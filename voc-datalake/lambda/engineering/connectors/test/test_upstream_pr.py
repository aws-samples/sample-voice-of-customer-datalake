"""Any public repository (7.57.00): the broker refuses every write on a public repository read only (fail closed, any
role, any operation); on a fork its PR author's pull request goes on to the upstream's: once the safety checks pass
(the GO, the upstream's state, the licence, DCO, an issue first), the run always gets the one-click link to GitHub's
compare page, and the app opens it as the connection owner only as the optional extra (the dial, the owner's
authorization, the caps); GitHub refusing the app (403) leaves the link, never an error (upstream_pr.py)."""
from __future__ import annotations

from dataclasses import replace
from urllib.parse import parse_qs, urlsplit

import pytest

from engineering.connectors.broker import FORK_ISSUE, READ_ONLY, Broker, NotNow, NotPermitted
from engineering.connectors.hosts import PUBLIC_READ, REPOSITORY_KIND, ForkPullRequest, PullRequestRef, UpstreamRecord
from engineering.connectors.identity import Caller
from engineering.connectors.test.fakes import (
    BRANCH,
    RUN,
    STARTER,
    TREE,
    FakeDial,
    FakeHost,
    FakeLedger,
    FakeRuns,
    FakeWrites,
    connector,
    record,
)
from engineering.connectors.test.upstream_fakes import (
    LOGIN,
    OWNER_CREDENTIAL,
    UPSTREAM,
    FakeOwnerTokens,
    FakeUpstream,
    FakeUpstreamLedger,
    fork_connector,
    upstream_facts,
)
from engineering.connectors.upstream import DISCLOSURE, ContributingAsks
from engineering.connectors.upstream_pr import (
    ASSISTED,
    ASSISTED_NO_GO,
    GITHUB_REFUSED,
    HUMAN,
    NO_GO,
    NOT_A_FORK,
    NOT_AUTHORIZED,
)
from engineering.connectors.write_policy import WriteRefused

TITLE, BODY = 'Fix the refund total', 'Rounds the total to cents.'
#: The fork's account (fakes.REPOSITORY's owner): whose pull request it is.
FORK_OWNER = 'example-org'
COMPARE = f'https://github.com/{UPSTREAM}/compare/main...example-org:refund-service:{BRANCH}'


def caller(role: str) -> Caller:
    return Caller(role=role, run_id=RUN, agent_index=1)


def _writes(broker: Broker, role: str) -> None:
    """The write ``role`` makes (its one operation)."""
    if role == 'understander':
        broker.label_issue(caller(role), 42, ('voc-triage/bug',))
    elif role == 'pr-reviewer':
        broker.post_comment(caller(role), 'pull_request', 7, 'Looks right.')
    elif role == 'committer':
        broker.push_bundle(caller(role), BRANCH, 'ws/default/runs/x.diff', TREE, 'Fix')
    else:
        broker.open_or_update_draft_pr(caller(role), BRANCH, TITLE, BODY)


# --- a public repository read only ------------------------------------------------------------------------------------


@pytest.mark.parametrize('role', ['understander', 'pr-reviewer', 'committer', 'pr-author'])
def test_a_public_repository_read_only_refuses_every_write_before_any_host_call(role: str) -> None:
    host = FakeHost()
    broker = Broker(replace(connector(host=host), upstream=FakeUpstream(kind_=PUBLIC_READ)))
    with pytest.raises(NotNow, match='read only'):
        _writes(broker, role)
    assert host.writes() == []
    assert not any(call[0] == 'branch_tree_hash' for call in host.calls)   # (refused before the host is asked)


def test_a_public_repository_read_only_refuses_the_issue_comment_and_the_upstream_pull_request_too() -> None:
    host = FakeHost()
    broker = Broker(replace(connector(host=host), upstream=FakeUpstream(kind_=PUBLIC_READ)))
    with pytest.raises(NotNow) as refused:
        broker.post_comment(caller('understander'), 'issue', 42, 'Triage: a bug.')
    assert refused.value.reason == READ_ONLY
    with pytest.raises(NotNow):
        broker.open_upstream_pr(caller('pr-author'), BRANCH)
    assert host.writes() == []


