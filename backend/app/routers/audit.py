"""审计查询与通知（设计 /audit：成员看自己，管理员看全部）。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .. import db
from ..security import Ctx, current_user

router = APIRouter(tags=["audit"])


@router.get("/audit")
async def query_audit(
    request: Request,
    action: str = "",
    user_id: str = "",
    limit: int = 100,
    from_ts: str = "",
    to_ts: str = "",
):
    ctx: Ctx = await current_user(request)
    if ctx.user["role"] != "admin":
        user_id = ctx.user["id"]  # 成员只看自己
    elif user_id:
        target = await db.fetch_one(
            "SELECT id FROM users WHERE id = :uid", {"uid": user_id}
        )
        if not target:
            raise HTTPException(404, "用户不存在")
    sql = (
        "SELECT a.id, a.user_id, a.username, a.action, a.target_type, a.target_id,"
        " a.ip, a.reason, a.detail, a.severity, a.created_at"
        " FROM audit_logs a WHERE 1=1"
    )
    params: dict = {"limit": min(max(limit, 1), 200)}
    if user_id:
        sql += " AND a.user_id = :uid"
        params["uid"] = user_id
    if action:
        sql += " AND a.action = :act"
        params["act"] = action[:64]
    if from_ts:
        sql += " AND a.created_at >= :f"
        params["f"] = from_ts
    if to_ts:
        sql += " AND a.created_at <= :t"
        params["t"] = to_ts
    sql += " ORDER BY a.created_at DESC LIMIT :limit"
    rows = await db.fetch_all(sql, params)
    return {"logs": rows}


@router.get("/notifications")
async def notifications(request: Request):
    ctx: Ctx = await current_user(request)
    rows = await db.fetch_all(
        "SELECT id, type, payload, read_at, created_at FROM notifications"
        " WHERE user_id = :uid ORDER BY read_at NULLS FIRST, created_at DESC LIMIT 50",
        {"uid": ctx.user["id"]},
    )
    return {"notifications": rows}


@router.post("/notifications/{nid}/read")
async def read_notification(nid: str, request: Request):
    ctx: Ctx = await current_user(request)
    await db.execute(
        "UPDATE notifications SET read_at = now() WHERE id = :nid AND user_id = :uid AND read_at IS NULL",
        {"nid": nid, "uid": ctx.user["id"]},
    )
    return {"ok": True}


@router.post("/notifications/read-all")
async def read_all_notifications(request: Request):
    ctx: Ctx = await current_user(request)
    await db.execute(
        "UPDATE notifications SET read_at = now() WHERE user_id = :uid AND read_at IS NULL",
        {"uid": ctx.user["id"]},
    )
    return {"ok": True}
