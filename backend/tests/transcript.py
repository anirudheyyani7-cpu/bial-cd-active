"""Reading a live turn's prose in a test, the way the citizen reads it.

WHY THIS EXISTS
A turn's state holds its content as ORDERED PARTS — prose interleaved with the steps that ran
between them — because the live feed and a reloaded transcript must agree on that order. Most
assertions here care about one of two things:

* WHAT was said — `rendered_text` joins the blocks the way the browser draws them, so a
  substring check reads naturally; or
* WHERE it was said — `state.text_blocks()` is the list to compare against directly, since an
  equality on the list is what pins the correct order (a joined string would pass either way).

Joined with the engine's own separator, not an empty string: concatenating raw paragraphs runs
the last sentence of one into the first word of the next.

`live_shape` and `reload_shape` answer the third question — whether a WATCHING tab and a
RELOADED one read the same thing. They live together because the comparison only means
something if both sides are reduced by functions that agree on what "on the screen" is; two
files each keeping their own copy is how the two orders would drift apart.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from src.api.v1.conversations.schemas import StepFrame, TextDeltaFrame, TurnStreamFrame
from src.services.messages.projection import AssistantTextItem, DisplayItem, StepItem
from src.services.turns.engine import TEXT_BLOCK_SEPARATOR


class _HasTextBlocks(Protocol):
    """The one thing this module needs of a turn state, so a test double works too."""

    def text_blocks(self) -> list[str]: ...


class _HasRing(Protocol):
    """Likewise for the frames a turn has put on the wire."""

    @property
    def ring(self) -> Sequence[TurnStreamFrame]: ...


def rendered_text(state: _HasTextBlocks) -> str:
    """Every block of prose the turn has given the citizen, as one readable string."""
    return TEXT_BLOCK_SEPARATOR.join(state.text_blocks())


def live_shape(state: _HasRing) -> list[str]:
    """The live feed reduced to what a watching tab still shows, in order. Text and steps
    only, so the shape is comparable across frame types only one side has (workspace,
    compile, preview, the reasoning working status).

    REDUCED THE WAY THE BROWSER REDUCES IT: a step arriving again on the same `tool_call_id`
    REPLACES the earlier frame, so the LAST frame for an id decides whether it's on screen
    when the turn ends — counting `started` frames alone would report a row as present
    however it was later withdrawn, the exact drift these comparisons exist to catch."""
    order: list[tuple[str, str]] = []  # ("text", the words) | ("step", the tool_call_id)
    steps: dict[str, StepItem] = {}
    for frame in state.ring:
        if isinstance(frame, TextDeltaFrame):
            text = frame.text.strip()
            if text:
                order.append(("text", text))
        elif isinstance(frame, StepFrame):
            if frame.tool_call_id not in steps:
                order.append(("step", frame.tool_call_id))
            steps[frame.tool_call_id] = frame.item
    shape: list[str] = []
    for kind, value in order:
        if kind == "text":
            shape.append(f"text:{value}")
        elif not steps[value].hidden:
            shape.append(f"step:{steps[value].tool}")
    return shape


def reload_shape(items: Sequence[DisplayItem]) -> list[str]:
    """The same shape, read off a reloaded transcript's projected items."""
    shape: list[str] = []
    for item in items:
        if isinstance(item, AssistantTextItem):
            shape.append(f"text:{item.text.strip()}")
        elif isinstance(item, StepItem) and not item.hidden:
            shape.append(f"step:{item.tool}")
    return shape
