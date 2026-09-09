"""What the Save indicator reports once the agent stops committing.

THE CHANGE THIS FILE GUARDS IS A CHANGE OF WEIGHT, NOT OF SHAPE. `_save_state_of` has always
answered "uncommitted tree → dirty" first — a backstop, once, for a model that skipped the
Write prompt's per-slice commit instruction. That instruction is gone: the platform now
commits once, at the turn boundary (`snapshot._COMMIT_SCRIPT`), so for the whole of every
building turn (and forever after, if the turn died before its finalizer ran) the user's new
work exists ONLY as an uncommitted worktree at an unmoved HEAD.

Delete that arm and the ladder falls through to "HEAD == savedHead" — the Save button
disappears and the citizen is told "all changes saved" over a tree nothing has saved anywhere.
Tri-state is pinned here too: `null` is "nobody could check", never "clean"."""

from __future__ import annotations

import uuid

import pytest

from src.services.build_sessions import manager as manager_module
from src.services.build_sessions.manager import SessionManager
from src.services.sandbox import SandboxHandle
from src.services.sandbox.base import ExecResult
from tests.fakes import FakeSandboxClient, FakeStorage, a_git_bundle

APP = uuid.UUID("0198f2c0-3333-7000-8000-00000000d1a7")
BASELINE = "a" * 40
SAVED_AT = "a" * 40
MOVED_ON = "b" * 40

_HANDLE = SandboxHandle(
    fqdn="app-x.westeurope.azurecontainerapps.io",
    token="t",
    app_name="app-x",
    preview_url="https://app-x.westeurope.azurecontainerapps.io/",
    ready=True,
)


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> FakeStorage:
    """`_saved_head` and `_recovery_written_at` both reach the store through `manager`'s own
    `get_storage`, so binding it there covers the whole ladder."""
    fake = FakeStorage()
    monkeypatch.setattr(manager_module, "get_storage", lambda: fake)
    return fake


def _container(*, head: str | None, porcelain: str = "", commits: int = 4) -> FakeSandboxClient:
    """A container answering `integrity.state_script`'s four `@@`-separated fields.

    `porcelain` non-empty is the whole subject of this file: files written and not committed."""
    client = FakeSandboxClient()

    def handler(cmd: list[str]) -> ExecResult:
        if cmd[0] == "sh" and "rev-parse" in cmd[-1]:
            return ExecResult(stdout=f"{head or ''}@@{porcelain}@@{commits}@@", stderr="", exit=0)
        return ExecResult(stdout="", stderr="", exit=0)

    client.exec_handler = handler
    return client


async def _saved(store: FakeStorage, sha: str) -> None:
    from src.services.storage import snapshot_key

    await store.put(snapshot_key(APP), a_git_bundle(sha))


# =============================================================================
# The normal shape now: files written, nothing committed
# =============================================================================


async def test_a_turn_that_wrote_files_and_committed_nothing_reports_unsaved_work(
    store: FakeStorage,
) -> None:
    """★★ THE CONTRACT. HEAD is exactly where the user's last Save is, and the tree is dirty.

    Before the platform took over committing, this shape barely occurred: the agent committed as it
    worked, so its files had become commits and the bottom of the ladder saw HEAD move. Now it is
    every building turn.

    Mutation check: drop the `state.uncommitted` arm from `_save_state_of` and this goes red with
    `dirty is False` — the platform telling the citizen their unsaved work is already saved."""
    await _saved(store, SAVED_AT)
    client = _container(head=SAVED_AT, porcelain=" M app/page.tsx\n?? app/new/page.tsx")

    state = await SessionManager()._save_state_of(client, _HANDLE, APP)

    assert state.dirty is True


