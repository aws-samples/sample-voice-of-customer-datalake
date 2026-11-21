"""shared/trial_pause.py (7.71.00): a trial's pause at its end (the plugins' existing audited disable, the live forms
turned off, all recorded) and its resume; a paused trial refuses a plugin's enable; and NOTHING is deleted but the
plugins' own enable rows, which are the existing disable (moto-backed, every DynamoDB call recorded)."""
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

from shared import trial_pause
from shared.exceptions import ConflictError
from shared.ingest_tables import ingest_table
from shared.platform_workspaces import NewWorkspace, create_workspace
from shared.prototype_pins import FORM_TYPE_PROTOTYPE_PIN
from shared.prototype_validation import FORMS_PARTITION, OPEN_FIELD
from shared.test.moto_tables import create_pk_sk_table
from shared.trial_pause import (
    ALREADY_PAUSED,
    CONVERTED,
    EXPIRY_ACTOR,
    NOT_A_TRIAL,
    NOT_ACTIVE,
    NOT_DUE,
    PAUSED_NOW,
    PauseTables,
    pause,
    resume,
)
from shared.trial_state import TRIAL_PAUSED_CODE, NewTrial, new_trial
from shared.trials import read_meta, save_trial
from shared.workspace import WorkspaceContext
from shared.workspace_plugin_settings import set_plugin_enabled, workspace_plugins

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
PAT = 'sub-pat'
START = datetime(2026, 11, 21, 9, 0, tzinfo=UTC)
AFTER_END = START + timedelta(days=31)
CEILING = ('webscraper', 'app_reviews_ios', 'github_issues', 's3_import')
FORMS = f'WS#{WS}#FEEDBACK_FORM'


@dataclass
class World:
    workspaces: Any
    aggregates: Any
    tables: PauseTables
    calls: list[tuple[str, dict]]


def _record(calls):
    def handler(params, model, **_kwargs):
        calls.append((model.name, params))
    return handler


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        workspaces = create_pk_sk_table('workspaces', resource)
        aggregates = create_pk_sk_table('aggregates', resource)
        trial = new_trial(NewTrial(days=30, pack={'forms': [], 'categories': False, 'playbooks': False}), PAT, START)
        create_workspace(workspaces, NewWorkspace(name='Acme Trial', slug='acme-trial'), PAT,
                         ['webscraper', 'app_reviews_ios'], ws=WS, trial=trial)
        for item in (
            {'pk': FORMS, 'sk': 'FORM#live', 'enabled': True, 'write_count': 4, 'name': 'Workshop feedback'},
            {'pk': FORMS, 'sk': 'FORM#legacy', 'enabled': True, 'name': 'Saved before 7.58 (no counter)'},
            {'pk': FORMS, 'sk': 'FORM#off', 'enabled': False, 'write_count': 1},
            {'pk': FORMS, 'sk': 'FORM#imported', 'enabled': False, 'imported': {'source': 'csv'}},
            {'pk': FORMS, 'sk': 'FORMREV#live#1', 'enabled': True},
            {'pk': FORMS, 'sk': 'FORMFUNNEL#live#2026-11-21', 'opened': 3},
            {'pk': f'WS#{WS}#SOURCE#feedback_form', 'sk': 'item-1', 'text': 'A response: it must stay'},
            {'pk': f'WS#{WS}#FEEDBACK_FORM_TEST', 'sk': 'live#t1', 'answers': {}},
        ):
            aggregates.put_item(Item=item)
        calls: list[tuple[str, dict]] = []
        resource.meta.client.meta.events.register('provide-client-params.dynamodb', _record(calls))
        tables = PauseTables(workspaces=workspaces, forms=lambda scope: ingest_table(scope, resource, 'aggregates'),
                             ceiling=CEILING)
        yield World(workspaces, aggregates, tables, calls)


def _keys(table):
    return sorted((row['pk'], row['sk']) for row in table.scan()['Items'])


def _form(world, form_id):
    return world.aggregates.get_item(Key={'pk': FORMS, 'sk': f'FORM#{form_id}'})['Item']


def _enabled(world):
    return [entry['id'] for entry in workspace_plugins(world.workspaces, WS, CEILING) if entry['enabled']]


def _audit_kinds(world):
    rows = world.workspaces.query(KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})
    return [(row['kind'], row.get('plugin'), row.get('reason')) for row in rows['Items']]


