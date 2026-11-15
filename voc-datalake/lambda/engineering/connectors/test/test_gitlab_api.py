"""GitLab's API as the connectors reach it (gitlab_api.py): the one host, the token's header, retries only on reads,
rate limits, the host's words redacted, project paths, and the save's check of a token."""
from __future__ import annotations

from datetime import date
from typing import Any

import pytest

from engineering.connectors.gitlab_api import (
    GITLAB_HOST,
    READ_TRIES,
    REQUIRED_SCOPES,
    TokenFacts,
    TokenRefused,
    check_token,
    gitlab_transport,
    host_text,
    is_project_path,
    next_page,
    project_ref,
    rate_limit_retry,
    send,
)
from engineering.connectors.hosts import HostBusy, HostError
from engineering.connectors.test.gitlab_fakes import API, NOW, PROJECT, PROJECT_ID, TOKEN, Clock, FakeGitLab, answer
from engineering.connectors.transport import HttpsTransport, Response

TODAY = date(2026, 11, 14)
SELF = f'{API}/personal_access_tokens/self'
PROJECT_PATH = f'{API}/projects/example-org%2Fpayments%2Frefund-service'


USER = f'{API}/user'
BOT_ID = 9001


def token_answer(**change: Any) -> Response:
    return answer(200, {'active': True, 'revoked': False, 'scopes': list(REQUIRED_SCOPES), 'expires_at': '2027-11-01',
                        'user_id': BOT_ID, **change})


def user_answer(**change: Any) -> Response:
    """The token's user: by default this project's bot (GitLab's ``project_<id>_bot_<random>``)."""
    return answer(200, {'id': BOT_ID, 'username': f'project_{PROJECT_ID}_bot_4ffca233d8298ea1', 'bot': True, **change})


def project_answer(level: int | None = 30, path: str = PROJECT, project_id: Any = PROJECT_ID) -> Response:
    access = None if level is None else {'access_level': level}
    return answer(200, {'id': project_id, 'path_with_namespace': path,
                        'permissions': {'project_access': access, 'group_access': None}})


def check(api: FakeGitLab, project: str = PROJECT) -> TokenFacts:
    api.routes.setdefault(('GET', USER), [user_answer()])
    return check_token(TOKEN, project, TODAY, transport=api, clock=Clock())


# --- the project's path ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize('path', ['example-org/refund-service', 'group/sub/project', 'a_b/c.d-e', 'g/' * 20 + 'p'])
def test_a_project_path_is_a_namespace_and_a_name(path: str) -> None:
    assert is_project_path(path)


@pytest.mark.parametrize('path', ['project', '/group/p', 'group/', 'group//p', 'group/../p', 'group/p.git',
                                  'group/p.atom', '-group/p', 'g/' * 21 + 'p', 'group/' + 'p' * 260, 'group/p q'])
def test_anything_else_is_not_a_project_path(path: str) -> None:
    assert not is_project_path(path)


def test_a_project_is_named_by_its_id_or_its_whole_path_encoded() -> None:
    assert (project_ref(PROJECT_ID), project_ref('a/b c')) == ('4242', 'a%2Fb%20c')


# --- requests -------------------------------------------------------------------------------------------------------


def test_a_request_carries_the_token_only_in_its_authorization_header() -> None:
    api = FakeGitLab().on('GET', f'{API}/projects/1', answer(200, {}))
    send(api, Clock(), 'GET', '/projects/1', TOKEN, 'the read')
    sent = api.sent[0]
    assert sent.headers['Authorization'] == f'Bearer {TOKEN}'
    assert TOKEN not in sent.path


def test_the_transport_reaches_gitlab_com_alone() -> None:
    made = gitlab_transport()
    assert isinstance(made, HttpsTransport)
    assert made._host == GITLAB_HOST


