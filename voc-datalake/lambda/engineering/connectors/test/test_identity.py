"""The caller's identity comes from its assumed-role ARN only: role by the pattern, run and agent by the session."""
from __future__ import annotations

from typing import Any

import pytest

from engineering.connectors.identity import Caller, UnknownCaller, agent_role, caller_from_event, own_account

ACCOUNT = '123456789012'
PATTERN = 'voc-eng-{role}-123456789012-us-east-1'
RUN = '01JD0000000000000000000000'


def event(arn: Any) -> dict[str, Any]:
    return {'requestContext': {'authorizer': {'iam': {'userArn': arn}}}}


def arn(role: str = 'fixer', session: str = f'{RUN}.2', account: str = ACCOUNT) -> str:
    return f'arn:aws:sts::{account}:assumed-role/voc-eng-{role}-123456789012-us-east-1/{session}'


def test_an_agent_of_a_run_is_known() -> None:
    assert caller_from_event(event(arn()), PATTERN, ACCOUNT) == Caller('fixer', RUN, 2)


@pytest.mark.parametrize('bad', [
    {}, {'requestContext': 'x'}, event(None), event('not an arn'), event(arn(account='210987654321')),
    event(arn(session='run-1.2')), event(arn(session=f'{RUN}.02')), event(arn(role='stranger')),
])
def test_anything_else_is_unknown(bad: dict[str, Any]) -> None:
    with pytest.raises(UnknownCaller):
        caller_from_event(bad, PATTERN, ACCOUNT)


def test_no_account_knows_nobody() -> None:
    with pytest.raises(UnknownCaller):
        caller_from_event(event(arn()), PATTERN, '')


@pytest.mark.parametrize(('name', 'pattern'), [
    ('voc-eng-fixer-x', 'voc-eng-x'), ('voc-eng-fixer-x', '{role}-{role}'), ('voc-eng--x', 'voc-eng-{role}-x'),
    ('other-fixer-x', 'voc-eng-{role}-x'),
])
def test_a_role_name_off_the_pattern_is_unknown(name: str, pattern: str) -> None:
    with pytest.raises(UnknownCaller):
        agent_role(name, pattern)


def test_the_own_account_is_the_function_arns() -> None:
    assert own_account(f'arn:aws:lambda:us-east-1:{ACCOUNT}:function:voc-board') == ACCOUNT
    assert own_account('arn:aws:lambda:us-east-1:12:function:voc-board') == ''
    assert own_account(None) == ''
