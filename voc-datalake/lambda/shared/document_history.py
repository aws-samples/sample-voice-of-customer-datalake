"""Every document edit is a new version; earlier versions stay retrievable (QA s3 F4).

An edit used to overwrite the stored content in place — from the in-page editor
and from the assistant's ``update_document`` alike — so the previous text was gone
and nothing listed what a document had been. Two kinds of document, one rule:

* **Managed** (PRD, PR/FAQ; prototypes are revised through their own workflow):
  an edit allocates the next version of the document's series through
  ``persist_versioned_document`` — exactly what regeneration does — so it is a new
  row titled ``Base (vN+1)`` and every earlier version is still a row of its own.
  The allocation id is ``edit:{source_id}:{edit_id}``, so a retried request
  replays the version it already made instead of making another.
* **Unmanaged** (research, custom): there is no series, so the document keeps its
  id and the content it replaces is first saved as a revision row,
  ``REVISION#{document_id}#{n:06d}``, in the project's version partition (swept
  with the project). The snapshot and the update are one transaction, conditioned
  on the revision the caller read, so two concurrent edits cannot both win.

Restoring is an edit whose new content is the old version's: it never rewrites
history, it adds to it. An edit that changes nothing saves nothing.

**No clobbering across tabs.** The transaction above only stops two edits racing
inside one request; a second tab that loaded the document earlier used to save
straight over the first tab's edit (it became a version, but silently). An edit may
carry ``expected_revision`` — the revision it loaded (unmanaged: ``revision``, unset
= 1; managed: the ``version`` of the series head it edited) — and is refused with a
409 when the document moved on since. Absent, there is no check: the assistant's and
MCP's ``update_document`` send none, exactly as before.
"""
from __future__ import annotations

import hashlib
import re
from decimal import Decimal
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared.document_versions import (
    STALE_SERIES_MESSAGE,
    managed_document_type,
    normalize_document_versions,
    normalized_base_title,
    persist_versioned_document,
    split_versioned_title,
    version_partition_key,
)
from shared.exceptions import ConflictError, NotFoundError, ValidationError
from shared.project_writes import projects_table_name

REVISION_PREFIX = 'REVISION#'
# The versions a list shows, newest first. A document edited more often keeps
# every version; the list is the recent history, not an archive browser.
VERSION_LIST_LIMIT = 25
EDIT_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
UNMANAGED_VERSION_RE = re.compile(r'^r([1-9]\d{0,5})$')

EDIT_KIND_EDIT = 'edit'
EDIT_KIND_RESTORE = 'restore'
# One wording for both kinds of document (the managed series check lives in document_versions).
STALE_DOCUMENT_MESSAGE = STALE_SERIES_MESSAGE

# Fields of a stored managed document that describe THAT row, never a version
# derived from it; everything else (sources, lineage, feedback counts) carries.
# (content, timestamps, edit_kind and edited_from_id are always set afresh.)
_ROW_IDENTITY_FIELDS = frozenset({
    'pk', 'sk', 'document_id', 'title', 'base_title', 'version', 'version_allocation_id',
    'restored_from_id', 'restored_from_version',
})


def validated_edit_id(raw: object, content: str) -> str:
    """The caller's idempotency key for one save, or a digest of the content.

    The SPA sends a fresh id per save, so the same text saved twice on purpose is
    two versions while a retried request is one. Without one, the content stands in.
    """
    if raw is None:
        return hashlib.sha256(content.encode()).hexdigest()[:32]
    if not isinstance(raw, str) or not EDIT_ID_RE.fullmatch(raw):
        raise ValidationError('edit_id must be 1-64 letters, digits, "-" or "_"')
    return raw


def validated_expected_revision(raw: object) -> int | None:
    """The revision the caller loaded, or None (no stale-save check)."""
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 1:
        raise ValidationError('expected_revision must be the revision you loaded (a whole number ≥ 1)')
    return raw