def test_a_read_lost_or_unavailable_is_sent_again_once() -> None:
    api = FakeGitLab().on('GET', f'{API}/x', HostBusy('lost', retry_after=60), answer(503), answer(200, {'ok': 1}))
    with pytest.raises(HostError) as failed:
        send(api, Clock(), 'GET', '/x', TOKEN, 'the read')
    assert failed.value.status == 503
    assert len(api.sent) == READ_TRIES
    assert send(api, Clock(), 'GET', '/x', TOKEN, 'the read').status == 200


def test_a_read_retried_after_a_lost_answer_returns_the_second() -> None:
    api = FakeGitLab().on('GET', f'{API}/x', HostBusy('lost', retry_after=60), answer(200, {'ok': 1}))
    assert send(api, Clock(), 'GET', '/x', TOKEN, 'the read').status == 200
    assert len(api.sent) == 2


@pytest.mark.parametrize('method', ['POST', 'PUT', 'DELETE'])
def test_a_write_is_never_sent_twice(method: str) -> None:
    api = FakeGitLab().on(method, f'{API}/x', answer(503))
    with pytest.raises(HostError):
        send(api, Clock(), method, '/x', TOKEN, 'the write', body={'a': 1}, ok=(201,))
    assert len(api.sent) == 1


@pytest.mark.parametrize(('headers', 'seconds'), [
    ({'retry-after': '7'}, 7), ({'ratelimit-reset': str(int(NOW) + 30)}, 30), ({}, 60)])
def test_a_rate_limit_is_never_waited_out(headers: dict[str, str], seconds: int) -> None:
    api = FakeGitLab().on('GET', f'{API}/x', answer(429, {}, headers))
    with pytest.raises(HostBusy) as busy:
        send(api, Clock(), 'GET', '/x', TOKEN, 'the read')
    assert busy.value.retry_after == seconds
    assert rate_limit_retry(answer(403, {}), NOW) is None


def test_the_hosts_words_are_kept_redacted_and_never_with_the_token() -> None:
    echoed = answer(400, {'message': f'bad token {TOKEN} or glpat-{"z" * 24}\nsecond line'})
    api = FakeGitLab().on('POST', f'{API}/x', echoed)
    with pytest.raises(HostError) as failed:
        send(api, Clock(), 'POST', '/x', TOKEN, 'the write', body={}, ok=(201,))
    assert TOKEN not in failed.value.reason
    assert 'glpat-zzzz' not in failed.value.reason
    assert failed.value.reason.startswith('The repository host answered 400 to the write: bad token')


@pytest.mark.parametrize(('body', 'said'), [
    (b'not json', ''), (b'{}', ''), (b'[1]', ''), (b'{"message": {"base": ["is invalid"]}}', '{"base": ["is invalid"]}'),
    (b'{"error": "' + b'x' * 300 + b'"}', 'x' * 200)])
def test_the_hosts_words_are_read_from_its_message_or_error(body: bytes, said: str) -> None:
    assert host_text(Response(400, {}, body), TOKEN) == said


def test_the_next_page_is_gitlabs_x_next_page_number() -> None:
    assert (next_page({'x-next-page': '3'}), next_page({'x-next-page': ''}), next_page({'x-next-page': '0'})) == (
        '3', None, None)


# --- the save's check of a token ------------------------------------------------------------------------------------


def test_a_developer_token_of_the_project_passes_with_its_expiry_and_the_hosts_spelling() -> None:
    api = FakeGitLab().on('GET', SELF, token_answer()).on('GET', f'{API}/projects/example-org%2Fpayments%2Frefund-svc',
                                                          project_answer(path='Example-Org/payments/refund-svc'))
    facts = check(api, 'example-org/payments/refund-svc')
    assert facts == TokenFacts(project_id=PROJECT_ID, project='Example-Org/payments/refund-svc', expires_at='2027-11-01')
    assert [s.method for s in api.sent] == ['GET', 'GET', 'GET']   # (three reads, no write)


