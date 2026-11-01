"""Copying personas into and out of a project (docs/project-workspace.md → Company personas).

Included by ``api/projects_handler.py``; its project-access middleware has already gated the
project in the path (``shared.project_access.required_level``: copy-sources GET = view, copy and
promote POST = edit):

- ``POST /projects/{id}/personas/{persona_id}/promote`` — an admin copies a project persona into
  the company library (201 ``{success, persona}``);
- ``GET /projects/{id}/personas/copy-sources`` — the library, and the OTHER projects the caller
  owns or is a member of that have personas;
- ``POST /projects/{id}/personas/copy`` — copy personas in from the library or from one of those
  projects (201 ``{success, personas}``).

A source project the caller neither owns nor is a member of is a 404 like a missing one, also when
it is public and for an admin (by design: membership, not visibility, makes a source).
"""
from __future__ import annotations

import json
import os
from collections.abc import Iterator
from decimal import Decimal
from typing import Final

from aws_lambda_powertools.event_handler import Response, content_types
from aws_lambda_powertools.event_handler.api_gateway import Router
from boto3.dynamodb.conditions import Key

from shared import company_personas_routes, persona_copy
from shared.api import decimal_default
from shared.aws import get_s3_client
from shared.company_personas import (
    COMPANY_PERSONAS_CONTAINER,
    company_persona_items,
    ensure_company_personas_meta,
    is_company_container,
    persona_summary,
)
from shared.dynamo_paging import iter_query
from shared.exceptions import NotFoundError, ValidationError
from shared.indexes import PROJECTS_BY_TYPE_INDEX
from shared.logging import tracer
from shared.persona_save import count_personas
from shared.project_access import Caller, project_members
from shared.project_gate import PROJECT_NOT_FOUND, require_admin_caller
from shared.project_writes import is_project_tombstone, is_verification_fixture, project_meta_key
from shared.request_body import json_object_body

app = Router()

MAX_COPY_PERSONAS: Final = 20
MAX_PERSONA_ID_CHARS: Final = 200
MAX_COPY_SOURCE_PROJECTS: Final = 100


_table = company_personas_routes.projects_table


def _caller() -> Caller:
    return company_personas_routes.caller_of(app)


def _require_admin() -> None:
    """403 unless an admin acting for themselves: only admins write the company library."""
    require_admin_caller(_caller())


def _created(body: dict) -> Response:
    return Response(status_code=201, content_type=content_types.APPLICATION_JSON,
                    body=json.dumps(body, default=decimal_default))


def _signed(personas: list[dict]) -> list[dict]:
    return company_personas_routes.ops().sign_avatars(personas)


def _live_meta(project_id: str) -> dict:
    """The project's META, or a 404 when it is missing or being deleted."""
    item = _table().get_item(Key=project_meta_key(project_id), ConsistentRead=True).get('Item')
    if not isinstance(item, dict) or is_project_tombstone(item):
        raise NotFoundError(PROJECT_NOT_FOUND)
    return item


def _is_owner_or_member(meta: dict, caller: Caller) -> bool:
    subject = caller.subject
    return bool(subject) and (meta.get('owner_sub') == subject or subject in project_members(meta))


def _copy(*, source: str, scope: persona_copy.SourceScope, name: str, ids: list[str], target: str) -> list[dict]:
    return persona_copy.copy_personas(
        _table(), get_s3_client(), os.environ.get('RAW_DATA_BUCKET', ''),
        source_container=source, source_scope=scope, source_project_name=name,
        persona_ids=ids, target_container=target, copied_by=_caller().subject,
    )


@app.post("/projects/<project_id>/personas/<persona_id>/promote")
@tracer.capture_method
def promote_persona(project_id: str, persona_id: str):
    """An admin copies one project persona into the company library (notes stay behind)."""
    _require_admin()
    meta = _live_meta(project_id)
    ensure_company_personas_meta(_table())
    copies = _copy(source=project_id, scope='project', name=str(meta.get('name') or ''),
                   ids=[persona_id], target=COMPANY_PERSONAS_CONTAINER)
    return _created({'success': True, 'persona': _signed(copies)[0]})


