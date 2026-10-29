"""Participants routes, part 1: settings, lists and people (docs/participants.md -> API).

Included by ``api/engagement_handler.py`` (voc-engagement-api). Every route is behind
the main Cognito authorizer: any signed-in app user, except the ADMIN routes
(settings write, list delete, person erasure). The resolver below is a Powertools
``Router`` named ``app`` so the route tooling (the admin-gate inventory, vulture's
registered-decorator list) reads it like a handler's own routes.
"""
from __future__ import annotations

from typing import Any

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared import engagement_config
from shared.api import get_caller_subject, require_admin
from shared.engagement_common import created, id_list, is_id, normalize_email
from shared.exceptions import NotFoundError, ValidationError
from shared.logging import logger, tracer
from shared.participants_asks import asks_of_person
from shared.participants_erasure import erase_person
from shared.participants_intake import collect_people
from shared.participants_lists import (
    LIST_NOT_FOUND,
    LIST_PREFIX,
    add_member,
    all_lists,
    create_list,
    delete_list,
    get_lists,
    list_fields,
    list_ids_of_person,
    list_view,
    member_ids,
    remove_member,
    require_list,
    update_list,
)
from shared.participants_settings import SETTINGS_KEY, from_item, load_settings, may_add_person, validate_changes
from shared.participants_store import (
    MAX_PEOPLE_LISTED,
    PERSON_NOT_FOUND,
    PERSON_PREFIX,
    REASON_EXTERNAL,
    create_person,
    get_people,
    list_people,
    matches_query,
    person_fields,
    person_view,
    require_person,
    update_person,
)
from shared.request_body import json_body_value, json_object_body
from shared.timestamps import now_iso

app = Router()
MAX_LIST_IDS: int = 50


def _table() -> Any:
    return engagement_config.participants_table()


def _event() -> dict[str, Any]:
    return app.current_event.raw_event


def _sub() -> str:
    return get_caller_subject(_event())


def _settings(table: Any) -> dict[str, Any]:
    return load_settings(table, engagement_config.brand_name())


def _list_id(raw: str) -> str:
    if not is_id(raw, LIST_PREFIX):
        raise NotFoundError(LIST_NOT_FOUND)
    return raw


def _person_id(raw: str) -> str:
    if not is_id(raw, PERSON_PREFIX):
        raise NotFoundError(PERSON_NOT_FOUND)
    return raw


def _people_views(table: Any, person_ids: list[str]) -> list[dict[str, Any]]:
    people = get_people(table, person_ids)
    return sorted((person_view(item) for item in people.values()), key=lambda p: str(p.get('email', '')).lower())


# ── Settings ──────────────────────────────────────────────────────────────────

@app.get('/participants/settings')
@tracer.capture_method
def get_settings():
    frontend = engagement_config.frontend_url()
    return {
        'settings': _settings(_table()),
        'email_enabled': bool(engagement_config.email_from()),
        'board_enabled': bool(engagement_config.board_pool_id()),
        'board_url': f'{frontend}/board' if frontend else '',
    }


@app.put('/participants/settings')
@tracer.capture_method
def put_settings():
    """Admin: company domains, external people, the daily send cap, the sender name."""
    require_admin(_event())
    try:
        changes = validate_changes(json_body_value(app))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    table = _table()
    stored = table.get_item(Key=SETTINGS_KEY, ConsistentRead=True).get('Item') or {}
    item = {**stored, **changes, **SETTINGS_KEY, 'updated_at': now_iso(), 'updated_by': _sub()}
    table.put_item(Item=item)
    logger.info('Engagement settings saved', extra={'fields': sorted(changes)})
    return {'settings': from_item(item, engagement_config.brand_name())}


# ── Lists ─────────────────────────────────────────────────────────────────────

@app.get('/participants/lists')
@tracer.capture_method
def get_all_lists():
    return {'lists': [list_view(item) for item in all_lists(_table())]}


@app.post('/participants/lists')
@tracer.capture_method
def post_list():
    item = create_list(_table(), list_fields(json_object_body(app), partial=False), _sub())
    return created({'list': list_view(item)})


@app.get('/participants/lists/<list_id>')
@tracer.capture_method
def get_one_list(list_id: str):
    table = _table()
    item = require_list(table, _list_id(list_id))
    return {'list': list_view(item), 'members': _people_views(table, member_ids(table, list_id))}


