"""应用入口：路由装配、安全响应头、SPA 静态托管、启动初始化。"""

from __future__ import annotations

import contextlib
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db, security
from .config import settings
from .routers import admin, auth, chat, dify, documents, folders, search, secrets
from .routers import audit as audit_router

app = FastAPI(
    title="私有知识库与密钥管理系统",
    version="1.1.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(documents.router)
app.include_router(folders.router)
app.include_router(search.router)
app.include_router(chat.router)
app.include_router(secrets.router)
app.include_router(audit_router.router)
app.include_router(dify.router)


@app.middleware("http")
async def security_headers(request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cache-Control"] = "no-store"
    if settings.enable_hsts:
        resp.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )
    return resp


@app.get("/healthz")
async def healthz():
    ok_db = False
    ok_redis = False
    try:
        await db.fetch_one("SELECT 1 AS x")
        ok_db = True
    except Exception as e:
        print(f"[healthz] db 不可用: {type(e).__name__}", flush=True)
    try:
        await security.redis_client().ping()
        ok_redis = True
    except Exception as e:
        print(f"[healthz] redis 不可用: {type(e).__name__}", flush=True)
    return JSONResponse(
        {"ok": ok_db and ok_redis, "db": ok_db, "redis": ok_redis},
        status_code=200 if (ok_db and ok_redis) else 503,
    )


@app.on_event("startup")
async def _startup() -> None:
    os.makedirs(os.path.join(settings.data_dir, "files"), exist_ok=True)
    await db.init_schema()


@app.on_event("shutdown")
async def _shutdown() -> None:
    with contextlib.suppress(Exception):
        await db.close_engine()
    with contextlib.suppress(Exception):
        await security.close_redis()


# ---------- SPA 静态托管（前端构建产物；平台 edge 或 api 附带，不自建 Nginx） ----------

_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _DIST.exists():
    assets = _DIST / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        if full_path.startswith(
            (
                "api/",
                "auth/",
                "admin/",
                "documents/",
                "search/",
                "chat/",
                "secrets/",
                "audit/",
                "dify/",
                "notifications/",
                "healthz",
            )
        ):
            return JSONResponse({"error": "not found"}, status_code=404)
        candidate = _DIST / full_path
        if full_path and candidate.is_file() and str(candidate).startswith(str(_DIST)):
            return FileResponse(str(candidate))
        return FileResponse(str(_DIST / "index.html"))
