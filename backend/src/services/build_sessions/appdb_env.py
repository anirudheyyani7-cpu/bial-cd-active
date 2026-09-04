"""The per-project DATABASE half of a build session's injected environment.

`provision_app_database` ensures the project's own database + role exist and returns the
single `BIAL_DATABASE_URL` var the sandbox injects into `next dev`.

A module of its own rather than a function in `appdata.py`, for the same reason
`appstorage.py` is one: `build_app_env` there is a SYNC, pure builder with no session and
no I/O, while this needs `await` and an `AsyncSession`; both merge into the same env dict.

THE APP'S DATA LIVES IN ITS OWN DATABASE, AND THE BROWSER HOLDS NO CREDENTIAL FOR IT. There
is no shared data plane: a generated app reaches its own PostgreSQL database with Drizzle
from SERVER code, so this value must never reach a client component, `window.__BIAL_CONFIG`,
a `NEXT_PUBLIC_*` name, rendered HTML, a log line, or a tracked file (it would ride the git
snapshot). It is a long-lived credential rather than a TTL'd capability, which makes it the
strictest secret on the injected manifest. The wall between two apps is a REVOKE CONNECT
grant the platform makes, not a predicate the generated app has to remember — and because
the control plane serves no app-facing data route, its CORS layer reflects `Origin: null`
on no path at all.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from src.services.appdb.provision import ensure_project_database, sandbox_dsn


async def provision_app_database(db: AsyncSession, project_id: uuid.UUID) -> dict[str, str]:
    """Ensure the project's database + role; return `{"BIAL_DATABASE_URL": <sandbox DSN>}`.

    Returns `{}` when `APP_DB__*` is unconfigured (dev/test) — a no-op merge, so the app
    simply has no persistence rather than the start failing. A genuine substrate error is
    left to PROPAGATE: it fails the start before any sandbox handle exists, and the whole
    sequence is idempotent, so the next start just re-runs it.

    `ensure_project_database` is idempotent and self-healing, which is what makes this the
    LAZY ensure too: a project created before this feature existed (or while the substrate
    was unconfigured) gets its database on its next build, without a migration or a sweep.

    The injected value is the SANDBOX form — bare `postgresql://`, host-rewritten for the
    container. `control_plane_dsn` must never reach a sandbox.
    """
    record = await ensure_project_database(db, project_id)
    if record is None:
        return {}
    return {"BIAL_DATABASE_URL": sandbox_dsn(record)}
