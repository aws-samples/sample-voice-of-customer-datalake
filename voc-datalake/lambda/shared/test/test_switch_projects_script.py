"""``scripts/projects/switch_projects.py``: the switch's upgrade check, run with the operator's credentials (7.100.00,
projects 3h-S0).

Against moto: the backfill's marker read first (missing or incomplete refuses, before any other reason); the switch
row read (current for the marker: ``already_switched``, a dry run too; stale: replaced; malformed: refused); the
writers judged by the backfill's own rule, before the walk and again after it; the retention worker's gap check
(jobs/retention/registries.py ``step``) walked to its end; a refusal writes nothing, names itself and says what to do
next; ``--apply`` writes the one row, conditioned on the marker as read; an AWS error exits 2 with its code and the
steps it took. The script is loaded by path.
"""
from __future__ import annotations

import sys
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from jobs.retention import registries
from shared import project_scope, project_walk
from shared.project_keys import REVIEW_REGISTRIES_MARKER_KEY, project_pk, project_type_pk
from shared.project_writes import register_deployment_project
from shared.test.moto_tables import (
    REVIEW_REGISTRIES_MARKER,
    create_projects_table_with_type_index,
    mark_review_registries_backfilled,
)
from shared.test.repo_paths import load_module_from_path, repo_root

_SCRIPT = repo_root() / 'scripts' / 'projects' / 'switch_projects.py'
NOW = '2026-11-27T12:00:00+00:00'
CLOCK = datetime(2026, 11, 27, 12, 0, tzinfo=UTC)
STAMP = '2026-11-01T00:00:00+00:00'
LATER = '2026-12-01T00:00:00+00:00'
ROLE_SESSION = 'arn:aws:sts::111122223333:assumed-role/Operator/someone@example.com'
ROLE = 'arn:aws:iam::111122223333:role/Operator'
DENIED = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'BatchGetItem')


@pytest.fixture(scope='module')
def script():
    module = load_module_from_path('switch_projects', _SCRIPT)
    try:
        yield module
    finally:
        sys.modules.pop(module.__name__, None)
        sys.modules.pop('backfill_review_registries', None)


@pytest.fixture
def table():
    with mock_aws():
        yield mark_review_registries_backfilled(create_projects_table_with_type_index('projects'))


def _writer(base: str, version: str | None = '7.99.0', status: str = 'Successful', minutes: int = 30) -> dict:
    return {'name': f'{base}-1-r', 'base': base, 'version': version, 'status': status, 'timeout': 900,
            'last_modified': CLOCK - timedelta(minutes=minutes)}


def _deployed(**writer: Any) -> Callable[[], list[dict[str, Any]]]:
    return lambda: [_writer('voc-projects-api', **writer), _writer('voc-projects-assist', version='7.98.0')]


def _check(script, table, **options: Any) -> dict[str, Any]:
    options.setdefault('deployed', _deployed())
    options.setdefault('apply', False)
    options.setdefault('identity', lambda: ROLE_SESSION)
    options.setdefault('now', lambda: NOW)
    return script.run_check(table, clock=lambda: CLOCK, **options)


def _projects(table, count: int, prefix: str = 'proj_switch') -> None:
    """Deployment projects as the create writes them: listed in PROJECT_IDS, then their META on gsi1-by-type."""
    for n in range(count):
        project_id = f'{prefix}_{n:04d}'
        register_deployment_project(table, project_id, STAMP)
        table.put_item(Item={'pk': project_pk(project_id, workspace=None), 'sk': 'META', 'project_id': project_id,
                             'created_at': STAMP, 'gsi1pk': project_type_pk(workspace=None), 'gsi1sk': STAMP})


def _unlisted(table, project_id: str = 'proj_unlisted_0001', listed_at: str = STAMP) -> None:
    """A live project on gsi1-by-type that PROJECT_IDS does not list (an older writer's), sorted by ``listed_at``."""
    table.put_item(Item={'pk': project_pk(project_id, workspace=None), 'sk': 'META', 'project_id': project_id,
                         'created_at': STAMP, 'gsi1pk': project_type_pk(workspace=None), 'gsi1sk': listed_at})


def _row(table) -> dict[str, Any] | None:
    return table.get_item(Key=dict(project_scope.SWITCH_KEY), ConsistentRead=True).get('Item')


def _rebackfill(table, at: str = LATER) -> None:
    """A new backfill's marker (an --unmark, then --apply)."""
    table.put_item(Item={**REVIEW_REGISTRIES_MARKER, 'completed_at': at})


