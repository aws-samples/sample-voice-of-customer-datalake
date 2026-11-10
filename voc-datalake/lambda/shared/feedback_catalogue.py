"""The machine-readable catalogue of a processed feedback item (TENETS.md D7), served at ``GET /feedback/catalogue``.

``/feedback/entities`` lists the VALUES a deployment holds; this says what each stored attribute of
``voc-feedback`` MEANS: type, meaning, the pipeline step that sets it, whether it holds personal data and
what the source's PII policy does to it, and the allowed values of an enum. The entries live in
``shared/feedback_catalogue_fields.py``; every allowed-value list is read from the code that enforces it,
so the catalogue cannot drift from the pipeline. It is the same for every caller and every deployment
release (no data, no configuration), so the answer is ETag-cacheable like every API GET.

``docs/data-catalogue.md`` holds ``render_markdown()`` between its markers, pinned by
``shared/test/test_feedback_catalogue.py``. Regenerate it with::

    cd voc-datalake/lambda && ../.venv/bin/python -m shared.feedback_catalogue
"""
from __future__ import annotations

import json
import re
import sys
from collections.abc import Iterable
from functools import cache
from pathlib import Path
from typing import Any, Final, get_args

from shared.feedback_catalogue_fields import FIELDS, STEPS, CatalogueField
from shared.feedback_category import CATEGORY_SOURCE_MANUAL, CATEGORY_SOURCE_REPROCESS
from shared.feedback_dimensions import (
    DIMENSION_SOURCE_AI,
    DIMENSION_SOURCE_CATEGORY,
    DIMENSION_SOURCE_MANUAL,
    DIMENSION_SOURCE_PROFILE,
    DIMENSION_SOURCE_REPROCESS,
    DIMENSION_SOURCE_SOURCE,
)
from shared.feedback_field_edits import ENUM_VALUES
from shared.feedback_types import feedback_type_dimension
from shared.ingest_schemas import IssueAttributes
from shared.silver_provenance import CHANGE_REASONS, EnrichmentMode
from shared.source_profiles import PII_POLICIES, SUMMARY_ONLY_DROPPED_FIELDS
from shared.usefulness import USEFULNESS_BANDS

__all__ = ['catalogue']

#: Bumped when the catalogue's own shape (not a field) changes.
CATALOGUE_VERSION: Final = 1

#: What a ``redact`` policy does at ingestion (``shared/source_policy.py``, pinned by the test): the
#: customer's words and links are redacted, the author dropped, no raw copy archived. Model-written text is
#: derived from the redacted words. Fields not named keep what the producer sent.
_UNDER_REDACT: Final[dict[str, str]] = {
    'original_text': 'redacted', 'title': 'redacted', 'source_url': 'redacted', 'metadata': 'redacted',
    'author': 'dropped', 's3_raw_uri': 'dropped',
    'normalized_text': 'from_redacted', 'direct_customer_quote': 'from_redacted',
    'problem_summary': 'from_redacted', 'problem_root_cause_hypothesis': 'from_redacted',
    'persona_name': 'from_redacted',
}
_POLICY_EFFECTS: Final[dict[str, str]] = {
    'kept': 'stored as the producer sent it',
    'redacted': 'personal data replaced by placeholders before anything is archived or queued',
    'dropped': 'not stored',
    'from_redacted': 'made from the redacted text',
    'replaced': "the model's problem_summary (or `[withheld]`) instead of the customer's words",
}


def _sorted(values: Iterable[object]) -> list[str]:
    return sorted(str(value) for value in values)


def _allowed_values() -> dict[str, list[str]]:
    values = {name: _sorted(allowed) for name, allowed in ENUM_VALUES.items()}
    values.update({
        'usefulness': list(USEFULNESS_BANDS),
        'pii_policy': list(PII_POLICIES),
        'enrichment_mode': list(get_args(EnrichmentMode)),
        'change_reason': _sorted(CHANGE_REASONS),
        'category_source': [CATEGORY_SOURCE_MANUAL, CATEGORY_SOURCE_REPROCESS],
        'dimension_sources': [DIMENSION_SOURCE_SOURCE, DIMENSION_SOURCE_PROFILE, DIMENSION_SOURCE_CATEGORY,
                              DIMENSION_SOURCE_AI, DIMENSION_SOURCE_MANUAL, DIMENSION_SOURCE_REPROCESS],
    })
    return values


