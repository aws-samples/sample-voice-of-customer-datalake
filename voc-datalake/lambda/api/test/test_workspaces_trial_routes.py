"""workspaces_handler.py: trial workspaces (7.71.00; docs/multi-workspace.md "Trial workspaces"): POST
/platform/workspaces with a trial, POST /platform/workspaces/{ws}/trial/extend and …/convert (platform admins only,
live-checked), what members read of the trial on GET /me/workspaces/current, a suggested playbook on the member add,
and the plugin enable refused while the trial is paused (moto-backed). Nothing is scheduled: voc-trial-expiry's hourly
tick reads the ends from the listing (lambda/jobs/trial_expiry/test/test_trial_expiry.py)."""
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event
from test_workspaces_platform_routes import ADA, PAT, UMA
from workspaces_api_world import handler_doubles

import workspaces_handler
from shared.exceptions import ConflictError
from shared.trial_pause import PauseTables, pause
from shared.trials import read_meta, save_trial

BODY = {'name': 'Acme Trial', 'slug': 'acme-trial',
        'trial': {'days': 14, 'pack': {'forms': ['workshop'], 'categories': True, 'playbooks': True}}}
CEILING = '["webscraper", "app_reviews_ios"]'


@dataclass
class World:
    workspaces: Any
    aggregates: Any
    resource: Any


@pytest.fixture
def world(monkeypatch) -> Iterator[World]:
    monkeypatch.setenv('ENABLED_SOURCES', CEILING)
    cognito = handler_doubles(monkeypatch)
    # The member add finds Ana's account (shared/workspace_members.py find_or_create_account).
    cognito.list_users.return_value = {'Users': [{'Username': 'ana', 'Attributes': [
        {'Name': 'sub', 'Value': 'sub-ana'}, {'Name': 'email', 'Value': 'ana@example.com'}]}]}
    monkeypatch.setattr(workspaces_handler, 'AGGREGATES_TABLE', 'aggregates')
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        monkeypatch.setattr(workspaces_handler, 'get_dynamodb_resource', lambda: resource)
        yield World(pk_sk_table('workspaces'), pk_sk_table('aggregates'), resource)


def _call(world, lambda_context, method, path, claims=PAT, body=None, ws=None):
    event = rest_event(method, path, claims=claims, body=body)
    if ws is not None:
        event['headers']['X-Workspace-Id'] = ws
    return invoke(workspaces_handler, event, lambda_context, workspaces=world.workspaces)


def _create(world, lambda_context, body=BODY):
    status, answer = _call(world, lambda_context, 'POST', '/platform/workspaces', body=body)
    assert status == 201, answer
    return answer['workspace']


def _pause(world, ws, days=15):
    tables = PauseTables(world.workspaces, lambda scope: workspaces_handler.ingest_table(scope, world.resource, 'aggregates'),
                         ('webscraper', 'app_reviews_ios'))
    assert pause(tables, ws, datetime.now(UTC) + timedelta(days=days))['outcome'] == 'paused'


def test_a_platform_admin_creates_a_trial_on_meta_and_the_listing(world, lambda_context):
    workspace = _create(world, lambda_context)
    ws, trial = workspace['id'], workspace['trial']
    assert (trial['days'], trial['created_by'], trial['pack']) == (14, 'sub-pat', BODY['trial']['pack'])
    expires = datetime.fromisoformat(trial['expires_at'])
    assert timedelta(days=14) - timedelta(minutes=1) < expires - datetime.now(UTC) <= timedelta(days=14)
    assert read_meta(world.workspaces, ws)['trial']['expires_at'] == trial['expires_at']
    # The console's list carries the listing row's copy.
    status, listed = _call(world, lambda_context, 'GET', '/platform/workspaces')
    assert (status, listed['workspaces'][0]['trial']['expires_at']) == (200, trial['expires_at'])


def test_a_workspace_without_a_trial_carries_none(world, lambda_context):
    workspace = _create(world, lambda_context, {'name': 'Plain', 'slug': 'plain'})
    assert workspace['trial'] is None
    assert 'trial' not in read_meta(world.workspaces, workspace['id'])


@pytest.mark.parametrize('trial', [{'days': 90}, {'days': 30, 'auto_delete': True}, 'yes'], ids=repr)
def test_a_bad_trial_is_a_400_and_writes_nothing(world, lambda_context, trial):
    status, _ = _call(world, lambda_context, 'POST', '/platform/workspaces', body={**BODY, 'trial': trial})
    assert status == 400
    assert world.workspaces.scan()['Items'] == []


