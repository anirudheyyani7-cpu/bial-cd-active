"""Delete a published app's REPOSITORY from the container registry when its app is deleted.

WITHOUT THIS, DELETING A PROJECT LEAVES ITS IMAGE IN THE REGISTRY FOREVER (#184). The dialog
that collects the citizen's reason promises the files behind the app are "destroyed
permanently"; every other artefact on the delete path is torn down to make that true — the
rows, the blobs, the per-app Blob container, the per-project database, the running container
app, the sandbox — and the built image was the one thing left standing. It is also the one
that still holds the citizen's source: a Next.js image carries the app's compiled tree.

A DELETE DELETES, so this runs DURING the delete rather than on a later sweep. There is no
sweep to defer to: the repository name is derived from the app id, and the row that carried
that id is gone the moment the cascade commits (see `src/core/alarms.py`'s
`TEARDOWN_ARTEFACT_SURVIVED_EVENT` for what does and does not run on a timer here).

RAW REST OVER `httpx`, NOT AN SDK, for the same reason `images.py` speaks ARM REST directly:
`azure-containerregistry` has had no release since 2023-07-11 and its classifiers stop at
Python 3.11, against this backend's 3.14 — a whole unmaintained dependency for two calls.
`httpx` is already in the set and already the thing every other Azure data-plane call in this
package is tested against (`httpx.MockTransport`).

THE CREDENTIAL IS THE ONE ALREADY LOADED, and the scope rides the TOKEN REQUEST rather than
the credential. `acr_username`/`acr_password` are required settings the process already holds
and already WRITES to the registry with (`local_images.py` does `docker login` and pushes with
them), so a second, narrower secret would guard nothing that is not already in this process.
What actually needs guarding is our own bug naming the wrong repository, and that is guarded
directly: the exchange asks for `repository:{repo}:delete` — a token good for exactly one
repository — and the name is composed by `names.repository_name`, the same function the build
pushed with. A test asserts the scope on the request, which is a stronger check than a
narrower credential would have given. If BIAL later issues a `citizen-apps/*` scope-map token,
it is an additive setting against a mechanism already proven here.

THE TWO CALLS:
  1. GET  {server}/oauth2/token?service={server}&scope=repository:{repo}:delete   (Basic auth)
  2. DELETE {server}/acr/v1/{repo}?api-version=2021-07-01                         (Bearer)

`202` and `404` are BOTH success: the delete is accepted asynchronously, and a repository that
is already gone is the state the caller asked for, so a repeated delete is a silent no-op
rather than an error. Everything else — 401, 403, 429, 5xx, a timeout, a DNS failure — is one
catch, because the caller's response to all of them is identical: log the alarm, leave the
image for a human, and let the delete stand.

NEVER RAISES, matching `sweep_published_apps` and `sweep_blobs`. This runs after the commit,
where an exception has nothing left to undo and would only turn a delete that succeeded into a
500 for the citizen.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from typing import Final

import httpx
import sqlalchemy as sa
import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.alarms import TEARDOWN_ARTEFACT_SURVIVED_EVENT
from src.db.models.deployment import Deployment
from src.services.deploy.config import DeployConfig
from src.services.deploy.names import repository_name

_log = structlog.get_logger()

# The ACR data-plane delete route's API version, pinned explicitly like `images.py` pins the
# Tasks one: an unpinned version is a 404 the day the registry moves its default.
_ACR_API_VERSION: Final = "2021-07-01"

# Both legs are bounded. The token exchange is a small control-plane call; the delete is
# asynchronous on the registry's side (202 means "accepted", not "finished"), so neither
# should ever be slow — and this sits on a request a citizen is waiting on, AFTER their delete
# has already committed, so a hung registry must not hold the response open.
_TOKEN_TIMEOUT_S: Final = 15.0
_DELETE_TIMEOUT_S: Final = 30.0

REPOSITORY_DELETED_EVENT: Final = "registry_repository_deleted"
"""One line per repository actually removed — the trail that says the image went with the app."""


def _scope_for(repository: str) -> str:
    """The token scope: delete on THIS repository and nothing else.

    The registry issues a token per scope, so this string is the blast radius of the call
    below. It is asserted on the request by test, because it — not the credential — is what
    stops a bug in the name derivation from reaching another app's images."""
    return f"repository:{repository}:delete"


