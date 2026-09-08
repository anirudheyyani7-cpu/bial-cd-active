"""The one lazy accessor for this process's environment segment.

WHY THIS EXISTS — THE IMPORT CYCLE THIS AVOIDS. Two places need this value and neither may
import `src.config` at module scope: `src.config` → `src.settings.api` → both
`src.services.redis.config` and the sandbox config, so a module-level import from either closes
the cycle and makes `src.config` unimportable. Both had solved it separately, with the same
explanation written out twice (`redis/keys.py::_environment`,
`sandbox/base.py::control_plane_segment`) — two copies of a subtle constraint is two places to
get it wrong.

NO module-scope imports, and both `src/__init__.py` and `src/core/__init__.py` are empty, so
importing this executes only this file — the property that keeps it out of the cycle.

RESOLVED PER CALL, NEVER MEMOIZED: the segment is a property of the running settings, not import
order, and the test suite rebinds settings between cases.

THE TWO CALLERS MEAN DIFFERENT THINGS BY IT — the Redis key prefix scopes coordination state; the
`bial-control-plane` tag decides which control plane may judge a container. Same value today, but
neither is redefined in terms of the other.
"""

from __future__ import annotations


def environment_segment() -> str:
    """This process's `ENVIRONMENT`, resolved right now."""
    from src.config import settings

    return str(settings.ENVIRONMENT)
