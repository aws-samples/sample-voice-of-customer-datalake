"""The metrics and feedback read routes on both paths (docs/multi-workspace.md, "Request flow").

End to end against moto: the same source item stored in the deployment and in two workspaces (one ``feedback_id``,
three partitions), its counters written by the real aggregator in each scope, read back through the real handler.
A request with ``X-Workspace-Id`` reads its workspace's partitions only; a non-member (the deployment's ``admins``
included) and a member of another workspace get the one 404; no header reads the deployment, as before; another
workspace's id is not found; a cursor the deployment issued is refused in a workspace; the response cache never
serves one scope's answer to another.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from decimal import Decimal
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import indexed_table

from aggregator.test.aggregator_fixtures import stream_record
from shared.api import clear_categories_cache
from shared.data_version import BatchBump
from shared.response_cache import DEFAULT_CACHE
from shared.test.clock import today_utc
from shared.workspace_request import RequestWorkspace

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
UNKNOWN = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DA'
MEMBER_A = {'sub': 'sub-ann', 'cognito:groups': 'admins', 'cognito:username': 'ann'}
MEMBER_B = {'sub': 'sub-bo', 'cognito:groups': 'admins', 'cognito:username': 'bo'}
# In the deployment's `admins` group, a member of no workspace: the group grants nothing inside one.
STRANGER = {'sub': 'sub-sam', 'cognito:groups': 'admins', 'cognito:username': 'sam'}


def _review(ws: str | None, fid: str, text: str, *, urgency: str = 'low', category: str = 'delivery',
            minute: int = 0) -> dict[str, Any]:
    """An item as the processor stores it, deployment-wide (``ws`` None) or in a workspace (every partition)."""
    prefix = f'WS#{ws}#' if ws else ''
    day = today_utc()
    at = f'{day}T10:{minute:02d}:00Z'
    return {
        'pk': f'{prefix}SOURCE#web', 'sk': f'FEEDBACK#{fid}', 'feedback_id': fid, 'date': day,
        'source_platform': 'web', 'category': category, 'sentiment_label': 'positive',
        'sentiment_score': Decimal('0.5'), 'urgency': urgency, 'source_channel': 'app', 'original_text': text,
        'persona_type': 'advocate', 'processed_at': at,
        'gsi1pk': f'{prefix}DATE#{day}', 'gsi1sk': f'{at}#{fid}', 'gsi2pk': f'{prefix}CATEGORY#{category}',
        'gsi2sk': f'0.5#{at}', 'gsi3pk': f'{prefix}URGENCY#{urgency}', 'gsi3sk': f'{at}#{fid}',
        'gsi4pk': f'{prefix}FEEDBACK#{fid}', 'gsi5pk': f'{prefix}CHANNEL#app',
    }


ITEMS = [
    # The same source item in all three scopes, each with its own text.
    _review(None, 'f1', 'deployment one', urgency='high'),
    _review(WS_A, 'f1', 'workspace A one', urgency='high'),
    _review(WS_B, 'f1', 'workspace B one', urgency='high'),
    # More of the deployment's (two urgent: a cursor), one more of A's, one only B has.
    _review(None, 'f2', 'deployment two', urgency='high', minute=1),
    _review(None, 'f3', 'deployment three', category='billing', minute=2),
    _review(WS_A, 'f4', 'workspace A four', category='billing', minute=3),
    _review(WS_B, 'only-b', 'workspace B only', minute=4),
]


_table = indexed_table


class _World:
    def __init__(self, feedback: Any, aggregates: Any, workspaces: Any) -> None:
        self.feedback, self.aggregates, self.workspaces = feedback, aggregates, workspaces
        self.platform_admin_confirmed = False
        self.workspace = RequestWorkspace(table=lambda: workspaces,
                                          confirm_platform_admin=lambda _event: self.platform_admin_confirmed)

    def get(self, api_gateway_event, lambda_context, path: str, *, claims: dict, ws: str | None = None,
            query: dict | None = None) -> tuple[dict, Any]:
        headers = {'X-Workspace-Id': ws} if ws is not None else {}
        with patch('metrics_handler.feedback_table', self.feedback), \
                patch('metrics_handler.aggregates_table', self.aggregates), \
                patch('metrics_handler._workspace', self.workspace):
            return call_route(_handler(), api_gateway_event, lambda_context, method='GET', path=path,
                              query_params={'days': '7', **(query or {})}, claims=claims, headers=headers)


def _handler():
    from metrics_handler import lambda_handler

    return lambda_handler


@pytest.fixture
def world() -> Iterator[_World]:
    from aggregator import handler as aggregator

    clear_categories_cache()
    DEFAULT_CACHE.clear()
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        feedback = _table(dynamodb, 'feedback', {
            'gsi1-by-date': ('gsi1pk', 'gsi1sk'), 'gsi2-by-category': ('gsi2pk', 'gsi2sk'),
            'gsi3-by-urgency': ('gsi3pk', 'gsi3sk'), 'gsi4-by-feedback-id': ('gsi4pk', None),
            'gsi5-by-channel': ('gsi5pk', 'gsi1sk')})
        aggregates = _table(dynamodb, 'aggregates', {'gsi1-by-metric-type': ('metric_type', 'pk')})
        workspaces = _table(dynamodb, 'workspaces', {})
        for item in ITEMS:
            feedback.put_item(Item=item)
        with patch.object(aggregator, 'aggregates_table', aggregates), \
                patch.object(aggregator, 'IDEMPOTENCY_TABLE', ''), \
                patch.object(aggregator, '_known_earliest_date', None), \
                patch.object(aggregator, '_known_workspace_earliest', {}), \
                patch.object(aggregator, 'data_changed', BatchBump(aggregator.bump_data_version)):
            for item in ITEMS:
                aggregator.record_handler(stream_record('INSERT', new=item))
        for ws, member in ((WS_A, MEMBER_A), (WS_B, MEMBER_B)):
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'status': 'active', 'name': ws, 'slug': ws[-6:]})
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': f"MEMBER#{member['sub']}", 'role': 'viewer'})
        yield _World(feedback, aggregates, workspaces)
    DEFAULT_CACHE.clear()
    clear_categories_cache()


class TestOneItemById:
    def test_each_scope_reads_its_own_copy(self, world, api_gateway_event, lambda_context):
        texts = {}
        for ws, claims in ((None, STRANGER), (WS_A, MEMBER_A), (WS_B, MEMBER_B)):
            response, body = world.get(api_gateway_event, lambda_context, '/feedback/f1', claims=claims, ws=ws)
            assert response['statusCode'] == 200, body
            texts[ws] = body['original_text']
        assert texts == {None: 'deployment one', WS_A: 'workspace A one', WS_B: 'workspace B one'}

    def test_another_workspaces_id_is_not_found(self, world, api_gateway_event, lambda_context):
        response, body = world.get(api_gateway_event, lambda_context, '/feedback/only-b', claims=MEMBER_A, ws=WS_A)

        assert response['statusCode'] == 404
        assert body['message'] == 'Feedback only-b not found'  # the route's own 404 (Powertools' body shape)
        response, _ = world.get(api_gateway_event, lambda_context, '/feedback/only-b', claims=STRANGER)
        assert response['statusCode'] == 404  # nor does the deployment see a workspace's item

    @pytest.mark.parametrize(('claims', 'ws'), [(STRANGER, WS_A), (MEMBER_B, WS_A), (MEMBER_A, UNKNOWN),
                                                (MEMBER_A, 'not-a-workspace')])
    def test_a_non_member_gets_the_one_404(self, world, api_gateway_event, lambda_context, claims, ws):
        for path in ('/feedback/f1', '/metrics/summary', '/feedback'):
            response, body = world.get(api_gateway_event, lambda_context, path, claims=claims, ws=ws)
            assert (response['statusCode'], body['error']) == (404, 'Workspace not found'), path

    def test_an_empty_header_is_refused_never_read_deployment_wide(self, world, api_gateway_event, lambda_context):
        response, body = world.get(api_gateway_event, lambda_context, '/metrics/summary', claims=MEMBER_A, ws='')

        assert response['statusCode'] == 400
        assert 'X-Workspace-Id' in body['error']


class TestListsAndMetrics:
    def test_the_list_is_the_workspaces(self, world, api_gateway_event, lambda_context):
        lists = {}
        for ws, claims in ((None, STRANGER), (WS_A, MEMBER_A), (WS_B, MEMBER_B)):
            _, body = world.get(api_gateway_event, lambda_context, '/feedback', claims=claims, ws=ws)
            lists[ws] = sorted(item['original_text'] for item in body['items'])
        assert lists == {
            None: ['deployment one', 'deployment three', 'deployment two'],
            WS_A: ['workspace A four', 'workspace A one'],
            WS_B: ['workspace B one', 'workspace B only'],
        }

    def test_a_category_list_reads_the_workspaces_category_partition(self, world, api_gateway_event, lambda_context):
        _, body = world.get(api_gateway_event, lambda_context, '/feedback', claims=MEMBER_A, ws=WS_A,
                            query={'category': 'billing'})

        assert [item['original_text'] for item in body['items']] == ['workspace A four']

    def test_a_channel_list_reads_the_workspaces_channel_partition(self, world, api_gateway_event, lambda_context):
        _, body = world.get(api_gateway_event, lambda_context, '/feedback', claims=MEMBER_B, ws=WS_B,
                            query={'channel': 'app'})

        assert sorted(item['original_text'] for item in body['items']) == ['workspace B one', 'workspace B only']

    def test_the_summary_counts_the_workspaces_counters(self, world, api_gateway_event, lambda_context):
        totals = {}
        for ws, claims in ((None, STRANGER), (WS_A, MEMBER_A), (WS_B, MEMBER_B)):
            response, body = world.get(api_gateway_event, lambda_context, '/metrics/summary', claims=claims, ws=ws)
            assert response['statusCode'] == 200, body
            totals[ws] = (body['total_feedback'], body['urgent_count'])
        assert totals == {None: (3, 2), WS_A: (2, 1), WS_B: (2, 1)}

    def test_the_breakdowns_read_the_workspaces_metric_types(self, world, api_gateway_event, lambda_context):
        _, sources = world.get(api_gateway_event, lambda_context, '/metrics/sources', claims=MEMBER_A, ws=WS_A)
        _, categories = world.get(api_gateway_event, lambda_context, '/metrics/categories', claims=MEMBER_A, ws=WS_A)
        _, personas = world.get(api_gateway_event, lambda_context, '/metrics/personas', claims=MEMBER_A, ws=WS_A)

        assert sources['sources'] == {'web': 2}
        assert {name: n for name, n in categories['categories'].items() if n} == {'delivery': 1, 'billing': 1}
        assert personas['personas'] == {'advocate': 2}

    def test_the_urgent_list_and_similar_items_are_the_workspaces(self, world, api_gateway_event, lambda_context):
        _, urgent = world.get(api_gateway_event, lambda_context, '/feedback/urgent', claims=MEMBER_B, ws=WS_B)
        _, similar = world.get(api_gateway_event, lambda_context, '/feedback/f1/similar', claims=MEMBER_B, ws=WS_B)

        assert [item['original_text'] for item in urgent['items']] == ['workspace B one']
        assert all(item['pk'].startswith(f'WS#{WS_B}#') for item in similar['items'])


class TestCursorsAndCache:
    def test_a_deployment_cursor_is_refused_in_a_workspace(self, world, api_gateway_event, lambda_context):
        _, first = world.get(api_gateway_event, lambda_context, '/feedback/urgent', claims=STRANGER,
                             query={'limit': '1'})
        assert first['next_token']

        response, body = world.get(api_gateway_event, lambda_context, '/feedback/urgent', claims=MEMBER_A, ws=WS_A,
                                   query={'limit': '1', 'next_token': first['next_token']})

        assert response['statusCode'] == 400
        assert body['error'] == 'next_token is not valid'

    def test_a_cursor_naming_another_workspaces_item_is_refused(self, world, api_gateway_event, lambda_context):
        from shared.feedback_cursor import encode_key_cursor

        forged = encode_key_cursor({'pk': f'WS#{WS_B}#SOURCE#web', 'sk': 'FEEDBACK#f1',
                                    'gsi3pk': f'WS#{WS_A}#URGENCY#high', 'gsi3sk': f'{today_utc()}T10:00:00Z#f1'})
        response, body = world.get(api_gateway_event, lambda_context, '/feedback/urgent', claims=MEMBER_A, ws=WS_A,
                                   query={'next_token': forged})

        assert (response['statusCode'], body['error']) == (400, 'next_token is not valid')

    def test_the_response_cache_never_crosses_scopes(self, world, api_gateway_event, lambda_context):
        """The same path and query, asked deployment-wide, then in A, then in B, then again: each answer is its
        scope's, and a repeat in A is served from the memo (no feedback read) with A's answer."""
        seen = []
        for ws, claims in ((None, STRANGER), (WS_A, MEMBER_A), (WS_B, MEMBER_B)):
            _, body = world.get(api_gateway_event, lambda_context, '/metrics/summary', claims=claims, ws=ws)
            seen.append(body['total_feedback'])
        assert seen == [3, 2, 2]
        assert len(DEFAULT_CACHE) == 3  # one entry per scope

        # Served from the memo: any feedback or counter read now fails the request (the versions read still runs).
        read = AssertionError('the repeat was not served from the memo')
        with patch.object(world.feedback, 'query', side_effect=read), \
                patch.object(world.aggregates, 'query', side_effect=read):
            response, again = world.get(api_gateway_event, lambda_context, '/metrics/summary', claims=MEMBER_A,
                                        ws=WS_A)
        assert response['statusCode'] == 200
        assert again['total_feedback'] == 2
        assert len(DEFAULT_CACHE) == 3

    def test_the_versions_read_is_the_workspaces(self, world, api_gateway_event, lambda_context):
        """A workspace's data_version moves its cache only: a bump in A leaves B's and the deployment's entries."""
        world.aggregates.put_item(Item={'pk': f'WS#{WS_A}#METRIC#meta', 'sk': 'data_version', 'v': 1})
        for ws, claims in ((None, STRANGER), (WS_A, MEMBER_A), (WS_B, MEMBER_B)):
            world.get(api_gateway_event, lambda_context, '/metrics/sources', claims=claims, ws=ws)
        entries = len(DEFAULT_CACHE)
        world.aggregates.put_item(Item={'pk': f'WS#{WS_A}#METRIC#meta', 'sk': 'data_version', 'v': 2})

        for ws, claims in ((None, STRANGER), (WS_B, MEMBER_B)):
            world.get(api_gateway_event, lambda_context, '/metrics/sources', claims=claims, ws=ws)
        assert len(DEFAULT_CACHE) == entries  # served from their entries
        world.get(api_gateway_event, lambda_context, '/metrics/sources', claims=MEMBER_A, ws=WS_A)
        assert len(DEFAULT_CACHE) == entries + 1  # A's new version is a new entry


