"""The deployment's GitHub Apps, made from the app in two clicks (7.45.00; docs/autonomous-engineering.md,
"Repository connectors": "A GitHub App in two clicks"). The Agents API's side: nothing here imports ``cryptography``
or reads a credential back.

1. **Create** (``manifest``, then ``convert``): an administrator asks for a manifest (``{account: user |
   organization, org?, workspace?}``); the answer is the form's target on github.com and the manifest itself (a private App,
   no OAuth on install, its setup asked again on an update, Contents, Pull requests and Issues read and write and
   Metadata read; with the github_issues webhook deployed, its hook on ``/webhooks/github_issues`` and the issues and
   issue_comment events). The browser posts it to GitHub, which creates the App and sends the browser back to
   ``/agents/connections/github/created`` with a ``code`` (good for an hour) and the ``state``: inside the workspace
   the flow started in (``/workspace/<slug>/agents/…``, the request's ``workspace``, 7.49.00), since the manifest is written
   fresh for each creation. The page posts both
   here at once; the code is exchanged with ``POST /app-manifests/<code>/conversions`` (no authentication, over the
   broker's crypto-free transport), and the answer's private key and webhook secret go straight to SSM: the key once
   for the App, ``{prefix}_github-app/<id>/key`` (``{app_id, slug, private_key}``), and its webhook secret, when a
   hook was asked for, ``{prefix}_github-app/<id>/webhook`` (``{webhook_secret}``), both SecureString, standard tier,
   the stack's key, never overwritten, written before the App's row. The client id and secret are discarded.
2. **Install** (``installed``): GitHub sends the browser back to ``/agents/connections/github/installed`` with the
   installation's id and the state minted with the create's answer (or by ``install``, to install it again). The
   token function (``app_tokens.py``, invoked by name) reads the installation with the App's JWT, refusing another
   App's (409), and lists its repositories with a ``metadata: read`` token it revokes. The ``setup_url`` is fixed
   when the App is made and an install can start anywhere, so it stays the top-level page: the SPA takes a return
   there back into the workspace the flow started in (frontend workspace/returnWorkspace.ts). Every repository it lists is
   saved as a connection (``ConnectionStore.save``, its parameter a reference to the App's key:
   ``connections.AppReference``), up to the deployment's ``MAX_CONNECTIONS``; one already connected, an archived one
   and those past the limit are reported, never saved. Then (7.50.02, ``issues_sync.py``) the deployment's GitHub
   Issues source follows: every connection of the App whose switch is on is read by it, and each repository gets the
   ``voc-agent`` label (the answer's ``issues`` block; **Check installation** does the same).

Since 7.57.00 (any public repository): the manifest names the App's callback URL
(``<frontend>/agents/connections/github/authorized``, its user authorization's return: ``user_authorizations.py``), and
the conversion keeps the App's OAuth client (its client id and secret, which GitHub answers with the key) for that
authorization, in the user-auth parameters' path, ``…/engineering-user-auth/app/<id>/client`` (``user_auth.py``),
SecureString, never overwritten, never read here; the row says the client is stored (``oauth``) and its id (not a
secret). An App made before 7.57.00 had its client discarded: ``set_client`` stores the client id and a new client
secret an administrator generates on GitHub. An install state may also be a fork's (``FORK_INSTALL``, minted by
``forks.py``): its return saves the fork's one connection (``Forks.installed``) instead of every repository.

State: each step's state is ``secrets.token_urlsafe(32)``, handed to the browser and never stored; its row,
``CONNECTIONS#default#SETUP`` / ``STATE#<sha256 of it>``, names its purpose (``create`` or ``install``), the
administrator it was minted for (their subject), the account, the App, when it expires (30 minutes) and its ``ttl``
(a day: voc-agents' TTL attribute removes it). A state is used once: one conditional UpdateItem claims it for the same
administrator and purpose, unexpired and unclaimed. A failure before anything is stored (GitHub unreachable, rate
limited or failing, its answer lost or off its shape; a refusal of the installation) releases the claim, so the step
may be posted again (a code GitHub spent meanwhile then answers ``CODE_REFUSED``); the
step's outcome is kept on the row, so the same administrator posting it again (a refresh, React's double effect)
gets the same answer; anything else is one uniform 400 that says nothing of which check failed.

Rows: an App is ``CONNECTIONS#default`` / ``GITHUB_APP#<id>`` (its id, slug, owner, the owner's kind, its page,
whether it has a hook, who made it and when, a version); its creation and removal are audit rows of the same
``LOG#`` shape as the connections' (``github_app_created``, ``github_app_removed``). The partition is the
connections', so every other writer of voc-agents is denied it (``denyHardCapWrites``). An App is removed only while
no connection uses it (409); its parameters go first. Deleting it on GitHub stays the administrator's (its page says
where), and so does renaming it (GitHub → Settings → Developer settings → GitHub Apps → the App → Edit). GitHub
derives an App's slug (its ``github.com/apps/<slug>`` page, the install links) from its name, so a rename can change
it: **Check installation** (``check``) records the slug its installation reports (``app_slug``), and the install links
keep working. The slug is learned from an installation only: an App renamed before its first install (or after its
last connection went) keeps the slug it was made with (docs/autonomous-engineering.md says what to do).
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final
from urllib.parse import quote, urlencode

from botocore.exceptions import BotoCoreError, ClientError

from engineering.connectors.connections import (
    APP_NUMBER,
    KIND_PUBLIC_READ,
    MAX_CONNECTIONS,
    MAX_PARAMETER_BYTES,
    PARTITION,
    Actor,
    AppReference,
    ConnectionRefused,
    ConnectionRequest,
    ConnectionStore,
    app_key_parameter,
    app_webhook_parameter,
    audit_row,
    check_connection_id,
    checked_private_key,
    delete_parameter,
    display_name,
    is_branch_name,
    parse_reason,
    partition_rows,
    write_audited,
)
from engineering.connectors.hosts import HostBusy, HostError
from engineering.connectors.issues_sync import follow_stored
from engineering.connectors.transport import DEFAULT_RETRY_SECONDS, HttpsTransport, Transport, asked_wait, dig, json_of
from engineering.connectors.user_auth_paths import (
    AUTHORIZED_PATH as USER_AUTHORIZED_PATH,
)
from engineering.connectors.user_auth_paths import (
    CLIENT_ID,
    CLIENT_SECRET,
    GITHUB_LOGIN,
    OAUTH_CODE,
    client_parameter,
    client_value,
)
from shared.dynamo_values import plain
from shared.github_rest import GITHUB_API, GITHUB_API_VERSION
from shared.logging import logger
from shared.model_fallback import error_code
from shared.workspace_ids import is_workspace_slug

#: The env vars: the app's own address (``https://<domain>``) and the github_issues webhook's (only when it is
#: deployed); the token function's is ``shared.engineering_agents.APP_TOKENS_FUNCTION_ENV``.
FRONTEND_URL_ENV: Final = 'FRONTEND_URL'
WEBHOOK_URL_ENV: Final = 'GITHUB_APP_WEBHOOK_URL'
#: The most GitHub Apps a deployment keeps (removed ones do not count).
MAX_APPS: Final = 5
APP_ROW_PREFIX: Final = 'GITHUB_APP#'
SETUP_PARTITION: Final = f'{PARTITION}#SETUP'
STATE_PREFIX: Final = 'STATE#'
CREATE: Final = 'create'
INSTALL: Final = 'install'
#: A fork's install (7.57.00, forks.py) and a person's user authorization (user_authorizations.py).
FORK_INSTALL: Final = 'fork_install'
AUTHORIZE: Final = 'authorize'
STATE_SECONDS: Final = 30 * 60
STATE_TTL_SECONDS: Final = 24 * 60 * 60
#: Where GitHub sends the browser back (the SPA's pages; the third, 7.57.00, the user authorization's).
CREATED_PATH: Final = '/agents/connections/github/created'
INSTALLED_PATH: Final = '/agents/connections/github/installed'
AUTHORIZED_PATH: Final = USER_AUTHORIZED_PATH
#: What the App may do: the broker's operations (contents, pull requests and issues, read and write) and metadata.
PERMISSIONS: Final = {'contents': 'write', 'pull_requests': 'write', 'issues': 'write', 'metadata': 'read'}
EVENTS: Final = ('issues', 'issue_comment')
#: An App's name: this and four hex digits (GitHub takes at most 34 characters, a name unique on all of GitHub).
NAME_PREFIX: Final = 'VoC Autonomous Agent '
NAME_SUFFIX_BYTES: Final = 2
#: GitHub's longest App name.
MAX_NAME_CHARS: Final = 34
#: A GitHub organization's login, as the form's target names it.
ORGANIZATION: Final = GITHUB_LOGIN
#: ``secrets.token_urlsafe(32)``.
STATE: Final = re.compile(r'[A-Za-z0-9_-]{43}')
#: GitHub's manifest code, as a path segment (the OAuth code's rule too).
CODE: Final = OAUTH_CODE
_SLUG: Final = re.compile(r'[a-z0-9][a-z0-9-]{0,99}')
_OWNER_TYPES: Final = frozenset({'User', 'Organization'})
_SETUP_ACTIONS: Final = frozenset({'install', 'update'})
API_HOST: Final = GITHUB_API.removeprefix('https://')
#: The one answer to a state that is unknown, expired, already used, or minted for another step or administrator.
STATE_REFUSED: Final = 'this link is no longer valid: start again from Agents → Connections'
CODE_REFUSED: Final = ('GitHub no longer takes this App\'s code (it is good for an hour, once): the App may exist on '
                       'GitHub without its key here. Delete it in GitHub\'s settings (Developer settings → GitHub '
                       'Apps) and create it again')
LOST: Final = ('GitHub\'s answer was lost: if the App shows in GitHub\'s settings without its key here, delete it there '
               'and create it again')
UNDER_WAY: Final = 'this step is already under way: open Agents → Connections in a moment'


@dataclass(frozen=True)
class ConvertedApp:
    """What GitHub's conversion answers that is kept: the App's facts, its private key and webhook secret, and since
    7.57.00 its OAuth client (its id, not a secret, and its secret: '' when GitHub answered none off its shape),
    ``repr`` leaving the secrets out."""

    app_id: str
    slug: str
    owner: str
    owner_type: str
    html_url: str
    private_key: str
    webhook_secret: str
    client_id: str = ''
    client_secret: str = ''

    def __repr__(self) -> str:
        return f'ConvertedApp(app_id={self.app_id!r}, slug={self.slug!r}, owner={self.owner!r})'


@dataclass(frozen=True)
class Claim:
    """A claimed state's row; ``replay``: the same administrator's step again, its ``outcome`` kept."""

    row: Mapping[str, Any]
    replay: bool = False


def _invalid(message: str) -> ConnectionRefused:
    return ConnectionRefused('invalid', message)


def _state_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def app_name(suffix: str) -> str:
    """A new App's name: ``VoC Autonomous Agent <4 hex>`` (25 characters, under GitHub's ``MAX_NAME_CHARS``)."""
    return f'{NAME_PREFIX}{suffix}'[:MAX_NAME_CHARS]


def manifest_for(name: str, frontend_url: str, webhook_url: str, workspace: str = '') -> dict[str, Any]:
    """The App's manifest (GitHub's "Registering a GitHub App from a manifest"): private, no OAuth on install, its
    setup page asked again on an update, the broker's permissions; with ``webhook_url``, its hook and events. The
    creation's return (``redirect_url``) goes back into ``workspace`` when the flow started in one; the setup page
    stays top-level (fixed with the App, while an install may start in any workspace)."""
    base = f'{frontend_url}/workspace/{workspace}' if workspace else frontend_url
    manifest: dict[str, Any] = {
        'name': name, 'url': frontend_url, 'description': 'The VoC data lake\'s engineering agents (this deployment).',
        'redirect_url': f'{base}{CREATED_PATH}', 'setup_url': f'{frontend_url}{INSTALLED_PATH}',
        # (7.57.00: the user authorization's return, top-level like the setup page; no OAuth on install, the
        # authorization is a person's own step, user_authorizations.py)
        'callback_urls': [f'{frontend_url}{AUTHORIZED_PATH}'],
        'public': False, 'request_oauth_on_install': False, 'setup_on_update': True,
        'default_permissions': dict(PERMISSIONS),
    }
    if webhook_url:
        manifest['hook_attributes'] = {'url': webhook_url, 'active': True}
        manifest['default_events'] = list(EVENTS)
    return manifest


def form_target(account: str, org: str, state: str) -> str:
    """Where the browser posts the manifest: the person's own settings, or the organization's."""
    query = urlencode({'state': state})
    if account == 'organization':
        return f'https://github.com/organizations/{org}/settings/apps/new?{query}'
    return f'https://github.com/settings/apps/new?{query}'


def install_target(slug: str, state: str) -> str:
    return f'https://github.com/apps/{quote(slug, safe="")}/installations/new?{urlencode({"state": state})}'


def parse_workspace(value: object) -> str:
    """The workspace a flow started in (its slug, as the platform makes one), or '' for none."""
    if value in (None, ''):
        return ''
    if not isinstance(value, str) or not is_workspace_slug(value):
        raise _invalid('workspace is the slug of the workspace the flow started in (3 to 40 of a-z, 0-9 and "-")')
    return value


def parse_manifest_request(body: Mapping[str, object]) -> tuple[str, str, str]:
    """``{account: user | organization, org?, workspace?}`` → (account, org, workspace); the org's login checked as
    GitHub spells one, the workspace as the platform makes a slug."""
    if not set(body) <= {'account', 'org', 'workspace'} or body.get('account') not in {'user', 'organization'}:
        raise _invalid('the body is {account: "user" or "organization", org?, workspace?}')
    account = str(body['account'])
    org = body.get('org')
    workspace = parse_workspace(body.get('workspace'))
    if account == 'user':
        if org not in (None, ''):
            raise _invalid('org is only for account "organization"')
        return account, '', workspace
    if not isinstance(org, str) or not ORGANIZATION.fullmatch(org.strip()):
        raise _invalid('org is the organization\'s GitHub login (letters, digits and single hyphens, at most 39)')
    return account, org.strip(), workspace


def _state_of(body: Mapping[str, object]) -> str:
    state = body.get('state')
    if not isinstance(state, str) or not STATE.fullmatch(state):
        raise _invalid(STATE_REFUSED)
    return state


def parse_conversion(body: Mapping[str, object]) -> tuple[str, str]:
    """``{code, state}`` → (code, state)."""
    if set(body) != {'code', 'state'} or not isinstance(body['code'], str) or not CODE.fullmatch(body['code']):
        raise _invalid('the body is {code, state}, as GitHub handed them back')
    return body['code'], _state_of(body)


def parse_installation(body: Mapping[str, object]) -> tuple[int, str]:
    """``{installation_id, setup_action, state}`` → (installation id, state). ``setup_action: request`` (an owner must
    approve the installation) is refused here: its return carries no installation yet, and the state stays alive."""
    if set(body) != {'installation_id', 'setup_action', 'state'}:
        raise _invalid('the body is {installation_id, setup_action, state}, as GitHub handed them back')
    if body['setup_action'] == 'request':
        raise _invalid('an owner must approve the installation first: GitHub then sends its installation back')
    if body['setup_action'] not in _SETUP_ACTIONS:
        raise _invalid('setup_action is install or update')
    raw = body['installation_id']
    text = str(raw) if isinstance(raw, int) and not isinstance(raw, bool) else raw
    if not isinstance(text, str) or not APP_NUMBER.fullmatch(text):
        raise _invalid('installation_id is the installation\'s id (digits)')
    return int(text), _state_of(body)


def parse_app_id(app_id: str) -> str:
    if not APP_NUMBER.fullmatch(app_id):
        raise ConnectionRefused('not_found', 'GitHub App not found')
    return app_id


def _canceled(error: Exception) -> bool:
    return isinstance(error, ClientError) and error_code(error) in {
        'ConditionalCheckFailedException', 'TransactionCanceledException'}


class SetupStates:
    """The flow's single-use states over voc-agents (a boto3 ``Table``)."""

    def __init__(self, table: Any, clock: Callable[[], datetime]) -> None:
        self._table = table
        self._clock = clock

    @staticmethod
    def _key(raw: str) -> dict[str, str]:
        return {'pk': SETUP_PARTITION, 'sk': f'{STATE_PREFIX}{_state_hash(raw)}'}

    def mint(self, purpose: str, actor: Actor, **facts: object) -> tuple[str, str]:
        """A new state for ``purpose`` and ``actor`` (``facts``: the account, the org, the App): (it, when it expires)."""
        raw = secrets.token_urlsafe(32)
        now = self._clock()
        expires = now + timedelta(seconds=STATE_SECONDS)
        item = {**self._key(raw), 'purpose': purpose, 'subject': actor.subject, 'created_at': _iso(now),
                'expires_at': int(expires.timestamp()), 'ttl': int(now.timestamp()) + STATE_TTL_SECONDS,
                **{name: value for name, value in facts.items() if value not in (None, '')}}
        try:
            self._table.put_item(Item=item, ConditionExpression='attribute_not_exists(sk)')
        except (ClientError, BotoCoreError) as error:
            logger.warning('engineering GitHub App state not stored', extra={'error_code': error_code(error)})
            raise ConnectionRefused('unavailable', 'the step could not be started: try again') from None
        return raw, _iso(expires)

    def claim(self, raw: str, purpose: str | tuple[str, ...], actor: Actor) -> Claim:
        """Claim ``raw`` for ``purpose`` (or any of several: an install's return may be a fork's, 7.57.00) and
        ``actor`` once (``STATE_REFUSED`` otherwise); the same administrator's step again, once it has its outcome,
        is a replay."""
        purposes = (purpose,) if isinstance(purpose, str) else purpose
        now = int(self._clock().timestamp())
        names = {'#subject': 'subject', '#purpose': 'purpose', '#expires': 'expires_at', '#used': 'used_at'}
        allowed = {f':purpose{n}': name for n, name in enumerate(purposes)}
        try:
            claimed = self._table.update_item(
                Key=self._key(raw), UpdateExpression='SET #used = :now',
                ConditionExpression=('attribute_exists(sk) AND #subject = :subject AND #purpose IN '
                                     f'({", ".join(allowed)}) AND #expires > :now AND attribute_not_exists(#used)'),
                ExpressionAttributeNames=names, ExpressionAttributeValues={
                    ':now': now, ':subject': actor.subject, **allowed},
                ReturnValues='ALL_NEW')
        except (ClientError, BotoCoreError) as error:
            if not _canceled(error):
                logger.warning('engineering GitHub App state not claimed', extra={'error_code': error_code(error)})
                raise ConnectionRefused('unavailable', 'the step could not be checked: try again') from None
            return self._refused(raw, purposes, actor, now)
        return Claim(claimed['Attributes'])

    def _refused(self, raw: str, purposes: tuple[str, ...], actor: Actor, now: int) -> Claim:
        try:
            row = self._table.get_item(Key=self._key(raw), ConsistentRead=True).get('Item')
        except (ClientError, BotoCoreError):
            raise ConnectionRefused('unavailable', 'the step could not be checked: try again') from None
        if row is None:
            raise _invalid(STATE_REFUSED)
        mine = (row.get('subject') == actor.subject and row.get('purpose') in purposes
                and int(row.get('expires_at', 0)) > now and row.get('used_at') is not None)
        if mine and isinstance(row.get('outcome'), dict):
            return Claim(row, replay=True)
        if mine:
            raise ConnectionRefused('conflict', UNDER_WAY)
        raise _invalid(STATE_REFUSED)

    def release(self, raw: str) -> None:
        """Give a claimed state back after a failure that changed nothing (best effort: logged, never raised)."""
        try:
            self._table.update_item(Key=self._key(raw), UpdateExpression='REMOVE #used',
                                    ConditionExpression='attribute_exists(#used) AND attribute_not_exists(#outcome)',
                                    ExpressionAttributeNames={'#used': 'used_at', '#outcome': 'outcome'})
        except (ClientError, BotoCoreError) as error:
            logger.warning('engineering GitHub App state not released', extra={'error_code': error_code(error)})

    def settle(self, raw: str, outcome: Mapping[str, Any]) -> None:
        """Keep the step's outcome on its row, for a replay (best effort: the step itself is done)."""
        try:
            self._table.update_item(Key=self._key(raw), UpdateExpression='SET #outcome = :outcome',
                                    ExpressionAttributeNames={'#outcome': 'outcome'},
                                    ExpressionAttributeValues={':outcome': dict(outcome)})
        except (ClientError, BotoCoreError) as error:
            logger.warning('engineering GitHub App outcome not kept', extra={'error_code': error_code(error)})


