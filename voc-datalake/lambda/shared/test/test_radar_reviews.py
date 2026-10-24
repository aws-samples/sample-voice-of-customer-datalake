"""shared/radar_reviews.py: cursor validation, the read budget and the review view (docs/radar.md)."""
from datetime import date
from decimal import Decimal
from unittest.mock import patch

import pytest
from moto import mock_aws

from shared import radar_reviews
from shared.category_access import UNRESTRICTED
from shared.radar_reviews import ReviewFilter, decode_cursor, encode_cursor, list_reviews, review_view
from shared.radar_store import radar_item, store_item
from shared.test.radar_fixtures import radar_pk_sk_table

START, END = date(2026, 3, 1), date(2026, 4, 30)


def _key(day: str, fid: str = 'f') -> dict:
    return {'pk': f'RADAR#acme#ITEMS#{day[:7]}', 'sk': f'{day}#{fid}'}


def test_a_cursor_decodes_back_to_its_key():
    key = _key('2026-04-02', 'abc')
    cursor = encode_cursor({**key, 'extra': 'dropped'})
    assert '=' not in cursor
    assert decode_cursor(cursor, 'acme', START, END) == key


@pytest.mark.parametrize('key', [
    _key('2026-05-01'),                                     # after the window
    _key('2026-02-28'),                                     # before it
    {'pk': 'RADAR#acme#ITEMS#2026-04', 'sk': '2026-03-31#f'},  # sk month is not the partition's
    {'pk': 'RADAR#acme#ITEMS#2026-04', 'sk': 'garbage'},
])
def test_a_cursor_outside_the_brand_window_is_refused(key):
    with pytest.raises(ValueError, match='cursor'):
        decode_cursor(encode_cursor(key), 'acme', START, END)


@pytest.mark.parametrize('cursor', ['', 'x' * 2000, '@@@', 'bnVsbA', 'eyJwayI6IDF9'])
def test_a_malformed_cursor_is_refused(cursor):
    # 'bnVsbA' = null, 'eyJwayI6IDF9' = {"pk": 1}
    with pytest.raises(ValueError, match='cursor'):
        decode_cursor(cursor, 'acme', START, END)


def test_a_review_filter_refuses_an_unknown_sentiment():
    with pytest.raises(ValueError, match='sentiment'):
        ReviewFilter(sentiment='furious')


def test_the_read_budget_ends_a_sparse_page_with_a_cursor_to_go_on():
    with mock_aws():
        table = radar_pk_sk_table('radar')
        for n in range(5):
            item = {'feedback_id': f'f{n}', 'date': f'2026-04-0{n + 1}', 'sentiment_label': 'neutral'}
            store_item(table, 'acme', radar_item(item, 'acme', 'Acme'))
        with patch.object(radar_reviews, 'MAX_READ', 3), patch.object(radar_reviews, 'QUERY_PAGE', 2):
            found, cursor = list_reviews(table, 'acme', admits=lambda _item: False, start=START, end=END, limit=10)
            assert (found, decode_cursor(cursor or '', 'acme', START, END)) == ([], _key('2026-04-03', 'f2'))
            rest, done = list_reviews(table, 'acme', admits=lambda _item: True, start=START, end=END, limit=10,
                                      after=decode_cursor(cursor or '', 'acme', START, END))
    assert ([r['feedback_id'] for r in rest], done) == (['f1', 'f0'], None)


def test_the_view_falls_back_to_the_normalized_text_and_the_key_day():
    view = review_view({
        'pk': 'p', 'sk': '2026-04-02#f', 'normalized_text': 'Bonjour', 'rating': True, 'urgency': 3,
        'source_url': 'ftp://x', 'title': '  ', 'direct_customer_quote': 'Call 555-123-4567',
    })
    assert view == {
        'feedback_id': '', 'day': '2026-04-02', 'text': 'Bonjour', 'sentiment_label': 'neutral',
        'sentiment_score': None, 'category': 'other', 'subcategory': None, 'source_platform': '',
        'quote': 'Call [PHONE]',
    }


def test_the_view_clips_long_text():
    view = review_view({'sk': '2026-04-02#f', 'original_text': 'a' * 9000, 'urgency': 'high',
                        'sentiment_score': Decimal('-0.25')})
    assert (len(view['text']), view['urgency'], view['sentiment_score']) == (radar_reviews.MAX_TEXT_CHARS, 'high', -0.25)


# Prod 5.14 (Radar → Example Air): a CSV imported twice stored each review twice (distinct feedback ids),
# and the first import predates `radar_day`, so its rows sit under the import day (2026-10-18) while
# their source date is 2026-10-16 — the list said 10-18, the review modal Oct 16.
OCT = (date(2026, 10, 1), date(2026, 10, 31))


