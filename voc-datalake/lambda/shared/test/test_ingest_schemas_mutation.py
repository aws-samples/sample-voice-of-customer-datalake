"""Mutation hardening for `shared/ingest_schemas.py`.

`plugins/_shared/test/test_schemas.py` pins that every live producer's message
validates and that one over-the-limit value per widened field is refused, but a
mutation run found three layers it never looked at:

* the ACCEPTED side of every bound. A limit that moves by one (`> 64` becoming
  `>= 64`, `max_length=256` becoming `257`) refuses or admits exactly one more
  value than the producers were sized against, and no earlier test asserted the
  boundary value itself — a 256-character id, a 50,000-character text, a 64-
  character metadata key, exactly 30 labels, exactly 20 custom fields, a
  `created_at` exactly one day ahead.
* the WORDING of every refusal and the shape of `MessageValidationError`. The
  processor logs the error list and dead-letters the message, so the location
  (`metadata.custom_fields`), the separator and the message text are what an
  operator reads. Each message is pinned here as a literal.
* the fallbacks nothing observed: a non-string `created_at` (an int or a
  `datetime`) must not crash the "unusable" check, an unparseable
  `ingested_at` falls through to now, a naive `created_at` is stamped UTC,
  every sanitised field strips the same set of characters, and each
  `IssueAttributes` counter defaults to exactly 0.
"""
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from shared.ingest_schemas import (
    IngestMessage,
    IssueAttributes,
    MessageMetadata,
    MessageValidationError,
    safe_validate_message,
    validate_message,
)

_CREATED_AT = '2025-01-01T12:00:00Z'
_INGESTED_AT = '2026-01-05T10:00:00+00:00'
_FROZEN_NOW = datetime(2026, 3, 1, 12, 0, 0, tzinfo=UTC)


def _raw(**overrides: object) -> dict:
    return {'id': 'item-1', 'source_platform': 'webscraper', 'text': 'Fine', 'created_at': _CREATED_AT, **overrides}


def _errors(raw: dict) -> list[str]:
    with pytest.raises(MessageValidationError) as exc_info:
        validate_message(raw)
    return exc_info.value.errors


def _issue(**overrides: object) -> dict:
    return {'kind': 'issue', 'repo': 'acme/r', 'number': 1, **overrides}


class _FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        del tz
        return _FROZEN_NOW


class TestTheErrorContract:
    def test_str_names_every_error_joined_by_comma(self):
        exc = MessageValidationError(['a: one', 'b: two'])

        assert exc.errors == ['a: one', 'b: two']
        assert str(exc) == 'Validation failed: a: one, b: two'

    def test_a_nested_location_is_joined_with_dots_and_followed_by_a_colon(self):
        raw = _raw(issue_attributes=_issue(linked_prs=['x']))

        assert _errors(raw) == [
            'issue_attributes.linked_prs.0: Input should be a valid integer, unable to parse string as an integer',
        ]

    def test_a_model_level_error_has_an_empty_location(self):
        raw = _raw(created_at=(datetime.now(UTC) + timedelta(days=5)).isoformat())

        assert _errors(raw) == [': Value error, created_at cannot be more than 1 day in the future']

    def test_every_field_error_is_reported_not_just_the_first(self):
        assert _errors(_raw(id='', text='', unknown='x')) == [
            'id: String should have at least 1 character',
            'text: String should have at least 1 character',
            'unknown: Extra inputs are not permitted',
        ]

    def test_a_missing_created_at_is_defaulted_so_only_the_platform_is_missing(self):
        message, errors = safe_validate_message({'id': 'x', 'text': 't'})

        assert message is None
        assert errors == ['source_platform: Field required']

    @pytest.mark.parametrize('field', ['id', 'source_platform', 'text'])
    def test_a_missing_required_field_is_named(self, field):
        raw = _raw()
        del raw[field]
        assert _errors(raw) == [f'{field}: Field required']


