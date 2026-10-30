"""The web_reviews ingestor end to end, with the browser and every AWS client faked."""
import json
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from page_reader import PageSnapshot

from _shared.test.ingestor_fixtures import offline_ingestor_construction, with_mock_circuit_breaker
from _shared.test.scoped_secret import scoped_secret

URL = 'https://www.trustpilot.com/review/example.com'
JSONLD = json.dumps([
    {'@type': 'Review', 'reviewBody': 'Lost my bag.', 'datePublished': '2026-10-01', 'author': {'name': 'Reviewer A'},
     'reviewRating': {'ratingValue': 1}},
    {'@type': 'Review', 'reviewBody': 'Old complaint.', 'datePublished': '2026-01-01'},
])


class WatermarkTable:
    def __init__(self, values: dict[str, str] | None = None):
        self.values = dict(values or {})

    def get_item(self, Key):
        value = self.values.get(Key['source'])
        return {'Item': {'value': value}} if value is not None else {}

    def put_item(self, Item):
        self.values[Item['source']] = Item['value']


class FakeTab:
    def __init__(self, pages: dict[str, PageSnapshot]):
        self.pages = pages

    def open(self) -> None:
        return None

    def load(self, url: str) -> PageSnapshot:
        return self.pages[url]

    fetch = load


def page(url: str = URL, **fields: Any) -> PageSnapshot:
    values = {'url': url, 'status': 200, 'title': 'Reviews', 'text': 'x' * 4000, 'html': '<html></html>',
              'jsonld': (JSONLD,), 'next_url': None}
    return PageSnapshot(**{**values, **fields})


def target_config(**fields: str) -> dict[str, str]:
    return {'id': 't1', 'app_name': 'Trustpilot', 'url': URL, 'max_pages': '1', 'frequency_minutes': '0', **fields}


@contextmanager
def ingestor(configs: list[dict], pages: dict[str, PageSnapshot] | None = None, *, execution_id: str | None = 'run_1',
             table: WatermarkTable | None = None, session: Any = None) -> Generator[Any, None, None]:
    """The ingestor over *configs*, its watermarks in *table*, its browser session *session* (a mock)."""
    from web_reviews.ingestor import handler

    secret = scoped_secret(configs=json.dumps(configs))
    with offline_ingestor_construction(), \
            patch('_shared.base_ingestor.get_secret', return_value=secret), \
            patch('shared.web_review_targets.validate_url', return_value=(True, '')), \
            patch.object(handler, 'browser_session', return_value=session or MagicMock()), \
            patch.object(handler, 'BrowserTab', return_value=FakeTab(pages or {URL: page()})):
        instance = handler.WebReviewsIngestor(execution_id=execution_id, complete=lambda _p, _s: '')
        with patch.object(instance, 'watermarks_table', table or WatermarkTable()):
            yield with_mock_circuit_breaker(instance)


