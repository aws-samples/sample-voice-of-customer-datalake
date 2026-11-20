"""Any public GitHub repository, read only (7.57.00; docs/autonomous-engineering.md, "Any public repository"). The
Agents API's side: the picker and the connection. Nothing here imports ``cryptography`` or reads a credential.

* **The picker** (``search``, ``GET /agents/engineering/public-repositories?q=``): a name, ``owner/name`` or a GitHub
  address, searched server-side through the token function (``app_tokens.py`` ``public_search``) with a token of the
  deployment's App that holds ``metadata: read`` alone and names no repository; each result with its stars, licence,
  whether it is archived, its last push, the connection that already has it, and since 7.60.00 the ways it may be
  connected (``ways_of``: the App, a fine-grained token, a fork). Private repositories are never
  answered: they connect through the App's installation, as before.
* **The connection** (``connect``, ``POST /agents/engineering/public-connections``): the repository read again through
  the token function (``public_repository``: it must be public on GitHub now), then stored as a ``public_read``
  connection (``connections.PublicRead``: the App installation whose read-only token reads it; no write credential for
  it exists anywhere), with its facts on the row (stars, licence, archived, last push), and the GitHub Issues source
  follows it (its issues as feedback; never a label: ``issues_sync.py``). An archived repository connects (reading is
  fine); its fork workflow is refused (``forks.py``).

**Why a token of the App, not none.** GitHub answers an unauthenticated reader 60 requests an hour per address, and a
Lambda's address is shared: the agents' reads and the issues' backfill would fail at random. A token of the App's
installation reads what any reader of a public repository reads, under the installation's own limit (5,000 an hour and
more), holds ``metadata: read`` alone (so it writes nothing, even on the repositories the App is installed on), is
minted by the token function or the broker (the only holders of the App's key) and is never answered to the Agents API.
So a deployment needs one GitHub App installation first (Connect GitHub): the anchor (``anchor``) is the installation
of the first of its own repositories' connections.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

from engineering.connectors.connections import (
    FINE_GRAINED_CREDENTIAL,
    KIND_PUBLIC_READ,
    KIND_REPOSITORY,
    MAX_CONNECTIONS,
    Actor,
    ConnectionRefused,
    ConnectionRequest,
    ConnectionStore,
    PublicRead,
    is_branch_name,
    parse_reason,
)
from engineering.connectors.github_apps import connection_id_for
from engineering.connectors.issues_sync import follow_stored
from engineering.connectors.upstream import UpstreamRefused, facts_from_answer, parse_query
from shared.github_rest import parse_repo
from shared.logging import logger

NO_APP: Final = ('Connect GitHub first (Agents → Connections → Connect GitHub): a public repository is read with the '
                 'read-only token of your GitHub App\'s installation, never anonymously (GitHub allows an anonymous '
                 'reader 60 requests an hour)')
NOT_PUBLIC: Final = ('GitHub has no public repository by that name: a private one connects through the GitHub App\'s '
                     'installation (Connect GitHub)')
ALREADY: Final = 'this repository is connected already (as {connection})'
_FIELDS: Final = frozenset({'repository', 'reason'})


def anchor(stored: Sequence[Mapping[str, Any]]) -> tuple[str, int]:
    """The App installation whose read-only token reads a public repository: the installation of the first connection
    (by id) of one's own repositories made through the deployment's App, else of any connection through one of its
    Apps (a fork's, a public one's); ``ConnectionRefused('conflict', NO_APP)`` for none."""
    def ranked(connection: Mapping[str, Any]) -> tuple[int, str]:
        own = connection.get('kind') == KIND_REPOSITORY and connection['credential'].get('kind') == 'app_reference'
        return (0 if own else 1, str(connection.get('connection_id', '')))

    # (7.60.00: a fine-grained token connection reads through one of them too, so its installation anchors as well)
    candidates = [c for c in stored if str(c.get('host', 'github')) == 'github'
                  and c['credential'].get('kind') in ('app_reference', KIND_PUBLIC_READ, FINE_GRAINED_CREDENTIAL)
                  and str(c['credential'].get('app_id') or '').isdigit()
                  and str(c['credential'].get('installation_id') or '').isdigit()]
    if not candidates:
        raise ConnectionRefused('conflict', NO_APP)
    first = min(candidates, key=ranked)
    return str(first['credential']['app_id']), int(first['credential']['installation_id'])


def room_for(stored: Sequence[Mapping[str, Any]], repository: str) -> None:
    """A new connection to ``repository`` (``owner/name``, any case) among the ``stored`` connections (their views):
    409 when one has it already (``ALREADY``) or the deployment holds its most (``MAX_CONNECTIONS``). A public
    repository's and (7.60.00) a fine-grained token's connect alike."""
    same = next((c for c in stored if str(c['repository']).lower() == repository.lower()), None)
    if same is not None:
        raise ConnectionRefused('conflict', ALREADY.format(connection=same['connection_id']))
    if len(stored) >= MAX_CONNECTIONS:
        raise ConnectionRefused('conflict', f'at most {MAX_CONNECTIONS} connections: remove one to add another')


def ways_of(facts: Any) -> dict[str, bool]:
    """(7.60.00) The "Add a repository" chooser's hints for a public repository found (``upstream.RepositoryFacts``):
    the App installed on it (``app``) or a fine-grained token (``token``: public repositories only) end with a branch
    and a pull request on it, a fork (``fork``: one with a licence) with a pull request on the fork; an archived one
    takes none of them."""
    takes = not facts.archived
    return {'app': takes, 'token': takes and not facts.private, 'fork': takes and bool(facts.licence_spdx)}


class PublicRepositories:
    """The picker and the connection over the connections (``connections``), the token function (``tokens``: its
    request in, its answer out, a ``ConnectionRefused`` for its failures) and the GitHub Issues source's follow
    (``issues``: ``issues_sync.IssuesFollow``; None: no ``issues`` block)."""

    def __init__(self, connections: ConnectionStore, tokens: Callable[[dict[str, Any]], dict[str, Any]],
                 issues: Any = None) -> None:
        self._connections = connections
        self._tokens = tokens
        self._issues = issues

    def search(self, query: object) -> dict[str, Any]:
        """``{repositories: [...], query}``: the picker's results (``upstream.RepositoryFacts.view``), each with the
        connection that has it (``connected``)."""
        try:
            _, words = parse_query(query)
        except UpstreamRefused as refused:
            raise ConnectionRefused('invalid', str(refused)) from None
        stored = self._connections.list()
        app_id, installation_id = anchor(stored)
        answer = self._tokens({'action': 'public_search', 'app_id': app_id, 'installation_id': installation_id,
                               'query': str(query).strip()})
        connected = {str(c['repository']).lower(): str(c['connection_id']) for c in stored}
        listed = answer.get('repositories')
        found = [facts for facts in map(facts_from_answer, listed if isinstance(listed, list) else [])
                 if facts is not None and not facts.private]
        return {'repositories': [{**facts.view(connected.get(facts.repository.lower())), 'ways': ways_of(facts)}
                                 for facts in found], 'query': words}

    def connect(self, body: Mapping[str, object], actor: Actor) -> tuple[dict[str, Any], bool, dict[str, Any] | None]:
        """A ``public_read`` connection for the body's repository (``{repository, reason?}``), read again on GitHub
        first: (the connection, created, the issues source's follow)."""
        if not set(body) <= _FIELDS or 'repository' not in body:
            raise ConnectionRefused('invalid', 'the body is {repository, reason?}')
        named = parse_repo(body['repository']) if isinstance(body['repository'], str) else None
        if named is None:
            raise ConnectionRefused('invalid', 'repository is owner/name, or its GitHub address')
        reason = parse_reason(body.get('reason'))
        stored = self._connections.list()
        room_for(stored, named)
        app_id, installation_id = anchor(stored)
        answer = self._tokens({'action': 'public_repository', 'app_id': app_id, 'installation_id': installation_id,
                               'repository': named, 'details': False})
        facts = facts_from_answer(answer.get('repository'))
        if facts is None or facts.private:
            raise ConnectionRefused('not_found', NOT_PUBLIC)
        if not is_branch_name(facts.default_branch):
            raise ConnectionRefused('conflict', 'the repository\'s default branch is not one the connections take')
        connection_id = connection_id_for(facts.repository, {str(c['connection_id']) for c in stored})
        request = ConnectionRequest(
            host='github', repository=facts.repository, default_branch=facts.default_branch,
            credential=PublicRead(app_id, installation_id), reason=reason, repository_private=False,
            kind=KIND_PUBLIC_READ, facts={'stars': facts.stars, 'licence': facts.licence_spdx,
                                          'archived': facts.archived, 'pushed_at': facts.pushed_at or None})
        connection, created = self._connections.save(connection_id, request, actor)
        logger.info('engineering public repository connected', extra={'connection_id': connection_id})
        return connection, created, follow_stored(self._issues, app_id, self._connections, actor)
