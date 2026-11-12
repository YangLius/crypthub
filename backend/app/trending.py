"""GitHub 每日热点：抓取 github.com/trending、关键词分类、每类 Top10、当日缓存。

- 数据源：github.com/trending?since=daily（HTML 解析，无官方 API）。
- 分类：规则关键词打分（AI 开发/开发工具/前端/后端/数据库/云原生/安全/语言/桌面/学习/娱乐/其他）。
- 缓存：Redis kb:gh:trend:{日期}，1 小时；force=1 强制重抓。
"""

from __future__ import annotations

import contextlib
import json
import re
from datetime import datetime, timedelta, timezone

import httpx

from . import security

TREND_URL = "https://github.com/trending?since=daily"
CACHE_TTL = 3600
TOP_N = 10
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

# (key, 中文标签, 关键词)。顺序即优先级：得分相同取靠前者。
CATEGORIES: list[tuple[str, str, tuple[str, ...]]] = [
    (
        "ai",
        "AI 开发",
        (
            "ai", "llm", "gpt", "agent", "agents", "rag", "machine-learning",
            "deep-learning", "neural", "transformer", "diffusion", "inference",
            "training", "embedding", "embeddings", "prompt", "chatbot", "chatgpt",
            "vision", "ocr", "asr", "tts", "multimodal", "openai", "anthropic",
            "mcp", "model-context-protocol", "fine-tuning", "gguf", "quantization",
            "nlp", "stable-diffusion", "llama", "mistral", "rlhf",
        ),
    ),
    (
        "devtools",
        "开发工具",
        (
            "cli", "editor", "ide", "debugger", "formatter", "linter",
            "developer-tools", "terminal", "shell", "code-review", "regex",
            "diagram", "visualization", "benchmark", "testing", "unit-testing",
            "static-analysis", "refactoring", "dotenv", "boilerplate",
        ),
    ),
    (
        "frontend",
        "前端 & UI",
        (
            "react", "vue", "svelte", "nextjs", "nuxt", "astro", "css", "tailwind",
            "ui", "ux", "component", "components", "frontend", "web-app",
            "dashboard", "website", "spa", "animation", "chart", "charts",
            "design-system", "icon", "icons", "layout", "webgl", "canvas",
        ),
    ),
    (
        "backend",
        "后端 & 服务",
        (
            "api", "server", "backend", "microservice", "microservices",
            "framework", "graphql", "rest", "rest-api", "proxy", "gateway",
            "rpc", "grpc", "middleware", "websocket", "webhook", "fastapi",
            "flask", "django", "spring", "express",
        ),
    ),
    (
        "data",
        "数据库 & 数据",
        (
            "database", "sql", "postgres", "postgresql", "mysql", "sqlite",
            "redis", "mongodb", "vector-database", "clickhouse", "duckdb",
            "etl", "analytics", "data-engineering", "data-pipeline", "crawler",
            "scraper", "scraping", "search-engine", "spreadsheet", "db",
            "bigdata", "data-visualization",
        ),
    ),
    (
        "devops",
        "运维 & 云原生",
        (
            "docker", "kubernetes", "k8s", "devops", "ci-cd", "ci", "cd",
            "self-hosted", "selfhosted", "cloud", "deployment", "monitoring",
            "observability", "homelab", "nas", "automation", "infrastructure",
            "terraform", "ansible", "nginx", "reverse-proxy", "container",
        ),
    ),
    (
        "security",
        "安全",
        (
            "security", "auth", "authentication", "authorization", "encryption",
            "pentest", "penetration-testing", "vulnerability", "cve", "malware",
            "password", "2fa", "totp", "vpn", "firewall", "privacy", "osint",
            "cryptography", "hacking", "redteam", "burp", "jwt", "oauth",
        ),
    ),
    (
        "lang",
        "编程语言 & 编译器",
        (
            "compiler", "programming-language", "interpreter", "runtime",
            "typechecker", "type-system", "llvm", "wasm", "webassembly",
            "transpiler", "garbage-collector", "language-server", "lsp",
        ),
    ),
    (
        "desktop",
        "桌面 & 效率",
        (
            "desktop", "windows", "macos", "electron", "tauri", "launcher",
            "note-taking", "notes", "productivity", "file-manager", "screenshot",
            "clipboard", "hotkey", "widgets", "cross-platform",
        ),
    ),
    (
        "learning",
        "学习 & 资源",
        (
            "awesome", "awesome-list", "tutorial", "tutorials", "interview",
            "roadmap", "cheatsheet", "cheat-sheet", "book", "books", "curated",
            "guide", "algorithm", "algorithms", "leetcode", "course",
            "learning", "examples", "snippets",
        ),
    ),
    (
        "fun",
        "游戏 & 多媒体",
        (
            "game", "games", "gaming", "emulator", "emulation", "minecraft",
            "godot", "unity", "video", "music", "audio", "media", "player",
            "anime", "streaming", "image-processing", "photo", "wallpaper",
            "subtitle", "ffmpeg", "download-manager",
        ),
    ),
    ("other", "其他", ()),
]

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _now_cst() -> datetime:
    return datetime.now(timezone(timedelta(hours=8)))


