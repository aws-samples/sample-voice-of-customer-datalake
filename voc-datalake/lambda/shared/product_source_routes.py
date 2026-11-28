"""The Product tab's source routes (7.104.00, docs/project-workspace.md → Product tab), included by
``api/projects_handler.py``.

    POST   /projects/{id}/product-docs/{doc_id}/uploaded   202 {doc}: the upload landed; the assist twin reads it
    POST   /projects/{id}/product-docs/urls                201 {doc}: a public https link {url}, read by the twin
    POST   /projects/{id}/product-docs/{doc_id}/refresh    202 {doc}: a link read again, or a failed or stale file
    POST   /projects/{id}/product-docs/answers             201 {doc}: typed answers saved as an interview source

``{doc}`` is a source as ``GET /projects/{id}/product-docs`` lists it (shared/product_sources.py ``doc_view``). That
route, ``POST …/product-docs/upload-url`` and ``DELETE …/product-docs/{doc_id}`` stay in the handler
(api/product_context.py). Every route rides the projects API's ``/projects/{proxy+}``, so the project gate applies (a
POST needs EDIT, so a viewer is refused; an MCP token acts as its minter, capped at editor). The twin's side is
shared/product_source_worker.py, an interview's answers are saved by shared/product_sources.py.

The limits (shared/product_sources.py): at most 20 sources a project, every kind together, at most 10 links among
them (``put_source``: a working-set limit, checked before each add; the spend is bounded by the reads' counters and
the extract's own caps, not by these); at most 30 link reads (an add or a refresh)
a project a UTC day and 60 a person, and 60 reads of a PDF, DOCX or PPTX (an announced upload or a retry) a person a
UTC day (429 ``rate_limited``, shared/aws.py ``count_once``). A link is https,
public (shared/url_policy.py ``require_public``, the guard a design reference's capture takes) and at most 2,048
characters, and a project names one address once (shared/reference_urls.py ``normalised_reference_url``). Typed
answers: at most 12, each at most 2,000 characters and its question at most 200 (shared/product_fields.py
``MAX_QUESTION_CHARS``, the extract's and the voice interview's cap too), through shared/pii_redaction.py
``redact_text`` before they are saved.

Every route acts in the request's scope (since 7.106.00, 3h-S3b, docs/multi-workspace.md 3h): the one the handler's
middleware resolved (shared/project_request_scope.py ``held_scope``; the deployment's until the flip, 3h-S12), passed to
every store, the reads' counters with it (``WS#{ws}#``); the twin's event names it from the resolved context
(shared/workspace_routing.py ``workspace_payload``), never from the body.
"""
from __future__ import annotations

import secrets
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared.assist_jobs import worker_function
from shared.aws import count_once, invoke_lambda_async
from shared.delete_audit import actor_from_event
from shared.exceptions import ConflictError, NotFoundError, ServiceError, ValidationError
from shared.logging import logger, tracer
from shared.pii_redaction import redact_text
from shared.product_fields import FIELD_LABELS, MAX_QUESTION_CHARS
from shared.product_source_worker import EXTRACT_ACTION
from shared.product_sources import (
    TWIN_STALL_SECONDS,
    InterviewAnswers,
    doc_view,
    file_read_counters,
    get_source,
    link_read_counters,
    list_sources,
    new_doc_id,
    projects_table,
    put_source,
    read_on_twin,
    require_room,
    save_interview_source,
    settle,
    source_row_key,
    upload_head,
)
from shared.project_gate import caller_from_event
from shared.project_request_scope import ProjectScope, held_scope
from shared.reference_urls import normalised_reference_url
from shared.request_body import json_object_body, reject_unknown_fields, validated_text
from shared.route_answers import json_response
from shared.tables import configured_table, get_aggregates_table
from shared.timestamps import now_iso, parse_iso
from shared.url_policy import NotPublicURLError, require_public
from shared.workspace_routing import workspace_payload
from shared.ws_repo import WorkspaceScope

__all__ = ['app']

app = Router()

