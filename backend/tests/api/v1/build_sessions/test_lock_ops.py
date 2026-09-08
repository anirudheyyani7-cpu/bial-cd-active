"""U6 — the superadmin `internal/reap` sweep: RBAC, idempotence, audit, and its 503s.

THERE ARE NO LOCK OPS LEFT, and this file's name outlived them. U28 retired `acquire` / `renew`
/ `release` / `heartbeat` along with the tests that were about them specifically (their happy
path, the renew-a-lost-lock 409, the acquire-vs-active 409, and their shared
Redis-outage/Redis-unconfigured coverage): nothing called those routes — the portal's keep-alive
loop that was their only caller was itself deleted back in U13. U33 took the last one standing,
`POST /{session_id}/lock/force-end`, which had had no caller on any surface since the block
banner's Force-end button went; its two tests here (the owner/non-owner/unknown matrix and the
404-before-Redis regression) went with the route, because a deleted route 404s every caller and
neither test could tell that from the behaviour it was written to pin. The reap half of this
suite is untouched below."""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps_rbac import superadmin_allowlist
from src.db.models.audit import AuditLog
from src.services.redis import (
    BUILD_COORDINATION_UNAVAILABLE_MSG,
    REGISTRY_STATE_READY,
    lock_key,
    registry_key,
)
from src.services.redis.keys import (
    REGISTRY_FIELD_APP_NAME,
    REGISTRY_FIELD_CREATED_AT,
    REGISTRY_FIELD_FQDN,
    REGISTRY_FIELD_STATE,
    REGISTRY_FIELD_TOKEN_REF,
)
from tests.api.v1.build_sessions.conftest import auth_headers
from tests.factories import UserFactory
from tests.fakes import a_sandbox_name


