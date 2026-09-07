"""The per-run dependency bundles the sandbox tools and the build harness receive.

Two dataclasses split along the seam between what each consumer needs: `SandboxSession` is
EVERYTHING the eight sandbox tools touch and nothing else — held by `BuildDeps.sandbox` (the
legacy `/build-sessions` harness) and by a Write chat turn's own deps, so one tool body serves
both (`tools.sandbox_toolset`). `BuildDeps` is the harness-only surround: owner `user_id`, the
single `ProgressEmitter` (tools and harness share ONE seq source), and the claim-once
preview-frame guard.

There are deliberately NO caches: an uncached `view` is always correct; a cache without
invalidation risks stale content mid-self-heal.
"""

from __future__ import annotations

import uuid
from collections import OrderedDict
from dataclasses import dataclass, field

from src.services.orchestrator.constants import (
    OUTPUT_SLICE_HANDLES_PER_TURN,
    REPEATED_COMMAND_MEMORY,
)
from src.services.orchestrator.progress import ProgressEmitter
from src.services.sandbox import SandboxClient, SandboxHandle


@dataclass(frozen=True)
class HeldOutput:
    """One command's output, held so `fetch_output_slice` can read the middle the cap removed.

    `lines` IS ALREADY REDACTED — THE WHOLE SECURITY PROPERTY OF THIS CLASS: it is
    `scrub_untrusted`'s output (capped, de-escaped, masked) split on newlines, nothing else may
    ever go in it. Raw stdout would be a direct path to an unmasked secret, and a secret sitting
    entirely in an elided middle is the ordinary case here, not a boundary one. Frozen: a held
    capture is a historical fact about an already-exited command.
    """

    #: The command this output came from, redacted and capped — model-facing header text only.
    command: str
    #: The redacted output, one entry per line. Never raw stdout/stderr.
    lines: tuple[str, ...]


@dataclass
class SandboxSession:
    """Everything the eight sandbox tools touch, and nothing else. Mutable so `declare_done` can
    flip the done-signal; the harness resets it at the start of each run.

    SECRET-SAFETY RULE. `handle.token` is the LIVE supervisor bearer. Never `log()`,
    `repr()`, or return `SandboxSession` or `SandboxHandle` wholesale, and never render
    `handle.token` into an error message or a model-visible tool result. Exception logging binds
    only `session_id` / `user_id` / `app_id` — never `handle` / `handle.token`.
    """

    sandbox_client: SandboxClient
    handle: SandboxHandle
    # From the run-context, so `BuildResult.app_id` is populated and the BRAIN trace binds.
    app_id: uuid.UUID
    # ── Mutable per-run signals the tools set and the loop reads ──────────────────────────────
    done_requested: bool = False
    done_summary: str = ""
    # Did this turn MUTATE the tree? Set by `write_file` / `edit_file` / `insert_lines` and by
    # `declare_done`, never reset mid-turn — "did anything change in this whole turn" is the
    # question. A Write turn that only read files is an ordinary chat turn and must not pay for a
    # verify pass or a self-heal nudge.
    workspace_touched: bool = False
    # ── The per-turn output buffer and the repeat-run memory ──────────────────────────────────
    # NEITHER IS PERSISTED. Both die with the session the harness rebuilds at the start of each
    # run, which is exactly the stated lifetime of a slice handle: a handle from a previous run
    # resolves to nothing and the model is told to re-run the command. Nothing here reaches the
    # database or blob storage.
    #
    # An OrderedDict, not a dict, because the eviction order IS the policy: `hold_output` drops
    # the OLDEST handle when the ring is full, so the notice the model just read always still
    # resolves.
    held_outputs: OrderedDict[str, HeldOutput] = field(default_factory=OrderedDict)
    # Redacted command strings already run this turn — the repeat-run adoption counter's memory.
    # Redacted, not raw, for the same reason `HeldOutput.lines` is: an argv token can carry
    # a credential, and this lives on the session for the whole turn.
    commands_seen: set[str] = field(default_factory=set)
    # The legacy build feed. `None` on a chat turn, where the turn ENGINE emits the step frames
    # from the run's own tool events — see `tools._step` for why emitting both would double-render.
    emitter: ProgressEmitter | None = None

    def hold_output(self, handle: str, held: HeldOutput) -> None:
        """Retain one truncated output under `handle`, evicting the oldest beyond the ring's cap.

        BOUNDED IN BOTH DIMENSIONS: each entry is capped upstream by `REDACT_INPUT_MAX_CHARS` and
        the ring holds `OUTPUT_SLICE_HANDLES_PER_TURN` of them, so a chatty turn cannot grow this
        without limit. Evicting the oldest (rather than refusing the newest) is deliberate — the
        handle the model was just handed is the one it is about to use."""
        self.held_outputs[handle] = held
        while len(self.held_outputs) > OUTPUT_SLICE_HANDLES_PER_TURN:
            self.held_outputs.popitem(last=False)

    def note_command(self, redacted_command: str) -> bool:
        """Record that this command ran; True if an IDENTICAL one already ran this turn.

        Capped at `REPEATED_COMMAND_MEMORY` distinct commands — past that it stops recording,
        so a pathological turn cannot grow the set unbounded; a repeat may then go uncounted,
        understating the metric but never affecting model behavior. Entries are whole argv
        strings, not hashed or shortened — a shortened key could collide two different commands
        into a false repeat, and an invented event is worse than a missed one.
        """
        repeated = redacted_command in self.commands_seen
        if not repeated and len(self.commands_seen) < REPEATED_COMMAND_MEMORY:
            self.commands_seen.add(redacted_command)
        return repeated


@dataclass
class BuildDeps:
    """The legacy build harness's per-run agent dependencies: the sandbox session the tools resolve
    through, plus the harness-only surround (owner scope, the emitter, the preview-frame
    guard)."""

    sandbox: SandboxSession
    emitter: ProgressEmitter
    user_id: uuid.UUID
    # The SHARED "preview is framed" guard, hoisted out of the `_run_loop` local it used to
    # be so ALL THREE initial-frame emit sites consult ONE flag: (a) the warm-resume immediate
    # emit, (b) the decoupled early readiness watcher, (c) the between-steps verify. Seeded from
    # `handle.ready` in `__post_init__` so a warm/resumed sandbox that emits `preview_ready`
    # immediately never double-fires with the watcher's first poll. The watcher exclusively owns
    # the later crash→reconnect→reframe cycle (verify never re-claims), so this is claim-once.
    preview_framed: bool = False

    def __post_init__(self) -> None:
        # A warm/resumed sandbox is already serving — treat the frame as claimed at construction so
        # the warm-resume emit (gated on `handle.ready`) fires once and the watcher/verify see it
        # taken. A cold sandbox starts unframed; the watcher or verify claims it on first serve.
        if self.sandbox.handle.ready:
            self.preview_framed = True

    def claim_preview_frame(self) -> bool:
        """Synchronously claim the one-time preview-framed transition — True for EXACTLY ONE caller
        across the initial-frame emit sites. The test-and-set has NO `await` between the "is it
        set?" check and the "set it" write, so the early watcher and the between-steps loop can
        never both see it unset and both emit `preview_ready` with two different seqs (a
        double-frame). This is what makes a second concurrent emitter safe."""
        if self.preview_framed:
            return False
        self.preview_framed = True
        return True
