"""voc-radar-scan inside a workspace (docs/multi-workspace.md, decision 13): the scan an event names runs on that
workspace's brands, settings and state, files its timeline there and nowhere else; the schedule's tick fans out."""
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws

from api.test.moto_helpers import pk_sk_table
from jobs.radar_scan import extract, handler, scan
from shared.radar_keys import brand_state_key, radar_settings_key, scan_key
from shared.radar_releases import list_releases
from shared.test.radar_fixtures import radar_pk_sk_table
from shared.ws_repo import WorkspaceScope

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'


def _today():
    return datetime.now(UTC).date()


def _context():
    context = MagicMock()
    context.get_remaining_time_in_millis.return_value = 900_000
    return context


def _unit():
    vector = [0.0] * 1024
    vector[0] = 1.0
    return vector


@pytest.fixture
def world():
    with mock_aws():
        radar, aggregates = radar_pk_sk_table('radar'), radar_pk_sk_table('aggregates')
        # A's own brand list; the deployment has none (so a scan that read the deployment's would skip).
        radar.put_item(Item={**radar_settings_key('brands', A), 'brands': [
            {'label': 'Acme', 'domains': ['acme.com']}]})
        answer = {'releases': [{'feature': 'Dark mode', 'release_date': None, 'summary': 'Acme shipped dark mode.',
                                'sources': [1]}]}
        search = MagicMock(return_value=[{'title': 'Result 1', 'url': 'https://blog.acme.com/dark',
                                          'text': 'snippet', 'published_date': str(_today())}])
        exa = MagicMock(return_value='deployment-exa-key')
        # Both workspaces active (each run checks before it writes; a fresh check per test).
        workspaces = pk_sk_table('workspaces')
        for ws in (A.ws, B):
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'status': 'active'})
        handler._status.clear()
        with patch.object(handler, 'RADAR_TABLE', 'radar'), patch.object(handler, 'AGGREGATES_TABLE', 'aggregates'), \
             patch.object(handler, 'WORKSPACES_TABLE', 'workspaces'), \
             patch.object(handler, 'is_web_search_configured', return_value=True), \
             patch.object(handler, 'load_exa_key', exa), \
             patch.object(handler, 'search_web', search), \
             patch.object(scan, 'embed_text', return_value=_unit()), \
             patch.object(extract, 'converse', return_value=json.dumps(answer)):
            yield radar, aggregates, search, exa
        handler._status.clear()


def _pks(table) -> set[str]:
    return {str(row['pk']) for row in table.scan(ConsistentRead=True)['Items']}


def test_a_workspace_scan_files_its_releases_and_state_in_the_workspace_only(world):
    radar, _, _, exa = world
    outcome = handler.handle_event({'mode': 'manual', 'workspace_id': A.ws, 'requested_by': 'sub-ada'}, _context())
    assert (outcome['status'], outcome['added'], outcome['brands']) == ('completed', 1, 1)
    releases = list_releases(radar, 'acme', _today() - timedelta(days=1), 10, workspace=A)
    assert [r['feature'] for r in releases] == ['Dark mode']
    assert list_releases(radar, 'acme', _today() - timedelta(days=1), 10) == []
    assert radar.get_item(Key=scan_key('LAST', A))['Item']['status'] == 'completed'
    assert 'Item' in radar.get_item(Key=brand_state_key('acme', A))
    assert radar.get_item(Key=radar_settings_key('version', A))['Item']['v'] == 1
    assert not any(pk.startswith(('RELEASE#', 'RADARSCAN')) for pk in _pks(radar))
    # A workspace keeps no Exa key yet: its scan never reads the deployment's.
    exa.assert_not_called()
    # Each per-brand partition it wrote is named first in A's owner list, for its hard delete.
    owned = {row['sk'] for row in radar.query(KeyConditionExpression='pk = :p', ExpressionAttributeValues={
        ':p': f'WS#{A.ws}#RADAR_OWNED'})['Items']}
    assert owned == {f'WS#{A.ws}#RELEASE#acme', brand_state_key('acme', A)['pk']}


def test_without_its_own_brands_a_workspace_scans_nothing_the_deployments_brands_included(world):
    radar, _, search, _ = world
    radar.put_item(Item={**radar_settings_key('brands'), 'brands': [{'label': 'Globex', 'domains': ['globex.com']}]})
    assert handler.handle_event({'mode': 'manual', 'workspace_id': B}, _context()) == {
        'status': 'skipped', 'reason': 'no_brands'}
    search.assert_not_called()


def test_each_workspace_has_its_own_lock_and_cadence(world):
    radar, _, search, _ = world
    now = int(datetime.now(UTC).timestamp())
    radar.put_item(Item={**scan_key('LOCK'), 'expires_at': now + 600})
    radar.put_item(Item={**scan_key('LAST'), 'finished_at': datetime.now(UTC).isoformat()})
    # The deployment's running scan and recent finish do not hold A's.
    assert handler.handle_event({'mode': 'scheduled', 'workspace_id': A.ws}, _context())['status'] == 'completed'
    radar.put_item(Item={**scan_key('LOCK', A), 'expires_at': now + 600})
    assert handler.handle_event({'mode': 'manual', 'workspace_id': A.ws}, _context())['reason'] == 'already_running'
    assert search.call_count >= 1


