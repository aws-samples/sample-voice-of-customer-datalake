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

The value is read out of the aggregator rather than re-stated here, so this test
cannot itself become the stale copy. Same lockstep pattern as
`test_feedback_page_limit_lockstep.py` (frontend page size ↔ endpoint maximum) and
`shared/test/test_search_minimum_lockstep.py`.

Read by PARSING the aggregator, not by importing it. `inspect.signature` was the
first implementation and it reaches the same value, but importing
`aggregator.handler` from an api test executes another Lambda package's module
scope — which creates a DynamoDB resource and reads `AGGREGATES_TABLE` — so the
test would fail for an environmental reason (no region, no env var) in exactly the
same red as real drift, and the two are not the same problem. `ast` reads the
source without running it, and it is also what lets the call sites be checked at
all.

Which mutation makes each assertion fail: change `ttl_days`' default in
`aggregator/handler.py`, or `AGGREGATE_RETENTION_DAYS` in `shared/api.py`,
without changing the other, and
`test_the_shared_constant_equals_the_aggregators_ttl_default` fails naming both
numbers. `test_every_writer_stamps_the_same_horizon` fails if only one of the
aggregator's writers is changed — some rows would then outlive the others and no
single constant could describe the window. It derives the writers from `_WRITERS`
rather than naming two inline, which is what it did until the arrival path became
transactional and added two more.
`test_no_call_site_overrides_the_ttl` fails if a writer is called with an explicit
`ttl_days`, which would make the default true and the rows' real horizon something
else; `test_each_writer_applies_the_parameter_it_takes` fails if a writer accepts
`ttl_days` and stamps something else, the same lie one level down.
"""
import ast
from pathlib import Path

from shared.api import AGGREGATE_RETENTION_DAYS, MAX_FEEDBACK_WINDOW_DAYS

# test/ → api/ → lambda/, then the sibling package that owns the value.
_AGGREGATOR_SOURCE = (
    Path(__file__).resolve().parents[2] / 'aggregator' / 'handler.py'
)
_TTL_PARAMETER = 'ttl_days'
# Every function that STAMPS an aggregate row's TTL. All of them, because one TTL per
# writer would mean two horizons over partitions a single window read spans, and
# `AGGREGATE_RETENTION_DAYS` could then describe none of them.
#
# FOUR since the arrival path became transactional (issue #264): an INSERT's counters
# and average are built as `TransactWriteItems` entries, and each of those builders
# takes its own `ttl_days` default. That is a third and fourth copy of the horizon — on
# the path EVERY ingested item takes — and a lockstep naming only the two single-write
# functions would have left them free to drift while reporting the constant as honoured.
#
# The `now + ttl_days * 24 * 60 * 60` ARITHMETIC is not in four places: `_counter_request`
# and `_average_request` each do it once for both of their issuers, and both take
# `ttl_days` as a REQUIRED parameter, so neither can carry a default that disagrees with
# anything. What the four names below still own is the DEFAULT — the number a caller gets
# when it does not say — which is the only thing a constant can describe and so the only
# thing this file reads.
_WRITERS = (
    'update_counter', 'update_average',
    '_counter_transaction_item', '_average_transaction_item',
)


def _aggregator_tree() -> ast.Module:
    return ast.parse(_AGGREGATOR_SOURCE.read_text(encoding='utf-8'))


def _writer(function_name: str) -> ast.FunctionDef:
    for node in ast.walk(_aggregator_tree()):
        if isinstance(node, ast.FunctionDef) and node.name == function_name:
            return node
    raise AssertionError(
        f'{function_name} is gone from {_AGGREGATOR_SOURCE.name}; the retention '
        'horizon the metrics routes report is no longer stamped by it'
    )


def _ttl_parameter_position(function: ast.FunctionDef) -> int:
    """Index of `ttl_days` among the positional parameters.

    Needed twice over: to line the parameter up with its default (defaults are
    right-aligned in the AST), and to spot a call that overrides it POSITIONALLY,
    which a keyword-only search would miss.

    Positional parameters only, so the two failures are told apart: the parameter
    being gone is one thing, and it becoming keyword-only is another — the latter
    moves its default into `kw_defaults` and makes a positional override
    impossible, so both readers here would need rewriting rather than a message
    about a parameter that is in fact still present.
    """
    names = [argument.arg for argument in function.args.args]
    if _TTL_PARAMETER not in names:
        keyword_only = [argument.arg for argument in function.args.kwonlyargs]
        assert _TTL_PARAMETER not in keyword_only, (
            f'{function.name} takes {_TTL_PARAMETER} keyword-only now: its default '
            'lives in kw_defaults and no call can override it positionally, so this '
            'helper and test_no_call_site_overrides_the_ttl both need updating'
        )
        raise AssertionError(
            f'{function.name} no longer takes {_TTL_PARAMETER}; the horizon is then '
            'decided somewhere this test cannot see'
        )
    return names.index(_TTL_PARAMETER)


def _aggregator_ttl_default(function_name: str) -> int:
    """The `ttl_days` default of one aggregator writer, read from its source."""
    function = _writer(function_name)
    position = _ttl_parameter_position(function)
    defaults = function.args.defaults
    # Defaults cover the LAST len(defaults) positional parameters.
    offset = len(function.args.args) - len(defaults)
    assert position >= offset, (
        f'{function_name} no longer defaults {_TTL_PARAMETER}; the retention '
        'horizon the metrics routes report is then decided per call site and '
        'cannot be a constant'
    )
    default = defaults[position - offset]
    assert isinstance(default, ast.Constant) and isinstance(default.value, int), (
        f"{function_name}'s {_TTL_PARAMETER} default is no longer a literal int, "
        'so a constant cannot describe it'
    )
    return default.value


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

    def test_no_call_site_overrides_the_ttl(self):
        """A default is only the real horizon if nothing overrides it.

        `update_counter(..., ttl_days=30)` at one call site would leave this
        lockstep green — the default still matches the constant — while the rows
        that site writes expire two months earlier than the metrics routes claim.
        Positional overrides count too, which is why the parameter's INDEX is
        derived rather than the keyword alone being searched for.

        SCOPE: calls written as a bare name inside `aggregator/handler.py`. A
        `handler.update_counter(..., ttl_days=30)` from another module is not seen,
        and neither is one reached through an alias. That is the safe direction —
        every production writer of aggregate rows is in this file, and a new caller
        elsewhere would be the change that has to justify itself — but the check is
        not a proof about the whole repo.
        """
        tree = _aggregator_tree()
        positions = {name: _ttl_parameter_position(_writer(name)) for name in _WRITERS}

        overrides = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            position = positions.get(node.func.id)
            if position is None:
                continue
            if len(node.args) > position or any(
                keyword.arg == _TTL_PARAMETER for keyword in node.keywords
            ):
                overrides.append(f'{node.func.id} at line {node.lineno}')

        assert overrides == [], (
            f'{overrides} pass an explicit {_TTL_PARAMETER}, so the rows they write '
            f'do not live for AGGREGATE_RETENTION_DAYS and the metrics routes '
            'report a horizon those partitions do not have'
        )

    def test_each_writer_applies_the_parameter_it_takes(self):
        """The same lie one level down: a writer could accept `ttl_days` and stamp
        a hardcoded number, in which case every assertion above is about a value
        no row ever sees. `aggregator/test/test_handler.py` covers the arithmetic;
        this only insists the parameter reaches it.
        """
        for name in _WRITERS:
            function = _writer(name)
            uses = [
                node for node in ast.walk(function)
                if isinstance(node, ast.Name) and node.id == _TTL_PARAMETER
            ]
            assert uses, (
                f'{name} takes {_TTL_PARAMETER} and never reads it, so the TTL it '
                'stamps is not the horizon this lockstep is about'
            )

    def test_every_writer_stamps_the_same_horizon(self):
        """All of them write into the SAME partitions that one window read spans
        (`METRIC#daily_total` counts beside `METRIC#daily_sentiment_avg` sums), so two
        TTLs would mean two horizons and no single constant could describe the window.

        DERIVED FROM `_WRITERS`, not from two names written out here. This assertion
        used to name `update_counter` and `update_average` inline, and when the arrival
        path became transactional it went half-blind: `_WRITERS` grew the two
        transaction builders, `test_no_call_site_overrides_the_ttl` and
        `test_each_writer_applies_the_parameter_it_takes` covered them because they
        iterate the tuple, and this one kept comparing the same two — so dropping the
        transactional counter's default to 30 days failed NOTHING. Measured, not
        supposed: that mutation now fails here and passed before.
        """
        horizons = {name: _aggregator_ttl_default(name) for name in _WRITERS}
        assert set(horizons.values()) == {AGGREGATE_RETENTION_DAYS}, (
            f'{horizons}: the aggregator stamps more than one retention horizon (or '
            f'one that is not AGGREGATE_RETENTION_DAYS={AGGREGATE_RETENTION_DAYS}), '
            f'so no single constant describes how far back the metrics routes may '
            f'report a window as complete.'
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
