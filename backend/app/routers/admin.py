"""管理员路由：开号/停用/角色/重置、组管理、组织恢复（设计 4.5/4.6）与离线恢复包。"""

from __future__ import annotations

import hashlib
import secrets as pysecrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import audit, db
from ..security import Ctx, current_user

router = APIRouter(tags=["admin"])

USERNAME_RE = r"^[a-zA-Z0-9_.\-]{2,32}$"


async def admin_ctx(ctx: Ctx = Depends(current_user)) -> Ctx:
    if ctx.user["role"] != "admin":
        raise HTTPException(403, "需要管理员权限")
    return ctx


# ---------- 用户管理 ----------


class CreateUserBody(BaseModel):
    username: str = Field(pattern=USERNAME_RE)
    display_name: str = Field(default="", max_length=64)
    role: str = Field(default="member", pattern="^(admin|member)$")


class RoleBody(BaseModel):
    role: str = Field(pattern="^(admin|member)$")


@router.get("/admin/users")
async def list_users(ctx: Ctx = Depends(admin_ctx)):
    rows = await db.fetch_all(
        "SELECT u.id, u.username, u.display_name, u.role, u.status, u.created_at,"
        " (k.user_id IS NOT NULL) AS has_keys"
        " FROM users u LEFT JOIN user_keys k ON k.user_id = u.id"
        " ORDER BY u.created_at"
    )
    return {"users": rows}


@router.post("/admin/users")
async def create_user(body: CreateUserBody, ctx: Ctx = Depends(admin_ctx)):
    dup = await db.fetch_one(
        "SELECT 1 AS x FROM users WHERE username = :u", {"u": body.username}
    )
    if dup:
        raise HTTPException(409, "用户名已存在")
    token = pysecrets.token_urlsafe(24)
    th = hashlib.sha256(token.encode()).digest()
    row = await db.execute_returning(
        "INSERT INTO users (username, display_name, role, status, setup_token_hash, setup_token_expires)"
        " VALUES (:u, :d, :r, 'pending', :th, now() + interval '7 days')"
        " RETURNING id, username, display_name, role, status",
        {
            "u": body.username,
            "d": body.display_name or body.username,
            "r": body.role,
            "th": th,
        },
    )
    if row is None:
        raise HTTPException(500, "创建用户失败")
    await audit.audit(
        "user_created",
        user=ctx.user,
        target_type="user",
        target_id=row["id"],
        ip=ctx.ip,
        detail={"role": body.role},
    )
    return {"user": row, "setup_token": token, "setup_url": f"/setup?token={token}"}


@router.post("/admin/users/{uid}/disable")
async def disable_user(uid: str, ctx: Ctx = Depends(admin_ctx)):
    u = await db.fetch_one(
        "SELECT id, username, role, status FROM users WHERE id = :uid", {"uid": uid}
    )
    if not u:
        raise HTTPException(404, "用户不存在")
    if u["id"] == ctx.user["id"]:
        raise HTTPException(400, "不能停用自己")
    if u["status"] == "disabled":
        return {"ok": True}
    await db.execute(
        "UPDATE users SET status='disabled', updated_at=now() WHERE id=:uid",
        {"uid": uid},
    )
    # 会话在其下次请求时即时失效（status 检查）；主动清除更快：
    await audit.audit(
        "user_disabled", user=ctx.user, target_type="user", target_id=uid, ip=ctx.ip
    )
    await audit.notify(uid, "account_disabled", {"by": ctx.user["username"]})
    return {"ok": True}


@router.post("/admin/users/{uid}/enable")
async def enable_user(uid: str, ctx: Ctx = Depends(admin_ctx)):
    u = await db.fetch_one(
        "SELECT id, username, status FROM users WHERE id = :uid", {"uid": uid}
    )
    if not u:
        raise HTTPException(404, "用户不存在")
    await db.execute(
        "UPDATE users SET status=CASE WHEN setup_token_hash IS NULL THEN 'active' ELSE 'pending' END,"
        " updated_at=now() WHERE id=:uid",
        {"uid": uid},
    )
    await audit.audit(
        "user_enabled", user=ctx.user, target_type="user", target_id=uid, ip=ctx.ip
    )
    return {"ok": True}


