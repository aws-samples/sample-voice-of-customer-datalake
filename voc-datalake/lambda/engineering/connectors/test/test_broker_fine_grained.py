"""The broker on a fine-grained connection (7.60.00, broker.py, github.py): the token makes the run's push and pull
request alone, after every gate and its owner's own go, in every way of working; comments, labels, the docs and the
upstream pull request are refused; an expired or unset token is refused, failing closed; and, through a recording
transport, the token travels only on the repository's Git Data and pull request writes, the App's read-only token on
everything else."""
from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from datetime import date

import pytest

from engineering.connectors import broker as broker_module
from engineering.connectors import handler
from engineering.connectors.broker import (
    HUMAN_DRIVEN_REFUSAL,
    MERGE_IS_HUMAN,
    Broker,
    FineGrainedRefused,
    token_disclosure,
)
from engineering.connectors.fine_grained import WriteToken
from engineering.connectors.github import NO_APP_WRITES, NOT_ITS_CREDENTIAL, GitHubHost, TokenCannotWrite
from engineering.connectors.hosts import FINE_GRAINED, WRITE_DONE, WRITE_REFUSED, NoConnection
from engineering.connectors.identity import LABEL_ISSUE, OPEN_UPSTREAM_PR, POST_COMMENT, PUSH_APPROVED_DOCS, Caller
from engineering.connectors.test.app_keys import credential
from engineering.connectors.test.fakes import (
    BRANCH,
    REPOSITORY,
    RUN,
    TREE,
    FakeBundles,
    FakeDial,
    FakeLedger,
    FakeWrites,
    connector,
)
from engineering.connectors.test.test_github import (
    REPO,
    TOKENS,
    Clock,
    FakeGitHub,
    answer,
    draftable,
    one_change,
    pushable,
    ruled,
)
from engineering.connectors.test.upstream_fakes import FakeUpstream
from engineering.connectors.write_policy import WriteRefused
from shared.digests import sha256_hex

PAT = 'github_pat_11ABCDEFG0' + 'y' * 40
#: The administrator who saved the token (its owner), and another one.
OWNER = 'person-sub-9'
OTHER = 'person-sub-2'
TODAY = date(2026, 11, 20)
COMMITTER = Caller('committer', RUN, 3)
AUTHOR = Caller('pr-author', RUN, 4)


#: The connection's write token, as its parameter holds it: the owner's, unexpired.
STORED = WriteToken(repository=REPOSITORY, login='casey-dev', expires_at='2026-12-31', owner=sha256_hex(OWNER),
                    token=PAT)


@dataclass
class FakeTokens:
    """The write tokens' reader: one token, or none (``NoConnection``); the connections it was asked for."""

    token_: WriteToken | None = STORED
    asked: list[str] = field(default_factory=list)

    def token(self, connection_id: str) -> WriteToken:
        self.asked.append(connection_id)
        if self.token_ is None:
            raise NoConnection('no token')
        return self.token_


def fine_grained_host(api: FakeGitHub) -> GitHubHost:
    return GitHubHost(lambda _: replace(credential(), kind=FINE_GRAINED), api, clock=Clock())


def fine_grained_broker(api: FakeGitHub, *, tokens: FakeTokens | None = None, by: str = OWNER, mode: str = 'ai_driven',
                        writes: FakeWrites | None = None, today: date = TODAY, wired: bool = True) -> Broker:
    """A broker over the real GitHub client on a fine-grained connection: the run's final go GO for ``TREE``, its go
    given by ``by`` ('' for none), its starter working ``mode``; ``wired``: the deployment names the token path."""
    host = fine_grained_host(api.on('GET', REPO, answer(200, {'default_branch': 'main'})))
    base = connector(host=host, bundles=FakeBundles(one_change()), writes=writes,
                     ledger=FakeLedger({(RUN, TREE)}, by={RUN: by} if by else {}),
                     dial=FakeDial({'person-sub-1': mode}))
    reader = (tokens if tokens is not None else FakeTokens()) if wired else None
    return Broker(replace(base, upstream=FakeUpstream(kind_=FINE_GRAINED), write_tokens=reader, token_writes=host),
                  today=lambda: today)


def authorizations(api: FakeGitHub) -> dict[tuple[str, str], str]:
    """Each request but the App token's mint, and the credential it carried (the token, or the App's)."""
    return {(s.method, s.path): 'pat' if s.headers['Authorization'] == f'Bearer {PAT}' else 'app'
            for s in api.sent if s.path != TOKENS}


def push(broker: Broker) -> str:
    return broker.push_bundle(COMMITTER, BRANCH, 'patch-key', TREE, 'Fix the refund total')


# --- the token's writes, and nothing else ---------------------------------------------------------------------------


