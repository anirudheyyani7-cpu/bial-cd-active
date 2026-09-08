"""The connector catalogue — the ONE module in this tree that is allowed to say DICE.

WHY THIS EXISTS. Connectors are generic by name and specific only by value (R18): the tables are
`connector_access_requests` and `project_connectors`, the enums are `connector_request_status` and
`connector_window_kind`, the routes are `/v1/connectors` and `/v1/admin/connector-requests`, and
the portal ships `IntegrationsDialog` / `ConnectorRow` / `connectorApi.ts`. DICE appears only as a
value of `connector_key` and as the literals on the one entry below. The checkable form of that
rule is a word-boundary, case-insensitive search for `dice` across `backend/src/` and
`portal/src/`: it must hit this file and nothing else. (Use a word boundary — a bare substring
search also matches `indices` in `portal/src/components/chat/ActivityGroup.tsx`.)

A MODULE CONSTANT, NOT A TABLE (R15, origin Q18). There is exactly one connector. A `connectors`
table would store display strings the boards own, would need seeding in every environment and every
test database, and would eventually want an admin CRUD screen for rows nobody is allowed to add.
The registry is code, reviewed like code, and deployed with the code that renders it.

EXACTLY ONE ENTRY, AND THAT IS THE POINT. The boards draw a second, greyed
`[ANOTHER BIAL SYSTEM]` / `Nothing else is connected to the platform yet` row as a placeholder for
a future integration. The owner ruled on 2026-09-08 that it is not built — so it is not in this
mapping either. A registry entry that nothing may be done with is exactly how the placeholder would
get back onto the screen, because every surface in this feature (the Integrations dialog's list,
the admin queue's filter pills, the rail's DATA rows) is rendered by ITERATING this mapping rather
than by naming a connector in a component. `tests/db/test_connector_models.py` pins the count at
one, and adding a second entry turns it red on purpose.

NO `available` FLAG. An earlier draft carried one so the switch-on and ask routes could refuse a
write against the greyed placeholder — a *known* key that a hand-crafted request could otherwise
name. With the placeholder gone there is no known-but-unusable key: anything outside this mapping
is unknown and 404s, which is the same guard for no field and no branch. Do not add the flag back
for a connector that does not exist yet.

EVERYTHING A CONNECTOR DIFFERS BY LIVES ON ITS ENTRY (owner ruling, 2026-09-08). Not in a
component, not in a module constant beside it. That is what makes "add a second connector" a
registry entry plus its board copy rather than a migration, a route and a component change. In
particular `max_window_days` is DICE's RETENTION, not a platform fact — the client document caps
the DICE build at the last thirty days, and another system will have its own number or none at all.
The window resolver (U2, this same module) reads the cap off the entry it is already handed, so a
second connector needs no change to the resolver.

TWO CONSENT SETS, NOT ONE — READ THIS BEFORE MERGING THEM BACK TOGETHER. The plan's U1 approach
described `consent_lines` as a single tuple "the ask dialog and the decide dialog show". The boards
disagree, and the boards are the specification (R1): `AskAccess` draws `WHAT AN APPROVAL GIVES YOU`
in the second person for the citizen, and `AdminReview` draws `WHAT APPROVING GIVES THEM` in the
third person for the administrator — different voice AND different content. The administrator's
third line is the only one of the six that names the thirty-day cap, and the citizen's first line
reads `Nothing you build can change DICE data`. Collapsing the two sets would therefore drop a
promise from the approver's panel and simultaneously ship second-person copy to the approver. Both
panels are consent copy, which R1's first condition makes binding in substance, so they ship as two
fields. The literals below are byte-exact from
`docs/ux-canvas/dice/boards/{AskAccess,AdminReview}.dc.html.txt`, cross-checked against the PNGs.

U2 ADDS THE WINDOW RESOLVER TO THIS MODULE. Registry and resolver are both pure and share one home
(`src/core/` is where pure cross-cutting modules live — `errors.py`, `words.py`, `redaction.py` —
while `src/services/` is I/O), so a later reader does not open either expecting a session. That
future import (`from src.services.usage import ist_today`) is also why NOTHING under
`src/db/models/` imports this module: `src.services.usage` re-exports from
`src.db.models.token_usage`, so a model reaching back here would close a models → core → services →
models loop. The connector-key column width therefore lives in `src/db/models/connector_access.py`,
and the test ties the two together."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final


@dataclass(frozen=True, slots=True)
class ConsentLine:
    """One ticked line of an informed-consent panel: the bold lead and the body after it.

    A pair, not one pre-joined string, because the boards set the lead in `font-weight:700` and the
    body in the panel's ordinary grey — a joined string would force the renderer to guess the split
    at the first full stop, which the approver's `Read access to the Flight Fact Report.` breaks
    (its body starts lowercase, mid-sentence, on purpose)."""

    lead: str
    body: str


@dataclass(frozen=True, slots=True)
class Connector:
    """One connectable system. Frozen and slotted: the registry is read at import and never
    mutated, and a typo'd attribute assignment should fail loudly rather than land on the entry.

    `display_name` and `subtitle` are the two strings every connector row and every admin filter
    pill renders. `max_window_days` is the connector's own retention cap, read by the U2 resolver.
    The two `consent_lines_*` tuples are the two panels described in the module docblock — see it
    before considering them redundant."""

    display_name: str
    subtitle: str
    max_window_days: int
    consent_lines_requester: tuple[ConsentLine, ...]
    consent_lines_approver: tuple[ConsentLine, ...]


# The `WHAT AN APPROVAL GIVES YOU` panel on `AskAccess`, shown to the citizen who is asking.
# Second person throughout; these are promises the harness track makes true, and R1 makes them
# binding in substance — they may be shortened, they may not start meaning something else.
_DICE_CONSENT_REQUESTER: Final = (
    ConsentLine(
        lead="Read-only.",
        body="Nothing you build can change DICE data.",
    ),
    ConsentLine(
        lead="One dataset.",
        body=(
            "The Flight Fact Report — flight schedules, gates, stands and status. "
            "Nothing else in DICE."
        ),
    ),
    ConsentLine(
        lead="Every project you own.",
        body=(
            "Including ones you have not made yet. You switch it on per project, "
            "and pick the days each one reads."
        ),
    ),
)

# The `WHAT APPROVING GIVES THEM` panel on `AdminReview`, shown to the administrator deciding.
# Third person, and the third line names the thirty days — the one fact the citizen's panel does
# not carry. `test_connector_models.py` asserts that number against `max_window_days`, because two
# emitters of the same fact that can drift apart is a shape this repo has already been bitten by.
_DICE_CONSENT_APPROVER: Final = (
    ConsentLine(
        lead="Read access to the Flight Fact Report.",
        body="and nothing else in DICE.",
    ),
    ConsentLine(
        lead="Every project they own.",
        body="including ones they have not made yet. They switch it on per project.",
    ),
    ConsentLine(
        lead="Up to 30 days of history while they build.",
        body=("each project picks its own range; a published app reads the dates its users pick."),
    ),
)


# THE registry. A `MappingProxyType` rather than a plain dict so a caller cannot install an entry
# at runtime — the surfaces that iterate this are the product's whole connector list, and "the list
# is whatever somebody put in the dict" is not a reviewable claim. The key is the stored
# `connector_key` value: lowercase, stable, and never rendered (the display name is).
CONNECTORS: Final[Mapping[str, Connector]] = MappingProxyType(
    {
        "dice": Connector(
            display_name="DICE",
            subtitle="Airport operations",
            # DICE's retention, not the platform's rule. See the module docblock.
            max_window_days=30,
            consent_lines_requester=_DICE_CONSENT_REQUESTER,
            consent_lines_approver=_DICE_CONSENT_APPROVER,
        ),
    }
)
