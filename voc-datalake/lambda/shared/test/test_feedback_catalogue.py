"""The feedback-item catalogue covers every attribute the pipeline stores (TENETS.md D7).

The writers are RUN, not read: the processor builds a fully enriched item, and each in-place writer
(source update, CSV correction, category reprocess, a person's category / dimensions / field edit)
builds its update. Every attribute name they produce must have a catalogue entry, so adding a stored
attribute without describing it fails here. The doc table and the policy effects are pinned too.
"""
from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from typing import Any, get_args
from unittest.mock import patch

import pytest

from jobs.category_reprocess import handler as reprocess
from processor import handler as processor
from shared import feedback_catalogue as cat
from shared.categorization import USER_PROMPT_TEMPLATE, Enrichment
from shared.csv_updates import csv_update
from shared.feedback_catalogue_fields import FIELDS, STEPS, Step
from shared.feedback_category import ManualEdit, category_change, manual_edit_fields
from shared.feedback_field_edits import EDITABLE_FIELDS
from shared.feedback_types import feedback_type_dimension
from shared.silver_provenance import REASON_DIMENSIONS_EDIT, SYSTEM_ACTOR
from shared.source_policy import apply_source_policy
from shared.source_updates import attributes_update, reenriched_fields

CATALOGUED = {field.name for field in FIELDS}
NOW = '2026-03-01T12:00:00+00:00'

INSIGHTS = {
    'category': 'delivery', 'subcategory': 'late', 'journey_stage': 'delivery', 'sentiment_label': 'negative',
    'sentiment_score': -0.6, 'urgency': 'high', 'impact_area': 'operations', 'problem_summary': 'Late parcel',
    'problem_root_cause_hypothesis': 'Courier backlog', 'direct_customer_quote': 'Two weeks late.',
    'persona': {'name': 'Frequent flyer', 'type': 'existing_customer',
                'attributes': {'inferred_segment': 'business', 'confidence': 'medium'}},
    'dimensions': {'feedback_type': 'service_failure'},
}
CATEGORIES = [{'id': 'delivery', 'name': 'delivery', 'subcategories': [{'id': 'late', 'name': 'late'}]}]
FULL_MESSAGE: dict[str, Any] = {
    'id': 'review-1', 'source_platform': 'csv_upload', 'brand_name': 'Example Air', 'text': 'Mon colis a deux semaines',
    'title': 'Late', 'url': 'https://example.com/r/1', 'created_at': '2026-02-01T00:00:00Z',
    'ingested_at': '2026-02-02T00:00:00Z', 'rating': 2, 'source_channel': 'review', 'ingestion_method': 'csv_upload',
    'author': 'A. Traveller', 'metadata': {'email': 'a@example.com'}, 'tags': ['vip'],
    'dimensions': {'feedback_type': 'service_failure'}, 's3_raw_uri': 's3://raw/raw/csv_upload/x.json',
    'csv_row_id': 'r1', 'csv_dataset': 'example-air', 'csv_content_hash': 'abc',
    'issue_attributes': {'kind': 'issue', 'repo': 'example/air', 'number': 1, 'updated_at': NOW},
}


@pytest.fixture
def built_item() -> Iterator[dict]:
    llm = {'insights': INSIGHTS, 'metadata': {'model_name': 'haiku', 'requested_model': 'haiku',
                                               'prompt_version': 'v1', 'latency_ms': 10}}
    with patch.object(processor, 'get_categories_config', return_value=CATEGORIES), \
            patch.object(processor, 'get_dimensions_config', return_value=[feedback_type_dimension()]), \
            patch.object(processor, 'source_profile', return_value={'tags': ['profile-tag']}), \
            patch.object(processor, 'pii_policy_for', return_value='redact'), \
            patch.object(processor, 'detect_language', return_value='fr'), \
            patch.object(processor, 'translate_text', return_value='My parcel is two weeks late'), \
            patch.object(processor, 'get_comprehend_sentiment', return_value={'label': 'negative', 'score': -0.6}), \
            patch.object(processor, 'invoke_bedrock_llm', return_value=llm):
        yield processor.build_feedback_item(dict(FULL_MESSAGE), 'fb-1', processor.datetime.fromisoformat(NOW))


def _names(update: dict) -> set[str]:
    return set(update['ExpressionAttributeNames'].values())


def _enrichment() -> Enrichment:
    return Enrichment(attributes={'category': 'delivery', 'subcategory': None, 'sentiment_score': Decimal('-0.6'),
                                  'urgency': 'high', 'normalized_text': None}, llm_result={'metadata': {}})


def test_the_processor_stores_only_catalogued_attributes(built_item: dict) -> None:
    assert set(built_item) - CATALOGUED == set()
    # The fixture really is fully enriched: these would be absent from a thin item.
    assert {'normalized_text', 'persona_attributes', 'llm_metadata', 'pii_policy', 'dimensions', 'tags'} <= set(built_item)


