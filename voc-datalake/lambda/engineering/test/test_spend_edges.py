"""The spend ledger's edges (engineering/spend.py): the exact requests its writes and its read send, the UTC day and
month whatever the machine's clock zone, a row's missing numbers, the model-row cap's edge, the refusals' own words,
the alerts' claim, close and give-back, and how a month's groups are keyed and ordered."""
from __future__ import annotations

import os
import time
from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any, cast

import pytest
from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from botocore.exceptions import _ClientErrorResponseTypeDef

from engineering import spend
from engineering.spend import (
    MICROVM,
    MonthSpend,
    Usage,
    Where,
    alert_sent,
    alerts_pk,
    check_query,
    claim_alert,
    flow_total_key,
    ledger_pk,
    ledger_updates,
    month_of,
    month_spend,
    release_alert,
    token_deltas,
)

#: The last half hour of a month in UTC: in a zone ahead of UTC it is already the next month's first day.
END_OF_MONTH = datetime(2026, 11, 30, 23, 30, tzinfo=UTC)
#: The first half hour of a month in UTC: in a zone behind UTC it is still the last month's last day.
START_OF_MONTH = datetime(2026, 12, 1, 0, 30, tzinfo=UTC)
BELOW_ZERO = 'a ledger write only adds: nothing in it is below zero'
BAD_MONTH = 'a month is YYYY-MM'
BAD_BY = 'by is one of workflow, repo, run, agent, model, day'


@pytest.fixture(params=['Etc/GMT-14', 'Etc/GMT+12'])
def far_zone(request: pytest.FixtureRequest) -> Iterator[str]:
    """The machine's clock in a zone far from UTC (14 hours ahead, 12 behind), restored after."""
    before = os.environ.get('TZ')
    os.environ['TZ'] = request.param
    time.tzset()
    yield request.param
    if before is None:
        del os.environ['TZ']
    else:
        os.environ['TZ'] = before
    time.tzset()


def _refusal(code: str = 'ConditionalCheckFailedException', item: dict[str, Any] | None = None) -> ClientError:
    response: dict[str, Any] = {'Error': {'Code': code, 'Message': 'refused'}}
    if item is not None:
        response['Item'] = item
    return ClientError(cast('_ClientErrorResponseTypeDef', response), 'UpdateItem')


class Recorder:
    """A table that records every request, refuses with ``error`` when given one, and answers ``items`` to a query."""

    def __init__(self, error: ClientError | None = None, items: list[dict[str, Any]] | None = None) -> None:
        self.error = error
        self.items = items or []
        self.requests: list[dict[str, Any]] = []

    def update_item(self, **request: Any) -> dict[str, Any]:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return {}

    def query(self, **request: Any) -> dict[str, Any]:
        self.requests.append(request)
        return {'Items': list(self.items)}


# --- the UTC month and day, whatever the machine's zone ---------------------------------------------------------

@pytest.mark.usefixtures('far_zone')
@pytest.mark.parametrize(('at', 'month'), [(END_OF_MONTH, '2026-11'), (START_OF_MONTH, '2026-12')])
def test_a_month_is_the_utc_month_whatever_the_machines_zone(at: datetime, month: str) -> None:
    assert month_of(at) == month


@pytest.mark.usefixtures('far_zone')
@pytest.mark.parametrize(('at', 'month', 'day'), [(END_OF_MONTH, '2026-11', '30'), (START_OF_MONTH, '2026-12', '01')])
def test_a_row_is_booked_to_the_utc_day_and_stamped_in_utc_whatever_the_machines_zone(
        at: datetime, month: str, day: str) -> None:
    row, total = ledger_updates('t', at, Where('RUN1', 'fixer-2', 'wf'), {MICROVM: Usage(usd=Decimal(1))})
    assert row['Update']['Key'] == {'pk': f'WS#default#SPEND#{month}',
                                    'sk': f'DAY#{day}#WF#wf#RUN#RUN1#AGENT#fixer-2#MODEL#microvm'}
    assert row['Update']['ExpressionAttributeValues'][':day'] == day
    assert row['Update']['ExpressionAttributeValues'][':at'] == at.isoformat()
    assert total['Update']['Key'] == {'pk': f'WS#default#SPEND#{month}', 'sk': 'FLOW#wf'}
    assert total['Update']['ExpressionAttributeValues'][':at'] == at.isoformat()


