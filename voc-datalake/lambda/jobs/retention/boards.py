"""voc-retention: an erasure by email also reaches the feedback boards (docs/feature-requests.md -> Erasure).

Board requests are not feedback items: they stay in voc-feature-requests. A person's email is stored
there on a request they filed (``FR#{id}`` / ``META``: ``reporter_email``, ``reporter_name``) and on
every +1 they gave (``FR#{id}`` / ``SUP#{id}``: ``email``, ``name``), and, when an admin opted in to
raw copies (``shared/feature_requests_raw.py``), in every version of those rows' raw copies::

    raw/feature_requests/{YYYY}/{MM}/{DD}/{request or support id}/{sha16}.json

An erasure job with ``field: 'email'`` (and no source, or the source ``feature_requests``) walks
the table with a bounded, paged Scan (no index holds the email). For each matching row, in order:

1. a tombstone (``AUDIT#tombstone#feature_requests`` / the request or support id; ids and the legal
   basis only, one PutItem, no ``ttl``), so nothing is changed without a record;
2. every version under the row's raw folder (the day is the row's own ``created_at``);
3. the row is DE-IDENTIFIED, not deleted: its email and name are REMOVEd (conditional on the row
   still being there). The request's title, description and +1 count stay: they are the board's
   shared content, and the erased person can no longer be tied to them.

The worker holds no delete on voc-feature-requests: Scan and UpdateItem only. A request whose
reporter was erased counts as erased evidence for the lineage pass (``lineage.py``): documents and
personas listing it in ``input_feature_request_ids`` are marked like for an erased review.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any, Final

from boto3.dynamodb.conditions import Attr, ConditionBase
from botocore.exceptions import ClientError

from jobs.retention.copies import legal_basis_for, tombstone_key
from jobs.retention.runs import BOARD_COUNTER, MODE_ERASE, note_erased_source
from shared import retention
from shared.archive_keys import archive_key_stem
from shared.aws import is_conditional_check_failure
from shared.feature_requests_raw import FEATURE_REQUESTS_SOURCE
from shared.feature_requests_store import request_key
from shared.timestamps import now_iso

# The boards' source id (raw copies, tombstones) doubles as the table's key in ``Walk.tables``.
BOARDS_SOURCE: Final = FEATURE_REQUESTS_SOURCE
STORE_BOARDS: Final = FEATURE_REQUESTS_SOURCE
ERASE_FIELD: Final = 'email'
PAGE_SIZE: Final = 100
_SUPPORT_SK_PREFIX: Final = 'SUP#'
# The request row's sort key, as its store writes it.
_REQUEST_SK: Final = request_key('_')['sk']
# What each row kind stores about the person (REMOVEd) and the id its raw folder is named after.
_PERSON_FIELDS: Final = {_REQUEST_SK: ('reporter_email', 'reporter_name'), _SUPPORT_SK_PREFIX: ('email', 'name')}
_PROJECTION: Final = ('pk', 'sk', 'request_id', 'support_id', 'created_at')


def applies(run: Mapping[str, Any]) -> bool:
    """An erasure by email that is not limited to another source."""
    return (run.get('mode') == MODE_ERASE and run.get('field') == ERASE_FIELD
            and run.get('source') in (None, '', BOARDS_SOURCE))


def erase_filter(value: str) -> ConditionBase:
    """Requests filed by, and +1s given by, the email (case-insensitive: the boards store it lower-cased)."""
    spellings = list(dict.fromkeys([value.strip().lower(), value]))
    request = Attr('sk').eq(_REQUEST_SK) & Attr('reporter_email').is_in(spellings)
    support = Attr('sk').begins_with(_SUPPORT_SK_PREFIX) & Attr('email').is_in(spellings)
    return request | support


def scan_page(table: Any, value: str, cursor: Mapping[str, Any] | None) -> dict[str, Any]:
    """One page of matching rows, with only the fields this pass reads."""
    kwargs: dict[str, Any] = {
        'Limit': PAGE_SIZE, 'FilterExpression': erase_filter(value),
        'ProjectionExpression': ', '.join(f'#{name}' for name in _PROJECTION),
        'ExpressionAttributeNames': {f'#{name}': name for name in _PROJECTION},
    }
    if cursor:
        kwargs['ExclusiveStartKey'] = dict(cursor)
    return table.scan(**kwargs)


def _kind(row: Mapping[str, Any]) -> str:
    return _REQUEST_SK if row.get('sk') == _REQUEST_SK else _SUPPORT_SK_PREFIX


def _request_id(row: Mapping[str, Any]) -> str:
    return str(row.get('request_id') or str(row['pk']).removeprefix('FR#'))


def _item_id(row: Mapping[str, Any]) -> str:
    """The request id (META) or the support id (a +1): the tombstone's and the raw folder's name."""
    if _kind(row) == _REQUEST_SK:
        return _request_id(row)
    return str(row.get('support_id') or str(row['sk']).removeprefix(_SUPPORT_SK_PREFIX))


def raw_folder(row: Mapping[str, Any]) -> str | None:
    """``raw/feature_requests/{YYYY}/{MM}/{DD}/{stem}/`` of the row, or None without a readable ``created_at``."""
    created_at = row.get('created_at')
    if not isinstance(created_at, str):
        return None
    try:
        day = datetime.fromisoformat(created_at.replace('Z', '+00:00')).date()
    except ValueError:
        return None
    return f'raw/{BOARDS_SOURCE}/{day:%Y/%m/%d}/{archive_key_stem(_item_id(row))}/'


def tombstone(run: Mapping[str, Any], row: Mapping[str, Any], now: str) -> dict[str, Any]:
    """One de-identified row's record: ids, the run and the legal basis, never the email or any content."""
    item_id = _item_id(row)
    return {
        **tombstone_key(BOARDS_SOURCE, item_id), 'feature_request_id': _request_id(row),
        **({'support_id': item_id} if _kind(row) == _SUPPORT_SK_PREFIX else {}),
        'source': BOARDS_SOURCE, 'store': STORE_BOARDS, 'action': 'deidentified', 'mode': run['mode'],
        'run_id': run['run_id'], 'legal_basis': legal_basis_for(run, BOARDS_SOURCE), 'deleted_at': now,
        **({'job_id': run['job_id']} if run.get('job_id') else {}),
    }


