"""A public repository connected with a fine-grained token limited to it (7.60.00; docs/autonomous-engineering.md, "A
fine-grained token (7.60.00)"). The Agents API's side: nothing here imports ``cryptography`` or reads a credential back.

* **Connect** (``create``, ``POST /agents/engineering/token-connections``, ``{repository, token, only_this_repository:
  true, default_branch?, connection_id?, reason?}``): the person's tick, the token's shape, then its check against
  GitHub (``fine_grained.check_token``: public, not archived, push, an expiry at most 90 days on, its login, no other
  private repository), then one ``fine_grained`` connection (``connections.FineGrainedToken``): read with the
  deployment's App's read-only token, as a public repository is (``public_repos.anchor``: so the deployment needs one
  App installation first), its write token in its own parameter, which only the broker reads.
* **Replace** (``renew``, ``PUT /agents/engineering/connections/<id>/token``, ``{token, only_this_repository: true,
  reason?}``): the same checks, for the connection's own repository; a renewal. While a run of the connection is live,
  only the token's own owner replaces it (another person's token would wait for another person's go, which the run's
  push never gets: 409).
* **Who** (the owner's decision): any administrator saves a token, only as themselves (the API refuses a delegated
  credential before this), and becomes its owner: the row keeps their subject's sha256 and their name, and only they
  give its runs their go (``go_refusal``, the go route's; the broker holds the go to the owner its token names too).

A refusal of the token is ``fine_grained.TokenRefused`` (422 with its ``code``, or 503); any other is a
``ConnectionRefused`` (400, 404, 409, 503). Neither ever names the token.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, date, datetime
from typing import Any, Final

from engineering.connectors.connections import (
    KIND_FINE_GRAINED,
    Actor,
    ConnectionRefused,
    ConnectionRequest,
    ConnectionStore,
    FineGrainedToken,
    check_connection_id,
    display_name,
    is_branch_name,
    kind_of,
    parse_reason,
)
from engineering.connectors.fine_grained import TokenFacts, TokenRefused, check_token, shape
from engineering.connectors.github_apps import connection_id_for
from engineering.connectors.public_repos import anchor, room_for
from shared.digests import sha256_hex
from shared.github_rest import parse_repo
from shared.logging import logger

_CREATE_FIELDS: Final = frozenset({'repository', 'token', 'only_this_repository', 'default_branch', 'connection_id',
                                   'reason'})
_REPLACE_FIELDS: Final = frozenset({'token', 'only_this_repository', 'reason'})
NOT_FINE_GRAINED: Final = 'this connection is not a fine-grained token\'s: its token is not replaced here'
OWNER_CHANGE_LIVE: Final = ('{runs} run(s) of this connection are live and wait for {owner}\'s go: only {owner} '
                            'replaces the token until they end (or stop them first)')
#: The go on a run of a fine-grained connection by anyone but its token owner (the go route's 403).
OWNER_ONLY_GO: Final = ("This run pushes with {login}'s fine-grained token: only {owner}, who saved it, gives the "
                          'run its go.')


def _tick(body: Mapping[str, object]) -> None:
    if body.get('only_this_repository') is not True:
        raise ConnectionRefused('invalid', 'only_this_repository is true: tick "This token can reach only the '
                                           'repository" once you made it so on GitHub')


def _token(body: Mapping[str, object]) -> str:
    try:
        return shape(body.get('token'))
    except ValueError as refused:
        raise ConnectionRefused('invalid', str(refused)) from None


class TokenConnections:
    """Connect and replace over the connections (``connections``: their store, whose token path the deployment names),
    with the token's check (``check``: ``fine_grained.check_token``; tests inject a fake) on ``clock``'s day (UTC)."""

    def __init__(self, connections: ConnectionStore, check: Callable[[str, str, date], TokenFacts] = check_token,
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._connections = connections
        self._check = check
        self._clock = clock

    def _checked(self, token: str, repository: str) -> TokenFacts:
        facts = self._check(token, repository, self._clock().astimezone(UTC).date())
        if facts.repository.lower() != repository.lower():
            raise TokenRefused('not_found', f'repository: GitHub answered for another repository than {repository}')
        return facts

    def _request(self, facts: TokenFacts, token: str, *, app: tuple[str, int], default_branch: str, reason: str,
                 actor: Actor) -> ConnectionRequest:
        at = self._clock().astimezone(UTC).isoformat()
        owner = sha256_hex(actor.subject)
        return ConnectionRequest(
            host='github', repository=facts.repository, default_branch=default_branch, reason=reason,
            credential=FineGrainedToken(app[0], app[1], facts, owner, token), repository_private=False,
            kind=KIND_FINE_GRAINED, facts={
                'token_login': facts.login, 'token_owner': owner, 'token_owner_name': display_name(actor.name),
                'token_saved_at': at, 'token_acknowledged': {'only_this_repository': True, 'at': at}})

    def create(self, body: Mapping[str, object], actor: Actor) -> tuple[dict[str, Any], bool]:
        """A ``fine_grained`` connection for the body's repository: (the connection, created)."""
        if not set(body) <= _CREATE_FIELDS or not {'repository', 'token', 'only_this_repository'} <= set(body):
            raise ConnectionRefused('invalid', 'the body is {repository, token, only_this_repository: true, '
                                               'default_branch?, connection_id?, reason?}')
        named = parse_repo(body['repository']) if isinstance(body['repository'], str) else None
        if named is None:
            raise ConnectionRefused('invalid', 'repository is owner/name, or its GitHub address')
        _tick(body)
        token, reason = _token(body), parse_reason(body.get('reason'))
        branch = body.get('default_branch')
        if branch is not None and (not isinstance(branch, str) or not is_branch_name(branch)):
            raise ConnectionRefused('invalid', 'default_branch is a branch name git accepts, not an agent\'s voc-agent/ '
                                               'branch')
        wanted = body.get('connection_id')
        if wanted is not None and not isinstance(wanted, str):
            raise ConnectionRefused('invalid', 'connection_id is text')
        stored = self._connections.list()
        room_for(stored, named)
        taken = {str(c['connection_id']) for c in stored}
        if wanted is not None and check_connection_id(wanted) in taken:
            raise ConnectionRefused('conflict', f'the connection id {wanted} is taken: choose another')
        app = anchor(stored)
        facts = self._checked(token, named)
        default_branch = branch if isinstance(branch, str) else facts.default_branch
        if not is_branch_name(default_branch):
            raise ConnectionRefused('conflict', 'the repository\'s default branch is not one the connections take')
        connection_id = wanted if wanted is not None else connection_id_for(facts.repository, taken)
        connection, created = self._connections.save(connection_id, self._request(
            facts, token, app=app, default_branch=default_branch, reason=reason, actor=actor), actor)
        logger.info('engineering token connection saved', extra={'connection_id': connection_id})
        return connection, created

    def _renewed_anchor(self, connection_id: str, row: Mapping[str, Any]) -> tuple[str, int]:
        """The App installation a replaced token reads through: anchored again among the OTHER connections, as a
        create anchors (7.66.00), so a token replaced after GitHub was connected again reads through the new
        installation (readiness's ``app_installation`` advice: connect GitHub again, then replace the token); the
        stored one when no other connection holds an installation."""
        others = [c for c in self._connections.list() if str(c.get('connection_id', '')) != connection_id]
        try:
            return anchor(others)
        except ConnectionRefused:
            return _stored_anchor(row)

    def renew(self, connection_id: str, body: Mapping[str, object], actor: Actor,
                live_runs: Callable[[str], list[str]] | None = None) -> dict[str, Any]:
        """The connection's token replaced (a renewal): the connection as saved. ``live_runs``: the connection's runs
        that have not ended (``connections.live_runs_of``), which keep the token's owner."""
        if not set(body) <= _REPLACE_FIELDS or not {'token', 'only_this_repository'} <= set(body):
            raise ConnectionRefused('invalid', 'the body is {token, only_this_repository: true, reason?}')
        _tick(body)
        token, reason = _token(body), parse_reason(body.get('reason'))
        row = self._connections.stored_row(connection_id)
        if kind_of(row) != KIND_FINE_GRAINED:
            raise ConnectionRefused('conflict', NOT_FINE_GRAINED)
        owner = sha256_hex(actor.subject)
        runs = live_runs(connection_id) if live_runs is not None and row.get('token_owner') != owner else []
        if runs:
            raise ConnectionRefused('conflict', OWNER_CHANGE_LIVE.format(
                runs=len(runs), owner=str(row.get('token_owner_name') or 'its owner')))
        repository = str(row.get('repository', ''))
        facts = self._checked(token, repository)
        app = self._renewed_anchor(connection_id, row)
        connection, _ = self._connections.save(connection_id, self._request(
            facts, token, app=app, default_branch=str(row.get('default_branch', '')), reason=reason, actor=actor),
            actor)
        logger.info('engineering token replaced', extra={'connection_id': connection_id})
        return connection


def _stored_anchor(row: Mapping[str, Any]) -> tuple[str, int]:
    return str(row.get('app_id', '')), int(str(row.get('installation_id') or '0'))


def go_refusal(row: Mapping[str, Any] | None, subject: str) -> str | None:
    """Why ``subject`` may not give a go on a run of the connection ``row`` (7.60.00): on a fine-grained connection,
    anyone but its token owner; None otherwise (any other kind, or the owner)."""
    if row is None or kind_of(row) != KIND_FINE_GRAINED:
        return None
    if subject and sha256_hex(subject) == row.get('token_owner'):
        return None
    return OWNER_ONLY_GO.format(login=str(row.get('token_login') or 'its owner'),
                                  owner=str(row.get('token_owner_name') or 'the administrator who saved it'))
