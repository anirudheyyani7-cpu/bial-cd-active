"""Conversations wire-shape schemas — the SPA's Mongo-style `_id` + camelCase envelopes.

Every Express-era conversations route returns a pre-built `JSONResponse` (to emit the exact
wire shape and `{"error":{"message"}}` envelope), so those RESPONSE models are
DOCUMENTED-ONLY: FastAPI advertises them in OpenAPI but never validates or reshapes the
response — characterization tests are the byte-identical guard. `_id` needs an explicit
alias because Pydantic treats a leading-underscore field name as private.

Net-new routes (the turn surfaces, the Build-it handoff) parse their bodies through models
normally instead. The legacy message-append/read schemas died with their endpoints; the
projection read shape now goes through the single history→display derivation."""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Final, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Discriminator,
    Field,
    Tag,
    TypeAdapter,
    model_validator,
)

from src.api.v1.build_sessions.schemas import ErrorSource
from src.db.models.conversation import ChatKind
from src.schemas import CamelModel
from src.services.messages.projection import DisplayItem, PlanOptionsItem, StepItem
from src.services.orchestrator.errors import user_facing
from src.services.sandbox.base import CompileState


class HeaderOut(CamelModel):
    """One conversation header. `title`/`context` are omitted when unset — the route's
    `_header_dict` builds them in only when present. This model is documented-only (the route
    returns a pre-built `JSONResponse`), so no exclude-unset serialization flag is involved;
    the `= None` defaults are what document those fields as non-required."""

    id: str = Field(alias="_id")
    project_id: str
    kind: str
    created_at: str
    updated_at: str
    title: str | None = None
    context: Any = None


class ConversationListResponse(CamelModel):
    conversations: list[HeaderOut]


class ConversationCreateRequest(CamelModel):
    """`POST /conversations` — create the row BEFORE the first turn. The id stays
    client-minted (`crypto.randomUUID`); the server validates ownership of the
    parent project and makes the call idempotent per owner, so the SPA's synchronous
    mint-then-navigate flow needs no extra round trip on a retry."""

    id: uuid.UUID
    project_id: uuid.UUID
    # THE ONE PLACE A CHAT'S KIND IS EVER SET. `ChatKind` is two-valued and fixed at creation:
    # no route changes it, no in-composer switcher exists, and no hidden marker row tells the
    # model that its toolset just changed — a three-valued conversation kind and the three-valued
    # mode that used to switch beside it collapsed into this single field. Building from a plan
    # does not change the plan chat either; the handoff creates a SECOND chat and starts the turn
    # there. The kind decides what a turn is handed — its toolset and its prompt — and whether the
    # surface shows the app pane; nothing else branches on it. A value outside the enum is refused
    # here rather than coerced to a default.
    kind: ChatKind
    title: str | None = None
    context: Any = None


class ConversationCreateResponse(CamelModel):
    conversation: HeaderOut


class ActiveTurnOut(CamelModel):
    """The in-flight turn, when one is running, read from the live turn registry. `last_seq` is
    the turn's newest event seq — the cursor a subscriber resumes the event stream from."""

    turn_id: str
    last_seq: int


class ConversationDetailResponse(CamelModel):
    """Header + display projection + the `activeTurn` seam — one read rebuilds the chat.
    `projection` items are the `services/messages/projection.py` models (the single
    history→display derivation; documented here, produced there)."""

    conversation: HeaderOut
    projection: list[DisplayItem]
    active_turn: ActiveTurnOut | None = None


# ---------------------------------------------------------------------------------------
# The turn-stream frame union (one transport for chat + build activity)
# ---------------------------------------------------------------------------------------
#
# Every frame carries the per-turn monotonic `seq` (the SSE `id:` cursor). The union
# discriminates through a CALLABLE Discriminator + Tag (the chat-message-shapes learning):
# a malformed KNOWN tag routes to its model and RAISES on validation, while an unknown tag
# is captured as `UnknownFrame` without degrading the known members — new server frame
# types never silently break an older parser that revalidates a stream.


class TurnTextPart(CamelModel):
    """One block of the turn's prose, at the position it took."""

    type: Literal["text"] = "text"
    text: str


