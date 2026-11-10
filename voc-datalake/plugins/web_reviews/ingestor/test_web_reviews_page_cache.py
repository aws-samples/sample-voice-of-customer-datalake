"""The page cache: an unchanged page costs no model call; a changed one is read; one write per changed page."""
import hashlib
from unittest.mock import patch

from page_cache import PageCache, normalised_url, page_digest
from page_reader import PageSnapshot
from test_web_reviews_handler import URL, WatermarkTable, ingestor, page, target_config

from web_reviews.ingestor import handler

ANSWER = '{"text": "Seat was broken.", "rating": 2}'


def text_page(text: str = 'Seat was broken. 2 stars.') -> PageSnapshot:
    return page(jsonld=(), text=text)


def cache_key(url: str = URL) -> str:
    return f'test_source#target_t1_page_{hashlib.sha256(url.encode()).hexdigest()[:16]}'


class TestTheKeyAndTheDigest:
    def test_the_key_hashes_the_normalised_url(self):
        cache = PageCache('target_t1', lambda _k: None, lambda _k, _v: None)
        assert cache.key('HTTPS://WWW.Trustpilot.com/review/example.com#reviews') == cache_key()[len('test_source#'):]

    def test_the_path_and_query_are_kept(self):
        assert normalised_url('https://A.example/R?page=2#x') == 'https://a.example/R?page=2'

    def test_the_digest_covers_the_json_ld_and_the_text(self):
        base = page_digest(text_page())
        assert base == hashlib.sha256(b'Seat was broken. 2 stars.').hexdigest()
        assert page_digest(page(jsonld=('{}',), text='Seat was broken. 2 stars.')) != base
        assert page_digest(text_page('Other text')) != base


class TestOneWritePerChangedPage:
    def test_remember_writes_once_and_not_again_when_unchanged(self):
        stored: dict[str, str] = {}
        writes: list[str] = []

        def put(key: str, value: str) -> None:
            writes.append(key)
            stored[key] = value

        cache = PageCache('p', stored.get, put)
        snapshot = text_page()
        assert cache.unchanged(snapshot) is False
        cache.remember(snapshot)
        cache.remember(snapshot)
        assert (cache.unchanged(snapshot), len(writes)) == (True, 1)

    def test_the_stored_hash_is_read_once_per_page(self):
        reads: list[str] = []
        def get(key: str) -> None:
            reads.append(key)

        cache = PageCache('p', get, lambda _k, _v: None)
        cache.unchanged(text_page())
        cache.remember(text_page())
        assert len(reads) == 1


def run(table: WatermarkTable, snapshot: PageSnapshot) -> tuple[list[dict], list[str]]:
    calls: list[str] = []

    def complete(prompt: str, _system: str) -> str:
        calls.append(prompt)
        return ANSWER

    with ingestor([target_config()], {URL: snapshot}, table=table) as ingest, \
            patch.object(handler, 'BrowserTab', return_value=_Tab(snapshot)):
        ingest._complete = complete
        items = list(ingest.fetch_new_items())
    return items, calls


class _Tab:
    def __init__(self, snapshot: PageSnapshot):
        self.snapshot = snapshot

    def open(self) -> None:
        return None

    def load(self, _url: str) -> PageSnapshot:
        return self.snapshot

    fetch = load


class TestTheCacheInARun:
    def test_the_first_read_calls_the_model_and_stores_the_hash(self):
        table = WatermarkTable()
        items, calls = run(table, text_page())
        assert (len(items), len(calls)) == (1, 1)
        assert table.values[cache_key()] == page_digest(text_page())

    def test_an_unchanged_page_skips_the_model_call(self):
        table = WatermarkTable()
        run(table, text_page())
        items, calls = run(table, text_page())
        assert (items, calls) == ([], [])

    def test_a_changed_page_is_read_again(self):
        table = WatermarkTable()
        run(table, text_page())
        items, calls = run(table, text_page('Seat was broken. 2 stars. And a new review.'))
        assert (len(items), len(calls)) == (1, 1)
        assert table.values[cache_key()] == page_digest(text_page('Seat was broken. 2 stars. And a new review.'))

    def test_a_backfill_reads_an_unchanged_page_anyway(self):
        table = WatermarkTable()
        run(table, text_page())
        table.values['test_source#target_t1_resume'] = f'{{"url": "{URL}", "page": 0, "reviews": 0}}'
        items, calls = run(table, text_page())
        assert (len(items), len(calls)) == (1, 1)
