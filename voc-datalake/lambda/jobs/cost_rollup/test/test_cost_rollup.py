"""voc-cost-rollup (jobs/cost_rollup/handler.py): the days it rolls up, the Insights queries it runs, and the rows it
writes (moto voc-aggregates and voc-workspaces; a fake Logs client: moto runs no Insights query)."""
from __future__ import annotations

import io
import json
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime
from decimal import Decimal
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from jobs.cost_rollup import handler
from jobs.cost_rollup.handler import (
    MAX_DAYS_BACK,
    USAGE_FILTER,
    IncompleteDay,
    Rollup,
    RollupIncomplete,
    day_query,
    days_to_roll_up,
    handle_event,
    query_day,
)
from shared import usage_meter
from shared.exceptions import ConfigurationError
from shared.model_prices import PriceList, TokenPrices
from shared.system_logs import ROW_LIMIT
from shared.test.moto_tables import create_pk_sk_table
from shared.test.system_logs_fake import PATTERN, FakeLogs, group
from shared.ws_repo import WorkspaceStatusCheck

ACME = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
BIRCH = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
MODEL = 'global.example.fictional-model'
NOW = datetime(2026, 11, 14, 2, 15, tzinfo=UTC)
YESTERDAY, BEFORE = '2026-11-13', '2026-11-12'


def usage(ws: str, *, model: str = MODEL, tier: str = 'default', calls: int = 1, input_tokens: int = 100,
          output_tokens: int = 10, cache_read: int = 0, cache_write: int = 0) -> list[dict[str, str]]:
    """One stats row as GetQueryResults answers it (every value a string)."""
    values = {'workspace_id': ws, 'model_id': model, 'service_tier': tier, 'calls': calls,
              'input_tokens': input_tokens, 'output_tokens': output_tokens, 'cache_read_tokens': cache_read,
              'cache_write_tokens': cache_write}
    return [{'field': name, 'value': str(value)} for name, value in values.items()]


Answer = Callable[[dict[str, Any]], tuple[str, list[list[dict[str, str]]]]]


class Logs(FakeLogs):
    """The System logs fake's listing, starts and stops; each started query answers ``answer(query)``
    (its status, and its rows once Complete)."""

    def __init__(self, names: list[str], answer: Answer) -> None:
        super().__init__(names)
        self.answer = answer

    def get_query_results(self, *, queryId: str) -> dict:
        query = next(q for q in self.started if q['queryId'] == queryId)
        status, rows = self.answer(query)
        return {'status': status, 'results': rows if status == 'Complete' else []}


def day_of(query: dict[str, Any]) -> str:
    return datetime.fromtimestamp(query['startTime'], UTC).date().isoformat()


@dataclass
class World:
    aggregates: Any
    workspaces: Any
    active: set[str]

    def rollup(self, logs: Logs, **overrides: Any) -> Rollup:
        clock = [0.0]

        def sleep(seconds: float) -> None:
            clock[0] += seconds

        base = Rollup(logs=logs, aggregates=self.aggregates, is_active=lambda scope: scope.ws in self.active,
                      now=lambda: NOW, monotonic=lambda: clock[0], sleep=sleep)
        return replace(base, **overrides)

    def rows(self, pk: str) -> list[dict[str, Any]]:
        return self.aggregates.query(KeyConditionExpression='pk = :p', ExpressionAttributeValues={':p': pk})['Items']


@pytest.fixture
def world(monkeypatch) -> Iterator[World]:
    monkeypatch.setenv('SYSTEM_LOG_GROUP_PATTERN', PATTERN)
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        yield World(create_pk_sk_table('test-aggregates', resource), create_pk_sk_table('test-workspaces', resource),
                    {ACME})


def by_day(rows: dict[str, list[list[dict[str, str]]]]) -> Callable[[dict[str, Any]], tuple[str, list]]:
    return lambda query: ('Complete', rows.get(day_of(query), []))


GROUPS = [group('projects-api'), group('settings-api')]


