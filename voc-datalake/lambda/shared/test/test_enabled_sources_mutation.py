"""Mutation hardening for `shared/enabled_sources.py`.

`test_enabled_sources.py` pins the RESULT of every input — the plugin ids in
deploy order, `manual_import` last, bad entries dropped — but a mutation run
found what it cannot see:

* the NAME of the variable. Every earlier test reads the name back from the
  module's own constant, so renaming it passed; CDK renders the list into an
  env var literally called ``ENABLED_SOURCES``, and the two must agree.
* the WARNING each soft failure logs. An unusable variable silently lists no
  plugins, so the warning is the only way an operator learns why the Settings
  or Logs page shows only ``manual_import``. Each cause logs its own message,
  pinned here as a literal, and the dropped-entry count is exact.
* that an absent variable is treated as empty (not as some other unparsable
  default), which only the warning can tell apart.
"""
import json
from unittest.mock import MagicMock

import pytest

from shared import enabled_sources
from shared.enabled_sources import default_source_ids


@pytest.fixture
def warning(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    fake_logger = MagicMock()
    monkeypatch.setattr(enabled_sources, 'logger', fake_logger)
    return fake_logger.warning


def test_the_list_is_read_from_the_variable_cdk_renders(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('ENABLED_SOURCES', json.dumps(['webscraper']))

    assert default_source_ids() == ['webscraper', 'manual_import']


class TestEverySoftFailureNamesItsCause:
    def test_an_absent_variable_says_it_is_not_set(
        self, monkeypatch: pytest.MonkeyPatch, warning: MagicMock,
    ) -> None:
        monkeypatch.delenv('ENABLED_SOURCES', raising=False)

        assert default_source_ids() == ['manual_import']
        warning.assert_called_once_with('ENABLED_SOURCES is not set; listing no plugin sources')

    @pytest.mark.parametrize(('raw', 'message'), [
        ('', 'ENABLED_SOURCES is not set; listing no plugin sources'),
        ('not json', 'ENABLED_SOURCES is not valid JSON; listing no plugin sources'),
        ('{"webscraper": true}', 'ENABLED_SOURCES is not a JSON array; listing no plugin sources'),
        ('"webscraper"', 'ENABLED_SOURCES is not a JSON array; listing no plugin sources'),
    ])
    def test_an_unusable_value_logs_exactly_its_cause(
        self, monkeypatch: pytest.MonkeyPatch, warning: MagicMock, raw: str, message: str,
    ) -> None:
        monkeypatch.setenv('ENABLED_SOURCES', raw)

        assert default_source_ids() == ['manual_import']
        warning.assert_called_once_with(message)


class TestDroppedEntriesAreCountedExactly:
    def test_a_fully_valid_list_logs_nothing(
        self, monkeypatch: pytest.MonkeyPatch, warning: MagicMock,
    ) -> None:
        monkeypatch.setenv('ENABLED_SOURCES', json.dumps(['webscraper', 's3_import']))

        assert default_source_ids() == ['webscraper', 's3_import', 'manual_import']
        warning.assert_not_called()

    def test_the_warning_counts_only_the_dropped_entries(
        self, monkeypatch: pytest.MonkeyPatch, warning: MagicMock,
    ) -> None:
        monkeypatch.setenv('ENABLED_SOURCES', json.dumps(['webscraper', '../etc', 7, 's3_import']))

        assert default_source_ids() == ['webscraper', 's3_import', 'manual_import']
        warning.assert_called_once_with('Ignoring 2 malformed ENABLED_SOURCES entries')
