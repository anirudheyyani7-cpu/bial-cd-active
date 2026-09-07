"""Moving already-published apps onto the shared apps hostname.

WHY THIS EXISTS. Every published app's address used to be its own container's ACA FQDN,
`https://pub-<28 hex>.<env-domain>/` — an internal DNS name that never resolved from an
employee's desk. Those addresses live in two independently-written places and are already
shared outside the platform, so rewriting the recorded strings directly is tempting but WRONG:
an image built before the base path shipped serves at `/`, so pointing a live link at
`/a/pub-<key>/` turns an honest "this doesn't resolve" into a 404 that reads as "the platform
broke my app". An honest failure beats a confident wrong answer.

So the rule is REPUBLISH BEFORE REWRITE, enforced structurally:
* `deployments.url` needs no backfill — the deploy pipeline's success terminal now writes the
  public address itself, so a republished app self-identifies and the rewrite below waits for
  that signal.
* `app_registry.deployed_url` DOES need one: the manual go-live runbook's field, written only
  by an admin, rewritten only for an app whose platform address has already moved — so it can
  never outrun the image.

WHAT IS LEFT ALONE. A human-typed address pointing elsewhere is not ours to correct. The test
for "ours" is exact and per-row: the recorded host's first label is this app's own container
name, which only the platform mints.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from enum import StrEnum
from urllib.parse import urlsplit

from src.services.deploy.names import published_app_name
from src.services.sandbox.base import base_path_for


class AddressState(StrEnum):
    """What a recorded address is, relative to the move."""

    ALREADY_MOVED = "already_moved"
    """It is on the apps hostname under this app's key. Nothing to do — and re-running the
    backfill must land here, which is what makes the whole pass idempotent."""

    NAMES_ITS_CONTAINER = "names_its_container"
    """The old shape: the host's first label is this app's own container name. Unreachable from
    a BIAL desk, and the thing the move exists to replace."""

    SOMEWHERE_ELSE = "somewhere_else"
    """A human-typed address pointing at something that is not this app's container. Left alone,
    always — see the module docstring."""

    ABSENT = "absent"
    """Nothing recorded. There is nothing to move and nothing to be wrong about."""


def classify(recorded: str | None, *, app_id: uuid.UUID, apps_base_url: str) -> AddressState:
    """What is this recorded address, for this app?

    Deliberately per-row and exact rather than a domain-suffix match. A suffix rule would need
    the Container Apps environment domain as a second configured input, would silently stop
    matching the day BIAL moved environments, and would rewrite any row that happened to sit
    under that domain. Comparing the host's FIRST LABEL against this app's own container name is
    narrower, needs no configuration, and cannot match another app's address by accident.
    """
    if not recorded or not recorded.strip():
        return AddressState.ABSENT

    parsed = urlsplit(recorded.strip())
    host = (parsed.hostname or "").lower()
    if not host:
        return AddressState.SOMEWHERE_ELSE

    name = published_app_name(app_id)
    apps_host = (urlsplit(apps_base_url).hostname or "").lower()

    if host == apps_host:
        # On the right host. It counts as moved only if it is under THIS app's key — an address
        # on the apps host carrying somebody else's key is a real defect, and calling it "already
        # moved" would hide it behind a no-op.
        return (
            AddressState.ALREADY_MOVED
            if parsed.path.startswith(base_path_for(name))
            else AddressState.SOMEWHERE_ELSE
        )
    if host.split(".")[0] == name:
        return AddressState.NAMES_ITS_CONTAINER
    return AddressState.SOMEWHERE_ELSE


@dataclass(frozen=True)
class AppAddresses:
    """The two independently-written addresses for one published app."""

    app_id: uuid.UUID
    platform_url: str | None
    """`deployments.url` — written by the pipeline and by the reconciler, never by a human."""
    recorded_url: str | None
    """`app_registry.deployed_url` — the manual go-live field, written only by an admin."""


@dataclass(frozen=True)
class Action:
    """What the backfill would do to one app, and why."""

    app_id: uuid.UUID
    platform: AddressState
    recorded: AddressState
    recorded_before: str | None
    """The value `app_registry.deployed_url` held before this pass. Carried so the driver can
    write a pre-image BEFORE overwriting: this is the one writer of that column with no person
    in the loop, and an overwrite nobody recorded is an overwrite nobody can undo."""
    rewrite_recorded_to: str | None
    """The new `app_registry.deployed_url`, or None when nothing is written."""
    blocked_reason: str | None
    """Why a rewrite that would otherwise happen is being held back."""


def decide(addresses: AppAddresses, *, apps_base_url: str) -> Action:
    """Whether this app's human-recorded address may move yet, and to what.

    THE GATE IS THE WHOLE DESIGN. A rewrite is permitted only when the platform's own address
    has ALREADY moved, because that is the observable proof the app was republished onto an
    image that serves under its key. Rewriting first would hand a live link a 404.
    """
    platform = classify(
        addresses.platform_url, app_id=addresses.app_id, apps_base_url=apps_base_url
    )
    recorded = classify(
        addresses.recorded_url, app_id=addresses.app_id, apps_base_url=apps_base_url
    )
    name = published_app_name(addresses.app_id)
    # One owner for the `/a/<name>` shape, shared with the sandbox side rather than re-spelled.
    target = f"{apps_base_url}{base_path_for(name)}/"

    if recorded is not AddressState.NAMES_ITS_CONTAINER:
        # Absent, already moved, or somewhere else — all three are "leave it".
        return Action(addresses.app_id, platform, recorded, addresses.recorded_url, None, None)

    if platform is not AddressState.ALREADY_MOVED:
        return Action(
            addresses.app_id,
            platform,
            recorded,
            addresses.recorded_url,
            None,
            "the app has not been republished yet — its platform address still names its "
            "container, so an image serving under the key is not proven to exist. Rewriting "
            "now would turn a link that does not resolve into one that answers 404.",
        )

    return Action(addresses.app_id, platform, recorded, addresses.recorded_url, target, None)
