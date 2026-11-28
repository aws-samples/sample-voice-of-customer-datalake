"""A product source's reading on the projects API's assist twin (7.104.00, docs/project-workspace.md → Product tab).

A PDF, DOCX or PPTX upload and a link are read here, not by the S3-triggered product-doc extractor (which keeps
Markdown, text and images): ``POST /projects/{id}/product-docs/{doc}/uploaded``, ``…/product-docs/urls`` and
``…/product-docs/{doc}/refresh`` (shared/product_source_routes.py) claim the source ``extracting`` with a fresh token
(``extract_token``, ``claimed_at``) and invoke the twin (``ASSIST_WORKER_FUNCTION``: the projects API's code and role,
15 minutes) with ``{action: 'product_source_extract', project_id, doc_id, token}``, plus the request's workspace
(shared/workspace_routing.py ``workspace_payload``). api/projects_handler.py ``lambda_handler`` hands such an event to
``run``, beside the Documents Library's (shared/library_worker.py).

``run`` reads the source only while it is ``extracting`` under that token, and every write is conditional on it:

* a file: its upload (``product_doc_source_key``, at most 25 MB), its SHA-256 held to the one the upload declared
  (a row that declares none fails as not the file announced),
  its text through shared/library_extract.py (a PDF's text layer, at most 500 pages, its pages joined with
  ``PAGE_BREAK``; a scanned PDF of at most 4.5 MB read by Amazon Bedrock through shared/library_worker.py
  ``describe``, which reads the file as data; DOCX and PPTX as the zip of XML parts they are, within its zip caps);
* a link: one public https page (shared/product_source_links.py).

The text goes to ``product_doc_extracted_key`` and the source is marked ``ready`` with what was read
(``extracted_chars``, ``truncated``, ``method``, ``pages``, ``injection_flag``; a link's ``final_url``, ``title``,
``fetched_at``), or ``failed`` with the person's message. Text that reads like instructions to a model is flagged,
never refused. A source deleted while it was read finds its row gone at the ready write and takes its text back; one
claimed again (a refresh) keeps the text for the newer read. ``run`` never raises (an async invoke's retry could not
help).

The scope is the event's (since 7.106.00, 3h-S3b, docs/multi-workspace.md 3h): its ``workspace_id``, which the starting
route sets from the request's resolved scope (shared/workspace_routing.py ``workspace_payload``: set last, over any
field of the same name), never from a caller's body; shared/ws_repo.py ``message_scope`` reads it (none: the
deployment's; one that is not a workspace id: refused). Every row and object it reads or writes is that scope's, so an
event naming another workspace than the source's finds no source claimed there and writes nothing.
"""
from __future__ import annotations

import hashlib
import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final

from botocore.exceptions import ClientError

from shared.aws import get_s3_client, is_action_event, is_missing_s3_object
from shared.library_extract import Extraction, ExtractionError, extract, format_of
from shared.library_worker import describe
from shared.logging import logger
from shared.product_sources import (
    MAX_SOURCE_FILE_BYTES,
    SOURCE_CONTENT_TYPES,
    get_source,
    injection_flag,
    product_doc_extracted_key,
    product_doc_source_key,
    projects_table,
    put_text,
    settle,
    take_back_text,
)
from shared.timestamps import now_iso
from shared.ws_repo import message_scope

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

__all__ = ['EXTRACT_ACTION', 'is_extract_event', 'run']

#: An unexpected failure's message, which the Product tab shows as it is: a file's or a link's alike (the Documents
#: Library's own says "upload it in another format", which a link cannot).
SOURCE_FAILURE: Final = 'This source could not be read. Try again, or add it another way.'

EXTRACT_ACTION: Final = 'product_source_extract'
_EXTRACTING: Final = ('extracting',)
_ERROR_CHARS: Final = 500
NOT_ARRIVED: Final = 'The file has not arrived. Upload it again.'
TOO_LARGE: Final = f'This file is larger than {MAX_SOURCE_FILE_BYTES // (1024 * 1024)} MB.'
NOT_THE_FILE: Final = 'The uploaded file does not match the one chosen. Upload it again.'


def is_extract_event(event: object) -> bool:
    """The twin's invocation for a source (never an API Gateway request): ``lambda_handler`` routes it to ``run``."""
    return isinstance(event, dict) and is_action_event(event, EXTRACT_ACTION)


def _object_bytes(key: str) -> bytes:
    """The upload, at most ``MAX_SOURCE_FILE_BYTES`` (a longer one is refused, never cut)."""
    try:
        body = get_s3_client().get_object(Bucket=os.environ.get('RAW_DATA_BUCKET', ''), Key=key)['Body']
    except ClientError as exc:
        if is_missing_s3_object(exc):
            raise ExtractionError(NOT_ARRIVED) from exc
        raise
    data = body.read(MAX_SOURCE_FILE_BYTES + 1)
    if len(data) > MAX_SOURCE_FILE_BYTES:
        raise ExtractionError(TOO_LARGE)
    return bytes(data)


def _read_file(project_id: str, item: Mapping[str, Any],
               workspace: WorkspaceScope | None) -> tuple[Extraction, dict[str, Any]]:
    content_type = item.get('content_type')
    ext = SOURCE_CONTENT_TYPES.get(content_type) if isinstance(content_type, str) else None
    fmt = format_of(content_type)
    if ext is None or fmt is None:
        raise ExtractionError('This file type is not supported.')
    data = _object_bytes(product_doc_source_key(project_id, str(item['doc_id']), ext, workspace=workspace))
    # Every PDF, DOCX or PPTX row declares its SHA-256 (POST …/upload-url requires it, 400 sha256_required): a row
    # without one is not the upload it announced either, never read unchecked (7.104.00 round 2).
    expected = item.get('sha256')
    if not isinstance(expected, str) or not expected or hashlib.sha256(data).hexdigest() != expected:
        raise ExtractionError(NOT_THE_FILE)
    return extract(fmt, data, describe), {}


