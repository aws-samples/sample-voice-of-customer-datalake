"""The 5.42 news scan: localized query plan, rotation, own-domain step, Exa, feeds, budget, kinds (docs/radar.md)."""
import json
import logging
from datetime import date
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.types import Binary
from moto import mock_aws

from jobs.radar_scan import extract, handler, queries, scan, windows
from jobs.radar_scan.test.fakes import acme_world, lambda_context, run_scan
from shared.exa_search import ExaSearchError
from shared.memory_store import encode_embedding
from shared.radar_brand_fields import LANGUAGES
from shared.radar_brands import BRAND_LIST_KEY, RadarBrand
from shared.radar_releases import ReleaseCandidate, list_releases, public_release, store_candidate
from shared.test.radar_fixtures import radar_pk_sk_table

TODAY = date(2026, 10, 27)
SINCE = '2026-10-01'
LOOKBACK = '2026-07-29'  # TODAY - 90 days
UNIT = [1.0] + [0.0] * 1023
PL_BRAND = RadarBrand('acme', 'Acme', ('acme.pl',), origin='list')


def _ctx(domains=('acme.pl',)):
    return extract.ExtractContext('acme', 'Acme', domains, TODAY, extract.Budget(0), MagicMock())


def _scan(brand=PL_BRAND, budget=6, cursor=0, **sources):
    # Every search last ran on SINCE (windows.py), so each asks only for what is new since then.
    steps = [f'{q.language}:{q.type}' for q in queries.query_plan(brand.label, brand.effective_language)]
    window = windows.BrandWindow(LOOKBACK, dict.fromkeys([*steps, windows.OWN_DOMAINS_STEP, windows.EXA_STEP], SINCE),
                                 cursor)
    return run_scan(brand, window, budget, TODAY, **sources)


def _dated_answer(day='2026-10-20', kind='release'):
    return json.dumps({'releases': [{'feature': 'Dark mode', 'kind': kind, 'release_date': day, 'summary': 's',
                                     'sources': [1]}]})


class TestQueryPlan:
    def test_a_polish_brand_searches_every_type_in_polish_then_in_english(self):
        plan = queries.query_plan('Acme', 'pl')
        assert [(q.language, q.type) for q in plan] == [
            *(('pl', t) for t in queries.QUERY_TYPES), *(('en', t) for t in queries.QUERY_TYPES)]
        assert plan[0].text == '"Acme" nowe funkcje nowa wersja'
        assert plan[5].text == 'Acme aktualności'  # company news: the brand unquoted
        assert plan[-1].text == 'Acme news'

    def test_a_czech_brand_searches_in_czech(self):
        assert [q.text for q in queries.query_plan('Acme', 'cs')][:3] == [
            '"Acme" nové funkce nová verze', '"Acme" spuštění novinka', '"Acme" akce sleva']

    def test_an_english_brand_runs_each_type_once(self):
        assert len(queries.query_plan('Acme', 'en')) == len(queries.QUERY_TYPES)

    def test_every_allowlisted_language_has_words_for_every_type(self):
        assert set(queries.QUERY_WORDS) == set(LANGUAGES)
        assert all(set(words) == set(queries.QUERY_TYPES) and all(words.values())
                   for words in queries.QUERY_WORDS.values())

    @pytest.mark.usefixtures('no_model')
    def test_rotation_covers_every_planned_query_over_successive_scans_within_the_cap(self):
        cursor, seen, calls = 0, [], 0
        for _ in range(6):
            stats, sources = _scan(RadarBrand('acme', 'Acme', origin='list', language='pl'), budget=2, cursor=cursor)
            calls += sources['search'].call_count
            assert sources['search'].call_count <= 2
            seen.extend(stats.query_types)
            cursor = stats.cursor
        assert set(seen) == {f'{q.language}:{q.type}' for q in queries.query_plan('Acme', 'pl')}
        assert calls == 12


