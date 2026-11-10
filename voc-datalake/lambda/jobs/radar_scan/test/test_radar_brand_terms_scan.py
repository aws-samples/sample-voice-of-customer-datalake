"""A brand's search terms and exclude terms in the news scan (5.47, docs/radar.md → "Search terms").

Example Air is the example: "air" is a common word, so its general news queries carry the legal
name and product names, and an article about air quality in general is dropped
before the model sees it.
"""
from datetime import date
from unittest.mock import MagicMock

import pytest

from jobs.radar_scan import queries, windows
from jobs.radar_scan.test.fakes import run_scan
from shared.exa_search import exa_search
from shared.radar_brands import RadarBrand

TODAY = date(2026, 10, 27)
SINCE = '2026-10-01'
LOOKBACK = '2026-07-29'
BRAND = RadarBrand('example-air', 'Example Air', ('example-air.example',), origin='list', language='cs',
                   search_terms=('Example Air Ltd', 'Example Air Miles'), exclude_terms=('air quality',))


def _scan(brand=BRAND, budget=6, **sources):
    steps = [f'{q.language}:{q.type}' for q in queries.query_plan(brand.label, brand.effective_language)]
    window = windows.BrandWindow(LOOKBACK, dict.fromkeys([*steps, windows.OWN_DOMAINS_STEP, windows.EXA_STEP], SINCE), 0)
    return run_scan(brand, window, budget, TODAY, **sources)


class TestWithTerms:
    def test_one_search_term_is_quoted_and_several_form_one_or_group(self):
        assert queries.with_terms('"Example Air" novinky', ('Example Air Ltd',)) == '"Example Air" novinky "Example Air Ltd"'
        assert queries.with_terms('"Example Air" novinky', ('Example Air Ltd', 'Example Air Miles')) == (
            '"Example Air" novinky ("Example Air Ltd" OR "Example Air Miles")')

    def test_exclude_terms_are_sent_as_minus_phrases(self):
        assert queries.with_terms('Example Air novinky', (), ('air quality', 'HR')) == (
            'Example Air novinky -"air quality" -"HR"')

    def test_no_terms_leave_the_query_unchanged(self):
        assert queries.with_terms('"Acme" launch') == '"Acme" launch'

    def test_terms_that_would_pass_the_query_cap_are_left_out_whole(self):
        long_terms = tuple(f'{"x" * 55}{n}' for n in range(8))
        text = queries.with_terms('"Acme" launch', long_terms, long_terms)
        assert len(text) <= queries.MAX_QUERY_CHARS
        assert text.startswith('"Acme" launch ("')
        # Never a term cut in half: every quoted phrase is one of the given terms.
        assert all(part.strip('()-" ') in long_terms for part in text.split('"')[3::2])

    def test_plain_terms_append_words_for_exa(self):
        assert queries.plain_terms('Example Air novinky', ('Example Air Ltd',)) == 'Example Air novinky Example Air Ltd'


@pytest.mark.usefixtures('no_model')
class TestScanUsesTheTerms:
    def test_the_general_news_queries_carry_the_search_terms_and_the_exclusions(self):
        _, sources = _scan(budget=1)
        assert sources['search'].call_args.args[0] == (
            '"Example Air" nové funkce nová verze ("Example Air Ltd" OR "Example Air Miles") -"air quality"')

    def test_the_own_domain_query_carries_only_the_exclusions(self):
        _, sources = _scan(budget=2)
        assert sources['search'].call_args_list[1].args[0] == 'Example Air novinky -"air quality"'

    def test_exa_gets_the_search_terms_as_words_and_one_exclude_phrase(self):
        exa = MagicMock(return_value=[])
        _scan(budget=4, exa_key='k' * 10, exa=exa)
        news = exa.call_args_list[1]
        assert news.args[1] == 'Example Air novinky Example Air Ltd Example Air Miles'
        assert news.kwargs['exclude_text'] == 'air quality'

    def test_a_brand_without_terms_sends_exa_no_exclude_text(self):
        exa = MagicMock(return_value=[])
        _scan(RadarBrand('example-air', 'Example Air', ('example-air.example',), origin='list'), budget=4,
              exa_key='k' * 10, exa=exa)
        assert all('exclude_text' not in call.kwargs for call in exa.call_args_list)

    def test_a_result_with_an_exclude_term_never_reaches_the_model(self, no_model):
        results = [
            {'title': 'Air Quality in 2026', 'url': 'https://news.example/a', 'text': 'A guide'},
            {'title': 'Example Air Ltd launches an app', 'url': 'https://news.example/b', 'text': 'New app'},
        ]
        stats, _ = _scan(budget=1, search=MagicMock(return_value=results))
        prompt = no_model.call_args.kwargs['prompt']
        assert 'news.example/b' in prompt
        assert 'news.example/a' not in prompt
        assert stats.excluded == 1

    def test_when_every_result_is_excluded_no_model_call_is_made(self, no_model):
        results = [{'title': 'x', 'url': 'https://news.example/a', 'text': 'all about AIR QUALITY'}]
        stats, _ = _scan(budget=1, search=MagicMock(return_value=results))
        assert no_model.call_count == 0
        assert stats.excluded == 1


class TestExaRequest:
    @staticmethod
    def _sent(**kwargs):
        post = MagicMock()
        post.return_value.status_code = 200
        post.return_value.json.return_value = {'results': []}
        exa_search('k' * 10, 'q', since=SINCE, post=post, **kwargs)
        return post.call_args.kwargs['json']

    def test_exclude_text_is_sent_as_one_phrase(self):
        assert self._sent(exclude_text='air quality')['excludeText'] == ['air quality']

    def test_no_exclude_text_sends_no_exclude_field(self):
        assert 'excludeText' not in self._sent()