class TurnStepPart(CamelModel):
    """One of the turn's steps, at the position it took.

    `tool_call_id` is the SAME key the live `StepFrame` carries, so a step that resolves
    after this snapshot replaces the one the snapshot delivered instead of stacking a second
    copy beside it. It used to be absent, and a client had to key a snapshot's steps on
    `seq`+`tool` — which is `0`+the tool name for every in-flight step, so two concurrent
    reads collided on one key and a reattaching citizen lost one of them."""

    type: Literal["step"] = "step"
    tool_call_id: str
    item: StepItem


TurnPart = Annotated[TurnTextPart | TurnStepPart, Field(discriminator="type")]
"""What a turn has produced so far, prose and steps INTERLEAVED in emission order.

A flat "text so far" string beside an unordered step list cannot express a turn that wrote,
acted, and wrote again — the two shapes agreed only while a turn was guaranteed at most one
block of text, always last. That guarantee came from prose beside a tool call being thrown
away; with it gone, the snapshot has to carry the order, or a citizen who reloads mid-turn
reads the same turn in a different order from one who never left."""


class SnapshotFrame(CamelModel):
    """The catch-up snapshot — always the first frame of a subscription that cannot prove
    gap-free continuity (fresh subscribe, F5, cursor fallen out of the ring). `items` are the
    turn's PERSISTED rows via the projection; `parts` is the in-memory tail not yet in the DB
    (prose + steps, ordered, hidden steps included — dropping them once cost a mid-turn
    reconnect the very steps the other two paths kept). `error_message` recovers a failed
    turn's WHY for a subscriber who missed the ring-only `error` frame. The workspace/preview/
    `compile_state` trio applies the same reasoning to a Write turn, so a reconnect never
    re-polls the sandbox or sits under a stale cover. All four are optional."""

    type: Literal["snapshot"] = "snapshot"
    seq: int
    turn_id: str | None
    turn_status: Literal["idle", "running", "completed", "failed", "stopped"]
    items: list[DisplayItem] = Field(default_factory=list)
    parts: list[TurnPart] = Field(default_factory=list)
    # The same catch-up reasoning as the fields below: a client that reattaches while the model
    # is mid-thought would otherwise see a still screen until the next frame changed something.
    working: bool = False
    error_message: str | None = None
    workspace_state: Literal["preparing", "ready", "unavailable"] | None = None
    preview_url: str | None = None
    preview_state: Literal["ready", "reconnecting"] | None = None
    compile_state: CompileState | None = None


class TextDeltaFrame(CamelModel):
    """One streamed slice of the assistant's reply text.

    `new_block` says this slice OPENS a block rather than continuing the current one — the
    live half of the boundary the reload projection gets for free from one stored `TextPart`
    per item. Without it a client could only concatenate, and a turn that wrote, acted and
    wrote again would render as one paragraph under all of its steps live, and as two
    paragraphs around them after a reload."""

    type: Literal["text_delta"] = "text_delta"
    seq: int
    text: str
    new_block: bool = False


class WorkingFrame(CamelModel):
    """The model is REASONING — and this is the whole of what reasoning becomes.

    A BOOLEAN, NEVER THE TEXT. Reasoning blocks are stored so the provider can be given them
    back on the next turn (it rejects a tool call whose reasoning block is missing) but are
    never projected, framed, or sent to the browser — the citizen reads one status line.
    EDGE-TRIGGERED: emitted when the flag CHANGES, not per reasoning delta, which would put
    thousands of identical frames through a ring sized for a turn's whole narrative."""

    type: Literal["working"] = "working"
    seq: int
    working: bool


class StepFrame(CamelModel):
    """A friendly agent step, live. `phase='started'` announces the tool call (item state
    `pending`); `phase='finished'` re-delivers the SAME step resolved (`ok`/`failed`).
    Clients key on `tool_call_id` to replace the pending card in place — `item` is the
    identical shape the reload projection produces, so live and reload can never drift."""

    type: Literal["step"] = "step"
    seq: int
    tool_call_id: str
    phase: Literal["started", "finished"]
    item: StepItem


class TurnErrorFrame(CamelModel):
    """An in-band, user-safe failure notice (the turn is failing; a terminal follows)."""

    type: Literal["error"] = "error"
    seq: int
    message: str


