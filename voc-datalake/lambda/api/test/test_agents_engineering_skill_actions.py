"""The Agents API's actions on a skill version (``POST /agents/engineering/skills/<role>/versions/<n>/accept``,
``…/reject``, ``…/rollback``, ``…/benchmark``; engineering/skills/actions.py, the store's own transactions).

Administrators acting for themselves only (a plain user and a delegated MCP credential get 403), 404 while the module
is off, 400 for a body off its shape, 409 when what the screen showed moved or the store refuses (a coach's version
without a passing benchmark, a second benchmark, a rollback to a version never accepted), each scope's writes its own,
and the person's reason redacted.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import patch

import pytest
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import call as _call
from engineering_skills_fixtures import (
    CONN,
    DELEGATED_ADMIN,
    OTHER,
    PERSON,
    WS,
    SkillsEnv,
    engineering_skills,
    propose_as_coach,
)

from engineering.board.test.table import TABLE
from engineering.knowledge.store import Actor
from engineering.skills.model import Reason
from engineering.skills.store import SHARED, SkillRef
from engineering.skills.test.fixtures import content, stricter

VERSIONS = '/agents/engineering/skills/fixer/versions'
#: Another administrator, acting in the same scope meanwhile.
OTHER_ADMIN = Actor('admin-sub-2', 'person', admin=True)
GAINED = {'before': 0.5, 'after': 1.0, 'cases': ['slug-cut-bug', 'pagination-review'], 'passed': True,
          'reasons': ["slug-cut-bug, the failure's case, gained"], 'failure_case': 'slug-cut-bug'}
SECRET = 'AKIA' + 'Z' * 16


@dataclass
class Env(SkillsEnv):
    def shared(self, proposals: int = 1) -> None:
        """The shared Fixer v1, accepted, and ``proposals`` people's proposals on it (v2, v3, ...)."""
        super().shared()
        for n in range(proposals):
            self.skills.propose_version(WS, SHARED, 'fixer', content(stricter().instructions + f'\nRule {n}.'),
                                        proposer=PERSON, base=SkillRef(SHARED, 1), reason=Reason(comment=f'Rule {n}.'))

    def coach(self) -> None:
        """The coach's proposal for CONN on the shared v1, expecting to gain on slug-cut-bug, not yet measured."""
        propose_as_coach(self.skills)

    def status(self, connection: str, version: int) -> str:
        return self.skills.version(WS, connection, 'fixer', version).status


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    with engineering_skills(monkeypatch) as table:
        yield Env(*table)


def _post(lambda_context: Any, path: str, body: dict[str, Any], connection: str = '',
          claims: dict[str, Any] = ADMIN) -> tuple[int, dict[str, Any]]:
    return _call(lambda_context, 'POST', f'{VERSIONS}/{path}', body=body, query={'connection': connection},
                 claims=claims)


ACCEPT = {'expected_status': 'proposed', 'expected_current': 1}


def test_an_administrator_accepts_a_proposal_with_its_event_and_announcement(lambda_context: Any, env: Env) -> None:
    env.shared()
    status, answer = _post(lambda_context, '2/accept', {**ACCEPT, 'reason': 'Clearer tests.'})
    assert (status, answer['version']['status'], answer['event']['comment']) == (200, 'accepted', 'Clearer tests.')
    assert (answer['announcement']['type'], answer['announcement']['published']) == ('skill.accepted', False)
    log = env.client.get_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WS}#SKILL##fixer'},
                                                    'sk': {'S': 'LOG#000002#accepted'}})['Item']
    assert log['announcement_id']['S'] == answer['announcement']['id']   # (recorded on its log row)


def test_an_administrator_rejects_a_proposal(lambda_context: Any, env: Env) -> None:
    env.shared()
    status, answer = _post(lambda_context, '2/reject', {'expected_status': 'proposed', 'reason': 'Too strict.'})
    assert (status, answer['version']['status'], answer['event']['event']) == (200, 'rejected', 'rejected')
    assert answer['announcement'] is None


def test_an_administrator_rolls_back_to_an_earlier_accepted_version_as_a_new_one(lambda_context: Any,
                                                                                 env: Env) -> None:
    env.shared()
    assert _post(lambda_context, '2/accept', ACCEPT)[0] == 200
    status, answer = _post(lambda_context, '1/rollback', {'expected_current': 2, 'reason': 'Back to the first.'})
    assert (status, answer['version']['version'], answer['version']['restores']) == (200, 3, 1)
    assert (answer['event']['event'], answer['announcement']['type']) == ('rolled_back', 'skill.rolled_back')
    assert env.status(SHARED, 3) == 'accepted'


