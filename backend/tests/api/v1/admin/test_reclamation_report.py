"""POST /v1/admin/apps/reclamation-report — what would the pass delete right now?

THE QUESTION THE TWO-FLAG DESIGN ASSUMED SOMEBODY COULD ASK. `reclaim_enabled` gets you a
report and `reclaim_destroy` lets the pass act, and the whole argument for splitting them is
that there is a state in which an operator reads a candidate list and agrees with it before
arming anything. Until this endpoint that list existed only in the worker's logs, after a pass
had already run — which answers after the decision rather than before it.

The classifier's own behaviour is pinned in `test_reclaim_classifier.py` and the pass
plumbing in `tests/workers/`. This file pins the ROUTE: who may call it, that it
destroys nothing, that it answers with the feature switched off, and what reaches the audit row.
"""

from __future__ import annotations

import datetime as dt
import uuid

import pytest
from pydantic import SecretStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.v1.build_sessions.deps import sandbox_or_none_dependency
from src.config import settings
from src.db.models.audit import AuditLog
from src.db.models.worker_pass import PassOutcome, WorkerPass
from src.services.auth.session_jwt import mint_session_jwt
from src.services.build_sessions.manager import app_name_for
from src.services.sandbox import SandboxError
from src.services.sandbox.base import (
    KIND_BUILD_SANDBOX,
    TAG_APP_ID,
    TAG_CONTROL_PLANE,
    TAG_CREATED_AT,
    TAG_KIND,
    TAG_USER_ID,
    FleetMember,
    control_plane_segment,
)
from src.services.sandbox.config import SandboxConfig
from src.workers.reclamation import RECLAMATION_TASK_NAME, _detail_with_fleet
from tests.factories import UserFactory
from tests.fakes import a_fleet_member

_TTL = settings.auth.access_ttl_seconds
_REPORT = "/v1/admin/apps/reclamation-report"
#: An obviously-fake Azure subscription id. This repo is PUBLIC and has no secret scanning, so
#: the string the leak test hunts for is a placeholder — a real one would be the leak.
_FAKE_SUB = "00000000-0000-0000-0000-000000000000"


def _cookie(jwt: str) -> dict[str, str]:
    return {"Cookie": f"session={jwt}"}


async def _admin(db: AsyncSession) -> dict[str, str]:
    user = await UserFactory.create(db, email="admin@bial.com")
    return _cookie(mint_session_jwt(user.id, user.token_version, _TTL))


async def _citizen(db: AsyncSession) -> dict[str, str]:
    user = await UserFactory.create(db, email="nobody@rvaiglobal.com")
    return _cookie(mint_session_jwt(user.id, user.token_version, _TTL))


def _orphan(name: str, *, age_hours: int = 6) -> FleetMember:
    """A fully-identified, unclaimed, old container — the shape that reaches a destroy tier."""
    return a_fleet_member(
        name,
        tags={
            TAG_KIND: KIND_BUILD_SANDBOX,
            TAG_USER_ID: str(uuid.uuid4()),
            TAG_APP_ID: str(uuid.uuid4()),
            TAG_CONTROL_PLANE: control_plane_segment(),
            TAG_CREATED_AT: (dt.datetime.now(dt.UTC) - dt.timedelta(hours=age_hours)).isoformat(),
        },
    )


class _Fleet:
    """A control plane that enumerates — and RECORDS any delete attempt.

    `deleted` is the assertion surface for the property this whole endpoint rests on. A fake that
    could not observe a delete could not prove one never happened."""

    def __init__(self, members: list[FleetMember], *, error: Exception | None = None) -> None:
        self.members = members
        self.error = error
        self.deleted: list[str] = []

    async def list_sandbox_fleet(self) -> list[FleetMember]:
        if self.error is not None:
            raise self.error
        return list(self.members)

    async def delete_app(self, *, name: str) -> None:  # pragma: no cover - must never run
        self.deleted.append(name)

    async def stamp_tags(self, *, name: str, tags: dict[str, str]) -> None:  # pragma: no cover
        raise AssertionError("a report must not write tags either — staging is the worker's")


class _CannotEnumerate:
    """A deployment whose sandbox client has no fleet capability at all."""


def _wire(app, sandbox: object) -> None:  # noqa: ANN001
    app.dependency_overrides[sandbox_or_none_dependency] = lambda: sandbox