MAX_URL_CHARS: Final = 2048
MAX_ANSWERS: Final = 12
MAX_ANSWER_CHARS: Final = 2000
MAX_PROPOSAL_ID_CHARS: Final = 128
NOT_STARTED: Final = 'The reading could not be started. Try again.'
_LABELS: Final = dict(FIELD_LABELS)


def _scope() -> ProjectScope:
    """The request's scope, as the handler's middleware resolved it."""
    return held_scope(app.context)


def _require_source(table: Any, project_id: str, doc_id: str, *, workspace: WorkspaceScope | None) -> dict:
    item = get_source(table, project_id, doc_id, workspace=workspace)
    if item is None:
        raise NotFoundError('Product source not found')
    return item


def _fresh(table: Any, project_id: str, item: Mapping[str, Any], *,
           workspace: WorkspaceScope | None) -> dict[str, Any]:
    """The source as it stands now (another request or the twin may have moved it), as every route answers it."""
    return doc_view(get_source(table, project_id, str(item['doc_id']), workspace=workspace) or item)


# ── Starting a read on the twin ─────────────────────────────────────────────────────────────────────────────────


def _claim(table: Any, project_id: str, doc_id: str, *, when: tuple[str, ...],
           workspace: WorkspaceScope | None) -> str | None:
    """Move the source to ``extracting`` under a fresh token when its status is one of ``when``: the token, or None
    when another request moved it first."""
    token = secrets.token_hex(8)
    fields = {'status': 'extracting', 'extract_token': token, 'claimed_at': now_iso()}
    claimed = settle(table, project_id, doc_id, fields, workspace=workspace, statuses=when, remove=('error',))
    return token if claimed else None


def _twin() -> str:
    """The projects API's assist twin (``ASSIST_WORKER_FUNCTION``), or a 500 when it is not configured."""
    function = worker_function()
    if function:
        return function
    raise ServiceError('The reading worker is not configured')


def _hand_to_the_twin(table: Any, project_id: str, doc_id: str, token: str, scope: ProjectScope) -> None:
    """Invoke the twin for the claimed source, its event naming ``scope``'s workspace from the resolved context (none
    for the deployment); a failed invoke fails the source (under its token) and is a 500."""
    try:
        invoke_lambda_async(_twin(), workspace_payload(
            {'action': EXTRACT_ACTION, 'project_id': project_id, 'doc_id': doc_id, 'token': token}, scope.context))
    except Exception as exc:
        logger.exception('A product source reading could not be started')
        settle(table, project_id, doc_id, {'status': 'failed', 'error': NOT_STARTED}, workspace=scope.workspace,
               statuses=('extracting',), token=token)
        raise ServiceError(NOT_STARTED) from exc


def _is_stale(item: Mapping[str, Any]) -> bool:
    """A read that outlived the twin: ``extracting`` since ``TWIN_STALL_SECONDS`` or more."""
    if item.get('status') != 'extracting':
        return False
    claimed = parse_iso(item.get('claimed_at'))
    return claimed is not None and claimed <= datetime.now(UTC) - timedelta(seconds=TWIN_STALL_SECONDS)


def _subject() -> str:
    return caller_from_event(app.current_event.raw_event).subject


def _aggregates() -> Any:
    """voc-aggregates: the reads' counters (the request scope's: a workspace's under ``WS#{ws}#``)."""
    return configured_table(get_aggregates_table(), 'Aggregates')


def _count_link_read(project_id: str, *, workspace: WorkspaceScope | None) -> None:
    """One more of the project's and the caller's link reads today in ``workspace``, both or neither, or 429
    ``rate_limited``."""
    now = datetime.now(UTC)
    count_once(_aggregates(), link_read_counters(project_id, _subject(), now, workspace=workspace), now)


def _count_file_read(*, workspace: WorkspaceScope | None) -> None:
    """One more of the caller's reads of a PDF, DOCX or PPTX today in ``workspace``, or 429 ``rate_limited``."""
    now = datetime.now(UTC)
    count_once(_aggregates(), file_read_counters(_subject(), now, workspace=workspace), now)


# ── Routes ───────────────────────────────────────────────────────────────────────────────────────────────────────


