"""The reading modes and the backfill across runs: review limits, every page, the stop reasons, the resume cursor.

Reader-level cases drive ``read_target`` over scripted pages; run-level cases drive the ingestor end to end
(``test_web_reviews_handler.ingestor``) with a recording tab and a watermarks table that outlives one run.
"""
import json
from collections.abc import Callable
from dataclasses import replace
from typing import Any
from unittest.mock import patch

import pytest
from page_reader import PageSnapshot
from resume import ResumeCursor, ResumeStore, next_cursor, parsed_cursor
from target_reader import Stop, TargetResult, read_target
from test_web_reviews_handler import URL, WatermarkTable, ingestor, page, target_config
from test_web_reviews_pagination import BASE, ScriptedTab, chain, limits, per_page, public_dns, review
from web_items import WebTarget

from web_reviews.ingestor import handler

__all__ = ['public_dns']  # the autouse no-DNS fixture of the pagination suite applies here too

KEY = 'test_source#target_t1_resume'
PAGES = [URL] + [f'{URL}?page={n}' for n in range(2, 5)]


def texts(result: TargetResult) -> list[str]:
    return [r.review.text for r in result.reviews]


class TestTheReaderSaysWhyItStopped:
    def test_a_review_limit_stops_the_target_across_pages(self):
        tab = ScriptedTab(chain(5))
        result = read_target(tab, BASE, lambda s: [review(f'{s.url} a'), review(f'{s.url} b')], limits(max_reviews=3))
        assert (len(result.reviews), result.pages_read, result.stop) == (3, 2, 'reviews')
        assert (result.resume_url, result.resume_page) == (f'{BASE}?page=2', 1)  # page 2 was cut: it is read again

    def test_a_cap_reached_at_a_page_end_resumes_at_the_next_page(self):
        tab = ScriptedTab(chain(3))
        result = read_target(tab, BASE, per_page([review('a')], [review('b')], [review('c')]), limits(max_reviews=2))
        assert (result.stop, result.resume_url, result.resume_page) == ('reviews', f'{BASE}?page=3', 2)

    def test_every_page_means_up_to_the_hundred_page_cap(self):
        tab = ScriptedTab(chain(120))
        result = read_target(tab, BASE, lambda s: [review(s.url)], limits(max_pages=100, max_reviews=5000))
        assert (result.pages_read, len(tab.visited), result.stop, result.resume_url) == (100, 100, 'pages', None)

    def test_out_of_time_with_a_next_page_names_it(self):
        ticks = iter([True, False])
        lim = replace(limits(), has_time=lambda: next(ticks))
        result = read_target(ScriptedTab(chain(4)), BASE, lambda s: [review(s.url)], lim)
        assert (result.pages_read, result.stop, result.resume_url, result.resume_page) == (2, 'time', f'{BASE}?page=3', 2)

    @pytest.mark.parametrize(('count', 'max_pages', 'stop'), [(1, 5, 'no_next'), (3, 2, 'pages')])
    def test_the_other_endings(self, count, max_pages, stop):
        result = read_target(ScriptedTab(chain(count)), BASE, lambda s: [review(s.url)], limits(max_pages=max_pages))
        assert (result.stop, result.resume_url) == (stop, None)

    def test_a_page_without_new_reviews_is_no_new(self):
        result = read_target(ScriptedTab(chain(2)), BASE, per_page([review('a')], [review('a')]), limits())
        assert result.stop == 'no_new'


def backfill(start_page: int = 2, **fields: Any):
    return replace(limits(**fields), start_page=start_page, stop_when_nothing_new=False)


class TestABackfillRead:
    def test_counts_pages_from_the_cursor_and_ignores_a_page_with_nothing_new(self):
        tab = ScriptedTab(chain(5))
        start = f'{BASE}?page=3'
        extract = {start: [], f'{BASE}?page=4': [review('d')], f'{BASE}?page=5': [review('e')]}
        result = read_target(tab, start, lambda s: extract[s.url], backfill(max_pages=5))
        assert (tab.visited, result.pages_read, result.stop) == ([start, f'{BASE}?page=4', f'{BASE}?page=5'], 5, 'pages')
        assert [(r.review.text, r.page) for r in result.reviews] == [('d', 4), ('e', 5)]

    def test_the_page_limit_counts_the_cursor_pages(self):
        result = read_target(ScriptedTab(chain(5)), f'{BASE}?page=3', lambda s: [review(s.url)], backfill(max_pages=3))
        assert (result.pages_read, result.stop) == (3, 'pages')


