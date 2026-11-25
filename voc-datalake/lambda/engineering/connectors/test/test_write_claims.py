"""Each broker write made once per key (records.py ``WriteClaims`` on moto, broker.py ``_once``, the handler's
``attempt``): a create-only claim row in the run's partition, taken before the host call and closed with its outcome."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from engineering.board.test.table import TABLE, create_table
from engineering.connectors.broker import (
    CLAIM_CLOCK_MARGIN_SECONDS,
    STALE_CLAIM_SECONDS,
    Broker,
    NotNow,
    NotPermitted,
    issue_marker,
    write_key,
)
from engineering.connectors.handler import handle
from engineering.connectors.hosts import (
    WRITE_CLAIMED,
    WRITE_DONE,
    WRITE_REFUSED,
    WRITE_UNKNOWN,
    HostBusy,
    HostError,
    OutcomeUnknown,
    Unavailable,
    WriteClaim,
)
from engineering.connectors.identity import Caller
from engineering.connectors.records import WriteClaims
from engineering.connectors.test.fakes import (
    ACCOUNT,
    BRANCH,
    PATTERN,
    RUN,
    STARTER,
    TREE,
    FakeDial,
    FakeHost,
    FakeRuns,
    FakeWrites,
    connector,
    record,
    role_arn,
    url_event,
)
from engineering.runtime.interface import MAX_ATTEMPT, AgentSpec

#: The run's writes' partition: never the run's own (``WS#default#RUN#<run>``).
PK = f'WS#default#WRITES#{RUN}'
KEY = 'pr-reviewer-5#1#post_comment'


@pytest.fixture
def client() -> Iterator[Any]:
    with mock_aws():
        yield create_table()


def _row(client: Any) -> dict[str, Any]:
    item = client.get_item(TableName=TABLE, Key={'pk': {'S': PK}, 'sk': {'S': f'WRITE#{KEY}'}})['Item']
    return {name: next(iter(value.values())) for name, value in item.items()}


def test_a_claim_is_created_once_closed_with_its_outcome_and_answered_to_a_repeat(client: Any):
    claims = WriteClaims(client, TABLE, clock=lambda: 1_000)
    assert claims.claim(RUN, KEY, 'post_comment') is None
    assert claims.claim(RUN, KEY, 'post_comment') == WriteClaim(WRITE_CLAIMED, at=1_000)
    claims.close(RUN, KEY, WRITE_DONE, {'url': 'https://code.example.com/pull/7#comment-1'})
    assert claims.claim(RUN, KEY, 'post_comment') == WriteClaim(WRITE_DONE, {'url': 'https://code.example.com/pull/7'
                                                                                    '#comment-1'}, 1_000)
    # The row's attributes are the claim's alone (the broker's IAM grant allows no other), in the run's partition.
    assert _row(client) == {'pk': PK, 'sk': f'WRITE#{KEY}', 'state': WRITE_DONE, 'op': 'post_comment', 'at': '1000',
                            'closed_at': '1000', 'result': '{"url": "https://code.example.com/pull/7#comment-1"}'}
    # A closed claim is never closed again.
    with pytest.raises(Unavailable):
        claims.close(RUN, KEY, WRITE_UNKNOWN)


def test_only_a_refusal_lets_the_key_be_claimed_again(client: Any):
    claims = WriteClaims(client, TABLE, clock=lambda: 1_000)
    assert claims.claim(RUN, KEY, 'post_comment') is None
    claims.close(RUN, KEY, WRITE_REFUSED)
    assert claims.claim(RUN, KEY, 'post_comment') is None
    claims.close(RUN, KEY, WRITE_UNKNOWN)
    assert claims.claim(RUN, KEY, 'post_comment') == WriteClaim(WRITE_UNKNOWN, at=1_000)


def test_an_issue_writes_claim_with_no_outcome_is_taken_again_once_stale_by_one_caller_alone(client: Any):
    # (7.71.03) A claim of a write on the run's issue whose call never answered (still claimed: it crashed between its
    # claim and its outcome; or unknown) is taken again once ``stale_after`` old, in one conditional write.
    now = [1_000]
    claims = WriteClaims(client, TABLE, clock=lambda: now[0])
    key = 'issue#42#post_comment'
    assert claims.claim(RUN, key, 'post_comment') is None
    assert claims.claim(RUN, key, 'post_comment', 300) == WriteClaim(WRITE_CLAIMED, at=1_000)   # (in flight)
    now[0] = 1_300
    assert claims.claim(RUN, key, 'post_comment', 300) is None
    assert claims.claim(RUN, key, 'post_comment', 300) == WriteClaim(WRITE_CLAIMED, at=1_300)   # (taken once)
    claims.close(RUN, key, WRITE_UNKNOWN)
    now[0] = 1_600
    assert claims.claim(RUN, key, 'post_comment') == WriteClaim(WRITE_UNKNOWN, at=1_300)   # (no stale_after: never)
    assert claims.claim(RUN, key, 'post_comment', 300) is None
    claims.close(RUN, key, WRITE_DONE, {'url': 'u'})
    now[0] = 9_000
    assert claims.claim(RUN, key, 'post_comment', 300) == WriteClaim(WRITE_DONE, {'url': 'u'}, 1_600)   # (done)


class Failing:
    """A DynamoDB client whose every call fails as the service would refuse it (a throttle)."""

    def __getattr__(self, name: str) -> Any:
        def fail(**_: Any) -> Any:
            raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow down'}},
                              name)
        return fail


def test_a_claim_that_cannot_be_written_or_read_is_unavailable_never_a_pass():
    claims = WriteClaims(Failing(), TABLE)
    with pytest.raises(Unavailable):
        claims.claim(RUN, KEY, 'post_comment')
    with pytest.raises(Unavailable):
        claims.close(RUN, KEY, WRITE_DONE, {'url': 'u'})


def test_the_broker_claims_a_write_on_the_table_and_a_repeat_is_never_posted_twice(client: Any):
    host = FakeHost()
    broker = Broker(connector(host=host, writes=WriteClaims(client, TABLE)))
    caller = Caller('pr-reviewer', RUN, 5)
    first = broker.post_comment(caller, 'pull_request', 7, 'One nit.')
    assert broker.post_comment(caller, 'pull_request', 7, 'One nit.') == first
    assert host.writes() == ['post_comment']
    # A different comment is a write of its own, made; the claims are in the writes' partition, none in the run's.
    broker.post_comment(caller, 'pull_request', 7, 'One more nit.')
    assert host.writes() == ['post_comment', 'post_comment']
    rows = client.scan(TableName=TABLE)['Items']
    assert {row['pk']['S'] for row in rows} == {PK}
    assert sorted(row['sk']['S'].rsplit('#', 1)[0] for row in rows) == ['WRITE#pr-reviewer-5#1#post_comment'] * 2
    assert {row['state']['S'] for row in rows} == {WRITE_DONE}
    first_key = write_key(caller, 1, 'post_comment', 'pull_request', 7, 'One nit.')
    assert f'WRITE#{first_key}' in {row['sk']['S'] for row in rows}


def test_two_understanders_of_a_run_comment_on_and_label_its_issue_once_the_second_gets_the_first_answer(client: Any):
    # (7.71.02) The first live Bug fixer run's two understanders each commented on its issue and labelled it: the key
    # was the agent's. A write on the run's issue is the run's, once, whoever asks first.
    host = FakeHost()
    broker = Broker(connector(host=host, writes=WriteClaims(client, TABLE)))
    first, second = Caller('understander', RUN, 2), Caller('understander', RUN, 5)
    url = broker.post_comment(first, 'issue', 42, 'A bug: the refund total drops the tax.')
    assert broker.label_issue(first, 42, ('voc-triage/bug', 'voc-severity/s2')) == ('voc-triage/bug', 'voc-severity/s2')
    # The second's own words and labels, at another attempt: nothing is written again, and its answer is the first's
    # (7.71.04: the labels on the issue, which its tool compares with its own).
    assert broker.post_comment(second, 'issue', 42, 'The refund total is wrong.', attempt=2) == url
    assert broker.label_issue(second, 42, ('voc-triage/bug', 'voc-severity/s3'), attempt=2) == (
        'voc-triage/bug', 'voc-severity/s2')
    assert host.writes() == ['post_comment', 'label_issue']
    rows = client.scan(TableName=TABLE)['Items']
    assert sorted((row['sk']['S'], row['state']['S']) for row in rows) == [
        ('WRITE#issue#42#label_issue', WRITE_DONE), ('WRITE#issue#42#post_comment', WRITE_DONE)]
    # A comment on the run's pull request is still each agent's own, once per attempt and text.
    reviewer = Caller('pr-reviewer', RUN, 6)
    broker.post_comment(reviewer, 'pull_request', 7, 'One nit.')
    broker.post_comment(reviewer, 'pull_request', 7, 'Another nit.')
    assert host.writes() == ['post_comment', 'label_issue', 'post_comment', 'post_comment']


def test_a_second_understanders_write_on_an_issue_whose_first_outcome_is_unknown_waits_for_that_call_to_be_over():
    writes = FakeWrites()
    host = FakeHost()
    broker = Broker(connector(host=host, writes=writes))
    writes.claims[(RUN, 'issue#42#post_comment')] = WriteClaim(WRITE_UNKNOWN, at=writes.now - 60)
    with pytest.raises(OutcomeUnknown, match="on the run's issue, by an agent of this run"):
        broker.post_comment(Caller('understander', RUN, 5), 'issue', 42, 'The refund total is wrong.')
    assert host.writes() == []


class CrashingHost(FakeHost):
    """A host whose first write of each kind is made, and then the broker's call ends (its function crashed or ran out
    of time) before the write's outcome is recorded: ``crash`` names the writes still to crash."""

    crash: frozenset[str] = frozenset({'post_comment', 'label_issue'})

    def post_comment(self, connection_id: str, on: Any, number: int, body: str) -> str:
        url = super().post_comment(connection_id, on, number, body)
        self._crash('post_comment')
        return url

    def label_issue(self, connection_id: str, number: int, labels: tuple[str, ...]) -> tuple[str, ...]:
        added = super().label_issue(connection_id, number, labels)
        self._crash('label_issue')
        return added

    def _crash(self, write: str) -> None:
        if write in self.crash:
            self.crash = self.crash - {write}
            raise SystemExit(f'the broker ended after its {write}')