def app_view(item: Mapping[str, Any], connections: Sequence[str]) -> dict[str, Any]:
    """A stored App as the API answers it (never a secret): its facts and the connections that use it."""
    def text(name: str) -> str | None:
        value = item.get(name)
        return value if isinstance(value, str) and value else None

    return {'app_id': str(item.get('app_id', '')), 'slug': str(item.get('slug', '')), 'owner': str(item.get('owner', '')),
            'owner_type': str(item.get('owner_type', '')), 'html_url': str(item.get('html_url', '')),
            'webhook': item.get('webhook') is True, 'connections': sorted(connections),
            'created_at': text('created_at'), 'created_by': text('created_by'), 'version': int(item.get('version', 0)),
            # (7.57.00: whether its OAuth client is stored, for the user authorization, and its id: not a secret)
            'oauth': item.get('oauth') is True, 'client_id': text('client_id')}


def connection_id_for(repository: str, taken: set[str]) -> str:
    """A connection id for ``repository``: its name in lower case, other characters ``-``, then ``-2``, ``-3``… while
    ``taken`` has it."""
    # (stripped before it is cut: it starts with a letter or a digit, as CONNECTION_ID needs, and the suffix fits 63)
    name = re.sub(r'[^a-z0-9-]+', '-', repository.split('/', 1)[-1].lower()).strip('-')[:58] or 'repository'
    candidate, n = name, 1
    while candidate in taken:
        n += 1
        candidate = f'{name}-{n}'
    return check_connection_id(candidate)


