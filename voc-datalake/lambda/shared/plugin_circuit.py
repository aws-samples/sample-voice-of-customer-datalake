"""
API-side view of a plugin's circuit breaker (``plugins/_shared/circuit_breaker.py``).

The breaker writes a ``TRIPPED`` row in the AGGREGATES table when a plugin fails too
often: ``CIRCUIT#<plugin>`` (``tripped_key``) for its deployment-wide runs (an event that
names no workspace; the trip also disables the plugin's schedule), and
``WS#{ws}#CIRCUIT#<plugin>`` (``workspace_tripped_key``) for its runs in one workspace.
Every later run on the same path is skipped while its row exists. This module reads
the TRIPPED row for ``GET /sources/status`` and deletes it for
``PUT /sources/{source}/enable`` and ``POST /sources/{source}/reset``, on the request's
path (docs/multi-workspace.md): without ``X-Workspace-Id`` the deployment-wide row, in a
workspace (``scope``) that workspace's row only, through ``ws_table`` (a key of another
workspace, or the deployment's, is refused before DynamoDB). Only the TRIPPED row is
read and cleared, on both paths: the ``FAILURES#`` rows expire on their own (24 h TTL)
and count only inside the breaker's 15-minute window. Both keys are pinned by
``test_integrations_circuit.py``.
Operational state, not customer data: deleting it only lets the next run go ahead.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from shared.batch_get import batch_get_all
from shared.ingest_tables import table_view
from shared.tables import get_aggregates_table
from shared.ws_repo import WorkspaceScope, ws_table

CIRCUIT_PK_PREFIX = 'CIRCUIT#'
TRIPPED_SK = 'TRIPPED'
# The breaker cuts what it stores at 500; re-cut so a legacy row cannot be larger.
MAX_LAST_ERROR_CHARS = 500


def tripped_key(source: str) -> dict[str, str]:
    """The DynamoDB key of *source*'s deployment-wide TRIPPED row (what the routes below read and clear)."""
    return {'pk': f'{CIRCUIT_PK_PREFIX}{source}', 'sk': TRIPPED_SK}


def workspace_tripped_key(scope: WorkspaceScope, source: str) -> dict[str, str]:
    """The key of *source*'s TRIPPED row in one workspace, ``WS#{ws}#CIRCUIT#<source>`` / ``TRIPPED``: the one the
    breaker writes for a run in that workspace (docs/multi-workspace.md)."""
    return {'pk': scope.key('CIRCUIT', source), 'sk': TRIPPED_SK}


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


def circuit_key(scope: WorkspaceScope | None, source: str) -> dict[str, str]:
    """*source*'s TRIPPED row on a request's path: ``tripped_key`` deployment-wide, ``workspace_tripped_key`` in
    ``scope``."""
    return tripped_key(source) if scope is None else workspace_tripped_key(scope, source)


def read_circuits(sources: list[str], *, include_error: bool,
                  scope: WorkspaceScope | None = None) -> dict[str, dict[str, Any]]:
    """Every source's breaker state (deployment-wide, or in ``scope`` only), in ONE strongly consistent batch read.

    Raises the DynamoDB error (or CircuitReadError); the caller degrades. One batch
    rather than a get per source in the status route's thread pool: a boto3
    resource is not thread-safe, and a batch is one round trip for ≤ 50 sources.
    In a workspace every key is checked to be the workspace's (``WorkspaceTable.check_keys``) before the call.
    """
    table = get_aggregates_table()
    if table is None:
        return {source: closed_circuit() for source in sources}
    keys = [circuit_key(scope, source) for source in sources]
    if scope is not None:
        keys = ws_table(scope, table).check_keys(keys)
    rows = batch_get_all(table, keys, failure=CircuitReadError('circuit state unavailable'))
    by_pk = {row.get('pk'): row for row in rows}

    def state(source: str) -> dict[str, Any]:
        row = by_pk.get(circuit_key(scope, source)['pk'])
        return circuit_from_row(row, include_error=include_error) if row else closed_circuit()

    return {source: state(source) for source in sources}


def clear_circuit(source: str, scope: WorkspaceScope | None = None) -> None:
    """Close *source*'s breaker, deployment-wide or in ``scope`` only (idempotent: deleting an absent row succeeds).
    Raises on failure."""
    table = get_aggregates_table()
    if table is not None:
        table_view(scope, table).delete_item(circuit_key(scope, source))
