"""
Tests for the Web Scraper Ingestor handler.

Focus: `_extract_rating` rating extraction, including the word-based star
classes fix (issue #148, e.g. ``<p class="star-rating Three">``). Also
characterizes the pre-existing digit-class, rating-attribute, and text
fallbacks so a regression in any of them is caught. Plus the manual-run
secret-cache clear (issue #141) and the handler's workspace entry
(docs/multi-workspace.md: a run happens in the workspace its event names, or deployment-wide when it names none).
"""

import json
from unittest.mock import MagicMock, patch

import pytest
from bs4 import BeautifulSoup

from _shared.test.ingestor_fixtures import offline_ingestor_construction
from _shared.test.scoped_secret import scoped_secret
from _shared.test.sqs_response_fixtures import echo_batch_success
from _shared.test.workspace_fixtures import (
    EVENTS_NAMING_NO_WORKSPACE,
    EVENTS_WITH_A_MALFORMED_WORKSPACE,
    OTHER_WS,
    REFUSED,
    SCHEDULED_TICK,
    SCOPE,
    SECRET_NAME,
    TICK_ORDER,
    WS,
    fan_out_then_run,
    ws_event,
)

# The execution id POST /scrapers/{id}/run names (shared/ids.py timestamped_id), and its invoke payload
# (lambda/api/scrapers_handler.py run_scraper).
SCRAPER_RUN_ID = "run_s1_20261112080000_0a1b2c3d"
SCRAPERS_API_RUN = {"scraper_id": "s1", "execution_id": SCRAPER_RUN_ID, "manual_run": True}

# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

def _el(html: str):
    """Return the first tag parsed from an HTML snippet."""
    return BeautifulSoup(html, "html.parser").find()


@pytest.fixture
def ingestor():
    """Create a WebScraperIngestor with mocked AWS dependencies."""
    with offline_ingestor_construction():
        from webscraper.ingestor.handler import WebScraperIngestor
        return WebScraperIngestor(SCOPE)


# ---------------------------------------------------------------------------
# Word-based star classes (issue #148)
# ---------------------------------------------------------------------------

class TestExtractRatingWordClasses:
    @pytest.mark.parametrize(("word", "expected"), [
        ("One", 1), ("Two", 2), ("Three", 3), ("Four", 4), ("Five", 5),
    ])
    def test_all_word_ratings(self, ingestor, word, expected):
        # "Three" is the books.toscrape.com pattern (<p class="star-rating Three">).
        el = _el(f'<p class="star-rating {word}"></p>')
        assert ingestor._extract_rating(el, {}) == expected

    def test_word_class_is_case_insensitive(self, ingestor):
        assert ingestor._extract_rating(_el('<p class="FIVE"></p>'), {}) == 5
        assert ingestor._extract_rating(_el('<p class="four"></p>'), {}) == 4

    def test_word_only_matches_whole_class_token(self, ingestor):
        # 'foo-three' must NOT match 'three' (no substring matching), so it
        # falls through to the text fallback and returns None here.
        el = _el('<p class="foo-three"></p>')
        assert ingestor._extract_rating(el, {}) is None

    def test_out_of_range_digit_falls_through_to_word(self, ingestor):
        # First token has a digit outside 1-5 (ignored); the loop must
        # continue and resolve the word token.
        el = _el('<p class="rating-9 Three"></p>')
        assert ingestor._extract_rating(el, {}) == 3


# ---------------------------------------------------------------------------
# Pre-existing behavior (characterization / regression guards)
# ---------------------------------------------------------------------------

class TestExtractRatingExisting:
    def test_digit_in_class_still_works(self, ingestor):
        assert ingestor._extract_rating(_el('<span class="rating-4"></span>'), {}) == 4

    def test_rating_attribute_takes_precedence(self, ingestor):
        # data-rating is checked before class names.
        el = _el('<div data-rating="5" class="Two"></div>')
        assert ingestor._extract_rating(el, {}) == 5

    def test_text_fallback_x_out_of_5(self, ingestor):
        assert ingestor._extract_rating(_el('<span>4/5</span>'), {}) == 4

    def test_text_fallback_stars(self, ingestor):
        assert ingestor._extract_rating(_el('<span>3 stars</span>'), {}) == 3

    def test_none_element_returns_none(self, ingestor):
        assert ingestor._extract_rating(None, {}) is None

    def test_no_rating_signal_returns_none(self, ingestor):
        assert ingestor._extract_rating(_el('<p class="star-rating"></p>'), {}) is None


