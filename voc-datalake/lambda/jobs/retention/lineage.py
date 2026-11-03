"""voc-retention: workspace artifacts that cited an erased item say so (TENETS.md D5).

Personas, research reports and documents in voc-projects record the reviews they
read (``input_feedback_ids``) and, for a persona, the ones it cites
(``evidence_feedback_ids``). After a run deletes items, this pass scans
voc-projects for rows carrying either list (paged, time-budgeted by the caller)
and looks each listed id up among the tombstones of the sources the run deleted
from (``AUDIT#tombstone#{source}``). An artifact with an erased id:

- loses that id from its lists, so lineage never points at a deleted item;
- gains ``erased_evidence: {count, job_id, mode, at}`` (``count`` adds up over
  runs), so its owner sees that evidence was erased.

The artifact's text is never rewritten: it belongs to its owner and holds no
review, only what the model wrote from them. The update is conditional on the
lists read, so an artifact regenerated meanwhile is left alone (its new lists
are checked by the next run that deletes anything).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Final

from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

from jobs.retention.copies import tombstone_key
from shared.aws import is_conditional_check_failure
from shared.batch_get import batch_get_all
from shared.feedback_sampling import INPUT_FEEDBACK_IDS_FIELD
from shared.logging import logger
from shared.persona_evidence import EVIDENCE_FEEDBACK_IDS_FIELD
from shared.timestamps import now_iso

ID_FIELDS: Final = (INPUT_FEEDBACK_IDS_FIELD, EVIDENCE_FEEDBACK_IDS_FIELD)
MARK_FIELD: Final = 'erased_evidence'
PAGE_SIZE: Final = 100


class TombstonesUnreadable(RuntimeError):
    """The tombstone lookup left keys unprocessed (the run fails and says so; nothing is half-marked)."""


def scan_page(projects_table: Any, cursor: Mapping[str, Any] | None) -> dict[str, Any]:
    """One page of rows that carry a feedback-id list, with only the fields this pass reads."""
    kwargs: dict[str, Any] = {
        'Limit': PAGE_SIZE,
        'FilterExpression': Attr(ID_FIELDS[0]).exists() | Attr(ID_FIELDS[1]).exists(),
        'ProjectionExpression': '#pk, #sk, #ids, #cited, #mark',
        'ExpressionAttributeNames': {'#pk': 'pk', '#sk': 'sk', '#ids': ID_FIELDS[0], '#cited': ID_FIELDS[1],
                                     '#mark': MARK_FIELD},
    }
    if cursor:
        kwargs['ExclusiveStartKey'] = dict(cursor)
    return projects_table.scan(**kwargs)


def _listed_ids(row: Mapping[str, Any]) -> list[str]:
    ids: list[str] = []
    for field in ID_FIELDS:
        values = row.get(field)
        if isinstance(values, list):
            ids.extend(value for value in values if isinstance(value, str) and value)
    return list(dict.fromkeys(ids))


def erased_ids(aggregates_table: Any, sources: Sequence[str], ids: Iterable[str]) -> set[str]:
    """The ``ids`` that have a tombstone under one of ``sources``."""
    wanted = list(dict.fromkeys(ids))
    keys = [tombstone_key(source, feedback_id) for source in sources for feedback_id in wanted]
    if not keys:
        return set()
    rows = batch_get_all(aggregates_table, keys, failure=TombstonesUnreadable('Tombstones could not be read'),
                         read_options={'ProjectionExpression': 'sk'})
    return {str(row['sk']) for row in rows}


def _mark(row: Mapping[str, Any], removed: int, run: Mapping[str, Any]) -> dict[str, Any]:
    previous = row.get(MARK_FIELD)
    before = previous.get('count') if isinstance(previous, Mapping) else 0
    return {
        'count': int(before or 0) + removed, 'job_id': run.get('job_id') or run['run_id'],
        'mode': run['mode'], 'at': now_iso(),
    }


def _list_update(row: Mapping[str, Any], erased: set[str]) -> tuple[list[str], list[str], dict[str, str],
                                                                 dict[str, Any], int]:
    """``(sets, conditions, names, values, removed)`` that drop ``erased`` from the row's id lists."""
    sets: list[str] = []
    conditions: list[str] = []
    names: dict[str, str] = {}
    values: dict[str, Any] = {}
    removed = 0
    for n, field in enumerate(field for field in ID_FIELDS if isinstance(row.get(field), list)):
        listed = row[field]
        kept = [value for value in listed if value not in erased]
        removed += len(listed) - len(kept)
        names[f'#f{n}'] = field
        values.update({f':old{n}': listed, f':new{n}': kept})
        sets.append(f'#f{n} = :new{n}')
        conditions.append(f'#f{n} = :old{n}')
    return sets, conditions, names, values, removed


def mark_artifact(projects_table: Any, row: Mapping[str, Any], erased: set[str], run: Mapping[str, Any]) -> bool:
    """Drop ``erased`` from the row's lists and mark it; False when it changed since it was read."""
    sets, conditions, names, values, removed = _list_update(row, erased)
    try:
        projects_table.update_item(
            Key={'pk': row['pk'], 'sk': row['sk']},
            UpdateExpression=f"SET {', '.join(sets)}, #mark = :mark",
            ConditionExpression=' AND '.join(conditions),
            ExpressionAttributeNames={**names, '#mark': MARK_FIELD},
            ExpressionAttributeValues={**values, ':mark': _mark(row, removed, run)},
        )
    except ClientError as e:
        if is_conditional_check_failure(e):
            logger.info('An artifact changed while its erased evidence was being marked; left for the next run')
            return False
        raise
    return True


def mark_rows(projects_table: Any, aggregates_table: Any, run: dict[str, Any],
              rows: Sequence[Mapping[str, Any]]) -> None:
    """Mark every row of one page whose lists name an erased item (counted in ``run['artifacts_marked']``).

    One tombstone lookup for the whole page (BatchGetItem, 100 keys a request).
    """
    listed = [_listed_ids(row) for row in rows]
    erased = erased_ids(aggregates_table, list(run['erased_sources']),
                        (feedback_id for ids in listed for feedback_id in ids))
    for row, ids in zip(rows, listed, strict=True):
        hits = erased.intersection(ids)
        if hits and mark_artifact(projects_table, row, hits, run):
            run['artifacts_marked'] += 1