class PlanOptionsFrame(CamelModel):
    """The Build it / Keep refining card, live. `item` is the identical shape the
    reload projection produces — resolution state always derives from the stored record."""

    type: Literal["plan_options"] = "plan_options"
    seq: int
    item: PlanOptionsItem


class WorkspaceFrame(CamelModel):
    """The turn's sandbox lifecycle — what the client's phase machine reads. `preparing` is a
    cold provision or a snapshot restore (30-60s, which is why it never blocks the POST);
    `unavailable` is a TYPED failure carrying citizen-readable copy, not a hang."""

    type: Literal["workspace"] = "workspace"
    seq: int
    state: Literal["preparing", "ready", "unavailable"]
    message: str | None = None
    # SOMETHING THE PLATFORM NEEDS THE CITIZEN TO SEE, as distinct from `message`, which
    # narrates the phase this frame announces ("Getting your workspace ready…").
    #
    # The two are different kinds of speech and they belong in different places on screen, which
    # is why they are different fields rather than one. `message` describes what is happening
    # right now and is correctly replaced by whatever happens next. A notice is a statement about
    # the APP — it was reset and is being put back, it was reset and cannot be, we could not check
    # it — and it stays true after the phase that carried it has passed. Sharing one field made
    # every ordinary turn post its phase narration into the banner slot above the composer.
    notice: str | None = None


class PreviewFrame(CamelModel):
    """The app's live preview. `ready` carries the url to frame — the client keys its iframe
    on it, so a NEW url remounts and reloads; `reconnecting` says the dev process died and a
    re-frame is coming, which only the server can know (`/dev/status` is bearer-guarded)."""

    type: Literal["preview"] = "preview"
    seq: int
    state: Literal["ready", "reconnecting"]
    preview_url: str | None = None


class CompileFrame(CamelModel):
    """What the app's dev server is compiling right now, so the preview pane can cover its
    frame instead of letting the framework's full-screen error screen fill it. Emitted ON
    CHANGE, not on every poll (a frame per poll would be several hundred per build on a ring
    sized for narrative). `unknown` is a real value the client MUST hold its cover on rather
    than clear — the signal only reaches a container once it runs an image carrying
    `/dev/compile`, so an absent signal may never read as clean."""

    type: Literal["compile"] = "compile"
    seq: int
    # The build's OWN enum rather than a re-spelled Literal, exactly as `DiagnosticFrame.source`
    # does: a StrEnum has an identical wire shape, and a second copy of the member list is a
    # copy that can drift from the value the producer already holds.
    state: CompileState


class DiagnosticFrame(CamelModel):
    """An in-narrative build diagnostic. Deliberately NOT an `error` frame: the turn is not
    failing — a repair run follows.

    ONE AUDIENCE RIDES THIS FRAME. `title`/`cleaned_stack` used to travel here beside the
    citizen's half as "safe to transmit, NOT a product surface" — a distinction no wire format
    can hold, and it once put a stack trace under a file-path title in a citizen's chat. The
    model's half now stays SERVER-SIDE, read off the `BuildError` by the repair run — not lost,
    not redacted, never sent. What crosses is `user_message`/`user_action` alone."""

    type: Literal["diagnostic"] = "diagnostic"
    seq: int
    # The build's OWN enum, not a re-spelled Literal. `ErrorSource` is a StrEnum, so the
    # wire shape is identical either way — but a second copy of the member list is a copy
    # that can drift, and the producer already holds a `BuildError.source`.
    #
    # KEPT, and it is worth saying why when its two neighbours went: `source` is a closed
    # vocabulary of error CLASSES this schema already publishes, it is what the citizen-facing
    # pair is derived from below, and it carries nothing out of the build — a class name is not
    # a stack.
    source: ErrorSource
    # DERIVED FROM `source` WHEN THE PRODUCER SUPPLIES NOTHING, which is the whole safety
    # property: the pair cannot be forgotten into emptiness by a caller that only knows about
    # the model's half, so every diagnostic that reaches a person carries a sentence AND a next
    # action. A producer that has something better to say may still pass its own.
    user_message: str = ""
    user_action: str = ""

    @model_validator(mode="after")
    def _speak_product_language(self) -> DiagnosticFrame:
        """Backfill either empty half of the citizen-facing pair from the error class.

        A cross-field invariant, not a presence check dressed up as one: what the pair should
        say is a function of `source`, so it cannot be expressed as a no-default field — and a
        blank half is the one state that must never egress, in every environment."""
        fallback = user_facing(self.source)
        if not self.user_message:
            self.user_message = fallback.message
        if not self.user_action:
            self.user_action = fallback.action
        return self


