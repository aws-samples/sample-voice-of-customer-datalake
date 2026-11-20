"""A repository connected with a fine-grained personal access token, limited to it (7.60.00; docs/autonomous-engineering.md,
"A fine-grained token (7.60.00)"). Pure: nothing here imports ``cryptography`` or reads a parameter, so the Agents API
(the token's check at a save) and the broker (the token's reader and the pin on its requests) share it.

**What it is for.** An administrator who can push to a public ``owner/name`` but cannot install the deployment's GitHub
App there (an organization whose owners approve apps is the typical case) connects it with a fine-grained token that
reaches that one repository, with Contents and Pull requests read and write and an expiry of at most ``MAX_DAYS``. The
repository is read as 7.57.00's public repositories are, with the deployment's App's read-only token; the token is
used for exactly two things, a run's final push and its pull request, after every gate and the token owner's own go
(``broker.py``), and only on the paths ``token_request_allowed`` names.

**The check at a save** (``check_token``: four reads, each sent once with ``CHECK_TIMEOUT_SECONDS``, no write):

1. the shape: ``github_pat_`` and its body; a classic token (``ghp_``), an OAuth token (``gho_``), a user-to-server or a
   server-to-server token (``ghu_``, ``ghs_``) or a refresh token (``ghr_``) is ``classic_token``;
2. ``GET /repos/<repo>`` with the token: 200, ``private: false``, ``archived: false`` and ``permissions.push: true``
   (401 ``not_accepted``, 403 ``org_pending_approval``, 404 ``not_found``);
3. its expiry, from the answer's ``GitHub-Authentication-Token-Expiration`` header (``expiry_date``): present, after
   today (UTC) and at most ``MAX_DAYS`` days on (one day more for the token owner's own time zone: the header carries
   their calendar day, which east of UTC is a day ahead of UTC's);
4. ``GET /user``: the token's ``login``;
5. ``GET /user/repos?visibility=private``: a token that lists any private repository reaches more than this public one
   (``other_repositories``). "This repository only" cannot be fully proven through the API (a token on "All
   repositories" of an account with no private repository lists none), so the person ticks it too.

Write access cannot be proven without writing (no write probe, the owner's decision: it would be a write, and could
start CI), so readiness says the first push confirms it, and a 403 at the push stops the step for a person
(``CANNOT_WRITE``, code ``token_cannot_write``). A token pending its organization's approval reads only public resources (GitHub's docs,
"Creating a fine-grained personal access token"), so its 403 may come only at the push: the same refusal says so.

The token is never logged, put in a message or answered: every refusal here names what to change, never the value.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Final, Literal
from urllib.parse import quote

from engineering.connectors.hosts import HostError
from engineering.connectors.transport import HttpsTransport, Response, Transport, dig
from shared.github_rest import GITHUB_API, GITHUB_API_VERSION, GITHUB_LOGIN
from shared.plan_canonical import FINGERPRINT_RE as SUBJECT_HASH

#: A fine-grained personal access token as GitHub hands it out (``github_pat_``, then its body: 82 characters today).
TOKEN: Final = re.compile(r'github_pat_[A-Za-z0-9_]{40,255}')
#: The prefixes of GitHub's other tokens, each refused as ``classic_token``: a classic personal access token, an OAuth
#: token, a GitHub App's user-to-server and server-to-server tokens, and a refresh token.
OTHER_PREFIXES: Final = ('ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_')
#: The longest a token may live from its save (the owner's decision: GitLab's project tokens live up to a year).
MAX_DAYS: Final = 90
#: The warning's window (the owner's decision): readiness and the page warn this many days before the expiry, or fewer.
WARN_DAYS: Final = 14
#: Each request of the save's check gets this long, and is sent once: its four reads end inside API Gateway's 29 s.
CHECK_TIMEOUT_SECONDS: Final = 6.0
API_HOST: Final = GITHUB_API.removeprefix('https://')
#: The response header that says when a personal access token expires.
EXPIRY_HEADER: Final = 'github-authentication-token-expiration'
#: ``YYYY-MM-DD`` as the header begins (``2027-02-18 06:00:00 -0800``, ``2027-02-18 14:00:00 UTC``).
_HEADER_DATE: Final = re.compile(r'\s*(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?(?:\s*(?:UTC|Z|[+-]\d{2}:?\d{2}))?\s*')

Code = Literal['classic_token', 'not_accepted', 'no_expiry', 'expires_too_late', 'expired', 'not_found',
               'private_repository', 'archived', 'no_push', 'org_pending_approval', 'other_repositories']
#: Every refusal code a save can answer (the API's 422 ``code``; the page words each).
CODES: Final[tuple[Code, ...]] = ('classic_token', 'not_accepted', 'no_expiry', 'expires_too_late', 'expired',
                                  'not_found', 'private_repository', 'archived', 'no_push', 'org_pending_approval',
                                  'other_repositories')

#: A push or a pull request the host refused with 403 on this kind (the broker stops the step for a person).
CANNOT_WRITE: Final = ("GitHub refused the connection's fine-grained token for this write (403): give it Contents "
                             'and Pull requests read and write on the repository, or, when its organization approves '
                             'fine-grained tokens, ask an owner to approve it; then replace the token under Agents → '
                             'Connections.')


class TokenRefused(Exception):
    """A token the connection is not saved with: ``code`` (one of ``CODES``, the API's 422) or ``unavailable`` (503,
    GitHub could not be asked), and a message that names what to change, never the token."""

    def __init__(self, code: Code | Literal['unavailable'], message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class TokenFacts:
    """What GitHub says of a token that passed: the repository as GitHub spells it, its default branch, the owner's
    kind (``User`` or ``Organization``), the token's login and when it expires (``YYYY-MM-DD``)."""

    repository: str
    default_branch: str
    owner_type: str
    login: str
    expires_at: str


