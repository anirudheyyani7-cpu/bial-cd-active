"""Remove a published app's container — when its app is deleted, and on the admin kill-switch.

WHY THIS EXISTS: without it, deleting a project leaves a live application running — still
serving, still billing, and named nowhere once the deployment row goes with the app under
`ON DELETE CASCADE`. The sandbox reaper can't find it either: it reads the Redis sandbox
registry, which a published app is never written to. It would run until a human noticed.

The app id is captured BEFORE the delete commits (the project cascade already does this for
the per-app Blob containers, so the same list serves both). Best-effort and never-raising,
matching `sweep_app_containers`: a container that outlives its app is a bounded, logged leak,
while raising here would abort a delete that has ALREADY COMMITTED.

TWO CALLERS, TWO POSTURES: the delete paths are best-effort as above; `deploy/router.py`'s
`unpublish` is a synchronous admin lever that must FAIL LOUD, so it reads the return count
and 503s on zero instead. Note what the count means there: `delete_app` no-ops on an absent
container and still increments, so non-zero means "no error", not "something was deleted".
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable

import structlog

from src.services.deploy.aca_publish import (
    DeployNotConfiguredError,
    PublishedAppRemover,
    get_published_apps,
)

_log = structlog.get_logger()

SWEPT_EVENT = "published_app_swept"


async def sweep_published_apps(
    app_ids: Iterable[uuid.UUID], *, client: PublishedAppRemover | None = None
) -> int:
    """Delete the published container app for each id. Returns how many were removed.

    `client` is injectable so a test can assert on the delete without reaching Azure; the
    default resolves the process singleton, and a deployment with publishing switched off
    simply has nothing to sweep."""
    ids = list(app_ids)
    if not ids:
        return 0

    if client is None:
        try:
            client = get_published_apps()
        except DeployNotConfiguredError:
            # Publishing is off on this deployment, so nothing was ever published.
            return 0

    swept = 0
    for app_id in ids:
        try:
            await client.delete_app(app_id=app_id)
            swept += 1
        except Exception:
            # A live container that outlives its app is a leak; a raise here would abort a
            # delete that already committed. Log loudly and keep going.
            _log.warning("published_app_sweep_failed", app_id=str(app_id), exc_info=True)
    if swept:
        _log.info(SWEPT_EVENT, count=swept)
    return swept