def _clean(fragment: str) -> str:
    import html as _html

    return _WS_RE.sub(" ", _html.unescape(_TAG_RE.sub("", fragment))).strip()


def _to_int(s: str) -> int:
    s = s.strip().replace(",", "")
    try:
        return int(s)
    except ValueError:
        return 0


async def _fetch_parse() -> list[dict]:
    """抓取并解析 trending 页面，返回 repo 字典列表（按页面顺序）。"""
    async with httpx.AsyncClient(
        timeout=30, follow_redirects=True, headers={"User-Agent": _UA}
    ) as client:
        resp = await client.get(TREND_URL)
        resp.raise_for_status()
        html = resp.text

    repos: list[dict] = []
    seen: set[str] = set()
    for chunk in html.split("<article")[1:]:
        # 仓库链接只在标题 h2 内（article 里第一个 <a> 是 star 按钮的登录跳转）
        h2 = re.search(r"<h2[^>]*>(.*?)</h2>", chunk, re.S)
        if h2 is None:
            continue
        m = re.search(r'<a[^>]+href="/([^"?]+)"', h2.group(1))
        if m is None:
            continue
        full_name = m.group(1).strip("/")
        if "/" not in full_name:
            continue
        if full_name.split("/")[0] in (
            "login", "features", "topics", "collections", "sponsors",
            "about", "trending", "orgs", "settings", "site",
        ):
            continue
        if full_name in seen:
            continue
        seen.add(full_name)

        desc = ""
        md = re.search(r"<p[^>]*>(.*?)</p>", chunk, re.S)
        if md:
            desc = _clean(md.group(1))[:300]

        lang = ""
        ml = re.search(r'itemprop="programmingLanguage">\s*([^<]+)<', chunk)
        if ml:
            lang = ml.group(1).strip()

        stars = forks = stars_today = 0
        ms = re.search(
            r'href="/[^"]+/stargazers"[^>]*>.*?([\d,\s]+)</a>', chunk, re.S
        )
        if ms:
            stars = _to_int(ms.group(1))
        mf = re.search(r'href="/[^"]+/forks"[^>]*>.*?([\d,\s]+)</a>', chunk, re.S)
        if mf:
            forks = _to_int(mf.group(1))
        mt = re.search(r"([\d,]+)\s*stars today", chunk)
        if mt:
            stars_today = _to_int(mt.group(1))

        repos.append(
            {
                "full_name": full_name,
                "url": f"https://github.com/{full_name}",
                "desc": desc,
                "language": lang,
                "stars": stars,
                "forks": forks,
                "stars_today": stars_today,
            }
        )
    if not repos:
        raise RuntimeError("页面解析得到 0 个项目（GitHub 页面结构可能变化）")
    return repos


def _classify(repo: dict) -> str:
    """关键词打分分类；命中数相同取 CATEGORIES 靠前者；全部未命中 → other。"""
    text = " ".join(
        str(repo.get(k, "")) for k in ("full_name", "desc", "language")
    ).lower()
    best_key, best_score = "other", 0
    for key, _label, kws in CATEGORIES:
        score = 0
        for kw in kws:
            n = len(re.findall(rf"(?<![a-z0-9]){re.escape(kw)}(?![a-z0-9])", text))
            score += min(n, 2)
        if score > best_score:
            best_key, best_score = key, score
    return best_key


def _group_top10(repos: list[dict]) -> list[dict]:
    """分类 → 按今日星排序取 TopN；输出保持 CATEGORIES 顺序，空分类不带出。"""
    buckets: dict[str, list[dict]] = {key: [] for key, _l, _k in CATEGORIES}
    for r in repos:
        buckets.setdefault(_classify(r), []).append(r)
    label_of = {key: label for key, label, _k in CATEGORIES}
    out: list[dict] = []
    for key, _label, _k in CATEGORIES:
        items = sorted(
            buckets.get(key, []),
            key=lambda r: (r["stars_today"], r["stars"]),
            reverse=True,
        )[:TOP_N]
        if items:
            out.append(
                {"key": key, "label": label_of[key], "count": len(items), "repos": items}
            )
    return out


async def fetch_daily(force: bool = False) -> dict:
    """当日 trending（分类分组 Top10），Redis 缓存 1 小时。"""
    date = _now_cst().strftime("%Y-%m-%d")
    key = f"kb:gh:trend:{date}"
    r = security.redis_client()
    if not force:
        with contextlib.suppress(Exception):
            cached = await r.get(key)
            if cached:
                return json.loads(cached)
    repos = await _fetch_parse()
    payload = {
        "date": date,
        "fetched_at": _now_cst().isoformat(timespec="seconds"),
        "total": len(repos),
        "categories": _group_top10(repos),
    }
    with contextlib.suppress(Exception):
        await r.set(key, json.dumps(payload, ensure_ascii=False), ex=CACHE_TTL)
    return payload
