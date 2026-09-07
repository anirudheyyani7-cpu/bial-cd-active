"""Remove a published app's container — when its app is deleted, and on the admin kill-switch.

WITHOUT THIS, DELETING A PROJECT LEAVES A LIVE APPLICATION RUNNING. It would keep serving
whatever it had cached, keep billing, and — because the deployment row went with the app
under `ON DELETE CASCADE` — there would be nothing left anywhere that names it. The sandbox
reaper cannot find it either: that sweep reads the Redis sandbox registry, which a published
app is deliberately never written to. It would run until a human noticed.

So the app id must be captured BEFORE the delete commits, which the project cascade already
does for the per-app Blob containers. The published container name is a pure function of the
app id, so the same list serves both — no extra column, no second query.

Best-effort and never raising, matching `sweep_app_containers`: an exception here would abort a
delete that has ALREADY COMMITTED and leave the caller believing it failed. A container that
outlives its app is therefore a leak AN OPERATOR must sweep by hand — this said "a bounded,
logged leak an operator can sweep", which read as though something would eventually come for
it. Nothing will: the sandbox reaper cannot see a published app at all (it reads the Redis
registry, which this path never writes), and no other reconciler on the delete path runs on a
timer outside production. So a failure raises `TEARDOWN_ARTEFACT_SURVIVED_EVENT` and the
caller records it (U22, R7a).

TWO CALLERS, TWO POSTURES, and the never-raise contract serves both. The delete paths are
best-effort as above. `deploy/router.py`'s `unpublish` (#113) is the opposite — it is a
synchronous admin lever that must FAIL LOUD — so it reads the return count back and 503s on
zero rather than asking this function to raise. Keep it never-raising: the delete paths call
it after their own commit, where an exception has nothing left to undo. Note what the count
means for that reader: `delete_app` no-ops on an absent container and still increments, so a
non-zero count means "no error", not "something was deleted".
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable

import structlog

from src.core.alarms import TEARDOWN_ARTEFACT_SURVIVED_EVENT
from src.services.deploy.aca_publish import (
    DeployNotConfiguredError,
    PublishedAppRemover,
    get_published_apps,
)

_log = structlog.get_logger()

SWEPT_EVENT = "published_app_swept"


async def sweep_published_apps(
    app_ids: Iterable[uuid.UUID], *, client: PublishedAppRemover | None = None
) -> list[uuid.UUID]:
    """Delete the published container app for each id. Returns the ids that SURVIVED.

    IT ANSWERS WITH SURVIVORS, LIKE ITS SIBLINGS, and that is the whole of the difference from
    the count it used to return. Four teardown arms on the delete path hand back what they could
    not destroy; this one handed back a number, so its caller had to re-derive whether publishing
    was configured at all (a fact this function already answers internally) and, on a short
    count, name EVERY id as a survivor. The audit row that records what outlived a delete is
    supposed to be attributable — naming an app that was in fact deleted is worse than naming
    none, because it sends an operator after something that is not there.

    An empty list therefore means "nothing survived", including on a deployment with publishing
    switched off, where nothing was ever published.

    `client` is injectable so a test can assert on the delete without reaching Azure; the
    default resolves the process singleton."""
    ids = list(app_ids)
    if not ids:
        return []

    if client is None:
        try:
            client = get_published_apps()
        except DeployNotConfiguredError:
            # Publishing is off on this deployment, so nothing was ever published.
            return []

    swept = 0
    survived: list[uuid.UUID] = []
    for app_id in ids:
        try:
            await client.delete_app(app_id=app_id)
            swept += 1
        except Exception:
            # A live container that outlives its app keeps serving and keeps BILLING, and
            # nothing automatic will come for it; a raise here would abort a delete that
            # already committed. Alarm loudly and keep going.
            _log.warning(
                TEARDOWN_ARTEFACT_SURVIVED_EVENT,
                artefact="published_app",
                artefact_id=str(app_id),
                reason="the container app could not be deleted",
                exc_info=True,
            )
            survived.append(app_id)
    if swept:
        _log.info(SWEPT_EVENT, count=swept)
    return survived