class TestEveryStringBoundIsExact:
    @pytest.mark.parametrize(('field', 'limit'), [
        ('id', 256), ('csv_row_id', 256), ('source_origin', 256), ('manual_import_job_id', 256),
        ('author', 256), ('brand_name', 256), ('ingestion_method', 64),
        ('source_channel', 128), ('channel', 128), ('preset_category', 128), ('preset_subcategory', 128),
        ('title', 500), ('s3_raw_uri', 512),
    ])
    def test_the_limit_is_accepted_and_one_more_is_refused(self, field, limit):
        assert getattr(validate_message(_raw(**{field: 'x' * limit})), field) == 'x' * limit
        assert _errors(_raw(**{field: 'x' * (limit + 1)})) == [
            f'{field}: String should have at most {limit} characters',
        ]

    @pytest.mark.parametrize('field', ['url', 'source_url'])
    def test_a_url_may_be_4096_characters(self, field):
        url = 'https://' + 'x' * 4088
        assert len(url) == 4096
        assert getattr(validate_message(_raw(**{field: url})), field) == url
        assert _errors(_raw(**{field: url + 'x'})) == [f'{field}: String should have at most 4096 characters']

    def test_text_may_be_50_000_characters(self):
        assert validate_message(_raw(text='t' * 50_000)).text == 't' * 50_000
        assert _errors(_raw(text='t' * 50_001)) == ['text: String should have at most 50000 characters']

    def test_a_single_character_id_platform_and_text_are_accepted(self):
        result = validate_message(_raw(id='a', source_platform='g', text='b'))
        assert (result.id, result.source_platform, result.text) == ('a', 'g', 'b')

    def test_a_minimal_message_leaves_every_optional_field_none(self):
        assert validate_message(_raw()).model_dump() == {
            'id': 'item-1', 'source_platform': 'webscraper', 'text': 'Fine',
            'created_at': datetime(2025, 1, 1, 12, 0, tzinfo=UTC),
            'csv_row_id': None, 'rating': None, 'url': None, 'source_url': None, 'source_channel': None,
            'channel': None, 'ingestion_method': None, 'source_origin': None, 'manual_import_job_id': None,
            'preset_category': None, 'preset_subcategory': None, 'author': None, 'title': None,
            'language': None, 'brand_name': None, 'brand_handles_matched': None, 'metadata': None,
            'dimensions': None, 'tags': None, 'pii_policy_applied': None,
            'issue_attributes': None, 'ingested_at': None, 's3_raw_uri': None, 'raw_data': None,
            'is_webhook': None, 'is_update': None, 'is_deleted': None,
        }

    def test_source_platform_may_be_256_characters_and_257_is_refused_before_normalising(self):
        assert validate_message(_raw(source_platform='p' * 256)).source_platform == 'p' * 256
        assert _errors(_raw(source_platform='p' * 257)) == [
            'source_platform: String should have at most 256 characters',
        ]

    def test_brand_handles_matched_may_hold_ten_entries(self):
        assert validate_message(_raw(brand_handles_matched=['h'] * 10)).brand_handles_matched == ['h'] * 10
        assert _errors(_raw(brand_handles_matched=['h'] * 11)) == [
            'brand_handles_matched: List should have at most 10 items after validation, not 11',
        ]


class TestRatingAndLanguage:
    @pytest.mark.parametrize('rating', [1, 2, 4.5, 5, 10, 1.0, 10.0])
    def test_the_whole_scale_including_both_ends_is_accepted(self, rating):
        assert validate_message(_raw(rating=rating)).rating == rating

    def test_an_explicit_null_rating_stays_null(self):
        assert validate_message(_raw(rating=None)).rating is None

    @pytest.mark.parametrize(('rating', 'message'), [
        (0.99, 'rating: Input should be greater than or equal to 1'),
        (10.01, 'rating: Input should be less than or equal to 10'),
    ])
    def test_just_outside_the_scale_names_the_bound(self, rating, message):
        assert _errors(_raw(rating=rating)) == [message]

    @pytest.mark.parametrize('language', ['en', 'pt-BR'])
    def test_a_two_letter_code_with_optional_region_is_accepted(self, language):
        assert validate_message(_raw(language=language)).language == language

    @pytest.mark.parametrize('language', ['EN', 'eng', 'en-us', 'e'])
    def test_other_language_spellings_are_refused(self, language):
        assert _errors(_raw(language=language)) == [
            "language: String should match pattern '^[a-z]{2}(-[A-Z]{2})?$'",
        ]


