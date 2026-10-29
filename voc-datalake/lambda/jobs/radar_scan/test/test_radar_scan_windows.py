"""5.42.01: each Radar search looks back to the day IT last ran, feeds read the whole lookback (docs/radar.md)."""
import json
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

from jobs.radar_scan import extract, handler, scan, windows
from jobs.radar_scan.test.fakes import acme_world, lambda_context, run_scan
from shared.exa_search import ExaSearchError
from shared.radar_brands import RadarBrand
from shared.radar_releases import list_releases

TODAY = date(2026, 10, 27)
LOOKBACK = (TODAY - timedelta(days=windows.LOOKBACK_DAYS)).isoformat()
YESTERDAY = (TODAY - timedelta(days=1)).isoformat()
BRAND = RadarBrand('acme', 'Acme', ('acme.pl',), origin='list')


class TestBrandWindow:
    def test_a_brand_never_scanned_looks_back_ninety_days_everywhere(self):
        window = windows.brand_window({}, TODAY)
        assert (window.lookback, window.since('pl:features'), window.since(windows.EXA_STEP), window.cursor) == (
            '2026-07-29', '2026-07-29', '2026-07-29', 0)

    def test_a_step_that_ran_yesterday_looks_back_to_yesterday_and_one_never_run_ninety_days(self):
        window = windows.brand_window({'since_by_step': {'pl:features': YESTERDAY}}, TODAY)
        assert (window.since('pl:features'), window.since('pl:launch')) == (YESTERDAY, LOOKBACK)

    def test_a_step_last_run_before_the_lookback_looks_back_only_to_the_floor(self):
        window = windows.brand_window({'since_by_step': {windows.EXA_STEP: '2026-01-02'}}, TODAY)
        assert window.since(windows.EXA_STEP) == LOOKBACK

    def test_an_old_state_row_without_since_by_step_looks_back_ninety_days_and_keeps_its_cursor(self):
        window = windows.brand_window({'last_scan_at': f'{TODAY}T08:00:00+00:00', 'query_cursor': Decimal(4)}, TODAY)
        assert (window.since('pl:features'), window.cursor) == (LOOKBACK, 4)

    @pytest.mark.parametrize('state', [
        {'since_by_step': 'pl:features=2026-10-26', 'query_cursor': 'three'},
        {'since_by_step': ['2026-10-26'], 'query_cursor': True},
        {'since_by_step': {'pl:features': 'yesterday', 'exa': None}, 'query_cursor': Decimal('NaN')},
        {'since_by_step': {'pl:features': '2026-12-01'}, 'query_cursor': -3},
    ])
    def test_a_malformed_stored_state_falls_back_to_the_defaults(self, state):
        window = windows.brand_window(state, TODAY)
        assert (dict(window.since_by_step), window.since('pl:features'), window.cursor) == ({}, LOOKBACK, 0)

    def test_next_state_moves_only_the_steps_that_ran_and_drops_entries_older_than_the_lookback(self):
        window = windows.brand_window({'since_by_step': {
            'pl:features': '2026-10-01', 'pl:launch': '2026-10-02', 'en:news': '2026-07-01'}}, TODAY)
        assert windows.next_state(window, ['pl:launch', windows.EXA_STEP], TODAY) == {
            'pl:features': '2026-10-01', 'pl:launch': '2026-10-27', windows.EXA_STEP: '2026-10-27'}


def _scan(since_by_step, budget, **sources):
    return run_scan(BRAND, windows.BrandWindow(LOOKBACK, since_by_step), budget, TODAY, **sources)


