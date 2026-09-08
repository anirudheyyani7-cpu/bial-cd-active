"""Pinned structlog event names for the build-harness alarms.

There is no metrics system in this deployment, so an alarm is a GREPPABLE EVENT CONSTANT an
external log rule keys on, plus a relational record where the outcome must be counted rather
than merely noticed. This module gathers the harness's own so they stop being scattered.

THE ONE RULE: each name appears exactly ONCE in the codebase. An alert cannot be written against
a string that exists in two spellings, and the second spelling is invisible until the day it is
the only one firing. Import the constant, never retype the literal — tests included. Reasons that
distinguish one firing from another belong in structured fields, not in the event name.

THE DELETE PATH'S ALARM IS NOT HERE, and the omission is deliberate. The artefact-survived alarm
every teardown arm raises spans `api/v1/projects/`, `services/storage/`, `services/deploy/` and
`services/appdb/`, and `services/storage/` is imported while `src.config` is still initialising —
so importing anything under this package from there is a startup circular-import error. It lives
in `src/core/alarms.py`, a leaf that imports no `src.*` at all; the doctrine above governs it
identically.
"""

from typing import Final

HMR_PROTOCOL_DRIFT_EVENT: Final = "compile_signal_protocol_drift"
"""The compile signal's canary fired: the supervisor connected to the dev server's HMR socket
SUCCESSFULLY and then received nothing it recognised.

This is the one event that separates "the protocol moved upstream" from "the socket is down".
Defensive parsing — ignore unknown frame verbs, never assume a field is present — is what keeps
a bundler upgrade from crashing the consumer, and is EXACTLY what would make a rename silent:
the consumer would receive frames forever and understand none of them, while the platform
reported a healthy app. The dev server sends its current state within milliseconds of a
connect, so silence after a successful connect has no innocent explanation.

Fields: `app_name`, `connect_generation`, `reason`. Raised at most once per successful connect
(the generation is what makes that possible) rather than once per poll.

WHAT TO DO: the frame verbs this consumer understands are `building` / `built` / `sync`, read
from `action` or `type`, in `sandbox/supervisor/app.py::_derive_compile`. Capture a few frames
from a live container's `/_next/webpack-hmr` and add the new verb there. Until that ships the
platform reports `UNKNOWN`, the preview cover holds rather than clearing, and no user sees a
framework error screen — degraded, not broken."""


RECOVERY_WRITE_DID_NOT_LAND_EVENT: Final = "recovery_write_did_not_land"
"""A turn ended and its work did not reach the recovery slot.

Fires on all THREE ways a turn's work fails to reach the slot, distinguished by `reason` rather
than by three event names — one operational question, one event, filterable by field:

* `refused` — the guard would not promote this tree (an unreadable lineage, a head_sha that is
  not a sha). The existing copy is untouched.
* `diverted` — same refusal, and the bundle was preserved under `divert_key` instead, so the tree
  is recoverable by the operator promote procedure rather than thrown away.
* `failed` — the bundle or the upload itself did not complete. This is the swallowed case, and it
  is raised from the CALL SITE, which is the only place that knows the write raised. THE SWALLOW
  STAYS — a safety net that can fail a turn is not a safety net — so this event is the whole of
  the trace such a failure leaves, and without it nobody can tell a platform that failed to CHECK
  the workspace from one that failed to make it DURABLE.

Fields: `app_id`, `reason`, and — where the guard formed an opinion — `recorded_head` and
`bundled_head`, which together say WHY a tree was refused.

WHAT TO DO: read the app's `divert/{app_id}/` prefix. A `diverted` event means a real tree is
sitting there; `services/build_sessions/snapshot.py::write_recovery_copy` documents the guard that
put it there, and the operator promote endpoint is how it gets moved back."""


WORKSPACE_LOST_WHILE_IDLE_EVENT: Final = "workspace_lost_while_idle"
"""A reversion was caught at the preview poll rather than at a turn.

THE TURN MAY NEVER COME. A container can revert while the citizen is reading, in another tab, or
at lunch, and the workspace is otherwise only ever asked about at the start of a turn — so
without this poll a standing "Build complete" claim sits above a dead app for as long as the tab
stays open.

Distinct from the turn-time reversion, deliberately. The turn-time one is handled — quarantined,
restored, told — inside a flow the citizen is already watching. This one fires with nobody
watching, so it is the operator's only notice that it happened at all, and it is the record that
says how often it happens.

Fields: `app_id` and `app_name` (which container), `last_known_head` (the app's last good
state), `recovery_copy_available` (was there anything to put back), and `verdict` (which of the
four states was reached).

THE CONTAINER'S AGE IS DELIBERATELY NOT HERE: reading it costs an ARM listing, which a poll a
browser tab drives every 45 seconds will not pay. An operator who needs it has the age in the
reclamation pass records, keyed by the same `app_name`.

WHAT TO DO: the citizen has already been told on the preview pane and the standing completion
claim has been retracted, so this is not an emergency page. It is the number to watch. If it
fires more than rarely, the containers are being reclaimed or reset out from under live sessions
and the reclamation policy is what wants looking at, not this code."""