class QuotaFrame(CamelModel):
    """The daily cap, hit mid-turn. Structured rather than free text because the client
    formats the numbers itself and drives its own banner — an `error` frame's message string
    cannot be re-formatted."""

    type: Literal["quota"] = "quota"
    seq: int
    limit: int
    used: int
    resets_at: str


class TurnEndedFrame(CamelModel):
    """The semantic terminal — exactly one per turn; the transport closes right after
    (`data: [DONE]`). `reason` names WHY a non-`completed` turn stopped (`quota_exceeded`,
    `self_heal_budget_exhausted`, `sandbox_gone`, `wall_clock_deadline_exceeded`,
    `request_limit`, `build_wrote_nothing`, `stopped_by_user`). `snapshot_committed` is
    TRI-STATE: `true`/`false` is the finalize's answer, `null` is UNKNOWN (nothing to
    snapshot, or a terminal that never reached finalize) — a client that collapses `null`
    into `false` loses work that may well be saved. All three fields are optional additions."""

    type: Literal["turn_ended"] = "turn_ended"
    seq: int
    turn_id: str
    status: Literal["completed", "failed", "stopped"]
    reason: str | None = None
    preview_url: str | None = None
    snapshot_committed: bool | None = None


class UnknownFrame(BaseModel):
    """A frame type this parser does not know — captured verbatim (extra="allow"), never
    an error: streams must be forward-extensible without breaking old parsers."""

    model_config = ConfigDict(extra="allow")

    type: str
    seq: int = 0


_KNOWN_FRAME_TAGS: Final = frozenset(
    {
        "snapshot",
        "text_delta",
        "step",
        "working",
        "plan_options",
        "error",
        "turn_ended",
        "workspace",
        "preview",
        "diagnostic",
        "quota",
        "compile",
    }
)


def _frame_tag(value: Any) -> str | None:
    """Callable discriminator: route known tags to their model (whose validation then
    RAISES on a malformed body — never silent), everything else to `UnknownFrame`."""
    tag = value.get("type") if isinstance(value, dict) else getattr(value, "type", None)
    if isinstance(tag, str) and tag in _KNOWN_FRAME_TAGS:
        return tag
    return "unknown"


# A new frame type needs BOTH `_KNOWN_FRAME_TAGS` above and a member here: a tag listed in
# only one of the two still parses, silently, as an `UnknownFrame` — the forward-compat
# escape hatch swallowing our own frame instead of the foreign one it exists for.
TurnStreamFrame = Annotated[
    Annotated[SnapshotFrame, Tag("snapshot")]
    | Annotated[TextDeltaFrame, Tag("text_delta")]
    | Annotated[StepFrame, Tag("step")]
    | Annotated[WorkingFrame, Tag("working")]
    | Annotated[PlanOptionsFrame, Tag("plan_options")]
    | Annotated[TurnErrorFrame, Tag("error")]
    | Annotated[TurnEndedFrame, Tag("turn_ended")]
    | Annotated[WorkspaceFrame, Tag("workspace")]
    | Annotated[PreviewFrame, Tag("preview")]
    | Annotated[DiagnosticFrame, Tag("diagnostic")]
    | Annotated[QuotaFrame, Tag("quota")]
    | Annotated[CompileFrame, Tag("compile")]
    | Annotated[UnknownFrame, Tag("unknown")],
    Discriminator(_frame_tag),
]

TURN_STREAM_FRAME_ADAPTER: TypeAdapter[TurnStreamFrame] = TypeAdapter(TurnStreamFrame)
"""The one validating parser for turn-stream frames (tests + any server-side re-parse)."""


class TurnStartResponse(CamelModel):
    """`POST /conversations/{id}/turns` → 202: the turn now runs detached."""

    turn_id: str


class TurnStopResponse(CamelModel):
    """`POST /conversations/{id}/turns/{turnId}/stop` → the stop landed (or the turn was
    already settled — stopping twice is not an error)."""

    status: Literal["stopping", "already_settled"]
