"""The project title's word cap, on BOTH write paths. No boundary tests existed
for an over-length name before this — the suite covered an over-length *description* and a
blank name, but nothing pinned the title limit on `POST` or `PATCH`, and the cap lived in two
places (the model constant and the portal's `NAME_MAX`) with nothing holding them together.

Two things these tests hold: (1) create and rename share `_clean_name`, and rename is the path
with no client-side guard, so a server-side hole would actually be reached there; (2) the word
rule is `count_words` = `str.split()`, splitting on RUNS of whitespace — a title typed with a
double space, newline or non-breaking space must count the same as the browser counts it
(`portal/src/utils/words.ts`), or a title that passes there could be refused here."""

from __future__ import annotations

import pytest

from src.core.words import count_words
from src.db.models.project import MAX_PROJECT_NAME, MAX_PROJECT_NAME_WORDS
from tests.api.v1.projects.test_projects_crud import _auth

_PROJECTS = "/v1/projects"


def _words(n: int) -> str:
    """A name of exactly `n` words, each distinct so nothing collapses."""
    return " ".join(f"w{i}" for i in range(n))


# --- create -------------------------------------------------------------------


@pytest.mark.parametrize("n", [1, MAX_PROJECT_NAME_WORDS - 1, MAX_PROJECT_NAME_WORDS])
async def test_create_accepts_a_name_up_to_the_word_cap(client, db_session, n: int) -> None:
    headers, _ = await _auth(db_session)

    resp = await client.post(_PROJECTS, headers=headers, json={"name": _words(n)})

    assert resp.status_code == 201, resp.text
    assert count_words(resp.json()["name"]) == n


async def test_create_refuses_one_word_past_the_cap(client, db_session) -> None:
    headers, _ = await _auth(db_session)

    resp = await client.post(
        _PROJECTS, headers=headers, json={"name": _words(MAX_PROJECT_NAME_WORDS + 1)}
    )

    assert resp.status_code == 422, resp.text
    # Written for a person, not the validator's own words. The portal flattens
    # `detail[].msg` straight to the screen, so this string IS what the user reads.
    assert "about 6 to 8 words" in resp.text
    assert "Value error" not in resp.json().get("detail", [{}])[0].get("msg", "")


async def test_the_character_backstop_still_refuses_an_enormous_single_word(
    client, db_session
) -> None:
    """The word rule alone would accept this — it is a single token — so the character bound
    is not redundant. It is the thing that stops an arbitrary paste reaching a
    `VARCHAR(120)` column, and a user should never meet it."""
    headers, _ = await _auth(db_session)

    resp = await client.post(
        _PROJECTS, headers=headers, json={"name": "x" * (MAX_PROJECT_NAME + 1)}
    )

    assert resp.status_code == 422, resp.text
    assert "characters" in resp.text


# --- rename: the path that had no client guard --------------------------------


async def test_rename_refuses_past_the_cap_too(client, db_session) -> None:
    """`PATCH` is the half the issue calls out as unguarded on the client.

    A hole here is reachable in the product today: the pencil on the project page sends
    whatever it is given.
    """
    headers, _ = await _auth(db_session)
    created = await client.post(_PROJECTS, headers=headers, json={"name": "Visitor Log"})
    project_id = created.json()["id"]

    resp = await client.patch(
        f"{_PROJECTS}/{project_id}",
        headers=headers,
        json={"name": _words(MAX_PROJECT_NAME_WORDS + 1)},
    )

    assert resp.status_code == 422, resp.text
    assert "about 6 to 8 words" in resp.text

    # ...and the stored name is untouched by the refusal.
    after = await client.get(f"{_PROJECTS}/{project_id}", headers=headers)
    assert after.json()["name"] == "Visitor Log"


async def test_rename_accepts_the_boundary(client, db_session) -> None:
    headers, _ = await _auth(db_session)
    created = await client.post(_PROJECTS, headers=headers, json={"name": "Visitor Log"})
    project_id = created.json()["id"]

    resp = await client.patch(
        f"{_PROJECTS}/{project_id}",
        headers=headers,
        json={"name": _words(MAX_PROJECT_NAME_WORDS)},
    )

    assert resp.status_code == 200, resp.text
    assert count_words(resp.json()["name"]) == MAX_PROJECT_NAME_WORDS


# --- the splitting rule, where client and server could drift -------------------


@pytest.mark.parametrize(
    "name",
    [
        "a  b  c  d  e  f  g  h",  # double spaces
        "a\tb\tc\td\te\tf\tg\th",  # tabs
        "a\nb\nc\nd\ne\nf\ng\nh",  # newlines
        "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh",  # CRLF
        "  a b c d e f g h  ",  # leading/trailing
        "a b c d e f g h",  # non-breaking space
    ],
)
async def test_whitespace_runs_count_as_one_separator(client, db_session, name: str) -> None:
    """Eight words however they are spaced — a paste must not silently become nine.

    `str.split()` (no argument) collapses runs and drops empty tokens; `split(" ")` would
    not, and would disagree with the browser. `portal/src/utils/words.ts` pins the mirror
    image of this list, which is the only thing making "the same rule on both sides" a fact
    rather than a claim.
    """
    headers, _ = await _auth(db_session)

    resp = await client.post(_PROJECTS, headers=headers, json={"name": name})

    assert resp.status_code == 201, resp.text
