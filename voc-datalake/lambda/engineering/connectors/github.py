"""The GitHub client of the connector's broker (docs/autonomous-engineering.md, "Repository connectors").

Credentials: the connection's GitHub App (``credentials``). A call reuses a cached installation token, or signs a
short App JWT (RS256, nine minutes) and mints one: an installation token for exactly the connection's one repository and the permissions the
operation needs (``contents``, ``issues``, ``pull_requests``: read or write; ``metadata: read`` comes with every
token). A token is kept in memory until ``TOKEN_MARGIN_SECONDS`` before it expires (GitHub's tokens live an hour);
the broker's are never revoked early (once a run is stopped the broker refuses its every operation before any token
is used); the checkout cache's fetch token is, right after its fetch (``revoke_fetch_token``).

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
* labels added to an issue (7.50.00, ``issues: write``: the understander's triage labels, which the broker checks
  against its allowlist first); nothing is removed;
* a pull request, opened ready for review (or as a draft, when the run's flow says ``pr: draft``), or its title and
  body updated, only when the branch's head has ``tree_hash``, and checked again afterwards: when the pull request's
  head does not have it (the branch moved meanwhile), or the check itself fails, one the client just opened is closed
  and the write's outcome is unknown (OutcomeUnknown), never refused, since the host already wrote. An update changes
  only the title and body, never whether it is a draft (GitHub's REST API cannot turn a ready one back into a draft,
  and this client never marks a draft ready).

Reads: a file and history on the run's default branch (the broker hands it on: ``ref`` and ``sha``), an issue or a
pull request with its thread, a patch's base file at the run's commit, and, for the CI attestation's check
(7.04.00, ``ci_protection``), what any reader of the repository sees of its branch rules: a branch's ``protected``
and classic required checks, and the ruleset rules that apply to a branch's name.

Since 7.10.00 it also reads people's reactions to the run's pull request (``reactions``, ``github_reactions.py``):
its reviews and comments with their authors' associations, the commits on the default branch after its merge and its
files' names.

Since 7.57.00 (any public repository): a public repository read only (``PUBLIC_READ``) gets a token of
``metadata: read`` alone that names no repository, whatever its operation asks (it is in no installation; GitHub serves
a public repository to any reader); a fork's issue reads go to its upstream (``issues_repository``); a public read of a
whole ``/repos/`` path (``public_get``, the upstream's facts) uses the connection's ``metadata: read`` token. (7.58.00)
No request opens a pull request on the upstream: the run ends with a link a person clicks.

Since 7.60.00 (a fine-grained token, ``FINE_GRAINED``): the connection is read as a public repository is, with the App's
``metadata: read`` token naming no repository, and ``_token`` refuses any write permission on it, so no App write token
is ever minted for it; its run's push and pull request are ``push_bundle_as`` and ``open_or_update_pr_as``, whose writes
alone carry the token the broker hands them (``_token_writer``), each request held to the repository's Git Data and
pull request paths (``fine_grained.token_request_allowed``), every read with the App's read-only token. A 403 to a write
with the token is ``TokenCannotWrite`` (nothing moved: the step waits for a person); a 401 or a 404 (7.63.00: the token
revoked or regenerated, or no longer reaching the repository) ``TokenNotAccepted``, which says to replace the token,
nothing written either.

The client has no method for a merge, an approval, settings, a change of branch protection, members, webhooks or
secrets.
Every request goes to ``api.github.com`` through one ``Transport`` (tests inject a fake): the token travels only in
the ``Authorization`` header, never in a URL; no redirect is followed; reads follow ``Link`` pagination by page
number (the cursor). A rate limit (``Retry-After``, ``X-RateLimit-Reset``, a secondary rate limit) is never waited
out inside a call: it is ``HostBusy`` with the seconds to wait. Nothing a request or a response carries is logged.
"""
from __future__ import annotations

import base64
import json
import re
import time
from collections.abc import Callable, Mapping
from datetime import datetime
from functools import partial
from typing import Final
from urllib.parse import parse_qs, quote, urlencode, urlsplit

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from engineering.connectors import github_reactions
from engineering.connectors.credentials import GitHubAppCredential
from engineering.connectors.fine_grained import CANNOT_WRITE, NOT_ACCEPTED, token_request_allowed
from engineering.connectors.hosts import (
    FILE_MODES,
    FINE_GRAINED,
    FORK,
    OBJECT_ID,
    PAGE_NUMBER,
    PUBLIC_READ,
    STORED_BRANCH_MISSING,
    BranchCaches,
    BundleContents,
    CiProtection,
    CommentTarget,
    Conflict,
    FileChange,
    HostBusy,
    HostError,
    InvalidTarget,
    NoConnection,
    NotFound,
    NotNow,
    PullRequestRef,
    ReadKind,
    ReadPage,
    StoredBranchMissing,
    checked_after_write,
    file_page,
    fresh,
    keep,
    read_page,
    repository_path,
    require_base,
    require_pushable,
    stray_changes,
)
from engineering.connectors.reactions import PullRequestReactions, writer_permission
from engineering.connectors.transport import (
    DEFAULT_RETRY_SECONDS,
    FIND_PAGE_SIZE,
    HttpsTransport,
    Response,
    Transport,
    asked_wait,
    marked_comment,
    text_or_empty,
    text_unless_missing,
)
from engineering.connectors.transport import dig as _dig
from engineering.connectors.transport import int_of as _int
from engineering.connectors.transport import items_of as _items
from engineering.connectors.transport import json_of as _json
from engineering.connectors.transport import text_of as _text
from engineering.connectors.write_policy import BrokerError, WriteRefused
from shared.github_rest import GITHUB_API, GITHUB_API_VERSION
from shared.logging import logger