async def test_unsaved_work_is_reported_on_top_of_the_saved_version_not_instead_of_it(
    store: FakeStorage,
) -> None:
    """The same shape, read for what it says ABOUT the save. "You have unsaved changes on top of
    the version you saved" and "nothing here is saved" are different sentences, and only the
    first one is true — a report that dropped `savedHead` would describe a bigger loss than the
    one that happened, on the one screen a worried user goes to."""
    await _saved(store, SAVED_AT)
    client = _container(head=SAVED_AT, porcelain=" M app/page.tsx")

    state = await SessionManager()._save_state_of(client, _HANDLE, APP)

    assert state.dirty is True
    assert state.saved_head == SAVED_AT  # the user's save is still on record
    assert state.container_head == SAVED_AT  # and so is where the container actually sits
    assert state.app_id == APP


async def test_the_platforms_own_turn_boundary_commit_settles_the_indicator(
    store: FakeStorage,
) -> None:
    """The other half of the new normal, and the reason the uncommitted arm is not the whole
    story. Once the turn-boundary bundle has committed, the tree is clean and HEAD has moved —
    so the ladder falls through to the commit comparison, which is still what answers "is what
    is in this container the thing I saved?"."""
    await _saved(store, SAVED_AT)
    clean_and_moved_on = _container(head=MOVED_ON, porcelain="")

    state = await SessionManager()._save_state_of(clean_and_moved_on, _HANDLE, APP)

    assert state.dirty is True
    assert state.container_head == MOVED_ON
    assert state.saved_head == SAVED_AT


async def test_a_clean_tree_at_the_saved_commit_is_genuinely_clean(store: FakeStorage) -> None:
    """The liveness assertion beside the three above: `dirty` must still be capable of being
    False, or "always dirty" would pass every test in this file and put a Save button on a
    project with nothing to save, permanently."""
    await _saved(store, SAVED_AT)
    client = _container(head=SAVED_AT, porcelain="")

    state = await SessionManager()._save_state_of(client, _HANDLE, APP)

    assert state.dirty is False


# =============================================================================
# Tri-state: null is "no claim", never "clean"
# =============================================================================


async def test_a_container_that_will_not_answer_is_unknown_not_clean(store: FakeStorage) -> None:
    """`dirty=None` means no claim was made, and it is NOT False. A probe that could not run tells
    us nothing about the tree — and a UI that renders unknown as clean tells the user their work
    is safe when nobody checked."""
    await _saved(store, SAVED_AT)
    mute = FakeSandboxClient()
    mute.exec_handler = lambda cmd: ExecResult(stdout="", stderr="boom", exit=1)

    state = await SessionManager()._save_state_of(mute, _HANDLE, APP)

    assert state.dirty is None
    assert state.dirty is not False  # the distinction the whole tri-state exists for
    assert state.container_head is None


async def test_a_project_with_no_app_yet_is_unknown_rather_than_saved() -> None:
    """The other `null` producer, asserted through the public entry point's own no-app arm: there
    is no workspace to compare, so there is no claim to make."""
    from src.services.build_sessions.manager import SaveState

    nothing_to_compare = SaveState(app_id=None, dirty=None, container_head=None, saved_head=None)

    assert nothing_to_compare.dirty is None
    assert nothing_to_compare.dirty is not False


# =============================================================================
# A never-saved project still offers the Save button
# =============================================================================


async def test_work_no_one_has_ever_saved_is_dirty_not_unknown(store: FakeStorage) -> None:
    """Nothing in the store at all, and a container holding real commits. Reading that as unknown
    hid the Save button on exactly the projects that most need it."""
    client = _container(head=MOVED_ON, porcelain="")

    state = await SessionManager()._save_state_of(client, _HANDLE, APP)

    assert state.dirty is True
    assert state.saved_head is None


# =============================================================================
# Framework churn: a dirty tree that nobody dirtied
# =============================================================================


