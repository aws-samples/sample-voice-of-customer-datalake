"""GET /platform/costs (workspaces_handler.py, shared/platform_costs.py): the cost estimate per workspace, read from the
rows of lambda/jobs/cost_rollup/ (moto-backed; docs/multi-workspace.md, "Cost per workspace")."""
from collections.abc import Iterator
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

import workspaces_handler
from shared import platform_admin_gate, platform_costs
from shared.exceptions import ValidationError
from shared.platform_costs import (
    DEPLOYMENT_COST_PARTITION,
    ESTIMATE_LABEL,
    UNATTRIBUTED_COST_PARTITION,
    CostRange,
    deployment_rows,
    parse_cost_limit,
    parse_range,
    summary,
)
from shared.test.cognito_doubles import live_cognito
from shared.workspace import MembershipCache

PAT = {'sub': 'sub-pat', 'cognito:username': 'pat', 'cognito:groups': '[admins, platform-admins]'}
ADA = {'sub': 'sub-ada', 'cognito:username': 'ada', 'cognito:groups': 'admins'}
MODEL = 'global.example.fictional-model'
#: The handler's today (``_utc_today``, patched).
TODAY = date(2026, 11, 14)


@dataclass
class World:
    workspaces: Any
    aggregates: Any
    cognito: MagicMock


@pytest.fixture
def world() -> Iterator[World]:
    with ExitStack() as stack:
        stack.enter_context(mock_aws())
        state = World(pk_sk_table('workspaces'), pk_sk_table('aggregates'), live_cognito())
        # The live platform-admin check reads the pool through both modules' Cognito client.
        for module in (workspaces_handler, platform_admin_gate):
            stack.enter_context(patch.object(module, 'get_cognito_idp_client', side_effect=lambda: state.cognito))
        stack.enter_context(patch.multiple(workspaces_handler, memberships=MembershipCache(),
                                           USER_POOL_ID='us-east-1_pool', _utc_today=lambda: TODAY))
        stack.enter_context(patch.dict('os.environ', {'USER_POOL_ID': 'us-east-1_pool'}))
        yield state


def _call(world, lambda_context, method, path, claims=PAT, body=None, query=None):
    event = rest_event(method, path, claims=claims, body=body)
    event['queryStringParameters'] = query
    return invoke(workspaces_handler, event, lambda_context, workspaces=world.workspaces, cost=world.aggregates)


def _create(world, lambda_context, name: str, slug: str) -> str:
    status, body = _call(world, lambda_context, 'POST', '/platform/workspaces', body={'name': name, 'slug': slug})
    assert status == 201
    return body['workspace']['id']


def _row(pk: str, day: date, *, calls: int = 1, usd: str | None = None, **extra: Any) -> dict[str, Any]:
    totals = {'calls': calls, 'input_tokens': 100 * calls, 'output_tokens': 10 * calls, 'cache_read_tokens': 0,
              'cache_write_tokens': 0}
    cost = None if usd is None else Decimal(usd)
    return {'pk': pk, 'sk': day.isoformat(), 'schema': 1, 'totals': totals, 'estimated_usd': cost,
            'complete': cost is not None, 'unpriced_models': [] if cost is not None else [MODEL],
            'by_model': [{'model_id': MODEL, 'service_tier': 'default', **totals, 'estimated_usd': cost}],
            'price_as_of': '2026-11-14', 'rolled_up_at': f'{day.isoformat()}T02:15:00+00:00', **extra}


def _range(days_back: int) -> dict[str, str]:
    return {'from': (TODAY - timedelta(days=days_back)).isoformat(), 'to': TODAY.isoformat()}