# ---------------------------------------------------------------------------
# Manual-run secret-cache clear (issue #141)
# ---------------------------------------------------------------------------

@pytest.fixture
def lambda_context():
    ctx = MagicMock()
    ctx.function_name = "test-webscraper"
    ctx.memory_limit_in_mb = 512
    ctx.invoked_function_arn = "arn:aws:lambda:us-east-1:123456789:function:test"
    ctx.aws_request_id = "test-request-id"
    return ctx


class TestLambdaHandlerSecretCache:
    """Save-then-Run-now must not serve a pre-save secret snapshot (#141).

    The cache-clear itself is centralized in BaseIngestor.__init__ (#215) and
    covered by plugins/_shared/test/test_base_ingestor.py — the handler's
    remaining contract is passing execution_id INTO the constructor, which is
    what triggers the guard. These tests fail if that pass-through is removed
    (which would silently reintroduce #141).
    """

    @patch("webscraper.ingestor.handler.WebScraperIngestor")
    def test_manual_run_passes_execution_id_to_constructor(
        self, MockIngestor, lambda_context
    ):
        from webscraper.ingestor.handler import lambda_handler
        MockIngestor.return_value.run.return_value = {"status": "success"}

        lambda_handler(
            ws_event(execution_id="exec-1", scraper_id="s1"), lambda_context
        )

        MockIngestor.assert_called_once_with(
            SCOPE, execution_id="exec-1", target_scraper_id="s1"
        )

    @patch("webscraper.ingestor.handler.WebScraperIngestor")
    def test_scheduled_run_passes_no_execution_id(
        self, MockIngestor, lambda_context
    ):
        """A workspace's scheduled run: the fan-out's invoke names only the workspace."""
        from webscraper.ingestor.handler import lambda_handler
        MockIngestor.return_value.run.return_value = {"status": "success"}

        lambda_handler(ws_event(), lambda_context)

        MockIngestor.assert_called_once_with(
            SCOPE, execution_id=None, target_scraper_id=None
        )

    @patch("_shared.base_ingestor.get_dynamodb_resource")
    @patch("_shared.base_ingestor.get_s3_client", new=MagicMock())
    @patch("_shared.base_ingestor.get_sqs_client", new=MagicMock())
    @patch("_shared.base_ingestor.get_secret")
    @patch("_shared.base_ingestor.clear_secret_cache")
    def test_manual_construction_clears_cache_before_config_read(
        self, mock_clear, mock_get_secret, mock_dynamo
    ):
        """End-to-end through the REAL WebScraperIngestor: constructing with
        an execution_id clears the cache before the secret/config is read."""
        call_order = []
        mock_clear.side_effect = lambda: call_order.append("clear")

        def record_get_secret(_arn):
            call_order.append("get_secret")
            return scoped_secret(configs="[]")

        mock_get_secret.side_effect = record_get_secret
        mock_dynamo.return_value.Table.return_value = MagicMock()

        from webscraper.ingestor.handler import WebScraperIngestor
        ingestor = WebScraperIngestor(SCOPE, execution_id="exec-1", target_scraper_id="s1")

        assert call_order == ["clear", "get_secret"]
        # The secret read is the workspace's own.
        mock_get_secret.assert_called_once_with(SECRET_NAME)
        assert ingestor.execution_id == "exec-1"


