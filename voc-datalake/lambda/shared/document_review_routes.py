"""Document comments and review links (docs/document-review.md), included by ``api/projects_handler.py``.

Two families of routes, both served by the projects API Lambda:

``/projects/{id}/documents/{doc}/comments…`` and ``…/share`` (the app's Cognito authorizer). The
handler's project-access middleware has already gated the project: reading and commenting need
VIEW (``shared.project_access._ROUTE_OVERRIDES``: a viewer may comment), creating or revoking a
review link needs EDIT. Deleting a thread is its author's, or an editor's.

``/review/{share_id}…`` (the BOARD authorizer: the app pool and the board pool, api-gateway.ts).
The middleware does not gate these (no project in the path); every route here re-reads the link and
admits the caller's VERIFIED email (``shared.document_share.require_share_for``). A reviewer reads
the newest version of the series and their own threads, and comments or replies on them, within a
daily budget. A reviewer never sees another reviewer's threads, the team's internal threads, or any
address but their own.

``…/comments/addressed`` (EDIT: the gate's default for that path) marks threads answered by the
path's saved version, or clears that ("Revise from comments", shared/document_revision.py).

The persona review and "Revise from comments" starts (``…/persona-review``,
``…/revise-from-comments``) live in the handler, beside the other assist jobs.

Workspaces (docs/multi-workspace.md, the project plan, 3e; plumbing since 7.37.00): every helper passes its
``workspace`` to every store it calls. The member routes take theirs from ``_project_scope``, the deployment until the
switch (3h) resolves ``X-Workspace-Id`` there (the project gate refuses a workspace until then). A reviewer's link
names its own workspace (``document_share.require_share_for``: the routing row's, nothing a request sent); a link kept
in a workspace is refused (``NotPerWorkspaceError``, ``REVIEWER_ROUTES_STORE``) once its row is read, before any
document or thread is read from the workspace or anything is written there, since a reviewer's write would land in
the workspace without its status check (3h).
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router
from botocore.exceptions import ClientError

from shared import document_comments as comments
from shared import document_series, document_share
from shared.ai_writing import KIND_AUTONOMOUS, writing_kind
from shared.aws import is_conditional_check_failure
from shared.delete_audit import actor_from_event, record_delete
from shared.engagement_identity import BoardViewer, board_viewer
from shared.exceptions import AuthorizationError, ConflictError, NotFoundError, ValidationError
from shared.logging import tracer
from shared.project_access import LEVEL_EDIT, Caller, ProjectAccess, claim_text, claims_from_event
from shared.project_keys import REVIEWER_ROUTES_STORE, require_deployment
from shared.request_body import json_object_body
from shared.tables import configured_table, get_projects_table
from shared.ws_repo import WorkspaceScope

app = Router()

# The keys the handler's middleware writes (projects_handler.py reads them under the same names).
CALLER_CONTEXT_KEY: Final = 'project_caller'
ACCESS_CONTEXT_KEY: Final = 'project_access'
THREAD_FULL: Final = 'This thread has reached its reply limit'
MAX_NAME_CHARS: Final = comments.MAX_NAME_CHARS


def _table() -> Any:
    return configured_table(get_projects_table(), 'Projects')


def _project_scope() -> WorkspaceScope | None:
    """The workspace of a member route's project: the deployment (None) until the switch (3h) resolves the request's
    ``X-Workspace-Id`` here, from its membership, and the project gate decides the workspace's project."""
    return None


def _caller() -> Caller:
    caller = app.context.get(CALLER_CONTEXT_KEY)
    if not isinstance(caller, Caller):
        raise AuthorizationError('Caller identity could not be determined')
    return caller


def _can_edit() -> bool:
    access = app.context.get(ACCESS_CONTEXT_KEY)
    return isinstance(access, ProjectAccess) and access.allows(LEVEL_EDIT)


def _member_author() -> dict[str, str]:
    caller = _caller()
    claims = claims_from_event(app.current_event.raw_event)
    name = claim_text(claims, 'name') or caller.email or caller.username
    return comments.user_author(caller.subject, name[:MAX_NAME_CHARS])