def test_a_public_repository_read_only_is_still_read() -> None:
    host = FakeHost()
    broker = Broker(replace(connector(host=host), upstream=FakeUpstream(kind_=PUBLIC_READ)))
    broker.read(caller('hunter'), 'file', 'src/refund.py', None)
    assert [call[0] for call in host.calls] == ['read']


@pytest.mark.parametrize('kind', ['mystery', ''])
def test_a_kind_the_broker_does_not_know_refuses_every_write(kind: str) -> None:
    host = FakeHost()
    broker = Broker(replace(connector(host=host), upstream=FakeUpstream(kind_=kind)))
    with pytest.raises(NotNow, match='read only'):
        broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, TITLE, BODY)
    assert host.writes() == []


class _NoDocs:
    """Approved docs never read: the kind refuses first."""

    def approved(self, connection_id: str, kind: str) -> object:
        raise AssertionError(f'{connection_id} {kind} read')

    def accepted_tenets(self, connection_id: str) -> dict[str, object] | None:
        raise AssertionError(f'{connection_id} read')


def test_the_docs_pull_request_is_refused_on_a_public_repository() -> None:
    from engineering.connectors.broker import DocsRequest
    from engineering.connectors.identity import START_ROLE

    host = FakeHost()
    broker = Broker(replace(connector(host=host), upstream=FakeUpstream(kind_=PUBLIC_READ), docs=_NoDocs(),
                            docs_writes=FakeWrites()))
    request = DocsRequest(connection='conn-1', repository='example-org/refund-service', default_branch='main',
                          kind='knowledge', digest='0' * 64, requested_by=STARTER)
    with pytest.raises(NotNow, match='read only'):
        broker.push_approved_docs(Caller(role=START_ROLE, run_id='', agent_index=0), request)
    assert host.writes() == []


# --- a fork: its issue is the upstream's --------------------------------------------------------------------------


def test_on_a_fork_the_upstreams_issue_gets_no_comment_and_no_label() -> None:
    host = FakeHost()
    broker = Broker(fork_connector(host=host))
    with pytest.raises(NotNow) as refused:
        broker.post_comment(caller('understander'), 'issue', 42, 'Triage: a bug.')
    assert refused.value.reason == FORK_ISSUE
    with pytest.raises(NotNow):
        broker.label_issue(caller('understander'), 42, ('voc-triage/bug',))
    broker.post_comment(caller('pr-reviewer'), 'pull_request', 7, 'Looks right.')   # (the fork's own pull request)
    assert host.writes() == ['post_comment']


# --- the upstream pull request: opened for you ---------------------------------------------------------------------


def test_with_the_owners_authorization_the_app_opens_it_as_them() -> None:
    host, upstream, tokens, ledger = FakeHost(), FakeUpstream(), FakeOwnerTokens(), FakeUpstreamLedger()
    broker = Broker(fork_connector(upstream, tokens, ledger, host=host))
    ref = broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, TITLE, BODY)
    fork_body = next(call[5] for call in host.calls if call[0] == 'open_or_update_draft_pr')
    assert '#42' not in str(fork_body)   # (the fork's pull request names no issue: the upstream's does)
    [(token, branch, title, body)] = upstream.opened
    assert (token, branch, title) == (OWNER_CREDENTIAL, BRANCH, TITLE)
    assert body.startswith('## Description\n\nRounds the total to cents.')   # (the template filled, its comment out)
    assert '<!--' not in body
    assert '- [ ] tests' in body
    assert 'Fixes #42' in body
    assert 'CONTRIBUTING.md' in body
    assert body.endswith(DISCLOSURE.format(login=FORK_OWNER))
    assert 'Only a person approves and merges' not in body   # (the fork's own closing line stays on the fork)
    assert ref.upstream is not None
    assert {name: ref.upstream[name] for name in ('state', 'number', 'url', 'as')} == {
        'state': 'opened', 'number': 314, 'url': f'https://github.com/{UPSTREAM}/pull/314', 'as': LOGIN}
    assert ledger.records[RUN].state == 'opened'
    assert ledger.slots
    assert ledger.closed[0] == {'state': 'done', 'number': 314, 'url': f'https://github.com/{UPSTREAM}/pull/314',
                                'as': LOGIN}   # (the audit: who it was opened as)


