"""A Radar brand's search_terms / exclude_terms on the brand list (5.47, docs/radar.md → "Search terms")."""
import pytest

from shared.radar_brand_terms import MAX_TERM_CHARS, MAX_TERMS, is_excluded
from shared.radar_brands import RadarBrand, brand_view, effective_brands, validate_brand_list


def _one(**fields):
    return validate_brand_list({'brands': [{'label': 'Example Air', 'domains': ['example-air.example'], **fields}]})[0]


@pytest.mark.parametrize('field', ['search_terms', 'exclude_terms'])
class TestBounds:
    def test_terms_are_whitespace_folded_and_de_duplicated_without_regard_to_case(self, field):
        assert _one(**{field: ['  Example   Air  Ltd ', 'example air ltd', 'Example Air Miles']})[field] == [
            'Example Air Ltd', 'Example Air Miles']

    def test_no_terms_store_nothing(self, field):
        assert field not in _one(**{field: []})
        assert field not in _one(**{field: None})

    def test_at_most_eight_terms(self, field):
        assert len(_one(**{field: [f't{n}' for n in range(MAX_TERMS)]})[field]) == MAX_TERMS
        with pytest.raises(ValueError, match=f'at most {MAX_TERMS}'):
            _one(**{field: [f't{n}' for n in range(MAX_TERMS + 1)]})

    def test_a_term_is_at_most_sixty_characters(self, field):
        assert _one(**{field: ['x' * MAX_TERM_CHARS]})[field] == ['x' * MAX_TERM_CHARS]
        with pytest.raises(ValueError, match=f'entry 1 is longer than {MAX_TERM_CHARS}'):
            _one(**{field: ['x' * (MAX_TERM_CHARS + 1)]})

    @pytest.mark.parametrize(('raw', 'message'), [
        ('Example Air', 'must be a list'),
        ([''], 'entry 1 is empty'),
        (['ok', 7], 'entry 2 is empty'),
        (['say "hi"'], 'must not contain double quotes'),
        (['-quality'], 'must not start with "-"'),
        (['a\x00b'], 'control characters'),
    ])
    def test_a_malformed_list_is_a_client_safe_400(self, field, raw, message):
        with pytest.raises(ValueError, match=message):
            _one(**{field: raw})


def test_the_terms_reach_the_effective_brand_and_its_api_view():
    listed = [_one(search_terms=['Example Air Ltd'], exclude_terms=['air quality'])]
    brand = effective_brands(listed, [])[0]
    assert brand.search_terms == ('Example Air Ltd',)
    assert brand.exclude_terms == ('air quality',)
    view = brand_view(brand)
    assert view['search_terms'] == ['Example Air Ltd']
    assert view['exclude_terms'] == ['air quality']


def test_a_brand_saved_before_the_terms_existed_reads_with_none():
    view = brand_view(effective_brands([{'label': 'Acme', 'domains': []}], [])[0])
    assert view['search_terms'] == []
    assert view['exclude_terms'] == []
    assert RadarBrand('acme', 'Acme').exclude_terms == ()


@pytest.mark.parametrize(('result', 'excluded'), [
    ({'title': 'Air Quality explained', 'text': ''}, True),
    ({'title': 'Example Air Ltd app', 'text': 'about AIR quality too'}, True),
    ({'title': 'Example Air Ltd app', 'text': 'a launch'}, False),
    ({}, False),
])
def test_a_result_is_excluded_when_its_title_or_snippet_holds_a_term(result, excluded):
    assert is_excluded(result, ['air quality']) is excluded
