"""应用配置：全部来自环境变量（部署时注入，不进代码/数据库）。

本地开发支持 .env：仓库根目录与 backend/ 下的 .env 都会被加载，
已有环境变量优先（override=False），便于容器注入覆盖。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# .env：仓库根 + backend/（均不覆盖已注入的环境变量）
for _p in (
    Path(__file__).resolve().parents[2] / ".env",
    Path(__file__).resolve().parents[1] / ".env",
):
    if _p.is_file():
        load_dotenv(_p, override=False)


def _bool(v: str | None, default: bool = False) -> bool:
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _database_url() -> str:
    """优先 DATABASE_URL；未设置时由 DB_* 分量组装（compose 用）。"""
    url = os.getenv("DATABASE_URL", "")
    if url:
        return url
    user = os.getenv("DB_USER", "kb")
    pwd = os.getenv("DB_PASS", "kb")
    host = os.getenv("DB_HOST", "localhost")
    port = os.getenv("DB_PORT", "5432")
    name = os.getenv("DB_NAME", "kb")
    return f"postgresql+asyncpg://{user}:{pwd}@{host}:{port}/{name}"


def _int_env(name: str, default: int) -> int:
    v = os.getenv(name)
    if v is None or not v.strip():
        return default
    try:
        return int(v.strip())
    except ValueError:
        raise RuntimeError(f"环境变量 {name} 不是合法整数: {v!r}") from None


@dataclass
class Settings:
    # 基础设施
    database_url: str = _database_url()
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    data_dir: str = os.getenv("DATA_DIR", "./data")
    cookie_secure: bool = _bool(os.getenv("COOKIE_SECURE"), True)
    enable_hsts: bool = _bool(os.getenv("ENABLE_HSTS"), False)
    max_upload_mb: int = _int_env("MAX_UPLOAD_MB", 50)

    # 会话
    session_ttl: int = _int_env("SESSION_TTL", 7 * 24 * 3600)

    # LLM（OpenAI 兼容：DeepSeek / 智谱等，key 部署时注入）
    llm_api_base: str = os.getenv("LLM_API_BASE", "")
    llm_api_key: str = os.getenv("LLM_API_KEY", "")
    llm_model: str = os.getenv("LLM_MODEL", "deepseek-chat")
    llm_timeout: int = _int_env("LLM_TIMEOUT", 60)

    # Embedding：local（worker 内 bge 模型）| openai_compat（API）
    embedding_provider: str = os.getenv("EMBEDDING_PROVIDER", "local")
    embedding_api_base: str = os.getenv("EMBEDDING_API_BASE", "")
    embedding_api_key: str = os.getenv("EMBEDDING_API_KEY", "")
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")
    embedding_dim: int = _int_env("EMBEDDING_DIM", 512)
    embedding_api_send_dims: bool = _bool(os.getenv("EMBEDDING_API_SEND_DIMS"), False)
    embedding_batch: int = _int_env("EMBEDDING_BATCH", 16)

    # Dify 服务间密钥
    dify_service_key: str = os.getenv("DIFY_SERVICE_KEY", "")

    # 限流（次/窗口秒）
    rl_login_limit: int = _int_env("RL_LOGIN_LIMIT", 5)
    rl_login_window: int = _int_env("RL_LOGIN_WINDOW", 900)
    rl_reveal_limit: int = _int_env("RL_REVEAL_LIMIT", 20)
    rl_reveal_window: int = _int_env("RL_REVEAL_WINDOW", 60)
    rl_chat_limit: int = _int_env("RL_CHAT_LIMIT", 30)
    rl_chat_window: int = _int_env("RL_CHAT_WINDOW", 60)

    # OCR（M1 默认关闭）
    ocr_enabled: bool = _bool(os.getenv("OCR_ENABLED"), False)

    # GitHub 新星池（Search API）可选令牌：配置后限速从 10 次/分 提升到 30 次/分
    github_token: str = os.getenv("GITHUB_TOKEN", "").strip()

    def require_llm(self) -> tuple[str, str, str]:
        if not (self.llm_api_base and self.llm_api_key and self.llm_model):
            raise RuntimeError(
                "LLM 未配置：请设置 LLM_API_BASE / LLM_API_KEY / LLM_MODEL"
            )
        return self.llm_api_base.rstrip("/"), self.llm_api_key, self.llm_model


settings = Settings()