@router.post("/admin/users/{uid}/role")
async def set_role(uid: str, body: RoleBody, ctx: Ctx = Depends(admin_ctx)):
    u = await db.fetch_one(
        "SELECT id, username FROM users WHERE id = :uid", {"uid": uid}
    )
    if not u:
        raise HTTPException(404, "用户不存在")
    if u["id"] == ctx.user["id"]:
        raise HTTPException(400, "不能修改自己的角色")
    await db.execute(
        "UPDATE users SET role=:r, updated_at=now() WHERE id=:uid",
        {"r": body.role, "uid": uid},
    )
    await audit.audit(
        "role_changed",
        user=ctx.user,
        target_type="user",
        target_id=uid,
        ip=ctx.ip,
        detail={"role": body.role},
    )
    return {"ok": True}


@router.post("/admin/users/{uid}/reset")
async def reset_user(uid: str, ctx: Ctx = Depends(admin_ctx)):
    """忘记主密码的补救入口：重新开号令牌；完成后旧条目需走组织恢复重新授权。"""
    u = await db.fetch_one(
        "SELECT id, username FROM users WHERE id = :uid", {"uid": uid}
    )
    if not u:
        raise HTTPException(404, "用户不存在")
    token = pysecrets.token_urlsafe(24)
    th = hashlib.sha256(token.encode()).digest()
    await db.execute(
        "UPDATE users SET setup_token_hash=:th, setup_token_expires=now() + interval '7 days',"
        " status='pending', updated_at=now() WHERE id=:uid",
        {"th": th, "uid": uid},
    )
    await audit.audit(
        "user_reset", user=ctx.user, target_type="user", target_id=uid, ip=ctx.ip
    )
    return {
        "setup_token": token,
        "setup_url": f"/setup?token={token}",
        "note": "完成设置后，其原条目需管理员通过组织恢复重新授权",
    }


# ---------- 组（M3） ----------