@pytest.mark.usefixtures('no_model')
class TestPerStepWindows:
    def test_each_plan_query_asks_for_what_is_new_since_it_last_ran(self):
        _, sources = _scan({'pl:features': YESTERDAY, 'pl:launch': '2026-10-20'}, budget=3)
        news = [c for c in sources['search'].call_args_list if 'published_after' in c.kwargs]
        assert [c.kwargs['published_after'] for c in news] == [YESTERDAY, '2026-10-20']

    def test_exa_uses_its_own_since(self):
        exa = MagicMock(return_value=[])
        _scan({windows.EXA_STEP: '2026-10-15', 'pl:features': YESTERDAY}, budget=4, exa_key='k' * 10, exa=exa)
        assert {c.kwargs['since'] for c in exa.call_args_list} == {'2026-10-15'}

    def test_the_steps_that_answered_are_reported_and_a_failed_exa_is_not(self):
        exa = MagicMock(side_effect=ExaSearchError('Exa search answered HTTP 500'))
        stats, _ = _scan({}, budget=4, exa_key='k' * 10, exa=exa)
        assert stats.ran_steps == ['pl:features', windows.OWN_DOMAINS_STEP]

    def test_the_feeds_always_read_the_whole_lookback(self):
        feeds = MagicMock(return_value=[])
        brand = RadarBrand('acme', 'Acme', origin='list', feed_urls=('https://acme.pl/feed',))
        run_scan(brand, windows.BrandWindow(LOOKBACK, {'pl:features': str(TODAY)}), 1, TODAY, search=None, feeds=feeds)
        assert feeds.call_args.args[1] == date.fromisoformat(LOOKBACK)


class TestHandlerState:
    @pytest.fixture
    def world(self):
        brand = {'label': 'Acme', 'domains': ['acme.pl'], 'language': 'pl', 'feed_urls': ['https://acme.pl/feed']}
        with acme_world(brand) as radar, patch.object(handler, 'load_exa_key', return_value=None), \
             patch.object(scan, 'embed_text', return_value=[1.0] + [0.0] * 1023):
            yield radar

    def _context(self):
        return lambda_context()

    def test_a_brand_scanned_earlier_today_still_files_its_feed_items_from_the_last_ninety_days(self, world):
        today = datetime.now(UTC).date()
        month_ago = (today - timedelta(days=30)).isoformat()
        world.put_item(Item={'pk': 'RADARSCAN#acme', 'sk': 'STATE', 'last_scan_at': f'{today}T06:00:00+00:00',
                             'query_cursor': 2, 'since_by_step': {'pl:features': str(today), 'pl:launch': str(today)}})
        item = {'title': 'FENG loan', 'url': 'https://acme.pl/news/feng', 'text': 'x', 'published_date': month_ago}
        answer = {'releases': [{'feature': 'FENG loan', 'kind': 'promotion', 'release_date': month_ago,
                                'summary': 's', 'sources': [1]}]}
        feeds = MagicMock(return_value=[item])
        with patch.object(handler, 'is_web_search_configured', return_value=False), \
             patch.object(scan, 'feed_results', feeds), patch.object(extract, 'converse', return_value=json.dumps(answer)):
            outcome = handler.handle_event({'mode': 'manual'}, self._context())
        assert feeds.call_args.args[1] == today - timedelta(days=windows.LOOKBACK_DAYS)
        assert outcome['added'] == 1
        [release] = list_releases(world, 'acme', today - timedelta(days=windows.LOOKBACK_DAYS), 10)
        assert (release['feature'], release['release_date']) == ('FENG loan', month_ago)

    def test_the_state_row_stores_since_by_step_next_to_the_cursor(self, world):
        today = str(datetime.now(UTC).date())
        world.put_item(Item={'pk': 'SETTINGS#radar', 'sk': 'config', 'query_cap': 3})
        with patch.object(handler, 'is_web_search_configured', return_value=True), \
             patch.object(handler, 'search_web', MagicMock(return_value=[])), \
             patch.object(scan, 'feed_results', return_value=[]), \
             patch.object(extract, 'converse', return_value='{"releases": []}'):
            handler.handle_event({'mode': 'manual'}, self._context())
        state = world.get_item(Key={'pk': 'RADARSCAN#acme', 'sk': 'STATE'})['Item']
        assert (state['since_by_step'], int(state['query_cursor'])) == (
            {'pl:features': today, windows.OWN_DOMAINS_STEP: today}, 1)
