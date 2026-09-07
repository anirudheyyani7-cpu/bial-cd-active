"""DI seams for the C3 control surface.

The sandbox client + session manager are resolved through FastAPI `Depends` (KTD-9) so
`app.dependency_overrides` reach them in tests — the router threads the resolved objects into
the SessionManager rather than letting the manager call the deps inline (a plain in-service call
would bypass the overrides).

THE BRAIN SEAM IS GONE. `run_build_dependency` / `RunBuildDep` built a process-singleton
`BuildOrchestrator` and handed the router its bound `run_build`; its one consumer was
`start_build`, which is deleted — the bare `POST` on the build-sessions collection lost its
browser client in PR #182.
`_build_model` went with it and was never shared: `conversations/_shared.py::chat_model` calls
`agent/model.py::build_foundry_model` directly, so the live chat path never routed through here.

Redis is the ONE exception and there is no `Depends` seam for it: the lock/heartbeat routes call
`get_redis()` LAZILY inside `build_coordination_or_503()`, because `get_redis()` raises on a
Redis-off deployment and an eagerly-solved dependency would raise before that seam — or the
route's own 404 — ever ran, turning the documented 503 into an undocumented 500. The
`redis_dependency` / `RedisDep` pair that used to live here was deleted once its last consumer
moved into the seam; nothing binds Redis through DI, and `fake_redis` binds the accessor
singleton instead. See
`docs/solutions/design-patterns/eager-fastapi-depends-bypasses-in-body-error-seam-2026-07-21.md`.

C3 §3 mandates signed double-submit CSRF on the mutating POSTs (`stop` / `internal/reap` and the
project-scoped ops), a deliberate divergence from the chat-relay precedent that the frozen
contract requires; the `status` GET and the SSE GET are exempt. That gate now lives in
`src/api/deps_csrf.py` — the conversations domain is its second consumer — and is re-exported
here so this module stays the C3 router's single dependency import.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends

from src.api.deps_csrf import RequireCsrf as RequireCsrf
from src.services.build_sessions import SessionManager, get_session_manager
from src.services.sandbox import SandboxClient, SandboxNotConfiguredError, get_sandbox


def sandbox_dependency() -> SandboxClient:
    """RAISES `SandboxNotConfiguredError` on a sandbox-off deployment — and because every
    `Depends` is solved BEFORE the route body's first statement, it raises where no `except` of
    the route's can reach it. Take this only where a missing sandbox genuinely IS a 500 (a deploy
    bug); a route that documents a sandbox-unavailable 503 takes `OptionalSandbox` below."""
    return get_sandbox()


def sandbox_or_none_dependency() -> SandboxClient | None:
    """The configured sandbox client, or **`None` when it is unconfigured** (dev/test) — the
    None-tolerant twin of `sandbox_dependency`, mirroring `OptionalStorage` in `src/api/deps.py`.

    It still resolves eagerly; it just cannot FAIL eagerly. `SandboxNotConfiguredError` subclasses
    `SandboxError`, so `relaunch_preview`'s `except (..., SandboxError) -> 503` *would* have caught
    it — one frame later. Resolved eagerly it escaped to the catch-all instead, and the route that
    advertises "The sandbox or build coordination is temporarily unavailable" answered an
    undocumented 500 with the wrong envelope. Sandbox-off is supported outside production
    (`_require_sandbox_in_production` only gates prod), so the break was live exactly where nobody
    watches. See
    `docs/solutions/design-patterns/eager-fastapi-depends-bypasses-in-body-error-seam-2026-07-21.md`."""
    try:
        return get_sandbox()
    except SandboxNotConfiguredError:
        return None


def session_manager_dependency() -> SessionManager:
    return get_session_manager()


SandboxDep = Annotated[SandboxClient, Depends(sandbox_dependency)]
# `| None`-tolerant, unlike `SandboxDep`: the consuming route maps an unset sandbox onto its
# own documented 503 instead of dying at dependency-solve time.
OptionalSandbox = Annotated[SandboxClient | None, Depends(sandbox_or_none_dependency)]
SessionManagerDep = Annotated[SessionManager, Depends(session_manager_dependency)]