def _member_projects(caller: Caller, exclude: str) -> Iterator[dict]:
    """Live project METAs (index order) that ``caller`` owns or is a member of, except ``exclude``."""
    for item in iter_query(_table(), {
        'IndexName': PROJECTS_BY_TYPE_INDEX, 'KeyConditionExpression': Key('gsi1pk').eq('TYPE#PROJECT'),
    }):
        project_id = item.get('project_id')
        if (
            isinstance(project_id, str) and project_id != exclude
            and not is_project_tombstone(item) and not is_verification_fixture(item)
            and _is_owner_or_member(item, caller)
        ):
            yield item


def _persona_count(item: dict) -> int:
    """The META's stored ``persona_count`` (kept by ``store_persona_count``); counted only when absent (legacy)."""
    stored = item.get('persona_count')
    if isinstance(stored, (int, Decimal)) and not isinstance(stored, bool):
        return int(stored)
    return count_personas(_table(), str(item['project_id']))


def _source_projects(caller: Caller, exclude: str) -> list[dict]:
    """``[{project_id, name, persona_count}]`` with personas, by name, at most 100."""
    sources = []
    for item in _member_projects(caller, exclude):
        count = _persona_count(item)
        if count > 0:
            sources.append({'project_id': item['project_id'], 'name': str(item.get('name') or ''),
                            'persona_count': count})
    sources.sort(key=lambda source: (source['name'].casefold(), source['project_id']))
    return sources[:MAX_COPY_SOURCE_PROJECTS]


@app.get("/projects/<project_id>/personas/copy-sources")
@tracer.capture_method
def persona_copy_sources(project_id: str):
    company = [persona_summary(p) for p in _signed(company_persona_items(_table()))]
    return {'company': company, 'projects': _source_projects(_caller(), project_id)}


def _persona_ids(raw: object) -> list[str]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_COPY_PERSONAS:
        raise ValidationError(f'persona_ids must list between 1 and {MAX_COPY_PERSONAS} persona ids')
    ids = [value for value in raw if isinstance(value, str) and value.strip()
           and value == value.strip() and len(value) <= MAX_PERSONA_ID_CHARS]
    if len(ids) != len(raw) or len(set(ids)) != len(ids):
        raise ValidationError('persona_ids must be unique, non-empty persona ids')
    return ids


def _source_of(raw: object, target: str) -> tuple[persona_copy.SourceScope, str]:
    """``(scope, source project id)`` of the body's ``source`` ('' for the library); 400 when malformed."""
    if not isinstance(raw, dict) or raw.get('scope') not in ('company', 'project'):
        raise ValidationError("source.scope must be 'company' or 'project'")
    if raw['scope'] == 'company':
        return 'company', ''
    source_id = raw.get('project_id')
    if not isinstance(source_id, str) or not source_id.strip() or source_id != source_id.strip():
        raise ValidationError('source.project_id is required')
    if source_id == target:
        raise ValidationError('Choose another project to copy personas from')
    return 'project', source_id


def _source_project_name(source_id: str) -> str:
    """The source project's name; 404 unless the caller owns it or is a member (no existence leak)."""
    if is_company_container(source_id):
        raise NotFoundError(PROJECT_NOT_FOUND)
    meta = _live_meta(source_id)
    if not _is_owner_or_member(meta, _caller()):
        raise NotFoundError(PROJECT_NOT_FOUND)
    return str(meta.get('name') or '')


@app.post("/projects/<project_id>/personas/copy")
@tracer.capture_method
def copy_personas_in(project_id: str):
    """Copy personas into this project from the library or another project of the caller's."""
    body = json_object_body(app)
    scope, source_id = _source_of(body.get('source'), project_id)
    ids = _persona_ids(body.get('persona_ids'))
    if scope == 'company':
        copies = _copy(source=COMPANY_PERSONAS_CONTAINER, scope='company', name='', ids=ids, target=project_id)
    else:
        name = _source_project_name(source_id)
        copies = _copy(source=source_id, scope='project', name=name, ids=ids, target=project_id)
    return _created({'success': True, 'personas': _signed(copies)})
