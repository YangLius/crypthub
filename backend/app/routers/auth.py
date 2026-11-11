"""认证路由：引导（首管理员+组织密钥）、开号完成（setup）、挑战-应答登录、会话。"""

from __future__ import annotations

import base64
import hashlib
import secrets as pysecrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .. import audit, db, security
from ..config import settings
from ..security import Ctx, current_user

router = APIRouter(prefix="/auth", tags=["auth"])

USERNAME_RE = r"^[a-zA-Z0-9_.\-]{2,32}$"


class BootstrapInitBody(BaseModel):
    username: str = Field(pattern=USERNAME_RE)
    display_name: str = Field(default="", max_length=64)


class SetupBody(BaseModel):
    token: str = Field(min_length=16, max_length=128)
    display_name: str = Field(default="", max_length=64)
    salt_auth: str  # b64 16B
    salt_enc: str  # b64 16B
    auth_verifier: str  # hex 64
    local_check_ct: str  # b64
    public_key: str  # b64 32B
    priv_wrapped: str  # b64
    rk_salt: str  # b64 16B
    priv_rk_wrapped: str  # b64
    # 首管理员引导时必填：组织恢复密钥
    org_public_key: str | None = None
    org_offline_salt: str | None = None
    org_priv_offline_wrapped: str | None = None
    org_delegate_sealed: str | None = None


class ChallengeBody(BaseModel):
    username: str


class LoginBody(BaseModel):
    challenge_id: str
    proof: str = Field(min_length=64, max_length=64)


def _token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


@router.get("/bootstrap-status")
async def bootstrap_status():
    row = await db.fetch_one("SELECT count(*) AS n FROM users")
    return {"needs_bootstrap": (row or {}).get("n", 0) == 0}


@router.post("/bootstrap-init")
async def bootstrap_init(body: BootstrapInitBody):
    row = await db.fetch_one("SELECT count(*) AS n FROM users")
    if (row or {}).get("n", 0) != 0:
        raise HTTPException(403, "系统已初始化，请使用管理员开号")
    token = pysecrets.token_urlsafe(24)
    await db.execute(
        "INSERT INTO users (username, display_name, role, status, setup_token_hash, setup_token_expires)"
        " VALUES (:u, :d, 'admin', 'pending', :th, now() + interval '1 day')",
        {
            "u": body.username,
            "d": body.display_name or body.username,
            "th": _token_hash(token),
        },
    )
    await audit.audit("user_created", detail={"bootstrap": True})
    return {"setup_token": token}


@router.get("/setup-info")
async def setup_info(token: str):
    u = await db.fetch_one(
        "SELECT id, username, display_name, role, status, setup_token_expires FROM users"
        " WHERE setup_token_hash = :th",
        {"th": _token_hash(token)},
    )
    if not u or u["status"] != "pending":
        raise HTTPException(404, "无效的开号令牌")
    import datetime

    exp = u["setup_token_expires"]
    if exp and exp < datetime.datetime.now(datetime.timezone.utc):
        raise HTTPException(404, "开号令牌已过期，请联系管理员重开")
    has_org = await db.fetch_one("SELECT 1 AS x FROM org_recovery WHERE id = 1")
    return {
        "user_id": u["id"],
        "username": u["username"],
        "display_name": u["display_name"],
        "role": u["role"],
        "needs_org": not has_org,
    }


@router.post("/setup")
async def setup(body: SetupBody, request: Request, response: Response):
    u = await db.fetch_one(
        "SELECT id, username, display_name, role, status, setup_token_expires FROM users"
        " WHERE setup_token_hash = :th",
        {"th": _token_hash(body.token)},
    )
    if not u or u["status"] != "pending":
        raise HTTPException(404, "无效的开号令牌")
    import datetime

    exp = u["setup_token_expires"]
    if exp and exp < datetime.datetime.now(datetime.timezone.utc):
        raise HTTPException(404, "开号令牌已过期")
    uid = u["id"]
    import binascii

    try:
        if len(body.salt_auth) < 16 or len(body.auth_verifier) != 64:
            raise ValueError("bad params")
        binascii.a2b_hex(body.auth_verifier)
    except ValueError:
        raise HTTPException(400, "参数格式错误") from None

    has_org = await db.fetch_one("SELECT 1 AS x FROM org_recovery WHERE id = 1")
    if not has_org:
        if not (
            body.org_public_key
            and body.org_offline_salt
            and body.org_priv_offline_wrapped
            and body.org_delegate_sealed
        ):
            raise HTTPException(400, "首管理员必须初始化组织恢复密钥")
        await db.execute(
            "INSERT INTO org_recovery (id, public_key, offline_salt, org_priv_offline_wrapped)"
            " VALUES (1, :pk, :os, :ow)",
            {
                "pk": body.org_public_key,
                "os": base64.b64decode(body.org_offline_salt),
                "ow": body.org_priv_offline_wrapped,
            },
        )
        await db.execute(
            "INSERT INTO org_recovery_delegates (admin_user_id, sealed) VALUES (:uid, :s)"
            " ON CONFLICT (admin_user_id) DO UPDATE SET sealed = EXCLUDED.sealed",
            {"uid": uid, "s": body.org_delegate_sealed},
        )

    from ..db import execute

    await execute(
        "UPDATE users SET display_name=:d, status='active', salt_auth=:sa,"
        " salt_enc=:se, auth_verifier=:av, local_check_ct=:lc,"
        " setup_token_hash=NULL, setup_token_expires=NULL, updated_at=now() WHERE id=:uid",
        {
            "d": body.display_name or u["display_name"],
            "sa": base64.b64decode(body.salt_auth),
            "se": base64.b64decode(body.salt_enc),
            "av": body.auth_verifier,
            "lc": body.local_check_ct,
            "uid": uid,
        },
    )
    await execute(
        "INSERT INTO user_keys (user_id, public_key, priv_wrapped, rk_salt, priv_rk_wrapped)"
        " VALUES (:uid, :pk, :pw, :rs, :rw)"
        " ON CONFLICT (user_id) DO UPDATE SET public_key=EXCLUDED.public_key,"
        " priv_wrapped=EXCLUDED.priv_wrapped, rk_salt=EXCLUDED.rk_salt,"
        " priv_rk_wrapped=EXCLUDED.priv_rk_wrapped",
        {
            "uid": uid,
            "pk": body.public_key,
            "pw": body.priv_wrapped,
            "rs": base64.b64decode(body.rk_salt),
            "rw": body.priv_rk_wrapped,
        },
    )
    await audit.audit(
        "setup_completed",
        user={"id": uid, "username": u["username"]},
        ip=request.client.host if request.client else "",
        detail={"bootstrap": not has_org},
    )
    token = await security.create_session(uid, u["role"])
    security.set_cookie(response, token)
    return {"user_id": uid, "username": u["username"], "role": u["role"]}