def web_target(**fields: Any) -> WebTarget:
    values: dict = {'id': 't1', 'name': 'T', 'url': URL, 'max_pages': 0, 'max_reviews': 0, 'frequency_minutes': 0,
                    'enabled': True}
    return WebTarget(**{**values, **fields})


def stored(url: str = PAGES[2], page: int = 2, reviews: int = 4) -> str:
    return json.dumps({'url': url, 'page': page, 'reviews': reviews})


class TestTheStoredCursor:
    def test_a_well_formed_cursor_is_read(self):
        assert parsed_cursor(stored(), web_target()) == ResumeCursor(PAGES[2], 2, 4)

    @pytest.mark.parametrize('value', [
        None, '', 'not json', '[]', stored(url='https://elsewhere.example.net/x'), stored(url='http://www.trustpilot.com/x'),
        json.dumps({'url': PAGES[2], 'page': True, 'reviews': 0}), json.dumps({'url': PAGES[2], 'page': -1, 'reviews': 0}),
        json.dumps({'url': PAGES[2], 'page': 1}), json.dumps({'url': 7, 'page': 1, 'reviews': 0}),
    ])
    def test_a_malformed_or_foreign_cursor_is_none(self, value):
        assert parsed_cursor(value, web_target()) is None

    @pytest.mark.parametrize(('fields', 'page', 'reviews', 'kept'), [
        ({'max_pages': 2}, 2, 0, False), ({'max_pages': 3}, 2, 0, True), ({'max_pages': 0}, 99, 0, True),
        ({'max_pages': 0}, 100, 0, False), ({'max_reviews': 4}, 1, 4, False), ({'max_reviews': 5}, 1, 4, True),
    ])
    def test_a_cursor_past_the_targets_limits_is_dropped(self, fields, page, reviews, kept):
        assert (parsed_cursor(stored(page=page, reviews=reviews), web_target(**fields)) is not None) is kept

    def test_the_store_writes_only_a_change_and_clears_only_what_was_stored(self):
        values: dict[str, str] = {}
        writes: list[tuple[str, str]] = []

        def put(key: str, value: str) -> None:
            writes.append((key, value))
            values[key] = value

        store = ResumeStore(values.get, put)
        target = web_target()
        assert store.load(target) is None
        store.save(target, None)
        store.save(target, ResumeCursor(PAGES[1], 1, 2))
        store.save(target, ResumeCursor(PAGES[1], 1, 2))
        store.save(target, None)
        assert writes == [('target_t1_resume', f'{{"url":"{PAGES[1]}","page":1,"reviews":2}}'), ('target_t1_resume', '')]


class TestTheNextCursor:
    def result(self, stop: Stop, resume_url: str | None = PAGES[2], taken: int = 2) -> TargetResult:
        reads = read_target(ScriptedTab(chain(1)), BASE, lambda _s: [review(f'r{n}') for n in range(taken)], limits()).reviews
        return TargetResult(reviews=reads, pages_read=2, stop=stop, resume_url=resume_url, resume_page=2)

    @pytest.mark.parametrize('stop', ['pages', 'no_next', 'no_new', 'blocked', 'off_host'])
    def test_any_other_ending_finishes_the_target(self, stop):
        assert next_cursor(None, self.result(stop), target_limit_left=None) is None

    def test_no_page_left_finishes_the_target(self):
        assert next_cursor(None, self.result('time', resume_url=None), target_limit_left=None) is None

    def test_time_carries_the_reviews_of_the_earlier_cursor(self):
        assert next_cursor(ResumeCursor(PAGES[1], 1, 5), self.result('time'), target_limit_left=None) == ResumeCursor(PAGES[2], 2, 7)

    @pytest.mark.parametrize(('left', 'resumes'), [(None, True), (3, True), (2, False)])
    def test_the_run_cap_resumes_but_the_targets_own_limit_finishes(self, left, resumes):
        assert (next_cursor(None, self.result('reviews'), target_limit_left=left) is not None) is resumes


