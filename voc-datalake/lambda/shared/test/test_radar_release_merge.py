"""One Radar release per feature name, and no stale titles on index pages (docs/radar.md → "One record per story")."""
from datetime import date

import pytest
from moto import mock_aws

from shared.radar_brand_citations import BrandMatch
from shared.radar_listing_pages import hub_pages, index_titles
from shared.radar_release_merge import collapse, feature_key, same_name
from shared.radar_releases import ReleaseCandidate, _found_via, list_releases, store_candidate
from shared.test.radar_fixtures import radar_pk_sk_table

EXAMPLE_AIR = BrandMatch(label='Example Air', domains=('example-air.example',))
TODAY = date(2026, 10, 25)


def _unit(axis: int) -> list[float]:
    vector = [0.0] * 1024
    vector[axis] = 1.0
    return vector


def _candidate(feature, day, url, title='Example Air news', kind='third_party'):
    return ReleaseCandidate('example-air', 'Example Air', feature, f'{feature} summary', day, (url,), (title,), kind)


@pytest.fixture
def table():
    with mock_aws():
        yield radar_pk_sk_table('radar')


class TestFeatureKey:
    @pytest.mark.parametrize('spelling', ['Agent', ' agent ', 'AGENT.', '"Agent"', 'Agent!', '\u2014Agent\u2026'])
    def test_case_space_and_end_punctuation_do_not_make_another_feature(self, spelling):
        assert feature_key(spelling) == 'agent'

    def test_inner_words_and_punctuation_stay(self):
        assert feature_key('Agent  Mode 2.0') == 'agent mode 2.0'
        assert feature_key('Agent') != feature_key('Agent mode')

    @pytest.mark.parametrize('empty', ['', '  ', '...', None])
    def test_a_name_of_only_punctuation_is_empty(self, empty):
        assert feature_key(empty) == ''


class TestStoreTime:
    def test_the_same_name_months_apart_merges_whatever_the_embedding(self, table):
        store_candidate(table, _candidate('Agent', '2026-03-24', 'https://example-air.example/agent', kind='official'),
                        _unit(0), TODAY, 'march')
        outcome = store_candidate(table, _candidate('agent.', None, 'https://travel.example/example-air-agent'),
                                  _unit(5), TODAY, 'october')
        assert outcome == 'merged'
        [release] = list_releases(table, 'example-air', date(2025, 1, 1), 10)
        assert (release['feature'], release['release_date'], release['mentions']) == ('Agent', '2026-03-24', 2)
        assert len(release['urls']) == 2

    def test_another_name_far_apart_still_files_a_new_record(self, table):
        store_candidate(table, _candidate('Agent', '2026-03-24', 'https://a.example/example-air-1'), _unit(0), TODAY, 'a')
        assert store_candidate(table, _candidate('Agent mode', '2026-10-01', 'https://b.example/example-air-2'),
                               _unit(0), TODAY, 'b') == 'added'

    def test_same_name_prefers_the_official_dated_record_among_stored_duplicates(self):
        rows = [{'feature': 'Loops', 'date_approximate': True, 'release_date': '2026-10-25'},
                {'feature': 'loops', 'source_kind': 'official', 'date_approximate': False, 'release_date': '2026-03-01'}]
        best = same_name(rows, 'LOOPS')
        assert best is not None
        assert best['source_kind'] == 'official'
        assert same_name(rows, '...') is None


def _view(feature, release_date, urls, **extra):
    return {'feature': feature, 'release_date': release_date, 'urls': urls, 'titles': ['t'] * len(urls),
            'mentions': 1, 'kind': 'release', 'found_via': ['web'], 'date_approximate': False, **extra}


class TestCollapse:
    def test_two_views_of_one_name_read_as_one_with_the_official_dated_one_leading(self):
        undated = _view('Agent', '2026-10-25', ['https://a.example/x'], date_approximate=True, first_seen='2026-10-25',
                        kind='news', found_via=['exa'], summary='undated')
        official = _view('agent', '2026-03-24', ['http://a.example/x', 'https://example-air.example/agent'],
                         source_kind='official', first_seen='2026-03-24', last_seen='2026-03-30', summary='official')
        [merged] = collapse([undated, official], _found_via)
        assert (merged['feature'], merged['release_date'], merged['summary']) == ('agent', '2026-03-24', 'official')
        # http and https of one page are one citation; the official page is kept.
        assert merged['urls'] == ['https://a.example/x', 'https://example-air.example/agent']
        assert (merged['mentions'], merged['kind'], merged['found_via']) == (2, 'release', ['web', 'exa'])
        assert (merged['first_seen'], merged['last_seen']) == ('2026-03-24', '2026-03-30')

    def test_views_of_other_names_or_without_a_name_are_left_alone(self):
        views = [_view('Agent', '2026-01-01', []), _view('', '2026-01-02', []), _view('', '2026-01-03', []),
                 _view('Loops', '2026-01-04', [])]
        assert [v['release_date'] for v in collapse(views, _found_via)] == ['2026-01-01', '2026-01-02', '2026-01-03',
                                                                           '2026-01-04']