def test_the_scheduled_run_writes_yesterday_and_the_day_before_for_each_workspace_and_the_deployment(world):
    logs = Logs(GROUPS, by_day({
        YESTERDAY: [usage(ACME, calls=3, input_tokens=1200, output_tokens=300, cache_read=50, cache_write=7),
                    usage('DEPLOYMENT', calls=1), usage('UNATTRIBUTED', calls=2)],
        BEFORE: [usage(ACME, calls=1)],
    }))
    outcome = handle_event({'mode': 'scheduled'}, world.rollup(logs))

    assert sorted(day_of(q) for q in logs.started) == [BEFORE, YESTERDAY]
    assert all(q['queryString'] == day_query(q['startTime'] * 1000, q['endTime'] * 1000)
               and q['endTime'] - q['startTime'] == 86400 for q in logs.started)
    assert outcome['written'][YESTERDAY] == {'workspaces': 1, 'deleted_workspaces': 0, 'deployment': 1,
                                             'unattributed': 1}
    [first, second] = sorted(world.rows(f'WS#{ACME}#COST'), key=lambda row: row['sk'])
    assert (first['sk'], second['sk']) == (BEFORE, YESTERDAY)
    assert second['totals'] == {'calls': 3, 'input_tokens': 1200, 'output_tokens': 300, 'cache_read_tokens': 50,
                                'cache_write_tokens': 7}
    # Every allowlisted model is unpriced today: the tokens are counted, the cost is None, the day incomplete.
    assert (second['estimated_usd'], second['complete'], second['unpriced_models']) == (None, False, [MODEL])
    assert second['by_model'] == [{'model_id': MODEL, 'service_tier': 'default', 'calls': 3, 'input_tokens': 1200,
                                   'output_tokens': 300, 'cache_read_tokens': 50, 'cache_write_tokens': 7,
                                   'estimated_usd': None}]
    assert {second['schema'], second['workspace_id'], second['price_as_of']} == {1, ACME, '2026-11-14'}
    assert second['rolled_up_at'] == NOW.isoformat()
    assert 'ttl' not in second
    assert [row['totals']['calls'] for row in world.rows('DEPLOYMENT#COST')] == [1]
    assert [row['totals']['calls'] for row in world.rows('UNATTRIBUTED#COST')] == [2]


def test_fifty_groups_a_query_and_the_batches_rows_are_summed(world):
    names = [group(f'fn-{n:03}') for n in range(260)]
    # Every batch answers the same row: six batches, one model's counts six times.
    logs = Logs(names, lambda _query: ('Complete', [usage(ACME, calls=2, input_tokens=10)]))
    handle_event({'days': [YESTERDAY]}, world.rollup(logs))

    # (the queries start concurrently, shared/system_logs.py start_queries: their batches' sizes, in any order)
    assert sorted((len(q['logGroupNames']) for q in logs.started), reverse=True) == [50, 50, 50, 50, 50, 10]
    assert sorted(name for q in logs.started for name in q['logGroupNames']) == sorted(names)
    [row] = world.rows(f'WS#{ACME}#COST')
    assert (row['totals']['calls'], row['totals']['input_tokens']) == (12, 60)


def test_only_the_voc_lambda_groups_of_this_deployment_are_queried(world):
    stranger = '/aws/lambda/other-app-123456789012-us-east-1'
    logs = Logs([*GROUPS, stranger], by_day({}))
    handle_event({'days': [YESTERDAY]}, world.rollup(logs))
    assert sorted(logs.started[0]['logGroupNames']) == sorted(GROUPS)


def test_a_workspace_that_is_not_active_gets_no_row_and_counts_to_the_deployments_deleted_workspaces(world):
    logs = Logs(GROUPS, by_day({YESTERDAY: [usage(ACME, calls=1), usage(BIRCH, calls=4, input_tokens=40),
                                            usage(BIRCH, model='global.example.other', calls=1)]}))
    handle_event({'days': [YESTERDAY]}, world.rollup(logs))

    assert world.rows(f'WS#{BIRCH}#COST') == []
    [deployment] = world.rows('DEPLOYMENT#COST')
    assert deployment['totals']['calls'] == 0
    deleted = deployment['deleted_workspaces']
    assert (deleted['workspaces'], deleted['totals']['calls'], deleted['totals']['input_tokens']) == (1, 5, 140)
    assert deleted['unpriced_models'] == [MODEL, 'global.example.other']
    assert 'by_model' not in deleted


def test_the_status_check_is_the_workspaces_meta(world):
    world.workspaces.put_item(Item={'pk': f'WS#{ACME}', 'sk': 'META', 'status': 'active'})
    world.workspaces.put_item(Item={'pk': f'WS#{BIRCH}', 'sk': 'META', 'status': 'deleting'})
    logs = Logs(GROUPS, by_day({YESTERDAY: [usage(ACME), usage(BIRCH)]}))
    handle_event({'days': [YESTERDAY]}, world.rollup(logs, is_active=WorkspaceStatusCheck(world.workspaces)))
    assert [len(world.rows(f'WS#{ws}#COST')) for ws in (ACME, BIRCH)] == [1, 0]