def test_only_the_pr_author_opens_the_upstream_pull_request() -> None:
    upstream = FakeUpstream()
    broker = Broker(fork_connector(upstream))
    for role in ('committer', 'understander', 'pr-reviewer', 'final-go', 'coordinator', 'fixer', 'runtime', 'start'):
        with pytest.raises(NotPermitted):
            broker.open_upstream_pr(caller(role), BRANCH)
    assert upstream.opened == []
    assert broker.open_upstream_pr(caller('pr-author'), BRANCH)['state'] == 'opened'


def test_the_upstream_pull_request_is_only_a_forks() -> None:
    broker = Broker(fork_connector(FakeUpstream(kind_=REPOSITORY_KIND)))
    with pytest.raises(NotNow) as refused:
        broker.open_upstream_pr(caller('pr-author'), BRANCH)
    assert refused.value.reason == NOT_A_FORK
    ref = broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, TITLE, BODY)
    assert ref.upstream is None   # (one's own repository: the pull request is the run's outcome, as before)


# --- the one-click link: always, once the safety checks pass -----------------------------------------------------


def _linked(broker: Broker, upstream: FakeUpstream, ledger: FakeUpstreamLedger) -> dict[str, object]:
    """The fork's pull request made, the upstream one left to the person's click: its record's view."""
    ref = broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, TITLE, BODY)
    assert ref.number == 7
    assert upstream.opened == []
    assert ref.upstream is not None
    assert ref.upstream['state'] == 'link'
    assert ledger.records[RUN].view() == {name: ref.upstream[name] for name in ledger.records[RUN].view()}
    return ref.upstream


def test_without_an_authorization_the_run_ends_with_the_one_click_link() -> None:
    upstream, tokens, ledger = FakeUpstream(), FakeOwnerTokens(missing=True), FakeUpstreamLedger()
    found = _linked(Broker(fork_connector(upstream, tokens, ledger)), upstream, ledger)
    assert found['reason'] == NOT_AUTHORIZED
    url = str(found['compare_url'])
    assert url.startswith(f'{COMPARE}?')
    query = parse_qs(urlsplit(url).query)
    assert query['expand'] == ['1']
    assert query['title'] == [TITLE]
    assert 'Fixes #42' in query['body'][0]
    assert query['body'][0].endswith(DISCLOSURE.format(login=FORK_OWNER))
    assert found['description'] is None   # (the whole body fits in the link)
    assert ledger.slots == []   # (only automatic opens count against the caps)


def test_github_refusing_the_app_keeps_the_link_and_is_no_error() -> None:
    from engineering.connectors.github_upstream import UpstreamHostRefused

    upstream = FakeUpstream(refuse=UpstreamHostRefused('GitHub answered 403 for the upstream'))
    ledger = FakeUpstreamLedger()
    found = _linked(Broker(fork_connector(upstream, ledger=ledger)), upstream, ledger)
    assert str(found['reason']).startswith(GITHUB_REFUSED)
    assert '403' in str(found['reason'])
    assert str(found['compare_url']).startswith(COMPARE)
    assert ledger.closed == [{'state': 'refused', 'as': LOGIN}]   # (the automatic attempt's audit says so)


