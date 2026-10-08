"""GET /feedback-forms?include=stats — every card's stats in the list (E2E F11).

The Feedback Forms page asked `/feedback-forms/{id}/stats` once per card, and
each of those paged the whole brand partition. The list now carries a `stats`
map computed by reading each distinct partition once.
"""
from unittest.mock import patch

import boto3
import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

from shared.test.moto_tables import create_pk_sk_table

FORMS = (
    {'form_id': 'form_a', 'brand_name': 'Acme', 'created_at': '2026-01-04'},
    {'form_id': 'form_b', 'brand_name': 'Acme', 'created_at': '2026-01-03'},
    {'form_id': 'form_c', 'brand_name': 'Beta', 'created_at': '2026-01-02'},
    {'form_id': 'form_d', 'brand_name': 'Acme', 'created_at': '2026-01-01'},
)
FEEDBACK = (
    {'pk': 'SOURCE#Acme', 'sk': 'FEEDBACK#1', 'feedback_id': '1', 'source_channel': 'form_form_a', 'rating': 5},
    {'pk': 'SOURCE#Acme', 'sk': 'FEEDBACK#2', 'feedback_id': '2', 'source_channel': 'form_form_a', 'rating': 3},
    {'pk': 'SOURCE#Acme', 'sk': 'FEEDBACK#3', 'feedback_id': '3', 'source_channel': 'form_form_b'},
    # Same partition, not a form submission: must not be counted for anyone.
    {'pk': 'SOURCE#Acme', 'sk': 'FEEDBACK#4', 'feedback_id': '4', 'source_channel': 'webscraper', 'rating': 1},
    {'pk': 'SOURCE#Beta', 'sk': 'FEEDBACK#5', 'feedback_id': '5', 'source_channel': 'form_form_c', 'rating': 4},
)


@pytest.fixture
def tables(feedback_form_handler):
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        aggregates = create_pk_sk_table('test-aggregates', resource)
        feedback = create_pk_sk_table('test-feedback', resource)
        for form in FORMS:
            aggregates.put_item(Item={'pk': 'FEEDBACK_FORM', 'sk': f"FORM#{form['form_id']}", **form})
        for row in FEEDBACK:
            feedback.put_item(Item=row)
        with patch.object(feedback_form_handler, 'aggregates_table', aggregates), \
                patch.object(feedback_form_handler, 'feedback_table', feedback):
            yield aggregates, feedback


def _list(feedback_form_handler, api_gateway_event, lambda_context, query_params=None):
    return call_route(
        feedback_form_handler.lambda_handler, api_gateway_event, lambda_context,
        method='GET', path='/feedback-forms', query_params=query_params,
    )


@pytest.mark.usefixtures('tables')
def test_every_form_gets_the_single_form_routes_numbers(
    feedback_form_handler, api_gateway_event, lambda_context,
):
    response, body = _list(feedback_form_handler, api_gateway_event, lambda_context, {'include': 'stats'})

    assert response['statusCode'] == 200
    assert [f['form_id'] for f in body['forms']] == ['form_a', 'form_b', 'form_c', 'form_d']
    assert body['stats'] == {
        'form_a': {'total_submissions': 2, 'avg_rating': 4.0, 'rating_count': 2},
        'form_b': {'total_submissions': 1, 'avg_rating': None, 'rating_count': 0},
        'form_c': {'total_submissions': 1, 'avg_rating': 4.0, 'rating_count': 1},
        'form_d': {'total_submissions': 0, 'avg_rating': None, 'rating_count': 0},
    }


@pytest.mark.usefixtures('tables')
def test_the_batch_agrees_with_the_per_form_route(
    feedback_form_handler, api_gateway_event, lambda_context,
):
    _, listed = _list(feedback_form_handler, api_gateway_event, lambda_context, {'include': 'stats'})
    for form in FORMS:
        _, single = call_route(
            feedback_form_handler.lambda_handler, api_gateway_event, lambda_context,
            method='GET', path=f"/feedback-forms/{form['form_id']}/stats",
            path_params={'form_id': form['form_id']},
        )
        assert listed['stats'][form['form_id']] == single['stats']


def test_each_partition_is_read_once_however_many_forms_share_it(
    feedback_form_handler, tables, api_gateway_event, lambda_context,
):
    _, feedback = tables
    with patch.object(feedback, 'query', wraps=feedback.query) as query:
        _list(feedback_form_handler, api_gateway_event, lambda_context, {'include': 'stats'})

    partitions = sorted(call.kwargs['KeyConditionExpression'].get_expression()['values'][1]
                        for call in query.call_args_list)
    assert partitions == ['SOURCE#Acme', 'SOURCE#Beta']


@pytest.mark.usefixtures('tables')
def test_without_include_the_list_is_unchanged(
    feedback_form_handler, api_gateway_event, lambda_context,
):
    _, body = _list(feedback_form_handler, api_gateway_event, lambda_context)

    assert 'stats' not in body
    assert len(body['forms']) == 4


def test_a_failed_stats_read_keeps_the_list_and_says_so(
    feedback_form_handler, tables, api_gateway_event, lambda_context,
):
    _, feedback = tables
    with patch.object(feedback, 'query', side_effect=RuntimeError('throttled')):
        response, body = _list(feedback_form_handler, api_gateway_event, lambda_context, {'include': 'stats'})

    assert response['statusCode'] == 200
    assert len(body['forms']) == 4
    assert 'stats' not in body, 'a failed read must never be reported as zero submissions'
    assert body['stats_error'] == 'Failed to fetch form stats'
