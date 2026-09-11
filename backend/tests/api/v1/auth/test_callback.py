"""GET /auth/callback — fail-closed validation, provisioning, session mint.

Entra is mocked at the Authlib seam: `get_oauth` is overridden with a fake
whose `authorize_access_token` returns a crafted token dict (or raises), so the
full callback logic runs with no live tenant.
"""

from __future__ import annotations

import re
from typing import Any

import httpx
import pytest
from authlib.integrations.starlette_client import OAuthError
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from structlog.testing import capture_logs

from src.config import settings
from src.db.models.refresh_token import RefreshToken
from src.db.models.user import User
from src.services.auth.cookies import csrf_cookie_name, refresh_cookie_name, session_cookie_name
from src.services.auth.oidc import get_oauth
from src.services.auth.refresh import hash_refresh_token
from tests.factories import UserFactory

_TID = settings.auth.tenant_id
_ABSENT = object()


def _token(**userinfo_overrides: Any) -> dict[str, Any]:
    userinfo: dict[str, Any] = {
        "oid": "entra-oid-new",
        "sub": "entra-sub-new",
        "tid": _TID,
        "email": "citizen@rvaiglobal.com",
        "preferred_username": "citizen@rvaiglobal.com",
        "name": "A Citizen",
    }
    userinfo.update(userinfo_overrides)
    userinfo = {k: v for k, v in userinfo.items() if v is not _ABSENT}
    # The access/id tokens are present in the response but MUST NOT be persisted.
    return {
        "userinfo": userinfo,
        "access_token": "entra-access-secret",
        "id_token": "entra-id-jwt",
    }


class _FakeEntra:
    def __init__(self, *, token: dict[str, Any] | None, error: Exception | None) -> None:
        self._token = token
        self._error = error
        self.redirects: list[dict[str, Any]] = []
        self.redirect_error: Exception | None = None

    async def authorize_access_token(self, request: Any) -> dict[str, Any]:
        if self._error is not None:
            raise self._error
        assert self._token is not None
        return self._token

    async def authorize_redirect(self, request: Any, redirect_uri: str, **kwargs: Any) -> Any:
        # The step-up re-issue. Recorded rather than built, so a test reads exactly which
        # parameters the callback asked Entra for.
        if self.redirect_error is not None:
            raise self.redirect_error
        self.redirects.append({"redirect_uri": redirect_uri, **kwargs})
        return RedirectResponse(
            f"https://login.microsoftonline.com/{_TID}/oauth2/v2.0/authorize?prompt=login",
            status_code=302,
        )


class _FakeOAuth:
    def __init__(self, entra: _FakeEntra) -> None:
        self.entra = entra


def _use_fake_oauth(
    app: Any, *, token: dict[str, Any] | None = None, error: Exception | None = None
) -> _FakeEntra:
    # ONE fake per test, shared across requests, so a test can read what the callback asked
    # Entra for and change the outcome between two callbacks.
    entra = _FakeEntra(token=token, error=error)
    app.dependency_overrides[get_oauth] = lambda: _FakeOAuth(entra)
    return entra


def _set_cookies(resp: httpx.Response) -> dict[str, str]:
    return {raw.split("=", 1)[0].strip(): raw for raw in resp.headers.get_list("set-cookie")}


def _cookie_value(raw: str) -> str:
    return raw.split("=", 1)[1].split(";", 1)[0]


def _assert_login_error(resp: httpx.Response, reason: str) -> str:
    """A failed callback bounces to `/login?authError=<reason>&ref=<correlation id>`.

    The ref is freshly random per request, so it is asserted for SHAPE, not value, and
    returned so a caller can match it against the log line the same request emitted."""
    base, sep, ref = resp.headers["location"].partition("&ref=")
    assert base == f"{settings.FRONTEND_URL}/login?authError={reason}"
    assert sep, "every login-error bounce must carry a ?ref= correlation id"
    assert re.fullmatch(r"[0-9a-f]{8}", ref), f"unexpected correlation id: {ref!r}"
    return ref


# --- provisioning --------------------------------------------------------


async def test_first_signin_provisions_user_and_sets_cookies(app, client, db_session) -> None:
    _use_fake_oauth(app, token=_token(oid="brand-new-oid"))
    resp = await client.get("/v1/auth/callback")

    assert resp.status_code == 302
    assert resp.headers["location"] == settings.FRONTEND_URL

    user = await db_session.scalar(select(User).where(User.azure_oid == "brand-new-oid"))
    assert user is not None
    assert user.email == "citizen@rvaiglobal.com"
    assert user.upn == "citizen@rvaiglobal.com"
    assert user.token_version == 0

    token_count = await db_session.scalar(
        select(func.count()).select_from(RefreshToken).where(RefreshToken.user_id == user.id)
    )
    assert token_count == 1

    cookies = _set_cookies(resp)
    assert {"session", "refresh", "csrf"} <= set(cookies)


