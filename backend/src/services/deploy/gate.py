"""The publish gate's shared reading: one stored review + one answer set -> one record.

THE ROUTE STILL OWNS THE LADDER. `deploy/router.py` decides which rung answers; this
module holds what that decision is *written in* — reading a stored review against the
shipping commit, handing sources to the merge, and the declaration document every
outcome records. It lives here because the DETACHED PIPELINE (the drift re-check) is a
second writer that cannot import the route, and two copies of a route-owned contract is
how `differences` quietly stops meaning the same thing in both places an admin reads it.

Nothing here decides anything: it reads, merges, formats. Both callers keep their own
decision.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models.classification_review import ClassificationReviewStatus
from src.services.audit.log import append_audit
from src.services.classification.merge import (
    MergeOutcome,
    QuestionMergeInput,
    ScanSignal,
)
from src.services.classification.schema import Verdict
from src.services.classification.service import ReviewReadout
from src.services.classification.store import ReviewRecord
from src.services.deploy.classification import DATA_CLASSIFICATION_QUESTIONS

GATE_AUDIT_ACTION = "publish_gate"
"""The one audit action every gate outcome writes, whoever decided it — the route's
ladder and the pipeline's post-re-check decision alike. See `append_gate_audit`."""


@dataclass(frozen=True)
class ReviewAtHead:
    """The stored review SITUATED against the shipping commit, computed once so the ladder, merge
    and record agree on what "there is a review" means.

    `complete` (rule 4's predicate) is narrower than the bare status: COMPLETE AND
    `answers_complete` AND not aged out AND stamped exactly this commit — a complete-but-partial
    row reads FAILED, as the runner does. `verdicts`/`scan` populate whenever the document is
    stamped this commit, even a FAILED row (the Tier A scan floor); a row stamped ANOTHER commit
    contributes nothing — an answer about an older version must NEVER be read as this one's."""

    complete: bool
    available: bool
    """Whether a review document for THIS commit informed the merge, recorded on every
    decision."""
    status: str | None
    failure_code: str | None
    source: str | None
    """`review` or `scan_floor`, or None when no document applies."""
    verdicts: dict[str, Any]
    """Per-question stored entries for this commit, or empty."""
    scan: dict[str, Any]
    """The stored scan block (booleans only, never locations), or empty."""


def review_at_head(readout: ReviewReadout | None, head_sha: str | None) -> ReviewAtHead:
    """One stored row + the shipping commit -> the gate's reading of it."""
    if readout is None or head_sha is None or readout.review.head_sha != head_sha:
        # Absent, or stamped a different version — the same nothing, deliberately: a
        # stamp mismatch makes a stored answer unusable.
        return ReviewAtHead(
            complete=False,
            available=False,
            status=readout.review.status.value if readout is not None else None,
            failure_code=readout.review.failure_code if readout is not None else None,
            source=None,
            verdicts={},
            scan={},
        )
    record: ReviewRecord = readout.review
    document = record.verdicts or {}
    questions = document.get("questions") or {}
    complete = (
        record.status is ClassificationReviewStatus.COMPLETE
        and record.answers_complete is True
        and not readout.aged_out
    )
    return ReviewAtHead(
        complete=complete,
        available=bool(questions),
        status=record.status.value,
        failure_code=record.failure_code,
        source=document.get("source"),
        verdicts=questions,
        scan=document.get("scan") or {},
    )