@pytest.mark.parametrize('claims', [ADA, UMA], ids=['administrator', 'user'])
def test_only_a_platform_admin_creates_extends_or_converts_a_trial(world, lambda_context, claims):
    ws = _create(world, lambda_context)['id']
    assert _call(world, lambda_context, 'POST', '/platform/workspaces', claims=claims, body=BODY)[0] == 403
    for action, body in (('extend', {'days': 30}), ('convert', None)):
        assert _call(world, lambda_context, 'POST', f'/platform/workspaces/{ws}/trial/{action}', claims=claims,
                     body=body)[0] == 403
    assert read_meta(world.workspaces, ws)['trial']['rev'] == 1


def test_an_extension_moves_the_end(world, lambda_context):
    workspace = _create(world, lambda_context)
    ws = workspace['id']
    status, body = _call(world, lambda_context, 'POST', f'/platform/workspaces/{ws}/trial/extend', body={'days': 30})
    assert status == 200
    before = datetime.fromisoformat(workspace['trial']['expires_at'])
    assert datetime.fromisoformat(body['trial']['expires_at']) == before + timedelta(days=30)
    assert read_meta(world.workspaces, ws)['trial']['expires_at'] == body['trial']['expires_at']
    assert _call(world, lambda_context, 'POST', f'/platform/workspaces/{ws}/trial/extend', body={'days': 7})[0] == 400


def test_a_workspace_that_is_no_trial_is_not_found(world, lambda_context):
    ws = _create(world, lambda_context, {'name': 'Plain', 'slug': 'plain'})['id']
    for path in (f'/platform/workspaces/{ws}/trial/convert', '/platform/workspaces/ws_bogus/trial/convert'):
        status, body = _call(world, lambda_context, 'POST', path)
        assert (status, body['error']) == (404, 'Trial not found')


def test_members_read_the_trial_and_their_suggested_playbook(world, lambda_context):
    ws = _create(world, lambda_context)['id']
    added = _call(world, lambda_context, 'POST', '/me/workspaces/current/members', ws=ws,
                  body={'email': 'ana@example.com', 'role': 'editor', 'playbook': 'qa'})
    assert added[0] == 201
    assert added[1]['member']['playbook'] == 'qa'
    ana = {'sub': added[1]['member']['sub'], 'cognito:username': 'ana', 'cognito:groups': 'users'}
    status, body = _call(world, lambda_context, 'GET', '/me/workspaces/current', claims=ana, ws=ws)
    assert status == 200
    trial = body['workspace']['trial']
    assert (trial['days'], trial['paused_at'], trial['converted_at'], body['workspace']['playbook']) == (
        14, None, None, 'qa')
    assert 'created_by' not in trial
    assert 'pack' not in trial
    bad = _call(world, lambda_context, 'POST', '/me/workspaces/current/members', ws=ws,
                body={'email': 'ana@example.com', 'role': 'viewer', 'playbook': 'ceo'})
    assert bad[0] == 400


def test_a_paused_trial_refuses_a_plugins_enable_until_it_is_extended(world, lambda_context):
    ws = _create(world, lambda_context)['id']
    world.aggregates.put_item(Item={'pk': f'WS#{ws}#FEEDBACK_FORM', 'sk': 'FORM#f1', 'enabled': True,
                                    'write_count': 0})
    _pause(world, ws)
    plugin = '/me/workspaces/current/plugins/webscraper'
    status, body = _call(world, lambda_context, 'PUT', plugin, ws=ws, body={'enabled': True})
    assert (status, body['code']) == (409, 'trial_paused')
    current = _call(world, lambda_context, 'GET', '/me/workspaces/current', ws=ws)[1]['workspace']['trial']
    assert current['paused'] == {'plugins': 2, 'forms': 1}
    assert current['paused_at'] is not None
    status, body = _call(world, lambda_context, 'POST', f'/platform/workspaces/{ws}/trial/extend', body={'days': 14})
    assert status == 200
    assert body['trial']['paused'] is None
    assert body['trial']['extended'][-1]['resumed'] == {'plugins': 2, 'forms': 1, 'skipped': []}
    # Q27 (7.71.01): the answer says what this extension resumed, the forms it left off included.
    assert body['trial']['resumed'] == {'plugins': 2, 'forms': 1, 'skipped': []}
    form = world.aggregates.get_item(Key={'pk': f'WS#{ws}#FEEDBACK_FORM', 'sk': 'FORM#f1'})['Item']
    assert form['enabled'] is True
    listed = _call(world, lambda_context, 'GET', '/me/workspaces/current/plugins', ws=ws)[1]['plugins']
    assert all(entry['enabled'] for entry in listed)