async def delete_repository(
    repository: str,
    *,
    config: DeployConfig,
    transport: httpx.AsyncBaseTransport | None = None,
) -> bool:
    """Delete one repository. `True` when it is gone (deleted, or already absent). NEVER RAISES.

    `transport` is injectable so a test drives the whole exchange through
    `httpx.MockTransport` without reaching Azure — the same seam `images.py` and
    `sandbox/client.py` use."""
    base = f"https://{config.acr_server}"
    try:
        async with httpx.AsyncClient(transport=transport, timeout=None) as http:
            token_resp = await http.get(
                f"{base}/oauth2/token",
                params={"service": config.acr_server, "scope": _scope_for(repository)},
                auth=(config.acr_username, config.acr_password.get_secret_value()),
                timeout=_TOKEN_TIMEOUT_S,
            )
            token_resp.raise_for_status()
            # `access_token` is what the exchange is FOR: a body without it is a registry that
            # answered 200 and gave us nothing, which is a failure however friendly it looked.
            token = token_resp.json()["access_token"]
            resp = await http.delete(
                f"{base}/acr/v1/{repository}",
                params={"api-version": _ACR_API_VERSION},
                headers={"Authorization": f"Bearer {token}"},
                timeout=_DELETE_TIMEOUT_S,
            )
            # 404 IS SUCCESS, not an error to report: the caller asked for the repository to
            # not exist, and it does not. A re-run of a delete that already worked, or an app
            # that was never published, must not raise an alarm a human then chases.
            if resp.status_code == httpx.codes.NOT_FOUND:
                return True
            resp.raise_for_status()
    except Exception as exc:  # noqa: BLE001 — post-commit: one catch, one response (see module docstring)
        # TYPE AND STATUS ONLY. An httpx error's text can carry the request URL, and the
        # request carries the Basic credential in a header the repr of some exceptions
        # includes; the operator needs to know WHICH repository survived and roughly why, not
        # the registry's own prose.
        _log.warning(
            TEARDOWN_ARTEFACT_SURVIVED_EVENT,
            artefact="registry_repository",
            artefact_id=repository,
            reason="the registry refused the delete or could not be reached",
            error_type=type(exc).__name__,
            status=getattr(getattr(exc, "response", None), "status_code", None),
        )
        return False
    _log.info(REPOSITORY_DELETED_EVENT, repository=repository)
    return True


async def app_ids_that_could_have_an_image(
    db: AsyncSession, app_ids: Iterable[uuid.UUID]
) -> list[uuid.UUID]:
    """The subset of `app_ids` that has ever had a deployment row — the only apps whose
    repository can exist in the registry at all.

    THE NAME IS ONLY EVER MINTED FROM A DEPLOYMENT. `names.image_tag` composes the push tag
    from the DEPLOYMENT id, so an image cannot reach the registry without a row in
    `deployments`; the row is therefore a NECESSARY condition for a repository, which is what
    makes filtering on it safe rather than a guess that could strand an image.

    WHY FILTER AT ALL, when a delete of an absent repository already answers 404 and 404 counts
    as success: because a registry that REFUSES the credential answers 401/403, and every app in
    the sweep then comes back as a survivor — including apps that were never built, whose
    repositories never existed. That fills the teardown record with names an operator would go
    looking for and not find, which the sibling sweeps' own docstrings call worse than naming
    nothing. A misconfigured delete credential should read as "the published apps' images may
    still be there", not as a leak per app in the account.

    MUST BE CALLED BEFORE THE COMMIT that removes the app. `deployments` rows cascade with the
    app row, so after the delete this answers an empty list for everything."""
    ids = list(app_ids)
    if not ids:
        return []
    query = sa.select(Deployment.app_id).where(Deployment.app_id.in_(ids)).distinct()
    built = set((await db.execute(query)).scalars().all())
    # Ordered by the CALLER's list, not by the database's, so the sweep and anything reading its
    # survivors stay in a stable, explainable order.
    return [app_id for app_id in ids if app_id in built]


async def sweep_app_repositories(
    app_ids: Iterable[uuid.UUID],
    *,
    config: DeployConfig | None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[str]:
    """Delete every app's repository; return the repositories that may STILL EXIST.

    The return is what lets the delete path record precisely what survived instead of guessing
    — an empty list means the registry holds nothing of these apps any more.

    ONE SKIP ARM, and it is the only one there is: `config is None` means `DEPLOY__*` is unset,
    so publishing is off on this deployment (the dev and test posture) and no image was ever
    built to delete. That is a genuine no-op, not a leak, so it is logged at debug and reports
    no survivors. There is deliberately no second arm for "no delete credential": the
    credential this uses is required config, present wherever publishing is on at all."""
    ids = list(app_ids)
    if not ids:
        return []
    if config is None:
        _log.debug("registry_repository_delete_skipped_unconfigured", count=len(ids))
        return []
    survived: list[str] = []
    for app_id in ids:
        repository = repository_name(
            repository_prefix=config.image_repository_prefix, app_id=app_id
        )
        if not await delete_repository(repository, config=config, transport=transport):
            survived.append(repository)
    return survived
