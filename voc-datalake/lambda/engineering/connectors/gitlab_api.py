"""GitLab's REST API as the connectors reach it (docs/autonomous-engineering.md, "Repository connectors": GitLab).

One host, ``gitlab.com`` (``GITLAB_HOST``: a self-managed instance's base URL is planned, for the owner to decide; it
would change this constant into a connection's field). Shared by the broker's GitLab client (``gitlab.py``), the
checkout cache's fetch (``cache.py``) and the Agents API's check of a token when a connection is saved
(``check_token``), so nothing here imports ``cryptography``.

* A request carries the connection's project access token only in its ``Authorization: Bearer`` header, never in a
  path or a log line; every path is under ``/api/v4``, the project named by its numeric id or its URL-encoded path.
* A rate limit (429, ``Retry-After`` or ``RateLimit-Reset``) is never waited out: ``HostBusy`` with the seconds to wait.
* A read (GET) that is lost on the way, or answered 502, 503 or 504, is tried again, at most ``READ_TRIES`` times in
  all; a write never is (its answer lost, the write may have happened: ``transport.py``).
* What the host says of a refusal (its ``message`` or ``error``) is kept in the error only after the token, and any
  credential-shaped text, is cut out of it, on one line, at most ``MAX_HOST_TEXT`` characters.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date
from typing import Final, Literal
from urllib.parse import quote

from engineering.connectors.hosts import PAGE_NUMBER, HostBusy, HostError
from engineering.connectors.transport import (
    DEFAULT_RETRY_SECONDS,
    SAFE_METHODS,
    HttpsTransport,
    Response,
    Transport,
    asked_wait,
    dig,
    json_of,
)

GITLAB_HOST: Final = 'gitlab.com'
#: The web address projects are under: the checkout cache's fetch URL and a comment's link start here.
GITLAB_URL: Final = f'https://{GITLAB_HOST}/'
API_PREFIX: Final = '/api/v4'
#: How many times a read is sent in all when it is lost or answered 502, 503 or 504.
READ_TRIES: Final = 2
_RETRIED_STATUSES: Final = frozenset({502, 503, 504})
#: The most of the host's own words an error keeps.
MAX_HOST_TEXT: Final = 200
#: A project access token's scopes the connection needs (``api`` covers merge requests and notes; the repository
#: scopes are what git's fetch and the Commits API name).
REQUIRED_SCOPES: Final = ('api', 'read_repository', 'write_repository')
#: The role a connection's token holds on its project: Developer (30). Maintainer (40) and Owner (50) could change
#: the project's protected branches and variables; Reporter (20) and Guest (10) cannot push.
DEVELOPER: Final = 30
#: A project access token as GitLab hands it out (``glpat-``, then its body).
TOKEN: Final = re.compile(r'glpat-[A-Za-z0-9_.-]{20,300}')
#: One part of a project's path (a group, a subgroup or the project): letters, digits, ``_``, ``.`` and ``-``.
_SEGMENT: Final = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}')
#: A project's path holds its namespace (a group and up to 19 subgroups) and its own name.
MAX_PATH_SEGMENTS: Final = 21
MAX_PATH: Final = 255

Kind = Literal['invalid', 'unavailable']


def is_project_path(text: str) -> bool:
    """``group[/subgroup...]/project`` as GitLab spells a project's path (its URL's path): 2 to ``MAX_PATH_SEGMENTS``
    parts, at most ``MAX_PATH`` characters, no ``..``, and no part ending in ``.git`` or ``.atom``."""
    parts = text.split('/')
    return (0 < len(text) <= MAX_PATH and 2 <= len(parts) <= MAX_PATH_SEGMENTS and '..' not in text
            and all(_SEGMENT.fullmatch(part) and not part.endswith(('.git', '.atom')) for part in parts))


def project_ref(project: int | str) -> str:
    """The project as a path names it: its numeric id, or its path URL-encoded whole (``/`` as ``%2F``)."""
    return str(project) if isinstance(project, int) else quote(project, safe='')


def host_text(response: Response, token: str) -> str:
    """What the host said of a refusal (its ``message`` or ``error``), with ``token`` and any credential-shaped text
    cut out, on one line, at most ``MAX_HOST_TEXT`` characters; '' when it said nothing readable."""
    from engineering.quality_gate.text import redact

    try:
        data = json.loads(response.body)
    except ValueError:
        return ''
    said = (data.get('message') or data.get('error')) if isinstance(data, dict) else None
    if not said:
        return ''
    text = said if isinstance(said, str) else json.dumps(said, sort_keys=True)
    if token:
        text = text.replace(token, '<redacted>')
    return ' '.join(redact(text).split())[:MAX_HOST_TEXT]


def rate_limit_retry(response: Response, now: float) -> int | None:
    """The seconds GitLab asks the client to wait (at least one) when it answered 429, else ``None``."""
    if response.status != 429:
        return None
    asked = asked_wait(response, 'ratelimit-reset', now)
    return DEFAULT_RETRY_SECONDS if asked is None else asked


def next_page(headers: Mapping[str, str]) -> str | None:
    """GitLab's ``X-Next-Page`` (the next read's cursor): a page number, or ``None`` on the last page."""
    page = headers.get('x-next-page', '')
    return page if PAGE_NUMBER.fullmatch(page) else None


#: Each request of the save's token check gets this long, and is sent once: its three reads end inside the API's
#: 29 s, so an administrator never meets a gateway timeout while the save goes on.
CHECK_TIMEOUT_SECONDS: Final = 6.0


def gitlab_transport(timeout: float = 10.0) -> Transport:
    """``gitlab.com`` over HTTPS, the one host the GitLab paths reach."""
    return HttpsTransport(timeout, host=GITLAB_HOST)


def send(transport: Transport, clock: Callable[[], float], method: str, path: str, token: str, what: str, *,
         body: object = None, ok: tuple[int, ...] = (200,), read_tries: int = READ_TRIES) -> Response:
    """``path`` (under ``/api/v4``) with ``token``: the answer when its status is in ``ok``; ``HostBusy`` for a rate
    limit, or for a read still lost or unavailable after ``read_tries``; else ``HostError`` with the status."""
    headers = {'Accept': 'application/json', 'Authorization': f'Bearer {token}', 'User-Agent': 'voc-engineering-broker'}
    data = None if body is None else json.dumps(body).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    retries = read_tries - 1 if method in SAFE_METHODS else 0
    for _ in range(retries):
        try:
            response = transport.request(method, f'{API_PREFIX}{path}', headers, data)
        except HostBusy:   # (a read lost on the way: sent again)
            continue
        if response.status not in _RETRIED_STATUSES or response.status in ok:
            return _checked(response, clock(), token, what, ok)
    return _checked(transport.request(method, f'{API_PREFIX}{path}', headers, data), clock(), token, what, ok)


def _checked(response: Response, now: float, token: str, what: str, ok: tuple[int, ...]) -> Response:
    retry = rate_limit_retry(response, now)
    if retry is not None:
        raise HostBusy(f'The repository host is rate limiting {what}; retry later.', retry_after=retry)
    if response.status in ok:
        return response
    said = host_text(response, token)
    unexpected = HostError(f'The repository host answered {response.status} to {what}' + (f': {said}' if said else '.'))
    unexpected.status = response.status
    raise unexpected


# --- the Agents API's check of a token, when a connection is saved ------------------------------------------------


class TokenRefused(Exception):
    """A token the connection cannot be saved with: ``kind`` ``invalid`` (400) or ``unavailable`` (503, GitLab could not
    be asked). The message names what is wrong, never the token. Raised as ``TokenRefused(kind, message)``."""

    @property
    def kind(self) -> Kind:
        return 'unavailable' if self.args[0] == 'unavailable' else 'invalid'

    def __str__(self) -> str:
        return str(self.args[1])


@dataclass(frozen=True)
class TokenFacts:
    """What GitLab says of a token that passed: its project's id and path (as GitLab spells it), and when it
    expires (``YYYY-MM-DD``)."""

    project_id: int
    project: str
    expires_at: str


_ROLE_WORDS: Final = {10: 'Guest', 20: 'Reporter', 40: 'Maintainer', 50: 'Owner'}
_CANNOT_ASK: Final = 'GitLab could not be asked about the token: save again in a moment'
_NOT_PROJECT_BOT: Final = ('credential: the token is not a project access token of this project (a personal token, '
                             "or another project's): use a project access token of this project, made in its "
                             'settings')
_NOT_ACCEPTED: Final = ('credential: GitLab does not accept the token (revoked, expired or mistyped): make a new project '
                        'access token and paste it whole')


def _ask(transport: Transport, clock: Callable[[], float], path: str, token: str, what: str) -> Response:
    try:
        response = send(transport, clock, 'GET', path, token, what, ok=(200, 401, 403, 404), read_tries=1)
    except HostError:   # (a rate limit or a host that cannot be reached included: HostBusy is a HostError)
        raise TokenRefused('unavailable', _CANNOT_ASK) from None
    if response.status == 401:
        raise TokenRefused('invalid', _NOT_ACCEPTED)
    return response


def _token_facts(transport: Transport, clock: Callable[[], float], token: str, today: date) -> tuple[str, int]:
    """The token's own facts (``/personal_access_tokens/self``, which a project access token reads of itself): active,
    the scopes the connection needs, an expiry after ``today``. Its expiry (``YYYY-MM-DD``) and its user's id."""
    response = _ask(transport, clock, '/personal_access_tokens/self', token, 'the token check')
    data = json_of(response) if response.status == 200 else None
    user_id = dig(data, 'user_id')
    if data is None or dig(data, 'active') is not True or dig(data, 'revoked') is True or not isinstance(user_id, int) \
            or isinstance(user_id, bool):
        raise TokenRefused('invalid', _NOT_ACCEPTED)
    scopes = dig(data, 'scopes')
    missing = [scope for scope in REQUIRED_SCOPES if not (isinstance(scopes, list) and scope in scopes)]
    if missing:
        raise TokenRefused('invalid', f'credential: the token lacks the scope(s) {", ".join(missing)}: make one with '
                                      f'{", ".join(REQUIRED_SCOPES)}')
    expires = dig(data, 'expires_at')
    try:
        expiry = date.fromisoformat(expires) if isinstance(expires, str) else None
    except ValueError:
        expiry = None
    if expiry is None:
        raise TokenRefused('invalid', 'credential: the token has no expiry GitLab reports: make one with an expiry '
                                      '(at most a year)')
    if expiry <= today:
        raise TokenRefused('invalid', f'credential: the token expired on {expiry.isoformat()}: make a new one')
    return expiry.isoformat(), user_id


