"""Embedding Provider 抽象（设计选型：本地 BGE / OpenAI 兼容 API，配置切换）。

- openai_compat：api 进程直接调 HTTP。
- local：模型只载入 worker 进程（768MB 预算）；api 通过 Redis 请求-应答通道
  委托 worker 计算（避免 api 进程加载 torch，内存友好）。
"""

from __future__ import annotations

import json
import uuid

import httpx

from . import security, sysconfig
from .config import settings

EMBED_REQ_KEY = "kb:embed:req"
EMBED_RES_TTL = 60


def _vec_text(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.7g}" for x in v) + "]"


# ---------- openai_compat ----------


async def _embed_via_api(
    texts: list[str], cfg: dict[str, str] | None = None
) -> list[list[float]]:
    cfg = cfg or await sysconfig.effective()
    base = (cfg.get("embedding_api_base") or settings.embedding_api_base).rstrip("/")
    key = cfg.get("embedding_api_key") or settings.embedding_api_key
    model = cfg.get("embedding_model") or settings.embedding_model
    headers = {"Authorization": f"Bearer {key}"}
    payload: dict = {"model": model, "input": texts}
    if (cfg.get("embedding_api_send_dims") or "").lower() == "true":
        payload["dimensions"] = settings.embedding_dim
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(f"{base}/embeddings", headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()["data"]
    ordered = sorted(data, key=lambda d: d["index"])
    return [d["embedding"] for d in ordered]


# ---------- local（worker 侧直接调用；api 侧走 Redis 委托） ----------

_local_model = None


def embed_local(texts: list[str]) -> list[list[float]]:
    """仅在 worker 进程调用：懒加载 sentence-transformers。"""
    global _local_model
    if _local_model is None:
        from sentence_transformers import SentenceTransformer

        _local_model = SentenceTransformer(settings.embedding_model, device="cpu")
    vecs = _local_model.encode(
        texts,
        batch_size=settings.embedding_batch,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    return [list(map(float, v)) for v in vecs]


async def _embed_via_worker(texts: list[str]) -> list[list[float]]:
    rid = uuid.uuid4().hex
    res_key = f"kb:embed:res:{rid}"
    r = security.redis_client()
    await r.rpush(EMBED_REQ_KEY, json.dumps({"id": rid, "texts": texts}))
    await r.expire(res_key, EMBED_RES_TTL + 30)
    raw = await r.blpop(res_key, timeout=60)
    if raw is None:
        raise RuntimeError("embedding worker 超时（worker 未运行？）")
    _, payload = raw
    try:
        data = json.loads(payload)
    except ValueError as e:
        raise RuntimeError("embedding 响应解析失败") from e
    if data.get("id") != rid:
        raise RuntimeError("embedding 响应不匹配")
    if "error" in data:
        raise RuntimeError(f"embedding 失败: {data['error']}")
    return data["vectors"]


async def embed_texts(
    texts: list[str], cfg: dict[str, str] | None = None
) -> list[list[float]]:
    """api / worker 通用入口（异步；worker 在自己事件循环内 await 调用）。

    cfg 缺省时自动读取 system_settings 覆盖后的生效配置。
    """
    if not texts:
        return []
    if cfg is None:
        cfg = await sysconfig.effective()
    if cfg.get("embedding_provider") == "openai_compat":
        out: list[list[float]] = []
        for i in range(0, len(texts), settings.embedding_batch):
            out.extend(
                await _embed_via_api(texts[i : i + settings.embedding_batch], cfg)
            )
        return out
    return await _embed_via_worker(texts)
