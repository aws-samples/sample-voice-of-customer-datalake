"""The run's pull request on its record (7.09.00, ``broker._keep_pull_request``, ``records.WriteClaims
.record_pull_request``, ``engineering/run_links.py``): kept when the host answers an open or an update with it, on
GitHub and on GitLab; never for an outcome unknown until a later open or update finds it by its branch; keyed on the
run's branch (a draft closed and opened again replaces it, the earlier numbers bounded; another branch never); read
back from the done claim when it could not be written; never for an address that is not the run's own repository's
on its host's own domain."""
from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from moto import mock_aws

from engineering.board.test.table import TABLE, create_table
from engineering.connectors.broker import Broker
from engineering.connectors.hosts import HostError, OutcomeUnknown, PullRequestRef, Unavailable
from engineering.connectors.identity import Caller
from engineering.connectors.records import WriteClaims
from engineering.connectors.test import test_github as gh
from engineering.connectors.test import test_gitlab_writes as gl
from engineering.connectors.test.fakes import BRANCH, REPOSITORY, RUN, FakeHost, FakeWrites, connector
from engineering.run_links import MAX_SUPERSEDED, PULL_REQUEST_SK, PullRequestLink, pull_request_link, run_links

GITHUB_PULL = f'https://github.com/{REPOSITORY}/pull/7'
GITLAB_MERGE = f'https://gitlab.com/{REPOSITORY}/-/merge_requests/7'
WHO = Caller(role='pr-author', run_id=RUN, agent_index=1)


@dataclass
class AnsweringHost(FakeHost):
    """A host whose pull request writes answer ``answers`` in turn (an exception is raised: the write's outcome is not
    known)."""

    answers: list[PullRequestRef | Exception] = field(default_factory=list)

    def open_or_update_draft_pr(self, connection_id: str, branch: str, base: str, title: str, body: str,
                                tree_hash: str) -> PullRequestRef:
        super().open_or_update_draft_pr(connection_id, branch, base, title, body, tree_hash)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def _ref(number: int = 7, url: str = GITHUB_PULL, host: str = 'github', head: str = BRANCH) -> PullRequestRef:
    return PullRequestRef(number=number, url=url, head=head, base='main', host=host)


def _why(caplog: pytest.LogCaptureFixture) -> list[str]:
    """Why each pull request was not kept, as the broker logged it."""
    return [str(getattr(entry, 'why', '')) for entry in caplog.records
            if entry.getMessage() == 'broker pull request not recorded']


def _broker(*answers: PullRequestRef | Exception) -> tuple[Broker, FakeWrites]:
    writes = FakeWrites()
    return Broker(connector(host=AnsweringHost(answers=list(answers)), writes=writes)), writes


@pytest.mark.parametrize(('host', 'url'), [('github', GITHUB_PULL), ('gitlab', GITLAB_MERGE)])
def test_the_pull_request_the_host_answers_an_open_and_an_update_with_is_kept_once(host: str, url: str) -> None:
    broker, writes = _broker(_ref(url=url, host=host), _ref(url=url, host=host))
    broker.open_or_update_draft_pr(WHO, BRANCH, 'Fix the refund total', 'Body', attempt=1)
    # (the update: the same pull request, new text, another attempt)
    broker.open_or_update_draft_pr(WHO, BRANCH, 'Fix the refund total', 'Body, edited', attempt=2)
    assert writes.pull_requests == {RUN: PullRequestLink(host=host, number=7, url=url, head=BRANCH, base='main')}


def test_an_outcome_unknown_records_nothing_until_a_later_open_finds_it_by_its_branch() -> None:
    broker, writes = _broker(HostError('The host did not answer.'), _ref())
    with pytest.raises(OutcomeUnknown):
        broker.open_or_update_draft_pr(WHO, BRANCH, 'Fix', 'Body', attempt=1)
    assert writes.pull_requests == {}
    # A repeat of the same write is never made again, and records nothing.
    with pytest.raises(OutcomeUnknown):
        broker.open_or_update_draft_pr(WHO, BRANCH, 'Fix', 'Body', attempt=1)
    assert writes.pull_requests == {}
    # The next attempt's lookup on the host finds the pull request by its branch: what it answers is kept.
    assert broker.open_or_update_draft_pr(WHO, BRANCH, 'Fix', 'Body', attempt=2).number == 7
    assert writes.pull_requests[RUN].number == 7


def test_a_draft_closed_and_opened_again_on_the_runs_branch_replaces_the_record() -> None:
    # A person closed draft 7; the next open finds none open from the branch and opens 9.
    broker, writes = _broker(_ref(), _ref(number=9, url=f'https://github.com/{REPOSITORY}/pull/9'))
    broker.open_or_update_draft_pr(WHO, BRANCH, 'Fix', 'Body', attempt=1)
    assert broker.open_or_update_draft_pr(WHO, BRANCH, 'Fix', 'Body', attempt=2).number == 9
    assert (writes.pull_requests[RUN].number, writes.pull_requests[RUN].superseded) == (9, (7,))