@pytest.fixture(autouse=True)
def _no_app_table(monkeypatch: pytest.MonkeyPatch) -> None:
    """The product database answers "no app matches", not "could not ask".

    Pinned per-test because the difference decides the tier — `None` escalates the whole fleet —
    and a test that let it default would be exercising the database fixture, not the route."""
    from src.services.build_sessions import reclamation_pass as pass_mod

    async def _known() -> frozenset[str]:
        return frozenset()

    monkeypatch.setattr(pass_mod, "_known_app_names", _known)


# --- the gate ---------------------------------------------------------------------


async def test_citizen_is_forbidden(client, app, db_session, fake_redis) -> None:  # noqa: ANN001
    _wire(app, _Fleet([]))
    assert (await client.post(_REPORT, headers=await _citizen(db_session))).status_code == 403


async def test_unauthenticated_is_401(client, app, db_session, fake_redis) -> None:  # noqa: ANN001
    _wire(app, _Fleet([]))
    assert (await client.post(_REPORT)).status_code == 401


# --- it reports, and it cannot act ------------------------------------------------


async def test_the_candidates_come_back_with_the_evidence(  # noqa: ANN001
    client, app, db_session, fake_redis
) -> None:
    """THE TIER AND THE REASON, not just a verdict. This list is read by somebody deciding
    whether to arm a destroy flag, and a decision they can only accept is not one they made."""
    admin = await _admin(db_session)
    doomed = app_name_for(uuid.uuid7())
    _wire(app, _Fleet([_orphan(doomed)]))

    body = (await client.post(_REPORT, headers=admin)).json()

    assert body["scanned"] == 1
    assert body["storeFault"] is False
    (candidate,) = body["candidates"]
    assert candidate["name"] == doomed
    assert candidate["tier"] and candidate["reason"]
    assert candidate["verdict"] in {"stage", "destroy", "escalate"}


async def test_a_report_deletes_nothing_and_stamps_nothing(  # noqa: ANN001
    client, app, db_session, fake_redis
) -> None:
    """THE ASSERTION THIS ENDPOINT EXISTS UNDER. It calls the PURE half of the pass — the staging
    stamp and the destroy arm live in the worker task and are not reachable from here — so this
    is a property of the seam rather than a flag the route remembers to check. Both fakes raise
    or record if either is ever attempted."""
    admin = await _admin(db_session)
    fleet = _Fleet([_orphan(app_name_for(uuid.uuid7())) for _ in range(3)])
    _wire(app, fleet)

    assert (await client.post(_REPORT, headers=admin)).status_code == 200

    assert fleet.deleted == []


async def test_it_answers_with_the_feature_switched_off(  # noqa: ANN001
    client, app, db_session, fake_redis
) -> None:
    """REFUSING HERE WOULD WITHHOLD THE REPORT EXACTLY WHEN IT IS WANTED — the deployment
    deciding whether to enable reclamation is the one where both flags are still off. The flags
    come back in the body instead, because they change what the same list MEANS: a preview on a
    report-only deployment, a description of what is about to happen on an armed one."""
    admin = await _admin(db_session)
    _wire(app, _Fleet([_orphan(app_name_for(uuid.uuid7()))]))

    body = (await client.post(_REPORT, headers=admin)).json()

    assert body["reclaimEnabled"] is False
    assert body["reclaimDestroy"] is False
    assert body["candidates"], "the preview is the whole point; an off flag must not empty it"


async def test_a_truncated_fleet_is_a_503_not_a_clean_report(  # noqa: ANN001
    client, app, db_session, fake_redis
) -> None:
    """A half-enumerated fleet reported as a whole one is the worst possible output: "nothing to
    collect" is indistinguishable from success, and it is what gets a ghost forgotten."""
    admin = await _admin(db_session)
    _wire(app, _Fleet([], error=SandboxError("ARM threw")))

    assert (await client.post(_REPORT, headers=admin)).status_code == 503


async def test_a_substrate_that_cannot_enumerate_is_503(  # noqa: ANN001
    client, app, db_session, fake_redis
) -> None:
    admin = await _admin(db_session)
    _wire(app, _CannotEnumerate())

    assert (await client.post(_REPORT, headers=admin)).status_code == 503


# --- the audit row ----------------------------------------------------------------


