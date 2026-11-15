"""Properties of the spend ledger and its alerts (engineering/spend.py): money and allowance counters.

A ledger write only adds, so the month's totals equal what the runs reported, to the cent; an alert goes off at a
level exactly when the month has passed it, and stays passed; a month is the UTC month of the write, whatever the
writer's clock zone; and the tokens a session reports are counted once, never negative.
"""
from __future__ import annotations

import re
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from hypothesis import assume, given
from hypothesis import strategies as st

from engineering.spend import (
    MICROVM,
    REPORTED_MICROVM,
    Usage,
    Where,
    alert_levels,
    flow_total_key,
    keyable,
    ledger_pk,
    ledger_updates,
    month_of,
    token_deltas,
)
from shared.test.properties import PROPERTY

LEVELS = (80, 100, *range(150, 1001, 50))
MONEY = st.decimals(min_value=0, max_value=5000, places=6, allow_nan=False, allow_infinity=False)
BUDGETS = st.decimals(min_value=Decimal('0.01'), max_value=Decimal(20000), places=2, allow_nan=False)
# A model name as the harness reports it: a real one, the MicroVM's own row, and names that clean to the '-' row.
MODELS = st.one_of(st.sampled_from(['claude-haiku-5-5', 'claude-sonnet-5-5', MICROVM, 'model.v2', 'x' * 200]),
                   st.from_regex(r'[a-z][a-z0-9 !.-]{0,20}', fullmatch=True))
FLOWS = st.sampled_from(['triage-bug', 'release-notes', 'review_2', 'flow with spaces', ''])
RUN_IDS = st.from_regex(r'run-[a-z0-9]{1,12}', fullmatch=True)
# Instants in any clock zone a writer may run in (a timezone-aware datetime, the way the supervisor stamps a write).
WHEN = st.datetimes(min_value=datetime.fromisoformat('2024-01-01'), max_value=datetime.fromisoformat('2035-12-31'),
                    timezones=st.timezones())   # (Hypothesis takes naive bounds; the zone is drawn)
TOKENS = st.fixed_dictionaries({'in': st.integers(0, 10**6), 'out': st.integers(0, 10**6)})


@st.composite
def usage_by_model(draw: st.DrawFn, *, many: bool = False) -> dict[str, Usage]:
    names = draw(st.lists(MODELS, min_size=0, max_size=40 if many else 4, unique=True))
    return {name: Usage(usd=draw(MONEY), tokens_in=draw(st.integers(0, 10**7)),
                        tokens_out=draw(st.integers(0, 10**6)), microvm_seconds=draw(st.integers(0, 3600)))
            for name in names}


@PROPERTY
@given(spent=MONEY, budget=BUDGETS)
def test_an_alert_level_is_passed_exactly_when_the_month_has_passed_it(spent: Decimal, budget: Decimal) -> None:
    """The alert levels are the percentages of the budget that the spend has reached (80 and 100, then every 50 up to
    1,000), lowest first: a level not reached is not in the list."""
    levels = alert_levels(spent, budget)
    assert levels == sorted(levels)
    assert set(levels) <= set(LEVELS)
    for level in LEVELS:
        assert (level in levels) == (spent * 100 / budget >= level)


@PROPERTY
@given(first=MONEY, second=MONEY, budget=BUDGETS)
def test_spend_that_grows_never_withdraws_an_alert(first: Decimal, second: Decimal, budget: Decimal) -> None:
    """Spend only grows: a level once passed stays passed for a larger spend, so an alert is never taken back."""
    low, high = sorted((first, second))
    assert set(alert_levels(low, budget)) <= set(alert_levels(high, budget))


@PROPERTY
@given(spent=MONEY, budget=st.decimals(min_value=-1000, max_value=0, places=2, allow_nan=False))
def test_no_positive_budget_means_no_alert(spent: Decimal, budget: Decimal) -> None:
    """A flow without a positive budget raises no alert at any spend (a zero or unset budget is not a limit)."""
    assert alert_levels(spent, budget) == []


@PROPERTY
@given(at=WHEN)
def test_a_month_is_the_utc_month_of_the_write(at: datetime) -> None:
    """The ledger's month is the UTC month of the write, whatever the writer's clock zone: a write at 23:30 in one zone
    lands in the month the instant is in UTC."""
    month = month_of(at)
    utc = at.astimezone(UTC)
    assert month == f'{utc.year:04d}-{utc.month:02d}'
    assert ledger_pk(month).endswith(f'#SPEND#{month}')