def _content_of(body: dict, document: dict) -> str:
    if 'content' not in body:
        return str(document.get('content') or '')
    content = body['content']
    if not isinstance(content, str):
        raise ValidationError('content must be a string')
    return content


# ── Managed series ───────────────────────────────────────────────────────────

def _series_base(document: dict) -> str:
    base, _ = split_versioned_title(document.get('base_title') or document.get('title') or 'Untitled')
    return base


def _new_managed_version(table: Any, project_id: str, document_type: str, source: dict, content: str, *,
                         allocation_id: str, now: str, provenance: dict[str, Any],
                         expected_last_version: int | None = None) -> dict:
    fields = {key: value for key, value in source.items() if key not in _ROW_IDENTITY_FIELDS}
    fields.update({'content': content, 'created_at': now, 'updated_at': now, **provenance})
    return persist_versioned_document(table, project_id, document_type, _series_base(source), allocation_id, fields,
                                      expected_last_version=expected_last_version)


def _series_documents(table: Any, project_id: str, document: dict, document_type: str) -> list[dict]:
    """Every version of ``document``'s series, newest first (full rows, content included).

    ``normalize_document_versions`` gives every managed row a ``base_title`` and an
    int ``version`` and leaves every other row alone, which the type filter drops.
    """
    series = normalized_base_title(_series_base(document), document_type)
    rows: list[dict] = []
    query: dict[str, Any] = {'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}'), 'ConsistentRead': True}
    while True:
        page = table.query(**query)
        rows.extend(page.get('Items', []))
        if not page.get('LastEvaluatedKey'):
            break
        query['ExclusiveStartKey'] = page['LastEvaluatedKey']
    versions = [
        row for row in normalize_document_versions(rows)
        if managed_document_type(row) == document_type
        and normalized_base_title(row['base_title'], document_type) == series
    ]
    versions.sort(key=lambda row: row['version'], reverse=True)
    return versions


def _managed_version_view(row: dict, *, current: bool) -> dict:
    return {
        'version_id': row.get('document_id'), 'document_id': row.get('document_id'),
        'version': row['version'], 'title': row.get('title'),
        'content': row.get('content') or '', 'created_at': row.get('created_at'), 'current': current,
        'edit_kind': row.get('edit_kind'), 'restored_from_version': row.get('restored_from_version'),
    }


# ── Unmanaged revisions ──────────────────────────────────────────────────────

def _revision_of(document: dict) -> int:
    """The stored revision number; DynamoDB hands numbers back as Decimal. Unset, or not a whole number ≥ 1, is 1."""
    revision = document.get('revision')
    if not isinstance(revision, int | Decimal):
        return 1
    return max(int(revision), 1) if revision == int(revision) else 1


def _revision_key(project_id: str, document_id: str, revision: int) -> dict[str, str]:
    return {'pk': version_partition_key(project_id), 'sk': f'{REVISION_PREFIX}{document_id}#{revision:06d}'}


