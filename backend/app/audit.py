"""审计与通知：只记动作，绝不记内容。"""

from __future__ import annotations

from . import db

# 动作清单（新增动作需在此登记，避免随意写 action）
ACTIONS = {
        "bootstrap",
        "setup_completed",
        "login",
        "login_failed",
        "logout",
        "unlock",
        "lock",
        "user_created",
        "folder_created",
        "folder_updated",
        "folder_deleted",
        "user_disabled",
        "user_enabled",
        "role_changed",
        "user_reset",
        "doc_uploaded",
        "doc_updated",
        "doc_deleted",
        "doc_reindexed",
        "secret_created",
        "secret_updated",
        "secret_deleted",
        "secret_rotated",
        "secret_revealed",
        "grant_created",
        "grant_revoked",
        "org_recovery_prepare",
        "org_recovery_entries_listed",
        "org_recovery_regrant",
        "offline_package_exported",
        "output_gate_blocked",
        "handover",
        "dify_retrieval",
        "pending_claimed",
        "group_created",
        "group_members_set",
        "system_config_revealed",
        "system_config_updated",
        "system_config_db_updated",
}


async def audit(
        action: str,
        *,
        user: dict | None = None,
        target_type: str = "",
        target_id: str = "",
        ip: str = "",
        reason: str = "",
        detail: dict | None = None,
        severity: str = "info",
) -> None:
        if action not in ACTIONS:
                raise ValueError(f"未登记的审计动作: {action}")
        detail = detail or {}
        # 防御：detail 不允许出现疑似内容的键
        for k in ("content", "content_ct", "password", "plaintext", "answer", "text"):
                if k in detail:
                        raise ValueError(f"审计 detail 禁止携带 {k}")
        await db.execute(
                "INSERT INTO audit_logs (user_id, username, action, target_type, target_id, ip, reason, detail, severity)"
                " VALUES (:uid, :uname, :action, :tt, :tid, :ip, :reason, CAST(:detail AS jsonb), :severity)",
                {
                        "uid": user["id"] if user else None,
                        "uname": (user or {}).get("username", ""),
                        "action": action,
                        "tt": target_type,
                        "tid": str(target_id),
                        "ip": ip,
                        "reason": reason[:500],
                        "detail": db.j(detail),
                        "severity": severity,
                },
        )


async def notify(user_id: str, ntype: str, payload: dict) -> None:
        await db.execute(
                "INSERT INTO notifications (user_id, type, payload) VALUES (:uid, :type, CAST(:payload AS jsonb))",
                {"uid": user_id, "type": ntype, "payload": db.j(payload)},
        )
