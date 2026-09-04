"""Deploy reconciliation on the worker's clock.

BLAST RADIUS. `reconcile_stalled_deployments` settles a deployment ROW and at most promotes it —
the reader type it is handed declares no delete method — so a wrong answer costs a row reading
`failed` instead of `running`, never a container app.

TWO PASSES AT ONCE ARE SAFE, which is why this one carries no lock of its own. Staleness is
`deployments.heartbeat_at` under a `status = 'running'` guard — a shared column, not in-process
state, so the pass sees the same rows out of process as the API does — and every terminal write
goes through `store._finish`'s `WHERE status = 'running'` guard and returns its rowcount.
"""

from __future__ import annotations

import structlog

from src.broker import broker
from src.config import settings

_log = structlog.get_logger()

# An operator (or an Azure Monitor rule) greps for exactly these, so they are constants rather
# than inline literals, and deliberately distinct from the boot one-shot's
# `deploy_startup_reconcile` — "a pass ran" and "a process booted" must never blur together.
DEPLOY_RECONCILE_DONE_EVENT = "deploy_reconcile_pass_done"
DEPLOY_RECONCILE_DISABLED_EVENT = "deploy_reconcile_pass_disabled"

# The task's stable wire name. It travels inside every queued message and is the key the
# receiver looks the executor up by, so renaming it strands anything already on the stream.
DEPLOY_RECONCILE_TASK_NAME = "deploy.reconcile_stalled"

# Pinned, not minted. `LabelScheduleSource` generates a fresh `uuid4().hex` for any schedule
# entry that does not carry one, per process start — which makes the id useless as a correlation
# key in logs and useless as a dedupe key for anything downstream.
DEPLOY_RECONCILE_SCHEDULE_ID = "deploy-reconcile-every-five-minutes"


def _honoured_by_the_clock(expression: str) -> str:
    """Return `expression`, or refuse to import.

    Taskiq validates a cron nowhere at decoration time — a bad one surfaces only as a warning
    logged once a second inside the scheduler loop, forever, while the task never fires. So it is
    asserted at IMPORT, and for FIRING rather than parsing: the evaluator accepts `99 * * * *`
    and then matches no minute ever.
    """
    from datetime import UTC, datetime, timedelta

    from taskiq.cli.scheduler.run import CronValueError, is_cron_task_now

    minute = datetime.now(UTC).replace(second=0, microsecond=0)
    try:
        fires = any(
            is_cron_task_now(expression, minute + timedelta(minutes=ahead)) for ahead in range(60)
        )
    except CronValueError as exc:
        raise ValueError(
            f"the deploy-reconcile cron {expression!r} does not parse, so the scheduler would "
            f"log a warning every second and never fire the task"
        ) from exc
    if not fires:
        raise ValueError(
            f"the deploy-reconcile cron {expression!r} parses but matches no minute in the next "
            f"hour, so the scheduler would never fire the task"
        )
    return expression


# Every five minutes on the wall clock.
#
# CRON, NEVER `interval`. `is_interval_task_now` returns True whenever `last_run is None`, and
# last-run state is an in-memory dict the scheduler never persists — so an interval task fires on
# EVERY process start, and `skip_first_run` does not suppress it. At ACA revision-roll frequency
# that is an unasked-for pass per deploy, forever.
DEPLOY_RECONCILE_CRON = _honoured_by_the_clock("*/5 * * * *")


def _off_duty_because() -> str | None:
    """Why this pass must not run, or `None` when it may.

    Two strings rather than a bool, because they mean different things to whoever reads the log
    line: `unconfigured` is "this deployment does not publish apps at all", the ordinary dev,
    test and not-yet-granted-the-registry-role posture; `flag_off` is "it does, and an operator
    switched the timer off". The flag ships ON, so `flag_off` is always a deliberate act.
    """
    deploy = settings.deploy
    if deploy is None:
        return "unconfigured"
    if not deploy.reconcile_enabled:
        return "flag_off"
    return None


@broker.task(
    task_name=DEPLOY_RECONCILE_TASK_NAME,
    # A LIST of dicts. A bare dict raises inside `LabelScheduleSource.startup()`, and an entry
    # missing all of {cron, interval, time} is silently skipped — a schedule that looks present
    # and never fires.
    schedule=[{"cron": DEPLOY_RECONCILE_CRON, "schedule_id": DEPLOY_RECONCILE_SCHEDULE_ID}],
)
async def reconcile_stalled_deploys() -> None:
    """Settle every deployment row whose pipeline stopped beating, and say how many."""
    off_duty = _off_duty_because()
    if off_duty is not None:
        _log.info(DEPLOY_RECONCILE_DISABLED_EVENT, reason=off_duty)
        return

    from src.db.base import async_session_factory
    from src.services.deploy.aca_publish import DeployNotConfiguredError, get_published_apps
    from src.services.deploy.reconcile import reconcile_stalled_deployments

    try:
        published_apps = get_published_apps()
    except DeployNotConfiguredError:
        # Belt and braces against the gate above: `get_published_apps` reads `settings.deploy`
        # itself, and the two reads are not one atomic look. A defined state, not a failure.
        _log.info(DEPLOY_RECONCILE_DISABLED_EVENT, reason="unconfigured")
        return

    resolved = await reconcile_stalled_deployments(async_session_factory, published_apps)
    _log.info(DEPLOY_RECONCILE_DONE_EVENT, resolved=resolved)
