"""The Agents API's reads of the agents' skills and scorecards (``GET /agents/engineering/skills``,
``…/skills/<role>/versions[/<version>]``, ``GET /agents/engineering/scorecards/<role>``; engineering/skills/views.py).

Read only, by administrators acting for themselves (a plain user and a delegated MCP credential get 403), and only with
the engineering module on (404 for everyone otherwise). Every input is checked (400), a page token is the server's own
and checked, a connection reads only its own partitions, and a promoted version's source connection is never answered.
"""
from __future__ import annotations

import base64
import json
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from unittest.mock import patch

import pytest
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import call as _call
from botocore.exceptions import ClientError
from engineering_skills_fixtures import CONN, DELEGATED_ADMIN, OTHER, PERSON, WS, engineering_skills, propose_as_coach

from engineering.board.test.table import TABLE
from engineering.learning.retrospective import RunRecord, ScoreLine
from engineering.learning.scorecard import ScorecardStore
from engineering.skills.model import BenchmarkRun, Reason
from engineering.skills.store import SHARED, SkillRef, SkillStore
from engineering.skills.test.fixtures import INSTRUCTIONS, content, stricter
from engineering.skills.views import page_token

SKILLS = '/agents/engineering/skills'
HISTORY = f'{SKILLS}/fixer/versions'
SCORES = '/agents/engineering/scorecards/fixer'
CASES = ('slug-cut-bug', 'pagination-review')
GAINED = BenchmarkRun(before=0.5, after=1.0, cases=CASES, passed=True, failure_case='slug-cut-bug',
                      reasons=("slug-cut-bug, the failure's case, gained",))
PATHS = (SKILLS, HISTORY, f'{HISTORY}/1', SCORES)


@dataclass
class Env:
    client: Any
    skills: SkillStore

    def shared_v1(self) -> None:
        """The shared Fixer skill's first version, an administrator's, accepted."""
        proposed = self.skills.propose_version(WS, SHARED, 'fixer', content(), proposer=PERSON,
                                               reason=Reason(comment='The first Fixer skill.'), base=None)
        self.skills.accept_version(WS, SHARED, 'fixer', proposed.version.version, PERSON)

    def shared_v2(self) -> None:
        """The shared v1, and a person's stricter v2 proposed on it."""
        self.shared_v1()
        self.skills.propose_version(WS, SHARED, 'fixer', stricter(), proposer=PERSON, base=SkillRef(SHARED, 1),
                                    reason=Reason(comment='A stricter test rule.'))

    def coach_v1(self) -> None:
        """The coach's version for CONN on the shared v1, measured with a gain and accepted."""
        propose_as_coach(self.skills)
        self.skills.record_benchmark(WS, CONN, 'fixer', 1, GAINED, PERSON)
        self.skills.accept_version(WS, CONN, 'fixer', 1, PERSON)

    def score(self, version: str, run_id: str, done: int) -> None:
        record = RunRecord(ws=WS, run_id=run_id, connection=CONN, status='done', started_at='2026-11-13T08:00:00Z',
                           ended_at='2026-11-13T09:00:00Z', tasks=(), history={}, agents=())
        ScorecardStore(self.client, TABLE).write(record, ScoreLine(
            'fixer', version, tasks_done=done, tasks_failed=1, needs_human=1, reposts=0, review_rounds=2,
            attempts=4, cost_usd=Decimal('0.75'), seconds=600))


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    """The reads' tables, with the readers' helpers."""
    with engineering_skills(monkeypatch) as table:
        yield Env(*table)


def test_an_administrator_reads_the_shared_roles_their_history_and_a_versions_diff(lambda_context: Any,
                                                                                   env: Env) -> None:
    env.shared_v2()
    env.skills.reject_version(WS, SHARED, 'fixer', 2, PERSON, 'Too strict for small fixes.')
    status, roles = _call(lambda_context, 'GET', SKILLS)
    assert (status, [(r['role'], r['current_version'], r['versions']) for r in roles['roles']]) == (200, [('fixer', 1, 2)])
    assert roles['roles'][0]['latest']['status'] == 'rejected'
    status, history = _call(lambda_context, 'GET', HISTORY)
    assert (status, [v['version'] for v in history['versions']], history['next_page']) == (200, [2, 1], None)
    assert history['versions'][0]['events'] == [
        {'event': 'rejected', 'by': 'admin-sub', 'at': history['versions'][0]['rejected_at'],
         'comment': 'Too strict for small fixes.'}]


