"""A fine-grained token's check at a save, its expiry, its parameter and the pin on its requests (7.60.00,
fine_grained.py): every refusal by its code, the expiry header's spellings and the 90-day boundary in UTC, a pending
approval's 403, and the token never in a message, an error or a log line."""
from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date

import pytest

from engineering.connectors import fine_grained
from engineering.connectors.fine_grained import (
    CODES,
    MAX_DAYS,
    TOKEN,
    TokenFacts,
    TokenRefused,
    WriteToken,
    check_token,
    days_left,
    expiry_date,
    expiry_state,
    parameter_value,
    parse_value,
    shape,
    token_request_allowed,
)
from engineering.connectors.hosts import HostBusy
from engineering.connectors.transport import Response

PAT = 'github_pat_11ABCDEFG0' + 'x' * 40
TODAY = date(2026, 11, 20)
REPOSITORY = 'open-tools/lint-kit'
OWNER = 'a' * 64


def answer(status: int = 200, data: object = None, headers: Mapping[str, str] | None = None) -> Response:
    return Response(status=status, headers=dict(headers or {}), body=json.dumps(data).encode())


def repository(**overrides: object) -> dict[str, object]:
    return {'full_name': REPOSITORY, 'private': False, 'archived': False, 'default_branch': 'main',
            'owner': {'login': 'open-tools', 'type': 'Organization'}, 'permissions': {'push': True}, **overrides}


EXPIRES = {'github-authentication-token-expiration': '2027-02-17 23:59:59 -0800'}


@dataclass
class FakeGitHub:
    """api.github.com as the check sees it: an answer per path, every request kept."""

    answers: dict[str, Response | Exception] = field(default_factory=dict)
    sent: list[tuple[str, str, dict[str, str]]] = field(default_factory=list)

    def request(self, method: str, path: str, headers: Mapping[str, str], body: bytes | None) -> Response:
        assert body is None
        self.sent.append((method, path, dict(headers)))
        reply = self.answers[path]
        if isinstance(reply, Exception):
            raise reply
        return reply


def github(repo: Response | None = None, user: Response | None = None, private: Response | None = None) -> FakeGitHub:
    return FakeGitHub({f'/repos/{REPOSITORY}': repo or answer(200, repository(), EXPIRES),
                       '/user': user or answer(200, {'login': 'casey-dev'}),
                       '/user/repos?visibility=private&per_page=1': private or answer(200, [])})


def refused(api: FakeGitHub, today: date = TODAY) -> TokenRefused:
    with pytest.raises(TokenRefused) as caught:
        check_token(PAT, REPOSITORY, today, api)
    return caught.value


def test_a_token_that_passes_answers_its_repository_login_and_expiry_after_four_reads() -> None:
    api = github()
    facts = check_token(PAT, REPOSITORY, TODAY, api)
    assert facts == TokenFacts(repository=REPOSITORY, default_branch='main', login='casey-dev',
                               expires_at='2027-02-17')
    assert [path for _, path, _ in api.sent] == [f'/repos/{REPOSITORY}', '/user',
                                                 '/user/repos?visibility=private&per_page=1']
    assert {headers['Authorization'] for _, _, headers in api.sent} == {f'Bearer {PAT}'}
    assert all(method == 'GET' and PAT not in path for method, path, _ in api.sent)   # (reads only; never in a path)