@pytest.mark.parametrize('ref', [
    _ref(url='https://code.example.net/example-org/refund-service/pull/7'),   # another domain
    _ref(url='http://github.com/example-org/refund-service/pull/7'),          # not https
    _ref(url='https://github.com/other-org/refund-service/pull/7'),           # another repository
    _ref(url=f'https://github.com/{REPOSITORY}/pull/8'),                      # another number than the answer's
    _ref(url=GITHUB_PULL, host='gitlab'),                                     # another host's address
    _ref(host=''),                                                            # no host kind
    _ref(head='voc-agent/another-run/fix'),                                   # not the run's branch
], ids=['domain', 'scheme', 'repository', 'number', 'host', 'no-host', 'branch'])
def test_an_answer_that_is_not_the_runs_own_is_not_kept(ref: PullRequestRef, caplog: pytest.LogCaptureFixture) -> None:
    broker, writes = _broker(ref)
    assert broker.open_or_update_draft_pr(WHO, BRANCH, 'Fix', 'Body').number == ref.number
    assert writes.pull_requests == {}
    assert _why(caplog) == ["not the run's own (another repository, host, address or branch)"]


class _Unwritable(FakeWrites):
    def record_pull_request(self, run_id: str, link: PullRequestLink) -> bool:  # noqa: ARG002 - the protocol's
        raise Unavailable('throttled')


def test_a_record_that_cannot_be_written_never_fails_the_write(caplog: pytest.LogCaptureFixture) -> None:
    broker = Broker(connector(host=AnsweringHost(answers=[_ref()]), writes=_Unwritable()))
    assert broker.open_or_update_draft_pr(WHO, BRANCH, 'Fix', 'Body').url == GITHUB_PULL
    assert _why(caplog) == ['the record could not be written; it is read back from the write claim until it is']


# --- the row, on moto -------------------------------------------------------------------------------------------------


@pytest.fixture
def client() -> Iterator[Any]:
    with mock_aws():
        yield create_table()


def _link(number: int = 7) -> PullRequestLink:
    found = pull_request_link('github', REPOSITORY, number, f'https://github.com/{REPOSITORY}/pull/{number}', BRANCH,
                              'main')
    assert found is not None
    return found


def _row(client: Any) -> dict[str, Any]:
    item = client.get_item(TableName=TABLE, Key={'pk': {'S': f'WS#default#WRITES#{RUN}'},
                                                 'sk': {'S': PULL_REQUEST_SK}})['Item']
    return {name: next(iter(value.values())) for name, value in item.items()}


def test_the_same_pull_request_again_updates_its_base_and_keeps_when_it_was_first_recorded(client: Any) -> None:
    times = iter([1_000, 2_000, 3_000])
    claims = WriteClaims(client, TABLE, clock=lambda: next(times))
    assert (claims.record_pull_request(RUN, _link()), claims.record_pull_request(RUN, _link())) == (True, True)
    # (a person changed the base on the host: compared on the number and the head alone)
    assert claims.record_pull_request(RUN, replace(_link(), base='release')) is True
    row = _row(client)
    assert (row['at'], row['closed_at'], row['op']) == ('1000', '2000', 'pull_request')
    assert (json.loads(row['result'])['base'], json.loads(row['result'])['superseded']) == ('release', [])


def test_a_new_number_on_the_runs_branch_replaces_it_and_another_branch_never_does(client: Any) -> None:
    claims = WriteClaims(client, TABLE, clock=lambda: 1_000)
    claims.record_pull_request(RUN, _link())
    assert claims.record_pull_request(RUN, _link(9)) is True
    assert claims.record_pull_request(RUN, replace(_link(11), head=f'voc-agent/{RUN}/another')) is False
    found = json.loads(_row(client)['result'])
    assert (found['number'], found['superseded'], found['head']) == (9, [7], BRANCH)


def test_the_numbers_it_replaced_are_bounded_the_oldest_dropped(client: Any) -> None:
    claims = WriteClaims(client, TABLE, clock=lambda: 1_000)
    for number in range(1, MAX_SUPERSEDED + 6):
        claims.record_pull_request(RUN, _link(number))
    found = json.loads(_row(client)['result'])
    assert (found['number'], found['superseded']) == (MAX_SUPERSEDED + 5, list(range(5, MAX_SUPERSEDED + 5)))


#: The claim row's attributes, all the broker's grant lets it write (lib/stacks/engineering-broker.ts).
_GRANT = re.compile(r"const BROKER_CLAIM_ATTRIBUTES = \[([^\]]*)\]")


