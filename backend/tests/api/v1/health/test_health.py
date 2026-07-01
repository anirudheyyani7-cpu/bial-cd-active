"""Health endpoint: happy path, fail-closed on DB down, and security headers."""

from __future__ import annotations

from src.db.session import get_db


async def test_health_returns_ok(client) -> None:
    # Happy path: DB reachable (real test session via the get_db override). No
    # auth required — health is public.
    response = await client.get("/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


async def test_health_503_when_db_down(app, client) -> None:
    # A DB failure must fail the probe CLOSED (503) so a platform health gate
    # doesn't route traffic to an API that can't reach its database.
    class _BoomSession:
        async def execute(self, *args: object, **kwargs: object) -> object:
            raise RuntimeError("db down")

    async def _boom_db():
        yield _BoomSession()

    app.dependency_overrides[get_db] = _boom_db
    try:
        response = await client.get("/v1/health")
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert response.status_code == 503
    assert response.json() == {"status": "degraded", "database": "unreachable"}


async def test_health_sets_security_headers(client) -> None:
    # The security-headers middleware applies to every response.
    response = await client.get("/v1/health")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["cache-control"] == "no-store"
