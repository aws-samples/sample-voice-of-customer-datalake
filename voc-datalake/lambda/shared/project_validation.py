"""The Validate step (7.68.00, docs/project-workspace.md → Validate): its criteria, tasks, state and verdicts.

TENETS.md tenet 2's chain ends "… → prototype → review"; the platform labels that step **Validate** (owner decision,
7.68.00: no tenet change). What every Validate route shares lives here:

* the **success criteria** ``[{id, text, target?}]``: parsed once from the PRD's Success Metrics (one model call,
  shared/validation_ai.py), then edited by hand. ``target`` is the average rating out of 5 that real testers must give
  the criterion for it to count as **met** (``DEFAULT_TARGET`` when absent); a PRD's own numbers (a business target,
  "checkout under two minutes") stay in its text, since a prototype test cannot measure them;
* the **tasks** a tester tries on the prototype ``[{id, text}]``, from the plan's test script, edited by hand;
* the project META's ``validation`` map::

      {prd_document_id, prototype_document_id, criteria, tasks, plan_document_id, run_document_id,
       report_document_id, form_id, form_open, form_language, card_in_prototype, status, revision, updated_at,
       updated_by: {sub, kind}, reason}

  every write conditional on the ``revision`` it read (409 ``validation_changed`` otherwise), recording who, when and
  why (TENETS.md D4), and refused on a project being deleted;
* **judging** a criterion: ``met`` / ``not_met`` / ``not_enough_data`` against its target, from REAL testers' answers
  only (at least ``MIN_RESPONSES``). A synthetic run (the personas, ``synthetic: true``) is shown beside them,
  labelled, and never counts towards "met" (owner decision, 7.68.00).
"""
from __future__ import annotations

import json
import re
import secrets
from collections.abc import Callable, Mapping, Sequence
from decimal import Decimal
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.dynamo_values import plain
from shared.exceptions import ConflictError, NotFoundError, ValidationError
from shared.methodology import VALIDATION_PLAN_TYPE, VALIDATION_REPORT_TYPE, VALIDATION_RUN_TYPE
from shared.project_writes import (
    PROJECT_WRITABLE_ATTRIBUTE_NAMES,
    PROJECT_WRITABLE_ATTRIBUTE_VALUES,
    PROJECT_WRITABLE_CONDITION,
    is_project_tombstone,
    project_meta_key,
)
from shared.request_body import validated_text
from shared.timestamps import now_iso

PLAN_TYPE: Final = VALIDATION_PLAN_TYPE
RUN_TYPE: Final = VALIDATION_RUN_TYPE
REPORT_TYPE: Final = VALIDATION_REPORT_TYPE

CRITERION_ID: Final = re.compile(r'c[0-9a-f]{6}')
TASK_ID: Final = re.compile(r't[0-9a-f]{6}')
MAX_CRITERIA: Final = 10
MAX_TASKS: Final = 8
MAX_TEXT_CHARS: Final = 300
MIN_TARGET: Final = 1.0
MAX_TARGET: Final = 5.0
#: The average rating out of 5 a criterion with no target of its own needs from real testers.
DEFAULT_TARGET: Final = 4.0
#: Real answers a criterion needs before it is judged at all (the forms' minimum segment, 7.63.00).
MIN_RESPONSES: Final = 5

STATUS_NOT_STARTED: Final = 'not_started'
STATUS_CRITERIA: Final = 'criteria'
STATUS_PLANNED: Final = 'planned'
STATUS_TESTING: Final = 'testing'
STATUS_REPORTED: Final = 'reported'

MET: Final = 'met'
NOT_MET: Final = 'not_met'
NOT_ENOUGH_DATA: Final = 'not_enough_data'
#: A synthetic run's reading of a criterion: never "met", only what the personas said.
LIKELY_MET: Final = 'likely_met'
LIKELY_NOT_MET: Final = 'likely_not_met'