def _delete_folder(s3: Any, bucket: str, folder: str) -> int:
    """Every version under ``folder``; the files deleted."""
    deleted, more = 0, True
    while more:
        objects, more = retention.delete_raw_prefix_page(s3, bucket, folder)
        deleted += objects
    return deleted


def deidentify(table: Any, row: Mapping[str, Any]) -> bool:
    """REMOVE the person's email and name from the row; False when the row is gone meanwhile."""
    fields = _PERSON_FIELDS[_kind(row)]
    try:
        table.update_item(
            Key={'pk': row['pk'], 'sk': row['sk']},
            UpdateExpression='REMOVE ' + ', '.join(f'#f{n}' for n in range(len(fields))),
            ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeNames={f'#f{n}': field for n, field in enumerate(fields)},
        )
    except ClientError as e:
        if is_conditional_check_failure(e):
            return False
        raise
    return True


class BoardEraser:
    """Erases the person from the matched board rows of one page, counting into ``run``."""

    def __init__(self, run: dict[str, Any], tables: Mapping[str, Any], s3: Any, bucket: str) -> None:
        self._run = run
        self._table = tables[STORE_BOARDS]
        self._aggregates = tables['aggregates']
        self._s3 = s3
        self._bucket = bucket

    def tombstones(self, rows: Sequence[Mapping[str, Any]]) -> None:
        """One tombstone per row, one PutItem each, before any row changes (copies.write_tombstones' rule)."""
        now = now_iso()
        for row in rows:
            self._aggregates.put_item(Item=tombstone(self._run, row, now))

    def erase(self, row: Mapping[str, Any]) -> None:
        """The row's raw copies (every version), then its email and name."""
        folder = raw_folder(row)
        if folder is not None and self._bucket:
            self._run['deleted_objects'] += _delete_folder(self._s3, self._bucket, folder)
        if deidentify(self._table, row):
            self._run[BOARD_COUNTER] = int(self._run.get(BOARD_COUNTER) or 0) + 1
            note_erased_source(self._run, BOARDS_SOURCE)
