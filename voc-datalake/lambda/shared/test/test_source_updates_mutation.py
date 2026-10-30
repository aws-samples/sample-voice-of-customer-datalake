"""Mutation hardening for `shared/source_updates.py`.

`processor/test/test_source_updates.py` drives the whole refresh through
`record_handler` against moto, so it proves the outcome (a label lands, a stale
copy is skipped, a manual category survives) but a mutation run found what it
cannot see:

* the exact `update_item` kwargs. Moto evaluates a condition but does not care
  how its placeholders are named, which guards there are beyond the one a test
  happens to trip, or whether a REMOVE clause is spelled out; every expression,
  name and value map is pinned here as a literal.
* the content fingerprint's literal digest and length (sorted keys, the `str`
  fallback for dates, the empty-text default), which only ever appeared as
  "differs from the first key".
* the ordering boundaries of `update_decision` (equal stamps, a naive stamp read
  as UTC, an unparseable or non-string stamp) and the summary-only rule of
  `text_changed` from either side.
* the gsi2sk rebuild for an item with no `#` in its key or no key at all.
"""
from datetime import date

import pytest

from shared.categorization import Enrichment
from shared.source_updates import (
    UPDATE_APPLY,
    UPDATE_STALE,
    UPDATE_UNCHANGED,
    attributes_update,
    content_fingerprint,
    idempotency_key_for,
    is_update_capable,
    keeps_stored_category,
    reenriched_fields,
    reenrichment_update,
    text_changed,
    update_decision,
)
from shared.usefulness import item_usefulness

NOW = '2026-03-01T00:00:00+00:00'
OLD = '2026-01-02T00:00:00+00:00'
NEW = '2026-02-01T00:00:00+00:00'


def _stored(**fields: object) -> dict:
    return {'pk': 'SOURCE#github_issues', 'sk': 'FEEDBACK#7', **fields}


def _incoming(updated_at: object = NEW, text: str = 'body', **attributes: object) -> dict:
    return {'source_platform': 'github_issues', 'id': 'acme/Kiro#7', 'text': text,
            'title': 'Title', 'issue_attributes': {'updated_at': updated_at, **attributes}}


def _enrichment(category_valid: bool = True, **attributes: object) -> Enrichment:
    base = {'category': 'performance', 'subcategory': 'latency', 'sentiment_score': -0.9,
            'urgency': 'high', 'sentiment_label': 'negative'}
    return Enrichment(attributes={**base, **attributes}, llm_result={'metadata': {'model_name': 'haiku'}},
                      category_valid=category_valid)


class TestTheDecisionNames:
    def test_the_three_outcomes_are_the_processor_status_suffixes(self):
        assert (UPDATE_APPLY, UPDATE_STALE, UPDATE_UNCHANGED) == ('apply', 'stale', 'unchanged')


class TestOnlyAGithubIssueIsUpdateCapable:
    @pytest.mark.parametrize(('record', 'expected'), [
        ({'source_platform': 'github_issues', 'issue_attributes': {}}, True),
        ({'source_platform': 'github_issues', 'issue_attributes': {'state': 'open'}}, True),
        ({'source_platform': 'github_issues', 'issue_attributes': None}, False),
        ({'source_platform': 'github_issues', 'issue_attributes': ['state']}, False),
        ({'source_platform': 'github_issues'}, False),
        ({'source_platform': 'webscraper', 'issue_attributes': {'state': 'open'}}, False),
        ({'issue_attributes': {'state': 'open'}}, False),
    ])
    def test_it_takes_the_github_source_and_a_mapping_of_attributes(self, record: dict, expected: bool):
        assert is_update_capable(record) is expected


class TestTheFingerprint:
    def test_it_is_the_first_16_hex_characters_of_the_sorted_payload_digest(self):
        assert content_fingerprint({'issue_attributes': {'b': 1, 'a': 2}, 'text': 'hi'}) == 'fda9ee2325b308b1'

    def test_key_order_does_not_change_it(self):
        assert content_fingerprint({'issue_attributes': {'a': 2, 'b': 1}, 'text': 'hi'}) == 'fda9ee2325b308b1'

    def test_a_missing_text_counts_as_empty_and_missing_attributes_as_null(self):
        assert content_fingerprint({}) == 'cf6cf6ddddd432bd'
        assert content_fingerprint({'issue_attributes': None, 'text': ''}) == 'cf6cf6ddddd432bd'

    def test_a_non_json_value_is_stringified(self):
        assert content_fingerprint({'issue_attributes': {'when': date(2026, 1, 2)}}) == 'b1fea95238c393c9'