async def test_returning_signin_updates_profile_preserves_token_version(
    app, client, db_session
) -> None:
    existing = await UserFactory.create(
        db_session, azure_oid="returning-oid", email="old@rvaiglobal.com", token_version=5
    )
    _use_fake_oauth(app, token=_token(oid="returning-oid", email="new@rvaiglobal.com"))
    resp = await client.get("/v1/auth/callback")

    assert resp.status_code == 302
    # No second row; the same user is updated in place.
    count = await db_session.scalar(
        select(func.count()).select_from(User).where(User.azure_oid == "returning-oid")
    )
    assert count == 1
    await db_session.refresh(existing)
    assert existing.email == "new@rvaiglobal.com"
    assert existing.token_version == 5  # revocation state preserved


# --- fail-closed paths ---------------------------------------------


async def test_wrong_tenant_redirects_to_login_error(app, client, db_session) -> None:
    _use_fake_oauth(
        app, token=_token(oid="foreign-oid", tid="ffffffff-ffff-ffff-ffff-ffffffffffff")
    )
    resp = await client.get("/v1/auth/callback")

    assert resp.status_code == 302
    _assert_login_error(resp, "wrong_tenant")
    assert resp.headers.get_list("set-cookie") == []  # no session minted
    assert await db_session.scalar(select(User).where(User.azure_oid == "foreign-oid")) is None


async def test_missing_userinfo_redirects_to_login_error(app, client, db_session) -> None:
    _use_fake_oauth(app, token={"access_token": "x"})  # no userinfo -> unvalidated
    resp = await client.get("/v1/auth/callback")

    assert resp.status_code == 302
    _assert_login_error(resp, "invalid_callback")
    assert resp.headers.get_list("set-cookie") == []
    assert await db_session.scalar(select(func.count()).select_from(User)) == 0


async def test_cancelled_consent_does_not_500(app, client) -> None:
    _use_fake_oauth(app, error=OAuthError(error="access_denied"))
    resp = await client.get("/v1/auth/callback")

    assert resp.status_code == 302
    _assert_login_error(resp, "auth_failed")
    assert resp.headers.get_list("set-cookie") == []


_HTTP_STATUS_ERROR = httpx.HTTPStatusError(
    "500", request=httpx.Request("GET", "https://x"), response=httpx.Response(500)
)


@pytest.mark.parametrize(
    "boom",
    [
        httpx.ConnectError("entra unreachable"),  # transport blip talking to Entra
        _HTTP_STATUS_ERROR,  # non-2xx from the token/userinfo endpoint
        ValueError("malformed userinfo json"),  # JSONDecodeError is a ValueError subclass
    ],
)
async def test_entra_error_fails_closed_not_500(app, client, boom: Exception) -> None:
    _use_fake_oauth(app, error=boom)
    resp = await client.get("/v1/auth/callback")

    assert resp.status_code == 302
    _assert_login_error(resp, "auth_failed")
    assert resp.headers.get_list("set-cookie") == []


# --- optional-email handling --------------------------------------------


async def test_missing_email_provisions_via_preferred_username(app, client, db_session) -> None:
    _use_fake_oauth(app, token=_token(oid="no-email-oid", email=_ABSENT))
    resp = await client.get("/v1/auth/callback")

    assert resp.status_code == 302
    assert resp.headers["location"] == settings.FRONTEND_URL
    user = await db_session.scalar(select(User).where(User.azure_oid == "no-email-oid"))
    assert user is not None
    assert user.email == "citizen@rvaiglobal.com"  # fell back to preferred_username


async def test_missing_email_and_upn_rejected(app, client, db_session) -> None:
    _use_fake_oauth(app, token=_token(oid="nada-oid", email=_ABSENT, preferred_username=_ABSENT))
    resp = await client.get("/v1/auth/callback")

    assert resp.status_code == 302
    _assert_login_error(resp, "invalid_callback")
    assert await db_session.scalar(select(User).where(User.azure_oid == "nada-oid")) is None


# --- cookie attributes + no-token-persistence ----------------------------------


async def test_cookie_attributes_follow_the_matrix(app, client) -> None:
    _use_fake_oauth(app, token=_token(oid="cookie-oid"))
    resp = await client.get("/v1/auth/callback")
    cookies = _set_cookies(resp)

    # session: HttpOnly, root path.
    assert "HttpOnly" in cookies["session"]
    assert "Path=/;" in cookies["session"] or cookies["session"].rstrip().endswith("Path=/")
    # refresh: HttpOnly, path-scoped to the refresh endpoint, NO Domain (host-only).
    assert "HttpOnly" in cookies["refresh"]
    assert "Path=/api/v1/auth/refresh" in cookies["refresh"]
    assert "Domain=" not in cookies["refresh"]
    # csrf: readable by JS -> NOT HttpOnly.
    assert "HttpOnly" not in cookies["csrf"]


