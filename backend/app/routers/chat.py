"""问答路由（设计 /chat）：检索 → LLM → 输出闸 → 带出处答案 + 关联凭据提示。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import audit, db, gates, llm, retrieval, security
from ..config import settings
from ..security import Ctx, current_user

router = APIRouter(tags=["chat"])

BLOCK_MESSAGE = "本次回答可能包含凭据，已拦截"


class ChatBody(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    project: str | None = Field(default=None, max_length=64)


@router.post("/chat")
async def chat(body: ChatBody, request: Request):
    ctx: Ctx = await current_user(request)
    await security.rate_limit(
        f"kb:chat:{ctx.user['id']}", settings.rl_chat_limit, settings.rl_chat_window
    )
    if not (settings.llm_api_base and settings.llm_api_key):
        raise HTTPException(503, "LLM 未配置（LLM_API_BASE / LLM_API_KEY / LLM_MODEL）")
    try:
        contexts = await retrieval.retrieve(body.question, project=body.project, top=5)
    except RuntimeError as e:
        raise HTTPException(503, f"检索服务不可用: {e}") from e

    if not contexts:
        return {"answer": "资料中未找到相关内容。", "citations": [], "secret_refs": []}

    try:
        answer = await llm.chat(body.question, contexts)
    except Exception as e:
        raise HTTPException(502, f"LLM 调用失败: {type(e).__name__}") from e

    # 输出闸（设计第 6 节）：命中整段阻断 + 高优先级审计告警
    hits = gates.scan(answer, strict=True)
    if hits:
        await audit.audit(
            "output_gate_blocked",
            user=ctx.user,
            ip=ctx.ip,
            detail={"hits": len(hits), "kinds": sorted({h.kind for h in hits})},
            severity="alert",
        )
        return {
            "answer": "",
            "blocked": True,
            "message": BLOCK_MESSAGE,
            "citations": [],
            "secret_refs": [],
        }

    # 引用与关联凭据（secret_ref 永不进 LLM 上下文，只做跳转提示）
    citations = []
    doc_ids: list[str] = []
    for c in contexts:
        if c["document_id"] in doc_ids:
            continue
        doc_ids.append(c["document_id"])
        citations.append(
            {
                "document_id": c["document_id"],
                "title": c["title"],
                "anchor": c["anchor"],
                "idx": c["idx"],
            }
        )
    secret_refs: list[dict] = []
    if doc_ids:
        docs = await db.fetch_all(
            "SELECT d.id, d.secret_ref, s.name FROM documents d"
            " LEFT JOIN secrets s ON s.id = d.secret_ref"
            " WHERE d.id = ANY(CAST(:ids AS uuid[])) AND d.secret_ref IS NOT NULL",
            {"ids": doc_ids},
        )
        if docs:
            mine = await db.fetch_all(
                "SELECT secret_id FROM secret_grants WHERE user_id = :uid"
                " AND secret_id = ANY(CAST(:sids AS uuid[]))",
                {"uid": ctx.user["id"], "sids": [d["secret_ref"] for d in docs]},
            )
            accessible = {m["secret_id"] for m in mine}
            for d in docs:
                if d["secret_ref"] in accessible and d["name"]:
                    secret_refs.append(
                        {"secret_id": d["secret_ref"], "name": d["name"]}
                    )
    return {"answer": answer, "citations": citations, "secret_refs": secret_refs}