@pytest.mark.parametrize('prefix', ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'])
def test_any_other_kind_of_github_token_is_refused_as_classic_by_its_prefix(prefix: str) -> None:
    with pytest.raises(TokenRefused) as caught:
        shape(f'{prefix}{"a" * 36}')
    assert caught.value.code == 'classic_token'


@pytest.mark.parametrize('value', ['', 'github_pat_short', 'glpat-abc', None, 42])
def test_a_value_off_the_shape_is_a_400_naming_the_field(value: object) -> None:
    with pytest.raises(ValueError, match=r'^token is a fine-grained personal access token'):
        shape(value)


def test_a_pasted_token_is_trimmed() -> None:
    assert shape(f'  {PAT}\n') == PAT


@pytest.mark.parametrize(('repo', 'code'), [
    (answer(401, {'message': 'Bad credentials'}), 'not_accepted'),
    (answer(403, {'message': 'Resource not accessible by personal access token'}), 'org_pending_approval'),
    (answer(404, {'message': 'Not Found'}), 'not_found'),
    (answer(200, repository(private=True), EXPIRES), 'private_repository'),
    (answer(200, repository(archived=True), EXPIRES), 'archived'),
    (answer(200, repository(permissions={'push': False}), EXPIRES), 'no_push'),
    (answer(200, repository(permissions=None), EXPIRES), 'no_push'),
    (answer(200, repository(full_name='open-tools/other'), EXPIRES), 'not_found'),
    (answer(200, repository()), 'no_expiry'),
    (answer(200, repository(), {'github-authentication-token-expiration': 'never'}), 'no_expiry'),
    (answer(200, repository(), {'github-authentication-token-expiration': '2026-11-20 10:00:00 UTC'}), 'expired'),
    (answer(200, repository(), {'github-authentication-token-expiration': '2026-11-01 10:00:00 UTC'}), 'expired'),
    (answer(200, repository(), {'github-authentication-token-expiration': '2027-11-20 10:00:00 UTC'}),
     'expires_too_late'),
])
def test_each_refusal_of_the_repository_read_has_its_code(repo: Response, code: str) -> None:
    assert code in CODES
    assert refused(github(repo=repo)).code == code


def test_a_403_says_how_an_organization_s_approval_unblocks_it_or_the_fork() -> None:
    message = str(refused(github(repo=answer(403, {}))))
    assert 'ask an owner of it to approve this one' in message
    assert 'fork' in message


def test_a_token_that_reaches_a_private_repository_is_not_this_repository_s_only() -> None:
    api = github(private=answer(200, [{'full_name': 'casey-dev/secret'}]))
    found = refused(api)
    assert (found.code, 'casey-dev/secret' in str(found)) == ('other_repositories', False)


@pytest.mark.parametrize('days', [MAX_DAYS, MAX_DAYS + 1])
def test_ninety_days_from_today_utc_pass_with_a_day_for_the_owner_s_time_zone(days: int) -> None:
    on = date.fromordinal(TODAY.toordinal() + days).isoformat()
    api = github(repo=answer(200, repository(), {'github-authentication-token-expiration': f'{on} 09:00:00 +0900'}))
    assert check_token(PAT, REPOSITORY, TODAY, api).expires_at == on


def test_ninety_two_days_on_is_too_late() -> None:
    on = date.fromordinal(TODAY.toordinal() + MAX_DAYS + 2).isoformat()
    api = github(repo=answer(200, repository(), {'github-authentication-token-expiration': f'{on} 00:00:00 UTC'}))
    assert refused(api).code == 'expires_too_late'


def test_a_token_expiring_tomorrow_still_passes() -> None:
    api = github(repo=answer(200, repository(), {'github-authentication-token-expiration': '2026-11-21 00:00:00 UTC'}))
    assert check_token(PAT, REPOSITORY, TODAY, api).expires_at == '2026-11-21'


@pytest.mark.parametrize(('header', 'day'), [
    ('2027-02-18 06:00:00 -0800', date(2027, 2, 18)), ('2027-02-18 14:00:00 UTC', date(2027, 2, 18)),
    ('2027-02-18T14:00:00Z', date(2027, 2, 18)), ('2027-02-18', date(2027, 2, 18)),
    ('2027-02-18 14:00:00 +05:30', date(2027, 2, 18)), ('2027-02-30 00:00:00 UTC', None), ('', None), (None, None),
    ('Thu, 18 Feb 2027', None),
])
def test_the_expiry_header_is_read_as_the_day_github_writes(header: str | None, day: date | None) -> None:
    assert expiry_date(header) == day


@pytest.mark.parametrize('failure', [HostBusy('down', retry_after=60),
                                     answer(403, {}, {'x-ratelimit-remaining': '0'}), answer(429, {}),
                                     answer(403, {'message': 'API rate limit exceeded'}), answer(500, {})])
def test_github_out_of_reach_or_rate_limiting_is_unavailable_never_a_refusal(failure: Response | Exception) -> None:
    api = FakeGitHub({f'/repos/{REPOSITORY}': failure})
    assert refused(api).code == 'unavailable'


@pytest.mark.parametrize(('user', 'private'), [
    (answer(200, {'login': 'not a login!'}), answer(200, [])), (answer(500, {}), answer(200, [])),
    (answer(200, {'login': 'casey-dev'}), answer(404, {})), (answer(200, {'login': 'casey-dev'}), answer(200, {})),
    (Response(200, {}, b'not json'), answer(200, [])),
])
def test_the_user_reads_off_their_shape_are_unavailable(user: Response, private: Response) -> None:
    assert refused(github(user=user, private=private)).code == 'unavailable'


def test_a_revoked_token_at_the_user_read_is_not_accepted() -> None:
    assert refused(github(user=answer(401, {}))).code == 'not_accepted'


def test_the_token_is_never_in_a_refusal_or_a_log_line(caplog: pytest.LogCaptureFixture) -> None:
    messages = []
    with caplog.at_level(logging.DEBUG):
        apis = (github(repo=answer(404, {'message': PAT})), github(repo=answer(401, {})),
                github(private=answer(200, [{'full_name': 'x/y'}])), github(user=answer(500, {})))
        messages.extend(str(refused(api)) for api in apis)
        for value in (f'ghp_{PAT}', PAT[:20]):
            try:
                shape(value)
            except (TokenRefused, ValueError) as error:
                messages.append(str(error))
    assert PAT not in ' '.join(messages) + caplog.text
    assert 'github_pat_' not in caplog.text


def test_the_check_reaches_api_github_com_alone_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    made: list[str] = []

    class Https:
        def __init__(self, timeout: float, *, host: str) -> None:
            made.append(f'{host}:{timeout}')

        def request(self, method: str, path: str, headers: Mapping[str, str], body: bytes | None) -> Response:
            return github().request(method, path, headers, body)

    monkeypatch.setattr(fine_grained, 'HttpsTransport', Https)
    check_token(PAT, REPOSITORY, TODAY)
    assert made == [f'api.github.com:{fine_grained.CHECK_TIMEOUT_SECONDS}']


# --- the expiry, the parameter and the pin ---------------------------------------------------------------------------


@pytest.mark.parametrize(('expires', 'state', 'left'), [
    ('2026-12-31', 'ok', 41), ('2026-12-04', 'soon', 14), ('2026-12-05', 'ok', 15), ('2026-11-21', 'soon', 1),
    ('2026-11-20', 'expired', 0), ('2026-01-01', 'expired', -323), (None, 'unset', None), ('soon', 'unset', None),
    ('2026-02-30', 'unset', None),
])
def test_a_token_s_state_on_a_day(expires: str | None, state: str, left: int | None) -> None:
    assert (expiry_state(expires, TODAY), days_left(expires, TODAY)) == (state, left)


def test_the_parameter_round_trips_and_its_repr_leaves_the_token_out() -> None:
    facts = TokenFacts(repository=REPOSITORY, default_branch='main', login='casey-dev', expires_at='2027-02-17')
    stored = parse_value(parameter_value(facts, OWNER, PAT))
    assert stored == WriteToken(repository=REPOSITORY, login='casey-dev', expires_at='2027-02-17', owner=OWNER,
                                token=PAT)
    assert PAT not in repr(stored)
    assert TOKEN.fullmatch(PAT)


@pytest.mark.parametrize('text', [
    'not json', '[]', json.dumps({'repository': REPOSITORY}),
    json.dumps({'repository': REPOSITORY, 'login': 'casey', 'expires_at': '2027-02-17', 'owner': 'short',
                'token': PAT}),
    json.dumps({'repository': 'no-slash', 'login': 'casey', 'expires_at': '2027-02-17', 'owner': OWNER, 'token': PAT}),
    json.dumps({'repository': REPOSITORY, 'login': 'casey', 'expires_at': 'soon', 'owner': OWNER, 'token': PAT}),
    json.dumps({'repository': REPOSITORY, 'login': 'casey', 'expires_at': '2027-02-17', 'owner': OWNER,
                'token': 'ghp_' + 'a' * 36}),
])
def test_a_parameter_off_its_shape_is_none(text: str) -> None:
    assert parse_value(text) is None


@pytest.mark.parametrize(('method', 'path', 'allowed'), [
    ('POST', f'/repos/{REPOSITORY}/git/blobs', True), ('POST', f'/repos/{REPOSITORY}/git/trees', True),
    ('POST', f'/repos/{REPOSITORY}/git/commits', True), ('POST', f'/repos/{REPOSITORY}/git/refs', True),
    ('PATCH', f'/repos/{REPOSITORY}/git/refs/heads/voc-agent/run/fix', True),
    ('POST', f'/repos/{REPOSITORY}/pulls', True), ('PATCH', f'/repos/{REPOSITORY}/pulls/12', True),
    ('GET', f'/repos/{REPOSITORY}/pulls/12', False), ('DELETE', f'/repos/{REPOSITORY}/git/refs/heads/x', False),
    ('PUT', f'/repos/{REPOSITORY}/pulls/12/merge', False), ('POST', f'/repos/{REPOSITORY}/pulls/12/reviews', False),
    ('POST', f'/repos/{REPOSITORY}/issues/3/comments', False), ('POST', f'/repos/{REPOSITORY}/issues/3/labels', False),
    ('PATCH', f'/repos/{REPOSITORY}', False), ('POST', '/repos/open-tools/other/git/trees', False),
    ('POST', f'/repos/{REPOSITORY}/git/trees?x=1', False),
    ('PATCH', f'/repos/{REPOSITORY}/git/refs/heads/../../x', False), ('PATCH', f'/repos/{REPOSITORY}/git/refs/tags/v1', False),
    ('POST', '/user/repos', False), ('POST', f'/repos/{REPOSITORY}/forks', False),
])
def test_the_token_is_pinned_to_the_repository_s_git_data_and_pull_request_writes(method: str, path: str,
                                                                                  allowed: bool) -> None:
    assert token_request_allowed(REPOSITORY, method, path) is allowed
