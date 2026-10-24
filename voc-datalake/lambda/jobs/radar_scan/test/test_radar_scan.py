"""voc-radar-scan: release scan steps, budgets, dedupe and the zero-cost skips (docs/radar.md)."""
import json
import math
from datetime import UTC, date, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws

from jobs.radar_scan import extract, handler, scan
from shared.radar_brands import RadarBrand
from shared.radar_releases import ReleaseCandidate, list_releases, source_kind, store_candidate
from shared.test.radar_fixtures import radar_pk_sk_table

PROFILES = {'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': [
    {'id': 'rival_reviews', 'radar_brand': 'Acme', 'radar_domains': ['acme.com']}]}


_table = radar_pk_sk_table


def _unit(index):
    """A unit vector along axis ``index`` (so two releases match only when they share it)."""
    vector = [0.0] * 1024
    vector[index] = 1.0
    return vector


def _context(remaining_ms=900_000):
    context = MagicMock()
    context.get_remaining_time_in_millis.return_value = remaining_ms
    return context


def _today():
    return datetime.now(UTC).date()


def _ctx(pages=0, fetch=None, today=None, domains=()):
    return extract.ExtractContext('acme', 'Acme', domains, today or _today(), extract.Budget(pages), fetch or MagicMock())


def _result(n, url, published=''):
    return {'title': f'Result {n}', 'url': url, 'text': f'snippet {n}', 'published_date': published}


@pytest.fixture
def world():
    with mock_aws():
        radar, aggregates = _table('radar'), _table('aggregates')
        aggregates.put_item(Item=PROFILES)
        aggregates.put_item(Item={'pk': 'SETTINGS#brand', 'sk': 'config', 'brand_name': 'Ours'})
        answer = {'releases': [{'feature': 'Dark mode', 'release_date': None, 'summary': 'Acme shipped dark mode.',
                                'sources': [1]}]}
        search = MagicMock(return_value=[_result(1, 'https://blog.acme.com/dark', str(_today()))])
        with patch.object(handler, 'RADAR_TABLE', 'radar'), patch.object(handler, 'AGGREGATES_TABLE', 'aggregates'), \
             patch.object(handler, 'is_web_search_configured', return_value=True), \
             patch.object(scan, 'search_web', search), \
             patch.object(scan, 'embed_text', return_value=_unit(0)), \
             patch.object(extract, 'converse', return_value=json.dumps(answer)) as model:
            yield radar, aggregates, search, model


class TestHandler:
    def test_no_radar_brand_means_no_search_and_no_model_call(self, world):
        _, aggregates, search, model = world
        aggregates.put_item(Item={**PROFILES, 'sources': [{'id': 'web'}]})
        assert handler.handle_event({'mode': 'manual'}, _context()) == {'status': 'skipped', 'reason': 'no_brands'}
        search.assert_not_called()
        model.assert_not_called()

    def test_a_manual_scan_files_an_official_release_with_citations(self, world):
        radar, _, _, _ = world
        outcome = handler.handle_event({'mode': 'manual', 'requested_by': 'sub-admin'}, _context())
        assert (outcome['status'], outcome['added'], outcome['brands']) == ('completed', 1, 1)
        releases = list_releases(radar, 'acme', _today() - timedelta(days=1), 10)
        assert [(r['feature'], r['source_kind'], r['urls']) for r in releases] == [
            ('Dark mode', 'official', ['https://blog.acme.com/dark'])]
        assert releases[0]['release_date'] == str(_today())
        assert 'embedding' not in releases[0]

    def test_the_query_cap_bounds_every_search(self, world):
        radar, _, search, _ = world
        radar.put_item(Item={'pk': 'SETTINGS#radar', 'sk': 'config', 'cadence': 'weekly', 'max_brands': 10,
                             'query_cap': 3})
        outcome = handler.handle_event({'mode': 'manual'}, _context())
        assert search.call_count == 3
        assert outcome['queries'] == 3

    def test_a_scheduled_tick_skips_until_the_cadence_is_due(self, world):
        radar, _, search, _ = world
        radar.put_item(Item={**handler.LAST_KEY, 'finished_at': datetime.now(UTC).isoformat()})
        assert handler.handle_event({'mode': 'scheduled'}, _context())['reason'] == 'not_due'
        search.assert_not_called()

    def test_a_second_scan_while_one_runs_is_refused(self, world):
        radar, _, _, _ = world
        radar.put_item(Item={**handler.LOCK_KEY, 'expires_at': int(datetime.now(UTC).timestamp()) + 600})
        assert handler.handle_event({'mode': 'manual'}, _context())['reason'] == 'already_running'

    def test_without_web_search_the_scan_records_why(self, world):
        radar, _, _, _ = world
        with patch.object(handler, 'is_web_search_configured', return_value=False):
            outcome = handler.handle_event({'mode': 'manual'}, _context())
        assert outcome['reason'] == 'web_search_unavailable'
        assert radar.get_item(Key=handler.LAST_KEY)['Item']['status'] == 'skipped'

    def test_the_first_scan_asks_for_the_last_90_days_then_only_since_the_last_scan(self, world):
        _, _, search, _ = world
        handler.handle_event({'mode': 'manual'}, _context())
        first_since = search.call_args_list[0].kwargs['published_after']
        assert first_since == (datetime.now(UTC) - timedelta(days=90)).date().isoformat()
        search.reset_mock()
        handler.handle_event({'mode': 'manual'}, _context())
        assert search.call_args_list[0].kwargs['published_after'] == str(_today())


