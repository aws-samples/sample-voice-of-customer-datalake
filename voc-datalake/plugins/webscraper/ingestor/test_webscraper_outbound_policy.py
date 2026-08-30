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
- Advance the watermark for a config the run budget truncated, so its unattempted
  URLs are starved rather than retried
  -> `a_truncated_config_keeps_its_watermark_so_it_stays_due`,
  `the_run_budget_does_not_starve_a_stalling_configs_tail`,
  `a_config_the_invocation_never_reached_records_nothing`.
- Skip the watermark for every config instead of only the truncated one, so every
  scraper runs on every invocation regardless of frequency
  -> `a_config_that_finished_its_urls_records_its_run`.
- Iterate `self.scraper_configs` in stored order, so a config that truncates is
  due-and-first for ever and every config behind it never runs again
  -> `a_permanently_stalling_config_does_not_starve_the_ones_behind_it`.
- Stop recording the truncation, leaving the ordering nothing to read
  -> `records_the_truncation_so_a_later_invocation_can_order_by_it`,
  `a_permanently_stalling_config_does_not_starve_the_ones_behind_it`.
- Order by `scraper_{id}_last_run` instead of the truncation marker, reshuffling
  every healthy account for no benefit
  -> `a_config_that_truncated_sorts_behind_one_that_never_did`,
  `a_permanently_stalling_config_does_not_starve_the_ones_behind_it`.
- Reorder so aggressively that a truncated config is never attempted again
  -> `the_stalling_config_is_still_retried_while_the_others_run`.
- Reorder configs that never truncated
  -> `configs_that_never_truncated_keep_their_stored_order`.
- Never clear the truncation marker, so one slow day demotes a config for ever
  -> `a_config_that_recovers_stops_being_demoted`.
- Use the stored watermark as a sort key without checking it is a string, so one
  unusable value raises TypeError before the config loop and stops ALL scraping
  -> `an_unusable_truncation_watermark_does_not_stop_the_invocation`.
- Drop the ScraperRunBudgetExhausted counter, leaving a scheduled run's truncation
  invisible (`_update_run_status` returns early without an execution_id)
  -> `emits_a_metric_when_the_run_budget_is_exhausted`.
- Attribute the truncation to the config being VISITED rather than the one that
  spent the budget, so a config that made no request is demoted and the culprit
  keeps first refusal for ever
  -> `the_marker_names_the_config_that_spent_the_budget`,
  `the_config_behind_a_boundary_stall_is_eventually_fetched`.
- Write a `completed_with_errors` row for a config the budget never let start
  -> `a_config_that_made_no_request_reports_nothing`.
- Skip the budget metric where the exhaustion is found at a config boundary, or
  emit it once per remaining config
  -> `the_budget_metric_still_fires_once_at_the_boundary`.
- Reorder so aggressively that the demoted culprit is never attempted again
  -> `the_stalling_config_is_still_retried`.
- Have `fetch_new_items`' empty-guard read the UNFILTERED `self.scraper_configs`
  again, so an all-malformed array satisfies the guard, iterates nothing and leaves
  a manual run's row at `status: 'running'`
  -> `an_all_malformed_array_writes_a_terminal_error_row`.
- Widen that guard so a malformed entry alongside a usable one aborts the run
  -> `a_usable_config_alongside_a_malformed_one_still_runs`,
  `an_ordinary_run_is_unaffected`.
- Raise the security-shaped `OutboundUrlBlocked` for hop exhaustion again, so a
  public chain of CLEARED hops fires the SSRF metric
  -> `a_public_over_long_chain_emits_no_security_metric`.
- Reclassify a genuine internal redirect along with it, or drop the metric
  -> `a_genuine_internal_redirect_still_emits_it`.
- Let one unreadable config raise out of the config loop, so no config in the array
  ingests and a manual run's row is abandoned at `status: 'running'`
  -> `a_healthy_config_behind_a_malformed_one_still_runs` (8 shapes),
  `a_manual_run_over_an_unusable_config_writes_a_terminal_status`.
- Read `config['id']` in `_should_run_scraper` again, or let an unparseable
  `last_run`/`frequency_minutes` raise instead of treating the config as due
  -> `a_healthy_config_behind_a_malformed_one_still_runs[missing id]`,
  `[last_run not a date]`, `[last_run not a string]`, `[frequency_minutes string]`.
- Compute with `pagination` unchecked in `_get_urls_to_scrape`
  -> `a_healthy_config_behind_a_malformed_one_still_runs[max_pages string]`,
  `[max_pages None]`, `[pagination string]`, `[start string]`.
- Advance the watermark for a config that could not be read, so it waits out its
  whole frequency before being retried -> `an_unusable_config_does_not_record_a_run`.
- Swallow so much that ordinary work is skipped, or coerce a USABLE pagination
  value away -> `an_ordinary_two_config_run_is_unaffected`,
  `a_valid_pagination_still_produces_its_pages`.