def test_a_crash_between_an_issue_writes_claim_and_its_outcome_blocks_the_run_only_until_that_call_is_over(
        client: Any):
    # (7.71.03) The first understander's call made its comment and its labels, then ended before their outcomes were
    # recorded: the claims stay claimed. A later call is answered unknown while that call may still be under way, and
    # once it is over the comment is found on the host by the run's marker (never posted twice) and the labels, which
    # the host adds idempotently, are put again.
    now = [1_000]
    host = CrashingHost()
    broker = Broker(connector(host=host, writes=WriteClaims(client, TABLE, clock=lambda: now[0])))
    first, second = Caller('understander', RUN, 2), Caller('understander', RUN, 5)
    for write in (lambda: broker.post_comment(first, 'issue', 42, 'A bug: the refund total drops the tax.'),
                  lambda: broker.label_issue(first, 42, ('voc-triage/bug', 'voc-severity/s2'))):
        with pytest.raises(SystemExit):
            write()
    assert _states(client) == {'issue#42#label_issue': WRITE_CLAIMED, 'issue#42#post_comment': WRITE_CLAIMED}
    now[0] += 60
    with pytest.raises(OutcomeUnknown, match='ask again in a few minutes'):
        broker.post_comment(second, 'issue', 42, 'The refund total is wrong.')
    now[0] += STALE_CLAIM_SECONDS
    url = broker.post_comment(second, 'issue', 42, 'The refund total is wrong.')
    labelled = broker.label_issue(second, 42, ('voc-triage/bug', 'voc-severity/s2'))
    assert (url, labelled) == ('https://code.example.com/issue/42#comment-1', ('voc-triage/bug', 'voc-severity/s2'))
    [(*_, posted)] = [call for call in host.calls if call[0] == 'post_comment']
    assert posted == f'A bug: the refund total drops the tax.\n\n{issue_marker(RUN)}'
    # (7.71.04) The look reads the comments updated since the first call's claim, a minute's margin before it.
    looked = [call for call in host.calls if call[0] == 'issue_comment']
    assert looked == [('issue_comment', 'conn-1', 42, issue_marker(RUN), 1_000 - CLAIM_CLOCK_MARGIN_SECONDS)]
    assert host.writes() == ['post_comment', 'label_issue', 'label_issue']
    assert _states(client) == {'issue#42#label_issue': WRITE_DONE, 'issue#42#post_comment': WRITE_DONE}
    # Once done, a third caller gets the answers back and nothing more is written.
    assert broker.post_comment(Caller('understander', RUN, 7), 'issue', 42, 'Again.') == url
    assert host.writes() == ['post_comment', 'label_issue', 'label_issue']


