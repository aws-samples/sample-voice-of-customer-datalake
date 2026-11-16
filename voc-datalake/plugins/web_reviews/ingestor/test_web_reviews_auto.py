"""``auto``: the cascade (signed browser → Bedrock web search → AgentCore Web Search snippets), what it learns per
workspace and site, and what the run row and the items say of it (docs/web-reviews.md → Methods, Learning which
method works)."""
import json
from collections.abc import Generator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from snippet_reader import SearchResult, SnippetSearchError
from test_web_reviews_handler import URL, WatermarkTable, ingestor, page, target_config, wm
from web_search_reader import WebSearchError, WebSearchRead, page_reviews

from _shared.test.workspace_fixtures import OTHER_SCOPE, SCOPE, WS
from shared.web_review_methods import record_item
from shared.ws_repo import OutOfScopeError, ws_table

DOMAIN = 'trustpilot.com'
WALL = page(status=403, text='', jsonld=(), html='<script src="/cdn-cgi/challenge-platform/h/b"></script>',
            title='Just a moment...')
DAY = timedelta(days=1)


def auto_config(**fields: str) -> dict[str, str]:
    return target_config(method='auto', **fields)


class AggregatesTable:
    """voc-aggregates with boto3's ``Key=`` / ``Item=`` shape, seen by the ingestor through its scope's view."""

    def __init__(self, items: list[dict] | None = None):
        self.items = {(item['pk'], item['sk']): item for item in items or []}
        self.puts: list[dict] = []

    def get_item(self, Key, **_kwargs):
        item = self.items.get((Key['pk'], Key['sk']))
        return {'Item': item} if item is not None else {}

    def put_item(self, Item, **_kwargs):
        self.puts.append(Item)
        self.items[(Item['pk'], Item['sk'])] = Item

    def update_item(self, **_kwargs):
        return {}


def stored_record(best: str, *, steps: dict[str, tuple[str, timedelta]], learned: timedelta = DAY) -> dict:
    """A stored record of DOMAIN in SCOPE: *steps* maps a step to (its last outcome, how long ago)."""
    from shared.web_review_methods import MethodRecord, StepStats

    now = datetime.now(UTC)
    record = MethodRecord(DOMAIN, best, (now - learned).isoformat(), {
        step: StepStats(outcome, (now - ago).isoformat(), int(outcome == 'readable'), int(outcome != 'readable'), 3)
        for step, (outcome, ago) in steps.items()})
    return record_item(SCOPE, record, now.isoformat())


def bedrock_read(*bodies: str, fetched: bool = True, reason: str | None = None) -> WebSearchRead:
    reviews = page_reviews(json.dumps({'reviews': [{'review_kind': 'review', 'body': body} for body in bodies]}), 20)[2]
    return WebSearchRead(reviews=reviews, model='openai.gpt-5.6-luna', fetched=fetched, reason=reason,
                         opened_urls=[URL])


SNIPPET = '... Great support team, they answered within an hour. Rated 5/5 ...'


@contextmanager
def auto_run(configs: list[dict], pages: dict | None = None, *, table: AggregatesTable | None = None,
             bedrock: WebSearchRead | Exception | None = None, search: list[SearchResult] | Exception | None = None,
             model_lines: str = '', session: Any = None, watermarks: WatermarkTable | None = None,
             ) -> Generator[tuple[Any, AggregatesTable, MagicMock, MagicMock, Any], None, None]:
    """A run over *configs* in SCOPE, its learned records in *table*; Bedrock web search answers *bedrock*, AgentCore
    Web Search *search*, the extraction model *model_lines*."""
    from web_reviews.ingestor import handler

    table = table or AggregatesTable()
    session = session or MagicMock()
    with ingestor(configs, pages, session=session, table=watermarks) as run, \
            patch.object(run, '_web_search', side_effect=[bedrock or bedrock_read()]) as searched, \
            patch.object(handler, 'invoke_web_search', side_effect=[search if search is not None else []]) as snippets:
        run.aggregates_table = ws_table(SCOPE, table)
        run._complete = lambda _prompt, _system: model_lines
        yield run, table, searched, snippets, session


