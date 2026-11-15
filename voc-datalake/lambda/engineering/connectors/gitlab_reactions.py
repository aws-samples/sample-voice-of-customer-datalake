"""GitLab's answers to a reactions read (7.10.00; ``reactions.py`` holds the model, the bounds and the trust filter).

``GitLabHost.reactions`` hands this a ``get`` on its own client (the project's token, its bounded retry of a lost read,
every refusal a redacted ``HostError``), the token's own user's id, and a lookup of a user's access level on the
project (the members API, cached by the client). At most 5 requests, plus one per read file of the merge request
(``MAX_EDIT_PATHS``) and one per author not yet cached (at most ``MAX_AUTHORS``), each one page of ``PAGE_SIZE``,
none of them a write:

- ``/merge_requests/<iid>``: the state, ``merged_at`` and the merge's commit (``merge_commit_sha``, else
  ``squash_commit_sha``);
- ``/merge_requests/<iid>/notes`` (newest first): a system note "approved this merge request" or "requested changes"
  is a review, a diff note a review comment, any other note by a person a comment; each author's access level is read
  (Developer, 30, or above kept), and a bot (``bot``, a project or group token's ``project_<id>_bot…`` user, the
  connection's own token's user) is dropped;
- once merged: ``/repository/commits?ref_name=<default branch>&since=<merged_at>`` (the revert),
  ``/merge_requests/<iid>/diffs`` (the files' names only: the diff text is never kept) and, per file,
  ``/repository/commits?ref_name=&path=&since=&until=`` (people's commits after the merge: one authored or committed
  by a project or group token's user, the agents' own among them, or naming an agent branch is left out).
"""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import Final

from engineering.connectors.gitlab_api import next_page
from engineering.connectors.hosts import NotFound
from engineering.connectors.reactions import (
    GITLAB_WRITER_LEVEL,
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
    window_end,
)
from engineering.connectors.transport import Response, dig, json_of, list_of

#: A GET of ``path`` (after ``/projects/<id>``) on the client, answered when its status is 200 or 404.
Get = Callable[[str], Response]
#: A user's access level on the project (0: not a member).
Level = Callable[[int], int]
#: The distinct authors whose access level one read looks up, at most (the rest are dropped as unchecked).
MAX_AUTHORS: Final = 20
#: A project's or group's access token's bot user, as GitLab names them.
_TOKEN_BOT: Final = re.compile(r'(?:project|group)_[0-9]+_bot(?:_[0-9a-z]+|[0-9]*)')
_REVIEW_NOTES: Final = (('approved this merge request', 'approved'), ('requested changes', 'changes_requested'))


def _review_state(note: object) -> str:
    body = dig(note, 'body')
    text = body.strip().lower() if isinstance(body, str) else ''
    return next((state for words, state in _REVIEW_NOTES if text.startswith(words)), '')


def _is_bot(note: object, own_user: int) -> bool:
    """A bot: ``bot``, a ``user_type`` other than ``human`` where the API answers one (a project bot, a service
    account), a project or group token's user, or the connection's own token's user."""
    username, user_type = dig(note, 'author', 'username'), dig(note, 'author', 'user_type')
    return (dig(note, 'author', 'bot') is True or dig(note, 'author', 'id') == own_user
            or (isinstance(user_type, str) and user_type != 'human')
            or (isinstance(username, str) and _TOKEN_BOT.fullmatch(username) is not None))


def _token_bot_address(address: object) -> bool:
    """A commit author's address that is a project or group token's user's (``project_<id>_bot…@…``)."""
    return isinstance(address, str) and _TOKEN_BOT.fullmatch(address.partition('@')[0]) is not None


def _kind(note: object, system: bool) -> ItemKind:
    if system:
        return 'review'
    return 'review_comment' if dig(note, 'type') == 'DiffNote' else 'comment'


