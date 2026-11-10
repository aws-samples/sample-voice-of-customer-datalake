"""`shared/data_quality.py`: the per-source usefulness distribution."""
from shared.data_quality import QUALITY_FIELDS, distribution, from_counters, from_items


def _row(source, low=0, medium=0, high=0, unrated=0):
    return {'source': source, 'low': low, 'medium': medium, 'high': high, 'unrated': unrated,
            'total': low + medium + high + unrated}


class TestFromCounters:
    def test_unrated_is_the_source_total_minus_its_banded_reviews(self):
        result = from_counters(
            {'webscraper': 10, 'feedback_form': 4},
            {'webscraper#low': 2, 'webscraper#high': 5, 'feedback_form#medium': 4},
        )
        assert result['sources'] == [_row('webscraper', low=2, high=5, unrated=3), _row('feedback_form', medium=4)]
        assert result['overall'] == {'low': 2, 'medium': 4, 'high': 5, 'unrated': 3, 'total': 14}

    def test_a_source_with_no_band_rows_is_all_unrated(self):
        """Everything stored before the band existed, with no reprocess yet."""
        assert from_counters({'manual_import': 7}, {})['sources'] == [_row('manual_import', unrated=7)]

    def test_bands_ahead_of_their_total_never_go_negative(self):
        assert from_counters({'web': 1}, {'web#high': 3})['sources'] == [_row('web', high=3)]

    def test_a_source_name_with_a_hash_still_parses_and_junk_rows_are_ignored(self):
        result = from_counters({'a#b': 2}, {'a#b#low': 2, 'a#b#excellent': 9, 'nohash': 4})
        assert result['sources'] == [_row('a#b', low=2)]

    def test_empty_sources_are_left_out_and_ties_sort_by_name(self):
        result = from_counters({'z': 3, 'a': 3, 'empty': 0}, {})
        assert [row['source'] for row in result['sources']] == ['a', 'z']

    def test_nothing_in_the_window_is_an_empty_answer(self):
        assert from_counters({}, {}) == {'sources': [], 'overall': dict.fromkeys(QUALITY_FIELDS, 0)}


class TestFromItems:
    def test_items_without_a_band_count_as_unrated(self):
        items = [
            {'source_platform': 'web', 'usefulness': 'high'},
            {'source_platform': 'web', 'usefulness': 'low'},
            {'source_platform': 'web'},
            {'source_platform': 'web', 'usefulness': 'bogus'},
            {'usefulness': 'medium'},
            {'source_platform': 7, 'usefulness': 'medium'},
        ]
        assert from_items(items)['sources'] == [
            _row('web', low=1, high=1, unrated=2), _row('unknown', medium=2)]

    def test_the_two_inputs_agree(self):
        items = [{'source_platform': 's', 'usefulness': 'low'}, {'source_platform': 's'}]
        assert from_items(items) == from_counters({'s': 2}, {'s#low': 1}) == distribution({'s': 2}, {'s': {'low': 1}})