def _series(project_id: str, document_id: str, *, workspace: WorkspaceScope | None) -> tuple[dict, dict[str, str]]:
    document = document_series.find_document(_table(), project_id, document_id, workspace=workspace)
    return document, document_series.series_of(project_id, document)


def _thread(project_id: str, series_id: str, comment_id: str, *, workspace: WorkspaceScope | None) -> dict[str, Any]:
    thread = comments.get_thread(_table(), project_id, series_id, comment_id, workspace=workspace)
    if thread is None:
        raise NotFoundError(comments.COMMENT_NOT_FOUND)
    return thread


def _reply(thread: Mapping[str, Any], author: Mapping[str, Any], text: str, *,
           workspace: WorkspaceScope | None) -> dict[str, Any]:
    try:
        return comments.append_reply(_table(), thread, comments.reply_item(author, text), workspace=workspace)
    except ClientError as error:
        if is_conditional_check_failure(error):
            raise ConflictError(THREAD_FULL) from error
        raise


# ── Project members ─────────────────────────────────────────────────────────

@app.get('/projects/<project_id>/documents/<document_id>/comments')
@tracer.capture_method
def list_document_comments(project_id: str, document_id: str):
    """Every thread of the document's series (all versions), oldest first, and its review link."""
    workspace = _project_scope()
    _, series = _series(project_id, document_id, workspace=workspace)
    table = _table()
    share = document_share.current_share(table, project_id, series['series_id'], workspace=workspace)
    threads = comments.list_threads(table, project_id, series['series_id'], workspace=workspace)
    return {'series': series, 'document_id': document_id, 'threads': comments.threads_view(threads, team=True),
            'share': document_share.share_view(share) if share else None, 'can_edit': _can_edit()}


@app.post('/projects/<project_id>/documents/<document_id>/comments')
@tracer.capture_method
def create_document_comment(project_id: str, document_id: str):
    """A new thread on THIS version: ``{text, anchor?: {exact, prefix?, suffix?, heading?}}``."""
    values = comments.validate_new_comment(json_object_body(app))
    workspace = _project_scope()
    document, series = _series(project_id, document_id, workspace=workspace)
    item = comments.thread_item(project_id=project_id, series_id=series['series_id'], document=document,
                                author=_member_author(), text=values['text'], anchor=values['anchor'],
                                workspace=workspace)
    comments.put_thread(_table(), item, workspace=workspace)
    return {'thread': comments.thread_view(item, team=True)}


@app.post('/projects/<project_id>/documents/<document_id>/comments/<comment_id>/replies')
@tracer.capture_method
def reply_document_comment(project_id: str, document_id: str, comment_id: str):
    text = comments.validate_reply(json_object_body(app))
    workspace = _project_scope()
    _, series = _series(project_id, document_id, workspace=workspace)
    thread = _thread(project_id, series['series_id'], comment_id, workspace=workspace)
    return {'thread': comments.thread_view(_reply(thread, _member_author(), text, workspace=workspace), team=True)}


def _status_change(project_id: str, document_id: str, comment_id: str, status: str) -> dict[str, Any]:
    workspace = _project_scope()
    _, series = _series(project_id, document_id, workspace=workspace)
    thread = _thread(project_id, series['series_id'], comment_id, workspace=workspace)
    try:
        updated = comments.set_status(_table(), thread, status, _member_author()['name'], workspace=workspace)
    except ClientError as error:
        if is_conditional_check_failure(error):
            raise NotFoundError(comments.COMMENT_NOT_FOUND) from error
        raise
    return {'thread': comments.thread_view(updated, team=True)}


@app.post('/projects/<project_id>/documents/<document_id>/comments/<comment_id>/resolve')
@tracer.capture_method
def resolve_document_comment(project_id: str, document_id: str, comment_id: str):
    return _status_change(project_id, document_id, comment_id, comments.STATUS_RESOLVED)


@app.post('/projects/<project_id>/documents/<document_id>/comments/<comment_id>/reopen')
@tracer.capture_method
def reopen_document_comment(project_id: str, document_id: str, comment_id: str):
    return _status_change(project_id, document_id, comment_id, comments.STATUS_OPEN)