def test_an_issue_comment_retried_after_a_crash_is_posted_when_the_host_has_none_of_the_runs():
    writes = FakeWrites()
    host = FakeHost()
    broker = Broker(connector(host=host, writes=writes))
    writes.claims[(RUN, 'issue#42#post_comment')] = WriteClaim(WRITE_CLAIMED, at=writes.now - STALE_CLAIM_SECONDS)
    assert broker.post_comment(Caller('understander', RUN, 5), 'issue', 42, 'The refund total is wrong.') == (
        'https://code.example.com/issue/42#comment-1')
    looked = [call for call in host.calls if call[0] == 'issue_comment']
    assert looked == [('issue_comment', 'conn-1', 42, issue_marker(RUN),
                       writes.now - STALE_CLAIM_SECONDS - CLAIM_CLOCK_MARGIN_SECONDS)]
    assert (host.writes(), writes.claims[(RUN, 'issue#42#post_comment')].state) == (['post_comment'], WRITE_DONE)


class CountedWrites(FakeWrites):
    """The ledger, counting its reads of a claim row (``earlier``)."""

    reads: int = 0

    def earlier(self, run_id: str, key: str) -> WriteClaim | None:
        self.reads += 1
        return super().earlier(run_id, key)


@pytest.mark.parametrize('state', [WRITE_CLAIMED, WRITE_UNKNOWN, WRITE_REFUSED, None])
def test_an_issue_write_reads_its_claim_row_once_and_looks_on_the_host_only_after_a_call_that_never_answered(
        state: str | None):
    # (7.71.04) One read of the claim before it is taken, whatever it holds; a refused one (nothing written) or none
    # is posted with no look on the host.
    writes, host = CountedWrites(), FakeHost()
    if state is not None:
        writes.claims[(RUN, 'issue#42#post_comment')] = WriteClaim(state, at=writes.now - STALE_CLAIM_SECONDS)
    broker = Broker(connector(host=host, writes=writes))
    assert broker.post_comment(Caller('understander', RUN, 5), 'issue', 42, 'The refund total is wrong.') == (
        'https://code.example.com/issue/42#comment-1')
    looks = [call[0] for call in host.calls].count('issue_comment')
    assert (writes.reads, looks, host.writes()) == (1, int(state in (WRITE_CLAIMED, WRITE_UNKNOWN)), ['post_comment'])


