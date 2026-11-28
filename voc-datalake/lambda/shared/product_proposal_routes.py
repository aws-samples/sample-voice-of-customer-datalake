"""The Product tab's extract and proposal routes (7.104.00, docs/project-workspace.md → Product tab), included by
``api/projects_handler.py``.

    POST   /projects/{id}/product-extract                          202 {job_id}: one extract of the ready sources
    GET    /projects/{id}/product-proposals/latest                 {proposal | null, context, field_meta, sources}
    POST   /projects/{id}/product-proposals/{proposal_id}/accept   {applied, conflicts, status}: the fields written
    POST   /projects/{id}/product-proposals/{proposal_id}/dismiss  {proposal_id, status}: the proposal dismissed

Every route rides the projects API's ``/projects/{proxy+}``, so the project gate applies (a GET needs VIEW, a POST
EDIT; an MCP token acts as its minter, capped at editor). An extract is a document-generator job
(``extract_product_description``, ``doc_type`` ``product_extract``, shared/product_extract.py), started through the
handler's own job start, which ``configure`` binds: the project's existence first (404), then this module's
precheck, in this order: 400 ``no_ready_sources`` (no source is ``ready``), 409 ``extract_running`` (the project's
extract lock is held), 429 ``rate_limited`` (shared/product_proposals.py's limits); then the job row as the caller
(``initiated_by``), the caller's model profile stamped on its config, the generator invoked. The lock is released by
the job (or here, when the start fails). ``effort`` is ``max`` unless the body asks for ``xhigh`` (a person's retry
of an extract that timed out, owner decision 10).

The latest proposal's ``sources`` are the project's source rows (shared/product_sources.py ``list_sources``, their one
reader) as GET …/product-docs answers each (``doc_view``; only that route fails a stalled read). An autonomous caller (an
MCP client, an agent or a plan step: shared/ai_writing.py ``writing_kind``) writes the product context, by an accept
here or a PUT …/product-context, only for people working AI-driven (``writer_of``, tenet 3: 403
``ai_writing_refused``), and never replaces a value a person typed (``person_value``, owner decision 4).

Every route acts in the request's scope (since 7.106.00, 3h-S3b, docs/multi-workspace.md 3h): the one the handler's
middleware resolved (shared/project_request_scope.py ``held_scope``; the deployment's until the flip, 3h-S12), passed to
every store, the owner's ``META`` an autonomous writer is checked against included. The extract's route passes it too,
but stays refused in a workspace by the middleware (api/projects_handler.py ``NOT_YET``, 3h-S8: its document-generator
job is the deployment's), and its own stores refuse one (shared/product_proposals.py ``PRODUCT_EXTRACT_STORE``).
"""
from __future__ import annotations

import json
import re
import secrets
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Final, Protocol

from aws_lambda_powertools.event_handler import Response, content_types
from aws_lambda_powertools.event_handler.api_gateway import Router

from shared import product_proposals as proposals
from shared.ai_writing import KIND_AUTONOMOUS, require_autonomous_writing, writing_kind, written_for
from shared.delete_audit import actor_from_event
from shared.exceptions import ConflictError, TooManyRequestsError, ValidationError
from shared.logging import tracer
from shared.product_sources import doc_view, list_sources, ready_sources
from shared.project_gate import caller_from_event, read_gate_meta
from shared.project_request_scope import held_scope
from shared.request_body import json_object_body, reject_unknown_fields
from shared.tables import configured_table, get_aggregates_table, get_projects_table
from shared.ws_repo import WorkspaceScope

__all__ = ['app', 'configure', 'writer_of']

app = Router()

EXTRACT_JOB_TYPE: Final = 'extract_product_description'
NO_READY_SOURCES: Final = 'no_ready_sources'
EXTRACT_RUNNING: Final = 'extract_running'
#: A response language as the SPA sends it (``en``, ``pt-BR``): its name goes into the prompt, so nothing else does.
_LANGUAGE: Final = re.compile(r'[a-z]{2,3}(-[A-Za-z0-9]{2,8})?')


class StartGeneratorJob(Protocol):
    """``(project_id, job_type, doc_config, message, *, precheck) -> {success, job_id, status, message}``:
    api/projects_handler.py ``_started_generator_job``. ``precheck`` runs after the project's existence check and
    before the job row."""

    def __call__(self, project_id: str, job_type: str, doc_config: dict[str, Any], message: str, *,
                 precheck: Callable[[], None] | None = None) -> dict[str, Any]: ...


_bound: list[StartGeneratorJob] = []


def configure(start_generator_job: StartGeneratorJob) -> None:
    """Bind the handler's document-generator job start (once, at import of the handler)."""
    _bound[:] = [start_generator_job]


def _table() -> Any:
    return configured_table(get_projects_table(), 'Projects')


def _aggregates() -> Any:
    """voc-aggregates: the extract limits' counters and the people's ways of working (shared/ai_mode.py)."""
    return configured_table(get_aggregates_table(), 'Aggregates')


def _event() -> dict:
    return app.current_event.raw_event


def _workspace() -> WorkspaceScope | None:
    """The request's workspace, as the handler's middleware resolved it (None: the deployment)."""
    return held_scope(app.context).workspace


