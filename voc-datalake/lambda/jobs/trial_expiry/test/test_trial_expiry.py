"""voc-trial-expiry (lambda/jobs/trial_expiry/handler.py, 7.71.00): the schedule's event pauses a due trial and nothing
else reaches it; the job's own code deletes nothing (its one delete is the plugins' existing disable, in
shared/workspace_plugin_settings.py, pinned with the pause by lambda/shared/test/test_trial_pause.py)."""
import ast
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws

from jobs.trial_expiry import handler
from shared.exceptions import ConfigurationError
from shared.platform_workspaces import NewWorkspace, create_workspace
from shared.test.moto_tables import create_pk_sk_table
from shared.trial_state import NewTrial, new_trial
from shared.trials import read_meta

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
START = datetime(2026, 11, 21, 9, 0, tzinfo=UTC)
LAMBDA_DIR = Path(__file__).resolve().parents[3]
EVENT = {'action': 'trial_expiry', 'workspace_id': WS, 'expires_at': '2026-12-05T09:00:00+00:00'}


@pytest.mark.parametrize('event', [
    None, [], {}, {'action': 'reactions', 'workspace_id': WS}, {'action': 'trial_expiry'},
    {'action': 'trial_expiry', 'workspace_id': 'ws_bogus'}, {'action': 'trial_expiry', 'workspace_id': 7},
], ids=repr)
def test_an_event_that_is_not_its_schedules_is_left_alone(event):
    tables = MagicMock()
    with patch.object(handler, 'pause') as pause:
        assert handler.handle_event(event, tables, START) == {'outcome': handler.IGNORED}
    pause.assert_not_called()


def test_its_schedules_event_pauses_the_trial_it_names_by_the_stored_end():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        workspaces = create_pk_sk_table('workspaces', resource)
        create_pk_sk_table('aggregates', resource)
        trial = new_trial(NewTrial(days=14, pack={'forms': [], 'categories': False, 'playbooks': False}), 'sub-pat',
                          START)
        create_workspace(workspaces, NewWorkspace(name='Acme Trial', slug='acme-trial'), 'sub-pat', ['webscraper'],
                         ws=WS, trial=trial)
        with patch.object(handler, 'WORKSPACES_TABLE', 'workspaces'), \
                patch.object(handler, 'AGGREGATES_TABLE', 'aggregates'), \
                patch.object(handler, 'get_dynamodb_resource', return_value=resource), \
                patch.object(handler, 'enabled_plugin_ids', return_value=['webscraper']):
            tables = handler._tables()
            # The event's own time says nothing: one day early, the stored end decides.
            assert handler.handle_event(EVENT, tables, START + timedelta(days=13))['outcome'] == 'not_due'
            assert handler.handle_event(EVENT, tables, START + timedelta(days=14))['outcome'] == 'paused'
        assert read_meta(workspaces, WS)['trial']['paused']['plugins'] == ['webscraper']


def test_it_needs_both_tables():
    with patch.object(handler, 'WORKSPACES_TABLE', ''), pytest.raises(ConfigurationError):
        handler._tables()


DELETE_CALLS = frozenset({'delete_item', 'delete_object', 'delete_objects', 'batch_write_item', 'batch_writer',
                          'delete_table', 'delete_schedule', 'delete_user', 'admin_delete_user', 'delete_parameter',
                          'delete_secret', 'delete_function'})


@pytest.mark.parametrize('module', ['jobs/trial_expiry/handler.py', 'shared/trial_pause.py', 'shared/trials.py',
                                    'shared/trial_state.py', 'shared/trial_schedule.py'])
def test_the_trials_code_calls_no_delete_of_any_kind(module):
    """Nothing here deletes: the pause's one delete is the existing plugin disable (shared/workspace_plugin_settings.py,
    whose key is a ``PLUGIN#`` row's), and no trial module names a ``Delete`` transaction entry either."""
    tree = ast.parse((LAMBDA_DIR / module).read_text(encoding='utf-8'))
    calls = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    assert calls & DELETE_CALLS == set()
    entries = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and node.value == 'Delete'}
    assert entries == set()
