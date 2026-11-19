"""The fork workflow (7.57.00; docs/autonomous-engineering.md, "Any public repository": contributing). The Agents API's
side: nothing here imports ``cryptography`` or reads a credential.

1. **Contribute** (the card's step 2, ``start``, ``POST /agents/engineering/connections/<id>/fork``) on a ``public_read``
   connection: ``{account: user | organization, org?, licence, app_id?, workspace?}``. The upstream is read again
   (``app_tokens.py`` ``public_repository`` with ``details``): an archived one, one that opts out of bot pull requests
   or has no licence, or a licence other than the one acknowledged (``licence``, its SPDX id as the page showed it), is
   refused (409). The answer is two links: GitHub's own fork page (``https://github.com/<upstream>/fork``: the person
   forks it into their account or an organization they administer; the platform creates no fork, since an App would
   need Administration (write) on every repository it is installed on to fork through the API) and the App's install
   link with a single-use state of its own (``github_apps.FORK_INSTALL``: the upstream, the account and the licence
   acknowledged), to install the App on the fork.
2. **The install's return** (``installed``, through ``POST …/github-apps/installations``): the installation is read
   (``inspect_fork``: another App's or a suspended one refused, as any install), and the fork of the upstream it
   covers, in the account chosen, becomes one ``fork`` connection (``connections.ForkReference``): the App's reference
   on the fork's installation (so the broker pushes to the fork and opens its pull request exactly as on one's own
   repository, its CI attested as any connection's), with the upstream, its default branch, the owner (whoever
   started the workflow: their subject's sha256 names their GitHub user authorization, with which the app opens the
   upstream pull request for them), the licence they acknowledged and their setting for AI-assisted runs (off). No fork
   there: 409, the state
   kept, so the same install link works once the fork exists.
3. **The owner's settings** (``set_upstream``, ``PUT …/connections/<id>/upstream``): ``{assisted, licence?, reason?}``,
   the owner's alone: whether the app opens an AI-assisted run's upstream pull request, and the licence acknowledged again
   after the upstream changed it (read again; it must be the current one).
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Final

from engineering.connectors.connections import (
    KIND_FORK,
    KIND_PUBLIC_READ,
    Actor,
    ConnectionRefused,
    ConnectionRequest,
    ConnectionStore,
    ForkReference,
    display_name,
    is_branch_name,
    kind_of,
    parse_reason,
)
from engineering.connectors.github_apps import (
    FORK_INSTALL,
    ORGANIZATION,
    GitHubApps,
    connection_id_for,
    install_target,
    parse_app_id,
)
from engineering.connectors.transport import dig
from engineering.connectors.upstream import contribution_refusal, facts_from_answer, licence_refusal
from engineering.connectors.user_auth_paths import subject_hash
from shared.logging import logger

NOT_PUBLIC_READ: Final = ('contributing starts from a public repository connected read only: this connection is '
                          'not one')
NOT_A_FORK: Final = 'this connection is not a fork'
NOT_OWNER: Final = ('only the connection\'s owner (whose fork and pull requests these are) changes this')
NO_FORK: Final = ('the installation covers no fork of {upstream} in {account}: fork it on GitHub first (the first '
                  'link), then install the App on the fork')
WRONG_ACCOUNT: Final = 'the App was installed on {login}, not on the account chosen for the fork ({wanted})'
UPSTREAM_GONE: Final = 'GitHub has no public repository {upstream} any more'
_START_FIELDS: Final = frozenset({'account', 'org', 'licence', 'app_id', 'workspace'})
_SETTINGS_FIELDS: Final = frozenset({'assisted', 'licence', 'reason'})


def fork_page(upstream: str) -> str:
    """GitHub's own page that forks ``upstream`` (the person picks the account or organization there)."""
    return f'https://github.com/{upstream}/fork'


def _account(body: Mapping[str, object]) -> tuple[str, str]:
    account, org = body.get('account'), body.get('org')
    if account == 'user':
        if org not in (None, ''):
            raise ConnectionRefused('invalid', 'org is only for account "organization"')
        return 'user', ''
    if account == 'organization' and isinstance(org, str) and ORGANIZATION.fullmatch(org.strip()):
        return 'organization', org.strip()
    raise ConnectionRefused('invalid', 'account is "user" (your own account) or "organization" with org, the '
                                       'organization\'s GitHub login')


