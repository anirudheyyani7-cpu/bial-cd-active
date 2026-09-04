"""The twenty-four-hour drain — the hole the confidence tiers cannot see (U16, R21).

WHAT THE TIERS STRUCTURALLY MISS. Every rule in `reclaim.py` asks "is anything claiming this
container?", so one held open by a JAMMED signal — a stay nobody can name, a lease whose writer
will not stop — is claimed *by definition* and no amount of tier logic reaches it. The drain is
the only rule that does not ask, and the only one that acts on a container a builder still
considers theirs — which is why it ships behind its own flag, off everywhere (ADR-0014).

A TURN IN FLIGHT IS NEVER INTERRUPTED. Past the mark, a build still holds the container; what
stops counting is everything else — interaction, served traffic, the ordinary end-of-turn stay.
The drain lands at the builder's next pause, and they are TOLD before it does.
"""

from __future__ import annotations

import datetime as dt

from src.services.sandbox.base import SandboxIdentity


def draining_at(
    identity: SandboxIdentity, *, enabled: bool, after_hours: int
) -> dt.datetime | None:
    """When this container will be drained, or `None` if it will not be.

    `None` when the flag is off, when the container carries no trustworthy age, or when the mark
    is still far enough away to be noise. A caller renders this to the builder, so it answers
    "when", never "whether" — a boolean would leave the UI inventing the sentence.

    NO AGE MEANS NO DRAIN: an untagged container must not be drained on a guess about how old it
    is. A backfilled age (`inventory.py`) is synthetic and can only push this mark later."""
    if not enabled or identity.created_at is None:
        return None
    return identity.created_at + dt.timedelta(hours=after_hours)


def is_drained(
    identity: SandboxIdentity,
    *,
    now: dt.datetime,
    enabled: bool,
    after_hours: int,
    turn_in_flight: bool,
) -> bool:
    """Is this container past its drain mark AND free to go?

    `turn_in_flight` is the one thing that outranks the drain, and it outranks it absolutely — a
    24-hour-old container with an agent making tool calls inside it is doing exactly what the
    platform exists to do. AE14's whole shape is: do not interrupt, tell the builder, reclaim at
    the pause."""
    if turn_in_flight:
        return False
    mark = draining_at(identity, enabled=enabled, after_hours=after_hours)
    return mark is not None and now >= mark
