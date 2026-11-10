"""混合检索（设计 5.3）：向量 top-8 + 关键词 top-8 → RRF 融合取前 5。"""
from __future__ import annotations

from . import db
from .embedding import embed_texts

VEC_K = 8
KW_K = 8
RRF_K = 60


async def _vector_search(qvec_str: str, k: int = VEC_K) -> list[dict]:
    sql = (
        "SELECT c.id, c.document_id, c.idx, c.anchor, c.text, d.title, d.project,"
        " 1 - (c.embedding <=> CAST(:v AS vector)) AS score"
        " FROM chunks c JOIN documents d ON d.id = c.document_id AND d.status = 'ready'"
        " WHERE c.embedding IS NOT NULL"
        " ORDER BY c.embedding <=> CAST(:v AS vector) LIMIT :k"
    )
    return await db.fetch_all(sql, {"v": qvec_str, "k": k})


def _tsquery(text: str) -> str:
    import jieba
    toks = [t for t in jieba.cut_for_search(text) if t.strip() and t.strip() not in
            ("，", "。", "、", "的", "是", "了", "在", "和", "与", "或", "对", "为")]
    safe = [t.replace("'", " ").replace("\\", " ") for t in toks]
    return " | ".join(f"'{t}'" for t in safe) if safe else "'__none__'"


async def _keyword_search(qtext: str, k: int = KW_K) -> list[dict]:
    tsq = _tsquery(qtext)
    sql = (
        "SELECT c.id, c.document_id, c.idx, c.anchor, c.text, d.title, d.project,"
        " GREATEST(ts_rank(c.tsv, to_tsquery('simple', :tsq)),"
        "          similarity(c.text, :qt)) AS score"
        " FROM chunks c JOIN documents d ON d.id = c.document_id AND d.status = 'ready'"
        " WHERE c.tsv @@ to_tsquery('simple', :tsq) OR c.text % :qt"
        " ORDER BY score DESC LIMIT :k"
    )
    return await db.fetch_all(sql, {"tsq": tsq, "qt": qtext[:200], "k": k})


def _rrf_fuse(*result_sets: list[dict], top: int = 5) -> list[dict]:
    fused: dict[int, dict] = {}
    for rs in result_sets:
        for rank, row in enumerate(rs, 1):
            cid = row["id"]
            entry = fused.setdefault(cid, {**row, "rrf": 0.0})
            entry["rrf"] += 1.0 / (RRF_K + rank)
    out = sorted(fused.values(), key=lambda r: -r["rrf"])[:top]
    return out


async def retrieve(query: str, *, project: str | None = None, top: int = 5) -> list[dict]:
    vecs = await embed_texts([query])
    qvec = db.vec(vecs[0])
    vs = await _vector_search(qvec)
    ks = await _keyword_search(query)
    merged = _rrf_fuse(vs, ks, top=top)
    if project:
        merged = [r for r in merged if r.get("project") == project]
    return merged
