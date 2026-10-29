"""Listing / index pages never decide a Radar same-page merge (5.47, docs/radar.md → "One record per story")."""
from datetime import date

import pytest
from moto import mock_aws

from shared.radar_listing_pages import is_listing_page
from shared.radar_releases import ReleaseCandidate, list_releases, store_candidate
from shared.test.radar_fixtures import radar_pk_sk_table

TODAY = date(2026, 10, 27)


@pytest.mark.parametrize('url', [
    'https://example.com/',
    'https://example.com',
    'https://example.com/news',
    'https://example.com/news/',
    'https://www.example.com/aktualnosci',
    'https://example.com/aktualnosci/programy.html',
    'https://example.com/pl/aktualnosci.html',
    'https://example.com/blog',
    'https://example.com/press',
    'https://example.com/en/newsroom/',
    'https://example.com/category/hr-software/',
    'https://example.com/blog/tag/payroll',
    'https://example.com/blog/page/2',
    'https://example.com/news?page=3',
    'https://example.com/articles?paged=2&sort=new',
    'https://example.com/2026/',
    'https://example.com/blog/2026/10/',
    'https://example.com/news/products',
    'https://example.cz/novinky/aplikace',
])
def test_a_listing_index_or_category_page_is_a_listing(url):
    assert is_listing_page(url) is True


@pytest.mark.parametrize('url', [
    'https://example.com/aktualnosci/nowa-wersja-programu-2026.html',
    'https://example.com/news/acme-launches-dark-mode',
    'https://example.com/blog/2026/10/27/dark-mode',
    'https://example.com/changelog/2026-07-30-loops',
    'https://example.com/press/12345',
    'https://example.com/feng-erp',
    'https://example.com/?p=123',
    'https://example.com/products/payroll-app',
    'not a url',
    None,
])
def test_an_article_page_is_not_a_listing(url):
    assert is_listing_page(url) is False


class TestSamePageMerge:
    @pytest.fixture
    def table(self):
        with mock_aws():
            yield radar_pk_sk_table('radar')

    @staticmethod
    def _unit(index):
        vector = [0.0] * 1024
        vector[index] = 1.0
        return vector

    @staticmethod
    def _candidate(feature, *urls, day='2026-10-20'):
        return ReleaseCandidate('acme', 'Acme', feature, 'summary', day, urls, ('t',) * len(urls), 'third_party')

    def test_two_stories_citing_the_same_listing_page_stay_two_records(self, table):
        listing = 'https://insert.example.com/aktualnosci/programy.html'
        store_candidate(table, self._candidate('New payroll module', listing), self._unit(0), TODAY, 'now')
        other = self._candidate('Partnership with a bank', listing)
        assert store_candidate(table, other, self._unit(1), TODAY, 'later') == 'added'
        assert len(list_releases(table, 'acme', date(2026, 1, 1), 10)) == 2

    def test_an_article_page_still_merges_when_a_listing_page_is_cited_beside_it(self, table):
        article = 'https://example.com/news/acme-launches-dark-mode'
        store_candidate(table, self._candidate('Dark mode', 'https://example.com/news', article), self._unit(0), TODAY, 'now')
        again = self._candidate('Dark theme ships', article)
        assert store_candidate(table, again, self._unit(1), TODAY, 'later') == 'merged'

    def test_a_page_two_records_already_cite_is_a_hub_and_merges_no_third_story(self, table):
        hub = 'https://example.com/acme-roundup-october'
        store_candidate(table, self._candidate('Dark mode', 'https://a.example/dark-mode'), self._unit(0), TODAY, 'now')
        store_candidate(table, self._candidate('Payroll app', 'https://a.example/payroll-app'), self._unit(1), TODAY, 'now')
        # Both stored stories also cite the round-up page (as when it was filed before 5.47).
        for row in table.scan()['Items']:
            table.put_item(Item={**row, 'urls': [*row['urls'], hub], 'titles': [*row['titles'], 'Round-up']})
        third = self._candidate('Bank partnership', hub)
        assert store_candidate(table, third, self._unit(2), TODAY, 'later') == 'added'
        assert len(list_releases(table, 'acme', date(2026, 1, 1), 10)) == 3

    def test_a_page_one_record_cites_still_merges(self, table):
        page = 'https://example.com/acme-roundup-october'
        store_candidate(table, self._candidate('Dark mode', page), self._unit(0), TODAY, 'now')
        assert store_candidate(table, self._candidate('Dark theme', page), self._unit(1), TODAY, 'later') == 'merged'
