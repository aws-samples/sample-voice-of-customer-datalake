"""Text clipped for people ends on a whole word with an ellipsis, never mid-word."""
import pytest

from shared.text_clip import clip_words


@pytest.mark.parametrize(('text', 'limit', 'expected'), [
    pytest.param('Unpaid refunds', 20, 'Unpaid refunds', id='text that fits is unchanged'),
    pytest.param('Unpaid  refunds\n dominate', 30, 'Unpaid refunds dominate', id='whitespace collapses'),
    pytest.param('baggage and unpaid refunds dominate', 22, 'baggage and unpaid…', id='cut before a partial word'),
    pytest.param('baggage and unpaid refunds', 19, 'baggage and unpaid…', id='a cut at a word end keeps it'),
    pytest.param('stranded, baggage', 12, 'stranded…', id='trailing punctuation dropped'),
    pytest.param('abcdefghij', 5, 'abcd…', id='one long word is cut hard'),
    pytest.param('abc', 0, '', id='no room'),
])
def test_text_is_clipped_on_a_word_with_an_ellipsis(text, limit, expected):
    clipped = clip_words(text, limit)

    assert clipped == expected
    assert len(clipped) <= limit
