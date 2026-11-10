"""A Radar brand's language and feed URLs (5.42, docs/radar.md → "Language" / "Feeds")."""
from unittest.mock import MagicMock

import pytest

from shared.radar_brand_fields import LANGUAGES, effective_language
from shared.radar_brands import (
    BRAND_LIST_KEY,
    RadarBrand,
    brand_view,
    effective_brands,
    load_brand_list,
    validate_brand_list,
)


def _one(**fields):
    return validate_brand_list({'brands': [{'label': 'Acme', **fields}]})[0]


class TestLanguage:
    @pytest.mark.parametrize('code', LANGUAGES)
    def test_every_allowlisted_language_is_stored_lower_case(self, code):
        assert _one(language=code.upper())['language'] == code

    @pytest.mark.parametrize('auto', [None, '', ' ', 'auto', 'AUTO'])
    def test_null_empty_or_auto_means_auto_and_is_not_stored(self, auto):
        assert 'language' not in _one(language=auto)

    @pytest.mark.parametrize('bad', ['xx', 'english', 'zh', 7, ['pl']])
    def test_a_language_off_the_allowlist_is_a_client_safe_400(self, bad):
        with pytest.raises(ValueError, match='Brand 1 language must be'):
            _one(language=bad)

    @pytest.mark.parametrize(('domain', 'language'), [
        ('acme.pl', 'pl'), ('acme.cz', 'cs'), ('acme.sk', 'sk'), ('acme.de', 'de'), ('acme.at', 'de'),
        ('acme.ch', 'de'), ('acme.fr', 'fr'), ('acme.es', 'es'), ('acme.it', 'it'), ('acme.pt', 'pt'),
        ('acme.com.br', 'pt'), ('acme.nl', 'nl'), ('acme.se', 'sv'), ('acme.dk', 'da'), ('acme.fi', 'fi'),
        ('acme.no', 'no'), ('acme.hu', 'hu'), ('acme.ro', 'ro'), ('acme.com', 'en'), ('acme.io', 'en'),
    ])
    def test_auto_derives_the_language_from_the_first_domain_tld(self, domain, language):
        assert effective_language(None, [domain, 'acme.de']) == language

    def test_a_stored_language_wins_over_the_tld_and_no_domain_means_english(self):
        assert effective_language('cs', ['acme.pl']) == 'cs'
        assert effective_language(None, []) == 'en'


class TestFeedUrls:
    def test_feeds_are_trimmed_and_de_duplicated(self):
        assert _one(feed_urls=[' https://acme.example/feed ', 'https://acme.example/feed'])['feed_urls'] == [
            'https://acme.example/feed']

    def test_no_feeds_store_nothing(self):
        assert _one(feed_urls=[]) == {'label': 'Acme', 'domains': []}

    @pytest.mark.parametrize(('urls', 'message'), [
        ('https://acme.example/feed', 'must be a list'),
        (['http://acme.example/feed'], 'feed URL 1 must start with https://'),
        (['https://user:pw@acme.example/feed'], 'must not hold credentials'),
        (['https://acme.example/feed#top'], 'must not have a #fragment'),
        (['https://localhost/feed'], 'public host name'),
        (['https://intranet/feed'], 'public host name'),
        (['https://10.0.0.1/feed'], 'public host name'),
        (['https://acme.example/a b'], 'spaces'),
        (['https://acme.example:99999/feed'], 'not a valid URL'),
        (['https://acme.example/' + 'x' * 500], 'longer than 500'),
        ([''], 'feed URL 1 is empty'),
        ([3], 'is empty'),
        ([f'https://acme.example/{n}' for n in range(4)], 'at most 3 feed URLs'),
    ])
    def test_a_bad_feed_url_is_a_400_that_says_why(self, urls, message):
        with pytest.raises(ValueError, match=message):
            _one(feed_urls=urls)


class TestStoredAndViewed:
    def test_a_list_saved_before_the_fields_still_loads_and_views_as_auto_without_feeds(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {**BRAND_LIST_KEY, 'brands': [{'label': 'Acme', 'domains': ['acme.cz']}]}}
        [brand] = effective_brands(load_brand_list(table), [])
        view = brand_view(brand)
        assert (view['language'], view['effective_language'], view['feed_urls']) == (None, 'cs', [])

    def test_the_view_carries_the_stored_language_and_feeds(self):
        listed = validate_brand_list({'brands': [{'label': 'Acme', 'domains': ['acme.pl'], 'language': 'en',
                                                  'feed_urls': ['https://acme.pl/rss']}]})
        view = brand_view(effective_brands(listed, [])[0])
        assert (view['language'], view['effective_language'], view['feed_urls']) == ('en', 'en', ['https://acme.pl/rss'])

    def test_a_legacy_profile_brand_has_auto_language_and_no_feeds(self):
        [brand] = effective_brands([], [{'id': 'p', 'radar_brand': 'Example Air', 'radar_domains': ['example.pl']}])
        assert (brand.language, brand.effective_language, brand.feed_urls) == (None, 'pl', ())
        assert RadarBrand('x', 'X').effective_language == 'en'
