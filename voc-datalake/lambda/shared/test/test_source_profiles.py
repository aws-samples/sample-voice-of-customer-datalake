"""`shared/source_profiles.py`: per-source data-protection policy and its container cache."""
from collections.abc import Iterator
from contextlib import contextmanager
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws

from shared import source_profiles
from shared.dimension_config import validate_dimensions
from shared.source_profiles import (
    PII_ALLOW,
    PII_REDACT,
    PII_SUMMARY_ONLY,
    SOURCES_SETTINGS_KEY,
    SourceProfilesUnavailable,
    cached_source_profile,
    cached_source_profile_strict,
    clear_source_profiles_cache,
    load_source_profiles,
    profile_for,
    restricted_source_ids,
    validate_source_profiles,
)
from shared.test.moto_tables import create_pk_sk_table

_DIMENSIONS = validate_dimensions([
    {'key': 'product', 'values': [{'name': 'app'}, {'name': 'web'}]},
    {'key': 'user_type', 'values': [{'name': 'customer'}, {'name': 'partner'}]},
])


def _defaults(source_id: str) -> dict:
    return {
        'id': source_id, 'label': source_id, 'pii': 'allow', 'retention_days': None,
        'restricted': False, 'dimension_defaults': {}, 'tags': [],
    }


def _refusal(value: object) -> str:
    with pytest.raises(ValueError, match=r'.') as exc_info:
        validate_source_profiles(value, _DIMENSIONS)
    return str(exc_info.value)


@pytest.fixture(autouse=True)
def _fresh_cache():
    clear_source_profiles_cache()
    yield
    clear_source_profiles_cache()


class TestValidateSourceProfilesNormalises:
    def test_a_minimal_profile_gets_every_default(self):
        assert validate_source_profiles([{'id': 'support_tickets'}], _DIMENSIONS) == [_defaults('support_tickets')]

    def test_a_full_profile_round_trips_trimmed_and_unknown_keys_dropped(self):
        result = validate_source_profiles([{
            'id': ' support_tickets ', 'label': ' Support tickets ', 'pii': 'summary_only',
            'retention_days': 365, 'restricted': True,
            'dimension_defaults': {'product': 'app'}, 'tags': [' support ', 'Support'], 'extra': 1,
        }], _DIMENSIONS)
        assert result == [{
            'id': 'support_tickets', 'label': 'Support tickets', 'pii': 'summary_only',
            'retention_days': 365, 'restricted': True,
            'dimension_defaults': {'product': 'app'}, 'tags': ['support'],
        }]

    def test_none_means_no_profiles(self):
        assert validate_source_profiles(None, _DIMENSIONS) == []

    def test_the_settings_key_and_pii_constants_are_the_contract(self):
        assert SOURCES_SETTINGS_KEY == {'pk': 'SETTINGS#sources', 'sk': 'config'}
        assert (PII_ALLOW, PII_REDACT, PII_SUMMARY_ONLY) == ('allow', 'redact', 'summary_only')


class TestValidateSourceProfilesLimits:
    def test_fifty_profiles_are_accepted_and_fifty_one_refused(self):
        assert len(validate_source_profiles([{'id': f's{i}'} for i in range(50)], _DIMENSIONS)) == 50
        assert _refusal([{'id': f's{i}'} for i in range(51)]) == 'At most 50 source profiles are allowed'

    def test_a_48_character_id_is_accepted_and_49_refused(self):
        assert validate_source_profiles([{'id': 'a' * 48}], _DIMENSIONS)[0]['id'] == 'a' * 48
        assert 'Source ids must be 1-48 characters' in _refusal([{'id': 'a' * 49}])

    def test_label_is_bounded_at_64_characters(self):
        assert validate_source_profiles([{'id': 's', 'label': 'L' * 64}], _DIMENSIONS)[0]['label'] == 'L' * 64
        assert _refusal([{'id': 's', 'label': 'L' * 65}]) == 'Source "s" label must be at most 64 characters'

    @pytest.mark.parametrize('days', [30, 3650, Decimal(90)])
    def test_retention_bounds_are_accepted(self, days):
        assert validate_source_profiles([{'id': 's', 'retention_days': days}], _DIMENSIONS)[0]['retention_days'] == days

    @pytest.mark.parametrize('days', [29, 3651, 0, -1, 90.5, Decimal('90.5'), '90', True])
    def test_retention_outside_the_range_or_not_whole_is_refused(self, days):
        assert 'retention_days must be empty (keep forever) or a whole number from 30 to 3650' in _refusal(
            [{'id': 's', 'retention_days': days}])

    def test_tags_over_the_limit_are_refused_naming_the_source(self):
        assert _refusal([{'id': 's', 'tags': [f't{i}' for i in range(21)]}]) == 'Source "s": At most 20 tags are allowed'