async def test_only_refresh_hash_is_persisted_not_entra_tokens(app, client, db_session) -> None:
    _use_fake_oauth(app, token=_token(oid="hash-oid"))
    resp = await client.get("/v1/auth/callback")

    user = await db_session.scalar(select(User).where(User.azure_oid == "hash-oid"))
    assert user is not None
    row = await db_session.scalar(select(RefreshToken).where(RefreshToken.user_id == user.id))
    assert row is not None
    # The stored hash matches the raw cookie token -> only the hash is at rest, and
    # it is NOT either Entra token.
    raw_refresh = _cookie_value(_set_cookies(resp)["refresh"])
    assert row.token_hash == hash_refresh_token(raw_refresh)
    assert row.token_hash not in ("entra-access-secret", "entra-id-jwt")


@pytest.mark.parametrize("field", ["oid", "sub"])
async def test_missing_oid_or_sub_rejected(app, client, field: str) -> None:
    _use_fake_oauth(app, token=_token(**{field: _ABSENT}))
    resp = await client.get("/v1/auth/callback")
    _assert_login_error(resp, "invalid_callback")


# --- diagnostics: every failure names itself in the log, and on screen -------------


async def test_auth_error_branch_is_logged_not_silent(app, client) -> None:
    """The AuthError branch (wrong tenant / invalid callback) used to `return` with NO
    log call at all, so a rejected sign-in left zero server-side trace. Regression guard."""
    _use_fake_oauth(
        app, token=_token(oid="foreign-oid", tid="ffffffff-ffff-ffff-ffff-ffffffffffff")
    )
    with capture_logs() as logs:
        resp = await client.get("/v1/auth/callback")

    ref = _assert_login_error(resp, "wrong_tenant")
    rejected = [entry for entry in logs if entry["event"] == "auth_callback_rejected"]
    assert len(rejected) == 1
    assert rejected[0]["reason"] == "wrong_tenant"
    # The id in the URL bar IS the id in the log — that is the whole point.
    assert rejected[0]["trace_id"] == ref


async def test_provider_failure_log_carries_the_same_ref_as_the_bounce(app, client) -> None:
    _use_fake_oauth(app, error=OAuthError(error="mismatching_state"))
    with capture_logs() as logs:
        resp = await client.get("/v1/auth/callback")

    ref = _assert_login_error(resp, "auth_failed")
    failed = [entry for entry in logs if entry["event"] == "auth_callback_failed"]
    assert len(failed) == 1
    assert failed[0]["error_type"] == "OAuthError"
    assert "mismatching_state" in failed[0]["detail"]
    assert failed[0]["trace_id"] == ref


async def test_each_failed_callback_gets_a_distinct_ref(app, client) -> None:
    """Two failures must not collapse to one id, or the log line cannot identify which
    attempt a user is holding a screenshot of."""
    _use_fake_oauth(app, error=OAuthError(error="access_denied"))
    first = _assert_login_error(await client.get("/v1/auth/callback"), "auth_failed")
    second = _assert_login_error(await client.get("/v1/auth/callback"), "auth_failed")
    assert first != second


# --- MFA step-up: AADSTS50078 and its family ---------------------------------------------------


def _aadsts(code: str) -> OAuthError:
    return OAuthError(
        error="invalid_grant",
        description=(
            f"AADSTS{code}: Presented multi-factor authentication has expired due to policies "
            "configured by your administrator. Trace ID: 18659dd0 Correlation ID: fc25d9f7"
        ),
    )


def _app_session_cookies(resp: httpx.Response) -> set[str]:
    return {session_cookie_name(), refresh_cookie_name(), csrf_cookie_name()} & set(
        _set_cookies(resp)
    )


@pytest.mark.parametrize("code", ["50076", "50078", "50079", "70044"])
async def test_a_stale_mfa_session_is_sent_back_to_entra_once_with_prompt_login(
    app, client, code: str
) -> None:
    """★ Production, 2026-09-11 (refs b005f1e8, d172da84): Entra silently re-minted a code from a
    browser session whose MFA had expired, the token exchange refused it with AADSTS50078, and
    every "try again" did the same. The callback now asks Entra for a FRESH sign-in instead of
    bouncing to a retry that cannot work. Mutation check: drop the step-up arm and this goes red
    on the auth_failed bounce."""
    entra = _use_fake_oauth(app, error=_aadsts(code))
    with capture_logs() as logs:
        resp = await client.get("/v1/auth/callback")

    assert resp.status_code == 302
    assert resp.headers["location"].startswith("https://login.microsoftonline.com/")
    assert entra.redirects == [{"redirect_uri": settings.auth.redirect_uri, "prompt": "login"}]
    assert _app_session_cookies(resp) == set()  # still no session: failing closed is unchanged
    assert "oauth_transient" in _set_cookies(resp)  # the one-retry marker rides this cookie
    step_up = [entry for entry in logs if entry["event"] == "auth_step_up_redirect"]
    assert len(step_up) == 1
    assert step_up[0]["aadsts"] == code
    assert re.fullmatch(r"[0-9a-f]{8}", step_up[0]["trace_id"])


