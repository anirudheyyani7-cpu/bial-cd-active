"""Placing an attached file, and telling the agent it is there (#214 R20/R20a/R11a).

THE TWO HALVES FAIL DIFFERENTLY, WHICH IS WHY BOTH ARE PINNED HERE. A file that is never placed
produces a `missing` from the reader — visible, recoverable. A file that is placed and never
NAMED produces the failure this whole feature exists to remove: the agent does not know a reader
exists, writes its own, and reports the result as confidently as a correct answer.

The naming tests are not cosmetic either. `read_attachment.py` dispatches on `path.suffix` and on
nothing else, so the segment derived here is what decides whether an admitted file is readable at
all — and the display name it is derived from is citizen-supplied text.
"""

from __future__ import annotations

import base64
import uuid

import pytest

from src.services.attachments.materialize import (
    CONTAINER_ATTACHMENTS_ROOT,
    AttachmentDelivery,
    AttachmentPlacementError,
    CodeLaneAttachment,
    code_lane_attachments,
    safe_file_name,
)
from src.services.media.lanes import (
    CSV_MEDIA_TYPE,
    EXCEL_MEDIA_TYPE,
    PPTX_MEDIA_TYPE,
    TSV_MEDIA_TYPE,
    WORD_MEDIA_TYPE,
)
from src.services.sandbox import SandboxError
from src.services.sandbox.base import ExecResult
from tests.factories import ConversationFactory, ProjectFactory, UserFactory
from tests.fakes import FakeStorage
from tests.services.orchestrator.fake_sandbox import FakeSandbox

from src.db.models.attachment import Attachment  # isort: skip


def _file(
    *,
    name: str = "movements.xlsx",
    file_name: str = "movements.xlsx",
    media_type: str = EXCEL_MEDIA_TYPE,
    size: int = 12,
    attachment_id: str = "att_1",
    user_id: uuid.UUID | None = None,
) -> CodeLaneAttachment:
    owner = user_id or uuid.uuid4()
    return CodeLaneAttachment(
        attachment_id=attachment_id,
        display_name=name,
        file_name=file_name,
        media_type=media_type,
        size=size,
        storage_key=f"att/{owner}/{attachment_id}",
    )


def _session(sandbox: FakeSandbox):
    from src.services.orchestrator.deps import SandboxSession

    return SandboxSession(
        sandbox_client=sandbox, handle=sandbox.handle, app_id=uuid.uuid4(), emitter=None
    )


# --- the name on disk (R20a) --------------------------------------------------------------


def test_the_extension_comes_from_the_verified_type_not_from_the_name() -> None:
    """★ THE READER DISPATCHES ON THE SUFFIX AND ON NOTHING ELSE, so the segment built here is
    what decides whether an admitted file can be read at all.

    Two admitted files are unreadable without this. The OOXML door checks the OPC part inside the
    BYTES and never looks at the name, so a workbook may arrive called `Q3 figures` with no
    extension; and `movements.tab` is a name the TSV door accepts on purpose while `.tab` is not a
    key in the reader's table.

    Mutation receipt: return the citizen's own suffix instead and both assertions below go red —
    and in production both files come back `unsupported` from a reader that was never given a
    chance to open them.
    """
    assert safe_file_name("Q3 figures", EXCEL_MEDIA_TYPE) == "Q3_figures.xlsx"
    assert safe_file_name("movements.tab", TSV_MEDIA_TYPE) == "movements.tsv"
    assert safe_file_name("brief.docx", WORD_MEDIA_TYPE) == "brief.docx"
    assert safe_file_name("deck.pptx", PPTX_MEDIA_TYPE) == "deck.pptx"