@pytest.mark.parametrize('named', ['', 'not-a-workspace', 'ws_short'])
def test_a_line_that_names_no_workspace_is_unattributed(world, named):
    logs = Logs(GROUPS, by_day({YESTERDAY: [usage(named, calls=2)]}))
    handle_event({'days': [YESTERDAY]}, world.rollup(logs))
    assert [row['totals']['calls'] for row in world.rows('UNATTRIBUTED#COST')] == [2]


def test_a_rerun_overwrites_the_day_never_adds_to_it(world):
    logs = Logs(GROUPS, by_day({YESTERDAY: [usage(ACME, calls=3), usage('DEPLOYMENT', calls=1)]}))
    for _ in range(2):
        handle_event({'days': [YESTERDAY]}, world.rollup(logs))
    assert [row['totals']['calls'] for row in world.rows(f'WS#{ACME}#COST')] == [3]
    assert [row['totals']['calls'] for row in world.rows('DEPLOYMENT#COST')] == [1]


def test_a_priced_model_is_estimated_in_usd(world):
    prices = PriceList(as_of='2026-01-01', source_url='https://example.com/prices', basis='fictional',
                       prices={MODEL: {'default': TokenPrices(Decimal('3'), Decimal('15'), Decimal('0.3'),
                                                              Decimal('3.75'))}})
    logs = Logs(GROUPS, by_day({YESTERDAY: [usage(ACME, input_tokens=1_000_000, output_tokens=0),
                                            usage(ACME, model='global.example.other', input_tokens=5)]}))
    handle_event({'days': [YESTERDAY]}, world.rollup(logs, price_list=prices))
    [row] = world.rows(f'WS#{ACME}#COST')
    assert row['estimated_usd'] == Decimal('3')
    assert (row['complete'], row['unpriced_models'], row['price_as_of']) == (False, ['global.example.other'],
                                                                            '2026-01-01')
    assert [entry['estimated_usd'] for entry in row['by_model']] == [Decimal('3'), None]


def _incomplete(world, answer, **overrides) -> tuple[Logs, RollupIncomplete]:
    """A run whose yesterday answers ``answer`` and whose day before answers a usage row."""
    def answering(query):
        return answer(query) if day_of(query) == YESTERDAY else ('Complete', [usage(ACME)])
    logs = Logs(GROUPS, answering)
    with pytest.raises(RollupIncomplete) as raised:
        handle_event({'mode': 'scheduled'}, world.rollup(logs, **overrides))
    return logs, raised.value


def _days_written(world) -> list[str]:
    return sorted(row['sk'] for row in world.rows(f'WS#{ACME}#COST'))


def test_a_day_at_the_result_cap_is_not_written_and_the_run_raises_after_the_other(world):
    _incomplete(world, lambda _query: ('Complete', [usage(ACME)] * ROW_LIMIT))
    assert _days_written(world) == [BEFORE]


@pytest.mark.parametrize('status', ['Failed', 'Cancelled', 'Timeout'])
def test_a_failed_query_writes_nothing_of_its_day(world, status):
    logs, error = _incomplete(world, lambda _query: (status, []))
    assert _days_written(world) == [BEFORE]
    assert YESTERDAY in str(error)
    assert logs.stopped, 'the failed round is stopped'


def test_a_query_still_running_past_the_budget_is_stopped_and_its_day_not_written(world):
    logs, _ = _incomplete(world, lambda _query: ('Running', []), poll_budget=5.0)
    yesterday = [q['queryId'] for q in logs.started if day_of(q) == YESTERDAY]
    assert set(yesterday) <= set(logs.stopped)
    assert _days_written(world) == [BEFORE]


def test_a_count_that_is_not_a_whole_number_fails_its_day(world):
    bad = usage(ACME)
    bad[4] = {'field': 'input_tokens', 'value': '1.5'}
    _incomplete(world, lambda _query: ('Complete', [bad]))
    assert _days_written(world) == [BEFORE]


