"""THE MODE SWITCH IS GONE — this file is its inertness guard.

`POST /v1/conversations/{id}/mode` used to change what a conversation WAS, atomically with a
hidden `[mode changed: …]` marker row so the model could see where in the history its toolset
changed. It went because a chat is one thing or the other from the moment it is created, chosen
once on `POST /conversations` — no second concept to switch between.

This file stays as the removal trace: the route answers 404 (not 405 or 500), nothing can write
a marker row, and a chat's kind never moves after creation.
"""

from __future__ import annotations

import uuid

import sqlalchemy as sa

from src.db.models.conversation import ChatKind, Conversation
from src.db.models.message import Message, MessageEntryKind
from src.services.messages import store
from tests.api.v1.conversations.conftest import _headers
from tests.factories import ConversationFactory, UserFactory


async def _rows(db_session, conversation_id):
    return list(
        await db_session.scalars(
            sa.select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.seq)
        )
    )


async def test_the_retired_route_answers_404_not_405_and_not_500(client, db_session) -> None:
    """404, specifically. A 405 would mean the path still resolves and only the verb is wrong
    — which is what a half-removal looks like — and a 500 would mean it resolves and then
    falls over. Asserted on an EXISTING, OWNED conversation, so nothing else can explain the
    status."""
    user = await UserFactory.create(db_session)
    conv = await ConversationFactory.create(db_session, user.id, kind=ChatKind.PLAN)

    resp = await client.post(
        f"/v1/conversations/{conv.id}/mode", headers=_headers(user), json={"mode": "write"}
    )
    assert resp.status_code == 404


async def test_nothing_was_written_and_the_kind_did_not_move(client, db_session) -> None:
    """The refusal is not merely a status: a hand-crafted request leaves no row behind and the
    chat is still the kind it was created as."""
    user = await UserFactory.create(db_session)
    conv = await ConversationFactory.create(db_session, user.id, kind=ChatKind.PLAN)

    await client.post(
        f"/v1/conversations/{conv.id}/mode", headers=_headers(user), json={"mode": "build"}
    )

    reloaded = await db_session.get(Conversation, conv.id)
    assert reloaded is not None and reloaded.kind is ChatKind.PLAN
    assert await _rows(db_session, conv.id) == []


async def test_an_unknown_conversation_gets_the_same_404(client, db_session) -> None:
    # Same answer for a conversation that does not exist: there is no route, so there is no
    # arm that could distinguish the two and leak existence.
    user = await UserFactory.create(db_session)
    resp = await client.post(
        f"/v1/conversations/{uuid.uuid4()}/mode", headers=_headers(user), json={"mode": "build"}
    )
    assert resp.status_code == 404


def test_no_writer_for_the_marker_exists_and_the_entry_kind_is_gone() -> None:
    """Both halves, because either alone leaves the door open.

    A writer with no enum member fails at run time on the first row it tries to write; an enum
    member with no writer is a label waiting for someone to find a use for it. The PG label is
    deliberately left in place and inert — swapping the type to remove one unreferenced label
    would rewrite the largest table for no behavioural gain — so the Python member is what
    carries the guarantee."""
    assert not hasattr(store, "append_mode_switch_marker")
    assert not hasattr(store, "mode_switch_marker_text")
    assert not hasattr(MessageEntryKind, "MODE_SWITCH")
    assert {member.value for member in MessageEntryKind} == {"turn", "step", "system_event"}
