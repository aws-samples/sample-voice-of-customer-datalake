"""Radar's configuration rows per workspace (shared/radar_keys.py; docs/multi-workspace.md, decision 13)."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from moto import mock_aws

from briefing import radar_cards
from shared.data_version import RADAR_VERSION_KEY
from shared.radar_brands import BRAND_LIST_KEY, load_brand_list
from shared.radar_keys import radar_settings_key
from shared.radar_routing import BrandLabels, RadarBrandListUnavailableError, UnknownRadarBrandError
from shared.radar_settings import DEFAULT_SETTINGS, SETTINGS_KEY, load_settings
from shared.test.radar_fixtures import radar_pk_sk_table
from shared.workspace_config import get_scoped_item
from shared.ws_repo import OutOfScopeError, WorkspaceScope

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')


@pytest.fixture
def table():
    with mock_aws():
        yield radar_pk_sk_table('radar')


def test_the_deployments_keys_are_unchanged():
    assert SETTINGS_KEY == {'pk': 'SETTINGS#radar', 'sk': 'config'}
    assert BRAND_LIST_KEY == {'pk': 'SETTINGS#radar', 'sk': 'brands'}
    assert RADAR_VERSION_KEY == {'pk': 'SETTINGS#radar', 'sk': 'version'}


def test_a_workspaces_keys_are_in_its_own_partitions():
    assert radar_settings_key('config', A) == {'pk': f'WS#{A.ws}#SETTINGS#radar', 'sk': 'config'}
    assert radar_settings_key('brands', A) == {'pk': f'WS#{A.ws}#SETTINGS#radar', 'sk': 'brands'}
    assert A.owns(radar_settings_key('config', A)['pk'])
    assert not B.owns(radar_settings_key('config', A)['pk'])


def test_a_workspace_has_no_version_row_of_its_own_yet():
    with pytest.raises(ValueError, match='version'):
        radar_settings_key('version', A)


def test_a_key_outside_the_workspace_never_reaches_dynamodb(table):
    with patch.object(table, 'get_item') as get_item, pytest.raises(OutOfScopeError):
        get_scoped_item(table, radar_settings_key('config', B), A)
    with pytest.raises(OutOfScopeError):
        get_scoped_item(table, SETTINGS_KEY, A)
    get_item.assert_not_called()


def test_the_settings_are_each_workspaces_own(table):
    table.put_item(Item={**SETTINGS_KEY, 'cadence': 'daily', 'max_brands': 3, 'query_cap': 9})
    table.put_item(Item={**radar_settings_key('config', A), 'cadence': 'monthly', 'max_brands': 5, 'query_cap': 7})
    assert load_settings(table) == {'cadence': 'daily', 'max_brands': 3, 'query_cap': 9}
    assert load_settings(table, A) == {'cadence': 'monthly', 'max_brands': 5, 'query_cap': 7}
    # A workspace with no row of its own has the defaults, never the deployment's settings.
    assert load_settings(table, B) == DEFAULT_SETTINGS


def test_the_brand_list_is_each_workspaces_own(table):
    table.put_item(Item={**BRAND_LIST_KEY, 'brands': [{'label': 'Northwind', 'domains': ['northwind.example']}]})
    table.put_item(Item={**radar_settings_key('brands', A),
                         'brands': [{'label': 'Contoso', 'domains': ['contoso.example']}]})
    assert [brand['label'] for brand in load_brand_list(table)] == ['Northwind']
    assert [brand['label'] for brand in load_brand_list(table, A)] == ['Contoso']
    assert load_brand_list(table, B) == []


class TestBrandLabels:
    def _lists(self, table):
        table.put_item(Item={**BRAND_LIST_KEY, 'brands': [{'label': 'Northwind', 'domains': ['northwind.example']}]})
        table.put_item(Item={**radar_settings_key('brands', A),
                             'brands': [{'label': 'Contoso', 'domains': ['contoso.example']}]})

    def test_each_workspace_resolves_only_its_own_brands(self, table):
        self._lists(table)
        labels = BrandLabels()
        assert labels.label(table, [], 'contoso', A) == 'Contoso'
        assert labels.label(table, [], 'northwind') == 'Northwind'
        with pytest.raises(UnknownRadarBrandError):
            labels.label(table, [], 'northwind', A)
        with pytest.raises(UnknownRadarBrandError):
            labels.label(table, [], 'contoso')
        with pytest.raises(UnknownRadarBrandError):
            labels.label(table, [], 'contoso', B)

    def test_the_cache_is_kept_per_workspace(self, table):
        self._lists(table)
        now = [0.0]
        labels = BrandLabels(ttl=60.0, clock=lambda: now[0])
        labels.label(table, [], 'contoso', A)
        labels.label(table, [], 'northwind')
        with patch('shared.radar_routing.load_brand_list', wraps=load_brand_list) as reads:
            now[0] = 30.0
            assert labels.label(table, [], 'contoso', A) == 'Contoso'
            assert labels.label(table, [], 'northwind') == 'Northwind'
            assert reads.call_count == 0
            now[0] = 61.0
            labels.label(table, [], 'contoso', A)
            assert [call.args[1] for call in reads.call_args_list] == [A]

    def test_a_list_that_cannot_be_read_forgets_only_that_workspaces_copy(self, table):
        self._lists(table)
        labels = BrandLabels()
        labels.label(table, [], 'contoso', A)
        labels.label(table, [], 'northwind')
        table.put_item(Item={**radar_settings_key('brands', A), 'brands': 'not a list'})
        with pytest.raises(RadarBrandListUnavailableError):
            labels.label(table, [], 'missing', A)
        with patch('shared.radar_routing.load_brand_list') as reads:
            assert labels.label(table, [], 'northwind') == 'Northwind'
            reads.assert_not_called()


def test_the_brief_reads_the_workspaces_brand_list_and_profiles(table):
    table.put_item(Item={**radar_settings_key('brands', A),
                         'brands': [{'label': 'Contoso', 'domains': ['contoso.example']}]})
    with patch.object(radar_cards, 'load_source_profiles', return_value=[]) as profiles:
        brands = radar_cards.effective_brands('aggregates', table, A)
    assert [brand.label for brand in brands] == ['Contoso']
    profiles.assert_called_once_with('aggregates', A)