def _under_summary_only(name: str) -> str:
    if name == 'original_text':
        return 'replaced'
    if name in SUMMARY_ONLY_DROPPED_FIELDS:
        return 'dropped'
    return _UNDER_REDACT.get(name, 'kept')


def _issue_sub_fields() -> list[dict[str, str]]:
    return [{'name': name, 'type': getattr(info.annotation, '__name__', str(info.annotation))}
            for name, info in IssueAttributes.model_fields.items()]


def _field_entry(field: CatalogueField, allowed: dict[str, list[str]]) -> dict[str, Any]:
    entry: dict[str, Any] = {
        'name': field.name,
        'type': field.type,
        'meaning': field.meaning,
        'set_by': list(field.steps),
        'always_present': field.always,
        'key': field.key,
        'pii': field.pii,
        'under_redact': _UNDER_REDACT.get(field.name, 'kept'),
        'under_summary_only': _under_summary_only(field.name),
    }
    if field.name in allowed:
        entry['values'] = allowed[field.name]
    if field.name == 'dimensions':
        builtin = feedback_type_dimension()
        entry['builtin_dimensions'] = {builtin['key']: [value['name'] for value in builtin['values']]}
    if field.name == 'issue_attributes':
        entry['sub_fields'] = _issue_sub_fields()
    return entry


@cache
def catalogue() -> dict[str, Any]:
    """``{version, table, steps, policy_effects, fields}``: one entry per stored attribute, in table order.

    Static for the life of the code, so built once per container; callers must not mutate it.
    """
    allowed = _allowed_values()
    return {
        'version': CATALOGUE_VERSION,
        'table': 'voc-feedback',
        'steps': [{'name': name, 'meaning': meaning} for name, meaning in STEPS.items()],
        'policy_effects': [{'name': name, 'meaning': meaning} for name, meaning in _POLICY_EFFECTS.items()],
        'fields': [_field_entry(field, allowed) for field in FIELDS],
    }


# ── docs/data-catalogue.md ──────────────────────────────────────────────────
DOC_PATH: Final = Path(__file__).resolve().parents[3] / 'docs' / 'data-catalogue.md'
START_MARKER: Final = '<!-- catalogue:start (generated by `python -m shared.feedback_catalogue`; do not edit) -->'
END_MARKER: Final = '<!-- catalogue:end -->'
#: The dev mock serves this copy (frontend/mock-feedback-catalogue.js), written by the same command as the doc.
MOCK_PATH: Final = Path(__file__).resolve().parents[2] / 'frontend' / 'mock-feedback-catalogue.json'


def _cell(text: str) -> str:
    return text.replace('|', '\\|').replace('\n', ' ')


def _row(entry: dict[str, Any]) -> str:
    values = ', '.join(f'`{value}`' for value in entry.get('values', []))
    flags = ' '.join(flag for flag, on in (('always', entry['always_present']), ('key', entry['key'])) if on)
    return (f"| `{entry['name']}` | {entry['type']} | {_cell(entry['meaning'])} | {', '.join(entry['set_by'])} "
            f"| {entry['pii']} | {entry['under_redact']} / {entry['under_summary_only']} | {values} | {flags} |")


def render_markdown() -> str:
    """The generated table of every stored attribute (the part of the doc between its markers)."""
    header = ('| Attribute | Type | Meaning | Set by | PII | redact / summary_only | Values | |\n'
              '|---|---|---|---|---|---|---|---|')
    return '\n'.join([header, *(_row(entry) for entry in catalogue()['fields'])])


_SECTION_RE: Final = re.compile(f'{re.escape(START_MARKER)}\n(.*?)\n?{re.escape(END_MARKER)}', re.DOTALL)


def _write_doc() -> int:
    doc = DOC_PATH.read_text(encoding='utf-8')
    match = _SECTION_RE.search(doc)
    if match is None:
        sys.stderr.write(f'{DOC_PATH}: catalogue markers not found\n')
        return 1
    generated = f'{START_MARKER}\n{render_markdown()}\n{END_MARKER}'
    DOC_PATH.write_text(doc[:match.start()] + generated + doc[match.end():], encoding='utf-8')
    MOCK_PATH.write_text(mock_json(), encoding='utf-8')
    return 0


def mock_json() -> str:
    """The catalogue as the dev mock serves it (stable JSON, one trailing newline)."""
    return json.dumps(catalogue(), indent=2, ensure_ascii=False) + '\n'


if __name__ == '__main__':
    sys.exit(_write_doc())