_SANITISED_FIELDS = (
    'id', 'csv_row_id', 'source_platform', 'source_channel', 'channel',
    'ingestion_method', 'source_origin', 'manual_import_job_id',
    'preset_category', 'preset_subcategory', 'author', 'title',
)


class TestSanitisedStrings:
    @pytest.mark.parametrize('field', _SANITISED_FIELDS)
    def test_c0_del_and_surrounding_whitespace_are_stripped(self, field):
        value = ' \x00a\x08b\x0bc\x0cd\x0ee\x1ff\x7fg '
        assert getattr(validate_message(_raw(**{field: value})), field) == 'abcdefg'

    @pytest.mark.parametrize('field', [f for f in _SANITISED_FIELDS if f not in ('id', 'source_platform')])
    def test_tab_and_newline_survive_inside_an_optional_string(self, field):
        assert getattr(validate_message(_raw(**{field: 'a\tb\nc'})), field) == 'a\tb\nc'

    @pytest.mark.parametrize('field', ['csv_row_id', 'author', 'title'])
    def test_an_explicit_none_stays_none(self, field):
        assert getattr(validate_message(_raw(**{field: None})), field) is None

    @pytest.mark.parametrize('value', ['   ', '\x00\x1f', ' \x7f '])
    def test_an_id_that_is_blank_once_stripped_is_refused_by_name(self, value):
        assert _errors(_raw(id=value)) == ['id: Value error, must not be blank']

    @pytest.mark.parametrize(('value', 'message'), [
        ('   ', 'must not be blank'),
        ('\u200b\ufeff', 'must not be blank'),
        ('a#b', "must not contain '#'"),
        ('\ufdfa' * 15, 'must be at most 256 characters once normalised'),
    ])
    def test_a_source_platform_refusal_says_why(self, value, message):
        assert _errors(_raw(source_platform=value)) == [f'source_platform: Value error, {message}']

    def test_a_platform_that_normalises_to_exactly_256_characters_is_accepted(self):
        # 14 x U+FDFA expand to 252 after NFKC; 4 plain letters bring it to 256.
        value = '\ufdfa' * 14 + 'abcd'
        assert len(validate_message(_raw(source_platform=value)).source_platform) == 256

    @pytest.mark.parametrize(('text', 'expected'), [
        ('a\n\nb', 'a\n\nb'),                     # two newlines stay
        ('a\n\n\nb', 'a\n\nb'),                   # three collapse to two
        ('Para 1\n\n\n\n\nPara 2', 'Para 1\n\nPara 2'),
        ('Line 1\nLine 2\tTabbed', 'Line 1\nLine 2\tTabbed'),  # tab and newline are not control characters here
        ('\x00 keep \x7f', 'keep'),               # C0/DEL removed before trimming
        ('Hello\x00World\x1fTest', 'HelloWorldTest'),
        ('   Trimmed text   ', 'Trimmed text'),
    ])
    def test_text_keeps_tabs_and_double_newlines_and_drops_the_rest(self, text, expected):
        assert validate_message(_raw(text=text)).text == expected


