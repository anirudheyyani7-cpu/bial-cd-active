"""The scheduled reclamation pass — report-only until somebody flips its destroy flag."""

from __future__ import annotations

import datetime as dt
from typing import Final

import structlog

from src.broker import broker
from src.config import settings
from src.services.build_sessions.reclamation_pass import PassReport

_log = structlog.get_logger()

#: The task's own name, and the `task_name` its pass records carry.
RECLAMATION_TASK_NAME: Final = "sandbox_reclamation"
RECLAMATION_SCHEDULE_ID: Final = "sandbox-reclamation-every-15m"

#: Every fifteen minutes, and it must not be sped up: the staging interval is fifteen minutes
#: too, so a faster cadence would let two "independent" reads land inside one window — exactly
#: the independence the two-pass rule buys.
RECLAMATION_CRON: Final = "*/15 * * * *"

# Named constants because an alert rule greps for exactly these strings, and distinct because they
# answer different questions: the fleet alarm is only ever emitted by a pass that RAN, so a rule
# keyed on it cannot tell a quiet fleet from a worker that has stopped.
FLEET_THRESHOLD_EVENT: Final = "sandbox_fleet_over_threshold"
PASS_COMPLETED_EVENT: Final = "sandbox_reclamation_pass_completed"


def _off_duty_because() -> str | None:
    """Why this pass must not run, or `None` when it may.

    Two strings rather than a bool, because they mean different things to whoever reads the log:
    `unconfigured` is "this deployment has no ARM access at all", the ordinary local posture;
    `flag_off` is "it does, and reclamation has not been switched on" — the state every
    environment ships in."""
    sandbox = settings.sandbox
    if sandbox is None:
        return "unconfigured"
    if not sandbox.reclaim_enabled:
        return "flag_off"
    return None


@broker.task(
    task_name=RECLAMATION_TASK_NAME,
    schedule=[{"cron": RECLAMATION_CRON, "schedule_id": RECLAMATION_SCHEDULE_ID}],
)
async def reclaim_abandoned_sandboxes() -> None:
    """One reclamation pass. Reports; destroys nothing until the destroy flag is turned on."""
    off_duty = _off_duty_because()
    if off_duty is not None:
        _log.info("sandbox_reclamation_pass_disabled", reason=off_duty)
        await _record_pass(outcome="declined", counts={}, detail=off_duty)
        return

    from src.services.build_sessions.reclamation_pass import run_reclamation_pass

    try:
        report = await run_reclamation_pass()
    except Exception:
        _log.exception("sandbox_reclamation_pass_failed")
        await _record_pass(
            outcome="failed", counts={}, detail="the pass raised; see the traceback"
        )
        raise

    counts = {
        "scanned": report.scanned,
        "spared": report.spared,
        "staged": report.staged,
        "destroy_candidates": report.destroy,
        "escalate": report.escalate,
        "not_ours": report.not_ours,
    }
    if report.store_fault:
        # A refusal to judge, reported as an alarm rather than a quiet zero: a pass that declined
        # and a pass that found nothing are different facts about the world.
        _log.error(
            "sandbox_reclamation_store_fault",
            detail="the coordination store accounts for too little of the live fleet",
            **counts,
        )
    if report.scanned >= _threshold():
        _log.warning(FLEET_THRESHOLD_EVENT, fleet=report.scanned, threshold=_threshold())

    for verdict in report.candidates:
        # THE EVIDENCE, not just the verdict: an operator has to be able to disagree with the
        # decision, which needs the tier and the reason behind it.
        _log.info(
            "sandbox_reclamation_candidate",
            app_name=verdict.name,
            tier=str(verdict.tier),
            verdict=str(verdict.verdict),
            reason=verdict.reason,
            would_destroy=settings.sandbox is not None and settings.sandbox.reclaim_destroy,
        )

    if not report.store_fault:
        # THE STAGING ARM, and it runs on `reclaim_enabled` ALONE. Gating the stamp on
        # `reclaim_destroy` too would leave `reclaim_staged_at` `None` forever on a report-only
        # deployment and re-stage every candidate on every pass — `Verdict.DESTROY` would be
        # unreachable by construction and the destroy arm below dead code nobody could tell
        # was dead.
        try:
            counts["stamped"] = await _stage_the_candidates(report)
        except Exception:
            _log.exception("sandbox_reclamation_staging_failed")
            await _record_pass(
                outcome="failed",
                counts=counts,
                detail="the staging arm raised; see the traceback",
            )
            raise
        # THE DESTROY ARM, and the only place a container is ever removed. A store fault skips
        # it entirely: a pass that does not trust its own inputs does not get to act on them.
        try:
            counts["destroyed"] = await _destroy_the_confirmed(report)
        except Exception:
            # RECORD BEFORE RE-RAISING, with the counts gathered so far. An absent row is how
            # this system says the worker is dead, so a pass that died in its destructive half
            # must not impersonate one that never ran. Only `destroyed` is missing, which is
            # honest — we do not know.
            _log.exception("sandbox_reclamation_destroy_failed")
            await _record_pass(
                outcome="failed",
                counts=counts,
                detail="the destroy arm raised; see the traceback",
            )
            raise

    _log.info(PASS_COMPLETED_EVENT, store_fault=report.store_fault, **counts)
    await _record_pass(
        outcome="declined" if report.store_fault else "ok",
        counts=counts,
        detail="store fault: the pass refused to judge" if report.store_fault else None,
    )


