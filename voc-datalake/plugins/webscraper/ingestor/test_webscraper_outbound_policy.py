"""
The scheduled ingestor must re-check every destination it fetches (issue #244).

Configurations are checked on write by the scrapers API, but this Lambda runs on
a schedule with an execution role and fetches a config saved possibly months
earlier, so the check is repeated here, immediately before each request, and on
every redirect hop. Both sides call the SAME
`shared.http_utils.assert_outbound_url_allowed` — that is the point of the
issue, and `TestOnePolicyForBothCallSites` below asserts it rather than trusting
this docstring.

REVERT MAP
----------
- Put `fetch_with_retry` back in `_scrape_page` (no per-fetch check, redirects
  followed by requests) -> `refuses_a_host_that_resolves_internally`,
  `refuses_a_redirect_from_a_public_page_into_an_internal_one`.
- Catch `OutboundUrlBlocked` inside `_scrape_page` as a fetch failure, or make
  it a `requests.RequestException` subclass -> `records_a_blocked_url_in_the_run_errors`
  (the URL would be skipped with a warning and the run would report success).
- Duplicate the policy into this plugin instead of importing it
  -> `TestOnePolicyForBothCallSites`.
- Drop the ScraperOutboundUrlBlocked counter -> `emits_a_metric_when_a_destination_is_blocked`.
- Drop `total_timeout` from the fetch, so one stalling URL can spend ~294 s of the
  300 s invocation and the run's final status write is lost
  -> `keeps_one_stalling_url_inside_its_budget`,
  `a_stalling_url_does_not_stop_the_next_one`.
- Tighten the budget until an ordinary page cannot load
  -> `a_healthy_page_is_unaffected_by_the_budget`.
- Drop the RUN budget, so N URLs each get a fresh page budget and their sum
  (measured 450 s for 10 paginated URLs) overruns the 300 s invocation
  -> `keeps_a_whole_stalling_config_inside_the_run_budget`.
- Take the run deadline per config instead of once, so it multiplies by config
  count -> `keeps_several_stalling_configs_inside_one_run_budget`.
- Break out of the URL loop without recording the truncation, so a partial run
  reports `completed` -> `records_the_truncation_in_the_run_errors`.
- Break BEFORE the terminal `_update_run_status`, recreating the abandoned
  `running` row -> `keeps_a_whole_stalling_config_inside_the_run_budget`.
- Make the run budget bite ordinary work
  -> `healthy_configs_are_unaffected_by_the_run_budget`.
- Count an unfetched page toward `pages_scraped`, making an all-timeout run
  indistinguishable from an empty healthy one
  -> `a_run_whose_every_page_timed_out_does_not_report_a_clean_completion`.

Nothing here touches the network: resolution and HTTP are patched at
`shared.http_utils`'s import boundary, which is where the ingestor's fetch
resolves them.
"""

from unittest.mock import MagicMock, patch

import pytest
from requests.structures import CaseInsensitiveDict

PUBLIC_ADDRINFO = [(2, 1, 6, '', ('93.184.216.34', 80))]
INTERNAL_ADDRINFO = [(2, 1, 6, '', ('169.254.169.254', 80))]

CSS_CONFIG = {
    'id': 's1',
    'name': 'Reviews',
    'extraction_method': 'css',
    'container_selector': '.review',
    'text_selector': '.review-text',
}

REVIEW_HTML = (
    '<html><div class="review">'
    '<span class="review-text">A genuinely long enough review body.</span>'
    '</div></html>'
)


def _response(status: int, *, location: str | None = None, text: str = '') -> MagicMock:
    response = MagicMock()
    response.status_code = status
    response.reason = 'reason'
    # CaseInsensitiveDict, not a plain dict: a real requests.Response is one,
    # and a real server may send `location:` lowercase — a plain-dict double
    # would pass against code reading from a case-SENSITIVE mapping.
    response.headers = CaseInsensitiveDict({'Location': location} if location else {})
    response.text = text
    return response


@pytest.fixture
def ingestor():
    """A real WebScraperIngestor with AWS mocked at the import boundary."""
    with (
        patch('_shared.base_ingestor.get_dynamodb_resource') as mock_dynamo,
        patch('_shared.base_ingestor.get_s3_client'),
        patch('_shared.base_ingestor.get_sqs_client'),
        patch('_shared.base_ingestor.get_secret', return_value={}),
    ):
        mock_dynamo.return_value.Table.return_value = MagicMock()
        from webscraper.ingestor.handler import WebScraperIngestor
        return WebScraperIngestor()


