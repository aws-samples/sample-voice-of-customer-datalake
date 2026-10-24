"""Radar release citations: one per page, https first, no machine feeds (docs/radar.md)."""
from datetime import date
from unittest.mock import MagicMock

import pytest
from moto import mock_aws

from shared.radar_citations import MAX_CITATIONS, clean_citations, is_feed_url, normalise_url
from shared.radar_releases import ReleaseCandidate, list_releases, public_release, store_candidate
from shared.test.radar_fixtures import radar_pk_sk_table


class TestNormalise:
    @pytest.mark.parametrize(('raw', 'clean'), [
        ('https://Blog.ACME.com/news#top', 'https://blog.acme.com/news'),
        ('https://acme.com/a?utm_source=x&id=7&UTM_medium=y&gclid=z', 'https://acme.com/a?id=7'),
        ('HTTPS://acme.com:443', 'https://acme.com/'),
        ('http://acme.com:8080/x', 'http://acme.com:8080/x'),
    ])
    def test_host_fragment_and_tracking_parameters(self, raw, clean):
        assert normalise_url(raw) == clean

    @pytest.mark.parametrize('raw', ['ftp://acme.com/x', 'javascript:alert(1)', '', None, 7, 'https://'])
    def test_anything_but_a_web_url_is_not_a_citation(self, raw):
        assert normalise_url(raw) is None


class TestFeeds:
    @pytest.mark.parametrize('url', [
        'https://example-air.example/rss/changelog.json', 'https://acme.com/blog/feed', 'https://acme.com/feeds/all',
        'https://acme.com/index.xml', 'https://acme.com/news.rss', 'https://acme.com/releases.atom',
        'https://acme.com/api/v1/releases.JSON',
    ])
    def test_machine_feeds_are_detected(self, url):
        assert is_feed_url(url)

    @pytest.mark.parametrize('url', ['https://acme.com/feedback', 'https://acme.com/blog/rss-explained',
                                     'https://example-air.example/changelog'])
    def test_pages_are_not_feeds(self, url):
        assert not is_feed_url(url)


class TestClean:
    def test_duplicates_collapse_to_one_https_citation_keeping_a_title(self):
        urls = ['http://www.acme.com/news/', 'https://acme.com/news?utm_source=x', 'https://acme.com/news#a']
        assert clean_citations(urls, ['', 'Acme news', 'Other']) == (['https://acme.com/news'], ['Acme news'])

    def test_feeds_are_dropped_and_titles_stay_beside_their_urls(self):
        urls = ['https://example-air.example/rss/changelog.json', 'https://example-air.example/changelog', 'https://news.example/a']
        assert clean_citations(urls, ['Feed', 'Changelog', 'News']) == (
            ['https://example-air.example/changelog', 'https://news.example/a'], ['Changelog', 'News'])

    def test_http_is_kept_but_ranked_after_https(self):
        urls = ['http://old.example/a', 'https://new.example/b']
        assert clean_citations(urls, ['Old', 'New']) == (['https://new.example/b', 'http://old.example/a'],
                                                        ['New', 'Old'])

    def test_a_missing_title_reads_as_the_host_and_the_list_is_capped(self):
        urls = [f'https://www.site{n}.example/x' for n in range(MAX_CITATIONS + 5)]
        clean_urls, titles = clean_citations(urls)
        assert (len(clean_urls), titles[0]) == (MAX_CITATIONS, 'site0.example')


def _unit(index):
    vector = [0.0] * 1024
    vector[index] = 1.0
    return vector


def _candidate(urls, titles):
    return ReleaseCandidate(brand='acme', brand_label='Acme', feature='Dark mode', summary='s',
                            release_date='2026-03-01', urls=tuple(urls), titles=tuple(titles))


class TestStoredReleases:
    def test_a_merge_dedupes_the_union_and_drops_feeds(self):
        with mock_aws():
            table = radar_pk_sk_table('radar')
            store_candidate(table, _candidate(['http://acme.com/dark'], ['Dark']), _unit(0), date(2026, 3, 1), 't1')
            store_candidate(table, _candidate(['https://acme.com/dark#x', 'https://acme.com/rss/feed.xml'],
                                              ['Dark mode', 'Feed']), _unit(0), date(2026, 3, 1), 't2')
            rows = list_releases(table, 'acme', date(2026, 1, 1), 10)
        assert [(r['urls'], r['titles'], r['mentions']) for r in rows] == [(['https://acme.com/dark'], ['Dark'], 2)]

    def test_rows_stored_before_the_cleaning_render_clean(self):
        row = {'release_id': 'r1', 'urls': ['https://example-air.example/rss/changelog.json', 'http://example-air.example/changelog',
                                            'https://example-air.example/changelog?utm_campaign=x'],
               'titles': ['Feed', 'Changelog']}
        view = public_release(row)
        assert (view['urls'], view['titles']) == (['https://example-air.example/changelog'], ['Changelog'])


def test_the_scan_files_no_release_cited_only_by_feeds(monkeypatch):
    from jobs.radar_scan import extract

    answer = '{"releases": [{"feature": "API", "release_date": "2026-03-01", "summary": "s", "sources": [1]}]}'
    monkeypatch.setattr(extract, 'converse', MagicMock(return_value=answer))
    ctx = extract.ExtractContext('example-air', 'Example Air', ('example-air.example',), date(2026, 3, 2), extract.Budget(0), MagicMock())
    results = [{'title': 'Feed', 'url': 'https://example-air.example/rss/changelog.json', 'published_date': '2026-03-01'}]
    assert extract.extract_candidates(results, ctx) == []