class TestSteps:
    @pytest.mark.usefixtures('no_model')
    def test_the_own_domain_step_searches_the_brand_news_on_its_domains_without_a_date_filter(self):
        _, sources = _scan(budget=2)
        own = sources['search'].call_args_list[1]
        assert own.args[0] == 'Acme aktualności'
        assert own.kwargs == {'include_domains': ['acme.pl']}

    @pytest.mark.usefixtures('no_model')
    def test_the_web_news_queries_ask_only_for_what_is_new(self):
        _, sources = _scan(budget=1)
        assert sources['search'].call_args.kwargs == {'include_domains': None, 'published_after': SINCE}

    @pytest.mark.usefixtures('no_model')
    def test_exa_runs_when_configured_and_nothing_dated_was_found(self):
        exa = MagicMock(return_value=[])
        stats, _ = _scan(budget=4, exa_key='k' * 10, exa=exa)
        assert [(c.args[1], c.kwargs) for c in exa.call_args_list] == [
            ('Acme aktualności', {'since': SINCE, 'include_domains': ['acme.pl']}),
            ('Acme aktualności', {'since': SINCE, 'include_domains': None}),
        ]
        assert stats.steps == ['news', 'own_domains', 'exa']
        assert stats.queries == 4

    @pytest.mark.usefixtures('no_model')
    def test_exa_does_not_run_without_a_key(self):
        exa = MagicMock()
        _scan(budget=6, exa=exa)
        exa.assert_not_called()

    def test_exa_does_not_run_when_web_search_found_a_dated_item(self):
        exa = MagicMock()
        search = MagicMock(return_value=[{'title': 't', 'url': 'https://acme.pl/n', 'text': 'x', 'published_date': ''}])
        with patch.object(extract, 'converse', return_value=_dated_answer()), \
             patch.object(scan, 'embed_text', return_value=[1.0]), patch.object(scan, 'store_candidate', return_value='added'):
            stats, _ = _scan(budget=6, search=search, exa_key='k' * 10, exa=exa)
        exa.assert_not_called()
        assert 'own_domains' not in stats.steps

    @pytest.mark.usefixtures('no_model')
    def test_an_exa_error_is_a_warning_and_the_brand_goes_on(self, caplog):
        exa = MagicMock(side_effect=ExaSearchError('Exa search answered HTTP 401'))
        with caplog.at_level(logging.WARNING):
            stats, _ = _scan(budget=6, exa_key='secret-key-1', exa=exa)
        assert {'exa', 'more_news'} <= set(stats.steps)
        assert 'HTTP 401' in caplog.text
        assert 'secret-key-1' not in caplog.text

    @pytest.mark.usefixtures('no_model')
    def test_feeds_run_first_and_each_counts_against_the_budget(self):
        feeds = MagicMock(return_value=[])
        brand = RadarBrand('acme', 'Acme', ('acme.pl',), origin='list',
                           feed_urls=('https://acme.pl/feed', 'https://acme.pl/blog/feed'))
        stats, sources = _scan(brand, budget=3, feeds=feeds)
        assert [c.args[0] for c in feeds.call_args_list] == list(brand.feed_urls)
        assert (stats.steps[0], stats.queries, sources['search'].call_count) == ('feeds', 3, 1)

    @pytest.mark.usefixtures('no_model')
    def test_without_web_search_only_feeds_and_exa_spend(self):
        exa = MagicMock(return_value=[])
        stats, _ = _scan(search=None, budget=6, exa_key='k' * 10, exa=exa)
        assert (stats.steps, stats.queries, stats.cursor) == (['exa'], 2, 0)

    def test_an_item_older_than_the_lookback_is_not_filed(self):
        search = MagicMock(return_value=[{'title': 't', 'url': 'https://acme.pl/n', 'text': 'x', 'published_date': ''}])
        with patch.object(extract, 'converse', return_value=_dated_answer('2026-05-01')), \
             patch.object(scan, 'embed_text', return_value=[1.0]), patch.object(scan, 'store_candidate') as store:
            stats, _ = _scan(budget=1, search=search)
        store.assert_not_called()
        assert stats.too_old == 1

    def test_the_brand_log_counts_sources_and_kinds_never_text(self, caplog):
        search = MagicMock(return_value=[{'title': 't', 'url': 'https://acme.pl/n', 'text': 'PAGE TEXT', 'published_date': ''}])
        with caplog.at_level(logging.INFO), patch.object(extract, 'converse', return_value=_dated_answer(kind='promotion')), \
             patch.object(scan, 'embed_text', return_value=[1.0]), patch.object(scan, 'store_candidate', return_value='added'):
            stats, _ = _scan(budget=1, search=search)
        assert (dict(stats.by_source), dict(stats.by_kind)) == ({'web_results': 1, 'web': 1}, {'promotion': 1})
        assert 'Radar: brand scanned' in caplog.text
        assert 'PAGE TEXT' not in caplog.text


class TestKinds:
    @pytest.mark.parametrize(('kind', 'expected'), [('partnership', 'partnership'), ('PROMOTION', 'promotion'),
                                                    ('rumour', 'news'), (None, 'news')])
    def test_the_extractor_maps_kinds_and_defaults_unknown_to_news(self, kind, expected):
        with patch.object(extract, 'converse', return_value=_dated_answer(kind=kind)):
            [found] = extract.extract_candidates([{'title': 't', 'url': 'https://acme.pl/n', 'text': 'x'}], _ctx(), 'exa')
        assert (found.kind, found.found_via) == (expected, ('exa',))

    def test_the_prompt_asks_for_news_of_the_company_itself_inside_a_data_block(self):
        assert 'air quality' in extract.SYSTEM_PROMPT
        assert '<web_results>' in extract._prompt('Acme', [{'title': 't', 'url': 'https://acme.pl/n', 'text': 'x'}])