class TestLambdaHandlerWorkspace:
    """The handler runs in the workspace its event names, deployment-wide when it names none, and refuses a
    malformed one (``run_in_workspace``)."""

    @pytest.mark.parametrize("event", [
        *EVENTS_WITH_A_MALFORMED_WORKSPACE,
        {"workspace_id": "not-a-workspace", "execution_id": "exec-1", "scraper_id": "s1"},
    ])
    @patch("webscraper.ingestor.handler.WebScraperIngestor")
    def test_an_event_naming_a_malformed_workspace_is_refused_and_constructs_nothing(
        self, MockIngestor, event, lambda_context
    ):
        from webscraper.ingestor.handler import lambda_handler

        assert lambda_handler(event, lambda_context) == REFUSED
        MockIngestor.assert_not_called()

    @pytest.mark.parametrize(("event", "kwargs"), [
        *((event, {"execution_id": event.get("execution_id"), "target_scraper_id": None})
          for event in EVENTS_NAMING_NO_WORKSPACE),
        # POST /scrapers/{id}/run (lambda/api/scrapers_handler.py run_scraper).
        (SCRAPERS_API_RUN, {"execution_id": SCRAPER_RUN_ID, "target_scraper_id": "s1"}),
        (None, {"execution_id": None, "target_scraper_id": None}),
        ([], {"execution_id": None, "target_scraper_id": None}),
    ])
    @patch("_shared.base_ingestor.fan_out_once")
    @patch("webscraper.ingestor.handler.WebScraperIngestor")
    def test_an_event_naming_no_workspace_runs_deployment_wide(
        self, MockIngestor, fan_out, event, kwargs, lambda_context
    ):
        from webscraper.ingestor.handler import lambda_handler
        MockIngestor.return_value.run.return_value = {"status": "success", "items_processed": 2}

        assert lambda_handler(event, lambda_context) == {"status": "success", "items_processed": 2}
        MockIngestor.assert_called_once_with(None, **kwargs)
        MockIngestor.return_value.run.assert_called_once_with()
        fan_out.assert_not_called()

    @patch("webscraper.ingestor.handler.WebScraperIngestor")
    def test_the_events_scope_execution_id_and_scraper_id_reach_the_ingestor(
        self, MockIngestor, lambda_context
    ):
        from webscraper.ingestor.handler import lambda_handler
        MockIngestor.return_value.run.return_value = {"status": "success"}

        result = lambda_handler(
            {"workspace_id": OTHER_WS, "execution_id": "exec-9", "scraper_id": "s9"}, lambda_context
        )

        assert result == {"status": "success"}
        (scope,), kwargs = MockIngestor.call_args
        assert MockIngestor.call_count == 1
        assert scope.ws == OTHER_WS
        assert kwargs == {"execution_id": "exec-9", "target_scraper_id": "s9"}
        MockIngestor.return_value.run.assert_called_once_with()

    @patch("webscraper.ingestor.handler.WebScraperIngestor")
    def test_the_scheduled_tick_fans_out_then_runs_deployment_wide(self, MockIngestor, lambda_context):
        from webscraper.ingestor.handler import lambda_handler
        MockIngestor.return_value.run.return_value = {"status": "success", "items_processed": 2}

        result, order = fan_out_then_run(
            MockIngestor.return_value.run, lambda: lambda_handler(dict(SCHEDULED_TICK), lambda_context))

        assert result == {"status": "success", "items_processed": 2}
        MockIngestor.assert_called_once_with(None, execution_id=None, target_scraper_id=None)
        assert order == list(TICK_ORDER)