def test_the_row_has_only_the_attributes_the_brokers_grant_allows(client: Any) -> None:
    WriteClaims(client, TABLE, clock=lambda: 1_000).record_pull_request(RUN, _link())
    stack = (Path(__file__).parents[4] / 'lib/stacks/engineering-broker.ts').read_text(encoding='utf-8')
    found = _GRANT.search(stack)
    assert found is not None
    assert set(_row(client)) <= set(re.findall(r"'([^']+)'", found.group(1)))


class _Failing:
    """A table whose read or write fails with ``error`` (``on``: which), or whose row always moves (``moved``)."""

    def __init__(self, error: Exception, on: str = 'update_item') -> None:
        self.error, self.on = error, on

    def get_item(self, **_: object) -> dict[str, Any]:
        if self.on == 'get_item':
            raise self.error
        return {}

    def update_item(self, **_: object) -> None:
        raise self.error


_THROTTLED = ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'slow down'}}, 'UpdateItem')
_MOVED = ClientError({'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'moved'}}, 'UpdateItem')


def test_the_reactions_read_takes_the_recorded_pull_request_of_the_runs_own_repository(client: Any) -> None:
    claims = WriteClaims(client, TABLE, clock=lambda: 1_000)
    assert claims.pull_request(RUN, REPOSITORY) is None
    claims.record_pull_request(RUN, _link())
    assert claims.pull_request(RUN, REPOSITORY) == _link()
    assert claims.pull_request(RUN, 'example-org/another-service') is None


def test_a_pull_request_that_cannot_be_read_for_the_reactions_is_unavailable() -> None:
    with pytest.raises(Unavailable):
        WriteClaims(_Failing(_THROTTLED, on='get_item'), TABLE).pull_request(RUN, REPOSITORY)


@pytest.mark.parametrize('table', [
    _Failing(_THROTTLED), _Failing(EndpointConnectionError(endpoint_url='https://dynamodb')),
    _Failing(_THROTTLED, on='get_item'), _Failing(_MOVED),
], ids=['throttled', 'unreachable', 'unreadable', 'moved-every-try'])
def test_a_row_that_cannot_be_written_is_unavailable(table: _Failing) -> None:
    with pytest.raises(Unavailable):
        WriteClaims(table, TABLE).record_pull_request(RUN, _link())


class _UnrecordedClaims(WriteClaims):
    def record_pull_request(self, run_id: str, link: PullRequestLink) -> bool:  # noqa: ARG002 - the protocol's
        raise Unavailable('throttled')


def test_a_record_that_could_not_be_written_is_read_back_from_its_done_claim(client: Any) -> None:
    writes = _UnrecordedClaims(client, TABLE, clock=lambda: 1_000)
    broker = Broker(connector(host=AnsweringHost(answers=[_ref()]), writes=writes))
    broker.open_or_update_draft_pr(WHO, BRANCH, 'Fix', 'Body')
    links = run_links(client, TABLE, 'default', RUN, {'repo': {'S': REPOSITORY}})
    assert links['pull_request'] == {'host': 'github', 'number': 7, 'url': GITHUB_PULL, 'head': BRANCH,
                                     'base': 'main', 'superseded': []}


# --- the clients' answers ---------------------------------------------------------------------------------------------


def test_github_answers_the_pull_requests_branches_and_its_host() -> None:
    api = gh.draftable(gh.FakeGitHub(), open_prs=[{'number': 7, 'html_url': GITHUB_PULL, 'head': {'ref': BRANCH},
                                                   'base': {'ref': 'main'}}])
    ref = gh.client(api).open_or_update_draft_pr('c', BRANCH, 'main', 'Fix', 'Body', gh.TREE)
    assert (ref.head, ref.base, ref.host) == (BRANCH, 'main', 'github')


def test_github_answers_no_branch_its_answer_does_not_name() -> None:
    ref = gh.client(gh.draftable(gh.FakeGitHub(), open_prs=[])).open_or_update_draft_pr(
        'c', BRANCH, 'main', 'Fix', 'Body', gh.TREE)
    assert (ref.number, ref.head, ref.base, ref.host) == (8, '', '', 'github')


def test_gitlab_answers_the_merge_requests_branches_and_its_host() -> None:
    ours = {**gl.OURS_OPEN, 'source_branch': BRANCH}
    ref = gl.client(gl.draftable(gl.FakeGitLab(), open_mrs=[ours])).open_or_update_draft_pr(
        'conn-1', BRANCH, 'main', 'Fix', 'Body', gl.TREE)
    assert (ref.number, ref.head, ref.base, ref.host) == (8, BRANCH, 'main', 'gitlab')
