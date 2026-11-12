"""The broker's caller, from the function URL's IAM identity only (docs/autonomous-engineering.md)."""
from __future__ import annotations

import pytest

from engineering.connectors.identity import (
    AGENT_ROLES,
    Caller,
    UnknownCaller,
    agent_role,
    caller_from_event,
    own_account,
)
from engineering.connectors.test.fakes import ACCOUNT, PATTERN, RUN, role_arn, url_event

#: The 64 characters STS allows in a role session name.
SESSION_NAME_LIMIT = 64


def caller(arn: str | None, account: str = ACCOUNT) -> Caller:
    return caller_from_event(url_event(arn), PATTERN, account)


@pytest.mark.parametrize('role', sorted(AGENT_ROLES))
def test_every_agent_role_is_known_by_its_iam_name(role: str) -> None:
    assert caller(role_arn(role)) == Caller(role=role, run_id=RUN, agent_index=3)


@pytest.mark.parametrize(('session', 'index'), [(f'{RUN}.0', 0), (f'{RUN}.12', 12), (f'{RUN}.999', 999)])
def test_reads_the_agent_index(session: str, index: int) -> None:
    assert caller(role_arn('fixer', session)).agent_index == index


def test_the_longest_session_name_it_accepts_fits_and_a_longer_one_is_refused() -> None:
    longest = f'{RUN}.999'   # 26 + 1 + 3 characters
    assert caller(role_arn('fixer', longest)).agent_index == 999
    assert len(longest) <= SESSION_NAME_LIMIT
    too_long = f'{RUN}.{"9" * (SESSION_NAME_LIMIT - len(RUN))}'
    assert len(too_long) == SESSION_NAME_LIMIT + 1
    with pytest.raises(UnknownCaller):
        caller(role_arn('fixer', too_long))


@pytest.mark.parametrize('session', [
    'run-7f3a.1',                    # not a ULID
    f'{RUN.lower()}.1',              # lower case
    f'{RUN[:-1]}U.1',                # a letter Crockford base32 leaves out
    f'{RUN}X.1',                     # 27 characters
    f'{RUN}.01',                     # a leading zero
    f'{RUN}.1000',                   # four digits
    f'{RUN}.',                       # no agent
    f'{RUN}',                        # no index at all
    f'{RUN}.1.2',                    # two indexes
    f'{RUN}.1@x',
    'x' * 65,                        # over the 64 characters a session name allows
])
def test_refuses_a_session_name_the_launcher_does_not_make(session: str) -> None:
    with pytest.raises(UnknownCaller):
        caller(role_arn('committer', session))


@pytest.mark.parametrize('arn', [
    f'arn:aws:iam::{ACCOUNT}:user/someone',
    f'arn:aws:iam::{ACCOUNT}:role/voc-eng-committer-{ACCOUNT}-us-east-1',
    f'arn:aws:sts::{ACCOUNT}:federated-user/someone',
    f'arn:aws:sts::{ACCOUNT}:assumed-role/voc-eng-committer-{ACCOUNT}-us-east-1',
    f'arn:aws:sts::12345:assumed-role/voc-eng-committer-{ACCOUNT}-us-east-1/{RUN}.1',
    f'arn:aws:sts::{ACCOUNT}:assumed-role/voc-eng-committer-{ACCOUNT}-us-east-1/{RUN}.1/extra',
    f' arn:aws:sts::{ACCOUNT}:assumed-role/voc-eng-committer-{ACCOUNT}-us-east-1/{RUN}.1',
    f'arn:aws:sts::{ACCOUNT}:assumed-role/voc-eng-committér-{ACCOUNT}-us-east-1/{RUN}.1',
    f'arn:aws:sts::{ACCOUNT}:assumed-role/{"r" * 65}/{RUN}.1',
    '',
])
def test_refuses_anything_but_an_assumed_role_session(arn: str) -> None:
    with pytest.raises(UnknownCaller):
        caller(arn)


def test_refuses_an_agent_role_session_of_another_account() -> None:
    assert caller(role_arn('committer', account=ACCOUNT)).role == 'committer'
    with pytest.raises(UnknownCaller):
        caller(role_arn('committer', account='222222222222'))


def test_refuses_every_caller_when_its_own_account_is_unknown() -> None:
    with pytest.raises(UnknownCaller):
        caller(role_arn('committer'), account='')


@pytest.mark.parametrize(('function_arn', 'account'), [
    (f'arn:aws:lambda:us-east-1:{ACCOUNT}:function:voc-engineering-broker', ACCOUNT),
    (f'arn:aws:lambda:us-east-1:{ACCOUNT}:function:voc-engineering-broker:live', ACCOUNT),
    ('arn:aws:lambda:us-east-1:12345:function:voc-engineering-broker', ''),
    (f'arn:aws:iam::{ACCOUNT}:role/x', ''),
    ('', ''),
    (None, ''),
])
def test_own_account_comes_from_the_function_arn(function_arn: object, account: str) -> None:
    assert own_account(function_arn) == account


@pytest.mark.parametrize('role_name', [
    f'voc-eng-admin-{ACCOUNT}-us-east-1',             # not an agent role
    f'voc-eng--{ACCOUNT}-us-east-1',                  # no role at all
    f'voc-eng-committer-{ACCOUNT}-eu-west-1',         # another region's (or deployment's) roles
    f'b-voc-eng-committer-{ACCOUNT}-us-east-1',       # a prefixed copy's roles
    f'voc-eng-committer-x-{ACCOUNT}-us-east-1',
    'voc-api-role',
])
def test_refuses_a_role_that_is_not_one_of_the_agent_roles(role_name: str) -> None:
    with pytest.raises(UnknownCaller):
        caller(f'arn:aws:sts::{ACCOUNT}:assumed-role/{role_name}/{RUN}.1')


@pytest.mark.parametrize('pattern', ['', 'voc-eng-committer', 'voc-{role}-{role}'])
def test_refuses_every_caller_without_a_pattern_of_one_placeholder(pattern: str) -> None:
    with pytest.raises(UnknownCaller):
        agent_role('voc-committer-committer', pattern)


def test_refuses_an_event_without_an_iam_identity() -> None:
    for event in [{}, {'requestContext': 'x'}, {'requestContext': {'authorizer': None}}, url_event(None),
                  {'requestContext': {'authorizer': {'iam': {'userArn': 42}}}}]:
        with pytest.raises(UnknownCaller):
            caller_from_event(event, PATTERN, ACCOUNT)


def test_never_takes_the_caller_from_the_body() -> None:
    body = {'role': 'committer', 'run_id': RUN, 'agent': 1}
    found = caller_from_event(url_event(role_arn('mapper', f'{RUN}.4'), body), PATTERN, ACCOUNT)
    assert (found.role, found.agent_index) == ('mapper', 4)