def merge_inputs(flags: dict[str, bool], review: ReviewAtHead) -> list[QuestionMergeInput]:
    """One `QuestionMergeInput` per questionnaire key: the citizen's answer, the stored
    verdict (None when no completed verdict is on record — the merge's convention), the
    scan signal, and the policy weight.

    VERDICTS ARE CONSULTED ONLY WHEN THE REVIEW IS COMPLETE FOR THIS COMMIT, except the
    Tier A floor (a FAILED row by construction) — feeding a running row's absent verdicts
    through as No would reopen the bypass rule 4 closes. The scan signal is meaningful
    for credentials alone, read off the stored booleans, never a location."""
    # A FLOOR row is not a review that answered — it is the record of one that never
    # returned, with the scan's Tier A hit written in as the credentials answer. Its
    # verdicts are therefore NOT handed to the merge as verdicts: `review_verdict=None` is
    # the merge's documented word for "no completed verdict is on record", which is
    # exactly this row's situation, and it is what lets the merge's own floor branch fire
    # and record SCAN_STOOD_IN.
    #
    # Passing the stored `yes` through instead made that branch UNREACHABLE, and the
    # mislabel was user-visible: the queue item read `review_yes_over_citizen_no`, whose
    # admin copy is "The automatic check found this kind of data" — on the one path where
    # no automatic check ran at all. The non-credentials questions are stored `unanswered`
    # on a floor row and merge identically either way (both fall to the citizen), so
    # nothing else moves.
    floor = review.source == "scan_floor"
    usable = review.complete or floor
    scan_signal = ScanSignal.NONE
    if usable and review.scan.get("tier_a_hit"):
        scan_signal = ScanSignal.TIER_A
    elif usable and review.scan.get("tier_b_hit"):
        scan_signal = ScanSignal.TIER_B

    inputs: list[QuestionMergeInput] = []
    for key, _label, weight in DATA_CLASSIFICATION_QUESTIONS:
        verdict: Verdict | None = None
        downgraded = False
        if usable and not floor:
            entry = review.verdicts.get(key)
            if isinstance(entry, dict):
                raw = entry.get("verdict")
                # An unrecognised label is treated as NO COMPLETED VERDICT rather than
                # guessed at — the question falls to the citizen, which is the fail-safe
                # direction: it can add routing, never remove it.
                verdict = next((v for v in Verdict if v.value == raw), None)
                # The runner's discard, carried through rather than re-derived: it turned
                # a Yes whose every cited location was absent into UNANSWERED, and from
                # the verdict alone that is indistinguishable from an honest abstention.
                # The merge routes on it (the agent DID raise a flag), so losing the flag
                # here would silently restore the fall-through it exists to close.
                downgraded = bool(entry.get("downgraded_from_yes"))
        inputs.append(
            QuestionMergeInput(
                key=key,
                weight=weight,
                citizen_yes=bool(flags.get(key)),
                review_verdict=verdict,
                scan=scan_signal if key == "credentials_secrets" else ScanSignal.NONE,
                downgraded_from_yes=downgraded,
            )
        )
    return inputs


@dataclass(frozen=True)
class DriftFacts:
    """WHY THIS QUEUE ITEM LOOKS LIKE AN ANSWER TO A DIFFERENT QUESTION.

    Set only on the save-and-publish path, where the citizen answered the form about one
    commit and the pipeline then re-checked another. Nobody is at the form when that
    decision lands, so the citizen's explanation — if there is one at all — was written
    about `answered_about`, not about the version an administrator is being asked to
    approve. These are the facts that make that distinction renderable.
    """

    answered_about: str | None
    """The commit the citizen's answers and explanation were written about: the stamp on
    the review that pre-filled the form. None when no stored review informed them."""

    newly_raised: tuple[str, ...]
    """The weighted questionnaire keys that routed this version and that the submitted
    answer set did NOT already carry — the ones the citizen's explanation cannot be an
    answer to, because they were not among the things it was written about.

    NOT the reason publishing stopped, and it must not be read as one: that reason is the
    merged answer set having any weighted Yes at all (rule 6). An item can route with this
    list EMPTY — the citizen declared the category themselves and the re-check simply
    agreed — and a screen that renders "nothing new was found" as "nothing was found"
    would tell an administrator the opposite of the truth."""