def test_a_platform_admin_reads_every_workspaces_estimate_and_the_deployments_on_the_first_page(world, lambda_context):
    acme = _create(world, lambda_context, 'Acme Outfitters', 'acme')
    birch = _create(world, lambda_context, 'Birch Bakery', 'birch')
    yesterday = TODAY - timedelta(days=1)
    world.aggregates.put_item(Item=_row(f'WS#{acme}#COST', yesterday, calls=3, usd='0.25'))
    world.aggregates.put_item(Item=_row(f'WS#{acme}#COST', TODAY - timedelta(days=2), calls=1, usd='0.5'))
    world.aggregates.put_item(Item=_row(f'WS#{acme}#COST', TODAY - timedelta(days=40), calls=9))  # outside the range
    world.aggregates.put_item(Item=_row(DEPLOYMENT_COST_PARTITION, yesterday, calls=2, deleted_workspaces={
        'workspaces': 1, 'totals': {'calls': 5}, 'estimated_usd': None, 'complete': False,
        'unpriced_models': [MODEL]}))
    world.aggregates.put_item(Item=_row(UNATTRIBUTED_COST_PARTITION, yesterday, calls=4))

    status, body = _call(world, lambda_context, 'GET', '/platform/costs', query=_range(6))

    assert status == 200
    assert {key: body[key] for key in ('estimate', 'label', 'currency', 'price_as_of', 'next_cursor')} == {
        'estimate': True, 'label': ESTIMATE_LABEL, 'currency': 'USD', 'price_as_of': '2026-11-14',
        'next_cursor': None}
    by_id = {entry['id']: entry for entry in body['workspaces']}
    assert sorted(by_id) == sorted([acme, birch])
    assert (by_id[acme]['name'], by_id[acme]['slug'], by_id[acme]['status']) == ('Acme Outfitters', 'acme', 'active')
    assert [day['date'] for day in by_id[acme]['days']] == [(TODAY - timedelta(days=n)).isoformat() for n in (2, 1)]
    total = by_id[acme]['total']
    assert (total['calls'], total['estimated_usd'], total['complete']) == (4, '0.750000', True)
    assert total['by_model'][0]['model_id'] == MODEL
    assert (by_id[birch]['days'], by_id[birch]['total']['estimated_usd']) == ([], '0.000000')
    assert body['deployment']['total']['calls'] == 2
    assert body['deployment']['deleted_workspaces']['calls'] == 5
    assert body['unattributed']['total'] == {**body['unattributed']['total'], 'calls': 4, 'estimated_usd': None,
                                             'complete': False, 'unpriced_models': [MODEL]}


def test_the_workspaces_are_paged_and_only_the_first_page_carries_the_deployment(world, lambda_context):
    for name, slug in (('Acme Outfitters', 'acme'), ('Birch Bakery', 'birch')):
        _create(world, lambda_context, name, slug)
    status, first = _call(world, lambda_context, 'GET', '/platform/costs', query={'limit': '1'})
    assert status == 200
    assert len(first['workspaces']) == 1
    assert first['next_cursor']
    status, second = _call(world, lambda_context, 'GET', '/platform/costs',
                           query={'limit': '1', 'cursor': first['next_cursor']})
    assert status == 200
    assert second['workspaces'][0]['id'] != first['workspaces'][0]['id']
    assert ('deployment' in first, 'deployment' in second, 'unattributed' in second) == (True, False, False)


def test_each_read_is_logged_with_the_caller_and_the_range(world, lambda_context):
    with patch.object(workspaces_handler.logger, 'info') as info:
        assert _call(world, lambda_context, 'GET', '/platform/costs', query=_range(3))[0] == 200
    info.assert_any_call('platform_costs_read', extra={
        'caller_sub': 'sub-pat', 'from': (TODAY - timedelta(days=3)).isoformat(), 'to': TODAY.isoformat()})


@pytest.mark.parametrize('query', [
    {'to': (TODAY + timedelta(days=1)).isoformat()},
    {'from': TODAY.isoformat(), 'to': (TODAY - timedelta(days=1)).isoformat()},
    _range(92),
    {'from': 'last-week'},
    {'limit': '26'}, {'limit': '0'}, {'limit': 'ten'},
    {'cursor': 'not-a-cursor'},
])
def test_a_bad_range_limit_or_cursor_is_a_400(world, lambda_context, query):
    assert _call(world, lambda_context, 'GET', '/platform/costs', query=query)[0] == 400


