"""Lexical similar-feedback ranking (shared/feedback_similarity.py).

Production finding (5.09.00): a negative email about a grey Android pay button
listed eight positive reviews from an unrelated source — the route returned the
category partition's highest-sentiment rows, unranked.
"""
import pytest

from shared.feedback_similarity import (
    OTHER_LANGUAGE,
    SAME_LANGUAGE,
    UNKNOWN_LANGUAGE,
    language_tier,
    rank_similar,
    tokens,
)

SOURCE = {
    'feedback_id': 'src', 'source_platform': 'email', 'sentiment_label': 'negative', 'subcategory': 'checkout',
    'original_text': 'The pay button stays grey on my Android phone, I cannot pay for my order.',
    'problem_summary': 'Pay button disabled (grey) on Android checkout',
}


def _item(fid: str, text: str, **fields) -> dict:
    return {'feedback_id': fid, 'original_text': text, **fields}


def test_the_production_case_ranks_the_matching_complaint_and_drops_unrelated_praise():
    candidates = [
        _item('praise1', 'Love this, great experience, super fast delivery!', sentiment_label='positive',
              source_platform='app_store'),
        _item('praise2', 'Wonderful support team, very friendly.', sentiment_label='positive',
              source_platform='app_store'),
        _item('match', 'Android: the pay button is grey and does nothing', sentiment_label='negative',
              source_platform='email', problem_summary='Pay button greyed out on Android'),
        _item('near', 'Checkout pay button greyed out after the update', sentiment_label='positive',
              source_platform='app_store'),
    ]

    ranked = [item['feedback_id'] for item in rank_similar(SOURCE, candidates, 8)]

    assert ranked == ['match', 'near']


def test_same_polarity_and_source_outrank_an_otherwise_equal_candidate():
    text = 'pay button grey android'
    same = _item('same', text, sentiment_label='negative', source_platform='email')
    other = _item('other', text, sentiment_label='positive', source_platform='web')

    assert [i['feedback_id'] for i in rank_similar(SOURCE, [other, same], 2)] == ['same', 'other']


def test_the_source_item_and_the_limit_are_respected():
    twins = [_item(f't{i}', SOURCE['original_text'], processed_at=f'2026-10-0{i}') for i in range(1, 5)]

    ranked = rank_similar(SOURCE, [SOURCE, *twins], 2)

    assert [i['feedback_id'] for i in ranked] == ['t4', 't3']


def test_stop_words_short_tokens_and_digits_carry_no_signal():
    assert tokens('The app is 5 stars and I am so happy, ok') == frozenset({'happy'})
    assert tokens(None, 3, '') == frozenset()


@pytest.mark.parametrize('candidate', [
    _item('none', ''),
    _item('stop', 'the and app review stars'),
    _item('far', 'delivery courier parcel late warehouse tracking number refund store'),
])
def test_no_meaningful_overlap_is_not_similar(candidate):
    assert rank_similar(SOURCE, [candidate], 8) == []


def test_the_translated_text_is_preferred_over_the_original():
    untranslated = _item('fr', 'Le bouton payer reste gris')
    translated = _item('fr', 'Le bouton payer reste gris', normalized_text='The pay button stays grey on Android')

    assert rank_similar(SOURCE, [untranslated], 8) == []
    assert rank_similar(SOURCE, [translated], 8) == [translated]


EXAMPLE_AIR = {'feedback_id': 'example_air', 'source_platform': 'web_trustpilot_example_air', 'original_language': 'es-419',
         'sentiment_label': 'negative', 'original_text': 'Perdieron mi equipaje',
         'normalized_text': 'They lost my luggage on the flight', 'problem_summary': 'Lost luggage on flight'}


class TestSameLanguageFirst:
    """Live finding: a Latin American Spanish review listed other brands' reviews in other languages first."""

    def _candidate(self, fid, language, source, text='They lost my luggage on the flight and nobody helped'):
        return {'feedback_id': fid, 'original_language': language, 'source_platform': source,
                'sentiment_label': 'negative', 'normalized_text': text, 'problem_summary': 'Lost luggage on flight'}

    def test_a_same_language_review_outranks_a_better_match_in_another_language(self):
        candidates = [
            self._candidate('acmeair_de', 'de', 'AcmeAir_android', 'They lost my luggage on the flight'),
            self._candidate('acme_pt', 'pt', 'Acme_ios'),
            self._candidate('example_air_es', 'es', 'web_trustpilot_example_air', 'Lost luggage, flight was late'),
            self._candidate('other_es', 'ES', 'AcmeJet_android', 'luggage lost on the flight'),
        ]
        ranked = [c['feedback_id'] for c in rank_similar(EXAMPLE_AIR, candidates, 4)]
        assert (set(ranked[:2]), set(ranked[2:])) == ({'example_air_es', 'other_es'}, {'acmeair_de', 'acme_pt'})

    def test_within_a_language_the_same_source_ranks_first(self):
        candidates = [self._candidate('acmejet', 'es', 'AcmeJet_android'),
                      self._candidate('example_air_2', 'es', 'web_trustpilot_example_air')]
        assert [c['feedback_id'] for c in rank_similar(EXAMPLE_AIR, candidates, 2)] == ['example_air_2', 'acmejet']

    def test_an_unknown_language_sits_between_same_and_other(self):
        candidates = [self._candidate('de', 'de', 'x'), self._candidate('none', None, 'x'),
                      self._candidate('es', 'es', 'x')]
        assert [c['feedback_id'] for c in rank_similar(EXAMPLE_AIR, candidates, 3)] == ['es', 'none', 'de']

    @pytest.mark.parametrize(('left', 'right', 'tier'), [
        ('es-419', 'es', SAME_LANGUAGE), ('en_US', 'EN', SAME_LANGUAGE), ('es', 'de', OTHER_LANGUAGE),
        ('', 'es', UNKNOWN_LANGUAGE), (None, None, UNKNOWN_LANGUAGE),
    ])
    def test_language_tier(self, left, right, tier):
        assert language_tier({'original_language': left}, {'language': right}) == tier