def declaration_document(
    *,
    head_sha: str | None,
    citizen: dict[str, bool],
    explanation: str | None,
    review: ReviewAtHead,
    merged: MergeOutcome,
    drift: DriftFacts | None = None,
) -> dict[str, Any]:
    """THE DECLARATION — the one payload every branch records and the queue carries.

    Written once, read by three consumers, so its shape is CONTRACT: the registry's
    `declaration` column, the `publish_gate` audit detail, and the routed response's
    provenance. `differences` carries `DisagreementKind` VALUES verbatim — renaming one
    is a data migration. Evidence locations are structurally absent; only the
    plain-language `reasons` ships, carried HERE because the review store is overwritten
    by the next run. `drift`, present only on the drift path, is itself the signal."""
    document: dict[str, Any] = {
        "commits": {
            "shipping": head_sha,
            # What the recorded verdicts are actually ABOUT. Equal to shipping whenever a
            # review informed the decision; null when none did. The drift path is what
            # makes these two legitimately differ.
            "reviewed": head_sha if review.available else None,
        },
        "citizen": {"answers": dict(citizen), "explanation": explanation},
        "review": {
            "available": review.available,
            "complete": review.complete,
            "status": review.status,
            "failureCode": review.failure_code,
            "source": review.source,
            "answers": {
                key: str(entry.get("verdict"))
                for key, entry in review.verdicts.items()
                if isinstance(entry, dict)
            },
            # Only where the stored entry actually holds prose: an absent reason must stay
            # absent so the screen can say "no reason recorded" rather than render "None".
            "reasons": {
                key: str(entry["reason"])
                for key, entry in review.verdicts.items()
                if isinstance(entry, dict) and isinstance(entry.get("reason"), str)
            },
            "scan": {
                "tierAHit": bool(review.scan.get("tier_a_hit")),
                "tierBHit": bool(review.scan.get("tier_b_hit")),
                "incomplete": bool(review.scan.get("incomplete")),
                "tierADispute": bool(review.scan.get("tier_a_dispute")),
            },
        },
        "merged": {
            "answers": {question.key: question.effective_yes for question in merged.questions},
            "anyWeightedYes": merged.any_weighted_yes,
        },
        "differences": {
            question.key: [kind.value for kind in question.recorded]
            for question in merged.questions
            if question.recorded
        },
    }
    if drift is not None:
        document["drift"] = {
            "answeredAbout": drift.answered_about,
            "shipping": head_sha,
            "newlyRaised": list(drift.newly_raised),
            "routedBy": "pipeline_recheck",
        }
    return document


# --- reading one back ---------------------------------------------------------------
#
# THE READERS LIVE BESIDE THE WRITER, deliberately. A declaration written here and taken
# apart somewhere else is the two-copies-of-a-contract failure this module's docstring
# exists to prevent: rename a section above and the only thing that tells you is a queue
# item that quietly reads every category as a new one. The single caller is the drift
# re-check, which is handed the gate's own document and must re-merge what is in it.


def answers_in(declaration: Mapping[str, Any], section: str) -> dict[str, bool]:
    """One answer block out of a declaration document.

    Read defensively — missing key, wrong type, a section that predates a question — and
    the missing answer is False, which is the policy table's own reading of an omitted key
    (`classification.total_weight`). Every direction of that leniency ADDS routing rather
    than removing it: an unreadable submitted baseline makes every Yes look new."""
    block = declaration.get(section)
    answers = block.get("answers") if isinstance(block, dict) else None
    if not isinstance(answers, dict):
        return {}
    return {str(key): bool(value) for key, value in answers.items()}


def explanation_in(declaration: Mapping[str, Any]) -> str | None:
    """The citizen's explanation, already redacted by the gate that stored it. On the
    drift path it was written about the EARLIER version — carried forward unchanged rather
    than dropped, with `drift.answeredAbout` naming the version it answers."""
    citizen = declaration.get("citizen")
    explanation = citizen.get("explanation") if isinstance(citizen, dict) else None
    return explanation if isinstance(explanation, str) else None


async def append_gate_audit(
    db: AsyncSession,
    *,
    actor_id: uuid.UUID,
    email: str | None,
    app_id: uuid.UUID,
    project_id: uuid.UUID,
    decision: str,
    rule: str,
    declaration: dict[str, Any] | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """ONE audit action for every gate outcome, APP-SCOPED. Commit-less.

    App-scoped is the fix: the refusal row this replaces was PROJECT-scoped with no app
    id, invisible to the admin app audit drawer (`resource_id`/`detail->>'appId'`). One
    action with a `decision` field, not four, so one query answers "what did the gate
    decide for this app". `email` is denormalised because the actor REFERENCE is nulled
    on user removal. TWO CALLERS — the route's ladder and the detached pipeline's drift
    re-check — write the same shape under the same actor, so one query still covers both."""
    detail: dict[str, Any] = {
        "appId": str(app_id),
        "projectId": str(project_id),
        "email": email,
        "decision": decision,
        # WHICH rung answered — the difference between "routed because the review found
        # something" and "routed because there was no review" is the whole story.
        "rule": rule,
    }
    if declaration is not None:
        detail["declaration"] = declaration
    if extra:
        detail.update(extra)
    await append_audit(
        db,
        actor_id=actor_id,
        action=GATE_AUDIT_ACTION,
        resource_type="app",
        resource_id=str(app_id),
        detail=detail,
    )
