"""The single `seq` source + the only path to `on_progress`.

One `ProgressEmitter` per run owns one counter behind one `_emit` coroutine: every envelope's
`seq` is assigned there and nowhere else, so the stream is strictly `+1` and gap-free. Typed
helpers construct the five progress members BRAIN may emit plus `preview_reconnecting`; nothing
calls `on_progress` directly. Deliberately NO `ended` helper: the terminal frame is the build-
session manager's, continuing this run's `seq` at `last_seq + 1`, so nothing here can race it.

CONCURRENT EMITTERS ARE SEQ-SAFE: the readiness watcher emits while the build loop runs, but
`_emit` assigns `seq` with no `await` before the sink, so interleaving only happens after each
`seq` is fixed; the watcher is torn down before the terminal funnel reads `last_seq`."""

from __future__ import annotations

import itertools
from collections.abc import Callable
from typing import Literal

import structlog

from src.api.v1.build_sessions.schemas import (
    BuildError,
    ErrorEvent,
    EscalationEvent,
    PreviewReadyEvent,
    PreviewReconnectingEvent,
    ProgressEnvelope,
    ProgressSink,
    QuotaExceededEvent,
    StepEvent,
)

logger = structlog.get_logger()


class ProgressEmitter:
    """The single seq source + emit path for one `run_build`."""

    def __init__(self, sink: ProgressSink) -> None:
        self._sink = sink
        self._counter = itertools.count(1)
        self.last_seq = 0

    async def _emit(self, make_event: Callable[[int], ProgressEnvelope]) -> int:
        """Assign the next `seq`, build the envelope, and push it to the sink. The ONLY place a
        `seq` is assigned and the ONLY caller of the sink."""
        seq = next(self._counter)
        self.last_seq = seq
        event = make_event(seq)
        try:
            await self._sink(event)
        except Exception:
            # The sink is contractually non-throwing; if it ever raises, a lost frame must not
            # break the build loop. Swallow-and-log — the counter has already advanced.
            logger.warning("progress_sink_raised", seq=seq, event_type=event.type)
        return seq

    async def step(
        self,
        *,
        name: str,
        label: str,
        state: Literal["started", "ok", "failed"],
        hidden: bool = False,
    ) -> int:
        # `hidden` drops read-only + housekeeping steps from the visible feed; it defaults False
        # so a caller that says nothing keeps emitting a visible step.
        return await self._emit(
            lambda seq: StepEvent(seq=seq, name=name, label=label, state=state, hidden=hidden)
        )

    async def error(self, error: BuildError) -> int:
        # `error` is already de-noised + redacted by `errors.declutter` (the single redaction
        # site for the structured-error egress path).
        return await self._emit(
            lambda seq: ErrorEvent(
                seq=seq,
                source=error.source,
                title=error.title,
                cleaned_stack=error.cleaned_stack,
            )
        )

    async def preview_ready(self, *, preview_url: str) -> int:
        return await self._emit(lambda seq: PreviewReadyEvent(seq=seq, preview_url=preview_url))

    async def preview_reconnecting(self) -> int:
        # The dev-server process crashed after the preview was framed. A feed-only signal
        # (no payload): the portal shows a distinct "reconnecting" visual until a `preview_ready`
        # re-frames. Emitted only by the early readiness watcher, which owns crash detection.
        return await self._emit(lambda seq: PreviewReconnectingEvent(seq=seq))

    async def escalation(
        self, *, reason: str, detail: str, last_error: BuildError | None = None
    ) -> int:
        return await self._emit(
            lambda seq: EscalationEvent(
                seq=seq, reason=reason, detail=detail, last_error=last_error
            )
        )

    async def quota_exceeded(self, *, limit: int, used: int, resets_at: str) -> int:
        return await self._emit(
            lambda seq: QuotaExceededEvent(seq=seq, limit=limit, used=used, resets_at=resets_at)
        )

    # No `ended` helper by design: the terminal frame is the build-session manager's.