@pytest.mark.parametrize(
    "hostile",
    [
        "../../etc/passwd",
        "..\\..\\windows\\system32\\config",
        "/etc/shadow",
        "....//....//x",
        "~/.ssh/id_rsa",
        "",
        "...",
    ],
)
def test_a_hostile_display_name_becomes_one_ordinary_segment(hostile: str) -> None:
    """★ The name is citizen-supplied text up to 512 characters and is never trusted as a path.

    Whatever arrives, what leaves is ONE segment: no separator, no `..`, no leading dot, and never
    empty. The supervisor's `_resolve` is a second, independent guard — this is the first, and
    neither is asked to be the only one.
    """
    name = safe_file_name(hostile, CSV_MEDIA_TYPE)

    assert "/" not in name and "\\" not in name
    assert not name.startswith(".") and ".." not in name
    assert name.endswith(".csv") and len(name) > len(".csv")


@pytest.mark.parametrize(
    "names",
    [
        # The ordinary case: the same file attached twice in one conversation.
        ["roster.xlsx", "roster.xlsx"],
        # And the one sanitising CREATES — two distinct names that reduce to one segment.
        ["Q3 report.xlsx", "Q3+report.xlsx"],
    ],
)
def test_two_files_that_land_on_the_same_name_stay_distinct(names: list[str]) -> None:
    """★ Uniqueness is a property of the SET, not of one name — and sanitising makes a collision
    MORE likely rather than less, because it folds distinct punctuation together.

    A later file overwriting an earlier one would leave the note naming two paths while the
    container held one file — the agent told something untrue, which is the failure mode this
    module exists to prevent rather than one it may cause.

    Mutation receipt: drop the `taken` set and the two paths below become equal.
    """
    rows = [
        Attachment(
            user_id=uuid.uuid4(),
            attachment_id=f"att_{i}",
            media_type=EXCEL_MEDIA_TYPE,
            name=name,
            size=1,
            storage_key=f"att/x/{i}",
        )
        for i, name in enumerate(names, start=1)
    ]
    from src.services.attachments.materialize import _named_without_collisions

    first, second = _named_without_collisions(rows)

    assert first.file_name != second.file_name
    assert first.container_path != second.container_path


def test_the_two_paths_are_the_same_file_addressed_two_ways() -> None:
    """The container writes an absolute path (the supervisor's second root is reachable only by
    naming it absolutely); the agent is given the `.attachments/` prefix its read surface vets and
    translates. One derivation, so the two cannot describe different files."""
    file = _file(file_name="rota.xlsx")

    assert file.container_path == f"{CONTAINER_ATTACHMENTS_ROOT}/rota.xlsx"
    assert file.model_path == ".attachments/rota.xlsx"


# --- the placement (R20) ------------------------------------------------------------------


async def test_the_bytes_land_in_the_container_unmodified() -> None:
    """★ THE MISSING LINK, ASSERTED. An Office file is a ZIP and carries CRLF constantly, so it
    must travel through `create_bytes` — the one write action that does not rewrite line endings.

    Mutation receipt: send it as `FileCreate` and the bytes below come back with every `\\r\\n`
    collapsed, which is a corrupt archive the reader refuses as damaged.
    """
    sandbox = FakeSandbox()
    storage = FakeStorage()
    file = _file(size=6)
    storage.objects[file.storage_key] = b"PK\x03\x04\r\n"

    await AttachmentDelivery(files=(file,), storage=storage).place(_session(sandbox))

    assert sandbox.binary_workspace[file.container_path] == b"PK\x03\x04\r\n"


async def test_a_file_already_there_at_the_right_size_is_not_sent_again() -> None:
    """A container that survived the last turn still holds every file placed on it, and re-sending
    four megabytes of base64 per attachment per turn buys nothing.

    Mutation receipt: ignore the listing and the write below happens anyway — correct, but it
    charges every later turn for a transfer with no effect.
    """
    sandbox = FakeSandbox()
    storage = FakeStorage()
    file = _file(size=6)
    storage.objects[file.storage_key] = b"PK\x03\x04\r\n"
    sandbox.default_result = ExecResult(stdout=f"{file.file_name}\t6\n", stderr="", exit=0)

    await AttachmentDelivery(files=(file,), storage=storage).place(_session(sandbox))

    assert file.container_path not in sandbox.binary_workspace


