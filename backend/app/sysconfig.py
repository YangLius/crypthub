"""系统运行时配置：DB 覆盖 .env（管理员在密钥区 UI 维护，改动即时生效）。

白名单键（与 config.Settings 字段同名）：
  LLM：llm_api_base / llm_api_key / llm_model
  嵌入：embedding_provider / embedding_api_base / embedding_api_key /
        embedding_model / embedding_api_send_dims
数据库连接不在此表（启动期依赖，改动写回 .env，见 routers/sysconfig.py）。
"""

from __future__ import annotations

from pathlib import Path

from . import db
from .config import settings

OVERRIDE_KEYS: tuple[str, ...] = (
    "llm_api_base",
    "llm_api_key",
    "llm_model",
    "embedding_provider",
    "embedding_api_base",
    "embedding_api_key",
    "embedding_model",
    "embedding_api_send_dims",
)

PROVIDERS = ("local", "openai_compat")


def _to_str(v: object) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


async def overrides() -> dict[str, str]:
    """读取 DB 覆盖行；表缺失等异常时降级为空覆盖（回退 .env 默认）。"""
    try:
        rows = await db.fetch_all(
            "SELECT key, value FROM system_settings WHERE key = ANY(:ks)",
            {"ks": list(OVERRIDE_KEYS)},
        )
    except Exception:
        return {}
    return {r["key"]: r["value"] for r in rows}


async def effective() -> dict[str, str]:
    """合并后的生效配置（DB 覆盖 > .env 默认），llm/embedding 消费方直接取用。"""
    cfg = {k: _to_str(getattr(settings, k)) for k in OVERRIDE_KEYS}
    cfg.update(await overrides())
    return cfg


def mask(secret: str) -> str:
    if not secret:
        return ""
    if len(secret) <= 12:
        return "••••••"
    return f"{secret[:4]}••••••{secret[-4:]}"


def parse_db_url(url: str) -> dict[str, str]:
    """拆 postgresql://user:pass@host:port/dbname（容错 +asyncpg 方言前缀）。"""
    from urllib.parse import unquote, urlsplit

    u = urlsplit(url.replace("postgresql+asyncpg://", "postgresql://"))
    return {
        "user": unquote(u.username or ""),
        "password": unquote(u.password or ""),
        "host": u.hostname or "",
        "port": str(u.port or 5432),
        "name": (u.path or "/").lstrip("/"),
    }


def build_db_url(host: str, port: str, user: str, password: str, name: str) -> str:
    from urllib.parse import quote

    return (
        f"postgresql+asyncpg://{quote(user, safe='')}:{quote(password, safe='')}"
        f"@{host}:{port}/{name}"
    )


ENV_CANDIDATES_PLACEHOLDER_REMOVED = None


def env_file_path() -> Path | None:
    """与 config.py 相同的 .env 搜索顺序，返回第一个存在的路径（无则 None）。"""
    cands = [
        Path(__file__).resolve().parents[2] / ".env",
        Path(__file__).resolve().parents[1] / ".env",
    ]
    for p in cands:
        if p.is_file():
            return p
    return None


def write_env_database_url(url: str) -> str:
    """把 DATABASE_URL 写回 .env（保留其余行），返回写入的文件路径。"""
    import re

    p = env_file_path()
    if p is None:
        raise RuntimeError("未找到 .env 文件（compose 部署请在服务器上手动配置）")
    text = p.read_text(encoding="utf-8")
    if re.search(r"(?m)^DATABASE_URL=", text):
        text = re.sub(r"(?m)^DATABASE_URL=.*$", f"DATABASE_URL={url}", text)
    else:
        text = text.rstrip("\n") + f"\nDATABASE_URL={url}\n"
    p.write_text(text, encoding="utf-8", newline="\n")
    return str(p)
