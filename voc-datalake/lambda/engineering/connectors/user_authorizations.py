"""A person's GitHub user authorization of one of the deployment's Apps (7.57.00; docs/autonomous-engineering.md, "Any
public repository": the upstream pull request). The Agents API's side: it never reads a token or a secret back.

A fork connection's runs end with a pull request on the upstream, opened by the broker as the connection's owner with
that person's user access token of the App (``user_auth.py``). The steps, each an administrator's acting for
themselves, the same two-click pattern as the App's creation (``github_apps.py``):

1. **The App's OAuth client** (``set_client``, ``PUT …/github-apps/<id>/oauth`` ``{client_id, client_secret}``): an App
   made from 7.57.00 kept it at its creation; an older one had it discarded, so an administrator generates a new client
   secret on GitHub (the App's settings → Generate a new client secret) and pastes it with the client id. It goes
   straight to ``…/engineering-user-auth/app/<id>/client`` (SecureString, the stack's key), never answered or logged;
   the App's row records its client id (not a secret) and ``oauth``, with an audit row ``github_app_oauth_set``.
2. **Authorize** (``authorize``, ``POST …/github-apps/<id>/authorize``): a single-use state (``AUTHORIZE``, 30
   minutes) and GitHub's authorize link, ``https://github.com/login/oauth/authorize?client_id=…&redirect_uri=<the
   deployment's /agents/connections/github/authorized>&state=…``, which the browser navigates to.
3. **The return** (``complete``, ``POST …/github-apps/authorizations`` ``{code, state}``): GitHub sends the browser to
   the SPA's page, which takes the code and the state out of its address at once (a replace) and posts them once. The
   state is claimed (the same administrator, unexpired, unused), and the code goes to voc-engineering-user-auth
   (``exchange``: the one function that reads the App's client secret and writes the person's token), which answers
   who the person is on GitHub, never a token. The row, ``CONNECTIONS#default`` / ``USER_AUTH#<app>#<sha256 of the
   subject>``, keeps the login, GitHub's user id, when, and when the refresh token expires, with an audit row
   ``github_user_authorized``.
4. **Remove my authorization** (``remove``): the person's token parameter deleted, the row marked removed, an audit row
   ``github_user_authorization_removed``; revoking it on GitHub (Settings → Applications → Authorized GitHub Apps)
   stays the person's.
"""
from __future__ import annotations

import functools
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, Final
from urllib.parse import urlencode

from botocore.exceptions import BotoCoreError, ClientError

from engineering.connectors.connections import (
    PARTITION,
    Actor,
    ConnectionRefused,
    audit_row,
    delete_parameter,
    display_name,
    partition_rows,
    write_audited,
)
from engineering.connectors.github_apps import AUTHORIZE, GitHubApps, parse_app_id, parse_conversion, parse_workspace
from engineering.connectors.user_auth_paths import (
    AUTHORIZED_PATH,
    CLIENT_ID,
    CLIENT_SECRET,
    client_parameter,
    client_value,
    subject_hash,
    user_parameter,
)
from shared.dynamo_values import plain
from shared.logging import logger
from shared.model_fallback import error_code

ROW_PREFIX: Final = 'USER_AUTH#'
AUTHORIZE_URL: Final = 'https://github.com/login/oauth/authorize'
NO_CLIENT: Final = ('the App\'s OAuth client is not stored here: set its client id and a new client secret first '
                    '(GitHub → Settings → Developer settings → GitHub Apps → the App → Generate a new client secret)')
NOT_AUTHORIZED: Final = 'you have not authorized this GitHub App'


#: A person's authorization row written with its audit row (``connections.write_audited``), in this step's words.
_recorded: Final = functools.partial(write_audited, logged='engineering GitHub user authorization not recorded',
                                     changed='the authorization changed meanwhile: authorize again',
                                     failed='the authorization could not be recorded: authorize again')


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def _key(app_id: str, owner: str) -> dict[str, str]:
    return {'pk': PARTITION, 'sk': f'{ROW_PREFIX}{app_id}#{owner}'}