class TestTheScrapersApiRunIsDeploymentWide:
    """``POST /scrapers/{id}/run`` invokes the webscraper with ``scraper_id`` and ``execution_id`` and no workspace:
    the run reads the shared secret and closes the deployment-wide rows the API wrote and polls."""

    @staticmethod
    def _run() -> tuple[dict, MagicMock, MagicMock, MagicMock]:
        from _shared import base_ingestor
        from webscraper.ingestor.handler import lambda_handler

        config = {"id": "s1", "name": "Sample shop", "urls": ["https://shop.example.com/reviews"]}
        item = {"id": "r1", "text": "Great product", "created_at": "2026-11-01T00:00:00Z"}
        table = MagicMock()
        context = MagicMock(function_name="test-webscraper", memory_limit_in_mb=512,
                            invoked_function_arn="arn:aws:lambda:us-east-1:123456789:function:test",
                            aws_request_id="req-1")
        with (
            offline_ingestor_construction(),
            patch("_shared.base_ingestor.AGGREGATES_TABLE", "voc-aggregates"),
            patch("_shared.base_ingestor.get_dynamodb_resource") as dynamo,
            patch("_shared.base_ingestor.get_secret",
                  return_value=scoped_secret(configs=json.dumps([config]))) as get_secret,
            patch("_shared.base_ingestor.get_sqs_client") as get_sqs,
            patch("_shared.base_ingestor.CircuitBreaker") as breaker,
            patch("_shared.base_ingestor.emit_audit_event"),
            patch("_shared.base_ingestor.fan_out_once") as fan_out,
            patch("webscraper.ingestor.handler.WebScraperIngestor._scrape_page", return_value=iter([item])),
            patch("webscraper.ingestor.handler.time.sleep"),
        ):
            dynamo.return_value.Table.return_value = table
            get_sqs.return_value.send_message_batch.side_effect = echo_batch_success
            breaker.return_value.is_open.return_value = False
            result = lambda_handler(dict(SCRAPERS_API_RUN), context)
        get_secret.assert_called_once_with(base_ingestor.SECRETS_ARN)
        breaker.assert_called_once_with("test_source", None)
        fan_out.assert_not_called()
        return result, table, get_sqs.return_value, dynamo.return_value

    def test_it_closes_the_scraper_run_row_the_api_wrote(self):
        result, table, _, _ = self._run()
        assert result == {"status": "success", "items_processed": 1}
        scraper_rows = [c.kwargs for c in table.update_item.call_args_list
                        if c.kwargs["Key"]["pk"].startswith("SCRAPER_RUN#")]
        assert {tuple(sorted(row["Key"].items())) for row in scraper_rows} == {
            (("pk", "SCRAPER_RUN#s1"), ("sk", SCRAPER_RUN_ID)),
        }
        last = scraper_rows[-1]
        values = {last["ExpressionAttributeNames"][name]: last["ExpressionAttributeValues"][f":{name[1:]}"]
                  for name in last["ExpressionAttributeNames"]}
        assert (values["status"], values["items_found"], values["errors"]) == ("completed", 1, [])

    def test_its_source_run_row_is_the_deployment_wide_one(self):
        _, table, _, _ = self._run()
        keys = {tuple(sorted(c.kwargs["Key"].items())) for c in table.update_item.call_args_list}
        assert keys == {
            (("pk", "SCRAPER_RUN#s1"), ("sk", SCRAPER_RUN_ID)),
            (("pk", "SOURCE_RUN#test_source"), ("sk", SCRAPER_RUN_ID)),
        }
        assert not any(key[0][1].startswith("WS#") for key in keys)

    def test_its_messages_name_no_workspace_and_its_watermark_is_deployment_wide(self):
        _, table, sqs, _ = self._run()
        (batch,) = sqs.send_message_batch.call_args_list
        (entry,) = batch.kwargs["Entries"]
        assert "workspace_id" not in json.loads(entry["MessageBody"])
        sources = {c.kwargs["Item"]["source"] for c in table.put_item.call_args_list}
        assert sources == {"test_source#scraper_s1_last_run", "test_source#last_id"}


class TestScraperRunRowIsTheWorkspaces:
    """A manual run's progress row lives in its workspace's partition: two workspaces never share one."""

    @staticmethod
    def _run_row_key(ws: str) -> dict:
        from shared.ws_repo import WorkspaceScope
        with offline_ingestor_construction(), \
             patch("_shared.base_ingestor.AGGREGATES_TABLE", "voc-aggregates"), \
             patch("_shared.base_ingestor.get_dynamodb_resource") as dynamo:
            table = MagicMock()
            dynamo.return_value.Table.return_value = table
            from webscraper.ingestor.handler import WebScraperIngestor
            ingestor = WebScraperIngestor(WorkspaceScope(ws), execution_id="exec-1", target_scraper_id="s1")
        ingestor._update_run_status("s1", {"status": "running"})
        table.update_item.assert_called_once()
        return table.update_item.call_args.kwargs["Key"]

    def test_the_row_of_a_run_in_each_workspace_is_that_workspaces(self):
        assert self._run_row_key(WS) == {"pk": f"WS#{WS}#SCRAPER_RUN#s1", "sk": "exec-1"}
        assert self._run_row_key(OTHER_WS) == {"pk": f"WS#{OTHER_WS}#SCRAPER_RUN#s1", "sk": "exec-1"}


# ---------------------------------------------------------------------------
# Outbound URL policy at fetch time (issue #244)
# ---------------------------------------------------------------------------