async def test_the_audit_row_carries_counts_and_never_a_container_name(  # noqa: ANN001
    client, app, db_session, fake_redis
) -> None:
    """A SANDBOX NAME EMBEDS 28 HEX CHARACTERS OF ITS APP'S UUID, so a name list in the audit log
    is a durable inventory of who was running what. The names travel in the response, where the
    operator needs them to act; the audit row gets numbers. The same split every sibling report
    here makes for blob keys and database names."""
    admin = await _admin(db_session)
    doomed = app_name_for(uuid.uuid7())
    _wire(app, _Fleet([_orphan(doomed)]))

    await client.post(_REPORT, headers=admin)

    rows = (
        (
            await db_session.execute(
                select(AuditLog).where(AuditLog.action == "sandbox:reclamation_report")
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    detail = rows[0].detail or {}
    assert detail["scanned"] == 1
    assert doomed not in str(detail)


# --- what the WORKER did, not what this process's flags say (#190) -----------------


def _a_fleet_configuration(*, subscription_id: str) -> SandboxConfig:
    """A structurally valid `SANDBOX__*` block pointing at an obviously-fake fleet.

    Every value is a placeholder — this file is in a PUBLIC repo, and the whole point of the
    subscription-id assertion below is defeated if the id it hunts for is a real one."""
    return SandboxConfig(
        subscription_id=subscription_id,
        resource_group="rg-not-ours",
        region="REPLACE_ME",
        managed_environment_name="env-not-ours",
        image_ref="REPLACE_ME",
        acr_server="REPLACE_ME",
        acr_username="REPLACE_ME",
        acr_password=SecretStr("REPLACE_ME"),
    )


async def _a_recorded_pass(db: AsyncSession, *, outcome: PassOutcome, detail: str | None) -> None:
    """One `worker_passes` row of the shape the worker's `_record_pass` writes."""
    db.add(
        WorkerPass(
            task_name=RECLAMATION_TASK_NAME,
            outcome=outcome,
            finished_at=dt.datetime.now(dt.UTC),
            counts={},
            detail=detail,
        )
    )
    await db.flush()


async def test_a_declined_pass_is_surfaced_so_scanned_zero_cannot_read_as_clean(  # noqa: ANN001
    client, app, db_session, fake_redis, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`#190` IN ONE TEST. The reported shape was `scanned: 0` beside `reclaimEnabled: true`,
    `reclamationStale: false` — every field green — while the worker logged
    `sandbox_reclamation_pass_disabled reason=flag_off` and enumerated nothing. The row already
    knew: `_record_pass` writes `declined`/`flag_off` on purpose. The report was the only thing
    that did not.

    `reclaimEnabled` STAYS TRUE HERE (R6). Its meaning is unchanged — it is this process's flag,
    and that is exactly the point: the green field and the honest one now sit side by side, and
    the honest one is the one that describes the process doing the work."""
    monkeypatch.setattr(settings, "sandbox", _a_fleet_configuration(subscription_id=_FAKE_SUB))
    admin = await _admin(db_session)
    _wire(app, _Fleet([]))
    await _a_recorded_pass(
        db_session, outcome=PassOutcome.DECLINED, detail=_detail_with_fleet("flag_off")
    )

    body = (await client.post(_REPORT, headers=admin)).json()

    assert body["scanned"] == 0
    assert body["reclamationStale"] is False
    assert body["lastPassOutcome"] == "declined"
    assert "flag_off" in body["lastPassDetail"]


async def test_a_successful_pass_names_the_fleet_it_enumerated(  # noqa: ANN001
    client, app, db_session, fake_redis, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A COUNT IS A FACT ABOUT A SUBSCRIPTION, and `#190`'s second finding was a worker pointed
    at a third one — it would have reported `scanned: 0` about a fleet that is not ours, and the
    report could not have told anybody. The resource group and the managed environment are what
    make that divergence readable."""
    monkeypatch.setattr(settings, "sandbox", _a_fleet_configuration(subscription_id=_FAKE_SUB))
    admin = await _admin(db_session)
    _wire(app, _Fleet([]))
    await _a_recorded_pass(db_session, outcome=PassOutcome.OK, detail=_detail_with_fleet(None))

    body = (await client.post(_REPORT, headers=admin)).json()

    # `ok`, not `ran` — `PassOutcome` is a native PG enum with three members and this is the one
    # that means the pass did its work. Asserted as the stored value so a rename cannot pass.
    assert body["lastPassOutcome"] == "ok"
    assert "rg-not-ours" in body["lastPassDetail"]
    assert "env-not-ours" in body["lastPassDetail"]


async def test_the_subscription_id_reaches_no_response_body(  # noqa: ANN001
    client, app, db_session, fake_redis, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE ONE THING THE FLEET NOTE MUST NOT CARRY (`.claude/rules/security.md`). A resource group
    and a managed environment name distinguish one deployment's fleet from another's, which is
    what an operator needs; a subscription id is an Azure account identifier, and it belongs in
    the server-side log line beside the row, never in a response this endpoint hands back.

    ASSERTED OVER THE WHOLE SERIALISED BODY, not over the two new fields — a leak added anywhere
    in this response (a future `fleet` object, a debug echo of the flags) is the same leak.

    MUTATION-CHECK: add `subscription_id` to `_enumerated_fleet`'s f-string, or hang the id off
    `ReclamationReportResponse`, and this goes red while every other test here stays green."""
    monkeypatch.setattr(settings, "sandbox", _a_fleet_configuration(subscription_id=_FAKE_SUB))
    admin = await _admin(db_session)
    _wire(app, _Fleet([_orphan(app_name_for(uuid.uuid7()))]))
    await _a_recorded_pass(db_session, outcome=PassOutcome.OK, detail=_detail_with_fleet(None))

    response = await client.post(_REPORT, headers=admin)

    assert response.status_code == 200
    assert _FAKE_SUB not in response.text
    # The fleet note IS there, so this is not passing because the note went missing.
    assert "rg-not-ours" in response.text


async def test_no_pass_ever_recorded_leaves_both_fields_null(  # noqa: ANN001
    client, app, db_session, fake_redis
) -> None:
    """NEVER-RAN IS NOT A PASS THAT SAID NOTHING. A fresh deployment has no row to quote, and
    inventing an outcome for it would be the same false green in a new spelling. `reclamationStale`
    keeps its existing meaning — true, because nothing is watching the fleet."""
    admin = await _admin(db_session)
    _wire(app, _Fleet([]))

    body = (await client.post(_REPORT, headers=admin)).json()

    assert body["lastPassOutcome"] is None
    assert body["lastPassDetail"] is None
    assert body["lastReclamationPassAt"] is None
    assert body["reclamationStale"] is True


async def test_the_worker_writes_the_fleet_onto_the_row_the_report_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE SEAM BETWEEN THE TWO HALVES OF THIS FIX, and the only test that spans it.

    Every route test above builds its row's `detail` by calling `_detail_with_fleet` itself, so
    they prove the ENDPOINT surfaces a fleet note faithfully and say nothing about whether the
    worker ever writes one. Drop the call from `_record_pass` and all of them stay green while
    production goes back to `flag_off` with no fleet attached — which is `#190` again.

    A CAPTURING FACTORY RATHER THAN THE DATABASE: `_record_pass` opens its OWN session on purpose
    (it must land even when the pass it describes has just failed), so letting it run for real
    here would commit a row outside this test's rolled-back transaction and into every later test.
    It also swallows every exception, so the unpack below is what makes a broken fake fail loudly
    instead of passing with nothing written."""
    import src.db.base as db_base
    from src.workers.reclamation import _record_pass

    monkeypatch.setattr(settings, "sandbox", _a_fleet_configuration(subscription_id=_FAKE_SUB))
    written: list[WorkerPass] = []

    class _CapturingSession:
        async def __aenter__(self) -> _CapturingSession:
            return self

        async def __aexit__(self, *_exc: object) -> None:
            return None

        def add(self, instance: object) -> None:
            assert isinstance(instance, WorkerPass)
            written.append(instance)

        async def commit(self) -> None:
            return None

    monkeypatch.setattr(db_base, "async_session_factory", _CapturingSession)

    await _record_pass(outcome="declined", counts={}, detail="flag_off")

    (row,) = written
    assert row.detail is not None
    assert "flag_off" in row.detail
    assert "rg-not-ours/env-not-ours" in row.detail
    # The other half of the contract, asserted where the string is BORN rather than only where it
    # is served: the id must not be in the column at all, not merely filtered on the way out.
    assert _FAKE_SUB not in row.detail
