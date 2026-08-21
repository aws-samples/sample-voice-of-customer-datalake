"""The aggregate TTL and the retention the metrics routes report must be one value.

`aggregator/handler.py` OWNS how long an aggregate row lives: `update_counter`
and `update_average` each take `ttl_days: int = 90` and stamp a DynamoDB TTL from
it. `shared/api.py` declares `AGGREGATE_RETENTION_DAYS`, which `metrics_handler`
uses to decide whether a requested window reaches further back than the rows
survive — the reason `?days=365` on the aggregates path reports `is_partial: true`.

Nothing links them, and the drift is silent in the direction that matters:
shorten the TTL to 30 without shortening the constant and every window between 31
and 90 days goes back to being reported COMPLETE while a third or more of it has
already been deleted. Lengthen it and the routes cry partial over answers they
could give in full. Neither shows up as an error, in a log, or in any other test
— which is precisely the shape of the defect `is_partial` exists to close.

The value is read out of the aggregator with `inspect.signature` rather than
re-stated here, so this test cannot itself become the stale copy. Same lockstep
pattern as `test_feedback_page_limit_lockstep.py` (frontend page size ↔ endpoint
maximum) and `shared/test/test_search_minimum_lockstep.py`.

Which mutation makes each assertion fail: change `ttl_days`' default in
`aggregator/handler.py`, or `AGGREGATE_RETENTION_DAYS` in `shared/api.py`,
without changing the other, and
`test_the_shared_constant_equals_the_aggregators_ttl_default` fails naming both
numbers. `test_both_writers_stamp_the_same_horizon` fails if only one of the two
aggregator functions is changed — half the rows would then outlive the other
half and no single constant could describe the window.
"""
import inspect

from shared.api import AGGREGATE_RETENTION_DAYS, MAX_FEEDBACK_WINDOW_DAYS


def _aggregator_ttl_default(function_name: str) -> int:
    """The `ttl_days` default of one aggregator writer, read from its signature.

    Imported inside the helper rather than at module scope so an aggregator that
    cannot be imported fails these tests rather than collection of the file.
    """
    from aggregator import handler as aggregator_handler

    parameter = inspect.signature(
        getattr(aggregator_handler, function_name)
    ).parameters['ttl_days']
    assert parameter.default is not inspect.Parameter.empty, (
        f'{function_name} no longer defaults ttl_days; the retention horizon the '
        'metrics routes report is then decided per call site and cannot be a constant'
    )
    return parameter.default


class TestAggregateRetentionLockstep:
    def test_the_shared_constant_equals_the_aggregators_ttl_default(self):
        ttl_days = _aggregator_ttl_default('update_counter')
        assert AGGREGATE_RETENTION_DAYS == ttl_days, (
            f'aggregator writes rows with a {ttl_days}-day TTL but '
            f'AGGREGATE_RETENTION_DAYS says {AGGREGATE_RETENTION_DAYS}. The metrics '
            'routes use the constant to decide when a window is wider than the rows '
            'that survive, so a mismatch makes them either assert completeness over '
            'deleted data or report partial over data they have. Change both.'
        )

    def test_both_writers_stamp_the_same_horizon(self):
        """`update_counter` and `update_average` write into the SAME partitions
        that one window read spans (`METRIC#daily_total` counts beside
        `METRIC#daily_sentiment_avg` sums), so two TTLs would mean two horizons
        and no single constant could describe the window."""
        assert (
            _aggregator_ttl_default('update_counter')
            == _aggregator_ttl_default('update_average')
            == AGGREGATE_RETENTION_DAYS
        )

    def test_the_retention_is_narrower_than_the_widest_requestable_window(self):
        """The premise of the whole check, asserted rather than assumed.

        If retention ever reaches as far as `validate_days` allows, no aggregates
        answer can be incomplete for this reason and the horizon check becomes
        dead code that reports nothing — a green suite meaning "never triggered".
        Making that a failure forces the check to be removed deliberately rather
        than left as decoration.
        """
        assert AGGREGATE_RETENTION_DAYS < MAX_FEEDBACK_WINDOW_DAYS, (
            'aggregates now retain as long as the widest window a caller may ask '
            'for, so _window_exceeds_aggregate_retention can never be true. Remove '
            'it and its tests rather than leaving a check that cannot fire.'
        )
