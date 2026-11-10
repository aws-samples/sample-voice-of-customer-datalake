"""The metrics Lambda answers its static `/feedback/<name>` reads when API Gateway delivers them through
`GET /feedback/{id}` (5.47.00 route consolidation, lib/stacks/api-routes.ts).

API Gateway now has no `/feedback/access` resource: the request arrives with `resource: /feedback/{id}` and
`pathParameters: {id: 'access'}`. The handler routes by PATH and Powertools matches static routes before
`/feedback/<feedback_id>`, so the answer must be the access scope, never an item lookup for id `access`.
"""
from unittest.mock import MagicMock, patch

import pytest
from category_access_fixtures import aggregates_with
from handler_events_fixtures import call_route

from metrics_handler import lambda_handler
from shared.api import clear_categories_cache


@pytest.fixture(autouse=True)
def _fresh_categories_cache():
    clear_categories_cache()
    yield
    clear_categories_cache()


def _through_item_resource(api_gateway_event, lambda_context, name: str):
    feedback = MagicMock()
    feedback.query.return_value = {'Items': []}
    with patch('metrics_handler.feedback_table', feedback), \
            patch('metrics_handler.aggregates_table', aggregates_with()):
        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context, method='GET', path=f'/feedback/{name}',
            resource='/feedback/{id}', path_params={'id': name}, query_params={'days': '1'})
    return response, body, feedback


def test_access_through_the_item_resource_answers_the_access_scope(api_gateway_event, lambda_context):
    response, body, feedback = _through_item_resource(api_gateway_event, lambda_context, 'access')
    assert response['statusCode'] == 200
    assert body['all'] is True
    assert 'source_rule' in body
    # No item lookup for a review whose id is "access".
    feedback.get_item.assert_not_called()


def test_urgent_through_the_item_resource_answers_the_urgent_list(api_gateway_event, lambda_context):
    response, body, feedback = _through_item_resource(api_gateway_event, lambda_context, 'urgent')
    assert response['statusCode'] == 200
    assert 'items' in body
    feedback.get_item.assert_not_called()
