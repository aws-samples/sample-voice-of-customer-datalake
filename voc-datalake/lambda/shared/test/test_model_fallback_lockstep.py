"""
The model capacity fallback exists twice: shared.model_fallback / model_config
(REST + job inference) and lambda/stream/src/bedrock/model-fallback.ts (the
streaming assistant). If the two drift, the same throttled model falls back on
one path and fails the request on the other, or the two walk different chains.
These tests read the TypeScript source and pin every mirrored constant.

Conventions (positive controls, full checkout): see shared/test/repo_paths.py.
"""
import re

from shared import model_fallback
from shared.model_config import MODEL_FALLBACK_ORDER, SURFACE_DEFAULTS
from shared.test.repo_paths import repo_root

TS_PATH = repo_root() / 'lambda' / 'stream' / 'src' / 'bedrock' / 'model-fallback.ts'


def _ts() -> str:
    return TS_PATH.read_text(encoding='utf-8')


def _block(name: str, closer: str) -> str:
    source = _ts()
    start = source.index(f'{name}')
    return source[start:source.index(closer, start)]


def _ts_strings(name: str, closer: str) -> list[str]:
    return re.findall(r"'([^']+)'", _block(name, closer).split('=', 1)[1])


def _ts_order() -> list[str]:
    return _ts_strings('export const MODEL_FALLBACK_ORDER', '];')


def _ts_patterns() -> list[str]:
    block = _block('const MODEL_UNAVAILABLE_PATTERNS', '];').split('= [', 1)[1]
    return re.findall(r'^\s*/(.+)/,$', block, flags=re.MULTILINE)


class TestPositiveControls:
    """The parsers below must find something, or equality proves nothing."""

    def test_ts_source_exists_and_parses(self):
        assert TS_PATH.is_file()
        assert len(_ts_order()) >= 2
        assert len(_ts_patterns()) >= 3
        assert _ts_strings('const CAPACITY_ERROR_CODES', ']);')
        assert _ts_strings('const MESSAGE_GATED_CODES', ']);')
        assert re.search(r'export const COOLDOWN_SECONDS = (\d+);', _ts())


class TestLockstep:
    def test_fallback_order_matches(self):
        assert tuple(_ts_order()) == MODEL_FALLBACK_ORDER

    def test_chat_surface_default_matches(self):
        match = re.search(r"export const CHAT_SURFACE_DEFAULT = '([^']+)';", _ts())
        assert match is not None
        assert match.group(1) == SURFACE_DEFAULTS['chat']

    def test_cooldown_matches(self):
        match = re.search(r'export const COOLDOWN_SECONDS = (\d+);', _ts())
        assert match is not None
        assert int(match.group(1)) == model_fallback.COOLDOWN_SECONDS

    def test_capacity_codes_match(self):
        ts_codes = set(_ts_strings('const CAPACITY_ERROR_CODES', ']);'))
        assert ts_codes == set(model_fallback.CAPACITY_ERROR_CODES)

    def test_message_gated_codes_match(self):
        ts_codes = set(_ts_strings('const MESSAGE_GATED_CODES', ']);'))
        assert ts_codes == set(model_fallback.MESSAGE_GATED_CODES)

    def test_unavailable_patterns_match_in_order(self):
        assert _ts_patterns() == list(model_fallback.MODEL_UNAVAILABLE_PATTERNS)

    def test_metric_name_matches(self):
        match = re.search(r"const MODEL_FALLBACK_METRIC = '([^']+)';", _ts())
        assert match is not None
        assert match.group(1) == model_fallback.MODEL_FALLBACK_METRIC