@pytest.mark.parametrize('named', ['', 'ws_short', 42, f'WS#{A.ws}'])
def test_an_event_naming_no_valid_workspace_is_refused_never_scanned_as_the_deployments(world, named):
    radar, _, search, _ = world
    radar.put_item(Item={**radar_settings_key('brands'), 'brands': [{'label': 'Globex', 'domains': ['globex.com']}]})
    assert handler.handle_event({'mode': 'manual', 'workspace_id': named}, _context()) == {
        'status': 'refused', 'reason': 'invalid_workspace'}
    search.assert_not_called()


@pytest.mark.usefixtures('world')
def test_the_schedules_tick_starts_one_scan_per_active_workspace_then_scans_the_deployments(monkeypatch):
    workspaces = boto3.resource('dynamodb', region_name='us-east-1').Table('workspaces')
    for ws, status in ((A.ws, 'active'), (B, 'deleting')):
        workspaces.put_item(Item={'pk': 'WORKSPACES', 'sk': ws, 'workspace_id': ws, 'id': ws, 'status': status,
                                  'name': ws, 'slug': ws[-6:].lower()})
    started = []
    monkeypatch.setattr(handler, 'WORKSPACES_TABLE', 'workspaces')
    monkeypatch.setenv('AWS_LAMBDA_FUNCTION_NAME', 'voc-radar-scan')
    monkeypatch.setattr(handler, 'invoke_lambda_async', lambda name, event: started.append((name, event)) or {})
    outcome = handler.handle_event({'mode': 'scheduled'}, _context())
    assert started == [('voc-radar-scan', {'mode': 'scheduled', 'workspace_id': A.ws})]
    # The deployment's own scan still runs (it has no brands here).
    assert outcome == {'status': 'skipped', 'reason': 'no_brands'}


@pytest.mark.usefixtures('world')
def test_a_listing_fault_never_stops_the_deployments_scan(monkeypatch):
    monkeypatch.setattr(handler, 'WORKSPACES_TABLE', 'workspaces')
    monkeypatch.setenv('AWS_LAMBDA_FUNCTION_NAME', 'voc-radar-scan')
    monkeypatch.setattr(handler, 'active_workspaces', MagicMock(side_effect=RuntimeError('throttled')))
    assert handler.handle_event({'mode': 'scheduled'}, _context()) == {'status': 'skipped', 'reason': 'no_brands'}


@pytest.mark.usefixtures('world')
def test_a_workspace_run_never_fans_out_again(monkeypatch):
    fan_out = MagicMock()
    monkeypatch.setattr(handler, 'fan_out', fan_out)
    handler.handle_event({'mode': 'scheduled', 'workspace_id': A.ws}, _context())
    handler.handle_event({'mode': 'manual'}, _context())
    fan_out.assert_not_called()


@pytest.mark.usefixtures('world')
def test_one_workspaces_failed_start_never_stops_the_others_nor_the_deployments_scan(monkeypatch):
    workspaces = boto3.resource('dynamodb', region_name='us-east-1').Table('workspaces')
    for ws in (A.ws, B):
        workspaces.put_item(Item={'pk': 'WORKSPACES', 'sk': ws, 'workspace_id': ws, 'id': ws, 'status': 'active',
                                  'name': ws, 'slug': ws[-6:].lower()})
    started, counted = [], MagicMock()
    monkeypatch.setattr(handler, 'WORKSPACES_TABLE', 'workspaces')
    monkeypatch.setenv('AWS_LAMBDA_FUNCTION_NAME', 'voc-radar-scan')
    monkeypatch.setattr(handler.metrics, 'add_metric', counted)

    def invoke(_name, event):
        if event['workspace_id'] == A.ws:
            raise RuntimeError('throttled')
        started.append(event['workspace_id'])
        return {}

    monkeypatch.setattr(handler, 'invoke_lambda_async', invoke)
    assert handler.fan_out() == 1
    assert started == [B]
    assert [c.kwargs['name'] for c in counted.call_args_list] == ['RadarScanFanOutFailures']
    assert handler.handle_event({'mode': 'scheduled'}, _context()) == {'status': 'skipped', 'reason': 'no_brands'}


def test_a_workspace_being_deleted_gets_no_scan_and_no_row(world):
    radar, _, search, _ = world
    boto3.resource('dynamodb', region_name='us-east-1').Table('workspaces').put_item(
        Item={'pk': f'WS#{A.ws}', 'sk': 'META', 'status': 'deleting'})
    assert handler.handle_event({'mode': 'manual', 'workspace_id': A.ws}, _context()) == {
        'status': 'skipped', 'reason': 'workspace_not_active'}
    search.assert_not_called()
    assert not any(pk.startswith(f'WS#{A.ws}#RADARSCAN') or pk.endswith('RADAR_OWNED') for pk in _pks(radar))


def test_a_workspace_that_stops_being_active_mid_scan_gets_nothing_more(world, monkeypatch):
    radar, _, _, _ = world
    answers = iter([True, False])
    monkeypatch.setattr(handler, '_workspace_active', lambda _scope: next(answers))
    assert handler.handle_event({'mode': 'manual', 'workspace_id': A.ws}, _context()) == {
        'status': 'stopped', 'reason': 'workspace_not_active'}
    # The lock it took expires by itself; no outcome, no owner list, no release, no released lock written.
    assert 'Item' not in radar.get_item(Key=scan_key('LAST', A))
    assert not any(pk.endswith(('RADAR_OWNED', '#RELEASE#acme')) for pk in _pks(radar))
    assert radar.get_item(Key=scan_key('LOCK', A))['Item']['expires_at'] > 0
