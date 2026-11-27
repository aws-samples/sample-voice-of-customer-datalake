"""The Documents Library's routes (docs/documents-library.md), included by ``api/projects_handler.py``.

    GET    /projects/library?q=&tag=&project_id=&sort=&cursor=&limit=   the list (viewers and up)
    GET    /projects/library/suggest?q=                                 at most 8 ready items, for the composer's ``#``
    POST   /projects/library                                            201 {item, upload}: a pending item and its PUT
    POST   /projects/library/context                                    what the assistant is given (native or passages)
    GET    /projects/library/{id}                                       {item, preview: {text_excerpt, original_url}}
    GET    /projects/library/{id}/text?page=                            one page (or part) of the extracted text
    PUT    /projects/library/{id}                                       metadata, with expected_version (409 when stale)
    DELETE /projects/library/{id}                                       an admin or the uploader
    POST   /projects/library/{id}/uploaded                              202: the upload landed, extraction starts
    POST   /projects/library/{id}/retry                                 202: extract a failed item again

Every route rides the projects API's own ``/projects/{proxy+}`` (no API Gateway resource; ``library`` is one of
shared/project_access.py ``NON_PROJECT_SEGMENTS``, as ``prioritization`` is, so the per-project gate skips it and
these routes decide access themselves).

Scope: the workspace the request names (``X-Workspace-Id``, resolved by shared/request_workspace.py, from the table
for a write), else the deployment's library. A member of another workspace, a malformed id and a deleted item all get
the one 404. Roles: every member (viewers too) reads and asks the assistant about an item; an editor or an admin
uploads, edits and retries; an admin of the scope (the deployment's ``admins`` group, acting for themselves, outside
a workspace) or the person who uploaded it (while they still write there) deletes. A library item is never feedback.
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Final

from aws_lambda_powertools.event_handler import Response, content_types
from aws_lambda_powertools.event_handler.api_gateway import Router

from shared import library_store as store
from shared.api import decimal_default
from shared.audit_rows import put_new_audit_row
from shared.aws import invoke_lambda_async
from shared.delete_audit import actor_from_event, record_delete
from shared.exceptions import (
    AuthorizationError,
    ConflictError,
    ServiceError,
    ServiceUnavailableError,
    ValidationError,
)
from shared.ingest_tables import table_view
from shared.library_extract import PAGE_BREAK
from shared.library_index import MAX_PASSAGE_CHARS, delete_chunks, retrieve
from shared.library_keys import SLUG_PATTERN, slug_key
from shared.library_objects import LibraryObjects
from shared.library_worker import EXTRACT_ACTION
from shared.logging import logger, tracer
from shared.project_access import LEVEL_VIEW, claim_text, claims_from_event
from shared.project_gate import acts_as_admin, caller_from_event, read_gate_meta, require_project_level
from shared.request_body import json_object_body, validated_text
from shared.request_workspace import request_workspace
from shared.tables import configured_table, get_projects_table, get_workspaces_table
from shared.timestamps import now_iso
from shared.workspace import EDITING_ROLES, audit_key, audit_sort_key
from shared.workspace_routing import workspace_payload
from shared.ws_repo import optional_scope

if TYPE_CHECKING:
    from shared.project_access import Caller
    from shared.workspace import WorkspaceContext
    from shared.ws_repo import WorkspaceScope

__all__ = ['app']

app = Router()

DELETE_KIND: Final = 'library_item'
MAX_SUGGESTIONS: Final = 8
#: Items one context request names: 3 a message, a few more for an MCP client's or the assistant's search.
MAX_CONTEXT_ITEMS: Final = 5
MAX_NATIVE_SLOTS: Final = 3
MAX_QUERY_CHARS: Final = 2000
DEFAULT_PAGE_SIZE: Final = 50
MAX_PAGE_SIZE: Final = 100
#: A part of a text without pages, as ``GET …/text`` answers it.
TEXT_PART_CHARS: Final = 20_000
EXCERPT_CHARS: Final = 2000
#: The extracted text a read loads at most (``MAX_TEXT_CHARS`` of UTF-8, with room for wide characters).
MAX_TEXT_BYTES: Final = 13 * 1024 * 1024
FAILED_WORKSPACE: Final = 'Failed to open the library'
NEEDS_AN_EDITOR: Final = 'Adding or changing library items needs the editor or admin role in this workspace'
DELETE_REFUSED: Final = 'Only an admin or the person who uploaded it can delete this item'
NOT_IN_A_WORKSPACE: Final = 'Linking a library item to a project is not available in a workspace yet.'
_SORTS: Final = ('newest', 'oldest', 'title', 'doc_date')
_WORD: Final = re.compile(r'[\w-]{3,}', re.UNICODE)


# ── The request's scope, caller and table ───────────────────────────────────────────────────────────────────────


def _table() -> Any:
    return configured_table(get_projects_table(), 'Projects')


def _event() -> dict:
    return app.current_event.raw_event


def _context(*, write: bool) -> WorkspaceContext | None:
    """The workspace the request names, as its member (a platform admin who is not one gets the one 404, as for the
    assistant's conversations: no live Cognito check, which the projects role has no grant for); fresh for a write."""
    return request_workspace(_event(), FAILED_WORKSPACE, fresh=write, elevate=False)


def _caller() -> Caller:
    return caller_from_event(_event())


def _actor(caller: Caller) -> store.Actor:
    # Never the address (as document_review_routes._member_author): an invited member has no `name` claim, and the
    # stored created_by / updated_by is shown to every reader of the library and kept until the item is deleted.
    name = claim_text(claims_from_event(_event()), 'name') or caller.username
    return store.Actor(caller.subject, name.strip()[:200])


def _require_writer(context: WorkspaceContext | None) -> None:
    if context is not None and context.role not in EDITING_ROLES:
        raise AuthorizationError(NEEDS_AN_EDITOR)


def _params() -> dict[str, str]:
    return dict(app.current_event.query_string_parameters or {})


def _answer(status: int, body: Mapping[str, Any]) -> Response:
    return Response(status_code=status, content_type=content_types.APPLICATION_JSON,
                    body=json.dumps(body, default=decimal_default))


def _check_project(project_id: str, scope: WorkspaceScope | None, caller: Caller) -> None:
    """A project link names a project the caller can see (deployment-wide only: projects are not per workspace)."""
    if not project_id:
        return
    if scope is not None:
        raise ValidationError(NOT_IN_A_WORKSPACE)
    require_project_level(lambda: read_gate_meta(_table(), project_id, workspace=scope), caller, LEVEL_VIEW,
                          workspace=scope)


# ── The list and the composer's suggestions ─────────────────────────────────────────────────────────────────────


def _matches(item: Mapping[str, Any], needle: str) -> bool:
    haystack = ' '.join(str(item.get(field) or '') for field in ('title', 'slug', 'source', 'filename'))
    return needle in f"{haystack} {' '.join(item.get('tags') or [])}".lower()


def _sorted(items: list[dict], sort: str) -> list[dict]:
    if sort == 'oldest':
        return sorted(items, key=lambda item: str(item.get('created_at') or ''))
    if sort == 'title':
        return sorted(items, key=lambda item: str(item.get('title') or '').lower())
    if sort == 'doc_date':
        return sorted(items, key=lambda item: str(item.get('doc_date') or ''), reverse=True)
    return sorted(items, key=lambda item: str(item.get('created_at') or ''), reverse=True)


def _int_param(params: Mapping[str, str], name: str, default: int, high: int) -> int:
    value = params.get(name, '')
    if not value:
        return default
    if not value.isdigit() or int(value) > high:
        raise ValidationError(f'{name} must be a whole number from 0 to {high}')
    return int(value)


@app.get('/projects/library')
@tracer.capture_method
def list_library():
    """The scope's items, filtered (``q`` in the title, slug, source, file name and tags; ``tag``; ``project_id``),
    sorted (``sort``: newest, oldest, title, doc_date) and paged (``cursor``, ``limit``); with every tag in use."""
    context = _context(write=False)
    scope = optional_scope(context)
    params = _params()
    sort = params.get('sort') or 'newest'
    if sort not in _SORTS:
        raise ValidationError(f"sort must be one of: {', '.join(_SORTS)}")
    items = store.list_items(_table(), scope)
    tags = sorted({tag for item in items for tag in item.get('tags') or []})
    needle = params.get('q', '').strip().lower()[:200]
    tag = params.get('tag', '').strip().lower()
    project_id = params.get('project_id', '').strip()
    shown = [item for item in items if (not needle or _matches(item, needle))
             and (not tag or tag in (item.get('tags') or [])) and (not project_id or item.get('project_id') == project_id)]
    start = _int_param(params, 'cursor', 0, store.MAX_ITEMS)
    limit = _int_param(params, 'limit', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE) or DEFAULT_PAGE_SIZE
    page = _sorted(shown, sort)[start:start + limit]
    following = start + limit
    return {'items': [store.public_view(item) for item in page], 'total': len(shown), 'tags': tags,
            'next_cursor': str(following) if following < len(shown) else None}


def _suggestion(item: Mapping[str, Any]) -> dict[str, Any]:
    view = store.public_view(item)
    return {name: view[name] for name in ('item_id', 'slug', 'title', 'format', 'bytes', 'native', 'chunks',
                                          'pages', 'extracted_chars', 'project_id', 'updated_at') if name in view}


@app.get('/projects/library/suggest')
@tracer.capture_method
def suggest_library():
    """At most ``MAX_SUGGESTIONS`` ready items for the composer's ``#`` (a slug that starts with ``q`` first, then any
    match, newest first)."""
    context = _context(write=False)
    scope = optional_scope(context)
    needle = _params().get('q', '').strip().lower()[:64]
    ready = [item for item in store.list_items(_table(), scope) if item.get('status') == 'ready']
    newest = _sorted([item for item in ready if not needle or _matches(item, needle)], 'newest')
    newest.sort(key=lambda item: not str(item.get('slug') or '').startswith(needle))
    return {'items': [_suggestion(item) for item in newest[:MAX_SUGGESTIONS]]}


# ── Create and upload ───────────────────────────────────────────────────────────────────────────────────────────


@app.post('/projects/library')
@tracer.capture_method
def create_library_item():
    """A pending item and its upload: ``{item, upload: {url, headers, expires_in}}`` (201). The browser PUTs the file
    to ``url`` with exactly ``headers`` (its length and type are signed, so another file is refused, and a second PUT
    too: ``If-None-Match: *``), then calls ``…/uploaded``."""
    context = _context(write=True)
    _require_writer(context)
    scope = optional_scope(context)
    caller = _caller()
    new = store.validate_new_item(json_object_body(app))
    _check_project(new.project_id, scope, caller)
    row = store.create_item(_table(), scope, new, _actor(caller))
    upload = LibraryObjects(scope).upload_url(str(row['item_id']), content_type=new.content_type, length=new.size)
    return _answer(201, {'item': store.public_view(row), 'upload': upload})


def _invoke_worker(function: str, payload: dict[str, Any]) -> None:
    if not function:
        raise ServiceError('The extraction worker is not configured')
    invoke_lambda_async(function, payload)


def _start_extraction(scope: WorkspaceScope | None, context: WorkspaceContext | None, item: Mapping[str, Any],
                      *, when: tuple[str, ...]) -> Response:
    """Claim the item for a new extraction (``when`` it is in one of those states) and hand it to the twin: 202 with
    the item, or 409 when another request moved it first."""
    import secrets

    from shared.assist_jobs import worker_function

    item_id = str(item['item_id'])
    token = secrets.token_hex(8)
    now = now_iso()
    if not store.set_status(_table(), scope, item_id, 'extracting', when=when,
                            fields={'extract_token': token, 'extract_started_at': now, 'updated_at': now},
                            remove=('error',)):
        raise ConflictError('This item changed meanwhile. Reload it.', code='stale')
    function = worker_function()
    try:
        _invoke_worker(function, workspace_payload({'action': EXTRACT_ACTION, 'item_id': item_id, 'token': token},
                                                   context))
    except Exception as exc:
        logger.exception('The library extraction could not be started')
        store.set_status(_table(), scope, item_id, 'failed', when=('extracting',), token=token,
                         fields={'error': 'The extraction could not be started. Try again.'})
        raise ServiceError('The extraction could not be started. Try again.') from exc
    fresh = store.require_item(_table(), scope, item_id, consistent=True)
    return _answer(202, {'item': store.public_view(fresh)})


@app.post('/projects/library/<item_id>/uploaded')
@tracer.capture_method
def library_item_uploaded(item_id: str):
    """The browser's PUT landed: the object is checked (its length and type are the item's) and the extraction starts
    (202). Idempotent: an item already extracting or ready answers as it is (202)."""
    context = _context(write=True)
    _require_writer(context)
    scope = optional_scope(context)
    item = store.require_item(_table(), scope, item_id, consistent=True)
    if item.get('status') != 'pending':
        return _answer(202, {'item': store.public_view(item)})
    head = LibraryObjects(scope).head(item_id)
    if head is None:
        raise ConflictError('The file has not arrived yet. Upload it again.', code='not_uploaded')
    if head['length'] != int(item.get('bytes') or 0) or head['content_type'] != item.get('content_type'):
        raise ConflictError('The uploaded file is not the one announced. Upload it again.', code='upload_mismatch')
    return _start_extraction(scope, context, item, when=('pending',))


@app.post('/projects/library/<item_id>/retry')
@tracer.capture_method
def retry_library_item(item_id: str):
    """Extract a failed item again, or one whose extraction outlived the worker (``stale``: 16 minutes or more since it
    started, library_store.py ``extraction_is_over``): 202, else 409 ``not_failed``."""
    context = _context(write=True)
    _require_writer(context)
    scope = optional_scope(context)
    item = store.require_item(_table(), scope, item_id, consistent=True)
    status = item.get('status')
    if status == 'failed' and LibraryObjects(scope).head(item_id) is None:
        raise ConflictError('The file never arrived. Delete this item and upload it again.', code='not_uploaded')
    if status == 'failed' or store.extraction_is_over(item):
        return _start_extraction(scope, context, item, when=(str(status),))
    raise ConflictError('Only a failed item can be extracted again.', code='not_failed')


# ── Read one ────────────────────────────────────────────────────────────────────────────────────────────────────


def _text_parts(item: Mapping[str, Any], text: str) -> list[str]:
    if item.get('pages'):
        return text.split(PAGE_BREAK)
    return [text[start:start + TEXT_PART_CHARS] for start in range(0, len(text), TEXT_PART_CHARS)] or ['']


@app.get('/projects/library/<item_id>')
@tracer.capture_method
def get_library_item(item_id: str):
    """One item, its text's first ``EXCERPT_CHARS`` and a 5-minute link to the original."""
    context = _context(write=False)
    scope = optional_scope(context)
    item = store.require_item(_table(), scope, item_id)
    objects = LibraryObjects(scope)
    preview: dict[str, Any] = {'text_excerpt': '', 'text_parts': 0, 'original_url': None}
    if item.get('status') == 'ready':
        text = objects.read_text(item_id, max_bytes=MAX_TEXT_BYTES) or ''
        preview.update(text_excerpt=text[:EXCERPT_CHARS], text_parts=len(_text_parts(item, text)))
    if item.get('status') != 'pending':
        preview['original_url'] = objects.download_url(item_id, filename=str(item.get('filename') or 'file'),
                                                       content_type=str(item.get('content_type')))
    return {'item': store.public_view(item), 'preview': preview}


@app.get('/projects/library/<item_id>/text')
@tracer.capture_method
def get_library_text(item_id: str):
    """``page`` (from 1) of the extracted text: a PDF's page, a slide, else a part of ``TEXT_PART_CHARS``."""
    context = _context(write=False)
    scope = optional_scope(context)
    item = store.require_item(_table(), scope, item_id)
    if item.get('status') != 'ready':
        raise ConflictError('This item has no text yet.', code='not_ready')
    text = LibraryObjects(scope).read_text(item_id, max_bytes=MAX_TEXT_BYTES) or ''
    parts = _text_parts(item, text)
    page = _int_param(_params(), 'page', 1, len(parts)) or 1
    return {'item_id': item_id, 'page': page, 'parts': len(parts), 'paged': bool(item.get('pages')),
            'text': parts[page - 1]}


# ── Change and delete ───────────────────────────────────────────────────────────────────────────────────────────


@app.put('/projects/library/<item_id>')
@tracer.capture_method
def update_library_item(item_id: str):
    """Change an item's metadata (``title``, ``slug``, ``source``, ``doc_date``, ``tags``, ``project_id``) with the
    ``expected_version`` it was read at: ``{item}``, or 409 ``stale`` / ``slug_taken``."""
    context = _context(write=True)
    _require_writer(context)
    scope = optional_scope(context)
    caller = _caller()
    item = store.require_item(_table(), scope, item_id, consistent=True)
    body = json_object_body(app)
    if 'project_id' in body:
        _check_project(validated_text(body.get('project_id'), 'project_id', 128), scope, caller)
    return {'item': store.public_view(store.update_item(_table(), scope, item, body, _actor(caller)))}


def _may_delete(context: WorkspaceContext | None, caller: Caller, item: Mapping[str, Any]) -> bool:
    if caller.delegated:
        return False
    uploader = (item.get('created_by') or {}).get('sub')
    if context is None:
        return acts_as_admin(caller) or uploader == caller.subject
    return context.role == 'admin' or (uploader == caller.subject and context.role in EDITING_ROLES)


def _record_delete(scope: WorkspaceScope | None, item: Mapping[str, Any]) -> None:
    """``AUDIT#delete`` (voc-projects) for the deployment's item, ``AUDIT#WS#{ws}`` (voc-workspaces) for a
    workspace's, kind ``library_item``, with the actor and the item (its id and short name, never its text)."""
    target = {'item_id': str(item['item_id']), 'slug': str(item.get('slug') or '')}
    if scope is None:
        record_delete(_table(), kind=DELETE_KIND, target=target, actor=actor_from_event(_event()))
        return
    at = now_iso()
    put_new_audit_row(configured_table(get_workspaces_table(), 'Workspaces'), {
        'pk': audit_key(scope.ws), 'sk': audit_sort_key(at), 'kind': DELETE_KIND,
        'actor': actor_from_event(_event()), 'target': target, 'at': at})


@app.delete('/projects/library/<item_id>')
@tracer.capture_method
def delete_library_item(item_id: str):
    """Delete an item for good, recorded: its extraction's claim first (a run in flight then drops what it writes), its
    passages and every version of its objects next, its row, slug and count last, so a delete that fails part way
    leaves the item to delete again rather than passages or files no item names (a version the bucket refused to
    delete is a 503 before the rows go)."""
    context = _context(write=True)
    scope = optional_scope(context)
    caller = _caller()
    item = store.require_item(_table(), scope, item_id, consistent=True)
    if not _may_delete(context, caller, item):
        raise AuthorizationError(DELETE_REFUSED)
    store.revoke_claim(_table(), scope, item_id)
    delete_chunks(_table(), scope, item_id)
    refused = LibraryObjects(scope).delete_item(item_id)
    if refused:
        # (7.66.00: the rows stay, so the item is there to delete again: never files that no item names)
        logger.warning('Some versions of a deleted library item were refused', extra={'refused': refused})
        raise ServiceUnavailableError('Some of the file could not be deleted yet. Delete the item again.')
    store.delete_item_rows(_table(), scope, item)
    _record_delete(scope, item)
    return {'success': True, 'deleted': item_id}


# ── What the assistant is given ─────────────────────────────────────────────────────────────────────────────────


def _strings(body: Mapping[str, Any], field: str) -> list[str]:
    """``body[field]``: none when absent or null, else a list of at most ``MAX_CONTEXT_ITEMS`` strings, each once."""
    listed = body.get(field)
    listed = [] if listed is None else listed
    if isinstance(listed, list) and len(listed) <= MAX_CONTEXT_ITEMS and all(isinstance(v, str) for v in listed):
        return list(dict.fromkeys(listed))
    raise ValidationError(f'{field} must be a list of at most {MAX_CONTEXT_ITEMS} strings')


def _by_slug(scope: WorkspaceScope | None, slug: str) -> dict | None:
    """The item a slug names in the scope (its guard row), or None."""
    guard = table_view(scope, _table()).get_item(slug_key(slug, workspace=scope)).get('Item')
    item_id = guard.get('item_id') if isinstance(guard, dict) else None
    return store.get_item(_table(), scope, item_id) if isinstance(item_id, str) else None


def _found_by_words(scope: WorkspaceScope | None, query: str) -> list[dict]:
    """Without ids: the (at most 3) ready items whose metadata shares the most words with ``query``."""
    words = {word.lower() for word in _WORD.findall(query)}
    scored = []
    for item in store.list_items(_table(), scope):
        if item.get('status') != 'ready' or not words:
            continue
        score = sum(1 for word in words if _matches(item, word))
        if score:
            scored.append((score, str(item.get('created_at') or ''), item))
    scored.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
    return [item for _score, _at, item in scored[:MAX_NATIVE_SLOTS]]


def _brief(item: Mapping[str, Any]) -> dict[str, Any]:
    view = store.public_view(item)
    return {name: view[name] for name in ('item_id', 'slug', 'title', 'source', 'doc_date', 'format', 'pages',
                                          'chunks', 'status', 'native', 'bytes') if name in view}


def _native_entry(objects: LibraryObjects, item: Mapping[str, Any]) -> dict[str, Any]:
    item_id = str(item['item_id'])
    kind = 'image' if str(item.get('content_type') or '').startswith('image/') else 'document'
    return {'item_id': item_id, 'slug': item.get('slug'), 'format': item.get('format'), 'kind': kind,
            'bytes': int(item.get('bytes') or 0),
            'url': objects.download_url(item_id, filename=str(item.get('filename') or 'file'),
                                        content_type=str(item.get('content_type')))}


@app.post('/projects/library/context')
@tracer.capture_method
def library_context():
    """``{item_ids?, slugs?, query, native_slots?, budget?}`` → ``{items, native, passages, missing, pending}``, read with the
    caller's own access: the stream Lambda's and an MCP client's way into the library.

    Up to ``native_slots`` ready items that Converse takes as they are (a document of at most 4.5 MB in a native
    format, an image of at most 3.75 MB; never a scanned PDF: ``library_store.sent_as_a_file``) come back as a
    5-minute presigned GET (``native``; never the bytes: a synchronous Lambda answer is capped at 6 MB); the others are searched for ``query`` (``passages``, the best 8 in at
    most ``budget`` characters). Without ``item_ids`` the items are the ready ones whose title, slug, tags or source
    share the most words with ``query``. ``missing`` counts the ids the scope does not hold (never naming them: another
    workspace's id and one that exists nowhere answer alike); one not ready is in ``pending``."""
    context = _context(write=False)
    scope = optional_scope(context)
    body = json_object_body(app)
    query = validated_text(body.get('query'), 'query', MAX_QUERY_CHARS)
    ids = _strings(body, 'item_ids')
    slots = body.get('native_slots', 0)
    budget = body.get('budget', MAX_PASSAGE_CHARS)
    if isinstance(slots, bool) or not isinstance(slots, int) or not 0 <= slots <= MAX_NATIVE_SLOTS:
        raise ValidationError(f'native_slots must be a whole number from 0 to {MAX_NATIVE_SLOTS}')
    if isinstance(budget, bool) or not isinstance(budget, int) or not 0 <= budget <= MAX_PASSAGE_CHARS:
        raise ValidationError(f'budget must be a whole number from 0 to {MAX_PASSAGE_CHARS}')
    slugs = [slug for slug in _strings(body, 'slugs') if SLUG_PATTERN.fullmatch(slug)]
    if not ids and not slugs and not query:
        raise ValidationError('Give item_ids, slugs, a query, or both')
    named = [store.get_item(_table(), scope, item_id) for item_id in ids] + [_by_slug(scope, slug) for slug in slugs]
    found = named if ids or slugs else _found_by_words(scope, query)
    missing = sum(1 for item in found if item is None)
    present = list({str(item['item_id']): item for item in found if item is not None}.values())
    ready = [item for item in present if item.get('status') == 'ready']
    native = [item for item in ready if store.sent_as_a_file(item)][:slots]
    searched = [item for item in ready if item not in native and int(item.get('chunks') or 0) > 0]
    objects = LibraryObjects(scope)
    passages = retrieve(_table(), scope, [str(item['item_id']) for item in searched], query or ' '.join(
        str(item.get('title') or '') for item in searched), budget=budget) if searched else []
    return {
        'items': [_brief(item) for item in present],
        'native': [_native_entry(objects, item) for item in native],
        'passages': [passage.view() for passage in passages],
        'missing': missing,
        'pending': [{'item_id': item['item_id'], 'status': item.get('status')} for item in present
                    if item.get('status') != 'ready'],
    }