def _refused(script, outcome: dict[str, Any], reason: str, next_step: str) -> None:
    assert (outcome['status'], outcome['reason'], outcome['written'], script.exit_code(outcome)) == (
        'refused', reason, False, 1)
    assert next_step in outcome['next_steps']


# ── Refusals: named, with next steps, writing nothing ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize('apply', [False, True])
def test_a_missing_marker_refuses_before_anything_else(script, table, apply):
    """With a gap and old writers too, the marker's failure is the one reported."""
    table.delete_item(Key=dict(REVIEW_REGISTRIES_MARKER_KEY))
    _unlisted(table)
    outcome = _check(script, table, apply=apply, deployed=_deployed(version='7.40.0'))
    _refused(script, outcome, script.NOT_BACKFILLED, 'backfill_review_registries.py --apply')
    assert (outcome['steps'], _row(table)) == (0, None)


@pytest.mark.parametrize('broken', [{'release': '7.47.0'}, {'completed_at': None}, {'projects_found': None}])
def test_an_incomplete_marker_refuses_as_a_missing_one(script, table, broken):
    marker = {**REVIEW_REGISTRIES_MARKER, **broken}
    table.put_item(Item={name: value for name, value in marker.items() if value is not None})
    _refused(script, _check(script, table, apply=True), script.NOT_BACKFILLED, '--apply')
    assert _row(table) is None


def test_a_missing_marker_refuses_even_with_a_switch_row(script, table):
    """After an --unmark the switch is off: the check says what is missing, not that it already switched."""
    _check(script, table, apply=True)
    table.delete_item(Key=dict(REVIEW_REGISTRIES_MARKER_KEY))
    _refused(script, _check(script, table), script.NOT_BACKFILLED, '--apply')


@pytest.mark.parametrize('writer', [{'version': '7.47.0'}, {'version': None}, {'status': 'Failed'},
                                    {'minutes': 1}])
def test_a_writer_older_than_7_48_or_not_settled_refuses(script, table, writer):
    _projects(table, 1)
    outcome = _check(script, table, apply=True, deployed=_deployed(**writer))
    _refused(script, outcome, script.WRITERS_NOT_READY, 'voc-projects-api')
    assert _row(table) is None


def test_a_missing_writer_refuses(script, table):
    outcome = _check(script, table, apply=True, deployed=lambda: [_writer('voc-projects-api')])
    _refused(script, outcome, script.WRITERS_NOT_READY, 'voc-projects-assist')


def test_a_writer_updated_during_the_walk_refuses(script, table):
    """The writers are read again after the walk; any change (here a new deploy's last_modified) refuses."""
    _projects(table, 1)
    reads = iter([_deployed()(), _deployed(minutes=25)()])
    outcome = _check(script, table, apply=True, deployed=lambda: next(reads))
    _refused(script, outcome, script.WRITERS_NOT_READY, 'changed during the check')
    assert _row(table) is None


def test_the_release_is_the_oldest_writers_at_the_second_read(script, table):
    _projects(table, 1)
    reads = iter([_deployed()(), _deployed()()])
    outcome = _check(script, table, apply=True, deployed=lambda: next(reads))
    assert (outcome['status'], (_row(table) or {}).get('release')) == ('switched', '7.98.0')


def test_a_gap_refuses_with_the_unmark_the_backfill_then_the_check_again(script, table):
    _projects(table, 3)
    _unlisted(table)
    outcome = _check(script, table, apply=True)
    _refused(script, outcome, script.INCOMPLETE, '--unmark')
    text = outcome['next_steps']
    assert text.index('--unmark') < text.index('--apply') < text.index('switch_projects.py')
    assert _row(table) is None


def test_a_gap_on_a_later_page_is_found(script, table):
    _projects(table, 4)
    _unlisted(table, 'proj_zz_unlisted_01', listed_at=LATER)  # last on the index
    with patch.object(project_walk, 'ID_PAGE', 2):
        outcome = _check(script, table, apply=True)
    _refused(script, outcome, script.INCOMPLETE, '--unmark')
    assert (outcome['steps'], _row(table)) == (3, None)


def test_past_its_step_cap_it_refuses_rather_than_switch_unchecked(script, table):
    _projects(table, 5)
    with patch.object(project_walk, 'ID_PAGE', 1):
        outcome = _check(script, table, apply=True, max_steps=3)
    _refused(script, outcome, script.TOO_MANY_STEPS, 'nothing was written')
    assert (outcome['steps'], _row(table)) == (3, None)


