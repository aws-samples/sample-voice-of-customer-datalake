"""Mutation-run pins for `shared/source_profiles.py` that `test_source_profiles.py` could not see.

The mutation run found: refusals asserted only by a fragment (the id regex and the two
``dimension_defaults`` shape messages, the ``Source id`` wording of ``bounded_text``),
the 503's client-safe message never read, ``load_source_profiles`` keeping only the
first unchecked default (``continue`` → ``break`` survived), ``profile_for``'s copy of
``dimension_defaults`` never compared with the stored value, the strict reader
without ``AGGREGATES_TABLE`` never called, and the import-time cache never exercised
(every test cleared it first). Two cache writes in ``clear_source_profiles_cache``
(``expires``, ``failed``) were dead — a cleared ``profiles`` forces the read that
rewrites both — and were removed.
"""
import importlib.util
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock, patch

import pytest

from shared.source_profiles import (
    SourceProfilesUnavailable,
    cached_source_profile_strict,
    clear_source_profiles_cache,
    load_source_profiles,
    profile_for,
    validate_source_profiles,
)

_MODULE_PATH = Path(__file__).resolve().parents[1] / 'source_profiles.py'
_ID_MESSAGE = 'Source ids must be 1-48 characters of a-z, 0-9, "_" or "-", starting with a letter or digit'


@pytest.fixture(autouse=True)
def _fresh_cache():
    clear_source_profiles_cache()
    yield
    clear_source_profiles_cache()


def _refusal(value: object) -> str:
    with pytest.raises(ValueError, match=r'.') as exc_info:
        validate_source_profiles(value, [])
    return str(exc_info.value)


def _table(sources: list[dict]) -> MagicMock:
    """An aggregates table whose `get_item` returns the settings row holding *sources*."""
    row = {'Item': {'sources': sources}}
    return MagicMock(get_item=MagicMock(return_value=row))


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('entry', 'message'), [
        ({'id': 'Bad Id'}, _ID_MESSAGE),
        ({'id': 5}, 'Source id must be a string'),
        ({'id': 'a' * 65}, 'Source id must be at most 64 characters'),
        ({'id': 's', 'dimension_defaults': ['product']}, 'Source "s" dimension_defaults must be an object'),
        ({'id': 's', 'dimension_defaults': {'product': 3}},
         'Source "s" dimension_defaults must map dimension keys to value names'),
        ({'id': 's', 'dimension_defaults': {3: 'app'}},
         'Source "s" dimension_defaults must map dimension keys to value names'),
    ])
    def test_the_exact_message(self, entry, message):
        assert _refusal([entry]) == message

    def test_the_unavailable_error_carries_the_client_safe_message(self):
        error = SourceProfilesUnavailable()
        assert error.message == 'Source settings are temporarily unavailable; please retry shortly'
        assert str(error) == 'Source settings are temporarily unavailable; please retry shortly'
        assert error.status_code == 503


class TestStoredDefaultsAreKeptWhole:
    def test_every_unchecked_default_of_a_stored_row_is_kept(self):
        table = _table([{'id': 's', 'dimension_defaults': {'retired': 'x', 'region': 'eu'}}])
        assert load_source_profiles(table)[0]['dimension_defaults'] == {'retired': 'x', 'region': 'eu'}

    def test_profile_for_returns_the_stored_defaults_and_tags(self):
        profiles = [{'id': 'a', 'dimension_defaults': {'product': 'app'}, 'tags': ['x']}]
        profile = profile_for(profiles, 'a')
        assert profile['dimension_defaults'] == {'product': 'app'}
        assert profile['tags'] == ['x']


class TestStrictReaderWithoutATable:
    def test_no_table_env_serves_the_defaults_instead_of_raising(self, monkeypatch):
        monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
        assert cached_source_profile_strict('support') == {
            'id': 'support', 'label': 'support', 'pii': 'allow', 'retention_days': None,
            'restricted': False, 'dimension_defaults': {}, 'tags': [],
        }


def _fresh_module() -> ModuleType:
    """A new copy of the module, so its import-time cache is the one under test."""
    spec = importlib.util.spec_from_file_location('source_profiles_fresh_copy', _MODULE_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestImportTimeCache:
    def test_the_first_call_after_import_reads_the_table(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        module = _fresh_module()
        resource = MagicMock()
        resource.Table.return_value = _table([{'id': 'support', 'pii': 'redact'}])
        with patch.object(module, 'get_dynamodb_resource', return_value=resource):
            assert module.cached_source_profile_strict('support')['pii'] == 'redact'
        resource.Table.assert_called_once_with('agg')
