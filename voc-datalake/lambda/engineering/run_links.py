"""The run's issue and pull request on its record (7.09.00; docs/autonomous-engineering.md, "Repository connectors":
the run's issue and pull request).

- **The pull request** (a GitLab merge request), ``WS#<ws>#WRITES#<run>`` / ``PULL_REQUEST``, beside the broker's write
  claims (``connectors/records.py``): written by the broker alone, once the host answered an open or an update of the
  run's draft pull request with it. Keyed on the head branch, the run's own: the same number again updates its base
  (and its rebuilt URL); a new number on the same head (a person closed the draft, and the next open made another)
  replaces it, the earlier numbers kept in ``superseded`` (at most ``MAX_SUPERSEDED``, the oldest dropped); another
  head is refused, so the record never moves to another branch's pull request (``merged``). A claim row's attributes
  only (``op``, ``at``, ``closed_at``, ``result``: the broker's grant allows no other, engineering-broker.ts),
  ``result`` holding ``{host, number, url, head, base, superseded}`` as JSON, ``at`` when it was first recorded and
  ``closed_at`` when last written. A write whose outcome is unknown records nothing: the next open or update finds the
  pull request by its branch on the host (the clients' lookup) and records what that answers.
- **The issue**, META's ``issue`` (``runtime/runs.py``, written once by the run's start): ``{host, number, url,
  verified}``, the number the person who started the run gave; ``verified`` is False: nothing reads the host at a
  start (only the broker holds the connection's credential), so it is shown as given, not checked.

Each holds the host kind, the number, the URL and (the pull request) its head and base branches; never a token, a
title, a body or any other text of the host's. A URL is kept, and read back, only when it is exactly the address of
that number in the run's own repository (META's ``repo``) on its host's own domain over https (``own_url``), and what
is kept is the address rebuilt from the host, repository and number (never the host's own spelling of it): a row that
says anything else is read as none.

A record the broker could not write is not lost: its done write claim keeps the same answer (the pull request
author's claims, ``WRITE#pr-author-…``), so the reader (``run_links``) takes the newest done claim, checked by the
same rules, when it is newer than the row or there is no row, and logs that it did.
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Final, Literal

from engineering.connectors.identity import OPEN_OR_UPDATE_DRAFT_PR
from engineering.connectors.user_auth_paths import GITHUB_LOGIN
from engineering.rows import amount_attr
from engineering.runtime.outputs import AGENT_BRANCH_PREFIX
from shared.logging import logger

#: Each host kind's own web domain (``connectors/gitlab_api.py`` ``GITLAB_HOST`` for GitLab, held to it by a test).
HOSTS: Final[Mapping[str, str]] = {'github': 'github.com', 'gitlab': 'gitlab.com'}
LinkKind = Literal['issue', 'pull_request']
#: Where a number sits under the repository's address, per host kind and link kind.
_SEGMENTS: Final[Mapping[str, Mapping[LinkKind, str]]] = {
    'github': {'issue': 'issues', 'pull_request': 'pull'},
    'gitlab': {'issue': '-/issues', 'pull_request': '-/merge_requests'},
}
#: The largest issue or pull request number taken (a host's numbers are 32-bit).
MAX_NUMBER: Final = 2_147_483_647
#: The most earlier pull request numbers the record keeps (the oldest dropped first).
MAX_SUPERSEDED: Final = 20
#: A part of a repository's path: never ``.`` or ``..``.
_PART: Final = r'(?!\.\.?(?:/|$))[A-Za-z0-9_.-]+'
#: A repository's path as each host's connection stores it: GitHub's ``owner/name`` exactly, GitLab's
#: ``group[/subgroup…]/project`` (up to 20 subgroups: connections.py's rule).
_REPOSITORIES: Final[Mapping[str, re.Pattern[str]]] = {
    'github': re.compile(rf'{_PART}/{_PART}'),
    'gitlab': re.compile(rf'{_PART}(?:/{_PART}){{1,20}}'),
}
#: A branch as the record keeps it: printable ASCII without spaces, at most 255 characters.
_BRANCH: Final = re.compile(r'[\x21-\x7e]{1,255}')
#: The pull request's row in the run's writes' partition, and its ``op``.
PULL_REQUEST_SK: Final = 'PULL_REQUEST'
PULL_REQUEST_OP: Final = 'pull_request'
#: The pull request author's write claims (``broker.write_key``: ``WRITE#<agent>#…``, the only role that opens one).
PR_AUTHOR_CLAIMS: Final = 'WRITE#pr-author-'
#: The most of those claims a read takes, newest in key order first (each attempt and each new text is one).
MAX_CLAIMS_READ: Final = 10
#: The rebuilds already logged as warnings, by run, row state and claim (later ones go to debug), at most this many.
MAX_LOGGED_REBUILDS: Final = 256
_logged_rebuilds: dict[tuple[str, str, int], None] = {}


def writes_pk(ws: str, run_id: str) -> str:
    """The partition of a run's writes (the broker's claims and the pull request), beside the run's own."""
    return f'WS#{ws}#WRITES#{run_id}'


