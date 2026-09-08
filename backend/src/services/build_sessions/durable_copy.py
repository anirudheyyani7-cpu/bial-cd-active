"""The durable-copy precondition — nothing is destroyed until its work is provably safe.

WHY THIS EXISTS
This is the last gate before an ARM delete, and it is the one whose failure a builder experiences
directly: every other guard in this system protects money, this one protects work.
WHAT "CURRENT" MEANS. `HEAD` in the container versus the `head_sha` stamped on the recovery
bundle's blob metadata — **not** `last_modified`. Azure stamps that in whole seconds, so a Save and
an autosave landing inside one second are indistinguishable by time, and "indistinguishable" on
this path means deleting a container whose newest change was never copied.
WHY THE RECOVERY SLOT AND NOT THE SAVED BUNDLE. The recovery key is the platform's own autosave at
turn boundaries, while the saved bundle is the user's explicit click; the relevant guarantee is
"their last completed change" — the former, since a builder who never pressed Save still has work
worth keeping and is the population most likely to be reclaimed.
THE FALLBACK ORDER IS DELIBERATE: recover the token → read `HEAD` → compare. If TOKEN RECOVERY
ITSELF fails, a present and parseable bundle counts as confirmed — otherwise a container that is
already dead can never be collected, which is the entire point of the exercise. If there is no
parseable bundle either, escalate. The real comparison still happens in the normal case.
"STORAGE IS OFF" IS NOT "THERE IS NO WORK TO PRESERVE". An unset store is a fact about the
DEPLOYMENT and an unreadable one a fact about this moment; only "the store answered and holds no
bundle" is a fact about the CONTAINER, so only that case counts as confirmed absent — the other two
spare the container as UNCONFIRMED. Folding "no store" into "no bundle" is right for offering a
restore, but wrong on a destroy path, where a confirmed absent reads as "safe to delete": the most
ordinary misconfiguration would otherwise delete the whole fleet while believing every container
had been verified.
"""

from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass

import structlog

from src.services.storage import get_storage, recovery_key
from src.services.storage.errors import StorageError, StorageUnconfiguredError

_log = structlog.get_logger()


class CopyState(enum.StrEnum):
    """Whether this container's work is provably safe to lose."""

    #: The recovery bundle's `head_sha` matches the container's `HEAD`, or the container could
    #: not be reached but a parseable bundle exists. Destruction may proceed.
    CONFIRMED_CURRENT = "confirmed_current"
    #: A copy exists but is behind the container. Take one first.
    STALE = "stale"
    #: Nothing could be confirmed — no parseable bundle, an unreachable store, or storage not
    #: configured at all. SPARE AND REPORT. Never destroy.
    UNCONFIRMED = "unconfirmed"


@dataclass(frozen=True)
class CopyVerdict:
    state: CopyState
    reason: str

    @property
    def may_destroy(self) -> bool:
        """The single question every caller actually asks.

        A property rather than a comparison at each call site, because `state is CONFIRMED_CURRENT`
        spelled out four times is four chances to write `is not STALE` and quietly authorise the
        two states that mean "we could not tell"."""
        return self.state is CopyState.CONFIRMED_CURRENT


async def confirm_durable_copy(
    app_id: uuid.UUID, *, container_head: str | None, container_dirty: bool | None
) -> CopyVerdict:
    """Is this container's work provably preserved?

    `container_head` is `None` when it could not be read — ordinary for an orphan with no
    registry record. `container_dirty` is KEYWORD-REQUIRED, NO DEFAULT: a caller that does not
    know must pass `None` and be refused, never stay silent and be believed. A HEAD match alone
    is not "preserved" — a turn commits only at `snapshot.py`, so the tree must be judged too.
    FAILS TOWARD SPARING, ALWAYS: every branch that cannot establish a fact returns
    `UNCONFIRMED`, which never authorises a delete — a timeout is not a death certificate."""
    try:
        store = get_storage()
    except StorageUnconfiguredError:
        # THE MISCONFIGURATION THAT WOULD DELETE THE FLEET. Read as "confirmed no bundle" — which
        # is how the build path is entitled to read it — this becomes "nothing to preserve, safe
        # to delete" for every container at once. It is a fact about the deployment, not about
        # anybody's work, and a worker on such a deployment should never have started.
        _log.error(
            "durable-copy gate asked on a storage-off deployment; refusing to authorise anything",
            app_id=str(app_id),
        )
        return CopyVerdict(CopyState.UNCONFIRMED, "the object store is not configured")

    try:
        meta = await store.head(recovery_key(app_id))
    except StorageError:
        _log.warning("recovery slot unreadable; sparing", app_id=str(app_id), exc_info=True)
        return CopyVerdict(CopyState.UNCONFIRMED, "the object store could not be read")

    if meta is None:
        return CopyVerdict(CopyState.UNCONFIRMED, "no recovery copy exists for this app")

    stamped = (meta.metadata or {}).get("head_sha")
    if not stamped:
        # A bundle whose head is unknown cannot be compared against anything. Older bundles
        # predate the metadata stamp, and this is exactly the kind of unreadable signal that
        # spares the container rather than confirming it.
        return CopyVerdict(CopyState.UNCONFIRMED, "the recovery copy carries no head_sha")

    if container_head is None:
        # TOKEN RECOVERY OR THE CONTAINER READ FAILED. A present, parseable bundle counts as
        # confirmed here — deliberately. Requiring the live comparison in this branch would make
        # the gate unsatisfiable: a container that is already dead can never answer,
        # so the gate would have spared every genuinely-dead container forever and collected
        # nothing at all.
        return CopyVerdict(
            CopyState.CONFIRMED_CURRENT,
            "the container could not be read; a parseable recovery copy stands in",
        )

    if stamped != container_head:
        return CopyVerdict(CopyState.STALE, "the recovery copy is behind HEAD")

    # HEAD MATCHES — now ask the question a HEAD comparison cannot answer (see the docstring).
    if container_dirty is None:
        # We reached the container and read its HEAD, but not its tree. That is an unestablished
        # fact on a path that authorises destruction, so it spares rather than confirms.
        return CopyVerdict(
            CopyState.UNCONFIRMED,
            "the recovery copy matches HEAD, but the working tree could not be read",
        )
    if container_dirty:
        # The copy is not behind HEAD — it is behind the WORKING TREE. STALE rather than
        # UNCONFIRMED because this is a known state with a known remedy: copy first, then reclaim.
        return CopyVerdict(
            CopyState.STALE,
            "the recovery copy matches HEAD but the working tree has uncommitted work",
        )
    return CopyVerdict(
        CopyState.CONFIRMED_CURRENT, "the recovery copy matches HEAD on a clean tree"
    )
