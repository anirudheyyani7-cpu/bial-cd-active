"""The Redis key namespace for the sandbox lifecycle.

These key strings are a **byte-stable cross-track contract**. Every key is built here, through the
single `ns()` choke point, so no module ever hand-writes one — drift in a prefix is a cross-track
break (a lock written under one format is invisible to a reaper reading another). The builders take
`uuid.UUID` and enforce it at RUNTIME, not just in the annotation: a canonical UUID cannot contain
a `:`, so the `user_id` axis can never forge a different family, and the type IS the boundary.

Five sandbox families share the environment-scoped root `bial:{environment}:sandbox:`; the segment
after it is the family discriminator:

    bial:{env}:sandbox:lock:{user_id}        string  — one-per-user lock (SET NX EX)
    bial:{env}:sandbox:heartbeat:{user_id}   string  — idle timer (presence = active)
    bial:{env}:sandbox:registry:{user_id}    hash    — {app_name, fqdn, token_ref, created_at,
                                                        state, preview_stay_until?}
    bial:{env}:sandbox:lease:{user_id}       string  — liveness lease (wall-clock deadline,
                                                        epoch seconds, TTL mandatory)
    bial:{env}:sandbox:starting:{user_id}    string  — start-in-flight marker (the project id
                                                        being started, TTL mandatory)

The sixth family is the taskiq queue, built in `src/broker.py`: `bial:{env}:taskiq:stream` plus
the library-derived `autoclaim:<group>:<stream>`, whose literal prefix cannot be moved under
`bial:` and therefore sits outside the environment-scoping guarantee by construction.

Single-replica deployment ⇒ there is intentionally **NO** `:channel` family: build progress is an
in-process asyncio channel, not Redis pub/sub.

Every key carries the environment because production shares one Redis instance with other BIAL
applications, and a scheduled job reads this namespace as a spare-list and deletes Azure
containers on the strength of it: a process pointed at the wrong instance must not be able to
act on another deployment's fleet. The registry hash is the ONE family with no TTL, and it is
the sole input to both the fleet sweep and the report-only Azure inventory — so a key that
moves or is forgotten does not degrade, it permanently strands every container live at that
instant, invisible to both. Two rules follow, and the builders below enforce them. A fleet scan
issues the current and the legacy pattern as two literals, never one `bial:*:` glob, which
would reach into other environments. And a scan only makes a legacy key REACHABLE, so the point
read behind it is dual-read as well (`locks.read_registry`). The legacy prefix is read-only,
and it goes once the inventory reports zero records under it.
"""

from __future__ import annotations

import uuid
from typing import Final

# The reserved product root, shared with the taskiq families in `src/broker.py`.
KEY_ROOT: Final = "bial:"

# The sandbox domain segment, below the environment.
KEY_DOMAIN: Final = "sandbox:"

# The legacy root, from before the environment segment was added to sandbox keys, frozen as
# HISTORY rather than taste: it is what the live fleet was registered under, so a typo here
# silently un-reaches every container the dual-read exists to keep visible.
# READ-ONLY — nothing writes it, and it goes once the fleet inventory reports zero
# legacy-prefix records.
LEGACY_KEY_PREFIX: Final = "bial:sandbox:"

# The family discriminators. Named rather than inlined so `ns()` callers and the scan
# patterns cannot disagree about a spelling.
FAMILY_LOCK: Final = "lock"
FAMILY_HEARTBEAT: Final = "heartbeat"
FAMILY_REGISTRY: Final = "registry"
FAMILY_LEASE: Final = "lease"
FAMILY_STARTING: Final = "starting"


def _environment() -> str:
    """This process's environment segment — the scope every sandbox key sits under.

    Delegated to `src.core.runtime_env`, which is a leaf with no module-scope imports: `src.config`
    reaches `src.settings.api`, which imports `src.services.redis.config` — which imports
    THIS package — so asking `src.config` directly at module level would close the cycle and make
    `src.config` unimportable.

    Kept as its own named function rather than calling the accessor at each site: what this scopes
    is coordination state, which is a different question from which control plane may judge a
    container, and the two are free to diverge."""
    from src.core.runtime_env import environment_segment

    return environment_segment()


