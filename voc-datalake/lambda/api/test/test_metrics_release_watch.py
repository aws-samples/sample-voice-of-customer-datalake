"""GET /metrics/release-watch: scoped before/after per release (shared/release_watch.py)."""
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from category_access_fixtures import RESTRICTED_CLAIMS, aggregates_with, restricted_to
from handler_events_fixtures import call_route

from metrics_handler import lambda_handler
from shared.api import clear_categories_cache

PATH = '/metrics/release-watch'


def _ago(days: int) -> str:
    return (datetime.now(UTC) - timedelta(days=days)).strftime('%Y-%m-%d')


def item(fid, days_ago, *, score=-0.5, label='negative', category='billing', version=None, text='slow login'):
    row = {'feedback_id': fid, 'pk': 'p', 'sk': fid, 'date': _ago(days_ago),
           'source_created_at': f'{_ago(days_ago)}T12:00:00Z', 'category': category,
           'sentiment_score': Decimal(str(score)), 'sentiment_label': label, 'original_text': text,
           'source_platform': 'webscraper'}
    if version:
        row['source_platform'] = 'github_issues'
        row['issue_attributes'] = {'software_version': version}
    return row


@pytest.fixture(autouse=True)
def _fresh_categories_cache():
    clear_categories_cache()
    yield
    clear_categories_cache()


def _feedback_table(items):
    """Answers each day partition with that day's items, like gsi1-by-date."""
    def query(**kwargs):
        partition = kwargs['KeyConditionExpression'].get_expression()['values'][1]
        rows = [i for i in items if f"DATE#{i['date']}" == partition]
        return {'Items': rows, 'ScannedCount': len(rows)}

    table = MagicMock()
    table.query.side_effect = query
    return table


def _call(api_gateway_event, lambda_context, query, *, items=(), claims=None, aggregates=None):
    with patch('metrics_handler.feedback_table', _feedback_table(list(items))), \
            patch('metrics_handler.aggregates_table', aggregates or aggregates_with()):
        kwargs = {'claims': claims} if claims else {}
        return call_route(lambda_handler, api_gateway_event, lambda_context,
                          method='GET', path=PATH, query_params=query, **kwargs)


def _body(result) -> dict:
    response, body = result
    assert response['statusCode'] == 200, body
    return body


def _status(result) -> int:
    return result[0]['statusCode']


GITHUB_ITEMS = [
    *[item(f'b{i}', 15, score=0.5, label='positive', version='1.1.0') for i in range(5)],
    *[item(f'a{i}', 5, score=-0.5, version='1.2.0') for i in range(12)],
]


class TestGithubReleases:
    def test_each_new_version_is_compared_and_a_regression_flagged(self, api_gateway_event, lambda_context):
        body = _body(_call(api_gateway_event, lambda_context, {'days': '30'}, items=GITHUB_ITEMS))
        newest = body['releases'][0]
        assert (newest['label'], newest['kind'], newest['date']) == ('1.2.0', 'github_release', _ago(5))
        assert (newest['before']['count'], newest['after']['count']) == (5, 12)
        assert newest['reasons'] == ['sentiment_drop', 'negative_rise']

    def test_the_answer_publishes_window_partial_and_thresholds(self, api_gateway_event, lambda_context):
        body = _body(_call(api_gateway_event, lambda_context, {'days': '30', 'window': '7'}, items=GITHUB_ITEMS))
        assert (body['period_days'], body['window_days'], body['is_partial']) == (30, 7, False)
        assert body['thresholds']['sentiment_drop'] == 0.15

    def test_a_restricted_caller_sees_only_its_categories(self, api_gateway_event, lambda_context):
        aggregates = restricted_to('delivery')
        body = _body(_call(api_gateway_event, lambda_context, {'days': '30'}, items=GITHUB_ITEMS,
                           claims=RESTRICTED_CLAIMS, aggregates=aggregates))
        assert body['releases'] == []

    def test_category_and_keywords_narrow_the_items(self, api_gateway_event, lambda_context):
        items = [*GITHUB_ITEMS, item('x', 4, category='ui', version='1.2.0', text='dark mode')]
        body = _body(_call(api_gateway_event, lambda_context,
                           {'days': '30', 'category': 'ui', 'q': 'DARK'}, items=items))
        assert [(r['label'], r['after']['count']) for r in body['releases']] == [('1.2.0', 1)]


class TestDatedLaunch:
    def test_a_named_launch_replaces_the_github_releases(self, api_gateway_event, lambda_context):
        body = _body(_call(api_gateway_event, lambda_context,
                           {'launched_at': _ago(5), 'label': 'New checkout'}, items=GITHUB_ITEMS))
        assert [(r['key'], r['label'], r['kind']) for r in body['releases']] == [
            (f'launch:{_ago(5)}', 'New checkout', 'launch')]

    @pytest.mark.parametrize('launched_at', ['soon', '2026-02-30', 'FUTURE', 'OLD'])
    def test_a_bad_launch_date_is_a_400(self, api_gateway_event, lambda_context, launched_at):
        value = {'FUTURE': _ago(-2), 'OLD': _ago(400)}.get(launched_at, launched_at)
        assert _status(_call(api_gateway_event, lambda_context, {'launched_at': value})) == 400

    def test_an_overlong_label_is_a_400(self, api_gateway_event, lambda_context):
        result = _call(api_gateway_event, lambda_context, {'launched_at': _ago(1), 'label': 'x' * 121})
        assert _status(result) == 400