class GitHubApps:
    """The Apps over voc-agents (``table``), SSM (``ssm``, under ``prefix`` with ``key_id``), the connections
    (``connections``) and the token function (``tokens``: its request in, its answer out, a ``ConnectionRefused`` for
    its failures). ``transport``: GitHub's conversion (tests inject a fake). ``issues``: the GitHub Issues source's
    follow of the connections (issues_sync.py ``IssuesFollow``; None: no ``issues`` block)."""

    def __init__(self, table: Any, ssm: Callable[[], Any], prefix: str, key_id: str, connections: ConnectionStore,
                 tokens: Callable[[dict[str, Any]], dict[str, Any]], *, frontend_url: str, webhook_url: str = '',
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC), transport: Transport | None = None,
                 issues: Any = None, user_prefix: str = '') -> None:
        self._table = table
        self._ssm = ssm
        self._prefix = prefix
        self._key_id = key_id
        self._connections = connections
        self._tokens = tokens
        self._frontend_url = frontend_url
        self._webhook_url = webhook_url
        self._clock = clock
        self._transport = transport or HttpsTransport(host=API_HOST)
        self._issues = issues
        #: The user-auth parameters' prefix (7.57.00; '' where the deployment names none: no OAuth client is kept).
        self._user_prefix = user_prefix
        #: A fork's install (7.57.00, ``forks.Forks``; None: a fork's state is refused as any other step's).
        self.forks: Any = None
        self.states = SetupStates(table, clock)

    # --- reads ------------------------------------------------------------------------------------------------

    def _apps(self) -> list[dict[str, Any]]:
        try:
            rows = partition_rows(self._table, APP_ROW_PREFIX)
        except (ClientError, BotoCoreError) as exc:
            raise ConnectionRefused('unavailable', 'the GitHub Apps could not be read: retry') from exc
        return [row for row in rows if row.get('removed') is not True]

    def _users(self) -> dict[str, list[dict[str, Any]]]:
        """The stored connections that use each App (by its id), as the connections answer them."""
        found: dict[str, list[dict[str, Any]]] = {}
        for connection in self._connections.list():
            credential = connection['credential']
            # (7.57.00: a public repository read through the App's token uses it too)
            if credential.get('kind') in ('app_reference', KIND_PUBLIC_READ) and credential.get('app_id'):
                found.setdefault(str(credential['app_id']), []).append(connection)
        return found

    def _app(self, app_id: str) -> dict[str, Any]:
        try:
            item = self._table.get_item(Key=self._app_key(parse_app_id(app_id)), ConsistentRead=True).get('Item')
        except (ClientError, BotoCoreError) as exc:
            raise ConnectionRefused('unavailable', 'the GitHub App could not be read: retry') from exc
        if item is None or item.get('removed') is True:
            raise ConnectionRefused('not_found', 'GitHub App not found')
        return item

    @staticmethod
    def _app_key(app_id: str) -> dict[str, str]:
        return {'pk': PARTITION, 'sk': f'{APP_ROW_PREFIX}{app_id}'}

    def list(self) -> list[dict[str, Any]]:
        """The stored Apps, oldest first, each with the connections that use it."""
        users = self._users()
        apps = [app_view(item, [str(c['connection_id']) for c in users.get(str(item.get('app_id')), [])])
                for item in self._apps()]
        return sorted(apps, key=lambda app: (app['created_at'] or '', app['app_id']))

    def _view(self, item: Mapping[str, Any]) -> dict[str, Any]:
        users = self._users().get(str(item.get('app_id')), [])
        return app_view(item, [str(c['connection_id']) for c in users])

    def stored(self, app_id: str) -> dict[str, Any]:
        """A stored App's row (404 for none or a removed one): the fork workflow's and the user authorization's read
        of its slug and OAuth client id (7.57.00)."""
        return self._app(app_id)

    def view_of(self, item: Mapping[str, Any]) -> dict[str, Any]:
        """``item`` (an App's row) as the API answers it, with the connections that use it."""
        return self._view(item)

    def write(self, item: Mapping[str, Any], before: Mapping[str, Any], audit: Mapping[str, Any]) -> None:
        """An App's row changed (conditioned on the version ``before`` read) with its audit row (7.57.00: its OAuth
        client set, ``user_authorizations.py``)."""
        self._write(item, before, audit)

    # --- 1. create -------------------------------------------------------------------------------------------

    def _require_room(self) -> None:
        if len(self._apps()) >= MAX_APPS:
            raise ConnectionRefused('conflict', f'at most {MAX_APPS} GitHub Apps: remove one to create another')

    def manifest(self, body: Mapping[str, object], actor: Actor) -> dict[str, Any]:
        """The manifest and the form's target for the administrator's account (409 at ``MAX_APPS``)."""
        account, org, workspace = parse_manifest_request(body)
        if not self._frontend_url.startswith('https://') or not (self._prefix and self._key_id):
            raise ConnectionRefused('unavailable', 'GitHub Apps cannot be made here: the deployment names no address '
                                                   'or parameter path')
        self._require_room()
        state, expires_at = self.states.mint(CREATE, actor, account=account, org=org,
                                             webhook=bool(self._webhook_url))
        name = app_name(secrets.token_hex(NAME_SUFFIX_BYTES))
        return {'action_url': form_target(account, org, state),
                'manifest': manifest_for(name, self._frontend_url, self._webhook_url, workspace), 'expires_at': expires_at}

    def convert(self, body: Mapping[str, object], actor: Actor) -> dict[str, Any]:
        """Exchange GitHub's code for the App's key (stored in SSM, never answered), store the App, and answer it with
        its install link (a new install state)."""
        code, state = parse_conversion(body)
        claim = self.states.claim(state, CREATE, actor)
        if claim.replay:
            if claim.row['outcome'].get('refused') == 'code':
                raise ConnectionRefused('conflict', CODE_REFUSED)
            return self._conversion_answer(self._app(str(claim.row['outcome'].get('app_id', ''))), actor)
        try:
            self._require_room()
            converted = self._exchange(code)
        except ConnectionRefused as refused:
            if refused.kind == 'conflict' and str(refused) == CODE_REFUSED:
                self.states.settle(state, {'refused': 'code'})   # (GitHub's last word on this code: said again)
            else:
                self.states.release(state)   # (nothing changed: GitHub kept the code, or never answered)
            raise
        item = self._store(converted, actor, webhook=claim.row.get('webhook') is True)
        self.states.settle(state, {'app_id': converted.app_id})
        return self._conversion_answer(item, actor)

    def _conversion_answer(self, item: Mapping[str, Any], actor: Actor) -> dict[str, Any]:
        install_url, expires_at = self._install_link(item, actor)
        return {'app': self._view(item), 'install_url': install_url, 'expires_at': expires_at}

    def _exchange(self, code: str) -> ConvertedApp:
        headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'voc-agents-api',
                   'X-GitHub-Api-Version': GITHUB_API_VERSION}
        try:
            response = self._transport.request('POST', f'/app-manifests/{quote(code, safe="")}/conversions',
                                               headers, None)
        except HostBusy:
            raise ConnectionRefused('unavailable', 'GitHub could not be reached: try again') from None
        except HostError:
            raise ConnectionRefused('unavailable', LOST) from None
        if response.status in (404, 422):
            raise ConnectionRefused('conflict', CODE_REFUSED)
        # (a 403 is a rate limit only while it says no request is left, as the broker's client reads it)
        busy = response.status == 429 or (response.status == 403 and asked_wait(
            response, 'x-ratelimit-reset', self._clock().timestamp(), reset_needs_empty='x-ratelimit-remaining')
            is not None)
        if busy or response.status >= 500:
            raise ConnectionRefused('unavailable', f'GitHub is busy ({response.status}): try again in '
                                                   f'{DEFAULT_RETRY_SECONDS} seconds')
        if response.status != 201:
            raise ConnectionRefused('unavailable', f'GitHub answered {response.status} to the App\'s code: {LOST}')
        try:
            return _converted(json_of(response))
        except (HostError, ConnectionRefused):
            raise ConnectionRefused('unavailable', LOST) from None

    def _store(self, app: ConvertedApp, actor: Actor, *, webhook: bool) -> dict[str, Any]:
        """The App's key (and webhook secret) in SSM first, then its row with its audit row; a row that cannot be
        written takes the parameters away again (the key is then lost: the App is deleted on GitHub and made again)."""
        names = [app_key_parameter(self._prefix, app.app_id)]
        values = [json.dumps({'app_id': app.app_id, 'slug': app.slug, 'private_key': app.private_key})]
        hooked = bool(webhook and app.webhook_secret)
        if hooked:
            names.append(app_webhook_parameter(self._prefix, app.app_id))
            values.append(json.dumps({'webhook_secret': app.webhook_secret}))
        # (7.57.00: its OAuth client, for the user authorization, outside the connections' path)
        oauth = bool(self._user_prefix and app.client_id and app.client_secret)
        if oauth:
            names.append(client_parameter(self._user_prefix, app.app_id))
            values.append(client_value(app.app_id, app.client_id, app.client_secret))
        if any(len(value.encode()) > MAX_PARAMETER_BYTES for value in values):
            raise ConnectionRefused('unavailable', f'GitHub\'s key for the App is larger than a parameter holds: {LOST}')
        put: list[str] = []
        try:
            for name, value in zip(names, values, strict=True):
                self._ssm().put_parameter(Name=name, Value=value, Type='SecureString', KeyId=self._key_id,
                                          Overwrite=False, Tier='Standard')
                put.append(name)
        except (ClientError, BotoCoreError) as error:
            logger.warning('engineering GitHub App key not stored',
                           extra={'app_id': app.app_id, 'error_code': error_code(error)})
            self._delete(put, app.app_id)
            raise ConnectionRefused('unavailable', f'the App\'s key could not be stored: {LOST}') from None
        at, who = _iso(self._clock()), display_name(actor.name)
        item = {**self._app_key(app.app_id), 'app_id': app.app_id, 'slug': app.slug, 'owner': app.owner,
                'owner_type': app.owner_type, 'html_url': app.html_url, 'webhook': hooked,
                'created_at': at, 'created_by': who, 'updated_at': at, 'updated_by': who, 'version': 1,
                **({'oauth': True, 'client_id': app.client_id} if oauth else {})}
        changes = {'slug': app.slug, 'owner': app.owner, 'owner_type': app.owner_type, 'webhook': hooked,
                   'key': 'stored', **({'client_secret': 'stored'} if oauth else {})}
        try:
            self._write(item, None, audit_row({'app_id': app.app_id}, 'github_app_created', changes, actor, at, 1))
        except ConnectionRefused:
            self._delete(put, app.app_id)
            raise ConnectionRefused('unavailable', f'the App could not be recorded: {LOST}') from None
        logger.info('engineering GitHub App created', extra={'app_id': app.app_id, 'webhook': hooked, 'oauth': oauth})
        return item

    def _delete(self, names: Sequence[str], app_id: str) -> None:
        ssm = self._ssm()
        for name in names:
            delete_parameter(ssm, name, logged='engineering GitHub App parameter not removed', about={'app_id': app_id},
                             refusal='the App\'s key could not be removed: remove it again')

    def _write(self, item: Mapping[str, Any], before: Mapping[str, Any] | None, audit: Mapping[str, Any]) -> None:
        write_audited(self._table, item, before, audit, logged='engineering GitHub App not recorded',
                      about={'app_id': item.get('app_id')},
                      changed='the GitHub App changed meanwhile: reload and try again',
                      failed='the GitHub App could not be recorded: try again')

    # --- 2. install -------------------------------------------------------------------------------------------

    def _install_link(self, item: Mapping[str, Any], actor: Actor) -> tuple[str, str]:
        state, expires_at = self.states.mint(INSTALL, actor, app_id=str(item.get('app_id', '')))
        return install_target(str(item.get('slug', '')), state), expires_at

    def install(self, app_id: str, actor: Actor) -> dict[str, Any]:
        """A new install link for a stored App (to install it on more repositories, or once more)."""
        install_url, expires_at = self._install_link(self._app(app_id), actor)
        return {'install_url': install_url, 'expires_at': expires_at}

    def installed(self, body: Mapping[str, object], actor: Actor) -> dict[str, Any]:
        """Save a connection for each repository the installation lists (``_save_all``), once per install state."""
        installation_id, state = parse_installation(body)
        claim = self.states.claim(state, (INSTALL, FORK_INSTALL) if self.forks is not None else INSTALL, actor)
        app_id = str(claim.row.get('app_id', ''))
        if claim.replay:
            # (its numbers ints again, not DynamoDB's Decimals: the replay answers as the step first did)
            return {**plain(claim.row['outcome']), 'app': self._view(self._app(app_id))}
        if claim.row.get('purpose') == FORK_INSTALL and self.forks is not None:
            # (7.57.00: a fork's install saves the fork's one connection: forks.py)
            try:
                outcome = self.forks.installed(claim.row, installation_id, actor)
            except ConnectionRefused:
                self.states.release(state)
                raise
            self.states.settle(state, outcome)
            return {**outcome, 'app': self._view(self._app(app_id))}
        try:
            item = self._app(app_id)
            inspected = self._tokens({'action': 'inspect_installation', 'app_id': app_id,
                                      'installation_id': installation_id})
        except ConnectionRefused:
            self.states.release(state)
            raise
        connections, skipped = self._save_all(app_id, installation_id, inspected, actor)
        account = dig(inspected, 'account')
        outcome = {'account': {'login': str(dig(account, 'login') or ''), 'type': str(dig(account, 'type') or '')},
                   'connections': connections, 'skipped': skipped, 'issues': self._follow(app_id, actor)}
        self.states.settle(state, outcome)
        logger.info('engineering GitHub App installed', extra={
            'app_id': app_id, 'installation_id': installation_id, 'connections': len(connections),
            'skipped': len(skipped)})
        return {**outcome, 'app': self._view(item)}

    def _save_all(self, app_id: str, installation_id: int, inspected: Mapping[str, Any],
                  actor: Actor) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        stored = self._connections.list()
        connected = {str(c['repository']).lower() for c in stored}
        taken = {str(c['connection_id']) for c in stored}
        room = MAX_CONNECTIONS - len(stored)
        saved: list[dict[str, Any]] = []
        skipped: list[dict[str, str]] = []
        listed = dig(inspected, 'repositories')
        for repository in listed if isinstance(listed, list) else []:
            name = str(dig(repository, 'repository') or '')
            reason = ('archived' if dig(repository, 'archived') is True else 'already_connected'
                      if name.lower() in connected else 'limit' if len(saved) >= room else '')
            if reason:
                skipped.append({'repository': name, 'reason': reason})
                continue
            connection_id = connection_id_for(name, taken)
            request = ConnectionRequest(host='github', repository=name, default_branch=str(
                dig(repository, 'default_branch') or ''), credential=AppReference(app_id, installation_id),
                repository_private=dig(repository, 'private') is True)
            try:
                if not is_branch_name(request.default_branch):
                    raise _invalid('the repository\'s default branch is not one the connections take')
                connection, created = self._connections.save(connection_id, request, actor)
            except ConnectionRefused as refused:
                logger.warning('engineering GitHub App connection not saved',
                               extra={'app_id': app_id, 'connection_id': connection_id, 'kind': refused.kind})
                skipped.append({'repository': name, 'reason': 'not_saved'})
                continue
            taken.add(connection_id)
            connected.add(name.lower())
            saved.append({'connection': connection, 'created': created})
        return saved, skipped

    def _follow(self, app_id: str, actor: Actor) -> dict[str, Any] | None:
        """The GitHub Issues source's follow of the App's stored connections (issues_sync.py ``follow_app``: never
        raises; None where the source is not deployed or no follow is wired)."""
        return follow_stored(self._issues, app_id, self._connections, actor)

    def check(self, app_id: str, actor: Actor | None = None) -> dict[str, Any]:
        """The repositories each installation the App's connections name now covers, and the connections whose
        repository it no longer does (``missing``: the broker refuses them, failing closed). An App renamed on GitHub
        has a new slug: the one its installation reports is recorded (``_renamed``), so its install links keep working.
        With ``actor``, the GitHub Issues source follows the App's connections again (``issues``)."""
        item = self._app(app_id)
        # (a public repository read only is not in the installation its token comes from: never "missing")
        users = [c for c in self._users().get(app_id, []) if c.get('kind') != KIND_PUBLIC_READ]
        installations: dict[str, list[dict[str, Any]]] = {}
        for connection in users:
            installations.setdefault(str(connection['credential'].get('installation_id') or ''), []).append(connection)
        repositories: set[str] = set()
        missing: list[str] = []
        slugs: set[str] = set()
        for installation_id, connections in installations.items():
            covered, truncated, slug = self._covered(app_id, installation_id)
            repositories |= covered
            slugs |= {slug} if slug else set()
            missing += [str(c['connection_id']) for c in connections
                        if not truncated and str(c['repository']).lower() not in {r.lower() for r in covered}]
        if len(slugs) == 1 and actor is not None:
            self._renamed(item, slugs.pop(), actor)
        issues = self._follow(app_id, actor) if actor is not None else None
        return {'repositories': sorted(repositories), 'missing': sorted(missing), 'issues': issues}

    def _renamed(self, item: Mapping[str, Any], slug: str, actor: Actor) -> None:
        """Record ``slug``, the one GitHub reports now, when the App's row names another (the App was renamed on
        GitHub), with its page and an audit row; a row that changed meanwhile is left as it is (the next check
        records it)."""
        before = str(item.get('slug', ''))
        if slug == before:
            return
        page = str(item.get('html_url', ''))
        html_url = f'https://github.com/apps/{slug}' if page in ('', f'https://github.com/apps/{before}') else page
        at = _iso(self._clock())
        version = int(item.get('version', 0)) + 1
        updated = {**item, 'slug': slug, 'html_url': html_url, 'updated_at': at,
                   'updated_by': display_name(actor.name), 'version': version}
        audit = audit_row({'app_id': str(item.get('app_id', ''))}, 'github_app_renamed', {'slug': slug, 'was': before},
                          actor, at, version)
        try:
            self._write(updated, item, audit)
        except ConnectionRefused:
            return
        logger.info('engineering GitHub App slug updated', extra={'app_id': item.get('app_id')})

    def _covered(self, app_id: str, installation_id: str) -> tuple[set[str], bool, str]:
        """The repositories ``installation_id`` covers, whether the list was cut, and the App's slug as the
        installation reports it ('' when off its shape); an installation the token function refuses (another App's,
        suspended, gone) covers none."""
        if not APP_NUMBER.fullmatch(installation_id):
            return set(), False, ''
        try:
            inspected = self._tokens({'action': 'inspect_installation', 'app_id': app_id,
                                      'installation_id': int(installation_id)})
        except ConnectionRefused as refused:
            if refused.kind != 'conflict':
                raise
            return set(), False, ''
        listed = dig(inspected, 'repositories')
        names = {str(dig(item, 'repository')) for item in (listed if isinstance(listed, list) else [])}
        slug = dig(inspected, 'app_slug')
        reported = slug if isinstance(slug, str) and _SLUG.fullmatch(slug) else ''
        return names, dig(inspected, 'truncated') is True, reported

    # --- removal ----------------------------------------------------------------------------------------------

    def remove(self, app_id: str, actor: Actor, reason: object = None) -> None:
        """Remove a stored App no connection uses (409 otherwise): its parameters first, then its row is marked
        removed, with its audit row. Deleting it on GitHub stays the administrator's."""
        why = parse_reason(reason)
        before = self._app(app_id)
        users = self._users().get(app_id, [])
        if users:
            raise ConnectionRefused('conflict', f'{len(users)} connection(s) use this GitHub App: remove them first')
        self._delete([app_key_parameter(self._prefix, app_id), app_webhook_parameter(self._prefix, app_id),
                      *([client_parameter(self._user_prefix, app_id)] if self._user_prefix else [])], app_id)
        at = _iso(self._clock())
        version = int(before.get('version', 0)) + 1
        item = {**before, 'removed': True, 'removed_at': at, 'removed_by': display_name(actor.name), 'version': version}
        audit = audit_row({'app_id': app_id}, 'github_app_removed', {'slug': before.get('slug'), 'key': 'removed'},
                          actor, at, version, why)
        self._write(item, before, audit)
        logger.info('engineering GitHub App removed', extra={'app_id': app_id})