def key_prefix() -> str:
    """`bial:{environment}:sandbox:` — the environment-scoped root every sandbox family
    sits under."""
    return f"{KEY_ROOT}{_environment()}:{KEY_DOMAIN}"


def ns(family: str, user_id: uuid.UUID) -> str:
    """THE choke point. Every sandbox key in the platform is this string.

    The `uuid.UUID` check is a runtime guard, not a redundant assertion of the annotation. User ids
    arrive from JSON, from Redis key names and from ARM tags — all places the type checker cannot
    reach — and a `str` is the one input that could smuggle a `:` in and cross a segment boundary,
    forging a different family or a different environment. Fail loudly instead.
    """
    if not isinstance(user_id, uuid.UUID):
        raise TypeError(
            f"a sandbox key is built from a uuid.UUID, never a {type(user_id).__name__}: "
            "a string user id could carry a ':' and forge a different key family"
        )
    return f"{key_prefix()}{family}:{user_id}"


def lock_key(user_id: uuid.UUID) -> str:
    """`bial:{env}:sandbox:lock:{user_id}` — the one-per-user lock. Held via `SET … NX EX`;
    `NX` is the enforcement point for the client ABC's one-sandbox-per-user rule. Released
    LAST (compare-and-delete) in the snapshot / teardown / reaper ordering."""
    return ns(FAMILY_LOCK, user_id)


def heartbeat_key(user_id: uuid.UUID) -> str:
    """`bial:{env}:sandbox:heartbeat:{user_id}` — the idle timer. Rewritten with a fresh
    expiry on each activity; **expiry = idle** (eligible for reaper teardown, which snapshots
    first)."""
    return ns(FAMILY_HEARTBEAT, user_id)


def registry_key(user_id: uuid.UUID) -> str:
    """`bial:{env}:sandbox:registry:{user_id}` — the sandbox record hash. Read on
    `attach_existing` to reconnect. Fields are the `REGISTRY_FIELD_*` constants below;
    `state` is the reaper's durable mark-ending marker.

    THE ONLY WRITE TARGET for the registry. The legacy key below is read-only."""
    return ns(FAMILY_REGISTRY, user_id)


def lease_key(user_id: uuid.UUID) -> str:
    """`bial:{env}:sandbox:lease:{user_id}` — the wall-clock liveness lease (family 4).

    The value is a deadline in Unix epoch seconds (`time.time()`, never `time.monotonic()` — a
    monotonic reading means nothing outside the process that took it, and cross-process
    readability is the whole point). Renewed by the turn engine for the duration of a turn, read
    by the reconciliation sweep, and it **must** carry a TTL: a lease that never expires is a
    container that can never be reclaimed. `build_sessions/locks.py` owns the three primitives."""
    return ns(FAMILY_LEASE, user_id)


def starting_key(user_id: uuid.UUID) -> str:
    """`bial:{env}:sandbox:starting:{user_id}` — the start-in-flight marker (family 5).

    The value is the `project_id` (str(uuid.UUID)) being started, and it **must** carry a TTL
    bounded by the cold-start budget plus margin: the marker is one of the disjuncts that spare
    a container from reclamation, so one that never expires spares its container forever.
    Written once, by `_holding_user_lock` — the one skeleton behind the build start, the
    relaunch and the turn's `ensure_sandbox` — and cleared on the same scope exit that releases
    or adopts the lock, and in the compensation arm.

    DELIBERATELY NOT A REGISTRY FIELD. A registry entry written before a container exists reads to
    the sweep, the reconciler and the ARM reconciliation as a live container that is not there, and
    a registered container is spared rather than collected. `build_sessions/locks.py` owns the
    write/read/clear primitives."""
    return ns(FAMILY_STARTING, user_id)


def legacy_registry_key(user_id: uuid.UUID) -> str:
    """`bial:sandbox:registry:{user_id}` — the legacy registry key. **READ-ONLY.**

    Every write goes to `registry_key`. This exists so the dual-read window can still reach a
    fleet registered before the environment segment did, and so `delete_registry` can clear the
    key a migration may have left behind. It goes once the fleet inventory reports zero
    legacy-prefix records."""
    if not isinstance(user_id, uuid.UUID):
        raise TypeError(
            f"a sandbox key is built from a uuid.UUID, never a {type(user_id).__name__}"
        )
    return f"{LEGACY_KEY_PREFIX}{FAMILY_REGISTRY}:{user_id}"