def _licence(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 64:
        raise ConnectionRefused('invalid', 'licence is the repository\'s licence (its SPDX id) as you read it')
    return value.strip()


class Forks:
    """The workflow over the connections, the deployment's GitHub Apps (their states and install links) and the
    token function (``tokens``: its request in, its answer out, a ``ConnectionRefused`` for its failures)."""

    def __init__(self, connections: ConnectionStore, apps: GitHubApps,
                 tokens: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
        self._connections = connections
        self._apps = apps
        self._tokens = tokens

    def _upstream(self, app_id: str, installation_id: int, repository: str) -> dict[str, Any]:
        """The upstream as GitHub answers it now (its facts, opt-out marker, CONTRIBUTING), read through ``app_id``'s
        installation ``installation_id`` with a read-only token; 404 when it is no public repository any more."""
        answer = self._tokens({'action': 'public_repository', 'app_id': app_id, 'installation_id': installation_id,
                               'repository': repository, 'details': True})
        if facts_from_answer(answer.get('repository')) is None:
            raise ConnectionRefused('not_found', UPSTREAM_GONE.format(upstream=repository))
        return answer

    # --- 1. Contribute (the card's step 2) -------------------------------------------------------------------

    def start(self, connection_id: str, body: Mapping[str, object], actor: Actor) -> dict[str, Any]:
        if not set(body) <= _START_FIELDS or 'licence' not in body:
            raise ConnectionRefused('invalid', 'the body is {account, org?, licence, app_id?, workspace?}')
        account, org = _account(body)
        licence = _licence(body['licence'])
        row = self._connections.stored_row(connection_id)
        if kind_of(row) != KIND_PUBLIC_READ:
            raise ConnectionRefused('conflict', NOT_PUBLIC_READ)
        upstream = str(row.get('repository', ''))
        app_id = parse_app_id(str(body.get('app_id') or row.get('app_id') or ''))
        app = self._apps.stored(app_id)
        answer = self._upstream(str(row.get('app_id', '')), int(str(row.get('installation_id', '0'))), upstream)
        facts = facts_from_answer(answer.get('repository'))
        refusal = None if facts is None else contribution_refusal(facts, answer.get('opt_out'), licence)
        if facts is None or refusal is not None:
            raise ConnectionRefused('conflict', refusal or UPSTREAM_GONE.format(upstream=upstream))
        state, expires_at = self._apps.states.mint(
            FORK_INSTALL, actor, app_id=app_id, account=account, org=org, upstream=facts.repository,
            upstream_connection=connection_id, upstream_default_branch=facts.default_branch, licence=licence)
        logger.info('engineering fork workflow started', extra={'connection_id': connection_id, 'app_id': app_id})
        return {'fork_url': fork_page(facts.repository), 'install_url': install_target(str(app.get('slug', '')), state),
                'expires_at': expires_at, 'app_id': app_id}

    # --- 2. the install's return ---------------------------------------------------------------------------------

    def installed(self, state: Mapping[str, Any], installation_id: int, actor: Actor) -> dict[str, Any]:
        """The fork's one connection, from a fork install's claimed ``state`` row: ``{account, connections, skipped,
        fork}``."""
        app_id, upstream = str(state.get('app_id', '')), str(state.get('upstream', ''))
        inspected = self._tokens({'action': 'inspect_fork', 'app_id': app_id, 'installation_id': installation_id,
                                  'upstream': upstream})
        login, kind = str(dig(inspected, 'account', 'login') or ''), str(dig(inspected, 'account', 'type') or '')
        wanted_org = str(state.get('org') or '')
        wanted = wanted_org or 'your own account'
        if (state.get('account') == 'organization') != (kind == 'Organization') or (
                wanted_org and login.lower() != wanted_org.lower()):
            raise ConnectionRefused('conflict', WRONG_ACCOUNT.format(login=login or 'another account', wanted=wanted))
        listed = dig(inspected, 'forks')
        forks = [item for item in (listed if isinstance(listed, list) else [])
                 if str(dig(item, 'repository') or '').lower().startswith(f'{login.lower()}/')
                 and dig(item, 'archived') is not True]
        if not forks:
            raise ConnectionRefused('conflict', NO_FORK.format(upstream=upstream, account=login or wanted))
        fork = forks[0]
        repository, branch = str(fork['repository']), str(dig(fork, 'default_branch') or '')
        if not is_branch_name(branch):
            raise ConnectionRefused('conflict', 'the fork\'s default branch is not one the connections take')
        stored = self._connections.list()
        already = next((c for c in stored if str(c['repository']).lower() == repository.lower()), None)
        if already is not None:
            raise ConnectionRefused('conflict', f'the fork is connected already (as {already["connection_id"]})')
        connection_id = connection_id_for(f'{repository}-fork', {str(c['connection_id']) for c in stored})
        licence = str(state.get('licence', ''))
        request = ConnectionRequest(
            host='github', repository=repository, default_branch=branch, repository_private=dig(fork, 'private') is True,
            credential=ForkReference(app_id, installation_id, upstream, str(state.get('upstream_default_branch', '')),
                                     subject_hash(actor.subject), licence, assisted=False),
            kind=KIND_FORK, facts={
                'upstream': upstream, 'upstream_connection': str(state.get('upstream_connection') or ''),
                'upstream_default_branch': str(state.get('upstream_default_branch', '')),
                'owner_subject': actor.subject, 'owner_name': display_name(actor.name), 'licence': licence,
                'upstream_pr_assisted': False, 'fork_account': login, 'fork_account_type': kind})
        connection, created = self._connections.save(connection_id, request, actor)
        logger.info('engineering fork connected', extra={'connection_id': connection_id, 'app_id': app_id})
        return {'account': {'login': login, 'type': kind}, 'connections': [{'connection': connection, 'created': created}],
                'skipped': [], 'fork': {'upstream': upstream, 'repository': repository}}

    # --- 3. the owner's settings ----------------------------------------------------------------------------------

    def set_upstream(self, connection_id: str, body: Mapping[str, object], actor: Actor) -> dict[str, Any]:
        if not set(body) <= _SETTINGS_FIELDS or not isinstance(body.get('assisted'), bool):
            raise ConnectionRefused('invalid', 'the body is {assisted: true or false, licence?, reason?}')
        row = self._connections.stored_row(connection_id)
        if kind_of(row) != KIND_FORK:
            raise ConnectionRefused('conflict', NOT_A_FORK)
        if row.get('owner_subject') != actor.subject:
            raise ConnectionRefused('conflict', NOT_OWNER)
        upstream, licence = str(row.get('upstream', '')), str(row.get('licence', ''))
        if body.get('licence') is not None:
            licence = _licence(body['licence'])
            answer = self._upstream(str(row.get('app_id', '')), int(str(row.get('installation_id', '0'))), upstream)
            facts = facts_from_answer(answer.get('repository'))
            refusal = None if facts is None else licence_refusal(facts, licence)
            if facts is None or refusal is not None:
                raise ConnectionRefused('conflict', refusal or UPSTREAM_GONE.format(upstream=upstream))
        assisted = bool(body['assisted'])
        request = ConnectionRequest(
            host='github', repository=str(row.get('repository', '')), default_branch=str(row.get('default_branch', '')),
            reason=parse_reason(body.get('reason')), repository_private=row.get('repository_private') is True,
            credential=ForkReference(str(row.get('app_id', '')), int(str(row.get('installation_id', '0'))), upstream,
                                     str(row.get('upstream_default_branch', '')), subject_hash(actor.subject),
                                     licence, assisted=assisted),
            kind=KIND_FORK, facts={**{name: row.get(name) for name in (
                'upstream', 'upstream_connection', 'upstream_default_branch', 'owner_subject', 'owner_name',
                'fork_account', 'fork_account_type')}, 'licence': licence, 'upstream_pr_assisted': assisted})
        connection, _ = self._connections.save(connection_id, request, actor)
        return connection