#: Why a write happened (TENETS.md D4), stored as the block's ``reason``.
REASON_CRITERIA_EXTRACTED: Final = 'criteria_extracted'
REASON_CRITERIA_EDITED: Final = 'criteria_edited'
REASON_PLAN_WRITTEN: Final = 'plan_written'
REASON_SYNTHETIC_RUN: Final = 'synthetic_run'
REASON_FORM_SAVED: Final = 'form_saved'
REASON_REPORT_WRITTEN: Final = 'report_written'

STALE_MESSAGE: Final = 'The validation changed since you opened it. Reload it and try again.'
CHANGED_CODE: Final = 'validation_changed'
_BLOCK: Final = 'validation'


def new_id(prefix: str, taken: set[str] | frozenset[str] = frozenset()) -> str:
    """``prefix`` + 6 random hex, never one of ``taken``: ids are never reused, so a removed task's question id (the
    pin form retires it for good) can never come back."""
    while True:
        candidate = f'{prefix}{secrets.token_hex(3)}'
        if candidate not in taken:
            return candidate


def _target(value: object, where: str) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float | Decimal) or \
            not MIN_TARGET <= float(value) <= MAX_TARGET:
        raise ValidationError(f'{where} must be a number from {MIN_TARGET:g} to {MAX_TARGET:g} (an average out of 5)')
    return Decimal(str(round(float(value), 1)))


Build = Callable[[Mapping[str, Any], str], dict[str, Any]]


def _entries(value: object, name: str, limit: int, pattern: re.Pattern[str], prefix: str, keys: frozenset[str],
             build: Build) -> list[dict[str, Any]]:
    """1 to ``limit`` objects of ``keys``, each with its id (kept when given, a new one otherwise) and ``build``'s
    fields; a 400 naming the entry and the field."""
    if not isinstance(value, list) or not 1 <= len(value) <= limit:
        raise ValidationError(f'{name} must be a list of 1 to {limit} entries')
    given = {str(entry['id']) for entry in value if isinstance(entry, Mapping) and isinstance(entry.get('id'), str)}
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, entry in enumerate(value):
        where = f'{name}[{index}]'
        if not isinstance(entry, Mapping):
            raise ValidationError(f'{where} must be an object')
        unknown = sorted(str(key)[:40] for key in entry if key not in keys)
        if unknown:
            raise ValidationError(f'{where}.{unknown[0]} is not a field of {name}')
        raw_id = entry.get('id')
        if raw_id is not None and not (isinstance(raw_id, str) and pattern.fullmatch(raw_id)):
            raise ValidationError(f'{where}.id is not one of its ids')
        entry_id = raw_id if isinstance(raw_id, str) else new_id(prefix, {*given, *seen})
        if entry_id in seen:
            raise ValidationError(f'{where}.id "{entry_id}" is used twice')
        seen.add(entry_id)
        out.append({'id': entry_id, **build(entry, where)})
    return out


def _criterion(entry: Mapping[str, Any], where: str) -> dict[str, Any]:
    out: dict[str, Any] = {'text': validated_text(entry.get('text'), f'{where}.text', MAX_TEXT_CHARS, required=True)}
    target = _target(entry.get('target'), f'{where}.target')
    if target is not None:
        out['target'] = target
    return out


def _task(entry: Mapping[str, Any], where: str) -> dict[str, Any]:
    return {'text': validated_text(entry.get('text'), f'{where}.text', MAX_TEXT_CHARS, required=True)}


def validated_criteria(value: object) -> list[dict[str, Any]]:
    """``[{id?, text, target?}]`` (1 to 10): ids kept or minted (``c`` + 6 hex), texts stripped, a target 1 to 5."""
    return _entries(value, 'criteria', MAX_CRITERIA, CRITERION_ID, 'c', frozenset({'id', 'text', 'target'}),
                    _criterion)


def validated_tasks(value: object) -> list[dict[str, Any]]:
    """``[{id?, text}]`` (1 to 8): what a tester tries on the prototype, ids kept or minted (``t`` + 6 hex)."""
    return _entries(value, 'tasks', MAX_TASKS, TASK_ID, 't', frozenset({'id', 'text'}), _task)