def registry_scan_patterns() -> tuple[str, ...]:
    """Every registry pattern a FLEET SCAN must cover, current first.

    Two literals, never one widened `bial:*:sandbox:registry:*` glob, and never enough on its
    own — the module docstring above says why on both counts.
    """
    return (f"{key_prefix()}{FAMILY_REGISTRY}:*", f"{LEGACY_KEY_PREFIX}{FAMILY_REGISTRY}:*")


# --- Registry hash fields (frozen — SESSION-API writes/reads these, never a
# hand-typed field string) --------------------------------------------------

REGISTRY_FIELD_APP_NAME: Final = "app_name"
REGISTRY_FIELD_FQDN: Final = "fqdn"
# A REFERENCE to the supervisor bearer token — NEVER the raw token: the raw token
# lives only in the sandbox container's own env and in-process in SandboxHandle.token.
REGISTRY_FIELD_TOKEN_REF: Final = "token_ref"
REGISTRY_FIELD_CREATED_AT: Final = "created_at"
REGISTRY_FIELD_STATE: Final = "state"
# A relaunched preview's STAY OF EXECUTION: the ISO-8601 UTC instant its bounded
# lease lapses. A relaunched preview holds no lock and renews no heartbeat, so
# absent this field the background sweep would reap a preview the user is still
# looking at. Honored by `sweep_all` ONLY — reconcile-on-start reaps regardless,
# because the incoming build needs the one-per-user slot.
REGISTRY_FIELD_PREVIEW_STAY_UNTIL: Final = "preview_stay_until"
# WHICH NAMED WRITER last moved the stay above. Provenance, not control flow:
# nothing branches on it, and it exists so an operator staring at a container that refuses
# to lapse can answer "what is holding this open?" without guessing. A deadline with no
# attributable author is the state this field exists to remove.
REGISTRY_FIELD_STAY_WRITER: Final = "stay_writer"

# THIS PROCESS ADOPTED THIS RECORD FROM THE LEGACY PREFIX during the dual-read window that lets a
# process still reach fleets registered under the un-scoped legacy prefix. Written only by
# `_adopt_a_pre_cutover_record`, read only by `delete_registry`, and it goes with the rest of
# the legacy arm once the fleet inventory reports zero legacy-prefix records.
#
# It exists because the legacy prefix is the one namespace with NO environment segment, so
# `bial:sandbox:registry:{user}` means different containers in different deployments that share a
# Redis instance. `delete_registry` deleted it unconditionally: a process reaping its own session
# also deleted whatever another environment had under that key — leaving the owning environment a
# running container with no record, which is exactly the class of orphan the scheduled fleet sweep
# exists to collect, manufactured by the environment-scoping migration's own cleanup. The adoption
# path already refuses to delete on read for this reason; this marker extends the same rule to the
# one place that still deletes.
#
# Durable rather than in-process, because the delete happens in a later session — often a later
# process — than the adoption.
REGISTRY_FIELD_ADOPTED_FROM_LEGACY: Final = "adopted_from_legacy"

# The complete frozen field set (a completeness/disjointness anchor for tests and
# for SESSION-API's hydration of the registry hash).
REGISTRY_FIELDS: Final = frozenset(
    {
        REGISTRY_FIELD_APP_NAME,
        REGISTRY_FIELD_FQDN,
        REGISTRY_FIELD_TOKEN_REF,
        REGISTRY_FIELD_CREATED_AT,
        REGISTRY_FIELD_STATE,
        REGISTRY_FIELD_PREVIEW_STAY_UNTIL,
        REGISTRY_FIELD_STAY_WRITER,
        REGISTRY_FIELD_ADOPTED_FROM_LEGACY,
    }
)

# The two lifecycle values the reaper writes to REGISTRY_FIELD_STATE: `ready`
# is the normal live state; `ending` is the durable mark-ending marker set FIRST in
# the reaper ordering (mark-ending → teardown → release lock) so a concurrent
# attach sees a dying container and does not reconnect.
REGISTRY_STATE_READY: Final = "ready"
REGISTRY_STATE_ENDING: Final = "ending"