def test_an_administrator_who_is_not_a_platform_admin_gets_403_and_reads_nothing(world, lambda_context):
    with patch.object(platform_costs, 'list_workspaces') as listed:
        assert _call(world, lambda_context, 'GET', '/platform/costs', claims=ADA)[0] == 403
    listed.assert_not_called()


def test_a_revoked_platform_admin_gets_403_by_the_live_check(world, lambda_context):
    world.cognito = live_cognito(('admins',))
    assert _call(world, lambda_context, 'GET', '/platform/costs')[0] == 403


def test_the_range_defaults_to_this_month_and_holds_at_most_92_days():
    assert parse_range({}, date(2026, 11, 14)) == CostRange(date(2026, 11, 1), date(2026, 11, 14))
    assert parse_range({'from': '2026-08-15', 'to': '2026-11-14'}, date(2026, 11, 14)).days() == 92
    with pytest.raises(ValidationError):
        parse_range({'from': '2026-08-14', 'to': '2026-11-14'}, date(2026, 11, 14))
    assert [parse_cost_limit(raw) for raw in (None, '', '1', '25')] == [20, 20, 1, 25]


def test_the_answer_holds_days_and_a_total_and_no_month_sums():
    entry = summary([_row('X', date(2026, 11, 2), usd='1')])
    assert sorted(entry) == ['days', 'total']


def test_a_partly_priced_range_sums_its_priced_part_and_says_it_is_incomplete():
    rows = [_row('X', date(2026, 11, 1), usd='0.1'), _row('X', date(2026, 11, 2))]
    total = summary(rows)['total']
    assert (total['estimated_usd'], total['complete'], total['unpriced_models']) == ('0.100000', False, [MODEL])


def test_a_complete_total_with_no_calls_is_a_known_zero_and_an_unpriced_one_is_unknown():
    assert summary([])['total']['estimated_usd'] == '0.000000'
    zero = {**_row('X', date(2026, 11, 1), calls=0), 'estimated_usd': None, 'complete': True, 'unpriced_models': [],
            'by_model': []}
    assert [day['estimated_usd'] for day in summary([zero])['days']] == ['0.000000']
    assert summary([_row('X', date(2026, 11, 1))])['total']['estimated_usd'] is None


def test_only_a_bad_cursor_is_a_400_and_any_other_fault_is_not(world, lambda_context):
    _create(world, lambda_context, 'Acme Outfitters', 'acme')
    refused = ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'detail'}}, 'Query')
    with patch.object(platform_costs, 'workspace_rows', side_effect=refused):
        status, body = _call(world, lambda_context, 'GET', '/platform/costs')
    assert (status, body['error']) == (500, 'Failed to read the costs')
    # A ValueError past the cursor's decode is a fault of ours, never answered as the client's 400.
    with patch.object(platform_costs, 'workspace_rows', side_effect=ValueError('a fault')), \
            pytest.raises(ValueError, match='a fault'):
        _call(world, lambda_context, 'GET', '/platform/costs')


def test_a_range_read_is_bounded_and_refuses_a_workspace_partition():
    """At most a row a day of the range: a partition that kept answering more pages is read no further."""
    table = MagicMock()
    table.query.return_value = {'Items': [{'sk': '2026-11-01'}],
                                'LastEvaluatedKey': {'pk': DEPLOYMENT_COST_PARTITION, 'sk': '2026-11-01'}}
    rows = deployment_rows(table, DEPLOYMENT_COST_PARTITION, CostRange(date(2026, 11, 1), date(2026, 11, 2)))
    assert (len(rows), table.query.call_count) == (2, 2)
    with pytest.raises(ValueError, match='not a deployment cost partition'):
        deployment_rows(table, 'WS#ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8#COST', CostRange(date(2026, 11, 1), date(2026, 11, 2)))
