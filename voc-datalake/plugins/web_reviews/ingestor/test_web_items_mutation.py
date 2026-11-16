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
from web_items import (
    MODEL_RELAYED_STEPS,
    WebTarget,
    created_at,
    is_model_relayed,
    queue_item,
    relayed_review_key,
    review_id,
    stored_configs,
    target_from_config,
)

from shared.test.clock import frozen_clock
from shared.web_review_targets import TargetError

URL = 'https://www.trustpilot.com/review/example.com'
REVIEW = ExtractedReview(text='Lost my bag.', rating=1.0, date='2026-10-01', title='Bag', author='Reviewer A')
UNDATED = ExtractedReview(text='Lost my bag.', rating=None, date=None, title=None, author=None)
ID_DATED = 'web_480171b35d26314cadaeec3716495f11df3132deeace7298f05935dc9ef8c650'
ID_UNDATED = 'web_a0004cd7fc62dd50ba4e3eae94fa60f5fdee9dd80c72857e39e97f5d7b5a4077'
#: A browser read's id, computed by the code before model-relayed ids (7.44.01): every stored review keeps its id.
BROWSER_REVIEW = ExtractedReview(text='Amazon Connect made our contact centre easy to run. Routing is flexible.',
                                 rating=4.0, date='2026-11-02', title='Easy to run', author='Admin in Telecom')
ID_BROWSER = 'web_4e53618f421aeceb9f4775ab5da042d5d5e453d0805c5c60501292cbfc52edc7'
TRUSTRADIUS = 'https://www.trustradius.com/products/amazon-connect/reviews'
#: The live case (7.44.00): the Bedrock web index relayed the same review twice, the second read 21 characters longer.
RELAYED_BODY = ('We moved our contact centre to Amazon Connect last year. ' * 26)[:1442]
FIRST_READ = ExtractedReview(text=RELAYED_BODY, rating=4.0, date='2026-11-02', title='Flexible routing', author=None)
SECOND_READ = ExtractedReview(text=f'{RELAYED_BODY} Support was quick too.', rating=4.0, date='2026-11-02',
                              title='Flexible routing', author=None)


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


class TestABrowserReadKeepsItsId:
    """Browser ids are never changed: a new id would store every review already stored once more."""

    @pytest.mark.parametrize('method_used', [None, 'browser', '', 'something new'])
    def test_the_pinned_id(self, method_used):
        assert review_id('www.trustradius.com', BROWSER_REVIEW, method_used=method_used, page_url=TRUSTRADIUS) == ID_BROWSER

    def test_the_queued_browser_item_carries_it(self):
        item = queue_item(target(url=TRUSTRADIUS), BROWSER_REVIEW, page=3, page_url=f'{TRUSTRADIUS}?page=3', brand_name='',
                          attribution={'method_used': 'browser'})
        assert (item['id'], is_model_relayed(item)) == (ID_BROWSER, False)

    def test_a_browser_read_still_tells_two_texts_apart(self):
        assert review_id('www.trustradius.com', FIRST_READ) != review_id('www.trustradius.com', SECOND_READ)