def _effort(value: object) -> str:
    if value is None:
        return proposals.EFFORTS[0]
    if value not in proposals.EFFORTS:
        raise ValidationError(f"effort must be one of: {', '.join(proposals.EFFORTS)}")
    return str(value)


def _language(value: object) -> str | None:
    if value in (None, ''):
        return None
    if not isinstance(value, str) or _LANGUAGE.fullmatch(value) is None:
        raise ValidationError('response_language must be a language code such as en or pt-BR')
    return value


def writer_of(event: dict, project_id: str, *, workspace: WorkspaceScope | None) -> proposals.Actor:
    """Who writes the product context in this request (an accept, or PUT …/product-context): the caller as
    shared/delete_audit.py ``actor_from_event`` names them, and whether the call is autonomous (``writing_kind``). An
    autonomous caller writes only for people working AI-driven (tenet 3): the person it acts as and the project's owner
    when that is someone else (shared/ai_writing.py ``written_for``, the PR/FAQ and PRD gate's rule too; the owner read
    from the project's ``META`` in ``workspace``); else 403 ``ai_writing_refused`` (and a ``ModeUnreadableError`` 403
    when a way of working cannot be read). A person's own write passes in every mode."""
    actor = actor_from_event(event)
    autonomous = writing_kind(event) == KIND_AUTONOMOUS
    if autonomous:
        owner = (read_gate_meta(_table(), project_id, workspace=workspace) or {}).get('owner_sub')
        require_autonomous_writing(_aggregates(), written_for(caller_from_event(event).subject, owner))
    return proposals.Actor(sub=actor['sub'], kind=actor['kind'], autonomous=autonomous)


def _precheck(table: Any, project_id: str, lock_id: str, subject: str, *,
              workspace: WorkspaceScope | None) -> Callable[[], None]:
    def check() -> None:
        if not ready_sources(table, project_id, workspace=workspace):
            raise ValidationError('No product source is ready to read: add one, or wait for it to be read',
                                  code=NO_READY_SOURCES)
        now = datetime.now(UTC)
        if not proposals.take_lock(table, project_id, lock_id, subject, now, workspace=workspace):
            raise ConflictError('An extract is already running for this project', code=EXTRACT_RUNNING)
        try:
            proposals.count_extract(_aggregates(), project_id, subject, now, workspace=workspace)
        except TooManyRequestsError:
            proposals.release_lock(table, project_id, lock_id, workspace=workspace)
            raise
    return check


@app.post("/projects/<project_id>/product-extract")
@tracer.capture_method
def start_product_extract(project_id: str):
    body = json_object_body(app)
    reject_unknown_fields(body, ('response_language', 'effort'))
    effort, language = _effort(body.get('effort')), _language(body.get('response_language'))
    caller = caller_from_event(_event())
    workspace = _workspace()
    table, lock_id = _table(), secrets.token_hex(8)
    doc_config: dict[str, Any] = {'doc_type': 'product_extract', 'response_language': language, 'effort': effort,
                                  'lock_id': lock_id, 'requested_by': actor_from_event(_event())}
    try:
        started = _bound[0](project_id, EXTRACT_JOB_TYPE, doc_config, 'Product extract started.',
                            precheck=_precheck(table, project_id, lock_id, caller.subject, workspace=workspace))
    except Exception:
        proposals.release_lock(table, project_id, lock_id, workspace=workspace)
        raise
    proposals.note_lock_job(table, project_id, lock_id, started['job_id'], workspace=workspace)
    return Response(status_code=202, content_type=content_types.APPLICATION_JSON, body=json.dumps(started))


@app.get("/projects/<project_id>/product-proposals/latest")
@tracer.capture_method
def latest_product_proposal(project_id: str):
    table, workspace = _table(), _workspace()
    state = proposals.context_state(table, project_id, workspace=workspace)
    rows = sorted(list_sources(table, project_id, workspace=workspace),
                  key=lambda row: str(row.get('created_at') or ''), reverse=True)
    docs = [doc_view(row) for row in rows]
    proposal = proposals.latest_row(table, project_id, workspace=workspace)
    live = [doc['doc_id'] for doc in docs if isinstance(doc.get('doc_id'), str)]
    return {'proposal': proposals.proposal_dto(proposal, state, live) if proposal is not None else None,
            'context': {**state.values, 'updated_at': state.updated_at}, 'field_meta': state.meta, 'sources': docs}


@app.post("/projects/<project_id>/product-proposals/<proposal_id>/accept")
@tracer.capture_method
def accept_product_proposal(project_id: str, proposal_id: str):
    body = json_object_body(app)
    reject_unknown_fields(body, ('fields',))
    workspace = _workspace()
    return proposals.accept(_table(), project_id, proposal_id, body,
                            writer_of(_event(), project_id, workspace=workspace), workspace=workspace)


@app.post("/projects/<project_id>/product-proposals/<proposal_id>/dismiss")
@tracer.capture_method
def dismiss_product_proposal(project_id: str, proposal_id: str):
    return proposals.dismiss(_table(), project_id, proposal_id, workspace=_workspace())