def _http_response(status, body='', location=None):
    response = MagicMock()
    response.status_code = status
    response.text = body
    response.headers = {'Location': location} if location else {}
    return response


_PUBLIC_DNS = [(2, 1, 6, '', ('93.184.216.34', 0))]
_REVIEW_PAGE = '<div class="review"><p class="review-text">Great product, would buy again</p></div>'


class TestFetchEnforcesUrlPolicy:
    """The scheduled/manual run re-checks every URL and redirect hop before
    requesting it, even when the stored config was never validated."""

    @patch("shared.http_utils.requests.Session.request")
    def test_a_configured_metadata_url_is_never_requested(self, mock_request, ingestor):
        from shared.http_utils import UnsafeURLError

        with pytest.raises(UnsafeURLError):
            ingestor._fetch_soup('http://169.254.169.254/latest/meta-data/')
        mock_request.assert_not_called()

    @patch("shared.http_utils.requests.Session.request")
    def test_a_redirect_to_the_metadata_ip_is_not_followed(self, mock_request, ingestor):
        from shared.http_utils import UnsafeURLError

        mock_request.return_value = _http_response(302, location='http://169.254.169.254/latest/api/token')
        with patch('shared.url_policy.socket.getaddrinfo', return_value=_PUBLIC_DNS), \
             pytest.raises(UnsafeURLError):
            ingestor._fetch_soup('https://shop.example/reviews')
        assert mock_request.call_count == 1
        assert mock_request.call_args.kwargs['allow_redirects'] is False

    def test_a_dns_rebind_to_the_runtime_api_never_connects(self, ingestor):
        """Public to the check, 127.0.0.1 to the connect: refused, no socket opened (real requests stack)."""
        from shared.http_utils import UnsafeURLError

        answers = iter(['93.184.216.34', '127.0.0.1'])

        def rebinding(_host, port, *_args, **_kwargs):
            return [(2, 1, 6, '', (next(answers, '127.0.0.1'), port or 0))]

        with patch('shared.url_policy.socket.getaddrinfo', side_effect=rebinding), \
             patch('shared.url_policy.socket.create_connection') as connect, \
             pytest.raises(UnsafeURLError):
            ingestor._fetch_soup('http://shop.example:9001/2018-06-01/runtime/invocation/next')
        connect.assert_not_called()

    @patch("webscraper.ingestor.handler.time.sleep", new=MagicMock())
    @patch("shared.http_utils.requests.Session.request")
    def test_a_blocked_url_fails_alone_and_the_run_continues(self, mock_request, ingestor):
        def resolver(host, *_args, **_kwargs):
            ip = '10.0.0.9' if host == 'intranet.example' else '93.184.216.34'
            return [(2, 1, 6, '', (ip, 0))]

        mock_request.return_value = _http_response(200, _REVIEW_PAGE)
        ingestor.scraper_configs = [{
            'id': 's1', 'name': 'Mixed',
            'urls': ['https://intranet.example/admin', 'https://shop.example/reviews'],
        }]
        ingestor.execution_id = 'exec-1'
        status_updates = []
        ingestor._update_run_status = lambda _sid, updates: status_updates.append(updates)
        ingestor.set_watermark = MagicMock()

        with patch('shared.url_policy.socket.getaddrinfo', side_effect=resolver):
            items = list(ingestor.fetch_new_items())

        assert [i['url'] for i in items] == ['https://shop.example/reviews']
        assert [c.kwargs['url'] for c in mock_request.call_args_list] == ['https://shop.example/reviews']
        final = status_updates[-1]
        assert final['status'] == 'completed_with_errors'
        assert len(final['errors']) == 1
        assert 'https://intranet.example/admin' in final['errors'][0]
        assert final['errors'][0] == (
            'Error scraping https://intranet.example/admin: URL blocked by policy '
            '(Access to internal/private IP addresses is not allowed)'
        )

    @patch("webscraper.ingestor.handler.time.sleep", new=MagicMock())
    def test_a_failing_page_records_the_exception_class_not_its_text(self, ingestor):
        """Run errors are readable by every user via GET /logs/scraper/*: no str(e)."""
        ingestor.scraper_configs = [{'id': 's1', 'name': 'Broken', 'urls': ['https://shop.example/reviews']}]
        ingestor.execution_id = 'exec-1'
        status_updates = []
        ingestor._update_run_status = lambda _sid, updates: status_updates.append(updates)
        ingestor.set_watermark = MagicMock()
        ingestor._scrape_page = MagicMock(side_effect=KeyError('review by jane.doe@example.com'))

        list(ingestor.fetch_new_items())

        assert status_updates[-1]['errors'] == ['Error scraping https://shop.example/reviews: KeyError']


