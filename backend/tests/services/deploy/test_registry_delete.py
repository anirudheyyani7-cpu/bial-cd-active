"""The deleted app's repository goes with it, and the token it uses reaches nothing else (U21).

THE SCOPE ASSERTION IS THE POINT OF THIS FILE. The credential is the registry-wide ACR admin
account the backend already holds and already pushes with, so what stands between a bug in the
name derivation and another citizen's images is not the secret — it is the scope on the token
request and the derived repository name on the delete. Both are asserted on the REQUEST, which
is the only place they are observable.

Everything runs through `httpx.MockTransport`: no Azure, no credential, no network. The error
arms are the ones a real deployment will hit first (a credential without `content/delete`, a
registry that is briefly unreachable), and every one of them must leave the caller intact —
this function runs after the citizen's delete has already committed.
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import structlog
from pydantic import SecretStr

from src.core.alarms import TEARDOWN_ARTEFACT_SURVIVED_EVENT
from src.services.deploy.config import DeployConfig
from src.services.deploy.names import image_tag, repository_name
from src.services.deploy.registry_delete import (
    REPOSITORY_DELETED_EVENT,
    delete_repository,
    sweep_app_repositories,
)

_SERVER = "bialgenaicr.azurecr.io"
_TOKEN = "registry-scoped-token"


def _config(**overrides: Any) -> DeployConfig:
    base: dict[str, Any] = {
        "acr_server": _SERVER,
        "acr_name": "bialgenaicr",
        "acr_resource_group": "BIAL-GENAI-AIML-RG",
        "acr_subscription_id": "sub-acr",
        "acr_username": "bialgenaicr",
        "acr_password": SecretStr("acr-pass"),
        "subscription_id": "sub",
        "resource_group": "rg",
        "region": "centralindia",
        "managed_environment_name": "env",
    }
    return DeployConfig(**{**base, **overrides})


def _registry(record: list[httpx.Request], *, delete_status: int = 202) -> httpx.MockTransport:
    """A registry that issues a token and answers the delete with `delete_status`."""

    def handler(request: httpx.Request) -> httpx.Response:
        record.append(request)
        if request.url.path == "/oauth2/token":
            return httpx.Response(200, json={"access_token": _TOKEN})
        return httpx.Response(delete_status)

    return httpx.MockTransport(handler)


def _delete_request(record: list[httpx.Request]) -> httpx.Request:
    return next(r for r in record if r.method == "DELETE")


def _token_request(record: list[httpx.Request]) -> httpx.Request:
    return next(r for r in record if r.url.path == "/oauth2/token")


# --- the guard that matters ----------------------------------------------------------------


async def test_the_token_is_scoped_to_the_one_repository_being_deleted() -> None:
    # THE WHOLE SAFETY ARGUMENT, ASSERTED. The account can delete anything in the registry;
    # this token can delete exactly one repository. A wildcard, a missing scope or a second
    # repository in the string is a token that could destroy another citizen's images.
    #
    # Mutation check: widen the scope to `repository:citizen-apps/*:delete` and this goes red.
    record: list[httpx.Request] = []
    app_id = uuid.uuid4()
    repository = repository_name(repository_prefix="citizen-apps", app_id=app_id)

    assert await delete_repository(repository, config=_config(), transport=_registry(record))

    token = _token_request(record)
    assert token.url.params["scope"] == f"repository:{repository}:delete"
    assert token.url.params["service"] == _SERVER
    # Basic auth on the exchange, from the credential the process already holds.
    assert token.headers["authorization"].startswith("Basic ")


async def test_the_delete_names_the_derived_repository_and_nothing_else() -> None:
    # The repository is DERIVED, never stored, so the name on the wire is the only place the
    # derivation can be checked — and it must equal the repository half of the tag the build
    # pushed to, or the delete misses the image it exists to remove.
    record: list[httpx.Request] = []
    app_id = uuid.uuid4()
    deployment_id = uuid.uuid4()
    repository = repository_name(repository_prefix="citizen-apps", app_id=app_id)

    await delete_repository(repository, config=_config(), transport=_registry(record))

    sent = _delete_request(record)
    assert sent.url.path == f"/acr/v1/{repository}"
    assert sent.url.host == _SERVER
    assert sent.url.params["api-version"] == "2021-07-01"
    assert sent.headers["authorization"] == f"Bearer {_TOKEN}"
    # ...and it is the same repository the push tag carries.
    tag = image_tag(repository_prefix="citizen-apps", app_id=app_id, deployment_id=deployment_id)
    assert tag.startswith(f"{repository}:")


# --- the arms a deployment actually hits ---------------------------------------------------


async def test_a_repository_that_is_already_gone_is_success() -> None:
    # A re-run of a delete that already worked, or an app that was never published: the state
    # the caller asked for is the state that exists. Reporting a leak here would send an
    # operator hunting for an image nobody has.
    record: list[httpx.Request] = []
    with structlog.testing.capture_logs() as captured:
        assert await delete_repository(
            "citizen-apps/gone", config=_config(), transport=_registry(record, delete_status=404)
        )
    assert not [e for e in captured if e.get("event") == TEARDOWN_ARTEFACT_SURVIVED_EVENT]


async def test_a_permission_refusal_is_reported_and_never_raised() -> None:
    # The failure this ships against: a credential without `content/delete`. It must alarm,
    # report the survivor, and let the caller's already-committed delete stand.
    record: list[httpx.Request] = []
    with structlog.testing.capture_logs() as captured:
        assert not await delete_repository(
            "citizen-apps/kept", config=_config(), transport=_registry(record, delete_status=403)
        )
    alarm = next(e for e in captured if e.get("event") == TEARDOWN_ARTEFACT_SURVIVED_EVENT)
    assert alarm["artefact"] == "registry_repository"
    assert alarm["artefact_id"] == "citizen-apps/kept"
    assert alarm["status"] == 403


async def test_a_registry_that_cannot_be_reached_is_reported_and_never_raised() -> None:
    # Not an HTTP status at all — a transport failure, which is what a DNS blip or a dropped
    # connection looks like. The one catch has to cover it or a delete that already committed
    # 500s at the citizen.
    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("name or service not known")

    with structlog.testing.capture_logs() as captured:
        assert not await delete_repository(
            "citizen-apps/kept", config=_config(), transport=httpx.MockTransport(unreachable)
        )
    alarm = next(e for e in captured if e.get("event") == TEARDOWN_ARTEFACT_SURVIVED_EVENT)
    assert alarm["error_type"] == "ConnectError"
    # No response, so no status — the field is present and honest rather than absent.
    assert alarm["status"] is None


async def test_a_token_exchange_that_answers_without_a_token_is_a_failure() -> None:
    # A 200 with no `access_token` is a registry that said yes and gave us nothing. Reading it
    # with `[...]` rather than `.get(...)` is what turns that into a reported failure instead
    # of a `Bearer None` delete that 401s a layer later.
    def no_token(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"refresh_token": "wrong-one"})

    assert not await delete_repository(
        "citizen-apps/kept", config=_config(), transport=httpx.MockTransport(no_token)
    )


# --- the sweep the delete path calls -------------------------------------------------------


async def test_the_sweep_reports_only_the_repositories_that_survived() -> None:
    kept = uuid.uuid4()
    record: list[httpx.Request] = []

    survived = await sweep_app_repositories(
        [kept], config=_config(), transport=_registry(record, delete_status=403)
    )

    assert survived == [repository_name(repository_prefix="citizen-apps", app_id=kept)]
    assert (
        await sweep_app_repositories([uuid.uuid4()], config=_config(), transport=_registry([]))
        == []
    )


async def test_publishing_switched_off_skips_the_registry_entirely() -> None:
    # THE ONE SKIP ARM THAT EXISTS. `settings.deploy is None` is the dev and test posture:
    # nothing was ever built, so there is nothing to delete and — importantly — nothing to
    # report as having survived. A skip that claimed a leak would put a note on every delete in
    # every environment that does not publish.
    record: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        record.append(request)
        return httpx.Response(202)

    assert (
        await sweep_app_repositories(
            [uuid.uuid4()], config=None, transport=httpx.MockTransport(handler)
        )
        == []
    )
    assert record == []


async def test_the_sweep_of_nothing_touches_the_registry_not_at_all() -> None:
    record: list[httpx.Request] = []
    assert await sweep_app_repositories([], config=_config(), transport=_registry(record)) == []
    assert record == []


async def test_a_removed_repository_leaves_a_trail() -> None:
    # The counterpart to the alarm: an operator asking "did the image go with the app" has one
    # line per repository actually removed.
    with structlog.testing.capture_logs() as captured:
        await delete_repository("citizen-apps/x", config=_config(), transport=_registry([]))
    assert [e["repository"] for e in captured if e.get("event") == REPOSITORY_DELETED_EVENT] == [
        "citizen-apps/x"
    ]