class TestScrapePageChecksEveryDestination:
    """`_scrape_page` fetches only through the checked client."""

    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_a_host_that_resolves_internally(
        self, mock_resolve, mock_request, ingestor
    ):
        """A saved host can start resolving internally after it was approved."""
        from shared.http_utils import OutboundUrlBlocked

        mock_resolve.return_value = INTERNAL_ADDRINFO

        with pytest.raises(OutboundUrlBlocked, match='internal/private'):
            list(ingestor._scrape_page(CSS_CONFIG, 'https://reviews.example.com/'))

        mock_request.assert_not_called()

    @pytest.mark.parametrize('url', [
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.5/reviews',
        'http://[::1]/reviews',
        'http://[fd00::1]/reviews',
    ])
    @patch('shared.http_utils.requests.request')
    def test_refuses_direct_internal_targets_in_both_families(
        self, mock_request, url, ingestor
    ):
        from shared.http_utils import OutboundUrlBlocked

        with pytest.raises(OutboundUrlBlocked, match='internal/private'):
            list(ingestor._scrape_page(CSS_CONFIG, url))

        mock_request.assert_not_called()

    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_a_redirect_from_a_public_page_into_an_internal_one(
        self, mock_resolve, mock_request, ingestor
    ):
        """
        The bypass in issue #244: an allowed public page 302s to the metadata
        endpoint. Letting requests follow redirects makes this return HTML the
        policy never cleared, and the items get ingested.
        """
        from shared.http_utils import OutboundUrlBlocked

        def resolve(hostname, *_args, **_kwargs):
            return PUBLIC_ADDRINFO if hostname == 'example.com' else INTERNAL_ADDRINFO

        mock_resolve.side_effect = resolve
        mock_request.return_value = _response(
            302, location='http://metadata.internal/latest/meta-data/'
        )

        with pytest.raises(OutboundUrlBlocked, match='internal/private'):
            list(ingestor._scrape_page(CSS_CONFIG, 'https://example.com/reviews'))

        # Refused before the second send: exactly one request left the Lambda.
        assert mock_request.call_count == 1

    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_never_lets_the_http_client_follow_a_redirect(
        self, mock_resolve, mock_request, ingestor
    ):
        mock_resolve.return_value = PUBLIC_ADDRINFO
        mock_request.return_value = _response(200, text=REVIEW_HTML)

        list(ingestor._scrape_page(CSS_CONFIG, 'https://example.com/reviews'))

        assert mock_request.call_args.kwargs['allow_redirects'] is False

    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_scrapes_a_public_page_as_before(self, mock_resolve, mock_request, ingestor):
        """
        Positive control: ordinary public scraping is unchanged. Without it, an
        ingestor that refused every URL would pass every test above.
        """
        mock_resolve.return_value = PUBLIC_ADDRINFO
        mock_request.return_value = _response(200, text=REVIEW_HTML)

        items = list(ingestor._scrape_page(CSS_CONFIG, 'https://example.com/reviews'))

        assert len(items) == 1
        assert 'genuinely long enough review body' in items[0]['text']
        assert items[0]['domain'] == 'example.com'
        assert mock_request.call_args.kwargs['timeout'] == 15

    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_follows_a_public_redirect_and_scrapes_the_final_page(
        self, mock_resolve, mock_request, ingestor
    ):
        """A site's own http->https or /page/1 redirect must still be followed."""
        mock_resolve.return_value = PUBLIC_ADDRINFO
        mock_request.side_effect = [
            _response(301, location='https://example.com/reviews/'),
            _response(200, text=REVIEW_HTML),
        ]

        items = list(ingestor._scrape_page(CSS_CONFIG, 'http://example.com/reviews'))

        assert len(items) == 1
        assert mock_request.call_count == 2

    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_still_treats_a_403_as_a_skipped_page(
        self, mock_resolve, mock_request, ingestor
    ):
        """The pre-existing bot-block path is untouched: no items, no exception."""
        mock_resolve.return_value = PUBLIC_ADDRINFO
        mock_request.return_value = _response(403)

        assert list(ingestor._scrape_page(CSS_CONFIG, 'https://example.com/reviews')) == []

    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_still_swallows_a_transport_failure(self, mock_resolve, mock_request, ingestor):
        """A page that will not load is still a warning-and-continue, not a raise."""
        import requests

        mock_resolve.return_value = PUBLIC_ADDRINFO
        mock_request.side_effect = requests.exceptions.ConnectionError('refused')

        assert list(ingestor._scrape_page(CSS_CONFIG, 'https://example.com/reviews')) == []