def test_a_look_on_the_host_that_fails_leaves_the_issue_comment_unknown_and_writes_nothing():
    class Unreadable(FakeHost):
        def issue_comment(self, connection_id: str, number: int, marker: str, since: int) -> str | None:
            raise HostError(f'The host answered 500 to the comment read ({connection_id}, #{number}, {marker}, '
                            f'{since}).')

    writes, host = FakeWrites(), Unreadable()
    broker = Broker(connector(host=host, writes=writes))
    writes.claims[(RUN, 'issue#42#post_comment')] = WriteClaim(WRITE_UNKNOWN, at=writes.now - STALE_CLAIM_SECONDS)
    with pytest.raises(HostError):
        broker.post_comment(Caller('understander', RUN, 5), 'issue', 42, 'The refund total is wrong.')
    assert (host.writes(), writes.claims[(RUN, 'issue#42#post_comment')].state) == ([], WRITE_UNKNOWN)


def _states(client: Any) -> dict[str, str]:
    return {row['sk']['S'].removeprefix('WRITE#'): row['state']['S'] for row in client.scan(TableName=TABLE)['Items']}


def test_a_rate_limited_write_wrote_nothing_is_answered_503_and_may_be_asked_again(client: Any):
    class BusyOnce(FakeHost):
        busy: bool = True

        def post_comment(self, connection_id: str, on: Any, number: int, body: str) -> str:
            if self.busy:
                self.busy = False
                raise HostBusy('The host is rate limiting; retry.', retry_after=30)
            return super().post_comment(connection_id, on, number, body)

    broker = Broker(connector(host=BusyOnce(), writes=WriteClaims(client, TABLE)))
    body = {'operation': 'post_comment', 'args': {'on': 'pull_request', 'number': 7, 'body': 'b'}}
    event = url_event(role_arn('pr-reviewer', f'{RUN}.5'), body)
    busy = handle(event, PATTERN, ACCOUNT, broker)
    assert (busy['statusCode'], busy['headers'].get('Retry-After'), _rows_state(client)) == (503, '30', WRITE_REFUSED)
    assert (handle(event, PATTERN, ACCOUNT, broker)['statusCode'], _rows_state(client)) == (200, WRITE_DONE)


def _rows_state(client: Any) -> str:
    [row] = client.scan(TableName=TABLE)['Items']
    return str(row['state']['S'])


class BrokenHost(FakeHost):
    def post_comment(self, connection_id: str, on: Any, number: int, body: str) -> str:
        self.calls.append(('post_comment', connection_id, on, number, body))
        raise HostError('The host answered 500.')


