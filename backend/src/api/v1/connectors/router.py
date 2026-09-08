"""The citizen's own connector access: what the registry offers, where they stand, ask, cancel.

THE OWNERSHIP CHECK A REVIEWER SHOULD BE ABLE TO MAKE BY READING TOP TO BOTTOM. There are three
routes and no cross-user read among them. Every statement that touches
`connector_access_requests` carries `user_id == user.id` in its WHERE clause, and the one
statement that touches `project_connectors` reaches it through a join on `projects`, whose
`user_id` predicate is in the same clause (that table deliberately carries no `user_id` of its
own — `projects` is its ownership anchor). The only rows-free read is the registry itself, which
is a module constant, identical for everybody, and holds no user data.

NEITHER WRITE IS AUDITED, and that is a decision rather than an omission (R11/origin R9). The
citizen is acting on their OWN row: an audit entry would carry the same actor and the same
timestamp `connector_access_requests` already holds, so it would be a second copy of the row it
describes. Approve and decline — one person acting on another — DO write one, in U5.

Errors use the data-plane `{"error": {"message", "code"}}` envelope (`AppApiError`), not the auth
endpoints' `{"detail": ...}`; the SPA already branches on `error.code`.
"""

from __future__ import annotations

import uuid

import sqlalchemy as sa
from fastapi import APIRouter, status
from sqlalchemy.dialects.postgresql import insert as pg_insert

from src.api.deps import CurrentUser, DbSession
from src.api.deps_csrf import RequireCsrf
from src.api.v1.connectors.schemas import (
    AccessRequestBody,
    ConnectorEntry,
    ConnectorListResponse,
)
from src.core.connectors import CONNECTORS, Connector
from src.core.errors import AppApiError
from src.db.models.connector_access import ConnectorAccessRequest, ConnectorRequestStatus
from src.db.models.project import Project
from src.db.models.project_connector import ProjectConnector
from src.schemas import AUTH_401, ErrorEnvelope, error_responses
from src.services.connectors import ConnectorPersonState, current_access

router = APIRouter(prefix="/connectors", tags=["connectors"])

_NO_SUCH_CONNECTOR = "That connector is not available."
_ALREADY_ASKED = "You have already asked for access to this. An administrator is looking at it."
_ALREADY_DECIDED = "An administrator has already answered this request."
_NOTHING_TO_CANCEL = "There is no waiting request to cancel."

# A state that must have a row behind it arrived without one. Unreachable while `current_access`
# is the only producer of a `PersonAccess`; raised rather than papered over because the
# alternative is an entry that claims `approved` and renders a blank date and a blank name.
_STATE_WITHOUT_ITS_ROW = "a decided connector state arrived with no request row behind it"


def _known_connector(connector_key: str) -> Connector:
    """The registry is the catalogue (R15) — there is no `connectors` table, so an unknown key is
    caught HERE and never by the database. Membership first, then subscript: a `.get()` returning
    `None` would put the absent case and the present case on the same line."""
    if connector_key not in CONNECTORS:
        raise AppApiError(status.HTTP_404_NOT_FOUND, _NO_SUCH_CONNECTOR, code="unknown_connector")
    return CONNECTORS[connector_key]


async def _on_project_count(db: DbSession, user_id: uuid.UUID, connector_key: str) -> int:
    """How many of this person's projects have the connector switched on — `On in 2 projects ›`.

    Scoped through `projects`, which is `project_connectors`' ownership anchor: the `user_id`
    predicate is on the join target, and dropping it would count every citizen's projects.

    COUNTING `enabled` IS COUNTING EFFECTIVE STATE HERE, and only here. Effective on is
    `enabled AND the owner is approved` (R12/R13, `core.connectors.resolve_window`), and this
    number is rendered on the APPROVED row only — the second conjunct is already true for every
    row it counts. It is not a licence to read `enabled` and call it "on" anywhere else."""
    counted = await db.scalar(
        sa.select(sa.func.count())
        .select_from(ProjectConnector)
        .join(Project, Project.id == ProjectConnector.project_id)
        .where(
            Project.user_id == user_id,
            ProjectConnector.connector_key == connector_key,
            ProjectConnector.enabled.is_(True),
        )
    )
    return int(counted or 0)


