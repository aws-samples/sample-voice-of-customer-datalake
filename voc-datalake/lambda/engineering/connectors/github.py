"""The GitHub client of the connector's broker (docs/autonomous-engineering.md, "Repository connectors").

Credentials: the connection's GitHub App (``credentials``). A call reuses a cached installation token, or signs a
short App JWT (RS256, nine minutes) and mints one: an installation token for exactly the connection's one repository and the permissions the
operation needs (``contents``, ``issues``, ``pull_requests``: read or write; ``metadata: read`` comes with every
token). A token is kept in memory until ``TOKEN_MARGIN_SECONDS`` before it expires (GitHub's tokens live an hour);
none is revoked early: once a run is stopped the broker refuses its every operation before any token is used.

Writes, and how each holds the broker's ``tree_hash``:

* a comment on an issue or a pull request;
* a push of a bundle, already read into commits (``BundleContents``): the client refuses a commit that changes a
  path outside the bundle's ``changed_paths`` (what the write rules checked), and refuses unless the branch's head
  is the bundle's ``base`` or, for a new branch, ``base`` is the default branch's head or an ancestor of it. It
  rebuilds the commits with the Git Data API (a tree on the parent's tree, text files inline and other files as
  blobs, then a commit; author and committer are the App's own bot), refuses unless the last tree GitHub computed
  is ``tree_hash``, and only then moves the branch, with ``force: false`` (a push made meanwhile is not a
  fast-forward of it and is refused), or creates it (refused when it was created meanwhile). Objects of a refused
  push stay unreferenced, and GitHub collects them;
* a draft pull request, opened, or its title and body updated, only when the branch's head has ``tree_hash``, and
  checked again afterwards: when the pull request's head does not have it (the branch moved meanwhile), or the
  check itself fails, one the client just opened is closed and the write is refused. An update changes only the title and body: GitHub's REST
  API cannot turn a pull request a person marked ready back into a draft.

The client has no method for a merge, an approval, settings, branch protection, members, webhooks or secrets.
Every request goes to ``api.github.com`` through one ``Transport`` (tests inject a fake): the token travels only in
the ``Authorization`` header, never in a URL; no redirect is followed; reads follow ``Link`` pagination by page
number (the cursor). A rate limit (``Retry-After``, ``X-RateLimit-Reset``, a secondary rate limit) is never waited
out inside a call: it is ``HostBusy`` with the seconds to wait. Nothing a request or a response carries is logged.
"""
from __future__ import annotations

import base64
import http.client
import json
import math
import re
import ssl
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Protocol
from urllib.parse import parse_qs, quote, urlencode, urlsplit

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

from engineering.connectors.credentials import GitHubAppCredential
from engineering.connectors.hosts import (
    FILE_MODES,
    OBJECT_ID,
    BundleContents,
    CommentTarget,
    Conflict,
    FileChange,
    HostBusy,
    HostError,
    InvalidTarget,
    NoConnection,
    NotFound,
    PullRequestRef,
    ReadKind,
    ReadPage,
)
from engineering.connectors.write_policy import BrokerError, WriteRefused
from shared.github_rest import GITHUB_API, GITHUB_API_VERSION
from shared.logging import logger

API_HOST: Final = GITHUB_API.removeprefix('https://')
#: The App JWT's life: GitHub takes at most ten minutes; ``iat`` is set a minute back for clock drift.
JWT_SECONDS: Final = 540
#: A token is minted again this long before it expires, so no call starts with one about to lapse.
TOKEN_MARGIN_SECONDS: Final = 300
#: A rate limit with no header to say how long (a secondary limit, a bare 429): GitHub asks for at least a minute.
DEFAULT_RETRY_SECONDS: Final = 60
#: The most of one response the client reads (a Lambda function URL answers at most 6 MB).
MAX_RESPONSE_BYTES: Final = 5 * 1024 * 1024
PAGE_SIZE: Final = 30
#: A comparison of a new branch's base with the default branch that puts the base on it (``base...head``: the head
#: is behind the base, or the same commit).
_ON_DEFAULT_BRANCH: Final = frozenset({'behind', 'identical'})
#: Requests that change nothing on the host, so a lost answer can be retried: reads, and minting an installation
#: token (a second token is harmless; it expires within the hour).
_SAFE_METHODS: Final = frozenset({'GET', 'HEAD'})
_TOKEN_PATH: Final = re.compile(r'/app/installations/[0-9]+/access_tokens\Z')
_JSON: Final = 'application/vnd.github+json'
_RAW: Final = 'application/vnd.github.raw+json'
_PAGE: Final = re.compile(r'[1-9][0-9]{0,4}')
_NUMBER: Final = re.compile(r'[1-9][0-9]{0,9}')
_NEXT: Final = re.compile(r'<([^>]+)>;\s*rel="next"')