@dataclass(frozen=True)
class WriteToken:
    """A connection's write token as the broker reads it (``{token_prefix}<id>``): the repository it is for, the
    token's login and expiry, the saver (``owner``: the sha256 of their subject), and the token (``repr`` leaves it
    out)."""

    repository: str
    login: str
    expires_at: str
    owner: str
    token: str = field(repr=False)


def shape(value: object) -> str:
    """``value`` as a fine-grained token (trimmed), ``TokenRefused('classic_token')`` for another kind of GitHub token,
    else ``ValueError`` (the API's 400: the field named, never its value)."""
    text = value.strip() if isinstance(value, str) else ''
    if text.startswith(OTHER_PREFIXES):
        raise TokenRefused('classic_token', 'token: this is not a fine-grained personal access token (a classic, OAuth '
                                            'or GitHub App token): make a fine-grained one (github_pat_…)')
    if not TOKEN.fullmatch(text):
        raise ValueError('token is a fine-grained personal access token (github_pat_…), pasted whole')
    return text


def expiry_date(header: str | None) -> date | None:
    """The day the header says the token expires, as GitHub writes it (the token owner's calendar day), or None when
    there is no header or it is off its shape."""
    found = _HEADER_DATE.fullmatch(header or '')
    if found is None:
        return None
    try:
        return date.fromisoformat(found.group(1))
    except ValueError:
        return None


def _day(text: object) -> date | None:
    """``YYYY-MM-DD`` as a day, None for anything else (another spelling ``date.fromisoformat`` takes included)."""
    if not isinstance(text, str) or len(text) != len('YYYY-MM-DD') or text[4] != '-' or text[7] != '-':
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def days_left(expires_at: object, today: date) -> int | None:
    """Whole days from ``today`` to ``expires_at`` (``YYYY-MM-DD``; 0 or fewer: expired), None for none or a day off
    its shape."""
    day = _day(expires_at)
    return None if day is None else (day - today).days


ExpiryState = Literal['unset', 'expired', 'soon', 'ok']