API_HOST: Final = GITHUB_API.removeprefix('https://')
#: The App JWT's life: GitHub takes at most ten minutes; ``iat`` is set a minute back for clock drift.
JWT_SECONDS: Final = 540
#: A token is minted again this long before it expires, so no call starts with one about to lapse.
TOKEN_MARGIN_SECONDS: Final = 300
PAGE_SIZE: Final = 30
#: A comparison of a new branch's base with the default branch that puts the base on it (``base...head``: the head
#: is behind the base, or the same commit).
_ON_DEFAULT_BRANCH: Final = frozenset({'behind', 'identical'})
#: Minting an installation token: a write whose lost answer may be repeated (a second token is harmless; it expires
#: within the hour), so the transport answers it as retryable, like a read.
TOKEN_PATH: Final = re.compile(r'/app/installations/[0-9]+/access_tokens\Z')
JSON_ACCEPT: Final = 'application/vnd.github+json'
RAW_ACCEPT: Final = 'application/vnd.github.raw+json'
_NEXT: Final = re.compile(r'<([^>]+)>;\s*rel="next"')
#: (7.104.00) The ``Link`` header's last and previous pages: an issue's comments read newest first (``issue_comment``);
#: the last page's is the reactions read's (``github_reactions.LAST_LINK``), one rule.
_LAST: Final = github_reactions.LAST_LINK
_PREV: Final = re.compile(r'<([^>]+)>;\s*rel="prev"')

Permissions = Mapping[str, str]
_READS: Final[Mapping[ReadKind, Permissions]] = {
    'file': {'contents': 'read'}, 'history': {'contents': 'read'},
    'issue': {'issues': 'read'}, 'pull_request': {'pull_requests': 'read'},
}
_COMMENTS: Final[Mapping[CommentTarget, Permissions]] = {
    'issue': {'issues': 'write'}, 'pull_request': {'pull_requests': 'write'}}
#: An issue's labels (7.50.00): issues write, nothing else.
#: An issue's labels written (``label_issue``), and the token function's ``ensure_label`` (app_tokens.py).
ISSUES_WRITE: Final[Permissions] = {'issues': 'write'}
_PUSH: Final[Permissions] = {'contents': 'write'}
_BRANCH: Final[Permissions] = {'contents': 'read'}
#: The checkout cache's fetch of one commit (``fetch_token``): read, nothing else.
_FETCH: Final[Permissions] = {'contents': 'read'}
#: The repository's own facts (its default branch): what every token holds anyway.
METADATA_READ: Final[Permissions] = {'metadata': 'read'}
#: How long a connection's default branch (the host's, or the stored one the host confirmed) is kept before it is
#: read again.
DEFAULT_BRANCH_SECONDS: Final = 300
#: The most entries each branch cache keeps (connections times branches stay small; the oldest goes first).
MAX_CACHED_BRANCHES: Final = 256
_DRAFT: Final[Permissions] = {'contents': 'read', 'pull_requests': 'write'}
#: The reactions read (``github_reactions.py``): the pull request, its reviews and comments, the default branch's commits.
_REACTIONS: Final[Permissions] = {'contents': 'read', 'issues': 'read', 'pull_requests': 'read'}
#: How long a reaction's author's write access is kept before it is read again.
WRITER_SECONDS: Final = 600
#: How long branch rules that passed the CI check are kept before they are read again.
CI_CHECK_SECONDS: Final = 300
#: The ruleset rules of one branch the check reads (one page): a branch with any is protected.
RULES_PAGE: Final = 100
#: The required checks a check keeps (their names), and the longest name it keeps.
MAX_REQUIRED_CHECKS: Final = 20
MAX_CHECK_NAME: Final = 200


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def app_jwt(credential: GitHubAppCredential, now: float) -> str:
    """The App's JWT (RS256): issued a minute back, expiring ``JWT_SECONDS`` from ``now``, issuer the App id."""
    return sign_app_jwt(credential.app_id, credential.private_key, now)


