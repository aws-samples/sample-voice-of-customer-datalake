"""Independent reads on hot request paths run concurrently (QA perf track).

Each test's mock waits on a `threading.Barrier` sized to the number of reads the
route makes. The barrier only opens when ALL of them are in flight at once, so a
serial loop blocks on its first call, times out, and the route fails — the test
fails with the fix reverted. A second assertion per route pins that the answer is
unchanged (order, sums, partial flags).

Production p95 before (ms, 24 h): metrics-api 861 (max 7139), users-api 1380,
logs-api p50 150 — see voc-e2e/qa/perf/LAMBDA-CAPACITY.md.
"""
import json
import threading
from unittest.mock import patch

from handler_events_fixtures import call_route

from shared.api import clear_categories_cache

BARRIER_TIMEOUT_S = 5


def _barrier_query(parties: int, answer):
    """A `query` side effect that blocks until `parties` calls are in flight."""
    barrier = threading.Barrier(parties, timeout=BARRIER_TIMEOUT_S)

    def query(**kwargs):
        barrier.wait()
        return answer(kwargs)
    return query


def _pk_of(kwargs) -> str:
    """The partition a key condition names (`Key('pk').eq(x) & ...`)."""
    condition = kwargs['KeyConditionExpression']
    # `And(Equals(Key('pk'), x), Between(...))` or a bare `Equals`.
    equals = condition.get_expression()['values'][0] if condition.expression_operator == 'AND' else condition
    return equals.get_expression()['values'][1]


class TestMetricsPartitionsAreReadTogether:
    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_sentiment_reads_its_four_partitions_concurrently(self, agg, fb, api_gateway_event, lambda_context):
        counts = {'positive': 5, 'neutral': 3, 'negative': 2, 'mixed': 1}
        agg.get_item.return_value = {}
        fb.query.return_value = {'Items': []}
        agg.query.side_effect = _barrier_query(4, lambda kw: {'Items': [
            {'sk': '2026-10-05', 'count': counts[_pk_of(kw).rsplit('#', 1)[1]]}]})
        clear_categories_cache()
        from metrics_handler import lambda_handler

        response, body = call_route(lambda_handler, api_gateway_event, lambda_context,
                                    method='GET', path='/metrics/sentiment', query_params={'days': '7'})

        assert response['statusCode'] == 200, response['body']
        assert body['breakdown'] == counts
        assert body['total'] == 11
        assert body['is_partial'] is False
        assert agg.query.call_count == 4

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_truncated_partition_still_marks_the_breakdown_partial(self, agg, fb, api_gateway_event, lambda_context):
        """The OR across partitions survives the concurrent read, whichever one is short."""
        agg.get_item.return_value = {}
        fb.query.return_value = {'Items': []}

        def answer(**kw):
            truncated = _pk_of(kw).endswith('#negative')
            page = {'Items': [{'sk': '2026-10-05', 'count': 1}]}
            return {**page, 'LastEvaluatedKey': {'pk': 'x'}} if truncated else page
        agg.query.side_effect = answer
        clear_categories_cache()
        from metrics_handler import lambda_handler

        _, body = call_route(lambda_handler, api_gateway_event, lambda_context,
                             method='GET', path='/metrics/sentiment', query_params={'days': '1'})

        assert body['is_partial'] is True

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_summary_reads_its_three_windows_concurrently(self, agg, fb, api_gateway_event, lambda_context):
        rows = {
            'METRIC#daily_total': [{'sk': '2026-10-05', 'count': 7}],
            'METRIC#daily_sentiment_avg': [{'sk': '2026-10-05', 'count': 2, 'sum': 1}],
            'METRIC#urgent': [{'sk': '2026-10-05', 'count': 3}],
        }
        agg.get_item.return_value = {}
        barrier_query = _barrier_query(3, lambda kw: {'Items': rows.get(_pk_of(kw), [])})

        def query(**kwargs):
            # Only the three window reads join the barrier; any other read the
            # route makes (none today) answers immediately.
            return barrier_query(**kwargs) if _pk_of(kwargs) in rows else {'Items': []}
        agg.query.side_effect = query
        fb.query.return_value = {'Items': []}
        clear_categories_cache()
        from metrics_handler import lambda_handler

        response, body = call_route(lambda_handler, api_gateway_event, lambda_context,
                                    method='GET', path='/metrics/summary', query_params={'days': '7'})

        assert response['statusCode'] == 200, response['body']
        assert body['urgent_count'] == 3
        assert body['is_partial'] is False


