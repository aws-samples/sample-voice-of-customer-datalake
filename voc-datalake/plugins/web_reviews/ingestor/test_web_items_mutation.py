"""``web_items``: targets as the ingestor reads them, and the queue items their reviews become.

The mutation run found what the end-to-end handler tests could not see: the exact review id (only
"equal" and "different" were asserted, so a changed separator or a dropped date survived), the
id-less watermark name, the 100-character channel cut, an empty brand, the ingest-time fallback of
``created_at``, and every field ``target_from_config`` copies (only a valid target was ever read).
"""
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from extract import ExtractedReview
from web_items import WebTarget, created_at, queue_item, review_id, stored_configs, target_from_config

from shared.test.clock import frozen_clock
from shared.web_review_targets import TargetError

URL = 'https://www.trustpilot.com/review/example.com'
REVIEW = ExtractedReview(text='Lost my bag.', rating=1.0, date='2026-10-01', title='Bag', author='Reviewer A')
UNDATED = ExtractedReview(text='Lost my bag.', rating=None, date=None, title=None, author=None)
ID_DATED = 'web_480171b35d26314cadaeec3716495f11df3132deeace7298f05935dc9ef8c650'
ID_UNDATED = 'web_a0004cd7fc62dd50ba4e3eae94fa60f5fdee9dd80c72857e39e97f5d7b5a4077'


def target(**fields: object) -> WebTarget:
    values: dict = {'id': 't1', 'name': 'Trustpilot', 'url': URL, 'max_pages': 1, 'max_reviews': 0,
                    'frequency_minutes': 0, 'enabled': True}
    return WebTarget(**{**values, **fields})


class TestTheTargetNamesItsHostAndWatermarks:
    @pytest.mark.parametrize(('url', 'host'), [('https://WWW.Trustpilot.COM/x', 'www.trustpilot.com'), ('not a url', '')])
    def test_host_is_the_lower_cased_hostname_or_empty(self, url, host):
        assert target(url=url).host == host

    def test_a_target_is_frozen_so_equal_targets_hash_alike(self):
        assert len({target(), target(), target(id='t2')}) == 2

    def test_the_watermark_prefix_is_the_id(self):
        assert target().watermark_prefix == 'target_t1'

    def test_without_an_id_the_prefix_is_a_16_char_url_hash(self):
        assert target(id='').watermark_prefix == 'target_96559f7e344f70bd'


class TestTheTargetsLimits:
    @pytest.mark.parametrize(('pages', 'limit'), [(0, 100), (1, 1), (10, 10), (100, 100)])
    def test_page_limit_is_max_pages_or_the_hard_cap(self, pages, limit):
        assert target(max_pages=pages).page_limit == limit

    @pytest.mark.parametrize(('reviews', 'limit'), [(0, None), (1, 1), (200, 200), (5000, 5000)])
    def test_review_limit_is_max_reviews_or_none(self, reviews, limit):
        assert target(max_reviews=reviews).review_limit == limit


class TestAStoredConfigBecomesATarget:
    @pytest.fixture(autouse=True)
    def _public_urls(self):
        with patch('shared.web_review_targets.validate_url', return_value=(True, '')):
            yield

    def test_every_field_is_copied_and_typed(self):
        config = {'id': 't9', 'app_name': 'Yelp', 'url': URL, 'max_pages': '3', 'max_reviews': '200',
                  'frequency_minutes': '60', 'enabled': 'true', 'source_id': 'web_trustpilot_example_air'}
        assert target_from_config(config) == WebTarget(
            id='t9', name='Yelp', url=URL, max_pages=3, max_reviews=200, frequency_minutes=60, enabled=True,
            source_id='web_trustpilot_example_air')

    def test_no_id_is_an_empty_id_and_false_is_disabled(self):
        parsed = target_from_config({'app_name': 'Yelp', 'url': URL, 'enabled': 'false'})
        assert (parsed.id, parsed.enabled, parsed.source_id) == ('', False, '')

    def test_an_invalid_config_is_a_client_safe_error(self):
        with pytest.raises(TargetError) as refused:
            target_from_config(['not', 'a', 'mapping'])
        assert str(refused.value) == 'No target provided'


