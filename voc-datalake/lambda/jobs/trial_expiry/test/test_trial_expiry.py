"""voc-trial-expiry (lambda/jobs/trial_expiry/handler.py, 7.71.00): the hourly tick pauses each due trial it reads from
the listing and nothing else reaches it; one trial that fails leaves the others paused; the job's own code deletes
nothing (its one delete is the plugins' existing disable, in shared/workspace_plugin_settings.py, pinned with the pause
by lambda/shared/test/test_trial_pause.py)."""
import ast
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from jobs.trial_expiry import handler
from shared.exceptions import ConfigurationError
from shared.platform_workspaces import NewWorkspace, create_workspace
from shared.test.moto_tables import create_pk_sk_table
from shared.trial_state import NewTrial, new_trial
from shared.trials import read_meta, save_trial

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
START = datetime(2026, 11, 21, 9, 0, tzinfo=UTC)
LAMBDA_DIR = Path(__file__).resolve().parents[3]
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
EVENT = {'action': 'trial_expiry'}


@pytest.mark.parametrize('event', [None, [], {}, {'action': 'reactions', 'workspace_id': WS}, {'action': 7}], ids=repr)
def test_an_event_that_is_not_its_rules_is_left_alone(event):
    tables = MagicMock()
    with patch.object(handler, 'pause') as pause:
        assert handler.handle_event(event, tables, START) == {'outcome': handler.IGNORED}
    pause.assert_not_called()


def _world(resource):
    workspaces = create_pk_sk_table('workspaces', resource)
    create_pk_sk_table('aggregates', resource)
    pack = {'forms': [], 'categories': False, 'playbooks': False}
    for ws, slug, days in ((WS, 'acme-trial', 14), (OTHER, 'beta-trial', 30)):
        create_workspace(workspaces, NewWorkspace(name=slug, slug=slug), 'sub-pat', ['webscraper'], ws=ws,
                         trial=new_trial(NewTrial(days=days, pack=pack), 'sub-pat', START))
    return workspaces


def _patched(resource):
    return (patch.object(handler, 'WORKSPACES_TABLE', 'workspaces'), patch.object(handler, 'AGGREGATES_TABLE', 'aggregates'),
            patch.object(handler, 'get_dynamodb_resource', return_value=resource),
            patch.object(handler, 'enabled_plugin_ids', return_value=['webscraper']))


def test_each_tick_pauses_the_trials_whose_stored_end_passed():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        workspaces = _world(resource)
        first, second, third, fourth = _patched(resource)
        with first, second, third, fourth:
            tables = handler._tables()
            assert handler.handle_event(EVENT, tables, START + timedelta(days=13)) == {'outcome': handler.SWEPT}
            assert handler.handle_event(EVENT, tables, START + timedelta(days=14)) == {'outcome': handler.SWEPT,
                                                                                       'paused': 1}
            # The next tick, within the day: the pause is visited again and found done.
            assert handler.handle_event(EVENT, tables, START + timedelta(days=14, hours=1)) == {
                'outcome': handler.SWEPT, 'already_paused': 1}
        assert read_meta(workspaces, WS)['trial']['paused']['plugins'] == ['webscraper']
        assert 'paused_at' not in read_meta(workspaces, OTHER)['trial']


def _failing(error: Exception):
    """The pause of trial ``WS`` fails with ``error``; the others run as they do."""
    real = handler.pause

    def failing_once(tables, ws, now):
        if ws == WS:
            raise error
        return real(tables, ws, now)

    return patch.object(handler, 'pause', side_effect=failing_once)


@pytest.mark.parametrize('error', [
    ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'UpdateItem'),
    TypeError('a bug of ours'),
], ids=['aws-error', 'any-other-error'])
def test_a_trial_that_fails_is_counted_and_left_for_the_next_tick_and_the_others_are_paused(error):
    """Any error of one trial (7.71.01's commit review: not only an AWS one) is logged and counted, and the tick goes
    on to the others."""
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        workspaces = _world(resource)
        first, second, third, fourth = _patched(resource)
        with first, second, third, fourth, _failing(error), patch.object(handler.logger, 'exception') as logged:
            outcome = handler.handle_event(EVENT, handler._tables(), START + timedelta(days=31))
        assert outcome == {'outcome': handler.SWEPT, 'failed': 1, 'paused': 1}
        assert 'paused_at' in read_meta(workspaces, OTHER)['trial']
        assert logged.call_args.kwargs['extra'] == {'workspace_id': WS}


def test_a_recorded_list_that_is_not_one_reads_as_none_and_the_trial_is_paused():
    """F2 (7.71.02): the pause reads ``trial.paused`` only through trial_state.paused_lists, so a stored map it does not
    expect (``paused.plugins`` a number) no longer fails the trial: it is read as nothing recorded, and the trial is
    paused like the others."""
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        workspaces = _world(resource)
        meta = read_meta(workspaces, WS)
        recently = (START + timedelta(days=30, hours=12)).isoformat()
        save_trial(workspaces, WS, meta, {**meta['trial'], 'paused_at': recently, 'paused': {'plugins': 7}})
        first, second, third, fourth = _patched(resource)
        with first, second, third, fourth:
            outcome = handler.handle_event(EVENT, handler._tables(), START + timedelta(days=31))
        assert outcome == {'outcome': handler.SWEPT, 'paused': 2}
        assert read_meta(workspaces, WS)['trial']['paused'] == {'plugins': ['webscraper'], 'forms': []}


def test_it_needs_both_tables():
    with patch.object(handler, 'WORKSPACES_TABLE', ''), pytest.raises(ConfigurationError):
        handler._tables()


DELETE_CALLS = frozenset({'delete_item', 'delete_object', 'delete_objects', 'batch_write_item', 'batch_writer',
                          'delete_table', 'delete_schedule', 'delete_user', 'admin_delete_user', 'delete_parameter',
                          'delete_secret', 'delete_function'})


@pytest.mark.parametrize('module', ['jobs/trial_expiry/handler.py', 'shared/trial_pause.py', 'shared/trials.py',
                                    'shared/trial_state.py'])
def test_the_trials_code_calls_no_delete_of_any_kind(module):
    """Nothing here deletes: the pause's one delete is the existing plugin disable (shared/workspace_plugin_settings.py,
    whose key is a ``PLUGIN#`` row's), and no trial module names a ``Delete`` transaction entry either."""
    tree = ast.parse((LAMBDA_DIR / module).read_text(encoding='utf-8'))
    calls = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    assert calls & DELETE_CALLS == set()
    entries = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and node.value == 'Delete'}
    assert entries == set()
