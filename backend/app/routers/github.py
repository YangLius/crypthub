"""GitHub 热点路由：查看每日 trending（两级分类全量）与归档到文档区。

归档规则（2026-11-12 v2）：
- 请求体 {full_names: ["owner/repo", ...]}：单项目=1 个元素，批量=多个（即页面勾选）。
- 每个项目按其当日分类落盘：文档区 GitHub/<父分类>[/<子分类>]，目录不存在自动创建。
- 文档标题《GitHub 项目 · owner/repo · 日期》，同日同项目重复归档=原地更新并重建索引。
- 走正常 worker 分块 + 嵌入管线，归档后即可被检索 / AI 问答引用。
"""

from __future__ import annotations

import asyncio
import contextlib

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import audit, db, queue, storage, trending
from ..config import settings
from ..security import Ctx, current_user

router = APIRouter(prefix="/github", tags=["github"])


@router.get("/trending")
async def trending_view(
    range: str = "daily", force: bool = False, ctx: Ctx = Depends(current_user)
) -> dict:
    try:
        return await trending.get_range(range, force=force)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    except Exception as e:
        raise HTTPException(502, f"抓取 GitHub Trending 失败：{str(e)[:200]}") from None


# ---------- 归档 ----------


class ArchiveBody(BaseModel):
    full_names: list[str] = Field(min_length=1, max_length=100)


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


def _render_repo_md(
    repo: dict, cat_label: str, sub_label: str | None, date: str
) -> str:
    sub_part = f" / {sub_label}" if sub_label else ""
    delta = (
        f"｜ 今日新增：+{repo['stars_today']:,}"
        if repo.get("stars_today") is not None
        else "｜ 每日新增：未知（新星池）"
    )
    created = repo.get("created_at")
    created_line = f"\n- 建库日期：{created}" if created else ""
    return "\n".join(
        [
            f"# {repo['full_name']}",
            "",
            f"> 分类：{cat_label}{sub_part} ｜ 归档日期：{date} ｜ 来源 github.com/trending",
            "",
            f"- 链接：{repo['url']}",
            f"- 语言：{repo['language'] or '未知'} ｜ 总星数：{repo['stars']:,}"
            f" {delta} ｜ Fork：{repo['forks']:,}",
            created_line,
            "",
            "## 简介",
            "",
            repo["desc"] or "（无描述）",
            "",
        ]
    )


async def _upsert_doc(
    title: str, folder_id: str, md: str, ctx: Ctx
) -> tuple[str, bool]:
    """同目录同名文档存在则原地更新内容并重建索引；否则新建。返回 (doc_id, created)。"""
    import hashlib

    raw = md.encode("utf-8")
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
            "tags": db.j(["github", "trending", "项目"]),
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
    # 归档索引：合并今日/本周/本月/新星四个范围（各自有缓存，失败的范围跳过）
    payloads: list[dict] = []
    for rk in trending.RANGE_KEYS:
        with contextlib.suppress(Exception):
            payloads.append(await trending.get_range(rk))
    if not payloads:
        raise HTTPException(502, "GitHub 数据不可用（请稍后重试或检查网络）")
    index = trending.repo_index(payloads)
    date = payloads[0].get("date", "")

    names = [n.strip().strip("/") for n in body.full_names if n.strip()]
    gh_id = await _ensure_doc_folder("GitHub", None)

    results: list[dict] = []
    not_found: list[str] = []
    for fn in names:
        hit = index.get(fn)
        if hit is None:
            not_found.append(fn)
            continue
        repo = hit["repo"]
        folder_id, path_parts = gh_id, ["GitHub", hit["cat_label"]]
        folder_id = await _ensure_doc_folder(hit["cat_label"], gh_id)
        if hit["sub_label"]:
            folder_id = await _ensure_doc_folder(hit["sub_label"], folder_id)
            path_parts.append(hit["sub_label"])
        title = f"GitHub 项目 · {fn} · {date}"
        md = _render_repo_md(repo, hit["cat_label"], hit["sub_label"], date)
        doc_id, created = await _upsert_doc(title, folder_id, md, ctx)
        results.append(
            {
                "full_name": fn,
                "doc_id": doc_id,
                "created": created,
                "path": "/".join(path_parts),
                "category": hit["cat_label"],
                "sub": hit["sub_label"],
                "stars": repo["stars"],
                "stars_today": repo.get("stars_today"),
            }
        )
        # 小睡一下：批量归档时避免同时塞太多嵌入任务打爆 API 限速
        await asyncio.sleep(0.2)

    if not results:
        raise HTTPException(404, "所选项目均不在今日热榜中（请刷新后重试）")

    await audit.audit(
        "gh_archive_created",
        user=ctx.user,
        ip=ctx.ip,
        detail={
            "date": date,
            "repos": [r["full_name"] for r in results],
            "not_found": not_found,
        },
    )
    return {
        "date": date,
        "results": results,
        "not_found": not_found,
        "note": "已写入 文档区/GitHub/<分类>[/<子分类>]，索引就绪后即可搜索",
    }