class TestValidateSourceProfilesRefuses:
    @pytest.mark.parametrize('source_id', ['', 'Support', '_x', '-x', 'a b', 'a#b', 'ünï'])
    def test_malformed_ids(self, source_id):
        assert 'Source ids must be 1-48 characters' in _refusal([{'id': source_id}])

    def test_duplicate_ids(self):
        assert _refusal([{'id': 's'}, {'id': 's'}]) == 'Source ids must be unique'

    def test_an_unknown_pii_policy(self):
        assert _refusal([{'id': 's', 'pii': 'hide'}]) == 'Source "s" pii must be one of allow, redact, summary_only'

    @pytest.mark.parametrize('restricted', ['true', 1, 0])
    def test_a_non_boolean_restricted(self, restricted):
        assert _refusal([{'id': 's', 'restricted': restricted}]) == 'Source "s" restricted must be true or false'

    def test_a_default_for_an_unknown_dimension(self):
        assert _refusal([{'id': 's', 'dimension_defaults': {'region': 'eu'}}]) == (
            'Source "s" dimension_defaults names an unknown dimension "region"')

    def test_a_default_value_the_dimension_does_not_allow(self):
        assert _refusal([{'id': 's', 'dimension_defaults': {'product': 'tv'}}]) == (
            'Source "s" dimension_defaults: "tv" is not a value of dimension "product"')

    @pytest.mark.parametrize('defaults', [{'product': 3}, ['product']])
    def test_malformed_dimension_defaults(self, defaults):
        assert 'dimension_defaults must' in _refusal([{'id': 's', 'dimension_defaults': defaults}])

    def test_a_non_list_and_a_non_object_entry(self):
        assert _refusal({'id': 's'}) == 'source profiles must be a list'
        assert _refusal(['s']) == 'Each source profile must be an object'


class TestLoadSourceProfiles:
    def test_reads_the_row_from_dynamodb_with_decimal_retention_as_int(self):
        with mock_aws():
            table = create_pk_sk_table('agg')
            table.put_item(Item={**SOURCES_SETTINGS_KEY, 'sources': [
                {'id': 'support_tickets', 'retention_days': 365, 'restricted': True,
                 'dimension_defaults': {'retired_dimension': 'x'}},
            ]})
            profiles = load_source_profiles(table)
        assert profiles == [{
            **_defaults('support_tickets'), 'retention_days': 365, 'restricted': True,
            'dimension_defaults': {'retired_dimension': 'x'},
        }]
        assert type(profiles[0]['retention_days']) is int

    def test_no_row_means_no_profiles(self):
        with mock_aws():
            assert load_source_profiles(create_pk_sk_table('agg')) == []

    def test_a_corrupt_row_raises_rather_than_dropping_a_restriction(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'sources': [{'id': 'Bad Id', 'restricted': True}]}}
        with pytest.raises(ValueError, match='Source ids must be'):
            load_source_profiles(table)
        table.get_item.assert_called_once_with(Key=SOURCES_SETTINGS_KEY, ConsistentRead=True)


class TestProfileFor:
    def test_returns_the_matching_profile(self):
        profiles = validate_source_profiles([{'id': 'a', 'pii': 'redact'}, {'id': 'b'}], _DIMENSIONS)
        assert profile_for(profiles, 'a')['pii'] == 'redact'

    def test_an_unknown_source_gets_the_full_default_profile(self):
        assert profile_for([], 'webscraper') == _defaults('webscraper')

    def test_the_result_is_a_copy_the_caller_may_mutate(self):
        profiles = validate_source_profiles([{'id': 'a', 'tags': ['x'], 'dimension_defaults': {'product': 'app'}}],
                                            _DIMENSIONS)
        copy = profile_for(profiles, 'a')
        copy['tags'].append('y')
        copy['dimension_defaults']['product'] = 'web'
        assert profiles[0]['tags'] == ['x']
        assert profiles[0]['dimension_defaults'] == {'product': 'app'}


class TestRestrictedSourceIds:
    def test_lists_only_restricted_sources(self):
        profiles = validate_source_profiles(
            [{'id': 'a', 'restricted': True}, {'id': 'b'}, {'id': 'c', 'restricted': True}], _DIMENSIONS)
        assert restricted_source_ids(profiles) == frozenset({'a', 'c'})

    def test_no_profiles_means_nothing_restricted(self):
        assert restricted_source_ids([]) == frozenset()


