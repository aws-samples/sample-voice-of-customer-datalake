"""The broker's reactions read (7.10.00, broker.py ``Broker.reactions``, handler.py ``reactions``): the runtime's alone,
its caller checked as an agent's is (its own account, its execution role, the session named after its function); an
agent's session refused whatever its role; an ended run's recorded pull request only, read on its default branch."""
from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

import pytest

from engineering.connectors import handler
from engineering.connectors.broker import NOT_ENDED, OTHER_REPOSITORY, Broker, NotNow, NotPermitted
from engineering.connectors.hosts import NO_CONNECTION, NoConnection
from engineering.connectors.identity import AGENT_ROLES, RUNTIME_ROLE, Caller
from engineering.connectors.reactions import PullRequestReactions, ReactionItem
from engineering.connectors.test.fakes import (
    ACCOUNT,
    PATTERN,
    REPOSITORY,
    RUN,
    FakeHost,
    FakeRuns,
    FakeWrites,
    connector,
    record,
    role_arn,
    url_event,
)
from engineering.run_links import PullRequestLink

RUNTIME_ROLE_NAME = 'VocProcessingStack-EngineeringRuntimeSupervisorRoleA1B2C3'
RUNTIME_FUNCTION = 'voc-engineering-runtime'
RUNTIME = (RUNTIME_ROLE_NAME, RUNTIME_FUNCTION)
LINK = PullRequestLink(host='github', number=7, url=f'https://github.com/{REPOSITORY}/pull/7',
                       head=f'voc-agent/{RUN}/fix', base='main')
FOUND = PullRequestReactions(host='github', number=7, url=LINK.url, state='open', items=(
    ReactionItem(kind='review', state='changes_requested', author='casey', at='2026-11-12T09:00:00Z',
                 body='Split this, and mail me at [redacted].'),))


def runtime_arn(role: str = RUNTIME_ROLE_NAME, session: str = RUNTIME_FUNCTION, account: str = ACCOUNT) -> str:
    return f'arn:aws:sts::{account}:assumed-role/{role}/{session}'


def broker(status: str = 'done', recorded: PullRequestLink | None = LINK, host: FakeHost | None = None) -> Broker:
    writes = FakeWrites()
    if recorded is not None:
        writes.pull_requests[RUN] = recorded
    return Broker(connector(host=host or FakeHost(reactions_found=FOUND), runs=FakeRuns({RUN: record(status=status)}),
                            writes=writes))


def call(user_arn: str, args: object, on: Broker | None = None, operation: str = 'reactions') -> tuple[int, Any]:
    response = handler.handle(url_event(user_arn, {'operation': operation, 'args': args}), PATTERN, ACCOUNT,
                              on or broker(), RUNTIME)
    return response['statusCode'], json.loads(response['body'])


def test_the_runtime_reads_an_ended_runs_reactions_on_its_recorded_pull_request() -> None:
    host = FakeHost(reactions_found=FOUND)
    status, body = call(runtime_arn(), {'run_id': RUN}, broker(host=host))
    assert status == 200
    assert body['result']['reactions'] == FOUND.view()
    # (the record's number and address, on the run's default branch: nothing from the request but the run)
    assert host.calls == [('reactions', 'conn-1', 7, LINK.url, 'main')]


@pytest.mark.parametrize('role', sorted(AGENT_ROLES))
def test_an_agents_session_may_not_read_reactions_whatever_its_role(role: str) -> None:
    host = FakeHost()
    status, body = call(role_arn(role), {'run_id': RUN}, broker(host=host))
    assert (status, body['error']) == (403, f'The {role} role may not read reactions.')
    assert host.calls == []


@pytest.mark.parametrize('user_arn', [
    runtime_arn(session='voc-engineering-delivery'),                 # another function on the same role
    runtime_arn(role='VocProcessingStack-SomeOtherRole'),             # another role
    runtime_arn(account='222222222222'),                              # another account
    f'arn:aws:iam::{ACCOUNT}:user/{RUNTIME_ROLE_NAME}',                # not an assumed role
])
def test_anything_but_the_runtimes_own_session_is_no_caller(user_arn: str) -> None:
    status, body = call(user_arn, {'run_id': RUN})
    assert (status, body) == (403, {'error': 'The caller is not an engineering agent.'})


def test_no_runtime_is_admitted_while_the_stack_names_none() -> None:
    response = handler.handle(url_event(runtime_arn(), {'operation': 'reactions', 'args': {'run_id': RUN}}), PATTERN,
                              ACCOUNT, broker())
    assert response['statusCode'] == 403


@pytest.mark.parametrize(('operation', 'args'), [
    ('read', {'kind': 'file', 'target': 'README.md'}),
    ('post_comment', {'on': 'pull_request', 'number': 7, 'body': 'Hello.'}),
])
def test_the_runtime_may_make_no_agents_operation(operation: str, args: dict[str, object]) -> None:
    status, body = call(runtime_arn(), args, operation=operation)
    assert status == 403
    assert body['error'].startswith('The runtime role may not')


@pytest.mark.parametrize('args', [{}, {'run_id': 'not-a-run'}, {'run_id': RUN, 'number': 9}])
def test_400_for_args_that_are_not_a_run(args: dict[str, object]) -> None:
    assert call(runtime_arn(), args)[0] == 400


@pytest.mark.parametrize('status', ['active', 'needs_human'])
def test_409_while_the_run_has_not_ended(status: str) -> None:
    assert call(runtime_arn(), {'run_id': RUN}, broker(status=status)) == (409, {'error': NOT_ENDED})


def test_a_run_without_a_recorded_pull_request_answers_none_and_asks_the_host_nothing() -> None:
    host = FakeHost()
    status, body = call(runtime_arn(), {'run_id': RUN}, broker(recorded=None, host=host))
    assert (status, body) == (200, {'result': {'reactions': None}})
    assert host.calls == []


def test_a_connection_that_names_another_repository_or_host_is_refused() -> None:
    moved = FakeHost(credential_repository='example-org/another-service')
    assert call(runtime_arn(), {'run_id': RUN}, broker(host=moved)) == (409, {'error': OTHER_REPOSITORY})
    other_host = FakeHost(reactions_found=replace(FOUND, host='gitlab'))
    assert call(runtime_arn(), {'run_id': RUN}, broker(host=other_host)) == (409, {'error': OTHER_REPOSITORY})


def test_the_broker_method_holds_the_same_rules() -> None:
    runtime = Caller(role=RUNTIME_ROLE, run_id='', agent_index=0)
    with pytest.raises(NotPermitted):
        broker().reactions(Caller(role='pr-author', run_id=RUN, agent_index=2), RUN)
    with pytest.raises(NoConnection, match=NO_CONNECTION):
        Broker(None).reactions(runtime, RUN)
    with pytest.raises(NotNow, match='not one the broker knows'):
        broker().reactions(runtime, '01JC8Z3K4M5N6P7Q8R9S0T1V2X')
    no_connection = Broker(connector(runs=FakeRuns({RUN: record(status='done', connection_id='')})))
    assert no_connection.reactions(runtime, RUN) is None