def test_a_version_answers_its_record_and_its_diff_from_its_base(lambda_context: Any, env: Env) -> None:
    env.shared_v2()
    status, found = _call(lambda_context, 'GET', f'{HISTORY}/2')
    version = found['version']
    assert (status, version['base'], version['status'], version['why']['comment']) == (
        200, {'shared': True, 'version': 1}, 'proposed', 'A stricter test rule.')
    assert version['record']['instructions'] == stricter().instructions
    assert version['diff']['instructions'] == [['+', "Run the package's whole test suite before you submit."]]


def test_a_connection_reads_its_own_versions_with_the_benchmark_measured_apart_from_the_claim(
        lambda_context: Any, env: Env) -> None:
    env.shared_v1()
    env.coach_v1()
    status, roles = _call(lambda_context, 'GET', SKILLS, query={'connection': CONN})
    assert (status, roles['connection'], [r['role'] for r in roles['roles']]) == (200, CONN, ['fixer'])
    line = _call(lambda_context, 'GET', HISTORY, query={'connection': CONN})[1]['versions'][0]
    assert (line['proposed_by_kind'], line['expected_case'], line['benchmark']['claimed']) == ('agent', 'slug-cut-bug', None)
    assert line['benchmark']['measured'] == {'before': 0.5, 'after': 1.0, 'passed': True, 'gained': True,
                                             'failure_case': 'slug-cut-bug', 'cases': 2, 'reasons': list(GAINED.reasons),
                                             'run_ref': '', 'by': 'admin-sub', 'at': line['benchmark']['measured']['at']}
    assert [event['event'] for event in line['events']] == ['accepted', 'benchmarked']


def test_a_proposers_claimed_rates_are_answered_as_a_claim_only(lambda_context: Any, env: Env) -> None:
    from engineering.skills.model import Benchmark

    env.shared_v1()
    env.skills.propose_version(WS, SHARED, 'fixer', stricter(), proposer=PERSON, base=SkillRef(SHARED, 1),
                               reason=Reason(comment='Measured on my laptop.'), benchmark=Benchmark(0.5, 0.9))
    line = _call(lambda_context, 'GET', HISTORY)[1]['versions'][0]
    assert line['benchmark'] == {'claimed': {'before': 0.5, 'after': 0.9}, 'measured': None}


def test_each_scope_reads_only_its_own_partitions(lambda_context: Any, env: Env) -> None:
    env.shared_v1()
    env.coach_v1()
    assert _call(lambda_context, 'GET', SKILLS, query={'connection': OTHER})[1]['roles'] == []
    assert _call(lambda_context, 'GET', HISTORY, query={'connection': OTHER})[1]['versions'] == []
    # The shared history is the shared skill's alone: the connection's version is not in it.
    shared = _call(lambda_context, 'GET', HISTORY)[1]['versions']
    assert [(v['version'], v['proposed_by_kind']) for v in shared] == [(1, 'person')]
    assert _call(lambda_context, 'GET', f'{HISTORY}/1', query={'connection': OTHER})[0] == 404


def test_a_promoted_versions_source_connection_is_never_answered(lambda_context: Any, env: Env) -> None:
    env.shared_v1()
    env.coach_v1()
    env.skills.promote_version(WS, 'fixer', SkillRef(CONN, 1), content(INSTRUCTIONS + '\nCheck the tests.'),
                               by=PERSON, reason=Reason(comment='What a connection taught, in general terms.'),
                               base=SkillRef(SHARED, 1))
    log = env.client.get_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WS}#SKILL##fixer'},
                                                    'sk': {'S': 'LOG#000002#promoted_from'}})
    assert log['Item']['source_connection']['S'] == CONN   # (it is recorded, for an administrator's own read)
    answers = [_call(lambda_context, 'GET', path)[1] for path in (SKILLS, HISTORY, f'{HISTORY}/2')]
    assert [v['version'] for v in answers[1]['versions']] == [2, 1]
    assert CONN not in json.dumps(answers)
    assert 'promoted' not in json.dumps(answers)


def _proposals(env: Env, count: int) -> None:
    for n in range(count):
        env.skills.propose_version(WS, SHARED, 'fixer', content(INSTRUCTIONS + f'\nProposal {n}.'), proposer=PERSON,
                                   base=SkillRef(SHARED, 1), reason=Reason(comment=f'Proposal {n}.'))


