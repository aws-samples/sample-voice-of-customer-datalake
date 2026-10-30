"""`shared/usefulness.py`: the deterministic usefulness band (docs/data-quality.md)."""
import pytest

from shared.feedback_types import feedback_type_dimension
from shared.usefulness import (
    BAND_RANK,
    CJK_CHARS_PER_WORD,
    CONCRETE_TYPES,
    DETAILED_WORDS,
    HIGH_POINTS,
    LONG_WORDS,
    MEDIUM_POINTS,
    MIN_CHARS,
    MIN_WORDS,
    USEFULNESS_BANDS,
    USEFULNESS_UNRATED,
    item_usefulness,
    stored_band,
    usefulness_band,
)

DETAILED = ' '.join(['word'] * DETAILED_WORDS)
LONG = ' '.join(['word'] * LONG_WORDS)
SPECIFIC_BUG = 'Since version 4.2 the app crashes every time I open settings, lost two bookings already'

# (text, problem_summary, feedback_type, expected band)
CASES = [
    # Near-empty or boilerplate: low whatever the enrichment says.
    ('', None, None, 'low'),
    ('   ', 'A summary', 'bug', 'low'),
    ('Great!', None, 'praise', 'low'),
    ('ok', 'Customer says ok', None, 'low'),
    ('N/A', None, None, 'low'),
    ('Love it!!!', None, None, 'low'),
    ('Thank you.', None, None, 'low'),
    ('Very   bad', 'Unhappy', 'bug', 'low'),
    ('it is bad', 'Unhappy', 'bug', 'low'),  # under MIN_CHARS
    # Long enough but nothing concrete: still low.
    ('Really friendly people all round', None, 'praise', 'low'),
    # One signal: medium.
    ('The checkout keeps spinning forever', None, 'praise', 'medium'),
    ('I paid 40 euros for nothing at all', None, 'other', 'medium'),
    ('Please make it better for me', None, 'feature_request', 'medium'),
    ('Please make it better for me', 'Asks for improvements', None, 'medium'),
    (DETAILED, None, None, 'medium'),
    # Two signals: medium.
    ('The app crashes all the time now', None, 'bug', 'medium'),
    # Three or more: high.
    (SPECIFIC_BUG, 'Crash on settings', 'bug', 'high'),
    (LONG, None, 'question', 'high'),
    ('Flight EX123 was delayed 5 hours and nobody told us anything', None, 'service_failure', 'high'),
]


class TestBand:
    @pytest.mark.parametrize(('text', 'summary', 'feedback_type', 'expected'), CASES)
    def test_each_review_lands_in_its_band(self, text, summary, feedback_type, expected):
        assert usefulness_band(text, problem_summary=summary, feedback_type=feedback_type) == expected

    @pytest.mark.parametrize('text', [None, 42, ['a list'], {'text': 'x'}])
    def test_a_text_that_is_not_a_string_is_low(self, text):
        assert usefulness_band(text) == 'low'

    def test_it_is_deterministic(self):
        assert {usefulness_band(SPECIFIC_BUG, feedback_type='bug') for _ in range(5)} == {'high'}

    def test_praise_and_other_are_not_concrete_even_with_a_summary(self):
        text = 'Really friendly people all round'
        assert usefulness_band(text, problem_summary='Something', feedback_type='praise') == 'low'
        assert usefulness_band(text, problem_summary='Something', feedback_type=None) == 'medium'

    def test_every_problem_request_or_question_type_is_concrete(self):
        values = {value['name'] for value in feedback_type_dimension()['values']}
        assert values - CONCRETE_TYPES == {'praise', 'other'}
        assert values >= CONCRETE_TYPES

    def test_the_thresholds_are_ordered(self):
        assert MIN_WORDS < DETAILED_WORDS < LONG_WORDS
        assert 0 < MEDIUM_POINTS < HIGH_POINTS
        assert MIN_CHARS > 0


class TestUnspacedScripts:
    """Untranslated text in a script without spaces between words is not near-empty by default."""

    JAPANESE = 'アプリを開くたびにクラッシュします。バージョン4.2から設定画面が使えません。'

    def test_a_detailed_japanese_review_is_not_low(self):
        assert usefulness_band(self.JAPANESE) == 'medium'
        assert usefulness_band(self.JAPANESE, feedback_type='bug') == 'high'

    def test_a_short_chinese_review_naming_an_issue_passes_the_floor(self):
        # 9 ideographs: one "word" under the old \w+ count, now 5 words and 18 weighted chars.
        assert usefulness_band('登录后应用一直崩溃', feedback_type='bug') == 'medium'
        assert usefulness_band('登录后应用一直崩溃') == 'low'

    def test_a_two_character_review_stays_near_empty(self):
        assert usefulness_band('很好', feedback_type='bug') == 'low'

    def test_each_word_of_unspaced_text_counts_toward_the_length_points(self):
        detailed = '字' * (DETAILED_WORDS * CJK_CHARS_PER_WORD)
        just_short = '字' * (DETAILED_WORDS * CJK_CHARS_PER_WORD - CJK_CHARS_PER_WORD)
        assert usefulness_band(detailed) == 'medium'
        assert usefulness_band(just_short) == 'low'

    def test_latin_word_counting_is_unchanged_next_to_ideographs(self):
        # Mixed text: the Latin words and the ideographs both count.
        assert usefulness_band('ok 好') == 'low'
        assert usefulness_band('Login 登录失败了', feedback_type='bug') == 'medium'


class TestItem:
    def test_the_translation_is_read_when_there_is_one(self):
        item = {
            'original_text': 'ok',
            'normalized_text': 'The app crashes after the 3.1 update on every login',
            'dimensions': {'feedback_type': 'bug'},
        }
        assert item_usefulness(item) == 'high'

    def test_the_original_text_and_summary_are_read_without_a_translation(self):
        item = {'original_text': 'Please make it better for me', 'problem_summary': 'Wants changes'}
        assert item_usefulness(item) == 'medium'

    def test_an_item_with_no_text_is_low(self):
        assert item_usefulness({}) == 'low'
        assert item_usefulness({'dimensions': 'not a map', 'original_text': 'Great!'}) == 'low'


class TestStoredBand:
    @pytest.mark.parametrize('band', USEFULNESS_BANDS)
    def test_a_stored_band_is_read_back(self, band):
        assert stored_band({'usefulness': band}) == band

    @pytest.mark.parametrize('item', [{}, {'usefulness': None}, {'usefulness': 'HIGH'}, {'usefulness': 3}])
    def test_a_missing_or_unknown_value_is_unrated(self, item):
        assert stored_band(item) == USEFULNESS_UNRATED

    def test_the_rank_puts_high_first_and_unrated_last(self):
        assert sorted(BAND_RANK, key=BAND_RANK.__getitem__) == ['high', 'medium', 'low', 'unrated']