def _read_link(item: Mapping[str, Any]) -> tuple[Extraction, dict[str, Any]]:
    # Imported here: requests and the pinned session load only on the twin's link path, never at the API's cold start.
    from shared.product_source_links import LinkError, read_page

    try:
        page = read_page(str(item.get('url') or ''), describe)
    except LinkError as exc:
        raise ExtractionError(str(exc)) from exc
    return page.extraction, {'final_url': page.final_url, 'title': page.title, 'content_type': page.content_type,
                             'size_bytes': page.size_bytes, 'fetched_at': now_iso()}


def _fail(table: Any, project_id: str, doc_id: str, token: str, message: str,
          workspace: WorkspaceScope | None) -> None:
    settle(table, project_id, doc_id, {'status': 'failed', 'error': message[:_ERROR_CHARS], 'failed_at': now_iso()},
           workspace=workspace, statuses=_EXTRACTING, token=token)


def _still_claimed(table: Any, project_id: str, doc_id: str, token: str, workspace: WorkspaceScope | None) -> bool:
    current = get_source(table, project_id, doc_id, workspace=workspace)
    return current is not None and current.get('status') == 'extracting' and current.get('extract_token') == token


def _ready(table: Any, project_id: str, doc_id: str, token: str, read: tuple[Extraction, dict[str, Any]],
           workspace: WorkspaceScope | None) -> str:
    """Store the text and mark the source ready, both only while the claim holds; ``done`` or ``skipped``."""
    extraction, extra = read
    if not _still_claimed(table, project_id, doc_id, token, workspace):
        # Claimed again (a refresh) or deleted while it was read: nothing written, the newer read's or nobody's.
        return 'skipped'
    put_text(project_id, doc_id, extraction.text, workspace=workspace)
    fields: dict[str, Any] = {
        'status': 'ready', 's3_extracted_key': product_doc_extracted_key(project_id, doc_id, workspace=workspace),
        'extracted_chars': len(extraction.text), 'truncated': extraction.truncated, 'method': extraction.method,
        'injection_flag': injection_flag(extraction.text), 'extracted_at': now_iso(), **extra,
    }
    # A read again (a refresh) replaces every attribute of the last one: one without pages removes the old count.
    if extraction.pages is not None:
        fields['pages'] = extraction.pages
    remove = ('error',) if extraction.pages is not None else ('error', 'pages')
    if settle(table, project_id, doc_id, fields, workspace=workspace, statuses=_EXTRACTING, token=token,
              remove=remove):
        return 'done'
    if get_source(table, project_id, doc_id, workspace=workspace) is None:
        # Deleted after the check above: its delete may have swept before this text landed, so it goes now.
        take_back_text(project_id, doc_id, workspace=workspace)
        logger.info('A product source was deleted while it was read; its text was taken back')
    return 'skipped'


def _read_source(table: Any, project_id: str, item: Mapping[str, Any], token: str,
                 workspace: WorkspaceScope | None) -> str:
    doc_id = str(item['doc_id'])
    try:
        read = _read_link(item) if item.get('source_kind') == 'url' else _read_file(project_id, item, workspace)
    except ExtractionError as exc:
        _fail(table, project_id, doc_id, token, str(exc), workspace)
        return 'failed'
    return _ready(table, project_id, doc_id, token, read, workspace)


@dataclass(frozen=True)
class _Claim:
    """What an event names: the source, the claim's token and the scope (its ``workspace_id``, or the deployment)."""

    project_id: str
    doc_id: str
    token: str
    scope: WorkspaceScope | None


def _claim_of(event: Mapping[str, Any]) -> _Claim | None:
    """The event's claim, or None (logged) for an event the twin refuses: a field missing or not text, or a workspace
    field that is not one."""
    refused, scope = message_scope(event)
    ids = [event.get(name) for name in ('project_id', 'doc_id', 'token')]
    texts = [value for value in ids if isinstance(value, str) and value]
    if refused or len(texts) != len(ids):
        logger.error('Product source extraction event refused')
        return None
    return _Claim(texts[0], texts[1], texts[2], scope)


def _read_claimed(table: Any, claim: _Claim) -> str:
    item = get_source(table, claim.project_id, claim.doc_id, workspace=claim.scope)
    if item is None or item.get('status') != 'extracting' or item.get('extract_token') != claim.token:
        logger.info('Product source extraction already done, claimed again or deleted')
        return 'skipped'
    return _read_source(table, claim.project_id, item, claim.token, claim.scope)


def run(event: Mapping[str, Any], table: Any = None) -> dict[str, str]:
    """The twin's side: read the claimed source (in voc-projects, or ``table``) and mark it ``ready`` (or ``failed``
    with the person's message), each write conditional on the claim's token. Answers ``{status}``: ``done``,
    ``failed``, ``skipped`` (the source is gone, claimed again or done) or ``ignored`` (an event it refuses)."""
    claim = _claim_of(event)
    if claim is None:
        return {'status': 'ignored'}
    try:
        table = table if table is not None else projects_table()
        return {'status': _read_claimed(table, claim)}
    except Exception:
        logger.exception('Product source extraction failed')
        if table is not None:
            try:
                _fail(table, claim.project_id, claim.doc_id, claim.token, SOURCE_FAILURE, claim.scope)
            except Exception:
                logger.exception('A failed product source extraction could not be recorded')
        return {'status': 'failed'}