class GroupBody(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class GroupMembersBody(BaseModel):
    user_ids: list[str] = Field(max_length=200)


@router.get("/admin/groups")
async def list_groups(ctx: Ctx = Depends(admin_ctx)):
    groups = await db.fetch_all("SELECT id, name, created_at FROM groups ORDER BY name")
    for g in groups:
        g["members"] = await db.fetch_all(
            "SELECT u.id, u.username, u.display_name FROM group_members gm"
            " JOIN users u ON u.id = gm.user_id WHERE gm.group_id = :gid",
            {"gid": g["id"]},
        )
    return {"groups": groups}


@router.post("/admin/groups")
async def create_group(body: GroupBody, ctx: Ctx = Depends(admin_ctx)):
    dup = await db.fetch_one(
        "SELECT 1 AS x FROM groups WHERE name = :n", {"n": body.name}
    )
    if dup:
        raise HTTPException(409, "组名已存在")
    row = await db.execute_returning(
        "INSERT INTO groups (name) VALUES (:n) RETURNING id, name", {"n": body.name}
    )
    if row is None:
        raise HTTPException(500, "创建组失败")
    await audit.audit(
        "group_created",
        user=ctx.user,
        target_type="group",
        target_id=row["id"],
        ip=ctx.ip,
    )
    return row


@router.post("/admin/groups/{gid}/members")
async def set_group_members(
    gid: str, body: GroupMembersBody, ctx: Ctx = Depends(admin_ctx)
):
    g = await db.fetch_one("SELECT id FROM groups WHERE id = :gid", {"gid": gid})
    if not g:
        raise HTTPException(404, "组不存在")
    await db.execute("DELETE FROM group_members WHERE group_id = :gid", {"gid": gid})
    for uid in body.user_ids:
        await db.execute(
            "INSERT INTO group_members (group_id, user_id) VALUES (:gid, :uid)"
            " ON CONFLICT DO NOTHING",
            {"gid": gid, "uid": uid},
        )
    await audit.audit(
        "group_members_set",
        user=ctx.user,
        target_type="group",
        target_id=gid,
        ip=ctx.ip,
        detail={"count": len(body.user_ids)},
    )
    return {"ok": True}


# ---------- 组织恢复 / 离职交接（设计 4.5 / 4.6） ----------


class RecoveryPrepareBody(BaseModel):
    reason: str = Field(min_length=5, max_length=300)


class RecoveryEntriesBody(BaseModel):
    user_id: str
    include_shared: bool = True


class RegrantItem(BaseModel):
    secret_id: str
    wrapped_dek: str


class RegrantBody(BaseModel):
    reason: str = Field(min_length=5, max_length=300)
    successor_id: str
    transfer: bool = False
    items: list[RegrantItem] = Field(min_length=1, max_length=500)


@router.get("/admin/recovery/status")
async def recovery_status(ctx: Ctx = Depends(admin_ctx)):
    org = await db.fetch_one("SELECT public_key FROM org_recovery WHERE id = 1")
    my = await db.fetch_one(
        "SELECT sealed FROM org_recovery_delegates WHERE admin_user_id = :uid",
        {"uid": ctx.user["id"]},
    )
    return {
        "has_org": bool(org),
        "org_pubkey": (org or {}).get("public_key"),
        "i_am_delegate": bool(my),
        "sealed_for_me": (my or {}).get("sealed"),
    }


@router.post("/admin/recovery/prepare")
async def recovery_prepare(body: RecoveryPrepareBody, ctx: Ctx = Depends(admin_ctx)):
    org = await db.fetch_one("SELECT public_key FROM org_recovery WHERE id = 1")
    if not org:
        raise HTTPException(404, "组织恢复密钥未初始化")
    my = await db.fetch_one(
        "SELECT sealed FROM org_recovery_delegates WHERE admin_user_id = :uid",
        {"uid": ctx.user["id"]},
    )
    if not my:
        raise HTTPException(403, "当前管理员没有组织恢复委托副本")
    await audit.audit(
        "org_recovery_prepare",
        user=ctx.user,
        ip=ctx.ip,
        reason=body.reason,
        severity="alert",
    )
    return {"org_pubkey": org["public_key"], "sealed_for_me": my["sealed"]}


@router.post("/admin/recovery/entries")
async def recovery_entries(body: RecoveryEntriesBody, ctx: Ctx = Depends(admin_ctx)):
    """返回目标用户名下/被共享的条目（只有密文与组织包装的 DEK；明文只在前端）。"""
    owned = await db.fetch_all(
        "SELECT s.id, s.name, s.project, s.env, s.version, s.owner_id, s.content_ct,"
        " s.dek_wrapped_org, TRUE AS is_owner"
        " FROM secrets s WHERE s.owner_id = :uid",
        {"uid": body.user_id},
    )
    shared: list[dict] = []
    if body.include_shared:
        shared = await db.fetch_all(
            "SELECT s.id, s.name, s.project, s.env, s.version, s.owner_id, s.content_ct,"
            " s.dek_wrapped_org, FALSE AS is_owner"
            " FROM secret_grants g JOIN secrets s ON s.id = g.secret_id"
            " WHERE g.user_id = :uid AND s.owner_id <> :uid",
            {"uid": body.user_id},
        )
    for row in owned + shared:
        row["grantees"] = await db.fetch_all(
            "SELECT g.user_id, u.username FROM secret_grants g"
            " JOIN users u ON u.id = g.user_id WHERE g.secret_id = :sid",
            {"sid": row["id"]},
        )
    await audit.audit(
        "org_recovery_entries_listed",
        user=ctx.user,
        ip=ctx.ip,
        target_type="user",
        target_id=body.user_id,
        detail={"owned": len(owned), "shared": len(shared)},
        severity="alert",
    )
    return {"entries": owned + shared}


@router.post("/admin/recovery/regrant")
async def recovery_regrant(body: RegrantBody, ctx: Ctx = Depends(admin_ctx)):
    succ = await db.fetch_one(
        "SELECT id, username, status FROM users WHERE id = :uid",
        {"uid": body.successor_id},
    )
    if not succ or succ["status"] != "active":
        raise HTTPException(404, "接手人不存在或未激活")
    done = []
    for item in body.items:
        s = await db.fetch_one(
            "SELECT id, owner_id FROM secrets WHERE id = :sid", {"sid": item.secret_id}
        )
        if not s:
            continue
        await db.execute(
            "INSERT INTO secret_grants (secret_id, user_id, wrapped_dek, granted_by)"
            " VALUES (:sid, :uid, :wd, :by)"
            " ON CONFLICT (secret_id, user_id) DO UPDATE SET wrapped_dek = EXCLUDED.wrapped_dek",
            {
                "sid": item.secret_id,
                "uid": body.successor_id,
                "wd": item.wrapped_dek,
                "by": ctx.user["id"],
            },
        )
        if body.transfer and s["owner_id"] != succ["id"]:
            old_owner = s["owner_id"]
            await db.execute(
                "UPDATE secrets SET owner_id=:uid, updated_at=now() WHERE id=:sid",
                {"uid": body.successor_id, "sid": item.secret_id},
            )
            await audit.notify(
                old_owner,
                "handover_out",
                {
                    "secret_id": item.secret_id,
                    "successor": succ["username"],
                    "by": ctx.user["username"],
                },
            )
        done.append(item.secret_id)
    await audit.audit(
        "org_recovery_regrant",
        user=ctx.user,
        ip=ctx.ip,
        reason=body.reason,
        target_type="user",
        target_id=body.successor_id,
        detail={"count": len(done), "transfer": body.transfer},
        severity="alert",
    )
    await audit.notify(
        body.successor_id,
        "handover_in",
        {"count": len(done), "by": ctx.user["username"], "transfer": body.transfer},
    )
    return {"ok": True, "count": len(done), "secret_ids": done}


@router.get("/admin/recovery/offline-package")
async def offline_package(ctx: Ctx = Depends(admin_ctx)):
    org = await db.fetch_one(
        "SELECT public_key, offline_salt, org_priv_offline_wrapped FROM org_recovery WHERE id = 1"
    )
    if not org:
        raise HTTPException(404, "组织恢复密钥未初始化")
    await audit.audit(
        "offline_package_exported", user=ctx.user, ip=ctx.ip, severity="alert"
    )
    return {
        "version": 1,
        "kdf": {"algo": "argon2id", "m_kb": 64 * 1024, "t": 3, "p": 1, "out_len": 32},
        "org_public_key": org["public_key"],
        "offline_salt_b64": org["offline_salt"].hex()
        if isinstance(org["offline_salt"], (bytes, bytearray))
        else org["offline_salt"],
        "org_priv_offline_wrapped_b64": org["org_priv_offline_wrapped"],
        "aad": "kb:org-offline",
        "instructions": [
            "1. 本文件含被离线恢复码加密的组织私钥；离线恢复码另行抄写在纸上，两者分开保管。",
            "2. 灾难恢复：恢复 pg_dump 备份到隔离环境，或直连只读副本。",
            "3. 运行 backend/scripts/offline_recover.py --package 本文件 --code <离线恢复码>",
            "   脚本在本地解开组织私钥并解出全部条目明文，全程不出本机。",
            "4. 用完即删；离线恢复码按规范定期轮换。",
        ],
    }
