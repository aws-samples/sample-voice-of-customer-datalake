"""Mutation hardening for `shared/category_gate.py`.

`test_category_gate.py` pins the scope each kind of caller resolves to, but a
mutation run found what it could not see:

* the exact READS: the categories-config key and its ``ConsistentRead=True``
  (the fresh read a write path relies on), and the access-row key;
* the WORDING of every 500 and of the log line behind it, and that a
  ``BotoCoreError`` (not only a ``ClientError``) is turned into that 500;
* the malformed-response guards: a non-mapping response or item, and a
  ``categories`` value that is not a list, read as "unset" / "no row";
* that a DELEGATED admin is not short-circuited to "everything" but resolved
  from its row, and that a caller without a subject is refused before any read.
"""
from collections.abc import Callable, Iterator
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import BotoCoreError, ClientError

from shared import category_access as ca
from shared import category_gate
from shared.api import clear_categories_cache
from shared.exceptions import ServiceError
from shared.project_access import Caller
from shared.source_profiles import SOURCES_SETTINGS_KEY

CONFIG_KEY = {'pk': 'SETTINGS#categories', 'sk': 'config'}
READ_FAILURES = [
    ClientError({'Error': {'Code': 'Throttling'}}, 'GetItem'),
    BotoCoreError(),
]


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    clear_categories_cache()
    yield
    clear_categories_cache()


def _table(*responses: object) -> MagicMock:
    table = MagicMock()
    table.get_item.side_effect = list(responses)
    return table


class TestCategoriesConfigRead:
    def test_reads_the_config_key_strongly(self) -> None:
        table = _table({'Item': {**CONFIG_KEY, 'categories': [{'name': 'a'}]}})
        assert category_gate.read_categories_config(table) == [{'name': 'a'}]
        table.get_item.assert_called_once_with(Key=CONFIG_KEY, ConsistentRead=True)

    @pytest.mark.parametrize('response', [
        None,
        ['Item'],
        {},
        {'Item': None},
        {'Item': ['categories']},
        {'Item': {'categories': None}},
        {'Item': {'categories': {'name': 'a'}}},
        {'Item': {'categories': 'a'}},
    ])
    def test_malformed_response_reads_as_unset(self, response: object) -> None:
        assert category_gate.read_categories_config(_table(response)) == []

    def test_keeps_only_named_dict_entries_in_order(self) -> None:
        stored = [{'name': 'b'}, {'name': ''}, {'description': 'x'}, 'junk', {'name': 'a'}]
        table = _table({'Item': {'categories': stored}})
        assert category_gate.read_categories_config(table) == [{'name': 'b'}, {'name': 'a'}]



class TestEveryFailedReadIsA500NamingItsCause:
    @pytest.mark.parametrize('failure', READ_FAILURES)
    @pytest.mark.parametrize(('read', 'message', 'log_line'), [
        (category_gate.read_categories_config,
         'Could not read categories. Please retry.', 'Categories config read failed'),
        (lambda table: category_gate.read_access_row(table, 'u1'),
         'Could not verify category access. Please retry.', 'Category access read failed'),
    ])
    def test_failed_read(
        self, read: Callable[[MagicMock], object], message: str, log_line: str,
        failure: Exception,
    ) -> None:
        with patch.object(category_gate, 'logger') as logger, \
                pytest.raises(ServiceError) as raised:
            read(_table(failure))
        assert str(raised.value) == message
        assert raised.value.__cause__ is failure
        logger.exception.assert_called_once_with(log_line)


class TestAccessRowRead:
    def test_reads_the_subjects_row(self) -> None:
        row = {**ca.access_key('u1'), 'categories': ['app']}
        table = _table({'Item': row})
        assert category_gate.read_access_row(table, 'u1') == row
        table.get_item.assert_called_once_with(Key={'pk': 'CATEGORY_ACCESS', 'sk': 'USER#u1'})

    @pytest.mark.parametrize('response', [None, ['Item'], {}, {'Item': None}, {'Item': ['x']}])
    def test_malformed_response_reads_as_no_row(self, response: object) -> None:
        assert category_gate.read_access_row(_table(response), 'u1') is None


class TestScopeForCaller:
    @pytest.mark.parametrize('is_admin', [True, False])
    def test_delegated_caller_resolves_from_its_row(self, is_admin: bool) -> None:
        table = _table({'Item': {'categories': ['app']}}, {'Item': {'categories': []}}, {})
        scope = category_gate.scope_for_caller(
            Caller(subject='u1', is_admin=is_admin, delegated=True), table)
        assert scope == ca.CategoryScope(all=False, categories=frozenset({'app'}))

    def test_subjectless_caller_sees_nothing_without_a_read(self) -> None:
        table = MagicMock()
        assert category_gate.scope_for_caller(Caller(subject=''), table) == ca.NOTHING
        table.get_item.assert_not_called()

    def test_unconfigured_table_names_the_failure(self) -> None:
        with pytest.raises(ServiceError) as raised:
            category_gate.scope_for_caller(Caller(subject='u1'), None)
        assert str(raised.value) == 'Could not verify category access. Please retry.'

    def test_no_row_skips_the_config_read_but_reads_the_restricted_sources(self) -> None:
        table = _table({}, {})
        assert category_gate.scope_for_caller(Caller(subject='u1'), table) == ca.UNRESTRICTED
        assert table.get_item.call_args_list == [
            call(Key=ca.access_key('u1')), call(Key=SOURCES_SETTINGS_KEY, ConsistentRead=True)]

    def test_restricted_row_adds_owned_categories_from_the_config(self) -> None:
        config = [{'name': 'delivery', 'owners': [{'sub': 'u1'}]}]
        table = _table({'Item': {'categories': ['app']}}, {'Item': {'categories': config}}, {})
        scope = category_gate.scope_for_caller(Caller(subject='u1'), table)
        assert scope == ca.CategoryScope(all=False, categories=frozenset({'app', 'delivery'}))
        assert table.get_item.call_count == 3

    def test_no_explicit_grant_hides_the_restricted_sources(self) -> None:
        sources = [{'id': 'support_tickets', 'restricted': True}, {'id': 'sales', 'restricted': False},
                   {'restricted': True}, 'junk']
        table = _table({}, {'Item': {'sources': sources}})
        scope = category_gate.scope_for_caller(Caller(subject='u1'), table)
        assert scope == ca.CategoryScope(all=True, source_deny=frozenset({'support_tickets'}))
        assert scope.all is False

    def test_an_explicit_grant_skips_the_sources_read(self) -> None:
        table = _table({'Item': {'sources': ['support_tickets']}})
        scope = category_gate.scope_for_caller(Caller(subject='u1'), table)
        assert scope.source_allow == frozenset({'support_tickets'})
        assert table.get_item.call_count == 1

    @pytest.mark.parametrize('response', [None, {'Item': 'x'}, {'Item': {'sources': 'x'}}])
    def test_an_unset_or_odd_sources_row_restricts_nothing(self, response: object) -> None:
        assert category_gate.read_restricted_sources(_table(response)) == frozenset()

    def test_a_failed_sources_read_is_a_500(self) -> None:
        table = MagicMock()
        table.get_item.side_effect = ClientError({'Error': {'Code': 'X'}}, 'GetItem')
        with pytest.raises(ServiceError, match='Could not verify source access'):
            category_gate.read_restricted_sources(table)
