"""The plain fields an admin may edit on a stored review (``PUT /data-explorer/feedback``), validated.

The Data Explorer editor sends the whole record back, so only the fields whose value differs
from the stored one are a change: an unchanged field is neither validated nor written (a legacy
value outside today's enums does not block an edit of another field).

Each changed field is validated (type, bound, enum: the values the enrichment prompt allows,
``shared/categorization.py``), then put through the source's PII policy, so an edit can never
store what ingestion would have refused (TENETS.md D2; ``shared/source_policy.py``):

- the policy is the stricter of the item's stored ``pii_policy`` and its source profile's
  current one; an unreadable profile FAILS CLOSED (503, ``SourceProfilesUnavailable``);
- ``redact``: every free-text field goes through ``shared.pii_redaction.redact_text``;
- ``summary_only``: the item stores no customer words, so an edit of ``original_text`` /
  ``normalized_text`` is refused (400); the other text fields are redacted.

A ``None`` (or ``''``) for an optional field removes it (the processor never stores nulls). A
number may arrive as a JSON number or a numeric string (the editor's inputs) and is stored as a
Decimal.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Final

from shared.exceptions import ValidationError
from shared.ingest_schemas import MAX_RATING, MAX_TEXT_LENGTH
from shared.pii_redaction import redact_text
from shared.source_profiles import PII_ALLOW, PII_POLICIES, PII_SUMMARY_ONLY, cached_source_profile_strict

__all__ = ['EDITABLE_FIELDS', 'FieldEdits', 'field_edits']

#: Bound on the derived free-text fields (summary, hypothesis): the model keeps them under 500.
MAX_DERIVED_TEXT: Final = 2000
MAX_PERSONA_NAME: Final = 200

_ENUMS: Final[dict[str, frozenset[str]]] = {
    'sentiment_label': frozenset({'positive', 'neutral', 'negative', 'mixed'}),
    'urgency': frozenset({'low', 'medium', 'high'}),
    'impact_area': frozenset({'product', 'operations', 'cx', 'tech', 'pricing', 'brand', 'legal', 'other'}),
    'journey_stage': frozenset({
        'awareness', 'consideration', 'purchase', 'delivery', 'usage', 'support', 'retention', 'advocacy',
        'unknown'}),
    'persona_type': frozenset({'existing_customer', 'prospect', 'churn_risk', 'advocate', 'unknown'}),
}
#: Free-text fields and their bound; each goes through the PII policy.
_TEXTS: Final[dict[str, int]] = {
    'original_text': MAX_TEXT_LENGTH,
    'normalized_text': MAX_TEXT_LENGTH,
    'problem_summary': MAX_DERIVED_TEXT,
    'problem_root_cause_hypothesis': MAX_DERIVED_TEXT,
    'persona_name': MAX_PERSONA_NAME,
}
#: ``(low, high)`` of each numeric field; the rating's are the queue schema's (``IngestMessage.rating``).
_NUMBERS: Final[dict[str, tuple[int, int]]] = {'sentiment_score': (-1, 1), 'rating': (1, MAX_RATING)}
#: Fields every enriched review has: never removed by an edit.
_REQUIRED: Final = frozenset({
    'original_text', 'sentiment_label', 'sentiment_score', 'urgency', 'impact_area', 'journey_stage'})
#: The customer's own words: a summary-only source stores none of them.
_CUSTOMER_WORDS: Final = frozenset({'original_text', 'normalized_text'})

EDITABLE_FIELDS: Final = (*_TEXTS, *_ENUMS, *_NUMBERS)


@dataclass
class FieldEdits:
    """The validated, policy-applied edit: fields to SET and fields to REMOVE."""

    sets: dict[str, Any] = field(default_factory=dict)
    removes: list[str] = field(default_factory=list)
    pii_policy: str = PII_ALLOW

    @property
    def changed(self) -> list[str]:
        return sorted([*self.sets, *self.removes])


def _number(name: str, value: object) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, int | float | Decimal | str):
        raise ValidationError(f'{name} must be a number')
    try:
        number = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValidationError(f'{name} must be a number') from exc
    low, high = _NUMBERS[name]
    if not number.is_finite() or not low <= number <= high:
        raise ValidationError(f'{name} must be between {low} and {high}')
    return number


def _valid(name: str, value: object) -> object:
    """``value`` checked for field ``name`` (a Decimal for a number); 400 otherwise."""
    if name in _NUMBERS:
        return _number(name, value)
    if name in _ENUMS:
        if value not in _ENUMS[name]:
            raise ValidationError(f"{name} must be one of: {', '.join(sorted(_ENUMS[name]))}")
        return value
    limit = _TEXTS[name]
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValidationError(f'{name} must be a non-empty string of at most {limit} characters')
    return value


def _same(stored: object, value: object) -> bool:
    """Whether ``value`` is the stored value (a stored Decimal equals the same number sent as JSON or text)."""
    if isinstance(stored, Decimal) and isinstance(value, int | float | str) and not isinstance(value, bool):
        try:
            return stored == Decimal(str(value))
        except InvalidOperation:
            return False
    return stored == value


def _policy(item: Mapping[str, Any]) -> str:
    """The stricter of the item's stored policy and its source's current one (fails closed)."""
    source = str(item.get('source_platform') or '')
    current = cached_source_profile_strict(source).get('pii')
    stored = item.get('pii_policy')
    ranks = [PII_POLICIES.index(p) for p in (current, stored) if isinstance(p, str) and p in PII_POLICIES]
    return PII_POLICIES[max(ranks, default=0)]


def _apply_policy(edits: FieldEdits, language: str | None) -> None:
    if edits.pii_policy == PII_ALLOW:
        return
    # Setting customer text is refused; removing it (it should not be stored for this source) is allowed.
    if edits.pii_policy == PII_SUMMARY_ONLY and _CUSTOMER_WORDS & set(edits.sets):
        raise ValidationError("This source keeps no customer text: original_text and normalized_text can't be set")
    for name in [n for n in edits.sets if n in _TEXTS]:
        edits.sets[name] = redact_text(edits.sets[name], language).text[:_TEXTS[name]]


def field_edits(item: Mapping[str, Any], data: Mapping[str, Any]) -> FieldEdits:
    """The changed editable fields of ``data`` against the stored ``item``, validated and policy-applied."""
    edits = FieldEdits()
    for name in EDITABLE_FIELDS:
        if name not in data or _same(item.get(name), data[name]):
            continue
        value = data[name]
        if value is None or value == '':
            if name in _REQUIRED:
                raise ValidationError(f'{name} is required')
            if name in item:
                edits.removes.append(name)
            continue
        edits.sets[name] = _valid(name, value)
    if edits.sets or edits.removes:
        edits.pii_policy = _policy(item)
        language = item.get('original_language')
        _apply_policy(edits, language if isinstance(language, str) else None)
    return edits
