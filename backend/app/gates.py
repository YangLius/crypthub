"""脱敏闸规则（服务端兜底扫描；与前端 TS 版保持同一规则集）。

规则（对应设计第 6 节）：
  prefix    已知凭据前缀：sk- ghp_ xoxb- AKIA -----BEGIN..PRIVATE KEY----- Bearer
  connstr   连接串：postgres://user:pass@... 等
  kv        键值对：(password|passwd|pwd|secret|token|api_key|...)[:=]值
  entropy   高熵串：长度≥20、字符集混用、香农熵>3.5 bit/char

命中 → 替换为 {{secret:<slug>}}；返回替换清单供待认领队列使用（真实值不入库）。
"""

from __future__ import annotations

import math
import re
import secrets as pysecrets
from dataclasses import dataclass, field

PLACEHOLDER_PREFIX = "{{secret:"
PLACEHOLDER_SUFFIX = "}}"

# 已知前缀（最长的优先，避免提前截断匹配）
_PREFIXES = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
    "github_pat_",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "AKIA",
    "ASIA",
    "sk-ant-",
    "sk-",
    "Bearer ",
]

_RE_CONN = re.compile(
    r"(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|rediss|mssql|ftp)://"
    r"[^\s:/@]+:[^\s@/]+@[^\s\"'<>]+",
    re.IGNORECASE,
)

_RE_KV = re.compile(
    r"(?i)(?<![A-Za-z0-9_{])(?:password|passwd|pwd|secret|token|api[_-]?key|"
    r"access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret)"
    r"\s*[:=]\s*(?!\{\{secret:)"
    r"(\"[^\"]{4,}\"|'[^']{4,}'|[^\s,;\"'`]{4,})"
)

_RE_TOKEN_CAND = re.compile(r"[A-Za-z0-9+/_.=\-]{20,}")


@dataclass
class Hit:
    kind: str  # prefix / connstr / kv / entropy
    start: int
    end: int
    value: str  # 命中原文（仅存于调用方内存，绝不入库/入日志）


@dataclass
class RedactResult:
    text: str
    pending: list[dict] = field(default_factory=list)  # [{slug, kind, length}]
    hits: list[Hit] = field(default_factory=list)


def shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    freq: dict[str, int] = {}
    for ch in s:
        freq[ch] = freq.get(ch, 0) + 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in freq.values())


def _char_classes(s: str) -> int:
    n = 0
    if re.search(r"[a-z]", s):
        n += 1
    if re.search(r"[A-Z]", s):
        n += 1
    if re.search(r"[0-9]", s):
        n += 1
    if re.search(r"[^A-Za-z0-9]", s):
        n += 1
    return n


def _is_prefix_hit(text: str, start: int, tok_end: int) -> tuple[int, str] | None:
    """token 起点处是否以已知前缀开始。返回 (end, prefix)。"""
    for p in _PREFIXES:
        if text.startswith(p, start):
            end = start + len(p)
            # 前缀后吸收紧随的非空白载荷（如 sk-xxxx 或 Bearer xxxx）
            m = re.match(r"[^\s\"']{6,}", text[end:tok_end])
            if p == "Bearer ":
                return (end + m.end(), p) if m else None
            return (tok_end, p)
    return None


def scan(text: str, *, strict: bool = True) -> list[Hit]:
    """扫描文本，返回互不重叠的命中区间（前者优先，重叠取先者）。

    strict=True（服务端兜底）：高熵规则要求字母+数字混用，降低误报；
    strict=False（与前端对齐）：任意两类字符即可。
    """
    hits: list[Hit] = []
    taken: list[tuple[int, int]] = []

    def overlaps(a: int, b: int) -> bool:
        return any(not (b <= s or a >= e) for s, e in taken)

    # 1) 连接串
    for m in _RE_CONN.finditer(text):
        if not overlaps(m.start(), m.end()):
            hits.append(Hit("connstr", m.start(), m.end(), m.group(0)))
            taken.append((m.start(), m.end()))

    # 2) 键值对
    for m in _RE_KV.finditer(text):
        if not overlaps(m.start(), m.end()):
            hits.append(Hit("kv", m.start(), m.end(), m.group(0)))
            taken.append((m.start(), m.end()))

    # 3) token 候选：前缀 + 高熵
    for m in re.finditer(r"\S+", text):
        tok_start, tok_end = m.start(), m.end()
        if overlaps(tok_start, tok_end):
            continue
        tok = m.group(0)
        ph = _is_prefix_hit(text, tok_start, tok_end)
        if ph:
            end, _ = ph
            hits.append(Hit("prefix", tok_start, end, text[tok_start:end]))
            taken.append((tok_start, end))
            continue
        for cm in _RE_TOKEN_CAND.finditer(tok):
            cand = cm.group(0)
            cs, ce = tok_start + cm.start(), tok_start + cm.end()
            if overlaps(cs, ce):
                continue
            if len(cand) >= 20 and shannon_entropy(cand) > 3.5:
                min_classes = 2 if strict else 1
                has_alpha = bool(re.search(r"[A-Za-z]", cand))
                has_digit = bool(re.search(r"[0-9]", cand))
                ok = _char_classes(cand) > min_classes or (has_alpha and has_digit)
                if strict:
                    ok = has_alpha and has_digit and _char_classes(cand) >= 2
                if ok:
                    hits.append(Hit("entropy", cs, ce, cand))
                    taken.append((cs, ce))
    hits.sort(key=lambda h: h.start)
    return hits


def redact(text: str, *, strict: bool = True) -> RedactResult:
    hits = scan(text, strict=strict)
    if not hits:
        return RedactResult(text=text)
    out = []
    pos = 0
    pending: list[dict] = []
    used_slugs = set()
    for h in hits:
        out.append(text[pos : h.start])
        slug = pysecrets.token_hex(4)
        while slug in used_slugs:  # 极小概率碰撞
            slug = pysecrets.token_hex(4)
        used_slugs.add(slug)
        out.append(PLACEHOLDER_PREFIX + slug + PLACEHOLDER_SUFFIX)
        pending.append({"slug": slug, "kind": h.kind, "length": h.end - h.start})
        pos = h.end
    out.append(text[pos:])
    return RedactResult(text="".join(out), pending=pending, hits=hits)


def is_text_mime(mime: str, filename: str) -> bool:
    text_exts = (
        ".md",
        ".markdown",
        ".txt",
        ".csv",
        ".tsv",
        ".log",
        ".json",
        ".yaml",
        ".yml",
        ".toml",
        ".ini",
        ".conf",
        ".py",
        ".js",
        ".ts",
        ".jsx",
        ".tsx",
        ".go",
        ".rs",
        ".java",
        ".kt",
        ".c",
        ".h",
        ".cpp",
        ".hpp",
        ".cs",
        ".rb",
        ".php",
        ".sh",
        ".bat",
        ".ps1",
        ".sql",
        ".html",
        ".css",
        ".xml",
        ".env",
    )
    if mime.startswith("text/"):
        return True
    if mime in (
        "application/json",
        "application/x-yaml",
        "application/toml",
        "application/javascript",
        "application/xml",
    ):
        return True
    return filename.lower().endswith(text_exts)
