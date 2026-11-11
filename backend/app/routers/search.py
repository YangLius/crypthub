"""检索路由（设计 /search）：语义 + 关键词混合检索。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import retrieval
from ..security import current_user

router = APIRouter(tags=["search"])


class SearchBody(BaseModel):
    q: str = Field(min_length=1, max_length=500)
    project: str | None = Field(default=None, max_length=64)
    top_k: int = Field(default=10, ge=1, le=50)


@router.post("/search")
async def search(body: SearchBody, request: Request):
    await current_user(request)
    try:
        rows = await retrieval.retrieve(body.q, project=body.project, top=body.top_k)
    except RuntimeError as e:
        raise HTTPException(503, f"检索服务不可用: {e}") from e
    results = []
    for r in rows:
        results.append(
            {
                "document_id": r["document_id"],
                "title": r["title"],
                "anchor": r["anchor"],
                "idx": r["idx"],
                "snippet": r["text"][:300],
                "score": round(min(0.99, float(r.get("rrf", 0)) * 10), 4),
            }
        )
    return {"results": results, "query": body.q}
