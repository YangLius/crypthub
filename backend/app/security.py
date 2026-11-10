"""会话 / 鉴权 / 限流 / 解锁标志。

会话存 Redis（TTL 滑动），Cookie HttpOnly + SameSite=Strict。
停用账号在每次请求的用户加载点即时失效（status 检查）。
"""
from __future__ import annotations

import hmac
import json
import secrets as pysecrets
from dataclasses import dataclass
from typing import Any

import redis.asyncio as aioredis
from fastapi import HTTPException, Request, Response

from .config import settings

_redis: aioredis.Redis | None = None

COOKIE_NAME = "kb_session"


def redis_client() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


# ---------- 会话 ----------

@dataclass
class SessionData:
    token: str
    user_id: str
    role: str
    unlocked: bool = False

    def to_json(self) -> str:
        return json.dumps({"user_id": self.user_id, "role": self.role, "unlocked": self.unlocked})


async def create_session(user_id: str, role: str) -> str:
    token = pysecrets.token_urlsafe(32)
    r = redis_client()
    await r.set(f"kb:sess:{token}", SessionData(token, user_id, role).to_json(),
                ex=settings.session_ttl)
    return token


async def get_session(token: str) -> SessionData | None:
    r = redis_client()
    raw = await r.get(f"kb:sess:{token}")
    if not raw:
        return None
    try:
        d = json.loads(raw)
        s = SessionData(token=token, user_id=str(d["user_id"]), role=str(d["role"]),
                        unlocked=bool(d.get("unlocked", False)))
    except (ValueError, KeyError, TypeError):
        # 会话数据损坏：当作已失效处理
        await destroy_session(token)
        return None
    await r.expire(f"kb:sess:{token}", settings.session_ttl)  # 滑动续期
    return s


async def destroy_session(token: str) -> None:
    await redis_client().delete(f"kb:sess:{token}")


async def set_unlocked(token: str, unlocked: bool) -> None:
    s = await get_session(token)
    if s:
        await redis_client().set(f"kb:sess:{token}", s.to_json() if not unlocked else
                                 json.dumps({"user_id": s.user_id, "role": s.role, "unlocked": True}),
                                 ex=settings.session_ttl)


# ---------- 请求上下文 / 依赖 ----------

@dataclass
class Ctx:
    user: dict          # users 行
    session: SessionData
    ip: str


async def current_user(request: Request) -> Ctx:
    token = request.cookies.get(COOKIE_NAME, "")
    if not token:
        raise HTTPException(401, "未登录")
    sess = await get_session(token)
    if not sess:
        raise HTTPException(401, "会话已失效")
    from . import db  # 局部导入避免环
    user = await db.fetch_one(
        "SELECT id, username, display_name, role, status, salt_auth, salt_enc, auth_verifier,"
        " local_check_ct FROM users WHERE id = :uid", {"uid": sess.user_id})
    if not user or user["status"] != "active":
        await destroy_session(token)
        raise HTTPException(401, "账号不可用")
    ip = request.client.host if request.client else ""
    return Ctx(user=user, session=sess, ip=ip)


async def require_admin(ctx: Ctx) -> Ctx:
    if ctx.user["role"] != "admin":
        raise HTTPException(403, "需要管理员权限")
    return ctx


def require_unlocked(ctx: Ctx) -> None:
    if not ctx.session.unlocked:
        raise HTTPException(403, "密钥区未解锁")


def set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME, token, max_age=settings.session_ttl, httponly=True,
        samesite="strict", secure=settings.cookie_secure, path="/")


def clear_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")


# ---------- 限流（Redis INCR + EXPIRE） ----------

async def rate_limit(key: str, limit: int, window: int) -> None:
    r = redis_client()
    k = f"kb:rl:{key}"
    n = await r.incr(k)
    if n == 1:
        await r.expire(k, window)
    if n > limit:
        ttl = await r.ttl(k)
        raise HTTPException(429, f"请求过于频繁，请 {max(ttl, 1)} 秒后重试")


async def rate_limit_or_consume(key: str, limit: int, window: int) -> bool:
    """仅探测不消耗（用于失败计数前的容量检查）。"""
    r = redis_client()
    n = await r.get(f"kb:rl:{key}")
    try:
        count = int(n) if n else 0
    except (TypeError, ValueError):
        count = 0
    return count < limit


async def kv_set(key: str, value: str, ttl: int) -> None:
    await redis_client().set(key, value, ex=ttl)


async def kv_get(key: str) -> str | None:
    v = await redis_client().get(key)
    return None if v is None else str(v)


async def kv_take(key: str) -> str | None:
    """原子读取并删除。"""
    v = await redis_client().getdel(key)
    return None if v is None else str(v)


def const_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


def has(obj: dict[str, Any], k: str) -> bool:
    return k in obj