class TestTheIdempotencyKey:
    def test_an_issue_gets_the_fingerprint_appended(self):
        record = {'source_platform': 'github_issues', 'id': 'acme/Kiro#7',
                  'issue_attributes': {'b': 1, 'a': 2}, 'text': 'hi'}
        assert idempotency_key_for(record) == 'github_issues:acme/Kiro#7:fda9ee2325b308b1'

    def test_any_other_record_is_source_and_id(self):
        assert idempotency_key_for({'source_platform': 'webscraper', 'id': 'x'}) == 'webscraper:x'

    def test_missing_source_and_id_read_unknown(self):
        assert idempotency_key_for({}) == 'unknown:unknown'


class TestTextChanged:
    def test_the_same_text_is_unchanged_and_another_is_changed(self):
        assert text_changed({'original_text': 'a'}, {'text': 'a'}, 'allow') is False
        assert text_changed({'original_text': 'a'}, {'text': 'b'}, 'allow') is True

    def test_a_missing_incoming_text_compares_as_empty(self):
        assert text_changed({'original_text': ''}, {}, 'allow') is False
        assert text_changed({}, {}, 'allow') is True

    @pytest.mark.parametrize(('policy', 'stored_policy'), [('summary_only', None), ('allow', 'summary_only')])
    def test_a_summary_only_item_never_counts_as_edited(self, policy: str, stored_policy: str | None):
        stored = {'original_text': 'summary', 'pii_policy': stored_policy}
        assert text_changed(stored, {'text': 'raw text'}, policy) is False


class TestUpdateDecision:
    def test_an_older_copy_is_stale(self):
        assert update_decision(_stored(issue_attributes={'updated_at': NEW}), _incoming(OLD), 'allow') == 'stale'

    def test_a_newer_copy_is_applied_even_with_identical_content(self):
        stored = _stored(issue_attributes={'updated_at': OLD}, original_text='body')
        incoming = _incoming(NEW)
        incoming['issue_attributes'] = {'updated_at': NEW}
        assert update_decision(stored, incoming, 'allow') == 'apply'

    def test_the_same_stamp_with_the_same_content_is_unchanged(self):
        incoming = _incoming(NEW)
        stored = _stored(issue_attributes=dict(incoming['issue_attributes']), original_text='body')
        assert update_decision(stored, incoming, 'allow') == 'unchanged'

    def test_the_same_stamp_with_other_attributes_is_applied(self):
        stored = _stored(issue_attributes={'updated_at': NEW, 'state': 'open'}, original_text='body')
        assert update_decision(stored, _incoming(NEW, state='closed'), 'allow') == 'apply'

    def test_the_same_stamp_with_other_text_is_applied(self):
        incoming = _incoming(NEW, text='edited')
        stored = _stored(issue_attributes=dict(incoming['issue_attributes']), original_text='body')
        assert update_decision(stored, incoming, 'allow') == 'apply'

    def test_a_naive_stamp_is_read_as_utc(self):
        stored = _stored(issue_attributes={'updated_at': '2026-02-01T00:00:00'}, original_text='body')
        assert update_decision(stored, _incoming('2026-02-01T00:00:00+00:00'), 'allow') == 'apply'
        assert update_decision(stored, _incoming('2026-01-31T23:59:59+00:00'), 'allow') == 'stale'
        assert update_decision(stored, _incoming('2026-02-01T00:00:01+00:00'), 'allow') == 'apply'

    def test_a_naive_incoming_stamp_is_read_as_utc(self):
        stored = _stored(issue_attributes={'updated_at': NEW}, original_text='body')
        assert update_decision(stored, _incoming('2026-01-31T23:59:59'), 'allow') == 'stale'

    @pytest.mark.parametrize('stamp', ['not a date', 20260201, None])
    def test_an_incoming_copy_without_a_usable_stamp_is_unchanged(self, stamp: object):
        stored = _stored(issue_attributes={'updated_at': OLD, 'state': 'open'}, original_text='other')
        assert update_decision(stored, _incoming(stamp, state='closed'), 'allow') == 'unchanged'

    def test_an_incoming_copy_without_attributes_is_unchanged(self):
        stored = _stored(issue_attributes={'updated_at': OLD}, original_text='other')
        assert update_decision(stored, {'text': 'x'}, 'allow') == 'unchanged'

    @pytest.mark.parametrize('stored_attributes', [{'updated_at': 'garbage'}, {}, 'not a mapping'])
    def test_a_stored_item_without_a_usable_stamp_follows_the_content(self, stored_attributes: object):
        changed = _stored(issue_attributes=stored_attributes, original_text='body')
        assert update_decision(changed, _incoming(OLD), 'allow') == 'apply'
        same = _incoming(OLD)
        assert update_decision(_stored(issue_attributes=same['issue_attributes'], original_text='body'),
                               same, 'allow') == 'unchanged'

    def test_a_summary_only_text_difference_alone_is_unchanged(self):
        incoming = _incoming(NEW, text='raw')
        stored = _stored(issue_attributes=dict(incoming['issue_attributes']), original_text='summary')
        assert update_decision(stored, incoming, 'summary_only') == 'unchanged'