def _candidates(notes: list[object], own_user: int, level: Level) -> list[Candidate]:
    """Each note that is a reaction, its author's write access read (``MAX_AUTHORS`` at most; any other unchecked,
    so dropped)."""
    levels: dict[int, int] = {}
    found: list[Candidate] = []
    for note in notes:
        system = dig(note, 'system') is True
        state = _review_state(note) if system else ''
        if system and not state:
            continue   # (any other system note is GitLab's own: a push, a label, a title change)
        author, bot = dig(note, 'author', 'id'), _is_bot(note, own_user)
        if isinstance(author, int) and not bot and author not in levels and len(levels) < MAX_AUTHORS:
            levels[author] = level(author)
        body = dig(note, 'body')
        found.append(Candidate(kind=_kind(note, system), state=state, author=handle(dig(note, 'author', 'username')),
                               at=iso(dig(note, 'created_at')),
                               body='' if system or not isinstance(body, str) else body,
                               writer=isinstance(author, int) and levels.get(author, 0) >= GITLAB_WRITER_LEVEL,
                               bot=bot))
    return found


def _commits(response: Response) -> list[tuple[str, str]]:
    return [(str(dig(item, 'id')), str(dig(item, 'message') or '')) for item in list_of(response)
            if isinstance(dig(item, 'id'), str)]


def _people_commits(response: Response) -> list[str]:
    """The commit ids of a history page that people made: no token bot's (the connection's own, whose commits are the
    agents'), no agent's (naming an agent branch)."""
    found = list_of(response)
    bots = [_token_bot_address(dig(item, 'author_email')) or _token_bot_address(dig(item, 'committer_email'))
            for item in found]
    return people_commits(zip([dig(item, 'id') for item in found], bots, [dig(item, 'message') for item in found],
                              strict=True))


def read(get: Get, host_url: str, number: int, branch: str, own_user: Callable[[], int],
         level: Level) -> PullRequestReactions:
    """The reactions to merge request ``number`` (its IID; its record's address ``host_url``), the revert and the edits
    after its merge on ``branch`` (the run's default branch); ``own_user`` (the token's user's id) is asked only when
    there are notes to filter."""
    answer = get(f'/merge_requests/{number}')
    if answer.status == 404:
        raise NotFound(f'The repository has no merge request {number}.')
    data = json_of(answer)
    merged_at, state = iso(dig(data, 'merged_at')), dig(data, 'state')
    notes = get(f'/merge_requests/{number}/notes?{page_query(sort="desc", order_by="created_at")}')
    listed = list_of(notes)
    items, dropped = kept(_candidates(listed, own_user() if listed else 0, level))
    found = PullRequestReactions(host='gitlab', number=number, url=host_url,
                                 state='merged' if state == 'merged' else 'open' if state == 'opened' else 'closed',
                                 merged_at=merged_at, items=items, dropped=dropped,
                                 more=next_page(notes.headers) is not None)
    merge_commit = next((sha for sha in (dig(data, 'merge_commit_sha'), dig(data, 'squash_commit_sha'))
                         if isinstance(sha, str) and sha), '')
    if found.state != 'merged' or not (merged_at and merge_commit):
        return found
    after = get(f'/repository/commits?{page_query(MAX_COMMITS_AFTER, ref_name=branch, since=merged_at)}')
    diffs = get(f'/merge_requests/{number}/diffs?{page_query()}')
    until = window_end(merged_at)

    def touched(path: str) -> list[str]:
        query = page_query(ref_name=branch, path=path, since=merged_at, until=until)
        return _people_commits(get(f'/repository/commits?{query}'))

    paths = sorted({str(path) for item in list_of(diffs) for path in (dig(item, 'new_path'), dig(item, 'old_path'))
                    if isinstance(path, str) and path})
    return after_merge(found, merged_at, merge_commit, _commits(after), paths, touched,
                       next_page(after.headers) is not None or next_page(diffs.headers) is not None)