class TestUrls:
    @pytest.mark.parametrize('field', ['url', 'source_url'])
    def test_a_scheme_other_than_http_names_the_rule(self, field):
        assert _errors(_raw(**{field: 'ftp://x'})) == [
            f'{field}: Value error, URL must start with http:// or https://',
        ]

    @pytest.mark.parametrize('field', ['url', 'source_url'])
    @pytest.mark.parametrize('value', ['', None])
    def test_an_empty_or_null_url_becomes_none(self, field, value):
        assert getattr(validate_message(_raw(**{field: value})), field) is None

    @pytest.mark.parametrize('field', ['url', 'source_url'])
    @pytest.mark.parametrize('value', ['http://example.com/r', 'https://example.com/r/1?x=1', 'http://'])
    def test_an_http_or_https_url_is_kept_verbatim(self, field, value):
        assert getattr(validate_message(_raw(**{field: value})), field) == value


class TestMetadata:
    @pytest.mark.parametrize(('field', 'limit'), [
        ('location_id', 64), ('reference_id', 64), ('business_id', 128), ('business_name', 256),
        ('author_image', 512),
    ])
    def test_each_declared_string_bound_is_exact(self, field, limit):
        assert getattr(validate_message(_raw(metadata={field: 'x' * limit})).metadata, field) == 'x' * limit
        assert _errors(_raw(metadata={field: 'x' * (limit + 1)})) == [
            f'metadata.{field}: String should have at most {limit} characters',
        ]

    @pytest.mark.parametrize('field', ['reply_count', 'like_count'])
    def test_counters_accept_zero_and_refuse_negative(self, field):
        assert getattr(validate_message(_raw(metadata={field: 0})).metadata, field) == 0
        assert _errors(_raw(metadata={field: -1})) == [
            f'metadata.{field}: Input should be greater than or equal to 0',
        ]

    def test_a_free_value_of_1000_characters_is_accepted_and_1001_refused(self):
        kept = validate_message(_raw(metadata={'note': 'v' * 1000})).metadata
        assert kept is not None
        assert kept.model_dump()['note'] == 'v' * 1000
        assert _errors(_raw(metadata={'note': 'v' * 1001})) == [
            "metadata: Value error, metadata value for 'note' exceeds max length",
        ]

    @pytest.mark.parametrize('value', [None, True, 0, 1.5, 'text'])
    def test_each_primitive_kind_is_accepted(self, value):
        kept = validate_message(_raw(metadata={'free': value})).metadata
        assert kept is not None
        assert kept.model_dump()['free'] == value

    @pytest.mark.parametrize('value', [{'a': 1}, [1], (1,), object()])
    def test_a_non_primitive_value_names_the_four_allowed_kinds(self, value):
        assert _errors(_raw(metadata={'free': value})) == [
            "metadata: Value error, metadata value for 'free' must be primitive (string, number, boolean, null)",
        ]

    def test_a_key_of_64_characters_is_accepted_and_65_is_truncated_in_the_message(self):
        kept = validate_message(_raw(metadata={'k' * 64: 'v'})).metadata
        assert kept is not None
        assert kept.model_dump()['k' * 64] == 'v'
        assert _errors(_raw(metadata={'k' * 65: 'v'})) == [
            f"metadata: Value error, metadata key '{'k' * 20}...' exceeds max length",
        ]

    def test_a_non_string_key_is_reported_and_its_value_is_not_inspected(self):
        assert _errors(_raw(metadata={1: {'nested': True}})) == [
            "metadata: Value error, metadata key must be string, got <class 'int'>",
        ]

    def test_every_offending_entry_is_listed_in_order_separated_by_semicolons(self):
        metadata = {2: 'x', 'custom_fields': {'ok': 1}, 'k' * 65: ['list'], 'nested': {'a': 1}}
        assert _errors(_raw(metadata=metadata)) == [
            "metadata: Value error, metadata key must be string, got <class 'int'>; "
            f"metadata key '{'k' * 20}...' exceeds max length; "
            f"metadata value for '{'k' * 65}' must be primitive (string, number, boolean, null); "
            "metadata value for 'nested' must be primitive (string, number, boolean, null)",
        ]

    def test_a_non_dict_metadata_is_a_validation_error_not_a_crash(self):
        assert _errors(_raw(metadata='flat')) == [
            'metadata: Input should be a valid dictionary or instance of MessageMetadata',
        ]

    def test_an_undeclared_primitive_key_is_kept(self):
        kept = validate_message(_raw(metadata={'external_ticket': 'T-1'})).metadata
        assert kept is not None
        assert kept.model_dump() == {
            'is_verified': None, 'location_id': None, 'reference_id': None, 'reply_count': None,
            'like_count': None, 'business_id': None, 'business_name': None, 'author_image': None,
            'custom_fields': None, 'external_ticket': 'T-1',
        }