def test_a_refused_start_fails_the_day_without_the_aws_text(world):
    logs = Logs(GROUPS, by_day({}))
    logs.fail_start = True  # the System logs fake's own switch
    with pytest.raises(RollupIncomplete):
        handle_event({'days': [YESTERDAY]}, world.rollup(logs))
    # The fake's refusal carries the text 'secret detail': only its code reaches the reason.
    with pytest.raises(IncompleteDay, match=r'^the log search failed \(LimitExceededException\)$'):
        query_day(world.rollup(logs), GROUPS, date(2026, 11, 13))


def test_no_round_polls_into_the_invocations_reserve(world):
    logs = Logs(GROUPS, by_day({}))
    with pytest.raises(IncompleteDay, match='out of time'):
        query_day(world.rollup(logs, remaining=lambda: 30.0), GROUPS, date(2026, 11, 13))
    assert logs.started == []
    assert world.rollup(logs, remaining=lambda: 100.0).round_budget() == 40.0


def test_a_deployment_without_the_log_group_pattern_runs_nothing(world, monkeypatch):
    monkeypatch.delenv('SYSTEM_LOG_GROUP_PATTERN')
    logs = Logs(GROUPS, by_day({}))
    with pytest.raises(ConfigurationError):
        handle_event({'days': [YESTERDAY]}, world.rollup(logs))
    assert logs.started == []


def test_a_scheduled_tick_is_the_default():
    assert days_to_roll_up({}, date(2026, 11, 14)) == [date(2026, 11, 13), date(2026, 11, 12)]


def test_a_backfill_takes_days_over_at_most_29_days_back_once_each():
    today = date(2026, 11, 14)
    assert days_to_roll_up({'days': ['2026-10-16', '2026-11-13', '2026-10-16']}, today) == [
        date(2026, 10, 16), date(2026, 11, 13)]
    assert MAX_DAYS_BACK == 29


@pytest.mark.parametrize('days', [[], ['2026-10-15'], ['2026-11-14'], ['2026-11-15'], ['not-a-date'], '2026-11-13',
                                  ['2026-11-13'] * 30])
def test_a_backfill_outside_the_limit_is_refused(days):
    with pytest.raises(ValueError, match=r'days must list|each day must be|Invalid isoformat'):
        days_to_roll_up({'days': days}, date(2026, 11, 14))


def test_the_query_keeps_the_usage_line_of_the_day_and_counts_it_by_workspace_model_and_tier():
    query = day_query(1_763_078_400_000, 1_763_164_800_000)
    assert query.startswith('filter @timestamp >= 1763078400000 and @timestamp < 1763164800000 | filter message = '
                            '"bedrock_usage" and ispresent(model_id) and ispresent(operation) | stats count(*) as calls')
    assert query.endswith(f'by workspace_id, model_id, service_tier | limit {ROW_LIMIT}')
    for name in ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'):
        assert f'sum({name}) as {name}' in query
    hostile: Any = '0 | fields @message'
    with pytest.raises(ValueError, match='invalid literal'):
        day_query(hostile, 1)  # only integers ever reach the string


def _window(query: str) -> tuple[int, int]:
    """The ``[start, end)`` milliseconds of a query's ``@timestamp`` filter."""
    match = re.match(r'filter @timestamp >= (\d+) and @timestamp < (\d+) \|', query)
    assert match is not None
    return int(match.group(1)), int(match.group(2))


def test_the_day_is_exact_to_the_millisecond_at_both_boundaries(world):
    """A fake Insights that applies the query's own @timestamp filter: a line at the day's first millisecond and at its
    last is counted, the millisecond before it and the next day's first are not."""
    start = int(datetime(2026, 11, 13, tzinfo=UTC).timestamp()) * 1000
    lines = {start - 1: 1, start: 10, start + 86_400_000 - 1: 100, start + 86_400_000: 1000}

    def answer(query: dict[str, Any]) -> tuple[str, list]:
        low, high = _window(query['queryString'])
        calls = sum(n for at, n in lines.items() if low <= at < high)
        return 'Complete', [usage(ACME, calls=calls)] if calls else []

    logs = Logs(GROUPS, answer)
    handle_event({'days': [YESTERDAY]}, world.rollup(logs))
    [query] = logs.started
    assert (query['startTime'], query['endTime']) == (start // 1000, start // 1000 + 86400)
    assert [row['totals']['calls'] for row in world.rows(f'WS#{ACME}#COST')] == [110]


class RefusingTable:
    """voc-aggregates whose PutItem of ``day`` AWS refuses (every other call goes to the table)."""

    def __init__(self, table: Any, day: str) -> None:
        self._table, self._day = table, day

    def __getattr__(self, name: str) -> Any:
        return getattr(self._table, name)

    def put_item(self, **kwargs: Any) -> dict:
        if kwargs['Item']['sk'] == self._day:
            raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'detail'}},
                              'PutItem')
        return self._table.put_item(**kwargs)