def test_a_push_carries_the_token_only_on_the_git_data_writes_and_the_app_s_read_only_token_elsewhere() -> None:
    api = ruled(pushable(FakeGitHub(), head=None))
    claims = FakeWrites()
    assert push(fine_grained_broker(api, writes=claims)) == TREE
    sent = authorizations(api)
    assert {key for key, by in sent.items() if by == 'pat'} == {
        ('POST', f'{REPO}/git/trees'), ('POST', f'{REPO}/git/commits'), ('POST', f'{REPO}/git/refs')}
    assert all(method == 'GET' for (method, _), by in sent.items() if by == 'app')
    # (every App token on this kind: metadata read alone, naming no repository: it writes nothing anywhere)
    assert {json.dumps(scope, sort_keys=True) for scope in api.scopes()} == {'{"permissions": {"metadata": "read"}}'}
    done = next(iter(claims.claims.values()))
    assert (done.state, (done.result or {}).get('with')) == (
        WRITE_DONE, {'credential': 'fine_grained_token', 'login': 'casey-dev', 'expires_at': '2026-12-31'})
    assert PAT not in json.dumps([claim.result for claim in claims.claims.values()])


def test_a_pull_request_carries_the_token_only_on_its_write_and_says_whose_token_and_whose_go() -> None:
    api = ruled(draftable(FakeGitHub(), open_prs=[]))
    ref = fine_grained_broker(api).open_or_update_draft_pr(AUTHOR, BRANCH, 'Fix the refund total', 'Rounds to cents.')
    assert ref.number == 8
    sent = authorizations(api)
    assert {key for key, by in sent.items() if by == 'pat'} == {('POST', f'{REPO}/pulls')}
    body = next(s.body for s in api.sent if (s.method, s.path) == ('POST', f'{REPO}/pulls'))['body']
    assert "Pushed with casey-dev's fine-grained token, after casey-dev's own go on the run." in body
    assert body.rstrip().endswith(MERGE_IS_HUMAN)


def test_the_disclosure_is_added_once() -> None:
    once = token_disclosure('Rounds to cents.', 'casey-dev')
    assert token_disclosure(once, 'casey-dev') == once


@pytest.mark.parametrize('mode', ['ai_driven', 'ai_assisted'])
def test_a_push_waits_for_the_token_owner_s_own_go_in_every_way_of_working(mode: str) -> None:
    for by in ('', OTHER):
        api = ruled(pushable(FakeGitHub(), head=None))
        with pytest.raises(FineGrainedRefused) as caught:
            push(fine_grained_broker(api, by=by, mode=mode))
        assert (caught.value.code, 'casey-dev' in caught.value.reason) == ('token_owner_go', True)
        assert [s for s in api.sent if s.method != 'GET' and s.path != TOKENS] == []
    api = ruled(pushable(FakeGitHub(), head=None))
    assert push(fine_grained_broker(api, mode=mode)) == TREE


@pytest.mark.parametrize('mode', ['human_driven', '', 'something_else'])
def test_human_driven_or_nothing_stored_pushes_nothing_even_with_the_owner_s_go(mode: str) -> None:
    api = ruled(pushable(FakeGitHub(), head=None))
    with pytest.raises(WriteRefused) as caught:
        push(fine_grained_broker(api, mode=mode))
    assert caught.value.reason == HUMAN_DRIVEN_REFUSAL


@pytest.mark.parametrize('expires', ['2026-11-20', '2026-10-01', 'not-a-day'])
def test_an_expired_token_is_refused_after_the_go_and_before_any_write(expires: str) -> None:
    tokens = FakeTokens(replace(STORED, expires_at=expires))
    api = ruled(pushable(FakeGitHub(), head=None))
    with pytest.raises(FineGrainedRefused) as caught:
        push(fine_grained_broker(api, tokens=tokens))
    assert caught.value.code == 'token_expired'
    assert [s.method for s in api.sent if s.method != 'GET' and s.path != TOKENS] == []


def test_a_token_not_stored_is_refused_and_no_token_reader_is_no_connection() -> None:
    api = ruled(pushable(FakeGitHub(), head=None))
    with pytest.raises(FineGrainedRefused) as caught:
        push(fine_grained_broker(api, tokens=FakeTokens(None)))
    assert caught.value.code == 'token_not_set'
    with pytest.raises(NoConnection):
        push(fine_grained_broker(ruled(pushable(FakeGitHub(), head=None)), wired=False))


def test_a_token_for_another_repository_is_refused() -> None:
    other = FakeTokens(replace(STORED, repository='other-org/x'))
    with pytest.raises(WriteRefused, match='another repository'):
        push(fine_grained_broker(ruled(pushable(FakeGitHub(), head=None)), tokens=other))


def test_github_s_403_to_the_token_s_write_stops_the_step_and_moves_nothing() -> None:
    api = ruled(pushable(FakeGitHub(), head=None)).on('POST', f'{REPO}/git/trees', answer(403, {}))
    claims = FakeWrites()
    with pytest.raises(TokenCannotWrite) as caught:
        push(fine_grained_broker(api, writes=claims))
    assert caught.value.code == 'token_cannot_write'
    assert ('POST', f'{REPO}/git/refs') not in authorizations(api)
    assert [claim.state for claim in claims.claims.values()] == [WRITE_REFUSED]
    answered = handler._refusal(caught.value)
    assert (answered['statusCode'], json.loads(answered['body'])['code']) == (409, 'token_cannot_write')