class TestCustomFields:
    def test_twenty_entries_with_64_character_keys_and_1000_character_values_are_accepted(self):
        custom = {f'{i:02d}' + 'k' * 62: 'v' * 1000 for i in range(20)}
        kept = validate_message(_raw(metadata={'custom_fields': custom})).metadata
        assert kept is not None
        assert kept.custom_fields == custom

    def test_a_null_custom_fields_stays_null(self):
        kept = validate_message(_raw(metadata={'custom_fields': None})).metadata
        assert kept is not None
        assert kept.custom_fields is None

    @pytest.mark.parametrize(('custom', 'message'), [
        ({'': 'v'}, 'Value error, custom_fields keys must be 1-64 characters'),
        ({'k' * 65: 'v'}, 'Value error, custom_fields keys must be 1-64 characters'),
        ({'k' * 30: 'v' * 1001}, f"Value error, custom_fields value for '{'k' * 20}' exceeds max length"),
        ({f'k{i}': i for i in range(21)}, 'Dictionary should have at most 20 items after validation, not 21'),
    ])
    def test_each_refusal_is_located_at_metadata_custom_fields(self, custom, message):
        assert _errors(_raw(metadata={'custom_fields': custom})) == [f'metadata.custom_fields: {message}']

    def test_a_1000_character_value_under_a_long_key_is_accepted(self):
        kept = validate_message(_raw(metadata={'custom_fields': {'k' * 64: 'v' * 1000}})).metadata
        assert kept is not None
        assert kept.custom_fields == {'k' * 64: 'v' * 1000}

    def test_custom_fields_is_exempt_from_the_flat_rule_but_nothing_else_is(self):
        assert _errors(_raw(metadata={'custom_fields': {'a': 1}, 'other': {'a': 1}})) == [
            "metadata: Value error, metadata value for 'other' must be primitive (string, number, boolean, null)",
        ]

    @pytest.mark.parametrize(('key', 'value'), [('nested', {'a': 1}), ('list', [1, 2])])
    def test_a_container_answer_is_refused_by_every_scalar_type_in_turn(self, key, value):
        assert _errors(_raw(metadata={'custom_fields': {key: value}})) == [
            f'metadata.custom_fields.{key}.str: Input should be a valid string',
            f'metadata.custom_fields.{key}.int: Input should be a valid integer',
            f'metadata.custom_fields.{key}.float: Input should be a valid number',
            f'metadata.custom_fields.{key}.bool: Input should be a valid boolean',
        ]


