"""Radar citations must be official or name the brand (shared/radar_brand_citations.py, docs/radar.md)."""
import pytest

from shared.radar_brand_citations import BrandMatch, brand_citations, keeps_citation, names_brand, on_domains

EXAMPLE_AIR = BrandMatch(label='Example Air', terms=('Example Air Ltd', 'SkyPass'), domains=('example-air.example',))
GLOBEX = BrandMatch(label='Globex')


class TestNamesBrand:
    @pytest.mark.parametrize('text', [
        'Example Air adds three routes', 'EXAMPLE AIR: new lounge', 'example-air launches SkyPass',
        'example_air.example/blog', 'Example\u00a0Air', 'exampleair.example/news/routes',
    ])
    def test_the_label_matches_whatever_the_case_spacing_or_separators(self, text):
        assert names_brand(text, EXAMPLE_AIR)

    def test_a_search_term_names_the_brand_too(self):
        assert names_brand('SkyPass membership now in Europe', EXAMPLE_AIR)

    def test_accents_are_folded_on_both_sides(self):
        cafe = BrandMatch(label='Café Globex')
        assert names_brand('cafe-globex.example/nouveautes', cafe)
        assert names_brand('CAFÉ GLOBEX ouvre', BrandMatch(label='Cafe Globex'))

    @pytest.mark.parametrize('text', ['Globexia raises a round', 'https://globexia.example/news', 'megaglobex corp'])
    def test_the_label_inside_a_longer_word_is_another_name(self, text):
        assert not names_brand(text, GLOBEX)

    @pytest.mark.parametrize('text', ['', '   ', None, 7])
    def test_nothing_to_read_names_nobody(self, text):
        assert not names_brand(text, GLOBEX)


class TestKeepsCitation:
    def test_an_official_page_stays_whatever_its_title(self):
        assert keeps_citation('https://www.example-air.example/n/42', 'Release notes', EXAMPLE_AIR)
        assert keeps_citation('https://news.example-air.example/x', '', EXAMPLE_AIR)

    def test_a_third_party_page_naming_the_brand_in_its_title_or_url_stays(self):
        assert keeps_citation('https://travel.example/story/1', 'Example Air cuts fares', EXAMPLE_AIR)
        assert keeps_citation('https://travel.example/example-air-cuts-fares', '', EXAMPLE_AIR)

    def test_an_unrelated_third_party_page_is_dropped(self):
        assert not keeps_citation('https://tools.example/four-layers-of-ai-controls',
                                  'Four layers of controls in an AI architecture', GLOBEX)

    def test_a_brand_name_only_in_the_query_string_does_not_count(self):
        assert not keeps_citation('https://tools.example/search?q=globex', 'Search results', GLOBEX)

    def test_a_brand_with_no_usable_name_drops_nothing(self):
        assert keeps_citation('https://tools.example/a', 'Anything', BrandMatch(label='&&'))

    def test_a_url_that_is_not_text_is_never_kept(self):
        assert not keeps_citation(None, 'Globex', GLOBEX)


class TestBrandCitations:
    def test_titles_stay_beside_their_urls_and_the_order_is_kept(self):
        urls = ['https://a.example/globex-ships', 'https://b.example/other', 'http://c.example/x']
        titles = ['Ships', 'Unrelated', 'Globex news']
        assert brand_citations(urls, titles, GLOBEX) == (
            ['https://a.example/globex-ships', 'http://c.example/x'], ['Ships', 'Globex news'])

    def test_every_citation_dropped_leaves_empty_lists(self):
        assert brand_citations(['https://b.example/other'], ['Unrelated'], GLOBEX) == ([], [])

    def test_a_missing_title_reads_as_empty(self):
        assert brand_citations(['https://globex.example/a'], [], GLOBEX) == (['https://globex.example/a'], [''])


def test_on_domains_matches_the_domain_and_its_subdomains_only():
    assert on_domains('https://blog.example-air.example/a', ('example-air.example',))
    assert not on_domains('https://notexample-air.example/a', ('example-air.example',))
    assert not on_domains('not a url', ('example-air.example',))


def test_a_malformed_url_is_neither_official_nor_naming_the_brand():
    broken = 'https://[globex.example/news'
    assert not on_domains(broken, ('globex.example',))
    assert not keeps_citation(broken, 'Unrelated', GLOBEX)
    assert keeps_citation(broken, 'Globex news', GLOBEX)
