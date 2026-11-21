"""The Documents Library's items in voc-projects (docs/documents-library.md "Data model").

One scope's library (the deployment's, or one workspace's: shared/library_keys.py) holds at most ``MAX_ITEMS`` items.
An item row carries its metadata (``title``, ``slug``, ``source``, ``doc_date``, ``tags``, ``project_id``), the file
(``filename``, ``content_type``, ``format``, ``bytes``, ``sha256``, ``s3_key``), its extraction (``status``
``pending → extracting → ready | failed``, ``error``, ``extracted_chars``, ``pages``, ``chunks``, ``native``,
``truncated``), who made and last changed it (``created_by`` / ``updated_by``: ``{sub, name}``, with ``*_at``) and
``version``, which every metadata change raises and must name (``expected_version``, 409 when stale).

Every write goes through the scope's table view (shared/ingest_tables.py ``table_view``, shared/participants_tables.py
``transact``): a workspace's through its ``ws_table``, which refuses any key outside it. A create is one transaction:
the item, its slug's guard (``SLUG#{slug}``, so a slug names one item of the scope) and the scope's count (``META``,
``items`` below ``MAX_ITEMS``). A slug change moves the guard in the item's own transaction; a delete removes all
three together.

A library item is never feedback (TENETS.md tenet 1): nothing here writes voc-feedback, voc-aggregates or the
processing queue, and no metric, sentiment or category reads these rows.
"""
from __future__ import annotations

import re
import string
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Any, Final

from botocore.exceptions import ClientError

from shared.exceptions import ConflictError, NotFoundError, ValidationError
from shared.ids import timestamped_id
from shared.ingest_tables import table_view
from shared.library_extract import FORMATS, MAX_NATIVE_IMAGE_BYTES, MAX_UPLOAD_BYTES, format_of, is_native
from shared.library_keys import (
    ITEM_SK_PREFIX,
    SLUG_PATTERN,
    is_item_id,
    item_key,
    library_pk,
    original_key,
    slug_key,
)
from shared.participants_tables import cancellation_codes, transact
from shared.request_body import validated_text
from shared.timestamps import now_iso, parse_iso

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

__all__ = [
    'MAX_ITEMS', 'PUBLIC_FIELDS', 'Actor', 'create_item', 'delete_item_rows', 'get_item', 'list_items',
    'public_view', 'require_item', 'set_status', 'update_item', 'validate_new_item',
]

MAX_ITEMS: Final = 1000
MAX_TITLE_CHARS: Final = 200
MAX_SOURCE_CHARS: Final = 200
MAX_FILENAME_CHARS: Final = 255
MAX_TAGS: Final = 10
MAX_TAG_CHARS: Final = 40
#: The fields ``PUT`` may change (with ``expected_version``).
EDITABLE_FIELDS: Final = ('title', 'slug', 'source', 'doc_date', 'tags', 'project_id')
#: What a client is answered of an item (never ``pk``/``sk``, the object key or the extraction's claim token).
PUBLIC_FIELDS: Final = (
    'item_id', 'title', 'slug', 'source', 'doc_date', 'tags', 'project_id', 'filename', 'content_type', 'format',
    'bytes', 'sha256', 'status', 'error', 'extracted_chars', 'pages', 'chunks', 'native', 'truncated', 'method',
    'created_by', 'created_at', 'updated_by', 'updated_at', 'version',
)
#: An extraction this old (the twin's 15 minutes and a margin) is over, whatever its row still says: the item reads
#: ``stale`` and can be retried (library_routes.py ``retry_library_item``; the SPA stops polling it then).
STALE_EXTRACTION_SECONDS: Final = 16 * 60
_COUNT_SK: Final = 'META'
_SLUG_ATTEMPTS: Final = 5
_PROJECT_ID: Final = re.compile(r'[A-Za-z0-9_-]{1,128}')
FULL_LIBRARY: Final = f'This library holds {MAX_ITEMS} items, its most. Delete some first.'
SLUG_TAKEN: Final = 'Another library item already has this short name.'
STALE: Final = 'This item was changed since you opened it. Reload it and try again.'


@dataclass(frozen=True)
class Actor:
    """Who writes: the caller's sub and the name shown beside their items."""

    sub: str
    name: str

    def stored(self) -> dict[str, str]:
        return {'sub': self.sub, 'name': self.name}