class TestStore:
    @pytest.fixture
    def table(self):
        with mock_aws():
            yield radar_pk_sk_table('radar')

    def _candidate(self, kind, via, url):
        return ReleaseCandidate('acme', 'Acme', 'Dark mode', 's', '2026-10-20', (url,), ('t',), kind=kind, found_via=(via,))

    def test_a_merge_keeps_the_first_kind_and_unions_found_via(self, table):
        store_candidate(table, self._candidate('announcement', 'feed', 'https://acme.pl/a'), UNIT, TODAY, 'now')
        store_candidate(table, self._candidate('release', 'exa', 'https://news.example/b'), UNIT, TODAY, 'later')
        [view] = list_releases(table, 'acme', date(2026, 1, 1), 10)
        assert (view['kind'], view['found_via'], view['mentions']) == ('announcement', ['exa', 'feed'], 2)

    def test_a_record_from_before_5_42_views_as_a_release_found_on_the_web(self):
        old = {'release_id': 'r', 'feature': 'Dark mode', 'release_date': '2026-01-01', 'urls': [], 'titles': []}
        assert (public_release(old)['kind'], public_release(old)['found_via']) == ('release', ['web'])

    def test_a_kindless_old_record_takes_the_new_kind_on_merge(self, table):
        table.put_item(Item={'pk': 'RELEASE#acme', 'sk': '2026-10-20#old', 'release_id': 'old', 'brand': 'acme',
                             'feature': 'Dark mode', 'release_date': '2026-10-20', 'urls': [], 'titles': [],
                             'mentions': 1, 'embedding': Binary(encode_embedding(UNIT))})
        assert store_candidate(table, self._candidate('promotion', 'feed', 'https://acme.pl/a'), UNIT, TODAY,
                               'now') == 'merged'
        [view] = list_releases(table, 'acme', date(2026, 1, 1), 10)
        assert (view['kind'], view['found_via']) == ('promotion', ['web', 'feed'])


class TestHandler:
    @pytest.fixture
    def world(self):
        with acme_world({'label': 'Acme', 'domains': ['acme.pl'], 'feed_urls': ['https://acme.pl/feed']}) as radar, \
             patch.object(extract, 'converse', return_value='{"releases": []}'):
            yield radar

    def _context(self):
        return lambda_context()

    @pytest.mark.usefixtures('world')
    def test_without_web_search_a_brand_with_feeds_is_still_scanned(self):
        with patch.object(handler, 'is_web_search_configured', return_value=False), \
             patch.object(handler, 'load_exa_key', return_value=None), \
             patch.object(scan, 'feed_results', return_value=[]):
            outcome = handler.handle_event({'mode': 'manual'}, self._context())
        assert (outcome['status'], outcome['queries']) == ('completed', 1)

    def test_the_plan_cursor_is_stored_per_brand_and_resumed(self, world):
        search = MagicMock(return_value=[])
        with patch.object(handler, 'is_web_search_configured', return_value=True), \
             patch.object(handler, 'search_web', search), patch.object(handler, 'load_exa_key', return_value=None), \
             patch.object(scan, 'feed_results', return_value=[]):
            world.put_item(Item={'pk': 'SETTINGS#radar', 'sk': 'config', 'query_cap': 4})
            handler.handle_event({'mode': 'manual'}, self._context())
            first = world.get_item(Key={'pk': 'RADARSCAN#acme', 'sk': 'STATE'})['Item']['query_cursor']
            handler.handle_event({'mode': 'manual'}, self._context())
        second = world.get_item(Key={'pk': 'RADARSCAN#acme', 'sk': 'STATE'})['Item']['query_cursor']
        assert (int(first), int(second)) == (2, 4)  # 4 = 1 feed + 1 news + 1 own domain + 1 more news, twice

    def test_with_no_source_at_all_the_scan_records_why(self, world):
        world.put_item(Item={**BRAND_LIST_KEY, 'brands': [{'label': 'Acme'}]})
        with patch.object(handler, 'is_web_search_configured', return_value=False), \
             patch.object(handler, 'load_exa_key', return_value=None):
            assert handler.handle_event({'mode': 'manual'}, self._context())['reason'] == 'web_search_unavailable'
