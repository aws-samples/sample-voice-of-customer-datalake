"""
In-place refresh of an issue-tracker item that is already stored (github_issues).

An issue is a living record: labels, state, milestone, reactions and even its text
change after the first ingest, and the plugin re-sends it whenever GitHub's
``updated_at`` moves (the poller lists by ``since=``, the webhook pushes
``labeled`` / ``closed`` / ``edited`` …). Every other source sends an item once,
so "already stored" means "duplicate" for them and only for them.

A record is UPDATE-CAPABLE only when it comes from the github_issues plugin
(``source_platform == GITHUB_SOURCE``, the plugin's manifest id) AND carries
``issue_attributes``. ``issue_attributes`` alone is not enough: any other producer
(manual import, a feedback form, another plugin) that happens to send the key is
a normal new item / duplicate skip, never an in-place overwrite. For those:

* ``update_decision`` orders the incoming copy against the stored one by
  ``issue_attributes.updated_at``: older is ``stale`` (out-of-order delivery), the
  same stamp with the same content is ``unchanged``, a newer stamp — or the same
  stamp with different content, or no stored stamp with different content — is
  ``apply``. An incoming copy with no stamp cannot be ordered and changes nothing.
* ``attributes_update`` refreshes ``issue_attributes`` alone; ``reenrichment_update``
  also replaces the text and the enriched fields when the text changed. Both are
  conditional ``update_item`` kwargs: the item must exist and its
  ``issue_attributes`` must still be what was read (a concurrent refresh makes the
  second one fail and retry), so nothing is ever created or deleted here.
* A person's corrections win: a ``category_source == 'manual'`` category (and its
  subcategory and by-category index) is never moved, and dimensions go through
  ``reinfer_dimensions``, which keeps every manual / source / profile value.
  ``tags`` are never touched (a person may have edited them).

The keys and the date index stay: ``pk``/``sk``, ``gsi1*`` and ``date`` are the
item's first ingest, so the aggregator re-buckets a MODIFY on the same day. Only
``gsi2pk`` (category), ``gsi2sk``'s sentiment half and ``gsi3pk`` (urgency) follow
a re-enrichment.
"""
import hashlib
import json
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from shared.categorization import Enrichment
from shared.github_metrics import GITHUB_SOURCE
from shared.source_profiles import PII_SUMMARY_ONLY

UPDATE_APPLY = 'apply'
UPDATE_STALE = 'stale'
UPDATE_UNCHANGED = 'unchanged'

CATEGORY_SOURCE_MANUAL = 'manual'
#: Hex characters of the content fingerprint appended to an update-capable
#: record's idempotency key (Powertools hashes the whole key again before storing it).
FINGERPRINT_LENGTH = 16
ISSUE_ATTRIBUTES = 'issue_attributes'


#: The only source whose records are refreshed in place (plugins/github_issues/manifest.json ``id``).
UPDATE_CAPABLE_SOURCE = GITHUB_SOURCE


def is_update_capable(raw_record: Mapping[str, Any]) -> bool:
    """True for a record a source may legitimately send again with newer content: a GitHub issue."""
    return (raw_record.get('source_platform') == UPDATE_CAPABLE_SOURCE
            and isinstance(raw_record.get(ISSUE_ATTRIBUTES), Mapping))


def content_fingerprint(raw_record: Mapping[str, Any]) -> str:
    """A stable digest of what an update can change: the attributes and the text."""
    payload = json.dumps(
        {'attributes': raw_record.get(ISSUE_ATTRIBUTES), 'text': raw_record.get('text', '')},
        sort_keys=True, default=str,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:FINGERPRINT_LENGTH]


def idempotency_key_for(raw_record: Mapping[str, Any]) -> str:
    """``<source>:<id>``, plus the content fingerprint for update-capable records.

    So an identical resend of an issue is still answered by the idempotency store,
    while a genuinely changed copy of it gets a key of its own and is processed.
    """
    base = f"{raw_record.get('source_platform', 'unknown')}:{raw_record.get('id', 'unknown')}"
    return f"{base}:{content_fingerprint(raw_record)}" if is_update_capable(raw_record) else base


def _stamp(attributes: object) -> datetime | None:
    value = attributes.get('updated_at') if isinstance(attributes, Mapping) else None
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def text_changed(stored: Mapping[str, Any], raw_record: Mapping[str, Any], pii_policy: str) -> bool:
    """Whether the incoming text differs from the stored ``original_text``.

    A summary-only source stores no text to compare with (``original_text`` is the
    model's summary), so its items are never re-enriched by an update.
    """
    if PII_SUMMARY_ONLY in (pii_policy, stored.get('pii_policy')):
        return False
    return stored.get('original_text') != raw_record.get('text', '')


def _content_differs(stored: Mapping[str, Any], raw_record: Mapping[str, Any], pii_policy: str) -> bool:
    # DynamoDB hands numbers back as Decimal; Decimal(3) == 3, so plain equality holds.
    return stored.get(ISSUE_ATTRIBUTES) != raw_record.get(ISSUE_ATTRIBUTES) \
        or text_changed(stored, raw_record, pii_policy)


def update_decision(stored: Mapping[str, Any], raw_record: Mapping[str, Any], pii_policy: str) -> str:
    """``apply`` / ``stale`` / ``unchanged`` for an incoming copy of a stored item."""
    incoming = _stamp(raw_record.get(ISSUE_ATTRIBUTES))
    if incoming is None:
        return UPDATE_UNCHANGED
    current = _stamp(stored.get(ISSUE_ATTRIBUTES))
    if current is not None and incoming < current:
        return UPDATE_STALE
    if current is not None and incoming > current:
        return UPDATE_APPLY
    return UPDATE_APPLY if _content_differs(stored, raw_record, pii_policy) else UPDATE_UNCHANGED


