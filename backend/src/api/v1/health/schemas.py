"""Health domain response schema."""

from __future__ import annotations

from typing import Literal

from src.schemas import CamelModel


class HealthStatus(CamelModel):
    """The `/v1/health` body; every field is single-word, so the camel base is a no-op.
    ⚠️ `degraded` NO LONGER IMPLIES 503 — automate on the HTTP status, never on the word
    `degraded`. Postgres unreachable → `degraded` + **503** (fails CLOSED, always-on).
    Redis unreachable → `degraded` + **200** (build sessions only; draining would cost
    users working functionality for nothing). `not_configured` reports `ok`: Redis is
    optional outside prod, and folding it into `unreachable` would 503 every storage-off
    dev box — the collapse-two-tiers bug this codebase already shipped once.
    """

    status: Literal["ok", "degraded"]
    database: Literal["ok", "unreachable"]
    redis: Literal["ok", "unreachable", "not_configured"]
