"""scripts/check_timing_tests.py: which tests count as bounding their own running time, and which markings exempt them."""
from __future__ import annotations

import importlib.util
from pathlib import Path
from textwrap import dedent
from types import ModuleType

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / 'scripts' / 'check_timing_tests.py'


@pytest.fixture(scope='module')
def checker() -> ModuleType:
    spec = importlib.util.spec_from_file_location('check_timing_tests', SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _unmarked(checker: ModuleType, source: str) -> list[str]:
    return [line.split(' ', 1)[1] for line in checker.unmarked_timing_tests('t.py', dedent(source))]


TIMED = '''
import time
def test_fast():
    started = time.perf_counter()
    assert time.perf_counter() - started < 1.0
'''


def test_a_test_that_bounds_its_time_must_be_marked(checker):
    assert _unmarked(checker, TIMED) == ['test_fast']


@pytest.mark.parametrize('marking', ['@pytest.mark.timing\n', '@pytest.mark.timing()\n'])
def test_the_marker_on_the_test_exempts_it(checker, marking):
    assert _unmarked(checker, TIMED.replace('def test_fast', marking + 'def test_fast')) == []


@pytest.mark.parametrize('module_mark', ['pytestmark = pytest.mark.timing', 'pytestmark = [pytest.mark.slow, pytest.mark.timing]'])
def test_a_module_marker_exempts_every_test(checker, module_mark):
    assert _unmarked(checker, module_mark + '\n' + TIMED) == []


def test_a_class_marker_exempts_its_methods(checker):
    source = '''
    import time
    @pytest.mark.timing
    class TestFast:
        def test_fast(self):
            started = time.monotonic()
            assert time.monotonic() - started <= 1.0
    '''
    assert _unmarked(checker, source) == []


def test_a_clock_read_through_a_module_helper_counts(checker):
    source = '''
    import time
    def _timed(fn):
        started = time.process_time()
        fn()
        return time.process_time() - started
    def _twice(fn):
        return _timed(fn) + _timed(fn)
    def test_fast():
        assert _twice(lambda: None) < 2.0
    '''
    assert _unmarked(checker, source) == ['test_fast']


@pytest.mark.parametrize('source', [
    'import time\ndef test_no_bound():\n    time.perf_counter()\n    assert True\n',
    'def test_no_clock():\n    assert 1 < 2\n',
    'import time\ndef helper():\n    assert time.perf_counter() > 0\n',
])
def test_a_test_without_both_a_clock_and_an_ordering_is_not_timed(checker, source):
    assert _unmarked(checker, source) == []


def test_another_marker_named_like_it_does_not_exempt(checker):
    assert _unmarked(checker, TIMED.replace('def test_fast', '@other.timing\ndef test_fast')) == ['test_fast']