def test_the_history_is_read_a_page_at_a_time_newest_first(lambda_context: Any, env: Env) -> None:
    env.shared_v1()
    _proposals(env, 22)
    first = _call(lambda_context, 'GET', HISTORY)[1]
    assert [v['version'] for v in first['versions']] == list(range(23, 3, -1))
    status, second = _call(lambda_context, 'GET', HISTORY, query={'page': first['next_page']})
    assert (status, [v['version'] for v in second['versions']], second['next_page']) == (200, [3, 2, 1], None)
    assert [e['event'] for e in second['versions'][2]['events']] == ['accepted']


def _tampered(token: str) -> str:
    text = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4)).decode()
    return base64.urlsafe_b64encode(text.replace('#4#', '#9#').encode()).decode().rstrip('=')


@pytest.mark.parametrize('token', [
    'not a token', '%%%', 'A' * 401, page_token(SHARED, 'mapper', 4), page_token(CONN, 'fixer', 4),
    base64.urlsafe_b64encode(b'#fixer#4#0000000000000000').decode().rstrip('='), _tampered(page_token(SHARED, 'fixer', 4)),
], ids=['spaces', 'symbols', 'too long', 'another role', 'another scope', 'bad checksum', 'number changed'])
def test_a_page_token_not_made_for_this_history_is_refused(lambda_context: Any, env: Env, token: str) -> None:
    env.shared_v1()
    status, body = _call(lambda_context, 'GET', HISTORY, query={'page': token})
    assert (status, 'first page' in body['error']) == (400, True)


def test_the_token_made_for_this_history_is_read(lambda_context: Any, env: Env) -> None:
    env.shared_v1()
    _proposals(env, 4)
    page = _call(lambda_context, 'GET', HISTORY, query={'page': page_token(SHARED, 'fixer', 4)})[1]
    assert [v['version'] for v in page['versions']] == [3, 2, 1]


def test_the_scorecards_compare_the_versions_asked_for_on_the_connections_own_rows(lambda_context: Any,
                                                                                   env: Env) -> None:
    env.score('fixer@2', '01JD0000000000000000000010', done=2)
    env.score('fixer@3', '01JD0000000000000000000011', done=6)
    status, body = _call(lambda_context, 'GET', SCORES, query={'connection': CONN, 'versions': '3,2'})
    assert (status, body['versions'], [c['label'] for c in body['cards']]) == (200, [3, 2], ['fixer@3', 'fixer@2'])
    assert body['cards'][0] == {
        # (fixer ships as version 3 since 7.53.00, the bundle's: a version asked for by number is labelled by that)
        'version': 3, 'source': 'shipped', 'label': 'fixer@3', 'runs': 1, 'pass_rate': 0.75, 'tasks_done': 6, 'tasks_failed': 1,
        'needs_human': 1, 'reposts': 0, 'review_rounds': 2, 'attempts': 4, 'cost_usd': 0.75, 'seconds': 600,
        'more': False, 'since': '2026-11-13T08:00:00Z', 'until': '2026-11-13T09:00:00Z',
        'human_edits': {'runs': 0, 'changes_requested': 0, 'people_commits_after_merge': 0, 'reverts': 0, 'more': False}}
    other = _call(lambda_context, 'GET', SCORES, query={'connection': OTHER, 'versions': '3'})[1]
    assert other['cards'][0]['runs'] == 0


def test_by_default_the_scorecards_show_the_shipped_versions_only_never_the_stores_numbers(lambda_context: Any,
                                                                                           env: Env) -> None:
    env.shared_v1()
    _proposals(env, 6)   # (shared versions 1-7 in the store: their numbers are never offered as scorecards)
    env.score('fixer@2', '01JD0000000000000000000010', done=3)
    status, body = _call(lambda_context, 'GET', SCORES, query={'connection': CONN})
    # (fixer ships as version 4 since 7.56.00, the compiled bundle's: the shipped one and the ones before it)
    assert (status, body['versions'], body['source'], body['scope_known']) == (200, [4, 3, 2, 1], 'shipped', False)
    assert [(c['version'], c['source'], c['runs']) for c in body['cards']] == [
        (4, 'shipped', 0), (3, 'shipped', 0), (2, 'shipped', 1), (1, 'shipped', 0)]
    coordinator = _call(lambda_context, 'GET', '/agents/engineering/scorecards/coordinator', query={'connection': CONN})[1]
    # (it ships as version 7 since 7.54.00: the shipped one and the ones before it, at most DEFAULT_COMPARED)
    assert coordinator['versions'] == [7, 6, 5, 4, 3]


@pytest.mark.usefixtures('env')
def test_a_role_that_ships_no_skill_has_no_default_scorecards(lambda_context: Any) -> None:
    status, body = _call(lambda_context, 'GET', '/agents/engineering/scorecards/coach', query={'connection': CONN})
    assert (status, body['versions'], body['cards']) == (200, [], [])