def test_every_always_present_attribute_is_on_a_built_item(built_item: dict) -> None:
    assert {field.name for field in FIELDS if field.always} - set(built_item) == set()


def test_every_in_place_writer_stores_only_catalogued_attributes() -> None:
    stored = {'pk': 'SOURCE#x', 'sk': 'FEEDBACK#1', 'category': 'delivery', 'processed_at': NOW,
              'gsi2sk': f'-0.6#{NOW}', 'issue_attributes': {'updated_at': NOW}, 'dimensions': {}}
    raw = {**FULL_MESSAGE, 'csv_replace': True}
    change = category_change(stored, 'delivery', 'late', {'at': NOW})
    written = (
        _names(attributes_update(stored, raw, NOW))
        | set(reenriched_fields(stored, raw, _enrichment(), ({'k': 'v'}, {'k': 'ai'})))
        | _names(csv_update(stored, raw, 'redact', NOW))
        | _names(reprocess.build_update(stored, {'category': 'delivery'}, False, NOW))
        | _names(reprocess.build_dimensions_update(stored, {'k': 'v'}, {'k': 'ai'}, NOW, band='high'))
        | set(change.names.values())
        | set(manual_edit_fields(ManualEdit(SYSTEM_ACTOR, REASON_DIMENSIONS_EDIT), NOW))
        | set(EDITABLE_FIELDS)
    )
    assert written - CATALOGUED == set()


def test_names_are_unique_and_steps_are_declared() -> None:
    assert len(CATALOGUED) == len(FIELDS)
    assert set(STEPS) == set(get_args(Step))
    assert {step for field in FIELDS for step in field.steps} <= set(STEPS)


def test_the_redact_effects_match_the_source_policy() -> None:
    message = {'text': 'Call me at a@example.com', 'title': 'From a@example.com', 'url': 'https://x.test/?e=a@example.com',
               'author': 'A. Traveller', 'metadata': {'note': 'a@example.com'}, 's3_raw_uri': 's3://raw/x'}
    out = apply_source_policy(message, {'pii': 'redact'})
    assert out is not None
    dropped = {'author', 's3_raw_uri'}
    assert dropped.isdisjoint(out)
    redacted = {name for name in ('text', 'title', 'url', 'metadata') if out[name] != message[name]}
    assert redacted == {'text', 'title', 'url', 'metadata'}
    effects = {e['name']: e['under_redact'] for e in cat.catalogue()['fields']}
    assert {name for name, effect in effects.items() if effect == 'dropped'} == dropped
    assert {name for name, effect in effects.items() if effect == 'redacted'} == {
        'original_text', 'title', 'source_url', 'metadata'}


def test_summary_only_drops_what_the_storage_policy_drops(built_item: dict) -> None:
    stored = processor.apply_storage_policy(built_item, 'summary_only')
    effects = {e['name']: e['under_summary_only'] for e in cat.catalogue()['fields']}
    assert {name for name, effect in effects.items() if effect == 'dropped'} == {
        name for name in built_item if name not in stored} | {'s3_raw_uri'}
    assert stored['original_text'] == built_item['problem_summary']
    assert effects['original_text'] == 'replaced'


def test_enum_values_come_from_the_code_that_enforces_them() -> None:
    values = {e['name']: e.get('values') for e in cat.catalogue()['fields']}
    assert values['urgency'] == ['high', 'low', 'medium']
    assert values['usefulness'] == ['low', 'medium', 'high']
    assert values['category_source'] == ['manual', reprocess.CATEGORY_SOURCE_REPROCESS]
    assert 'source_update' in values['enrichment_mode']
    for name in ('journey_stage', 'impact_area', 'persona_type', 'sentiment_label', 'urgency'):
        # Every value the catalogue allows is one the prompt asks for (the prompt may also allow `null`).
        assert set(values[name]) <= set(_prompt_values(name)), name


def _prompt_values(field: str) -> list[str]:
    """The ``a|b|c`` list the enrichment prompt asks the model for (``persona.type`` for persona_type)."""
    key = '"type":"' if field == 'persona_type' else f'"{field}":"'
    return USER_PROMPT_TEMPLATE.split(key, 1)[1].split('"', 1)[0].split('|')


def test_the_catalogue_names_the_builtin_dimension_and_issue_sub_fields() -> None:
    fields = {e['name']: e for e in cat.catalogue()['fields']}
    assert 'service_failure' in fields['dimensions']['builtin_dimensions']['feedback_type']
    assert {'repo', 'labels', 'updated_at'} <= {f['name'] for f in fields['issue_attributes']['sub_fields']}


def test_the_doc_holds_the_generated_table() -> None:
    section = cat.doc_section(cat.DOC_PATH.read_text(encoding='utf-8'))
    assert section == cat.render_markdown(), (
        'docs/data-catalogue.md is stale: cd voc-datalake/lambda && ../.venv/bin/python -m shared.feedback_catalogue')
