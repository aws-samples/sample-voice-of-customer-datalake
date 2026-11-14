"""The GitHub client (github.py): App JWT, scoped tokens, paging, rate limits, the leased push, the draft PR, Stop."""
from __future__ import annotations

import base64
import http.client
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

from engineering.connectors import github
from engineering.connectors.broker import Broker
from engineering.connectors.github import (
    API_HOST,
    JWT_SECONDS,
    MAX_RESPONSE_BYTES,
    TOKEN_MARGIN_SECONDS,
    GitHubHost,
    HttpsTransport,
    Response,
    app_jwt,
    next_page,
    rate_limit_retry,
)
from engineering.connectors.hosts import (
    WRITE_UNKNOWN,
    BundleContents,
    Commit,
    Conflict,
    FileChange,
    HostBusy,
    HostError,
    InvalidTarget,
    NotFound,
    OutcomeUnknown,
    PullRequestRef,
)
from engineering.connectors.identity import Caller
from engineering.connectors.test.app_keys import APP_ID, INSTALLATION_ID, credential, private_key
from engineering.connectors.test.fakes import BASE, BOT, BRANCH, RUN, TREE, FakeWrites, bundle_contents, connector
from engineering.connectors.write_policy import WriteRefused

NOW = 1_800_000_000.0
REPO = '/repos/example-org/refund-service'
TOKENS = f'/app/installations/{INSTALLATION_ID}/access_tokens'
BASE_TREE = '1' * 40
COMMIT = 'c' * 40
BLOB = 'b' * 40
QUOTED_REF = f'/git/ref/heads/{BRANCH}'


def answer(status: int = 200, data: object = None, headers: Mapping[str, str] | None = None) -> Response:
    return Response(status=status, headers=dict(headers or {}), body=json.dumps(data).encode())


@dataclass
class Sent:
    method: str
    path: str
    headers: dict[str, str]
    body: Any


@dataclass
class FakeGitHub:
    """The GitHub API as the client sees it: canned answers per (method, path), every request recorded."""

    routes: dict[tuple[str, str], list[Response | Callable[[Sent], Response]]] = field(default_factory=dict)
    sent: list[Sent] = field(default_factory=list)
    minted: int = 0

    def __post_init__(self) -> None:
        self.on('POST', TOKENS, self._mint)

    def _mint(self, _: Sent) -> Response:
        self.minted += 1
        expires = datetime.fromtimestamp(NOW + 3600, UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
        return answer(201, {'token': f'ghs_test_token_{self.minted}', 'expires_at': expires})

    def on(self, method: str, path: str, *answers: Response | Callable[[Sent], Response]) -> FakeGitHub:
        """Answer ``method path`` with ``answers`` in turn, the last one from then on."""
        self.routes[(method, path)] = list(answers)
        return self

    def request(self, method: str, path: str, headers: Mapping[str, str], body: bytes | None) -> Response:
        sent = Sent(method, path, dict(headers), None if body is None else json.loads(body))
        self.sent.append(sent)
        queue = self.routes.get((method, path))
        if not queue:
            raise AssertionError(f'unexpected {method} {path}')
        reply = queue.pop(0) if len(queue) > 1 else queue[0]
        return reply(sent) if callable(reply) else reply

    def calls(self) -> list[tuple[str, str]]:
        """Every request but the token requests."""
        return [(s.method, s.path) for s in self.sent if s.path != TOKENS]

    def scopes(self) -> list[Any]:
        """The body of every token request."""
        return [s.body for s in self.sent if s.path == TOKENS]


class Clock:
    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> float:
        return self.now


def client(api: FakeGitHub, clock: Clock | None = None) -> GitHubHost:
    return GitHubHost(lambda _: credential(), api, clock=clock or Clock())


def decode(part: str) -> Any:
    return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))


# --- the App JWT and the installation tokens ------------------------------------------------------------------------


def test_the_app_jwt_is_rs256_short_lived_and_issued_by_the_app() -> None:
    token = app_jwt(credential(), NOW)
    header, claims, signature = token.split('.')
    assert decode(header) == {'alg': 'RS256', 'typ': 'JWT'}
    assert decode(claims) == {'iat': int(NOW) - 60, 'exp': int(NOW) + JWT_SECONDS, 'iss': APP_ID}
    assert decode(claims)['exp'] - decode(claims)['iat'] <= 600   # GitHub takes at most ten minutes
    private_key().public_key().verify(base64.urlsafe_b64decode(signature + '=' * (-len(signature) % 4)),
                                      f'{header}.{claims}'.encode(), padding.PKCS1v15(), hashes.SHA256())


def test_a_token_is_minted_with_the_app_jwt_for_one_repository() -> None:
    api = FakeGitHub().on('GET', f'{REPO}/contents/README.md', Response(200, {}, b'# Refunds'))
    page = client(api).read('conn-1', 'file', 'README.md', None)
    assert page.content == '# Refunds'
    mint, read = api.sent
    assert mint.headers['Authorization'] == f'Bearer {app_jwt(credential(), NOW)}'
    assert mint.body == {'repositories': ['refund-service'], 'permissions': {'contents': 'read'}}
    assert read.headers['Authorization'] == 'Bearer ghs_test_token_1'
    assert read.headers['Accept'] == 'application/vnd.github.raw+json'
    assert read.headers['X-GitHub-Api-Version'] == '2022-11-28'