def _replace_unmanaged(table: Any, project_id: str, document: dict, *, content: str, title: str,
                       now: str, provenance: dict[str, Any]) -> dict:
    """Snapshot the current content as its revision, then write the new one (one transaction)."""
    document_id = str(document['document_id'])
    observed = _revision_of(document)
    snapshot = {
        **_revision_key(project_id, document_id, observed), 'document_id': document_id, 'revision': observed,
        'title': document.get('title') or '', 'content': document.get('content') or '',
        'saved_at': document.get('updated_at') or document.get('created_at'), 'replaced_at': now,
        'edit_kind': document.get('edit_kind'), 'restored_from_version': document.get('restored_from_version'),
    }
    sets = {'#content': ('content', content), '#title': ('title', title), '#updated': ('updated_at', now),
            '#revision': ('revision', observed + 1),
            '#kind': ('edit_kind', provenance['edit_kind']),
            '#restored': ('restored_from_version', provenance.get('restored_from_version'))}
    revision_condition = '#revision = :observed' if 'revision' in document else 'attribute_not_exists(#revision)'
    values = {f':v{n}': value for n, (_, value) in enumerate(sets.values())}
    table_name = projects_table_name(table)
    try:
        table.meta.client.transact_write_items(TransactItems=[
            {'Put': {'TableName': table_name, 'Item': snapshot,
                     'ConditionExpression': 'attribute_not_exists(pk) AND attribute_not_exists(sk)'}},
            {'Update': {
                'TableName': table_name, 'Key': {'pk': document['pk'], 'sk': document['sk']},
                'UpdateExpression': 'SET ' + ', '.join(f'{name} = :v{n}' for n, name in enumerate(sets)),
                'ConditionExpression': f'attribute_exists(pk) AND document_id = :document_id AND {revision_condition}',
                'ExpressionAttributeNames': {name: attribute for name, (attribute, _) in sets.items()},
                'ExpressionAttributeValues': {**values, ':document_id': document_id,
                                              **({':observed': observed} if 'revision' in document else {})},
            }},
        ])
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
            raise ConflictError(STALE_DOCUMENT_MESSAGE) from error
        raise
    return {**document, 'content': content, 'title': title, 'updated_at': now, 'revision': observed + 1,
            **provenance}


def _revision_rows(table: Any, project_id: str, document_id: str, limit: int) -> list[dict]:
    page = table.query(
        KeyConditionExpression=Key('pk').eq(version_partition_key(project_id))
        & Key('sk').begins_with(f'{REVISION_PREFIX}{document_id}#'),
        ScanIndexForward=False, Limit=limit, ConsistentRead=True,
    )
    return list(page.get('Items', []))


def _unmanaged_version_view(row: dict, revision: int, *, current: bool, created_at: object) -> dict:
    return {
        'version_id': f'r{revision}', 'document_id': row.get('document_id'), 'version': revision,
        'title': row.get('title'), 'content': row.get('content') or '', 'created_at': created_at,
        'current': current, 'edit_kind': row.get('edit_kind'),
        'restored_from_version': row.get('restored_from_version'),
    }


# ── Public operations ────────────────────────────────────────────────────────

def edit_document(table: Any, project_id: str, document: dict, body: dict, *, now: str,
                  title: str | None = None) -> dict:
    """Apply an edit as a new version. ``title`` is the new title of an UNMANAGED document.

    ``body['expected_revision']`` (optional) is the revision the caller loaded; a
    document that moved on since is a ConflictError (409), never a silent overwrite.
    Checked after the no-change return: an edit that saves nothing clobbers nothing.
    """
    expected = validated_expected_revision(body.get('expected_revision'))
    content = _content_of(body, document)
    new_title = title if title is not None else str(document.get('title') or '')
    if content == (document.get('content') or '') and new_title == (document.get('title') or ''):
        return {'success': True, 'unchanged': True, 'document': document}
    provenance = {'edit_kind': EDIT_KIND_EDIT}
    document_type = managed_document_type(document)
    if document_type is not None:
        allocation_id = f"edit:{document['document_id']}:{validated_edit_id(body.get('edit_id'), content)}"
        item = _new_managed_version(table, project_id, document_type, document, content, allocation_id=allocation_id,
                                    now=now, provenance={**provenance, 'edited_from_id': document['document_id']},
                                    expected_last_version=expected)
        return {'success': True, 'document': item}
    # Validated for one contract across both kinds; an unmanaged edit is idempotent by
    # content already (a replayed save finds the text unchanged and saves nothing).
    validated_edit_id(body.get('edit_id'), content)
    # The transaction in _replace_unmanaged is conditioned on this same revision, so a
    # save landing between this read and that write is refused too.
    if expected is not None and expected != _revision_of(document):
        raise ConflictError(STALE_DOCUMENT_MESSAGE)
    item = _replace_unmanaged(table, project_id, document, content=content, title=new_title, now=now,
                              provenance=provenance)
    return {'success': True, 'document': item}


