"""Mutation survivors of `shared/document_versions.py` (both slices: 1-727 and 728-end), killed by example tests.

The two mutation suites mock the table with a MagicMock, which has every attribute, and build every ClientError
with an ``Error`` member, and the files a mutation run of this module is given never call the stale-save guard
through `persist_versioned_document` or `series_head_version` at all. What that left unpinned:

* a table object with no ``name`` at all (not a falsy one): every writer refuses it with its own ValueError,
  not an AttributeError from deep inside;
* a ClientError whose response has no ``Error`` member (botocore keeps the response as it was given): it is
  neither a conditional failure nor transient, so it is re-raised as itself (or logged as ``Unknown``);
* the stale-save guard as a save meets it: a client that loaded the series at another version than its head
  gets the 409, one that loaded the head gets the next version, and a counter that moves under a named version
  is the 409 at once, not retried;
* the series head an editor is shown (`series_head_version`): the counter, or every version in use past it;
* a stored PRD titled with its own type label (``'X — PRD'``) is the plain title's series when a save looks for
  the versions already in use.
"""
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

import shared.document_versions as dv
from shared.document_versions import (
    _acquire_legacy_migration,
    _ensure_allocation_history,
    _persist_legacy_identity,
    _release_legacy_migration,
    _series_state,
    _transient,
    persist_versioned_document,
    series_head_version,
)
from shared.exceptions import ConflictError
from shared.test.document_versions_fixtures import COUNTER_KEY, frozen_time
from shared.test.document_versions_fixtures import mock_table as _table
from shared.test.document_versions_fixtures import transactions as _transactions
from shared.test.test_document_versions_mutation_728_1498 import (
    CANONICAL,
    FIELDS,
    META,
    ORIGINAL,
    SERIES_KEY,
    _generated,
    _item,
    _persist,
    _store,
)

STALE = 'The document was changed by someone else; reload it and try again'


@pytest.fixture(autouse=True)
def frozen_clock() -> Iterator[tuple[MagicMock, MagicMock]]:
    with frozen_time() as clock:
        yield clock


@pytest.fixture
def no_legacy() -> Iterator[MagicMock]:
    """A project whose query finds no legacy rows (the save's own path is what is under test)."""
    with patch.object(dv, '_query_project_documents', return_value=[]) as query:
        yield query


def _bare_error() -> ClientError:
    """A ClientError whose response carries no ``Error`` member."""
    return ClientError({}, 'TransactWriteItems')


class _NamelessTable:
    """A table with reads but no ``name`` attribute at all."""

    def __init__(self) -> None:
        self.get_item = MagicMock(return_value={})


class TestATableWithoutANameIsRefused:
    def test_by_the_legacy_lease(self):
        with pytest.raises(ValueError, match=r'^Projects table name is required for legacy migration$'):
            _acquire_legacy_migration(SimpleNamespace(), 'p1', COUNTER_KEY, 'prd', 'launch', 'Launch', 3, 'me')

    def test_by_the_legacy_identity_write(self):
        with pytest.raises(ValueError, match=r'^Projects table name is required for legacy migration$'):
            _persist_legacy_identity(SimpleNamespace(), 'p1', COUNTER_KEY, 'prd', 't', 'me', ORIGINAL, CANONICAL,
                                     None)

    def test_by_the_allocation_history_repair(self):
        with pytest.raises(ValueError, match=r'^Projects table name is required for allocation history$'):
            _ensure_allocation_history(_NamelessTable(), 'p1', 'prd', 'a1', _generated())

    def test_by_a_save(self):
        with pytest.raises(ValueError, match=r'^Projects table name is required for document persistence$'):
            persist_versioned_document(SimpleNamespace(), 'p1', 'prd', 'Launch', 'a1', dict(FIELDS))