@router.post("/challenge")
async def challenge(body: ChallengeBody):
    u = await db.fetch_one(
        "SELECT id, salt_auth FROM users WHERE username = :u AND status = 'active'",
        {"u": body.username},
    )
    if not u or not u["salt_auth"]:
        raise HTTPException(404, "用户不存在或不可用")
    cid = pysecrets.token_urlsafe(16)
    ch = pysecrets.token_hex(32)
    await security.kv_set(f"kb:ch:{cid}", f"{u['id']}|{ch}", ttl=120)
    # salt_auth 需下发用于客户端 KDF（盐不是秘密；标准做法，同 Bitwarden）
    import base64

    return {
        "challenge_id": cid,
        "challenge": ch,
        "salt_auth": base64.b64encode(bytes(u["salt_auth"])).decode(),
    }


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response):
    raw = await security.kv_take(f"kb:ch:{body.challenge_id}")
    if not raw or "|" not in raw:
        raise HTTPException(400, "挑战已失效，请重新登录")
    uid, ch = raw.split("|", 1)
    ip = request.client.host if request.client else ""
    rl_key = f"kb:login:{uid}:{ip}"
    if not await security.rate_limit_or_consume(
        rl_key, settings.rl_login_limit, settings.rl_login_window
    ):
        raise HTTPException(429, "失败次数过多，请稍后再试")
    u = await db.fetch_one(
        "SELECT id, username, role, status, auth_verifier FROM users WHERE id = :uid",
        {"uid": uid},
    )
    if not u or u["status"] != "active" or not u["auth_verifier"]:
        raise HTTPException(401, "用户名或主密码错误")
    import hmac as _h

    expected = _h.new(
        bytes.fromhex(u["auth_verifier"]), ch.encode(), "sha256"
    ).hexdigest()
    if not _h.compare_digest(expected, body.proof):
        await security.rate_limit(
            rl_key, settings.rl_login_limit, settings.rl_login_window
        )
        await audit.audit(
            "login_failed",
            user={"id": uid, "username": u["username"]},
            ip=ip,
            severity="warn",
        )
        raise HTTPException(401, "用户名或主密码错误")
    await security.kv_take(f"kb:rl:{rl_key}")  # 成功即清零
    token = await security.create_session(uid, u["role"])
    security.set_cookie(response, token)
    await audit.audit("login", user={"id": uid, "username": u["username"]}, ip=ip)
    return {"user_id": uid, "username": u["username"], "role": u["role"]}


@router.post("/logout")
async def logout(request: Request, response: Response):
    token = request.cookies.get(security.COOKIE_NAME, "")
    if token:
        sess = await security.get_session(token)
        if sess:
            await audit.audit("logout", user={"id": sess.user_id})
        await security.destroy_session(token)
    security.clear_cookie(response)
    return {"ok": True}


@router.get("/me")
async def me(ctx: Ctx = Depends(current_user)):
    uk = await db.fetch_one(
        "SELECT public_key, priv_wrapped FROM user_keys WHERE user_id = :uid",
        {"uid": ctx.user["id"]},
    )
    has_org = await db.fetch_one("SELECT 1 AS x FROM org_recovery WHERE id = 1")
    import base64

    salt_enc = ctx.user.get("salt_enc")
    return {
        "user_id": ctx.user["id"],
        "username": ctx.user["username"],
        "display_name": ctx.user["display_name"],
        "role": ctx.user["role"],
        "public_key": (uk or {}).get("public_key"),
        "priv_wrapped": (uk or {}).get("priv_wrapped"),
        "salt_enc": base64.b64encode(bytes(salt_enc)).decode() if salt_enc else None,
        "local_check_ct": ctx.user.get("local_check_ct"),
        "has_org": bool(has_org),
        "unlocked": ctx.session.unlocked,
    }
