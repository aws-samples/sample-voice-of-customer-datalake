"""
API-side view of a plugin's circuit breaker (``plugins/_shared/circuit_breaker.py``).

The breaker writes ``CIRCUIT#<plugin>`` / ``TRIPPED`` in the AGGREGATES table when a
plugin fails too often, and every later run is skipped while that row exists.
This module reads it for ``GET /sources/status`` and deletes it for
``PUT /sources/{source}/enable`` and ``POST /sources/{source}/reset`` — the same
key, pinned in lockstep by ``test_integrations_circuit.py``. Operational state, not
customer data: deleting it only lets the next run go ahead.
"""

from decimal import Decimal
from typing import Any

from shared.batch_get import batch_get_all
from shared.tables import get_aggregates_table

CIRCUIT_PK_PREFIX = 'CIRCUIT#'
TRIPPED_SK = 'TRIPPED'
# The breaker cuts what it stores at 500; re-cut so a legacy row cannot be larger.
MAX_LAST_ERROR_CHARS = 500


def tripped_key(source: str) -> dict[str, str]:
    """The DynamoDB key of *source*'s TRIPPED row."""
    return {'pk': f'{CIRCUIT_PK_PREFIX}{source}', 'sk': TRIPPED_SK}


def closed_circuit() -> dict[str, Any]:
    """What a source with no TRIPPED row reports."""
    return {'tripped': False, 'tripped_at': None, 'failure_count': 0, 'last_error': None}


def _failure_count(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int | Decimal):
        return max(0, int(value))
    return 0


def circuit_from_row(row: dict, *, include_error: bool) -> dict[str, Any]:
    """The API shape of a stored TRIPPED row.

    ``last_error`` is the plugin exception's free text (an upstream URL, a response
    body), so it goes only to admins — the same rule as the run-status rows, which
    carry the exception type only (#263). Everyone else gets ``None``.
    """
    tripped_at = row.get('tripped_at')
    last_error = row.get('last_error')
    return {
        'tripped': True,
        'tripped_at': tripped_at if isinstance(tripped_at, str) else None,
        'failure_count': _failure_count(row.get('failure_count')),
        'last_error': (
            last_error[:MAX_LAST_ERROR_CHARS] if include_error and isinstance(last_error, str) else None
        ),
    }


class CircuitReadError(Exception):
    """The TRIPPED rows could not all be read (the batch kept rows unprocessed)."""


def read_circuits(sources: list[str], *, include_error: bool) -> dict[str, dict[str, Any]]:
    """Every source's breaker state, in ONE strongly consistent batch read.

    Raises the DynamoDB error (or CircuitReadError); the caller degrades. One batch
    rather than a get per source in the status route's thread pool: a boto3
    resource is not thread-safe, and a batch is one round trip for ≤ 50 sources.
    """
    table = get_aggregates_table()
    if table is None:
        return {source: closed_circuit() for source in sources}
    rows = batch_get_all(table, [tripped_key(source) for source in sources],
                         failure=CircuitReadError('circuit state unavailable'))
    by_pk = {row.get('pk'): row for row in rows}

    def state(source: str) -> dict[str, Any]:
        row = by_pk.get(tripped_key(source)['pk'])
        return circuit_from_row(row, include_error=include_error) if row else closed_circuit()

    return {source: state(source) for source in sources}


def clear_circuit(source: str) -> None:
    """Close *source*'s breaker (idempotent: deleting an absent row succeeds). Raises on failure."""
    table = get_aggregates_table()
    if table is not None:
        table.delete_item(Key=tripped_key(source))