@pytest.mark.usefixtures('far_zone')
def test_an_alerts_claim_times_are_utc_whatever_the_machines_zone() -> None:
    table = Recorder()
    claim_alert(table, '2026-11', 'wf', 80, run_id='RUN1', spent=Decimal(85), budget=Decimal(100), at=END_OF_MONTH)
    values = table.requests[0]['ExpressionAttributeValues']
    assert values[':at'] == '2026-11-30T23:30:00+00:00'
    assert values[':stale'] == '2026-11-30T23:25:00+00:00'


@pytest.mark.usefixtures('far_zone')
def test_an_alerts_close_time_is_utc_whatever_the_machines_zone() -> None:
    table = Recorder()
    alert_sent(table, '2026-11', 'wf', 80, run_id='RUN1', budget=Decimal(100), at=END_OF_MONTH)
    assert table.requests[0]['ExpressionAttributeValues'][':at'] == '2026-11-30T23:30:00+00:00'


# --- the exact requests the writes send -------------------------------------------------------------------------

def test_a_ledger_row_and_its_flows_total_are_these_exact_updates() -> None:
    usage = {MICROVM: Usage(usd=Decimal('0.5'), microvm_seconds=60), 'model-a': Usage(usd=Decimal('0.25'),
                                                                                      tokens_in=10, tokens_out=3)}
    updates = ledger_updates('voc', END_OF_MONTH, Where('RUN1', 'fixer-2', 'wf', 'example/app', 7), usage)
    names = {'#day': 'day'}
    expression = ('ADD usd :usd, tokens_in :in, tokens_out :out, microvm_seconds :secs '
                  'SET #day = :day, flow = :flow, repo = :repo, run_id = :run, agent_id = :agent, '
                  'model = :model, updated_at = :at, updated_by = :by, session_seq = :seq')
    at = '2026-11-30T23:30:00+00:00'
    common = {':day': '30', ':flow': 'wf', ':repo': 'example/app', ':run': 'RUN1', ':agent': 'fixer-2', ':at': at,
              ':by': 'runtime/sessions', ':seq': 7}
    assert updates == [
        {'Update': {'TableName': 'voc', 'Key': {'pk': 'WS#default#SPEND#2026-11',
                                                'sk': 'DAY#30#WF#wf#RUN#RUN1#AGENT#fixer-2#MODEL#microvm'},
                    'UpdateExpression': expression, 'ExpressionAttributeNames': names,
                    'ExpressionAttributeValues': {':usd': Decimal('0.5'), ':in': 0, ':out': 0, ':secs': 60,
                                                  **common, ':model': 'microvm'}}},
        {'Update': {'TableName': 'voc', 'Key': {'pk': 'WS#default#SPEND#2026-11',
                                                'sk': 'DAY#30#WF#wf#RUN#RUN1#AGENT#fixer-2#MODEL#model-a'},
                    'UpdateExpression': expression, 'ExpressionAttributeNames': names,
                    'ExpressionAttributeValues': {':usd': Decimal('0.25'), ':in': 10, ':out': 3, ':secs': 0,
                                                  **common, ':model': 'model-a'}}},
        {'Update': {'TableName': 'voc', 'Key': {'pk': 'WS#default#SPEND#2026-11', 'sk': 'FLOW#wf'},
                    'UpdateExpression': 'ADD usd :usd SET updated_at = :at, updated_by = :by',
                    'ExpressionAttributeValues': {':usd': Decimal('0.75'), ':at': at, ':by': 'runtime/sessions'}}},
    ]


def test_a_rows_who_defaults_to_no_flow_no_repo_and_version_zero() -> None:
    (row,) = ledger_updates('t', END_OF_MONTH, Where('RUN1', 'fixer-2'), {'m': Usage(tokens_in=1)})
    values = row['Update']['ExpressionAttributeValues']
    assert (values[':flow'], values[':repo'], values[':seq']) == ('', '', 0)


def test_an_alerts_claim_is_this_exact_conditional_update() -> None:
    table = Recorder()
    assert claim_alert(table, '2026-11', 'wf', 80, run_id='RUN1', spent=Decimal(85), budget=Decimal('12.345'),
                       at=END_OF_MONTH) == 'claimed'
    assert table.requests == [{
        'Key': {'pk': 'WS#default#BUDGET#2026-11', 'sk': 'ALERT#wf#000000001234#0080'},
        'UpdateExpression': 'SET run_id = :run, spent_usd = :spent, alerted_at = :at, updated_by = :by',
        'ConditionExpression': ('attribute_not_exists(sk) OR (attribute_not_exists(sent_at) '
                                'AND (run_id = :run OR alerted_at < :stale))'),
        'ExpressionAttributeValues': {':run': 'RUN1', ':spent': Decimal(85), ':stale': '2026-11-30T23:25:00+00:00',
                                      ':at': '2026-11-30T23:30:00+00:00', ':by': 'runtime/supervisor'},
        'ReturnValuesOnConditionCheckFailure': 'ALL_OLD'}]


