"""Mutation hardening for `shared/plugin_circuit.py`.

`api/test/test_integrations_circuit.py` drives the module through the
`/sources` routes, where the integrations conftest defaults the aggregates
table to ``None`` or to a moto table. A mutation run found three things it
could not see:

* the FLOOR of the failure count: a stored count of 0 (or a negative legacy
  value) must report 0, so ``max(0, …)`` becoming ``max(1, …)`` survived — every
  route test used a row with 5 failures.
* the "no table" path with sources: without an aggregates table every named
  source reports a closed breaker and nothing is read.
* the wording of the fail-closed error when the batch keeps keys unprocessed.

The run also showed ``or not sources`` in `read_circuits` was unobservable (an
empty batch issues no request and answers ``{}`` either way); it was removed.
"""
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

from shared import plugin_circuit

CLOSED = {'tripped': False, 'tripped_at': None, 'failure_count': 0, 'last_error': None}


def _table() -> MagicMock:
    """A table resource stand-in whose BatchGetItem client the test scripts."""
    table = MagicMock()
    table.name = 'aggregates'
    return table


class TestTheFailureCountIsNeverBelowZero:
    @pytest.mark.parametrize(('stored', 'reported'), [
        (0, 0),
        (Decimal(0), 0),
        (-3, 0),
        (Decimal(-1), 0),
        (1, 1),
        (Decimal(7), 7),
    ])
    def test_the_stored_count_is_floored_at_zero(self, stored: object, reported: int):
        circuit = plugin_circuit.circuit_from_row({'failure_count': stored}, include_error=False)

        assert circuit['failure_count'] == reported


class TestWithoutATableEveryBreakerIsClosed:
    def test_each_named_source_reports_closed_without_a_read(self):
        with (
            patch('shared.plugin_circuit.get_aggregates_table', return_value=None),
            patch('shared.plugin_circuit.batch_get_all') as batch,
        ):
            states = plugin_circuit.read_circuits(['webscraper', 'app_reviews_ios'], include_error=True)

        assert states == {'webscraper': CLOSED, 'app_reviews_ios': CLOSED}
        batch.assert_not_called()

    def test_an_empty_source_list_reads_nothing(self):
        table = _table()
        with patch('shared.plugin_circuit.get_aggregates_table', return_value=table):
            states = plugin_circuit.read_circuits([], include_error=True)

        assert states == {}
        table.meta.client.batch_get_item.assert_not_called()


class TestAReadThatKeepsKeysUnprocessedFailsClosed:
    def test_the_error_names_the_unavailable_state(self):
        table = _table()
        key = {'pk': 'CIRCUIT#webscraper', 'sk': 'TRIPPED'}
        table.meta.client.batch_get_item.return_value = {
            'Responses': {}, 'UnprocessedKeys': {'aggregates': {'Keys': [key]}},
        }
        with (
            patch('shared.plugin_circuit.get_aggregates_table', return_value=table),
            patch('shared.batch_get.time.sleep'),
            pytest.raises(plugin_circuit.CircuitReadError) as raised,
        ):
            plugin_circuit.read_circuits(['webscraper'], include_error=True)

        assert str(raised.value) == 'circuit state unavailable'
