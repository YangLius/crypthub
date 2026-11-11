"""后台 worker：索引任务（解析→兜底脱敏→分块→embedding→入库）
+ embedding 请求-应答服务（api 委托本地模型计算）。

独立进程运行：python -m app.worker
"""

from __future__ import annotations

import asyncio
import json
import re
import traceback

import redis.exceptions

from . import db, embedding, gates, parsing, queue, security
from .config import settings

FILES_DIR_SUFFIX = "files"


def file_path(doc_id: str, filename: str) -> str:
    ext = re.sub(
        r"[^a-z0-9.]", "", __import__("os").path.splitext(filename.lower())[1][:10]
    )
    return f"{FILES_DIR_SUFFIX}/{doc_id}{ext}"


async def process_index(doc_id: str) -> None:
    doc = await db.fetch_one("SELECT * FROM documents WHERE id = :id", {"id": doc_id})
    if not doc:
        return
    try:
        full = doc["file_path"]
        path = f"{settings.data_dir}/{full}"
        data = await asyncio.to_thread(_read_file, path)
        text = await asyncio.to_thread(
            parsing.extract, data, doc["filename"], doc["mime"]
        )
        # 服务端兜底脱敏（模式 B，设计 5.2）：客户端已扫过的占位符不会被再命中
        rd = gates.redact(text, strict=True)
        # 兜底命中的占位符 → 待认领队列（真实值不落库）
        for p in rd.pending:
            await db.execute(
                "INSERT INTO pending_secrets (slug, kind, source_doc_id, source_hint, created_by)"
                " VALUES (:slug, :kind, :doc, :hint, :uid)"
                " ON CONFLICT (slug) DO NOTHING",
                {
                    "slug": p["slug"],
                    "kind": p["kind"],
                    "doc": doc_id,
                    "hint": f"{doc['title']} · 服务端兜底扫描",
                    "uid": doc["uploaded_by"],
                },
            )
        # 分块
        from .chunking import chunk_text

        chunks = chunk_text(rd.text)
        texts = [c.text for c in chunks]
        vecs = await embedding.embed_texts(texts) if texts else []
        if len(vecs) != len(texts):
            raise RuntimeError("embedding 数量不匹配")
        # 重建该文档的索引
        await db.execute("DELETE FROM chunks WHERE document_id = :id", {"id": doc_id})
        for c, v in zip(chunks, vecs, strict=True):
            await db.execute(
                "INSERT INTO chunks (document_id, idx, anchor, text, tsv, embedding, dim)"
                " VALUES (:doc, :idx, :anchor, :text,"
                "  to_tsvector('simple', :tsv), CAST(:emb AS real[]), :dim)",
                {
                    "doc": doc_id,
                    "idx": c.idx,
                    "anchor": c.anchor,
                    "text": c.text,
                    "tsv": _tokens(c.text),
                    "emb": v,
                    "dim": len(v),
                },
            )
        await db.execute(
            "UPDATE documents SET status='ready', chunk_count=:n, error=NULL,"
            " updated_at=now() WHERE id=:id",
            {"n": len(chunks), "id": doc_id},
        )
    except Exception as e:  # 单文档失败不影响其他任务
        err = f"{type(e).__name__}: {e}"
        await db.execute(
            "UPDATE documents SET status='failed', error=:e, updated_at=now() WHERE id=:id",
            {"e": err[:500], "id": doc_id},
        )


def _read_file(path: str) -> bytes:
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError as e:
        raise RuntimeError(f"无法读取文件 {path}: {e}") from e


def _tokens(text: str) -> str:
    import jieba

    return " ".join(t for t in jieba.cut_for_search(text) if t.strip())


# ---------- embedding 请求-应答服务 ----------


async def serve_embed_requests() -> None:
    r = security.redis_client()
    while True:
        try:
            item = await r.blpop(embedding.EMBED_REQ_KEY, timeout=2)
        except redis.exceptions.TimeoutError:
            # 阻塞读超时属常态（部分 redis 实现/fakeredis偶发）；继续循环
            continue
        except redis.exceptions.ConnectionError as e:
            print(f"[worker] redis 连接异常，1s 后重试: {e}", flush=True)
            await asyncio.sleep(1)
            continue
        if item is None:
            continue
        _, raw = item
        try:
            req = json.loads(raw)
            vectors = embedding.embed_local(req["texts"])
            await r.lpush(
                f"kb:embed:res:{req['id']}",
                json.dumps({"id": req["id"], "vectors": vectors}),
            )
            await r.expire(f"kb:embed:res:{req['id']}", embedding.EMBED_RES_TTL)
        except Exception as e:
            # 无法定位请求 id 时只能丢弃；记录日志便于排查 worker/模型故障
            print(f"[worker] embed 响应失败: {e}", flush=True)
            try:
                req = json.loads(raw)
                await r.lpush(
                    f"kb:embed:res:{req['id']}",
                    json.dumps({"id": req["id"], "error": str(e)}),
                )
                await r.expire(f"kb:embed:res:{req['id']}", embedding.EMBED_RES_TTL)
            except Exception:
                traceback.print_exc()


# 后台任务引用保活（防止被 GC）
_bg_tasks: set[asyncio.Task] = set()


async def main() -> None:
    print("[worker] 启动", flush=True)
    if settings.embedding_provider == "local":
        # 预热模型
        try:
            embedding.embed_local(["预热"])
            print(f"[worker] 模型已加载: {settings.embedding_model}", flush=True)
        except Exception:
            traceback.print_exc()
    embed_task = asyncio.create_task(serve_embed_requests())
    _bg_tasks.add(embed_task)
    embed_task.add_done_callback(_bg_tasks.discard)
    r = security.redis_client()
    while True:
        try:
            item = await r.blpop(queue.TASK_KEY, timeout=5)
        except redis.exceptions.TimeoutError:
            continue
        except redis.exceptions.ConnectionError as e:
            print(f"[worker] redis 连接异常，1s 后重试: {e}", flush=True)
            await asyncio.sleep(1)
            continue
        if item is None:
            await asyncio.sleep(0.2)
            continue
        _, raw = item
        try:
            task = json.loads(raw)
        except ValueError:
            continue
        if task.get("type") == "index":
            print(f"[worker] index {task['doc_id']}", flush=True)
            try:
                await process_index(task["doc_id"])
            except Exception:
                traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())