def test_the_step_cap_covers_ten_million_projects(script):
    assert script.MAX_STEPS * project_walk.ID_PAGE == 10_000_000


@pytest.mark.parametrize('change', [
    _rebackfill,
    lambda table: table.update_item(Key=dict(REVIEW_REGISTRIES_MARKER_KEY), UpdateExpression='SET #r = :r',
                                    ExpressionAttributeNames={'#r': 'release'}, ExpressionAttributeValues={':r': '7.99.0'}),
    lambda table: table.delete_item(Key=dict(REVIEW_REGISTRIES_MARKER_KEY)),
])
def test_a_marker_changed_during_the_walk_stops_the_write(script, table, change):
    """The write's ConditionCheck holds the marker to the completed_at and release the check read."""
    _projects(table, 1)
    real = registries.step

    def step_then_change(*args: Any) -> Any:
        following = real(*args)
        change(table)
        return following

    with patch.object(registries, 'step', side_effect=step_then_change):
        outcome = _check(script, table, apply=True)
    _refused(script, outcome, script.MARKER_CHANGED, 'run the check again')
    assert _row(table) is None


def test_a_malformed_switch_row_refuses_and_is_left_alone(script, table):
    table.put_item(Item={**project_scope.SWITCH_KEY, 'note': 'by hand'})
    outcome = _check(script, table, apply=True)
    _refused(script, outcome, script.SWITCH_ROW_MALFORMED, 'PROJECTS_SWITCH')
    assert _row(table) == {**project_scope.SWITCH_KEY, 'note': 'by hand'}


# ── A lost race ───────────────────────────────────────────────────────────────────────────────────────────────────

def _race(table, row: dict[str, Any]) -> Any:
    """A step that, once the walk ended, lets another writer put ``row`` (a second check, or a hand)."""
    real = registries.step

    def step(*args: Any) -> Any:
        following = real(*args)
        if following is None:
            table.put_item(Item=row)
        return following

    return patch.object(registries, 'step', side_effect=step)


def test_a_check_that_loses_the_race_to_another_reads_its_row_as_already_switched(script, table):
    _projects(table, 1)
    theirs = project_scope.switch_row(NOW, '7.98.0', 1, 1, REVIEW_REGISTRIES_MARKER['completed_at'], ROLE)
    with _race(table, theirs):
        outcome = _check(script, table, apply=True)
    assert (outcome['status'], outcome['written'], script.exit_code(outcome)) == ('already_switched', False, 0)
    assert _row(table) == theirs


def test_a_check_that_loses_the_race_to_a_malformed_row_refuses(script, table):
    _projects(table, 1)
    with _race(table, {**project_scope.SWITCH_KEY, 'note': 'by hand'}):
        outcome = _check(script, table, apply=True)
    _refused(script, outcome, script.SWITCH_ROW_MALFORMED, 'PROJECTS_SWITCH')


def test_a_check_that_loses_the_race_to_a_complete_row_for_another_marker_reads_it_as_changed(script, table):
    _projects(table, 1)
    theirs = project_scope.switch_row(NOW, '7.98.0', 1, 1, '2026-01-01T00:00:00+00:00', ROLE)
    with _race(table, theirs):
        outcome = _check(script, table, apply=True)
    _refused(script, outcome, script.SWITCH_ROW_CHANGED, 'run the check again')


def test_a_transaction_cancelled_for_another_reason_exits_two(script, table):
    _projects(table, 1)
    cancelled = ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': 'x'},
                             'CancellationReasons': [{'Code': 'None'}, {'Code': 'TransactionConflict'}]},
                            'TransactWriteItems')
    with patch.object(table.meta.client, 'transact_write_items', side_effect=cancelled):
        outcome = _check(script, table, apply=True)
    assert (outcome['status'], outcome['error_code'], script.exit_code(outcome)) == (
        'error', 'TransactionCanceledException', 2)


# ── A stale row: the marker it names was replaced ─────────────────────────────────────────────────────────────────

def test_a_row_for_an_older_marker_is_not_switched_and_the_check_replaces_it(script, table):
    _projects(table, 2)
    _check(script, table, apply=True)
    _rebackfill(table)
    assert project_scope.projects_switched(table) is False
    dry = _check(script, table)
    assert (dry['status'], (_row(table) or {}).get('marker_at')) == ('passed', REVIEW_REGISTRIES_MARKER['completed_at'])
    outcome = _check(script, table, apply=True)
    assert (outcome['status'], (_row(table) or {}).get('marker_at')) == ('switched', LATER)
    assert project_scope.projects_switched(table) is True