@pytest.mark.parametrize('path', ['/feedback/f1', '/metrics/summary', '/feedback'])
def test_the_header_check_runs_before_any_read(world, api_gateway_event, lambda_context, path):
    """A non-member's request reads no feedback and no counter (no Query, GetItem or BatchGetItem, the versions
    read included): the workspace is resolved first."""
    read = AssertionError('read before the membership check')
    with patch.object(world.feedback, 'query', side_effect=read), \
            patch.object(world.feedback, 'get_item', side_effect=read), \
            patch.object(world.feedback.meta.client, 'batch_get_item', side_effect=read), \
            patch.object(world.aggregates, 'query', side_effect=read), \
            patch.object(world.aggregates, 'get_item', side_effect=read), \
            patch.object(world.aggregates.meta.client, 'batch_get_item', side_effect=read):
        response, body = world.get(api_gateway_event, lambda_context, path, claims=STRANGER, ws=WS_A)

    assert (response['statusCode'], body) == (404, {'success': False, 'error': 'Workspace not found'})


def test_a_value_left_on_the_context_never_stands_in_for_the_requests_workspace(world, api_gateway_event,
                                                                                 lambda_context):
    """A helper called outside a request (a warm container's earlier call, a test) may leave the context with no
    workspace; the next request still resolves its own header: the one 404, never a deployment-wide read."""
    import metrics_handler

    metrics_handler.app.append_context(**{metrics_handler.WORKSPACE_CONTEXT_KEY: None})
    try:
        response, body = world.get(api_gateway_event, lambda_context, '/feedback/f1', claims=STRANGER,
                                   ws='not-a-workspace')
    finally:
        metrics_handler.app.context.pop(metrics_handler.WORKSPACE_CONTEXT_KEY, None)

    assert (response['statusCode'], body) == (404, {'success': False, 'error': 'Workspace not found'})