Permissions = Mapping[str, str]
_READS: Final[Mapping[ReadKind, Permissions]] = {
    'file': {'contents': 'read'}, 'history': {'contents': 'read'},
    'issue': {'issues': 'read'}, 'pull_request': {'pull_requests': 'read'},
}
_COMMENTS: Final[Mapping[CommentTarget, Permissions]] = {
    'issue': {'issues': 'write'}, 'pull_request': {'pull_requests': 'write'}}
_PUSH: Final[Permissions] = {'contents': 'write'}
_BRANCH: Final[Permissions] = {'contents': 'read'}
#: The repository's own facts (its default branch): what every token holds anyway.
_METADATA: Final[Permissions] = {'metadata': 'read'}
#: How long a connection's default branch is kept before it is read again.
DEFAULT_BRANCH_SECONDS: Final = 300
_DRAFT: Final[Permissions] = {'contents': 'read', 'pull_requests': 'write'}


@dataclass(frozen=True)
class Response:
    status: int
    #: Header names in lower case.
    headers: Mapping[str, str]
    body: bytes


class Transport(Protocol):
    def request(self, method: str, path: str, headers: Mapping[str, str], body: bytes | None) -> Response: ...


class _Answer(Protocol):
    status: int

    def read(self, limit: int, /) -> bytes: ...

    def getheaders(self) -> list[tuple[str, str]]: ...


class _Connection(Protocol):
    def request(self, method: str, url: str, body: bytes | None, headers: Mapping[str, str]) -> None: ...

    def getresponse(self) -> _Answer: ...

    def close(self) -> None: ...


