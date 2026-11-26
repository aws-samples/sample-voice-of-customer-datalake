"""voc-retention: an erasure by email also reaches the feedback boards (docs/feature-requests.md -> Erasure).

Board requests are not feedback items: they stay in voc-feature-requests. A person's email is stored
there on a request they filed (``FR#{id}`` / ``META``: ``reporter_email``, ``reporter_name``) and on
every +1 they gave (``FR#{id}`` / ``SUP#{id}``: ``email``, ``name``), and, when an admin opted in to
raw copies (``shared/feature_requests_raw.py``), in every version of those rows' raw copies::

    raw/feature_requests/{YYYY}/{MM}/{DD}/{request or support id}/{sha16}.json

An erasure job with ``field: 'email'`` (and no source, or the source ``feature_requests``) walks
the table with a bounded, paged Scan (no index holds the email). For each matching row, in order:

1. a tombstone (``AUDIT#tombstone#feature_requests``; ids and the legal basis only, one PutItem, no
   ``ttl``), so nothing is changed without a record. A request's is written for the page before any
   row changes (its id is random and stays); a +1's right before its re-key, under its NEW id only;
2. every version under the row's raw folder (the day is the row's own ``created_at``);
3. the row is DE-IDENTIFIED, not deleted. A request: its email and name are REMOVEd (conditional on
   the row still being there). A +1: its id is derived from the email, so it is RE-KEYED
   (``boards_rekey.py``): one transaction puts it under a new random id without email and name and
   deletes the old row, then the request's totals are recomputed (the +1 still counts). The request's
   title, description and +1 count stay: they are the board's shared content, and the erased person
   can no longer be tied to them.

A customer contact (since 7.72.00): a +1's own ``contact_email`` and a request's ``fields.contact_email`` (an address
the person filing it typed; both stored lower-cased) match too. A row that names the address only as its contact gets
its raw copies deleted and that one field REMOVEd (only while it still holds a spelling of the address); its id stays.
A +1 whose own address and contact are both the erased one is re-keyed without either.

Records (since 7.72.00): a request's id tombstone is put only if new (the lineage pass reads its existence alone, so
a request whose contact alone matched marks the artifacts that cite it, as any erased request), and each erasure also
puts its own record of each field it removes from a request (``{request id}#reporter#{token}``,
``{request id}#contact#{token}``: the job, its legal basis), so a second erasure meeting the request is recorded too;
a +1 whose contact alone matched gets ``{request id}#contact#{token}``, never its own id, which derives from its
supporter's address (the supporter is not erased). A promote (shared/feature_requests_promote.py) makes each +1's
contact a participant, so after this no later promote finds the address again.

On voc-feature-requests the worker reads (Scan, GetItem, Query), updates, and puts / deletes rows
under ``FR#*`` only (the re-key). A request whose reporter was erased counts as erased evidence for
the lineage pass (``lineage.py``): documents and personas listing it in ``input_feature_request_ids``
are marked like for an erased review.
"""

from __future__ import annotations

import secrets
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any, Final

from boto3.dynamodb.conditions import Attr, ConditionBase
from botocore.exceptions import ClientError

from jobs.retention import boards_rekey
from jobs.retention.copies import tombstone_record
from jobs.retention.runs import MODE_ERASE, note_erased_source
from shared import retention
from shared.archive_keys import archive_key_stem
from shared.aws import is_conditional_check_failure
from shared.feature_requests_raw import FEATURE_REQUESTS_SOURCE
from shared.feature_requests_store import request_key
from shared.retention import BOARD_COUNTER
from shared.timestamps import now_iso