class TestRun:
    def test_sends_the_reviews_newer_than_the_watermark(self):
        table = WatermarkTable({'test_source#target_t1_newest_review': '2026-09-30'})
        with ingestor([target_config()], table=table) as run:
            items = list(run.fetch_new_items())
        assert [item['text'] for item in items] == ['Lost my bag.']

    def test_advances_the_watermark_to_the_newest_review(self):
        table = WatermarkTable()
        with ingestor([target_config()], table=table) as run:
            list(run.fetch_new_items())
        assert table.values['test_source#target_t1_newest_review'] == '2026-10-01'

    def test_a_blocked_site_is_reported_not_empty(self):
        wall = page(status=403, text='', jsonld=(), html='<script src="https://ct.captcha-delivery.com/c.js">')
        with ingestor([target_config()], {URL: wall}) as run:
            assert list(run.fetch_new_items()) == []
        assert run.run_errors == ['Trustpilot: blocked by DataDome']

    def test_a_redirect_off_host_is_reported_and_not_imported(self):
        moved = page(url='https://www.example.net/landing')
        with ingestor([target_config()], {URL: moved}) as run:
            assert list(run.fetch_new_items()) == []
        assert run.run_errors == ['Trustpilot: redirected off-host']

    def test_the_completed_run_status_carries_the_errors(self):
        with ingestor([target_config()]) as run:
            run.run_errors.append('Trustpilot: blocked by DataDome')
            run.aggregates_table = MagicMock()
            run._update_source_run_status({'status': 'completed', 'items_found': 0})
        values = run.aggregates_table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert values[':errors'] == ['Trustpilot: blocked by DataDome']

    def test_an_invalid_stored_target_is_reported_and_skipped(self):
        with ingestor([target_config(url='http://www.trustpilot.com/review/x')]) as run:
            assert list(run.fetch_new_items()) == []
        assert run.run_errors == ['Trustpilot: Only https URLs are allowed']

    def test_a_scheduled_run_skips_a_manual_only_target(self):
        session = MagicMock()
        with ingestor([target_config()], execution_id=None, session=session) as run:
            assert list(run.fetch_new_items()) == []
        session.__enter__.assert_not_called()

    def test_a_scheduled_run_reads_a_due_target(self):
        with ingestor([target_config(frequency_minutes='60')], execution_id=None) as run:
            assert len(list(run.fetch_new_items())) == 2

    def test_a_disabled_target_is_not_read(self):
        with ingestor([target_config(enabled='false')]) as run:
            assert list(run.fetch_new_items()) == []

    def test_one_session_for_every_target(self):
        second_url = 'https://www.tripadvisor.com/Airline_Review-x'
        configs = [target_config(), target_config(id='t2', app_name='TripAdvisor', url=second_url,
                                                  source_id='web_tripadvisor_example_air')]
        session = MagicMock()
        with ingestor(configs, {URL: page(), second_url: page(url=second_url)}, session=session) as run:
            items = list(run.fetch_new_items())
        assert session.__enter__.call_count == 1
        # The stored label, and for a target saved before it existed one minted from host + name.
        assert {item['source_platform_override'] for item in items} == {
            'web_trustpilot_trustpilot', 'web_tripadvisor_example_air'}

    def test_an_unavailable_browser_is_a_clear_error(self):
        from agentcore_browser import BrowserUnavailableError

        session = MagicMock()
        session.__enter__.side_effect = BrowserUnavailableError('AgentCore Browser is unavailable in eu-central-1')
        with ingestor([target_config()], session=session) as run:
            assert list(run.fetch_new_items()) == []
        assert run.run_errors == ['AgentCore Browser is unavailable in eu-central-1']

    def test_one_failing_target_does_not_lose_the_others(self):
        second_url = 'https://www.tripadvisor.com/Airline_Review-x'
        configs = [target_config(url='https://www.trustpilot.com/missing'), target_config(id='t2', app_name='TA', url=second_url)]
        with ingestor(configs, {second_url: page(url=second_url)}) as run:
            items = list(run.fetch_new_items())
        assert (len(items), run.run_errors) == (2, ['Trustpilot: failed (KeyError)'])

    def test_metadata_reaches_the_queue_message(self):
        with ingestor([target_config()]) as run, patch.object(run, 'store_raw_to_s3', return_value=None):
            item = next(iter(run.fetch_new_items()))
            assert run.normalize_item(item)['metadata'] == {'target': 'Trustpilot', 'page': 1}


@pytest.mark.parametrize('app_id', ['t2', 'https://www.yelp.com/biz/x'])
def test_run_now_for_one_target(app_id):
    """``Run now`` on one card passes its id or URL as ``app_id``; only that target is read."""
    from web_reviews.ingestor import handler

    def targets_read(self):
        return [target.id for target in self._targets()]

    with ingestor([target_config(), target_config(id='t2', url='https://www.yelp.com/biz/x')]), \
            patch.object(handler.WebReviewsIngestor, 'run', targets_read):
        assert handler.WebReviewsIngestor.run_for_event({'execution_id': 'run_1', 'app_id': app_id}) == ['t2']