def test_before_its_end_nothing_is_paused(world):
    before = (_keys(world.workspaces), _keys(world.aggregates))
    assert pause(world.tables, WS, START + timedelta(days=29)) == {'outcome': NOT_DUE}
    assert (_keys(world.workspaces), _keys(world.aggregates)) == before


def test_at_its_end_the_plugins_and_live_forms_are_turned_off_and_recorded(world):
    assert pause(world.tables, WS, AFTER_END) == {'outcome': PAUSED_NOW, 'plugins': 2, 'forms': 2}
    trial = read_meta(world.workspaces, WS)['trial']
    assert trial['paused_at'] == AFTER_END.isoformat()
    assert trial['paused'] == {'plugins': ['webscraper', 'app_reviews_ios'], 'forms': ['legacy', 'live']}
    assert _enabled(world) == []
    live, legacy = _form(world, 'live'), _form(world, 'legacy')
    assert (live['enabled'], live['write_count'], live['updated_by']) == (False, 5, EXPIRY_ACTOR)
    # A form saved before the save counter existed gets one, so an editor's stale copy cannot turn it on again.
    assert (legacy['enabled'], legacy['write_count']) == (False, 1)
    # The forms that were off, imported included, are not touched.
    assert 'updated_by' not in _form(world, 'off')
    assert 'updated_by' not in _form(world, 'imported')
    kinds = _audit_kinds(world)
    assert ('trial_paused', None, None) in kinds
    assert {('plugin_disabled', plugin, 'trial_paused') for plugin in ('webscraper', 'app_reviews_ios')} <= set(kinds)


def test_nothing_is_deleted_but_the_plugins_own_enable_rows(world):
    """The pin of 7.71.00: the expiry deletes no workspace, form, response, feedback item or audit row. The only delete
    it sends is the existing plugin disable's, of a ``PLUGIN#{plugin}`` / ``WS#{ws}`` row."""
    workspaces, aggregates = _keys(world.workspaces), _keys(world.aggregates)
    world.calls.clear()
    pause(world.tables, WS, AFTER_END)
    calls = list(world.calls)
    assert _keys(world.aggregates) == aggregates
    gone = set(workspaces) - set(_keys(world.workspaces))
    assert gone == {('PLUGIN#webscraper', f'WS#{WS}'), ('PLUGIN#app_reviews_ios', f'WS#{WS}')}
    operations = {name for name, _params in calls}
    assert operations <= {'GetItem', 'Query', 'PutItem', 'UpdateItem', 'TransactWriteItems'}
    deletes = [entry['Delete']['Key'] for name, params in calls if name == 'TransactWriteItems'
               for entry in params['TransactItems'] if 'Delete' in entry]
    assert deletes
    assert all(key['pk'].startswith('PLUGIN#') and key['sk'] == f'WS#{WS}' for key in deletes)


def test_a_second_run_changes_nothing(world):
    pause(world.tables, WS, AFTER_END)
    after = (_keys(world.workspaces), _keys(world.aggregates), read_meta(world.workspaces, WS)['trial'])
    assert pause(world.tables, WS, AFTER_END + timedelta(minutes=5)) == {'outcome': ALREADY_PAUSED}
    # No audit row, no plugin row, form or trial change.
    assert (_keys(world.workspaces), _keys(world.aggregates), read_meta(world.workspaces, WS)['trial']) == after


def test_a_retry_after_a_partial_pause_still_records_everything_it_turned_off(world):
    with patch.object(trial_pause, 'set_form_live', side_effect=RuntimeError('throttled')), \
            pytest.raises(RuntimeError):
        pause(world.tables, WS, AFTER_END)
    # The plugins went off before the failure; the retry finds them off already, and still records them.
    assert pause(world.tables, WS, AFTER_END)['outcome'] == PAUSED_NOW
    trial = read_meta(world.workspaces, WS)['trial']
    assert trial['paused'] == {'plugins': ['webscraper', 'app_reviews_ios'], 'forms': ['legacy', 'live']}
    assert _form(world, 'live')['enabled'] is False


def test_a_converted_trial_a_deleting_workspace_and_a_workspace_with_no_trial_are_left_alone(world):
    meta = read_meta(world.workspaces, WS)
    save_trial(world.workspaces, WS, meta, {**meta['trial'], 'converted_at': START.isoformat()})
    assert pause(world.tables, WS, AFTER_END) == {'outcome': CONVERTED}
    world.workspaces.update_item(Key={'pk': f'WS#{WS}', 'sk': 'META'}, UpdateExpression='SET #s = :d',
                                 ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':d': 'deleting'})
    assert pause(world.tables, WS, AFTER_END) == {'outcome': NOT_ACTIVE}
    other = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
    create_workspace(world.workspaces, NewWorkspace(name='Plain', slug='plain'), PAT, ['webscraper'], ws=other)
    assert pause(world.tables, other, AFTER_END) == {'outcome': NOT_A_TRIAL}
    assert _enabled(world) == ['webscraper', 'app_reviews_ios']