def test_an_alerts_close_is_this_exact_conditional_update() -> None:
    table = Recorder()
    alert_sent(table, '2026-11', 'wf', 1000, run_id='RUN1', budget=Decimal(100), at=END_OF_MONTH)
    assert table.requests == [{
        'Key': {'pk': 'WS#default#BUDGET#2026-11', 'sk': 'ALERT#wf#000000010000#1000'},
        'UpdateExpression': 'SET sent_at = :at',
        'ConditionExpression': 'attribute_exists(sk) AND run_id = :run AND attribute_not_exists(sent_at)',
        'ExpressionAttributeValues': {':run': 'RUN1', ':at': '2026-11-30T23:30:00+00:00'}}]


def test_a_given_back_claim_goes_to_the_epoch_by_this_exact_conditional_update() -> None:
    table = Recorder()
    release_alert(table, '2026-11', 'wf', 100, run_id='RUN1', budget=Decimal(100))
    assert table.requests == [{
        'Key': {'pk': 'WS#default#BUDGET#2026-11', 'sk': 'ALERT#wf#000000010000#0100'},
        'UpdateExpression': 'SET alerted_at = :released',
        'ConditionExpression': 'attribute_exists(sk) AND run_id = :run AND attribute_not_exists(sent_at)',
        'ExpressionAttributeValues': {':run': 'RUN1', ':released': '1970-01-01T00:00:00+00:00'}}]


def test_a_months_read_is_this_one_query_of_its_day_rows() -> None:
    table = Recorder()
    month_spend(table, '2026-11', 'day')
    assert table.requests == [{'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :day)',
                               'ExpressionAttributeValues': {':pk': 'WS#default#SPEND#2026-11', ':day': 'DAY#'}}]


# --- what an alert's claim, close and give-back answer -----------------------------------------------------------

@pytest.mark.parametrize(('old', 'claim'), [
    ({'sent_at': '2026-11-30T23:00:00+00:00', 'run_id': 'RUN2'}, 'said'), ({'run_id': 'RUN2'}, 'held'), (None, 'held')])
def test_a_refused_claim_is_said_when_the_row_was_closed_else_held(old: dict[str, Any] | None, claim: str) -> None:
    table = Recorder(_refusal(item=old))
    assert claim_alert(table, '2026-11', 'wf', 80, run_id='RUN1', spent=Decimal(85), budget=Decimal(100),
                       at=END_OF_MONTH) == claim


def test_a_claim_that_fails_for_another_reason_raises() -> None:
    table = Recorder(_refusal('ProvisionedThroughputExceededException'))
    with pytest.raises(ClientError, match='ProvisionedThroughputExceededException'):
        claim_alert(table, '2026-11', 'wf', 80, run_id='RUN1', spent=Decimal(85), budget=Decimal(100),
                    at=END_OF_MONTH)


def test_a_close_or_give_back_its_condition_refuses_is_quietly_nothing() -> None:
    table = Recorder(_refusal())
    alert_sent(table, '2026-11', 'wf', 80, run_id='RUN2', budget=Decimal(100), at=END_OF_MONTH)
    release_alert(table, '2026-11', 'wf', 80, run_id='RUN2', budget=Decimal(100))
    assert len(table.requests) == 2


def test_a_close_that_fails_for_another_reason_raises() -> None:
    table = Recorder(_refusal('InternalServerError'))
    with pytest.raises(ClientError, match='InternalServerError'):
        alert_sent(table, '2026-11', 'wf', 80, run_id='RUN1', budget=Decimal(100), at=END_OF_MONTH)


def test_a_give_back_that_fails_for_another_reason_raises() -> None:
    table = Recorder(_refusal('InternalServerError'))
    with pytest.raises(ClientError, match='InternalServerError'):
        release_alert(table, '2026-11', 'wf', 80, run_id='RUN1', budget=Decimal(100))


# --- the refusals' own words ----------------------------------------------------------------------------------

@pytest.mark.parametrize('used', [Usage(usd=Decimal('-0.01')), Usage(tokens_in=-1), Usage(tokens_out=-1),
                                  Usage(microvm_seconds=-1)])