def test_a_stale_row_changed_during_the_walk_is_not_replaced(script, table):
    """The replacement is conditioned on the old row's marker_at: a row another check wrote meanwhile stays."""
    _projects(table, 1)
    _check(script, table, apply=True)
    _rebackfill(table)
    theirs = project_scope.switch_row(NOW, '7.98.0', 1, 1, LATER, ROLE)
    with _race(table, theirs):
        outcome = _check(script, table, apply=True)
    assert (outcome['status'], outcome['written']) == ('already_switched', False)
    assert _row(table) == theirs


def test_a_stale_row_deleted_during_the_walk_is_a_concurrent_change(script, table):
    """The replacement's condition fails on a row no longer there: the check says to run again, never "delete it"."""
    _projects(table, 1)
    _check(script, table, apply=True)
    _rebackfill(table)
    real = registries.step

    def step(*args: Any) -> Any:
        following = real(*args)
        if following is None:
            table.delete_item(Key=dict(project_scope.SWITCH_KEY))
        return following

    with patch.object(registries, 'step', side_effect=step):
        outcome = _check(script, table, apply=True)
    _refused(script, outcome, script.SWITCH_ROW_CHANGED, 'run the check again')
    assert 'delete it' not in outcome['next_steps']
    assert _row(table) is None


def test_replacing_a_stale_row_prints_the_earlier_checks_record(script, table):
    _projects(table, 1)
    with patch.object(script, 'applied_by', return_value='arn:aws:iam::111122223333:role/Earlier'):
        _check(script, table, apply=True, now=lambda: '2026-11-20T08:00:00+00:00')
    _rebackfill(table)
    for apply in (False, True):
        text = script.summary(_check(script, table, apply=apply))
        assert 'replac' in text
        assert '2026-11-20T08:00:00+00:00' in text
        assert 'arn:aws:iam::111122223333:role/Earlier' in text
        assert '7.98.0' in text


# ── Who applied it ────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(('caller', 'recorded'), [
    (ROLE_SESSION, ROLE),
    ('arn:aws-us-gov:sts::111122223333:assumed-role/path-free/session', 'arn:aws-us-gov:iam::111122223333:role/path-free'),
    ('arn:aws:iam::111122223333:user/ops/operator', 'arn:aws:iam::111122223333:user'),
    ('arn:aws:iam::111122223333:root', 'arn:aws:iam::111122223333:root'),
    ('arn:aws:sts::111122223333:federated-user/someone@example.com', 'arn:aws:sts::111122223333:federated-user'),])
def test_applied_by_drops_an_assumed_roles_session_name(script, caller, recorded):
    assert script.applied_by(caller) == recorded


def test_the_row_records_the_role_and_the_summary_prints_it(script, table):
    _projects(table, 1)
    outcome = _check(script, table, apply=True)
    assert (_row(table) or {}).get('applied_by') == ROLE
    assert 'someone@example.com' not in str(_row(table))
    assert ROLE in script.summary(outcome)


# ── AWS errors: exit 2, named, with the steps taken ───────────────────────────────────────────────────────────────

def test_an_aws_error_mid_walk_exits_two_with_its_code_and_real_step_count(script, table):
    _projects(table, 3)
    real = registries.step
    calls = {'n': 0}

    def fail_on_second(*args: Any) -> Any:
        calls['n'] += 1
        if calls['n'] == 2:
            raise DENIED
        return real(*args)

    with patch.object(project_walk, 'ID_PAGE', 1), patch.object(registries, 'step', side_effect=fail_on_second):
        outcome = _check(script, table, apply=True)
    assert (outcome['status'], outcome['error_code'], outcome['steps'], script.exit_code(outcome)) == (
        'error', 'AccessDeniedException', 1, 2)
    assert 'permission' in outcome['next_steps']
    assert _row(table) is None


def test_an_unreadable_registry_exits_two_by_a_public_name(script, table):
    _projects(table, 1)
    with patch.object(registries, 'step', side_effect=registries._RegistryUnreadable('x')):
        outcome = _check(script, table)
    assert (outcome['status'], outcome['error_code'], script.exit_code(outcome)) == ('error', 'RegistryUnreadable', 2)


