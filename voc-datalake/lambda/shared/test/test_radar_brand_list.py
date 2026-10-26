"""The Radar brand list, the effective brands, ``radar_brand`` on configs, and the processor's lookup (docs/radar.md)."""
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from shared.ingest_schemas import safe_validate_message
from shared.radar_brands import (
    BRAND_LIST_KEY,
    RadarBrand,
    effective_brands,
    is_brand_key,
    load_brand_list,
    radar_brand_setting,
    radar_stamp,
    validate_brand_list,
)
from shared.radar_routing import BrandLabels, RadarBrandListUnavailableError, UnknownRadarBrandError
from shared.web_review_targets import TargetError, validated_target


def _table(brands):
    table = MagicMock()
    table.get_item.return_value = {'Item': {**BRAND_LIST_KEY, 'brands': brands}} if brands is not None else {}
    return table


class TestBrandList:
    def test_labels_and_domains_are_normalised(self):
        assert validate_brand_list({'brands': [{'label': ' Acme  Corp ', 'domains': ['https://www.Acme.com/x']}]}) == [
            {'label': 'Acme Corp', 'domains': ['acme.com']}]

    @pytest.mark.parametrize(('body', 'message'), [
        ([], 'JSON object'),
        ({'brands': 'Acme'}, 'must be a list'),
        ({'brands': [{'label': 'Acme'}, {'label': 'acme'}]}, 'already in the list'),
        ({'brands': ['Acme']}, 'must be an object'),
        ({'brands': [{'label': 'Ünïcode only é'}]}, 'Latin letters'),
        ({'brands': [{'label': 'Acme', 'domains': 'acme.com'}]}, 'domains must be a list'),
        ({'brands': [{'label': f'B{n}'} for n in range(26)]}, 'at most 25'),
    ])
    def test_an_invalid_list_names_the_problem(self, body, message):
        with pytest.raises(ValueError, match=message):
            validate_brand_list(body)

    def test_no_saved_list_is_empty_and_a_corrupt_one_raises(self):
        assert load_brand_list(_table(None)) == []
        with pytest.raises(ValueError, match='must be a list'):
            load_brand_list(_table('corrupt'))


LEGACY_PROFILES = ({'id': 'rival', 'radar_brand': 'ACME', 'radar_domains': ['acme.com']},
                   {'id': 'radar_example_air', 'radar_brand': 'Example Air'})
MESSAGE = {'id': 'x', 'source_platform': 'Initech reviews', 'text': 'Hi', 'created_at': '2026-10-01T00:00:00Z'}
TARGET = {'app_name': 'Initech', 'url': 'https://www.trustpilot.com/review/initech.com'}


class TestEffectiveBrands:
    def test_the_list_then_legacy_brands_merged_by_key(self):
        brands = effective_brands([{'label': 'Acme', 'domains': ['acme.io']}], LEGACY_PROFILES)
        assert brands == [
            RadarBrand('acme', 'Acme', ('acme.io', 'acme.com'), ('rival',), 'list'),
            RadarBrand('example-air', 'Example Air', (), ('radar_example_air',), 'profile'),
        ]

    def test_without_a_list_the_legacy_brands_are_all_there_is(self):
        assert [b.key for b in effective_brands([], LEGACY_PROFILES)] == ['acme', 'example-air']


class TestConfigField:
    @pytest.mark.parametrize(('raw', 'expected'), [(None, ''), ('', ''), ('  ', ''), (' acme ', 'acme'),
                                                   ('example-air', 'example-air'), ('acme_co-2', 'acme_co-2')])
    def test_a_saved_radar_brand_is_a_key_or_nothing(self, raw, expected):
        assert radar_brand_setting(raw) == expected

    @pytest.mark.parametrize('raw', ['Acme', 'acme corp', '-acme', 'x' * 65, 7, ['acme']])
    def test_a_malformed_radar_brand_is_refused(self, raw):
        with pytest.raises(ValueError, match='Radar brand key'):
            radar_brand_setting(raw)

    def test_the_ingest_stamp_never_drops_a_value(self):
        assert (radar_stamp(None), radar_stamp(''), radar_stamp(' acme ')) == ({}, {}, {'radar_brand_key': 'acme'})
        assert radar_stamp('Bad Key') == {'radar_brand_key': 'Bad Key'}

    def test_is_brand_key(self):
        assert (is_brand_key('acme'), is_brand_key('Acme'), is_brand_key(None)) == (True, False, False)


class TestQueueSchema:
    def test_the_message_may_carry_a_brand_key(self):
        message, errors = safe_validate_message({**MESSAGE, 'radar_brand_key': 'initech'})
        assert (errors, message.radar_brand_key if message else None) == ([], 'initech')

    def test_a_malformed_brand_key_is_rejected(self):
        message, errors = safe_validate_message({**MESSAGE, 'radar_brand_key': 'Not A Key'})
        assert message is None
        assert any('radar_brand_key' in error for error in errors)

    def test_a_manual_paste_is_never_stamped(self):
        message, errors = safe_validate_message({**MESSAGE, 'radar_brand_key': 'initech', 'ingestion_method': 'manual'})
        assert message is None
        assert any('manual paste' in error for error in errors)


class TestWebReviewTarget:
    def test_a_target_keeps_its_radar_brand(self, monkeypatch):
        monkeypatch.setattr('shared.web_review_targets.validate_url', lambda _url: (True, None))
        assert validated_target({**TARGET, 'radar_brand': 'initech'})['radar_brand'] == 'initech'
        assert 'radar_brand' not in validated_target({**TARGET, 'radar_brand': ''})

    def test_a_malformed_radar_brand_is_a_target_error(self, monkeypatch):
        monkeypatch.setattr('shared.web_review_targets.validate_url', lambda _url: (True, None))
        with pytest.raises(TargetError, match='Radar brand key'):
            validated_target({**TARGET, 'radar_brand': 'Initech Corp'})


class TestBrandLabels:
    def test_the_list_is_read_once_per_ttl(self):
        table = _table([{'label': 'Initech', 'domains': []}])
        labels = BrandLabels(ttl=60, clock=lambda: 0.0)
        assert [labels.label(table, [], 'initech') for _ in range(3)] == ['Initech'] * 3
        assert table.get_item.call_count == 1

    def test_a_miss_reads_once_more_then_refuses(self):
        table = _table([{'label': 'Initech', 'domains': []}])
        labels = BrandLabels(clock=lambda: 0.0)
        with pytest.raises(UnknownRadarBrandError):
            labels.label(table, [], 'nope')
        assert table.get_item.call_count == 2

    def test_a_legacy_profile_brand_resolves(self):
        labels = BrandLabels()
        assert labels.label(_table(None), [{'id': 'radar_example_air', 'radar_brand': 'Example Air'}], 'example-air') == 'Example Air'

    def test_an_unreadable_list_raises_and_is_not_cached(self):
        table = MagicMock()
        table.get_item.side_effect = ClientError({'Error': {'Code': 'Throttling'}}, 'GetItem')
        labels = BrandLabels()
        with pytest.raises(RadarBrandListUnavailableError):
            labels.label(table, [], 'initech')
        table.get_item.side_effect = None
        table.get_item.return_value = {'Item': {'brands': [{'label': 'Initech'}]}}
        assert labels.label(table, [], 'initech') == 'Initech'
