"""shared/workspace_ids.py: a workspace id and the names built from it, importable without the request path."""
import ast
from pathlib import Path

import pytest

from shared import workspace, workspace_ids
from shared.workspace_ids import credentials_secret_name, is_workspace_id, ws_key

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


def test_a_key_and_a_secret_name_refuse_an_id_that_is_not_one():
    assert ws_key(WS, 'SOURCE', 'web') == f'WS#{WS}#SOURCE#web'
    assert credentials_secret_name('voc/ws', WS) == f'voc/ws/{WS}/credentials'
    with pytest.raises(ValueError, match='not a workspace id'):
        ws_key('acme', 'SOURCE')
    with pytest.raises(ValueError, match='not a workspace id'):
        credentials_secret_name('voc/ws', '../acme')
    with pytest.raises(ValueError, match='no secret prefix'):
        credentials_secret_name('', WS)


def test_the_middleware_serves_the_same_functions():
    """shared/workspace.py re-exports them, so one rule decides an id everywhere."""
    assert workspace.is_workspace_id is is_workspace_id
    assert workspace.ws_key is ws_key


def test_it_imports_nothing_but_the_standard_library():
    """The asynchronous workers (the ingestors, the queue schema) import it without the request path."""
    tree = ast.parse(Path(workspace_ids.__file__).read_text(encoding='utf-8'))
    imported = {alias.name.split('.')[0] for node in ast.walk(tree) if isinstance(node, ast.Import)
                for alias in node.names}
    imported |= {(node.module or '').split('.')[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    assert imported <= {'__future__', 're', 'typing'}
