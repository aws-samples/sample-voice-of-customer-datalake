"""Nothing in the data lake is deleted by time: no writer of customer data stamps a TTL.

This file used to pin the aggregator's `ttl_days=90` against `AGGREGATE_RETENTION_DAYS`
so the metrics routes could report windows past the horizon as partial. The product
rule is now "we can read and interpret but never delete", so the lockstep is
inverted: it fails if a TTL comes back on the paths that write feedback or its
aggregates, or if the retired retention constant/predicate reappears.

Read by PARSING the sources, not importing them, for the reason the old test gave:
importing `aggregator.handler` from an api test executes another Lambda package's
module scope (a DynamoDB resource, a required env var), and that environmental
failure would look like drift.

Scope: the aggregator's METRIC# writers and the processor's feedback item. The
aggregates table keeps TTL ENABLED for operational rows (processor logs at 7 days,
voting sessions, fixtures) — those are not customer data and are not checked here.
"""
import ast
from pathlib import Path

import shared.api as shared_api
from shared.api import ALL_TIME_DAYS, MAX_FEEDBACK_WINDOW_DAYS

_LAMBDA_ROOT = Path(__file__).resolve().parents[2]
_AGGREGATOR_SOURCE = _LAMBDA_ROOT / 'aggregator' / 'handler.py'
_PROCESSOR_SOURCE = _LAMBDA_ROOT / 'processor' / 'handler.py'
_METRICS_SOURCE = _LAMBDA_ROOT / 'api' / 'metrics_handler.py'

# Every function that builds or issues an aggregate row write.
_AGGREGATE_WRITERS = (
    '_counter_request', '_average_request',
    'update_counter', 'update_average',
    '_counter_transaction_item', '_average_transaction_item',
)


def _function(source: Path, name: str) -> ast.FunctionDef:
    for node in ast.walk(ast.parse(source.read_text(encoding='utf-8'))):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f'{name} is gone from {source.name}; update this lockstep')


def _string_constants(node: ast.AST) -> list[str]:
    return [
        n.value for n in ast.walk(node)
        if isinstance(n, ast.Constant) and isinstance(n.value, str)
    ]


def _mentions_ttl(node: ast.AST) -> list[str]:
    """String literals naming a `ttl` attribute: `'ttl'`, `'#ttl'`, `':ttl'`, or an
    update expression that sets one."""
    return [
        value for value in _string_constants(node)
        if value in ('ttl', '#ttl', ':ttl') or '#ttl' in value or ':ttl' in value
    ]


class TestNoCustomerDataIsStampedWithATtl:
    def test_no_aggregate_writer_takes_a_ttl_parameter(self):
        offenders = []
        for name in _AGGREGATE_WRITERS:
            arguments = _function(_AGGREGATOR_SOURCE, name).args
            if any(a.arg == 'ttl_days' for a in arguments.args + arguments.kwonlyargs):
                offenders.append(name)
        assert offenders == [], (
            f'{offenders} take ttl_days again: aggregate rows would expire, and every '
            'all-time window would silently under-report once they did'
        )

    def test_no_aggregate_writer_names_a_ttl_attribute(self):
        offenders = {
            name: _mentions_ttl(_function(_AGGREGATOR_SOURCE, name))
            for name in _AGGREGATE_WRITERS
        }
        offenders = {name: hits for name, hits in offenders.items() if hits}
        assert offenders == {}, f'aggregate writers stamp a TTL again: {offenders}'

    def test_the_processed_feedback_item_carries_no_ttl(self):
        """`process_feedback` builds the voc-feedback item; it must not have a
        `'ttl'` key (the table's TTL is disabled, and an item carrying the attribute
        would be deleted the moment TTL is ever re-enabled). The processor's log
        rows (`log_validation_failure`/`log_processing_error`) keep their 7-day TTL:
        they are operational rows, not customer data."""
        builder = _function(_PROCESSOR_SOURCE, 'process_feedback')
        keys = [
            key.value
            for node in ast.walk(builder) if isinstance(node, ast.Dict)
            for key in node.keys
            if isinstance(key, ast.Constant)
        ]
        assert 'ttl' not in keys


class TestTheRetentionHorizonIsRetired:
    def test_the_constant_is_gone(self):
        assert not hasattr(shared_api, 'AGGREGATE_RETENTION_DAYS')

    def test_the_metrics_handler_no_longer_reports_partial_for_retention(self):
        source = _METRICS_SOURCE.read_text(encoding='utf-8')
        assert 'AGGREGATE_RETENTION_DAYS' not in source
        assert '_window_exceeds_aggregate_retention' not in source

    def test_windows_run_from_all_time_to_the_ceiling(self):
        from shared.api import validate_days

        assert ALL_TIME_DAYS == 0
        assert MAX_FEEDBACK_WINDOW_DAYS == 9999
        assert validate_days(0) == ALL_TIME_DAYS
        assert validate_days(MAX_FEEDBACK_WINDOW_DAYS + 1) == MAX_FEEDBACK_WINDOW_DAYS
