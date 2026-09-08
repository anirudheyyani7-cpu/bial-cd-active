"""The citizen-facing connector wire shapes.

`ConnectorEntry` IS THE `ConnectorStates` BOARD'S "THE PERSON" HALF, one object per registry
entry: the connector's name and subtitle, which of the four person states the caller is in, and
the facts that state needs rendered beside it. Fields outside the caller's own state are `null` —
`approvedByName` on a declined row would be a second answer to "who decided", and the board draws
one.

WHY THE APPROVED AND DECLINED TIMESTAMPS ARE TWO FIELDS OVER ONE COLUMN. `decided_at` carries
both, but the board's two sentences are `Approved for you 2 Sep · Rahul Menon` and
`Declined 2 Sep · Rahul Menon`, and a client that had to read `decidedAt` and then consult
`state` to learn which sentence it belongs to is one `if` away from writing "Approved" over a
decline. The state selects the field; the field names the sentence.

EVERY NAME FIELD IS `str | None`, AND NOT BECAUSE THE NAME MIGHT BE BLANK. The server already
falls back to the decider's email when `users.display_name` is null (see
`services/connectors/access.PersonAccess`), so a present decider always has a non-empty handle.
`None` means there is no decider to name at all: nobody has decided, or the administrator who did
has since been deleted (`decided_by_id` is `ON DELETE SET NULL`, so the decision outlives them).
"""

from __future__ import annotations

from datetime import datetime

from pydantic import field_validator

from src.schemas import CamelModel, clean_stated_reason
from src.services.connectors import ConnectorPersonState


def _clean_request_remarks(value: str) -> str:
    """The connector access request's binding of the shared 5-50 word stated-reason rule.

    THE SAME RULE THE DELETE REASON USES, by owner decision D1 — not a note type of its own.
    Both surfaces count words with `portal/src/utils/words.ts`, so a browser counter can never
    let through something this API refuses, and `Give a little more detail — at least 5 words.`
    is something a person can act on where a character floor is not.

    The empty-field sentence is the `AskAccess` board's own helper text, which is what makes it
    read as an instruction rather than as a complaint about a form."""
    return clean_stated_reason(value, say_why="Say what you need the data for.")


class AccessRequestBody(CamelModel):
    """The body `POST /v1/connectors/{connector_key}/request` requires.

    THE REMARK IS THE WHOLE OF WHAT THE ADMINISTRATOR DECIDES ON — the decide dialog leads with
    it — which is why it is required here and NOT NULL on the row. WHO is asking is stamped from
    the authenticated session and never carried in the body; an extra key is ignored, as Pydantic
    ignores any unknown key."""

    remarks: str

    _v_remarks = field_validator("remarks")(_clean_request_remarks)


class ConnectorEntry(CamelModel):
    """One registry connector as the asking person sees it. See the module docblock."""

    #: The stored `connector_key`. Stable, lowercase, and never rendered — the display name is.
    key: str
    display_name: str
    subtitle: str
    state: ConnectorPersonState
    #: `pending` only: when they asked. The board reads `Asked 5 Sep, 08:30 · waiting on an
    #: administrator`, so the time of day is part of the sentence and this is not a date.
    asked_at: datetime | None = None
    #: `approved` only.
    approved_at: datetime | None = None
    approved_by_name: str | None = None
    #: `approved` only: how many of the caller's own projects have this connector switched on,
    #: for `On in 2 projects ›`. `None` — not `0` — in every other state: "we did not count"
    #: and "none" are different answers, and only one of them belongs on a row with no access.
    on_project_count: int | None = None
    #: `declined` only. The administrator's words reach the citizen VERBATIM and are rendered as
    #: plain text on every surface, never through a markdown component: one user writes this and
    #: another reads it.
    decided_at: datetime | None = None
    decided_by_name: str | None = None
    decision_remarks: str | None = None


class ConnectorListResponse(CamelModel):
    """Every registry connector, in registry order.

    AN ENVELOPE RATHER THAN A BARE ARRAY, matching `MarketplaceListResponse`: a top-level JSON
    array cannot grow a field, and this list is the one the Integrations dialog renders whole."""

    connectors: list[ConnectorEntry]