@app.put('/participants/lists/<list_id>')
@tracer.capture_method
def put_list(list_id: str):
    fields = list_fields(json_object_body(app), partial=True)
    if not fields:
        raise ValidationError('Nothing to update: send name, description or kind')
    return {'list': list_view(update_list(_table(), _list_id(list_id), fields))}


@app.delete('/participants/lists/<list_id>')
@tracer.capture_method
def remove_list(list_id: str):
    """Admin: the list, its memberships and project links go; the people stay."""
    require_admin(_event())
    delete_list(_table(), _list_id(list_id))
    logger.info('Participant list deleted', extra={'list_id': list_id})
    return {'success': True}


@app.post('/participants/lists/<list_id>/members')
@tracer.capture_method
def post_members(list_id: str):
    table = _table()
    require_list(table, _list_id(list_id))
    sub = _sub()
    intake = collect_people(table, _settings(table), json_object_body(app), created_by=sub)
    added = sum(add_member(table, list_id, person_id, sub) for person_id in intake.person_ids)
    logger.info('List members added', extra={'list_id': list_id, 'added': added, 'people_created': intake.created,
                                             'rejected': len(intake.rejected)})
    return {'added': added, 'already': len(intake.person_ids) - added, 'created': intake.created,
            'rejected': intake.rejected}


@app.delete('/participants/lists/<list_id>/members/<person_id>')
@tracer.capture_method
def delete_member(list_id: str, person_id: str):
    table = _table()
    require_list(table, _list_id(list_id))
    remove_member(table, list_id, _person_id(person_id))
    return {'success': True}


# ── People ────────────────────────────────────────────────────────────────────

@app.get('/participants/people')
@tracer.capture_method
def get_people_route():
    params = app.current_event.query_string_parameters or {}
    query = (params.get('q') or '').strip().lower()[:160]
    table = _table()
    list_id = params.get('list_id')
    if not list_id:
        return {'people': [person_view(item) for item in list_people(table, query)]}
    require_list(table, _list_id(list_id))
    members = get_people(table, member_ids(table, list_id)).values()
    matching = sorted((item for item in members if not query or matches_query(item, query)),
                      key=lambda item: str(item.get('email_lc', '')))
    return {'people': [person_view(item) for item in matching[:MAX_PEOPLE_LISTED]]}


@app.post('/participants/people')
@tracer.capture_method
def post_person():
    body = json_object_body(app)
    table = _table()
    try:
        email, email_lc = normalize_email(body.get('email'))
    except ValueError as exc:
        raise ValidationError('invalid_email') from exc
    if not may_add_person(_settings(table), email_lc):
        raise ValidationError(REASON_EXTERNAL)
    list_ids = id_list(body.get('list_ids'), 'list_ids', LIST_PREFIX, MAX_LIST_IDS)
    if len(get_lists(table, list_ids)) != len(list_ids):
        raise NotFoundError(LIST_NOT_FOUND)
    sub = _sub()
    item = create_person(table, email=email, email_lc=email_lc, fields=person_fields(body), origin='manual',
                         created_by=sub)
    joined = {list_id for list_id in list_ids if add_member(table, list_id, item['person_id'], sub)}
    logger.info('Participant created', extra={'person_id': item['person_id'], 'lists': len(joined)})
    return created({'person': person_view({**item, 'list_ids': joined})})


@app.get('/participants/people/<person_id>')
@tracer.capture_method
def get_person_route(person_id: str):
    table = _table()
    item = require_person(table, _person_id(person_id))
    lists = get_lists(table, list_ids_of_person(table, person_id))
    return {'person': person_view(item),
            'lists': sorted((list_view(entry) for entry in lists.values()), key=lambda entry: str(entry.get('name'))),
            'asks': asks_of_person(table, person_id)}


@app.put('/participants/people/<person_id>')
@tracer.capture_method
def put_person(person_id: str):
    body = json_object_body(app)
    if 'email' in body:
        raise ValidationError('email cannot be changed: add the new address as a new person')
    fields = person_fields(body)
    if not fields:
        raise ValidationError('Nothing to update: send name, company, title, notes or tags')
    return {'person': person_view(update_person(_table(), _person_id(person_id), fields))}


@app.delete('/participants/people/<person_id>')
@tracer.capture_method
def erase_person_route(person_id: str):
    """Admin: erase the person (docs/participants.md -> Erasure)."""
    require_admin(_event())
    erase_person(_table(), _person_id(person_id))
    return {'success': True}
