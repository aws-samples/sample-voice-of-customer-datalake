"""shared/trial_schedule.py: a trial's one EventBridge Scheduler schedule per expiry (7.71.00), which runs voc-trial-expiry
once and deletes itself; the API only ever creates one."""
import ast
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from shared.exceptions import ConfigurationError
from shared.trial_schedule import (
    EXPIRY_ACTION,
    SCHEDULE_PREFIX,
    TrialSchedule,
    configured_schedule,
    schedule_name,
    unqualified,
)

ROOT = Path(__file__).resolve().parents[3]
WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
END = datetime(2026, 12, 21, 9, 30, 5, tzinfo=UTC)
TARGET = 'arn:aws:lambda:us-east-1:111111111111:function:voc-trial-expiry-111111111111-us-east-1'
ROLE = 'arn:aws:iam::111111111111:role/voc-trial-scheduler-111111111111-us-east-1'


def _schedule(client):
    return TrialSchedule(client, 'voc-trials-111111111111-us-east-1', ROLE, f'{TARGET}:live')


def test_one_schedule_per_trial_and_end_named_within_schedulers_limit():
    name = schedule_name(WS, END)
    assert name == f'voc-trial-{WS}-20261221T093005'
    assert len(name) <= 64
    assert re.fullmatch(r'[0-9A-Za-z_.-]+', name)
    # Another end of the same trial is another schedule.
    assert schedule_name(WS, END.replace(day=22)) != name


def test_it_runs_the_job_once_at_the_end_with_retries_then_deletes_itself():
    client = MagicMock()
    assert _schedule(client).create(WS, END) is True
    request = client.create_schedule.call_args.kwargs
    assert {key: request[key] for key in ('Name', 'GroupName', 'ScheduleExpression', 'ScheduleExpressionTimezone',
                                          'FlexibleTimeWindow', 'State', 'ActionAfterCompletion')} == {
        'Name': schedule_name(WS, END), 'GroupName': 'voc-trials-111111111111-us-east-1',
        'ScheduleExpression': 'at(2026-12-21T09:30:05)', 'ScheduleExpressionTimezone': 'UTC',
        'FlexibleTimeWindow': {'Mode': 'OFF'}, 'State': 'ENABLED', 'ActionAfterCompletion': 'DELETE'}
    target = request['Target']
    # The unqualified job (never an alias or version), through the scheduler's own role.
    assert (target['Arn'], target['RoleArn']) == (TARGET, ROLE)
    assert target['RetryPolicy'] == {'MaximumRetryAttempts': 3, 'MaximumEventAgeInSeconds': 86_400}
    assert json.loads(target['Input']) == {'action': EXPIRY_ACTION, 'workspace_id': WS,
                                           'expires_at': '2026-12-21T09:30:05+00:00'}
    assert request['Description'] == 'Pauses the trial workspace once it ends; deletes nothing.'


def test_a_second_create_for_the_same_end_changes_nothing():
    client = MagicMock()
    client.create_schedule.side_effect = ClientError({'Error': {'Code': 'ConflictException'}}, 'CreateSchedule')
    assert _schedule(client).create(WS, END) is False


def test_any_other_refusal_propagates():
    client = MagicMock()
    client.create_schedule.side_effect = ClientError({'Error': {'Code': 'AccessDeniedException'}}, 'CreateSchedule')
    with pytest.raises(ClientError):
        _schedule(client).create(WS, END)


def test_unqualified_drops_an_alias_or_version():
    assert unqualified(f'{TARGET}:7') == TARGET
    assert unqualified(TARGET) == TARGET


@pytest.mark.parametrize('missing', ['TRIAL_SCHEDULE_GROUP', 'TRIAL_SCHEDULER_ROLE_ARN', 'TRIAL_EXPIRY_FUNCTION_ARN'])
def test_the_schedules_need_their_whole_configuration_before_a_client_is_built(monkeypatch, missing):
    for name in ('TRIAL_SCHEDULE_GROUP', 'TRIAL_SCHEDULER_ROLE_ARN', 'TRIAL_EXPIRY_FUNCTION_ARN'):
        monkeypatch.setenv(name, 'set')
    monkeypatch.delenv(missing)
    factory = MagicMock()
    with pytest.raises(ConfigurationError):
        configured_schedule(factory)
    factory.assert_not_called()


def test_a_configured_schedule_names_its_group_role_and_job(monkeypatch):
    monkeypatch.setenv('TRIAL_SCHEDULE_GROUP', 'group')
    monkeypatch.setenv('TRIAL_SCHEDULER_ROLE_ARN', ROLE)
    monkeypatch.setenv('TRIAL_EXPIRY_FUNCTION_ARN', TARGET)
    client = MagicMock()
    assert configured_schedule(lambda: client) == TrialSchedule(client, 'group', ROLE, TARGET)


def test_the_prefix_is_the_one_the_stacks_grant_names():
    stack = (ROOT / 'lib' / 'stacks' / 'trial-expiry.ts').read_text(encoding='utf-8')
    assert f"export const TRIAL_SCHEDULE_PREFIX = '{SCHEDULE_PREFIX}';" in stack


def test_no_code_ever_updates_or_deletes_a_schedule():
    """The API creates a schedule and never changes one (its grant is CreateSchedule alone); each deletes itself."""
    found = []
    for path in (ROOT / 'lambda').rglob('*.py'):
        if '/test' in str(path) or '/layers/' in str(path):
            continue
        found.extend(f'{path.relative_to(ROOT)}: {node.attr}' for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))) if isinstance(node, ast.Attribute) and node.attr in {'delete_schedule', 'update_schedule',
                                                                 'delete_schedule_group'})
    assert found == []
