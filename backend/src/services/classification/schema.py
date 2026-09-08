"""The review's structured output — six verdicts, evidence-first.

WHY THIS EXISTS: field order is load-bearing, pinned by test. Per question the schema is
evidence → reason → verdict — the model cites what it found, explains it, only then
concludes, in the order pydantic declares (preserved into the JSON schema). Verdict-first
would yield a justification written after the fact, the worst thing to hand a reviewer
whose job is checking reasoning.

The six questions key off `deploy/classification.CLASSIFICATION_KEYS`, the single source
also used by the request schema and the persisted deployment declaration. Validation
demands EXACTLY the six: a missing question is rejected as incomplete, never defaulted to
No — it must be RETURNED as `unanswered` — and answers are normalised into questionnaire
order.

`completeness` disambiguates truncation from abstention: a clipped review and one that
abstained on every question both look like six `unanswered`; `partial` is a failure, not
six abstentions.

Evidence is INTERNAL ONLY, never rendered to a citizen or admin — `reason` is the only
text a person reads, kept plain by the prompt (evidence fields carry the integrity load).
"""

from __future__ import annotations

from enum import StrEnum
from typing import Self

from pydantic import BaseModel, Field, field_validator, model_validator

from src.services.deploy.classification import CLASSIFICATION_KEYS


class Verdict(StrEnum):
    """One question's answer. `UNANSWERED` is a real verdict, not a gap: the review
    answers only where it has evidence, and an unanswered question is decided by
    the citizen alone."""

    YES = "yes"
    NO = "no"
    UNANSWERED = "unanswered"


class Completeness(StrEnum):
    """Whether the review covered everything it set out to. `PARTIAL` marks a review the
    model itself knows is cut short — it is stored as a failure, never as abstention."""

    COMPLETE = "complete"
    PARTIAL = "partial"


class EvidenceRef(BaseModel):
    """One machine-checkable location backing a verdict. Deliberately NOWHERE to
    carry a found value — evidence that quoted its secret would leak it into stored
    records. Validation checks each cited path against the extracted tree; a Yes citing a
    path that does not exist is downgraded to unanswered."""

    path: str = Field(
        max_length=500,
        description=(
            "Workspace-relative path of the file the finding is in, exactly as listed "
            "by the tools (e.g. `app/lib/db.ts`)."
        ),
    )
    kind: str = Field(
        max_length=100,
        description=(
            "Short machine label for WHAT is at that path — e.g. `hardcoded-value`, "
            "`form-field`, `api-route`, `schema-column`. Never the content itself."
        ),
    )


class QuestionVerdict(BaseModel):
    """One question's finding — evidence first, then the reason, then the verdict."""

    key: str = Field(
        description="The questionnaire key this verdict answers.",
        json_schema_extra={"enum": list(CLASSIFICATION_KEYS)},
    )
    evidence: list[EvidenceRef] = Field(
        description=(
            "The locations backing this verdict, cited BEFORE reasoning. Empty for a "
            "No or an unanswered verdict; a Yes without evidence will not stand."
        ),
    )
    reason: str = Field(
        min_length=1,
        max_length=2000,
        description=(
            "The explanation, written AFTER the evidence and BEFORE the verdict, for a "
            "non-technical reader: no file names, no paths, no code, no identifiers, "
            "and never the value of anything found. Required even when unanswered — "
            "say what could not be determined."
        ),
    )
    verdict: Verdict = Field(
        description=(
            "The conclusion, stated LAST. `unanswered` when there is no evidence "
            "either way — never guess."
        ),
    )
    agreed_with_scan: bool | None = Field(
        default=None,
        description=(
            "Only when the task message listed scan findings for THIS question: true "
            "if the verdict is consistent with those findings, false if the review "
            "overrules them. Omit for questions the scan said nothing about."
        ),
    )

    @field_validator("key")
    @classmethod
    def _one_of_the_six(cls, value: str) -> str:
        if value not in CLASSIFICATION_KEYS:
            raise ValueError(
                f"unknown question key {value!r} — the six keys are "
                f"{', '.join(CLASSIFICATION_KEYS)}"
            )
        return value


class ReviewOutput(BaseModel):
    """The whole review: the completeness signal plus exactly the six verdicts, held in
    questionnaire order after validation regardless of the order the model produced."""

    completeness: Completeness = Field(
        description=(
            "`complete` when every question was examined as far as the evidence "
            "allows (an honest `unanswered` still counts as complete); `partial` when "
            "the review is knowingly cut short."
        ),
    )
    questions: list[QuestionVerdict] = Field(
        description="One verdict per questionnaire key — all six, exactly once each.",
    )

    @model_validator(mode="after")
    def _exactly_the_six(self) -> Self:
        keys = [question.key for question in self.questions]
        duplicated = sorted({key for key in keys if keys.count(key) > 1})
        if duplicated:
            raise ValueError(
                f"duplicated question key(s): {', '.join(duplicated)} — answer each "
                "question exactly once"
            )
        missing = [key for key in CLASSIFICATION_KEYS if key not in keys]
        if missing:
            # Rejected as INCOMPLETE, deliberately — a missing question must never be
            # read as No. The shape for "no evidence" is a RETURNED `unanswered`.
            raise ValueError(
                f"incomplete review: missing question(s) {', '.join(missing)} — a "
                "question you cannot answer must still be returned with verdict "
                "'unanswered', never omitted"
            )
        # Normalise into questionnaire order: a correct-but-reordered response is not a
        # failure, and every consumer downstream reads the six in one canonical order.
        rank = {key: index for index, key in enumerate(CLASSIFICATION_KEYS)}
        self.questions = sorted(self.questions, key=lambda question: rank[question.key])
        return self