def expiry_state(expires_at: object, today: date) -> ExpiryState:
    """A token's state on ``today``: none known (``unset``), stopped (``expired``: on its expiry day, as a GitLab
    token's), within ``WARN_DAYS`` (``soon``) or fine."""
    left = days_left(expires_at, today)
    if left is None:
        return 'unset'
    if left <= 0:
        return 'expired'
    return 'soon' if left <= WARN_DAYS else 'ok'


def utc_today(clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> date:
    return clock().astimezone(UTC).date()


def token_request_allowed(repository: str, method: str, path: str) -> bool:
    """Whether a request may carry the connection's write token (the broker's pin, ``github.py``): a write of the Git
    Data API's objects (a blob, a tree, a commit) or of a branch's ref on ``repository`` (created, or moved under
    ``refs/heads/``), or a pull request of it created or edited. No read, no other path or repository, no query, no
    ``..``."""
    prefix = f'/repos/{repository}/'
    if method not in ('POST', 'PATCH') or not path.startswith(prefix) or '?' in path or '#' in path:
        return False
    rest = path.removeprefix(prefix)
    if any(part in {'', '.', '..'} for part in rest.split('/')):
        return False
    if method == 'POST':
        return rest in {'git/blobs', 'git/trees', 'git/commits', 'git/refs', 'pulls'}
    return re.fullmatch(r'git/refs/heads/[A-Za-z0-9._/%-]{1,255}|pulls/[1-9][0-9]{0,9}', rest) is not None


def parameter_value(facts: TokenFacts, owner: str, token: str) -> str:
    """The write token's parameter JSON (``{token_prefix}<id>``), as the broker's reader parses it (``parse_value``)."""
    return json.dumps({'repository': facts.repository, 'login': facts.login, 'expires_at': facts.expires_at,
                       'owner': owner, 'token': token})


def parse_value(text: str) -> WriteToken | None:
    """A write token's parameter JSON, or None when it is off its shape (every field needed: fail closed)."""
    try:
        value = json.loads(text)
    except ValueError:
        return None
    if not isinstance(value, dict):
        return None
    fields = {name: value.get(name) for name in ('repository', 'login', 'expires_at', 'owner', 'token')}
    if not all(isinstance(item, str) for item in fields.values()):
        return None
    repository, login, expires_at, owner, token = (str(fields[name]) for name in fields)
    if (re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}', repository) is None
            or not GITHUB_LOGIN.fullmatch(login) or _day(expires_at) is None
            or not SUBJECT_HASH.fullmatch(owner) or not TOKEN.fullmatch(token)):
        return None
    return WriteToken(repository=repository, login=login, expires_at=expires_at, owner=owner, token=token)


# --- the check at a save ------------------------------------------------------------------------------------------

_CANNOT_ASK: Final = 'GitHub could not be asked about the token: save again in a moment'


def _get(transport: Transport, path: str, token: str) -> Response:
    """One read with the token (in its ``Authorization`` header alone), sent once; a rate limit or a host out of reach
    is ``unavailable``."""
    headers = {'Accept': 'application/vnd.github+json', 'Authorization': f'Bearer {token}',
               'User-Agent': 'voc-engineering-agents-api', 'X-GitHub-Api-Version': GITHUB_API_VERSION}
    try:
        response = transport.request('GET', path, headers, None)
    except HostError:   # (HostBusy included: a host that could not be reached)
        raise TokenRefused('unavailable', _CANNOT_ASK) from None
    limited = response.status == 429 or (response.status == 403 and (
        response.headers.get('x-ratelimit-remaining') == '0' or 'retry-after' in response.headers
        or b'rate limit' in response.body.lower()))
    if limited:
        raise TokenRefused('unavailable', _CANNOT_ASK)
    if response.status == 401:
        raise TokenRefused('not_accepted', 'token: GitHub does not accept it (revoked, expired or mistyped): make a new '
                                           'fine-grained token and paste it whole')
    return response


def _json(response: Response) -> object:
    try:
        return json.loads(response.body)
    except ValueError:
        raise TokenRefused('unavailable', _CANNOT_ASK) from None