def every_route(api: FakeGitHub) -> FakeGitHub:
    """Answers for every operation of ``scoped_operations``."""
    return (api.on('GET', f'{REPO}/contents/a.py', Response(200, {}, b'x'))
            .on('GET', f'{REPO}/commits?per_page=30&page=1&path=a.py', answer(200, []))
            .on('GET', f'{REPO}/issues/42', answer(200, {'number': 42}))
            .on('GET', f'{REPO}/pulls/7', answer(200, {'number': 7}))
            .on('GET', f'{REPO}/issues/42/comments?per_page=30&page=1', answer(200, []))
            .on('GET', f'{REPO}/issues/7/comments?per_page=30&page=1', answer(200, []))
            .on('GET', f'{REPO}/pulls/7/comments?per_page=30&page=1', answer(200, []))
            .on('GET', f'{REPO}/pulls/7/reviews?per_page=30&page=1', answer(200, []))
            .on('POST', f'{REPO}/issues/42/comments', answer(201, {'html_url': 'https://h/c/1'}))
            .on('POST', f'{REPO}/issues/7/comments', answer(201, {'html_url': 'https://h/c/2'})))


@pytest.mark.parametrize(('operation', 'permissions'), [
    (lambda host: host.read('c', 'file', 'a.py', None), {'contents': 'read'}),
    (lambda host: host.read('c', 'history', 'a.py', None), {'contents': 'read'}),
    (lambda host: host.read('c', 'issue', '42', None), {'issues': 'read'}),
    (lambda host: host.read('c', 'pull_request', '7', None), {'pull_requests': 'read'}),
    (lambda host: host.post_comment('c', 'issue', 42, 'Noted.'), {'issues': 'write'}),
    (lambda host: host.post_comment('c', 'pull_request', 7, 'Noted.'), {'pull_requests': 'write'}),
])
def test_each_operation_asks_only_for_the_permissions_it_needs(operation: Callable[[GitHubHost], object],
                                                               permissions: dict[str, str]) -> None:
    api = every_route(FakeGitHub())
    operation(client(api))
    assert api.scopes() == [{'repositories': ['refund-service'], 'permissions': permissions}]


def test_a_push_holds_contents_write_and_a_pull_request_contents_read_and_pull_requests_write() -> None:
    api = pushable(FakeGitHub(), head=None)
    client(api).push_bundle('c', BRANCH, one_change(), TREE, 'main')
    assert api.scopes() == [{'repositories': ['refund-service'], 'permissions': {'contents': 'write'}}]
    api = draftable(FakeGitHub(), open_prs=[])
    client(api).open_or_update_draft_pr('c', BRANCH, 'main', 'Fix', 'Body', TREE)
    assert api.scopes() == [{'repositories': ['refund-service'],
                             'permissions': {'contents': 'read', 'pull_requests': 'write'}}]


def test_the_branch_lookup_only_reads() -> None:
    api = FakeGitHub().on('GET', f'{REPO}{QUOTED_REF}', answer(404, {}))
    host = client(api)
    assert host.branch_tree_hash('c', BRANCH) is None
    assert [s['permissions'] for s in api.scopes()] == [{'contents': 'read'}]


@pytest.mark.parametrize('repointed', [
    {'repository': 'billing-service'}, {'installation_id': INSTALLATION_ID + 1}, {'owner': 'other-org'}])
def test_a_repointed_connection_never_reuses_the_old_repositorys_token(repointed: dict[str, Any]) -> None:
    current = [credential()]
    moved = replace(credential(), **repointed)
    api = FakeGitHub().on('GET', f'{REPO}/contents/a.py', Response(200, {}, b'x'))
    api.on('POST', f'/app/installations/{moved.installation_id}/access_tokens', api.routes[('POST', TOKENS)][0])
    api.on('GET', f'/repos/{moved.owner}/{moved.repository}/contents/a.py', Response(200, {}, b'y'))
    host = GitHubHost(lambda _: current[0], api, clock=Clock())
    host.read('c', 'file', 'a.py', None)
    current[0] = moved
    assert host.read('c', 'file', 'a.py', None).content == 'y'
    assert api.minted == 2
    assert api.sent[-1].headers['Authorization'] == 'Bearer ghs_test_token_2'


def test_a_token_is_reused_until_shortly_before_it_expires() -> None:
    api = FakeGitHub().on('GET', f'{REPO}/contents/a.py', Response(200, {}, b'x'))
    clock = Clock()
    host = client(api, clock)
    host.read('c', 'file', 'a.py', None)
    host.read('c', 'file', 'a.py', None)
    assert api.minted == 1
    clock.now = NOW + 3600 - TOKEN_MARGIN_SECONDS - 1
    host.read('c', 'file', 'a.py', None)
    assert api.minted == 1
    clock.now += 2
    host.read('c', 'file', 'a.py', None)
    assert api.minted == 2
    assert [s.headers['Authorization'] for s in api.sent if s.path != TOKENS][-1] == 'Bearer ghs_test_token_2'


@pytest.mark.parametrize('reply', [
    answer(201, {'token': 'ghs_x'}),
    answer(201, {'token': 'ghs_x', 'expires_at': 'soon'}),
    Response(201, {}, b'not json'),
    answer(500, {'message': 'boom'}),
])
def test_a_token_request_the_host_answers_wrongly_is_a_host_error(reply: Response) -> None:
    api = FakeGitHub().on('POST', TOKENS, reply)
    with pytest.raises(HostError) as caught:
        client(api).read('c', 'file', 'a.py', None)
    assert 'ghs_x' not in caught.value.reason
    assert 'boom' not in caught.value.reason


# --- reads, paging and rate limits ----------------------------------------------------------------------------------


def test_a_missing_file_is_not_found() -> None:
    api = FakeGitHub().on('GET', f'{REPO}/contents/src/a%20b.py', answer(404, {}))
    with pytest.raises(NotFound):
        client(api).read('c', 'file', 'src/a b.py', None)


@pytest.mark.parametrize('target', ['../secrets', 'src/../../x', '/etc/passwd', 'a//b', 'a/./b', 'a\\b', 'a\nb', 'a/'])
def test_a_file_path_that_leaves_the_repository_is_never_asked_for(target: str) -> None:
    api = FakeGitHub()
    with pytest.raises(InvalidTarget):
        client(api).read('c', 'file', target, None)
    assert api.calls() == []