async def test_a_re_upload_under_the_same_name_is_placed_over_the_old_one() -> None:
    """★ THE SIZE IS PART OF THE SKIP, and not for tidiness. A name that matches with a different
    size is a DIFFERENT file: skipping on the name alone would leave last week's roster in the
    container while the note described this week's."""
    sandbox = FakeSandbox()
    storage = FakeStorage()
    file = _file(size=9)
    storage.objects[file.storage_key] = b"PK\x03\x04 new"
    sandbox.default_result = ExecResult(stdout=f"{file.file_name}\t6\n", stderr="", exit=0)

    await AttachmentDelivery(files=(file,), storage=storage).place(_session(sandbox))

    assert sandbox.binary_workspace[file.container_path] == b"PK\x03\x04 new"


async def test_a_failed_listing_places_everything_rather_than_nothing() -> None:
    """The skip is an optimisation and only ever a skip. If the container cannot be listed the
    answer is "nothing is there", which is slower and correct — never "everything is there",
    which would leave the agent reading a file that was never written."""
    sandbox = FakeSandbox()
    storage = FakeStorage()
    file = _file(size=6)
    storage.objects[file.storage_key] = b"PK\x03\x04\r\n"
    sandbox.default_result = ExecResult(stdout="", stderr="find: no such directory", exit=1)

    await AttachmentDelivery(files=(file,), storage=storage).place(_session(sandbox))

    assert file.container_path in sandbox.binary_workspace


async def test_a_file_that_cannot_be_placed_raises_rather_than_carrying_on() -> None:
    """★ THE TURN ENDS. Carrying on answers a question about a file the agent cannot see, and
    every failure mode of that is silent: the reader reports `missing`, and the model either
    apologises or — worse — describes the file from its name.

    Mutation receipt: swallow the `SandboxError` and the call below returns cleanly, which is the
    shape in which a citizen gets a confident answer about a file that was never delivered.
    """
    sandbox = FakeSandbox()
    sandbox.files_error = SandboxError("supervisor said no")
    storage = FakeStorage()
    file = _file(name="salaries.xlsx", size=6)
    storage.objects[file.storage_key] = b"PK\x03\x04\r\n"

    with pytest.raises(AttachmentPlacementError) as caught:
        await AttachmentDelivery(files=(file,), storage=storage).place(_session(sandbox))

    # The sentence is read by the citizen, so it names their file and says what to do.
    assert "salaries.xlsx" in str(caught.value)
    assert "Please try again" in str(caught.value)


async def test_a_blob_that_has_gone_missing_raises_too() -> None:
    """Same rule, other side of the transfer: a row whose object is gone is not a file the turn
    can quietly proceed without."""
    sandbox = FakeSandbox()
    storage = FakeStorage()  # the object is deliberately never seeded
    file = _file(name="gates.csv", media_type=CSV_MEDIA_TYPE)

    with pytest.raises(AttachmentPlacementError) as caught:
        await AttachmentDelivery(files=(file,), storage=storage).place(_session(sandbox))

    assert "gates.csv" in str(caught.value)


# --- the note (R11a) ------------------------------------------------------------------------


def test_the_note_names_the_file_the_path_and_the_reader() -> None:
    """★ THE SINGLE FAILURE THE DESIGN EXISTS TO PREVENT, pinned as three separate presences.

    Without the path the agent looks in the app tree and concludes nothing was uploaded. Without
    the reader it writes its own parser — which takes the first sheet, misses the formulas and
    inlines a photo, and reports all of it as confidently as a correct answer. Without the file's
    own name the citizen's question ("what is in the roster?") does not connect to anything.

    Mutation receipt: remove any one of the three and its assertion goes red.
    """
    note = AttachmentDelivery(
        files=(_file(name="Gate roster.xlsx", file_name="Gate_roster.xlsx", size=4096),),
        storage=FakeStorage(),
    ).note()

    assert "Gate roster.xlsx" in note
    assert ".attachments/Gate_roster.xlsx" in note
    assert "/usr/local/lib/bial/read_attachment.py" in note
    assert "own parser" in note