class TestStoredConfigsAreAListOrNothing:
    @pytest.mark.parametrize(('secrets', 'expected'), [
        ({}, []),
        ({'configs': '[{"id": "t1"}]'}, [{'id': 't1'}]),
        ({'configs': [{'id': 't2'}]}, [{'id': 't2'}]),
        ({'configs': '{not json'}, []),
        ({'configs': '{"id": "t1"}'}, []),
        ({'configs': {'id': 't1'}}, []),
    ])
    def test_configs(self, secrets, expected):
        assert stored_configs(secrets) == expected


class TestTheReviewIdIsAFixedHash:
    @pytest.mark.parametrize('host', ['www.trustpilot.com', 'WWW.TRUSTPILOT.COM'])
    def test_host_text_and_date(self, host):
        assert review_id(host, REVIEW) == ID_DATED

    def test_an_undated_review_hashes_an_empty_date(self):
        assert review_id('www.trustpilot.com', UNDATED) == ID_UNDATED


class TestCreatedAt:
    def test_a_dated_review_is_midnight_utc(self):
        assert created_at(REVIEW) == '2026-10-01T00:00:00+00:00'

    def test_an_undated_review_is_the_ingest_time_in_utc(self):
        clock = MagicMock()
        clock.now.return_value = datetime(2026, 10, 5, 8, 30, tzinfo=UTC)
        with frozen_clock('web_items', clock):
            assert created_at(UNDATED) == '2026-10-05T08:30:00+00:00'
        clock.now.assert_called_once_with(UTC)


class TestTheQueueItem:
    def test_every_field(self):
        item = queue_item(target(), REVIEW, page=2, page_url=f'{URL}?page=2', brand_name='Acme')
        assert item == {
            'id': ID_DATED,
            'channel': 'Trustpilot',
            'text': 'Lost my bag.',
            'title': 'Bag',
            'rating': 1.0,
            'created_at': '2026-10-01T00:00:00+00:00',
            'url': f'{URL}?page=2',
            'author': 'Reviewer A',
            'brand_handles_matched': ['Acme'],
            'source_platform_override': 'web_trustpilot_trustpilot',
            'metadata': {'target': 'Trustpilot', 'page': 2},
        }

    def test_the_source_is_the_stored_source_id(self):
        item = queue_item(target(source_id='web_trustpilot_example_air'), REVIEW, page=1, page_url=URL, brand_name='')
        assert item['source_platform_override'] == 'web_trustpilot_example_air'

    def test_without_a_stored_source_id_it_is_minted_from_host_and_name(self):
        item = queue_item(target(name='Example Air main'), REVIEW, page=1, page_url=URL, brand_name='')
        assert item['source_platform_override'] == 'web_trustpilot_example_air_main'

    def test_no_brand_matches_nothing(self):
        assert queue_item(target(), REVIEW, page=1, page_url=URL, brand_name='')['brand_handles_matched'] == []

    @pytest.mark.parametrize(('length', 'kept'), [(100, 100), (101, 100)])
    def test_the_channel_is_cut_at_100_characters(self, length, kept):
        item = queue_item(target(name='n' * length), REVIEW, page=1, page_url=URL, brand_name='')
        assert (item['channel'], item['metadata']['target']) == ('n' * kept, 'n' * length)


class TestRadarBrand:
    """A target naming a Radar brand stamps its reviews with `radar_brand_key` (docs/radar.md)."""

    def test_a_radar_target_stamps_every_review(self):
        item = queue_item(target(radar_brand='initech'), REVIEW, page=1, page_url=URL, brand_name='')
        assert item['radar_brand_key'] == 'initech'

    def test_an_ordinary_target_carries_no_key(self):
        assert 'radar_brand_key' not in queue_item(target(), REVIEW, page=1, page_url=URL, brand_name='')

    def test_the_stored_radar_brand_reaches_the_target(self):
        with patch('shared.web_review_targets.validate_url', return_value=(True, None)):
            loaded = target_from_config({'app_name': 'Rival', 'url': URL, 'radar_brand': 'initech'})
        assert loaded.radar_brand == 'initech'