class TestScrapePageBoundsOneUrlsCostOfTheInvocation:
    """
    One stalling URL must not be able to consume the scheduled run.

    `manifest.json` gives this Lambda 300 s and one config may name
    MAX_SCRAPER_URLS (50) URLs inside it. A per-request timeout bounds nothing
    across that: the checked walk is MAX_REDIRECT_HOPS + 1 hops and each is
    retried RETRY_MAX_ATTEMPTS times, which measured ~294 s for a single URL at
    the old bare `timeout=15`.

    The consequence is worse than losing a page, which is why a wall-clock budget
    is the fix and not a shorter per-request timeout: the invocation is killed
    inside `fetch_new_items`, so the final `_update_run_status` never runs and the
    run row stays at `status: 'running'` for ever.
    """

    @patch('tenacity.nap.time.sleep')
    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_keeps_one_stalling_url_inside_its_budget(
        self, mock_resolve, mock_request, mock_sleep, ingestor
    ):
        """
        Measured on a fake clock: the double consumes its whole timeout and the
        retry backoff advances the same clock, so this reads the real arithmetic
        without spending a minute of wall time on it.
        """
        import requests
        from webscraper.ingestor.handler import SCRAPE_PAGE_TOTAL_TIMEOUT_SECONDS

        mock_resolve.return_value = PUBLIC_ADDRINFO
        now = [1000.0]

        def stall(**kwargs):
            now[0] += kwargs['timeout']      # the host holds the connection open
            raise requests.exceptions.Timeout('stalled')

        mock_request.side_effect = stall
        mock_sleep.side_effect = lambda seconds: now.__setitem__(0, now[0] + seconds)

        with patch('shared.http_utils.time.monotonic', lambda: now[0]):
            items = list(ingestor._scrape_page(CSS_CONFIG, 'https://slow.example/reviews'))

        spent = now[0] - 1000.0
        assert spent <= SCRAPE_PAGE_TOTAL_TIMEOUT_SECONDS, (
            f'one URL spent {spent}s of the 300s invocation'
        )
        # Still a warn-and-continue: the Timeout is a RequestException, so
        # `_scrape_page` swallows it and the run's other URLs get their turn.
        assert items == []

    @patch('tenacity.nap.time.sleep')
    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_a_stalling_url_does_not_stop_the_next_one(
        self, mock_resolve, mock_request, mock_sleep, ingestor
    ):
        """
        The budget must end the URL, not the run — and the run must still write
        its final status, which is what a killed invocation loses.
        """
        import requests

        mock_resolve.return_value = PUBLIC_ADDRINFO
        now = [1000.0]

        def stall_then_serve(**kwargs):
            if 'slow.example' in kwargs['url']:
                now[0] += kwargs['timeout']
                raise requests.exceptions.Timeout('stalled')
            return _response(200, text=REVIEW_HTML)

        mock_request.side_effect = stall_then_serve
        mock_sleep.side_effect = lambda seconds: now.__setitem__(0, now[0] + seconds)

        ingestor.execution_id = 'exec-1'
        ingestor.target_scraper_id = 's1'
        ingestor.scraper_configs = [{
            **CSS_CONFIG,
            'urls': ['https://slow.example/reviews', 'https://good.example/reviews'],
        }]

        statuses = []
        with (
            patch('shared.http_utils.time.monotonic', lambda: now[0]),
            patch.object(ingestor, '_update_run_status', lambda _id, u: statuses.append(u)),
            patch.object(ingestor, 'set_watermark'),
            patch('webscraper.ingestor.handler.time.sleep'),
        ):
            items = list(ingestor.fetch_new_items())

        assert len(items) == 1, 'the second URL was never reached'
        assert statuses[-1]['status'] in ('completed', 'completed_with_errors')
        assert statuses[-1]['completed_at']

    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_a_healthy_page_is_unaffected_by_the_budget(
        self, mock_resolve, mock_request, ingestor
    ):
        """
        Positive control. A budget short enough to bite a healthy page would look
        like this test passing while ordinary scraping silently degraded, so the
        per-request timeout must still be what a fast page sees.
        """
        from webscraper.ingestor.handler import SCRAPE_PAGE_HOP_TIMEOUT_SECONDS

        mock_resolve.return_value = PUBLIC_ADDRINFO
        mock_request.return_value = _response(200, text=REVIEW_HTML)

        items = list(ingestor._scrape_page(CSS_CONFIG, 'https://example.com/reviews'))

        assert len(items) == 1
        assert mock_request.call_args.kwargs['timeout'] == SCRAPE_PAGE_HOP_TIMEOUT_SECONDS