def test_a_file_has_no_pages() -> None:
    with pytest.raises(InvalidTarget):
        client(FakeGitHub()).read('c', 'file', 'a.py', '2')


def test_a_file_that_is_not_utf8_text_is_refused_not_mangled() -> None:
    api = FakeGitHub().on('GET', f'{REPO}/contents/logo.png', Response(200, {}, b'\x89PNG\r\n\x1a\n\xff'))
    with pytest.raises(InvalidTarget) as caught:
        client(api).read('c', 'file', 'logo.png', None)
    assert 'UTF-8' in caught.value.reason


def test_history_follows_the_link_header_by_page_number() -> None:
    link = (f'<https://{API_HOST}/repositories/1/commits?path=a.py&page=3>; rel="next", '
            f'<https://{API_HOST}/repositories/1/commits?path=a.py&page=9>; rel="last"')
    commit = {'sha': COMMIT, 'commit': {'message': 'Fix', 'committer': {'date': '2026-11-01T00:00:00Z'},
                                        'author': {'email': 'casey@mail-host.net'}}}
    api = (FakeGitHub().on('GET', f'{REPO}/commits?per_page=30&page=2&path=a.py', answer(200, [commit], {'link': link}))
           .on('GET', f'{REPO}/commits?per_page=30&page=1', answer(200, {'not': 'a list'})))
    host = client(api)
    page = host.read('c', 'history', 'a.py', '2')
    assert page.next_cursor == '3'
    assert json.loads(page.content) == {'commits': [{'sha': COMMIT, 'date': '2026-11-01T00:00:00Z', 'message': 'Fix'}]}
    assert 'casey@' not in page.content   # no author address is handed to an agent
    whole = host.read('c', 'history', '.', None)   # "." is the whole repository
    assert (whole.content, whole.next_cursor) == ('{"commits": []}', None)


@pytest.mark.parametrize(('link', 'expected'), [
    ('', None),
    ('<https://api.github.com/x?page=2>; rel="last"', None),
    ('<https://api.github.com/x?page=2>; rel="next"', '2'),
    ('<https://api.github.com/x?page=abc>; rel="next"', None),
    ('<https://api.github.com/x>; rel="next"', None),
])
def test_the_next_cursor_is_only_a_page_number(link: str, expected: str | None) -> None:
    assert next_page({'link': link} if link else {}) == expected


@pytest.mark.parametrize('cursor', ['0', 'https://evil.example/x', '1;2', '123456'])
def test_a_cursor_the_broker_did_not_hand_out_is_refused(cursor: str) -> None:
    api = FakeGitHub()
    with pytest.raises(InvalidTarget):
        client(api).read('c', 'history', 'a.py', cursor)
    assert api.calls() == []


def test_an_issue_reads_with_its_comments_then_more_comments_by_page() -> None:
    comment = {'id': 1, 'user': {'login': 'maintainer'}, 'created_at': '2026-11-01T00:00:00Z', 'body': 'Seen it.'}
    link = {'link': '<https://api.github.com/repositories/1/issues/42/comments?page=2>; rel="next"'}
    api = (FakeGitHub().on('GET', f'{REPO}/issues/42', answer(200, {'number': 42, 'title': 'Refund', 'state': 'open',
                                                                     'body': 'Wrong total', 'labels': []}))
           .on('GET', f'{REPO}/issues/42/comments?per_page=30&page=1', answer(200, [comment], link))
           .on('GET', f'{REPO}/issues/42/comments?per_page=30&page=2', answer(200, [])))
    host = client(api)
    first = host.read('c', 'issue', '42', None)
    assert json.loads(first.content) == {
        'issue': {'number': 42, 'title': 'Refund', 'state': 'open', 'body': 'Wrong total'},
        'comments': [{'id': 1, 'author': 'maintainer', 'created_at': '2026-11-01T00:00:00Z', 'body': 'Seen it.'}]}
    assert first.next_cursor == '2'
    second = host.read('c', 'issue', '42', '2')
    assert (json.loads(second.content), second.next_cursor) == ({'comments': []}, None)
    assert api.calls()[-1] == ('GET', f'{REPO}/issues/42/comments?per_page=30&page=2')


def test_a_pull_request_reads_with_its_conversation_review_comments_and_reviews() -> None:
    review_comment = {'id': 5, 'user': {'login': 'reviewer'}, 'created_at': '2026-11-02T00:00:00Z',
                      'body': 'Round here?', 'path': 'src/refund.py', 'line': 12, 'diff_hunk': '@@ -1 +1 @@'}
    review = {'id': 9, 'user': {'login': 'reviewer'}, 'state': 'CHANGES_REQUESTED',
              'submitted_at': '2026-11-02T00:01:00Z', 'body': 'One change.'}
    next_reviews = {'link': '<https://api.github.com/repositories/1/pulls/7/reviews?page=2>; rel="next"'}
    api = (FakeGitHub().on('GET', f'{REPO}/pulls/7', answer(200, {'number': 7, 'draft': True}))
           .on('GET', f'{REPO}/issues/7/comments?per_page=30&page=1', answer(200, {}))
           .on('GET', f'{REPO}/pulls/7/comments?per_page=30&page=1', answer(200, [review_comment]))
           .on('GET', f'{REPO}/pulls/7/reviews?per_page=30&page=1', answer(200, [review], next_reviews)))
    page = client(api).read('c', 'pull_request', '7', None)
    assert json.loads(page.content) == {
        'pull_request': {'number': 7, 'draft': True}, 'comments': [],
        'review_comments': [{'id': 5, 'author': 'reviewer', 'created_at': '2026-11-02T00:00:00Z',
                             'body': 'Round here?', 'path': 'src/refund.py', 'line': 12}],
        'reviews': [{'id': 9, 'author': 'reviewer', 'state': 'CHANGES_REQUESTED',
                     'submitted_at': '2026-11-02T00:01:00Z', 'body': 'One change.'}]}
    # The reviews have another page, so the pull request does.
    assert page.next_cursor == '2'