# ============================================
# update_item kwargs
# ============================================

class _Update:
    """Accumulates one ``update_item`` call's expression, names, values and conditions."""

    def __init__(self, stored: Mapping[str, Any]):
        self.key = {'pk': stored['pk'], 'sk': stored['sk']}
        self.names: dict[str, str] = {'#pk': 'pk'}
        self.values: dict[str, Any] = {}
        self.sets: list[str] = []
        self.removes: list[str] = []
        self.conditions: list[str] = ['attribute_exists(#pk)']

    def assign(self, fields: Mapping[str, Any]) -> None:
        """SET each field; a None value REMOVEs it (the processor never stores nulls)."""
        for field, value in fields.items():
            alias = f'#f{len(self.names)}'
            self.names[alias] = field
            if value is None:
                self.removes.append(alias)
                continue
            placeholder = f':f{len(self.values)}'
            self.values[placeholder] = value
            self.sets.append(f'{alias} = {placeholder}')

    def require_unchanged(self, stored: Mapping[str, Any], field: str) -> None:
        """The update only lands if ``field`` is still what was read (absent stays absent)."""
        alias = f'#g{len(self.names)}'
        self.names[alias] = field
        if field not in stored:
            self.conditions.append(f'attribute_not_exists({alias})')
            return
        placeholder = f':g{len(self.values)}'
        self.values[placeholder] = stored[field]
        self.conditions.append(f'{alias} = {placeholder}')

    def require_not_manual_category(self) -> None:
        self.names['#category_source'] = 'category_source'
        self.values[':manual'] = CATEGORY_SOURCE_MANUAL
        self.conditions.append('(attribute_not_exists(#category_source) OR #category_source <> :manual)')

    def kwargs(self) -> dict:
        expression = 'SET ' + ', '.join(self.sets)
        if self.removes:
            expression = f"{expression} REMOVE {', '.join(self.removes)}"
        return {
            'Key': self.key,
            'UpdateExpression': expression,
            'ConditionExpression': ' AND '.join(self.conditions),
            'ExpressionAttributeNames': self.names,
            'ExpressionAttributeValues': self.values,
        }


def attributes_update(stored: Mapping[str, Any], raw_record: Mapping[str, Any], now_iso: str) -> dict:
    """Refresh ``issue_attributes`` only (labels, state, milestone, reactions, …)."""
    update = _Update(stored)
    update.assign({ISSUE_ATTRIBUTES: raw_record[ISSUE_ATTRIBUTES], 'source_refreshed_at': now_iso})
    update.require_unchanged(stored, ISSUE_ATTRIBUTES)
    return update.kwargs()


def keeps_stored_category(stored: Mapping[str, Any], enrichment: Enrichment) -> bool:
    """A person's correction, or a model answer outside the configured categories, keeps the stored one."""
    return stored.get('category_source') == CATEGORY_SOURCE_MANUAL or not enrichment.category_valid


def _sentiment_index_key(stored: Mapping[str, Any], score: object) -> str:
    """``gsi2sk`` with the new score and the item's original timestamp half."""
    previous = stored.get('gsi2sk')
    if isinstance(previous, str) and '#' in previous:
        return f"{score}#{previous.partition('#')[2]}"
    return f"{score}#{stored.get('processed_at', '')}"


def reenriched_fields(
    stored: Mapping[str, Any], raw_record: Mapping[str, Any], enrichment: Enrichment,
    dimensions: tuple[dict, dict],
) -> dict:
    """The stored fields a re-enrichment replaces (None = REMOVE)."""
    enriched = dict(enrichment.attributes)
    keep_category = keeps_stored_category(stored, enrichment)
    if keep_category:
        enriched.pop('category', None)
        enriched.pop('subcategory', None)
    resolved, sources = dimensions
    fields = {
        'original_text': raw_record.get('text', ''),
        'title': raw_record.get('title'),
        **enriched,
        'llm_metadata': enrichment.llm_result.get('metadata', {}),
        'dimensions': resolved or None,
        'dimension_sources': sources or None,
        'gsi2sk': _sentiment_index_key(stored, enriched['sentiment_score']),
        'gsi3pk': f"URGENCY#{enriched['urgency']}",
    }
    if not keep_category:
        fields['gsi2pk'] = f"CATEGORY#{enriched['category']}"
    return fields


def reenrichment_update(
    stored: Mapping[str, Any], raw_record: Mapping[str, Any], enrichment: Enrichment,
    dimensions: tuple[dict, dict], now_iso: str,
) -> dict:
    """Refresh ``issue_attributes``, the text and the enriched fields after a text edit.

    Besides the attributes guard, the update is conditional on the dimensions being
    what was read and — when the category is being moved — on nobody having
    corrected it by hand meanwhile: a correction landing mid-flight fails this
    update, the record is retried, and the retry keeps the correction.
    """
    update = _Update(stored)
    update.assign({
        ISSUE_ATTRIBUTES: raw_record[ISSUE_ATTRIBUTES],
        'source_refreshed_at': now_iso,
        **reenriched_fields(stored, raw_record, enrichment, dimensions),
    })
    update.require_unchanged(stored, ISSUE_ATTRIBUTES)
    update.require_unchanged(stored, 'dimensions')
    if not keeps_stored_category(stored, enrichment):
        update.require_not_manual_category()
    return update.kwargs()