# ── Validation ──────────────────────────────────────────────────────────────────────────────────────────────────


def slugify(text: str) -> str:
    """``Q3 Market Report.pdf`` → ``q3-market-report-pdf``: lower case, ASCII letters and digits, hyphens."""
    import unicodedata

    plain = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode('ascii').lower()
    slug = re.sub(r'[^a-z0-9]+', '-', plain).strip('-')[:64].strip('-')
    return slug or 'document'


def _slug(value: object) -> str:
    if not isinstance(value, str) or SLUG_PATTERN.fullmatch(value) is None:
        raise ValidationError('slug must be 1 to 64 lower-case letters, digits and hyphens, '
                              'starting and ending with a letter or digit')
    return value


def _tags(value: object) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_TAGS:
        raise ValidationError(f'tags must be a list of at most {MAX_TAGS}')
    tags: list[str] = []
    for raw in value:
        if not isinstance(raw, str):
            raise ValidationError('each tag must be text')
        tag = re.sub(r'\s+', ' ', raw).strip().lower()
        if len(tag) > MAX_TAG_CHARS:
            raise ValidationError(f'a tag is at most {MAX_TAG_CHARS} characters')
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def _doc_date(value: object) -> str:
    text = validated_text(value, 'doc_date', 10)
    if not text:
        return ''
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError as exc:
        raise ValidationError('doc_date must be a date (YYYY-MM-DD)') from exc


def _project_id(value: object) -> str:
    text = validated_text(value, 'project_id', 128)
    if text and _PROJECT_ID.fullmatch(text) is None:
        raise ValidationError('project_id is not a project id')
    return text


def _byte_count(value: object, content_type: str) -> int:
    """The declared size, a whole number of bytes within the cap (it is signed into the upload's URL)."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError('bytes must be the file size in bytes')
    image = content_type.startswith('image/')
    if not 1 <= value <= (MAX_NATIVE_IMAGE_BYTES if image else MAX_UPLOAD_BYTES):
        raise ValidationError('Images must be at most 3.75 MB' if image else 'Files must be at most 25 MB',
                              code='too_large')
    return value


@dataclass(frozen=True)
class NewItem:
    """A create's checked body."""

    title: str
    slug: str
    slug_given: bool
    source: str
    doc_date: str
    tags: list[str]
    project_id: str
    filename: str
    content_type: str
    size: int
    sha256: str


def _filename(value: object) -> str:
    name = validated_text(value, 'filename', 1024, required=True)
    name = re.sub(r'[\x00-\x1f\x7f/\\]+', '_', name).strip()
    return name[-MAX_FILENAME_CHARS:] or 'file'


def validate_new_item(body: Mapping[str, Any]) -> NewItem:
    """``POST /projects/library``'s body, checked; 400 (``unsupported_type`` / ``too_large``) before anything is
    written."""
    allowed = {'title', 'slug', 'source', 'doc_date', 'tags', 'project_id', 'filename', 'content_type', 'bytes',
               'sha256'}
    unknown = sorted(set(body) - allowed)
    if unknown:
        raise ValidationError(f"Unknown field(s): {', '.join(unknown)}")
    filename = _filename(body.get('filename'))
    content_type = validated_text(body.get('content_type'), 'content_type', 200, required=True).lower()
    if format_of(content_type) is None:
        raise ValidationError('This file type is not supported. Upload a PDF, Word, Excel, PowerPoint, CSV, HTML, '
                              'text or Markdown file, or a PNG, JPEG, GIF or WebP image.', code='unsupported_type')
    size = _byte_count(body.get('bytes'), content_type)
    title = validated_text(body.get('title'), 'title', MAX_TITLE_CHARS) or filename.rsplit('.', 1)[0][:MAX_TITLE_CHARS]
    slug_given = body.get('slug') not in (None, '')
    sha = validated_text(body.get('sha256'), 'sha256', 64).lower()
    if sha and (len(sha) != 64 or not set(sha) <= set(string.hexdigits.lower())):
        raise ValidationError('sha256 must be 64 hexadecimal characters')
    return NewItem(
        title=title or 'Untitled', slug=_slug(body.get('slug')) if slug_given else slugify(title),
        slug_given=slug_given, source=validated_text(body.get('source'), 'source', MAX_SOURCE_CHARS),
        doc_date=_doc_date(body.get('doc_date')), tags=_tags(body.get('tags')),
        project_id=_project_id(body.get('project_id')), filename=filename, content_type=content_type, size=size,
        sha256=sha,
    )