async def test_internal_reap_superadmin_only_and_idempotent(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    citizen = await UserFactory.create(db_session, email="lk5-citizen@rvaiglobal.com")
    admin = await UserFactory.create(db_session, email="lk5-admin@rvaiglobal.com")
    wire.app.dependency_overrides[superadmin_allowlist] = lambda: frozenset({admin.email})

    # A citizen is denied by the superadmin gate.
    denied = await client.post("/v1/build-sessions/internal/reap", headers=auth_headers(citizen))
    assert denied.status_code == 403

    # Seed a stale sandbox (registry + lock, no heartbeat) so the sweep reaps exactly one.
    stale = uuid.uuid4()
    await fake_redis.hset(
        registry_key(stale),
        mapping={
            REGISTRY_FIELD_APP_NAME: a_sandbox_name("stale"),
            REGISTRY_FIELD_FQDN: "stale.example",
            REGISTRY_FIELD_TOKEN_REF: "ref",
            REGISTRY_FIELD_CREATED_AT: "2026-07-14T00:00:00+00:00",
            REGISTRY_FIELD_STATE: REGISTRY_STATE_READY,
        },
    )
    await fake_redis.set(lock_key(stale), "crashed", ex=900)

    ok = await client.post("/v1/build-sessions/internal/reap", headers=auth_headers(admin))
    assert ok.status_code == 200
    assert ok.json()["reaped"] == 1
    # A second immediate sweep is a clean no-op (idempotent / timer-safe).
    again = await client.post("/v1/build-sessions/internal/reap", headers=auth_headers(admin))
    assert again.status_code == 200 and again.json()["reaped"] == 0


async def test_internal_reap_is_audited(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    # Every superadmin-gated action is audited (ADR-0005): a successful reap writes ONE
    # accountability row with the sweep count in `detail`.
    admin = await UserFactory.create(db_session, email="lk6-admin@rvaiglobal.com")
    wire.app.dependency_overrides[superadmin_allowlist] = lambda: frozenset({admin.email})

    stale = uuid.uuid4()
    await fake_redis.hset(
        registry_key(stale),
        mapping={
            REGISTRY_FIELD_APP_NAME: a_sandbox_name("stale"),
            REGISTRY_FIELD_FQDN: "stale.example",
            REGISTRY_FIELD_TOKEN_REF: "ref",
            REGISTRY_FIELD_CREATED_AT: "2026-07-14T00:00:00+00:00",
            REGISTRY_FIELD_STATE: REGISTRY_STATE_READY,
        },
    )
    await fake_redis.set(lock_key(stale), "crashed", ex=900)

    ok = await client.post("/v1/build-sessions/internal/reap", headers=auth_headers(admin))
    assert ok.status_code == 200 and ok.json()["reaped"] == 1

    row = (
        await db_session.execute(select(AuditLog).where(AuditLog.action == "build_session.reap"))
    ).scalar_one()
    assert row.actor_id == admin.id
    assert row.resource_type == "build_session"
    # `failed` rides in the audit row too: "reaped 0" alone cannot distinguish a clean
    # sweep from one in which every user threw.
    assert row.detail == {"reaped": 1, "failed": 0}


async def test_internal_reap_documents_the_503_in_its_openapi_responses(
    client: AsyncClient,
) -> None:
    # The lock-op half of this table used to sit here too (acquire/renew/release/heartbeat all
    # documented the same 503) and is gone with the routes (U28/U33). `internal/reap` is the
    # only route left in this file, and the only one that ever documented a 503.
    schema = (await client.get("/openapi.json")).json()
    path = "/v1/build-sessions/internal/reap"
    assert "503" in schema["paths"][path]["post"]["responses"], path


# --- internal/reap: a Redis outage is a 503 to the operator, never a 500 -----------------


async def test_internal_reap_is_503_on_a_redis_outage(
    client: AsyncClient, db_session: AsyncSession, fake_redis, wire
) -> None:
    """A total Redis outage during the reconciliation sweep is a retryable 503 to the operator,
    never an opaque 500: the sweep runs inside `build_coordination_or_503`, and the audit row lives
    INSIDE the seam AFTER the sweep, so a sweep that never ran writes NO accountability row and
    nothing is committed. `scan_iter` is cursed because that is the first Redis call `sweep_all`
    makes (an async generator, so it must raise on iteration)."""
    admin = await UserFactory.create(db_session, email="lk7-admin@rvaiglobal.com")
    wire.app.dependency_overrides[superadmin_allowlist] = lambda: frozenset({admin.email})

    async def scan_iter_is_gone(*_args: object, **_kwargs: object):
        raise RedisError("redis is down")
        yield  # unreachable: forces an async generator so `async for` raises on the first step

    curse = pytest.MonkeyPatch()
    curse.setattr(fake_redis, "scan_iter", scan_iter_is_gone)
    try:
        resp = await client.post("/v1/build-sessions/internal/reap", headers=auth_headers(admin))
    finally:
        curse.undo()

    assert resp.status_code == 503
    assert resp.status_code != 500
    assert resp.json()["error"]["message"] == BUILD_COORDINATION_UNAVAILABLE_MSG
    # No audit row for a sweep that never ran (the row is deliberately inside the seam).
    row = await db_session.scalar(select(AuditLog).where(AuditLog.action == "build_session.reap"))
    assert row is None


async def test_internal_reap_is_503_not_500_when_redis_is_not_configured(
    client: AsyncClient, db_session: AsyncSession, wire
) -> None:
    """FIX 1 regression, deliberately FIXTURE-FREE (`.claude/rules/testing.md`): no `fake_redis`
    bound, so `get_redis()` raises `RedisNotConfiguredError` INSIDE the seam and the trailing
    `_coordination_is_gone()` answers 503. Before FIX 1 the eager `RedisDep` raised that at
    dependency-solve time → an undocumented 500. No sweep, so no audit row."""
    admin = await UserFactory.create(db_session, email="lk7b-admin@rvaiglobal.com")
    wire.app.dependency_overrides[superadmin_allowlist] = lambda: frozenset({admin.email})

    resp = await client.post("/v1/build-sessions/internal/reap", headers=auth_headers(admin))
    assert resp.status_code == 503
    assert resp.status_code != 500
    assert resp.json()["error"]["message"] == BUILD_COORDINATION_UNAVAILABLE_MSG
    row = await db_session.scalar(select(AuditLog).where(AuditLog.action == "build_session.reap"))
    assert row is None