class TestLogsSourcesAreReadTogether:
    SOURCES = ("webscraper", "manual_import")

    @patch('logs_handler.default_source_ids')
    @patch('logs_handler.aggregates_table')
    def test_summary_reads_every_source_and_type_concurrently(self, agg, sources, api_gateway_event, lambda_context):
        sources.return_value = list(self.SOURCES)
        sizes = {'LOGS#validation#webscraper': 2, 'LOGS#processing#webscraper': 0,
                 'LOGS#validation#manual_import': 1, 'LOGS#processing#manual_import': 4}
        agg.query.side_effect = _barrier_query(4, lambda kw: {'Items': [
            {'timestamp': f't{i}'} for i in range(sizes[_pk_of(kw)])]})
        from logs_handler import lambda_handler

        response, body = call_route(lambda_handler, api_gateway_event, lambda_context,
                                    method='GET', path='/logs/summary')

        assert response['statusCode'] == 200, response['body']
        assert body['summary'] == {
            'validation_failures': {'webscraper': 2, 'manual_import': 1},
            'processing_errors': {'manual_import': 4},
            'total_validation_failures': 3,
            'total_processing_errors': 4,
        }

    @patch('logs_handler.default_source_ids')
    @patch('logs_handler.aggregates_table')
    def test_listing_reads_every_source_concurrently_and_merges_newest_first(
            self, agg, sources, api_gateway_event, lambda_context):
        sources.return_value = list(self.SOURCES)
        stamps = {'LOGS#validation#webscraper': ['2026-10-05T03', '2026-10-05T01'],
                  'LOGS#validation#manual_import': ['2026-10-05T02']}
        agg.query.side_effect = _barrier_query(2, lambda kw: {'Items': [
            {'timestamp': t, 'source_platform': _pk_of(kw).rsplit('#', 1)[1]} for t in stamps[_pk_of(kw)]]})
        from logs_handler import lambda_handler

        response, body = call_route(lambda_handler, api_gateway_event, lambda_context,
                                    method='GET', path='/logs/validation')

        assert response['statusCode'] == 200, response['body']
        assert [log['timestamp'] for log in body['logs']] == ['2026-10-05T03', '2026-10-05T02', '2026-10-05T01']


class TestUsersListingOverlapsItsCognitoReads:
    @patch('users_handler.cognito')
    def test_user_listing_and_group_listings_are_in_flight_together(
            self, cognito, api_gateway_event, lambda_context):
        # ListUsers + one ListUsersInGroup per group (2) = 3 calls at once.
        barrier = threading.Barrier(3, timeout=BARRIER_TIMEOUT_S)
        cognito.list_groups.return_value = {'Groups': [{'GroupName': 'admins'}, {'GroupName': 'users'}]}

        def list_users(**_kw):
            barrier.wait()
            return {'Users': [
                {'Username': n, 'Attributes': [{'Name': 'sub', 'Value': f'sub-{n}'}],
                 'UserStatus': 'CONFIRMED', 'Enabled': True} for n in ('a', 'b')]}

        def list_users_in_group(GroupName, **_kw):
            barrier.wait()
            return {'Users': [{'Username': 'a'}] if GroupName == 'admins' else [{'Username': 'a'}, {'Username': 'b'}]}

        cognito.list_users.side_effect = list_users
        cognito.list_users_in_group.side_effect = list_users_in_group
        from users_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/users')
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'

        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200, response['body']
        users = json.loads(response['body'])['users']
        # ListGroups order is kept in each user's groups.
        assert {u['username']: u['groups'] for u in users} == {'a': ['admins', 'users'], 'b': ['users']}