def validated_expected_revision(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValidationError('expected_revision must be a whole number')
    return value


def target_of(criterion: Mapping[str, Any]) -> float:
    target = criterion.get('target')
    return float(target) if isinstance(target, int | float | Decimal) and not isinstance(target, bool) \
        else DEFAULT_TARGET


# ── The META's block ─────────────────────────────────────────────────────────────────────────────────────────────

def block_of(meta: Mapping[str, Any] | None) -> dict[str, Any]:
    """The project's ``validation`` map, JSON-safe ({} before the first write)."""
    stored = (meta or {}).get(_BLOCK)
    return plain(dict(stored)) if isinstance(stored, Mapping) else {}


def status_of(block: Mapping[str, Any]) -> str:
    """Where the step stands: reported, testing (the card asks real testers), planned, criteria, not started."""
    is_open = block.get('form_open') is True
    if block.get('report_document_id'):
        return STATUS_REPORTED
    if is_open:
        return STATUS_TESTING
    if block.get('plan_document_id'):
        return STATUS_PLANNED
    return STATUS_CRITERIA if block.get('criteria') else STATUS_NOT_STARTED


def read_meta(table: Any, project_id: str) -> dict[str, Any]:
    """The project's META (strongly consistent); 404 when it is gone or being deleted."""
    meta = table.get_item(Key=project_meta_key(project_id), ConsistentRead=True).get('Item')
    if not meta or is_project_tombstone(meta):
        raise NotFoundError('Project not found')
    return meta


def to_dynamo(value: Any) -> Any:
    """``value`` with every float a Decimal (DynamoDB takes no float)."""
    return json.loads(json.dumps(plain(value)), parse_float=Decimal)


Changes = Callable[[dict[str, Any]], Mapping[str, Any]]


def _write_block(table: Any, project_id: str, stored: Mapping[str, Any], changes: Mapping[str, Any], *,
                 actor: Mapping[str, str], reason: str) -> dict[str, Any]:
    revision = int(stored.get('revision') or 0)
    block = {**stored, **changes, 'revision': revision + 1, 'updated_at': now_iso(),
             'updated_by': {'sub': str(actor.get('sub') or ''), 'kind': str(actor.get('kind') or '')},
             'reason': reason}
    block['status'] = status_of(block)
    names = {**PROJECT_WRITABLE_ATTRIBUTE_NAMES, '#validation': _BLOCK}
    values: dict[str, Any] = {**PROJECT_WRITABLE_ATTRIBUTE_VALUES, ':block': to_dynamo(block)}
    if revision:
        names['#revision'] = 'revision'
        values[':expected'] = revision
        condition = f'{PROJECT_WRITABLE_CONDITION} AND #validation.#revision = :expected'
    else:
        condition = f'{PROJECT_WRITABLE_CONDITION} AND attribute_not_exists(#validation)'
    table.update_item(Key=project_meta_key(project_id), UpdateExpression='SET #validation = :block',
                      ConditionExpression=condition, ExpressionAttributeNames=names,
                      ExpressionAttributeValues=values)
    return plain(block)


def update_block(table: Any, project_id: str, changes: Changes, *, actor: Mapping[str, str], reason: str,
                 expected_revision: int | None = None) -> dict[str, Any]:
    """Apply ``changes(block)`` to the META's block and write it, one revision on; the block written (JSON-safe).

    ``expected_revision`` (a person's editor: the revision it loaded) makes any write in between a 409. Without one
    (a job finishing), a write in between is read again and ``changes`` applied to it, once.
    """
    for attempt in range(2):
        stored = block_of(read_meta(table, project_id))
        if expected_revision is not None and int(stored.get('revision') or 0) != expected_revision:
            raise ConflictError(STALE_MESSAGE, code=CHANGED_CODE, details={'revision': stored.get('revision') or 0})
        try:
            return _write_block(table, project_id, stored, changes(stored), actor=actor, reason=reason)
        except ClientError as error:
            if not is_conditional_check_failure(error):
                raise
            if expected_revision is not None or attempt:
                raise ConflictError(STALE_MESSAGE, code=CHANGED_CODE) from error
    raise ConflictError(STALE_MESSAGE, code=CHANGED_CODE)  # pragma: no cover  the second attempt returns or raises


# ── Judging ──────────────────────────────────────────────────────────────────────────────────────────────────────

def judged(criterion: Mapping[str, Any], real: Mapping[str, Any] | None) -> str:
    """``met`` / ``not_met`` against the criterion's target once ``MIN_RESPONSES`` real testers rated it, else
    ``not_enough_data``. Only real answers are read: there is no synthetic argument to pass."""
    answered = int((real or {}).get('n') or 0)
    average = (real or {}).get('average')
    if answered < MIN_RESPONSES or not isinstance(average, int | float):
        return NOT_ENOUGH_DATA
    return MET if float(average) >= target_of(criterion) else NOT_MET


def synthetic_reading(criterion: Mapping[str, Any], synthetic: Mapping[str, Any] | None) -> str | None:
    """What the personas' average says about a criterion (``likely_met`` / ``likely_not_met``), labelled synthetic;
    None without a run."""
    average = (synthetic or {}).get('average')
    if not isinstance(average, int | float):
        return None
    return LIKELY_MET if float(average) >= target_of(criterion) else LIKELY_NOT_MET


def criteria_results(criteria: Sequence[Mapping[str, Any]], real: Mapping[str, Any] | None,
                     synthetic: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """Per criterion: its target, the real testers' figure and ``outcome`` (``met`` / ``not_met`` /
    ``not_enough_data``), and the synthetic figure beside it."""
    real_by_id = (real or {}).get('criteria') or {}
    synthetic_by_id = (synthetic or {}).get('criteria') or {}
    out = []
    for criterion in criteria:
        own_real = real_by_id.get(criterion['id']) or {'n': 0, 'average': None}
        own_synthetic = synthetic_by_id.get(criterion['id'])
        out.append({
            'id': criterion['id'], 'text': criterion['text'], 'target': target_of(criterion),
            'target_set': 'target' in criterion, 'real': own_real, 'outcome': judged(criterion, own_real),
            'synthetic': ({**own_synthetic, 'reading': synthetic_reading(criterion, own_synthetic), 'synthetic': True}
                          if own_synthetic else None),
        })
    return out


def task_results(tasks: Sequence[Mapping[str, Any]], real: Mapping[str, Any] | None,
                 synthetic: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """Per task: the real testers' yes / no and success rate, and the personas' outcomes beside them (labelled)."""
    real_by_id = (real or {}).get('tasks') or {}
    synthetic_by_id = (synthetic or {}).get('tasks') or {}
    return [{'id': task['id'], 'text': task['text'],
             'real': real_by_id.get(task['id']) or {'n': 0, 'yes': 0, 'no': 0, 'rate': None},
             'synthetic': {**synthetic_by_id[task['id']], 'synthetic': True} if task['id'] in synthetic_by_id else None}
            for task in tasks]


def suggested_verdict(results: Sequence[Mapping[str, Any]]) -> str:
    """``pursue`` when every criterion is met by real testers, ``park`` otherwise; never ``reject`` by itself."""
    return 'pursue' if results and all(result['outcome'] == MET for result in results) else 'park'


def decision_prefill(project_name: str, results: Sequence[Mapping[str, Any]], *, report_document_id: str | None,
                     feedback_ids: Sequence[str], responses: int) -> dict[str, Any]:
    """The new decision's fields (the existing decision records: verdict, success_metric, evidence ids)."""
    met = sum(result['outcome'] == MET for result in results)
    judged_count = sum(result['outcome'] != NOT_ENOUGH_DATA for result in results)
    rationale = (f'Validation with {responses} real tester response(s): {met} of {len(results)} success criteria met'
                 f' ({len(results) - judged_count} without enough data). Synthetic persona runs are not counted.')
    return {
        'title': f'Decision after validating {project_name}'[:200],
        'verdict': suggested_verdict(results),
        'rationale': rationale,
        'success_metric': '; '.join(f"{result['text']} (target {result['target']:g} of 5)" for result in results)[:1000],
        'evidence': {'document_ids': [report_document_id] if report_document_id else [],
                     'feedback_ids': list(dict.fromkeys(feedback_ids))[:50]},
    }
