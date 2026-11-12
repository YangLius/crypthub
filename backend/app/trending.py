"""GitHub 每日热点：抓取 trending、两级分类（父分类→子分类）、全量输出、当日缓存。

- 数据源：github.com/trending?since=daily（HTML 解析，匿名页当前约 10~25 个项目）。
- 分类：两级规则关键词打分，先选最优父分类，再在其中选最优子分类；
  例：AI 开发 → Agent 智能体 / Skills 提示工程 / RAG 知识库 / LLM 框架 / MCP 协议 …
- 输出：每个分类全量（不截 Top10），前端分页展示；附带完整 taxonomy 供菜单渲染。
- 缓存：Redis kb:gh:trend:v2:{日期}，1 小时；force 重抓。
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
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

# 两级分类树：(key, 中文标签, [(子key, 子标签, 关键词), ...])。
# 顺序即优先级：父分类得分相同取靠前者；子分类得分相同取靠前者。
TAXONOMY: list[tuple[str, str, list[tuple[str, str, tuple[str, ...]]]]] = [
    (
        "ai",
        "AI 开发",
        [
            (
                "agent",
                "Agent 智能体",
                (
                    "agent", "agents", "agentic", "multi-agent", "autonomous-agents",
                    "crewai", "langgraph", "browser-use", "computer-use", "workflow-agent",
                ),
            ),
            (
                "skills",
                "Skills 提示工程",
                (
                    "skills", "skill", "prompt-engineering", "prompts", "system-prompt",
                    "prompt-library", "awesome-prompts", "slash-commands", "subagents",
                ),
            ),
            (
                "rag",
                "RAG 知识库",
                (
                    "rag", "knowledge-base", "embedding", "embeddings", "retrieval",
                    "vector-database", "semantic-search", "knowledge-graph",
                ),
            ),
            (
                "mcp",
                "MCP 协议",
                ("mcp", "model-context-protocol", "mcp-server", "mcp-client"),
            ),
            (
                "llm",
                "LLM 框架/应用",
                (
                    "llm", "gpt", "chatgpt", "ollama", "llama", "mistral", "inference",
                    "gguf", "quantization", "openai", "anthropic", "gemini", "deepseek",
                    "qwen", "vllm", "chatbot", "local-llm", "chat-ui",
                ),
            ),
            (
                "coding",
                "AI 编程",
                (
                    "ai-coding", "coding-agent", "copilot", "code-review-ai", "cursor",
                    "claude-code", "auto-coder", "ai-programming", "vibe-coding",
                ),
            ),
            (
                "gen-media",
                "AI 生成（图/音/视频）",
                (
                    "stable-diffusion", "diffusion", "image-generation", "video-generation",
                    "text-to-image", "text-to-speech", "tts", "asr", "speech", "voice",
                    "digital-human", "lipsync", "wav2vec", "ocr", "sadtalker",
                ),
            ),
            (
                "training",
                "训练/微调",
                (
                    "fine-tuning", "training", "rlhf", "deep-learning", "machine-learning",
                    "transformer", "neural-network", "pytorch", "tensorflow", "jax",
                    "lora", "peft", "dataset", "gpu", "distributed-training", "ml",
                ),
            ),
        ],
    ),
    (
        "devtools",
        "开发工具",
        [
            ("cli", "CLI/终端", ("cli", "terminal", "shell", "command-line", "tui", "zsh", "fish")),
            ("editor", "编辑器/IDE", ("editor", "ide", "neovim", "vim", "emacs", "vscode", "zed", "jetbrains")),
            (
                "quality",
                "质量/测试",
                (
                    "linter", "formatter", "static-analysis", "testing", "unit-testing",
                    "e2e-testing", "code-review", "refactoring", "benchmark", "debugger",
                    "fuzzing", "mutation-testing",
                ),
            ),
            ("git", "Git 增强", ("git", "git-cliff", "diff", "merge-tool", "commit")),
            (
                "misc-tools",
                "效率工具集",
                (
                    "developer-tools", "boilerplate", "regex", "diagram", "dotenv",
                    "documentation", "docs-generator", "changelog", "release",
                ),
            ),
        ],
    ),
    (
        "frontend",
        "前端 & UI",
        [
            (
                "framework",
                "框架/库",
                ("react", "vue", "svelte", "nextjs", "nuxt", "astro", "solidjs", "remix", "angular", "qwik"),
            ),
            (
                "ui-css",
                "组件/CSS",
                (
                    "css", "tailwind", "ui", "ux", "components", "design-system", "icons",
                    "layout", "theme", "shadcn", "radix", "styling",
                ),
            ),
            (
                "viz",
                "可视化/图形",
                (
                    "chart", "charts", "visualization", "dataviz", "canvas", "webgl",
                    "threejs", "animation", "d3", "svg", "maps",
                ),
            ),
        ],
    ),
    (
        "backend",
        "后端 & 服务",
        [
            (
                "framework",
                "Web 框架",
                (
                    "fastapi", "flask", "django", "spring", "express", "nestjs", "gin",
                    "laravel", "rails", "aspnet", "framework", "sanic", "litestar",
                ),
            ),
            (
                "api",
                "API/网关",
                ("api", "rest", "rest-api", "graphql", "gateway", "api-gateway", "openapi", "swagger"),
            ),
            (
                "rpc-mq",
                "RPC/消息队列",
                (
                    "rpc", "grpc", "websocket", "webhook", "middleware", "message-queue",
                    "kafka", "rabbitmq", "nats", "event-driven", "pubsub",
                ),
            ),
            ("server", "服务端", ("server", "backend", "microservice", "microservices")),
        ],
    ),
    (
        "data",
        "数据库 & 数据",
        [
            (
                "db",
                "数据库",
                (
                    "database", "postgres", "postgresql", "mysql", "sqlite", "redis",
                    "mongodb", "duckdb", "clickhouse", "sql", "db", "nosql",
                    "cassandra", "influxdb", "timescaledb", "embedded-database",
                ),
            ),
            ("search", "搜索引擎", ("search-engine", "elasticsearch", "meilisearch", "typesense", "full-text-search")),
            (
                "pipeline",
                "数据工程",
                (
                    "etl", "data-engineering", "data-pipeline", "analytics", "bigdata",
                    "airflow", "dbt", "data-quality", "spreadsheet",
                ),
            ),
            ("crawler", "爬虫", ("crawler", "scraper", "scraping", "spider", "crawl4ai")),
        ],
    ),
    (
        "devops",
        "运维 & 云原生",
        [
            (
                "container",
                "容器/编排",
                ("docker", "kubernetes", "k8s", "container", "containerd", "helm", "podman", "compose", "nomad"),
            ),
            (
                "cicd",
                "CI/CD",
                ("ci", "cd", "ci-cd", "github-actions", "gitlab-ci", "jenkins", "deployment", "devops"),
            ),
            (
                "hosting",
                "自托管/家庭实验室",
                (
                    "self-hosted", "selfhosted", "homelab", "nas", "vps", "debian",
                    "ubuntu", "archlinux", "nixos", "linux", "unraid", "proxmox",
                ),
            ),
            (
                "observability",
                "监控/可观测",
                ("monitoring", "observability", "prometheus", "grafana", "logging", "tracing", "uptime", "alerting"),
            ),
            (
                "iac-cloud",
                "IaC/云/自动化",
                (
                    "terraform", "ansible", "infrastructure", "cloud", "aws", "gcp",
                    "azure", "pulumi", "nginx", "reverse-proxy", "automation", "caddy",
                    "traefik", "backup",
                ),
            ),
        ],
    ),
    (
        "security",
        "安全",
        [
            (
                "offensive",
                "渗透/攻防",
                (
                    "pentest", "penetration-testing", "vulnerability", "cve", "malware",
                    "hacking", "redteam", "osint", "burp", "exploit", "recon",
                    "payload", "ctf",
                ),
            ),
            (
                "auth-crypto",
                "认证/加密",
                (
                    "auth", "authentication", "authorization", "encryption", "cryptography",
                    "password", "2fa", "totp", "jwt", "oauth", "sso", "passkey",
                    "privacy", "vault", "secrets-management", "pgp",
                ),
            ),
            ("network", "网络安全", ("vpn", "firewall", "wireguard", "tor", "packet-capture", "network-security")),
        ],
    ),
    (
        "mobile",
        "移动开发",
        [
            ("ios", "iOS", ("swift", "swiftui", "ios", "xcode", "objective-c", "uikit")),
            ("android", "Android", ("android", "kotlin", "jetpack-compose", "gradle-android")),
            (
                "cross",
                "跨端",
                ("flutter", "react-native", "capacitor", "ionic", "expo", "cross-platform", "maui", "mobile"),
            ),
        ],
    ),
    (
        "lang",
        "编程语言 & 运行时",
        [
            (
                "compiler",
                "编译器/运行时",
                (
                    "compiler", "interpreter", "programming-language", "transpiler",
                    "llvm", "runtime", "bytecode", "jit", "garbage-collector",
                ),
            ),
            ("types-wasm", "类型系统/WASM", ("wasm", "webassembly", "typechecker", "type-system", "wasi")),
            ("tooling", "语言工具链", ("lsp", "language-server", "package-manager", "build-tool", "cross-compile")),
        ],
    ),
    (
        "desktop",
        "桌面 & 效率",
        [
            (
                "desktop-app",
                "桌面应用",
                ("desktop", "electron", "tauri", "windows", "macos", "linux-desktop", "qt", "gtk", "menubar"),
            ),
            (
                "productivity",
                "效率工具",
                (
                    "launcher", "productivity", "clipboard", "screenshot", "hotkey",
                    "file-manager", "widgets", "shortcuts", "window-manager",
                ),
            ),
            (
                "notes",
                "笔记/知识管理",
                (
                    "note-taking", "notes", "knowledge-management", "obsidian",
                    "markdown-editor", "journal", "diary", "zettelkasten", "wiki",
                ),
            ),
        ],
    ),
    (
        "learning",
        "学习 & 资源",
        [
            (
                "tutorial",
                "教程/面试",
                (
                    "tutorial", "tutorials", "interview", "roadmap", "course", "leetcode",
                    "system-design", "guide",
                ),
            ),
            (
                "collections",
                "合集/清单",
                (
                    "awesome", "awesome-list", "curated", "cheatsheet", "cheat-sheet",
                    "book", "books", "list", "algorithms", "algorithm", "examples",
                    "snippets", "design-patterns",
                ),
            ),
        ],
    ),
    (
        "fun",
        "游戏 & 多媒体",
        [
            (
                "game",
                "游戏",
                (
                    "game", "games", "gaming", "emulator", "emulation", "minecraft",
                    "godot", "unity", "unreal", "roguelike", "chess", "gameboy",
                    "raycasting", "retro-gaming",
                ),
            ),
            (
                "media",
                "多媒体/下载",
                (
                    "video", "music", "audio", "media", "player", "anime", "streaming",
                    "image-processing", "photo", "wallpaper", "subtitle", "ffmpeg",
                    "download-manager", "youtube", "podcast", "ebook", "iptv",
                ),
            ),
        ],
    ),
    (
        "blockchain",
        "区块链 & 量化",
        [
            (
                "chain",
                "链/合约",
                (
                    "blockchain", "bitcoin", "ethereum", "solidity", "smart-contracts",
                    "web3", "defi", "nft", "solana", "layer2", "crypto-wallet", "move-lang",
                ),
            ),
            (
                "trading",
                "量化交易",
                ("trading", "quant", "stock", "algorithmic-trading", "fintech", "exchange", "backtesting"),
            ),
        ],
    ),
    ("other", "其他", []),
]

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_NON_REPO_PREFIXES = (
    "login", "features", "topics", "collections", "sponsors",
    "about", "trending", "orgs", "settings", "site",
)


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


def _kw_hits(kw: str, text: str) -> int:
    return len(re.findall(rf"(?<![a-z0-9]){re.escape(kw)}(?![a-z0-9])", text))


def _classify(repo: dict) -> tuple[str, str | None]:
    """两级打分分类 → (父key, 子key 或 None)；得分相同取 TAXONOMY 靠前者；全未命中 → ("other", None)。"""
    text = " ".join(
        str(repo.get(k, "")) for k in ("full_name", "desc", "language")
    ).lower()
    best_cat, best_cat_score, best_sub = "other", 0, None
    for key, _label, subs in TAXONOMY:
        cat_score, sub_best_score, sub_best_key = 0, 0, None
        for skey, _slabel, kws in subs:
            s = 0
            for kw in kws:
                s += min(_kw_hits(kw, text), 2)
            if s:
                cat_score += s
                if s > sub_best_score:
                    sub_best_score, sub_best_key = s, skey
        if cat_score > best_cat_score:
            best_cat, best_cat_score, best_sub = key, cat_score, sub_best_key
    return best_cat, best_sub


def _sub_label(cat_key: str, sub_key: str | None) -> str | None:
    if sub_key is None:
        return None
    for key, _label, subs in TAXONOMY:
        if key == cat_key:
            for skey, slabel, _kws in subs:
                if skey == sub_key:
                    return slabel
    return None


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
        if full_name.split("/")[0] in _NON_REPO_PREFIXES:
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
        ms = re.search(r'href="/[^"]+/stargazers"[^>]*>.*?([\d,\s]+)</a>', chunk, re.S)
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


def _group_all(repos: list[dict]) -> list[dict]:
    """两级分组：父分类（带子分类标签）全量输出；输出保持 TAXONOMY 顺序，空分类不带出。"""
    buckets: dict[str, list[dict]] = {}
    for r in repos:
        cat, sub = _classify(r)
        r = dict(r)
        r["sub"] = sub
        r["sub_label"] = _sub_label(cat, sub)
        buckets.setdefault(cat, []).append(r)
    label_of = {key: label for key, label, _s in TAXONOMY}
    out: list[dict] = []
    for key, _label, _s in TAXONOMY:
        items = buckets.get(key)
        if not items:
            continue
        out.append({"key": key, "label": label_of[key], "count": len(items), "repos": items})
    return out


def _taxonomy_payload() -> list[dict]:
    return [
        {"key": key, "label": label, "subs": [{"key": sk, "label": sl} for sk, sl, _k in subs]}
        for key, label, subs in TAXONOMY
    ]


async def fetch_daily(force: bool = False) -> dict:
    """当日 trending（两级分类全量 + taxonomy），Redis 缓存 1 小时。"""
    date = _now_cst().strftime("%Y-%m-%d")
    key = f"kb:gh:trend:v2:{date}"
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
        "taxonomy": _taxonomy_payload(),
        "categories": _group_all(repos),
    }
    with contextlib.suppress(Exception):
        await r.set(key, json.dumps(payload, ensure_ascii=False), ex=CACHE_TTL)
    return payload
