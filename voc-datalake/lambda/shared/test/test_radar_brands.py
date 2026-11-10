"""Radar brands on source profiles, and the Radar settings (docs/radar.md)."""
from datetime import timedelta
from decimal import Decimal
from unittest.mock import MagicMock

import pytest

from shared.radar_brands import RadarBrand, brand_key, radar_brands, radar_profile_fields
from shared.radar_settings import (
    DEFAULT_SETTINGS,
    cadence_interval,
    load_settings,
    per_brand_queries,
    validate_settings,
)
from shared.source_profiles import load_source_profiles, profile_for, validate_source_profiles


class TestProfileFields:
    def test_an_ordinary_source_has_no_radar_fields(self):
        assert radar_profile_fields({'id': 'web'}, 'Source "web"') == {}
        assert radar_profile_fields({'radar_brand': '  '}, 'x') == {}

    def test_brand_and_domains_are_normalised(self):
        fields = radar_profile_fields(
            {'radar_brand': '  Acme   Corp ', 'radar_domains': ['https://www.Acme.com/blog', 'acme.com', 'acme.dev']}, 'x')
        assert fields == {'radar_brand': 'Acme Corp', 'radar_domains': ['acme.com', 'acme.dev']}

    @pytest.mark.parametrize('entry', [
        {'radar_brand': 7},
        {'radar_brand': '<script>'},
        {'radar_domains': ['acme.com']},
        {'radar_brand': 'Acme', 'radar_domains': 'acme.com'},
        {'radar_brand': 'Acme', 'radar_domains': ['not a domain']},
        {'radar_brand': 'Acme', 'radar_domains': [f'd{n}.com' for n in range(11)]},
    ])
    def test_invalid_fields_are_refused(self, entry):
        with pytest.raises(ValueError, match='radar_'):
            radar_profile_fields(entry, 'x')

    def test_the_source_profile_validator_keeps_them(self):
        profiles = validate_source_profiles([{'id': 'rival', 'radar_brand': 'Acme', 'radar_domains': ['acme.com']}], [])
        assert profiles[0]['radar_brand'] == 'Acme'
        assert 'radar_brand' not in validate_source_profiles([{'id': 'web'}], [])[0]

    def test_a_stored_profile_round_trips_and_profile_for_copies_the_domains(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'sources': [{'id': 'rival', 'radar_brand': 'Acme',
                                                             'radar_domains': ['acme.com']}]}}
        profiles = load_source_profiles(table)
        copy = profile_for(profiles, 'rival')
        copy['radar_domains'].append('evil.com')
        assert profiles[0]['radar_domains'] == ['acme.com']


class TestBrands:
    def test_brand_key_is_a_stable_slug(self):
        assert brand_key('Acme Corp.') == 'acme-corp'
        assert brand_key("Ana's & Co") == 'ana-s-co'

    def test_profiles_naming_one_brand_merge(self):
        brands = radar_brands([
            {'id': 'a', 'radar_brand': 'Acme', 'radar_domains': ['acme.com']},
            {'id': 'web'},
            {'id': 'b', 'radar_brand': 'acme', 'radar_domains': ['acme.com', 'acme.dev']},
            {'id': 'c', 'radar_brand': 'Globex'},
        ])
        assert brands == [
            RadarBrand('acme', 'Acme', ('acme.com', 'acme.dev'), ('a', 'b')),
            RadarBrand('globex', 'Globex', (), ('c',)),
        ]


class TestSettings:
    def test_defaults_fill_missing_fields(self):
        assert validate_settings({}) == DEFAULT_SETTINGS
        assert validate_settings({'cadence': 'daily', 'max_brands': 3})['max_brands'] == 3

    @pytest.mark.parametrize('body', [
        [], {'cadence': 'hourly'}, {'max_brands': 0}, {'max_brands': 26}, {'query_cap': 1.5}, {'query_cap': True},
    ])
    def test_invalid_settings_are_refused(self, body):
        with pytest.raises(ValueError, match='must'):
            validate_settings(body)

    def test_a_stored_row_reads_back_with_its_decimals(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'cadence': 'monthly', 'max_brands': Decimal(4), 'query_cap': Decimal(12)}}
        assert load_settings(table) == {'cadence': 'monthly', 'max_brands': 4, 'query_cap': 12}

    def test_a_corrupt_row_falls_back_to_the_defaults(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'cadence': 'never'}}
        assert load_settings(table) == DEFAULT_SETTINGS

    def test_cadence_and_query_share(self):
        assert cadence_interval('weekly') == timedelta(days=7) - timedelta(hours=1)
        assert per_brand_queries(30, 4) == 7
        assert per_brand_queries(2, 5) == 1
