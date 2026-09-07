"""The Redis error TAXONOMY, and the single place it becomes an HTTP status.

WHY THIS EXISTS: two Redis failure modes look alike and are not, and collapsing them is an
anti-pattern this repo already shipped and was burned by — a uniform "unavailable ⇒ 503"
503'd every build start on deployments that had deliberately switched Redis off, with the
whole suite green because the fixture always bound one.

* `RedisNotConfiguredError` is a CERTAIN answer: Redis is genuinely optional outside
  production, and with none there is no build-session subsystem at all, so the caller
  PROCEEDS.
* `RedisError` is AMBIGUITY: the store exists and failed to answer, so a check over it
  decided nothing → 503 (fail-first).

Anything else propagates untouched — a taxonomy, never a catch-all.

Lives in `services/redis/`, not `services/build_sessions/`, because that package has a real
import cycle (`build_sessions/__init__ → locks → ... → back into the half-initialized
package`); this module is cycle-free and importable from any call site.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Final

import structlog
from fastapi import status
from redis.exceptions import RedisError

from src.core.errors import AppApiError
from src.services.redis.client import RedisNotConfiguredError

_log = structlog.get_logger()

# USER-FACING COPY, not a log line. The portal surfaces this 503 message VERBATIM — an
# `ApiError`'s `message` becomes the citizen-facing reason, asserted in the portal's
# `StartAppControl.test.tsx` ("carries the server's named reason verbatim") — so this
# string is read by citizen developers: professional, actionable, and leaking no internal
# detail. It is hoisted to a constant so the router and this helper can never drift
# apart into two subtly different apologies.
BUILD_COORDINATION_UNAVAILABLE_MSG: Final = (
    "Build coordination is temporarily unavailable. Please try again."
)


@contextmanager
def build_coordination_or_503() -> Iterator[None]:
    """Run a build-coordination check under the two-tier taxonomy above.

    Wrap `get_redis()` and the commands that follow it inside the block — both tiers are
    read at one seam. An unconfigured Redis SKIPS THE REST OF THE BLOCK and resumes after
    it, as if the check passed (nothing to hold a lock); put nothing in the block that must
    run regardless. Deliberately a plain `contextmanager`: `with` composes fine with an
    `await`-bearing body, and a sync generator is the smaller surface."""
    try:
        yield
    except RedisNotConfiguredError:
        # Not an error state: the DEFINED meaning of "no Redis" is "no build sessions".
        _log.debug("redis is not configured; skipping the build-coordination check")
        return
    except RedisError as exc:
        raise AppApiError(
            status.HTTP_503_SERVICE_UNAVAILABLE, BUILD_COORDINATION_UNAVAILABLE_MSG
        ) from exc


def coordination_is_gone() -> AppApiError:
    """The 503 to raise on the line AFTER a `build_coordination_or_503()` block, for routes
    where Redis IS the operation, not a check on it.

    Pairs with the skip-the-body flow above: `RedisNotConfiguredError` resumes past the
    block, so reaching this line means the body never ran. A route only ASKING Redis a
    question should treat that as a pass; one that cannot work without Redis has nothing
    to return, and falling off the end yields an implicit `None` — a 500 from response
    validation, as `admin.reconcile_sandboxes` once shipped without this raise."""
    return AppApiError(status.HTTP_503_SERVICE_UNAVAILABLE, BUILD_COORDINATION_UNAVAILABLE_MSG)
