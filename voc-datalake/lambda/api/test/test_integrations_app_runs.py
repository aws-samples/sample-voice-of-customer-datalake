"""One app's runs (Run now on a review page or an app connector), against a moto aggregates table.

`POST /sources/{source}/run` with `app_id` keeps that app on its run row, and
`GET /sources/status?run_status=<source>&app_id=<app>` answers that app's newest run, so four review pages run at
once each read their own result, after a reload too (the Data sources page used to apply the plugin's latest run
to every running card). `&execution_id=` answers one run. The workspace half (another workspace's app or run answers
`never_run`) is in test_operator_routes_workspace.py.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route
from integrations_fixtures import stub_ingestor_invoke
from moto import mock_aws

import integrations_handler as h
from shared.run_rows import APP_RUN_LOOKBACK
from shared.test.moto_tables import create_pk_sk_table

pytestmark = pytest.mark.usefixtures('plugin_secret_defaults')

PAGES = {
    'g2': 'https://www.g2.com/products/example-connect/reviews',
    'gartner': 'https://www.gartner.com/reviews/market/example/vendor/example',
    'trustradius': 'https://www.trustradius.com/products/example-connect/reviews',
    'capterra': 'https://www.capterra.com/p/1/Example-Connect/reviews/',
}
PARTITION = 'SOURCE_RUN#web_reviews'


@pytest.fixture
def aggregates() -> Iterator[Any]:
    with mock_aws():
        table = create_pk_sk_table('test-aggregates')
        with patch('shared.tables.get_aggregates_table', return_value=table):
            yield table


@pytest.fixture
def ingestor() -> Iterator[MagicMock]:
    client = stub_ingestor_invoke(MagicMock())
    with patch.object(h.boto3, 'client', return_value=client):
        yield client


@pytest.fixture
def route(api_gateway_event, lambda_context) -> Callable[..., tuple[int, Any]]:
    def _route(method: str, path: str, **event_kwargs: Any) -> tuple[int, Any]:
        parts = path.strip('/').split('/')
        path_params = {'source': parts[1]} if parts[1] != 'status' else {}
        response, body = call_route(h.lambda_handler, api_gateway_event, lambda_context, method=method, path=path,
                                    path_params=path_params, **event_kwargs)
        return response['statusCode'], body
    return _route


def _status(route, **query: str) -> dict:
    status, body = route('GET', '/sources/status', query_params={'run_status': 'web_reviews', **query})
    assert status == 200, body
    return body


def _finish(table: Any, execution_id: str, *, items: int, errors: list[str]) -> None:
    """What the ingestor does at the end of its run (plugins/_shared/base_ingestor.py `_update_source_run_status`)."""
    table.update_item(Key={'pk': PARTITION, 'sk': execution_id},
                      UpdateExpression='SET #s = :s, items_found = :i, errors = :e, completed_at = :c',
                      ExpressionAttributeNames={'#s': 'status'},
                      ExpressionAttributeValues={':s': 'completed', ':i': items, ':e': errors, ':c': '2026-11-15T10:00:00Z'})


class TestFourPagesRunAtOnce:
    def test_each_page_reads_its_own_run_while_running_and_once_finished(self, route, aggregates, ingestor):
        started = {}
        for name, url in PAGES.items():
            status, body = route('POST', '/sources/web_reviews/run', body={'app_id': url})
            assert status == 200, body
            started[name] = body['execution_id']
        assert [json.loads(c.kwargs['Payload'])['app_id'] for c in ingestor.invoke.call_args_list] == list(PAGES.values())

        # While they run, each page's own row.
        for name, url in PAGES.items():
            assert (_status(route, app_id=url)['execution_id'], _status(route, app_id=url)['status']) == (
                started[name], 'running')

        _finish(aggregates, started['g2'], items=0, errors=['G2 - Example: blocked by DataDome'])
        _finish(aggregates, started['gartner'], items=0, errors=['Gartner - Example: blocked by Cloudflare'])
        _finish(aggregates, started['capterra'], items=12, errors=[])

        g2 = _status(route, app_id=PAGES['g2'])
        assert (g2['status'], g2['items_found'], g2['errors']) == ('completed', 0, ['G2 - Example: blocked by DataDome'])
        assert _status(route, app_id=PAGES['gartner'])['errors'] == ['Gartner - Example: blocked by Cloudflare']
        assert _status(route, app_id=PAGES['trustradius'])['status'] == 'running'
        capterra = _status(route, app_id=PAGES['capterra'])
        assert (capterra['status'], capterra['items_found'], capterra['errors']) == ('completed', 12, [])
        # The plugin's latest run (no app_id) is still answered as before: whichever row sorts newest.
        assert _status(route)['execution_id'] == max(started.values())

    @pytest.mark.usefixtures('aggregates', 'ingestor')
    def test_an_execution_id_answers_that_run_and_with_an_app_only_when_it_is_that_apps(self, route):
        execution_id = route('POST', '/sources/web_reviews/run', body={'app_id': PAGES['g2']})[1]['execution_id']

        assert _status(route, execution_id=execution_id)['status'] == 'running'
        assert _status(route, execution_id=execution_id, app_id=PAGES['g2'])['execution_id'] == execution_id
        assert _status(route, execution_id=execution_id, app_id=PAGES['gartner']) == {
            'source': 'web_reviews', 'status': 'never_run'}

    @pytest.mark.usefixtures('aggregates', 'ingestor')
    def test_a_page_that_never_ran_says_so_beside_one_that_did(self, route):
        route('POST', '/sources/web_reviews/run', body={'app_id': PAGES['g2']})

        assert _status(route, app_id=PAGES['gartner']) == {'source': 'web_reviews', 'status': 'never_run'}

    @pytest.mark.usefixtures('aggregates', 'ingestor')
    def test_a_run_of_every_page_is_no_pages_own_run(self, route):
        route('POST', '/sources/web_reviews/run')

        assert _status(route, app_id=PAGES['g2'])['status'] == 'never_run'
        assert _status(route)['status'] == 'running'


class TestTheLookback:
    def _seed(self, table: Any, others: int) -> None:
        """One run of G2, then ``others`` newer runs of another page."""
        table.put_item(Item={'pk': PARTITION, 'sk': 'run_web_reviews_20261101000000_00000000', 'status': 'completed',
                             'app_id': PAGES['g2'], 'items_found': 4})
        for n in range(others):
            table.put_item(Item={'pk': PARTITION, 'sk': f'run_web_reviews_20261102{n:06d}_00000000',
                                 'status': 'completed', 'app_id': PAGES['gartner']})

    def test_an_apps_run_behind_pages_of_other_runs_is_found(self, route, aggregates):
        self._seed(aggregates, APP_RUN_LOOKBACK - 1)

        assert _status(route, app_id=PAGES['g2'])['items_found'] == 4

    def test_one_older_than_the_lookback_is_never_run(self, route, aggregates):
        self._seed(aggregates, APP_RUN_LOOKBACK)

        assert _status(route, app_id=PAGES['g2'])['status'] == 'never_run'