# ── Reads ───────────────────────────────────────────────────────────────────────────────────────────────────────


def extraction_is_over(item: Mapping[str, Any]) -> bool:
    """Whether the item is ``extracting`` since ``STALE_EXTRACTION_SECONDS`` or more (its worker cannot be running)."""
    started = parse_iso(item.get('extract_started_at'))
    return item.get('status') == 'extracting' and started is not None and (
        datetime.now(UTC) - started).total_seconds() >= STALE_EXTRACTION_SECONDS


def public_view(item: Mapping[str, Any]) -> dict[str, Any]:
    """An item as a client sees it (numbers as ints; ``stale`` when its extraction is over: ``extraction_is_over``)."""
    view: dict[str, Any] = {}
    for field in PUBLIC_FIELDS:
        value = item.get(field)
        if value is None:
            continue
        view[field] = int(value) if hasattr(value, 'as_integer_ratio') and not isinstance(value, bool | float) \
            else value
    view.setdefault('tags', [])
    if extraction_is_over(item):
        view['stale'] = True
    return view


def get_item(table: Any, scope: WorkspaceScope | None, item_id: str, *, consistent: bool = False) -> dict | None:
    if not is_item_id(item_id):
        return None
    item = table_view(scope, table).get_item(item_key(item_id, workspace=scope), ConsistentRead=consistent).get('Item')
    return item if isinstance(item, dict) else None


def require_item(table: Any, scope: WorkspaceScope | None, item_id: str, *, consistent: bool = False) -> dict:
    """The item, or the one 404 (an id of another scope, a malformed one and a deleted one look the same)."""
    item = get_item(table, scope, item_id, consistent=consistent)
    if item is None:
        raise NotFoundError('Library item not found')
    return item


def list_items(table: Any, scope: WorkspaceScope | None) -> list[dict]:
    """Every item row of the scope (at most ``MAX_ITEMS``, each a few hundred bytes), in creation order."""
    return list(table_view(scope, table).iter_query(
        'pk', library_pk(workspace=scope), sort_condition='begins_with(#sk, :sk)', max_items=MAX_ITEMS,
        ExpressionAttributeNames={'#sk': 'sk'}, ExpressionAttributeValues={':sk': ITEM_SK_PREFIX}))


# ── Writes ──────────────────────────────────────────────────────────────────────────────────────────────────────


def _count_entry(scope: WorkspaceScope | None, delta: int) -> dict[str, Any]:
    update: dict[str, Any] = {
        'Key': {'pk': library_pk(workspace=scope), 'sk': _COUNT_SK},
        'UpdateExpression': 'ADD #items :delta',
        'ExpressionAttributeNames': {'#items': 'items'},
        'ExpressionAttributeValues': {':delta': delta},
    }
    if delta > 0:
        update['ConditionExpression'] = 'attribute_not_exists(#items) OR #items < :cap'
        update['ExpressionAttributeValues'][':cap'] = MAX_ITEMS
    return {'Update': update}


def _slug_entry(scope: WorkspaceScope | None, slug: str, item_id: str) -> dict[str, Any]:
    return {'Put': {'Item': {**slug_key(slug, workspace=scope), 'item_id': item_id},
                    'ConditionExpression': 'attribute_not_exists(pk)'}}


def _new_row(scope: WorkspaceScope | None, item_id: str, new: NewItem, slug: str, actor: Actor) -> dict[str, Any]:
    fmt = FORMATS[new.content_type]
    now = now_iso()
    row: dict[str, Any] = {
        **item_key(item_id, workspace=scope), 'item_id': item_id, 'title': new.title, 'slug': slug,
        'source': new.source, 'doc_date': new.doc_date, 'tags': new.tags, 'filename': new.filename,
        'content_type': new.content_type, 'format': fmt.name, 'bytes': new.size,
        's3_key': original_key(item_id, workspace=scope), 'status': 'pending', 'extracted_chars': 0, 'chunks': 0,
        'native': is_native(fmt, new.size), 'created_by': actor.stored(), 'created_at': now,
        'updated_by': actor.stored(), 'updated_at': now, 'version': 1,
    }
    row.update({name: value for name, value in (('project_id', new.project_id), ('sha256', new.sha256)) if value})
    return row


