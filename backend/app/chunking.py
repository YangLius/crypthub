"""分块：标题/函数边界优先，单块 400–800 字，重叠 10%（设计 5.3）。

实现：
  _split_units 只做逻辑切分（标题行 / 函数起始 / 行），不做长度累积；
  chunk_text 负责累积（≤MAX_LEN 才追加）、最小块与 10% 重叠尾部携带。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

TARGET = 600
MAX_LEN = 800
OVERLAP_RATIO = 0.1
_OVERLAP_CHARS = 80  # MAX_LEN * OVERLAP_RATIO
_MIN_EMIT = 200  # 小于此长度不单独成块（并入后续内容）

_RE_HEADING = re.compile(
    r"^(#{1,6}\s+.+|【.+】|第[一二三四五六七八九十\d]+[章节部分]|[一二三四五六七八九十]+、|\d+(\.\d+)*\s+\S.*)$"
)
_RE_FUNC = re.compile(
    r"^\s*(?:async\s+)?(?:def|class|function|func|fn|public|private|protected|export)\b"
)


@dataclass
class Chunk:
    idx: int
    anchor: str
    text: str


def _split_units(text: str) -> list[tuple[str, str]]:
    """切到自然单元（行级）。返回 [(unit_text, anchor)]，anchor 为最近标题。"""
    units: list[tuple[str, str]] = []
    anchor = ""
    buf: list[str] = []

    def flush() -> None:
        if buf:
            u = "\n".join(buf).strip("\n")
            if u:
                units.append((u, anchor))
            buf.clear()

    for line in text.split("\n"):
        stripped = line.strip()
        if stripped and _RE_HEADING.match(stripped):
            flush()
            anchor = stripped[:80]
            units.append((stripped, anchor))
        elif _RE_FUNC.match(line) and len("\n".join(buf)) > 50:
            flush()
            buf.append(line)
        else:
            buf.append(line)
    flush()
    return units


def chunk_text(text: str) -> list[Chunk]:
    chunks: list[Chunk] = []
    units = _split_units(text)
    cur: list[str] = []
    cur_anchor = ""

    def cur_text() -> str:
        return "\n".join(cur)

    def emit() -> None:
        nonlocal cur
        t = cur_text().strip()
        if t:
            chunks.append(Chunk(len(chunks), cur_anchor or "正文", t))
        cur = []

    def hard_split(t: str, anchor: str) -> None:
        """超长单元硬切，块间携带 10% 重叠。"""
        step = MAX_LEN - _OVERLAP_CHARS
        i = 0
        while i < len(t):
            piece = t[i : i + MAX_LEN].strip()
            if len(piece) >= 20:
                chunks.append(Chunk(len(chunks), anchor or "正文", piece))
            if i + MAX_LEN >= len(t):
                break
            i += step

    def carry_tail() -> None:
        """发射当前缓冲并保留 10% 尾部作为下一块开头。"""
        tail = cur_text()[-_OVERLAP_CHARS:]
        emit()
        if tail.strip():
            cur.append(tail)

    for u, a in units:
        if cur_anchor != a and a:
            cur_anchor = a
        if len(u) > MAX_LEN:
            emit()
            hard_split(u, a)
            continue
        if cur and len(cur_text()) + len(u) + 1 > MAX_LEN:
            if len(cur_text()) >= _MIN_EMIT:
                carry_tail()
                cur.append(u)
                continue
            # 当前缓冲太小（仅尾部残留）：合并后硬切，保证不超限
            merged = cur_text() + "\n" + u
            emit()
            hard_split(merged, a)
            continue
        cur.append(u)
        if len(cur_text()) >= TARGET:
            carry_tail()
    emit()
    return [c for c in chunks if len(c.text) >= 20]