class HttpsTransport:
    """``api.github.com`` over HTTPS with the default certificate checks; a path, never a URL, so no other host."""

    def __init__(self, timeout: float = 10.0,
                 connect: Callable[..., _Connection] = http.client.HTTPSConnection) -> None:
        self._timeout = timeout
        self._connect = connect

    def request(self, method: str, path: str, headers: Mapping[str, str], body: bytes | None) -> Response:
        connection = self._connect(API_HOST, timeout=self._timeout, context=ssl.create_default_context())
        sent = False
        try:
            connection.request(method, path, body=body, headers=dict(headers))
            sent = True
            answer = connection.getresponse()
            data = answer.read(MAX_RESPONSE_BYTES + 1)
            status, received = answer.status, {name.lower(): value for name, value in answer.getheaders()}
        except (OSError, http.client.HTTPException):
            # A write whose answer was lost may have happened: "retry later" could make it twice (a second comment,
            # a second pull request), so only a read, or a request that never left, is answered as retryable.
            if sent and method not in _SAFE_METHODS and not _TOKEN_PATH.match(path):
                raise HostError('The repository host\'s answer to a write was lost: the write may have happened, '
                                'so check before trying it again.') from None
            raise HostBusy('The repository host could not be reached.', retry_after=DEFAULT_RETRY_SECONDS) from None
        finally:
            connection.close()
        if len(data) > MAX_RESPONSE_BYTES:
            raise HostError('The repository host answered with more than the broker reads.')
        return Response(status=status, headers=received, body=data)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def app_jwt(credential: GitHubAppCredential, now: float) -> str:
    """The App's JWT (RS256): issued a minute back, expiring ``JWT_SECONDS`` from ``now``, issuer the App id."""
    header = _b64url(json.dumps({'alg': 'RS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    claims = _b64url(json.dumps({'iat': int(now) - 60, 'exp': int(now) + JWT_SECONDS, 'iss': credential.app_id},
                                separators=(',', ':')).encode())
    signing_input = f'{header}.{claims}'.encode('ascii')
    signature = credential.private_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return f'{header}.{claims}.{_b64url(signature)}'


def rate_limit_retry(response: Response, now: float) -> int | None:
    """The seconds GitHub asks the client to wait before it retries ``response``'s request (at least one), or
    ``None`` when it is not rate limited (a plain 403 is a refusal, not a limit)."""
    if response.status not in (403, 429):
        return None
    retry_after = response.headers.get('retry-after', '')
    if retry_after.isdigit():
        return max(1, int(retry_after))
    reset = response.headers.get('x-ratelimit-reset', '')
    if response.headers.get('x-ratelimit-remaining') == '0' and reset.isdigit():
        return max(1, math.ceil(float(reset) - now))
    if response.status == 429 or b'secondary rate limit' in response.body.lower():
        return DEFAULT_RETRY_SECONDS
    return None


def next_page(headers: Mapping[str, str]) -> str | None:
    """The page number of the ``Link`` header's ``rel="next"`` (the next read's cursor), or ``None``."""
    found = _NEXT.search(headers.get('link', ''))
    page = parse_qs(urlsplit(found.group(1)).query).get('page', [''])[0] if found else ''
    return page if _PAGE.fullmatch(page) else None


def _page(cursor: str | None) -> str:
    if cursor is None:
        return '1'
    if not _PAGE.fullmatch(cursor):
        raise InvalidTarget('The cursor is not one the broker handed out.')
    return cursor


def _repository_path(target: str) -> str:
    """``target`` as a path inside the repository, URL-quoted; never one that climbs out of it."""
    parts = target.split('/')
    if any(part in {'', '.', '..'} for part in parts) or any(ord(c) < 32 or c == '\\' for c in target):
        raise InvalidTarget('The target is a path inside the repository: no empty, "." or ".." part.')
    return quote(target, safe='/')


def _number(target: str) -> str:
    if not _NUMBER.fullmatch(target):
        raise InvalidTarget('The target is the number of an issue or a pull request.')
    return target


def _json(response: Response) -> Any:
    try:
        return json.loads(response.body)
    except ValueError:
        raise HostError(f'The repository host answered {response.status} with a body that is not JSON.') from None


def _text(value: object, key: str) -> str:
    found = value.get(key) if isinstance(value, dict) else None
    if not isinstance(found, str):
        raise HostError(f'The repository host answered without "{key}".')
    return found


def _int(value: object, key: str) -> int:
    found = value.get(key) if isinstance(value, dict) else None
    if not isinstance(found, int) or isinstance(found, bool):
        raise HostError(f'The repository host answered without "{key}".')
    return found


def _dig(value: object, *keys: str) -> object:
    for key in keys:
        value = value.get(key) if isinstance(value, dict) else None
    return value


def _items(data: object, fields: Mapping[str, tuple[str, ...]]) -> list[dict[str, object]]:
    """Each item of a list answer, as ``fields`` (name -> the keys to it) pick it."""
    return [{name: _dig(item, *keys) for name, keys in fields.items()}
            for item in (data if isinstance(data, list) else [])]


_COMMENT_FIELDS: Final[Mapping[str, tuple[str, ...]]] = {
    'id': ('id',), 'author': ('user', 'login'), 'created_at': ('created_at',), 'body': ('body',)}
_REVIEW_COMMENT_FIELDS: Final[Mapping[str, tuple[str, ...]]] = {
    **_COMMENT_FIELDS, 'path': ('path',), 'line': ('line',)}
_REVIEW_FIELDS: Final[Mapping[str, tuple[str, ...]]] = {
    'id': ('id',), 'author': ('user', 'login'), 'state': ('state',), 'submitted_at': ('submitted_at',),
    'body': ('body',)}


def _stray_changes(contents: BundleContents) -> list[str]:
    """Why a bundle's commits are not the ones the write rules checked: a change outside ``changed_paths``, or a
    file mode the client does not write."""
    listed = set(contents.changed_paths)
    changes = [change for commit in contents.commits for change in commit.changes]
    found = [f'A pushed commit changes a path the bundle does not list ({path}).'
             for path in sorted({c.path for c in changes} - listed)]
    found += [f'A pushed file must be a regular file, an executable or a symbolic link ({path}).'
              for path in sorted({c.path for c in changes if c.mode not in FILE_MODES})]
    return found


class GitHubHost:
    """``RepositoryHost`` over the GitHub REST API, one App installation token per repository and permission set."""

    def __init__(self, credentials: Callable[[str], GitHubAppCredential], transport: Transport | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self._credentials = credentials
        self._transport = transport or HttpsTransport()
        self._clock = clock
        #: (connection, installation, owner/repository, permissions) -> (token, when it stops being used).
        self._tokens: dict[tuple[str, int, str, tuple[tuple[str, str], ...]], tuple[str, float]] = {}
        #: (connection, owner/repository) -> (its default branch, when it is read again).
        self._default_branches: dict[tuple[str, str], tuple[str, float]] = {}

    # --- HTTP -------------------------------------------------------------------------------------------------

    def _send(self, method: str, path: str, authorization: str, what: str, body: object = None,
              accept: str = _JSON, ok: tuple[int, ...] = (200,)) -> Response:
        headers = {'Accept': accept, 'Authorization': authorization, 'User-Agent': 'voc-engineering-broker',
                   'X-GitHub-Api-Version': GITHUB_API_VERSION}
        data = None if body is None else json.dumps(body).encode()
        if data is not None:
            headers['Content-Type'] = 'application/json'
        response = self._transport.request(method, path, headers, data)
        retry = rate_limit_retry(response, self._clock())
        if retry is not None:
            raise HostBusy(f'The repository host is rate limiting {what}; retry later.', retry_after=retry)
        if response.status not in ok:
            raise HostError(f'The repository host answered {response.status} to {what}.')
        return response

    def _token(self, connection_id: str, permissions: Permissions) -> tuple[GitHubAppCredential, str]:
        credential = self._credentials(connection_id)
        # The installation and repository are in the key: a connection re-pointed at another repository (or
        # installation) never reuses a token minted for the old one.
        key = (connection_id, credential.installation_id, f'{credential.owner}/{credential.repository}',
               tuple(sorted(permissions.items())))
        held = self._tokens.get(key)
        now = self._clock()
        if held is not None and now < held[1]:
            return credential, held[0]
        response = self._send('POST', f'/app/installations/{credential.installation_id}/access_tokens',
                              f'Bearer {app_jwt(credential, now)}', 'the token request', ok=(201,),
                              body={'repositories': [credential.repository], 'permissions': dict(permissions)})
        data = _json(response)
        try:
            expires = datetime.fromisoformat(_text(data, 'expires_at')).timestamp()
        except ValueError:
            raise HostError('The repository host answered the token request without a valid expiry.') from None
        token = _text(data, 'token')
        self._tokens[key] = (token, expires - TOKEN_MARGIN_SECONDS)
        return credential, token

    def _api(self, connection_id: str, permissions: Permissions, method: str, path: str, what: str,
             body: object = None, accept: str = _JSON, ok: tuple[int, ...] = (200,)) -> Response:
        """``path`` (after ``/repos/{owner}/{repo}``) with a token for ``permissions`` on the connection's repo."""
        credential, token = self._token(connection_id, permissions)
        return self._send(method, f'/repos/{credential.owner}/{credential.repository}{path}', f'Bearer {token}',
                          what, body=body, accept=accept, ok=ok)

    # --- reads ------------------------------------------------------------------------------------------------

    def read(self, connection_id: str, kind: ReadKind, target: str, cursor: str | None) -> ReadPage:
        if kind == 'file':
            return self._read_file(connection_id, target, cursor)
        page = _page(cursor)
        if kind == 'history':
            return self._read_history(connection_id, target, page)
        return self._read_thread(connection_id, kind, _number(target), page)

    def _read_file(self, connection_id: str, target: str, cursor: str | None) -> ReadPage:
        if cursor is not None:
            raise InvalidTarget('A file is read whole; it has no pages.')
        response = self._api(connection_id, _READS['file'], 'GET', f'/contents/{_repository_path(target)}',
                             'the file read', accept=_RAW, ok=(200, 404))
        if response.status == 404:
            raise NotFound('The repository has no such file on its default branch.')
        try:
            return ReadPage(content=response.body.decode('utf-8'), next_cursor=None)
        except UnicodeDecodeError:
            raise InvalidTarget('The file is not UTF-8 text; the broker reads text files only.') from None

    def file_at(self, connection_id: str, commit: str, path: str) -> bytes | None:
        """The bytes of ``path`` at ``commit`` (a full object id), ``None`` when the commit has no such file: a
        submitted patch's base (``patches.py``). At most ``MAX_RESPONSE_BYTES``, like every answer."""
        if not OBJECT_ID.fullmatch(commit):
            raise InvalidTarget('The commit is a full object id.')
        response = self._api(connection_id, _READS['file'], 'GET',
                             f'/contents/{_repository_path(path)}?{urlencode({"ref": commit})}', 'the base file read',
                             accept=_RAW, ok=(200, 404))
        return None if response.status == 404 else response.body

    def default_branch(self, connection_id: str) -> str:
        """The repository's default branch, kept ``DEFAULT_BRANCH_SECONDS`` per connection and repository."""
        credential = self._credentials(connection_id)
        key = (connection_id, f'{credential.owner}/{credential.repository}')
        held = self._default_branches.get(key)
        now = self._clock()
        if held is not None and now < held[1]:
            return held[0]
        branch = _text(_json(self._api(connection_id, _METADATA, 'GET', '', 'the repository read')), 'default_branch')
        self._default_branches[key] = (branch, now + DEFAULT_BRANCH_SECONDS)
        return branch

    def _read_history(self, connection_id: str, target: str, page: str) -> ReadPage:
        # "." is the whole repository's history; any other target, the history of that path.
        fields: dict[str, object] = {'per_page': PAGE_SIZE, 'page': page}
        if target != '.':
            _repository_path(target)
            fields['path'] = target
        response = self._api(connection_id, _READS['history'], 'GET', f'/commits?{urlencode(fields)}',
                             'the history read')
        commits = _items(_json(response), {'sha': ('sha',), 'date': ('commit', 'committer', 'date'),
                                           'message': ('commit', 'message')})
        return ReadPage(content=json.dumps({'commits': commits}), next_cursor=next_page(response.headers))

    def _read_thread(self, connection_id: str, kind: ReadKind, number: str, page: str) -> ReadPage:
        """An issue, or a pull request, with its conversation (and a pull request's review comments and reviews),
        one page of each; the next cursor while any of them has another page."""
        permissions = _READS[kind]
        what = 'the issue read' if kind == 'issue' else 'the pull request read'
        content: dict[str, object] = {}
        if page == '1':
            item = self._api(connection_id, permissions, 'GET',
                             f'/issues/{number}' if kind == 'issue' else f'/pulls/{number}', what, ok=(200, 404))
            if item.status == 404:
                raise NotFound(f'The repository has no {kind.replace("_", " ")} {number}.')
            data = _json(item)
            content[kind] = {key: _dig(data, key) for key in ('number', 'title', 'state', 'body', 'draft')
                             if isinstance(data, dict) and key in data}
        query = urlencode({'per_page': PAGE_SIZE, 'page': page})
        parts = [('comments', f'/issues/{number}/comments', _COMMENT_FIELDS)]
        if kind == 'pull_request':
            parts += [('review_comments', f'/pulls/{number}/comments', _REVIEW_COMMENT_FIELDS),
                      ('reviews', f'/pulls/{number}/reviews', _REVIEW_FIELDS)]
        cursors: list[str] = []
        for key, path, fields in parts:
            response = self._api(connection_id, permissions, 'GET', f'{path}?{query}', what)
            content[key] = _items(_json(response), fields)
            cursors += [c for c in [next_page(response.headers)] if c is not None]
        return ReadPage(content=json.dumps(content), next_cursor=cursors[0] if cursors else None)

    def _open_pull_request(self, connection_id: str, permissions: Permissions, branch: str) -> PullRequestRef | None:
        credential = self._credentials(connection_id)
        query = urlencode({'state': 'open', 'head': f'{credential.owner}:{branch}', 'per_page': 1})
        found = _json(self._api(connection_id, permissions, 'GET', f'/pulls?{query}', 'the pull request lookup'))
        first = found[0] if isinstance(found, list) and found else None
        return None if first is None else PullRequestRef(number=_int(first, 'number'), url=_text(first, 'html_url'))

    def branch_tree_hash(self, connection_id: str, branch: str) -> str | None:
        return self._branch_tree(connection_id, _BRANCH, branch)

    def _head(self, connection_id: str, permissions: Permissions, branch: str) -> str | None:
        response = self._api(connection_id, permissions, 'GET', f'/git/ref/heads/{quote(branch, safe="/")}',
                             'the branch lookup', ok=(200, 404))
        return None if response.status == 404 else _text(_dig(_json(response), 'object'), 'sha')

    def _tree_of(self, connection_id: str, permissions: Permissions, commit: str) -> str | None:
        """The tree of ``commit``, or ``None`` when the repository has no such commit."""
        response = self._api(connection_id, permissions, 'GET', f'/git/commits/{quote(commit, safe="")}',
                             'the commit lookup', ok=(200, 404))
        return None if response.status == 404 else _text(_dig(_json(response), 'tree'), 'sha')

    def _branch_tree(self, connection_id: str, permissions: Permissions, branch: str) -> str | None:
        head = self._head(connection_id, permissions, branch)
        return None if head is None else self._tree_of(connection_id, permissions, head)

    # --- writes -----------------------------------------------------------------------------------------------

    def post_comment(self, connection_id: str, on: CommentTarget, number: int, body: str) -> str:
        response = self._api(connection_id, _COMMENTS[on], 'POST', f'/issues/{number}/comments', 'the comment',
                             body={'body': body}, ok=(201,))
        return _text(_json(response), 'html_url')

    def _entry(self, connection_id: str, change: FileChange) -> dict[str, object]:
        """A tree entry for ``change``: a deletion, a text file inline, any other file as a blob."""
        entry: dict[str, object] = {'path': change.path, 'mode': change.mode, 'type': 'blob'}
        if change.content is None:
            return {**entry, 'sha': None}
        try:
            return {**entry, 'content': change.content.decode('utf-8')}
        except UnicodeDecodeError:
            blob = self._api(connection_id, _PUSH, 'POST', '/git/blobs', 'the push', ok=(201,),
                             body={'content': base64.b64encode(change.content).decode('ascii'), 'encoding': 'base64'})
            return {**entry, 'sha': _text(_json(blob), 'sha')}

    def _require_on_default_branch(self, connection_id: str, default_branch: str, base: str) -> None:
        compare = f'{quote(default_branch, safe="/")}...{quote(base, safe="")}'
        response = self._api(connection_id, _PUSH, 'GET', f'/compare/{compare}?per_page=1', 'the push',
                             ok=(200, 404))
        if response.status == 404 or _dig(_json(response), 'status') not in _ON_DEFAULT_BRANCH:
            raise Conflict("A new branch starts on the default branch: the bundle's base is not its head or an "
                           'ancestor of it.')

    def push_bundle(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str,
                    default_branch: str) -> None:
        if not contents.commits:
            raise WriteRefused('A pushed bundle carries at least one commit.')
        stray = _stray_changes(contents)
        if stray:
            raise WriteRefused(' '.join(stray))
        if contents.tree_hash != tree_hash:
            raise Conflict("The bundle's head does not have the tree the broker checked.")
        head = self._head(connection_id, _PUSH, branch)
        if head is not None and head != contents.base:
            raise Conflict('The branch has moved since the bundle was made (its head is not the bundle\'s base); '
                           'fetch it and make the bundle again.')
        if head is None:
            self._require_on_default_branch(connection_id, default_branch, contents.base)
        tree = self._tree_of(connection_id, _PUSH, contents.base)
        if tree is None:
            raise Conflict("The repository has no commit the bundle's base names; fetch and make the bundle again.")
        parent = contents.base
        for commit in contents.commits:
            if commit.changes:
                entries = [self._entry(connection_id, change) for change in commit.changes]
                built = self._api(connection_id, _PUSH, 'POST', '/git/trees', 'the push', ok=(201,),
                                  body={'base_tree': tree, 'tree': entries})
                tree = _text(_json(built), 'sha')
            made = self._api(connection_id, _PUSH, 'POST', '/git/commits', 'the push', ok=(201,),
                             body={'message': commit.message, 'tree': tree, 'parents': [parent]})
            parent = _text(_json(made), 'sha')
        if tree != tree_hash:
            raise Conflict('The commits rebuilt on the host have another tree than the one the broker checked; '
                           'the branch was not moved.')
        ref = f'refs/heads/{branch}'
        if head is None:
            moved = self._api(connection_id, _PUSH, 'POST', '/git/refs', 'the push', ok=(201, 422),
                              body={'ref': ref, 'sha': parent})
        else:
            moved = self._api(connection_id, _PUSH, 'PATCH', f'/git/{quote(ref, safe="/")}', 'the push',
                              ok=(200, 422), body={'sha': parent, 'force': False})
        if moved.status == 422:
            raise Conflict('The branch changed while the bundle was pushed; fetch it and make the bundle again.')

    def _require_pull_request_tree(self, connection_id: str, number: int, tree_hash: str) -> None:
        """Raise ``Conflict`` unless the pull request's head has ``tree_hash``."""
        response = self._api(connection_id, _DRAFT, 'GET', f'/pulls/{number}', 'the pull request check')
        if self._tree_of(connection_id, _DRAFT, _text(_dig(_json(response), 'head'), 'sha')) != tree_hash:
            raise Conflict("The branch moved while the pull request was written: its head does not have the tree "
                           "the board's GO is for.")

    def open_or_update_draft_pr(self, connection_id: str, branch: str, base: str, title: str, body: str,
                                tree_hash: str) -> PullRequestRef:
        if self._branch_tree(connection_id, _DRAFT, branch) != tree_hash:
            raise Conflict("The branch's head does not have the tree the board's GO is for.")
        ref = self._open_pull_request(connection_id, _DRAFT, branch)
        opened = ref is None
        if ref is not None:
            self._api(connection_id, _DRAFT, 'PATCH', f'/pulls/{ref.number}', 'the pull request update',
                      body={'title': title, 'body': body})
        else:
            created = _json(self._api(connection_id, _DRAFT, 'POST', '/pulls', 'the draft pull request', ok=(201,),
                                      body={'title': title, 'body': body, 'head': branch, 'base': base,
                                            'draft': True}))
            ref = PullRequestRef(number=_int(created, 'number'), url=_text(created, 'html_url'))
        try:
            self._require_pull_request_tree(connection_id, ref.number, tree_hash)
        except Exception:
            # Whatever stops the check (the branch moved, a rate limit, a host error), a pull request this call
            # opened is not left open unchecked; the original failure is what the caller gets.
            if opened:
                self._close(connection_id, ref.number)
            raise
        return ref

    def _close(self, connection_id: str, number: int) -> None:
        """Close the pull request ``number`` this call opened; a close that fails is logged by its number only."""
        try:
            self._api(connection_id, _DRAFT, 'PATCH', f'/pulls/{number}', 'the pull request close',
                      body={'state': 'closed'})
        except (BrokerError, NoConnection, ValueError, OSError):
            # A failure of the close (a host refusal, a malformed answer, a lost connection) is logged by number
            # only, so the caller still gets the failure that made the close necessary.
            logger.warning('engineering pull request not closed', extra={'pull_request': number})
