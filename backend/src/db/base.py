"""Async SQLAlchemy engine, session factory, and declarative Base (ADR-0013).

One process-wide async engine (asyncpg driver) + `async_sessionmaker`. Sessions
are opened per-request via `get_db` (`db/session.py`) — never a module-global
session. `pool_pre_ping` validates a pooled connection before handing it out so a
stale connection surfaces as a clean reconnect, not a mid-query failure.
"""

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from src.config import settings

engine = create_async_engine(
    settings.DATABASE_URL.get_secret_value(),
    pool_size=20,
    pool_pre_ping=True,
)

async_session_factory = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    """Declarative base for every ORM model. New models compose the mixins in
    `db/mixins.py` rather than re-declaring id/timestamp/ownership columns."""
