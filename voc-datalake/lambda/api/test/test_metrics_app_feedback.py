"""The metric and list routes leave the VoC app's own micro-feedback out (an item tagged ``voc_app``, 7.66.00,
shared/item_filters.py), as the aggregates the unfiltered routes read do; a filter on the tag itself reads it, in the
metrics, the Feedback list and search (moto)."""
from __future__ import annotations

from contextlib import ExitStack
from datetime import UTC, datetime
from decimal import Decimal
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import indexed_table, pk_sk_table

from metrics_handler import lambda_handler
from shared.api import clear_categories_cache

ADMIN_CLAIMS = {'sub': 'sub-admin', 'cognito:groups': 'admins', 'cognito:username': 'ada'}
#: Each review: its id, source and tags (two are the micro-feedback's).
REVIEWS = [('w1', 'web', []), ('w2', 'web', ['beta']), ('f1', 'feedback_form', ['voc_app']),
           ('f2', 'feedback_form', ['VOC_APP', 'beta'])]


def _review(today: str, n: int, row: tuple[str, str, list[str]]) -> dict:
    fid, source, tags = row
    item = {'pk': f'SOURCE#{source}', 'sk': f'FEEDBACK#{fid}', 'feedback_id': fid, 'gsi1pk': f'DATE#{today}',
            'gsi1sk': f'{today}T00:00:0{n}', 'date': today, 'source_platform': source, 'category': 'delivery',
            'sentiment_label': 'negative', 'sentiment_score': Decimal('0'), 'problem_summary': f'Problem {fid}'}
    return {**item, 'tags': tags} if tags else item


@pytest.fixture
def get(api_gateway_event, lambda_context):
    with ExitStack() as stack:
        stack.enter_context(mock_aws())
        clear_categories_cache()
        feedback = pk_sk_table('app-feedback', gsi1_index='gsi1-by-date')
        aggregates = pk_sk_table('app-aggregates')
        today = datetime.now(UTC).strftime('%Y-%m-%d')
        for n, row in enumerate(REVIEWS):
            feedback.put_item(Item=_review(today, n, row))
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': [{'name': 'delivery'}]})
        stack.enter_context(patch('metrics_handler.feedback_table', feedback))
        stack.enter_context(patch('metrics_handler.aggregates_table', aggregates))

        def call(path: str, **params: str) -> tuple[int, dict]:
            response, body = call_route(lambda_handler, api_gateway_event, lambda_context, method='GET',
                                        path=path, query_params={'days': '1', **params}, claims=ADMIN_CLAIMS)
            return response['statusCode'], body

        yield call
    clear_categories_cache()


def test_a_filtered_metric_leaves_the_app_feedback_out(get):
    _, summary = get('/metrics/summary', source='web,feedback_form')
    _, sources = get('/metrics/sources', category='delivery')
    _, tagged = get('/metrics/summary', tag='beta')
    assert summary['total_feedback'] == 2
    assert sources['sources'] == {'web': 2}
    assert tagged['total_feedback'] == 1


def test_a_filter_on_its_tag_counts_it(get):
    _, summary = get('/metrics/summary', tag='voc_app')
    _, sources = get('/metrics/sources', tag='VOC_APP')
    assert summary['total_feedback'] == 2
    assert sources['sources'] == {'feedback_form': 2}


def test_the_feedback_list_and_search_leave_it_out_unless_asked_by_tag(get):
    _, listed = get('/feedback', source='feedback_form')
    _, tagged = get('/feedback', tag='voc_app')
    _, searched = get('/feedback/search', q='Problem')
    _, asked = get('/feedback/search', q='Problem', tag='voc_app')
    assert [listed['items'], sorted(item['feedback_id'] for item in tagged['items'])] == [[], ['f1', 'f2']]
    assert [sorted(item['feedback_id'] for item in searched['items']),
            sorted(item['feedback_id'] for item in asked['items'])] == [['w1', 'w2'], ['f1', 'f2']]


def test_the_similar_reviews_leave_it_out(get):
    """Review round 3 (7.66.00): ``/feedback/{id}/similar`` (the web app's Similar panel, and the assistant's
    ``get_feedback_item`` and MCP ``feedback_get`` with ``include_similar``, which both call this route) ranks no
    micro-feedback, though it shares the review's category partition."""
    today = datetime.now(UTC).strftime('%Y-%m-%d')
    text = {'normalized_text': 'The courier delivered the parcel late and the box was crushed'}
    source, *candidates = [{**_review(today, n, row), **text} for n, row in enumerate(REVIEWS)]
    with patch('metrics_handler._feedback_by_id', return_value=source), \
            patch('metrics_handler._feedback_query', return_value={'Items': [source, *candidates]}) as read:
        status, similar = get('/feedback/w1/similar')
    assert read.call_args.kwargs['IndexName'] == 'gsi2-by-category'
    assert (status, [item['feedback_id'] for item in similar['items']]) == (200, ['w2'])


def test_the_entities_issue_sample_leaves_it_out(get):
    """Review round 3 (7.66.00): ``/feedback/entities``' issue sample (its projected rows carry the tags now) counts no
    micro-feedback's problem, as the aggregates beside it count none of its reviews; a filtered request's sample too."""
    import boto3
    aggregates = indexed_table(boto3.resource('dynamodb', region_name='us-east-1'), 'app-aggregates-indexed',
                               {'gsi1-by-metric-type': ('metric_type', 'pk')})
    aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': [{'name': 'delivery'}]})
    with patch('metrics_handler.aggregates_table', aggregates):   # (the unfiltered branch reads the aggregates' index)
        _, entities = get('/feedback/entities')
    _, filtered = get('/feedback/entities', source='web,feedback_form')
    assert [sorted(entities['entities']['issues']), sorted(filtered['entities']['issues'])] == [
        ['problem w1', 'problem w2'], ['problem w1', 'problem w2']]
