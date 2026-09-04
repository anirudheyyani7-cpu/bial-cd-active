"""Approvals — the submit-into-queue service, and the ONE route into the admin
submit/approve queue.

Module map (consumers import the module they need,
`from src.services.approvals import submit`):

* `submit` — the app-scoped build-session guard, the fail-closed bundle read, the
  blob-first-row-second copy, and the guarded UPDATE that moves the app to pending
  carrying its lineage and declaration.

The invariant is checkable by grep and is meant to stay that way: no code path outside
this package writes `AppStatus.PENDING`. There is deliberately no citizen-callable
submit route — a queue item that arrived by one would carry no declaration for an
administrator to read — so the only callers are the publish gate, which supplies the
merged declaration, and any future admin-initiated entry.
"""
