"""`GET /feedback/catalogue` (TENETS.md D7): what every stored attribute of a feedback item means.

API Gateway delivers it through `GET /feedback/{id}` (lib/stacks/api-routes.ts): the static route must win
over an item lookup for id `catalogue`, read no table, answer the same to every signed-in user and carry
an ETag like every metrics GET.
"""
from unittest.mock import MagicMock, patch

from handler_events_fixtures import call_route

from metrics_handler import lambda_handler
from shared.feedback_catalogue import catalogue


def _get(api_gateway_event, lambda_context):
    feedback, aggregates = MagicMock(), MagicMock()
    with patch('metrics_handler.feedback_table', feedback), patch('metrics_handler.aggregates_table', aggregates):
        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context, method='GET', path='/feedback/catalogue',
            resource='/feedback/{id}', path_params={'id': 'catalogue'})
    return response, body, feedback, aggregates


def test_it_answers_the_catalogue_without_reading_a_table(api_gateway_event, lambda_context):
    response, body, feedback, aggregates = _get(api_gateway_event, lambda_context)
    assert response['statusCode'] == 200
    assert body == catalogue()
    assert body['table'] == 'voc-feedback'
    assert feedback.method_calls == aggregates.method_calls == []


def test_the_answer_is_revalidated_by_etag(api_gateway_event, lambda_context):
    response, _body, _feedback, _aggregates = _get(api_gateway_event, lambda_context)
    headers = response.get('multiValueHeaders') or {}
    assert headers.get('ETag', [''])[0].startswith('W/"')
    assert headers.get('Cache-Control') == ['private, no-cache']