def test_a_full_daily_cap_leaves_the_link() -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger(full='The daily cap on upstream pull requests is reached.')
    found = _linked(Broker(fork_connector(upstream, ledger=ledger)), upstream, ledger)
    assert 'daily cap' in str(found['reason'])
    assert found['compare_url'] is not None


@pytest.mark.parametrize(('assisted', 'said'), [(False, ASSISTED), (True, ASSISTED_NO_GO)])
def test_an_ai_assisted_run_the_app_may_not_open_for_leaves_the_link(assisted: bool, said: str) -> None:
    upstream, tokens, ledger = FakeUpstream(), FakeOwnerTokens(), FakeUpstreamLedger()
    upstream.fork_ = replace(upstream.fork_, assisted=assisted)
    broker = Broker(fork_connector(upstream, tokens, ledger, gate=FakeLedger({(RUN, TREE)}),
                                   dial=FakeDial({STARTER: 'ai_assisted'})))
    found = broker.open_upstream_pr(caller('pr-author'), BRANCH)
    assert (found['state'], found['reason']) == ('link', said)
    assert tokens.read == []   # (the owner's token is never read for a run it may not be used for)


def test_ai_assisted_with_the_owners_setting_and_a_persons_go_opens_it() -> None:
    upstream = FakeUpstream()
    upstream.fork_ = replace(upstream.fork_, assisted=True)
    broker = Broker(fork_connector(upstream, gate=FakeLedger({(RUN, TREE)}, people={RUN}),
                                   dial=FakeDial({STARTER: 'ai_assisted'})))
    outcome = broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, TITLE, BODY).upstream
    assert outcome is not None
    assert outcome['state'] == 'opened'


@pytest.mark.parametrize('mode', ['human_driven', ''])
def test_a_way_of_working_that_pushes_nothing_has_no_fork_pull_request_and_the_app_opens_nothing(mode: str) -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    broker = Broker(fork_connector(upstream, ledger=ledger, dial=FakeDial({STARTER: mode})))
    with pytest.raises(NotNow):   # (the dial holds the fork's own pull request: the run pushes nothing)
        broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, TITLE, BODY)
    found = broker.open_upstream_pr(caller('pr-author'), BRANCH)
    assert (found['state'], found['reason']) == ('link', HUMAN)
    assert upstream.opened == []


def test_a_body_too_long_for_the_link_is_shortened_and_kept_whole_for_copying() -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    upstream.fork_pr = ForkPullRequest(title=TITLE, body='Rounds the total to cents. ' * 400, open=True)
    found = _linked(Broker(fork_connector(upstream, FakeOwnerTokens(missing=True), ledger)), upstream, ledger)
    url = str(found['compare_url'])
    assert len(url) <= 7000
    assert 'Copy the description' in parse_qs(urlsplit(url).query)['body'][0]
    assert str(found['description']).count('Rounds the total to cents.') == 400


# --- the safety checks: a refusal offers no link -------------------------------------------------------------------


def _refused(broker: Broker, upstream: FakeUpstream, ledger: FakeUpstreamLedger) -> str:
    """The fork's pull request made, the upstream one refused, with no link: its reason, as the run's record keeps it."""
    ref = broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, TITLE, BODY)
    assert ref.number == 7
    assert upstream.opened == []
    assert ref.upstream is not None
    assert ref.upstream['state'] == 'refused'
    assert ledger.records[RUN].state == 'refused'
    assert ledger.records[RUN].compare_url is None
    assert ledger.records[RUN].reason == ref.upstream['reason']
    return str(ref.upstream['reason'])


