"""GET /metrics/github and the /feedback version/label filters."""
from datetime import UTC, datetime
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from category_access_fixtures import RESTRICTED_CLAIMS, aggregates_with, restricted_to
from handler_events_fixtures import call_route

from metrics_handler import lambda_handler
from shared.api import clear_categories_cache
from shared.github_metrics import github_breakdown, matches_issue_filters, version_sort_key

TODAY = datetime.now(UTC).strftime('%Y-%m-%d')


def gh_item(feedback_id, version=None, *, category='bug', sentiment=-0.5, label='negative',
            labels=('bug',), error=None, component=None, kind='issue', plus_one=0, repo='acme/Kiro'):
    attributes = {'kind': kind, 'repo': repo, 'number': 1, 'labels': list(labels),
                  'plus_one': plus_one, 'state': 'open'}
    if version:
        attributes['software_version'] = version
    if error:
        attributes['error_signature'] = error
    if component:
        attributes['component'] = component
    return {
        'feedback_id': feedback_id, 'pk': 'p', 'sk': feedback_id, 'date': TODAY,
        'source_platform': 'github_issues', 'category': category,
        'sentiment_score': Decimal(str(sentiment)), 'sentiment_label': label,
        'issue_attributes': attributes,
    }


ITEMS = [
    gh_item('a', '0.4.1', error='typeerror: x', component='chat', plus_one=2),
    gh_item('b', '0.4.1', category='performance', sentiment=0.5, label='positive', labels=('feedback',)),
    gh_item('c', '0.4.2', error='typeerror: x', kind='comment'),
    gh_item('d', '0.4.2', category='delivery', error='keyerror: <str>', component='auth'),
    gh_item('e', '0.10.0', labels=('bug', 'regression'), error='panic: boom'),
    gh_item('f', None, labels=()),
]


@pytest.fixture(autouse=True)
def _fresh_categories_cache():
    clear_categories_cache()
    yield
    clear_categories_cache()


def _feedback_table(items):
    table = MagicMock()
    table.query.side_effect = lambda **_: {'Items': list(items), 'ScannedCount': len(items)}
    return table


def _call(api_gateway_event, lambda_context, path, *, items=ITEMS, aggregates=None, claims=None, query=None):
    with patch('metrics_handler.feedback_table', _feedback_table(items)), \
            patch('metrics_handler.aggregates_table', aggregates or aggregates_with()):
        kwargs = {'claims': claims} if claims else {}
        return call_route(lambda_handler, api_gateway_event, lambda_context,
                          method='GET', path=path, query_params=query or {'days': '1'}, **kwargs)


class TestBreakdown:
    def test_versions_are_in_release_order_with_their_stats(self):
        body = github_breakdown(ITEMS)

        assert [v['version'] for v in body['versions']] == ['0.4.1', '0.4.2', '0.10.0']
        first = body['versions'][0]
        assert first['count'] == 2
        assert first['weight'] == 4  # (1 + 2 👍) + 1
        assert first['avg_sentiment'] == 0.0
        assert first['negative'] == 1
        assert first['top_complaints'] == [{'name': 'bug', 'count': 1}]
        assert first['top_errors'] == [{'name': 'typeerror: x', 'count': 1}]
        assert body['versions'][1]['issues'] == 1
        assert body['versions'][1]['comments'] == 1
        assert body['unversioned']['count'] == 1
        assert body['total'] == 6
        assert body['repos'] == ['acme/Kiro']

    def test_new_since_last_version_compares_the_latest_with_every_earlier_release(self):
        body = github_breakdown(ITEMS)

        assert body['latest_version'] == '0.10.0'
        assert body['previous_version'] == '0.4.2'
        assert body['new_in_latest']['errors'] == [{'name': 'panic: boom', 'count': 1}]
        # 'bug' was already reported against 0.4.1 — not new.
        assert body['new_in_latest']['categories'] == []

    def test_a_single_release_reports_nothing_as_new(self):
        body = github_breakdown([gh_item('a', '1.0.0', error='x: y')])
        assert body['previous_version'] is None
        assert body['new_in_latest'] == {'errors': [], 'categories': [], 'components': []}

    def test_labels_are_counted_per_label(self):
        rows = {row['label']: row for row in github_breakdown(ITEMS)['labels']}
        assert rows['bug']['count'] == 4
        assert rows['regression']['count'] == 1
        assert rows['bug']['open'] == 4

    def test_no_items(self):
        body = github_breakdown([])
        assert body['versions'] == []
        assert body['latest_version'] is None
        assert body['unversioned'] == {'count': 0, 'weight': 0, 'avg_sentiment': None, 'negative': 0}

    @pytest.mark.parametrize(('ordered'), [
        ['0.9.0', '0.10.0'],
        ['1.0.0-rc.1', '1.0.0'],
        ['1.2', '1.2.1'],
        ['1.0.0-beta.2', '1.0.0-rc.1'],
    ])
    def test_version_sort_key(self, ordered):
        earlier, later = ordered
        assert version_sort_key(earlier) < version_sort_key(later)

    def test_issue_filters(self):
        item = gh_item('a', '0.4.2', labels=('Bug',))
        assert matches_issue_filters(item, '0.4.2', None)
        assert matches_issue_filters(item, 'v0.4.2', 'bug')
        assert not matches_issue_filters(item, '0.4.1', None)
        assert not matches_issue_filters(item, None, 'question')
        assert not matches_issue_filters({'feedback_id': 'x'}, '0.4.2', None)
        assert matches_issue_filters({'feedback_id': 'x'}, None, None)


class TestRoute:
    def test_pushes_the_source_down_and_returns_the_breakdown(self, api_gateway_event, lambda_context):
        table = _feedback_table(ITEMS)
        with patch('metrics_handler.feedback_table', table), \
                patch('metrics_handler.aggregates_table', aggregates_with()):
            response, body = call_route(lambda_handler, api_gateway_event, lambda_context,
                                        method='GET', path='/metrics/github', query_params={'days': '1'})

        assert response['statusCode'] == 200
        assert body['is_partial'] is False
        assert body['latest_version'] == '0.10.0'
        filter_expression = table.query.call_args.kwargs['FilterExpression']
        assert filter_expression.get_expression()['values'][1] == 'github_issues'

    def test_a_restricted_caller_sees_only_their_categories(self, api_gateway_event, lambda_context):
        _, body = _call(api_gateway_event, lambda_context, '/metrics/github',
                        aggregates=restricted_to('delivery'), claims=RESTRICTED_CLAIMS)
        assert body['total'] == 1
        assert [v['version'] for v in body['versions']] == ['0.4.2']

    def test_repo_narrows_the_breakdown(self, api_gateway_event, lambda_context):
        items = [*ITEMS, gh_item('z', '9.0.0', repo='acme/other')]
        _, body = _call(api_gateway_event, lambda_context, '/metrics/github', items=items,
                        query={'days': '1', 'repo': 'acme/other'})
        assert body['total'] == 1
        assert body['repos'] == ['acme/other']


class TestFeedbackFilters:
    def test_version_filter(self, api_gateway_event, lambda_context):
        _, body = _call(api_gateway_event, lambda_context, '/feedback', query={'days': '1', 'version': '0.4.2'})
        assert sorted(i['feedback_id'] for i in body['items']) == ['c', 'd']

    def test_label_filter(self, api_gateway_event, lambda_context):
        _, body = _call(api_gateway_event, lambda_context, '/feedback', query={'days': '1', 'label': 'regression'})
        assert [i['feedback_id'] for i in body['items']] == ['e']
