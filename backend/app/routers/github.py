"""GitHub 热点路由：查看每日 trending（分类 Top10）与一键归档到文档区。

归档规则（设计需求 2026-11-12）：
- 文档区全局 doc 树下确保存在「GitHub」目录，其下确保存在对应分类子目录（不存在则创建）。
- 每个分类生成一篇 Markdown 日报（Top10 关键信息），同日同分类已存在则原地更新并重建索引。
- 归档走正常文档管线（worker 分块 + 嵌入），归档后即可被检索 / AI 问答引用。
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import audit, db, queue, storage, trending
from ..config import settings
from ..security import Ctx, current_user

router = APIRouter(prefix="/github", tags=["github"])


@router.get("/trending")
async def trending_view(force: bool = False, ctx: Ctx = Depends(current_user)) -> dict:
    try:
        return await trending.fetch_daily(force=force)
    except Exception as e:
        raise HTTPException(502, f"抓取 GitHub Trending 失败：{str(e)[:200]}") from None


# ---------- 归档 ----------


class ArchiveBody(BaseModel):
    category: str | None = Field(
        default=None, max_length=40, description="分类 key；缺省=全部分类"
    )


async def _ensure_doc_folder(name: str, parent_id: str | None) -> str:
    """doc 树（owner_id IS NULL）下按 父目录+名称 找目录，没有则创建。"""
    if parent_id is None:
        row = await db.fetch_one(
            "SELECT id FROM folders WHERE kind='doc' AND name=:name"
            " AND parent_id IS NULL AND owner_id IS NULL",
            {"name": name},
        )
    else:
        row = await db.fetch_one(
            "SELECT id FROM folders WHERE kind='doc' AND name=:name"
            " AND parent_id=:pid AND owner_id IS NULL",
            {"name": name, "pid": parent_id},
        )
    if row:
        return row["id"]
    row = await db.execute_returning(
        "INSERT INTO folders (kind, name, parent_id, owner_id)"
        " VALUES ('doc', :name, :pid, NULL) RETURNING id",
        {"name": name, "pid": parent_id},
    )
    if row is None:
        raise HTTPException(500, "目录创建失败")
    return row["id"]


def _render_markdown(date: str, cat: dict) -> str:
    lines = [
        f"# GitHub 每日热点 · {cat['label']} · {date}",
        "",
        f"> 每日 Top{len(cat['repos'])} · 数据来源 github.com/trending · 生成于 {date}",
        "",
    ]
    for i, r in enumerate(cat["repos"], 1):
        lines += [
            f"## {i}. {r['full_name']}",
            "",
            f"- 链接：{r['url']}",
            f"- 语言：{r['language'] or '未知'} ｜ 总星数：{r['stars']:,}"
            f" ｜ 今日新增：+{r['stars_today']:,} ｜ Fork：{r['forks']:,}",
            f"- 简介：{r['desc'] or '（无描述）'}",
            "",
        ]
    return "\n".join(lines)


async def _upsert_doc(
    title: str, folder_id: str, md: str, ctx: Ctx
) -> tuple[str, bool]:
    """同目录同名文档存在则原地更新内容并重建索引；否则新建。返回 (doc_id, created)。"""
    raw = md.encode("utf-8")
    import hashlib

    sha = hashlib.sha256(raw).hexdigest()
    old = await db.fetch_one(
        "SELECT id, file_path FROM documents WHERE title=:t AND folder_id=:fid",
        {"t": title, "fid": folder_id},
    )
    if old:
        rel = old["file_path"]
        full = storage.abs_path(rel, settings.data_dir)
        try:
            with open(full, "wb") as f:
                f.write(raw)
        except OSError as e:
            raise HTTPException(500, f"写文件失败：{e}") from None
        await db.execute(
            "UPDATE documents SET size_bytes=:sz, sha256=:sha, status='processing',"
            " error=NULL, chunk_count=0, updated_at=now() WHERE id=:id",
            {"sz": len(raw), "sha": sha, "id": old["id"]},
        )
        await db.execute("DELETE FROM chunks WHERE document_id=:id", {"id": old["id"]})
        await queue.enqueue_index(old["id"])
        return old["id"], False

    rel = storage.doc_file_rel_path(f"{title}.md")
    full = storage.abs_path(rel, settings.data_dir)
    try:
        with open(full, "wb") as f:
            f.write(raw)
    except OSError as e:
        raise HTTPException(500, f"写文件失败：{e}") from None
    row = await db.execute_returning(
        "INSERT INTO documents (title, filename, mime, size_bytes, sha256, file_path,"
        " project, tags, status, uploaded_by, folder_id, client_redacted)"
        " VALUES (:t, :f, 'text/markdown', :sz, :sha, :fp, 'GitHub',"
        " CAST(:tags AS jsonb), 'processing', :uid, :fid, FALSE)"
        " RETURNING id",
        {
            "t": title,
            "f": f"{title}.md",
            "sz": len(raw),
            "sha": sha,
            "fp": rel,
            "tags": db.j(["github", "trending", "日报"]),
            "uid": ctx.user["id"],
            "fid": folder_id,
        },
    )
    if row is None:
        raise HTTPException(500, "入库失败")
    await queue.enqueue_index(row["id"])
    return row["id"], True


@router.post("/archive")
async def archive(body: ArchiveBody, ctx: Ctx = Depends(current_user)) -> dict:
    try:
        data = await trending.fetch_daily()
    except Exception as e:
        raise HTTPException(502, f"抓取 GitHub Trending 失败：{str(e)[:200]}") from None

    cats = data["categories"]
    if body.category is not None:
        cats = [c for c in cats if c["key"] == body.category]
        if not cats:
            raise HTTPException(404, "该分类今日没有上榜项目")

    gh_id = await _ensure_doc_folder("GitHub", None)
    results = []
    for c in cats:
        cat_id = await _ensure_doc_folder(c["label"], gh_id)
        md = _render_markdown(data["date"], c)
        title = f"GitHub 每日热点 · {c['label']} · {data['date']}"
        doc_id, created = await _upsert_doc(title, cat_id, md, ctx)
        results.append(
            {
                "category": c["key"],
                "label": c["label"],
                "doc_id": doc_id,
                "created": created,
                "repos": len(c["repos"]),
            }
        )
        # 小睡一下：避免批量归档时同时塞多个嵌入任务打爆 API 限速
        await asyncio.sleep(0.2)

    await audit.audit(
        "gh_archive_created",
        user=ctx.user,
        ip=ctx.ip,
        detail={"date": data["date"], "docs": [r["label"] for r in results]},
    )
    return {
        "date": data["date"],
        "results": results,
        "note": "已写入 文档区/GitHub/<分类>，索引就绪后即可搜索",
    }