async def _entry(
    db: DbSession, user_id: uuid.UUID, connector_key: str, connector: Connector
) -> ConnectorEntry:
    """One connector as this person sees it — the ONE place an entry is assembled.

    Both writes report their result through this rather than asserting the state they intended:
    the answer is a derivation over the person's remaining rows (`current_access`), and a route
    hard-coding `pending` after an insert or `neverAsked` after a cancel would be a second copy
    of that rule, correct only for as long as nobody adds a fifth status."""
    access = await current_access(db, user_id=user_id, connector_key=connector_key)
    state = access.state
    if state is ConnectorPersonState.NEVER_ASKED:
        return ConnectorEntry(
            key=connector_key,
            display_name=connector.display_name,
            subtitle=connector.subtitle,
            state=state,
        )

    row = access.request
    if row is None:
        raise ValueError(_STATE_WITHOUT_ITS_ROW)

    asked_at = row.created_at if state is ConnectorPersonState.PENDING else None
    approved = state is ConnectorPersonState.APPROVED
    declined = state is ConnectorPersonState.DECLINED
    return ConnectorEntry(
        key=connector_key,
        display_name=connector.display_name,
        subtitle=connector.subtitle,
        state=state,
        asked_at=asked_at,
        approved_at=row.decided_at if approved else None,
        approved_by_name=access.decided_by_name if approved else None,
        on_project_count=(
            await _on_project_count(db, user_id, connector_key) if approved else None
        ),
        decided_at=row.decided_at if declined else None,
        decided_by_name=access.decided_by_name if declined else None,
        decision_remarks=row.decision_remarks if declined else None,
    )


@router.get("", responses=error_responses(AUTH_401))
async def list_connectors(user: CurrentUser, db: DbSession) -> ConnectorListResponse:
    """Every system this platform can connect to, and where you stand with each one.

    One entry per catalogue connector, always — a connector you have never asked about is
    present with the state `neverAsked`, because this list is the whole of what Integrations
    offers, not a list of your grants. Each entry carries only the fields its own state needs:
    `askedAt` while you wait, `approvedAt` / `approvedByName` / `onProjectCount` once an
    administrator has said yes, and `decidedAt` / `decidedByName` / `decisionRemarks` if they
    said no. Access is granted to a PERSON, so one answer covers every project you own,
    including the ones you have not made yet."""
    return ConnectorListResponse(
        connectors=[
            await _entry(db, user.id, key, connector) for key, connector in CONNECTORS.items()
        ]
    )


