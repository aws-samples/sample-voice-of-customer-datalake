"""The evidence marker of a persona that was NOT generated from feedback (TENETS.md tenet 2).

A generated persona carries the reviews it read (``input_feedback_ids``) and the ones it
cites (``evidence_feedback_ids``). A persona imported from an image or pasted text, or
copied from another project or the company library, came from somewhere else, and a
reader must be able to tell. Every imported or copied persona therefore stores:

* ``evidence: {source: 'import' | 'copy', count, inherited, origin}``:
  ``count`` is the number of customer reviews behind the persona (0 for an import),
  ``inherited`` says a copy kept its source persona's reviews, and ``origin`` names
  where the source's evidence came from (``generated``, ``import`` or ``unknown``);
* ``methodology``: the same block a generated document stores
  (``shared.methodology``, step ``personas``), with a ``no_evidence`` warning when
  ``count`` is 0.

Evidence is never invented: an import always counts 0, and a copy counts only the
review ids its source row really holds. The review ids themselves stay in the two
existing fields (copied with the persona), which ``voc-retention``'s lineage pass
already clears on an erasure; this marker repeats no id, so an erasure cannot leave
one behind here.

Pure functions, no AWS.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final, Literal

from shared import methodology
from shared.persona_evidence import EVIDENCE_FEEDBACK_IDS_FIELD

MarkerSource = Literal['import', 'copy']

EVIDENCE_FIELD: Final = 'evidence'
METHODOLOGY_FIELD: Final = 'methodology'
#: Fields a copy recomputes rather than carries over.
MARKER_FIELDS: Final = frozenset({EVIDENCE_FIELD, METHODOLOGY_FIELD})

ORIGIN_GENERATED: Final = 'generated'
ORIGIN_IMPORT: Final = 'import'
ORIGIN_UNKNOWN: Final = 'unknown'

_MESSAGES: Final[Mapping[str, str]] = {
    'import': 'Imported persona: it is not based on customer feedback.',
    'copy': 'Copied from a persona that is not based on customer feedback.',
}


def _id_list(value: object) -> list[str]:
    return [item for item in value if isinstance(item, str) and item] if isinstance(value, list) else []


def review_count(persona: Mapping[str, Any]) -> int:
    """The reviews behind ``persona``: the corpus it read, else the reviews it cites."""
    corpus = _id_list(persona.get('input_feedback_ids'))
    return len(corpus) if corpus else len(_id_list(persona.get(EVIDENCE_FEEDBACK_IDS_FIELD)))


def _origin(source: Mapping[str, Any]) -> str:
    """Where a copy's source got its evidence, read from the source row only."""
    if review_count(source) > 0:
        return ORIGIN_GENERATED
    marker = source.get(EVIDENCE_FIELD)
    if isinstance(marker, Mapping):
        origin = marker.get('origin') if marker.get('source') == 'copy' else marker.get('source')
        if origin in (ORIGIN_GENERATED, ORIGIN_IMPORT):
            return str(origin)
    if source.get('imported_from'):
        return ORIGIN_IMPORT
    return ORIGIN_UNKNOWN


def _block(source: MarkerSource, count: int) -> dict[str, Any]:
    warnings = [] if count else [{'code': methodology.W_NO_EVIDENCE, 'message': _MESSAGES[source]}]
    return methodology.build('personas', [], evidence=count, extra_warnings=warnings)


def imported() -> dict[str, Any]:
    """The marker fields of an imported persona (an image or pasted text): no evidence."""
    return {
        EVIDENCE_FIELD: {'source': 'import', 'count': 0, 'inherited': False, 'origin': ORIGIN_IMPORT},
        METHODOLOGY_FIELD: _block('import', 0),
    }


def copied(source_persona: Mapping[str, Any]) -> dict[str, Any]:
    """The marker fields of a copy: the source's review count when it had reviews, else 0."""
    count = review_count(source_persona)
    return {
        EVIDENCE_FIELD: {'source': 'copy', 'count': count, 'inherited': count > 0,
                         'origin': _origin(source_persona)},
        METHODOLOGY_FIELD: _block('copy', count),
    }


def import_start() -> dict[str, Any]:
    """The ``methodology`` block an import START answers (before its job ran)."""
    return _block('import', 0)
