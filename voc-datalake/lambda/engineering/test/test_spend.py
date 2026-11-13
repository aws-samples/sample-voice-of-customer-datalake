"""The spend ledger (engineering/spend.py): its rows' keys and ADDs, the token deltas, and one month's grouped read."""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import boto3
import pytest
from moto import mock_aws

from engineering import spend
from engineering.board.test.table import TABLE, create_table
from engineering.spend import MICROVM, Usage, Where, ledger_updates, month_spend, token_deltas

AT = datetime(2026, 11, 13, 23, 30, tzinfo=UTC)


@pytest.fixture
def table() -> Iterator[Any]:
    with mock_aws():
        create_table()
        yield boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)


def _add(table: Any, where: Where, usage: dict[str, Usage], at: datetime = AT) -> None:
    table.meta.client.transact_write_items(TransactItems=ledger_updates(TABLE, at, where, usage))


def test_a_rows_key_is_the_day_workflow_run_agent_and_model_in_the_months_partition():
    (update,) = ledger_updates(TABLE, AT, Where('RUN1', 'fixer-2', 'wf_hunt', 'example/app'),
                               {MICROVM: Usage(usd=Decimal('0.5'), microvm_seconds=60), 'idle': Usage()})
    assert update['Update']['Key'] == {'pk': 'WS#default#SPEND#2026-11',
                                       'sk': 'DAY#13#WF#wf_hunt#RUN#RUN1#AGENT#fixer-2#MODEL#microvm'}
    # A part that could break the key (empty, or a '#') is '-'; a model that adds nothing writes no row.
    (odd,) = ledger_updates(TABLE, AT, Where('RUN1', 'a#b', ''), {'m': Usage(tokens_in=1)})
    assert odd['Update']['Key']['sk'] == 'DAY#13#WF#-#RUN#RUN1#AGENT#-#MODEL#m'


def test_token_deltas_count_only_what_is_new_never_less_than_none():
    assert token_deltas({'a': {'in': 10, 'out': 4}, 'b': {'in': 3, 'out': 0}}, {'a': {'in': 7, 'out': 4}, 'b': {'in': 5}}) == {
        'a': Usage(tokens_in=3)}


def test_a_month_reads_one_partition_grouped_by_what_is_asked(table: Any):
    hunt = Where('RUN1', 'hunter-2', 'wf_hunt', 'example/app')
    fix = Where('RUN2', 'fixer-3', 'wf_fix', 'example/lib')
    _add(table, hunt, {MICROVM: Usage(usd=Decimal('1.5'), microvm_seconds=100), 'model-a': Usage(tokens_in=10, tokens_out=2)})
    _add(table, hunt, {MICROVM: Usage(usd=Decimal('0.5'), microvm_seconds=50)})   # (the same row: ADDs)
    _add(table, fix, {MICROVM: Usage(usd=Decimal('3'), microvm_seconds=300)})
    _add(table, fix, {MICROVM: Usage(usd=Decimal('9'))}, datetime(2026, 12, 1, tzinfo=UTC))   # (next month: not read)
    by_workflow = month_spend(table, '2026-11', 'workflow').view()
    assert by_workflow['total'] == {'usd': 5.0, 'tokens_in': 10, 'tokens_out': 2, 'microvm_seconds': 450}
    assert [(group['key'], group['usd']) for group in by_workflow['groups']] == [('wf_fix', 3.0), ('wf_hunt', 2.0)]
    by_model = month_spend(table, '2026-11', 'model', flow='wf_hunt').view()
    assert [(group['key'], group['tokens_in']) for group in by_model['groups']] == [('microvm', 0), ('model-a', 10)]
    by_repo = month_spend(table, '2026-11', 'repo').view()
    assert {group['key'] for group in by_repo['groups']} == {'example/app', 'example/lib'}


def test_a_month_past_the_row_cap_answers_what_it_read_and_says_so(table: Any, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(spend, 'MAX_ROWS', 1)
    for agent in ('a-1', 'b-2'):
        _add(table, Where('RUN1', agent, 'wf'), {MICROVM: Usage(usd=Decimal(1))})
    view = month_spend(table, '2026-11', 'agent').view()
    assert (view['truncated'], view['total']['usd']) == (True, 1.0)


@pytest.mark.parametrize(('month', 'by', 'match'), [
    ('2026-13', 'workflow', 'YYYY-MM'), ('26-11', 'run', 'YYYY-MM'), ('2026-11', 'cost', 'by is one of')])
def test_a_bad_month_or_grouping_is_refused(table: Any, month: str, by: str, match: str):
    with pytest.raises(ValueError, match=match):
        month_spend(table, month, by)


def test_model_names_that_clean_to_one_key_are_one_entry_never_two_operations_on_a_row(table: Any):
    # (from the harness's report, inside the MicroVM: two such entries would fail the whole transaction)
    usage = {'a#1': Usage(tokens_in=5), 'a b': Usage(tokens_in=7), '': Usage(tokens_out=1)}
    (entry,) = ledger_updates(TABLE, AT, Where('RUN1', 'fixer-2', 'wf'), usage)
    assert entry['Update']['ExpressionAttributeValues'][':in'] == 12
    _add(table, Where('RUN1', 'fixer-2', 'wf'), usage)
    assert month_spend(table, '2026-11', 'model').view()['groups'] == [
        {'key': '-', 'usd': 0.0, 'tokens_in': 12, 'tokens_out': 1, 'microvm_seconds': 0}]


def test_a_month_groups_by_run_by_day_and_by_each_runs_own_agent(table: Any):
    _add(table, Where('RUN1', 'fixer-1', 'wf'), {MICROVM: Usage(usd=Decimal(1))})
    _add(table, Where('RUN2', 'fixer-1', 'wf'), {MICROVM: Usage(usd=Decimal(2))}, datetime(2026, 11, 14, tzinfo=UTC))
    keys = {by: [group['key'] for group in month_spend(table, '2026-11', by).view()['groups']]
            for by in ('run', 'day', 'agent')}
    # (every run has its own fixer-1: an agent is its run's)
    assert keys == {'run': ['RUN2', 'RUN1'], 'day': ['14', '13'], 'agent': ['RUN2/fixer-1', 'RUN1/fixer-1']}


def test_microvm_time_keeps_its_own_row_past_the_cap():
    usage = {f'm{number:03}': Usage(tokens_in=1) for number in range(150)}
    usage[MICROVM] = Usage(usd=Decimal(1), microvm_seconds=10)
    entries = ledger_updates(TABLE, AT, Where('RUN1', 'fixer-2', 'wf'), usage)
    keys = {entry['Update']['Key']['sk'].rsplit('#', 1)[1]: entry for entry in entries}
    assert (len(entries), keys['microvm']['Update']['ExpressionAttributeValues'][':secs']) == (32, 10)


def test_a_key_part_is_ascii_so_a_sort_key_fits_its_bytes():
    (entry,) = ledger_updates(TABLE, AT, Where('RUN1', 'fixer-2', 'é' * 128), {'模型': Usage(tokens_in=1)})
    assert entry['Update']['Key']['sk'] == 'DAY#13#WF#-#RUN#RUN1#AGENT#fixer-2#MODEL#-'


def test_groups_with_no_dollars_are_ordered_by_tokens_then_time(table: Any):
    _add(table, Where('RUN1', 'fixer-2', 'wf'), {'small': Usage(tokens_in=1), 'big': Usage(tokens_in=900)})
    groups = month_spend(table, '2026-11', 'model').view()['groups']
    assert [group['key'] for group in groups] == ['big', 'small']
