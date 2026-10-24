"""Pagination: next-link detection (the real snapshot JS in jsdom), the page-parameter fallback, the read loop."""
import json
import shutil
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest
from extract import ExtractedReview
from page_reader import NEXT_WORDS, SNAPSHOT_JS, PageSnapshot, page_parameter_successor, same_origin
from target_reader import ReadLimits, next_page_url, read_target

JSDOM = Path(__file__).resolve().parents[3] / 'frontend' / 'node_modules' / 'jsdom'
NODE = shutil.which('node')
BASE = 'https://reviews.example.com/r/acme'
NODE_RUNNER = """
const { JSDOM } = require(process.argv[1]);
const [html, url, snapshot, words] = [process.argv[2], process.argv[3], process.argv[4], JSON.parse(process.argv[5])];
const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
const run = dom.window.eval('(' + snapshot + ')');
const limits = { jsonldChars: 400000, jsonldBlocks: 50, htmlChars: 20000, textChars: 160000 };
run('navigate', null, words, limits).then((out) => process.stdout.write(out));
"""


@pytest.fixture(autouse=True)
def public_dns():
    """Every host resolves to a public address (no DNS in unit tests)."""
    with patch('shared.web_review_targets.validate_url', return_value=(True, '')):
        yield


def run_snapshot_js(html: str) -> dict:
    if NODE is None or not JSDOM.exists():
        pytest.skip('node + frontend jsdom are needed to run the snapshot script')
    completed = subprocess.run(  # noqa: S603 - fixed argv, test-only
        [NODE, '-e', NODE_RUNNER, str(JSDOM), html, BASE, SNAPSHOT_JS, json.dumps(list(NEXT_WORDS))],
        capture_output=True, text=True, check=True, timeout=60,
    )
    return json.loads(completed.stdout)


class TestSnapshotScript:
    @pytest.mark.parametrize('html', [
        '<html><head><link rel="next" href="?page=2"></head><body>Reviews</body></html>',
        '<html><body><a rel="next nofollow" href="/r/acme?page=2">2</a></body></html>',
        '<html><body><a href="/r/acme?page=2">Siguiente</a></body></html>',
        '<html><body><a aria-label="Next page" href="/r/acme?page=2"><svg></svg></a></body></html>',
        '<html><body><a href="/r/acme?page=2"> \u203a </a></body></html>',
    ])
    def test_finds_the_next_page_link(self, html):
        assert run_snapshot_js(html)['next'] == 'https://reviews.example.com/r/acme?page=2'

    def test_no_next_link_is_null(self):
        assert run_snapshot_js('<html><body><a href="/about">About us</a></body></html>')['next'] is None

    def test_returns_the_json_ld_blocks(self):
        html = '<html><body><script type="application/ld+json">{"@type":"Review","reviewBody":"Good"}</script></body></html>'
        assert run_snapshot_js(html)['ld'] == ['{"@type":"Review","reviewBody":"Good"}']


@pytest.mark.parametrize(('url', 'expected'), [
    ('https://a.example/r?page=2', 'https://a.example/r?page=3'),
    ('https://a.example/r?sort=new&p=9', 'https://a.example/r?sort=new&p=10'),
    ('https://a.example/r', None),
    ('https://a.example/r?page=last', None),
])
def test_page_parameter_successor(url, expected):
    assert page_parameter_successor(url) == expected


def test_same_origin():
    assert same_origin('https://a.example/x', 'https://a.example/y?page=2')
    assert not same_origin('https://a.example/x', 'https://b.example/x')


def snapshot(url: str = BASE, next_url: str | None = None, text: str = 'x' * 4000) -> PageSnapshot:
    return PageSnapshot(url=url, status=200, title='Reviews', text=text, html='<html></html>', jsonld=(), next_url=next_url)


class TestNextPageUrl:
    def test_follows_the_next_link_on_the_same_host(self):
        assert next_page_url(snapshot(next_url=f'{BASE}?page=2'), BASE, set()) == f'{BASE}?page=2'

    def test_never_leaves_the_target_host(self):
        assert next_page_url(snapshot(next_url='https://ads.example.net/x'), BASE, set()) is None

    def test_never_revisits_a_page(self):
        assert next_page_url(snapshot(next_url=f'{BASE}?page=2'), BASE, {f'{BASE}?page=2'}) is None

    def test_falls_back_to_the_page_parameter(self):
        assert next_page_url(snapshot(url=f'{BASE}?page=3'), BASE, set()) == f'{BASE}?page=4'

    @pytest.mark.parametrize('elsewhere', [
        'http://reviews.example.com/r?page=2',
        'https://reviews.example.com:8443/r?page=2',
        'https://evil.example.net/r?page=2',
    ])
    def test_the_next_page_keeps_the_target_origin(self, elsewhere):
        with patch('target_reader.checked_url', side_effect=lambda url: url):  # the origin check alone decides
            assert next_page_url(snapshot(next_url=elsewhere), BASE, set()) is None
            assert next_page_url(snapshot(next_url=f'{BASE}?page=2'), BASE, set()) == f'{BASE}?page=2'

    def test_refuses_plain_http(self):
        assert next_page_url(snapshot(next_url='http://reviews.example.com/r?page=2'), BASE, set()) is None