@contextmanager
def _stored_profiles(
    monkeypatch: pytest.MonkeyPatch, sources: object = None, error: Exception | None = None,
) -> Iterator[MagicMock]:
    """An aggregates table holding *sources* (or failing every read with *error*), wired in as the module's resource."""
    monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
    table = MagicMock()
    if error is not None:
        table.get_item.side_effect = error
    else:
        table.get_item.return_value = {'Item': {'sources': sources}} if sources is not None else {}
    resource = MagicMock()
    resource.Table.return_value = table
    with patch('shared.source_profiles.get_dynamodb_resource', return_value=resource):
        yield table


@contextmanager
def _clock(readings: list[float]) -> Iterator[MagicMock]:
    """The module's own clock reads *readings* in turn (the logger keeps the real one)."""
    with patch.object(source_profiles, 'time') as fake_time:
        fake_time.time.side_effect = readings
        yield fake_time


class TestCachedSourceProfile:
    def test_returns_the_stored_profile(self, monkeypatch):
        with _stored_profiles(monkeypatch, [{'id': 'support', 'pii': 'redact'}]):
            assert cached_source_profile('support')['pii'] == 'redact'

    def test_reads_the_table_once_within_the_ttl_for_every_source(self, monkeypatch):
        with _stored_profiles(monkeypatch, [{'id': 'support'}]) as table, \
                _clock([1000.0, 1100.0, 1299.0]):
            cached_source_profile('support')
            cached_source_profile('webscraper')
            cached_source_profile('support')
        assert table.get_item.call_count == 1

    def test_rereads_after_300_seconds(self, monkeypatch):
        with _stored_profiles(monkeypatch, [{'id': 'support'}]) as table, \
                _clock([1000.0, 1300.0]):
            cached_source_profile('support')
            cached_source_profile('support')
        assert table.get_item.call_count == 2

    def test_a_failed_read_yields_defaults_and_retries_after_30_seconds(self, monkeypatch):
        with _stored_profiles(monkeypatch, error=RuntimeError('throttled')) as table, \
                _clock([1000.0, 1029.0, 1030.0]):
            assert cached_source_profile('support') == _defaults('support')
            cached_source_profile('support')
            cached_source_profile('support')
        assert table.get_item.call_count == 2

    def test_the_strict_reader_raises_on_a_failed_read_and_keeps_raising_within_the_error_ttl(self, monkeypatch):
        with _stored_profiles(monkeypatch, error=RuntimeError('throttled')) as table, \
                _clock([1000.0, 1029.0, 1030.0]):
            with pytest.raises(SourceProfilesUnavailable) as exc:
                cached_source_profile_strict('support')
            assert exc.value.status_code == 503
            for _ in range(2):  # 1029 s: the cached failure; 1030 s: a reread that fails again
                with pytest.raises(SourceProfilesUnavailable):
                    cached_source_profile_strict('support')
        assert table.get_item.call_count == 2

    def test_the_strict_reader_serves_a_good_read(self, monkeypatch):
        with _stored_profiles(monkeypatch, [{'id': 'support', 'pii': 'redact'}]):
            assert cached_source_profile_strict('support')['pii'] == 'redact'

    def test_the_strict_reader_raises_on_a_corrupt_row(self, monkeypatch):
        with _stored_profiles(monkeypatch, [{'id': 'Bad Id'}]), pytest.raises(SourceProfilesUnavailable):
            cached_source_profile_strict('support')

    def test_a_corrupt_row_yields_defaults_and_is_logged(self, monkeypatch):
        with _stored_profiles(monkeypatch, [{'id': 'Bad Id'}]), \
                patch.object(source_profiles.logger, 'exception') as log:
            assert cached_source_profile('support') == _defaults('support')
        log.assert_called_once_with('Source profiles lookup failed; using defaults')

    def test_no_table_env_yields_defaults_without_a_read(self, monkeypatch):
        monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
        with patch('shared.source_profiles.get_dynamodb_resource') as resource:
            assert cached_source_profile('support') == _defaults('support')
        resource.assert_not_called()

    def test_clearing_the_cache_forces_a_reread(self, monkeypatch):
        with _stored_profiles(monkeypatch, [{'id': 'support'}]) as table:
            cached_source_profile('support')
            clear_source_profiles_cache()
            cached_source_profile('support')
        assert table.get_item.call_count == 2

    def test_a_caller_mutating_its_profile_does_not_change_the_cache(self, monkeypatch):
        with _stored_profiles(monkeypatch, [{'id': 'support', 'tags': ['x']}]):
            cached_source_profile('support')['tags'].append('y')
            assert cached_source_profile('support')['tags'] == ['x']
