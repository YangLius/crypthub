"""多级目录：文档区全局共享树（kind=doc，owner_id NULL），密钥区每人私有树（kind=secret）。

安全约束：
* kind=secret 的目录只属于创建者本人，他人访问一律 404（不暴露存在性）；
* 移动目录禁止移入自己的子树（环），层级深度有上限；
* 同目录同名唯一（数据库唯一索引兜底 + 应用层预检给出友好报错）。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import db
from ..security import Ctx, current_user

router = APIRouter(prefix="/folders", tags=["folders"])

MAX_DEPTH = 10
_NULL_UUID = "00000000-0000-0000-0000-000000000000"


class FolderBody(BaseModel):
    kind: str = Field(pattern="^(doc|secret)$")
    name: str = Field(min_length=1, max_length=100)
    parent_id: str | None = Field(default=None, max_length=64)


class FolderPatchBody(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    parent_id: str | None = Field(default=None, max_length=64)  # null = 移到根


async def _ctx(request: Request) -> Ctx:
    return await current_user(request)


def _is_mine(row: dict, uid: str) -> bool:
    """doc 树全员共享；secret 树只属于 owner。"""
    if row["kind"] == "doc":
        return True
    return str(row["owner_id"]) == str(uid)


async def _folder_or_404(fid: str, kind: str, uid: str) -> dict:
    row = await db.fetch_one(
        "SELECT id, kind, parent_id, name, owner_id FROM folders WHERE id = :id",
        {"id": fid},
    )
    if not row or row["kind"] != kind or not _is_mine(row, uid):
        raise HTTPException(404, "目录不存在")
    return row


async def _depth_of(fid: str) -> int:
    """fid 到根的距离（根级目录=1）。"""
    row = await db.fetch_one(
        "WITH RECURSIVE up AS ("
        " SELECT id, parent_id, 1 AS d FROM folders WHERE id = :id"
        " UNION ALL"
        " SELECT f.id, f.parent_id, up.d + 1 FROM folders f JOIN up ON f.id = up.parent_id"
        ") SELECT COALESCE(MAX(d), 1) AS depth FROM up",
        {"id": fid},
    )
    return int(row["depth"]) if row else 1


async def _subtree_height(fid: str) -> int:
    """fid 子树的最大层数（叶子=1）。"""
    row = await db.fetch_one(
        "WITH RECURSIVE down AS ("
        " SELECT id, parent_id, 1 AS d FROM folders WHERE id = :id"
        " UNION ALL"
        " SELECT f.id, f.parent_id, down.d + 1 FROM folders f JOIN down ON f.id = down.parent_id"
        " WHERE down.d < 64"
        ") SELECT COALESCE(MAX(d), 1) AS h FROM down",
        {"id": fid},
    )
    return int(row["h"]) if row else 1


async def _path_contains(start_id: str, target_id: str) -> bool:
    """start 的祖先链上是否包含 target（含自身）。"""
    row = await db.fetch_one(
        "WITH RECURSIVE up AS ("
        " SELECT id, parent_id FROM folders WHERE id = :start"
        " UNION ALL"
        " SELECT f.id, f.parent_id FROM folders f JOIN up ON f.id = up.parent_id"
        ") SELECT COUNT(*) AS n FROM up WHERE id = :target",
        {"start": start_id, "target": target_id},
    )
    return bool(row and int(row["n"]) > 0)


async def _sibling_exists(
    kind: str, name: str, parent_id: str | None, uid: str, exclude_id: str = _NULL_UUID
) -> bool:
    row = await db.fetch_one(
        "SELECT 1 AS x FROM folders WHERE kind = :k AND name = :n"
        " AND COALESCE(parent_id, CAST(:nu AS uuid)) = COALESCE(CAST(:pid AS uuid), CAST(:nu AS uuid))"
        " AND COALESCE(CAST(owner_id AS text), '') = COALESCE(CAST(:oid AS text), '')"
        " AND id <> CAST(:ex AS uuid)"
        " LIMIT 1",
        {
            "k": kind,
            "n": name,
            "pid": parent_id,
            "nu": _NULL_UUID,
            "oid": uid if kind == "secret" else None,
            "ex": exclude_id,
        },
    )
    return bool(row)


@router.get("")
async def list_folders(request: Request, kind: str = "doc"):
    if kind not in ("doc", "secret"):
        raise HTTPException(400, "kind 必须是 doc 或 secret")
    ctx = await _ctx(request)
    if kind == "doc":
        sql = "SELECT id, parent_id, name FROM folders WHERE kind = 'doc' AND owner_id IS NULL ORDER BY name"
        params: dict = {}
    else:
        sql = "SELECT id, parent_id, name FROM folders WHERE kind = 'secret' AND owner_id = :uid ORDER BY name"
        params = {"uid": ctx.user["id"]}
    rows = await db.fetch_all(sql, params)
    return {"folders": rows}


@router.post("")
async def create_folder(body: FolderBody, request: Request):
    ctx = await _ctx(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "目录名不能为空")
    if body.parent_id:
        parent = await _folder_or_404(body.parent_id, body.kind, str(ctx.user["id"]))
        depth = await _depth_of(str(parent["id"]))
        if depth + 1 > MAX_DEPTH:
            raise HTTPException(400, f"目录层级不能超过 {MAX_DEPTH} 级")
    if await _sibling_exists(body.kind, name, body.parent_id or None, str(ctx.user["id"])):
        raise HTTPException(400, "同级目录下已存在同名目录")
    row = await db.execute_returning(
        "INSERT INTO folders (kind, parent_id, name, owner_id)"
        " VALUES (:k, :pid, :n, :oid)"
        " RETURNING id, parent_id, name",
        {
            "k": body.kind,
            "pid": body.parent_id,
            "n": name,
            "oid": ctx.user["id"] if body.kind == "secret" else None,
        },
    )
    if row is None:
        raise HTTPException(500, "创建目录失败")
    return {"folder": row}


@router.patch("/{fid}")
async def update_folder(fid: str, body: FolderPatchBody, request: Request):
    ctx = await _ctx(request)
    uid = str(ctx.user["id"])
    row = await db.fetch_one(
        "SELECT id, kind, parent_id, name, owner_id FROM folders WHERE id = :id",
        {"id": fid},
    )
    if not row or not _is_mine(row, uid):
        raise HTTPException(404, "目录不存在")
    kind = str(row["kind"])
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "目录名不能为空")
    new_parent = body.parent_id
    if new_parent:
        parent = await _folder_or_404(new_parent, kind, uid)
        if str(parent["id"]) == str(fid):
            raise HTTPException(400, "不能移动到自身")
        if await _path_contains(str(parent["id"]), str(fid)):
            raise HTTPException(400, "不能移动到自己的子目录下")
        height = await _subtree_height(str(fid))
        pdepth = await _depth_of(str(parent["id"]))
        if pdepth + height > MAX_DEPTH:
            raise HTTPException(400, f"移动后层级不能超过 {MAX_DEPTH} 级")
    if await _sibling_exists(kind, name, new_parent, uid, exclude_id=str(fid)):
        raise HTTPException(400, "同级目录下已存在同名目录")
    await db.execute(
        "UPDATE folders SET name = :n, parent_id = :pid WHERE id = :id",
        {"n": name, "pid": new_parent, "id": fid},
    )
    return {"ok": True}


@router.delete("/{fid}")
async def delete_folder(fid: str, request: Request):
    ctx = await _ctx(request)
    row = await db.fetch_one(
        "SELECT id, kind, owner_id FROM folders WHERE id = :id", {"id": fid}
    )
    if not row or not _is_mine(row, str(ctx.user["id"])):
        raise HTTPException(404, "目录不存在")
    await db.execute("DELETE FROM folders WHERE id = :id", {"id": fid})
    return {"ok": True}