class TestIssueAttributes:
    def test_counters_default_to_zero_and_has_repro_to_false(self):
        attributes = validate_message(_raw(issue_attributes=_issue())).issue_attributes
        assert attributes is not None
        assert attributes.model_dump() == {
            'kind': 'issue', 'repo': 'acme/r', 'number': 1, 'parent_id': None, 'state': None,
            'state_reason': None, 'labels': [], 'plus_one': 0, 'reactions_total': 0,
            'author_association': None, 'milestone': None, 'linked_prs': [], 'comment_count': 0,
            'updated_at': None, 'software_version': None, 'version_source': None, 'component': None,
            'error_signature': None, 'has_repro': False,
        }

    @pytest.mark.parametrize('kind', ['issue', 'comment'])
    def test_both_kinds_are_accepted(self, kind):
        attributes = validate_message(_raw(issue_attributes=_issue(kind=kind))).issue_attributes
        assert attributes is not None
        assert attributes.kind == kind

    @pytest.mark.parametrize('source', ['form', 'label', 'body'])
    def test_each_version_source_is_accepted(self, source):
        attributes = validate_message(_raw(issue_attributes=_issue(version_source=source))).issue_attributes
        assert attributes is not None
        assert attributes.version_source == source

    @pytest.mark.parametrize(('field', 'limit'), [
        ('parent_id', 256), ('state', 16), ('state_reason', 32), ('author_association', 32),
        ('milestone', 256), ('updated_at', 40), ('software_version', 64), ('component', 100),
        ('error_signature', 200),
    ])
    def test_each_string_bound_is_exact(self, field, limit):
        attributes = validate_message(_raw(issue_attributes=_issue(**{field: 'x' * limit}))).issue_attributes
        assert attributes is not None
        assert getattr(attributes, field) == 'x' * limit
        assert _errors(_raw(issue_attributes=_issue(**{field: 'x' * (limit + 1)}))) == [
            f'issue_attributes.{field}: String should have at most {limit} characters',
        ]

    def test_repo_may_be_3_to_140_characters(self):
        longest = 'a/' + 'b' * 138
        assert IssueAttributes(**_issue(repo='a/b')).repo == 'a/b'
        assert IssueAttributes(**_issue(repo=longest)).repo == longest
        assert _errors(_raw(issue_attributes=_issue(repo=longest + 'b'))) == [
            'issue_attributes.repo: String should have at most 140 characters',
        ]
        assert _errors(_raw(issue_attributes=_issue(repo='a/'))) == [
            'issue_attributes.repo: String should have at least 3 characters',
        ]

    @pytest.mark.parametrize(('field', 'floor'), [
        ('number', 1), ('plus_one', 0), ('reactions_total', 0), ('comment_count', 0),
    ])
    def test_each_counter_floor_is_exact(self, field, floor):
        attributes = validate_message(_raw(issue_attributes=_issue(**{field: floor}))).issue_attributes
        assert attributes is not None
        assert getattr(attributes, field) == floor
        assert _errors(_raw(issue_attributes=_issue(**{field: floor - 1}))) == [
            f'issue_attributes.{field}: Input should be greater than or equal to {floor}',
        ]

    def test_thirty_labels_of_100_characters_are_accepted(self):
        labels = [f'{i:02d}' + 'l' * 98 for i in range(30)]
        attributes = validate_message(_raw(issue_attributes=_issue(labels=labels))).issue_attributes
        assert attributes is not None
        assert attributes.labels == labels

    def test_a_101_character_label_and_a_31st_label_are_refused_by_name(self):
        assert _errors(_raw(issue_attributes=_issue(labels=['l' * 101]))) == [
            'issue_attributes.labels: Value error, a label exceeds 100 characters',
        ]
        assert _errors(_raw(issue_attributes=_issue(labels=['l'] * 31))) == [
            'issue_attributes.labels: List should have at most 30 items after validation, not 31',
        ]

    @pytest.mark.parametrize(('overrides', 'message'), [
        ({'unknown': 'x'}, 'unknown: Extra inputs are not permitted'),
        ({'kind': 'pull'}, "kind: String should match pattern '^(issue|comment)$'"),
        ({'repo': 'not a repo'}, "repo: String should match pattern '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'"),
        ({'version_source': 'guess'}, "version_source: String should match pattern '^(form|label|body)$'"),
    ])
    def test_an_unknown_field_or_an_unmatched_pattern_is_refused_by_name(self, overrides, message):
        assert _errors(_raw(issue_attributes=_issue(**overrides))) == [f'issue_attributes.{message}']

    def test_fifty_linked_prs_are_accepted_and_51_refused(self):
        attributes = validate_message(_raw(issue_attributes=_issue(linked_prs=list(range(50))))).issue_attributes
        assert attributes is not None
        assert attributes.linked_prs == list(range(50))
        assert _errors(_raw(issue_attributes=_issue(linked_prs=list(range(51))))) == [
            'issue_attributes.linked_prs: List should have at most 50 items after validation, not 51',
        ]