# ---------------------------------------------------------------------------
# 'Manual only' schedule: frequency_minutes 0
# ---------------------------------------------------------------------------

class TestManualOnlySchedule:
    """`frequency_minutes: 0` is 'Manual only' in the Scrapers UI: a scheduled tick
    must never run it, however long ago (or whether) it last ran; a manual run
    (`execution_id`) still does."""

    @pytest.mark.parametrize('last_run', [None, '2000-01-01T00:00:00+00:00'])
    def test_a_manual_only_scraper_is_never_due(self, ingestor, last_run):
        ingestor.get_watermark = MagicMock(return_value=last_run)

        assert ingestor._should_run_scraper({'id': 's1', 'frequency_minutes': 0}) is False

    def test_a_scheduled_tick_skips_it(self, ingestor):
        ingestor.scraper_configs = [{'id': 's1', 'frequency_minutes': 0, 'urls': ['https://shop.example/r']}]
        ingestor.get_watermark = MagicMock(return_value=None)
        ingestor._scrape_page = MagicMock(return_value=[])

        assert list(ingestor.fetch_new_items()) == []
        ingestor._scrape_page.assert_not_called()

    @patch("webscraper.ingestor.handler.time.sleep", new=MagicMock())
    def test_a_manual_run_still_scrapes_it(self, ingestor):
        ingestor.scraper_configs = [{'id': 's1', 'frequency_minutes': 0, 'urls': ['https://shop.example/r']}]
        ingestor.execution_id = 'exec-1'
        ingestor.target_scraper_id = 's1'
        ingestor._update_run_status = MagicMock()
        ingestor.set_watermark = MagicMock()
        ingestor._scrape_page = MagicMock(return_value=[{'id': 'r1'}])

        assert list(ingestor.fetch_new_items()) == [{'id': 'r1'}]
        ingestor._scrape_page.assert_called_once()


# ---------------------------------------------------------------------------
# Scraper dimension defaults and tags travel on every message
# ---------------------------------------------------------------------------

def _scraped(ingestor, config):
    """One scraped review of scraper `s1` with `config` merged in."""
    return ingestor._scraped_item(
        {'id': 's1', 'name': 'Shop', **config}, 'https://shop.example/reviews',
        item_url='https://shop.example/r/1', extraction_method='css', channel='web',
        title='', text='Great', rating=5, created_at='2026-01-15T00:00:00+00:00', author='A')


class TestScraperLabels:
    def _item(self, ingestor, config):
        return _scraped(ingestor, config)

    def test_defaults_and_tags_become_message_labels(self, ingestor):
        item = self._item(ingestor, {'dimension_defaults': {'product': 'app'}, 'tags': ['vip', 'VIP']})
        assert (item['dimensions'], item['tags']) == ({'product': 'app'}, ['vip'])

    def test_a_scraper_without_them_adds_neither(self, ingestor):
        assert not {'dimensions', 'tags'} & set(self._item(ingestor, {}))


class TestScraperRadarBrand:
    """A scraper naming a Radar brand stamps its reviews with `radar_brand_key` (docs/radar.md)."""

    def _item(self, ingestor, config):
        return _scraped(ingestor, config)

    def test_a_radar_scraper_stamps_every_review(self, ingestor):
        assert self._item(ingestor, {'radar_brand': 'initech'})['radar_brand_key'] == 'initech'

    def test_an_ordinary_scraper_carries_no_key(self, ingestor):
        assert 'radar_brand_key' not in self._item(ingestor, {'radar_brand': ''})

    def test_the_key_reaches_the_queue_message(self, ingestor):
        with patch.object(ingestor, 'store_raw_to_s3', return_value='s3://b/k'):
            message = ingestor.normalize_item(self._item(ingestor, {'radar_brand': 'initech'}))
        assert message['radar_brand_key'] == 'initech'