async def _stage_the_candidates(report: PassReport) -> int:
    """Stamp `bial-reclaim-staged-at` on every STAGE verdict. Returns how many took.

    NOTHING ELSE WRITES THIS TAG, and the classifier reads exactly `reclaim_staged_at` to decide
    STAGE versus DESTROY — so if this stops running, the destroy arm has no reachable input.
    ONE CONTAINER'S REFUSED PATCH IS ONE CONTAINER'S PROBLEM: the stamp is idempotent and
    retried next pass, so a throttled/vanished container is logged and stepped over rather
    than aborting the whole sweep."""
    from src.services.build_sessions.destroy import staging_tags
    from src.services.build_sessions.inventory import FleetTagger
    from src.services.build_sessions.reclaim import Verdict
    from src.services.sandbox import SandboxError, get_sandbox

    staging = tuple(v for v in report.candidates if v.verdict is Verdict.STAGE)
    if not staging:
        # Before touching the control plane at all: a pass with nothing to stage must not make
        # an ARM client appear.
        return 0

    control_plane = get_sandbox()
    if not isinstance(control_plane, FleetTagger):
        # A substrate that can list but not stamp cannot participate in the two-pass rule. Loud,
        # because on such a deployment reclamation can never progress past STAGE and the silence
        # would read as a fleet that simply has nothing to collect.
        _log.error("sandbox_reclamation_staging_unsupported_substrate")
        return 0

    tags = staging_tags(dt.datetime.now(dt.UTC))
    stamped = 0
    for verdict in staging:
        try:
            await control_plane.stamp_tags(name=verdict.name, tags=tags)
        except SandboxError:
            _log.warning(
                "sandbox_reclamation_staging_stamp_failed", app_name=verdict.name, exc_info=True
            )
            continue
        stamped += 1
    return stamped


async def _destroy_the_confirmed(report: PassReport) -> int:
    """Act on the candidates the classifier confirmed. Returns how many it CONFIRMED destroyed."""
    from src.services.build_sessions.destroy import destroy_candidates
    from src.services.build_sessions.inventory import FleetDestroyer
    from src.services.build_sessions.reaper import reap_the_container_we_judged
    from src.services.build_sessions.reclaim import RegistryClaim, Verdict
    from src.services.build_sessions.reclamation_pass import claim_for_container
    from src.services.redis import get_redis
    from src.services.sandbox import get_sandbox

    confirmed = tuple(v for v in report.candidates if v.verdict is Verdict.DESTROY)
    if not confirmed or settings.sandbox is None or not settings.sandbox.reclaim_destroy:
        return 0

    control_plane = get_sandbox()
    if not isinstance(control_plane, FleetDestroyer):
        # A substrate that can list but not re-read a container's tags cannot satisfy the
        # re-validation rule, and re-validation is not optional on a destroy path. Refusing is
        # the only safe answer: acting on the enumeration snapshot is precisely the race that
        # deletes a container a builder just started.
        _log.error("sandbox_reclamation_destroy_unsupported_substrate")
        return 0

    async def _revalidate(name: str) -> dict[str, str] | None:
        """Re-read THIS container's tags, right now — never the enumeration snapshot."""
        return await control_plane.get_app_tags(name=name)

    async def _claim_now(name: str) -> RegistryClaim | None:
        """Rebuild THIS container's spare-list entry, right now.

        Asks by CONTAINER, not by the owner the ARM tags name — the same question the classifier
        asked, so the two reads cannot disagree about what "claimed" means."""
        return await claim_for_container(get_redis(), app_name=name)

    async def _teardown(name: str) -> bool:
        """Destroy THE CONTAINER WE JUDGED — by name, never by whatever the owner's record
        currently points at."""
        user_id, app_id = report.owners[name]
        return await reap_the_container_we_judged(
            get_redis(), control_plane, app_name=name, user_uuid=user_id, app_id=app_id
        )

    outcome = await destroy_candidates(
        confirmed,
        revalidate=_revalidate,
        claim_now=_claim_now,
        teardown=_teardown,
        environment=str(settings.ENVIRONMENT),
    )
    if outcome.remaining:
        _log.warning("sandbox_reclamation_ceiling_reached", remaining=outcome.remaining)
    if outcome.aborted:
        _log.info("sandbox_reclamation_aborted_on_revalidation", count=len(outcome.aborted))
    if outcome.refused:
        # NOT an abort and not a destruction: the teardown ran and declined. A gate sparing the
        # same container every pass is a container whose work nothing is preserving — worth
        # reading, rather than a number quietly missing from `destroyed`.
        _log.warning("sandbox_reclamation_teardown_refused", names=list(outcome.refused))
    return len(outcome.destroyed)


def _threshold() -> int:
    sandbox = settings.sandbox
    return sandbox.reclaim_fleet_alarm_threshold if sandbox else 25


async def _record_pass(*, outcome: str, counts: dict[str, int], detail: str | None) -> None:
    """Write the pass record. EVERY outcome, including the boring ones.

    A zero-candidate pass still writes (quiet fleet vs. dead worker are otherwise the same
    observation); a declined pass writes (so "off" is visible, not inferred from silence); a
    failed pass writes (a pass that raises every tick must not look like one that never ran).
    ITS OWN SESSION, not the caller's: runs outside any request and must land even when the
    pass it describes has just failed."""
    from src.db.base import async_session_factory
    from src.db.models.worker_pass import PassOutcome, WorkerPass

    try:
        async with async_session_factory() as db:
            db.add(
                WorkerPass(
                    task_name=RECLAMATION_TASK_NAME,
                    outcome=PassOutcome(outcome),
                    finished_at=dt.datetime.now(dt.UTC),
                    counts=counts,
                    detail=detail,
                )
            )
            await db.commit()
    except Exception:
        # A pass whose WORK succeeded must not be reported as failed because its bookkeeping did.
        # Loud, though: the staleness alarm reads this table, so a silent failure here would make
        # a healthy worker look dead.
        _log.exception("sandbox_reclamation_pass_record_failed", outcome=outcome)