def valid_number(number: object) -> bool:
    """A whole number from 1 to ``MAX_NUMBER`` (never a bool)."""
    return isinstance(number, int) and not isinstance(number, bool) and 1 <= number <= MAX_NUMBER


def _repository_ok(host: str, repository: str) -> bool:
    pattern = _REPOSITORIES.get(host)
    return pattern is not None and pattern.fullmatch(repository) is not None


def link_url(host: str, repository: str, kind: LinkKind, number: int) -> str:
    """The address of issue or pull request ``number`` in ``repository`` on ``host`` (a kind of ``HOSTS``)."""
    return f'https://{HOSTS[host]}/{repository}/{_SEGMENTS[host][kind]}/{number}'


def own_url(host: str, repository: str, kind: LinkKind, number: int, url: str) -> bool:
    """``url`` is exactly the address of ``number`` in the run's own ``repository`` on its host's own domain, over
    https (ASCII; the host's casing of the path may differ from the stored one)."""
    if not _repository_ok(host, repository) or not valid_number(number) or not url.isascii():
        return False
    return url.lower() == link_url(host, repository, kind, number).lower()


@dataclass(frozen=True)
class PullRequestLink:
    """The run's pull request as its record keeps it, with the numbers it replaced (oldest first)."""

    host: str
    number: int
    url: str
    head: str
    base: str
    superseded: tuple[int, ...] = ()

    def result(self) -> str:
        """The row's ``result``: the same link always the same text."""
        return json.dumps(self.view(), sort_keys=True, separators=(',', ':'))

    def view(self) -> dict[str, Any]:
        return {'host': self.host, 'number': self.number, 'url': self.url, 'head': self.head, 'base': self.base,
                'superseded': list(self.superseded)}


def pull_request_link(host: str, repository: str, number: int, url: str, head: str,
                      base: str) -> PullRequestLink | None:
    """The link to keep of a host's answer, None when it is not the run's own (``own_url``) or a branch is off; its
    URL rebuilt from the host, repository and number."""
    if not own_url(host, repository, 'pull_request', number, url):
        return None
    if not (_BRANCH.fullmatch(head) and _BRANCH.fullmatch(base)):
        return None
    return PullRequestLink(host=host, number=number, url=link_url(host, repository, 'pull_request', number),
                           head=head, base=base)


def merged(current: PullRequestLink | None, new: PullRequestLink) -> PullRequestLink | None:
    """What the record becomes when the host answers ``new``: ``new`` for none; on the same head, ``new`` with the
    numbers it replaced (``current``'s, and ``current`` itself when ``new`` is another number, at most
    ``MAX_SUPERSEDED``, the oldest dropped); None (refused) for another head."""
    if current is None:
        return new
    if current.head != new.head:
        return None
    earlier = [number for number in current.superseded if number != new.number]
    if current.number != new.number:
        earlier.append(current.number)
    return replace(new, superseded=tuple(earlier[-MAX_SUPERSEDED:]))