class TestTheAttributesUpdate:
    def test_it_sets_the_attributes_and_refresh_time_guarded_by_what_was_read(self):
        stored = _stored(issue_attributes={'updated_at': OLD})
        incoming = _incoming(NEW)

        assert attributes_update(stored, incoming, NOW) == {
            'Key': {'pk': 'SOURCE#github_issues', 'sk': 'FEEDBACK#7'},
            'UpdateExpression': 'SET #f1 = :f0, #f2 = :f1',
            'ConditionExpression': 'attribute_exists(#pk) AND #g3 = :g2',
            'ExpressionAttributeNames': {'#pk': 'pk', '#f1': 'issue_attributes', '#f2': 'source_refreshed_at',
                                         '#g3': 'issue_attributes'},
            'ExpressionAttributeValues': {':f0': {'updated_at': NEW}, ':f1': NOW, ':g2': {'updated_at': OLD}},
        }

    def test_an_item_stored_without_attributes_requires_them_still_absent(self):
        kwargs = attributes_update(_stored(), _incoming(NEW), NOW)

        assert kwargs['ConditionExpression'] == 'attribute_exists(#pk) AND attribute_not_exists(#g3)'
        assert kwargs['ExpressionAttributeNames']['#g3'] == 'issue_attributes'
        assert kwargs['ExpressionAttributeValues'] == {':f0': {'updated_at': NEW}, ':f1': NOW}


class TestKeepsStoredCategory:
    @pytest.mark.parametrize(('category_source', 'valid', 'expected'), [
        ('manual', True, True),
        ('manual', False, True),
        ('llm', True, False),
        (None, True, False),
        ('llm', False, True),
    ])
    def test_a_manual_correction_or_an_invalid_answer_keeps_it(self, category_source: str | None, valid: bool,
                                                               expected: bool):
        stored = _stored(category_source=category_source)
        assert keeps_stored_category(stored, _enrichment(category_valid=valid)) is expected


class TestTheReenrichedFields:
    def test_a_moved_category_replaces_every_enriched_field_and_its_indexes(self):
        stored = _stored(gsi2sk='-0.4#2026-01-02T00:00:00Z', processed_at='ignored')
        fields = reenriched_fields(stored, _incoming(NEW, text='edited'), _enrichment(),
                                   ({'product': 'IDE'}, {'product': 'ai'}))

        assert fields == {
            'original_text': 'edited', 'title': 'Title',
            'category': 'performance', 'subcategory': 'latency', 'sentiment_score': -0.9,
            'urgency': 'high', 'sentiment_label': 'negative',
            'llm_metadata': {'model_name': 'haiku'},
            'dimensions': {'product': 'IDE'}, 'dimension_sources': {'product': 'ai'},
            'gsi2sk': '-0.9#2026-01-02T00:00:00Z', 'gsi3pk': 'URGENCY#high',
            'gsi2pk': 'CATEGORY#performance',
            # One word: low (shared/usefulness.py); the aggregator re-buckets the change.
            'usefulness': 'low',
        }

    def test_the_band_is_the_one_the_written_fields_give_never_the_stored_translation(self):
        # The stored item still holds the OLD text's translation and summary; the band reads the new text.
        stored = _stored(normalized_text='Since version 4.2 the app crashes at checkout every single day',
                         problem_summary='Old crash')
        text = 'The checkout keeps spinning forever'
        fields = reenriched_fields(stored, _incoming(NEW, text=text), _enrichment(),
                                   ({'feedback_type': 'praise'}, {'feedback_type': 'ai'}))

        assert fields['usefulness'] == item_usefulness(fields) == 'medium'

    def test_a_kept_category_leaves_category_subcategory_and_its_index_alone(self):
        stored = _stored(category_source='manual', gsi2sk='-0.4#T')
        fields = reenriched_fields(stored, {'issue_attributes': {}}, _enrichment(), ({}, {}))

        assert fields == {
            'original_text': '', 'title': None,
            'sentiment_score': -0.9, 'urgency': 'high', 'sentiment_label': 'negative',
            'llm_metadata': {'model_name': 'haiku'},
            'dimensions': None, 'dimension_sources': None,
            'gsi2sk': '-0.9#T', 'gsi3pk': 'URGENCY#high',
            'usefulness': 'low',
        }

    def test_a_kept_category_tolerates_an_enrichment_without_one(self):
        enrichment = Enrichment(attributes={'sentiment_score': 0.1, 'urgency': 'low'}, llm_result={},
                                category_valid=False)
        fields = reenriched_fields(_stored(gsi2sk='0.5#T'), _incoming(), enrichment, ({}, {}))

        assert fields['llm_metadata'] == {}
        assert 'category' not in fields
        assert 'gsi2pk' not in fields

    @pytest.mark.parametrize(('stored', 'expected'), [
        ({'gsi2sk': '-0.4#2026-01-02T00:00:00Z#x', 'processed_at': 'P'}, '-0.9#2026-01-02T00:00:00Z#x'),
        ({'gsi2sk': 'no-separator', 'processed_at': 'P'}, '-0.9#P'),
        ({'gsi2sk': 42, 'processed_at': 'P'}, '-0.9#P'),
        ({'processed_at': 'P'}, '-0.9#P'),
        ({}, '-0.9#'),
    ])
    def test_the_sentiment_index_keeps_the_original_timestamp_half(self, stored: dict, expected: str):
        fields = reenriched_fields(_stored(**stored), _incoming(), _enrichment(), ({}, {}))
        assert fields['gsi2sk'] == expected