def test_the_note_says_a_failure_is_an_answer() -> None:
    """The reader always exits 0 and prints one object, including for a damaged file. An agent
    that reads `"ok": false` as a broken command retries it, or falls back to writing its own
    parser — so the contract is stated rather than left to be inferred from one result."""
    note = AttachmentDelivery(files=(_file(),), storage=FakeStorage()).note()

    assert "exits 0" in note
    assert "retry" in note


def test_the_note_says_file_content_is_data_and_never_an_instruction() -> None:
    """★ #214 R18. A cell, a paragraph or a speaker note can say "ignore your previous
    instructions", and the reader will faithfully report it — that is the reader working, not the
    reader failing. The boundary has to be stated somewhere, and the note is the only place the
    agent is told about attachments at all.

    Mutation receipt: drop the sentence and an agent reading a hostile spreadsheet has nothing in
    its context marking that text as someone's data rather than as direction.
    """
    note = AttachmentDelivery(files=(_file(),), storage=FakeStorage()).note()

    assert "never an instruction" in note
    assert "data" in note


def test_the_note_forbids_seeding_the_apps_database_from_an_attachment() -> None:
    """★ #214 R18a. A roster is what the app is built FOR, not what it is built FROM. An agent
    that quietly inserts a thousand rows has made a decision about someone's data that nobody
    asked for and that nothing on screen records."""
    note = AttachmentDelivery(files=(_file(),), storage=FakeStorage()).note()

    assert "database" in note
    assert "built FOR" in note


def test_the_note_says_the_reader_is_the_shipped_copy() -> None:
    """★ #214 R16. Build can edit the reader — it holds an unrestricted `run_command` — but the
    reader lives in the workspace IMAGE, not in the app tree, so the edit dies with the container.
    An agent that fixed it last turn and finds its change gone is one that starts writing its own
    parser again, which is the outcome the whole design removes."""
    note = AttachmentDelivery(files=(_file(),), storage=FakeStorage()).note()

    assert "shipped copy" in note
    assert "rebuilt" in note


def test_the_note_lists_every_file_the_conversation_holds() -> None:
    """A note that named only the newest file would make everything attached earlier invisible on
    the very turn the citizen asks about it."""
    files = (
        _file(attachment_id="att_1", name="a.csv", file_name="a.csv", media_type=CSV_MEDIA_TYPE),
        _file(
            attachment_id="att_2",
            name="b.docx",
            file_name="b.docx",
            media_type=WORD_MEDIA_TYPE,
        ),
    )

    note = AttachmentDelivery(files=files, storage=FakeStorage()).note()

    assert ".attachments/a.csv" in note
    assert ".attachments/b.docx" in note


# --- what the turn can see (R20a) -----------------------------------------------------------


async def _stored(
    db_session,
    storage: FakeStorage,
    *,
    user_id: uuid.UUID,
    attachment_id: str,
    media_type: str,
    name: str,
    conversation_id: uuid.UUID | None,
) -> None:
    key = f"att/{user_id}/{attachment_id}"
    db_session.add(
        Attachment(
            user_id=user_id,
            attachment_id=attachment_id,
            media_type=media_type,
            name=name,
            size=4,
            storage_key=key,
            conversation_id=conversation_id,
        )
    )
    await db_session.flush()
    storage.objects[key] = b"PK\x03\x04"


async def test_the_query_takes_the_code_lane_and_leaves_the_model_lane(db_session) -> None:
    """★ THE LANE BOUNDARY, ON THE PATH THAT PLACES FILES. An image belongs to the model and its
    bytes ride in the prompt; only a code-lane file is written into the container. A widened query
    would put a PNG in the workspace and name it to an agent with no reader for it."""
    storage = FakeStorage()
    user = await UserFactory.create(db_session)
    project = await ProjectFactory.create(db_session, user.id)
    conv = await ConversationFactory.create(db_session, user.id, project_id=project.id)
    await _stored(
        db_session,
        storage,
        user_id=user.id,
        attachment_id="a",
        media_type=EXCEL_MEDIA_TYPE,
        name="book.xlsx",
        conversation_id=conv.id,
    )
    await _stored(
        db_session,
        storage,
        user_id=user.id,
        attachment_id="b",
        media_type="image/png",
        name="shot.png",
        conversation_id=conv.id,
    )

    found = await code_lane_attachments(db_session, user_id=user.id, conversation_id=conv.id)

    assert [f.attachment_id for f in found] == ["a"]


