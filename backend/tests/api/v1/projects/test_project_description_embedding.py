"""The description embedding write path, through the live endpoints (#191 slice 3, R25/R26).

The embedder is resolved through `EmbedderDep`/`embedder_dependency` (`src/services/
embeddings/client.py`), a FastAPI dependency for exactly this reason — these tests swap it
for a `TestEmbeddingModel`-backed `Embedder` via `dependency_overrides`, the same shape
`conftest.py`'s billing/storage overrides already use, rather than reaching the real Foundry
resource (unconfigured in this test environment, `settings.foundry is None`).
"""

from __future__ import annotations

import uuid

import pytest
from pydantic_ai import Embedder
from pydantic_ai.embeddings.test import TestEmbeddingModel

from src.db.models.project import DESCRIPTION_EMBEDDING_DIMENSIONS, Project
from src.services.embeddings import embedder_dependency
from tests.api.v1.projects.conftest import _VALID_DESCRIPTION
from tests.api.v1.projects.test_projects_crud import _auth
from tests.factories import ProjectFactory

_PROJECTS = "/v1/projects"


@pytest.fixture
def fake_embedder(app):
    """Override `EmbedderDep` with a deterministic, no-network `Embedder` for the
    duration of one test — the same shape `conftest.py`'s `_override_billing`/
    `_override_storage` already use for other request-scoped externals.

    `dimensions=DESCRIPTION_EMBEDDING_DIMENSIONS` IS REQUIRED, not the default `8` a bare
    `TestEmbeddingModel()` produces: `description_embedding` is a `vector(1536)` column, and
    pgvector enforces that exact width on write — an 8-wide vector 500s at `db.commit()`
    (a `DataError` outside `write_description_embedding`'s own try/except, which only
    guards the embed call itself, not the flush), not the graceful degrade R26 asks for.
    """
    app.dependency_overrides[embedder_dependency] = lambda: Embedder(
        TestEmbeddingModel(dimensions=DESCRIPTION_EMBEDDING_DIMENSIONS)
    )
    try:
        yield
    finally:
        app.dependency_overrides.pop(embedder_dependency, None)


async def test_create_writes_the_embedding_when_an_embedder_is_configured(
    client, db_session, fake_embedder
) -> None:
    headers, _ = await _auth(db_session)
    resp = await client.post(
        _PROJECTS, headers=headers, json={"name": "X", "description": _VALID_DESCRIPTION}
    )
    assert resp.status_code == 201

    row = await db_session.get(Project, uuid.UUID(resp.json()["id"]))
    assert row is not None
    assert row.description_embedding is not None


async def test_create_leaves_the_embedding_absent_when_none_is_configured(
    client, db_session
) -> None:
    # The suite's own baseline: no `fake_embedder` override, and `settings.foundry is None`
    # in this test environment — R20's documented degrade, not a bug.
    headers, _ = await _auth(db_session)
    resp = await client.post(
        _PROJECTS, headers=headers, json={"name": "X", "description": _VALID_DESCRIPTION}
    )
    assert resp.status_code == 201

    row = await db_session.get(Project, uuid.UUID(resp.json()["id"]))
    assert row is not None
    assert row.description_embedding is None


async def test_patch_refreshes_the_embedding_when_the_description_actually_changes(
    client, db_session, fake_embedder
) -> None:
    headers, user = await _auth(db_session)
    project = await ProjectFactory.create(db_session, user.id, description="original text here")
    await db_session.commit()

    resp = await client.patch(
        f"{_PROJECTS}/{project.id}", headers=headers, json={"description": _VALID_DESCRIPTION}
    )
    assert resp.status_code == 200

    row = await db_session.get(Project, project.id)
    assert row is not None
    assert row.description_embedding is not None


async def test_patch_does_not_re_embed_when_the_description_is_unchanged(
    client, db_session, app
) -> None:
    # A patch that includes `description` with its OWN CURRENT VALUE (e.g. a client that
    # always sends the full form) must not spend an embedding call — R25 says "refreshed
    # WHENEVER IT CHANGES", not on every patch that merely mentions the field. Proven by
    # making the embedder explode if it is ever called at all.
    class _MustNotBeCalled:
        async def embed_documents(self, *_a, **_k):  # pragma: no cover - the point is it isn't
            raise AssertionError("the embedder must not be called when description is unchanged")

    app.dependency_overrides[embedder_dependency] = lambda: _MustNotBeCalled()
    try:
        headers, user = await _auth(db_session)
        project = await ProjectFactory.create(db_session, user.id, description=_VALID_DESCRIPTION)
        await db_session.commit()

        resp = await client.patch(
            f"{_PROJECTS}/{project.id}",
            headers=headers,
            json={"name": "Renamed", "description": _VALID_DESCRIPTION},
        )
        assert resp.status_code == 200, resp.text
    finally:
        app.dependency_overrides.pop(embedder_dependency, None)


async def test_patch_does_not_re_embed_a_patch_that_only_touches_name(
    client, db_session, app
) -> None:
    class _MustNotBeCalled:
        async def embed_documents(self, *_a, **_k):  # pragma: no cover - the point is it isn't
            raise AssertionError("the embedder must not be called when description is absent")

    app.dependency_overrides[embedder_dependency] = lambda: _MustNotBeCalled()
    try:
        headers, user = await _auth(db_session)
        project = await ProjectFactory.create(db_session, user.id, description=_VALID_DESCRIPTION)
        await db_session.commit()

        resp = await client.patch(
            f"{_PROJECTS}/{project.id}", headers=headers, json={"name": "Renamed Only"}
        )
        assert resp.status_code == 200, resp.text
    finally:
        app.dependency_overrides.pop(embedder_dependency, None)


async def test_a_failed_embed_call_still_lets_the_create_succeed(client, db_session, app) -> None:
    # R26: the embedding call is a network round trip that can fail independently of
    # everything else about the write — it must never be the reason a citizen cannot create
    # a project.
    class _Boom:
        async def embed_documents(self, *_a, **_k):
            raise RuntimeError("simulated Foundry timeout")

    app.dependency_overrides[embedder_dependency] = lambda: _Boom()
    try:
        headers, _ = await _auth(db_session)
        resp = await client.post(
            _PROJECTS, headers=headers, json={"name": "X", "description": _VALID_DESCRIPTION}
        )
        assert resp.status_code == 201, resp.text

        row = await db_session.get(Project, uuid.UUID(resp.json()["id"]))
        assert row is not None
        assert row.description is not None  # the write itself landed
        assert row.description_embedding is None  # the embedding simply did not
    finally:
        app.dependency_overrides.pop(embedder_dependency, None)