def _legacy(fid: str, text: str, created: str) -> dict:
    """A row stored before `radar_day`: keyed by its import day, no `radar_day` attribute."""
    return {'pk': 'RADAR#example-air#ITEMS#2026-10', 'sk': f'2026-10-18#{fid}', 'feedback_id': fid, 'date': '2026-10-18',
            'source_created_at': created, 'original_text': text, 'sentiment_label': 'negative'}


def test_a_legacy_row_shows_the_day_it_was_written_not_its_import_day():
    view = review_view(_legacy('old', 'Support took four days', '2026-10-16T00:00:00Z'))
    assert view['day'] == '2026-10-16'


def test_the_single_review_shows_the_same_day_as_the_list():
    row = _legacy('old', 'Support took four days', '2026-10-16T00:00:00Z')
    assert radar_reviews.review_detail_view(row)['day'] == review_view(row)['day'] == '2026-10-16'


def test_the_same_review_imported_twice_is_listed_once():
    with mock_aws():
        table = radar_pk_sk_table('radar')
        table.put_item(Item=_legacy('old', 'Support took  four days', '2026-10-16T00:00:00Z'))
        item = {'feedback_id': 'new', 'date': '2026-10-18', 'source_created_at': '2026-10-16T00:00:00Z',
                'original_text': 'support took four days', 'sentiment_label': 'negative'}
        store_item(table, 'example-air', radar_item(item, 'example-air', 'Example Air'))
        found, cursor = list_reviews(table, 'example-air', admits=lambda _item: True, start=OCT[0], end=OCT[1], limit=10)
    assert ([r['feedback_id'] for r in found], cursor) == (['old'], None)


def test_different_texts_or_days_are_kept_apart():
    with mock_aws():
        table = radar_pk_sk_table('radar')
        table.put_item(Item=_legacy('a', 'Search is slow', '2026-10-16T00:00:00Z'))
        table.put_item(Item=_legacy('b', 'Search is slow', '2026-10-17T00:00:00Z'))
        table.put_item(Item=_legacy('c', 'Pricing is confusing', '2026-10-16T00:00:00Z'))
        found, _ = list_reviews(table, 'example-air', admits=lambda _item: True, start=OCT[0], end=OCT[1], limit=10)
    assert sorted(r['feedback_id'] for r in found) == ['a', 'b', 'c']


def test_review_detail_reports_the_stored_original_language_as_language():
    """The processor stores `original_language` (build_feedback_item); the modal reads `language` (prod: "Unknown")."""
    row = _legacy('old', 'Support took four days', '2026-10-16T00:00:00Z')
    assert radar_reviews.review_detail_view({**row, 'original_language': 'pt'})['language'] == 'pt'
    assert 'language' not in radar_reviews.review_detail_view({**row, 'original_language': ''})


# verify4 V5 (Radar → Example Air, days=90): `day=<newest day>` listed all 6 reviews (Oct 16/17/18) while
# Oct 16 and Oct 17 listed 2 each. The legacy copies sit under their import day (Oct 18), so a filter on
# the KEY day returned them all for the newest day. The filter is on the WRITTEN day the list shows.
_WRITTEN = {'a': '2026-10-16', 'b': '2026-10-16', 'c': '2026-10-17', 'd': '2026-10-17', 'e': '2026-10-18',
            'f': '2026-10-18'}


def _imported_twice(table) -> None:
    """Each review once as a legacy row (keyed 2026-10-18) and once under its written day."""
    for fid, day in _WRITTEN.items():
        table.put_item(Item=_legacy(f'old-{fid}', f'Review {fid}', f'{day}T09:00:00Z'))
        item = {'feedback_id': f'new-{fid}', 'date': '2026-10-18', 'source_created_at': f'{day}T09:00:00Z',
                'original_text': f'Review {fid}', 'sentiment_label': 'negative'}
        store_item(table, 'example-air', radar_item(item, 'example-air', 'Example Air'))


@pytest.mark.parametrize(('day', 'expected'), [
    ('2026-10-18', ['2026-10-18', '2026-10-18']),   # the newest day (the import day) — was all 6
    ('2026-10-17', ['2026-10-17', '2026-10-17']),   # a middle day
    ('2026-10-16', ['2026-10-16', '2026-10-16']),   # the oldest day
    ('2026-10-15', []),                              # a day with nothing written
])
def test_a_day_lists_only_the_reviews_written_that_day(day, expected):
    with mock_aws():
        table = radar_pk_sk_table('radar')
        _imported_twice(table)
        page = radar_reviews.reviews_page(table, 'example-air', UNRESTRICTED, {'day': day}, OCT)
    assert ([r['day'] for r in page['reviews']], page['next_cursor']) == (expected, None)


def test_the_whole_window_still_lists_each_review_once():
    with mock_aws():
        table = radar_pk_sk_table('radar')
        _imported_twice(table)
        page = radar_reviews.reviews_page(table, 'example-air', UNRESTRICTED, {}, OCT)
    assert sorted(r['day'] for r in page['reviews']) == sorted(_WRITTEN.values())
