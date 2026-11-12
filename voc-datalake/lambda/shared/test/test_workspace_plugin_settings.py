"""shared/workspace_plugin_settings.py: the keys and the checks (the routes: api/test/test_workspaces_plugins_routes.py)."""
import pytest

from shared.enabled_sources import enabled_plugin_ids
from shared.exceptions import NotFoundError
from shared.workspace_plugin_settings import PLUGIN_NOT_FOUND, offered_plugin, plugin_key

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'


def test_the_row_is_the_plugin_s_partition_and_the_workspace_s_sort_key():
    """The layout the scheduled ingestor's fan-out reads (one partition per plugin, a sort key per workspace)."""
    assert plugin_key('webscraper', WS) == {'pk': 'PLUGIN#webscraper', 'sk': f'WS#{WS}'}


@pytest.mark.parametrize(('plugin', 'ws'), [('Not-A-Plugin', WS), ('web#scraper', WS), ('webscraper', 'ws_bad')])
def test_a_key_is_never_built_from_a_bad_plugin_or_workspace(plugin, ws):
    with pytest.raises(ValueError, match=r'not a (plugin|workspace) id'):
        plugin_key(plugin, ws)


@pytest.mark.parametrize('plugin', ['synthetic_reviews', '', None, 42, 'Webscraper'])
def test_only_a_plugin_of_the_ceiling_is_offered(plugin):
    with pytest.raises(NotFoundError, match=PLUGIN_NOT_FOUND):
        offered_plugin(plugin, ['webscraper'])
    assert offered_plugin('webscraper', ['webscraper']) == 'webscraper'


def test_the_ceiling_is_the_deployment_s_enabled_plugins_in_order_without_non_plugin_sources(monkeypatch):
    monkeypatch.setenv('ENABLED_SOURCES', '["app_reviews_ios", "webscraper", "Bad Id"]')
    assert enabled_plugin_ids() == ['app_reviews_ios', 'webscraper']
