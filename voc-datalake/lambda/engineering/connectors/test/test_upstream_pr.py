"""Any public repository (7.57.00): the broker refuses every write on a public repository read only (fail closed, any
role, any operation); on a fork its PR author's pull request goes on to the upstream's: once the safety checks pass
(the GO, the upstream's state, the licence, DCO, an issue first), the run gets the one-click link to GitHub's compare
page, and the person creates it on GitHub (7.58.00: the app never opens it itself; upstream_pr.py)."""
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
    UPSTREAM,
    FakeUpstream,
    FakeUpstreamLedger,
    fork_connector,
    upstream_facts,
)
from engineering.connectors.upstream import DISCLOSURE, ContributingAsks
from engineering.connectors.upstream_pr import NO_GO, NOT_A_FORK
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


# --- the upstream pull request: one click away ---------------------------------------------------------------------


def _not_opened(broker: Broker, upstream: FakeUpstream, state: str) -> dict[str, object]:
    """The fork's pull request made, the upstream one offered (``state``): what the PR operation answered of it."""
    ref = broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, TITLE, BODY)
    assert ref.number == 7
    assert ref.upstream is not None
    assert ref.upstream['state'] == state
    assert 'open' not in upstream.asked   # (no write on the upstream: the person opens it)
    return ref.upstream


def _linked(broker: Broker, upstream: FakeUpstream, ledger: FakeUpstreamLedger) -> dict[str, object]:
    """The fork's pull request made, the upstream one left to the person's click: its record's view."""
    found = _not_opened(broker, upstream, 'link')
    assert ledger.records[RUN].view() == {name: found[name] for name in ledger.records[RUN].view()}
    return found


def test_the_forks_pull_request_goes_on_to_the_upstreams_one_click_link() -> None:
    host, upstream, ledger = FakeHost(), FakeUpstream(), FakeUpstreamLedger()
    found = _linked(Broker(fork_connector(upstream, ledger, host=host)), upstream, ledger)
    fork_body = next(call[5] for call in host.calls if call[0] == 'open_or_update_draft_pr')
    assert '#42' not in str(fork_body)   # (the fork's pull request names no issue: the upstream's does)
    url = str(found['compare_url'])
    assert url.startswith(f'{COMPARE}?')
    query = parse_qs(urlsplit(url).query)
    assert (query['expand'], query['title']) == (['1'], [TITLE])
    body = query['body'][0]
    assert body.startswith('## Description\n\nRounds the total to cents.')   # (the template filled, its comment out)
    assert '<!--' not in body
    assert '- [ ] tests' in body
    assert 'Fixes #42' in body
    assert 'CONTRIBUTING.md' in body
    assert body.endswith(DISCLOSURE.format(login=FORK_OWNER))
    assert 'Only a person approves and merges' not in body   # (the fork's own closing line stays on the fork)
    assert (found['description'], found['reason'], found['as']) == (None, None, None)   # (the whole body fits)


def test_only_the_pr_author_asks_for_the_upstream_pull_request() -> None:
    upstream = FakeUpstream()
    broker = Broker(fork_connector(upstream))
    for role in ('committer', 'understander', 'pr-reviewer', 'final-go', 'coordinator', 'fixer', 'runtime', 'start'):
        with pytest.raises(NotPermitted):
            broker.open_upstream_pr(caller(role), BRANCH)
    assert broker.open_upstream_pr(caller('pr-author'), BRANCH)['state'] == 'link'


def test_the_upstream_pull_request_is_only_a_forks() -> None:
    broker = Broker(fork_connector(FakeUpstream(kind_=REPOSITORY_KIND)))
    with pytest.raises(NotNow) as refused:
        broker.open_upstream_pr(caller('pr-author'), BRANCH)
    assert refused.value.reason == NOT_A_FORK
    ref = broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, TITLE, BODY)
    assert ref.upstream is None   # (one's own repository: the pull request is the run's outcome, as before)


@pytest.mark.parametrize('mode', ['ai_driven', 'ai_assisted'])
def test_the_link_is_the_same_whatever_way_of_working_lets_the_fork_pull_request_through(mode: str) -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    broker = Broker(fork_connector(upstream, ledger, gate=FakeLedger({(RUN, TREE)}, people={RUN}),
                                   dial=FakeDial({STARTER: mode})))
    assert _linked(broker, upstream, ledger)['reason'] is None


@pytest.mark.parametrize('mode', ['human_driven', ''])
def test_a_way_of_working_that_pushes_nothing_has_no_fork_pull_request(mode: str) -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    broker = Broker(fork_connector(upstream, ledger, dial=FakeDial({STARTER: mode})))
    with pytest.raises(NotNow):   # (the dial holds the fork's own pull request: the run pushes nothing)
        broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, TITLE, BODY)