@pytest.mark.parametrize(('facts', 'said'), [
    ({'archived': True}, 'archived'), ({'licence_spdx': 'GPL-3.0'}, 'acknowledge it again'),
    ({'licence_spdx': None}, 'no licence'), ({'private': True}, 'not public'),
])
def test_the_upstreams_state_refuses_the_link_before_any_token_or_cap(facts: dict[str, object], said: str) -> None:
    upstream, tokens, ledger = FakeUpstream(), FakeOwnerTokens(), FakeUpstreamLedger()
    upstream.facts_ = replace(upstream.facts_, facts=upstream_facts(**facts))
    assert said in _refused(Broker(fork_connector(upstream, tokens, ledger)), upstream, ledger)
    assert tokens.read == []
    assert ledger.slots == []


@pytest.mark.parametrize(('change', 'said'), [
    ({'opt_out': 'no-bot-prs'}, 'opts out of bot pull requests (no-bot-prs)'),
    ({'contributing': ContributingAsks(path='CONTRIBUTING.md', dco=True)}, 'DCO sign-off'),
])
def test_an_opted_out_upstream_or_one_asking_a_sign_off_gets_no_link(change: dict[str, object], said: str) -> None:
    upstream, tokens, ledger = FakeUpstream(), FakeOwnerTokens(), FakeUpstreamLedger()
    upstream.facts_ = replace(upstream.facts_, **change)
    assert said in _refused(Broker(fork_connector(upstream, tokens, ledger)), upstream, ledger)
    assert tokens.read == []


def test_an_upstream_asking_an_issue_first_needs_the_runs_issue() -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    upstream.facts_ = replace(upstream.facts_, contributing=ContributingAsks(path='CONTRIBUTING.md', issue_first=True))
    broker = Broker(fork_connector(upstream, ledger=ledger, runs=FakeRuns({RUN: record(issue_number=None)})))
    assert 'issue before a pull request' in _refused(broker, upstream, ledger)


def test_no_go_for_the_branchs_tree_now_no_link() -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    broker = Broker(fork_connector(upstream, ledger=ledger, host=FakeHost(tree_hash='f' * 40),
                                   gate=FakeLedger({(RUN, TREE)})))
    with pytest.raises(NotNow) as refused:
        broker.open_upstream_pr(caller('pr-author'), BRANCH)
    assert refused.value.reason == NO_GO
    assert upstream.opened == []
    assert ledger.records[RUN].compare_url is None


def test_an_opened_upstream_pull_request_is_answered_again_never_opened_twice() -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    broker = Broker(fork_connector(upstream, ledger=ledger))
    broker.open_upstream_pr(caller('pr-author'), BRANCH)
    again = broker.open_upstream_pr(caller('pr-author'), BRANCH)
    assert again['repeated'] is True
    assert len(upstream.opened) == 1


def test_an_open_upstream_pull_request_from_the_branch_is_recorded_without_a_write_or_a_slot() -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    upstream.existing_ = PullRequestRef(number=99, url=f'https://github.com/{UPSTREAM}/pull/99', head=BRANCH)
    answered = Broker(fork_connector(upstream, ledger=ledger)).open_upstream_pr(caller('pr-author'), BRANCH)
    assert (answered['number'], answered['repeated']) == (99, True)
    assert upstream.opened == []
    assert ledger.slots == []
    assert ledger.records[RUN] == UpstreamRecord('opened', UPSTREAM, number=99,
                                                 url=f'https://github.com/{UPSTREAM}/pull/99')


def test_a_closed_fork_pull_request_opens_nothing_upstream() -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    upstream.fork_pr = ForkPullRequest(title=TITLE, body=BODY, open=False)
    with pytest.raises(NotNow, match='closed'):
        Broker(fork_connector(upstream, ledger=ledger)).open_upstream_pr(caller('pr-author'), BRANCH)
    assert upstream.opened == []


def test_the_agents_words_are_held_to_the_write_rules_again() -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    upstream.fork_pr = ForkPullRequest(title=TITLE, body='Write to casey@mail-host.net for details.', open=True)
    with pytest.raises(WriteRefused, match='email'):
        Broker(fork_connector(upstream, ledger=ledger)).open_upstream_pr(caller('pr-author'), BRANCH)
    assert upstream.opened == []
