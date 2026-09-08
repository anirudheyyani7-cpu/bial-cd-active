"""Pinned structlog event names that NO SINGLE PACKAGE OWNS.

`build_sessions/alarms.py` gathers the build harness's own alarms and explains the doctrine:
there is no metrics system in this deployment, so an alarm is a GREPPABLE EVENT CONSTANT an
external log rule keys on; each name exists exactly ONCE in the codebase, is imported rather
than retyped (including by tests), and distinguishing reasons live in structured FIELDS rather
than in a second event name.

THIS MODULE EXISTS FOR THE ALARMS THAT SPAN PACKAGES. `src/core/` is a leaf — nothing in here
imports `src.*` — which is the property that matters: the delete path runs through
`api/v1/projects/`, `services/storage/`, `services/deploy/` and `services/appdb/`, and
`services/storage/` is imported while `src.config` is still initialising. A constant those arms
share therefore cannot live under a package with a heavy `__init__`, or importing it is a
startup circular-import error in production's import order (and only in production's, which is
the worst way to find out).
"""

from typing import Final

TEARDOWN_ARTEFACT_SURVIVED_EVENT: Final = "delete_left_an_artefact_behind"
"""A delete finished and something it was supposed to destroy is still out there.

NOBODY COLLECTS THIS AUTOMATICALLY, which is the whole reason it is an alarm rather than a
debug line. Every teardown arm on the delete path is best-effort by necessity — the rows are
already committed, so a raise there would 500 a delete that in fact succeeded — and until this
unit each arm's comment said the leftover would be picked up by "the scheduled sweep". It will
not be. The only reconciler on a timer is the sandbox reap, which runs solely when
`environment == "production"` (`build_sessions/destroy.py::may_destroy_on_this_control_plane`);
the storage reconciler and the per-project-database reconciler are operator-invoked, the latter
deletes nothing at all (`storage/reconcile.py`, `appdb/reconcile.py`), and the reclamation
janitor's destroy flag is off in every environment (`workers/reclamation.py`). So a surviving
blob, container, image, database or sandbox is collected by a human reading this event, or by
nobody, ever.

ONE EVENT FOR EVERY ARM, on purpose: the operational question is "what did a delete leave
behind", and the artefact class is a FIELD, not a second event name — otherwise the alert has
to be written five times and a sixth arm added later is invisible.

Fields: `artefact` (one of `blob`, `app_container`, `app_database`, `registry_repository`,
`published_app`, `sandbox_container`, `submission_bundle`), `artefact_id` (the key, name or id
an operator needs to find it), and `reason` (why the arm gave up). The project delete path ALSO
writes one `project:teardown-incomplete` audit row naming the same artefacts, so the leak is
countable and attributable, not only greppable — the log line is the notice, the row is the
record.

WHAT TO DO: the artefact named in the event still exists and still costs something (a running
container bills; a database keeps a copy of the citizen's data alive after they asked for it to
be destroyed). Delete it by hand, then fix the cause the `reason` field names — most often a
credential without the delete permission, which is a configuration change rather than a code
one."""