def test_a_body_too_long_for_the_link_is_shortened_and_kept_whole_for_copying() -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    upstream.fork_pr = ForkPullRequest(title=TITLE, body='Rounds the total to cents. ' * 400, open=True)
    found = _linked(Broker(fork_connector(upstream, ledger)), upstream, ledger)
    url = str(found['compare_url'])
    assert len(url) <= 7000
    assert 'Copy the description' in parse_qs(urlsplit(url).query)['body'][0]
    assert str(found['description']).count('Rounds the total to cents.') == 400


def test_the_links_base_is_the_upstreams_default_branch_as_github_answers_it_now() -> None:
    # (Q20, 7.58.00) Not the default branch stored when the fork was connected.
    upstream = FakeUpstream()
    upstream.facts_ = replace(upstream.facts_, facts=upstream_facts(default_branch='trunk'))
    found = Broker(fork_connector(upstream, gate=FakeLedger({(RUN, TREE)}))).open_upstream_pr(caller('pr-author'), BRANCH)
    assert str(found['compare_url']).startswith(f'https://github.com/{UPSTREAM}/compare/trunk...')


# --- the safety checks: a refusal offers no link -------------------------------------------------------------------


def _refused(broker: Broker, upstream: FakeUpstream, ledger: FakeUpstreamLedger) -> str:
    """The fork's pull request made, the upstream one refused, with no link: its reason, as the run's record keeps it."""
    found = _not_opened(broker, upstream, 'refused')
    record = ledger.records[RUN]
    assert (record.state, record.compare_url, record.reason) == ('refused', None, found['reason'])
    return str(found['reason'])


@pytest.mark.parametrize(('facts', 'said'), [
    ({'archived': True}, 'archived'), ({'licence_spdx': 'GPL-3.0'}, 'acknowledge it again'),
    ({'licence_spdx': None}, 'no licence'), ({'private': True}, 'not public'),
])
def test_the_upstreams_state_refuses_the_link(facts: dict[str, object], said: str) -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    upstream.facts_ = replace(upstream.facts_, facts=upstream_facts(**facts))
    assert said in _refused(Broker(fork_connector(upstream, ledger)), upstream, ledger)


@pytest.mark.parametrize(('change', 'said'), [
    ({'opt_out': 'no-bot-prs'}, 'opts out of bot pull requests (no-bot-prs)'),
    ({'contributing': ContributingAsks(path='CONTRIBUTING.md', dco=True)}, 'DCO sign-off'),
])
def test_an_opted_out_upstream_or_one_asking_a_sign_off_gets_no_link(change: dict[str, object], said: str) -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    upstream.facts_ = replace(upstream.facts_, **change)
    assert said in _refused(Broker(fork_connector(upstream, ledger)), upstream, ledger)


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
    assert ledger.records[RUN].compare_url is None


def test_an_upstream_pull_request_recorded_open_is_answered_as_it_stands() -> None:
    opened = UpstreamRecord('opened', UPSTREAM, number=99, url=f'https://github.com/{UPSTREAM}/pull/99')
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger(records={RUN: opened})
    again = Broker(fork_connector(upstream, ledger=ledger)).open_upstream_pr(caller('pr-author'), BRANCH)
    assert (again['state'], again['number'], again['repeated']) == ('opened', 99, True)
    assert 'facts' not in upstream.asked   # (nothing read again)


def test_an_open_upstream_pull_request_from_the_branch_is_recorded_as_the_runs() -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    upstream.existing_ = PullRequestRef(number=99, url=f'https://github.com/{UPSTREAM}/pull/99', head=BRANCH)
    answered = Broker(fork_connector(upstream, ledger=ledger)).open_upstream_pr(caller('pr-author'), BRANCH)
    assert (answered['number'], answered['repeated']) == (99, True)
    assert ledger.records[RUN] == UpstreamRecord('opened', UPSTREAM, number=99,
                                                 url=f'https://github.com/{UPSTREAM}/pull/99')


def test_a_closed_fork_pull_request_opens_nothing_upstream() -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    upstream.fork_pr = ForkPullRequest(title=TITLE, body=BODY, open=False)
    with pytest.raises(NotNow, match='closed'):
        Broker(fork_connector(upstream, ledger=ledger)).open_upstream_pr(caller('pr-author'), BRANCH)
    assert ledger.records[RUN].state == 'refused'


def test_the_agents_words_are_held_to_the_write_rules_again() -> None:
    upstream, ledger = FakeUpstream(), FakeUpstreamLedger()
    upstream.fork_pr = ForkPullRequest(title=TITLE, body='Write to casey@mail-host.net for details.', open=True)
    with pytest.raises(WriteRefused, match='email'):
        Broker(fork_connector(upstream, ledger=ledger)).open_upstream_pr(caller('pr-author'), BRANCH)
    assert ledger.records[RUN].state == 'refused'
