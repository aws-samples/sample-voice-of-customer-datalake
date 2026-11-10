"""``GET /projects?ids=…`` — the Prioritization board's one-call detail read (moto).

Pins: only projects the caller can VIEW come back (missing, deleted and private
ones are simply absent, so nothing leaks existence); access is decided on a
BatchGetItem of META before any partition is read; keys go 100 per request with
UnprocessedKeys retried and a fail-closed 500; the id list is bounded (400).
"""
from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from typing import Any
from unittest.mock import patch

import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

import projects
import projects_handler
from shared import batch_get
from shared.indexes import PROJECTS_BY_TYPE_INDEX

ALICE = {'sub': 'alice-sub', 'cognito:username': 'alice'}
ROOT = {'sub': 'root-sub', 'cognito:username': 'root', 'cognito:groups': 'admins'}
MAX_IDS = projects.MAX_PROJECT_DETAIL_BATCH


@pytest.fixture
def table() -> Iterator[Any]:
    with mock_aws():
        yield pk_sk_table('batch-projects', gsi1_index=PROJECTS_BY_TYPE_INDEX)


def _project(table: Any, project_id: str, *, owner: str = 'bob-sub', visibility: str = 'private',
             **meta: Any) -> None:
    table.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': 'META', 'project_id': project_id,
                         'name': project_id.title(), 'owner_sub': owner, 'visibility': visibility, **meta})
    table.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': f'DOC#doc_{project_id}',
                         'document_id': f'doc_{project_id}', 'document_type': 'prfaq', 'title': 'Pitch',
                         'content': 'x', 'created_at': '2026-01-01T00:00:00+00:00'})
    table.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': 'PERSONA#p1', 'persona_id': 'p1', 'name': 'P'})


@pytest.fixture
def get(table, api_gateway_event, lambda_context) -> Callable[..., tuple[int, dict]]:
    def _get(claims: dict, ids: str) -> tuple[int, dict]:
        event = api_gateway_event(method='GET', path='/projects', query_params={'ids': ids}, claims=claims)
        with patch.object(projects_handler, 'get_projects_table', return_value=table), \
                patch.object(projects, 'projects_table', table):
            response = projects_handler.lambda_handler(event, lambda_context)
        return response['statusCode'], json.loads(response['body'])
    return _get


def _ids(body: dict) -> list[str]:
    return [detail['project']['project_id'] for detail in body['details']]


class TestAccess:
    def test_only_viewable_projects_come_back_in_request_order(self, table, get):
        _project(table, 'mine', owner='alice-sub')
        _project(table, 'shared', visibility='public')
        _project(table, 'private')
        _project(table, 'gone', owner='alice-sub', status='deleted')

        status, body = get(ALICE, 'shared,private,unknown,gone,mine,shared')

        assert status == 200
        assert _ids(body) == ['shared', 'mine']
        detail = body['details'][1]
        assert set(detail) == {'project', 'documents'}  # no personas, no avatar signing
        assert [d['document_id'] for d in detail['documents']] == ['doc_mine']

    def test_a_project_nobody_shared_answers_like_one_that_does_not_exist(self, table, get):
        _project(table, 'private')
        assert get(ALICE, 'private') == get(ALICE, 'nonexistent') == (200, {'details': []})

    def test_an_admin_sees_every_live_project(self, table, get):
        _project(table, 'a')
        _project(table, 'b', owner='alice-sub')
        assert _ids(get(ROOT, 'a,b')[1]) == ['a', 'b']

    def test_no_partition_is_read_for_a_project_the_caller_cannot_view(self, table, get):
        _project(table, 'mine', owner='alice-sub')
        _project(table, 'private')
        real_query = table.query
        queried: list[str] = []

        def spy(**kwargs: Any) -> dict:
            queried.append(kwargs['KeyConditionExpression']._values[1])
            return real_query(**kwargs)

        with patch.object(table, 'query', side_effect=spy):
            assert _ids(get(ALICE, 'private,mine')[1]) == ['mine']
        assert queried == ['PROJECT#mine']


class TestBounds:
    @pytest.mark.parametrize('ids', ['', ' , ', 'a/b', 'p1,../x', ','.join(f'p{i}' for i in range(MAX_IDS + 1))])
    def test_an_empty_malformed_or_oversized_list_is_400(self, get, ids):
        status, body = get(ALICE, ids)
        assert status == 400
        assert body['success'] is False

    def test_the_maximum_number_of_distinct_ids_is_accepted(self, get):
        assert get(ALICE, ','.join(f'p{i}' for i in range(MAX_IDS)))[0] == 200

    def test_duplicates_count_once(self, get):
        assert get(ALICE, ','.join(['p1'] * (MAX_IDS + 1)))[0] == 200


class TestBatchReads:
    def test_meta_is_read_100_keys_per_request(self, table, get):
        real = table.meta.client.batch_get_item
        with patch.object(table.meta.client, 'batch_get_item', side_effect=real) as spy:
            get(ROOT, ','.join(f'p{i:03d}' for i in range(150)))
        sizes = [len(c.kwargs['RequestItems'][table.name]['Keys']) for c in spy.call_args_list]
        assert sizes == [100, 50]

    def test_unprocessed_keys_are_retried(self, table, get):
        _project(table, 'shared', visibility='public')
        real = table.meta.client.batch_get_item
        answers = iter([{'Responses': {table.name: []}}])

        def first_unprocessed(**kwargs: Any) -> dict:
            first = next(answers, None)
            if first is not None:
                return {**first, 'UnprocessedKeys': kwargs['RequestItems']}
            return real(**kwargs)

        with patch.object(table.meta.client, 'batch_get_item', side_effect=first_unprocessed), \
                patch.object(batch_get.time, 'sleep'):
            assert _ids(get(ALICE, 'shared')[1]) == ['shared']

    def test_keys_left_unprocessed_fail_closed(self, table, get):
        _project(table, 'shared', visibility='public')

        def never(**kwargs: Any) -> dict:
            return {'Responses': {}, 'UnprocessedKeys': kwargs['RequestItems']}

        with patch.object(table.meta.client, 'batch_get_item', side_effect=never), \
                patch.object(batch_get.time, 'sleep'):
            status, body = get(ALICE, 'shared')
        assert status == 500
        assert body == {'success': False, 'error': 'Failed to read projects'}


def test_without_ids_the_route_is_still_the_project_list(api_gateway_event, lambda_context):
    event = api_gateway_event(method='GET', path='/projects', claims=ALICE)
    with patch.object(projects_handler, 'list_projects', return_value={'projects': []}) as listing:
        response = projects_handler.lambda_handler(event, lambda_context)
    assert json.loads(response['body']) == {'projects': []}
    listing.assert_called_once()
