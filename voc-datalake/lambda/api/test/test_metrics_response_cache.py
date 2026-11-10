"""The metrics routes' warm-container memo end to end (docs/caching.md).

A repeat of the same question, with nothing changed, is answered without reading
feedback again; a data/config bump, another caller's scope or a different window is
a fresh read; a version read that fails is a live read every time.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from category_access_fixtures import CATEGORIES_CONFIG, RESTRICTED_CLAIMS, RESTRICTED_SUB
from handler_events_fixtures import call_route
from urgency_index_fixtures import wire_urgency_index

from metrics_handler import lambda_handler
from shared.api import clear_categories_cache
from shared.category_access import access_key
from shared.data_version import CONFIG_VERSION_KEY, DATA_VERSION_KEY
from shared.test.clock import today_utc

OTHER_CLAIMS = {'sub': 'sub-other', 'cognito:groups': 'users', 'cognito:username': 'otto'}


@pytest.fixture(autouse=True)
def _fresh_categories_cache():
    clear_categories_cache()
    yield
    clear_categories_cache()


def _items() -> list[dict]:
    today = today_utc()
    return [
        {'feedback_id': 'd1', 'category': 'delivery', 'date': today, 'source_platform': 'web', 'pk': 'p', 'sk': 'd1',
         'sentiment_label': 'negative', 'sentiment_score': -0.5, 'urgency': 'high', 'original_text': 'parcel late'},
        {'feedback_id': 'b1', 'category': 'billing', 'date': today, 'source_platform': 'app', 'pk': 'p', 'sk': 'b1',
         'sentiment_label': 'positive', 'sentiment_score': 0.9, 'urgency': 'low', 'original_text': 'billed twice'},
    ]


class _World:
    """Aggregates whose version rows the test moves; a feedback table that counts its reads."""

    def __init__(self) -> None:
        self.versions: dict[str, Any] = {'data_version': 1, 'config_version': 1}
        self.version_reads_fail = False
        rows = {
            (CATEGORIES_CONFIG['pk'], CATEGORIES_CONFIG['sk']): CATEGORIES_CONFIG,
            tuple(access_key(RESTRICTED_SUB).values()): {**access_key(RESTRICTED_SUB), 'categories': ['delivery']},
            tuple(access_key('sub-other').values()): {**access_key('sub-other'), 'categories': ['billing']},
        }
        self.aggregates = MagicMock()
        self.aggregates.name = 'test-aggregates'
        self.aggregates.get_item.side_effect = lambda Key, **_: (
            {'Item': rows[(Key['pk'], Key['sk'])]} if (Key['pk'], Key['sk']) in rows else {})
        self.aggregates.query.return_value = {'Items': []}
        self.aggregates.meta.client.batch_get_item.side_effect = self._batch_get
        self.feedback = MagicMock()
        wire_urgency_index(self.feedback, _items())
        self.feedback.query.side_effect = lambda **_: {'Items': _items()}

    def _batch_get(self, **_kwargs: Any) -> dict:
        if self.version_reads_fail:
            raise RuntimeError('throttled')
        keys = (DATA_VERSION_KEY, CONFIG_VERSION_KEY)
        return {'Responses': {'test-aggregates': [
            {**key, 'v': self.versions[key['sk']]} for key in keys]}}

    def get(self, api_gateway_event, lambda_context, path='/metrics/summary', claims=RESTRICTED_CLAIMS,
            days='1') -> tuple[dict, Any]:
        with patch('metrics_handler.feedback_table', self.feedback), \
                patch('metrics_handler.aggregates_table', self.aggregates):
            return call_route(lambda_handler, api_gateway_event, lambda_context,
                              method='GET', path=path, query_params={'days': days}, claims=claims)

    @property
    def feedback_reads(self) -> int:
        return self.feedback.query.call_count


@pytest.fixture
def world() -> _World:
    return _World()


def test_a_repeat_is_answered_without_reading_feedback_again(world, api_gateway_event, lambda_context):
    _, first = world.get(api_gateway_event, lambda_context)
    reads = world.feedback_reads
    _, second = world.get(api_gateway_event, lambda_context)
    assert reads > 0
    assert world.feedback_reads == reads
    assert second == first


def test_a_data_bump_reads_again(world, api_gateway_event, lambda_context):
    world.get(api_gateway_event, lambda_context)
    reads = world.feedback_reads
    world.versions['data_version'] = 2
    world.get(api_gateway_event, lambda_context)
    assert world.feedback_reads > reads


def test_a_config_bump_reads_again(world, api_gateway_event, lambda_context):
    world.get(api_gateway_event, lambda_context)
    reads = world.feedback_reads
    world.versions['config_version'] = 2
    world.get(api_gateway_event, lambda_context)
    assert world.feedback_reads > reads


def test_two_scopes_never_share_an_answer(world, api_gateway_event, lambda_context):
    _, delivery = world.get(api_gateway_event, lambda_context, path='/feedback')
    _, billing = world.get(api_gateway_event, lambda_context, path='/feedback', claims=OTHER_CLAIMS)
    assert [item['category'] for item in delivery['items']] == ['delivery']
    assert [item['category'] for item in billing['items']] == ['billing']


def test_a_different_window_reads_again(world, api_gateway_event, lambda_context):
    world.get(api_gateway_event, lambda_context, days='1')
    reads = world.feedback_reads
    world.get(api_gateway_event, lambda_context, days='7')
    assert world.feedback_reads > reads


def test_a_failed_version_read_is_a_live_read_every_time(world, api_gateway_event, lambda_context):
    world.version_reads_fail = True
    world.get(api_gateway_event, lambda_context)
    reads = world.feedback_reads
    response, _ = world.get(api_gateway_event, lambda_context)
    assert response['statusCode'] == 200
    assert world.feedback_reads > reads


def test_the_answer_carries_a_revalidation_tag(world, api_gateway_event, lambda_context):
    response, _ = world.get(api_gateway_event, lambda_context)
    headers = response['multiValueHeaders']
    assert headers['ETag'][0].startswith('W/"')
    assert headers['Cache-Control'] == ['private, no-cache']