@app.post('/projects/<project_id>/documents/<document_id>/comments/addressed')
@tracer.capture_method
def mark_document_comments_addressed(project_id: str, document_id: str):
    """``{thread_ids: [≤50], addressed?: bool = true}`` (edit): THIS version (the path's document)
    answers the threads, or with ``addressed: false`` no longer does (the canvas's Undo of an
    applied pass, on the restored version).

    The canvas calls it after a "Revise from comments" proposal is saved; so does MCP's
    ``documents_mark_comments_addressed``. Each call is appended to the threads'
    ``addressed_history`` (D1). Ids not in the series are skipped; none found is 404.
    """
    thread_ids, addressed = comments.validate_addressed(json_object_body(app))
    workspace = _project_scope()
    document, series = _series(project_id, document_id, workspace=workspace)
    if document.get('version') is None:
        raise ValidationError('This document has no saved version to mark comments by')
    table = _table()
    wanted = set(thread_ids)
    threads = [thread for thread in comments.list_threads(table, project_id, series['series_id'], workspace=workspace)
               if thread.get('comment_id') in wanted]
    if not threads:
        raise NotFoundError(comments.COMMENT_NOT_FOUND)
    by_kind = (comments.ADDRESSED_BY_AI if writing_kind(app.current_event.raw_event) == KIND_AUTONOMOUS
               else comments.ADDRESSED_BY_USER)
    entry = comments.addressed_entry(version=int(document['version']), document_id=document_id, by_kind=by_kind,
                                     by_sub=_caller().subject, addressed=addressed)
    marked = comments.record_threads_addressed(table, threads, entry, workspace=workspace)
    return {'threads': comments.threads_view(marked, team=True)}


@app.delete('/projects/<project_id>/documents/<document_id>/comments/<comment_id>')
@tracer.capture_method
def delete_document_comment(project_id: str, document_id: str, comment_id: str):
    """The thread's own author, or anyone who can edit the project; 403 otherwise."""
    workspace = _project_scope()
    _, series = _series(project_id, document_id, workspace=workspace)
    thread = _thread(project_id, series['series_id'], comment_id, workspace=workspace)
    raw_author = thread.get('author')
    author: Mapping[str, Any] = raw_author if isinstance(raw_author, Mapping) else {}
    own = author.get('kind') == comments.AUTHOR_USER and author.get('sub') == _caller().subject
    if not own and not _can_edit():
        raise AuthorizationError('Only the comment author or a project editor can delete this comment')
    table = _table()
    comments.delete_thread(table, thread, workspace=workspace)
    record_delete(table, kind='document_comment', actor=actor_from_event(app.current_event.raw_event),
                  target={'project_id': project_id, 'document_id': document_id, 'comment_id': comment_id})
    return {'success': True, 'comment_id': comment_id}


@app.get('/projects/<project_id>/documents/<document_id>/share')
@tracer.capture_method
def get_document_share(project_id: str, document_id: str):
    workspace = _project_scope()
    _, series = _series(project_id, document_id, workspace=workspace)
    share = document_share.current_share(_table(), project_id, series['series_id'], workspace=workspace)
    return {'share': document_share.share_view(share) if share else None}


@app.post('/projects/<project_id>/documents/<document_id>/share')
@tracer.capture_method
def create_document_share(project_id: str, document_id: str):
    """The series' review link (edit): ``{audience?, expires_in_days?}``; an active link is returned as is."""
    values = document_share.validate_share_body(json_object_body(app))
    workspace = _project_scope()
    _, series = _series(project_id, document_id, workspace=workspace)
    author = _member_author()
    share, created = document_share.create_share(
        _table(), project_id=project_id, series=series, document_id=document_id, creator=author, values=values,
        workspace=workspace)
    return {'share': document_share.share_view(share), 'created': created}