def test_an_extension_refused_by_a_trial_changed_meanwhile_finishes_when_retried(world, lambda_context):
    """The 409 of a trial changed between the read and the write (here: right after the resume) leaves it resumed but
    still marked paused (and ``resuming_at``, so the hourly tick turns nothing off meanwhile); the same extension again
    finishes it, its end counted from the same stored end."""
    ws = _create(world, lambda_context)['id']
    world.aggregates.put_item(Item={'pk': f'WS#{ws}#FEEDBACK_FORM', 'sk': 'FORM#f1', 'enabled': True,
                                    'write_count': 0})
    _pause(world, ws)
    before = read_meta(world.workspaces, ws)['trial']
    calls = []

    def changed_meanwhile(*args, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            # The write after the resume (the first marks the trial resuming).
            raise ConflictError('The trial changed meanwhile: reload it and try again', code='trial_changed')
        return save_trial(*args, **kwargs)

    with patch('shared.trials.save_trial', side_effect=changed_meanwhile):
        first = _call(world, lambda_context, 'POST', f'/platform/workspaces/{ws}/trial/extend', body={'days': 14})
        assert (first[0], first[1]['code']) == (409, 'trial_changed')
        assert read_meta(world.workspaces, ws)['trial']['paused_at'] == before['paused_at']
        tables = PauseTables(world.workspaces, lambda scope: workspaces_handler.ingest_table(scope, world.resource,
                                                                                            'aggregates'),
                             ('webscraper', 'app_reviews_ios'))
        # A tick past the trial's end while the mark is fresh (its 15 minutes stretched over the 15 days here; a stale
        # mark's pause: shared/test/test_trial_pause.py).
        with patch('shared.trial_pause.RESUMING_FRESH', timedelta(days=16)):
            assert pause(tables, ws, datetime.now(UTC) + timedelta(days=15))['outcome'] == 'not_due'
        status, body = _call(world, lambda_context, 'POST', f'/platform/workspaces/{ws}/trial/extend', body={'days': 14})
    assert status == 200
    assert body['trial']['paused'] is None
    ends = datetime.fromisoformat(body['trial']['expires_at'])
    assert (ends, len(body['trial']['extended'])) == (datetime.fromisoformat(before['expires_at']) + timedelta(days=14), 1)
    form = world.aggregates.get_item(Key={'pk': f'WS#{ws}#FEEDBACK_FORM', 'sk': 'FORM#f1'})['Item']
    assert form['enabled'] is True


def test_a_conversion_resumes_a_paused_trial_and_ends_it(world, lambda_context):
    ws = _create(world, lambda_context)['id']
    _pause(world, ws)
    status, body = _call(world, lambda_context, 'POST', f'/platform/workspaces/{ws}/trial/convert')
    assert status == 200
    assert body['trial']['converted_by'] == 'sub-pat'
    assert body['trial']['paused'] is None
    assert body['trial']['resumed'] == {'plugins': 2, 'forms': 0, 'skipped': []}
    assert _call(world, lambda_context, 'PUT', '/me/workspaces/current/plugins/webscraper', ws=ws,
                 body={'enabled': False})[0] == 200
    assert _call(world, lambda_context, 'POST', f'/platform/workspaces/{ws}/trial/extend', body={'days': 14})[0] == 409


def test_each_workspace_answers_its_own_trial_and_a_non_member_the_one_404(world, lambda_context):
    """The cross-workspace case: /me/workspaces/current reads the trial of the workspace X-Workspace-Id names only."""
    trial_ws = _create(world, lambda_context)['id']
    plain_ws = _create(world, lambda_context, {'name': 'Plain', 'slug': 'plain'})['id']
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current', ws=trial_ws)[1]['workspace']['trial'] is not None
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current', ws=plain_ws)[1]['workspace']['trial'] is None
    stranger = {'sub': 'sub-sam', 'cognito:username': 'sam', 'cognito:groups': 'users'}
    status, body = _call(world, lambda_context, 'GET', '/me/workspaces/current', claims=stranger, ws=trial_ws)
    assert (status, body['error']) == (404, 'Workspace not found')