def test_a_host_error_mid_write_leaves_the_claim_unknown_and_answers_502(client: Any):
    broker = Broker(connector(host=BrokenHost(), writes=WriteClaims(client, TABLE)))
    body = {'operation': 'post_comment', 'args': {'on': 'pull_request', 'number': 7, 'body': 'b'}}
    response = handle(url_event(role_arn('pr-reviewer', f'{RUN}.5'), body), PATTERN, ACCOUNT, broker)
    assert (response['statusCode'], 'not known' in response['body'], _rows_state(client)) == (
        502, True, WRITE_UNKNOWN)


def test_a_repeat_answers_its_first_outcome_even_after_the_run_or_the_dial_moved_on():
    runs, dial, host, writes = FakeRuns(), FakeDial(), FakeHost(), FakeWrites()
    broker = Broker(connector(host=host, runs=runs, dial=dial, writes=writes))
    reviewer, committer = Caller('pr-reviewer', RUN, 5), Caller('committer', RUN, 3)
    url = broker.post_comment(reviewer, 'pull_request', 7, 'One nit.')
    pushed = broker.push_bundle(committer, BRANCH, 'patch-key', TREE, 'Fix the refund total')
    runs.runs[RUN] = record(status='stopped')
    dial.modes[STARTER] = 'human_driven'
    # The writes made answer their answers, as a repeated launch does; nothing is written again.
    assert broker.post_comment(reviewer, 'pull_request', 7, 'One nit.') == url
    assert broker.push_bundle(committer, BRANCH, 'patch-key', TREE, 'Fix the refund total') == pushed
    assert host.writes() == ['post_comment', 'push_bundle']
    # A new write is checked as ever, and refused; so is another role asking with the same words.
    with pytest.raises(NotNow, match='stopped'):
        broker.post_comment(reviewer, 'pull_request', 7, 'Another nit.')
    with pytest.raises(NotPermitted):
        broker.post_comment(Caller('fixer', RUN, 5), 'pull_request', 7, 'One nit.')
    # A repeat of one whose outcome is unknown stays unknown, whatever the run's state.
    unknown = write_key(reviewer, 1, 'post_comment', 'pull_request', 7, 'Lost.')
    writes.claims[(RUN, unknown)] = WriteClaim(WRITE_UNKNOWN)
    with pytest.raises(OutcomeUnknown):
        broker.post_comment(reviewer, 'pull_request', 7, 'Lost.')
    assert host.writes() == ['post_comment', 'push_bundle']


@pytest.mark.parametrize('attempt', [0, -1, MAX_ATTEMPT + 1, True, '2', 1.5])
def test_a_writes_attempt_is_a_whole_number_from_1(attempt: object):
    body = {'operation': 'post_comment', 'args': {'on': 'pull_request', 'number': 7, 'body': 'b', 'attempt': attempt}}
    response = handle(url_event(role_arn('pr-reviewer', f'{RUN}.5'), body), PATTERN, ACCOUNT, Broker(connector()))
    assert (response['statusCode'], f'attempt is a whole number from 1 to {MAX_ATTEMPT}.' in response['body']) == (
        400, True)


@pytest.mark.parametrize('attempt', [1, 1001, MAX_ATTEMPT])
def test_every_attempt_the_runtime_runs_a_task_at_can_write(attempt: int):
    # The runtime's bound (a task's attempts, runtime/interface.py) is the broker's: an agent at any attempt it can
    # work at is never refused its write for the attempt's number.
    assert MAX_ATTEMPT == 9999
    AgentSpec(run_id=RUN, agent_id='pr-reviewer-5', role='pr-reviewer', task_id='task-1', language='python',
              egress=(), connection='conn-1', attempt=attempt)
    body = {'operation': 'post_comment', 'args': {'on': 'pull_request', 'number': 7, 'body': 'b', 'attempt': attempt}}
    response = handle(url_event(role_arn('pr-reviewer', f'{RUN}.5'), body), PATTERN, ACCOUNT, Broker(connector()))
    assert response['statusCode'] == 200


def test_a_writes_attempt_is_part_of_its_key():
    writes = FakeWrites()
    broker = Broker(connector(writes=writes))
    for attempt in (2, 2, 3):
        body = {'operation': 'post_comment', 'args': {'on': 'pull_request', 'number': 7, 'body': 'b',
                                                      'attempt': attempt}}
        assert handle(url_event(role_arn('pr-reviewer', f'{RUN}.5'), body), PATTERN, ACCOUNT,
                      broker)['statusCode'] == 200
    assert sorted(key.rsplit('#', 1)[0] for _, key in writes.claims) == ['pr-reviewer-5#2#post_comment',
                                                                          'pr-reviewer-5#3#post_comment']
