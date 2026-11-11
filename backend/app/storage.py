"""文件存储：原始文档保存在 DATA_DIR/files 下，文件名 = 文档 id + 消毒后的扩展名。"""

from __future__ import annotations

import re
import uuid


def doc_file_rel_path(filename: str) -> str:
    """返回相对 DATA_DIR 的路径；扩展名只保留 [a-z0-9.]，杜绝路径注入。"""
    dot = filename.rfind(".")
    slash = max(filename.rfind("/"), filename.rfind("\\"))
    ext = filename[dot:].lower() if dot > slash and dot != -1 else ""
    ext = re.sub(r"[^a-z0-9.]", "", ext)[:10]
    if not re.fullmatch(r"\.[a-z0-9]{0,9}", ext):
        ext = ""
    return f"files/{uuid.uuid4().hex}{ext}"


def abs_path(rel: str, data_dir: str) -> str:
    """拼绝对路径并防目录穿越（rel 必须是内部生成的形态）。"""
    import os

    base = os.path.abspath(data_dir)
    full = os.path.abspath(os.path.join(base, rel))
    if not full.startswith(base + os.sep):
        raise ValueError("非法存储路径")
    return full