def authorization_view(item: Mapping[str, Any]) -> dict[str, Any]:
    """A person's authorization as the API answers it: never a token."""
    def text(name: str) -> str | None:
        value = item.get(name)
        return value if isinstance(value, str) and value else None

    return {'app_id': str(item.get('app_id', '')), 'login': str(item.get('login', '')),
            'authorized_at': text('authorized_at'), 'refresh_expires_at': text('refresh_expires_at')}


class UserAuthorizations:
    """The steps over voc-agents (``table``), SSM (``ssm``: put and delete only, under ``prefix`` with ``key_id``), the
    deployment's Apps (their rows and single-use states) and voc-engineering-user-auth (``exchange``: its request in,
    its answer out, a ``ConnectionRefused`` for its failures)."""

    def __init__(self, table: Any, ssm: Callable[[], Any], prefix: str, key_id: str, apps: GitHubApps,
                 exchange: Callable[[dict[str, Any]], dict[str, Any]], *, frontend_url: str,
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._table = table
        self._ssm = ssm
        self._prefix = prefix
        self._key_id = key_id
        self._apps = apps
        self._exchange = exchange
        self._frontend_url = frontend_url
        self._clock = clock

    def _require_paths(self) -> None:
        if not (self._prefix and self._key_id and self._frontend_url.startswith('https://')):
            raise ConnectionRefused('unavailable', 'user authorizations cannot be stored here: the deployment names '
                                                   'no path, key or address for them')

    # --- 1. the App's OAuth client --------------------------------------------------------------------------------

    def set_client(self, app_id: str, body: Mapping[str, object], actor: Actor) -> dict[str, Any]:
        """Store App ``app_id``'s OAuth client (an App made before 7.57.00): the App as answered after."""
        self._require_paths()
        if set(body) != {'client_id', 'client_secret'}:
            raise ConnectionRefused('invalid', 'the body is {client_id, client_secret}, as the App\'s settings show '
                                               'them')
        client_id, secret = body['client_id'], body['client_secret']
        if not isinstance(client_id, str) or not CLIENT_ID.fullmatch(client_id.strip()):
            raise ConnectionRefused('invalid', 'client_id is the App\'s client id (Iv…), as its settings show it')
        if not isinstance(secret, str) or not CLIENT_SECRET.fullmatch(secret.strip()):
            raise ConnectionRefused('invalid', 'client_secret is a client secret of the App (40 hexadecimal '
                                               'characters), generated on its settings page')
        item = self._apps.stored(parse_app_id(app_id))
        try:
            self._ssm().put_parameter(Name=client_parameter(self._prefix, app_id), Type='SecureString', Tier='Standard',
                                      Value=client_value(app_id, client_id.strip(), secret.strip()),
                                      KeyId=self._key_id, Overwrite=True)
        except (ClientError, BotoCoreError) as error:
            logger.warning('engineering GitHub App OAuth client not stored',
                           extra={'app_id': app_id, 'error_code': error_code(error)})
            raise ConnectionRefused('unavailable', 'the App\'s OAuth client could not be stored: try again') from None
        at, version = _iso(self._clock()), int(item.get('version', 0)) + 1
        updated = {**item, 'oauth': True, 'client_id': client_id.strip(), 'updated_at': at,
                   'updated_by': display_name(actor.name), 'version': version}
        self._apps.write(updated, item, audit_row({'app_id': app_id}, 'github_app_oauth_set', {
            'client_id': client_id.strip(), 'client_secret': 'stored'}, actor, at, version))
        logger.info('engineering GitHub App OAuth client stored', extra={'app_id': app_id})
        return self._apps.view_of(updated)

    # --- 2. authorize ---------------------------------------------------------------------------------------------

    def redirect_uri(self) -> str:
        return f'{self._frontend_url}{AUTHORIZED_PATH}'

    def authorize(self, app_id: str, body: Mapping[str, object], actor: Actor) -> dict[str, Any]:
        """GitHub's authorize link for App ``app_id`` with a new single-use state (``{authorize_url, expires_at}``)."""
        self._require_paths()
        if not set(body) <= {'workspace'}:
            raise ConnectionRefused('invalid', 'the body is {workspace?}, or none')
        parse_workspace(body.get('workspace'))
        item = self._apps.stored(parse_app_id(app_id))
        client_id = item.get('client_id')
        if item.get('oauth') is not True or not isinstance(client_id, str) or not CLIENT_ID.fullmatch(client_id):
            raise ConnectionRefused('conflict', NO_CLIENT)
        state, expires_at = self._apps.states.mint(AUTHORIZE, actor, app_id=app_id)
        query = urlencode({'client_id': client_id, 'redirect_uri': self.redirect_uri(), 'state': state})
        return {'authorize_url': f'{AUTHORIZE_URL}?{query}', 'expires_at': expires_at}

    # --- 3. the return --------------------------------------------------------------------------------------------

    def complete(self, body: Mapping[str, object], actor: Actor) -> dict[str, Any]:
        """The code exchanged (by voc-engineering-user-auth) for the person's token, kept there; the authorization
        as answered (``{authorization}``), once per state (a replay answers it again)."""
        self._require_paths()
        code, state = parse_conversion(body)
        claim = self._apps.states.claim(state, AUTHORIZE, actor)
        if claim.replay:
            return {'authorization': plain(claim.row['outcome'])}
        app_id, owner = str(claim.row.get('app_id', '')), subject_hash(actor.subject)
        try:
            answer = self._exchange({'action': 'exchange', 'app_id': app_id, 'subject_hash': owner, 'code': code,
                                     'redirect_uri': self.redirect_uri()})
        except ConnectionRefused as refused:
            if refused.kind == 'unavailable':
                self._apps.states.release(state)   # (GitHub or the function did not answer: the code may still work)
            raise
        at = _iso(self._clock())
        before = self._row(app_id, owner)
        version = int((before or {}).get('version', 0)) + 1
        item = {**_key(app_id, owner), 'app_id': app_id, 'login': str(answer.get('login') or ''),
                'user_id': answer.get('user_id') if isinstance(answer.get('user_id'), int) else 0,
                'authorized_at': at, 'by_name': display_name(actor.name), 'version': version,
                **({'refresh_expires_at': answer['refresh_token_expires_at']}
                   if isinstance(answer.get('refresh_token_expires_at'), str) else {})}
        audit = audit_row({'app_id': app_id}, 'github_user_authorized', {'login': item['login']}, actor, at, version)
        _recorded(self._table, item, before, audit, about={'app_id': app_id})
        view = authorization_view(item)
        self._apps.states.settle(state, view)
        logger.info('engineering GitHub user authorization recorded', extra={'app_id': app_id})
        return {'authorization': view}

    def _row(self, app_id: str, owner: str) -> dict[str, Any] | None:
        try:
            item = self._table.get_item(Key=_key(app_id, owner), ConsistentRead=True).get('Item')
        except (ClientError, BotoCoreError) as exc:
            raise ConnectionRefused('unavailable', 'the authorization could not be read: retry') from exc
        return item if isinstance(item, dict) else None

    # --- reads and removal ------------------------------------------------------------------------------------------

    def mine(self, actor: Actor) -> list[dict[str, Any]]:
        """The caller's own authorizations (never another person's), by App."""
        owner = subject_hash(actor.subject)
        try:
            rows = partition_rows(self._table, ROW_PREFIX)
        except (ClientError, BotoCoreError) as exc:
            raise ConnectionRefused('unavailable', 'the authorizations could not be read: retry') from exc
        return [authorization_view(row) for row in rows
                if str(row.get('sk', '')).endswith(f'#{owner}') and row.get('removed') is not True]

    def remove(self, app_id: str, actor: Actor) -> None:
        """The caller's authorization of App ``app_id`` removed: their token parameter first, then the row."""
        self._require_paths()
        owner = subject_hash(actor.subject)
        before = self._row(parse_app_id(app_id), owner)
        if before is None or before.get('removed') is True:
            raise ConnectionRefused('not_found', NOT_AUTHORIZED)
        delete_parameter(self._ssm(), user_parameter(self._prefix, app_id, owner),
                         logged='engineering GitHub user authorization not removed', about={'app_id': app_id},
                         refusal='the authorization could not be removed: remove it again')
        at, version = _iso(self._clock()), int(before.get('version', 0)) + 1
        item = {**before, 'removed': True, 'removed_at': at, 'version': version}
        _recorded(self._table, item, before, audit_row({'app_id': app_id}, 'github_user_authorization_removed',
                                                       {'login': before.get('login')}, actor, at, version),
                  about={'app_id': app_id})