def _require_expiry(response: Response, today: date) -> str:
    expiry = expiry_date(response.headers.get(EXPIRY_HEADER))
    if expiry is None:
        raise TokenRefused('no_expiry', f'token: it has no expiry GitHub reports: make one that expires in {MAX_DAYS} '
                                        'days or fewer')
    if expiry <= today:
        raise TokenRefused('expired', f'token: it expired on {expiry.isoformat()}: make a new one')
    # (one day more than MAX_DAYS: the header is the owner's calendar day, a day ahead of UTC's east of it)
    if expiry > today + timedelta(days=MAX_DAYS + 1):
        raise TokenRefused('expires_too_late', f'token: it expires on {expiry.isoformat()}, more than {MAX_DAYS} days '
                                               f'away: make one that expires in {MAX_DAYS} days or fewer')
    return expiry.isoformat()


def _repository_facts(response: Response, repository: str) -> tuple[str, str, str]:
    owner = repository.split('/', 1)[0]
    if response.status == 403:
        raise TokenRefused('org_pending_approval', f'token: GitHub refused it for {repository} (403): when {owner} '
                                                   'approves fine-grained tokens, ask an owner of it to approve this '
                                                   'one, or contribute through a fork')
    if response.status == 404:
        raise TokenRefused('not_found', f'repository: the token cannot see {repository}: check the name, and that the '
                                        f'token\'s resource owner is {owner} with {repository} selected')
    if response.status != 200:
        raise TokenRefused('unavailable', _CANNOT_ASK)
    data = _json(response)
    spelled = dig(data, 'full_name')
    if not isinstance(spelled, str) or spelled.lower() != repository.lower():
        raise TokenRefused('not_found', f'repository: GitHub answered for another repository than {repository}')
    if dig(data, 'private') is not False:
        raise TokenRefused('private_repository', f'repository: {spelled} is private: a token connects a public '
                                                 'repository only (a private one connects through the GitHub App)')
    if dig(data, 'archived') is True:
        raise TokenRefused('archived', f'repository: {spelled} is archived on GitHub: it takes no pushes')
    if dig(data, 'permissions', 'push') is not True:
        raise TokenRefused('no_push', f'token: it cannot push to {spelled}: give it Contents and Pull requests read and '
                                      'write (and ask for push access to the repository if you have none)')
    branch, kind = dig(data, 'default_branch'), dig(data, 'owner', 'type')
    return spelled, branch if isinstance(branch, str) else '', kind if isinstance(kind, str) else ''


def _login(transport: Transport, token: str) -> str:
    response = _get(transport, '/user', token)
    login = dig(_json(response), 'login') if response.status == 200 else None
    if not isinstance(login, str) or not GITHUB_LOGIN.fullmatch(login):
        raise TokenRefused('unavailable', _CANNOT_ASK)
    return login


def _require_this_repository_only(transport: Transport, token: str, repository: str) -> None:
    response = _get(transport, '/user/repos?visibility=private&per_page=1', token)
    if response.status != 200:
        raise TokenRefused('unavailable', _CANNOT_ASK)
    listed = _json(response)
    if not isinstance(listed, list):
        raise TokenRefused('unavailable', _CANNOT_ASK)
    if listed:
        raise TokenRefused('other_repositories', f'token: it reaches private repositories besides {repository}: make '
                                                 f'one with "Only select repositories" and {repository} alone')


def check_token(token: str, repository: str, today: date, transport: Transport | None = None) -> TokenFacts:
    """Whether ``token`` (``shape`` already passed) may be the write token of a connection to ``repository``
    (``owner/name``): the module's five steps, ``TokenRefused`` saying what to change, or ``unavailable``."""
    via = transport or HttpsTransport(CHECK_TIMEOUT_SECONDS, host=API_HOST)
    response = _get(via, f'/repos/{quote(repository, safe="/")}', token)
    expires_at = _require_expiry(response, today) if response.status == 200 else ''
    spelled, branch, owner_type = _repository_facts(response, repository)
    login = _login(via, token)
    _require_this_repository_only(via, token, spelled)
    return TokenFacts(repository=spelled, default_branch=branch, owner_type=owner_type, login=login,
                      expires_at=expires_at)