def the_read(run) -> dict:
    [read] = run.reads
    return read


class TestTheCascade:
    def test_a_blocked_browser_hands_the_page_to_bedrock_web_search(self):
        with auto_run([auto_config()], {URL: WALL}, bedrock=bedrock_read('Fast refunds.')) as (run, table, _s, snip, _):
            items = list(run.fetch_new_items())
        assert [item['text'] for item in items] == ['Fast refunds.']
        metadata = items[0]['metadata']
        assert (metadata['method_used'], metadata['method'], metadata['site']) == (
            'bedrock_web_search', 'bedrock_web_search', 'www.trustpilot.com')
        snip.assert_not_called()
        read = the_read(run)
        assert read['steps'] == [{'method': 'browser', 'outcome': 'blocked', 'reviews': 0, 'vendor': 'Cloudflare'},
                                 {'method': 'bedrock_web_search', 'outcome': 'readable', 'reviews': 1}]
        assert (read['method_used'], read['reviews'], read['plan'], read['excerpt']) == (
            'bedrock_web_search', 1, 'cascade', False)
        assert run.run_errors == []  # a fallback that read the page is no error
        [put] = table.puts
        assert (put['pk'], put['sk'], put['best_method']) == (f'WS#{WS}#WEB_REVIEWS#METHODS', DOMAIN,
                                                              'bedrock_web_search')
        assert put['methods']['browser']['last_outcome'] == 'blocked:Cloudflare'
        assert put['methods']['bedrock_web_search']['successes'] == 1

    def test_when_bedrock_gets_nothing_the_snippets_are_read_as_excerpts(self):
        found = [SearchResult(URL, 'Example reviews', SNIPPET, '2026-10-01T00:00:00Z'),
                 SearchResult('https://www.trustpilot.com/review/other.com', 'Other', 'Other shop is great.', None)]
        line = json.dumps({'rating': 5, 'date': None, 'title': None,
                           'text': 'Great support team, they answered within an hour.'})
        with auto_run([auto_config()], {URL: WALL}, bedrock=bedrock_read(fetched=False, reason='NOT_AVAILABLE'),
                      search=found, model_lines=line) as (run, table, _s, snippets, _):
            [item] = list(run.fetch_new_items())
        query, domain = snippets.call_args.args
        assert (query, domain) == ('Trustpilot reviews', DOMAIN)
        assert (item['text'], item['rating'], item['author'], item['url']) == (
            'Great support team, they answered within an hour.', 5.0, None, URL)
        metadata = item['metadata']
        assert {key: metadata[key] for key in ('method_used', 'excerpt', 'snippet_cut', 'snippet_url', 'snippet_title',
                                               'snippet_published_date', 'query')} == {
            'method_used': 'agentcore_web_search', 'excerpt': True, 'snippet_cut': True, 'snippet_url': URL,
            'snippet_title': 'Example reviews', 'snippet_published_date': '2026-10-01T00:00:00Z',
            'query': 'Trustpilot reviews'}
        assert metadata['snippet'] == SNIPPET
        read = the_read(run)
        assert [(s['method'], s['outcome']) for s in read['steps']] == [
            ('browser', 'blocked'), ('bedrock_web_search', 'error'), ('agentcore_web_search', 'readable')]
        assert read['steps'][1]['detail'] == 'could not open the page (NOT_AVAILABLE)'
        assert (read['method_used'], read['excerpt']) == ('agentcore_web_search', True)
        assert table.puts[-1]['best_method'] == 'agentcore_web_search'

    def test_a_snippet_review_the_snippets_do_not_hold_is_never_stored(self):
        found = [SearchResult(URL, None, SNIPPET, None)]
        invented = json.dumps({'rating': 5, 'date': None, 'title': None, 'text': 'Best shop ever, ten out of ten.'})
        with auto_run([auto_config()], {URL: WALL}, bedrock=bedrock_read(), search=found,
                      model_lines=invented) as (run, _t, _s, _sn, _):
            assert list(run.fetch_new_items()) == []
        assert the_read(run)['steps'][-1]['outcome'] == 'no_reviews'

    def test_results_on_other_pages_of_the_site_are_not_read(self):
        found = [SearchResult('https://www.trustpilot.com/review/neighbour.com', None, SNIPPET, None)]
        line = json.dumps({'text': 'Great support team, they answered within an hour.'})
        with auto_run([auto_config()], {URL: WALL}, bedrock=bedrock_read(), search=found,
                      model_lines=line) as (run, _t, _s, _sn, _):
            assert list(run.fetch_new_items()) == []
        assert the_read(run)['steps'][-1] == {'method': 'agentcore_web_search', 'outcome': 'no_reviews', 'reviews': 0,
                                              'detail': 'no result on the page itself'}

    def test_when_nothing_reads_it_one_error_names_every_step(self):
        with auto_run([auto_config()], {URL: WALL}, bedrock=WebSearchError('HTTP 403: denied'),
                      search=SnippetSearchError('HTTP 403: no', 403)) as (run, table, _s, _sn, _):
            assert list(run.fetch_new_items()) == []
        [error] = run.run_errors
        assert error.startswith('Trustpilot: no method read it (the browser: blocked by Cloudflare; Amazon Bedrock web '
                                'search: failed (HTTP 403: denied)')
        assert the_read(run)['method_used'] is None
        assert table.puts[-1]['best_method'] == 'none'

    def test_a_browser_that_reads_the_page_ends_the_cascade(self):
        with auto_run([auto_config()]) as (run, table, searched, snippets, _):
            items = list(run.fetch_new_items())
        assert [item['metadata']['method_used'] for item in items] == ['browser', 'browser']
        searched.assert_not_called()
        snippets.assert_not_called()
        assert the_read(run)['steps'] == [{'method': 'browser', 'outcome': 'readable', 'reviews': 2}]
        assert table.puts[-1]['best_method'] == 'browser'

    def test_a_redirect_to_an_error_page_is_a_block(self):
        error_page = page(url='chrome-error://chromewebdata/', text='This site cannot be reached', jsonld=())
        with auto_run([auto_config()], {URL: error_page}, bedrock=bedrock_read('Cached review.')) as (run, *_):
            assert [item['text'] for item in run.fetch_new_items()] == ['Cached review.']
        assert the_read(run)['steps'][0] == {'method': 'browser', 'outcome': 'blocked', 'reviews': 0,
                                             'vendor': 'an error page'}

    def test_a_redirect_to_another_sites_page_ends_the_read(self):
        moved = page(url='https://www.example.net/landing', jsonld=())
        with auto_run([auto_config()], {URL: moved}) as (run, _t, searched, _sn, _):
            assert list(run.fetch_new_items()) == []
        searched.assert_not_called()
        assert run.run_errors == ['Trustpilot: redirected off-host']

    def test_a_page_that_did_not_load_goes_to_the_next_step(self):
        from page_reader import PageLoadError

        tab = MagicMock()
        tab.load.side_effect = PageLoadError('the page did not load (net::ERR_NAME_NOT_RESOLVED)')
        from web_reviews.ingestor import handler

        with auto_run([auto_config()], bedrock=bedrock_read('From the cache.')) as (run, *_), \
                patch.object(handler, 'BrowserTab', return_value=tab):
            assert [item['text'] for item in run.fetch_new_items()] == ['From the cache.']
        assert the_read(run)['steps'][0]['outcome'] == 'error'

    def test_the_snippet_step_is_not_run_where_agentcore_web_search_is_not_offered(self, monkeypatch):
        monkeypatch.setenv('AWS_REGION', 'eu-central-1')
        with auto_run([auto_config()], {URL: WALL}, bedrock=bedrock_read()) as (run, _t, _s, snippets, _):
            list(run.fetch_new_items())
        snippets.assert_not_called()
        assert the_read(run)['steps'][-1] == {'method': 'agentcore_web_search', 'outcome': 'not_offered', 'reviews': 0}