def test_an_administrator_records_a_benchmark_once(lambda_context: Any, env: Env) -> None:
    env.shared()
    status, answer = _post(lambda_context, '2/benchmark', {'expected_status': 'proposed', **GAINED})
    assert (status, answer['version']['benchmark']['measured']['gained'], answer['event']['event']) == (
        200, True, 'benchmarked')
    status, again = _post(lambda_context, '2/benchmark', {'expected_status': 'proposed', **GAINED})
    assert (status, 'measured once' in again['error']) == (409, True)


def test_a_coachs_version_is_accepted_only_once_its_benchmark_passed_with_a_gain(lambda_context: Any,
                                                                                 env: Env) -> None:
    env.shared()
    env.coach()
    accept = {'expected_status': 'proposed', 'expected_current': 0}
    status, refused = _post(lambda_context, '1/accept', accept, CONN)
    assert (status, 'has no recorded benchmark' in refused['error'], env.status(CONN, 1)) == (409, True, 'proposed')
    assert _post(lambda_context, '1/benchmark', {'expected_status': 'proposed', **GAINED}, CONN)[0] == 200
    assert _post(lambda_context, '1/accept', accept, CONN)[0] == 200


def test_a_coachs_version_takes_only_a_benchmark_naming_its_expected_case(lambda_context: Any, env: Env) -> None:
    env.shared()
    env.coach()
    other = {**GAINED, 'failure_case': 'pagination-review'}
    status, refused = _post(lambda_context, '1/benchmark', {'expected_status': 'proposed', **other}, CONN)
    assert (status, 'slug-cut-bug' in refused['error']) == (400, True)


def test_a_failed_benchmark_keeps_a_coachs_version_from_acceptance(lambda_context: Any, env: Env) -> None:
    env.shared()
    env.coach()
    failed = {**GAINED, 'after': 0.5, 'passed': False, 'reasons': ['pagination-review regressed']}
    assert _post(lambda_context, '1/benchmark', {'expected_status': 'proposed', **failed}, CONN)[0] == 200
    status, refused = _post(lambda_context, '1/accept', {'expected_status': 'proposed', 'expected_current': 0}, CONN)
    assert (status, 'failed its benchmark' in refused['error']) == (409, True)


def test_equal_rates_are_no_gain_and_keep_a_coachs_version_from_acceptance(lambda_context: Any, env: Env) -> None:
    env.shared()
    env.coach()
    level = {**GAINED, 'before': 0.8, 'after': 0.8}
    status, recorded = _post(lambda_context, '1/benchmark', {'expected_status': 'proposed', **level}, CONN)
    assert (status, recorded['version']['benchmark']['measured']['gained']) == (200, False)
    status, refused = _post(lambda_context, '1/accept', {'expected_status': 'proposed', 'expected_current': 0}, CONN)
    assert (status, 'its pass rate did not rise' in refused['error'], env.status(CONN, 1)) == (409, True, 'proposed')


def test_a_benchmarks_reasons_and_run_reference_are_redacted(lambda_context: Any, env: Env) -> None:
    env.shared()
    body = {'expected_status': 'proposed', **GAINED, 'reasons': [f'ran with {SECRET}'], 'run_ref': f'run-7 {SECRET}'}
    status, answer = _post(lambda_context, '2/benchmark', body)
    measured = answer['version']['benchmark']['measured']
    assert (status, SECRET in json.dumps(measured), measured['run_ref'].startswith('run-7')) == (200, False, True)


def test_a_benchmark_ticked_passed_whose_rates_fell_is_refused(lambda_context: Any, env: Env) -> None:
    env.shared()
    env.coach()
    regressed = {**GAINED, 'before': 0.9, 'after': 0.5}
    status, refused = _post(lambda_context, '1/benchmark', {'expected_status': 'proposed', **regressed}, CONN)
    assert (status, 'record it as failed' in refused['error']) == (400, True)
    assert env.skills.version(WS, CONN, 'fixer', 1).benchmark_run is None


