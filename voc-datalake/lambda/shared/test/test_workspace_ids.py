"""shared/workspace_ids.py: a workspace id and the names built from it, importable without the request path."""
import ast
from pathlib import Path

import pytest

from shared import workspace, workspace_ids
from shared.workspace_ids import credentials_parameter_name, credentials_path, is_workspace_id, ws_key

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'


@pytest.mark.parametrize('value', [WS, 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ', 'ws_00000000000000000000000000'])
def test_a_ulid_with_the_prefix_is_a_workspace_id(value):
    assert is_workspace_id(value)


@pytest.mark.parametrize('value', [
    '', 'ws_', 'WS_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'ws_81JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DI',
    'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D', f'{WS}0', f' {WS}', f'{WS}\n', None, 7, [WS],
])
def test_anything_else_is_not(value):
    assert not is_workspace_id(value)


def test_a_key_refuses_an_id_that_is_not_one():
    assert ws_key(WS, 'SOURCE', 'web') == f'WS#{WS}#SOURCE#web'
    with pytest.raises(ValueError, match='not a workspace id'):
        ws_key('acme', 'SOURCE')


@pytest.mark.parametrize('prefix', ['/voc/ws', '/stg-voc/ws'])
def test_one_parameter_per_plugin_namespace(prefix):
    """Decision 19: a plugin's keys in one parameter of the workspace."""
    assert credentials_path(prefix, WS) == f'{prefix}/{WS}/credentials'
    assert credentials_parameter_name(prefix, WS, 'github_issues') == f'{prefix}/{WS}/credentials/github_issues'


@pytest.mark.parametrize('ws', ['../acme', 'acme', f'{WS}/credentials', ''])
def test_a_name_refuses_an_id_that_is_not_one(ws):
    with pytest.raises(ValueError, match='not a workspace id'):
        credentials_parameter_name('/voc/ws', ws, 'webscraper')


@pytest.mark.parametrize('prefix', ['', 'voc/ws', '/voc/ws/', '/', '/voc/../ws', '/voc ws', '//voc'])
def test_a_name_refuses_a_prefix_that_is_not_a_path(prefix):
    with pytest.raises(ValueError, match='no parameter prefix'):
        credentials_parameter_name(prefix, WS, 'webscraper')


@pytest.mark.parametrize('plugin', ['', 'Web', 'web/../github', 'web-scraper', '_web', 'web_', 'a.b', 'x' * 65])
def test_a_name_refuses_a_plugin_id_that_is_not_one(plugin):
    """Nothing but a plugin id can be the last segment: no other plugin's or workspace's parameter is reachable."""
    with pytest.raises(ValueError, match='not a plugin id'):
        credentials_parameter_name('/voc/ws', WS, plugin)


def test_the_middleware_serves_the_same_functions():
    """shared/workspace.py re-exports them, so one rule decides an id everywhere."""
    assert workspace.is_workspace_id is is_workspace_id
    assert workspace.ws_key is ws_key


def test_it_imports_nothing_but_the_standard_library():
    """The asynchronous workers (the ingestors, the queue schema) import it without the request path: only the
    standard library and shared/plugin_identity.py, which imports only ``re``."""
    def imports(path: Path) -> set[str]:
        tree = ast.parse(path.read_text(encoding='utf-8'))
        names = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        return names | {node.module or '' for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}

    here = Path(workspace_ids.__file__)
    assert imports(here) <= {'__future__', 're', 'typing', 'shared.plugin_identity'}
    assert imports(here.with_name('plugin_identity.py')) <= {'__future__', 're', 'typing'}