class TestTheReenrichmentUpdate:
    def test_a_moved_category_is_guarded_against_a_concurrent_manual_correction(self):
        stored = _stored(issue_attributes={'updated_at': OLD}, dimensions={'product': 'IDE'}, gsi2sk='-0.4#T')
        enrichment = Enrichment(attributes={'category': 'performance', 'sentiment_score': -0.9, 'urgency': 'high',
                                            'subcategory': None},
                                llm_result={'metadata': {'m': 1}})
        kwargs = reenrichment_update(stored, _incoming(NEW, text='edited'), enrichment, ({}, {}), NOW)

        assert kwargs == {
            'Key': {'pk': 'SOURCE#github_issues', 'sk': 'FEEDBACK#7'},
            'UpdateExpression': ('SET #f1 = :f0, #f2 = :f1, #f3 = :f2, #f4 = :f3, #f5 = :f4, #f6 = :f5, '
                                 '#f7 = :f6, #f9 = :f7, #f12 = :f8, #f13 = :f9, #f14 = :f10, #f15 = :f11 '
                                 'REMOVE #f8, #f10, #f11'),
            'ConditionExpression': ('attribute_exists(#pk) AND #g16 = :g12 AND #g17 = :g13 AND '
                                    '(attribute_not_exists(#category_source) OR #category_source <> :manual)'),
            'ExpressionAttributeNames': {
                '#pk': 'pk', '#f1': 'issue_attributes', '#f2': 'source_refreshed_at', '#f3': 'original_text',
                '#f4': 'title', '#f5': 'category', '#f6': 'sentiment_score', '#f7': 'urgency',
                '#f8': 'subcategory', '#f9': 'llm_metadata', '#f10': 'dimensions', '#f11': 'dimension_sources',
                '#f12': 'gsi2sk', '#f13': 'gsi3pk', '#f14': 'gsi2pk', '#f15': 'usefulness',
                '#g16': 'issue_attributes', '#g17': 'dimensions', '#category_source': 'category_source',
            },
            'ExpressionAttributeValues': {
                ':f0': {'updated_at': NEW}, ':f1': NOW, ':f2': 'edited', ':f3': 'Title', ':f4': 'performance',
                ':f5': -0.9, ':f6': 'high', ':f7': {'m': 1}, ':f8': '-0.9#T', ':f9': 'URGENCY#high',
                ':f10': 'CATEGORY#performance', ':f11': 'low',
                ':g12': {'updated_at': OLD}, ':g13': {'product': 'IDE'},
                ':manual': 'manual',
            },
        }

    def test_a_kept_category_adds_no_manual_guard(self):
        stored = _stored(category_source='manual', gsi2sk='-0.4#T')
        enrichment = Enrichment(attributes={'sentiment_score': -0.9, 'urgency': 'high'}, llm_result={})
        kwargs = reenrichment_update(stored, _incoming(NEW, text='e'), enrichment, ({'a': 'b'}, {'a': 'ai'}), NOW)

        assert kwargs['ConditionExpression'] == \
            'attribute_exists(#pk) AND attribute_not_exists(#g13) AND attribute_not_exists(#g14)'
        assert kwargs['UpdateExpression'] == (
            'SET #f1 = :f0, #f2 = :f1, #f3 = :f2, #f4 = :f3, #f5 = :f4, #f6 = :f5, #f7 = :f6, '
            '#f8 = :f7, #f9 = :f8, #f10 = :f9, #f11 = :f10, #f12 = :f11')
        assert '#category_source' not in kwargs['ExpressionAttributeNames']
        assert ':manual' not in kwargs['ExpressionAttributeValues']
