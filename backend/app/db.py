"""数据库访问：异步会话 + 轻量 SQL 助手 + 启动时幂等建表。

约定：所有 SQL 均为代码内静态字符串，用户输入一律走绑定参数（:name）。
"""
from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from .config import settings

_engine: AsyncEngine | None = None
_maker: async_sessionmaker[AsyncSession] | None = None


def _sessionmaker() -> async_sessionmaker[AsyncSession]:
    global _engine, _maker
    if _maker is None:
        _engine = create_async_engine(settings.database_url, pool_pre_ping=True, pool_size=10)
        _maker = async_sessionmaker(_engine, expire_on_commit=False)
    return _maker


async def close_engine() -> None:
    global _engine, _maker
    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _maker = None


async def init_schema() -> None:
    """执行 schema.sql（全部 IF NOT EXISTS，幂等）。"""
    sql = (Path(__file__).parent / "schema.sql").read_text(encoding="utf-8")
    async with _sessionmaker()() as session:
        await session.execute(text(sql))
        await session.commit()


def _rows(result) -> list[dict]:
    return [dict(r._mapping) for r in result]


async def fetch_all(sql: str, params: dict | None = None) -> list[dict]:
    async with _sessionmaker()() as session:
        res = await session.execute(text(sql), params or {})
        return _rows(res)


async def fetch_one(sql: str, params: dict | None = None) -> dict | None:
    rows = await fetch_all(sql, params)
    return rows[0] if rows else None


async def execute(sql: str, params: dict | None = None) -> None:
    async with _sessionmaker()() as session:
        await session.execute(text(sql), params or {})
        await session.commit()


async def execute_returning(sql: str, params: dict | None = None) -> dict | None:
    async with _sessionmaker()() as session:
        res = await session.execute(text(sql), params or {})
        await session.commit()
        rows = _rows(res)
        return rows[0] if rows else None


async def transact(statements: list[tuple[str, dict | None]]) -> None:
    """同一事务内执行多条静态 SQL（绑定参数）。"""
    async with _sessionmaker()() as session:
        for sql, params in statements:
            await session.execute(text(sql), params or {})
        await session.commit()


def vec(v: list[float]) -> str:
    """向量 → pgvector 文本字面量（经 cast(:v AS vector) 绑定）。"""
    return "[" + ",".join(f"{x:.7g}" for x in v) + "]"


def j(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)
