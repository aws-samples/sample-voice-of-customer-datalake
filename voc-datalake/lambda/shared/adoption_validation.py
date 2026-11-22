"""What the leadership view reads of the Validate phase (7.68.00, idea 4), in one place: every field and document type
name it reads, and the tolerant readers the rollup uses (shared/adoption_rollup.py). docs/leadership-view.md.

The names match 7.68.00 as shipped (shared/project_validation.py, shared/validation_documents.py; checked on the
integrated 7.67.00-7.71.00 stack):

* the project ``META``'s ``validation`` map, of which the rollup reads ``report_document_id``;
* the project documents of type ``validation_plan``, ``validation_report`` and ``validation_run`` (``PLAN_TYPE``,
  ``REPORT_TYPE``, ``RUN_TYPE``); a run is always stored with ``synthetic: true`` and never counts as met;
* a report's per-criterion results, ``results[i]``, each with its ``outcome`` (``met`` / ``not_met`` /
  ``not_enough_data``: ``project_validation.MET``, ``NOT_MET``, ``NOT_ENOUGH_DATA``);
* a decision (shared/decision_records.py) that cites a validation report among its evidence ids
  (``decision.evidence.document_ids``, as ``project_validation.decision_prefill`` fills them).

Every reader is tolerant: a project, a report or a decision without any of it counts as not validated, never as an
error, so a project made before 7.68.00 reads as one that was never validated.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

# The Validate phase's document types the rollup reads (``document_type``; a plan counts towards nothing).
from shared.methodology import VALIDATION_REPORT_TYPE, VALIDATION_RUN_TYPE

__all__ = ['META_VALIDATION_FIELD', 'REPORT_RESULTS_FIELD', 'SYNTHETIC_FIELD', 'VALIDATION_REPORT_TYPE',
           'VALIDATION_RUN_TYPE', 'is_synthetic', 'met_criteria', 'report_projection']

#: The project ``META``'s map (7.68.00): ``{prd_document_id, criteria, plan_document_id, report_document_id, status}``.
META_VALIDATION_FIELD: Final = 'validation'
#: A run with the personas (``validation_run``) says so: it never counts as met (owner decision 9).
SYNTHETIC_FIELD: Final = 'synthetic'
#: A report's per-criterion results (a list of maps) and the key of each one's outcome against its target.
REPORT_RESULTS_FIELD: Final = 'results'
REPORT_OUTCOME_KEY: Final = 'outcome'
OUTCOME_MET: Final = 'met'
#: The criteria of one report the rollup reads the outcome of (the PRD's success metrics: a handful).
MAX_REPORT_CRITERIA: Final = 20


def report_projection(names: dict[str, str]) -> list[str]:
    """The projection paths of a report's outcomes, ``results[0].#outcome`` … (only the outcome of each criterion is
    read: never a quote, a rate or a criterion's text), the outcome's name added to ``names``. The list is named as
    itself, not through a placeholder (it is no reserved word; moto refuses a placeholder before an index)."""
    names['#outcome'] = REPORT_OUTCOME_KEY
    return [f'{REPORT_RESULTS_FIELD}[{index}].#outcome' for index in range(MAX_REPORT_CRITERIA)]


def is_synthetic(row: Mapping[str, Any]) -> bool:
    """Whether a validation run was made with the personas (anything but an explicit ``synthetic: false`` is, for a
    ``validation_run``: synthetic is the only kind 7.68.00 stores as a run)."""
    return row.get(SYNTHETIC_FIELD) is not False


def met_criteria(row: Mapping[str, Any]) -> int:
    """How many of a report's criteria were met by real results (0 for a report that says nothing readable); a
    synthetic report counts none."""
    if row.get(SYNTHETIC_FIELD) is True:
        return 0
    results = row.get(REPORT_RESULTS_FIELD)
    if not isinstance(results, list):
        return 0
    return sum(1 for result in results
               if isinstance(result, Mapping) and result.get(REPORT_OUTCOME_KEY) == OUTCOME_MET)