def _converted(data: object) -> ConvertedApp:
    """GitHub's conversion answer, each kept field checked (``HostError`` naming none of its values)."""
    app_id, slug = str(dig(data, 'id') or ''), dig(data, 'slug')
    owner, owner_type, html_url = dig(data, 'owner', 'login'), dig(data, 'owner', 'type'), dig(data, 'html_url')
    secret = dig(data, 'webhook_secret')
    if not (APP_NUMBER.fullmatch(app_id) and isinstance(slug, str) and _SLUG.fullmatch(slug)
            and isinstance(owner, str) and owner_type in _OWNER_TYPES and isinstance(html_url, str)
            and html_url.startswith('https://github.com/') and (secret is None or isinstance(secret, str))):
        raise HostError('GitHub answered the App\'s code off its shape.')
    # (7.57.00: its OAuth client, for the user authorization; one off its shape is not kept, and an administrator
    # sets it later: set_client)
    client_id, client_secret = dig(data, 'client_id'), dig(data, 'client_secret')
    client = (isinstance(client_id, str) and CLIENT_ID.fullmatch(client_id) is not None
              and isinstance(client_secret, str) and CLIENT_SECRET.fullmatch(client_secret) is not None)
    return ConvertedApp(app_id=app_id, slug=slug, owner=owner, owner_type=str(owner_type), html_url=html_url,
                        private_key=checked_private_key(dig(data, 'pem')), webhook_secret=secret or '',
                        client_id=str(client_id) if client else '', client_secret=str(client_secret) if client else '')