@dataclass(frozen=True)
class IssueLink:
    """The issue the run was started from; ``verified`` False: recorded as given (nothing read the host)."""

    host: str
    number: int
    url: str
    verified: bool = False

    def item(self) -> dict[str, Any]:
        """META's ``issue``, as the run's start writes it (a resource table's item)."""
        return {'host': self.host, 'number': self.number, 'url': self.url, 'verified': self.verified}

    def view(self) -> dict[str, Any]:
        return self.item()


def issue_link(host: str, repository: str, number: int) -> IssueLink | None:
    """The issue ``number`` of ``repository`` on ``host`` as a start records it, None when any of them is off."""
    if not _repository_ok(host, repository) or not valid_number(number):
        return None
    return IssueLink(host=host, number=number, url=link_url(host, repository, 'issue', number))


def _string(value: object) -> str:
    found = value.get('S') if isinstance(value, dict) else None
    return found if isinstance(found, str) else ''


def _whole(value: object) -> int:
    found = value.get('N') if isinstance(value, dict) else None
    return int(found) if isinstance(found, str) and found.isdigit() else 0


def issue_of(meta: Mapping[str, Any]) -> IssueLink | None:
    """META's issue (a low-level item), None when there is none or it is not the run's own repository's (a fork run's,
    7.57.00: its upstream's, META's ``issue_repo``)."""
    raw = meta.get('issue')
    fields = raw.get('M') if isinstance(raw, dict) else None
    if not isinstance(fields, dict):
        return None
    host, number, url = _string(fields.get('host')), _whole(fields.get('number')), _string(fields.get('url'))
    if not own_url(host, _string(meta.get('issue_repo')) or _string(meta.get('repo')), 'issue', number, url):
        return None
    verified = fields.get('verified')
    return IssueLink(host=host, number=number, url=url,
                     verified=isinstance(verified, dict) and verified.get('BOOL') is True)


def _fields(text: str) -> dict[str, object]:
    """A ``result``'s JSON object (``{}`` when it is not one)."""
    try:
        found = json.loads(text or 'null')
    except ValueError:
        return {}
    return {str(key): value for key, value in found.items()} if isinstance(found, dict) else {}


def _superseded(value: object) -> tuple[int, ...]:
    listed = value if isinstance(value, list) else []
    return tuple(number for number in listed if valid_number(number))[-MAX_SUPERSEDED:]


def stored_link(text: str) -> PullRequestLink | None:
    """The pull request a ``result`` (the row's, or a done claim's) names as stored, None when it is off its shape;
    its address not checked (``link_of`` checks it)."""
    fields = _fields(text)
    host, number, url, head, base = (fields.get(name) for name in ('host', 'number', 'url', 'head', 'base'))
    if not (isinstance(host, str) and isinstance(number, int) and valid_number(number) and isinstance(url, str)
            and isinstance(head, str) and isinstance(base, str)):
        return None
    return PullRequestLink(host=host, number=number, url=url, head=head, base=base,
                           superseded=_superseded(fields.get('superseded')))


def link_of(text: str, repository: str) -> PullRequestLink | None:
    """The pull request a ``result`` names, None when it is off its shape or not ``repository``'s own
    (``pull_request_link``)."""
    found = stored_link(text)
    checked = None if found is None else pull_request_link(found.host, repository, found.number, found.url, found.head,
                                                            found.base)
    return None if checked is None or found is None else replace(checked, superseded=found.superseded)


def pull_request_of(item: Mapping[str, Any] | None, repository: str) -> PullRequestLink | None:
    """The pull request row's link (a low-level item), None for none or one that is not ``repository``'s own."""
    return None if item is None else link_of(_string(item.get('result')), repository)