@app.post("/projects/<project_id>/product-docs/<doc_id>/uploaded")
@tracer.capture_method
def product_doc_uploaded(project_id: str, doc_id: str):
    """The browser's PUT of a PDF, DOCX or PPTX landed: its object is checked (its length and type are the source's)
    and the twin reads it (202), counted towards the caller's file reads (429 ``rate_limited``). Idempotent: a source
    already claimed, read or failed, and one the S3-triggered extractor reads (Markdown, text, an image), answer as
    they are (202)."""
    scope = _scope()
    workspace = scope.workspace
    table = projects_table()
    item = _require_source(table, project_id, doc_id, workspace=workspace)
    if item.get('status') != 'pending' or not read_on_twin(item):
        return json_response(202, {'doc': doc_view(item)})
    head = upload_head(project_id, item, workspace=workspace)
    if head is None:
        raise ConflictError('The file has not arrived yet. Upload it again.', code='not_uploaded')
    if head['length'] != int(item.get('size_bytes') or 0) or head['content_type'] != item.get('content_type'):
        raise ConflictError('The uploaded file is not the one announced. Upload it again.', code='upload_mismatch')
    _count_file_read(workspace=workspace)
    token = _claim(table, project_id, doc_id, when=('pending',), workspace=workspace)
    if token is not None:
        _hand_to_the_twin(table, project_id, doc_id, token, scope)
    return json_response(202, {'doc': _fresh(table, project_id, item, workspace=workspace)})


@app.post("/projects/<project_id>/product-docs/<doc_id>/refresh")
@tracer.capture_method
def refresh_product_doc(project_id: str, doc_id: str):
    """Read a link again (ready or failed), or a PDF, DOCX or PPTX whose read failed; either one whose read outlived
    the twin (16 minutes). 202, else 409: ``not_refreshable`` (an upload the S3 extractor reads, or answers),
    ``extracting`` (a read under way), ``not_failed`` (a file read fine), ``not_uploaded``, ``stale`` (moved
    meanwhile); 429 ``rate_limited``. A link's read counts towards the day's link reads, a file's towards the
    caller's file reads."""
    scope = _scope()
    workspace = scope.workspace
    table = projects_table()
    item = _require_source(table, project_id, doc_id, workspace=workspace)
    status = str(item.get('status'))
    if not read_on_twin(item):
        raise ConflictError('This source is read when it is added. Delete it and add it again.',
                            code='not_refreshable')
    if status == 'extracting' and not _is_stale(item):
        raise ConflictError('This source is being read. Wait for it to finish.', code='extracting')
    if item.get('source_kind') == 'url':
        _count_link_read(project_id, workspace=workspace)
    elif status != 'failed' and not _is_stale(item):
        raise ConflictError('Only a source whose read failed can be read again.', code='not_failed')
    elif upload_head(project_id, item, workspace=workspace) is None:
        raise ConflictError('The file never arrived. Delete this source and upload it again.', code='not_uploaded')
    else:
        _count_file_read(workspace=workspace)
    token = _claim(table, project_id, doc_id, when=(status,), workspace=workspace)
    if token is None:
        raise ConflictError('This source changed meanwhile. Reload it.', code='stale')
    _hand_to_the_twin(table, project_id, doc_id, token, scope)
    return json_response(202, {'doc': _fresh(table, project_id, item, workspace=workspace)})


def _public_link(body: Mapping[str, Any]) -> str:
    reject_unknown_fields(body, ('url',))
    url = validated_text(body.get('url'), 'url', MAX_URL_CHARS, required=True)
    try:
        require_public(url, final=False)
    except NotPublicURLError as exc:
        raise ValidationError(str(exc), code=exc.reason) from exc
    return url


def _refuse_a_second_copy(sources: list[dict], url: str) -> None:
    wanted = normalised_reference_url(url)
    for source in sources:
        added = source.get('url')
        if source.get('source_kind') == 'url' and isinstance(added, str) and normalised_reference_url(added) == wanted:
            raise ConflictError(f'This link is already a source of this project: "{added}".', code='duplicate',
                                details={'doc_id': source.get('doc_id')})