# The boards' source id (raw copies, tombstones) doubles as the table's key in ``Walk.tables``.
BOARDS_SOURCE: Final = FEATURE_REQUESTS_SOURCE
STORE_BOARDS: Final = FEATURE_REQUESTS_SOURCE
ERASE_FIELD: Final = 'email'
PAGE_SIZE: Final = 100
_SUPPORT_SK_PREFIX: Final = 'SUP#'
# The request row's sort key, as its store writes it.
_REQUEST_SK: Final = request_key('_')['sk']
# What a request row stores about its reporter (REMOVEd); a +1 is re-keyed instead (boards_rekey.py).
_REPORTER_FIELDS: Final = ('reporter_email', 'reporter_name')
#: A customer contact's address (shared/feature_board_fields.py ``EMAIL_FIELDS``): a +1's own field, a request's in
#: its ``fields`` map; stored normalised (lower-cased).
_CONTACT: Final = 'contact_email'
_PROJECTION: Final = ('pk', 'sk', 'request_id', 'support_id', 'created_at', 'email', 'reporter_email', _CONTACT)


def applies(run: Mapping[str, Any]) -> bool:
    """An erasure by email that is not limited to another source."""
    return (run.get('mode') == MODE_ERASE and run.get('field') == ERASE_FIELD
            and run.get('source') in (None, '', BOARDS_SOURCE))


def _spellings(value: str) -> list[str]:
    return list(dict.fromkeys([value.strip().lower(), value]))


def erase_filter(value: str) -> ConditionBase:
    """Requests filed by, and +1s given by, the email, and (since 7.72.00) a +1 or a request naming it as its customer
    contact (``contact_email``, a +1's own field, a request's in ``fields``): case-insensitive, the boards store both
    lower-cased."""
    spellings = _spellings(value)
    request = Attr('sk').eq(_REQUEST_SK) & (Attr('reporter_email').is_in(spellings)
                                            | Attr(f'fields.{_CONTACT}').is_in(spellings))
    support = Attr('sk').begins_with(_SUPPORT_SK_PREFIX) & (Attr('email').is_in(spellings)
                                                            | Attr(_CONTACT).is_in(spellings))
    return request | support


def scan_page(table: Any, value: str, cursor: Mapping[str, Any] | None) -> dict[str, Any]:
    """One page of matching rows, with only the fields this pass reads: the keys and ids, and which address matched
    (a +1's ``email`` or ``contact_email``, a request's ``reporter_email`` or ``fields.contact_email``)."""
    names = {f'#{name}': name for name in _PROJECTION}
    kwargs: dict[str, Any] = {
        'Limit': PAGE_SIZE, 'FilterExpression': erase_filter(value),
        'ProjectionExpression': ', '.join([*names, '#fields.#contact']),
        'ExpressionAttributeNames': {**names, '#fields': 'fields', '#contact': _CONTACT},
    }
    if cursor:
        kwargs['ExclusiveStartKey'] = dict(cursor)
    return table.scan(**kwargs)


def _kind(row: Mapping[str, Any]) -> str:
    return _REQUEST_SK if row.get('sk') == _REQUEST_SK else _SUPPORT_SK_PREFIX


def _request_id(row: Mapping[str, Any]) -> str:
    return str(row.get('request_id') or str(row['pk']).removeprefix('FR#'))


def _item_id(row: Mapping[str, Any]) -> str:
    """The request id (META) or the old support id (a +1): the raw folder's name (never a tombstone's)."""
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


def is_support(row: Mapping[str, Any]) -> bool:
    return _kind(row) == _SUPPORT_SK_PREFIX


def tombstone(run: Mapping[str, Any], row: Mapping[str, Any], now: str,
              new_support_id: str | None = None) -> dict[str, Any]:
    """One de-identified row's record: ids, the run and the legal basis, never the email or any content.

    A +1's record names ``new_support_id`` (its id after the re-key), never the email-derived old id."""
    request_id = _request_id(row)
    if not is_support(row):
        return {**tombstone_record(run, BOARDS_SOURCE, request_id, STORE_BOARDS, now),
                'feature_request_id': request_id, 'action': 'deidentified'}
    if not new_support_id:
        raise ValueError('a +1 tombstone names the re-keyed support id')
    return {**tombstone_record(run, BOARDS_SOURCE, new_support_id, STORE_BOARDS, now),
            'feature_request_id': request_id, 'support_id': new_support_id, 'action': 'deidentified'}