VALID_MONTH = re.compile(r'20[0-9]{2}-(0[1-9]|1[0-2])')


@PROPERTY
@given(month=st.one_of(st.from_regex(r'20[0-9]{2}-(0[1-9]|1[0-2])', fullmatch=True), st.text(max_size=12)))
def test_a_ledger_key_month_is_yyyy_mm_and_nothing_else(month: str) -> None:
    """Only a YYYY-MM month makes a ledger key; anything else is refused before a key is built."""
    if VALID_MONTH.fullmatch(month):
        assert ledger_pk(month).endswith(f'#SPEND#{month}')
    else:
        with pytest.raises(ValueError, match='a month is YYYY-MM'):
            ledger_pk(month)


@PROPERTY
@given(usage=usage_by_model(many=True), flow=FLOWS, run_id=RUN_IDS, at=WHEN)
def test_the_month_adds_up_to_what_the_runs_reported_and_each_row_is_written_once(
        usage: dict[str, Usage], flow: str, run_id: str, at: datetime) -> None:
    """A session's write adds exactly what it measured: the day rows' dollars, tokens and MicroVM seconds sum to the
    report's, every row is one key (no two operations on one row), and a flow with dollars has its month total
    raised by the same dollars."""
    updates = ledger_updates('voc-aggregates', at, Where(run_id, 'agent-1', flow, 'repo-1', 3), usage)
    keys = [(u['Update']['Key']['pk'], u['Update']['Key']['sk']) for u in updates]
    assert len(keys) == len(set(keys))
    day_total = Usage()
    for u in updates:
        if u['Update']['Key']['sk'].startswith('FLOW#'):
            continue
        values = u['Update']['ExpressionAttributeValues']
        assert min(values[':usd'], values[':in'], values[':out'], values[':secs']) >= 0
        day_total = day_total + Usage(usd=values[':usd'], tokens_in=values[':in'], tokens_out=values[':out'],
                                      microvm_seconds=values[':secs'])
    expected = sum((used for used in usage.values()), Usage())
    assert day_total.usd == expected.usd
    assert day_total.tokens_in == expected.tokens_in
    assert day_total.tokens_out == expected.tokens_out
    assert day_total.microvm_seconds == expected.microvm_seconds
    flow_rows = [u for u in updates if u['Update']['Key'] == flow_total_key(month_of(at), flow)]
    if expected.usd > 0 and keyable(flow):
        assert len(flow_rows) == 1
        assert flow_rows[0]['Update']['ExpressionAttributeValues'][':usd'] == expected.usd
    else:
        assert flow_rows == []


@PROPERTY
@given(usage=usage_by_model(), flow=FLOWS, at=WHEN)
def test_a_negative_figure_refuses_the_whole_write(usage: dict[str, Usage], flow: str, at: datetime) -> None:
    """A ledger write only adds: one negative figure, in any model, refuses the whole write."""
    assume(usage)
    usage[next(iter(usage))] = Usage(usd=Decimal('-0.01'))
    with pytest.raises(ValueError, match='only adds'):
        ledger_updates('voc-aggregates', at, Where('run-1', 'agent-1', flow, '', 1), usage)


@PROPERTY
@given(now=st.dictionaries(MODELS, TOKENS, max_size=5), earlier=st.dictionaries(MODELS, TOKENS, max_size=5))
def test_a_session_counts_each_token_once_and_never_negative(now: dict, earlier: dict) -> None:
    """The tokens a session reports are added once: the delta is what is above the ledgered total, never less than
    zero (a total that drops is not a refund), and a report already ledgered adds nothing."""
    deltas = token_deltas(now, earlier)
    assert all(d.tokens_in >= 0 and d.tokens_out >= 0 for d in deltas.values())
    assert token_deltas(now, now) == {}
    fresh = token_deltas(now, {})
    assert sum(d.tokens_in for d in fresh.values()) == sum(int(c['in']) for c in now.values())
    assert sum(d.tokens_out for d in fresh.values()) == sum(int(c['out']) for c in now.values())
    if MICROVM in now and now[MICROVM]['in'] + now[MICROVM]['out'] > 0:
        assert REPORTED_MICROVM in fresh