def test_a_helper_reached_without_the_middleware_fails_closed(world, api_gateway_event, lambda_context):
    """After a request in workspace A, Powertools still holds that request's event; a data helper reached outside a
    request must neither resolve that earlier header nor read deployment-wide: it raises (a 500), reading nothing."""
    import metrics_handler

    response, _ = world.get(api_gateway_event, lambda_context, '/feedback/f1', claims=MEMBER_A, ws=WS_A)
    assert response['statusCode'] == 200
    assert metrics_handler.WORKSPACE_CONTEXT_KEY not in metrics_handler.app.context  # cleared after the resolve

    read = AssertionError('read without a resolved workspace')
    with patch.object(world.feedback, 'query', side_effect=read), patch('metrics_handler.feedback_table', world.feedback):
        with pytest.raises(metrics_handler.WorkspaceNotResolved) as raised:
            metrics_handler._feedback_by_id('f1')
        with pytest.raises(metrics_handler.WorkspaceNotResolved):
            metrics_handler._ws_scope()
    assert (raised.value.status_code, raised.value.message) == (500, metrics_handler.WORKSPACE_NOT_RESOLVED)


#: Every route of the metrics API (lambda/api/test/test_route_admin_gates.py WORKSPACE_SCOPED), with the query it
#: needs to read something.
ROUTE_QUERIES: dict[str, dict[str, str]] = {
    '/feedback': {}, '/feedback/urgent': {}, '/feedback/entities': {}, '/feedback/search': {'q': 'one'},
    '/feedback/problems': {}, '/feedback/access': {}, '/feedback/catalogue': {}, '/feedback/f1': {},
    '/feedback/f1/similar': {}, '/metrics/summary': {}, '/metrics/sentiment': {}, '/metrics/categories': {},
    '/metrics/sources': {}, '/metrics/personas': {}, '/metrics/dimensions': {'key': 'feedback_type'},
    '/metrics/data-quality': {}, '/metrics/github': {}, '/metrics/release-watch': {'launched_at': today_utc()},
}
#: What the deployment's and workspace B's copies carry, and A's never: their text and their partitions.
FOREIGN = ('deployment one', 'deployment two', 'deployment three', 'workspace B', f'WS#{WS_B}#', '"SOURCE#web"',
           '"DATE#', '"CATEGORY#', '"URGENCY#', '"gsi4pk": "FEEDBACK#')