def test_a_rollback_holds_the_current_version_the_person_saw_in_its_write(env: Env) -> None:
    """The store compares the current version the person saw with the one it reads, the one its transaction then
    holds: a version accepted between the screen's read and the rollback is never replaced silently."""
    from engineering.skills.store import CHANGED, SkillConflict

    env.shared()
    env.skills.accept_version(WS, SHARED, 'fixer', 2, PERSON)
    with pytest.raises(SkillConflict, match=CHANGED):
        env.skills.roll_back_to(WS, SHARED, 'fixer', 1, PERSON, expected_current=1)
    head = env.skills.head(WS, SHARED, 'fixer')
    assert (head.current_version if head else 0, head.versions if head else 0) == (2, 2)


def test_a_write_the_table_refuses_is_a_503_that_says_it_was_not_saved(lambda_context: Any, env: Env) -> None:
    from botocore.exceptions import ClientError

    env.shared()
    refused = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}},
                          'TransactWriteItems')
    with patch.object(env.client, 'transact_write_items', side_effect=refused):
        status, body = _post(lambda_context, '2/reject', {'expected_status': 'proposed'})
    assert (status, body['error']) == (503, 'the skill version could not be saved: read it again and retry')


def test_a_rollback_to_a_version_never_accepted_is_refused(lambda_context: Any, env: Env) -> None:
    env.shared(proposals=2)
    assert _post(lambda_context, '3/accept', {**ACCEPT, 'expected_current': 1})[0] == 200
    status, refused = _post(lambda_context, '2/rollback', {'expected_current': 3})
    assert (status, 'never accepted' in refused['error']) == (409, True)


@pytest.mark.parametrize(('path', 'body', 'said'), [
    ('2/accept', {'expected_status': 'proposed', 'expected_current': 2}, 'current version was v2 and is v1'),
    ('1/rollback', {'expected_current': 3}, 'current version was v3 and is v1'),
], ids=['accept: current moved', 'rollback: current moved'])
def test_a_current_version_that_moved_since_the_screen_read_it_is_409_and_nothing_is_written(
        lambda_context: Any, env: Env, path: str, body: dict[str, Any], said: str) -> None:
    env.shared()
    status, refused = _post(lambda_context, path, body)
    assert (status, 'it changed since you opened it' in refused['error'], said in refused['error']) == (409, True, True)
    head = env.skills.head(WS, SHARED, 'fixer')
    assert (env.status(SHARED, 2), head.current_version if head else 0) == ('proposed', 1)


@pytest.mark.parametrize(('path', 'body'), [
    ('2/accept', ACCEPT), ('2/reject', {'expected_status': 'proposed'}),
    ('2/benchmark', {'expected_status': 'proposed', **GAINED}),
], ids=['accept', 'reject', 'benchmark'])
def test_a_proposal_another_administrator_rejected_meanwhile_is_409(lambda_context: Any, env: Env, path: str,
                                                                     body: dict[str, Any]) -> None:
    env.shared()
    env.skills.reject_version(WS, SHARED, 'fixer', 2, OTHER_ADMIN)
    status, refused = _post(lambda_context, path, body)
    assert (status, refused['error'].startswith('it changed since you opened it: version 2 was proposed and is rejected')) == (
        409, True)


def test_a_rejection_that_loses_its_race_to_an_acceptance_is_409_it_changed(lambda_context: Any, env: Env) -> None:
    """A rejects while B accepts: A's read sees the proposal, B's acceptance lands before A's transaction, and A's
    transaction is refused by its own condition, said as a change the screen reloads for."""
    env.shared()
    real = env.client.transact_write_items
    raced: list[bool] = []

    def accept_first(**request: Any) -> Any:
        if not raced:
            raced.append(True)
            env.skills.accept_version(WS, SHARED, 'fixer', 2, OTHER_ADMIN)
        return real(**request)

    with patch.object(env.client, 'transact_write_items', side_effect=accept_first):
        status, refused = _post(lambda_context, '2/reject', {'expected_status': 'proposed'})
    assert (status, refused['error'].startswith('it changed since you opened it')) == (409, True)
    assert env.status(SHARED, 2) == 'accepted'


def test_a_base_that_moved_meanwhile_is_409(lambda_context: Any, env: Env) -> None:
    env.shared(proposals=2)
    assert _post(lambda_context, '2/accept', ACCEPT)[0] == 200
    # (version 3 was written on v1; v2 is current now, as the screen that read it again shows)
    status, refused = _post(lambda_context, '3/accept', {**ACCEPT, 'expected_current': 2})
    assert (status, 'propose it again on the current version' in refused['error']) == (409, True)