class TestRunBoundsTheWholeInvocation:
    """
    The per-page budget bounds a page; this bounds the INVOCATION, which is what
    the Lambda's 300 s timeout is compared against.

    Nothing summed the pages, and the sum is what gets the invocation killed:
    a config with `pagination.max_pages: 10` yields 10 URLs and measured 450 s,
    MAX_SCRAPER_URLS (50) URLs ~2450 s. So the abandoned `status: 'running'` row
    the per-page budget was added to prevent needed 6 stalling URLs instead of 1.

    Invocation-wide rather than per-config because `fetch_new_items` iterates every
    due config in one invocation — `keeps_several_stalling_configs_inside_one_run_
    budget` is the case a per-config budget would fail.

    The clock is faked: the transport double consumes its whole timeout, tenacity's
    backoff and the inter-page pause advance the same clock, so these read the real
    arithmetic without spending minutes of wall time. `shared.http_utils.time` and
    the handler's `time` are the same module object, so one patch drives both.
    """

    @staticmethod
    def _run_on_a_fake_clock(ingestor, configs, *, serve=None):
        """
        Run `fetch_new_items` over `configs` with a stalling transport.

        Returns (seconds of simulated wall clock spent, items, status writes).

        Args:
            serve: optional `url -> response or None` hook. Returning None (the
                default for every URL) stalls: the host holds the connection for
                the full timeout and then times out, which is the shape that makes
                a per-page budget insufficient.
        """
        import requests

        now = [1000.0]

        def transport(**kwargs):
            served = serve(kwargs['url']) if serve else None
            if served is not None:
                return served
            now[0] += kwargs['timeout']
            raise requests.exceptions.Timeout('stalled')

        ingestor.execution_id = 'exec-1'
        ingestor.scraper_configs = configs

        statuses = []
        with (
            patch('shared.http_utils.requests.request', side_effect=transport),
            patch('shared.http_utils.socket.getaddrinfo', return_value=PUBLIC_ADDRINFO),
            patch('shared.http_utils.time.monotonic', lambda: now[0]),
            patch('tenacity.nap.time.sleep', lambda s: now.__setitem__(0, now[0] + s)),
            patch(
                'webscraper.ingestor.handler.time.sleep',
                lambda s: now.__setitem__(0, now[0] + s),
            ),
            patch.object(
                ingestor, '_update_run_status', lambda _id, u: statuses.append(u)
            ),
            patch.object(ingestor, 'set_watermark'),
        ):
            items = list(ingestor.fetch_new_items())

        return now[0] - 1000.0, items, statuses

    def test_keeps_a_whole_stalling_config_inside_the_run_budget(self, ingestor):
        """
        The reviewer's measurement: 10 paginated stalling URLs — the `max_pages`
        the shipped templates use — spent 450 s against a 300 s invocation, so the
        terminal status write never happened. It must now both fit the budget AND
        still write a terminal status, because the budget's whole purpose is to
        leave time for that write.
        """
        from webscraper.ingestor.handler import SCRAPE_RUN_TOTAL_TIMEOUT_SECONDS

        spent, _items, statuses = self._run_on_a_fake_clock(ingestor, [{
            **CSS_CONFIG,
            'base_url': 'https://slow.example/reviews',
            'pagination': {'enabled': True, 'max_pages': 10},
        }])

        assert spent <= SCRAPE_RUN_TOTAL_TIMEOUT_SECONDS, (
            f'one config spent {spent}s of the 300s invocation'
        )
        assert statuses, 'the run wrote no status at all'
        assert statuses[-1]['status'] == 'completed_with_errors'
        assert statuses[-1]['completed_at']

    def test_keeps_several_stalling_configs_inside_one_run_budget(self, ingestor):
        """
        One invocation processes EVERY due config, so a per-config budget would
        multiply by config count and bound nothing — measured 5 configs x 2
        stalling URLs = 450 s. This is the case that distinguishes an
        invocation-wide deadline from a per-config one.
        """
        from webscraper.ingestor.handler import SCRAPE_RUN_TOTAL_TIMEOUT_SECONDS

        spent, _items, statuses = self._run_on_a_fake_clock(ingestor, [
            {
                **CSS_CONFIG,
                'id': f's{n}',
                'urls': [f'https://slow{n}.example/a', f'https://slow{n}.example/b'],
            }
            for n in range(5)
        ])

        assert spent <= SCRAPE_RUN_TOTAL_TIMEOUT_SECONDS, (
            f'5 configs spent {spent}s of the 300s invocation'
        )
        assert statuses[-1]['completed_at'], 'no config wrote a terminal status'

    def test_records_the_truncation_in_the_run_errors(self, ingestor):
        """
        A truncated run must not look like a finished one. Reporting `completed`
        over a partial URL set would hide precisely the truncation this budget
        introduces, and the URL count is what tells an operator how much was
        skipped.
        """
        _spent, _items, statuses = self._run_on_a_fake_clock(ingestor, [{
            **CSS_CONFIG,
            'base_url': 'https://slow.example/reviews',
            'pagination': {'enabled': True, 'max_pages': 10},
        }])

        final = statuses[-1]
        assert final['status'] == 'completed_with_errors'
        assert any('Run budget' in e and 'not attempted' in e for e in final['errors']), (
            f'the truncation was not recorded: {final["errors"]}'
        )

    def test_a_run_whose_every_page_timed_out_does_not_report_a_clean_completion(
        self, ingestor
    ):
        """
        Pre-existing before this budget, and made more reachable by it: every
        attempted URL counted as `pages_scraped`, so an all-timeout run reported
        `completed`, `errors: []` and a non-zero page count — indistinguishable
        from an empty but healthy run.

        Two URLs only, so the run budget is NOT the thing being measured here.
        """
        _spent, items, statuses = self._run_on_a_fake_clock(ingestor, [{
            **CSS_CONFIG,
            'urls': ['https://slow.example/a', 'https://slow.example/b'],
        }])

        final = statuses[-1]
        assert items == []
        assert final['pages_scraped'] == 0, (
            'a page that never loaded was counted as scraped'
        )

    def test_healthy_configs_are_unaffected_by_the_run_budget(self, ingestor):
        """
        Positive control. A run budget that truncated ordinary work would pass
        every assertion above while silently halving what the platform ingests, so
        several healthy configs must still scrape every URL and yield every item.
        """
        configs = [
            {**CSS_CONFIG, 'id': f's{n}', 'urls': [f'https://ok{n}.example/a',
                                                   f'https://ok{n}.example/b']}
            for n in range(3)
        ]

        _spent, items, statuses = self._run_on_a_fake_clock(
            ingestor, configs, serve=lambda _url: _response(200, text=REVIEW_HTML)
        )

        assert len(items) == 6, 'a healthy run was truncated'
        assert statuses[-1]['status'] == 'completed'
        assert statuses[-1]['pages_scraped'] == 2
        assert statuses[-1]['errors'] == []