def _newest_claim(client: Any, table: str, ws: str, run_id: str,
                  repository: str) -> tuple[PullRequestLink, int] | None:
    """The newest done open or update of the run's pull request whose answer is its own (on a branch of the run),
    with when its claim was closed; None for none. One Query of at most ``MAX_CLAIMS_READ`` of the pull request
    author's claims, the last in key order first (``WRITE#pr-author-<n>#<attempt>#…``: the agent, then its attempt;
    the pull request author makes no other write, so the prefix holds its claims alone), of which the latest closed
    wins. The key orders agents and attempts as text, not by time (``pr-author-10`` before ``pr-author-2``), so past
    nine agents or attempts a newer claim can fall outside the read: then the row stands, and the next open or update
    rewrites it."""
    answer = client.query(TableName=table, ConsistentRead=True, ScanIndexForward=False, Limit=MAX_CLAIMS_READ,
                          KeyConditionExpression='pk = :pk AND begins_with(sk, :p)',
                          ExpressionAttributeValues={':pk': {'S': writes_pk(ws, run_id)}, ':p': {'S': PR_AUTHOR_CLAIMS}})
    rows: list[dict[str, Any]] = answer.get('Items', [])
    own = f'{AGENT_BRANCH_PREFIX}{run_id}/'
    found: list[tuple[int, PullRequestLink]] = []
    for row in rows:
        if _string(row.get('op')) != OPEN_OR_UPDATE_DRAFT_PR or _string(row.get('state')) != 'done':
            continue
        link = link_of(_string(row.get('result')), repository)
        if link is not None and link.head.startswith(own):
            found.append((int(amount_attr(row, 'closed_at')), link))
    if not found:
        return None
    at, link = max(found, key=lambda pair: pair[0])
    return link, at


def _pull_request(client: Any, table: str, ws: str, run_id: str, repository: str) -> PullRequestLink | None:
    """The row's pull request, or, when a done claim is newer than the row (or there is no row) and names another,
    the record it would have written (``merged``): a record the broker could not write is read back from its claim."""
    key = {'pk': {'S': writes_pk(ws, run_id)}, 'sk': {'S': PULL_REQUEST_SK}}
    item = client.get_item(TableName=table, Key=key, ConsistentRead=True).get('Item')
    recorded = pull_request_of(item, repository)
    claim = _newest_claim(client, table, ws, run_id, repository)
    if claim is None:
        return recorded
    link, at = claim
    if recorded is not None and (at <= int(amount_attr(item or {}, 'closed_at')) or link.number == recorded.number):
        return recorded
    repaired = merged(recorded, link)
    if repaired is None:
        return recorded
    _log_rebuild(run_id, '' if item is None else _string(item.get('result')), repaired.number)
    return repaired


def run_pull_request(client: Any, table: str, ws: str, run_id: str, repository: str) -> PullRequestLink | None:
    """The run's pull request as ``run_links`` reads it (its row, else its newest done write claim), for the broker's
    reactions read (7.10.00): one consistent GetItem and one bounded Query of the run's writes' partition."""
    return _pull_request(client, table, ws, run_id, repository)


def _log_rebuild(run_id: str, row: str, number: int) -> None:
    """A warning the first time this container rebuilds this run's record from this row and claim (the overview polls
    every few seconds), debug after."""
    key = (run_id, row, number)
    log = logger.debug if key in _logged_rebuilds else logger.warning
    if key not in _logged_rebuilds:
        while len(_logged_rebuilds) >= MAX_LOGGED_REBUILDS:
            del _logged_rebuilds[next(iter(_logged_rebuilds))]
        _logged_rebuilds[key] = None
    log("engineering: the run's pull request read from its done write claim", extra={'run_id': run_id,
                                                                                     'number': number})


