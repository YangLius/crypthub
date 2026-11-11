"""密钥区路由（设计第 8 节）：服务端只搬密文。

访问模型：每条密钥 × 每个有权访问者 = 一行授权（secret_grants）。
内容端点要求会话已解锁（unlock 是前端行为，服务端只做 UX 强制 + 审计）。
"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import audit, db, security
from ..config import settings
from ..security import Ctx, current_user, require_unlocked

router = APIRouter(prefix="/secrets", tags=["secrets"])

UUID_RE = (
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


class UnlockBody(BaseModel):
    ok: bool = True


class SecretCreateBody(BaseModel):
    id: str | None = Field(
        default=None, pattern=UUID_RE
    )  # 客户端生成（AAD 需预先绑定 id）
    name: str = Field(min_length=1, max_length=200)
    project: str = Field(default="", max_length=64)
    env: str = Field(default="", max_length=32)
    tags: list[str] = Field(default_factory=list, max_length=20)
    content_ct: str  # b64 密文（AAD=kb:secret:<id> 由前端绑定）
    dek_wrapped_org: str  # b64 ECIES(org_pub, DEK)
    grants: list[dict] = Field(min_length=1, max_length=100)  # [{user_id, wrapped_dek}]


class SecretMetaBody(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    project: str | None = Field(default=None, max_length=64)
    env: str | None = Field(default=None, max_length=32)
    tags: list[str] | None = Field(default=None, max_length=20)


class GrantBody(BaseModel):
    user_id: str = Field(pattern=UUID_RE)
    wrapped_dek: str


class RotateBody(BaseModel):
    content_ct: str
    dek_wrapped_org: str
    wrapped_deks: dict[str, str]  # user_id -> sealed DEK（含 owner）
    old_content_ct: str
    old_wrapped_deks: dict[str, str]  # 归档用


# ---------- 解锁 / 锁定 ----------


@router.post("/unlock")
async def unlock(request: Request):
    ctx: Ctx = await current_user(request)
    if not ctx.session.unlocked:
        await security.set_unlocked(ctx.session.token, True)
    await audit.audit("unlock", user=ctx.user, ip=ctx.ip)
    return {"ok": True, "unlocked": True}


@router.post("/lock")
async def lock(request: Request):
    ctx: Ctx = await current_user(request)
    await security.set_unlocked(ctx.session.token, False)
    await audit.audit("lock", user=ctx.user, ip=ctx.ip)
    return {"ok": True, "unlocked": False}


# ---------- 创建 / 列表 ----------


@router.post("")
async def create_secret(body: SecretCreateBody, request: Request):
    ctx: Ctx = await current_user(request)
    require_unlocked(ctx)
    uid = str(ctx.user["id"])
    seen = set()
    for g in body.grants:
        gu = str(g.get("user_id", ""))
        if not gu or gu in seen:
            raise HTTPException(400, "授权列表无效（重复或缺失 user_id）")
        seen.add(gu)
    if uid not in seen:
        raise HTTPException(400, "授权列表必须包含创建者本人")
    # 校验被授权人存在且已建密钥
    for gu in seen:
        uk = await db.fetch_one(
            "SELECT u.status FROM users u LEFT JOIN user_keys k ON k.user_id = u.id"
            " WHERE u.id = :uid AND k.public_key IS NOT NULL",
            {"uid": gu},
        )
        if not uk:
            raise HTTPException(400, "被共享人不存在或尚未完成密钥初始化")
    row = await db.execute_returning(
        "INSERT INTO secrets (id, name, project, env, tags, content_ct, dek_wrapped_org, owner_id)"
        " VALUES (:sid, :n, :pj, :ev, CAST(:tags AS jsonb), :ct, :org, :uid)"
        " RETURNING id, name, version",
        {
            "sid": body.id,
            "n": body.name,
            "pj": body.project,
            "ev": body.env,
            "tags": db.j(body.tags),
            "ct": body.content_ct,
            "org": body.dek_wrapped_org,
            "uid": uid,
        },
    )
    if row is None:
        raise HTTPException(500, "创建失败")
    for g in body.grants:
        gu = str(g["user_id"])
        await db.execute(
            "INSERT INTO secret_grants (secret_id, user_id, wrapped_dek, granted_by)"
            " VALUES (:sid, :uid, :wd, :by) ON CONFLICT DO NOTHING",
            {
                "sid": row["id"],
                "uid": gu,
                "wd": str(g.get("wrapped_dek", "")),
                "by": uid,
            },
        )
    await audit.audit(
        "secret_created",
        user=ctx.user,
        target_type="secret",
        target_id=row["id"],
        ip=ctx.ip,
        detail={"grants": len(body.grants)},
    )
    return {"id": row["id"], "name": row["name"], "version": row["version"]}


@router.get("")
async def list_secrets(request: Request, project: str = "", env: str = "", q: str = ""):
    ctx: Ctx = await current_user(request)
    sql = (
        "SELECT s.id, s.name, s.project, s.env, s.tags, s.version, s.owner_id,"
        " s.updated_at, g.folder_id, (s.owner_id = :me) AS is_owner"
        " FROM secrets s JOIN secret_grants g ON g.secret_id = s.id AND g.user_id = :me"
        " WHERE 1=1"
    )
    params: dict = {"me": ctx.user["id"]}
    if project:
        sql += " AND s.project = :pj"
        params["pj"] = project
    if env:
        sql += " AND s.env = :ev"
        params["ev"] = env
    if q:
        sql += " AND (s.name ILIKE :q OR s.project ILIKE :q)"
        params["q"] = f"%{q[:100]}%"
    sql += " ORDER BY s.updated_at DESC LIMIT 500"
    rows = await db.fetch_all(sql, params)
    return {"secrets": rows}


class FolderMoveBody(BaseModel):
    folder_id: str = Field(max_length=64)  # "root"=移回根目录


@router.patch("/{sid}/folder")
async def set_secret_folder(sid: str, body: FolderMoveBody, request: Request):
    """归档到「我自己」的目录树（每人独立视图，互不影响）。"""
    ctx: Ctx = await current_user(request)
    g = await db.fetch_one(
        "SELECT id FROM secret_grants WHERE secret_id = :sid AND user_id = :uid",
        {"sid": sid, "uid": ctx.user["id"]},
    )
    if not g:
        raise HTTPException(403, "你没有这条密钥的授权")
    target: str | None = None
    if body.folder_id != "root":
        f = await db.fetch_one(
            "SELECT id FROM folders WHERE id = :fid AND kind = 'secret' AND owner_id = :uid",
            {"fid": body.folder_id, "uid": ctx.user["id"]},
        )
        if not f:
            raise HTTPException(404, "目标目录不存在")
        target = body.folder_id
    await db.execute(
        "UPDATE secret_grants SET folder_id = :fid WHERE id = :gid",
        {"fid": target, "gid": g["id"]},
    )
    return {"ok": True}


@router.get("/share-targets")
async def share_targets(request: Request):
    """共享对话框数据：成员列表（含公钥）+ 组列表（成员展开）。"""
    await current_user(request)
    users = await db.fetch_all(
        "SELECT u.id, u.username, u.display_name, k.public_key FROM users u"
        " JOIN user_keys k ON k.user_id = u.id WHERE u.status = 'active' ORDER BY u.username"
    )
    groups = await db.fetch_all("SELECT id, name FROM groups ORDER BY name")
    for g in groups:
        members = await db.fetch_all(
            "SELECT user_id FROM group_members WHERE group_id = :gid", {"gid": g["id"]}
        )
        g["member_ids"] = [m["user_id"] for m in members]
    return {"users": users, "groups": groups}


@router.get("/users/{uid}/pubkey")
async def user_pubkey(uid: str, request: Request):
    await current_user(request)
    row = await db.fetch_one(
        "SELECT k.public_key FROM users u JOIN user_keys k ON k.user_id = u.id"
        " WHERE u.id = :uid AND u.status = 'active'",
        {"uid": uid},
    )
    if not row:
        raise HTTPException(404, "用户不存在或不可用")
    return {"public_key": row["public_key"]}


# ---------- 单条：元数据 / reveal / 轮换 / 版本 / 删除 ----------


async def _get_grant_or_403(sid: str, uid: str) -> dict:
    row = await db.fetch_one(
        "SELECT s.*, g.wrapped_dek AS my_wrapped_dek, (s.owner_id = :uid) AS is_owner"
        " FROM secrets s JOIN secret_grants g ON g.secret_id = s.id AND g.user_id = :uid"
        " WHERE s.id = :sid",
        {"sid": sid, "uid": uid},
    )
    if not row:
        raise HTTPException(403, "无权访问该条目")  # 越权一律 403，不区分不存在
    return row


async def _get_owned_or_403(sid: str, uid: str) -> dict:
    row = await db.fetch_one("SELECT * FROM secrets WHERE id = :sid", {"sid": sid})
    if not row or row["owner_id"] != uid:
        raise HTTPException(403, "仅条目所有者可执行此操作")
    return row


@router.get("/{sid}")
async def get_secret(sid: str, request: Request):
    ctx: Ctx = await current_user(request)
    row = await _get_grant_or_403(sid, ctx.user["id"])
    return {
        "id": row["id"],
        "name": row["name"],
        "project": row["project"],
        "env": row["env"],
        "tags": row["tags"]
        if isinstance(row["tags"], list)
        else json.loads(row["tags"] or "[]"),
        "version": row["version"],
        "owner_id": row["owner_id"],
        "is_owner": row["is_owner"],
        "my_wrapped_dek": row["my_wrapped_dek"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@router.patch("/{sid}")
async def update_meta(sid: str, body: SecretMetaBody, request: Request):
    ctx: Ctx = await current_user(request)
    await _get_owned_or_403(sid, ctx.user["id"])
    await db.execute(
        "UPDATE secrets SET name = COALESCE(:n, name), project = COALESCE(:pj, project),"
        " env = COALESCE(:ev, env), tags = COALESCE(CAST(:tags AS jsonb), tags), updated_at = now()"
        " WHERE id = :sid",
        {
            "n": body.name,
            "pj": body.project,
            "ev": body.env,
            "tags": db.j(body.tags) if body.tags is not None else None,
            "sid": sid,
        },
    )
    await audit.audit(
        "secret_updated", user=ctx.user, target_type="secret", target_id=sid, ip=ctx.ip
    )
    return {"ok": True}


@router.delete("/{sid}")
async def delete_secret(sid: str, request: Request):
    ctx: Ctx = await current_user(request)
    row = await _get_owned_or_403(sid, ctx.user["id"])
    await db.execute("DELETE FROM secrets WHERE id = :sid", {"sid": sid})
    await audit.audit(
        "secret_deleted",
        user=ctx.user,
        target_type="secret",
        target_id=sid,
        ip=ctx.ip,
        detail={"name": row["name"]},
    )
    return {"ok": True}


@router.get("/{sid}/reveal")
async def reveal(sid: str, request: Request):
    ctx: Ctx = await current_user(request)
    require_unlocked(ctx)
    await security.rate_limit(
        f"kb:reveal:{ctx.user['id']}",
        settings.rl_reveal_limit,
        settings.rl_reveal_window,
    )
    row = await _get_grant_or_403(sid, ctx.user["id"])
    await audit.audit(
        "secret_revealed", user=ctx.user, target_type="secret", target_id=sid, ip=ctx.ip
    )
    return {
        "content_ct": row["content_ct"],
        "wrapped_dek": row["my_wrapped_dek"],
        "version": row["version"],
    }


@router.get("/{sid}/grants")
async def list_grants(sid: str, request: Request):
    ctx: Ctx = await current_user(request)
    await _get_owned_or_403(sid, ctx.user["id"])
    rows = await db.fetch_all(
        "SELECT g.user_id, u.username, u.display_name, g.wrapped_dek, g.created_at"
        " FROM secret_grants g JOIN users u ON u.id = g.user_id WHERE g.secret_id = :sid"
        " ORDER BY g.created_at",
        {"sid": sid},
    )
    return {"grants": rows}


@router.post("/{sid}/grants")
async def add_grant(sid: str, body: GrantBody, request: Request):
    ctx: Ctx = await current_user(request)
    require_unlocked(ctx)
    await _get_owned_or_403(sid, ctx.user["id"])
    uk = await db.fetch_one(
        "SELECT k.public_key FROM users u JOIN user_keys k ON k.user_id = u.id"
        " WHERE u.id = :uid AND u.status = 'active'",
        {"uid": body.user_id},
    )
    if not uk:
        raise HTTPException(404, "目标用户不存在或未激活")
    await db.execute(
        "INSERT INTO secret_grants (secret_id, user_id, wrapped_dek, granted_by)"
        " VALUES (:sid, :uid, :wd, :by)"
        " ON CONFLICT (secret_id, user_id) DO UPDATE SET wrapped_dek = EXCLUDED.wrapped_dek",
        {"sid": sid, "uid": body.user_id, "wd": body.wrapped_dek, "by": ctx.user["id"]},
    )
    await audit.audit(
        "grant_created",
        user=ctx.user,
        target_type="secret",
        target_id=sid,
        ip=ctx.ip,
        detail={"grantee": body.user_id},
    )
    await audit.notify(
        body.user_id, "grant_created", {"secret_id": sid, "by": ctx.user["username"]}
    )
    return {"ok": True}


@router.delete("/{sid}/grants/{uid}")
async def revoke_grant(sid: str, uid: str, request: Request):
    ctx: Ctx = await current_user(request)
    await _get_owned_or_403(sid, ctx.user["id"])
    s = await db.fetch_one("SELECT owner_id FROM secrets WHERE id = :sid", {"sid": sid})
    if s and uid == s["owner_id"]:
        raise HTTPException(400, "不能撤销所有者的授权")
    await db.execute(
        "DELETE FROM secret_grants WHERE secret_id = :sid AND user_id = :uid",
        {"sid": sid, "uid": uid},
    )
    await audit.audit(
        "grant_revoked",
        user=ctx.user,
        target_type="secret",
        target_id=sid,
        ip=ctx.ip,
        detail={"grantee": uid},
    )
    await audit.notify(
        uid, "grant_revoked", {"secret_id": sid, "by": ctx.user["username"]}
    )
    return {"ok": True}


@router.put("/{sid}/rotate")
async def rotate(sid: str, body: RotateBody, request: Request):
    """轮换（设计 4.4）：前端生成新 DEK 全量重包；旧密文与旧包装归档。"""
    ctx: Ctx = await current_user(request)
    require_unlocked(ctx)
    owner = await _get_owned_or_403(sid, ctx.user["id"])
    if ctx.user["id"] not in body.wrapped_deks:
        raise HTTPException(400, "wrapped_deks 必须包含所有者")
    from ..db import transact

    await transact(
        [
            (
                "INSERT INTO secret_versions (secret_id, version, content_ct, wrapped_deks, rotated_by)"
                " VALUES (:sid, :v, :ct, CAST(:wd AS jsonb), :by)",
                {
                    "sid": sid,
                    "v": owner["version"],
                    "ct": body.old_content_ct,
                    "wd": db.j(body.old_wrapped_deks),
                    "by": ctx.user["id"],
                },
            ),
            (
                "UPDATE secrets SET content_ct=:ct, dek_wrapped_org=:org, version=version+1,"
                " updated_at=now() WHERE id=:sid",
                {"ct": body.content_ct, "org": body.dek_wrapped_org, "sid": sid},
            ),
        ]
    )
    for uid_s, wd in body.wrapped_deks.items():
        await db.execute(
            "INSERT INTO secret_grants (secret_id, user_id, wrapped_dek, granted_by)"
            " VALUES (:sid, :uid, :wd, :by)"
            " ON CONFLICT (secret_id, user_id) DO UPDATE SET wrapped_dek = EXCLUDED.wrapped_dek",
            {"sid": sid, "uid": uid_s, "wd": wd, "by": ctx.user["id"]},
        )
    await audit.audit(
        "secret_rotated", user=ctx.user, target_type="secret", target_id=sid, ip=ctx.ip
    )
    return {"ok": True, "version": owner["version"] + 1}


@router.get("/{sid}/versions")
async def versions(sid: str, request: Request):
    ctx: Ctx = await current_user(request)
    await _get_owned_or_403(sid, ctx.user["id"])
    rows = await db.fetch_all(
        "SELECT version, content_ct, wrapped_deks, created_at FROM secret_versions"
        " WHERE secret_id = :sid ORDER BY version DESC LIMIT 100",
        {"sid": sid},
    )
    return {"versions": rows}


# ---------- 待认领占位符 ----------


class PendingActionBody(BaseModel):
    secret_id: str | None = Field(default=None, pattern=UUID_RE)


@router.post("/pending/{pid}/claim")
async def claim_pending(pid: str, body: PendingActionBody, request: Request):
    ctx: Ctx = await current_user(request)
    row = await db.fetch_one(
        "SELECT id, status FROM pending_secrets WHERE id = :pid AND created_by = :uid",
        {"pid": pid, "uid": ctx.user["id"]},
    )
    if not row:
        raise HTTPException(404, "待认领记录不存在")
    if body.secret_id:
        s = await db.fetch_one(
            "SELECT id FROM secrets WHERE id = :sid", {"sid": body.secret_id}
        )
        if not s:
            raise HTTPException(404, "密钥条目不存在")
    await db.execute(
        "UPDATE pending_secrets SET status='claimed', claimed_secret_id=:sid WHERE id=:pid",
        {"sid": body.secret_id, "pid": pid},
    )
    await audit.audit(
        "pending_claimed",
        user=ctx.user,
        target_type="pending",
        target_id=pid,
        ip=ctx.ip,
    )
    return {"ok": True}


@router.post("/pending/{pid}/dismiss")
async def dismiss_pending(pid: str, request: Request):
    ctx: Ctx = await current_user(request)
    row = await db.fetch_one(
        "SELECT id FROM pending_secrets WHERE id = :pid AND created_by = :uid",
        {"pid": pid, "uid": ctx.user["id"]},
    )
    if not row:
        raise HTTPException(404, "待认领记录不存在")
    await db.execute(
        "UPDATE pending_secrets SET status='dismissed' WHERE id=:pid", {"pid": pid}
    )
    return {"ok": True}