class TestRunReportsABlockedUrl:
    """A blocked destination must be visible in the run, not silently skipped."""

    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_records_a_blocked_url_in_the_run_errors(
        self, mock_resolve, mock_request, ingestor
    ):
        """
        `fetch_new_items` wraps each URL in `except Exception`, so the blocked
        URL is skipped and the scraper's other URLs continue — but the reason
        lands in `errors` and the run reports `completed_with_errors`.

        This is what `OutboundUrlBlocked` not being a `RequestException` buys:
        `_scrape_page`'s own handler would otherwise absorb it and the run would
        report a clean success.
        """
        def resolve(hostname, *_args, **_kwargs):
            return PUBLIC_ADDRINFO if hostname == 'good.example' else INTERNAL_ADDRINFO

        mock_resolve.side_effect = resolve
        mock_request.return_value = _response(200, text=REVIEW_HTML)

        ingestor.execution_id = 'exec-1'
        ingestor.target_scraper_id = 's1'
        ingestor.scraper_configs = [{
            **CSS_CONFIG,
            'urls': ['https://good.example/reviews', 'https://sneaky.example/reviews'],
        }]

        statuses = []
        with (
            patch.object(ingestor, '_update_run_status', lambda _id, u: statuses.append(u)),
            patch.object(ingestor, 'set_watermark'),
            patch('webscraper.ingestor.handler.time.sleep'),
        ):
            items = list(ingestor.fetch_new_items())

        # The public URL was still scraped.
        assert len(items) == 1

        final = statuses[-1]
        assert final['status'] == 'completed_with_errors'
        assert any('sneaky.example' in e for e in final['errors'])
        assert any('internal/private' in e for e in final['errors'])

    @patch('webscraper.ingestor.handler.metrics')
    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_emits_a_metric_when_a_destination_is_blocked(
        self, mock_resolve, mock_request, mock_metrics, ingestor
    ):
        """
        A run's `errors` list is only visible to someone opening that run. The
        case worth alerting on — a saved host that has started resolving
        internally, on every scheduled run — needs a counter, because in the run
        list it is indistinguishable from an ordinary flaky page.
        """
        mock_resolve.return_value = INTERNAL_ADDRINFO
        mock_request.return_value = _response(200, text=REVIEW_HTML)

        ingestor.execution_id = 'exec-1'
        ingestor.target_scraper_id = 's1'
        ingestor.scraper_configs = [{**CSS_CONFIG, 'urls': ['https://sneaky.example/reviews']}]

        with (
            patch.object(ingestor, '_update_run_status'),
            patch.object(ingestor, 'set_watermark'),
            patch('webscraper.ingestor.handler.time.sleep'),
        ):
            list(ingestor.fetch_new_items())

        blocked = [
            c for c in mock_metrics.add_metric.call_args_list
            if c.kwargs.get('name') == 'ScraperOutboundUrlBlocked'
        ]
        assert blocked, 'a blocked destination emitted no metric'
        assert blocked[0].kwargs['value'] == 1

    @patch('webscraper.ingestor.handler.metrics')
    @patch('shared.http_utils.requests.request')
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_emits_no_blocked_metric_on_an_ordinary_run(
        self, mock_resolve, mock_request, mock_metrics, ingestor
    ):
        """Positive control: an always-firing counter would be worse than none."""
        mock_resolve.return_value = PUBLIC_ADDRINFO
        mock_request.return_value = _response(200, text=REVIEW_HTML)

        ingestor.execution_id = 'exec-1'
        ingestor.target_scraper_id = 's1'
        ingestor.scraper_configs = [{**CSS_CONFIG, 'urls': ['https://good.example/reviews']}]

        with (
            patch.object(ingestor, '_update_run_status'),
            patch.object(ingestor, 'set_watermark'),
            patch('webscraper.ingestor.handler.time.sleep'),
        ):
            list(ingestor.fetch_new_items())

        assert not [
            c for c in mock_metrics.add_metric.call_args_list
            if c.kwargs.get('name') == 'ScraperOutboundUrlBlocked'
        ]