class TestNoReviews:
    EMPTY = page(jsonld=(), text='Nothing here yet.')

    def test_no_review_on_a_page_never_read_before_goes_to_the_next_step(self):
        with auto_run([auto_config()], {URL: self.EMPTY}, bedrock=bedrock_read('Cached one.')) as (run, *_):
            assert [item['text'] for item in run.fetch_new_items()] == ['Cached one.']
        assert the_read(run)['steps'][0] == {'method': 'browser', 'outcome': 'no_reviews', 'reviews': 0}

    def test_the_snippet_query_is_the_pages_own_title_when_the_browser_read_it(self):
        titled = page(jsonld=(), text='Nothing here yet.', title='Example Shop Reviews | Trustpilot')
        with auto_run([auto_config()], {URL: titled}, bedrock=bedrock_read(), search=[]) as (run, _t, _s, snippets, _):
            list(run.fetch_new_items())
        assert snippets.call_args.args == ('Example Shop Reviews | Trustpilot', DOMAIN)

    def test_no_review_on_a_page_that_declares_some_goes_to_the_next_step(self):
        declared = page(jsonld=(json.dumps({'@type': 'Product', 'aggregateRating': {
            '@type': 'AggregateRating', 'ratingValue': 4.1, 'reviewCount': 812}}),), text='Reviews load later.')
        watermarks = WatermarkTable({wm('target_t1_last_run'): '2026-11-01T00:00:00+00:00'})
        with auto_run([auto_config()], {URL: declared}, watermarks=watermarks,
                      bedrock=bedrock_read('Cached one.')) as (run, *_):
            assert [item['text'] for item in run.fetch_new_items()] == ['Cached one.']

    def test_a_page_known_to_have_none_is_read_as_it_is(self):
        watermarks = WatermarkTable({wm('target_t1_last_run'): '2026-11-01T00:00:00+00:00'})
        with auto_run([auto_config()], {URL: self.EMPTY}, watermarks=watermarks) as (run, _t, searched, _sn, _):
            assert list(run.fetch_new_items()) == []
        searched.assert_not_called()
        assert the_read(run)['steps'] == [{'method': 'browser', 'outcome': 'readable', 'reviews': 0}]
        assert run.run_errors == []