class TestAClientErrorWithoutAnErrorMemberIsReRaised:
    def test_it_is_not_transient(self):
        assert _transient(_bare_error()) is False

    def test_by_the_legacy_lease(self):
        table = _table()
        table.get_item.return_value = {}
        error = _bare_error()
        table.meta.client.transact_write_items.side_effect = [error]
        with pytest.raises(ClientError) as caught:
            _acquire_legacy_migration(table, 'p1', COUNTER_KEY, 'prd', 'launch', 'Launch', 3, 'me')
        assert caught.value is error

    def test_by_the_legacy_identity_write(self):
        table = _table()
        error = _bare_error()
        table.meta.client.transact_write_items.side_effect = [error]
        unsettled = patch.object(dv, '_legacy_identity_settled', return_value=False)
        with unsettled, pytest.raises(ClientError) as caught:
            _persist_legacy_identity(table, 'p1', COUNTER_KEY, 'prd', 't', 'me', ORIGINAL, CANONICAL, None)
        assert caught.value is error

    def test_by_the_allocation_history_repair(self):
        table = _store(META)
        error = _bare_error()
        table.meta.client.transact_write_items.side_effect = [error]
        with pytest.raises(ClientError) as caught:
            _ensure_allocation_history(table, 'p1', 'prd', 'a1', _generated())
        assert caught.value is error

    @pytest.mark.usefixtures('no_legacy')
    def test_by_a_save(self):
        table = _store(META, {**SERIES_KEY, 'last_version': 2})
        error = _bare_error()
        table.meta.client.transact_write_items.side_effect = [error]
        with pytest.raises(ClientError) as caught:
            _persist(table)
        assert caught.value is error

    def test_a_failed_lease_release_is_logged_as_unknown(self):
        table = _table()
        table.update_item.side_effect = _bare_error()
        with patch.object(dv, 'logger') as logger:
            _release_legacy_migration(table, COUNTER_KEY, 'me')
        logger.warning.assert_called_once_with(
            'Document version migration lease release failed; lease will expire',
            extra={'error_code': 'Unknown'},
        )


def _save(table: MagicMock, expected: int | None) -> dict[str, Any]:
    return persist_versioned_document(table, 'p1', 'prd', 'Launch', 'a1', dict(FIELDS),
                                      expected_last_version=expected)


@pytest.mark.usefixtures('no_legacy')
class TestASaveFromAStaleCopyIsA409:
    def test_a_new_series_loaded_at_another_version(self):
        table = _store(META)
        with pytest.raises(ConflictError) as caught:
            _save(table, 1)
        assert caught.value.message == STALE
        table.meta.client.transact_write_items.assert_not_called()

    def test_a_new_series_loaded_at_its_head_takes_version_one(self):
        assert _save(_store(META), 0) == _item(1)

    def test_a_series_moved_past_the_loaded_version(self):
        table = _store(META, {**SERIES_KEY, 'last_version': 4})
        with pytest.raises(ConflictError) as caught:
            _save(table, 3)
        assert caught.value.message == STALE
        table.meta.client.transact_write_items.assert_not_called()

    def test_a_series_loaded_at_its_head_takes_the_next_version(self):
        assert _save(_store(META, {**SERIES_KEY, 'last_version': 4}), 4) == _item(5)

    def test_a_counter_that_moves_during_the_save_is_a_409_at_once(self, frozen_clock):
        _, sleep = frozen_clock
        table = _store(META, {**SERIES_KEY, 'last_version': 4})
        error = ClientError({'Error': {'Code': 'TransactionCanceledException'},
                             'CancellationReasons': [{'Code': 'ConditionalCheckFailed'}]}, 'TransactWriteItems')

        def another_save_lands(**_kwargs: Any) -> None:
            table.rows[(SERIES_KEY['pk'], SERIES_KEY['sk'])] = {**SERIES_KEY, 'last_version': 5}
            raise error

        table.meta.client.transact_write_items.side_effect = another_save_lands
        with pytest.raises(ConflictError) as caught:
            _save(table, 4)
        assert caught.value.message == STALE
        assert caught.value.__cause__ is error
        assert len(_transactions(table)) == 1
        sleep.assert_not_called()


