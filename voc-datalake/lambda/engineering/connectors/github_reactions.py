"""GitHub's answers to a reactions read (7.10.00; ``reactions.py`` holds the model, the bounds and the trust filter).

``GitHubHost.reactions`` hands this a ``get`` on its own client (a token for reading the pull request, its comments and
the repository's contents, the same one-host transport, every refusal a ``HostError`` with the status only) and a
lookup of a user's write access (``writes``: the client's, cached), so the requests are the client's, none of them a
write:

- ``/pulls/<n>``: the state, ``merged_at`` and ``merge_commit_sha``;
- the reactions: ``/pulls/<n>/comments`` (sorted newest first, one page), and ``/pulls/<n>/reviews`` and
  ``/issues/<n>/comments``, which GitHub answers oldest first and cannot sort: their first page and, when the
  ``Link`` header names a ``last`` page, that one too (two pages at most each), so the newest are read; past two
  pages the ones between are not, and ``more`` says so. Each author's ``author_association`` (OWNER, MEMBER or
  COLLABORATOR) is the first cut and ``user.type`` ``Bot`` (the App's own included) is dropped; then each such
  author's permission is read (``/collaborators/<login>/permission``, at most ``MAX_AUTHORS``), and only write access
  keeps a reaction;
- once merged: ``/commits?sha=<default branch>&since=<merged_at>`` (the revert), ``/pulls/<n>/files`` and, per file,
  ``/commits?sha=&path=&since=&until=`` (people's commits after the merge: a bot's, the App's own and one that names
  an agent branch left out; the files' names only).
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from typing import Final
from urllib.parse import parse_qs, urlsplit

from engineering.connectors.hosts import NotFound
from engineering.connectors.reactions import (
    GITHUB_WRITERS,
    MAX_COMMITS_AFTER,
    Candidate,
    ItemKind,
    PullRequestReactions,
    after_merge,
    handle,
    iso,
    kept,
    page_query,
    people_commits,
    verified,
    window_end,
)
from engineering.connectors.transport import Response, dig, json_of, list_of

#: A GET of ``path`` (after ``/repos/<owner>/<name>``) on the client, answered when its status is 200 or 404.
Get = Callable[[str], Response]
#: GitHub's review states, as the read names them (a dismissed or pending review is no reaction).
_REVIEW_STATES: Final[Mapping[str, str]] = {
    'APPROVED': 'approved', 'CHANGES_REQUESTED': 'changes_requested', 'COMMENTED': 'commented'}
_LAST: Final = re.compile(r'<([^>]+)>;\s*rel="last"')
#: The highest last page a read asks for (a page number GitHub handed out).
_MAX_PAGE: Final = 10_000


def _more(response: Response) -> bool:
    return 'rel="next"' in response.headers.get('link', '')


def _last_page(response: Response) -> int:
    found = _LAST.search(response.headers.get('link', ''))
    page = parse_qs(urlsplit(found.group(1)).query).get('page', [''])[0] if found else ''
    return int(page) if page.isdigit() and 0 < int(page) <= _MAX_PAGE else 0


def _newest(get: Get, path: str) -> tuple[list[object], bool]:
    """An oldest-first list's first page and, when there are more, its last (the newest); whether pages between them
    were left unread."""
    first = get(f'{path}?{page_query()}')
    last = _last_page(first)
    if last <= 1:
        return list_of(first), False
    return list_of(first) + list_of(get(f'{path}?{page_query(page=last)}')), last > 2


def _is_bot(user: object) -> bool:
    login = dig(user, 'login')
    # (the App's own user is a bot: ``<app>[bot]``, type Bot)
    return dig(user, 'type') == 'Bot' or (isinstance(login, str) and login.endswith('[bot]'))


def _candidate(item: object, kind: ItemKind, state: str, at_key: str) -> Candidate:
    body = dig(item, 'body')
    return Candidate(kind=kind, state=state, author=handle(dig(item, 'user', 'login')), at=iso(dig(item, at_key)),
                     body=body if isinstance(body, str) else '', writer=dig(item, 'author_association') in GITHUB_WRITERS,
                     bot=_is_bot(dig(item, 'user')))


def _candidates(get: Get, number: int) -> tuple[list[Candidate], bool]:
    reviews, more_reviews = _newest(get, f'/pulls/{number}/reviews')
    review_comments = get(f'/pulls/{number}/comments?{page_query(sort="created", direction="desc")}')
    comments, more_comments = _newest(get, f'/issues/{number}/comments')
    found = [_candidate(item, 'review', _REVIEW_STATES[str(dig(item, 'state'))], 'submitted_at')
             for item in reviews if dig(item, 'state') in _REVIEW_STATES]
    found += [_candidate(item, 'review_comment', '', 'created_at') for item in list_of(review_comments)]
    found += [_candidate(item, 'comment', '', 'created_at') for item in comments]
    return found, more_reviews or more_comments or _more(review_comments)


def _commits(response: Response) -> list[tuple[str, str]]:
    return [(str(dig(item, 'sha')), str(dig(item, 'commit', 'message') or '')) for item in list_of(response)
            if isinstance(dig(item, 'sha'), str)]


def _people_commits(response: Response) -> list[str]:
    """The commit ids of a history page that people made: no bot's (its GitHub author), no agent's."""
    return people_commits((dig(item, 'sha'), _is_bot(dig(item, 'author')), dig(item, 'commit', 'message'))
                          for item in list_of(response))


def read(get: Get, host_url: str, number: int, branch: str, writes: Callable[[str], bool]) -> PullRequestReactions:
    """The reactions to pull request ``number`` (its record's address ``host_url``), the revert and people's commits
    after its merge on ``branch`` (the run's default branch); ``writes`` says whether a login may write."""
    answer = get(f'/pulls/{number}')
    if answer.status == 404:
        raise NotFound(f'The repository has no pull request {number}.')
    data = json_of(answer)
    merged_at, merge_commit = iso(dig(data, 'merged_at')), dig(data, 'merge_commit_sha')
    candidates, more = _candidates(get, number)
    items, dropped = kept(verified(candidates, writes))
    found = PullRequestReactions(host='github', number=number, url=host_url,
                                 state='open' if dig(data, 'state') == 'open' else 'closed', items=items,
                                 dropped=dropped, more=more)
    if not merged_at or not isinstance(merge_commit, str):
        return found
    after = get(f'/commits?{page_query(MAX_COMMITS_AFTER, sha=branch, since=merged_at)}')
    files = get(f'/pulls/{number}/files?{page_query()}')
    until = window_end(merged_at)

    def touched(path: str) -> list[str]:
        return _people_commits(get(f'/commits?{page_query(sha=branch, path=path, since=merged_at, until=until)}'))

    paths = [str(dig(item, 'filename')) for item in list_of(files) if isinstance(dig(item, 'filename'), str)]
    return after_merge(found, merged_at, merge_commit, _commits(after), paths, touched, _more(after) or _more(files))
