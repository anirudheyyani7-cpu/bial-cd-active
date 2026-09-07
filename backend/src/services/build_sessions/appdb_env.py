"""The per-project DATABASE half of a build session's injected environment.

`provision_app_database` ensures the project's database + role exist and returns the single
`BIAL_DATABASE_URL` var the sandbox injects into `next dev`. Its own module (not a function in
`appdata.py`) because it needs `await`/`AsyncSession`, unlike `appstorage.py`'s sync builder;
both merge into the same env dict.

THE APP'S DATA LIVES IN ITS OWN DATABASE, AND THE BROWSER HOLDS NO CREDENTIAL FOR IT. This value
must NEVER reach a client component, `window.__BIAL_CONFIG`, a `NEXT_PUBLIC_*` name, rendered
HTML, a log line, or a tracked file (it would ride the git snapshot) — it is a long-lived
credential, the strictest secret on the injected manifest. The wall between two apps is a REVOKE
CONNECT grant the platform makes, not something the generated app has to remember."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from src.services.appdb.provision import ensure_project_database, sandbox_dsn


async def provision_app_database(db: AsyncSession, project_id: uuid.UUID) -> dict[str, str]:
    """Ensure the project's database + role; return `{"BIAL_DATABASE_URL": <sandbox DSN>}`.

    Returns `{}` when `APP_DB__*` is unconfigured (dev/test) — a no-op merge, not a failure. A
    genuine substrate error PROPAGATES before any sandbox handle exists; the whole sequence is
    idempotent, so the next start just re-runs it. That idempotency is also what makes this a
    LAZY ensure: a project created before this feature existed gets its database on its next
    build, no migration needed. The injected value is the SANDBOX form — `control_plane_dsn`
    must never reach a sandbox."""
    record = await ensure_project_database(db, project_id)
    if record is None:
        return {}
    return {"BIAL_DATABASE_URL": sandbox_dsn(record)}