def list_document_versions(table: Any, project_id: str, document: dict) -> dict:
    """The document's versions, newest first, each with its content."""
    document_type = managed_document_type(document)
    if document_type is not None:
        series = _series_documents(table, project_id, document, document_type)[:VERSION_LIST_LIMIT]
        versions = [_managed_version_view(row, current=index == 0) for index, row in enumerate(series)]
        return {'managed': True, 'versions': versions}
    current = _revision_of(document)
    versions = [_unmanaged_version_view(document, current, current=True,
                                        created_at=document.get('updated_at') or document.get('created_at'))]
    for row in _revision_rows(table, project_id, str(document['document_id']), VERSION_LIST_LIMIT - 1):
        versions.append(_unmanaged_version_view(row, _revision_of(row), current=False, created_at=row.get('saved_at')))
    return {'managed': False, 'versions': versions}


def restore_document_version(table: Any, project_id: str, document: dict, version_id: str, body: dict, *,
                             now: str) -> dict:
    """A NEW version carrying ``version_id``'s content (history is added to, never rewritten)."""
    document_type = managed_document_type(document)
    if document_type == 'prototype':
        raise ValidationError('Prototypes are restored through the prototype revision workflow')
    if document_type is not None:
        return _restore_managed(table, project_id, document_type, document, version_id, body, now=now)
    return _restore_unmanaged(table, project_id, document, version_id, now=now)


def _restore_managed(table: Any, project_id: str, document_type: str, document: dict, version_id: str,
                     body: dict, *, now: str) -> dict:
    series = _series_documents(table, project_id, document, document_type)
    source = next((row for row in series if row.get('document_id') == version_id), None)
    if source is None:
        raise NotFoundError('Version not found')
    latest = series[0]
    content = str(source.get('content') or '')
    if content == (latest.get('content') or ''):
        return {'success': True, 'unchanged': True, 'document': latest}
    allocation_id = f"restore:{version_id}:{validated_edit_id(body.get('edit_id'), content)}"
    item = _new_managed_version(table, project_id, document_type, latest, content, allocation_id=allocation_id,
                                now=now,
                                provenance={'edit_kind': EDIT_KIND_RESTORE, 'edited_from_id': latest['document_id'],
                                            'restored_from_id': version_id,
                                            'restored_from_version': source['version']})
    return {'success': True, 'document': item}


def _restore_unmanaged(table: Any, project_id: str, document: dict, version_id: str, *, now: str) -> dict:
    match = UNMANAGED_VERSION_RE.fullmatch(version_id)
    if match is None:
        raise NotFoundError('Version not found')
    revision = int(match.group(1))
    if revision == _revision_of(document):
        return {'success': True, 'unchanged': True, 'document': document}
    row = table.get_item(Key=_revision_key(project_id, str(document['document_id']), revision),
                         ConsistentRead=True).get('Item')
    if not row:
        raise NotFoundError('Version not found')
    item = _replace_unmanaged(table, project_id, document, content=str(row.get('content') or ''),
                              title=str(row.get('title') or document.get('title') or ''), now=now,
                              provenance={'edit_kind': EDIT_KIND_RESTORE, 'restored_from_version': revision})
    return {'success': True, 'document': item}


def delete_document_revisions(table: Any, project_id: str, document_id: str) -> None:
    """Remove an unmanaged document's saved revisions (its own rows only)."""
    query: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(version_partition_key(project_id))
        & Key('sk').begins_with(f'{REVISION_PREFIX}{document_id}#'),
        'ProjectionExpression': 'pk, sk', 'ConsistentRead': True,
    }
    with table.batch_writer() as batch:
        while True:
            page = table.query(**query)
            for item in page.get('Items', []):
                batch.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
            if not page.get('LastEvaluatedKey'):
                return
            query['ExclusiveStartKey'] = page['LastEvaluatedKey']
