"""Dify 外部知识库回调（设计第 9 节，第二阶段接入）：服务间密钥鉴权，只返回已脱敏片段。"""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from .. import audit, retrieval, security
from ..config import settings

router = APIRouter(prefix="/dify", tags=["dify"])


class RetrievalBody(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    top_k: int = Field(default=5, ge=1, le=20)


@router.post("/retrieval")
async def retrieval_callback(body: RetrievalBody, request: Request,
                             x_service_key: str = Header(default="")):
    if not settings.dify_service_key:
        raise HTTPException(503, "Dify 回调未启用（未配置 DIFY_SERVICE_KEY）")
    if not security.const_eq(x_service_key, settings.dify_service_key):
        raise HTTPException(401, "服务密钥无效")
    rows = await retrieval.retrieve(body.query, top=body.top_k)
    await audit.audit("dify_retrieval", detail={"top_k": body.top_k, "hits": len(rows)})
    return {
        "records": [
            {
                "content": r["text"],
                "score": round(min(0.99, float(r.get("rrf", 0)) * 10), 4),
                "title": r["title"],
                "metadata": {"document_id": r["document_id"], "anchor": r["anchor"],
                             "chunk_idx": r["idx"]},
            }
            for r in rows
        ]
    }