def test_a_missing_issue_is_not_found_and_a_target_that_is_not_a_number_is_refused() -> None:
    api = FakeGitHub().on('GET', f'{REPO}/issues/43', answer(404, {}))
    with pytest.raises(NotFound):
        client(api).read('c', 'issue', '43', None)
    with pytest.raises(InvalidTarget):
        client(api).read('c', 'pull_request', '7/merge', None)


SECONDARY = b'{"message": "You have exceeded a secondary rate limit. Please wait a few minutes."}'


@pytest.mark.parametrize(('status', 'headers', 'body', 'retry'), [
    (200, {'retry-after': '5'}, b'', None),
    (403, {}, b'{"message": "Resource not accessible by integration"}', None),
    (403, {'retry-after': '2'}, b'', 2),
    (403, {'retry-after': '0'}, b'', 1),
    (429, {'retry-after': '30'}, b'', 30),
    (403, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': str(int(NOW) + 4)}, b'', 4),
    (403, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': str(int(NOW) - 4)}, b'', 1),
    (403, {'x-ratelimit-remaining': '7', 'x-ratelimit-reset': str(int(NOW) + 4)}, b'', None),
    (429, {}, b'', 60),
    # A secondary rate limit: a 403 with no header to say how long, only its message.
    (403, {}, SECONDARY, 60),
])
def test_the_rate_limit_retry(status: int, headers: dict[str, str], body: bytes, retry: int | None) -> None:
    assert rate_limit_retry(Response(status, headers, body), NOW) == retry


@pytest.mark.parametrize(('reply', 'retry_after'), [
    (answer(429, {}, {'retry-after': '2'}), 2),
    (answer(403, {}, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': str(int(NOW) + 600)}), 600),
    (Response(403, {}, SECONDARY), 60),
])
def test_a_rate_limit_is_never_waited_out_but_answered_with_its_retry(reply: Response, retry_after: int) -> None:
    api = FakeGitHub().on('GET', f'{REPO}/contents/a.py', reply, Response(200, {}, b'x'))
    with pytest.raises(HostBusy) as caught:
        client(api).read('c', 'file', 'a.py', None)
    assert caught.value.retry_after == retry_after
    assert len(api.calls()) == 1   # asked once, not retried inside the call


def test_a_refusal_that_is_not_a_rate_limit_is_a_host_error_naming_the_status() -> None:
    api = FakeGitHub().on('POST', f'{REPO}/issues/42/comments', answer(403, {'message': 'Resource not accessible'}))
    with pytest.raises(HostError) as caught:
        client(api).post_comment('c', 'issue', 42, 'Noted.')
    assert not isinstance(caught.value, HostBusy)
    assert caught.value.reason == 'The repository host answered 403 to the comment.'


# --- comments and pull requests -------------------------------------------------------------------------------------


def test_a_comment_is_posted_on_the_issue() -> None:
    api = FakeGitHub().on('POST', f'{REPO}/issues/42/comments', answer(201, {'html_url': 'https://h/i/42#c1'}))
    assert client(api).post_comment('c', 'issue', 42, 'Bug: src/a.py:3.') == 'https://h/i/42#c1'
    assert api.sent[-1].body == {'body': 'Bug: src/a.py:3.'}


PR_HEAD = '9' * 40


def draftable(api: FakeGitHub, open_prs: list[object], tree: str = TREE, head: int = 200,
              pr_tree: str = TREE) -> FakeGitHub:
    """The branch at ``COMMIT`` (tree ``tree``), the open pull requests, and each pull request's head ``PR_HEAD``
    (tree ``pr_tree``) when the client checks it after the write."""
    query = f'state=open&head=example-org%3A{BRANCH.replace("/", "%2F")}&per_page=1'
    return (api.on('GET', f'{REPO}{QUOTED_REF}', answer(head, {'object': {'sha': COMMIT, 'type': 'commit'}}))
            .on('GET', f'{REPO}/git/commits/{COMMIT}', answer(200, {'tree': {'sha': tree}}))
            .on('GET', f'{REPO}/git/commits/{PR_HEAD}', answer(200, {'tree': {'sha': pr_tree}}))
            .on('GET', f'{REPO}/pulls?{query}', answer(200, open_prs))
            .on('POST', f'{REPO}/pulls', answer(201, {'number': 8, 'html_url': 'https://h/pull/8'}))
            .on('GET', f'{REPO}/pulls/8', answer(200, {'number': 8, 'head': {'sha': PR_HEAD}}))
            .on('GET', f'{REPO}/pulls/7', answer(200, {'number': 7, 'head': {'sha': PR_HEAD}}))
            .on('PATCH', f'{REPO}/pulls/8', answer(200, {'number': 8}))
            .on('PATCH', f'{REPO}/pulls/7', answer(200, {'number': 7})))


def writes(api: FakeGitHub) -> list[tuple[str, str, Any]]:
    return [(s.method, s.path, s.body) for s in api.sent if s.method != 'GET' and s.path != TOKENS]


def test_a_draft_pull_request_is_opened_when_the_branch_has_the_tree_and_checked_after() -> None:
    api = draftable(FakeGitHub(), open_prs=[])
    ref = client(api).open_or_update_draft_pr('c', BRANCH, 'main', 'Fix', 'From fb_01.', TREE)
    assert ref == PullRequestRef(number=8, url='https://h/pull/8')
    assert writes(api) == [('POST', f'{REPO}/pulls',
                            {'title': 'Fix', 'body': 'From fb_01.', 'head': BRANCH, 'base': 'main', 'draft': True})]
    assert api.calls()[-2:] == [('GET', f'{REPO}/pulls/8'), ('GET', f'{REPO}/git/commits/{PR_HEAD}')]


def test_an_open_pull_request_gets_its_text_updated_only() -> None:
    api = draftable(FakeGitHub(), open_prs=[{'number': 7, 'html_url': 'https://h/pull/7'}])
    ref = client(api).open_or_update_draft_pr('c', BRANCH, 'main', 'Fix', 'Body', TREE)
    assert ref == PullRequestRef(number=7, url='https://h/pull/7')
    assert writes(api) == [('PATCH', f'{REPO}/pulls/7', {'title': 'Fix', 'body': 'Body'})]


@pytest.mark.parametrize(('tree', 'head'), [('f' * 40, 200), (TREE, 404)])
def test_no_pull_request_unless_the_branch_head_has_the_tree(tree: str, head: int) -> None:
    api = draftable(FakeGitHub(), open_prs=[], tree=tree, head=head)
    with pytest.raises(Conflict):
        client(api).open_or_update_draft_pr('c', BRANCH, 'main', 'Fix', 'Body', TREE)
    assert writes(api) == []


def test_a_pull_request_opened_while_the_branch_moved_is_closed_and_its_outcome_unknown() -> None:
    api = draftable(FakeGitHub(), open_prs=[], pr_tree='e' * 40)
    with pytest.raises(OutcomeUnknown) as caught:
        client(api).open_or_update_draft_pr('c', BRANCH, 'main', 'Fix', 'Body', TREE)
    # The write went out: never a refusal (a Conflict says nothing was written), whatever the close did.
    assert not isinstance(caught.value, WriteRefused | HostBusy)
    assert 'moved' in caught.value.reason
    assert isinstance(caught.value.__cause__, Conflict)
    assert [w[:2] for w in writes(api)] == [('POST', f'{REPO}/pulls'), ('PATCH', f'{REPO}/pulls/8')]
    assert writes(api)[-1][2] == {'state': 'closed'}


@pytest.mark.parametrize(('check', 'cause'), [
    (answer(429, {}, {'retry-after': '7'}), HostBusy),   # a rate limit after the create: no longer "nothing written"
    (answer(500, {}), HostError),
    (answer(200, {'number': 8}), HostError),   # an answer without the head's sha
])
def test_a_pull_request_opened_whose_check_fails_is_closed_and_its_outcome_unknown(check: Response,
                                                                                  cause: type[Exception]) -> None:
    api = draftable(FakeGitHub(), open_prs=[]).on('GET', f'{REPO}/pulls/8', check)
    with pytest.raises(OutcomeUnknown) as caught:
        client(api).open_or_update_draft_pr('c', BRANCH, 'main', 'Fix', 'Body', TREE)
    assert (type(caught.value), isinstance(caught.value.__cause__, cause)) == (OutcomeUnknown, True)
    assert writes(api)[-1] == ('PATCH', f'{REPO}/pulls/8', {'state': 'closed'})


def test_a_close_that_fails_is_logged_by_number_and_the_outcome_still_unknown(
        caplog: pytest.LogCaptureFixture) -> None:
    api = draftable(FakeGitHub(), open_prs=[], pr_tree='e' * 40).on('PATCH', f'{REPO}/pulls/8', answer(500, {}))
    with pytest.raises(OutcomeUnknown):
        client(api).open_or_update_draft_pr('c', BRANCH, 'main', 'Secret title', 'Secret body', TREE)
    closes = [r for r in caplog.records if r.getMessage() == 'engineering pull request not closed']
    assert [vars(r)['pull_request'] for r in closes] == [8]
    assert 'Secret' not in repr([vars(r) for r in caplog.records])


def test_any_failure_of_the_close_still_raises_the_outcome_unknown(caplog: pytest.LogCaptureFixture,
                                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    host = client(draftable(FakeGitHub(), open_prs=[], pr_tree='e' * 40))
    real_api = host._api

    def api(connection_id: str, permissions: Mapping[str, str], method: str, path: str, what: str,
            **kwargs: Any) -> Response:
        if what == 'the pull request close':
            raise ValueError('a malformed answer')
        return real_api(connection_id, permissions, method, path, what, **kwargs)
    monkeypatch.setattr(host, '_api', api)
    with pytest.raises(OutcomeUnknown):
        host.open_or_update_draft_pr('c', BRANCH, 'main', 'Fix', 'Body', TREE)
    assert [vars(r)['pull_request'] for r in caplog.records
            if r.getMessage() == 'engineering pull request not closed'] == [8]


@pytest.mark.parametrize('check', [answer(200, {'number': 7, 'head': {'sha': PR_HEAD}}),   # (its tree moved)
                                   answer(429, {}, {'retry-after': '7'})], ids=['moved', 'rate-limited'])
def test_an_updated_pull_request_whose_check_fails_wrote_so_its_outcome_is_unknown_and_left_open(
        check: Response) -> None:
    api = draftable(FakeGitHub(), open_prs=[{'number': 7, 'html_url': 'https://h/pull/7'}], pr_tree='e' * 40)
    api.on('GET', f'{REPO}/pulls/7', check)
    with pytest.raises(OutcomeUnknown) as caught:
        client(api).open_or_update_draft_pr('c', BRANCH, 'main', 'Fix', 'Body', TREE)
    # The text was updated: never recorded as "refused, nothing written".
    assert 'updated' in caught.value.reason
    assert writes(api) == [('PATCH', f'{REPO}/pulls/7', {'title': 'Fix', 'body': 'Body'})]


@pytest.mark.parametrize('check', [answer(429, {}, {'retry-after': '7'}),
                                   answer(200, {'number': 8, 'head': {'sha': PR_HEAD}})], ids=['rate-limited', 'moved'])
def test_a_draft_whose_check_fails_after_the_create_is_unknown_and_its_repeat_opens_no_second_pull_request(
        check: Response) -> None:
    api = draftable(FakeGitHub(), open_prs=[], pr_tree='e' * 40).on('GET', f'{REPO}/pulls/8', check)
    claims = FakeWrites()
    broker = Broker(connector(host=client(api), writes=claims))
    author = Caller('pr-author', RUN, 4)
    for _ in range(2):
        with pytest.raises(OutcomeUnknown):
            broker.open_or_update_draft_pr(author, BRANCH, 'Fix the refund total', 'Rounds to cents (fb_01).')
    assert [w[:2] for w in writes(api)].count(('POST', f'{REPO}/pulls')) == 1
    assert [claim.state for claim in claims.claims.values()] == [WRITE_UNKNOWN]


def test_a_pull_request_lookup_answer_without_a_number_is_a_host_error() -> None:
    api = draftable(FakeGitHub(), open_prs=[{'number': True, 'html_url': 'https://h/pull/7'}])
    with pytest.raises(HostError):
        client(api).open_or_update_draft_pr('c', BRANCH, 'main', 'Fix', 'Body', TREE)


# --- the leased push ------------------------------------------------------------------------------------------------


def one_change(*changes: FileChange, tree_hash: str = TREE) -> BundleContents:
    """A one-commit bundle of ``changes`` (by default one text file), each of them listed in its changed paths."""
    commit = Commit(message='Fix the refund total', author=BOT, committer=BOT,
                    changes=changes or (FileChange('src/refund.py', '100644', b'total = 1\n'),))
    return replace(bundle_contents(), commits=(commit,), tree_hash=tree_hash,
                   changed_paths=tuple(c.path for c in commit.changes))


def pushable(api: FakeGitHub, head: str | None = BASE, built_tree: str = TREE, moved: int = 200,
             compare: str = 'behind', base: int = 200) -> FakeGitHub:
    ref = answer(404, {}) if head is None else answer(200, {'object': {'sha': head, 'type': 'commit'}})
    return (api.on('GET', f'{REPO}{QUOTED_REF}', ref)
            .on('GET', f'{REPO}/compare/main...{BASE}?per_page=1', answer(200, {'status': compare}))
            .on('GET', f'{REPO}/git/commits/{BASE}', answer(base, {'tree': {'sha': BASE_TREE}}))
            .on('POST', f'{REPO}/git/blobs', answer(201, {'sha': BLOB}))
            .on('POST', f'{REPO}/git/trees', answer(201, {'sha': built_tree}))
            .on('POST', f'{REPO}/git/commits', answer(201, {'sha': COMMIT}))
            .on('POST', f'{REPO}/git/refs', answer(201 if moved == 200 else moved, {}))
            .on('PATCH', f'{REPO}/git/refs/heads/{BRANCH}', answer(moved, {})))


def test_a_push_to_a_new_branch_starts_on_the_default_branch_and_creates_it() -> None:
    api = pushable(FakeGitHub(), head=None)
    client(api).push_bundle('c', BRANCH, one_change(), TREE, 'main')
    assert api.calls() == [('GET', f'{REPO}{QUOTED_REF}'), ('GET', f'{REPO}/compare/main...{BASE}?per_page=1'),
                           ('GET', f'{REPO}/git/commits/{BASE}'), ('POST', f'{REPO}/git/trees'),
                           ('POST', f'{REPO}/git/commits'), ('POST', f'{REPO}/git/refs')]
    tree, commit, ref = (s.body for s in api.sent[-3:])
    # A text file goes inline in the tree: no blob.
    assert tree == {'base_tree': BASE_TREE,
                    'tree': [{'path': 'src/refund.py', 'mode': '100644', 'type': 'blob', 'content': 'total = 1\n'}]}
    assert commit == {'message': 'Fix the refund total', 'tree': TREE, 'parents': [BASE]}
    assert ref == {'ref': f'refs/heads/{BRANCH}', 'sha': COMMIT}


@pytest.mark.parametrize('compare', ['identical', 'behind'])
def test_a_new_branch_may_start_on_the_default_branchs_head_or_an_ancestor(compare: str) -> None:
    api = pushable(FakeGitHub(), head=None, compare=compare)
    client(api).push_bundle('c', BRANCH, one_change(), TREE, 'main')
    assert api.calls()[-1] == ('POST', f'{REPO}/git/refs')


@pytest.mark.parametrize('compare', ['ahead', 'diverged'])
def test_a_new_branch_off_the_default_branch_is_refused(compare: str) -> None:
    api = pushable(FakeGitHub(), head=None, compare=compare)
    with pytest.raises(Conflict) as caught:
        client(api).push_bundle('c', BRANCH, one_change(), TREE, 'main')
    assert 'default branch' in caught.value.reason
    assert writes(api) == []


def test_a_new_branch_whose_base_the_host_cannot_compare_is_refused() -> None:
    api = pushable(FakeGitHub(), head=None).on('GET', f'{REPO}/compare/main...{BASE}?per_page=1', answer(404, {}))
    with pytest.raises(Conflict):
        client(api).push_bundle('c', BRANCH, one_change(), TREE, 'main')
    assert writes(api) == []


def test_a_base_the_host_does_not_have_is_a_refused_push() -> None:
    api = pushable(FakeGitHub(), base=404)
    with pytest.raises(Conflict) as caught:
        client(api).push_bundle('c', BRANCH, one_change(), TREE, 'main')
    assert "bundle's base" in caught.value.reason
    assert writes(api) == []


def test_a_push_to_the_branch_moves_it_without_force_from_the_expected_head() -> None:
    api = pushable(FakeGitHub())
    deleted = FileChange('src/old.py', '100644', None)
    client(api).push_bundle('c', BRANCH, one_change(deleted), TREE, 'main')
    assert ('GET', f'{REPO}/compare/main...{BASE}?per_page=1') not in api.calls()   # the lease is the head
    assert api.sent[-3].body['tree'] == [{'path': 'src/old.py', 'mode': '100644', 'type': 'blob', 'sha': None}]
    assert (api.sent[-1].method, api.sent[-1].path, api.sent[-1].body) == (
        'PATCH', f'{REPO}/git/refs/heads/{BRANCH}', {'sha': COMMIT, 'force': False})


def test_a_binary_file_is_pushed_as_a_blob() -> None:
    api = pushable(FakeGitHub())
    client(api).push_bundle('c', BRANCH, one_change(FileChange('img/logo.png', '100644', b'\x89PNG\xff')), TREE, 'main')
    blob, tree = (s.body for s in api.sent if s.path in {f'{REPO}/git/blobs', f'{REPO}/git/trees'})
    assert blob == {'content': base64.b64encode(b'\x89PNG\xff').decode(), 'encoding': 'base64'}
    assert tree['tree'] == [{'path': 'img/logo.png', 'mode': '100644', 'type': 'blob', 'sha': BLOB}]


def test_a_commit_that_changes_nothing_keeps_its_parents_tree() -> None:
    api = pushable(FakeGitHub(), head=None)
    empty = Commit(message='Record the run', author=BOT, committer=BOT)
    client(api).push_bundle('c', BRANCH, replace(one_change(tree_hash=BASE_TREE), commits=(empty,)), BASE_TREE, 'main')
    assert ('POST', f'{REPO}/git/trees') not in api.calls()
    assert api.sent[-2].body == {'message': 'Record the run', 'tree': BASE_TREE, 'parents': [BASE]}


def test_refuses_a_bundle_whose_tree_is_not_the_checked_one_before_any_request() -> None:
    api = pushable(FakeGitHub())
    with pytest.raises(Conflict):
        client(api).push_bundle('c', BRANCH, one_change(tree_hash='f' * 40), TREE, 'main')
    assert api.sent == []


def test_refuses_a_bundle_with_no_commit() -> None:
    api = pushable(FakeGitHub())
    with pytest.raises(WriteRefused):
        client(api).push_bundle('c', BRANCH, replace(one_change(), commits=()), TREE, 'main')
    assert api.sent == []


def test_refuses_a_commit_that_changes_a_path_the_rules_did_not_check() -> None:
    # An earlier commit touches the CI workflow and a later one reverts it: the final tree alone would not show it.
    sneaky = Commit(message='Tweak CI', author=BOT, committer=BOT,
                    changes=(FileChange('.github/workflows/ci.yml', '100644', b'on: push\n'),))
    contents = one_change()
    contents = replace(contents, commits=(sneaky, *contents.commits))
    api = pushable(FakeGitHub())
    with pytest.raises(WriteRefused) as caught:
        client(api).push_bundle('c', BRANCH, contents, TREE, 'main')
    assert '.github/workflows/ci.yml' in caught.value.reason
    assert api.sent == []


def test_refuses_when_the_branch_moved_since_the_bundle_was_made() -> None:
    api = pushable(FakeGitHub(), head='d' * 40)
    with pytest.raises(Conflict) as caught:
        client(api).push_bundle('c', BRANCH, one_change(), TREE, 'main')
    assert 'moved' in caught.value.reason
    assert api.calls() == [('GET', f'{REPO}{QUOTED_REF}')]


def test_refuses_when_the_rebuilt_tree_is_not_the_checked_one_and_leaves_the_branch() -> None:
    api = pushable(FakeGitHub(), built_tree='e' * 40)
    with pytest.raises(Conflict):
        client(api).push_bundle('c', BRANCH, one_change(), TREE, 'main')
    assert [c for c in api.calls() if 'refs' in c[1] and c[0] != 'GET'] == []


@pytest.mark.parametrize('head', [BASE, None])
def test_the_lease_refuses_a_branch_changed_during_the_push(head: str | None) -> None:
    api = pushable(FakeGitHub(), head=head, moved=422)
    with pytest.raises(Conflict) as caught:
        client(api).push_bundle('c', BRANCH, one_change(), TREE, 'main')
    assert 'changed while' in caught.value.reason


def test_refuses_a_file_mode_that_is_not_a_file_or_a_link_before_any_request() -> None:
    api = pushable(FakeGitHub())
    with pytest.raises(WriteRefused) as caught:
        client(api).push_bundle('c', BRANCH, one_change(FileChange('vendor/lib', '160000', b'')), TREE, 'main')
    assert caught.value.reason == 'A pushed file must be a regular file, an executable or a symbolic link (vendor/lib).'
    assert api.sent == []


# --- secrecy --------------------------------------------------------------------------------------------------------


def test_no_token_or_jwt_is_ever_in_a_url_or_a_log_line(caplog: pytest.LogCaptureFixture) -> None:
    api = every_route(pushable(draftable(FakeGitHub(), open_prs=[]), head=None))
    host = client(api)
    host.read('c', 'file', 'a.py', None)
    host.read('c', 'issue', '42', None)
    host.post_comment('c', 'issue', 42, 'Noted.')
    host.push_bundle('c', BRANCH, one_change(), TREE, 'main')
    api.on('GET', f'{REPO}{QUOTED_REF}', answer(200, {'object': {'sha': COMMIT, 'type': 'commit'}}))
    host.open_or_update_draft_pr('c', BRANCH, 'main', 'Fix', 'Body', TREE)
    secrets = [s.headers['Authorization'].removeprefix('Bearer ') for s in api.sent]
    assert len(set(secrets)) >= 5
    for secret in secrets:
        assert all(secret not in s.path for s in api.sent)
        assert all(secret not in json.dumps(s.body) for s in api.sent)
        assert secret not in repr([vars(r) for r in caplog.records])


def test_the_client_has_no_merge_approve_settings_or_revoke_method() -> None:
    public = {name for name in dir(GitHubHost) if not name.startswith('_')}
    # Reads (a patch's base file, the default branch) and the three writes: nothing else.
    assert public == {'read', 'file_at', 'default_branch', 'post_comment', 'branch_tree_hash', 'push_bundle',
                      'open_or_update_draft_pr'}


def test_a_base_file_is_read_raw_at_its_commit_and_a_missing_one_is_none() -> None:
    commit = 'a' * 40
    api = (FakeGitHub()
           .on('GET', f'{REPO}/contents/src/refund.py?ref={commit}',
               Response(status=200, headers={}, body=b'\x00binary and text\n'))
           .on('GET', f'{REPO}/contents/src/gone.py?ref={commit}', answer(404, {})))
    host = client(api)
    assert host.file_at('c', commit, 'src/refund.py') == b'\x00binary and text\n'
    assert host.file_at('c', commit, 'src/gone.py') is None
    assert api.sent[-1].headers['Accept'] == 'application/vnd.github.raw+json'
    assert api.scopes()[0]['permissions'] == {'contents': 'read'}


@pytest.mark.parametrize(('commit', 'path'), [('main', 'a.py'), ('a' * 39, 'a.py'), ('a' * 40, '../a.py'),
                                              ('a' * 40, 'src//a.py')])
def test_a_base_file_read_takes_only_a_full_commit_and_a_path_inside(commit: str, path: str) -> None:
    api = FakeGitHub()
    with pytest.raises(InvalidTarget):
        client(api).file_at('c', commit, path)
    assert api.calls() == []


def test_the_default_branch_is_read_with_metadata_only_and_kept_five_minutes() -> None:
    api = FakeGitHub().on('GET', REPO, answer(200, {'default_branch': 'trunk'}), answer(200, {'default_branch': 'main'}))
    clock = Clock()
    host = client(api, clock)
    assert (host.default_branch('c'), host.default_branch('c')) == ('trunk', 'trunk')
    assert api.calls() == [('GET', REPO)]
    assert api.scopes()[0]['permissions'] == {'metadata': 'read'}
    clock.now += github.DEFAULT_BRANCH_SECONDS
    assert host.default_branch('c') == 'main'


# --- the HTTPS transport --------------------------------------------------------------------------------------------


@dataclass
class FakeAnswer:
    status: int = 200
    body: bytes = b'{}'

    def read(self, amt: int) -> bytes:
        return self.body[:amt]

    def getheaders(self) -> list[tuple[str, str]]:
        return [('Retry-After', '3'), ('Content-Type', 'application/json')]


@dataclass
class FakeConnection:
    host: str
    timeout: float
    context: object
    reply: FakeAnswer | Exception
    send_fails: bool = False
    sent: list[tuple[str, str, bytes | None, dict[str, str]]] = field(default_factory=list)
    closed: bool = False

    def request(self, method: str, url: str, body: bytes | None, headers: Mapping[str, str]) -> None:
        if self.send_fails:
            raise OSError('connection refused')
        self.sent.append((method, url, body, dict(headers)))

    def getresponse(self) -> FakeAnswer:
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply

    def close(self) -> None:
        self.closed = True


def transport(reply: FakeAnswer | Exception, *, send_fails: bool = False) -> tuple[HttpsTransport, list[FakeConnection]]:
    made: list[FakeConnection] = []

    def connect(host: str, timeout: float, context: object) -> FakeConnection:
        made.append(FakeConnection(host, timeout, context, reply, send_fails))
        return made[-1]
    return HttpsTransport(connect=connect), made


def test_the_transport_talks_only_to_the_api_host_and_lower_cases_headers() -> None:
    https, made = transport(FakeAnswer(201, b'{"a": 1}'))
    response = https.request('POST', '/x', {'Accept': 'j'}, b'{}')
    assert response == Response(201, {'retry-after': '3', 'content-type': 'application/json'}, b'{"a": 1}')
    assert (made[0].host, made[0].sent, made[0].closed) == (API_HOST, [('POST', '/x', b'{}', {'Accept': 'j'})], True)


def test_the_transport_reads_no_more_than_it_answers() -> None:
    https, made = transport(FakeAnswer(200, b'x' * (MAX_RESPONSE_BYTES + 1)))
    with pytest.raises(HostError):
        https.request('GET', '/x', {}, None)
    assert made[0].closed


@pytest.mark.parametrize('failure', [OSError('reset'), http.client.RemoteDisconnected('gone')])
def test_an_unreachable_host_is_retryable(failure: Exception) -> None:
    https, made = transport(failure)
    with pytest.raises(HostBusy):
        https.request('GET', '/x', {}, None)
    assert made[0].closed


@pytest.mark.parametrize('method', ['POST', 'PATCH', 'DELETE'])
def test_a_lost_answer_to_a_write_is_not_retryable(method: str) -> None:
    https, made = transport(http.client.RemoteDisconnected('gone'))
    with pytest.raises(HostError, match='may have happened'):
        https.request(method, '/x', {}, b'{}')
    assert made[0].closed


def test_a_lost_answer_to_a_token_request_is_retryable() -> None:
    https, made = transport(http.client.RemoteDisconnected('gone'))
    with pytest.raises(HostBusy):
        https.request('POST', '/app/installations/42/access_tokens', {}, b'{}')
    assert made[0].closed


def test_a_write_that_never_left_is_retryable() -> None:
    https, made = transport(FakeAnswer(201, b'{}'), send_fails=True)
    with pytest.raises(HostBusy):
        https.request('POST', '/x', {}, b'{}')
    assert (made[0].sent, made[0].closed) == ([], True)


def test_the_default_transport_is_https() -> None:
    assert isinstance(GitHubHost(lambda _: credential())._transport, HttpsTransport)
    assert github.HttpsTransport()._connect is http.client.HTTPSConnection
