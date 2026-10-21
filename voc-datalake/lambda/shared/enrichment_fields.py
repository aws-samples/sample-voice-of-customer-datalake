"""Registry of LLM-derived enrichment fields that are filterable facets.

One declaration per field drives every place that field appears:

- the processor's enrichment prompt (the JSON key + its rating guide),
- validation of the model's answer before it is stored,
- the feedback-list / metrics filters (`?<name>=<value>` query params),
- the Data Quality statistics and the async calculate / recalculate jobs.

Adding a field is therefore: one `EnrichmentField(...)` entry below, the matching
entry in `frontend/src/api/enrichmentFields.ts` (pinned by
`shared/test/test_enrichment_fields.py`), and its labels in the locale files.

These are TOP-LEVEL item attributes produced only by the processor (or by the
data-quality worker, from the same prompt guide). They are never ingest input:
`IngestMessage` forbids extra keys, and custom import columns live in the
separate `custom_fields` map.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

# Filter value meaning "the item has no value for this field" — rows enriched
# before the field existed, or whose enrichment call failed. A real enum value
# can never collide with it because every registry value is validated against
# its declared tuple.
UNSCORED = 'unscored'


@dataclass(frozen=True)
class EnrichmentField:
    """One categorical, LLM-derived attribute stored on a feedback item."""

    name: str
    """DynamoDB attribute name, JSON key in the prompt, and filter query param."""

    values: tuple[str, ...]
    """Allowed values, in display order (most to least favourable)."""

    description: str
    """What the field measures, used to phrase the single-field prompt."""

    guide: str
    """Rating guide shown to the model. Plain text, no braces (prompt is .format()ed)."""


USEFULNESS = EnrichmentField(
    name='usefulness',
    values=('high', 'medium', 'low'),
    description='how useful this feedback is for identifying specific bugs, problems or feature opportunities',
    guide=(
        '- "high": clearly describes a specific problem, bug or feature request that a team could act on\n'
        '- "medium": contains some useful signal that hints at a need, problem or preference\n'
        '- "low": almost no actionable content (a single word, random characters, '
        'or generic praise/complaint with no detail)'
    ),
)

ENRICHMENT_FIELDS: tuple[EnrichmentField, ...] = (USEFULNESS,)

_BY_NAME = {f.name: f for f in ENRICHMENT_FIELDS}


def get_field(name: str) -> EnrichmentField | None:
    """The registered field called `name`, or None."""
    return _BY_NAME.get(name)


def field_names() -> tuple[str, ...]:
    return tuple(f.name for f in ENRICHMENT_FIELDS)


def normalize_value(field: EnrichmentField, raw: object) -> str | None:
    """`raw` as one of `field.values`, or None when it is not a declared value.

    Models answer "High", " medium " or "n/a"; only an exact declared value (after
    trimming and lower-casing) is stored, so a stored value is always filterable
    and a garbage answer reads as unscored rather than as a fake category.
    """
    if not isinstance(raw, str):
        return None
    value = raw.strip().lower()
    return value if value in field.values else None


def extract_enrichment_values(insights: dict) -> dict[str, str]:
    """The validated registry values present in one enrichment response.

    Fields the model omitted or answered outside the enum are left out entirely,
    so the processor's None-stripping writes no attribute and the item is counted
    as unscored — never as a default that was not actually derived.
    """
    if not isinstance(insights, dict):
        return {}
    out: dict[str, str] = {}
    for field in ENRICHMENT_FIELDS:
        value = normalize_value(field, insights.get(field.name))
        if value is not None:
            out[field.name] = value
    return out


def prompt_schema_fragment() -> str:
    """The registry's keys for the enrichment JSON structure, e.g. `"usefulness":"high|medium|low"`.

    Contains no braces, so it can be spliced into a `.format()` template unescaped.
    """
    return ','.join(f'"{f.name}":"{"|".join(f.values)}"' for f in ENRICHMENT_FIELDS)


def prompt_guides() -> str:
    """Rating guides appended after the enrichment JSON structure."""
    blocks = [f'{f.name} rating guide:\n{f.guide}' for f in ENRICHMENT_FIELDS]
    return '\n\n'.join(blocks)


SINGLE_FIELD_SYSTEM_PROMPT = (
    'You are an expert customer experience analyst. '
    'Return ONLY valid JSON with exactly the requested key. Never invent PII.'
)


def build_single_field_prompt(field: EnrichmentField, text: str, max_chars: int = 3000) -> str:
    """The prompt the data-quality worker uses to (re)derive one field for one item.

    Uses the same guide as the full enrichment prompt so a recalculated value means
    the same thing as one the processor wrote at ingest.
    """
    allowed = '|'.join(field.values)
    return (
        f'Rate {field.description}.\n\n'
        f'{field.name} rating guide:\n{field.guide}\n\n'
        f'Feedback:\n"""\n{text[:max_chars]}\n"""\n\n'
        f'Return ONLY this JSON: {{"{field.name}":"{allowed}"}}'
    )


def item_value(item: Mapping[str, object], field: EnrichmentField) -> str:
    """The stored value for filtering/counting, or UNSCORED when absent or invalid."""
    return normalize_value(field, item.get(field.name)) or UNSCORED
