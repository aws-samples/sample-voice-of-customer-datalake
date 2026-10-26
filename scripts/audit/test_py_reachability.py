"""py_reachability finds planted dead code and stays quiet on the live look-alikes (graph rules)."""
from __future__ import annotations

import pytest
from audit_common import CDK_DIR
from py_reachability import analyse, findings, main

from conftest import TreeMaker, assembly_of, lambda_function

COPY = 'cp /asset-input/api/app_handler.py /asset-output/ && cp -r /asset-input/shared /asset-output/'

HANDLER = '''
import importlib
from html.parser import HTMLParser
from shared import lib
from shared.lib import used_by_name
from shared import strategies

app = object()

@app.get('/things')
def list_things():
    return lib.Cache().clear_live()

def lambda_handler(event, context):
    used_by_name()
    Parser().feed('<p>')
    kind = event['kind'] if event['kind'] in NODE_KINDS else 'alpha'
    getattr(strategies, 'by_string')()
    return importlib.import_module(f'shared.nodes.{kind}').finish(event)

class Parser(HTMLParser):
    def handle_starttag(self, tag, attrs):
        return tag

NODE_KINDS = ('alpha',)
'''

LIB = '''
__all__ = ['used_by_name', 'exported_only']

def used_by_name():
    return 1

def exported_only():
    return 2

def dead_helper():
    return 3

def seam_only_tests_call():
    return 4

class Cache:
    def clear_live(self):
        return 5

    def clear(self):
        return 6
'''

FILES = {
    'lambda/api/app_handler.py': HANDLER,
    'lambda/shared/__init__.py': '',
    'lambda/shared/lib.py': LIB,
    'lambda/shared/strategies.py': 'def by_string():\n    return 1\n\ndef never():\n    return 2\n',
    'lambda/shared/nodes/__init__.py': '',
    'lambda/shared/nodes/alpha.py': 'def finish(event):\n    return event\n\ndef unused():\n    return 0\n',
    'lambda/orphan/tool.py': 'def build():\n    return 1\n',
    'lambda/shared/test/test_lib.py': 'from shared.lib import seam_only_tests_call\n\n'
                                       'def test_seam():\n    assert seam_only_tests_call() == 4\n',
}


@pytest.fixture
def result(make_tree: TreeMaker) -> dict[str, str]:
    root = make_tree(FILES)
    program = analyse(root, assembly_of(lambda_function('Api/Fn', 'app_handler.lambda_handler', COPY)))
    return {f.key: f.kind for f in findings(program)}


def test_planted_dead_code_is_found(result: dict[str, str]) -> None:
    assert result == {
        'lambda/shared/lib.py::exported_only': 'dead',             # alive only through __all__
        'lambda/shared/lib.py::dead_helper': 'dead',
        'lambda/shared/lib.py::seam_only_tests_call': 'test-only',
        'lambda/shared/lib.py::Cache.clear': 'dead',               # `.clear_live()` is not `.clear()`
        'lambda/shared/strategies.py::never': 'dead',
        'lambda/shared/nodes/alpha.py::unused': 'dead',
        'lambda/orphan/tool.py': 'unbundled-module',
    }


def test_the_live_look_alikes_stay_quiet(result: dict[str, str]) -> None:
    for live in ('list_things', 'lambda_handler', 'used_by_name', 'by_string', 'finish', 'Parser.handle_starttag',
                 'Cache.clear_live'):
        assert not [k for k in result if k.endswith(f'::{live}')], live


def test_an_unused_package_reexport_is_found_and_a_used_one_is_not(make_tree: TreeMaker) -> None:
    files = {**FILES, 'lambda/shared/reexports/__init__.py': 'from shared.lib import used_by_name, Cache\n',
             'lambda/api/app_handler.py': HANDLER + '\nfrom shared.reexports import Cache as Reexported\nReexported()\n'}
    program = analyse(make_tree(files), assembly_of(lambda_function('Api/Fn', 'app_handler.lambda_handler', COPY)))
    kinds = {f.key: f.kind for f in findings(program)}
    assert kinds['lambda/shared/reexports/__init__.py::used_by_name'] == 'unused-reexport'
    assert 'lambda/shared/reexports/__init__.py::Cache' not in kinds


def test_vacuity_guard_on_the_real_tree() -> None:
    """The whole app: every Python Lambda analysed, hundreds of modules and thousands of symbols live."""
    assert main(['--cdk-dir', str(CDK_DIR)]) == 0