class TestOnePolicyForBothCallSites:
    """
    The ingestor imports the shared policy rather than carrying its own.

    Issue #244's fourth acceptance criterion. The failure mode it guards is the
    one this repo already had: `scrapers_handler.validate_url` existed, the
    plugin had nothing, and neither side knew the other was meant to agree.
    """

    def test_uses_the_shared_checked_fetch_object(self):
        from shared import http_utils
        from webscraper.ingestor import handler

        assert handler.fetch_checked_with_retry is http_utils.fetch_checked_with_retry
        assert handler.OutboundUrlBlocked is http_utils.OutboundUrlBlocked

    def test_defines_no_url_policy_of_its_own(self):
        """
        Asserted against the module's source, so it holds for any spelling of a
        re-introduced denylist rather than one particular name.

        Scoped to names in CALL position, plus what the module IMPORTS, rather
        than every `Name`/`Attribute` node: an unrelated future variable that
        happens to be spelled `getaddrinfo` should not fail this, while an actual
        resolver call, or an import of the unchecked fetch, must.
        """
        import ast
        import inspect

        from webscraper.ingestor import handler

        tree = ast.parse(inspect.getsource(handler))

        called = set()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if isinstance(node.func, ast.Name):
                called.add(node.func.id)
            elif isinstance(node.func, ast.Attribute):
                called.add(node.func.attr)

        imported = {
            alias.asname or alias.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in node.names
        }

        assert 'getaddrinfo' not in called, 'ingestor resolves hostnames itself'
        assert 'ip_network' not in called, 'ingestor carries its own address denylist'
        # The unchecked fetch this plugin used to call. Importing it again is the
        # regression: it follows redirects with no per-hop check.
        assert 'fetch_with_retry' not in called | imported, (
            'ingestor fetches without the policy'
        )