@pytest.mark.parametrize('user', [
    # A personal access token: its user a person (a direct Developer member, who reaches every project they can).
    user_answer(username='dana', bot=False),
    user_answer(username=f'project_{PROJECT_ID}_bot_4ffca233d8298ea1', bot=False),
    # Another project's bot (its token sees a public project, or was added to this one as a member).
    user_answer(username='project_77_bot_4ffca233d8298ea1'),
    user_answer(username=f'project_{PROJECT_ID}0_bot_4ffca233d8298ea1'),
    # A bot, but not the user the token is of.
    user_answer(id=BOT_ID + 1),
    answer(404, {}),
], ids=['personal', 'not a bot', 'another project', 'a longer id', 'another user', 'unread'])
def test_only_a_project_access_token_of_this_project_passes(user: Response) -> None:
    api = FakeGitLab().on('GET', SELF, token_answer()).on('GET', PROJECT_PATH, project_answer()).on('GET', USER, user)
    with pytest.raises(TokenRefused, match='use a project access token of this project') as refused:
        check(api)
    assert refused.value.kind == 'invalid'


def test_an_older_project_bots_name_passes() -> None:
    api = FakeGitLab().on('GET', SELF, token_answer()).on('GET', PROJECT_PATH, project_answer()).on(
        'GET', USER, user_answer(username=f'project_{PROJECT_ID}_bot3'))
    assert check(api).project_id == PROJECT_ID


@pytest.mark.parametrize(('token', 'said'), [
    (answer(401, {'message': '401 Unauthorized'}), 'does not accept the token'),
    (token_answer(active=False), 'does not accept the token'),
    (token_answer(revoked=True), 'does not accept the token'),
    (answer(404, {}), 'does not accept the token'),
    (token_answer(scopes=['read_api']), 'lacks the scope(s) api, read_repository, write_repository'),
    (token_answer(scopes=['api', 'read_repository']), 'lacks the scope(s) write_repository'),
    (token_answer(expires_at=None), 'no expiry'),
    (token_answer(expires_at='soon'), 'no expiry'),
    (token_answer(expires_at='2026-11-14'), 'expired on 2026-11-14'),
])
def test_a_token_gitlab_does_not_take_as_it_is_is_refused_saying_what_to_change(token: Response, said: str) -> None:
    api = FakeGitLab().on('GET', SELF, token).on('GET', PROJECT_PATH, project_answer())
    with pytest.raises(TokenRefused, match=said.replace('(', r'\(').replace(')', r'\)')) as refused:
        check(api)
    assert refused.value.kind == 'invalid'
    assert TOKEN not in str(refused.value)


@pytest.mark.parametrize(('project', 'said'), [
    (answer(404, {'message': '404 Project Not Found'}), 'cannot see this project'),
    (answer(401, {}), 'does not accept the token'),
    (project_answer(path='example-org/other'), 'another project'),
    (project_answer(project_id='4242'), 'another project'),
    (project_answer(level=None), "not this project's own"),
    (project_answer(level=40), 'role is Maintainer'),
    (project_answer(level=50), 'role is Owner'),
    (project_answer(level=20), 'role is Reporter'),
    (project_answer(level=35), 'role is another role'),
])
def test_a_token_that_is_not_this_projects_developer_is_refused(project: Response, said: str) -> None:
    api = FakeGitLab().on('GET', SELF, token_answer()).on('GET', PROJECT_PATH, project)
    with pytest.raises(TokenRefused, match=said) as refused:
        check(api)
    assert refused.value.kind == 'invalid'


@pytest.mark.parametrize('trouble', [answer(429, {}), answer(500, {}), HostBusy('lost', retry_after=60)])
def test_a_gitlab_that_cannot_be_asked_is_unavailable_never_a_pass(trouble: Response | Exception) -> None:
    api = FakeGitLab().on('GET', SELF, trouble)
    with pytest.raises(TokenRefused) as refused:
        check(api)
    assert refused.value.kind == 'unavailable'
    assert len(api.sent) == 1   # (sent once: the save's two reads end inside the API's 29 s)