def test_any_one_figure_below_zero_refuses_the_write_in_its_own_words(used: Usage) -> None:
    with pytest.raises(ValueError, match='only adds') as refused:
        ledger_updates('t', END_OF_MONTH, Where('RUN1', 'fixer-2', 'wf'), {'ok': Usage(tokens_in=1), 'm': used})
    assert str(refused.value) == BELOW_ZERO


@pytest.mark.parametrize('month', ['2026-00', '2026-13', '1999-12', '2100-01', '2026-1', '2026-011', ' 2026-11'])
def test_a_month_that_is_not_yyyy_mm_is_refused_in_its_own_words(month: str) -> None:
    with pytest.raises(ValueError, match='YYYY-MM') as refused:
        ledger_pk(month)
    assert str(refused.value) == BAD_MONTH


@pytest.mark.parametrize('month', ['2000-01', '2026-09', '2026-10', '2026-12', '2099-11'])
def test_every_real_month_has_its_ledger_and_its_alerts(month: str) -> None:
    assert (ledger_pk(month), alerts_pk(month)) == (f'WS#default#SPEND#{month}', f'WS#default#BUDGET#{month}')


def test_the_alerts_take_the_ledgers_month_rule() -> None:
    with pytest.raises(ValueError, match='YYYY-MM') as refused:
        alerts_pk('2026-13')
    assert str(refused.value) == BAD_MONTH


def test_a_read_refuses_a_grouping_naming_every_one_it_takes() -> None:
    with pytest.raises(ValueError, match='by is one of') as refused:
        check_query('2026-11', 'cost')
    assert str(refused.value) == BAD_BY


def test_a_read_refuses_a_bad_month_before_its_grouping() -> None:
    with pytest.raises(ValueError, match='YYYY-MM') as refused:
        check_query('2026-13', 'cost')
    assert str(refused.value) == BAD_MONTH


@pytest.mark.parametrize('by', ['workflow', 'repo', 'run', 'agent', 'model', 'day'])
def test_every_grouping_is_taken(by: str) -> None:
    assert check_query('2026-11', by) is None


# --- a key part ---------------------------------------------------------------------------------------------

@pytest.mark.parametrize(('flow', 'part'), [
    ('Az09._:/@+=-', 'Az09._:/@+=-'), ('x' * 128, 'x' * 128), ('x' * 129, '-'), ('', '-'), ('a b', '-'),
    ('a#b', '-'), ('a\n', '-')])
def test_a_key_part_is_its_own_ascii_up_to_128_or_the_dash_row(flow: str, part: str) -> None:
    assert flow_total_key('2026-11', flow) == {'pk': 'WS#default#SPEND#2026-11', 'sk': f'FLOW#{part}'}


# --- a usage's numbers ---------------------------------------------------------------------------------------

def test_a_usage_starts_at_zero_in_every_figure() -> None:
    assert Usage() == Usage(usd=Decimal(0), tokens_in=0, tokens_out=0, microvm_seconds=0)


@pytest.mark.parametrize('field', ['usd', 'tokens_in', 'tokens_out', 'microvm_seconds'])
def test_a_row_missing_a_figure_reads_it_as_zero(field: str) -> None:
    row = {'usd': Decimal('1.5'), 'tokens_in': 10, 'tokens_out': 3, 'microvm_seconds': 60}
    del row[field]
    expected = {'usd': Decimal('1.5'), 'tokens_in': 10, 'tokens_out': 3, 'microvm_seconds': 60, field: 0}
    assert Usage.of_row(row) == Usage(**expected)


def test_a_row_with_no_figures_reads_as_nothing() -> None:
    assert Usage.of_row({}) == Usage()


@pytest.mark.parametrize('used', [Usage(usd=Decimal('0.01')), Usage(tokens_in=1), Usage(tokens_out=1),
                                  Usage(microvm_seconds=1)])
def test_any_one_figure_makes_a_usage_count(used: Usage) -> None:
    assert bool(used) is True


def test_a_usage_with_nothing_counts_for_nothing() -> None:
    assert bool(Usage()) is False


def test_two_usages_add_figure_by_figure() -> None:
    total = Usage(Decimal('1.5'), 1, 2, 3) + Usage(Decimal('0.25'), 10, 20, 30)
    assert total == Usage(Decimal('1.75'), 11, 22, 33)


def test_a_usages_tokens_are_in_and_out_together() -> None:
    assert Usage(tokens_in=3, tokens_out=4).tokens == 7


