"""Every attribute a processed feedback item (``voc-feedback``, the Silver tier) may store (TENETS.md D7).

One entry per attribute: its type, what it means, which pipeline step sets it, and whether it holds
personal data. ``shared/feedback_catalogue.py`` assembles the served catalogue
(``GET /feedback/catalogue``) and the table in ``docs/data-catalogue.md`` from these entries;
``shared/test/test_feedback_catalogue.py`` fails when a writer stores an attribute that has no entry.

Enum values are NOT written here: the catalogue reads them from the code that enforces them.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

FieldType = Literal['string', 'number', 'boolean', 'map', 'list']
#: ``customer_text``: the customer's own words (or a translation of them); ``personal``: data about a
#: person (author, contact metadata); ``derived_text``: model-written text that may quote the customer;
#: ``none``: no personal data.
PiiClass = Literal['customer_text', 'personal', 'derived_text', 'none']

#: The pipeline steps that set attributes, in pipeline order (the served catalogue's ``steps``).
STEPS: Final[dict[str, str]] = {
    'producer': 'Copied from the queue message the source sent (plugin, webhook, import, feedback form), after '
                'the source policy (shared/source_policy.py) and the queue schema (shared/ingest_schemas.py)',
    'processor': 'Computed by the feedback processor when it stores the item (lambda/processor/handler.py)',
    'enrichment': 'Comprehend language and sentiment, Translate, and the enrichment model '
                  '(shared/categorization.py run_enrichment)',
    'classification': 'Dimension and tag resolution: message, source profile, category product, then the model '
                      '(shared/feedback_dimensions.py)',
    'provenance': 'How the item was made (shared/silver_provenance.py, TENETS.md D2)',
    'storage_policy': "The source's PII policy applied to the stored item (processor apply_storage_policy)",
    'source_update': 'A newer copy from an update-capable source or a confirmed CSV correction '
                     '(shared/source_updates.py, shared/csv_updates.py)',
    'reprocess': 'A category reprocess job (lambda/jobs/category_reprocess)',
    'edit': 'A person: PUT /feedback/{id}/category|dimensions, PUT /data-explorer/feedback',
}
Step = Literal['producer', 'processor', 'enrichment', 'classification', 'provenance', 'storage_policy',
               'source_update', 'reprocess', 'edit']


@dataclass(frozen=True)
class CatalogueField:
    name: str
    type: FieldType
    steps: tuple[Step, ...]
    meaning: str
    pii: PiiClass = 'none'
    #: On every stored item (the processor always writes it); otherwise present only when it applies.
    always: bool = False
    #: A table or index key: how the item is found, not what it says.
    key: bool = False


def _f(name: str, type_: FieldType, steps: tuple[Step, ...], meaning: str, *, pii: PiiClass = 'none',
       always: bool = False, key: bool = False) -> CatalogueField:
    return CatalogueField(name, type_, steps, meaning, pii, always, key)


_P: Final[tuple[Step, ...]] = ('processor',)
_E: Final[tuple[Step, ...]] = ('enrichment', 'source_update', 'reprocess', 'edit')

FIELDS: Final[tuple[CatalogueField, ...]] = (
    # ── keys and indexes ─────────────────────────────────────────────────────
    _f('pk', 'string', _P, '`SOURCE#{brand_name}`: the partition of the source the item came from (an item of a '
       'workspace: every partition key here starts `WS#{ws}#`, docs/multi-workspace.md)', always=True, key=True),
    _f('sk', 'string', _P, '`FEEDBACK#{feedback_id}`', always=True, key=True),
    _f('gsi1pk', 'string', _P, '`DATE#{YYYY-MM-DD}` of processing (index gsi1-by-date)', always=True, key=True),
    _f('gsi1sk', 'string', _P, '`{processed_at}#{feedback_id}` (gsi1-by-date, gsi5-by-channel)', always=True, key=True),
    _f('gsi2pk', 'string', ('processor', 'source_update', 'reprocess', 'edit'),
       '`CATEGORY#{category}` (index gsi2-by-category)', always=True, key=True),
    _f('gsi2sk', 'string', ('processor', 'source_update'), '`{sentiment_score}#{processed_at}`', always=True, key=True),
    _f('gsi3pk', 'string', ('processor', 'source_update'), '`URGENCY#{urgency}` (index gsi3-by-urgency)',
       always=True, key=True),
    _f('gsi3sk', 'string', _P, '`processed_at` (gsi3-by-urgency)', always=True, key=True),
    _f('gsi4pk', 'string', _P, '`FEEDBACK#{feedback_id}` (index gsi4-by-feedback-id)', always=True, key=True),
    _f('gsi5pk', 'string', ('processor', 'source_update'), '`CHANNEL#{source_channel}` (index gsi5-by-channel); `CHANNEL#unknown` when the channel is empty',
       key=True),
    # ── identity and source ──────────────────────────────────────────────────
    _f('feedback_id', 'string', _P, 'The item id: the same source item has the same id in every workspace, so '
       'gsi4-by-feedback-id is keyed on `gsi4pk`', always=True),
    _f('source_id', 'string', ('producer',), "The id the source gave the item (its own review / issue id)", always=True),
    _f('source_platform', 'string', ('producer',), 'The source (plugin id or import path) that sent the item',
       always=True),
    _f('source_channel', 'string', ('producer', 'source_update'),
       "The source's channel (e.g. `review`, `issue`, `form`); `unknown` when the source sends none "
       '(index gsi5-by-channel, through `gsi5pk`)', always=True),
    _f('brand_name', 'string', _P, 'The label the item is filed under: the message `brand_name`, else the source',
       always=True),
    _f('ingestion_method', 'string', ('producer',), 'How the item entered: `manual`, `csv_upload`, `json_upload`, …'),
    _f('source_url', 'string', ('producer', 'source_update', 'edit'),
       'Link to the item at its source (http/https; redacted under a `redact` policy)', pii='personal'),
    _f('source_created_at', 'string', ('producer', 'source_update'), 'When the customer wrote it (ISO 8601, the source clock)'),
    _f('ingested_at', 'string', ('producer',), 'When the producer fetched it (ISO 8601)'),
    _f('processed_at', 'string', _P, 'When the processor stored it (ISO 8601 UTC)', always=True),
    _f('date', 'string', _P, '`YYYY-MM-DD` of processing: the day the metrics count it under', always=True),
    _f('s3_raw_uri', 'string', ('producer', 'processor'),
       'The immutable raw copy (`s3://…/raw/{source}/…`); absent when the source policy archives nothing'),
    _f('csv_row_id', 'string', ('producer', 'source_update'), "A CSV row's own id, unique only within its file"),
    _f('csv_dataset', 'string', ('producer', 'source_update'), 'The named CSV dataset the row belongs to (docs/csv-import.md)'),
    _f('csv_content_hash', 'string', ('producer', 'source_update'), "Digest of a dataset row's content, compared by the next upload"),
    _f('issue_attributes', 'map', ('producer', 'source_update'),
       'Issue-tracker fields (version, labels, state, reactions, …) of an update-capable source; '
       'sub-fields listed under `sub_fields`'),
    _f('source_refreshed_at', 'string', ('source_update',), 'When a newer copy from the source last refreshed it'),
    # ── the customer's words ─────────────────────────────────────────────────
    _f('original_text', 'string', ('producer', 'storage_policy', 'source_update', 'edit'),
       "The customer's text as received (after the source policy); under `summary_only` the model's summary "
       'or `[withheld]`', pii='customer_text', always=True),
    _f('title', 'string', ('producer', 'source_update'), 'Title of the review / issue', pii='customer_text'),
    _f('author', 'string', ('producer',), "The author's name or handle (dropped under `redact`)", pii='personal'),
    _f('metadata', 'map', ('producer',),
       'Source-specific extra fields (e.g. app version, form custom fields; `email` lower-cased)', pii='personal'),
    _f('rating', 'number', ('producer', 'source_update', 'edit'), 'Star rating, 1 to 5 when the source has one'),
    # ── enrichment ───────────────────────────────────────────────────────────
    _f('original_language', 'string', ('enrichment', 'source_update', 'reprocess'),
       'Language of `original_text` (Comprehend, ISO 639-1)', always=True),
    _f('normalized_text', 'string', _E,
       'The text translated into the primary language; absent when it is already in it', pii='customer_text'),
    _f('category', 'string', _E, 'Configured category (GET /settings/categories); `other` when the model picks none',
       always=True),
    _f('subcategory', 'string', _E, 'Configured subcategory of `category`'),
    _f('sentiment_label', 'string', _E, 'Overall sentiment', always=True),
    _f('sentiment_score', 'number', _E, 'Sentiment from -1 (negative) to 1 (positive), 3 decimals', always=True),
    _f('urgency', 'string', _E, 'How soon it needs attention', always=True),
    _f('impact_area', 'string', _E, 'The part of the business it affects', always=True),
    _f('journey_stage', 'string', _E, 'Customer-journey stage it was written in', always=True),
    _f('problem_summary', 'string', _E, "The model's one-line summary of the problem", pii='derived_text'),
    _f('problem_root_cause_hypothesis', 'string', _E, "The model's guess at the cause", pii='derived_text'),
    _f('direct_customer_quote', 'string', ('enrichment', 'source_update', 'reprocess'),
       'The most telling sentence, quoted verbatim', pii='customer_text'),
    _f('persona_name', 'string', _E, 'Inferred customer archetype name', pii='derived_text'),
    _f('persona_type', 'string', _E, 'Inferred relationship to the brand'),
    _f('persona_attributes', 'map', ('enrichment', 'source_update', 'reprocess'),
       '`{inferred_segment, confidence}` of the persona'),
    _f('usefulness', 'string', ('processor', 'source_update'),
       'Heuristic usefulness band (docs/data-quality.md); absent = unrated'),
    # ── classification ───────────────────────────────────────────────────────
    _f('dimensions', 'map', ('classification', 'source_update', 'reprocess', 'edit'),
       '`{key: value}` over the configured dimensions (GET /settings/dimensions) and the built-in `feedback_type`'),
    _f('dimension_sources', 'map', ('classification', 'source_update', 'reprocess', 'edit'),
       '`{key: where the value came from}`'),
    _f('tags', 'list', ('classification', 'edit'), 'Free tags from the message, the source profile or a person'),
    _f('category_source', 'string', ('reprocess', 'edit'),
       'Who last set the category: `manual` (a person; never moved by a job) or `reprocess`; absent = the model'),
    _f('category_override', 'map', ('edit',),
       'Audit of the last manual category change `{previous_category, previous_subcategory, by_sub, by_username, at}`',
       pii='personal'),
    _f('category_reprocessed_at', 'string', ('reprocess',), 'When a reprocess job last re-categorised it'),
    _f('dimensions_reprocessed_at', 'string', ('reprocess',), 'When a dimensions reprocess job last re-ran it'),
    # ── provenance and policy ────────────────────────────────────────────────
    _f('pipeline_version', 'string', ('provenance',), 'App release that enriched it (`unknown` when unset)',
       always=True),
    _f('enrichment_mode', 'string', ('provenance',), 'How the enriched fields were made', always=True),
    _f('enriched_at', 'string', ('provenance',), 'When the enriched fields were made (ISO 8601 UTC)', always=True),
    _f('llm_metadata', 'map', ('provenance',),
       '`{model_name, requested_model, prompt_version, latency_ms, error?}`: `model_name` answered, '
       '`requested_model` was asked (they differ after a capacity fallback)', always=True),
    _f('pii_policy', 'string', ('storage_policy', 'source_update'),
       'The PII policy the item was stored under; absent = `allow`'),
    _f('updated_by', 'map', ('source_update', 'edit'), '`{sub, kind}` of the last in-place change (`system` for a source)',
       pii='personal'),
    _f('updated_at', 'string', ('source_update', 'edit'), 'When the item last changed in place (ISO 8601 UTC)'),
    _f('change_reason', 'string', ('source_update', 'reprocess', 'edit'), 'Why it last changed in place'),
)
