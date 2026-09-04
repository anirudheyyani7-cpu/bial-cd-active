"""Code continuity across sessions — what survives a reset.

The conversations-PATCH `code` mirror died with the `conversations.code` column and the PATCH
now 400s (pinned in `tests/api/v1/conversations/test_conversations.py`). `current_code` has no
writer on this branch — code truth lives in the build snapshots — and its readers treat a NULL
as "no code yet"; either a writer comes back from the build pipeline or the readers retire with
the column. What stays pinned here is that submit never touches it.

The cross-user prompt-grounding test moved. It posted to the retired `POST /v1/claude` relay; the
same ADR-0004 property is asserted in `tests/api/v1/conversations/test_project_grounding.py`.
"""

from __future__ import annotations

from pydantic_ai.models.test import TestModel
from sqlalchemy import select

from src.config import settings
from src.db.models.app_registry import AppRegistry
from src.db.models.conversation import ChatKind
from src.services.auth.session_jwt import mint_session_jwt
from src.services.build_sessions.appdata import resolve_app_for_project
from tests.factories import ConversationFactory, ProjectFactory, UserFactory

_TTL = settings.auth.access_ttl_seconds


def _cookie(jwt: str) -> dict[str, str]:
    return {"Cookie": f"session={jwt}"}


async def _auth(db_session):
    user = await UserFactory.create(db_session)
    return _cookie(mint_session_jwt(user.id, user.token_version, _TTL)), user


async def _builder_conv(db_session, user_id, project_id):
    return await ConversationFactory.create(
        db_session, user_id, project_id=project_id, kind=ChatKind.BUILD
    )


async def _provision(db_session, user_id, project_id) -> str:
    """Mint the project's app the way the build session does. Commits so the endpoints under
    test read it through their own session."""
    app_id = await resolve_app_for_project(db_session, user_id, project_id)
    await db_session.commit()
    return str(app_id)


async def test_submit_no_longer_touches_current_code(client, db_session, set_chat_model) -> None:
    # INERTNESS GUARD: submit used to backstop `current_code` from its request body. The
    # open-sandbox submit carries NO source — the artifact is the server-side bundle copy —
    # so `current_code` stays exactly what it was (here: NULL, its permanent state now that
    # the PATCH mirror is retired). Asserted against `services/approvals/submit`, because the
    # behaviour lives in the service and not in a route.
    import uuid as _uuid

    from src.db.models.app_registry import ApprovalRoute
    from src.services.approvals.submit import submit_app_for_review
    from src.services.storage import snapshot_key
    from tests.fakes import FakeStorage

    store = FakeStorage()
    headers, user = await _auth(db_session)
    project = await ProjectFactory.create(db_session, user.id)
    await _builder_conv(db_session, user.id, project.id)

    app_id = await _provision(db_session, user.id, project.id)

    store.objects[snapshot_key(_uuid.UUID(app_id))] = (
        b"# v2 git bundle\n" + b"ce" * 20 + b" HEAD\n\nPACK-continuity"
    )
    app_row = await db_session.get(AppRegistry, _uuid.UUID(app_id))
    await submit_app_for_review(
        db_session,
        store,
        user_id=user.id,
        app=app_row,
        declaration={"citizen": {}, "review": {}, "differences": [], "explanation": ""},
        route=ApprovalRoute.SELF_PUBLISH,
    )
    await db_session.commit()

    # The retired backstop stays retired: current_code is untouched by submit.
    row = await db_session.scalar(select(AppRegistry).where(AppRegistry.project_id == project.id))
    assert row is not None
    assert row.current_code is None

    # The documented consequence: with no code recorded, description:generate still 409s.
    set_chat_model(TestModel(custom_output_text="never reached"))
    gen = await client.post(f"/v1/projects/{project.id}/description:generate", headers=headers)
    assert gen.status_code == 409