def test_a_usage_is_shown_with_dollars_as_a_number() -> None:
    assert Usage(Decimal('1.25'), 1, 2, 3).view() == {'usd': 1.25, 'tokens_in': 1, 'tokens_out': 2,
                                                       'microvm_seconds': 3}


# --- the model-row cap -----------------------------------------------------------------------------------------

def _models(updates: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {update['Update']['Key']['sk'].rsplit('#MODEL#', 1)[1]: update['Update']['ExpressionAttributeValues']
            for update in updates if update['Update']['Key']['sk'].startswith('DAY#')}


def test_exactly_the_cap_of_models_keeps_every_one_its_own_row() -> None:
    usage = {f'm{number:02}': Usage(tokens_in=1) for number in range(spend.MAX_MODEL_ROWS)}
    rows = _models(ledger_updates('t', END_OF_MONTH, Where('RUN1', 'fixer-2', 'wf'), usage))
    assert sorted(rows) == sorted(usage)


def test_past_the_cap_the_most_tokens_keep_their_rows_and_the_rest_are_summed_on_the_dash_row() -> None:
    # Tokens out count as tokens too: m00 has the fewest in but the most in all.
    usage = {f'm{number:02}': Usage(tokens_in=100 + number) for number in range(1, 33)}
    usage['m00'] = Usage(tokens_in=1, tokens_out=1000)
    usage['m01'] = Usage(tokens_in=5, usd=Decimal(2))
    rows = _models(ledger_updates('t', END_OF_MONTH, Where('RUN1', 'fixer-2', 'wf'), usage))
    assert sorted(rows) == ['-', 'm00', *(f'm{number:02}' for number in range(3, 33))]
    assert (rows['-'][':in'], rows['-'][':usd']) == (5 + 102, Decimal(2))


def test_past_the_cap_equal_tokens_keep_the_first_names() -> None:
    usage = {f'm{number:02}': Usage(tokens_in=1) for number in range(33)}
    rows = _models(ledger_updates('t', END_OF_MONTH, Where('RUN1', 'fixer-2', 'wf'), usage))
    assert sorted(rows) == ['-', *(f'm{number:02}' for number in range(31))]
    assert rows['-'][':in'] == 2


def test_past_the_cap_a_kept_dash_row_also_takes_the_rest() -> None:
    usage = {f'm{number:02}': Usage(tokens_in=10 + number) for number in range(33)}
    usage['a b'] = Usage(tokens_in=1000)   # (cleans to the '-' row, which has the most tokens)
    rows = _models(ledger_updates('t', END_OF_MONTH, Where('RUN1', 'fixer-2', 'wf'), usage))
    assert sorted(rows) == ['-', *(f'm{number:02}' for number in range(3, 33))]   # (one row fewer than the cap)
    assert rows['-'][':in'] == 1000 + 10 + 11 + 12


def test_session_time_keeps_its_row_past_the_cap_even_with_no_tokens() -> None:
    usage = {f'm{number:02}': Usage(tokens_in=1) for number in range(40)}
    usage[MICROVM] = Usage(microvm_seconds=5)
    rows = _models(ledger_updates('t', END_OF_MONTH, Where('RUN1', 'fixer-2', 'wf'), usage))
    assert rows[MICROVM][':secs'] == 5
    assert rows['-'][':in'] == 40 - 30


# --- the token deltas ------------------------------------------------------------------------------------------

def test_a_count_missing_from_a_report_or_the_ledger_is_zero() -> None:
    assert token_deltas({'a': {'in': 5}, 'b': {'out': 4}, 'c': {}}, {'a': {'out': 9}, 'b': {'in': 9}}) == {
        'a': Usage(tokens_in=5), 'b': Usage(tokens_out=4)}


def test_a_total_that_dropped_adds_nothing_while_the_other_count_still_adds() -> None:
    assert token_deltas({'a': {'in': 3, 'out': 10}}, {'a': {'in': 5, 'out': 4}}) == {'a': Usage(tokens_out=6)}


def test_a_reported_model_named_like_the_session_row_is_ledgered_apart_and_summed() -> None:
    deltas = token_deltas({MICROVM: {'in': 2, 'out': 1}, 'microvm-reported': {'in': 3}}, {})
    assert deltas == {'microvm-reported': Usage(tokens_in=5, tokens_out=1)}


# --- a month's read --------------------------------------------------------------------------------------------

def test_an_empty_month_shows_nothing_spent() -> None:
    assert MonthSpend('2026-11', 'day').view() == {
        'month': '2026-11', 'by': 'day', 'truncated': False, 'groups': [],
        'total': {'usd': 0.0, 'tokens_in': 0, 'tokens_out': 0, 'microvm_seconds': 0}}


def test_a_months_read_says_which_month_and_grouping_it_is() -> None:
    view = month_spend(Recorder(items=[]), '2026-11', 'model').view()
    assert (view['month'], view['by']) == ('2026-11', 'model')


def test_groups_are_biggest_first_by_dollars_then_tokens_then_time_then_key() -> None:
    month = MonthSpend('2026-11', 'model', groups={
        'b-time': Usage(microvm_seconds=5), 'a-time': Usage(microvm_seconds=5), 'more-time': Usage(microvm_seconds=9),
        'tokens': Usage(tokens_in=1, tokens_out=1), 'fewer-tokens': Usage(tokens_out=1),
        'dollars': Usage(usd=Decimal('0.5')), 'more-dollars': Usage(usd=Decimal(1))}, truncated=True)
    view = month.view()
    assert [group['key'] for group in view['groups']] == [
        'more-dollars', 'dollars', 'tokens', 'fewer-tokens', 'more-time', 'a-time', 'b-time']
    assert view['groups'][0] == {'key': 'more-dollars', 'usd': 1.0, 'tokens_in': 0, 'tokens_out': 0,
                                 'microvm_seconds': 0}
    assert view['truncated'] is True


ROWS = [
    {'flow': 'wf_a', 'repo': 'example/app', 'run_id': 'RUN1', 'agent_id': 'fixer-1', 'model': 'microvm', 'day': '01',
     'usd': Decimal(1)},
    {'flow': 'wf_b', 'repo': 'example/lib', 'run_id': 'RUN2', 'agent_id': 'fixer-1', 'model': 'model-a', 'day': '02',
     'tokens_in': 7},
    {'usd': Decimal(2)},   # (a row missing its who: grouped on '-')
    {'flow': '', 'agent_id': 'hunter-1', 'tokens_out': 3},
]


@pytest.mark.parametrize(('by', 'keys'), [
    ('workflow', ['-', 'wf_a', 'wf_b']), ('repo', ['-', 'example/app', 'example/lib']), ('run', ['-', 'RUN1', 'RUN2']),
    ('agent', ['-/-', '-/hunter-1', 'RUN1/fixer-1', 'RUN2/fixer-1']), ('model', ['-', 'microvm', 'model-a']),
    ('day', ['-', '01', '02'])])
def test_each_grouping_reads_its_own_attribute_and_a_missing_one_is_the_dash_group(by: str, keys: list[str]) -> None:
    spent = month_spend(Recorder(items=ROWS), '2026-11', by)
    assert sorted(spent.groups) == keys
    assert spent.total == Usage(usd=Decimal(3), tokens_in=7, tokens_out=3)


def test_a_flows_read_takes_only_its_rows_and_no_flow_takes_all() -> None:
    only = month_spend(Recorder(items=ROWS), '2026-11', 'run', flow='wf_b')
    assert (only.groups, only.total) == ({'RUN2': Usage(tokens_in=7)}, Usage(tokens_in=7))


@pytest.mark.parametrize(('rows', 'truncated'), [(3, False), (4, True)])
def test_a_month_is_truncated_only_past_its_row_cap(monkeypatch: pytest.MonkeyPatch, rows: int, truncated: bool) -> None:
    monkeypatch.setattr(spend, 'MAX_ROWS', 3)
    items = [{'run_id': f'RUN{number}', 'usd': Decimal(1)} for number in range(rows)]
    spent = month_spend(Recorder(items=items), '2026-11', 'run')
    assert (spent.truncated, spent.total.usd, len(spent.groups)) == (truncated, Decimal(3), 3)


def test_a_flows_read_counts_the_rows_it_skips_toward_the_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(spend, 'MAX_ROWS', 1)
    spent = month_spend(Recorder(items=ROWS[:2]), '2026-11', 'run', flow='wf_b')
    assert (spent.truncated, spent.total) == (True, Usage())


def test_a_month_reads_twenty_thousand_rows_before_it_is_truncated() -> None:
    items = [{'usd': Decimal(1)}] * 20_001
    spent = month_spend(Recorder(items=items), '2026-11', 'day')
    assert (spent.truncated, spent.total.usd) == (True, Decimal(20_000))