def job_tombstone(run: Mapping[str, Any], row: Mapping[str, Any], now: str, field: str = _CONTACT) -> dict[str, Any]:
    """This job's own record of a field it removed from a row (7.72.00): keyed by the row's request and a random token
    (``{request id}#{field}#{token}``: never a +1's own id, which derives from its supporter's address), the field, the
    request's id, the run and the legal basis only. A request's id tombstone is put only if new, so each erasure that
    changes a request also leaves this record of its own; a +1 whose contact alone matched gets one too. A page read
    again (a resumed or rerun job) writes one more."""
    request_id = _request_id(row)
    key = f"{request_id}#{field.split('_', 1)[0]}#{secrets.token_hex(8)}"
    return {**tombstone_record(run, BOARDS_SOURCE, key, STORE_BOARDS, now),
            'feature_request_id': request_id, 'field': field, 'action': 'deidentified'}


def _delete_folder(s3: Any, bucket: str, folder: str) -> int:
    """Every version under ``folder``; the files deleted."""
    deleted, more = 0, True
    while more:
        objects, more = retention.delete_raw_prefix_page(s3, bucket, folder)
        deleted += objects
    return deleted


def deidentify(table: Any, row: Mapping[str, Any]) -> bool:
    """REMOVE the reporter's email and name from a request row; False when the row is gone meanwhile."""
    return remove_fields(table, row, _REPORTER_FIELDS)


def _remove_request_contact(table: Any, row: Mapping[str, Any], spellings: Sequence[str]) -> bool:
    """REMOVE a request's ``fields.contact_email`` while it still holds one of ``spellings``; False when the row is
    gone, or its contact changed, meanwhile."""
    return remove_fields(table, row, (f'fields.{_CONTACT}',), holding=spellings)


def remove_fields(table: Any, row: Mapping[str, Any], fields: Sequence[str], holding: Sequence[str] = ()) -> bool:
    """REMOVE ``fields`` from the row at ``row``'s key (conditional on the row still being there, and with ``holding``
    on the one field still holding one of those values); False when it is gone, or changed, meanwhile. A field may be a
    path into a map (``fields.contact_email``, each part named on its own). Shared with the membership pass
    (``members.py``)."""
    names: dict[str, str] = {}
    paths = []
    for n, field in enumerate(fields):
        parts = field.split('.')
        placeholders = [f'#f{n}'] if len(parts) == 1 else [f'#f{n}_{m}' for m in range(len(parts))]
        names.update(zip(placeholders, parts, strict=True))
        paths.append('.'.join(placeholders))
    condition = 'attribute_exists(pk)'
    values: dict[str, Any] = {}
    if holding:
        values = {f':h{n}': value for n, value in enumerate(holding)}
        condition += f" AND {paths[0]} IN ({', '.join(values)})"
    try:
        table.update_item(
            Key={'pk': row['pk'], 'sk': row['sk']},
            UpdateExpression='REMOVE ' + ', '.join(paths),
            ConditionExpression=condition,
            ExpressionAttributeNames=names,
            **({'ExpressionAttributeValues': values} if values else {}),
        )
    except ClientError as e:
        if is_conditional_check_failure(e):
            return False
        raise
    return True