def test_a_refused_write_fails_its_day_only_and_the_outcome_is_still_logged(world):
    logs = Logs(GROUPS, by_day({YESTERDAY: [usage(ACME)], BEFORE: [usage(ACME)]}))
    rollup = world.rollup(logs, aggregates=RefusingTable(world.aggregates, YESTERDAY))
    with patch.object(handler.logger, 'info') as info, pytest.raises(RollupIncomplete, match=YESTERDAY):
        handle_event({'mode': 'scheduled'}, rollup)
    assert _days_written(world) == [BEFORE]
    [(_line, outcome)] = [(c.args[0], c.kwargs['extra']) for c in info.call_args_list if c.args[0] == 'cost_rollup']
    assert outcome['failed'] == {YESTERDAY: 'AWS refused a call (ProvisionedThroughputExceededException)'}
    assert list(outcome['written']) == [BEFORE]


def test_the_usage_line_powertools_logs_carries_every_field_the_query_reads():
    """shared/usage_meter.py's line through the real Powertools logger and its JSON formatter (its handler's stream
    read, as Lambda ships it to CloudWatch): a top-level ``message`` of ``bedrock_usage``, and every field the query
    filters, sums or groups by, at the top level too."""
    stream = io.StringIO()
    context: dict[str, Any] = {}
    usage_meter.remember_request({'modelId': MODEL}, context)
    with patch.object(usage_meter.logger.registered_handler, 'stream', stream):
        usage_meter.log_usage(http_response=SimpleNamespace(status_code=200, headers={}),
                              parsed={'usage': {'inputTokens': 5, 'outputTokens': 2}},
                              model=SimpleNamespace(name='Converse'), context=context)
    [line] = [json.loads(text) for text in stream.getvalue().splitlines() if 'bedrock_usage' in text]
    assert line['message'] == 'bedrock_usage'
    query = day_query(0, 1)
    read = set(re.findall(r'ispresent\((\w+)\)|sum\((\w+)\)', query)) | {('by', name) for name in
                                                                        ('workspace_id', 'model_id', 'service_tier')}
    fields = {name for pair in read for name in pair if name and name != 'by'}
    assert fields == {'model_id', 'operation', 'input_tokens', 'output_tokens', 'cache_read_tokens',
                      'cache_write_tokens', 'workspace_id', 'service_tier'}
    assert fields <= set(usage_meter.USAGE_FIELDS)
    assert fields <= set(line)
    assert USAGE_FILTER.startswith(f'message = "{usage_meter.USAGE_LINE}"')


def test_the_handler_wires_the_lambdas_remaining_time(world, monkeypatch, lambda_context):
    seen: list[float] = []
    monkeypatch.setattr(handler, '_rollup', lambda remaining: seen.append(remaining()) or world.rollup(
        Logs(GROUPS, by_day({}))))
    lambda_context.get_remaining_time_in_millis = lambda: 900_000
    assert handler.lambda_handler({'days': [YESTERDAY]}, lambda_context)['written'][YESTERDAY]['workspaces'] == 0
    assert seen == [900.0]


def test_a_custom_model_is_priced_from_the_registry_and_the_row_is_complete(monkeypatch):
    """-c customModels (7.65.00): the rollup prices a custom model's tokens with its required registry price."""
    from shared.custom_models import CUSTOM_MODELS_ENV
    from shared.model_prices import PRICE_LIST
    from shared.test.repo_paths import repo_root
    monkeypatch.setenv(CUSTOM_MODELS_ENV, (repo_root() / 'lib' / 'test-support' / 'custom-models-env.json')
                       .read_text(encoding='utf-8'))
    counts = {'calls': 3, 'input_tokens': 1_000_000, 'output_tokens': 1_000_000, 'cache_read_tokens': 0,
              'cache_write_tokens': 0}
    part = handler.priced({('us.meta.llama3-3-70b-instruct-v1:0', 'default'): counts}, PRICE_LIST)
    assert (part['estimated_usd'], part['complete'], part['unpriced_models']) == (Decimal('1.44'), True, [])