@router.post(
    "/{connector_key}/request",
    status_code=status.HTTP_201_CREATED,
    dependencies=[RequireCsrf],
    responses=error_responses(
        AUTH_401,
        (403, ErrorEnvelope, "CSRF check failed"),
        (404, ErrorEnvelope, "No such connector"),
        (409, ErrorEnvelope, "Already waiting on an administrator, or already answered"),
    ),
)
async def request_access(
    connector_key: str, body: AccessRequestBody, user: CurrentUser, db: DbSession
) -> ConnectorEntry:
    """Ask an administrator for access to a connector, for yourself.

    `remarks` is required and is the whole of what the administrator has to go on: 5 to 50 words,
    the same rule the platform applies to every reason it asks you to state.

    Refused with `409 already_pending` if you are already waiting on an administrator, and with
    `409 already_decided` if one has already answered — a decline is FINAL for now, and an
    approval you already hold is not improved by asking again. Returns the connector in its new
    state."""
    connector = _known_connector(connector_key)

    # THE HONEST-COPY PRE-CHECK; the insert below is the real gate for the pending case.
    # `approved` is refused for a reason beyond tidiness: a second pending row would become the
    # most recent non-cancelled row, so the person's state would fall back to `pending` and the
    # resolver would switch their connector OFF in every project until an administrator acted.
    access = await current_access(db, user_id=user.id, connector_key=connector_key)
    if access.state in (ConnectorPersonState.APPROVED, ConnectorPersonState.DECLINED):
        raise AppApiError(status.HTTP_409_CONFLICT, _ALREADY_DECIDED, code="already_decided")
    if access.state is ConnectorPersonState.PENDING:
        raise AppApiError(status.HTTP_409_CONFLICT, _ALREADY_ASKED, code="already_pending")

    # ON CONFLICT DO NOTHING, INFERRED AGAINST THE PARTIAL PENDING INDEX. A plain
    # check-then-insert loses the race that the portal makes ordinary rather than exotic:
    # `ComposerBox.tsx` records that `aria-disabled` "says so; it does not do so", so `Ask an
    # administrator` stays clickable while the first request is in flight, both clicks clear the
    # pre-check above, and the second violates `uq_connector_access_requests_one_pending` — a 500
    # where this route promises a 409.
    #
    # `index_elements` + `index_where` rather than `constraint=`: a PARTIAL index cannot be named
    # as an `ON CONSTRAINT` target. The predicate stays the LITERAL `status = 'pending'` the
    # model's `postgresql_where` uses — written as a bound parameter it would stop matching the
    # index from the sixth execution on a pooled connection, once Postgres switches to a generic
    # plan.
    inserted = await db.execute(
        pg_insert(ConnectorAccessRequest)
        .values(
            user_id=user.id,
            connector_key=connector_key,
            status=ConnectorRequestStatus.PENDING,
            requester_remarks=body.remarks,
        )
        .on_conflict_do_nothing(
            index_elements=["user_id", "connector_key"],
            index_where=sa.text("status = 'pending'"),
        )
        .returning(ConnectorAccessRequest.id)
    )
    if inserted.first() is None:
        # The citizen's other click landed between the pre-check and here — same person, two
        # requests in flight. Same refusal and same code as the pre-check: they asked twice and
        # are waiting once, which is the outcome they wanted.
        raise AppApiError(status.HTTP_409_CONFLICT, _ALREADY_ASKED, code="already_pending")

    await db.commit()
    return await _entry(db, user.id, connector_key, connector)


@router.post(
    "/{connector_key}/cancel",
    dependencies=[RequireCsrf],
    responses=error_responses(
        AUTH_401,
        (403, ErrorEnvelope, "CSRF check failed"),
        (404, ErrorEnvelope, "No such connector"),
        (409, ErrorEnvelope, "Nothing is waiting on an administrator"),
    ),
)
async def cancel_access_request(
    connector_key: str, user: CurrentUser, db: DbSession
) -> ConnectorEntry:
    """Withdraw your own waiting request for a connector.

    Only a request that is still waiting can be withdrawn — one an administrator has already
    answered is refused with `409 nothing_pending`, never silently accepted. Cancelling leaves
    the row as history and returns you to `neverAsked`, free to ask again. Returns the connector
    in its new state."""
    connector = _known_connector(connector_key)

    # THE GUARDED UPDATE IS THE WHOLE GATE — no pre-check, no read-then-write. Zero rows means
    # there was nothing pending (or an administrator decided it a moment ago), and that is a
    # refusal rather than a no-op: a `Cancel` that reports success while the request sails on
    # into the queue is the one outcome worse than an error. `user_id` is in the predicate, so a
    # crafted request naming somebody else's connector cancels nothing.
    #
    # ADR-0008: both status values go through the mapped ORM column, which types the binds as the
    # native enum — asyncpg will not cast `varchar` to an enum implicitly.
    cancelled = await db.execute(
        sa.update(ConnectorAccessRequest)
        .where(
            ConnectorAccessRequest.user_id == user.id,
            ConnectorAccessRequest.connector_key == connector_key,
            ConnectorAccessRequest.status == ConnectorRequestStatus.PENDING,
        )
        .values(status=ConnectorRequestStatus.CANCELLED)
        .returning(ConnectorAccessRequest.id)
    )
    if cancelled.first() is None:
        raise AppApiError(status.HTTP_409_CONFLICT, _NOTHING_TO_CANCEL, code="nothing_pending")

    await db.commit()
    return await _entry(db, user.id, connector_key, connector)