class TestSteps:
    def test_the_own_domain_step_runs_only_when_step_one_found_no_dated_release(self):
        search = MagicMock(return_value=[])
        brand = RadarBrand('acme', 'Acme', ('acme.com',), ('rival',))
        ctx = _ctx(domains=('acme.com',))
        stats = scan.scan_brand(brand, our_brand='Ours', since='2026-01-01', budget=extract.Budget(6), ctx=ctx,
                                table=MagicMock(), now_iso='now', search=search)
        assert stats.steps == ['features', 'own_domains', 'broader']
        own = [c for c in search.call_args_list if c.kwargs['include_domains']]
        assert [c.kwargs['include_domains'] for c in own] == [['acme.com'], ['acme.com']]
        assert search.call_args_list[-1].args[0] == 'Acme vs Ours'


class TestExtract:
    def test_results_reach_the_model_only_inside_a_data_block(self):
        with patch.object(extract, 'converse', return_value='{"releases": []}') as model:
            extract.extract_candidates([_result(1, 'https://x.example/a')], _ctx())
        prompt = model.call_args.kwargs['prompt']
        assert '<web_results>' in prompt
        assert 'snippet 1' in prompt.split('<web_results>', 1)[1]

    def test_a_missing_date_is_read_from_the_article_page_once(self):
        page = MagicMock(status_code=200, text='<meta property="article:published_time" content="2026-09-02T10:00">')
        fetch = MagicMock(return_value=page)
        answer = json.dumps({'releases': [{'feature': 'X', 'summary': 's', 'sources': [1]},
                                          {'feature': 'Y', 'summary': 's', 'sources': [2]}]})
        ctx = _ctx(pages=1, fetch=fetch, today=date(2026, 10, 1))
        with patch.object(extract, 'converse', return_value=answer):
            found = extract.extract_candidates(
                [_result(1, 'https://x.example/a'), _result(2, 'https://x.example/b')], ctx)
        assert [c.release_date for c in found] == ['2026-09-02', None]
        fetch.assert_called_once_with('https://x.example/a', timeout=extract.PAGE_TIMEOUT_SECONDS,
                                      max_bytes=extract.MAX_PAGE_BYTES)

    def test_entries_without_a_cited_result_or_a_feature_are_dropped(self):
        answer = json.dumps({'releases': [{'feature': '', 'sources': [1]}, {'feature': 'Z', 'sources': [9]}, 'x']})
        with patch.object(extract, 'converse', return_value=answer):
            found = extract.extract_candidates([_result(1, 'https://x.example/a')], _ctx())
        assert found == []

    def test_a_future_or_malformed_date_is_ignored(self):
        assert extract._valid_day('2999-01-01', _today()) is None
        assert extract._valid_day('soon', _today()) is None


class TestReleaseDedupe:
    @pytest.fixture
    def table(self):
        with mock_aws():
            yield _table('radar')

    def _candidate(self, feature, kind='third_party', day='2026-09-01', url='https://news.example/1'):
        return ReleaseCandidate('acme', 'Acme', feature, 'summary', day, (url,), ('t',), kind)

    def test_a_near_duplicate_merges_and_counts_a_mention(self, table):
        store_candidate(table, self._candidate('Dark mode'), _unit(0), _today(), 'now')
        similar = [math.sqrt(0.9), math.sqrt(0.1)] + [0.0] * 1022
        outcome = store_candidate(table, self._candidate('Dark theme', url='https://news.example/2'), similar,
                                  _today(), 'later')
        assert outcome == 'merged'
        [release] = list_releases(table, 'acme', date(2026, 1, 1), 10)
        assert (release['mentions'], release['urls']) == (2, ['https://news.example/1', 'https://news.example/2'])

    def test_an_official_source_wins_the_feature_name_and_date(self, table):
        store_candidate(table, self._candidate('dark-ish mode', day='2026-09-05'), _unit(0), _today(), 'now')
        store_candidate(table, self._candidate('Dark mode', 'official', '2026-09-01', 'https://acme.com/n'),
                        _unit(0), _today(), 'later')
        [release] = list_releases(table, 'acme', date(2026, 1, 1), 10)
        assert (release['feature'], release['release_date'], release['source_kind']) == (
            'Dark mode', '2026-09-01', 'official')

    def test_far_apart_or_different_features_stay_separate(self, table):
        store_candidate(table, self._candidate('Dark mode', day='2026-01-01'), _unit(0), _today(), 'now')
        store_candidate(table, self._candidate('Dark mode', day='2026-06-01'), _unit(0), _today(), 'now')
        store_candidate(table, self._candidate('Payments', day='2026-06-02'), _unit(1), _today(), 'now')
        assert len(list_releases(table, 'acme', date(2025, 1, 1), 10)) == 3

    def test_source_kind_matches_the_brand_domains_and_subdomains(self):
        assert source_kind(['https://docs.acme.com/x'], ['acme.com']) == 'official'
        assert source_kind(['https://notacme.com/x', 'bad url'], ['acme.com']) == 'third_party'


class TestRadarVersionBump:
    """docs/caching.md: the scan bumps the Radar version once, when it records its outcome."""

    @staticmethod
    def _version(radar) -> int:
        from shared.data_version import RADAR_VERSION_KEY
        return int((radar.get_item(Key=RADAR_VERSION_KEY).get('Item') or {}).get('v', 0))

    def test_a_completed_scan_bumps_once(self, world):
        radar, _, _, _ = world
        assert handler.handle_event({'mode': 'manual'}, _context())['status'] == 'completed'
        assert self._version(radar) == 1

    def test_a_skipped_scan_records_nothing_and_bumps_nothing(self, world):
        radar, aggregates, _, _ = world
        aggregates.put_item(Item={**PROFILES, 'sources': [{'id': 'web'}]})
        handler.handle_event({'mode': 'manual'}, _context())
        assert self._version(radar) == 0