class TestAModelRelayedReviewIsKnownByItsStableFields:
    """Bedrock web search and AgentCore Web Search relay the review's text through a model, which varies it."""

    @pytest.mark.parametrize('step', sorted(MODEL_RELAYED_STEPS))
    def test_two_reads_differing_only_in_trailing_text_get_one_id(self, step):
        first = review_id('www.trustradius.com', FIRST_READ, method_used=step, page_url=TRUSTRADIUS)
        assert first == review_id('www.trustradius.com', SECOND_READ, method_used=step, page_url=TRUSTRADIUS)
        assert (first[:4], len(first)) == ('web_', 68)
        assert first != review_id('www.trustradius.com', FIRST_READ)

    def test_both_relaying_steps_agree(self):
        assert len({review_id('www.trustradius.com', FIRST_READ, method_used=step, page_url=TRUSTRADIUS)
                    for step in MODEL_RELAYED_STEPS}) == 1

    @pytest.mark.parametrize('other', [
        ExtractedReview(text=RELAYED_BODY, rating=4.0, date='2026-11-02', title='Clunky reporting', author=None),
        ExtractedReview(text=RELAYED_BODY, rating=4.0, date='2026-11-02', title='Flexible routing', author='Agent B'),
        ExtractedReview(text=RELAYED_BODY, rating=4.0, date='2026-11-03', title='Flexible routing', author=None),
    ], ids=['another title', 'an author', 'another date'])
    def test_different_reviews_on_one_page_get_different_ids(self, other):
        ids = {review_id('www.trustradius.com', review, method_used='bedrock_web_search', page_url=TRUSTRADIUS)
               for review in (FIRST_READ, other)}
        assert len(ids) == 2

    def test_host_path_title_and_author_are_compared_loosely(self):
        loose = ExtractedReview(text='Other words.', rating=None, date='2026-11-02', title='  flexible ROUTING!! ',
                                author='\u2003')  # a blank author (an em space) is no author
        assert relayed_review_key('WWW.TrustRadius.com', loose,
                                  'https://www.trustradius.com/Products/Amazon-Connect/Reviews/?page=2') == (
            relayed_review_key('www.trustradius.com', FIRST_READ, TRUSTRADIUS))

    def test_the_key_with_a_title_or_author(self):
        review = ExtractedReview(text='x', rating=None, date='2026-11-02', title='**Great** crew', author='J. Doe')
        assert relayed_review_key('www.trustradius.com', review, TRUSTRADIUS) == (
            'relayed\nwww.trustradius.com\n/products/amazon-connect/reviews\n2026-11-02\nby\nj doe\ngreat crew')

    def test_without_title_or_author_the_first_200_normalized_characters(self):
        text = 'Great, GREAT   support\u2014really!  ' + 'word ' * 100
        review = ExtractedReview(text=text, rating=None, date=None, title=None, author='')
        key = relayed_review_key('www.trustradius.com', review, 'https://www.trustradius.com')
        head, prefix = key.rsplit('\n', 1)
        assert head == 'relayed\nwww.trustradius.com\n/\n\ntext'
        assert prefix == ('great great support really ' + 'word ' * 100)[:200].rstrip()
        assert len(prefix) == 200

    def test_a_prefix_cut_on_a_space_drops_it(self):
        review = ExtractedReview(text=f'{"a" * 199} tail', rating=None, date=None, title=None, author=None)
        assert relayed_review_key('h', review, '').rsplit('\n', 1)[1] == 'a' * 199

    def test_without_title_or_author_trailing_text_beyond_the_prefix_keeps_the_id(self):
        first = ExtractedReview(text=RELAYED_BODY, rating=None, date='2026-11-02', title=None, author=None)
        second = ExtractedReview(text=f'{RELAYED_BODY} And more.', rating=None, date='2026-11-02', title=None, author=None)
        other = ExtractedReview(text=f'Not the same. {RELAYED_BODY}', rating=None, date='2026-11-02', title=None, author=None)
        ids = [review_id('www.trustradius.com', review, method_used='agentcore_web_search', page_url=TRUSTRADIUS)
               for review in (first, second, other)]
        assert ids[0] == ids[1] != ids[2]

    def test_another_page_of_the_site_is_another_review(self):
        assert review_id('www.trustradius.com', FIRST_READ, method_used='bedrock_web_search', page_url=TRUSTRADIUS) != (
            review_id('www.trustradius.com', FIRST_READ, method_used='bedrock_web_search',
                      page_url='https://www.trustradius.com/products/amazon-lex/reviews'))

    def test_the_queued_item_is_known_on_the_targets_page_not_the_snippets_url(self):
        relayed: dict[str, object] = {'method_used': 'agentcore_web_search'}
        on_target = queue_item(target(url=TRUSTRADIUS), FIRST_READ, page=1, page_url=TRUSTRADIUS, brand_name='',
                               attribution=relayed)
        on_snippet = queue_item(target(url=TRUSTRADIUS), SECOND_READ, page=1, page_url=f'{TRUSTRADIUS}?page=2',
                                brand_name='', attribution=relayed)
        assert on_target['id'] == on_snippet['id'] == review_id(
            'www.trustradius.com', FIRST_READ, method_used='agentcore_web_search', page_url=TRUSTRADIUS)
        assert (is_model_relayed(on_target), on_snippet['url']) == (True, f'{TRUSTRADIUS}?page=2')

    @pytest.mark.parametrize(('item', 'relayed'), [
        ({'metadata': {'method_used': 'bedrock_web_search'}}, True),
        ({'metadata': {'method_used': 'agentcore_web_search'}}, True),
        ({'metadata': {'method_used': 'browser'}}, False),
        ({'metadata': {'method_used': ['bedrock_web_search']}}, False),
        ({'metadata': {}}, False),
        ({'metadata': 'bedrock_web_search'}, False),
        ({}, False),
    ])
    def test_which_items_are_model_relayed(self, item, relayed):
        assert is_model_relayed(item) is relayed


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