@pytest.mark.parametrize(('error', 'code'), [
    (ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'no'}}, 'ListStackResources'), 'AccessDenied'),
    (ValueError('time data does not match'), 'ValueError'),
])
def test_a_failed_writers_read_exits_two(script, table, error, code):
    def failing() -> list[dict[str, Any]]:
        raise error

    outcome = _check(script, table, deployed=failing)
    assert (outcome['status'], outcome['error_code'], script.exit_code(outcome)) == ('error', code, 2)


def test_a_failed_identity_read_exits_two(script, table):
    def failing() -> str:
        raise ClientError({'Error': {'Code': 'ExpiredToken', 'Message': 'no'}}, 'GetCallerIdentity')

    outcome = _check(script, table, apply=True, identity=failing)
    assert (outcome['status'], outcome['error_code'], _row(table)) == ('error', 'ExpiredToken', None)


def test_main_prints_an_aws_error_before_the_check_and_exits_two(script, capsys, monkeypatch):
    monkeypatch.delenv('PROJECTS_TABLE', raising=False)  # the table is then read from the stack's output
    session = MagicMock()
    session.return_value.client.return_value.describe_stacks.side_effect = ClientError(
        {'Error': {'Code': 'ExpiredToken', 'Message': 'no'}}, 'DescribeStacks')
    with patch('boto3.session.Session', session):
        assert script.main([]) == 2
    assert 'ExpiredToken' in capsys.readouterr().err


def test_main_exits_two_when_the_stack_names_no_table(script, capsys, monkeypatch):
    monkeypatch.delenv('PROJECTS_TABLE', raising=False)
    session = MagicMock()
    session.return_value.client.return_value.describe_stacks.return_value = {'Stacks': [{'Outputs': []}]}
    with patch('boto3.session.Session', session):
        assert script.main([]) == 2
    assert '--projects-table' in capsys.readouterr().err


# ── A passed check ────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_dry_run_that_passes_writes_nothing(script, table):
    _projects(table, 3)
    outcome = _check(script, table)
    assert (outcome['status'], outcome['written'], outcome['projects_checked'], script.exit_code(outcome)) == (
        'passed', False, 3, 0)
    assert '--apply' in outcome['next_steps']
    assert _row(table) is None


def test_apply_writes_the_one_row(script, table):
    _projects(table, 5)
    with patch.object(project_walk, 'ID_PAGE', 2):
        outcome = _check(script, table, apply=True)
    assert (outcome['status'], outcome['written'], outcome['projects_checked'], outcome['steps']) == (
        'switched', True, 5, 3)
    assert _row(table) == project_scope.switch_row(NOW, '7.98.0', 5, 3, REVIEW_REGISTRIES_MARKER['completed_at'], ROLE)
    assert project_scope.projects_switched(table) is True


def test_the_persona_library_and_a_fixture_project_are_skipped(script, table):
    _projects(table, 1)
    _unlisted(table, 'company_personas')
    _unlisted(table, 'proj_vf_' + 'a' * 24)
    outcome = _check(script, table, apply=True)
    assert (outcome['status'], outcome['projects_checked']) == ('switched', 1)


@pytest.mark.parametrize('apply', [False, True])
def test_a_rerun_for_the_same_marker_reads_the_row_and_changes_nothing(script, table, apply):
    _projects(table, 2)
    _check(script, table, apply=True)
    before = _row(table)
    _projects(table, 3, prefix='proj_later')
    outcome = _check(script, table, apply=apply)
    assert (outcome['status'], outcome['written'], outcome['steps'], script.exit_code(outcome)) == (
        'already_switched', False, 0, 0)
    assert _row(table) == before


def test_the_summary_says_the_outcome_and_what_next(script, table):
    _projects(table, 1)
    text = script.summary(_check(script, table, apply=True))
    assert text.startswith('switched')
    assert 'switch row written' in text
    table.delete_item(Key=dict(REVIEW_REGISTRIES_MARKER_KEY))
    assert f'refused ({script.NOT_BACKFILLED})' in script.summary(_check(script, table))


def test_main_runs_the_check_on_the_named_table(script, table, capsys):
    _projects(table, 1)
    session = MagicMock()
    session.return_value.resource.return_value.Table.return_value = table
    session.return_value.client.return_value.get_caller_identity.return_value = {'Arn': ROLE_SESSION}
    with patch('boto3.session.Session', session), patch.object(script, '_utc_now', return_value=CLOCK), \
            patch.object(script.backfill, 'link_writers', return_value=_deployed()()):
        assert script.main(['--projects-table', 'projects']) == 0
    assert capsys.readouterr().out.startswith('passed')
    assert _row(table) is None