@pytest.mark.parametrize(('path', 'body'), [
    ('2/accept', {}), ('2/accept', {'expected_status': 'proposed', 'expected_current': -1}),
    ('2/accept', {'expected_status': 'proposed', 'expected_current': True}),
    ('2/accept', {**ACCEPT, 'extra': 1}), ('2/accept', {**ACCEPT, 'reason': 7}),
    ('2/accept', {**ACCEPT, 'reason': 'x' * 2001}), ('2/reject', {'expected_status': 'gone'}),
    ('1/rollback', {'expected_current': '1'}), ('2/benchmark', {'expected_status': 'proposed'}),
    ('2/benchmark', {'expected_status': 'proposed', **GAINED, 'before': 2}),
    ('2/benchmark', {'expected_status': 'proposed', **GAINED, 'cases': 'slug-cut-bug'}),
    ('0/accept', ACCEPT), ('abc/reject', {'expected_status': 'proposed'}),
    ('2/accept', {**ACCEPT, 'expected_status': 'accepted'}), ('2/benchmark', {**GAINED, 'expected_status': 'rejected'}),
    ('2/benchmark', {'expected_status': 'proposed', **GAINED, 'run_ref': 'x' * 301}),
    ('2/benchmark', {'expected_status': 'proposed', **GAINED, 'reasons': ['x' * 401]}),
], ids=['accept empty', 'accept negative', 'accept bool', 'accept extra', 'reason not text', 'reason too long',
        'reject status', 'rollback text', 'benchmark missing', 'benchmark rate', 'benchmark cases', 'version 0',
        'version text', 'accept not proposed', 'benchmark not proposed', 'run ref too long', 'reason of a case too long'])
def test_a_body_or_path_off_its_shape_is_400(lambda_context: Any, env: Env, path: str, body: dict[str, Any]) -> None:
    env.shared()
    assert _post(lambda_context, path, body)[0] == 400


def test_a_bad_role_or_connection_is_400(lambda_context: Any, env: Env) -> None:
    env.shared()
    assert _call(lambda_context, 'POST', '/agents/engineering/skills/wizard/versions/2/accept', body=ACCEPT)[0] == 400
    assert _post(lambda_context, '2/accept', ACCEPT, connection='Bad_Id')[0] == 400


def test_an_administrator_acts_on_a_scope_only_through_its_own_partitions(lambda_context: Any, env: Env) -> None:
    env.shared()
    env.coach()
    # The coach's v1 is CONN's: OTHER has no such version, and the shared v1 is accepted, not this proposal.
    assert _post(lambda_context, '1/reject', {'expected_status': 'proposed'}, OTHER)[0] == 404
    assert _post(lambda_context, '1/reject', {'expected_status': 'proposed'}, CONN)[0] == 200
    assert (env.status(CONN, 1), env.status(SHARED, 1)) == ('rejected', 'accepted')


def test_the_reason_is_redacted_before_it_is_stored(lambda_context: Any, env: Env) -> None:
    env.shared()
    _, answer = _post(lambda_context, '2/reject', {'expected_status': 'proposed', 'reason': f'key {SECRET} leaked'})
    assert SECRET not in answer['event']['comment']
    stored = env.client.get_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WS}#SKILL##fixer'},
                                                       'sk': {'S': 'LOG#000002#rejected'}})['Item']
    assert SECRET not in stored['comment']['S']


ACTIONS = (('2/accept', ACCEPT), ('2/reject', {'expected_status': 'proposed'}), ('1/rollback', {'expected_current': 1}),
           ('2/benchmark', {'expected_status': 'proposed', **GAINED}))


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_every_action_is_403_for_anyone_but_an_administrator_acting_for_themselves(lambda_context: Any, env: Env,
                                                                                   claims: dict[str, Any]) -> None:
    env.shared()
    assert [_post(lambda_context, path, body, claims=claims)[0] for path, body in ACTIONS] == [403] * len(ACTIONS)
    assert env.status(SHARED, 2) == 'proposed'


@pytest.mark.usefixtures('env')
@pytest.mark.parametrize('missing', ['ENGINEERING_AGENTS', 'ENGINEERING_TABLE'])
def test_every_action_is_404_while_the_module_is_off(lambda_context: Any, monkeypatch: pytest.MonkeyPatch,
                                                     missing: str) -> None:
    monkeypatch.delenv(missing)
    for claims in (ADMIN, USER):
        assert [_post(lambda_context, path, body, claims=claims)[0] for path, body in ACTIONS] == [404] * len(ACTIONS)