class TestTheTimeBudget:
    def test_a_later_step_without_the_time_for_it_is_skipped_and_reported(self):
        with auto_run([auto_config()], {URL: WALL}) as (run, table, searched, snippets, _):
            browser_step = run._browser_step

            def then_no_time(tab, cascade):
                yield from browser_step(tab, cascade)
                run._deadline = 0.0

            with patch.object(run, '_browser_step', then_no_time):
                assert list(run.fetch_new_items()) == []
        searched.assert_not_called()
        snippets.assert_not_called()
        assert [step['outcome'] for step in the_read(run)['steps']] == ['blocked', 'skipped_time', 'skipped_time']
        [error] = run.run_errors
        assert 'Amazon Bedrock web search: skipped, the run ran out of time' in error
        assert set(table.puts[-1]['methods']) == {'browser'}  # a skipped step learns nothing


class TestWhatTheWorkspaceLearned:
    def test_a_fresh_best_method_is_read_first_and_no_browser_session_starts(self):
        known = stored_record('bedrock_web_search', steps={'bedrock_web_search': ('readable', DAY),
                                                           'browser': ('blocked:Cloudflare', 2 * DAY)})
        with auto_run([auto_config()], table=AggregatesTable([known]),
                      bedrock=bedrock_read('Known path.')) as (run, table, _s, _sn, session):
            assert [item['text'] for item in run.fetch_new_items()] == ['Known path.']
        session.__enter__.assert_not_called()
        read = the_read(run)
        assert (read['plan'], read['known_method'], read['learned_at']) == (
            'known', 'bedrock_web_search', known['learned_at'])
        assert table.puts[-1]['methods']['bedrock_web_search']['successes'] == 2

    def test_a_known_method_that_fails_now_continues_the_cascade_from_the_top(self):
        known = stored_record('bedrock_web_search', steps={'bedrock_web_search': ('readable', DAY),
                                                           'browser': ('blocked:Cloudflare', 10 * DAY)})
        with auto_run([auto_config()], table=AggregatesTable([known]),
                      bedrock=bedrock_read(fetched=False)) as (run, table, _s, _sn, _):
            items = list(run.fetch_new_items())
        assert [item['metadata']['method_used'] for item in items] == ['browser', 'browser']
        assert [s['method'] for s in the_read(run)['steps']] == ['bedrock_web_search', 'browser']
        assert table.puts[-1]['best_method'] == 'browser'

    def test_a_recent_block_keeps_the_browser_out(self):
        known = stored_record('bedrock_web_search', steps={'bedrock_web_search': ('readable', DAY),
                                                           'browser': ('blocked:Cloudflare', 2 * DAY)})
        with auto_run([auto_config()], table=AggregatesTable([known]), bedrock=bedrock_read(fetched=False),
                      search=[]) as (run, _t, _s, _sn, session):
            list(run.fetch_new_items())
        session.__enter__.assert_not_called()
        assert [s['method'] for s in the_read(run)['steps']] == ['bedrock_web_search', 'agentcore_web_search']

    def test_the_browser_is_re_checked_when_it_was_last_tried_long_ago(self):
        known = stored_record('bedrock_web_search', steps={'bedrock_web_search': ('readable', DAY),
                                                           'browser': ('blocked:Cloudflare', 15 * DAY)})
        with auto_run([auto_config()], {URL: WALL}, table=AggregatesTable([known]),
                      bedrock=bedrock_read('Still the index.')) as (run, table, *_):
            assert [item['text'] for item in run.fetch_new_items()] == ['Still the index.']
        read = the_read(run)
        assert read['plan'] == 'reprobe'
        assert [(s['method'], s['outcome']) for s in read['steps']] == [('browser', 'blocked'),
                                                                        ('bedrock_web_search', 'readable')]
        assert table.puts[-1]['methods']['browser']['last_at'] > known['methods']['browser']['last_at']

    def test_two_pages_of_one_site_share_the_record(self):
        second = auto_config(id='t2', app_name='Second', url='https://www.trustpilot.com/review/second.com')
        pages = {URL: WALL, second['url']: WALL}
        with auto_run([auto_config(), second], pages) as (run, table, searched, _sn, _):
            searched.side_effect = [bedrock_read('One.'), bedrock_read('Two.')]
            assert [item['text'] for item in run.fetch_new_items()] == ['One.', 'Two.']
        assert table.puts[-1]['methods']['bedrock_web_search']['successes'] == 2

    def test_the_record_is_the_workspaces_own(self):
        from shared.web_review_methods import MethodRecord, write_record

        with pytest.raises(OutOfScopeError):
            write_record(ws_table(SCOPE, AggregatesTable()), OTHER_SCOPE, MethodRecord(DOMAIN), '2026-11-16T00:00:00+00:00')

    def test_a_record_that_cannot_be_saved_does_not_fail_the_run(self):
        failing = AggregatesTable()
        failing.put_item = MagicMock(side_effect=OutOfScopeError('no'))
        with auto_run([auto_config()], table=failing) as (run, *_):
            assert len(list(run.fetch_new_items())) == 2


class TestTheRunRow:
    def test_the_completed_run_carries_the_reads(self):
        with auto_run([auto_config()], {URL: WALL}, bedrock=bedrock_read('Fast refunds.')) as (run, *_):
            list(run.fetch_new_items())
            run.aggregates_table = MagicMock()
            run._update_source_run_status({'status': 'completed', 'items_found': 1})
        values = run.aggregates_table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert values[':reads'][0]['method_used'] == 'bedrock_web_search'

    def test_a_browser_target_has_its_read_too(self):
        with ingestor([target_config()]) as run:
            list(run.fetch_new_items())
        assert the_read(run) == {
            'target': 'Trustpilot', 'target_id': 't1', 'method': 'browser', 'method_used': 'browser', 'reviews': 2,
            'steps': [{'method': 'browser', 'outcome': 'readable', 'reviews': 2}], 'excerpt': False, 'plan': None,
            'known_method': None, 'learned_at': None}