def jsonld_page(url: str, next_url: str | None, *reviews: tuple[str, str]) -> PageSnapshot:
    nodes = [{'@type': 'Review', 'reviewBody': text, 'datePublished': day} for text, day in reviews]
    return page(url=url, jsonld=(json.dumps(nodes),) if nodes else (), text='', next_url=next_url)


def site() -> dict[str, PageSnapshot]:
    """Four pages of old reviews, two per page (page 3 has none)."""
    nxt = [*PAGES[1:], None]
    found = {0: [('p1 a', '2026-01-04'), ('p1 b', '2026-01-04')], 1: [('p2 a', '2026-01-03'), ('p2 b', '2026-01-03')],
             2: [], 3: [('p4 a', '2026-01-01'), ('p4 b', '2026-01-01')]}
    return {url: jsonld_page(url, nxt[i], *found[i]) for i, url in enumerate(PAGES)}


class RecordingTab:
    def __init__(self, pages: dict[str, PageSnapshot]):
        self.pages = pages
        self.visited: list[str] = []

    def open(self) -> None:
        return None

    def load(self, url: str) -> PageSnapshot:
        self.visited.append(url)
        return self.pages[url]

    fetch = load


def run_once(table: WatermarkTable, has_time: Callable[[], bool] | None = None, **config: str) -> tuple[list[dict], RecordingTab]:
    tab = RecordingTab(site())
    with ingestor([target_config(**{'max_pages': '0', **config})], table=table) as run, patch.object(handler, 'BrowserTab', return_value=tab):
        if has_time is not None:
            run._has_time = has_time
        items = list(run.fetch_new_items())
    return items, tab


class TestTheBackfillAcrossRuns:
    def test_a_run_out_of_time_with_a_next_page_stores_the_cursor(self):
        table = WatermarkTable()
        ticks = iter([True, True, False])  # the target starts, page 2 is read, then no time is left
        items, _tab = run_once(table, lambda: next(ticks))
        assert [i['text'] for i in items] == ['p1 a', 'p1 b', 'p2 a', 'p2 b']
        assert json.loads(table.values[KEY]) == {'url': PAGES[2], 'page': 2, 'reviews': 4}

    def test_the_next_run_starts_at_the_cursor_and_reads_every_review_as_new(self):
        table = WatermarkTable({KEY: stored(), 'test_source#target_t1_newest_review': '2026-10-10'})
        with patch.object(handler, 'logger') as log:
            items, tab = run_once(table, max_pages='4')
        assert tab.visited == [PAGES[2], PAGES[3]]  # page 3 has nothing new and does not stop the backfill
        assert [(i['text'], i['metadata']['page']) for i in items] == [('p4 a', 4), ('p4 b', 4)]
        assert table.values[KEY] == ''  # the target's 4 pages are read: finished
        assert table.values['test_source#target_t1_newest_review'] == '2026-10-10'  # only ever forward
        log.info.assert_any_call('web_reviews www.trustpilot.com: resuming at page 3 (4 reviews read so far)')

    def test_the_carried_reviews_count_against_the_targets_limit(self):
        table = WatermarkTable({KEY: stored(url=PAGES[1], page=1, reviews=4)})
        items, _tab = run_once(table, max_reviews='5')
        assert ([i['text'] for i in items], table.values[KEY]) == (['p2 a'], '')

    def test_the_run_cap_leaves_a_cursor_at_the_cut_page(self):
        table = WatermarkTable()
        with patch.object(handler, 'MAX_REVIEWS_PER_RUN', 3):
            items, _tab = run_once(table)
        assert len(items) == 3
        assert json.loads(table.values[KEY]) == {'url': PAGES[1], 'page': 1, 'reviews': 3}

    def test_a_failed_read_clears_the_cursor(self):
        table = WatermarkTable({KEY: stored(url=f'{URL}?page=9')})
        items, _tab = run_once(table)
        assert (items, table.values[KEY]) == ([], '')

    def test_a_run_without_a_cursor_writes_none(self):
        table = WatermarkTable()
        run_once(table)
        assert KEY not in table.values