# --- what the token never does ---------------------------------------------------------------------------------------


def test_a_comment_a_label_and_the_upstream_pull_request_are_refused_before_any_token() -> None:
    api = FakeGitHub()
    broker = fine_grained_broker(api)
    refusals = []
    for attempt in (lambda: broker.post_comment(Caller('understander', RUN, 1), 'issue', 42, 'Triage'),
                    lambda: broker.post_comment(Caller('pr-reviewer', RUN, 2), 'pull_request', 7, 'Looks good'),
                    lambda: broker.label_issue(Caller('understander', RUN, 1), 42, ('voc-triage/bug',)),
                    lambda: broker.open_upstream_pr(AUTHOR, BRANCH)):
        with pytest.raises(FineGrainedRefused) as caught:
            attempt()
        refusals.append(caught.value.code)
    assert refusals == ['token_scope'] * 4
    assert [s.method for s in api.sent if s.method != 'GET'] == []


@pytest.mark.parametrize('operation', [POST_COMMENT, LABEL_ISSUE, PUSH_APPROVED_DOCS, OPEN_UPSTREAM_PR])
def test_the_docs_and_issue_writes_are_out_of_the_token_s_scope(operation: str) -> None:
    with pytest.raises(FineGrainedRefused) as caught:
        broker_module._require_kind(FINE_GRAINED, operation)
    answered = handler._refusal(caught.value)
    assert (answered['statusCode'], json.loads(answered['body'])['code']) == (409, 'token_scope')


def test_the_app_s_token_on_this_kind_reads_only_so_the_token_never_comes_out_of_it() -> None:
    api = FakeGitHub()
    host = fine_grained_host(api)
    for write in (lambda: host.push_bundle('c', BRANCH, one_change(), TREE, 'main'),
                  lambda: host.open_or_update_draft_pr('c', BRANCH, 'main', 'Fix', 'Body', TREE),
                  lambda: host.post_comment('c', 'issue', 42, 'Hi'),
                  lambda: host.label_issue('c', 42, ('voc-triage/bug',))):
        with pytest.raises(WriteRefused) as caught:
            write()
        assert caught.value.reason == NO_APP_WRITES
    assert [s.method for s in api.sent if s.method != 'GET' and s.path != TOKENS] == []
    assert all(scope == {'permissions': {'metadata': 'read'}} for scope in api.scopes())


def test_a_token_write_on_any_other_connection_is_refused_before_any_request() -> None:
    api = FakeGitHub()
    host = GitHubHost(lambda _: credential(), api, clock=Clock())
    with pytest.raises(WriteRefused) as caught:
        host.push_bundle_as('c', BRANCH, one_change(), TREE, 'main', PAT)
    assert caught.value.reason == NOT_ITS_CREDENTIAL
    with pytest.raises(WriteRefused):
        host.open_or_update_pr_as('c', BRANCH, 'main', 'Fix', 'Body', TREE, PAT)
    assert api.sent == []


# --- the router: the token's writes are GitHub's alone -------------------------------------------------------------


def test_the_router_hands_the_token_writes_to_github_and_refuses_them_on_a_gitlab_credential() -> None:
    from engineering.connectors.gitlab import GitLabHost
    from engineering.connectors.router import HostRouter
    from engineering.connectors.test.gitlab_fakes import FakeGitLab
    from engineering.connectors.test.gitlab_fakes import credential as gitlab_credential

    stored = {'gh': replace(credential(), kind=FINE_GRAINED), 'gl': gitlab_credential()}
    gitlab = GitLabHost(lambda _c: gitlab_credential(), FakeGitLab())
    pushed, opened = pushable(FakeGitHub(), head=None), draftable(FakeGitHub(), open_prs=[])
    HostRouter(stored.__getitem__, fine_grained_host(pushed), gitlab).push_bundle_as('gh', BRANCH, one_change(), TREE,
                                                                                     'main', PAT)
    router = HostRouter(stored.__getitem__, fine_grained_host(opened), gitlab)
    assert router.open_or_update_pr_as('gh', BRANCH, 'main', 'Fix', 'Body', TREE, PAT, draft=False).number == 8
    assert ('POST', f'{REPO}/git/refs') in {key for key, by in authorizations(pushed).items() if by == 'pat'}
    assert {key for key, by in authorizations(opened).items() if by == 'pat'} == {('POST', f'{REPO}/pulls')}
    for write in (lambda: router.push_bundle_as('gl', BRANCH, one_change(), TREE, 'main', PAT),
                  lambda: router.open_or_update_pr_as('gl', BRANCH, 'main', 'Fix', 'Body', TREE, PAT)):
        with pytest.raises(NoConnection):
            write()
