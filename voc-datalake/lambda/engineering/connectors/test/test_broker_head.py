"""The broker's ``head`` (7.47.00, broker.py ``Broker.head``, handler.py ``head``): voc-engineering-start's alone, read
only; and a run started from an issue names it in its pull request (``closing_body``)."""
from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

import pytest

from engineering.connectors import handler
from engineering.connectors.broker import Broker, NotNow, NotPermitted, closing_body
from engineering.connectors.hosts import STORED_BRANCH_MISSING, NoConnection, StoredBranchMissing
from engineering.connectors.identity import RUNTIME_ROLE, START_ROLE, Caller
from engineering.connectors.test.fakes import (
    ACCOUNT,
    BASE,
    PATTERN,
    REPOSITORY,
    FakeHost,
    connector,
    record,
    role_arn,
    url_event,
)

START = Caller(role=START_ROLE, run_id='', agent_index=0)
START_ROLE_NAME = 'VocProcessingStack-EngineeringStartRoleA1B2C3'
START_FUNCTION = 'voc-engineering-start'
ARGS = {'connection': 'conn-1', 'repository': REPOSITORY, 'branch': 'main'}


def start_arn(role: str = START_ROLE_NAME, session: str = START_FUNCTION, account: str = ACCOUNT) -> str:
    return f'arn:aws:sts::{account}:assumed-role/{role}/{session}'


def call(user_arn: str, args: object, operation: str = 'head', host: FakeHost | None = None,
         start: tuple[str, str] = (START_ROLE_NAME, START_FUNCTION)) -> tuple[int, Any]:
    response = handler.handle(url_event(user_arn, {'operation': operation, 'args': args}), PATTERN, ACCOUNT,
                              Broker(connector(host=host or FakeHost())), start=start)
    return response['statusCode'], json.loads(response['body'])


def test_the_start_reads_the_head_of_the_stored_branch_and_the_issues_state() -> None:
    host = FakeHost()
    assert call(start_arn(), {**ARGS, 'issue': 42}, host=host) == (
        200, {'result': {'commit': BASE, 'issue': {'number': 42, 'state': 'open'}}})
    assert call(start_arn(), {**ARGS, 'issue': 43}, host=host)[1]['result']['issue'] == {'number': 43, 'state': 'closed'}
    assert call(start_arn(), {**ARGS, 'issue': 99}, host=host)[1]['result']['issue'] == {'number': 99, 'state': None}
    assert call(start_arn(), ARGS, host=host)[1]['result'] == {'commit': BASE, 'issue': None}
    # Reads only: the branch confirmed, its head and the issue; no write of any kind.
    assert host.writes() == []
    assert ('head_commit', 'conn-1', 'main') in host.calls


def test_the_head_is_the_starts_alone() -> None:
    assert call(role_arn('fixer'), ARGS)[0] == 403
    assert call(start_arn(session='voc-engineering-runtime'), ARGS)[0] == 403   # (another function, same role)
    assert call(start_arn(account='222222222222'), ARGS)[0] == 403
    assert call(start_arn(), ARGS, start=('', ''))[0] == 403                    # (no start admitted)
    for caller in (Caller(role='committer', run_id='R', agent_index=1), Caller(RUNTIME_ROLE, '', 0)):
        with pytest.raises(NotPermitted):
            Broker(connector()).head(caller, 'conn-1', REPOSITORY, 'main')


def test_the_start_may_make_no_other_operation() -> None:
    assert call(start_arn(), {'kind': 'file', 'target': 'README.md'}, operation='read')[0] == 403
    assert call(start_arn(), {'run_id': '01JC8Z3K4M5N6P7Q8R9S0T1V2W'}, operation='reactions')[0] == 403


@pytest.mark.parametrize('args', [
    {'connection': 'conn-1', 'repository': REPOSITORY},
    {**ARGS, 'issue': 'seven'}, {**ARGS, 'issue': 0}, {**ARGS, 'issue': True}, {**ARGS, 'connection': 'Conn 1'},
    {**ARGS, 'commit': BASE},
])
def test_400_for_args_that_are_not_the_heads(args: dict[str, object]) -> None:
    assert call(start_arn(), args)[0] == 400


def test_a_credential_for_another_repository_or_a_missing_branch_is_refused() -> None:
    broker = Broker(connector(host=FakeHost(credential_repository='example-org/other')))
    with pytest.raises(NotNow):
        broker.head(START, 'conn-1', REPOSITORY, 'main')
    with pytest.raises(StoredBranchMissing):
        Broker(connector()).head(START, 'conn-1', REPOSITORY, 'gone')
    assert call(start_arn(), {**ARGS, 'branch': 'gone'}) == (409, {'error': STORED_BRANCH_MISSING})
    with pytest.raises(NoConnection):
        Broker(None).head(START, 'conn-1', REPOSITORY, 'main')


@pytest.mark.parametrize(('body', 'run', 'named'), [
    ('Fix the refund total.', record(), 'Fix the refund total.\n\nFixes #42'),
    ('Fix the refund total.\n\n', record(issue_host='gitlab'), 'Fix the refund total.\n\nCloses #42'),
    ('Fixes #42: the total.', record(), 'Fixes #42: the total.'),
    ('See #420 and owner/repo#42.', record(), 'See #420 and owner/repo#42.\n\nFixes #42'),
    ('Fix the refund total.', record(issue_number=None), 'Fix the refund total.'),
])
def test_a_pull_request_names_the_issue_its_run_started_from(body: str, run: Any, named: str) -> None:
    assert closing_body(body, replace(run)) == named