def _refusal(error: ClientError) -> str | None:
    """Which entry of a create refused it: ``count`` (the library is full) or ``slug`` (taken), else None."""
    codes = cancellation_codes(error)
    if len(codes) >= 3 and codes[0] == 'ConditionalCheckFailed':
        return 'count'
    if len(codes) >= 3 and codes[1] == 'ConditionalCheckFailed':
        return 'slug'
    return None


def create_item(table: Any, scope: WorkspaceScope | None, new: NewItem, actor: Actor) -> dict[str, Any]:
    """Write a pending item (its slug guarded, the scope's count raised): the stored row. 409 ``slug_taken`` for a
    slug the person chose that another item has; a generated one takes the next free ``-2`` … ``-5``; 409
    ``library_full`` at ``MAX_ITEMS``."""
    item_id = timestamped_id('lib')
    attempts = 1 if new.slug_given else _SLUG_ATTEMPTS
    for attempt in range(attempts):
        slug = new.slug if attempt == 0 else f'{new.slug[:60]}-{attempt + 1}'
        row = _new_row(scope, item_id, new, slug, actor)
        try:
            transact(table, scope, [_count_entry(scope, 1), _slug_entry(scope, slug, item_id),
                                    {'Put': {'Item': row, 'ConditionExpression': 'attribute_not_exists(pk)'}}])
        except ClientError as exc:
            refusal = _refusal(exc)
            if refusal == 'count':
                raise ConflictError(FULL_LIBRARY, code='library_full') from exc
            if refusal == 'slug' and attempt + 1 < attempts:
                continue
            if refusal == 'slug':
                raise ConflictError(SLUG_TAKEN, code='slug_taken') from exc
            raise
        return row
    raise ConflictError(SLUG_TAKEN, code='slug_taken')  # pragma: no cover - the loop returns or raises


def _changes(body: Mapping[str, Any]) -> dict[str, Any]:
    changes: dict[str, Any] = {}
    readers = {
        'title': lambda value: validated_text(value, 'title', MAX_TITLE_CHARS, required=True),
        'slug': _slug, 'source': lambda value: validated_text(value, 'source', MAX_SOURCE_CHARS),
        'doc_date': _doc_date, 'tags': _tags, 'project_id': _project_id,
    }
    for name, read in readers.items():
        if name in body:
            changes[name] = read(body[name])
    return changes


def update_item(table: Any, scope: WorkspaceScope | None, item: Mapping[str, Any], body: Mapping[str, Any],
                actor: Actor) -> dict[str, Any]:
    """Apply a ``PUT``'s metadata to ``item`` when ``expected_version`` is its version (409 ``stale`` otherwise; 409
    ``slug_taken`` for a taken slug): the new row."""
    unknown = sorted(set(body) - {*EDITABLE_FIELDS, 'expected_version'})
    if unknown:
        raise ValidationError(f"Unknown field(s): {', '.join(unknown)}")
    expected = body.get('expected_version')
    if isinstance(expected, bool) or not isinstance(expected, int):
        raise ValidationError('expected_version is required: the version you opened')
    changes = _changes(body)
    if not changes:
        raise ValidationError(f"Give at least one of: {', '.join(EDITABLE_FIELDS)}")
    item_id = str(item['item_id'])
    now = now_iso()
    names = {f'#f{index}': name for index, name in enumerate(changes)}
    values: dict[str, Any] = {f':v{index}': value for index, value in enumerate(changes.values())}
    sets = [f'#f{index} = :v{index}' for index in range(len(changes))]
    names.update({'#version': 'version', '#ub': 'updated_by', '#ua': 'updated_at'})
    values.update({':expected': expected, ':one': 1, ':by': actor.stored(), ':at': now})
    update = {'Key': item_key(item_id, workspace=scope),
              'UpdateExpression': 'SET ' + ', '.join([*sets, '#ub = :by', '#ua = :at']) + ' ADD #version :one',
              'ConditionExpression': 'attribute_exists(pk) AND #version = :expected',
              'ExpressionAttributeNames': names, 'ExpressionAttributeValues': values}
    entries: list[dict[str, Any]] = [{'Update': update}]
    old_slug = str(item.get('slug') or '')
    moves_slug = 'slug' in changes and changes['slug'] != old_slug
    if moves_slug:
        entries += [_slug_entry(scope, changes['slug'], item_id),
                    {'Delete': {'Key': slug_key(old_slug, workspace=scope)}}]
    try:
        transact(table, scope, entries)
    except ClientError as exc:
        codes = cancellation_codes(exc)
        if codes and codes[0] == 'ConditionalCheckFailed':
            raise ConflictError(STALE, code='stale', details={'version': int(item.get('version') or 0)}) from exc
        if moves_slug and len(codes) > 1 and codes[1] == 'ConditionalCheckFailed':
            raise ConflictError(SLUG_TAKEN, code='slug_taken') from exc
        raise
    return {**item, **changes, 'updated_by': actor.stored(), 'updated_at': now, 'version': expected + 1}