@app.post("/projects/<project_id>/product-docs/urls")
@tracer.capture_method
def add_product_doc_url(project_id: str):
    """``{url}``: a public https page as a source (201), read by the twin. 400 ``url_not_allowed``,
    ``too_many_sources``, ``too_many_links``; 409 ``duplicate``; 429 ``rate_limited``. The caps are checked before the
    read is counted, and again as the row is put (``put_source``)."""
    url = _public_link(json_object_body(app))
    scope = _scope()
    workspace = scope.workspace
    table = projects_table()
    sources = list_sources(table, project_id, workspace=workspace)
    require_room(sources, link=True)
    _refuse_a_second_copy(sources, url)
    _count_link_read(project_id, workspace=workspace)
    doc_id, token, now = new_doc_id(), secrets.token_hex(8), now_iso()
    row = {
        **source_row_key(project_id, doc_id, workspace=workspace), 'doc_id': doc_id, 'filename': url[:255],
        'content_type': '',
        'size_bytes': 0, 's3_raw_key': None, 's3_extracted_key': None, 'status': 'extracting', 'error': None,
        'extracted_chars': 0, 'created_at': now, 'source_kind': 'url', 'url': url,
        'created_by': actor_from_event(app.current_event.raw_event), 'extract_token': token, 'claimed_at': now,
    }
    put_source(table, project_id, row, workspace=workspace, link=True)
    _hand_to_the_twin(table, project_id, doc_id, token, scope)
    return json_response(201, {'doc': _fresh(table, project_id, row, workspace=workspace)})


def _answered(value: object) -> list[tuple[str, str, str]]:
    """The body's ``answers``, each ``(field, question, answer)``; a blank answer is left out, and none is a 400."""
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_ANSWERS:
        raise ValidationError(f'answers must be a list of 1 to {MAX_ANSWERS} answers')
    answered: list[tuple[str, str, str]] = []
    for entry in value:
        if not isinstance(entry, dict):
            raise ValidationError('each answer must be an object: {field, question, answer}')
        reject_unknown_fields(entry, ('field', 'question', 'answer'))
        field = entry.get('field')
        if not isinstance(field, str) or field not in _LABELS:
            raise ValidationError('an answer names a field the product description does not have')
        question = validated_text(entry.get('question'), 'question', MAX_QUESTION_CHARS, required=True)
        answer = validated_text(entry.get('answer'), 'answer', MAX_ANSWER_CHARS)
        if answer:
            answered.append((field, question, answer))
    if not answered:
        raise ValidationError('Write at least one answer.', code='no_answers')
    return answered


def _interview_text(answered: list[tuple[str, str, str]]) -> str:
    """The typed answers as the source's Markdown: one section per answer (its field's label and key), its question
    and its answer, each through ``redact_text`` (the patterns: e-mail addresses, phone numbers and the like)."""
    return '\n\n'.join(
        f'### {_LABELS[field]} (`{field}`)\n**Question:** {redact_text(question).text}\n\n'
        f'**Answer:** {redact_text(answer).text}'
        for field, question, answer in answered)


@app.post("/projects/<project_id>/product-docs/answers")
@tracer.capture_method
def save_product_answers(project_id: str):
    """``{proposal_id?, mode: 'typed', answers: [{field, question, answer}]}``: typed answers as one ready
    ``interview`` source (201). A voice interview's transcript is saved by its finalize, never here."""
    body = json_object_body(app)
    reject_unknown_fields(body, ('proposal_id', 'mode', 'answers'))
    if body.get('mode') != 'typed':
        raise ValidationError("mode must be 'typed' (a voice interview is saved when it ends)")
    proposal_id = validated_text(body.get('proposal_id'), 'proposal_id', MAX_PROPOSAL_ID_CHARS) or None
    text = _interview_text(_answered(body.get('answers')))
    doc = save_interview_source(project_id, InterviewAnswers(
        text=text, mode='typed', created_by=actor_from_event(app.current_event.raw_event), proposal_id=proposal_id),
        workspace=_scope().workspace)
    return json_response(201, {'doc': doc})