async def test_a_row_with_no_conversation_link_is_still_found_by_its_id(db_session) -> None:
    """★ `conversation_id` IS NULLABLE ON PURPOSE, so the link cannot be the only way in. A file
    the citizen just attached to this message must be readable whether or not it was stamped —
    otherwise it is accepted at the door, charged against the quota, and then invisible, with
    nothing on screen saying so.

    Mutation receipt: drop the id arm and this returns empty.
    """
    storage = FakeStorage()
    user = await UserFactory.create(db_session)
    project = await ProjectFactory.create(db_session, user.id)
    conv = await ConversationFactory.create(db_session, user.id, project_id=project.id)
    await _stored(
        db_session,
        storage,
        user_id=user.id,
        attachment_id="loose",
        media_type=CSV_MEDIA_TYPE,
        name="rows.csv",
        conversation_id=None,
    )

    found = await code_lane_attachments(
        db_session, user_id=user.id, conversation_id=conv.id, attachment_ids=["loose"]
    )

    assert [f.attachment_id for f in found] == ["loose"]


async def test_another_owners_file_is_not_reachable_by_naming_its_id(db_session) -> None:
    """★ OWNERSHIP IS ANDed WITH BOTH WAYS IN. The id arm takes client-supplied tokens, so
    without the owner scope a caller could name someone else's attachment and have the platform
    place it in their own container."""
    storage = FakeStorage()
    mine = await UserFactory.create(db_session)
    theirs = await UserFactory.create(db_session)
    project = await ProjectFactory.create(db_session, mine.id)
    conv = await ConversationFactory.create(db_session, mine.id, project_id=project.id)
    await _stored(
        db_session,
        storage,
        user_id=theirs.id,
        attachment_id="secret",
        media_type=EXCEL_MEDIA_TYPE,
        name="payroll.xlsx",
        conversation_id=None,
    )

    found = await code_lane_attachments(
        db_session, user_id=mine.id, conversation_id=conv.id, attachment_ids=["secret"]
    )

    assert found == []


async def test_the_delivery_round_trips_a_stored_file_into_the_container(db_session) -> None:
    """The whole path in one test: a stored row becomes a placed file at the path the note names,
    which is what makes the agent's first read succeed."""
    storage = FakeStorage()
    sandbox = FakeSandbox()
    user = await UserFactory.create(db_session)
    project = await ProjectFactory.create(db_session, user.id)
    conv = await ConversationFactory.create(db_session, user.id, project_id=project.id)
    await _stored(
        db_session,
        storage,
        user_id=user.id,
        attachment_id="a",
        media_type=EXCEL_MEDIA_TYPE,
        name="Gate roster.xlsx",
        conversation_id=conv.id,
    )

    files = await code_lane_attachments(db_session, user_id=user.id, conversation_id=conv.id)
    delivery = AttachmentDelivery(files=tuple(files), storage=storage)
    await delivery.place(_session(sandbox))

    placed = f"{CONTAINER_ATTACHMENTS_ROOT}/Gate_roster.xlsx"
    assert sandbox.binary_workspace[placed] == b"PK\x03\x04"
    assert ".attachments/Gate_roster.xlsx" in delivery.note()
    # The transfer is base64 on the wire and bytes on disk — asserted because a fake that decoded
    # nothing would let a broken encoder pass.
    assert base64.b64encode(b"PK\x03\x04").decode() != sandbox.binary_workspace[placed].decode(
        "latin-1"
    )
