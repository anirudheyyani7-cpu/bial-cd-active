"""The shared signed double-submit CSRF gate for mutating data-plane POSTs.

Lives here — beside `deps_rbac.py` — rather than inside one domain: it started as the control
surface's own dependency, and `api/v1/conversations` is the second consumer.

Deliberately NOT universal: a route opts IN via `RequireCsrf`. The legacy chat relay once
justified an exception (no CSRF token, a frozen contract) — now retired, so that exception is
gone; opt-in survives on its own merits, keeping the gate a visible line per route rather than a
blanket a new GET-shaped endpoint silently inherits. It is NOT licence for a mutating route
that declares nothing: if every one is meant to carry it, make that a positive decision and
AUDIT THE LIST. Fails closed with the data-plane `{"error":{"message","code"}}` envelope.
"""

from __future__ import annotations

from fastapi import Depends, Request

from src.api.deps import CurrentUser
from src.core.errors import AppApiError
from src.services.auth.cookies import csrf_cookie_name
from src.services.auth.csrf import verify_csrf


async def require_csrf(user: CurrentUser, request: Request) -> None:
    """Signed double-submit CSRF check on a mutating POST. Fails closed with
    the data-plane `{"error":{"message","code"}}` envelope."""
    if not verify_csrf(
        request.cookies.get(csrf_cookie_name(), ""),
        request.headers.get("x-csrf-token", ""),
        user.id,
        user.token_version,
    ):
        raise AppApiError(403, "CSRF check failed.", code="csrf_failed")


RequireCsrf = Depends(require_csrf)