def test_every_route_is_in_the_inventory():
    from test_route_admin_gates import WORKSPACE_SCOPED

    inventory = {route.split(' ', 1)[1].replace('<feedback_id>', 'f1') for route in WORKSPACE_SCOPED['metrics_handler.py']}
    assert inventory == set(ROUTE_QUERIES)


@pytest.mark.parametrize('path', sorted(ROUTE_QUERIES))
def test_every_route_answers_only_the_workspaces_data(world, api_gateway_event, lambda_context, path):
    response, body = world.get(api_gateway_event, lambda_context, path, claims=MEMBER_A, ws=WS_A,
                               query=ROUTE_QUERIES[path])

    assert response['statusCode'] == 200, body
    text = json.dumps(body, default=str)
    assert [mark for mark in FOREIGN if mark in text] == [], path


@pytest.mark.parametrize('path', ['/feedback', '/feedback/search', '/feedback/urgent', '/feedback/f1'])
def test_the_lists_carry_the_workspaces_items(world, api_gateway_event, lambda_context, path):
    _, body = world.get(api_gateway_event, lambda_context, path, claims=MEMBER_A, ws=WS_A, query=ROUTE_QUERIES[path])

    items = body.get('items', [body])
    assert items, path
    assert all(item['pk'].startswith(f'WS#{WS_A}#') for item in items), path