class ScriptedTab:
    """Pages by URL; records what was loaded and fetched."""

    def __init__(self, pages: dict[str, PageSnapshot]):
        self.pages = pages
        self.visited: list[str] = []

    def load(self, url: str) -> PageSnapshot:
        self.visited.append(url)
        return self.pages[url]

    fetch = load


def review(text: str, day: str | None = '2026-10-01') -> ExtractedReview:
    return ExtractedReview(text=text, rating=None, date=day, title=None, author=None)


def limits(max_pages: int = 5, max_reviews: int = 100, is_new=lambda _r: True) -> ReadLimits:
    return ReadLimits(max_pages=max_pages, max_reviews=max_reviews, has_time=lambda: True, is_new=is_new)


def chain(count: int) -> dict[str, PageSnapshot]:
    urls = [BASE] + [f'{BASE}?page={n}' for n in range(2, count + 1)]
    return {url: snapshot(url=url, next_url=urls[i + 1] if i + 1 < len(urls) else None) for i, url in enumerate(urls)}


def per_page(*page_reviews: list[ExtractedReview]):
    by_url = {BASE: page_reviews[0], **{f'{BASE}?page={n + 2}': r for n, r in enumerate(page_reviews[1:])}}
    return lambda snap: by_url[snap.url]


class TestReadTarget:
    def test_reads_pages_until_max_pages(self):
        tab = ScriptedTab(chain(5))
        result = read_target(tab, BASE, per_page(*[[review(f'r{n}')] for n in range(5)]), limits(max_pages=3))
        assert (result.pages_read, len(result.reviews), len(tab.visited)) == (3, 3, 3)

    def test_stops_at_a_page_without_new_reviews(self):
        tab = ScriptedTab(chain(4))
        extract = per_page([review('a')], [review('a')], [review('c')], [review('d')])
        result = read_target(tab, BASE, extract, limits())
        assert ([r.review.text for r in result.reviews], result.pages_read) == (['a'], 2)

    def test_reviews_older_than_the_watermark_are_not_new(self):
        tab = ScriptedTab(chain(2))
        extract = per_page([review('new'), review('old', '2020-01-01')], [review('older', '2019-01-01')])
        result = read_target(tab, BASE, extract, limits(is_new=lambda r: r.date is None or r.date >= '2026-01-01'))
        assert ([r.review.text for r in result.reviews], result.pages_read) == (['new'], 2)

    def test_a_blocked_first_page_reports_the_vendor(self):
        wall = PageSnapshot(url=BASE, status=403, title='', text='', html='<script src="https://ct.captcha-delivery.com/c.js">',
                            jsonld=(), next_url=None)
        result = read_target(ScriptedTab({BASE: wall}), BASE, per_page([]), limits())
        assert (result.blocked, result.pages_read, result.reviews) == ('DataDome', 0, [])

    def test_a_block_on_a_later_page_keeps_what_was_read(self):
        pages = chain(2)
        pages[f'{BASE}?page=2'] = PageSnapshot(url=f'{BASE}?page=2', status=429, title='', text='', html='', jsonld=(), next_url=None)
        result = read_target(ScriptedTab(pages), BASE, per_page([review('a')], []), limits())
        assert (result.blocked, [r.review.text for r in result.reviews]) == ('HTTP 429', ['a'])

    @pytest.mark.parametrize('status', [404, 410])
    def test_a_next_page_that_does_not_exist_ends_the_list_and_is_not_a_block(self, status):
        """Live-caught on Trustpilot: `?page=4` of a 3-page list answered 404, reported as "blocked by HTTP 404"."""
        pages = chain(2)
        pages[f'{BASE}?page=2'] = PageSnapshot(url=f'{BASE}?page=2', status=status, title='', text='', html='', jsonld=(), next_url=None)
        result = read_target(ScriptedTab(pages), BASE, per_page([review('a')]), limits())
        assert (result.stop, result.blocked, result.pages_read, [r.review.text for r in result.reviews]) == (
            'no_next', None, 1, ['a'])

    def test_a_first_page_that_does_not_exist_is_still_reported(self):
        missing = PageSnapshot(url=BASE, status=404, title='', text='', html='', jsonld=(), next_url=None)
        result = read_target(ScriptedTab({BASE: missing}), BASE, per_page([]), limits())
        assert (result.stop, result.blocked) == ('blocked', 'HTTP 404')

    def test_a_redirect_off_host_on_page_one_stops_the_target(self):
        moved = snapshot(url='https://elsewhere.example.net/r', next_url='https://elsewhere.example.net/r?page=2')
        result = read_target(ScriptedTab({BASE: moved}), BASE, lambda _s: [review('foreign')], limits())
        assert (result.off_host, result.pages_read, result.reviews) == (True, 0, [])

    def test_a_redirect_off_host_after_a_fetch_keeps_what_was_read(self):
        pages = chain(3)
        pages[f'{BASE}?page=2'] = snapshot(url='https://elsewhere.example.net/r', next_url=None)
        result = read_target(ScriptedTab(pages), BASE, lambda s: [review(s.url)], limits())
        assert (result.off_host, result.pages_read, [r.review.text for r in result.reviews]) == (True, 1, [BASE])

    def test_records_the_page_each_review_came_from(self):
        tab = ScriptedTab(chain(2))
        result = read_target(tab, BASE, per_page([review('a')], [review('b')]), limits(max_pages=2))
        assert [(r.page, r.page_url) for r in result.reviews] == [(1, BASE), (2, f'{BASE}?page=2')]