def test_a_history_page_whose_versions_sit_far_apart_reads_its_events(lambda_context: Any, env: Env) -> None:
    env.shared_v1()
    # (numbers taken by proposals refused after their number was handed out: the page spans 1 to 302)
    for skipped in (150, 149):
        env.client.update_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WS}#SKILL##fixer'}, 'sk': {'S': 'HEAD'}},
                               UpdateExpression='ADD versions :n', ExpressionAttributeValues={':n': {'N': str(skipped)}})
        _proposals(env, 1)
    env.skills.reject_version(WS, SHARED, 'fixer', 302, PERSON, 'Not now.')
    status, page = _call(lambda_context, 'GET', HISTORY)
    assert (status, [v['version'] for v in page['versions']]) == (200, [302, 152, 1])
    assert [[e['event'] for e in v['events']] for v in page['versions']] == [['rejected'], [], ['accepted']]


@pytest.mark.parametrize(('path', 'query'), [
    (f'{SKILLS}/wizard/versions', {}), (f'{SKILLS}/wizard/versions/1', {}), ('/agents/engineering/scorecards/wizard',
                                                                            {'connection': CONN}),
    (f'{HISTORY}/0', {}), (f'{HISTORY}/abc', {}), (f'{HISTORY}/1000000', {}), (f'{HISTORY}/01', {}),
    (SKILLS, {'connection': 'Harbor_Conn'}), (HISTORY, {'connection': 'a#b'}), (SKILLS, {'connection': '-x'}),
    (SCORES, {}), (SCORES, {'connection': CONN, 'versions': '1,1'}), (SCORES, {'connection': CONN, 'versions': 'x'}),
    (SCORES, {'connection': CONN, 'versions': ','.join(str(n) for n in range(1, 12))}),
    (SCORES, {'connection': CONN, 'versions': '0'}),
], ids=['history role', 'version role', 'scorecard role', 'version 0', 'version text', 'version too big',
        'leading zero', 'connection shape', 'connection hash', 'connection dash', 'scorecards shared',
        'versions twice', 'versions text', 'versions eleven', 'versions zero'])
def test_each_input_off_its_shape_is_400(lambda_context: Any, env: Env, path: str, query: dict[str, str]) -> None:
    env.shared_v1()
    assert _call(lambda_context, 'GET', path, query=query)[0] == 400


def test_a_version_the_scope_does_not_have_is_404(lambda_context: Any, env: Env) -> None:
    env.shared_v1()
    assert _call(lambda_context, 'GET', f'{HISTORY}/2')[0] == 404


@pytest.mark.usefixtures('env')
@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_every_read_is_403_for_anyone_but_an_administrator_acting_for_themselves(lambda_context: Any,
                                                                                 claims: dict[str, Any]) -> None:
    assert [_call(lambda_context, 'GET', path, claims=claims)[0] for path in PATHS] == [403] * len(PATHS)
    # (before any input is checked: a non-admin learns nothing of the shapes either)
    assert _call(lambda_context, 'GET', f'{SKILLS}/wizard/versions', claims=claims)[0] == 403


@pytest.mark.usefixtures('env')
@pytest.mark.parametrize('missing', ['ENGINEERING_AGENTS', 'ENGINEERING_TABLE'])
def test_every_read_is_404_while_the_module_is_off(lambda_context: Any, monkeypatch: pytest.MonkeyPatch,
                                                   missing: str) -> None:
    monkeypatch.delenv(missing)
    for claims in (ADMIN, USER):
        assert [_call(lambda_context, 'GET', path, claims=claims)[0] for path in PATHS] == [404] * len(PATHS)


@pytest.mark.usefixtures('env')
def test_without_the_engineering_package_every_read_is_404_not_500(lambda_context: Any,
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('ENGINEERING_AGENTS')
    absent = dict.fromkeys(name for name in list(sys.modules) if name.split('.')[0] == 'engineering')
    with patch.dict(sys.modules, {**absent, 'engineering': None}):
        assert [_call(lambda_context, 'GET', path)[0] for path in PATHS] == [404] * len(PATHS)


def test_a_read_the_table_refuses_is_a_503(lambda_context: Any, env: Env) -> None:
    refused = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow down'}},
                          'GetItem')
    with patch.object(env.client, 'get_item', side_effect=refused):
        status, body = _call(lambda_context, 'GET', SKILLS)
    assert (status, body['error']) == (503, 'the skills could not be read: retry')
