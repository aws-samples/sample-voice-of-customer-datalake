"""The token and revocation FACADE of the MCP OAuth server (``POST /oauth/token``, ``POST /oauth/revoke``).

Both forward the client's form to Cognito's hosted-UI endpoints (``/oauth2/token``, ``/oauth2/revoke``)
and add what Cognito cannot know:

* **authorization_code** — the code was delivered through the loopback relay (``shared.mcp_oauth_relay``):
  its binding must name this client and this loopback ``redirect_uri``, and ``redirect_uri`` is put back
  to the relay URL Cognito issued the code for. A code with no binding is accepted only for a client's
  configured NON-loopback callback (it never went through the relay).
* After Cognito answers 200, the new access token's ``origin_jti`` (its refresh chain) is RECORDED on the
  person's grant — only while the consent window is open (``mcp_oauth_grants.chain_window_open``), once
  per consent, and never on a revoked grant. No consent → no chain → every token of it is refused.
* **refresh_token** — the refreshed access token must still belong to a recorded chain of an active grant.
* Any refusal after Cognito already issued tokens revokes the refresh token at Cognito (best effort) and
  answers ``400 invalid_grant``.

The access token is read WITHOUT a signature check here: it is Cognito's own answer over TLS from the
fixed ``COGNITO_DOMAIN_URL``, never a client-presented value (the MCP server verifies every presented
token in full, ``shared.mcp_oauth_jwt``). Refresh tokens are never stored. Nothing here logs a code, a
verifier or a token.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final

import requests

from shared import mcp_oauth_grants as grants
from shared import mcp_oauth_relay as relay
from shared.mcp_oauth_config import OAuthConfig
from shared.mcp_oauth_jwt_parts import unverified_claims
from shared.mcp_oauth_loopback import loopback_path
from shared.mcp_oauth_register import redirect_allowed

COGNITO_TIMEOUT_SECONDS: Final = 10
RECONNECT_MESSAGE: Final = 'Approve the connection on the consent screen, then sign in again'
# Cognito's answer fields a client may see.
_TOKEN_FIELDS: Final = ('access_token', 'id_token', 'refresh_token', 'token_type', 'expires_in')
_ERROR_FIELDS: Final = ('error', 'error_description')


@dataclass(frozen=True)
class FacadeAnswer:
    status: int
    body: dict[str, Any]


class CognitoUnavailable(Exception):
    """Cognito could not be reached or answered something that is not OAuth JSON (a 502)."""


def oauth_error(error: str, description: str, status: int = 400) -> FacadeAnswer:
    return FacadeAnswer(status, {'error': error, 'error_description': description})


def post_to_cognito(config: OAuthConfig, path: str, form: Mapping[str, str]) -> tuple[int, dict[str, Any]]:
    try:
        response = requests.post(f'{config.cognito_domain}{path}', data=dict(form),
                                 timeout=COGNITO_TIMEOUT_SECONDS, allow_redirects=False,
                                 headers={'Content-Type': 'application/x-www-form-urlencoded'})
    except requests.RequestException as exc:
        raise CognitoUnavailable(type(exc).__name__) from exc
    if not response.content:
        return response.status_code, {}
    try:
        body = response.json()
    except ValueError as exc:
        raise CognitoUnavailable('non-JSON answer') from exc
    if not isinstance(body, dict):
        raise CognitoUnavailable('non-object answer')
    return response.status_code, body


@dataclass(frozen=True)
class GrantStore:
    """The two grant operations the facade needs, injected by the router (and fakes in tests)."""

    load: Callable[[str], dict | None]
    record_chain: Callable[[dict, str], bool]


@dataclass(frozen=True)
class Exchange:
    config: OAuthConfig
    jobs_table: Any
    store: GrantStore
    now: datetime
    post: Callable[[OAuthConfig, str, Mapping[str, str]], tuple[int, dict[str, Any]]] = post_to_cognito

    def token(self, form: Mapping[str, str]) -> FacadeAnswer:
        kind = self.config.kind_of(form.get('client_id'))
        if kind is None:
            return oauth_error('invalid_client', 'unknown client', 401)
        grant_type = form.get('grant_type')
        if grant_type == 'authorization_code':
            return self._code(form, kind)
        if grant_type == 'refresh_token':
            if not form.get('refresh_token'):
                return oauth_error('invalid_request', 'refresh_token is required')
            return self._forward_and_check(dict(form), new_chain=False)
        return oauth_error('unsupported_grant_type', 'only authorization_code and refresh_token are supported')

    def revoke(self, form: Mapping[str, str]) -> FacadeAnswer:
        if self.config.kind_of(form.get('client_id')) is None:
            return oauth_error('invalid_client', 'unknown client', 401)
        if not form.get('token'):
            return oauth_error('invalid_request', 'token is required')
        status, body = self.post(self.config, '/oauth2/revoke', {'token': form['token'], 'client_id': form['client_id']})
        return FacadeAnswer(200, {}) if status == 200 else FacadeAnswer(status, _only(body, _ERROR_FIELDS))

    def _code(self, form: Mapping[str, str], kind: str) -> FacadeAnswer:
        code, redirect_uri = form.get('code', ''), form.get('redirect_uri', '')
        if not code or not redirect_uri or not form.get('code_verifier'):
            return oauth_error('invalid_request', 'code, redirect_uri and code_verifier are required')
        forwarded = dict(form)
        binding = relay.consume_code_binding(self.jobs_table, code, self.now)
        if binding is not None:
            if binding.client_id != form['client_id'] or binding.redirect_uri != redirect_uri:
                return oauth_error('invalid_grant', 'the code was issued to another client or redirect URI')
            forwarded['redirect_uri'] = self.config.relay_url
        elif loopback_path(redirect_uri) is not None or not redirect_allowed(kind, redirect_uri, self.config):
            return oauth_error('invalid_grant', 'unknown or already used authorization code')
        return self._forward_and_check(forwarded, new_chain=True)

    def _forward_and_check(self, form: dict[str, str], *, new_chain: bool) -> FacadeAnswer:
        status, body = self.post(self.config, '/oauth2/token', form)
        if status != 200:
            return FacadeAnswer(status if 400 <= status < 500 else 502, _only(body, _ERROR_FIELDS)
                                or {'error': 'server_error'})
        if self._grant_accepts(body.get('access_token'), form['client_id'], new_chain=new_chain):
            return FacadeAnswer(200, _only(body, _TOKEN_FIELDS))
        self._revoke_quietly(body.get('refresh_token') or form.get('refresh_token'), form['client_id'])
        return oauth_error('invalid_grant', RECONNECT_MESSAGE)

    def _token_identity(self, access_token: object, client_id: str) -> tuple[str, str] | None:
        """(sub, origin_jti) of Cognito's fresh access token for ``client_id``, or None."""
        claims = unverified_claims(access_token)
        if claims is None or claims.get('client_id') != client_id or claims.get('token_use') != 'access':
            return None
        sub, origin_jti = claims.get('sub'), claims.get('origin_jti')
        if claims.get('iss') != self.config.cognito_issuer or not isinstance(sub, str) or not sub:
            return None
        return (sub, origin_jti) if grants.is_valid_origin_jti(origin_jti) else None

    def _active_grant(self, sub: str, client_id: str) -> dict | None:
        row = self.store.load(grants.grant_id(sub, client_id))
        return row if grants.is_active_grant_of(row, sub=sub, client_id=client_id, now=self.now) else None

    def _grant_accepts(self, access_token: object, client_id: str, *, new_chain: bool) -> bool:
        identity = self._token_identity(access_token, client_id)
        row = self._active_grant(identity[0], client_id) if identity else None
        if identity is None or row is None:
            return False
        origin_jti = identity[1]
        if not new_chain:
            return origin_jti in grants.chains(row)
        return grants.chain_window_open(row, self.now) and self.store.record_chain(row, origin_jti)

    def _revoke_quietly(self, refresh_token: object, client_id: str) -> None:
        if not isinstance(refresh_token, str) or not refresh_token:
            return
        try:
            self.post(self.config, '/oauth2/revoke', {'token': refresh_token, 'client_id': client_id})
        except CognitoUnavailable:
            return


def _only(body: Mapping[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {field: body[field] for field in fields if field in body}
