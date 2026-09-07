"""Admin danger ops — the destructive purge behind the super-admin governance
surface. Internal symbols use the witty naming rule: `nuke_app` (hard-delete).
Public API responses stay professional.

The old per-app file model (`app_files`) and the shared `data_records`
plane are both retired, so what an app owns here is object-store blobs only:
`nuke_app` sweeps the app's snapshot bundle, its immutable submission bundles, AND
its per-app Blob container before dropping the registry row. A residual blob is a
bounded storage orphan, never a data loss. The project's own PostgreSQL database is a
POST-COMMIT teardown owned by the caller, not by this module.
"""

from __future__ import annotations

import uuid

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models.app_registry import AppRegistry
from src.services.deploy.teardown import sweep_published_apps
from src.services.storage import (
    AppContainerStore,
    ObjectStorage,
    all_keys_under,
    recovery_key,
    snapshot_key,
    submissions_prefix,
    sweep_app_containers,
    sweep_blobs,
)


async def nuke_app(
    db: AsyncSession,
    storage: ObjectStorage,
    app_id: uuid.UUID,
    container_store: AppContainerStore | None,
) -> None:
    """Hard-delete an app: sweep the snapshot bundle, every submission bundle under
    `submissions/{app_id}/`, and the per-app Blob CONTAINER, then drop the registry row — sweeps
    first, while the id still resolves them. Sweeps are best-effort (a residual blob/container is
    a bounded, logged orphan) EXCEPT the submissions enumeration, which raises: proceeding past a
    failed listing would drop the row and strand unfindable blobs, so the delete fails retryably
    instead. BLOB-ONLY: the project's Postgres DB/role is the caller's POST-COMMIT
    `salt_the_earth` step, after `db.commit()` — `DROP DATABASE` cannot run inside this
    function's transaction, so putting it here would not merely be misplaced, it would fail."""
    submission_keys = await all_keys_under(storage, submissions_prefix(app_id))
    # `recovery_key` alongside `snapshot_key`: both carry the app's whole tree, and a hard
    # delete that leaves one of them behind has not deleted the app.
    await sweep_blobs(storage, [snapshot_key(app_id), recovery_key(app_id), *submission_keys])
    await sweep_app_containers(container_store, [app_id])
    # The published container app too, and BEFORE the row goes: after the delete there is
    # nothing left that names the running container, and the sandbox reaper cannot reach it
    # (it sweeps the Redis registry, which a published app is deliberately never in). An
    # admin who hard-deletes an app must not leave it serving that app's data.
    await sweep_published_apps([app_id])
    await db.execute(sa.delete(AppRegistry).where(AppRegistry.id == app_id))