PLATFORM_ADMIN = {'sub': 'sub-pat', 'cognito:groups': 'admins,platform-admins', 'cognito:username': 'pat'}


class TestAPlatformAdminEntry:

    def _entries(self, world) -> list[dict]:
        return world.workspaces.query(KeyConditionExpression='pk = :pk',
                                      ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS_A}'})['Items']

    def test_a_confirmed_platform_admin_reads_as_admin_and_the_entry_is_audited(self, world, api_gateway_event,
                                                                               lambda_context):
        world.platform_admin_confirmed = True
        for path in ('/feedback/f1', '/metrics/summary'):
            response, body = world.get(api_gateway_event, lambda_context, path, claims=PLATFORM_ADMIN, ws=WS_A)
            assert response['statusCode'] == 200, body
        assert body['total_feedback'] == 2
        assert [(row['kind'], row['actor']) for row in self._entries(world)] == [('platform_admin_entry', 'sub-pat')]

    def test_an_unconfirmed_one_gets_the_one_404_and_writes_nothing(self, world, api_gateway_event, lambda_context):
        world.platform_admin_confirmed = False
        response, body = world.get(api_gateway_event, lambda_context, '/feedback/f1', claims=PLATFORM_ADMIN,
                                   ws=WS_A)

        assert (response['statusCode'], body) == (404, {'success': False, 'error': 'Workspace not found'})
        assert self._entries(world) == []