async def test_a_second_rejection_after_the_step_up_bounces_to_reauth_required_never_loops(
    app, client
) -> None:
    """★ One automatic retry, never a redirect loop between the callback and Entra."""
    entra = _use_fake_oauth(app, error=_aadsts("50078"))
    first = await client.get("/v1/auth/callback")
    assert first.headers["location"].startswith("https://login.microsoftonline.com/")

    second = await client.get("/v1/auth/callback")

    assert second.status_code == 302
    _assert_login_error(second, "reauth_required")
    assert len(entra.redirects) == 1
    assert _app_session_cookies(second) == set()


async def test_a_successful_sign_in_after_the_step_up_clears_the_marker(app, client) -> None:
    entra = _use_fake_oauth(app, error=_aadsts("50078"))
    await client.get("/v1/auth/callback")
    entra._error, entra._token = None, _token()

    signed_in = await client.get("/v1/auth/callback")
    assert signed_in.headers["location"] == settings.FRONTEND_URL
    assert session_cookie_name() in _set_cookies(signed_in)

    # A later stale session gets its one automatic retry again, because success cleared the marker.
    entra._error = _aadsts("50078")
    again = await client.get("/v1/auth/callback")
    assert again.headers["location"].startswith("https://login.microsoftonline.com/")
    assert len(entra.redirects) == 2


async def test_other_entra_rejections_keep_the_generic_bounce(app, client) -> None:
    entra = _use_fake_oauth(
        app,
        error=OAuthError(error="invalid_client", description="AADSTS7000215: Invalid client."),
    )
    resp = await client.get("/v1/auth/callback")
    _assert_login_error(resp, "auth_failed")
    assert entra.redirects == []


@pytest.mark.parametrize(
    "failure",
    [
        pytest.param(httpx.ConnectError("entra unreachable"), id="network"),
        pytest.param(OAuthError(error="server_error", description="metadata refused"), id="oauth"),
        pytest.param(ValueError("malformed discovery document"), id="malformed"),
    ],
)
async def test_a_step_up_that_cannot_reach_entra_falls_closed_to_the_banner(
    app, client, failure: Exception
) -> None:
    entra = _use_fake_oauth(app, error=_aadsts("50078"))
    entra.redirect_error = failure
    resp = await client.get("/v1/auth/callback")
    assert resp.status_code == 302
    _assert_login_error(resp, "reauth_required")
    assert _app_session_cookies(resp) == set()

    # The marker went with the failed attempt, so once Entra answers again the next stale session
    # still gets its one automatic retry. Mutation check: drop the pop in `_step_up`'s failure arm
    # and this goes red on the banner.
    entra.redirect_error = None
    again = await client.get("/v1/auth/callback")
    assert again.headers["location"].startswith("https://login.microsoftonline.com/")


async def test_a_forced_sign_in_that_entra_refuses_again_goes_to_the_banner(app, client) -> None:
    """The login page's own forced sign-in already spent the one retry: a refusal after it is the
    banner, not a second trip to Entra."""
    entra = _use_fake_oauth(app, error=_aadsts("50078"))
    await client.get("/v1/auth/login", params={"prompt": "login"})

    resp = await client.get("/v1/auth/callback")

    _assert_login_error(resp, "reauth_required")
    assert entra.redirects == [{"redirect_uri": settings.auth.redirect_uri, "prompt": "login"}]


async def test_an_ordinary_sign_in_clears_a_forced_one_it_replaced(app, client) -> None:
    """A forced sign-in that was abandoned for the ordinary button must not leave its marker
    behind, or the next stale MFA session would go straight to the banner without its automatic
    retry. Mutation check: drop the pop in `login` and this goes red on the banner."""
    entra = _use_fake_oauth(app, error=_aadsts("50078"))
    await client.get("/v1/auth/login", params={"prompt": "login"})
    await client.get("/v1/auth/login")

    resp = await client.get("/v1/auth/callback")

    assert resp.headers["location"].startswith("https://login.microsoftonline.com/")
    assert len(entra.redirects) == 3
    assert entra.redirects[-1] == {"redirect_uri": settings.auth.redirect_uri, "prompt": "login"}
