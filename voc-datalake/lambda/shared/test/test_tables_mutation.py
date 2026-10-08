"""Mutation hardening for `shared/tables.py`.

`test_tables.py` covered only the jobs and aggregates accessors, and only with
the env var set to an empty string. A mutation run found what it could not see:

* the ENV VAR NAME behind the feedback and projects accessors — a renamed
  ``FEEDBACK_TABLE`` / ``PROJECTS_TABLE`` literal survived, so every accessor
  is now pinned to its exact variable and the exact table name it builds;
* the DEFAULT for an UNSET variable: ``os.environ.get(env_var, '')`` mutated to
  a non-empty default built a Table for a name nobody configured. An absent
  variable must answer ``None`` without touching DynamoDB;
* that an unconfigured table is not cached as ``None`` — the variable set
  later (a warm container after a config change, or a test) is honoured.

This file supersedes `test_tables.py`, whose cases it restates for all four
accessors.
"""
import os
from collections.abc import Callable, Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from shared import tables
from shared.tables import (
    get_aggregates_table,
    get_feedback_table,
    get_jobs_table,
    get_projects_table,
)

ACCESSORS: list[tuple[Callable[[], Any], str]] = [
    (get_jobs_table, 'JOBS_TABLE'),
    (get_aggregates_table, 'AGGREGATES_TABLE'),
    (get_feedback_table, 'FEEDBACK_TABLE'),
    (get_projects_table, 'PROJECTS_TABLE'),
]
ALL_ENV_VARS = [env_var for _, env_var in ACCESSORS]


@pytest.fixture
def resource() -> Iterator[MagicMock]:
    """A DynamoDB resource double; `Table(...)` answers `dynamodb.Table.return_value`.

    The accessor cache is emptied before AND after, so no double built here is
    served to a later test.
    """
    dynamodb = MagicMock()
    tables._cache.clear()
    with patch('shared.tables.get_dynamodb_resource', return_value=dynamodb):
        yield dynamodb
    tables._cache.clear()


@pytest.fixture
def unset_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove every table env var (absent, not empty)."""
    for env_var in ALL_ENV_VARS:
        monkeypatch.delenv(env_var, raising=False)


@pytest.mark.usefixtures('unset_env')
@pytest.mark.parametrize(('accessor', 'env_var'), ACCESSORS)
class TestEachAccessorReadsItsOwnEnvVar:
    def test_builds_the_table_named_by_its_env_var(
        self, accessor: Callable[[], Any], env_var: str, resource: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setenv(env_var, f'voc-{env_var.lower()}')

        table = accessor()

        resource.Table.assert_called_once_with(f'voc-{env_var.lower()}')
        assert table is resource.Table.return_value

    def test_ignores_the_other_accessors_env_vars(
        self, accessor: Callable[[], Any], env_var: str, resource: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ):
        for other in ALL_ENV_VARS:
            if other != env_var:
                monkeypatch.setenv(other, f'voc-{other.lower()}')

        assert accessor() is None
        resource.Table.assert_not_called()

    def test_reuses_the_cached_table(
        self, accessor: Callable[[], Any], env_var: str, resource: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setenv(env_var, 'first-name')
        first = accessor()
        monkeypatch.setenv(env_var, 'second-name')

        assert accessor() is first
        resource.Table.assert_called_once_with('first-name')


@pytest.mark.usefixtures('unset_env')
@pytest.mark.parametrize(('accessor', 'env_var'), ACCESSORS)
class TestAnUnconfiguredTableIsNoneAndNotCached:
    def test_absent_env_var_answers_none_without_building_a_table(
        self, accessor: Callable[[], Any], env_var: str, resource: MagicMock,
    ):
        assert env_var not in os.environ

        assert accessor() is None
        resource.Table.assert_not_called()

    def test_empty_env_var_answers_none_without_building_a_table(
        self, accessor: Callable[[], Any], env_var: str, resource: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setenv(env_var, '')

        assert accessor() is None
        resource.Table.assert_not_called()

    def test_a_variable_set_after_a_miss_is_honoured(
        self, accessor: Callable[[], Any], env_var: str, resource: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ):
        assert accessor() is None
        monkeypatch.setenv(env_var, 'late-table')

        accessor()

        resource.Table.assert_called_once_with('late-table')