class TestReadTime:
    def test_rows_stored_before_the_name_rule_read_as_one_and_the_limit_counts_collapsed_rows(self, table):
        for n, day in enumerate(['2026-01-05', '2026-03-05', '2026-06-05', '2026-09-05']):
            table.put_item(Item={'pk': 'RELEASE#example-air', 'sk': f'{day}#r{n}', 'release_id': f'r{n}',
                                 'feature': 'Loops', 'release_date': day, 'urls': [f'https://a.example/example-air-{n}'],
                                 'titles': [f'Loops {n}']})
        for n, day in enumerate(['2026-02-01', '2026-04-01']):
            table.put_item(Item={'pk': 'RELEASE#example-air', 'sk': f'{day}#o{n}', 'release_id': f'o{n}',
                                 'feature': f'Other {n}', 'release_date': day, 'urls': [], 'titles': []})
        releases = list_releases(table, 'example-air', date(2025, 1, 1), 3, EXAMPLE_AIR)
        assert [r['feature'] for r in releases] == ['Loops', 'Other 1', 'Other 0']
        assert (releases[0]['mentions'], len(releases[0]['urls'])) == (4, 4)

    def test_a_record_whose_every_citation_is_dropped_keeps_the_record_with_none(self, table):
        table.put_item(Item={'pk': 'RELEASE#example-air', 'sk': '2026-05-01#r1', 'release_id': 'r1',
                             'feature': 'Loops', 'release_date': '2026-05-01',
                             'urls': ['https://tools.example/four-layers-of-controls'],
                             'titles': ['Another company outlines four layers of controls']})
        [release] = list_releases(table, 'example-air', date(2025, 1, 1), 10, EXAMPLE_AIR)
        assert (release['feature'], release['urls'], release['titles']) == ('Loops', [], [])

    def test_without_a_brand_match_the_citations_read_as_stored(self, table):
        table.put_item(Item={'pk': 'RELEASE#example-air', 'sk': '2026-05-01#r1', 'release_id': 'r1', 'feature': 'Loops',
                             'release_date': '2026-05-01', 'urls': ['https://tools.example/x'], 'titles': ['X']})
        [release] = list_releases(table, 'example-air', date(2025, 1, 1), 10)
        assert release['urls'] == ['https://tools.example/x']


class TestIndexTitles:
    def test_a_listing_page_has_no_title_and_a_story_page_keeps_its_own(self):
        urls = ['https://example-air.example/changelog', 'https://example-air.example/changelog/2026-07-30-loops']
        assert index_titles(urls, ['Coding sessions on mobile', 'Loops']) == ['', 'Loops']

    def test_a_hub_page_has_no_title_and_missing_titles_read_empty(self):
        assert index_titles(['https://a.example/x', 'https://a.example/y'], ['X'], {'a.example/x?'}) == ['', '']

    def test_a_page_two_records_cite_is_a_hub_however_each_spells_it(self):
        records = [['https://a.example/x/'], ['http://www.a.example/x'], ['https://a.example/y']]
        assert hub_pages(records) == {'a.example/x?'}

    def test_one_record_citing_a_page_twice_is_not_a_hub(self):
        assert hub_pages([['https://a.example/x', 'http://a.example/x']]) == set()

    def test_the_api_blanks_an_index_title_cited_by_two_records_and_keeps_story_titles(self, table):
        hub = 'https://example-air.example/whats-new-in-example-air'
        for n, (feature, story) in enumerate([('Guided reviews', 'guided-reviews'), ('Copilot', 'copilot')]):
            table.put_item(Item={'pk': 'RELEASE#example-air', 'sk': f'2026-05-0{n + 1}#r{n}', 'release_id': f'r{n}',
                                 'feature': feature, 'release_date': f'2026-05-0{n + 1}',
                                 'urls': [hub, f'https://travel.example/example-air-{story}'],
                                 'titles': ['Coding sessions on mobile', feature]})
        releases = list_releases(table, 'example-air', date(2025, 1, 1), 10, EXAMPLE_AIR)
        assert [r['titles'] for r in releases] == [['', 'Copilot'], ['', 'Guided reviews']]