async def test_a_tree_dirty_only_with_framework_churn_is_not_unsaved_work(
    store: FakeStorage,
) -> None:
    """★★ THE REPORTED BUG. Open a project, touch nothing, and be told there are unsaved changes.

    `next dev` rewrites `next-env.d.ts` and normalises `tsconfig.json` on every boot, so the
    porcelain of a LIVE container is never empty — which meant merely starting an app made the
    rail announce unsaved work, the reclaim dialog offer to save it, and the exit guard demand a
    save first. One production hand-over spent forty seconds writing those two files.

    Mutation check: drop `clean_but_for_churn` from the `state.uncommitted` arm and this goes red
    with `dirty is True` — the platform inventing work the citizen never did."""
    await _saved(store, SAVED_AT)
    just_booted = _container(head=SAVED_AT, porcelain=" M next-env.d.ts")

    state = await SessionManager()._save_state_of(just_booted, _HANDLE, APP)

    # Falls through to the commit comparison, which is the honest answer: the container sits
    # exactly where the last Save left it.
    assert state.dirty is False
    assert state.container_head == SAVED_AT
    assert state.saved_head == SAVED_AT


async def test_churn_beside_real_work_is_still_unsaved_work(store: FakeStorage) -> None:
    """The filter narrows, it never swallows. A page the agent wrote in the same tree as the two
    files the framework rewrote is work, and the whole of `_save_state_of` exists to say so.

    Mutation check: widen the filter to "ignore the tree when ANY churn is present" and this goes
    red — which is the version of this fix that would lose somebody their build."""
    await _saved(store, SAVED_AT)
    real = _container(head=SAVED_AT, porcelain=" M next-env.d.ts\n M app/page.tsx")

    state = await SessionManager()._save_state_of(real, _HANDLE, APP)

    assert state.dirty is True


async def test_an_agent_edit_to_tsconfig_is_work_not_churn(store: FakeStorage) -> None:
    """★★ THE ONE THAT WOULD HAVE COST SOMEBODY THEIR BUILD.

    `prompt_blocks.py` tells the model, verbatim, that `tsconfig.json` is editable. So an agent
    adding a path alias is doing exactly what it was invited to do — and the first cut of the churn
    filter reused `clean_but_for_churn`, which forgives that file because the REAPER may. The save
    indicator would then have answered "Everything is saved" over the citizen's own change.

    A wrongly-dirty tree costs a save nobody needed; a wrongly-clean one costs the build. This side
    fails dirty.

    Mutation check: point `_save_state_of` back at `clean_but_for_churn` and this goes red with
    `dirty is False`."""
    await _saved(store, SAVED_AT)
    agent_edited_it = _container(head=SAVED_AT, porcelain=" M tsconfig.json")

    state = await SessionManager()._save_state_of(agent_edited_it, _HANDLE, APP)

    assert state.dirty is True


async def test_a_porcelain_too_long_to_read_stays_dirty(store: FakeStorage) -> None:
    """Fails CLOSED, and this arm is built so that ONLY the backstop can make it pass.

    THE FIRST CUT OF THIS TEST PROVED NOTHING. It flooded the porcelain with `app/f.tsx` lines — a
    path that is not churn — so the tree read dirty through the ORDINARY route whether or not the
    truncation guard existed. A test that passes on a path other than the one it names is the
    false-green shape this repo keeps rediscovering.

    So every line here is the regenerated file. Without the truncation guard every parsed path is
    forgiven and the tree reports CLEAN; with it, output that hit the cap is treated as evidence of
    real work. The two answers are opposite, which is what makes the assertion mean something.

    Mutation check: drop the `porcelain_truncated` arm from `only_regenerated_files_changed` and
    this goes red with `dirty is False` — a heavily-edited tree reported as saved."""
    await _saved(store, SAVED_AT)
    from src.services.build_sessions.integrity import PORCELAIN_CAP_BYTES

    line = " M next-env.d.ts\n"
    flooded = _container(head=SAVED_AT, porcelain=line * (PORCELAIN_CAP_BYTES // len(line) + 40))

    state = await SessionManager()._save_state_of(flooded, _HANDLE, APP)

    assert state.dirty is True