@app.delete('/projects/<project_id>/documents/<document_id>/share')
@tracer.capture_method
def revoke_document_share(project_id: str, document_id: str):
    """Turn the series' review link off (edit); its reviewers' threads stay."""
    workspace = _project_scope()
    _, series = _series(project_id, document_id, workspace=workspace)
    revoked = document_share.revoke_share(_table(), project_id, series['series_id'], _member_author()['name'],
                                          workspace=workspace)
    return {'success': True, 'revoked': revoked}


# ── Reviewers (board authorizer) ────────────────────────────────────────────

def _reviewer(share_id: str) -> tuple[BoardViewer, dict[str, Any], WorkspaceScope | None]:
    """The signed-in reviewer, the link that admits them and the workspace it is kept in (the routing row's). A link
    kept in a workspace is refused (``REVIEWER_ROUTES_STORE``) once its link row is read, before any document or
    thread is read from that workspace or anything is written there (the module docstring)."""
    viewer = board_viewer(app.current_event.raw_event)
    share, workspace = document_share.require_share_for(_table(), share_id, viewer.email)
    require_deployment(workspace, REVIEWER_ROUTES_STORE)
    return viewer, share, workspace


def _review_document(share: Mapping[str, Any], *, workspace: WorkspaceScope | None) -> dict[str, Any]:
    document = document_series.latest_version(
        _table(), str(share['project_id']), str(share['document_type']), str(share['base_title']),
        workspace=workspace)
    if document is None:
        raise NotFoundError(document_share.LINK_GONE)
    return document


def _own_threads(share: Mapping[str, Any], email_lc: str, *, workspace: WorkspaceScope | None) -> list[dict[str, Any]]:
    rows = comments.list_threads(_table(), str(share['project_id']), str(share['series_id']), workspace=workspace)
    return comments.threads_view((row for row in rows if comments.is_reviewer_thread(row, email_lc)), team=False)


@app.get('/review/<share_id>')
@tracer.capture_method
def get_review(share_id: str):
    """The newest version of the shared document and the caller's own threads."""
    viewer, share, workspace = _reviewer(share_id)
    document = _review_document(share, workspace=workspace)
    return {
        'share': {'share_id': share_id, 'document_type': share.get('document_type'),
                  'expires_at': share.get('expires_at')},
        'document': {'document_id': document.get('document_id'), 'version': document.get('version'),
                     'title': document.get('title'), 'content': document.get('content') or ''},
        'threads': _own_threads(share, viewer.email, workspace=workspace),
        'viewer': {'email': viewer.email, 'name': viewer.name},
    }


@app.post('/review/<share_id>/comments')
@tracer.capture_method
def create_review_comment(share_id: str):
    viewer, share, workspace = _reviewer(share_id)
    values = comments.validate_new_comment(json_object_body(app))
    document = _review_document(share, workspace=workspace)
    document_share.count_reviewer_write(_table(), share_id, viewer.email, workspace=workspace)
    item = comments.thread_item(
        project_id=str(share['project_id']), series_id=str(share['series_id']), document=document,
        author=comments.reviewer_author(viewer.email, viewer.name), text=values['text'], anchor=values['anchor'],
        share_id=share_id, workspace=workspace)
    comments.put_thread(_table(), item, workspace=workspace)
    return {'thread': comments.thread_view(item, team=False)}


@app.post('/review/<share_id>/comments/<comment_id>/replies')
@tracer.capture_method
def reply_review_comment(share_id: str, comment_id: str):
    """A reply on one of the caller's OWN threads (404 for any other)."""
    viewer, share, workspace = _reviewer(share_id)
    text = comments.validate_reply(json_object_body(app))
    thread = comments.get_thread(_table(), str(share['project_id']), str(share['series_id']), comment_id,
                                 workspace=workspace)
    if thread is None or not comments.is_reviewer_thread(thread, viewer.email):
        raise NotFoundError(comments.COMMENT_NOT_FOUND)
    document_share.count_reviewer_write(_table(), share_id, viewer.email, workspace=workspace)
    updated = _reply(thread, comments.reviewer_author(viewer.email, viewer.name), text, workspace=workspace)
    return {'thread': comments.thread_view(updated, team=False)}