class TestCreatedAt:
    @pytest.mark.parametrize('value', [None, '', '  ', '3 days ago', 'not-a-date'])
    def test_an_unusable_value_takes_ingested_at(self, value):
        result = validate_message(_raw(created_at=value, ingested_at=_INGESTED_AT))
        assert result.created_at == datetime(2026, 1, 5, 10, 0, tzinfo=UTC)

    def test_an_unusable_value_without_an_ingested_at_takes_now(self):
        with patch('shared.ingest_schemas.datetime', _FrozenDatetime):
            absent = validate_message(_raw(created_at=''))
            null = validate_message(_raw(created_at='', ingested_at=None))
        assert (absent.created_at, null.created_at) == (_FROZEN_NOW, _FROZEN_NOW)

    def test_an_unparseable_ingested_at_is_still_refused_on_its_own_field(self):
        assert _errors(_raw(created_at='', ingested_at='yesterday')) == [
            'ingested_at: Input should be a valid datetime or date, input is too short',
        ]

    @pytest.mark.parametrize(('value', 'expected'), [
        (1735732800, datetime(2025, 1, 1, 12, 0, tzinfo=UTC)),
        (datetime(2025, 1, 1, 12, 0, tzinfo=UTC), datetime(2025, 1, 1, 12, 0, tzinfo=UTC)),
        ('2025-01-01T12:00:00Z', datetime(2025, 1, 1, 12, 0, tzinfo=UTC)),
        ('2025-01-01T17:00:00+05:00', datetime(2025, 1, 1, 12, 0, tzinfo=UTC)),
        ('2025-01-01', datetime(2025, 1, 1, 0, 0, tzinfo=UTC)),
    ])
    def test_a_parseable_value_of_any_type_is_kept_not_replaced(self, value, expected):
        assert validate_message(_raw(created_at=value, ingested_at=_INGESTED_AT)).created_at == expected

    def test_a_naive_value_is_stamped_utc(self):
        assert validate_message(_raw(created_at='2025-01-01T12:00:00')).created_at == datetime(
            2025, 1, 1, 12, 0, tzinfo=UTC,
        )

    def test_exactly_one_day_ahead_is_accepted_and_one_second_more_is_refused(self):
        edge = _FROZEN_NOW + timedelta(days=1)
        with patch('shared.ingest_schemas.datetime', _FrozenDatetime):
            assert validate_message(_raw(created_at=edge.isoformat())).created_at == edge
            assert _errors(_raw(created_at=(edge + timedelta(seconds=1)).isoformat())) == [
                ': Value error, created_at cannot be more than 1 day in the future',
            ]

    def test_the_before_hook_leaves_a_non_dict_input_to_pydantic(self):
        with pytest.raises(ValidationError) as exc_info:
            IngestMessage.model_validate('not a dict')
        assert [error['msg'] for error in exc_info.value.errors()] == [
            'Input should be a valid dictionary or instance of IngestMessage',
        ]

    def test_a_metadata_model_instance_is_accepted_as_is(self):
        metadata = MessageMetadata.model_validate({'is_verified': True})
        kept = validate_message(_raw(metadata=metadata)).metadata
        assert kept is not None
        assert kept.is_verified is True