def _require_project_bot(transport: Transport, clock: Callable[[], float], token: str, user_id: int,
                         project_id: int) -> None:
    """The token's user (``GET /user``) must be the project's own bot: a bot (``bot: true``), the user the token is
    of, and named as GitLab names a project access token's bot. GitLab's docs ("Project access tokens", bot users for
    projects): "a bot user is created ... The username is set to project_{project_id}_bot_{random_string}" (for
    example project_123_bot_ and a hexadecimal string); tokens made before 15.x carry project_{project_id}_bot and a
    number. A personal access token (its user a person, who reaches every project they can) or another project's
    token is refused."""
    response = _ask(transport, clock, '/user', token, 'the token check')
    data = json_of(response) if response.status == 200 else None
    username = dig(data, 'username')
    bot = re.compile(rf'project_{project_id}_bot(?:_[0-9a-z]+|[0-9]*)')
    if dig(data, 'bot') is not True or dig(data, 'id') != user_id or not isinstance(username, str) \
            or bot.fullmatch(username) is None:
        raise TokenRefused('invalid', _NOT_PROJECT_BOT)


def check_token(token: str, project: str, today: date, transport: Transport | None = None,
                clock: Callable[[], float] = lambda: 0.0) -> TokenFacts:
    """Whether ``token`` may be a connection's credential for ``project`` (its path): GitLab accepts it, it is active
    with the scopes ``REQUIRED_SCOPES`` and an expiry after ``today``, and the project it reads at that path is its
    own: a project access token of that project (its user that project's bot, ``_require_project_bot``), a member of
    it with the role Developer, not higher or lower. Three reads, each sent once with ``CHECK_TIMEOUT_SECONDS``, no
    write; the token is never put in a message. ``TokenRefused`` saying what to change, or ``unavailable`` when GitLab
    cannot be asked."""
    via = transport or gitlab_transport(CHECK_TIMEOUT_SECONDS)
    expires, user_id = _token_facts(via, clock, token, today)
    response = _ask(via, clock, f'/projects/{project_ref(project)}', token, 'the project check')
    if response.status != 200:
        raise TokenRefused('invalid', 'repository: the token cannot see this project on GitLab: check its path, and '
                                      'that the token is this project\'s')
    data = json_of(response)
    path, project_id = dig(data, 'path_with_namespace'), dig(data, 'id')
    if not isinstance(path, str) or path.casefold() != project.casefold() or not isinstance(project_id, int) \
            or isinstance(project_id, bool):
        raise TokenRefused('invalid', 'repository: GitLab answered for another project than this path')
    level = dig(data, 'permissions', 'project_access', 'access_level')
    if level is None:
        raise TokenRefused('invalid', 'credential: the token is not this project\'s own: make a project access token '
                                      'in this project\'s settings')
    if level != DEVELOPER:
        role = _ROLE_WORDS.get(level, 'another role') if isinstance(level, int) else 'another role'
        raise TokenRefused('invalid', f'credential: the token\'s role is {role}: make one with the role Developer')
    _require_project_bot(via, clock, token, user_id, project_id)
    return TokenFacts(project_id=project_id, project=path, expires_at=expires)
