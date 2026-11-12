"""文档路由：上传（含客户端预扫结果登记）、列表、元数据更新、删除、重建索引。"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from .. import audit, db, queue, storage
from ..config import settings
from ..security import Ctx, current_user

router = APIRouter(prefix="/documents", tags=["documents"])


class PendingItem(BaseModel):
    slug: str = Field(min_length=6, max_length=64, pattern="^[a-f0-9]+$")
    kind: str = Field(default="", max_length=32)


class PendingBody(BaseModel):
    items: list[PendingItem] = Field(min_length=1, max_length=200)


class DocUpdateBody(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    project: str | None = Field(default=None, max_length=64)
    tags: list[str] | None = Field(default=None, max_length=20)
    secret_ref: str | None = Field(default=None, max_length=64)
    folder_id: str | None = Field(
        default=None, max_length=64
    )  # None=不改动；"root"=移回根


def _parse_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        v = json.loads(raw)
    except ValueError:
        v = None
    if isinstance(v, list):
        return [str(t)[:64] for t in v[:20]]
    return [t.strip()[:64] for t in raw.split(",") if t.strip()][:20]


@router.post("")
async def upload(
    request: Request,
    file: UploadFile = File(...),
    title: str = Form(""),
    project: str = Form(""),
    tags: str = Form(""),
    client_redacted: str = Form("false"),
    folder_id: str = Form(""),
):
    ctx: Ctx = await current_user(request)
    data = bytearray()
    while True:
        chunk = await file.read(1024 * 512)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > settings.max_upload_mb * 1024 * 1024:
            raise HTTPException(413, f"文件超过 {settings.max_upload_mb}MB 限制")
    raw = bytes(data)
    if not raw:
        raise HTTPException(400, "空文件")
    filename = os.path.basename(file.filename or "untitled")
    mime = file.content_type or ""
    title = (title or os.path.splitext(filename)[0])[:200]

    up_folder: str | None = None
    if folder_id:
        f = await db.fetch_one(
            "SELECT id FROM folders WHERE id = :fid AND kind = 'doc' AND owner_id IS NULL",
            {"fid": folder_id},
        )
        if not f:
            raise HTTPException(404, "目标目录不存在")
        up_folder = folder_id

    sha = hashlib.sha256(raw).hexdigest()
    # 重复上传 → 原地更新而不是新建/报 409：
    #   ① 内容完全相同（sha256 全局一致），或
    #   ② 同一用户上传过同名文档（内容变了，如脱敏规则升级后重传同一文件）
    dup = await db.fetch_one(
        "SELECT id, title, file_path, sha256 FROM documents"
        " WHERE sha256 = :sha OR (title = :title AND uploaded_by = :uid)"
        " ORDER BY (sha256 = :sha) DESC, updated_at DESC LIMIT 1",
        {"sha": sha, "title": title, "uid": ctx.user["id"]},
    )
    if dup:
        same_content = dup["sha256"] == sha
        if same_content:
            # 字节一致：复用旧文件，不重复落盘
            fp_bind: str | None = None
            sha_bind: str | None = None
            sz_bind: int | None = None
        else:
            rel = storage.doc_file_rel_path(filename)
            full = storage.abs_path(rel, settings.data_dir)
            try:
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "wb") as fo:
                    fo.write(raw)
            except OSError as e:
                raise HTTPException(500, f"文件保存失败: {e}") from e
            old_full = storage.abs_path(dup["file_path"], settings.data_dir)
            if old_full != full:
                # 旧文件缺失不阻塞更新
                with contextlib.suppress(OSError):
                    os.remove(old_full)
            fp_bind = rel
            sha_bind = sha
            sz_bind = len(raw)
        # 旧索引与新占位符（未认领的）随文档更新一并作废；已认领的保留作审计
        await db.execute(
            "DELETE FROM chunks WHERE document_id = :did", {"did": dup["id"]}
        )
        await db.execute(
            "DELETE FROM pending_secrets WHERE source_doc_id = :did AND status = 'open'",
            {"did": dup["id"]},
        )
        row = await db.execute_returning(
            "UPDATE documents SET title = :t, filename = :f, mime = :m,"
            " size_bytes = COALESCE(:sz, size_bytes), sha256 = COALESCE(:sha, sha256),"
            " file_path = COALESCE(:fp, file_path), project = :pj,"
            " tags = CAST(:tags AS jsonb), folder_id = COALESCE(:fid, folder_id),"
            " client_redacted = :cr, status = 'processing', error = NULL,"
            " chunk_count = 0, updated_at = now()"
            " WHERE id = :did RETURNING id, title, status",
            {
                "t": title,
                "f": filename,
                "m": mime,
                "sz": sz_bind,
                "sha": sha_bind,
                "fp": fp_bind,
                "pj": (project or "")[:64],
                "tags": db.j(_parse_tags(tags)),
                "fid": up_folder,
                "cr": client_redacted == "true",
                "did": dup["id"],
            },
        )
        if row is None:
            raise HTTPException(500, "更新失败")
        await queue.enqueue_index(row["id"])
        await audit.audit(
            "doc_updated",
            user=ctx.user,
            target_type="document",
            target_id=row["id"],
            ip=ctx.ip,
            detail={
                "update_reason": "same_sha256" if same_content else "re_upload",
                "size": len(raw),
            },
        )
        return {
            "id": row["id"],
            "title": row["title"],
            "status": "processing",
            "updated": True,
        }

    # 文本类文件服务端兜底扫描在 worker 解析后统一进行（模式 B），
    # 这里只登记客户端预扫产生的占位符。
    rel = storage.doc_file_rel_path(filename)
    row = await db.execute_returning(
        "INSERT INTO documents (title, filename, mime, size_bytes, sha256, file_path,"
        " project, tags, status, uploaded_by, folder_id, client_redacted)"
        " VALUES (:t, :f, :m, :sz, :sha, :fp, :pj, CAST(:tags AS jsonb), 'processing', :uid, :fid, :cr)"
        " RETURNING id, title, status",
        {
            "t": title,
            "f": filename,
            "m": mime,
            "sz": len(raw),
            "sha": sha,
            "fp": rel,
            "pj": (project or "")[:64],
            "tags": db.j(_parse_tags(tags)),
            "uid": ctx.user["id"],
            "fid": up_folder,
            "cr": client_redacted == "true",
        },
    )
    if row is None:
        raise HTTPException(500, "入库失败")

    full = storage.abs_path(rel, settings.data_dir)
    try:
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as fo:
            fo.write(raw)
    except OSError as e:
        raise HTTPException(500, f"文件保存失败: {e}") from e

    await queue.enqueue_index(row["id"])
    await audit.audit(
        "doc_uploaded",
        user=ctx.user,
        target_type="document",
        target_id=row["id"],
        ip=ctx.ip,
        detail={"size": len(raw), "client_redacted": client_redacted == "true"},
    )
    return {"id": row["id"], "title": row["title"], "status": "processing"}


@router.get("")
async def list_documents(
    request: Request, project: str = "", tag: str = "", limit: int = 200
):
    await current_user(request)
    sql = (
        "SELECT d.id, d.title, d.filename, d.mime, d.size_bytes, d.project, d.tags,"
        " d.status, d.error, d.chunk_count, d.secret_ref, d.folder_id, d.created_at, d.updated_at,"
        " u.username AS uploader"
        " FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE 1=1"
    )
    params: dict = {"limit": min(limit, 500)}
    if project:
        sql += " AND d.project = :pj"
        params["pj"] = project
    if tag:
        sql += " AND d.tags @> CAST(:tag AS jsonb)"
        params["tag"] = db.j([tag])
    sql += " ORDER BY d.created_at DESC LIMIT :limit"
    rows = await db.fetch_all(sql, params)
    return {"documents": rows}


@router.get("/pending")
async def list_pending(request: Request):
    ctx: Ctx = await current_user(request)
    rows = await db.fetch_all(
        "SELECT p.id, p.slug, p.kind, p.source_doc_id, p.source_hint, p.status, p.created_at, d.title AS doc_title"
        " FROM pending_secrets p LEFT JOIN documents d ON d.id = p.source_doc_id"
        " WHERE p.created_by = :uid AND p.status = 'open' ORDER BY p.created_at DESC LIMIT 200",
        {"uid": ctx.user["id"]},
    )
    return {"pending": rows}


@router.get("/{doc_id}")
async def get_document(doc_id: str, request: Request):
    await current_user(request)
    d = await db.fetch_one(
        "SELECT id, title, filename, mime, size_bytes, project, tags, status, error,"
        " chunk_count, secret_ref, folder_id, client_redacted, created_at, updated_at FROM documents WHERE id = :id",
        {"id": doc_id},
    )
    if not d:
        raise HTTPException(404, "文档不存在")
    return d


@router.get("/{doc_id}/redacted")
async def get_redacted_text(doc_id: str, request: Request):
    """返回客户端预扫替换后的脱敏文本（仅占位符、无凭据原文）。

    供密钥区"从本机原文回填"把占位符与本机原始文件重新扫描出的命中做上下文配对。
    仅 client_redacted=true 的文档提供（服务端存的文件本身就是脱敏文本）；
    非脱敏文档一律 404，避免变相提供原始文件下载。
    """
    await current_user(request)
    d = await db.fetch_one(
        "SELECT id, title, project, client_redacted, file_path"
        " FROM documents WHERE id = :id",
        {"id": doc_id},
    )
    if not d or not d["client_redacted"]:
        raise HTTPException(404, "该文档没有可用的脱敏文本")
    full = storage.abs_path(d["file_path"], settings.data_dir)
    try:
        if os.path.getsize(full) > 2 * 1024 * 1024:
            raise HTTPException(400, "脱敏文本过大，请手工认领")
        with open(full, "rb") as fo:
            raw = fo.read()
    except OSError:
        raise HTTPException(404, "脱敏文本文件缺失") from None
    return {
        "id": d["id"],
        "title": d["title"],
        "project": d["project"],
        "text": raw.decode("utf-8", errors="replace"),
    }


def _stitch_join(texts: list[str]) -> str:
    """按序拼接分块文本，并去除相邻分块间的重叠部分。

    索引分块为保上下文会让每块携带前一块末尾约 80 字符（超长硬切也是
    step = MAX_LEN - OVERLAP）；直接 join 会在阅读视图里出现重复段落。
    这里对相邻块做尾部/头部精确匹配（窗口 200 字符，最短 20）去重；
    无重叠（短文档逻辑切分）时按原文换行拼接。
    """
    out = ""
    for t in texts:
        if not t:
            continue
        if not out:
            out = t
            continue
        window = min(200, len(out), len(t))
        stitched = False
        for k in range(window, 19, -1):
            if out[-k:] == t[:k]:
                out += t[k:]
                stitched = True
                break
        if not stitched:
            out += "\n" + t
    return out


@router.get("/{doc_id}/view")
async def view_document(doc_id: str, request: Request):
    """在线查看文档正文（已索引的安全文本，非原始文件下载）。

    正文由索引分块按序拼接：PDF/DOCX 是解析后的文本，.md/.txt 是入库前
    已脱敏（服务端门禁或客户端预扫）的文本，均不含凭据原文，可安全展示。
    """
    await current_user(request)
    d = await db.fetch_one(
        "SELECT id, title, status, error, chunk_count FROM documents WHERE id = :id",
        {"id": doc_id},
    )
    if not d:
        raise HTTPException(404, "文档不存在")
    if d["status"] == "processing":
        raise HTTPException(409, "文档正在索引中，请稍后再试")
    if d["status"] == "failed":
        raise HTTPException(409, f"文档索引失败：{d['error'] or '未知原因'}")
    rows = await db.fetch_all(
        "SELECT text FROM chunks WHERE document_id = :id ORDER BY idx",
        {"id": doc_id},
    )
    if not rows:
        raise HTTPException(404, "文档暂无可展示的正文")
    text = _stitch_join([r["text"] for r in rows])
    truncated = False
    if len(text) > 500_000:
        text = text[:500_000]
        truncated = True
    return {
        "id": d["id"],
        "title": d["title"],
        "chunk_count": d["chunk_count"],
        "text": text,
        "truncated": truncated,
    }


@router.get("/{doc_id}/placeholders")
async def list_placeholders(doc_id: str, request: Request):
    """本文档的密钥占位符 → 已认领密钥映射（仅供前端本机解密回显）。

    只返回当前用户自己产生的占位符（created_by = 当前用户），
    且只暴露 slug → secret_id 映射，不含任何明文/密文；
    前端解锁密钥区后自行 reveal + 本地解密完成回显，服务端全程不碰明文。
    """
    ctx: Ctx = await current_user(request)
    d = await db.fetch_one("SELECT id FROM documents WHERE id = :id", {"id": doc_id})
    if not d:
        raise HTTPException(404, "文档不存在")
    rows = await db.fetch_all(
        "SELECT slug, status, claimed_secret_id FROM pending_secrets"
        " WHERE source_doc_id = :did AND created_by = :uid"
        " AND status IN ('open', 'claimed')",
        {"did": doc_id, "uid": ctx.user["id"]},
    )
    return {
        "placeholders": [
            {
                "slug": r["slug"],
                "status": r["status"],
                "secret_id": r["claimed_secret_id"],
            }
            for r in rows
        ]
    }


@router.patch("/{doc_id}")
async def update_document(doc_id: str, body: DocUpdateBody, request: Request):
    ctx: Ctx = await current_user(request)
    d = await db.fetch_one("SELECT id FROM documents WHERE id = :id", {"id": doc_id})
    if not d:
        raise HTTPException(404, "文档不存在")
    if body.secret_ref:
        s = await db.fetch_one(
            "SELECT id FROM secrets WHERE id = :sid", {"sid": body.secret_ref}
        )
        if not s:
            raise HTTPException(404, "关联的密钥条目不存在")
    has_folder = body.folder_id is not None
    new_folder: str | None = None
    if has_folder and body.folder_id != "root":
        f = await db.fetch_one(
            "SELECT id FROM folders WHERE id = :fid AND kind = 'doc' AND owner_id IS NULL",
            {"fid": body.folder_id},
        )
        if not f:
            raise HTTPException(404, "目标目录不存在")
        new_folder = body.folder_id
    await db.execute(
        "UPDATE documents SET"
        " title = COALESCE(:t, title), project = COALESCE(:pj, project),"
        " tags = COALESCE(CAST(:tags AS jsonb), tags),"
        " secret_ref = CASE WHEN :has_ref THEN :ref ELSE secret_ref END,"
        " folder_id = CASE WHEN :has_folder THEN :fid ELSE folder_id END,"
        " updated_at = now() WHERE id = :id",
        {
            "t": body.title,
            "pj": body.project,
            "tags": db.j(body.tags) if body.tags is not None else None,
            "has_ref": body.secret_ref is not None,
            "ref": body.secret_ref,
            "has_folder": has_folder,
            "fid": new_folder,
            "id": doc_id,
        },
    )
    await audit.audit(
        "doc_updated",
        user=ctx.user,
        target_type="document",
        target_id=doc_id,
        ip=ctx.ip,
    )
    return {"ok": True}


@router.post("/{doc_id}/pending")
async def report_pending(doc_id: str, body: PendingBody, request: Request):
    """客户端预扫（模式 A）命中的占位符登记为待认领。"""
    ctx: Ctx = await current_user(request)
    d = await db.fetch_one(
        "SELECT id, title FROM documents WHERE id = :id", {"id": doc_id}
    )
    if not d:
        raise HTTPException(404, "文档不存在")
    for item in body.items:
        await db.execute(
            "INSERT INTO pending_secrets (slug, kind, source_doc_id, source_hint, created_by)"
            " VALUES (:slug, :kind, :doc, :hint, :uid) ON CONFLICT (slug) DO NOTHING",
            {
                "slug": item.slug,
                "kind": item.kind,
                "doc": doc_id,
                "hint": f"{d['title']} · 上传预扫",
                "uid": ctx.user["id"],
            },
        )
    return {"ok": True, "count": len(body.items)}


@router.post("/{doc_id}/reindex")
async def reindex(doc_id: str, request: Request):
    ctx: Ctx = await current_user(request)
    d = await db.fetch_one("SELECT id FROM documents WHERE id = :id", {"id": doc_id})
    if not d:
        raise HTTPException(404, "文档不存在")
    await db.execute(
        "UPDATE documents SET status='processing', error=NULL, updated_at=now() WHERE id=:id",
        {"id": doc_id},
    )
    await queue.enqueue_index(doc_id)
    await audit.audit(
        "doc_reindexed",
        user=ctx.user,
        target_type="document",
        target_id=doc_id,
        ip=ctx.ip,
    )
    return {"ok": True, "status": "processing"}


@router.delete("/{doc_id}")
async def delete_document(doc_id: str, request: Request):
    ctx: Ctx = await current_user(request)
    d = await db.fetch_one(
        "SELECT id, file_path, title FROM documents WHERE id = :id", {"id": doc_id}
    )
    if not d:
        raise HTTPException(404, "文档不存在")
    await db.execute("DELETE FROM documents WHERE id = :id", {"id": doc_id})
    try:
        full = storage.abs_path(d["file_path"], settings.data_dir)
        if os.path.exists(full):
            os.remove(full)
    except (OSError, ValueError) as e:
        # 文件缺失/路径异常不影响删除（数据库行已删）
        print(f"[documents] 清理文件失败 doc={doc_id}: {e}", flush=True)
    await audit.audit(
        "doc_deleted",
        user=ctx.user,
        target_type="document",
        target_id=doc_id,
        ip=ctx.ip,
        detail={"title": d["title"]},
    )
    return {"ok": True}


@router.post("/_reindex_stale")
async def reindex_stale(request: Request):
    """重建所有 processing 卡住超过 10 分钟的任务（自愈入口）。"""
    await current_user(request)
    rows = await db.fetch_all(
        "SELECT id FROM documents WHERE status='processing' AND updated_at < now() - interval '10 minutes'"
    )
    for r in rows:
        await queue.enqueue_index(r["id"])
    return {"ok": True, "queued": len(rows)}