class TestDimensionsTagsAndPiiPolicy:
    """The three KVD contract fields: producer dimensions, tags and the applied source policy."""

    def test_all_three_are_optional_and_default_to_none(self):
        message = validate_message(_raw())
        assert (message.dimensions, message.tags, message.pii_policy_applied) == (None, None, None)

    def test_dimensions_are_kept_with_control_characters_stripped(self):
        message = validate_message(_raw(dimensions={'pro\x00duct ': ' app\x1f', 'user_type': 'partner'}))
        assert message.dimensions == {'product': 'app', 'user_type': 'partner'}

    def test_a_blank_dimension_value_is_dropped_and_all_blank_means_none(self):
        assert validate_message(_raw(dimensions={'product': ' ', 'module': 'login'})).dimensions == {'module': 'login'}
        assert validate_message(_raw(dimensions={'product': ''})).dimensions is None

    def test_ten_dimensions_are_accepted_and_eleven_refused(self):
        assert len(validate_message(_raw(dimensions={f'd{i}': 'v' for i in range(10)})).dimensions or {}) == 10
        assert _errors(_raw(dimensions={f'd{i}': 'v' for i in range(11)})) == [
            'dimensions: Dictionary should have at most 10 items after validation, not 11',
        ]

    def test_dimension_keys_are_bounded_at_32_characters(self):
        assert validate_message(_raw(dimensions={'k' * 32: 'v'})).dimensions == {'k' * 32: 'v'}
        assert _errors(_raw(dimensions={'k' * 33: 'v'})) == [
            'dimensions: Value error, dimension keys must be 1-32 characters',
        ]

    def test_a_blank_dimension_key_is_refused(self):
        assert _errors(_raw(dimensions={' \x00': 'v'})) == [
            'dimensions: Value error, dimension keys must be 1-32 characters',
        ]

    def test_dimension_values_are_bounded_at_64_characters(self):
        assert validate_message(_raw(dimensions={'product': 'v' * 64})).dimensions == {'product': 'v' * 64}
        assert _errors(_raw(dimensions={'product': 'v' * 65})) == [
            "dimensions: Value error, dimension value for 'product' exceeds 64 characters",
        ]

    @pytest.mark.parametrize('dimensions', [{'product': 3}, {'product': ['app']}, ['product']])
    def test_non_string_dimension_values_are_refused(self, dimensions):
        assert _errors(_raw(dimensions=dimensions))[0].startswith('dimensions')

    def test_tags_are_normalised_like_the_settings_rows(self):
        message = validate_message(_raw(tags=[' VIP ', 'vip', '', 'beta\x00 tester']))
        assert message.tags == ['VIP', 'beta tester']

    def test_no_usable_tags_means_none(self):
        assert validate_message(_raw(tags=['', '  '])).tags is None

    def test_twenty_tags_are_accepted_and_twenty_one_refused(self):
        assert len(validate_message(_raw(tags=[f't{i}' for i in range(20)])).tags or []) == 20
        assert _errors(_raw(tags=[f't{i}' for i in range(21)])) == ['tags: Value error, At most 20 tags are allowed']

    def test_a_tag_is_bounded_at_64_characters(self):
        assert validate_message(_raw(tags=['t' * 64])).tags == ['t' * 64]
        assert _errors(_raw(tags=['t' * 65])) == [
            'tags: Value error, Tags must be 1-64 characters with no "#", "," or ":"',
        ]

    @pytest.mark.parametrize('tags', [['a#b'], ['a,b'], ['a:b'], [3], 'vip'])
    def test_malformed_tags_are_refused(self, tags):
        assert _errors(_raw(tags=tags))[0].startswith('tags')

    @pytest.mark.parametrize('policy', ['allow', 'redact', 'summary_only'])
    def test_each_pii_policy_is_accepted(self, policy):
        assert validate_message(_raw(pii_policy_applied=policy)).pii_policy_applied == policy

    @pytest.mark.parametrize('policy', ['ALLOW', 'hide', 'redact ', ''])
    def test_any_other_pii_policy_is_refused(self, policy):
        assert _errors(_raw(pii_policy_applied=policy)) == [
            "pii_policy_applied: String should match pattern '^(allow|redact|summary_only)$'",
        ]