def _head_table(rows: list[dict[str, Any]], counter: dict[str, Any] | None) -> MagicMock:
    table = _store(*([{**SERIES_KEY, **counter}] if counter is not None else []))
    table.query.return_value = {'Items': rows}
    return table


PRD_ROWS = [
    {'pk': 'PROJECT#p1', 'sk': 'PRD#a', 'title': 'Launch', 'version': 2, 'created_at': '1'},
    {'pk': 'PROJECT#p1', 'sk': 'PRD#b', 'title': 'launch — PRD (v3)', 'created_at': '2'},
    {'pk': 'PROJECT#p1', 'sk': 'PRD#c', 'title': 'Other', 'version': 9, 'created_at': '3'},
    {'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d', 'title': 'Launch', 'version': 8, 'created_at': '4'},
]


class TestTheSeriesHeadAnEditorIsShown:
    @pytest.mark.parametrize(('rows', 'counter', 'head'), [
        ([], None, 0),
        ([], {}, 0),
        (PRD_ROWS, None, 3),
        (PRD_ROWS, {'last_version': 2}, 3),
        (PRD_ROWS, {'last_version': 6}, 6),
        ([], {'last_version': '4'}, 4),
    ])
    def test_the_counter_or_every_version_in_use_past_it(self, rows, counter, head):
        table = _head_table(rows, counter)
        assert series_head_version(table, 'p1', 'prd', ' LAUNCH — PRD (v7) ') == head
        table.get_item.assert_called_once_with(Key=SERIES_KEY, ConsistentRead=True)
        query = table.query.call_args.kwargs
        assert query['KeyConditionExpression'] == Key('pk').eq('PROJECT#p1')
        assert query['ConsistentRead'] is True


class TestASavedLabelledTitleIsThePlainTitlesSeries:
    def test_its_versions_count_toward_the_plain_titles_head(self):
        documents = [{'sk': 'PRD#a', 'created_at': '1', 'title': 'Launch — PRD', 'version': 4}]
        assert _series_state(documents, 'prd', 'launch', 'Fallback') == ('Launch — PRD', 4)


class TestAStoredVersionOfOddDigitsIsIgnored:
    """A stored version is read, never trusted: a text that `str.isdigit` accepts but `int` cannot parse (a
    superscript, a circled digit) counts as no version; it does not crash every read of the project."""

    @pytest.mark.parametrize('odd', [chr(0xB2), chr(0x2460), '3' + chr(0xB9)])
    def test_a_superscript_or_circled_digit_is_not_a_version(self, odd):
        assert dv.normalize_document_versions([{'sk': 'PRD#a', 'title': 'Plan', 'version': odd}])[0]['version'] == 1

    def test_a_text_of_ascii_digits_still_is(self):
        assert dv.normalize_document_versions([{'sk': 'PRD#a', 'title': 'Plan', 'version': '4'}])[0]['version'] == 4


class TestAMigrationGroupsTitlesAsAReadDoes:
    def test_a_plain_and_an_own_type_labelled_prd_are_migrated_as_one_series(self):
        documents = [
            {'pk': 'PROJECT#p1', 'sk': 'PRD#a', 'title': 'Plan', 'created_at': '1'},
            {'pk': 'PROJECT#p1', 'sk': 'PRD#b', 'title': 'Plan — PRD', 'created_at': '2'},
        ]
        with patch.object(dv, '_persist_legacy_series') as series:
            series.side_effect = lambda _t, _p, _type, _n, docs: docs
            dv.persist_legacy_document_versions(_table(), 'p1', documents)
        assert [(*c.args[2:4], [d['sk'] for d in c.args[4]]) for c in series.call_args_list] == [
            ('prd', 'plan', ['PRD#a', 'PRD#b']),
        ]
