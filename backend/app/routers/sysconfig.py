"""系统配置路由（仅管理员）：查看/明文查看/改 LLM·嵌入配置，改数据库连接。

- LLM/嵌入：存 system_settings 表覆盖 .env，改动即时生效（无需重启）。
- 数据库：启动期依赖，连接参数经连通性测试后写回 .env，重启后端生效。
- 所有敏感动作写审计；API Key 默认打码，明文查看单独走 /reveal 并记 warn 审计。
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import audit, db, sysconfig
from ..security import Ctx, current_user

router = APIRouter(prefix="/admin/system-config", tags=["sysconfig"])

REVEALABLE = ("llm_api_key", "embedding_api_key", "db_password")
UPDATABLE = set(sysconfig.OVERRIDE_KEYS)


async def admin_ctx(ctx: Ctx = Depends(current_user)) -> Ctx:
    if ctx.user["role"] != "admin":
        raise HTTPException(403, "需要管理员权限")
    return ctx


# ---------- 查看 ----------


@router.get("")
async def get_config(ctx: Ctx = Depends(admin_ctx)) -> dict:
    cfg = await sysconfig.effective()
    ov = await sysconfig.overrides()
    dbinfo = sysconfig.parse_db_url(cfg_db_url := _db_url())
    return {
        "llm": {
            "api_base": cfg["llm_api_base"],
            "model": cfg["llm_model"],
            "api_key_masked": sysconfig.mask(cfg["llm_api_key"]),
            "api_key_set": bool(cfg["llm_api_key"]),
            "api_key_source": "db" if "llm_api_key" in ov else "env",
        },
        "embedding": {
            "provider": cfg["embedding_provider"],
            "api_base": cfg["embedding_api_base"],
            "model": cfg["embedding_model"],
            "api_key_masked": sysconfig.mask(cfg["embedding_api_key"]),
            "api_key_set": bool(cfg["embedding_api_key"]),
            "api_key_source": "db" if "embedding_api_key" in ov else "env",
            "send_dims": cfg["embedding_api_send_dims"].lower() == "true",
        },
        "db": {
            "host": dbinfo["host"],
            "port": dbinfo["port"],
            "name": dbinfo["name"],
            "user": dbinfo["user"],
            "password_masked": sysconfig.mask(dbinfo["password"]),
            "password_set": bool(dbinfo["password"]),
            "source": "env",
        },
        "overrides": sorted(ov.keys()),
        "read_only_ok": cfg_db_url != "",
    }


def _db_url() -> str:
    from ..config import settings

    return settings.database_url


class RevealBody(BaseModel):
    fields: list[str] = Field(max_length=5)


@router.post("/reveal")
async def reveal(body: RevealBody, ctx: Ctx = Depends(admin_ctx)) -> dict:
    for f in body.fields:
        if f not in REVEALABLE:
            raise HTTPException(400, f"不允许查看字段：{f}")
    cfg = await sysconfig.effective()
    dbinfo = sysconfig.parse_db_url(_db_url())
    out: dict[str, str] = {}
    if "llm_api_key" in body.fields:
        out["llm_api_key"] = cfg["llm_api_key"]
    if "embedding_api_key" in body.fields:
        out["embedding_api_key"] = cfg["embedding_api_key"]
    if "db_password" in body.fields:
        out["db_password"] = dbinfo["password"]
    await audit.audit(
        "system_config_revealed",
        user=ctx.user,
        ip=ctx.ip,
        detail={"fields": body.fields},
        severity="warn",
    )
    return {"values": out}


# ---------- 修改 LLM / 嵌入（DB 覆盖，即时生效） ----------


class UpdateBody(BaseModel):
    llm_api_base: str | None = Field(default=None, max_length=300)
    llm_api_key: str | None = Field(default=None, max_length=300)
    llm_model: str | None = Field(default=None, max_length=120)
    embedding_provider: str | None = Field(default=None, max_length=40)
    embedding_api_base: str | None = Field(default=None, max_length=300)
    embedding_api_key: str | None = Field(default=None, max_length=300)
    embedding_model: str | None = Field(default=None, max_length=200)
    embedding_api_send_dims: str | None = Field(default=None, max_length=8)


@router.put("")
async def update_config(body: UpdateBody, ctx: Ctx = Depends(admin_ctx)) -> dict:
    changed: dict[str, str] = {}
    fields = body.model_dump(exclude_none=True)
    for k, v in fields.items():
        if k not in UPDATABLE:
            raise HTTPException(400, f"不允许修改字段：{k}")
        if k == "embedding_provider" and v not in sysconfig.PROVIDERS:
            raise HTTPException(400, f"provider 仅支持：{' / '.join(sysconfig.PROVIDERS)}")
        if k == "embedding_api_send_dims" and v not in ("true", "false"):
            raise HTTPException(400, "send_dims 仅支持 true/false")
        if v == "":  # 空串=删除覆盖，恢复 .env 默认
            await db.execute(
                "DELETE FROM system_settings WHERE key = :k", {"k": k}
            )
        else:
            await db.execute(
                "INSERT INTO system_settings (key, value, updated_by)"
                " VALUES (:k, :v, :uid)"
                " ON CONFLICT (key) DO UPDATE SET"
                " value = EXCLUDED.value, updated_by = EXCLUDED.updated_by,"
                " updated_at = now()",
                {"k": k, "v": v, "uid": ctx.user["id"]},
            )
        changed[k] = "reset" if v == "" else "updated"
    await audit.audit(
        "system_config_updated",
        user=ctx.user,
        ip=ctx.ip,
        detail={"keys": sorted(changed.keys())},
    )
    return {"changed": changed, "note": "即时生效（LLM/嵌入）；嵌入模型变更后需重建索引"}


# ---------- 连通性测试 ----------


class TestLlmBody(BaseModel):
    api_base: str | None = Field(default=None, max_length=300)
    api_key: str | None = Field(default=None, max_length=300)
    model: str | None = Field(default=None, max_length=120)


@router.post("/test-llm")
async def test_llm(body: TestLlmBody, ctx: Ctx = Depends(admin_ctx)) -> dict:
    cfg = await sysconfig.effective()
    base = (body.api_base or cfg["llm_api_base"]).rstrip("/")
    key = body.api_key or cfg["llm_api_key"]
    model = body.model or cfg["llm_model"]
    if not (base and key and model):
        return {"ok": False, "error": "Base URL / API Key / 模型名缺一不可"}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{base}/chat/completions",
                headers={"Authorization": f"Bearer {key}"},
                json={
                    "model": model,
                    "max_tokens": 8,
                    "messages": [{"role": "user", "content": "回复：ok"}],
                },
            )
            resp.raise_for_status()
            reply = resp.json()["choices"][0]["message"]["content"]
        return {"ok": True, "reply": str(reply)[:80]}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


class TestEmbedBody(BaseModel):
    provider: str | None = Field(default=None, max_length=40)
    api_base: str | None = Field(default=None, max_length=300)
    api_key: str | None = Field(default=None, max_length=300)
    model: str | None = Field(default=None, max_length=200)
    send_dims: bool | None = None


@router.post("/test-embedding")
async def test_embedding(body: TestEmbedBody, ctx: Ctx = Depends(admin_ctx)) -> dict:
    cfg = await sysconfig.effective()
    provider = body.provider or cfg["embedding_provider"]
    if provider == "local":
        return {"ok": True, "note": "本地模型在 worker 进程加载，无法在此直接测试"}
    base = (body.api_base or cfg["embedding_api_base"]).rstrip("/")
    key = body.api_key or cfg["embedding_api_key"]
    model = body.model or cfg["embedding_model"]
    from ..config import settings

    send_dims = (
        body.send_dims
        if body.send_dims is not None
        else cfg["embedding_api_send_dims"].lower() == "true"
    )
    if not (base and key and model):
        return {"ok": False, "error": "Base URL / API Key / 模型名缺一不可"}
    payload: dict = {"model": model, "input": ["连接测试"]}
    if send_dims:
        payload["dimensions"] = settings.embedding_dim
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{base}/embeddings",
                headers={"Authorization": f"Bearer {key}"},
                json=payload,
            )
            resp.raise_for_status()
            vec = resp.json()["data"][0]["embedding"]
        return {"ok": True, "dims": len(vec)}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


# ---------- 数据库连接（测试 + 写回 .env，重启生效） ----------


class DbBody(BaseModel):
    host: str = Field(max_length=200)
    port: str = Field(pattern=r"^\d{1,5}$", max_length=5)
    name: str = Field(max_length=100)
    user: str = Field(max_length=100)
    password: str = Field(default="", max_length=200)


async def _try_db_connect(b: DbBody) -> None:
    """连通性测试：失败抛异常（消息含原因）。"""
    import asyncio

    import asyncpg

    try:
        conn = await asyncio.wait_for(
            asyncpg.connect(
                host=b.host,
                port=int(b.port),
                user=b.user,
                password=b.password,
                database=b.name,
                timeout=8,
            ),
            timeout=12,
        )
    except Exception as e:
        raise RuntimeError(f"连接失败：{str(e)[:200]}") from e
    try:
        await asyncio.wait_for(conn.fetch("SELECT 1"), timeout=8)
    finally:
        await conn.close()


@router.post("/db-test")
async def db_test(body: DbBody, ctx: Ctx = Depends(admin_ctx)) -> dict:
    try:
        await _try_db_connect(body)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


@router.put("/db")
async def update_db(body: DbBody, ctx: Ctx = Depends(admin_ctx)) -> dict:
    try:
        await _try_db_connect(body)
    except Exception as e:
        raise HTTPException(400, f"{e}") from None
    url = sysconfig.build_db_url(body.host, body.port, body.user, body.password, body.name)
    try:
        path = sysconfig.write_env_database_url(url)
    except Exception as e:
        raise HTTPException(400, f"写入 .env 失败：{e}") from None
    await audit.audit(
        "system_config_db_updated",
        user=ctx.user,
        ip=ctx.ip,
        detail={"host": body.host, "port": body.port, "name": body.name, "user": body.user},
        severity="alert",
    )
    return {"ok": True, "note": f"已写入 {path}，重启后端后生效"}
