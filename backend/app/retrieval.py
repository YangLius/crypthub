"""混合检索（设计 5.3）：向量 top-8 + 关键词 top-8 → RRF 融合取前 5。

实现偏差（2026-11-10 联调确认）：目标 PostgreSQL 未安装 pgvector 扩展，
embedding 存 real[]；向量检索改为两阶段——先取全部向量在 Python 侧做
精确余弦扫描（设计本就不建 ANN 索引、百级文档规模），再按 top id 取整行。
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from heapq import nlargest

from . import db
from .embedding import embed_texts

VEC_K = 8
KW_K = 8
RRF_K = 60
# 向量扫描行数上限：远超预期规模时保护内存/网络
VEC_SCAN_CAP = 20000


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """余弦相似度；维度不匹配或零向量返回 0。"""
    if len(a) != len(b) or not a:
        return 0.0
    dot = math.fsum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(math.fsum(x * x for x in a))
    nb = math.sqrt(math.fsum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


async def _vector_search(qvec: list[float], k: int = VEC_K) -> list[dict]:
    # 阶段一：只取向量算分（避免为大文本付网络开销）
    sql1 = (
        "SELECT c.id, c.embedding"
        " FROM chunks c JOIN documents d ON d.id = c.document_id AND d.status = 'ready'"
        " WHERE c.embedding IS NOT NULL LIMIT :cap"
    )
    rows = await db.fetch_all(sql1, {"cap": VEC_SCAN_CAP})
    scored = [
        (r["id"], _cosine(qvec, r["embedding"]))
        for r in rows
        if isinstance(r["embedding"], (list, tuple))
    ]
    top = nlargest(k, scored, key=lambda t: t[1])
    top_ids = [i for i, s in top if s > 0.0]
    if not top_ids:
        return []
    # 阶段二：取 top id 的完整行（数组绑定参数，无字符串拼接）
    sql2 = (
        "SELECT c.id, c.document_id, c.idx, c.anchor, c.text, d.title, d.project"
        " FROM chunks c JOIN documents d ON d.id = c.document_id AND d.status = 'ready'"
        " WHERE c.id = ANY(CAST(:ids AS bigint[]))"
    )
    rows2 = await db.fetch_all(sql2, {"ids": top_ids})
    score_by_id = dict(top)
    for r in rows2:
        r["score"] = score_by_id.get(r["id"], 0.0)
    return sorted(rows2, key=lambda r: -r["score"])


def _tsquery(text: str) -> str:
    import jieba

    toks = [
        t
        for t in jieba.cut_for_search(text)
        if t.strip()
        and t.strip()
        not in ("，", "。", "、", "的", "是", "了", "在", "和", "与", "或", "对", "为")
    ]
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
    fused: dict[object, dict] = {}
    for rs in result_sets:
        for rank, row in enumerate(rs, 1):
            cid = row["id"]
            entry = fused.setdefault(cid, {**row, "rrf": 0.0})
            entry["rrf"] += 1.0 / (RRF_K + rank)
    out = sorted(fused.values(), key=lambda r: -r["rrf"])[:top]
    return out


async def retrieve(
    query: str, *, project: str | None = None, top: int = 5
) -> list[dict]:
    vecs = await embed_texts([query])
    vs = await _vector_search(vecs[0])
    ks = await _keyword_search(query)
    merged = _rrf_fuse(vs, ks, top=top)
    if project:
        merged = [r for r in merged if r.get("project") == project]
    return merged
