"""The company persona library API, ``/company-personas`` (docs/project-workspace.md → Company personas).

Included by ``api/projects_handler.py`` and served by the projects Lambda. Every signed-in user
reads the library; every write is a non-delegated admin's (owner decision). The writes run the
SAME code the project persona routes run, on the reserved container
(``shared.company_personas.COMPANY_PERSONAS_CONTAINER``): the handler hands those functions in
through ``configure`` (``PersonaOps``), because an API bundle ships only the handler, ``projects.py``
and ``shared/`` — this module cannot import them.

Generation is always ADDITIVE here: replace mode would wipe the library.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from aws_lambda_powertools.event_handler import Response
from aws_lambda_powertools.event_handler.api_gateway import Router

from shared.company_personas import (
    COMPANY_PERSONAS_CONTAINER,
    company_persona_items,
    ensure_company_personas_meta,
    without_copier,
)
from shared.document_review_routes import CALLER_CONTEXT_KEY
from shared.exceptions import AuthorizationError, ConfigurationError
from shared.logging import tracer
from shared.project_access import Caller
from shared.project_gate import acts_as_admin, require_admin_caller
from shared.request_body import json_object_body
from shared.tables import configured_table, get_projects_table

app = Router()

CONTAINER = COMPANY_PERSONAS_CONTAINER


@dataclass(frozen=True)
class PersonaOps:
    """The project persona functions the library reuses, bound by ``projects_handler``.

    Each takes the container id where a project route takes its project id.
    """

    start_generation: Callable[[str, dict], dict]
    start_import: Callable[[str, dict], dict]
    start_avatar: Callable[[str, str], Response]
    job_list: Callable[[str], dict]
    job_status: Callable[[str, str], dict]
    update_persona: Callable[[str, str, dict], dict]
    delete_persona: Callable[[str, str], dict]
    add_note: Callable[[str, str, dict], dict]
    require_persona: Callable[[str, str], None]
    sign_avatars: Callable[[list[dict]], list[dict]]


_bound: list[PersonaOps] = []


def configure(ops: PersonaOps) -> None:
    """Bind the handler's persona functions (once, at import of the handler)."""
    _bound[:] = [ops]


def ops() -> PersonaOps:
    if not _bound:
        raise ConfigurationError('Company persona routes are not configured')
    return _bound[0]


def projects_table() -> Any:
    return configured_table(get_projects_table(), 'Projects')


def caller_of(router: Router) -> Caller:
    """The caller the handler's middleware put in ``router``'s context; 403 when there is none."""
    caller = router.context.get(CALLER_CONTEXT_KEY)
    if not isinstance(caller, Caller):
        raise AuthorizationError('Caller identity could not be determined')
    return caller


def request_caller() -> Caller:
    return caller_of(app)


def _require_admin() -> None:
    """403 unless an admin acting for themselves (never a delegated credential or an agent)."""
    require_admin_caller(request_caller())


def _writable_library() -> None:
    """The container's META exists before any write or job (persona-save checks it)."""
    ensure_company_personas_meta(projects_table())


#: Storage keys never returned by the library read.
STORAGE_KEYS = frozenset({'pk', 'sk', 'gsi1pk', 'gsi1sk'})


def public_persona(persona: dict, *, admin: bool) -> dict:
    """A library persona as the API returns it: no storage keys; who copied it only for admins."""
    shown = {key: value for key, value in persona.items() if key not in STORAGE_KEYS}
    provenance = shown.get('copied_from')
    if not admin and isinstance(provenance, dict):
        shown['copied_from'] = without_copier(provenance)
    return shown


@app.get("/company-personas")
@tracer.capture_method
def list_company_personas():
    """``{personas, can_edit}``, newest first: every signed-in user reads the library."""
    admin = acts_as_admin(request_caller())
    personas = ops().sign_avatars(company_persona_items(projects_table()))
    return {'personas': [public_persona(persona, admin=admin) for persona in personas], 'can_edit': admin}


@app.post("/company-personas/generate")
@tracer.capture_method
def generate_company_personas():
    _require_admin()
    body = json_object_body(app)
    _writable_library()
    return ops().start_generation(CONTAINER, {**body, 'keep_existing_personas': True})


@app.post("/company-personas/import")
@tracer.capture_method
def import_company_persona():
    _require_admin()
    body = json_object_body(app)
    _writable_library()
    return ops().start_import(CONTAINER, body)


#: Job fields a non-admin reader of the library's jobs list never gets (the starter's sub, raw errors, results).
ADMIN_ONLY_JOB_FIELDS = frozenset({'error', 'result', 'initiated_by'})


@app.get("/company-personas/jobs")
@tracer.capture_method
def list_company_persona_jobs():
    """Every reader sees job progress; only admins (who start the jobs) see who started one and why it failed."""
    caller = request_caller()
    listing = ops().job_list(CONTAINER)
    if acts_as_admin(caller):
        return listing
    jobs = [{key: value for key, value in job.items() if key not in ADMIN_ONLY_JOB_FIELDS}
            for job in listing.get('jobs', [])]
    return {**listing, 'jobs': jobs}


@app.get("/company-personas/jobs/<job_id>")
@tracer.capture_method
def get_company_persona_job(job_id: str):
    _require_admin()
    return ops().job_status(CONTAINER, job_id)


@app.put("/company-personas/<persona_id>")
@tracer.capture_method
def update_company_persona(persona_id: str):
    _require_admin()
    body = json_object_body(app)
    ops().require_persona(CONTAINER, persona_id)
    return ops().update_persona(CONTAINER, persona_id, body)


@app.delete("/company-personas/<persona_id>")
@tracer.capture_method
def delete_company_persona(persona_id: str):
    """Hard delete, like a project persona; its avatar objects go with it."""
    _require_admin()
    ops().require_persona(CONTAINER, persona_id)
    _writable_library()
    return ops().delete_persona(CONTAINER, persona_id)


@app.post("/company-personas/<persona_id>/notes")
@tracer.capture_method
def add_company_persona_note(persona_id: str):
    _require_admin()
    body = json_object_body(app)
    ops().require_persona(CONTAINER, persona_id)
    return ops().add_note(CONTAINER, persona_id, body)


@app.post("/company-personas/<persona_id>/regenerate-avatar")
@tracer.capture_method
def regenerate_company_persona_avatar(persona_id: str):
    """202 + an assist job; poll ``GET /company-personas/jobs/{job_id}``."""
    _require_admin()
    ops().require_persona(CONTAINER, persona_id)
    _writable_library()
    return ops().start_avatar(CONTAINER, persona_id)