def delete_item_rows(table: Any, scope: WorkspaceScope | None, item: Mapping[str, Any]) -> None:
    """Remove the item, its slug guard and its place in the count, in one transaction (404 when another delete was
    first)."""
    item_id = str(item['item_id'])
    slug = str(item.get('slug') or '')
    entries: list[dict[str, Any]] = [
        {'Delete': {'Key': item_key(item_id, workspace=scope), 'ConditionExpression': 'attribute_exists(pk)'}},
        _count_entry(scope, -1),
    ]
    if slug:
        entries.append({'Delete': {'Key': slug_key(slug, workspace=scope),
                                   'ConditionExpression': 'attribute_not_exists(pk) OR item_id = :id',
                                   'ExpressionAttributeValues': {':id': item_id}}})
    try:
        transact(table, scope, entries)
    except ClientError as exc:
        if cancellation_codes(exc)[:1] == ['ConditionalCheckFailed']:
            raise NotFoundError('Library item not found') from exc
        raise


def revoke_claim(table: Any, scope: WorkspaceScope | None, item_id: str) -> None:
    """Remove the item's extraction claim (a delete's first step): a run still in flight then finds its claim gone and
    drops what it wrote (library_worker.py). 404 when the item is gone."""
    try:
        table_view(scope, table).update_item(item_key(item_id, workspace=scope), UpdateExpression='REMOVE #tok',
                                             ConditionExpression='attribute_exists(pk)',
                                             ExpressionAttributeNames={'#tok': 'extract_token'})
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            raise NotFoundError('Library item not found') from exc
        raise


def set_status(table: Any, scope: WorkspaceScope | None, item_id: str, status: str, *,
               when: tuple[str, ...], fields: Mapping[str, Any] | None = None,
               remove: tuple[str, ...] = (), token: str | None = None) -> bool:
    """Move the item to ``status`` when it is in one of ``when`` (and, given ``token``, still claimed by it), with
    ``fields`` set and ``remove`` removed: True when it moved (False when the item is gone or elsewhere)."""
    sets = {'status': status, **(fields or {})}
    names = {f'#s{index}': name for index, name in enumerate(sets)}
    values: dict[str, Any] = {f':s{index}': value for index, value in enumerate(sets.values())}
    names['#st'] = 'status'
    values.update({f':w{index}': state for index, state in enumerate(when)})
    condition = f"attribute_exists(pk) AND #st IN ({', '.join(f':w{index}' for index in range(len(when)))})"
    if token is not None:
        names['#tok'] = 'extract_token'
        values[':tok'] = token
        condition += ' AND #tok = :tok'
    expression = 'SET ' + ', '.join(f'#s{index} = :s{index}' for index in range(len(sets)))
    if remove:
        names.update({f'#r{index}': name for index, name in enumerate(remove)})
        expression += ' REMOVE ' + ', '.join(f'#r{index}' for index in range(len(remove)))
    try:
        table_view(scope, table).update_item(item_key(item_id, workspace=scope), UpdateExpression=expression,
                                             ConditionExpression=condition, ExpressionAttributeNames=names,
                                             ExpressionAttributeValues=values)
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            return False
        raise
    return True

