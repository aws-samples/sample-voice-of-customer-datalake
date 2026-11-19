"""py_graph: one bundle's reach never depends on the bundles analysed before it with the same ParseCache."""
from __future__ import annotations

from pathlib import Path

from py_graph import Graph, ParseCache

LAZY = '''
def signed():
    from shared.signing import sign
    return sign()

def plain():
    return 1
'''
SIGNING = '''
import cryptography

def sign():
    return cryptography
'''


def _bundle(root: Path, handler: str) -> dict[str, Path]:
    (root / 'shared').mkdir(parents=True, exist_ok=True)
    files = {'shared': '', 'shared.lazy': LAZY, 'shared.signing': SIGNING, 'handler': handler}
    modules: dict[str, Path] = {}
    for name, text in files.items():
        path = root / ('shared/__init__.py' if name == 'shared' else f"{name.replace('.', '/')}.py")
        path.write_text(text, encoding='utf-8')
        modules[name] = path
    return modules


def test_a_lazy_import_one_bundle_reaches_is_not_followed_by_the_next(tmp_path: Path) -> None:
    signs = _bundle(tmp_path / 'a', 'from shared import lazy\n\ndef lambda_handler(event, context):\n    return lazy.signed()\n')
    plain = _bundle(tmp_path / 'b', 'from shared import lazy\n\ndef lambda_handler(event, context):\n    return lazy.plain()\n')
    # The same files under the same names in both bundles, so they share the cache's parsed modules.
    shared = {name: signs[name] for name in ('shared', 'shared.lazy', 'shared.signing')}
    cache = ParseCache()
    first = Graph({**shared, 'handler': signs['handler']}, cache).run([('handler', 'lambda_handler')])
    second = Graph({**shared, 'handler': plain['handler']}, cache).run([('handler', 'lambda_handler')])
    alone = Graph({**shared, 'handler': plain['handler']}, ParseCache()).run([('handler', 'lambda_handler')])
    assert ('shared.signing', 'sign') in first.alive
    assert 'shared.signing' not in second.loaded
    assert (second.loaded, second.alive) == (alone.loaded, alone.alive)