#: The run's upstream pull request's row (7.57.00, a fork connection's: ``connectors/upstream_records.py``), beside its
#: pull request's in its writes' partition, and its ``op``.
UPSTREAM_SK: Final = 'UPSTREAM_PULL_REQUEST'
UPSTREAM_OP: Final = 'upstream_pull_request'
UPSTREAM_STATES: Final = ('opened', 'link', 'refused', 'unknown')
#: The longest reason the record keeps (one line), and the longest prefilled title and full text read back (GitHub's).
MAX_UPSTREAM_REASON: Final = 500
MAX_UPSTREAM_TITLE: Final = 256
MAX_UPSTREAM_TEXT: Final = 65_536
#: The one-click link's longest address (connectors/upstream.py MAX_COMPARE_URL, with room for its encoding).
MAX_COMPARE_LINK: Final = 8000


def _compare_url(upstream: str, value: object) -> str | None:
    """The one-click link read back only when it is GitHub's compare page of the upstream itself, over https."""
    page = f'https://github.com/{upstream}/compare/'
    ok = isinstance(value, str) and value.startswith(page) and len(value) <= MAX_COMPARE_LINK and value.isascii()
    return value if ok and isinstance(value, str) else None


def _text_or_none(value: object, limit: int) -> str | None:
    return value if isinstance(value, str) and value and len(value) <= limit else None


def upstream_view(state: str, result: str) -> dict[str, Any] | None:
    """The run's upstream pull request as its row keeps it (``state`` and the ``result`` JSON), None when it is off
    its shape: its address read back only when it is exactly that number's on github.com under the upstream, and its
    one-click link only when it is the upstream's own compare page (``_compare_url``)."""
    fields = _fields(result)
    upstream, number, url, login, reason = (fields.get(name) for name in ('upstream', 'number', 'url', 'as', 'reason'))
    if state not in UPSTREAM_STATES or not (isinstance(upstream, str) and _repository_ok('github', upstream)):
        return None
    opened = isinstance(number, int) and isinstance(url, str) and own_url('github', upstream, 'pull_request', number,
                                                                         url)
    return {'state': state, 'upstream': upstream, 'number': number if opened else None,
            'url': link_url('github', upstream, 'pull_request', number) if opened and isinstance(number, int) else None,
            'as': login if isinstance(login, str) and GITHUB_LOGIN.fullmatch(login) else None,
            'reason': ' '.join(reason.split())[:MAX_UPSTREAM_REASON] if isinstance(reason, str) and reason else None,
            'compare_url': _compare_url(upstream, fields.get('compare_url')),
            'title': _text_or_none(fields.get('title'), MAX_UPSTREAM_TITLE),
            'description': _text_or_none(fields.get('description'), MAX_UPSTREAM_TEXT)}


def run_upstream(client: Any, table: str, ws: str, run_id: str) -> dict[str, Any] | None:
    """The run's upstream pull request (one consistent GetItem of its row), None for none."""
    key = {'pk': {'S': writes_pk(ws, run_id)}, 'sk': {'S': UPSTREAM_SK}}
    item = client.get_item(TableName=table, Key=key, ConsistentRead=True).get('Item')
    if item is None:
        return None
    found = upstream_view(_string(item.get('state')), _string(item.get('result')))
    if found is not None:
        at = _whole(item.get('closed_at'))
        found['at'] = datetime.fromtimestamp(at, UTC).isoformat() if at else None
    return found


def run_links(client: Any, table: str, ws: str, run_id: str, meta: Mapping[str, Any]) -> dict[str, Any]:
    """``{issue, pull_request, upstream_pull_request}`` of the run (each its view, or None), from its low-level META,
    one consistent GetItem of the pull request's row, one bounded Query of its author's write claims and, since
    7.57.00, one GetItem of its upstream pull request's row."""
    issue, pull_request = issue_of(meta), _pull_request(client, table, ws, run_id, _string(meta.get('repo')))
    return {'issue': None if issue is None else issue.view(),
            'pull_request': None if pull_request is None else pull_request.view(),
            'upstream_pull_request': run_upstream(client, table, ws, run_id)}