Nothing here touches the network: resolution and HTTP are patched at
`shared.http_utils`'s import boundary, which is where the ingestor's fetch
resolves them.
"""

from datetime import datetime, timedelta, timezone
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

# One config that cannot finish inside the run budget, ahead of two that finish
# immediately: the shape in which a truncating config starved everything behind it.
# Module-level, like the constants above, rather than class attributes.
STALLING_CONFIG = {
    **CSS_CONFIG, 'id': 'A', 'name': 'A', 'frequency_minutes': 60,
    'urls': [f'https://slow.example/{n}' for n in range(20)],
}
HEALTHY_CONFIGS = [
    {**CSS_CONFIG, 'id': 'B', 'name': 'B', 'frequency_minutes': 60,
     'urls': ['https://okb.example/a']},
    {**CSS_CONFIG, 'id': 'C', 'name': 'C', 'frequency_minutes': 60,
     'urls': ['https://okc.example/a']},
]


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
    def _run_on_a_fake_clock(
        ingestor, configs, *, serve=None, watermarks=None, scheduled=False,
        requested=None, rows=None,
    ):
        """
        Run `fetch_new_items` over `configs` with a stalling transport.

        Returns (seconds of simulated wall clock spent, items, status writes).

        Args:
            serve: optional `url -> response or None` hook. Returning None (the
                default for every URL) stalls: the host holds the connection for
                the full timeout and then times out, which is the shape that makes
                a per-page budget insufficient.
            watermarks: optional dict the run's `set_watermark` calls are recorded
                into, for the tests that assert which configs were marked as
                having run. Reads are served from the same dict, so passing one
                across several calls simulates SUCCESSIVE invocations sharing a
                watermark table — which is the only way to observe the config
                ORDER, since ordering depends on what a previous run recorded.
                Absent, the writes are simply swallowed.
            scheduled: run as the EventBridge schedule does (no execution_id), so
                `_should_run_scraper` gates each config. The default is a manual
                run, which bypasses that gate.
            requested: optional list every requested URL is appended to, in order,
                for asserting which configs were reached rather than only which
                watermarks moved.
            rows: optional list every status write is appended to as
                `(scraper_id, updates)`. The returned `statuses` drop the id, which
                is enough while every write belongs to the config being visited —
                but not for asserting WHICH config a run row was written against,
                which is what a mis-attributed truncation looks like.
        """
        import requests

        now = [1000.0]

        def transport(**kwargs):
            if requested is not None:
                requested.append(kwargs['url'])
            served = serve(kwargs['url']) if serve else None
            if served is not None:
                return served
            now[0] += kwargs['timeout']
            raise requests.exceptions.Timeout('stalled')

        ingestor.execution_id = None if scheduled else 'exec-1'
        ingestor.scraper_configs = configs

        statuses = []

        def record_status(scraper_id, updates):
            statuses.append(updates)
            if rows is not None:
                rows.append((scraper_id, updates))

        with (
            patch('shared.http_utils.requests.request', side_effect=transport),
            patch('shared.http_utils.socket.getaddrinfo', return_value=PUBLIC_ADDRINFO),
            patch('shared.http_utils.time.monotonic', lambda: now[0]),
            patch('tenacity.nap.time.sleep', lambda s: now.__setitem__(0, now[0] + s)),
            patch(
                'webscraper.ingestor.handler.time.sleep',
                lambda s: now.__setitem__(0, now[0] + s),
            ),
            patch.object(ingestor, '_update_run_status', record_status),
            patch.object(
                ingestor,
                'set_watermark',
                lambda key, value: (
                    watermarks.__setitem__(key, value)
                    if watermarks is not None else None
                ),
            ),
            patch.object(
                ingestor,
                'get_watermark',
                lambda key, default=None: (
                    watermarks.get(key, default) if watermarks is not None
                    else default
                ),
            ),
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

    def test_a_truncated_config_keeps_its_watermark_so_it_stays_due(self, ingestor):
        """
        A config the run budget cut short must remain due for the next invocation.

        `set_watermark` ran unconditionally after the URL loop, so a truncated
        config was marked as having just run and then waited out its whole
        `frequency_minutes`. Because `_get_urls_to_scrape` rebuilds the list in the
        same order every time, the next invocation restarts at URL 0 too — so the
        unattempted tail was not deferred, it was starved, on every invocation,
        indefinitely. `starves` below measures that end to end.
        """
        watermarks: dict = {}

        _spent, _items, statuses = self._run_on_a_fake_clock(
            ingestor,
            [{
                **CSS_CONFIG,
                'base_url': 'https://slow.example/reviews',
                'pagination': {'enabled': True, 'max_pages': 10},
            }],
            watermarks=watermarks,
        )

        # It really was truncated — otherwise this asserts nothing.
        assert any('Run budget' in e for e in statuses[-1]['errors'])
        # The `last_run` key specifically, not "no watermark at all":
        # `_should_run_scraper` reads only that one, and the truncation IS recorded
        # separately so `_configs_in_fairness_order` can move this config back.
        # Asserting the whole dict was empty conflated dueness with ordering and
        # would fail on the fairness marker while the starvation it prevents went
        # unmeasured.
        assert 'scraper_s1_last_run' not in watermarks, (
            f'the truncated config was marked as having run: {watermarks}'
        )

    def test_the_run_budget_does_not_starve_a_stalling_configs_tail(self, ingestor):
        """
        The outcome the watermark guard buys, measured across TWO invocations.

        20 stalling URLs followed by 10 healthy ones: the first invocation spends
        its whole budget on the stalls and reaches none of the healthy pages. With
        the watermark advanced, the config is not due again for
        `frequency_minutes`, so the healthy tail is never reached at all. Holding
        it leaves the config due, so the second invocation runs — and this asserts
        it runs, which is the retry the comment at the `break` promises.
        """
        config = {
            **CSS_CONFIG,
            'frequency_minutes': 60,
            'urls': (
                [f'https://slow.example/{n}' for n in range(20)]
                + [f'https://ok.example/{n}' for n in range(10)]
            ),
        }
        watermarks: dict = {}

        def serve(url):
            return _response(200, text=REVIEW_HTML) if 'ok.example' in url else None

        # A SCHEDULED run, which is the only mode `_should_run_scraper` gates.
        ingestor.target_scraper_id = None
        self._run_on_a_fake_clock(
            ingestor, [config], serve=serve, watermarks=watermarks, scheduled=True,
        )

        # Whether the next scheduled invocation would run it at all.
        with patch.object(
            ingestor, 'get_watermark',
            lambda key, default=None: watermarks.get(key, default),
        ):
            assert ingestor._should_run_scraper(config), (
                'the truncated config is not due again, so its unattempted URLs '
                'are starved rather than retried'
            )

    def test_a_config_that_finished_its_urls_records_its_run(self, ingestor):
        """
        Positive control. Skipping the watermark whenever anything went wrong would
        satisfy the assertions above while making every scraper run on every
        invocation regardless of its frequency — so a config that completed its
        URLs must still record that it ran.
        """
        watermarks: dict = {}

        _spent, items, statuses = self._run_on_a_fake_clock(
            ingestor,
            [{**CSS_CONFIG, 'urls': ['https://ok.example/a', 'https://ok.example/b']}],
            serve=lambda _url: _response(200, text=REVIEW_HTML),
            watermarks=watermarks,
        )

        assert len(items) == 2
        assert statuses[-1]['status'] == 'completed'
        assert list(watermarks) == ['scraper_s1_last_run'], (
            f'a completed config did not record its run: {watermarks}'
        )

    def test_a_config_the_invocation_never_reached_records_nothing(self, ingestor):
        """
        The other route by which a config stays due, distinguished from the
        truncated one because only this route is automatic: a config the run never
        got to was never written at all.
        """
        watermarks: dict = {}

        self._run_on_a_fake_clock(
            ingestor,
            [
                {
                    **CSS_CONFIG,
                    'id': 'truncated',
                    'base_url': 'https://slow.example/reviews',
                    'pagination': {'enabled': True, 'max_pages': 10},
                },
                {**CSS_CONFIG, 'id': 'unreached', 'urls': ['https://ok.example/a']},
            ],
            watermarks=watermarks,
        )

        assert not [k for k in watermarks if k.endswith('_last_run')], (
            f'a config was marked as having run without completing: {watermarks}'
        )
        # And specifically the one never reached, which is the case this names.
        assert 'scraper_unreached_last_run' not in watermarks


class TestATruncatingConfigCannotMonopoliseTheLoop:
    """
    A config that cannot finish inside the run budget must not starve the others.

    Three individually-defensible behaviours composed into a total halt. A
    truncated config holds its `last_run` watermark, so it is due on EVERY
    invocation; the run budget `break`s the config loop, so nothing after it runs;
    and the configs were iterated in stored order, so it was reached first every
    time. Measured over 20 scheduled invocations (5 hours at the manifest's
    `rate(15 minutes)`) with one stalling config ahead of two healthy ones: zero
    watermarks written and the healthy configs fetched 0 of 2 URLs — never, not
    merely less often. A single slow site halted webscraper ingestion for every
    other scraper in the account.

    It was a REGRESSION from the watermark hold, not a pre-existing property:
    advancing the watermark had been rotating the queue as a side effect, because a
    config marked as having run was skipped as not-yet-due on the next invocation.
    Verified by counterfactual — with the watermark advanced unconditionally, the
    healthy configs are reached.

    `_configs_in_fairness_order` is what separates the two guarantees, which is why
    the fix is an ordering change and not a change to dueness: a truncated config
    stays due immediately (`TestRunBoundsTheWholeInvocation` above pins that) and
    sorts behind the configs it just blocked.

    Uses the fake-clock helper above; `watermarks` shared across calls is what makes
    several invocations observable, since the order depends on what the previous one
    recorded.
    """

    @staticmethod
    def _serve_only_healthy(url):
        return _response(200, text=REVIEW_HTML) if 'ok' in url else None

    def _invoke_repeatedly(self, ingestor, configs, times):
        """
        `times` successive SCHEDULED invocations over one watermark table.

        Returns every URL requested across all of them. `_should_run_scraper` is
        left unpatched so real dueness applies, with `datetime.now` advanced past
        each config's `frequency_minutes` between invocations — otherwise a config
        that legitimately recorded a run would look starved when it is merely
        waiting, which is the distinction this class exists to make.
        """
        import webscraper.ingestor.handler as handler_module

        watermarks: dict = {}
        requested: list = []
        clock = [datetime(2026, 1, 1, tzinfo=timezone.utc)]

        class AdvancingDatetime:
            """`datetime` with a `now` this test controls; everything else real."""

            @staticmethod
            def now(tz=None):
                return clock[0]

            @staticmethod
            def fromisoformat(value):
                return datetime.fromisoformat(value)

        for _ in range(times):
            with patch.object(handler_module, 'datetime', AdvancingDatetime):
                TestRunBoundsTheWholeInvocation._run_on_a_fake_clock(
                    ingestor,
                    configs,
                    serve=self._serve_only_healthy,
                    watermarks=watermarks,
                    scheduled=True,
                    requested=requested,
                )
            # Past any config's frequency_minutes, so nothing is skipped merely
            # for having run recently.
            clock[0] = clock[0] + timedelta(minutes=90)

        return requested, watermarks

    def test_a_permanently_stalling_config_does_not_starve_the_ones_behind_it(
        self, ingestor
    ):
        """
        The reviewer's measurement, as an assertion on URLs actually REQUESTED
        rather than on watermarks: watermarks can move without a config having been
        reached, so only the request log proves the healthy configs got their turn.

        Two invocations are enough — the stalling config sorts last on the second —
        but this runs several to show it does not merely alternate into starvation.
        """
        requested, _watermarks = self._invoke_repeatedly(
            ingestor, [STALLING_CONFIG, *HEALTHY_CONFIGS], times=4
        )

        reached = {url for url in requested if 'ok' in url}
        assert reached == {'https://okb.example/a', 'https://okc.example/a'}, (
            f'the healthy configs behind a stalling one were starved: {reached}'
        )

    def test_the_stalling_config_is_still_retried_while_the_others_run(
        self, ingestor
    ):
        """
        The guarantee the fix must not trade away. Moving a truncated config to the
        back would be a regression of its own if it stopped being attempted at all,
        so it must still be reached on a later invocation.
        """
        requested, _watermarks = self._invoke_repeatedly(
            ingestor, [STALLING_CONFIG, *HEALTHY_CONFIGS], times=3
        )

        assert any('slow.example' in url for url in requested), (
            'the truncated config was never retried'
        )

    def test_records_the_truncation_so_a_later_invocation_can_order_by_it(
        self, ingestor
    ):
        """
        The ordering is only possible because the truncation is persisted. This
        pins the mechanism as well as the outcome, so a fix that reordered by
        something transient (in-memory, lost between invocations) would fail here.
        """
        watermarks: dict = {}

        TestRunBoundsTheWholeInvocation._run_on_a_fake_clock(
            ingestor,
            [STALLING_CONFIG],
            serve=self._serve_only_healthy,
            watermarks=watermarks,
            scheduled=True,
        )

        assert 'scraper_A_last_truncated' in watermarks, (
            f'nothing recorded the truncation, so ordering cannot use it: '
            f'{watermarks}'
        )
        # And it did NOT record a run, which is what keeps it due.
        assert 'scraper_A_last_run' not in watermarks

    def test_a_config_that_recovers_stops_being_demoted(self, ingestor):
        """
        The demotion must be self-correcting. A site that was slow once would
        otherwise sort behind every never-truncated config for ever, on the strength
        of a truncation it has since recovered from — so finishing every URL has to
        clear the marker.
        """
        watermarks = {'scraper_s1_last_truncated': '2026-01-01T00:00:00+00:00'}

        TestRunBoundsTheWholeInvocation._run_on_a_fake_clock(
            ingestor,
            [{**CSS_CONFIG, 'urls': ['https://ok.example/a']}],
            serve=lambda _url: _response(200, text=REVIEW_HTML),
            watermarks=watermarks,
        )

        assert not watermarks['scraper_s1_last_truncated'], (
            'a recovered config is still demoted by a stale truncation marker'
        )
        # It genuinely completed — otherwise this asserts nothing.
        assert watermarks['scraper_s1_last_run']

    def test_a_config_that_truncated_sorts_behind_one_that_never_did(
        self, ingestor
    ):
        """
        The ordering rule directly, so a failure here names the cause rather than
        the symptom.
        """
        ingestor.scraper_configs = [STALLING_CONFIG, *HEALTHY_CONFIGS]
        watermarks = {'scraper_A_last_truncated': '2026-01-01T00:00:00+00:00'}

        with patch.object(
            ingestor, 'get_watermark',
            lambda key, default=None: watermarks.get(key, default),
        ):
            order = [c['id'] for c in ingestor._configs_in_fairness_order()]

        assert order == ['B', 'C', 'A'], f'truncated config was not moved back: {order}'

    def test_configs_that_never_truncated_keep_their_stored_order(self, ingestor):
        """
        Positive control on the ordering. A sort that shuffled ordinary accounts
        would pass the starvation tests above while changing the behaviour of every
        deployment that never truncates, so the common case must be untouched.
        """
        ingestor.scraper_configs = [STALLING_CONFIG, *HEALTHY_CONFIGS]

        with patch.object(ingestor, 'get_watermark', lambda key, default=None: default):
            order = [c['id'] for c in ingestor._configs_in_fairness_order()]

        assert order == ['A', 'B', 'C'], f'stored order was not preserved: {order}'

    @pytest.mark.parametrize(
        'stored', [None, '', 123, {'not': 'a timestamp'}, ['list']],
    )
    def test_an_unusable_truncation_watermark_does_not_stop_the_invocation(
        self, ingestor, stored
    ):
        """
        The sort key comes from DynamoDB, and it runs BEFORE the config loop — so a
        value that cannot be compared aborted the whole invocation rather than
        costing one config its place. Every scraper would have stopped, which is
        strictly worse than the starvation being fixed.
        """
        ingestor.scraper_configs = [STALLING_CONFIG, *HEALTHY_CONFIGS]

        with patch.object(ingestor, 'get_watermark', lambda key, default=None: stored):
            order = [c['id'] for c in ingestor._configs_in_fairness_order()]

        assert order == ['A', 'B', 'C']

    def test_emits_a_metric_when_the_run_budget_is_exhausted(self, ingestor):
        """
        For a SCHEDULED run `_update_run_status` returns early, so the run's
        `errors` are not written anywhere an operator sees. An account truncating on
        every schedule is ingesting less than it thinks, and this is the only signal
        that says so.
        """
        with patch('webscraper.ingestor.handler.metrics.add_metric') as mock_metric:
            TestRunBoundsTheWholeInvocation._run_on_a_fake_clock(ingestor, [STALLING_CONFIG])

        assert 'ScraperRunBudgetExhausted' in [
            call.kwargs.get('name') for call in mock_metric.call_args_list
        ]

    def test_emits_no_budget_metric_on_a_healthy_run(self, ingestor):
        """Positive control: the metric must mean something when it fires."""
        with patch('webscraper.ingestor.handler.metrics.add_metric') as mock_metric:
            TestRunBoundsTheWholeInvocation._run_on_a_fake_clock(
                ingestor,
                [{**CSS_CONFIG, 'urls': ['https://ok.example/a']}],
                serve=lambda _url: _response(200, text=REVIEW_HTML),
            )

        assert 'ScraperRunBudgetExhausted' not in [
            call.kwargs.get('name') for call in mock_metric.call_args_list
        ]


class TestTheTruncationIsBlamedOnTheConfigThatSpentTheBudget:
    """
    The config that ran out of budget is the one demoted — not the one that merely
    discovered the budget was gone.

    `config_truncated` was set inside the URL loop of whichever config was being
    visited when `remaining <= 0` first tested true. When a config spends the whole
    budget but FINISHES its own URL list, that fires at index 0 of the NEXT config,
    which has requested nothing. So the culprit recorded a clean run and kept its
    place, while its victim was marked truncated, demoted by
    `_configs_in_fairness_order`, and given a `completed_with_errors` row saying
    "N URL(s) not attempted" about URLs it never attempted.

    Measured with 5 stalling URLs ahead of one healthy config: the marker landed on
    `scraper_B_last_truncated`, the loop order stayed ('A', 'B') on every one of 40
    scheduled invocations, and the healthy config was fetched 0 times — the same
    total starvation `TestATruncatingConfigCannotMonopoliseTheLoop` exists to
    prevent, restored through the ordering it feeds.

    The suite could not see it because STALLING_CONFIG has 20 URLs, which lands
    in the range where the budget expires INSIDE a config and the attribution is
    incidentally right. These tests use the boundary shape instead, and find it by
    sweeping rather than hardcoding a count, so retuning the budget constants
    cannot quietly make them vacuous.
    """

    # URL counts swept for a config whose stalls end with the budget exactly gone.
    # A range, not the measured 5: the boundary moves with the budget constants and
    # the retry curve, and a test pinned to one count would silently stop measuring
    # the boundary rather than fail.
    _BOUNDARY_SWEEP = range(3, 12)

    @staticmethod
    def _pair(stalling_urls):
        return [
            {**CSS_CONFIG, 'id': 'A', 'name': 'Alpha', 'frequency_minutes': 60,
             'urls': [f'https://slow.example/{n}' for n in range(stalling_urls)]},
            {**CSS_CONFIG, 'id': 'B', 'name': 'Bravo', 'frequency_minutes': 60,
             'urls': ['https://okb.example/a']},
        ]

    @classmethod
    def _boundary_runs(cls, ingestor):
        """
        Every swept URL count in which config B made NO request, with what the run
        recorded for it.

        Yields `(count, watermarks, rows)`. B making no request is precisely the
        condition under which the old code blamed it, so these are the shapes the
        assertions below are about.
        """
        for count in cls._BOUNDARY_SWEEP:
            watermarks: dict = {}
            requested: list = []
            rows: list = []
            TestRunBoundsTheWholeInvocation._run_on_a_fake_clock(
                ingestor,
                cls._pair(count),
                serve=lambda url: (
                    _response(200, text=REVIEW_HTML) if 'okb' in url else None
                ),
                watermarks=watermarks,
                requested=requested,
                rows=rows,
            )
            if not any('okb' in url for url in requested):
                yield count, watermarks, rows

    def test_the_boundary_shape_is_reachable(self, ingestor):
        """
        Positive control on the sweep. If no swept count leaves the second config
        unattempted, every assertion below is about a situation that never occurs,
        and this class would pass while measuring nothing.
        """
        counts = [count for count, _wm, _rows in self._boundary_runs(ingestor)]

        assert counts, (
            f'no URL count in {self._BOUNDARY_SWEEP} exhausted the budget at a '
            f'config boundary — the sweep no longer reaches the case these tests '
            f'are about'
        )

    def test_the_marker_names_the_config_that_spent_the_budget(self, ingestor):
        """
        The mechanism, asserted for every boundary shape rather than one measured
        count: the demotion is only fair if it names the culprit.
        """
        for count, watermarks, _rows in self._boundary_runs(ingestor):
            marked = [k for k in watermarks if k.endswith('_last_truncated')]

            assert marked == ['scraper_A_last_truncated'], (
                f'with {count} stalling URLs the truncation was attributed to '
                f'{marked} — the config that made no request'
            )

    def test_a_config_that_made_no_request_reports_nothing(self, ingestor):
        """
        A config the budget never let start has neither run nor been truncated, so
        it must claim neither. It reported `completed_with_errors` over "N URL(s)
        not attempted" — naming itself for a budget another config spent, which is
        what an operator reads when deciding which scraper is misbehaving.
        """
        for count, watermarks, rows in self._boundary_runs(ingestor):
            terminal_b = [
                updates for scraper_id, updates in rows
                if scraper_id == 'B' and 'status' in updates
            ]

            assert not terminal_b, (
                f'with {count} stalling URLs an unattempted config wrote a '
                f'terminal row: {terminal_b}'
            )
            # And it stays due, which is the other half of "reports nothing".
            assert 'scraper_B_last_run' not in watermarks

    def test_the_config_behind_a_boundary_stall_is_eventually_fetched(
        self, ingestor
    ):
        """
        The outcome, across real scheduled invocations and asserted on URLs actually
        REQUESTED. The marker being on the wrong config made the loop order
        permanent: ('A', 'B') on all 40 invocations, B fetched 0 times.
        """
        count = next(count for count, _wm, _rows in self._boundary_runs(ingestor))
        requested, _watermarks = TestATruncatingConfigCannotMonopoliseTheLoop()\
            ._invoke_repeatedly(ingestor, self._pair(count), times=4)

        assert any('okb' in url for url in requested), (
            'the config behind a boundary-stalling one was never fetched, so the '
            'truncation is still attributed to it rather than to the culprit'
        )

    def test_the_stalling_config_is_still_retried(self, ingestor):
        """
        The guarantee the attribution fix must not trade away: demoting the culprit
        must not stop it being attempted.
        """
        count = next(count for count, _wm, _rows in self._boundary_runs(ingestor))
        requested, _watermarks = TestATruncatingConfigCannotMonopoliseTheLoop()\
            ._invoke_repeatedly(ingestor, self._pair(count), times=4)

        assert any('slow.example' in url for url in requested)

    def test_the_budget_metric_still_fires_once_at_the_boundary(self, ingestor):
        """
        The truncation is real even where no config's own URL loop reports it, so
        the alertable counter must still be emitted — exactly once, since the
        invocation stops.
        """
        count = next(count for count, _wm, _rows in self._boundary_runs(ingestor))

        with patch('webscraper.ingestor.handler.metrics.add_metric') as mock_metric:
            TestRunBoundsTheWholeInvocation._run_on_a_fake_clock(
                ingestor,
                self._pair(count),
                serve=lambda url: (
                    _response(200, text=REVIEW_HTML) if 'okb' in url else None
                ),
            )

        exhausted = [
            call for call in mock_metric.call_args_list
            if call.kwargs.get('name') == 'ScraperRunBudgetExhausted'
        ]
        assert len(exhausted) == 1, (
            f'expected one budget-exhausted metric, got {len(exhausted)}'
        )


class TestAnUnusableConfigArrayStillReportsATerminalStatus:
    """
    A stored array with no usable config must take the error branch, not neither.

    `_configs_in_fairness_order` filters non-dict entries, but `fetch_new_items`'
    empty-guard still tested the UNFILTERED `self.scraper_configs` — so an array of
    entirely non-dict entries satisfied the guard (non-empty) and then iterated
    nothing. A manual run had already written a `status: 'running'` row, and nothing
    terminal was ever written for it: the same abandoned row the run budget exists
    to prevent, reached by a different route, and nothing reconciles one.

    Defence in depth rather than a reachable path today — `_load_scraper_configs`
    calls `c.get('enabled', True)` and so raises AttributeError on such an entry
    first. It is tested because the filter was added AS defence, and as written it
    converted one unreachable failure into a different silent one.
    """

    def test_an_all_malformed_array_writes_a_terminal_error_row(self, ingestor):
        ingestor.execution_id = 'exec-1'
        ingestor.target_scraper_id = 's1'
        ingestor.scraper_configs = ['not-a-dict', 42]

        statuses = []
        with (
            patch.object(
                ingestor, '_update_run_status', lambda _id, u: statuses.append(u)
            ),
            patch.object(ingestor, 'set_watermark'),
            patch.object(ingestor, 'get_watermark', lambda key, default=None: default),
        ):
            items = list(ingestor.fetch_new_items())

        assert items == []
        assert statuses, 'no terminal status was written, so the run row stays running'
        assert statuses[-1]['status'] == 'error'
        assert statuses[-1]['errors'] == ['No scraper configuration found']

    def test_a_usable_config_alongside_a_malformed_one_still_runs(self, ingestor):
        """
        The filter must drop the unusable entry, not the run. Reporting `error` for
        an array that also holds a working config would turn defence into an
        outage.
        """
        ingestor.scraper_configs = [
            'not-a-dict', {**CSS_CONFIG, 'urls': ['https://ok.example/a']},
        ]

        with (
            patch('shared.http_utils.requests.request',
                  return_value=_response(200, text=REVIEW_HTML)),
            patch('shared.http_utils.socket.getaddrinfo', return_value=PUBLIC_ADDRINFO),
            patch.object(ingestor, '_update_run_status'),
            patch.object(ingestor, 'set_watermark'),
            patch.object(ingestor, 'get_watermark', lambda key, default=None: default),
            patch('webscraper.ingestor.handler.time.sleep'),
        ):
            items = list(ingestor.fetch_new_items())

        assert len(items) == 1

    def test_an_ordinary_run_is_unaffected(self, ingestor):
        """
        Positive control on moving the guard: it now reads a DERIVED list, so a bug
        in the derivation would report "no configuration" for a healthy account.
        """
        ingestor.execution_id = 'exec-1'
        ingestor.target_scraper_id = 's1'
        ingestor.scraper_configs = [{**CSS_CONFIG, 'urls': ['https://ok.example/a']}]

        statuses = []
        with (
            patch('shared.http_utils.requests.request',
                  return_value=_response(200, text=REVIEW_HTML)),
            patch('shared.http_utils.socket.getaddrinfo', return_value=PUBLIC_ADDRINFO),
            patch.object(
                ingestor, '_update_run_status', lambda _id, u: statuses.append(u)
            ),
            patch.object(ingestor, 'set_watermark'),
            patch.object(ingestor, 'get_watermark', lambda key, default=None: default),
            patch('webscraper.ingestor.handler.time.sleep'),
        ):
            items = list(ingestor.fetch_new_items())

        assert len(items) == 1
        assert statuses[-1]['status'] == 'completed'


# A config the ingestor is meant to survive, and the malformed shapes it must
# survive. Module-level like STALLING_CONFIG above rather than class attributes:
# same convention, and a mutable class attribute is a RUF012.
HEALTHY_CONFIG = {
    **CSS_CONFIG, 'id': 'healthy', 'name': 'healthy',
    'urls': ['https://ok.example/a'],
}

# (label, malformed config, watermarks it needs to be stored)
MALFORMED_CONFIGS = [
    # `id` is REMOVED, not merely left unspread: CSS_CONFIG carries one, so
    # `{**CSS_CONFIG, ...}` cannot express this case at all — a first version
    # that tried passed against the unfixed handler for that reason.
    ("missing id", {k: v for k, v in CSS_CONFIG.items() if k != 'id'}
     | {'name': 'no-id', 'urls': ['https://bad.example/a']}, {}),
    ("max_pages string", {**CSS_CONFIG, 'id': 'b', 'base_url': 'https://bad.example/',
                          'pagination': {'enabled': True, 'max_pages': '10'}}, {}),
    ("max_pages None", {**CSS_CONFIG, 'id': 'b', 'base_url': 'https://bad.example/',
                        'pagination': {'enabled': True, 'max_pages': None}}, {}),
    ("pagination string", {**CSS_CONFIG, 'id': 'b', 'base_url': 'https://bad.example/',
                           'pagination': 'x'}, {}),
    ("start string", {**CSS_CONFIG, 'id': 'b', 'base_url': 'https://bad.example/',
                      'pagination': {'enabled': True, 'start': 'x'}}, {}),
    ("last_run not a date", {**CSS_CONFIG, 'id': 'wm',
                             'urls': ['https://bad.example/a']},
     {'scraper_wm_last_run': 'not-a-date'}),
    ("last_run not a string", {**CSS_CONFIG, 'id': 'wm',
                               'urls': ['https://bad.example/a']},
     {'scraper_wm_last_run': 12345}),
    ("frequency_minutes string", {**CSS_CONFIG, 'id': 'fq', 'frequency_minutes': 'x',
                                  'urls': ['https://bad.example/a']},
     {'scraper_fq_last_run': '2020-01-01T00:00:00+00:00'}),
]


class TestOneMalformedConfigCostsOneConfig:
    """
    A config the ingestor cannot read must cost that config, not the invocation.

    Every shape below is accepted by `POST /scrapers` and then raised out of
    `fetch_new_items`, so NO config in the array ran — measured, a healthy config
    sitting behind the malformed one was fetched 0 times in every case. Two of the
    shapes come from DynamoDB rather than the config, via `_should_run_scraper`.

    That is the same "one unusable value stops all scraping" failure
    `_configs_in_fairness_order`'s sort-key guard was written to prevent; these are
    the remaining routes to it. For a MANUAL run it is worse than a lost
    invocation: `POST /scrapers/<id>/run` has already written a `status: 'running'`
    row, and an exception leaving the loop means nothing terminal replaces it.

    The `range()`/`config['id']` reads predate this PR, so this is defence made
    consistent rather than a regression fixed. It is closed in three places, and
    each has its own reason: refused on WRITE by `shared/scraper_urls.py` (the
    actionable 400), coerced in `_get_urls_to_scrape`/`_should_run_scraper` for
    configs already stored, and caught per-config in the loop — which is the only
    one of the three that also covers the shape nobody has thought of yet.
    """

    @staticmethod
    def _scheduled_run(ingestor, configs, watermarks):
        """A scheduled invocation, returning (requested URLs, status writes)."""
        requested = []
        statuses = []

        def transport(**kwargs):
            requested.append(kwargs['url'])
            return _response(200, text=REVIEW_HTML)

        ingestor.execution_id = None
        ingestor.scraper_configs = configs

        with (
            patch('shared.http_utils.requests.request', side_effect=transport),
            patch('shared.http_utils.socket.getaddrinfo', return_value=PUBLIC_ADDRINFO),
            patch('webscraper.ingestor.handler.time.sleep'),
            patch.object(
                ingestor, '_update_run_status',
                lambda _id, u: statuses.append((_id, u)),
            ),
            patch.object(
                ingestor, 'set_watermark',
                lambda key, value: watermarks.__setitem__(key, value),
            ),
            patch.object(
                ingestor, 'get_watermark',
                lambda key, default=None: watermarks.get(key, default),
            ),
        ):
            items = list(ingestor.fetch_new_items())

        return requested, statuses, items

    @pytest.mark.parametrize(
        'malformed,stored', [(c, w) for _label, c, w in MALFORMED_CONFIGS],
        ids=[label for label, _c, _w in MALFORMED_CONFIGS],
    )
    def test_a_healthy_config_behind_a_malformed_one_still_runs(
        self, malformed, stored, ingestor
    ):
        """
        Asserted on the URLs actually REQUESTED, not on watermarks: a watermark can
        move without the config having been fetched.
        """
        requested, _statuses, _items = self._scheduled_run(
            ingestor, [malformed, HEALTHY_CONFIG], dict(stored)
        )

        assert 'https://ok.example/a' in requested, (
            'the malformed config stopped the whole invocation'
        )

    def test_a_manual_run_over_an_unusable_config_writes_a_terminal_status(
        self, ingestor
    ):
        """
        The specific thing an escaping exception loses. `POST /scrapers/<id>/run`
        has already written `status: 'running'`, and nothing reconciles one that is
        never replaced.

        Driven through a config whose `urls` cannot be iterated — a shape neither
        the write check nor the coercions cover — so this measures the per-config
        guard rather than one of the narrower fixes.
        """
        ingestor.execution_id = 'exec-1'
        ingestor.target_scraper_id = 'b'
        ingestor.scraper_configs = [{**CSS_CONFIG, 'id': 'b', 'urls': 7}]

        statuses = []
        with (
            patch('shared.http_utils.requests.request',
                  return_value=_response(200, text=REVIEW_HTML)),
            patch('shared.http_utils.socket.getaddrinfo', return_value=PUBLIC_ADDRINFO),
            patch('webscraper.ingestor.handler.time.sleep'),
            patch.object(
                ingestor, '_update_run_status', lambda _id, u: statuses.append(u)
            ),
            patch.object(ingestor, 'set_watermark'),
            patch.object(ingestor, 'get_watermark', lambda key, default=None: default),
        ):
            items = list(ingestor.fetch_new_items())

        assert items == []
        assert statuses, 'no terminal status: the run row stays at running for ever'
        assert statuses[-1]['status'] == 'error'
        assert statuses[-1]['completed_at']

    def test_an_unusable_config_does_not_record_a_run(self, ingestor):
        """
        It never ran, so its `last_run` must not move — otherwise a config that
        fails to load waits out its whole `frequency_minutes` before being tried
        again, and a fixed config would too.
        """
        watermarks = {}
        self._scheduled_run(
            ingestor,
            [{**CSS_CONFIG, 'id': 'b', 'urls': 7}, HEALTHY_CONFIG],
            watermarks,
        )

        assert 'scraper_b_last_run' not in watermarks
        assert 'scraper_healthy_last_run' in watermarks, (
            'the healthy config did not record its run either'
        )

    def test_an_ordinary_two_config_run_is_unaffected(self, ingestor):
        """
        Positive control. A guard that swallowed too much — or coercions that
        defaulted a valid value away — would satisfy every assertion above while
        quietly ingesting nothing, so this pins that both configs are still
        fetched, both yield, and both record their run.
        """
        watermarks = {}
        requested, statuses, items = self._scheduled_run(
            ingestor,
            [
                {**CSS_CONFIG, 'id': 'one', 'urls': ['https://one.example/a']},
                {**CSS_CONFIG, 'id': 'two', 'urls': ['https://two.example/a']},
            ],
            watermarks,
        )

        assert requested == ['https://one.example/a', 'https://two.example/a']
        assert len(items) == 2
        assert watermarks.keys() >= {'scraper_one_last_run', 'scraper_two_last_run'}
        assert [u['status'] for _id, u in statuses if 'status' in u] == [
            'completed', 'completed'
        ]

    def test_a_valid_pagination_still_produces_its_pages(self, ingestor):
        """
        Positive control on the coercion specifically: `_as_int` must narrow only
        what it cannot use. `max_pages: 3` means base_url plus pages 2 and 3, so
        coercing a usable value to the default would show up here.
        """
        requested, _statuses, _items = self._scheduled_run(
            ingestor,
            [{**CSS_CONFIG, 'id': 'p', 'base_url': 'https://ok.example/r',
              'pagination': {'enabled': True, 'max_pages': 3, 'start': 1}}],
            {},
        )

        assert requested == [
            'https://ok.example/r',
            'https://ok.example/r?page=2',
            'https://ok.example/r?page=3',
        ]


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


class TestALongPublicChainIsNotASecurityEvent:
    """
    Exhausting the hop bound on a PUBLIC chain must not report a blocked
    destination.

    Every hop in such a chain was resolved and cleared, so it is a transport
    oddity. While it raised `OutboundUrlBlocked` the run's `errors` said "Blocked
    outbound URL", it was logged at ERROR, and `ScraperOutboundUrlBlocked` fired —
    a metric whose own comment says it exists for the one case worth alerting on,
    a saved host that has started resolving internally. A site with a long
    redirect chain paged someone about an SSRF event that did not happen.
    """

    @staticmethod
    def _run(ingestor, transport):
        metric_names = []
        with (
            patch('shared.http_utils.requests.request', side_effect=transport),
            patch('shared.http_utils.socket.getaddrinfo') as mock_resolve,
            patch('webscraper.ingestor.handler.metrics.add_metric') as mock_metric,
            patch.object(ingestor, '_update_run_status'),
            patch.object(ingestor, 'set_watermark'),
            patch.object(ingestor, 'get_watermark', lambda key, default=None: default),
            patch('webscraper.ingestor.handler.time.sleep'),
        ):
            mock_resolve.side_effect = lambda hostname, *a, **k: (
                PUBLIC_ADDRINFO if hostname == 'ok.example' else INTERNAL_ADDRINFO
            )
            mock_metric.side_effect = lambda **kw: metric_names.append(kw['name'])
            ingestor.execution_id = 'exec-1'
            ingestor.scraper_configs = [
                {**CSS_CONFIG, 'id': 'A', 'urls': ['https://ok.example/start']}
            ]
            list(ingestor.fetch_new_items())
        return metric_names

    def test_a_public_over_long_chain_emits_no_security_metric(self, ingestor):
        hop = iter(range(1, 40))
        metric_names = self._run(
            ingestor,
            lambda **_k: _response(302, location=f'https://ok.example/h{next(hop)}'),
        )

        assert 'ScraperOutboundUrlBlocked' not in metric_names, (
            'a cleared public chain was reported as a blocked destination'
        )

    def test_a_genuine_internal_redirect_still_emits_it(self, ingestor):
        """
        Positive control. Reclassifying the hop limit must not reclassify a real
        refusal — without this, deleting the metric entirely would pass above.
        """
        metric_names = self._run(
            ingestor,
            lambda **_k: _response(302, location='http://169.254.169.254/latest/'),
        )

        assert 'ScraperOutboundUrlBlocked' in metric_names


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