def sign_app_jwt(app_id: str, key: rsa.RSAPrivateKey, now: float) -> str:
    """App ``app_id``'s JWT signed with ``key`` (``app_jwt``'s; the token function's too, ``app_tokens.py``, which
    holds an App's key and no connection)."""
    header = _b64url(json.dumps({'alg': 'RS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    claims = _b64url(json.dumps({'iat': int(now) - 60, 'exp': int(now) + JWT_SECONDS, 'iss': app_id},
                                separators=(',', ':')).encode())
    signing_input = f'{header}.{claims}'.encode('ascii')
    signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return f'{header}.{claims}.{_b64url(signature)}'


def rate_limit_retry(response: Response, now: float) -> int | None:
    """The seconds GitHub asks the client to wait before it retries ``response``'s request (at least one), or
    ``None`` when it is not rate limited (a plain 403 is a refusal, not a limit)."""
    if response.status not in (403, 429):
        return None
    asked = asked_wait(response, 'x-ratelimit-reset', now, reset_needs_empty='x-ratelimit-remaining')
    if asked is not None:
        return asked
    if response.status == 429 or b'secondary rate limit' in response.body.lower():
        return DEFAULT_RETRY_SECONDS
    return None


def send_request(transport: Transport, clock: Callable[[], float], method: str, path: str, authorization: str, what: str,
                 *, body: object = None, accept: str = JSON_ACCEPT, ok: tuple[int, ...] = (200,),
                 user_agent: str = 'voc-engineering-broker') -> Response:
    """One request to api.github.com through ``transport`` (the broker's client's, and the token function's): a rate
    limit is ``HostBusy`` with the seconds to wait, any status outside ``ok`` a ``HostError`` naming it and ``what``,
    never the token or what was sent."""
    headers = {'Accept': accept, 'Authorization': authorization, 'User-Agent': user_agent,
               'X-GitHub-Api-Version': GITHUB_API_VERSION}
    data = None if body is None else json.dumps(body).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    response = transport.request(method, path, headers, data)
    retry = rate_limit_retry(response, clock())
    if retry is not None:
        raise HostBusy(f'The repository host is rate limiting {what}; retry later.', retry_after=retry)
    if response.status not in ok:
        unexpected = HostError(f'The repository host answered {response.status} to {what}.')
        unexpected.status = response.status
        raise unexpected
    return response


def next_page(headers: Mapping[str, str], rel: re.Pattern[str] = _NEXT) -> str | None:
    """The page number of the ``Link`` header's ``rel="next"`` (the next read's cursor), or ``None``; ``rel``: another
    of its links (``_LAST``, ``_PREV``)."""
    found = rel.search(headers.get('link', ''))
    page = parse_qs(urlsplit(found.group(1)).query).get('page', [''])[0] if found else ''
    return page if PAGE_NUMBER.fullmatch(page) else None


def _repository_path(target: str) -> str:
    """``target`` as a path inside the repository, URL-quoted; never one that climbs out of it."""
    return quote(repository_path(target), safe='/')


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
    return stray_changes(contents, lambda change: change.mode in FILE_MODES,
                         'A pushed file must be a regular file, an executable or a symbolic link')


def _check_names(names: list[object]) -> tuple[str, ...]:
    """The status checks' names a branch rule lists: text, one line, at most ``MAX_CHECK_NAME`` characters each."""
    return tuple(name for name in names if isinstance(name, str) and name.strip() and len(name) <= MAX_CHECK_NAME
                 and name.isprintable())


def _ruleset_checks(rules: list[object]) -> tuple[str, ...]:
    """The status checks the ``required_status_checks`` rules of a branch's rulesets require."""
    names: list[object] = []
    for rule in rules:
        if _dig(rule, 'type') == 'required_status_checks':
            listed = _dig(rule, 'parameters', 'required_status_checks')
            names += [_dig(check, 'context') for check in (listed if isinstance(listed, list) else [])]
    return _check_names(names)


def _posted_by_app(comment: dict[str, object], app_id: str) -> bool:
    """Whether App ``app_id`` (the connection's) posted ``comment`` itself (7.71.04): GitHub's
    ``performed_via_github_app.id``, which a person's comment, or another App's, never has, and (7.104.00, S1) its
    author the App's own bot (``user.type`` ``Bot``, ``user.login`` the App's ``<slug>[bot]``), which a person
    commenting through the App with a user token is not: their comment carries the App too, under their own login."""
    found = _dig(comment, 'performed_via_github_app', 'id')
    slug = _dig(comment, 'performed_via_github_app', 'slug')
    return (type(found) is int and str(found) == app_id and isinstance(slug, str) and bool(slug)
            and _dig(comment, 'user', 'type') == 'Bot' and _dig(comment, 'user', 'login') == f'{slug}[bot]')


def issues_repository(credential: GitHubAppCredential) -> str:
    """Where the run's issue lives: the connection's own repository, or a fork's upstream (7.57.00: a fork's issues
    are its upstream's, the ones its public_read connection reads as feedback)."""
    if credential.kind == FORK and credential.fork is not None:
        return credential.fork.upstream
    return f'{credential.owner}/{credential.repository}'


def open_from(owner: str, branch: str) -> str:
    """The query of a repository's open pull request from ``owner``'s ``branch`` (one is enough)."""
    return urlencode({'state': 'open', 'head': f'{owner}:{branch}', 'per_page': 1})


def first_pull_request(response: Response) -> PullRequestRef | None:
    """The first pull request a list answer names (its lookup by branch: ``open_from``), None for none."""
    found = _json(response)
    first = found[0] if isinstance(found, list) and found else None
    return None if first is None else pull_request_ref(first)


def pull_request_ref(found: object) -> PullRequestRef:
    """A pull request as GitHub answers it (its create, its lookup): the number, the URL, its head and base branches."""
    return PullRequestRef(number=_int(found, 'number'), url=_text(found, 'html_url'),
                          head=text_or_empty(found, 'head', 'ref'), base=text_or_empty(found, 'base', 'ref'),
                          host='github')


class TokenCannotWrite(NotNow):
    """GitHub refused a write with a fine-grained connection's token (403, 7.60.00): nothing was moved, and the step
    waits for a person (the token's permissions, or its organization's approval); ``code`` beside the reason."""

    code = 'token_cannot_write'


class TokenNotAccepted(NotNow):
    """GitHub did not take a fine-grained connection's token for a write (7.63.00: 401, the token revoked, expired or
    regenerated; 404, it no longer reaches the repository): nothing was written, so the write is a refusal, never an
    unknown outcome (the broker's claim is closed as refused, and the attempt may write again once the token is
    replaced); the step waits for a person, who replaces the token."""

    code = 'token_not_accepted'


#: A write's request (``method``, the path after ``/repos/<owner>/<name>``, what it is, its body and the statuses it
#: takes), with the App's write token or, on a fine-grained connection, the token the broker handed in.
Writer = Callable[..., Response]
#: The App's write token on a fine-grained connection, or a token write elsewhere: refused before any request.
NO_APP_WRITES: Final = ("A fine-grained connection is written only with its own token, by the run's push and pull "
                        'request: the App\'s token on it reads only.')
NOT_ITS_CREDENTIAL: Final = 'A write token is only for a connection made with one.'


class GitHubHost:
    """``RepositoryHost`` over the GitHub REST API, one App installation token per repository and permission set."""

    def __init__(self, credentials: Callable[[str], GitHubAppCredential], transport: Transport | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self._credentials = credentials
        self._transport = transport or HttpsTransport(host=API_HOST, repeatable=TOKEN_PATH)
        self._clock = clock
        #: (connection, installation, owner/repository, permissions) -> (token, when it stops being used).
        self._tokens: dict[tuple[str, int, str, tuple[tuple[str, str], ...]], tuple[str, float]] = {}
        #: By (connection, owner/repository, ...): the default branches, the stored ones confirmed, the rules passed.
        self._cached = BranchCaches()
        #: By (connection, owner/repository, login): whether a reaction's author may write, and when it is read again.
        self._writers: dict[tuple[str, str, str], tuple[bool, float]] = {}

    # --- HTTP -------------------------------------------------------------------------------------------------

    def _send(self, method: str, path: str, authorization: str, what: str, body: object = None,
              accept: str = JSON_ACCEPT, ok: tuple[int, ...] = (200,)) -> Response:
        return send_request(self._transport, self._clock, method, path, authorization, what, body=body, accept=accept,
                            ok=ok)

    def _token(self, connection_id: str, permissions: Permissions) -> tuple[GitHubAppCredential, str]:
        credential = self._credentials(connection_id)
        # A public repository read only (7.57.00) is not in the installation its token comes from: whatever the
        # operation asked, its token holds ``metadata: read`` alone and names no repository, so it reads what is
        # public and can write nothing on any repository (the broker refuses every write on it before this). A
        # fine-grained connection (7.60.00) reads the same way, and never gets an App write token: only its own token
        # writes, and only through ``_token_writer``.
        public = credential.kind in (PUBLIC_READ, FINE_GRAINED)
        if credential.kind == FINE_GRAINED and 'write' in permissions.values():
            raise WriteRefused(NO_APP_WRITES)
        if public:
            permissions = METADATA_READ
        # The installation and repository are in the key: a connection re-pointed at another repository (or
        # installation) never reuses a token minted for the old one.
        key = (connection_id, credential.installation_id, f'{credential.owner}/{credential.repository}',
               tuple(sorted(permissions.items())))
        held = self._tokens.get(key)
        now = self._clock()
        if held is not None and now < held[1]:
            return credential, held[0]
        body: dict[str, object] = {'permissions': dict(permissions)}
        if not public:
            body['repositories'] = [credential.repository]
        response = self._send('POST', f'/app/installations/{credential.installation_id}/access_tokens',
                              f'Bearer {app_jwt(credential, now)}', 'the token request', ok=(201,), body=body)
        data = _json(response)
        try:
            expires = datetime.fromisoformat(_text(data, 'expires_at')).timestamp()
        except ValueError:
            raise HostError('The repository host answered the token request without a valid expiry.') from None
        token = _text(data, 'token')
        self._tokens[key] = (token, expires - TOKEN_MARGIN_SECONDS)
        return credential, token

    def _api(self, connection_id: str, permissions: Permissions, method: str, path: str, what: str,
             body: object = None, accept: str = JSON_ACCEPT, ok: tuple[int, ...] = (200,), *,
             issues: bool = False) -> Response:
        """``path`` (after ``/repos/{owner}/{repo}``) with a token for ``permissions`` on the connection's repo.
        ``issues``: a read of the run's issue, which on a fork connection (7.57.00) is the upstream's, read as any
        reader of a public repository reads it (the fork's token, ``issues_repository``)."""
        credential, token = self._token(connection_id, permissions)
        repository = issues_repository(credential) if issues else f'{credential.owner}/{credential.repository}'
        return self._send(method, f'/repos/{repository}{path}', f'Bearer {token}', what, body=body, accept=accept,
                          ok=ok)

    def public_get(self, connection_id: str, path: str, what: str, *, accept: str = JSON_ACCEPT,
                   ok: tuple[int, ...] = (200,)) -> Response:
        """``GET path`` (a whole API path under ``/repos/``, a public repository's: a fork's upstream, 7.57.00) with
        the connection's ``metadata: read`` token: what any reader of a public repository reads; never a write."""
        if not path.startswith('/repos/'):
            raise InvalidTarget('A public read is of a repository.')
        _, token = self._token(connection_id, METADATA_READ)
        return self._send('GET', path, f'Bearer {token}', what, accept=accept, ok=ok)

    # --- reads ------------------------------------------------------------------------------------------------

    def read(self, connection_id: str, kind: ReadKind, target: str, cursor: str | None, branch: str = '') -> ReadPage:
        """A file or history on ``branch`` (the run's default branch, as the broker worked it out: the stored one once
        the host confirmed it; '' for the repository's own), an issue or a pull request with its thread."""
        return read_page(kind, target, cursor, lambda: self._read_file(connection_id, target, branch),
                         lambda page: self._read_history(connection_id, target, page, branch),
                         lambda number, page: self._read_thread(connection_id, kind, number, page))

    def _read_file(self, connection_id: str, target: str, branch: str) -> ReadPage:
        on = f'?{urlencode({"ref": branch})}' if branch else ''
        response = self._api(connection_id, _READS['file'], 'GET', f'/contents/{_repository_path(target)}{on}',
                             'the file read', accept=RAW_ACCEPT, ok=(200, 404))
        return file_page(None if response.status == 404 else response.body)

    def file_at(self, connection_id: str, commit: str, path: str) -> bytes | None:
        """The bytes of ``path`` at ``commit`` (a full object id), ``None`` when the commit has no such file: a
        submitted patch's base (``patches.py``). At most ``MAX_RESPONSE_BYTES``, like every answer."""
        if not OBJECT_ID.fullmatch(commit):
            raise InvalidTarget('The commit is a full object id.')
        response = self._api(connection_id, _READS['file'], 'GET',
                             f'/contents/{_repository_path(path)}?{urlencode({"ref": commit})}', 'the base file read',
                             accept=RAW_ACCEPT, ok=(200, 404))
        return None if response.status == 404 else response.body

    def repository(self, connection_id: str) -> str:
        """``owner/name`` of the repository the connection's credential is for (no request to the host)."""
        credential = self._credentials(connection_id)
        return f'{credential.owner}/{credential.repository}'

    def fetch_token(self, connection_id: str) -> tuple[str, str]:
        """``owner/name`` and an installation token for ``contents: read`` on that one repository: the checkout
        cache's fetch (``cache.py``), which hands it to git only through its environment."""
        credential, token = self._token(connection_id, _FETCH)
        return f'{credential.owner}/{credential.repository}', token

    def revoke_fetch_token(self, token: str) -> None:
        """Revoke a token ``fetch_token`` minted (``DELETE /installation/token``, sent once, never retried) and forget
        it, so this container mints a fresh one next time. Raises ``HostError`` when the host does not answer 204."""
        for key, (held, _until) in list(self._tokens.items()):
            if held == token:
                del self._tokens[key]
        self._send('DELETE', '/installation/token', f'Bearer {token}', 'the token revocation', ok=(204,))

    def default_branch(self, connection_id: str, stored: str = '') -> str:
        """``stored``, the connection's default branch as the run recorded it, once the repository has it (one branch
        lookup, ``contents: read``, kept ``DEFAULT_BRANCH_SECONDS``; ``StoredBranchMissing`` when it has none, never
        kept); for ``stored=''`` (a run started before connections recorded one) the repository's own default
        branch, kept as long per connection and repository."""
        credential = self._credentials(connection_id)
        if stored:
            return self._confirmed(connection_id, f'{credential.owner}/{credential.repository}', stored)
        key = (connection_id, f'{credential.owner}/{credential.repository}')
        now = self._clock()
        held = fresh(self._cached.default_branches, key, now)
        if held is not None:
            return held
        branch = _text(_json(self._api(connection_id, METADATA_READ, 'GET', '', 'the repository read')), 'default_branch')
        keep(self._cached.default_branches, key, (branch, now + DEFAULT_BRANCH_SECONDS), MAX_CACHED_BRANCHES)
        return branch

    def _confirmed(self, connection_id: str, repository: str, branch: str) -> str:
        key = (connection_id, repository, branch)
        now = self._clock()
        if now < self._cached.confirmed_branches.get(key, 0.0):
            return branch
        if self._head(connection_id, _BRANCH, branch) is None:
            raise StoredBranchMissing(STORED_BRANCH_MISSING)
        keep(self._cached.confirmed_branches, key, now + DEFAULT_BRANCH_SECONDS, MAX_CACHED_BRANCHES)
        return branch

    # --- the branch rules (the CI attestation's check) ------------------------------------------------------------

    def ci_protection(self, connection_id: str, default_branch: str, branch: str) -> CiProtection:
        """What the repository's branch rules say of ``default_branch`` and the agent's ``branch``, read with a
        ``contents: read`` token (rules and branches are what any reader of the repository sees): the default
        branch's protection (classic branch protection or any ruleset rule) and the status checks it requires (both
        kinds), and whether ``branch`` is protected (any rule for its name, or, once it exists, GitHub's own
        ``protected``). At most four requests (two per branch), none of them a write; a result that passes is kept
        ``CI_CHECK_SECONDS`` per connection, repository and both branches, one that does not is read again next time,
        so a fixed rule counts at once."""
        credential = self._credentials(connection_id)
        key = (connection_id, f'{credential.owner}/{credential.repository}', default_branch, branch)
        now = self._clock()
        held = fresh(self._cached.ci_checks, key, now)
        if held is not None:
            return held
        protected, classic_checks = self._branch_protection(connection_id, default_branch)
        rules = self._rules(connection_id, default_branch)
        agent_protected, _ = self._branch_protection(connection_id, branch)
        checks = (*classic_checks, *_ruleset_checks(rules))
        found = CiProtection(default_branch_protected=protected or bool(rules),
                             required_checks=tuple(dict.fromkeys(checks))[:MAX_REQUIRED_CHECKS],
                             agent_branch_protected=agent_protected or bool(self._rules(connection_id, branch)),
                             checked_at=now)
        if found.passes:
            keep(self._cached.ci_checks, key, (found, now + CI_CHECK_SECONDS), MAX_CACHED_BRANCHES)
        return found

    def _branch_protection(self, connection_id: str, branch: str) -> tuple[bool, tuple[str, ...]]:
        """GitHub's own ``protected`` of ``branch`` and the status checks its classic protection requires; (False,
        ()) for a branch the repository does not have (yet)."""
        response = self._api(connection_id, _BRANCH, 'GET', f'/branches/{quote(branch, safe="/")}',
                             'the branch rules read', ok=(200, 404))
        if response.status == 404:
            return False, ()
        data = _json(response)
        status = _dig(data, 'protection', 'required_status_checks')
        contexts = _dig(status, 'contexts')
        checks = _dig(status, 'checks')
        names = [*(contexts if isinstance(contexts, list) else []),
                 *(_dig(check, 'context') for check in (checks if isinstance(checks, list) else []))]
        return _dig(data, 'protected') is True, _check_names(names)

    def _rules(self, connection_id: str, branch: str) -> list[object]:
        """The ruleset rules that apply to ``branch`` (one page of ``RULES_PAGE``: a branch with more has rules)."""
        response = self._api(connection_id, _BRANCH, 'GET',
                             f'/rules/branches/{quote(branch, safe="/")}?{urlencode({"per_page": RULES_PAGE})}',
                             'the branch rules read', ok=(200, 404))
        data = [] if response.status == 404 else _json(response)
        return data if isinstance(data, list) else []

    def _read_history(self, connection_id: str, target: str, page: str, branch: str) -> ReadPage:
        # "." is the whole repository's history; any other target, the history of that path; on ``branch``.
        fields: dict[str, object] = {'per_page': PAGE_SIZE, 'page': page}
        if branch:
            fields['sha'] = branch
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
        issues = kind == 'issue'
        if page == '1':
            item = self._api(connection_id, permissions, 'GET',
                             f'/issues/{number}' if kind == 'issue' else f'/pulls/{number}', what, ok=(200, 404),
                             issues=issues)
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
            response = self._api(connection_id, permissions, 'GET', f'{path}?{query}', what, issues=issues)
            content[key] = _items(_json(response), fields)
            cursors += [c for c in [next_page(response.headers)] if c is not None]
        return ReadPage(content=json.dumps(content), next_cursor=cursors[0] if cursors else None)

    def reactions(self, connection_id: str, number: int, url: str, branch: str) -> PullRequestReactions:
        """People's reactions to pull request ``number`` (7.10.00, ``github_reactions.py``): reads only, with a token
        for reading the pull request, its comments and the repository's contents."""
        def get(path: str) -> Response:
            return self._api(connection_id, _REACTIONS, 'GET', path, 'the reactions read', ok=(200, 404))

        return github_reactions.read(get, url, number, branch, partial(self._writes, connection_id))

    def _writes(self, connection_id: str, login: str) -> bool:
        """Whether ``login`` may write to the connection's repository (GitHub's "Get repository permissions for a
        user": ``reactions.writer_permission``), kept ``WRITER_SECONDS``; a lookup that fails (an error, a rate
        limit, an answer off its shape) is False and is not kept (fail closed)."""
        credential = self._credentials(connection_id)
        key, now = (connection_id, f'{credential.owner}/{credential.repository}', login), self._clock()
        held = fresh(self._writers, key, now)
        if held is not None:
            return held
        try:
            response = self._api(connection_id, _REACTIONS, 'GET', f'/collaborators/{quote(login, safe="")}/permission',
                                 'the reactions read')
            writes = writer_permission(_json(response))
        except BrokerError:
            return False
        keep(self._writers, key, (writes, now + WRITER_SECONDS), MAX_CACHED_BRANCHES)
        return writes

    def _open_pull_request(self, connection_id: str, permissions: Permissions, branch: str) -> PullRequestRef | None:
        credential = self._credentials(connection_id)
        return first_pull_request(self._api(connection_id, permissions, 'GET',
                                            f'/pulls?{open_from(credential.owner, branch)}', 'the pull request lookup'))

    def branch_tree_hash(self, connection_id: str, branch: str) -> str | None:
        return self._branch_tree(connection_id, _BRANCH, branch)

    def head_commit(self, connection_id: str, branch: str) -> str | None:
        """The head commit of ``branch`` (``contents: read``), None for none."""
        return self._head(connection_id, _BRANCH, branch)

    def issue_state(self, connection_id: str, number: int) -> str | None:
        """Issue ``number``'s state (``issues: read``): None for no such issue, and for a pull request, which GitHub's
        issues API answers too (with its ``pull_request`` field)."""
        response = self._api(connection_id, _READS['issue'], 'GET', f'/issues/{int(number)}', 'the issue read',
                             ok=(200, 404, 410), issues=True)
        data = None if response.status != 200 else _json(response)
        if not isinstance(data, dict) or 'pull_request' in data:
            return None
        state = data.get('state')
        return state if state in ('open', 'closed') else None

    def _head(self, connection_id: str, permissions: Permissions, branch: str) -> str | None:
        response = self._api(connection_id, permissions, 'GET', f'/git/ref/heads/{quote(branch, safe="/")}',
                             'the branch lookup', ok=(200, 404))
        return text_unless_missing(response, 'object', 'sha')

    def _tree_of(self, connection_id: str, permissions: Permissions, commit: str) -> str | None:
        """The tree of ``commit``, or ``None`` when the repository has no such commit."""
        path = f'/git/commits/{quote(commit, safe="")}'
        return text_unless_missing(self._api(connection_id, permissions, 'GET', path, 'the commit lookup',
                                             ok=(200, 404)), 'tree', 'sha')

    def _branch_tree(self, connection_id: str, permissions: Permissions, branch: str) -> str | None:
        head = self._head(connection_id, permissions, branch)
        return None if head is None else self._tree_of(connection_id, permissions, head)

    # --- writes -----------------------------------------------------------------------------------------------

    def post_comment(self, connection_id: str, on: CommentTarget, number: int, body: str) -> str:
        response = self._api(connection_id, _COMMENTS[on], 'POST', f'/issues/{number}/comments', 'the comment',
                             body={'body': body}, ok=(201,))
        return _text(_json(response), 'html_url')

    def issue_comment(self, connection_id: str, number: int, marker: str) -> str | None:
        """The URL of issue ``number``'s comment that is the run's (7.71.03), a few pages at most
        (``marked_comment``): since 7.71.04 only one the connection's App posted itself (``_posted_by_app``, the
        credential's ``app_id``) whose body ends with ``marker``. Newest first (7.104.00): GitHub lists an issue's
        comments oldest first and takes no order, so the look reads the first page, then from the last page its
        ``Link`` names back a page at a time, each page newest first; the run's comment is among the newest however
        long the thread, and however long ago the call that posted it (7.71.04's ``since``, from that call's claim,
        missed it once a claim was taken again twice). A ``Link`` that names a next page and no last is read on from
        the first page."""
        app_id = self._credentials(connection_id).app_id

        def page(at: str) -> Response:
            return self._api(connection_id, _READS['issue'], 'GET',
                             f'/issues/{int(number)}/comments?{urlencode({"per_page": FIND_PAGE_SIZE, "page": at})}',
                             'the comment read')

        first = page('1')
        last = next_page(first.headers, _LAST)

        def read(at: str) -> Response:
            return first if at == '1' else page(at)

        def ours(comment: dict[str, object]) -> bool:
            return _posted_by_app(comment, app_id)

        def url(comment: dict[str, object]) -> str:
            return _text(comment, 'html_url')

        if last is None and next_page(first.headers) is not None:
            # (a Link that names no last page: read on from the first, as GitHub lists them)
            return marked_comment(read, next_page, marker, ours, url)
        return marked_comment(read, partial(next_page, rel=_PREV), marker, ours, url, start=last or '1',
                              newest_first=True)

    def label_issue(self, connection_id: str, number: int, labels: tuple[str, ...]) -> tuple[str, ...]:
        """Add ``labels`` to issue ``number`` (GitHub creates a label the repository does not have yet)."""
        self._api(connection_id, ISSUES_WRITE, 'POST', f'/issues/{int(number)}/labels', 'the labels',
                  body={'labels': list(labels)}, ok=(200,))
        return labels

    @staticmethod
    def _entry(host_write: Writer, change: FileChange) -> dict[str, object]:
        """A tree entry for ``change``: a deletion, a text file inline, any other file as a blob (``host_write``'s)."""
        entry: dict[str, object] = {'path': change.path, 'mode': change.mode, 'type': 'blob'}
        if change.content is None:
            return {**entry, 'sha': None}
        try:
            return {**entry, 'content': change.content.decode('utf-8')}
        except UnicodeDecodeError:
            blob = host_write('POST', '/git/blobs', 'the push', ok=(201,),
                         body={'content': base64.b64encode(change.content).decode('ascii'), 'encoding': 'base64'})
            return {**entry, 'sha': _text(_json(blob), 'sha')}

    def _require_on_default_branch(self, connection_id: str, permissions: Permissions, default_branch: str,
                                   base: str) -> None:
        compare = f'{quote(default_branch, safe="/")}...{quote(base, safe="")}'
        response = self._api(connection_id, permissions, 'GET', f'/compare/{compare}?per_page=1', 'the push',
                             ok=(200, 404))
        if response.status == 404 or _dig(_json(response), 'status') not in _ON_DEFAULT_BRANCH:
            raise Conflict("A new branch starts on the default branch: the bundle's base is not its head or an "
                           'ancestor of it.')

    def push_bundle(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str,
                    default_branch: str) -> None:
        self._push(connection_id, branch, contents, tree_hash, default_branch, '')

    def push_bundle_as(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str,
                       default_branch: str, write_token: str) -> None:
        """A fine-grained connection's push (7.60.00): ``push_bundle``'s, its writes with ``write_token``."""
        self._push(connection_id, branch, contents, tree_hash, default_branch, write_token)

    def _token_writer(self, connection_id: str, permissions: Permissions, write_token: str) -> Writer:
        """How a write's request is sent: with the App's token for ``permissions`` (``_api``), or on a fine-grained
        connection with ``write_token``, held to ``token_request_allowed`` (``WriteRefused`` off it, before any
        request), its 403 ``TokenCannotWrite`` and its 401 or 404 ``TokenNotAccepted`` (7.63.00: nothing written). A
        token write elsewhere, or none on a fine-grained connection, is
        refused before any request."""
        credential = self._credentials(connection_id)
        if credential.kind != FINE_GRAINED:
            if write_token:
                raise WriteRefused(NOT_ITS_CREDENTIAL)
            return partial(self._api, connection_id, permissions)
        if not write_token:
            raise WriteRefused(NO_APP_WRITES)
        repository = f'{credential.owner}/{credential.repository}'

        def send(method: str, path: str, what: str, body: object = None, accept: str = JSON_ACCEPT,
                 ok: tuple[int, ...] = (200,)) -> Response:
            full = f'/repos/{repository}{path}'
            if not token_request_allowed(repository, method, full):
                raise WriteRefused('A fine-grained connection\'s token writes only the run\'s branch and pull request.')
            try:
                return self._send(method, full, f'Bearer {write_token}', what, body=body, accept=accept, ok=ok)
            except HostBusy:
                raise
            except HostError as refused:
                if refused.status == 403:
                    raise TokenCannotWrite(CANNOT_WRITE) from None
                if refused.status in (401, 404):
                    raise TokenNotAccepted(NOT_ACCEPTED.format(status=refused.status)) from None
                raise

        return send

    def _reads(self, connection_id: str, permissions: Permissions) -> Permissions:
        """The permissions a write's own reads ask for: the write's (one token for both), or on a fine-grained
        connection ``contents: read`` (``_token`` makes it the App's ``metadata: read``)."""
        return _BRANCH if self._credentials(connection_id).kind == FINE_GRAINED else permissions

    def _push(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str, default_branch: str,
              write_token: str) -> None:
        host_write = self._token_writer(connection_id, _PUSH, write_token)
        reads = self._reads(connection_id, _PUSH)
        require_pushable(contents, tree_hash, _stray_changes(contents))
        head = self._head(connection_id, reads, branch)
        require_base(head, contents)
        if head is None:
            self._require_on_default_branch(connection_id, reads, default_branch, contents.base)
        tree = self._tree_of(connection_id, reads, contents.base)
        if tree is None:
            raise Conflict("The repository has no commit the bundle's base names; fetch and make the bundle again.")
        parent = contents.base
        for commit in contents.commits:
            if commit.changes:
                entries = [self._entry(host_write, change) for change in commit.changes]
                built = host_write('POST', '/git/trees', 'the push', ok=(201,), body={'base_tree': tree, 'tree': entries})
                tree = _text(_json(built), 'sha')
            made = host_write('POST', '/git/commits', 'the push', ok=(201,),
                         body={'message': commit.message, 'tree': tree, 'parents': [parent]})
            parent = _text(_json(made), 'sha')
        if tree != tree_hash:
            raise Conflict('The commits rebuilt on the host have another tree than the one the broker checked; '
                           'the branch was not moved.')
        ref = f'refs/heads/{branch}'
        if head is None:
            moved = host_write('POST', '/git/refs', 'the push', ok=(201, 422), body={'ref': ref, 'sha': parent})
        else:
            moved = host_write('PATCH', f'/git/{quote(ref, safe="/")}', 'the push', ok=(200, 422),
                          body={'sha': parent, 'force': False})
        if moved.status == 422:
            raise Conflict('The branch changed while the bundle was pushed; fetch it and make the bundle again.')

    def tree_with(self, connection_id: str, base: str, changes: tuple[FileChange, ...]) -> str:
        """The tree ``changes`` give on ``base``'s (7.52.00, the approved docs' write), made with the Git Data API as a
        push makes it: an object no branch names until a push commits it (the push makes the same tree again, by its
        content). ``Conflict`` when the repository has no such commit."""
        tree = self._tree_of(connection_id, _PUSH, base)
        if tree is None:
            raise Conflict("The repository has no commit the docs' base names; read its head again.")
        if not changes:
            return tree
        host_write = partial(self._api, connection_id, _PUSH)
        entries = [self._entry(host_write, change) for change in changes]
        built = host_write('POST', '/git/trees', 'the docs tree', ok=(201,), body={'base_tree': tree, 'tree': entries})
        return _text(_json(built), 'sha')

    def _require_pull_request_tree(self, connection_id: str, permissions: Permissions, number: int,
                                   tree_hash: str) -> None:
        """Raise ``Conflict`` unless the pull request's head has ``tree_hash``."""
        response = self._api(connection_id, permissions, 'GET', f'/pulls/{number}', 'the pull request check')
        if self._tree_of(connection_id, permissions, _text(_dig(_json(response), 'head'), 'sha')) != tree_hash:
            raise Conflict("The branch moved while the pull request was written: its head does not have the tree "
                           "the board's GO is for.")

    def open_or_update_draft_pr(self, connection_id: str, branch: str, base: str, title: str, body: str,
                                tree_hash: str, *, draft: bool = True) -> PullRequestRef:
        return self._pull_request(connection_id, branch, base, title, body, tree_hash, draft, '')

    def open_or_update_pr_as(self, connection_id: str, branch: str, base: str, title: str, body: str, tree_hash: str,
                             write_token: str, *, draft: bool = True) -> PullRequestRef:
        """A fine-grained connection's pull request (7.60.00): ``open_or_update_draft_pr``'s, its writes with
        ``write_token``."""
        return self._pull_request(connection_id, branch, base, title, body, tree_hash, draft, write_token)

    def _pull_request(self, connection_id: str, branch: str, base: str, title: str, body: str, tree_hash: str,
                      draft: bool, write_token: str) -> PullRequestRef:
        host_write = self._token_writer(connection_id, _DRAFT, write_token)
        reads = self._reads(connection_id, _DRAFT)
        if self._branch_tree(connection_id, reads, branch) != tree_hash:
            raise Conflict("The branch's head does not have the tree the board's GO is for.")
        ref = self._open_pull_request(connection_id, reads, branch)
        opened = ref is None
        if ref is not None:
            host_write('PATCH', f'/pulls/{ref.number}', 'the pull request update', body={'title': title, 'body': body})
        else:
            created = _json(host_write('POST', '/pulls', 'the pull request', ok=(201,),
                                  body={'title': title, 'body': body, 'head': branch, 'base': base, 'draft': draft}))
            ref = pull_request_ref(created)
        number = ref.number
        # (a pull request this call opened is never left open unchecked)
        return checked_after_write(
            ref, opened, lambda: self._require_pull_request_tree(connection_id, reads, number, tree_hash),
            lambda: self._close(host_write, number))

    @staticmethod
    def _close(host_write: Writer, number: int) -> None:
        """Close the pull request ``number`` this call opened; a close that fails is logged by its number only."""
        try:
            host_write('PATCH', f'/pulls/{number}', 'the pull request close', body={'state': 'closed'})
        except (BrokerError, NoConnection, ValueError, OSError):
            # A failure of the close (a host refusal, a malformed answer, a lost connection) is logged by number
            # only, so the caller still gets the failure that made the close necessary.
            logger.warning('engineering pull request not closed', extra={'pull_request': number})