def _admin(platform_admin=False):
    return WorkspaceContext(ws=WS, role='admin', name='Acme Trial', slug='acme-trial', platform_admin=platform_admin)


def test_a_paused_trial_refuses_a_plugins_enable_and_still_takes_a_disable(world):
    pause(world.tables, WS, AFTER_END)
    with pytest.raises(ConflictError) as raised:
        set_plugin_enabled(world.workspaces, _admin(), 'webscraper', True, PAT)
    assert raised.value.code == TRIAL_PAUSED_CODE
    with pytest.raises(ConflictError):
        set_plugin_enabled(world.workspaces, _admin(platform_admin=True), 'github_issues', True, 'sub-platform')
    assert _enabled(world) == []


def test_a_pause_landing_between_the_enables_read_and_its_commit_still_wins(world):
    """The enable's transaction checks that ``trial.paused_at`` is absent: a pause that lands after its read is not
    undone by it."""
    meta = read_meta(world.workspaces, WS)
    save_trial(world.workspaces, WS, meta, {**meta['trial'], 'paused_at': AFTER_END.isoformat()})
    reads = iter([None, {'paused_at': AFTER_END.isoformat()}])
    with patch('shared.workspace_plugin_settings.stored_trial', side_effect=lambda *_: next(reads)), \
            pytest.raises(ConflictError) as raised:
        set_plugin_enabled(world.workspaces, _admin(), 'github_issues', True, PAT)
    assert raised.value.code == TRIAL_PAUSED_CODE
    assert 'github_issues' not in _enabled(world)


def test_the_resume_turns_back_on_exactly_what_the_pause_turned_off(world):
    pause(world.tables, WS, AFTER_END)
    # Meanwhile a form was deleted by its owner: it stays deleted.
    world.aggregates.delete_item(Key={'pk': FORMS, 'sk': 'FORM#legacy'})
    trial = read_meta(world.workspaces, WS)['trial']
    assert resume(world.tables, WS, trial, 'sub-platform', 'trial_extended') == {'plugins': 2, 'forms': 1}
    assert _enabled(world) == ['webscraper', 'app_reviews_ios']
    assert (_form(world, 'live')['enabled'], _form(world, 'live')['updated_by']) == (True, 'sub-platform')
    assert _form(world, 'off')['enabled'] is False
    assert 'Item' not in world.aggregates.get_item(Key={'pk': FORMS, 'sk': 'FORM#legacy'})
    assert ('plugin_enabled', 'webscraper', 'trial_extended') in _audit_kinds(world)


def test_the_resume_skips_a_plugin_the_deployment_no_longer_offers(world):
    pause(world.tables, WS, AFTER_END)
    trial = read_meta(world.workspaces, WS)['trial']
    narrower = PauseTables(world.workspaces, world.tables.forms, ('webscraper',))
    assert resume(narrower, WS, trial, 'sub-platform', 'trial_converted')['plugins'] == 1
    assert _enabled(world) == ['webscraper']


def test_a_prototypes_pin_form_and_its_validation_card_are_left_working(world):
    """Pins and 7.68.00's "Tell us how it went" card are prototype review on a project, not a live public form of the
    workspace, and projects are still the deployment's (docs/multi-workspace.md, "Trial workspaces"): a pin form is in
    the deployment's forms partition, never a workspace's, so a pause neither turns it or its card off nor records it,
    and a resume never touches it."""
    pin = {'pk': FORMS_PARTITION, 'sk': 'FORM#pf_proto1', 'form_type': FORM_TYPE_PROTOTYPE_PIN, 'enabled': True,
           OPEN_FIELD: True, 'write_count': 2}
    world.aggregates.put_item(Item=pin)
    assert pause(world.tables, WS, AFTER_END)['outcome'] == PAUSED_NOW
    trial = read_meta(world.workspaces, WS)['trial']
    assert trial['paused']['forms'] == ['legacy', 'live']
    resume(world.tables, WS, trial, 'sub-platform', 'trial_extended')
    assert world.aggregates.get_item(Key={'pk': FORMS_PARTITION, 'sk': 'FORM#pf_proto1'})['Item'] == pin