class BoardEraser:
    """Erases the person from the matched board rows of one page, counting into ``run``."""

    def __init__(self, run: dict[str, Any], tables: Mapping[str, Any], s3: Any, bucket: str, value: str = '') -> None:
        self._run = run
        self._table = tables[STORE_BOARDS]
        self._aggregates = tables['aggregates']
        self._s3 = s3
        self._bucket = bucket
        # The erased address as the filter matched it (``_spellings``): which of a row's fields holds it.
        self._wanted = frozenset(_spellings(value)) if value else frozenset()

    def matched(self, row: Mapping[str, Any]) -> tuple[bool, bool]:
        """Whether the row holds the address as the person's own (a +1's ``email``, a request's ``reporter_email``)
        and as its customer contact (``contact_email``); a row the eraser cannot tell (no value given) reads as the
        person's own, as before 7.72.00."""
        if not self._wanted:
            return True, False
        fields = row.get('fields')
        contact = row.get(_CONTACT) if is_support(row) else (fields.get(_CONTACT) if isinstance(fields, Mapping) else None)
        own = row.get('email' if is_support(row) else 'reporter_email')
        return own in self._wanted, contact in self._wanted

    def tombstones(self, rows: Sequence[Mapping[str, Any]]) -> None:
        """One tombstone per request row, one PutItem each, before any row changes (copies.write_tombstones'
        rule). A +1's is written in ``erase``, right before its re-key: its new id is decided there."""
        now = now_iso()
        for row in rows:
            own, contact = self.matched(row)
            if not is_support(row):
                # Put only if new (7.72.00): a later erasure that meets the request again never overwrites the first's
                # record (the lineage pass reads the key's existence alone); so each job also leaves its own record of
                # each field it removes, its legal basis with it.
                self._put_new(tombstone(self._run, row, now))
                if own and self._wanted:
                    self._aggregates.put_item(Item=job_tombstone(self._run, row, now, 'reporter_email'))
                if contact:
                    self._aggregates.put_item(Item=job_tombstone(self._run, row, now))
            elif not own:
                # A +1 that names the address as its contact only (7.72.00): this job's own record, which names no
                # +1 id, written before anything of the page changes, its raw copies included.
                self._aggregates.put_item(Item=job_tombstone(self._run, row, now))

    def _put_new(self, item: Mapping[str, Any]) -> None:
        try:
            self._aggregates.put_item(Item=dict(item), ConditionExpression='attribute_not_exists(pk)')
        except ClientError as e:
            if not is_conditional_check_failure(e):
                raise

    def erase(self, row: Mapping[str, Any]) -> None:
        """The row's raw copies (every version), then its email and name (a +1: re-keyed without them)."""
        folder = raw_folder(row)
        if folder is not None and self._bucket:
            self._run['deleted_objects'] += _delete_folder(self._s3, self._bucket, folder)
        if self._erase_row(row):
            self._run[BOARD_COUNTER] = int(self._run.get(BOARD_COUNTER) or 0) + 1
            note_erased_source(self._run, BOARDS_SOURCE)

    def _erase_row(self, row: Mapping[str, Any]) -> bool:
        own, contact = self.matched(row)
        if not is_support(row):
            changed = deidentify(self._table, row) if own else False
            # A request naming the address as its contact (7.72.00) loses that field only; its tombstone is the page's.
            return (_remove_request_contact(self._table, row, sorted(self._wanted)) if contact else False) or changed
        # Read first: a +1 removed since the scan gets no tombstone naming an id that is never stored. The
        # tombstone still precedes the change; the transaction's conditions cover the race left after the read.
        current = boards_rekey.current_support(self._table, _request_id(row), _item_id(row))
        if current is None:
            return False
        if not own:
            return self._erase_contact(current)
        support_id = boards_rekey.new_support_id()
        self._aggregates.put_item(Item=tombstone(self._run, current, now_iso(), support_id))
        also = {'also': frozenset({_CONTACT})} if contact else {}
        if not boards_rekey.rekey(self._table, current, support_id, **also):
            return False
        boards_rekey.recount(self._table, _request_id(row))
        return True

    def _erase_contact(self, current: Mapping[str, Any]) -> bool:
        """A +1 that names the address as its customer contact only (7.72.00): its ``contact_email`` REMOVEd, its id
        kept (it derives from the supporter's own address, not the contact's: the supporter is not erased), so its
        tombstone never names that id (anyone who knows the supporter's address could recompute it): it is keyed by the
        request and a random token (``job_tombstone``) and written with the page's, before its raw copies go
        (``tombstones``); then a promote of the request (shared/feature_requests_promote.py, which makes each +1's
        contact a participant) no longer finds the address. The REMOVE holds only while the field still holds a
        spelling of the address (a contact changed since the scan is left as it now is)."""
        return remove_fields(self._table, current, (_CONTACT,), holding=sorted(self._wanted))
