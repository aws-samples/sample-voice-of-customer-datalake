"""Participants routes, part 2: project links, asks and the public unsubscribe.

Project routes need view (GET) or edit (writes) on the project
(``shared/project_access.py``; 404 without view). An ask tied to a project needs edit
to create and view to read; an ask list shows a project's asks only to callers who
can view that project. ``POST /unsubscribe`` is PUBLIC and always answers 200.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final
from urllib.parse import urlparse

from aws_lambda_powertools.event_handler.api_gateway import Router
from botocore.exceptions import BotoCoreError, ClientError

from shared import engagement_config, participants_send
from shared.api import get_caller_subject, is_admin
from shared.engagement_common import (
    created,
    id_list,
    is_id,
    optional_text,
    required_text,
)
from shared.engagement_identity import can_view_project, require_project_access, verified_email
from shared.exceptions import ConflictError, NotFoundError, TooManyRequestsError, ValidationError
from shared.logging import logger, tracer
from shared.participants_asks import (
    CAP_SENDER_FIELD,
    DAILY_CAP_REFUSAL,
    MAX_RECIPIENTS,
    PER_SENDER_DAILY_CAP,
    SENDER_CAP_REFUSAL,
    UNSUBSCRIBE_SK,
    ask_view,
    create_ask,
    get_ask,
    list_asks,
    recipient_rows,
    resolve_token,
    sent_today,
    sent_today_by,
)
from shared.participants_intake import collect_people
from shared.participants_lists import (
    LIST_NOT_FOUND,
    LIST_PREFIX,
    get_lists,
    link,
    list_view,
    member_ids,
    project_links,
    unlink,
)
from shared.participants_settings import load_settings
from shared.participants_store import (
    PERSON_NOT_FOUND,
    PERSON_PREFIX,
    get_people,
    is_active,
    mark_unsubscribed,
    person_view,
)
from shared.project_access import LEVEL_EDIT, LEVEL_VIEW
from shared.request_body import json_body_value, json_object_body
from shared.tables import get_aggregates_table

app = Router()
MAX_LIST_IDS: Final = 50
MAX_SUBJECT: Final = 160
MAX_MESSAGE: Final = 4000
MAX_URL: Final = 2000
ASK_NOT_FOUND: Final = 'Ask not found'
_FORM_ID_CHARS: Final = frozenset('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_')


def _event() -> dict[str, Any]:
    return app.current_event.raw_event


def _table() -> Any:
    return engagement_config.participants_table()


# ── Project links ─────────────────────────────────────────────────────────────

def _project_view(table: Any, project_id: str) -> dict[str, Any]:
    list_ids, person_ids = project_links(table, project_id)
    lists = get_lists(table, list_ids)
    reach_ids = {pid for list_id in lists for pid in member_ids(table, list_id)} | set(person_ids)
    everyone = get_people(table, reach_ids)
    return {
        'lists': sorted((list_view(item) for item in lists.values()), key=lambda entry: str(entry.get('name'))),
        'people': sorted((person_view(everyone[pid]) for pid in person_ids if pid in everyone),
                         key=lambda entry: str(entry.get('email', '')).lower()),
        'reach': sum(1 for item in everyone.values() if is_active(item)),
    }


@app.get('/participants/projects/<project_id>')
@tracer.capture_method
def get_project_participants(project_id: str):
    project_id = require_project_access(_event(), project_id, LEVEL_VIEW)
    return _project_view(_table(), project_id)


@app.post('/participants/projects/<project_id>')
@tracer.capture_method
def post_project_participants(project_id: str):
    """Edit: link lists and people (existing ids, or new people by email) to the project."""
    project_id = require_project_access(_event(), project_id, LEVEL_EDIT)
    body = json_object_body(app)
    table = _table()
    sub = get_caller_subject(_event())
    list_ids = id_list(body.get('list_ids'), 'list_ids', LIST_PREFIX, MAX_LIST_IDS)
    if len(get_lists(table, list_ids)) != len(list_ids):
        raise NotFoundError(LIST_NOT_FOUND)
    intake = collect_people(table, load_settings(table, engagement_config.brand_name()), body, created_by=sub)
    for list_id in list_ids:
        link(table, project_id, 'LIST', list_id, sub)
    for person_id in intake.person_ids:
        link(table, project_id, 'PERSON', person_id, sub)
    logger.info('Project participants linked', extra={'project_id': project_id, 'lists': len(list_ids),
                                                      'people': len(intake.person_ids)})
    return {**_project_view(table, project_id), 'created': intake.created, 'rejected': intake.rejected}


@app.delete('/participants/projects/<project_id>/lists/<list_id>')
@tracer.capture_method
def unlink_project_list(project_id: str, list_id: str):
    project_id = require_project_access(_event(), project_id, LEVEL_EDIT)
    if is_id(list_id, LIST_PREFIX):
        unlink(_table(), project_id, 'LIST', list_id)
    return {'success': True}


@app.delete('/participants/projects/<project_id>/people/<person_id>')
@tracer.capture_method
def unlink_project_person(project_id: str, person_id: str):
    project_id = require_project_access(_event(), project_id, LEVEL_EDIT)
    if is_id(person_id, PERSON_PREFIX):
        unlink(_table(), project_id, 'PERSON', person_id)
    return {'success': True}


# ── Asks ──────────────────────────────────────────────────────────────────────

def _api_base() -> str:
    context = _event().get('requestContext') or {}
    host, stage = context.get('domainName'), context.get('stage')
    if not isinstance(host, str) or not host or not isinstance(stage, str) or not stage:
        raise ValidationError('The request has no API host to build links from')
    return f'https://{host}/{stage}'


def _form_exists(form_id: str) -> bool:
    table = get_aggregates_table()
    return table is not None and 'Item' in table.get_item(Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'},
                                                          ProjectionExpression='pk')


def _ask_link(raw: object, api_base: str) -> dict[str, str]:
    """``{kind: 'form', form_id, url: <widget page>}`` or ``{kind: 'url', url}`` (https only)."""
    if not isinstance(raw, dict) or raw.get('kind') not in ('form', 'url'):
        raise ValidationError("link must be {kind: 'form', form_id} or {kind: 'url', url}")
    if raw['kind'] == 'form':
        form_id = raw.get('form_id')
        if not isinstance(form_id, str) or not 0 < len(form_id) <= 64 or set(form_id) - _FORM_ID_CHARS:
            raise ValidationError('link.form_id is not a form id')
        if not _form_exists(form_id):
            raise ValidationError('form_not_found')
        return {'kind': 'form', 'form_id': form_id, 'url': f'{api_base}/feedback-forms/{form_id}/iframe'}
    url = optional_text(raw, 'url', MAX_URL) or ''
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.netloc:
        raise ValidationError('link.url must be an https:// address')
    return {'kind': 'url', 'url': url}


def _recipients(table: Any, body: Mapping[str, Any]) -> list[str]:
    """Every person of the named lists plus the named people, de-duplicated (lists first)."""
    list_ids = id_list(body.get('list_ids'), 'list_ids', LIST_PREFIX, MAX_LIST_IDS)
    person_ids = id_list(body.get('person_ids'), 'person_ids', PERSON_PREFIX, MAX_RECIPIENTS)
    if len(get_lists(table, list_ids)) != len(list_ids):
        raise NotFoundError(LIST_NOT_FOUND)
    ordered: dict[str, None] = {}
    for list_id in list_ids:
        ordered.update(dict.fromkeys(member_ids(table, list_id, limit=MAX_RECIPIENTS + 1)))
        if len(ordered) > MAX_RECIPIENTS:
            raise ValidationError('too_many_recipients')
    ordered.update(dict.fromkeys(person_ids))
    if len(ordered) > MAX_RECIPIENTS:
        raise ValidationError('too_many_recipients')
    return list(ordered)


def _ask_fields(body: Mapping[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    """subject, message, project_id (edit required), link, api_base and the Reply-To address."""
    fields: dict[str, Any] = {'subject': required_text(body, 'subject', MAX_SUBJECT),
                              'message': required_text(body, 'message', MAX_MESSAGE)}
    if body.get('project_id') is not None:
        fields['project_id'] = require_project_access(event, body['project_id'], LEVEL_EDIT)
    api_base = _api_base()
    fields.update(link=_ask_link(body.get('link'), api_base), api_base=api_base,
                  created_by_email=verified_email(event))
    return fields


def _check_capacity(table: Any, active: int, capped_sender: str) -> None:
    """400 without recipients; 429 over the sender's own cap (when they have one) or the deployment's."""
    if not active:
        raise ValidationError('no_recipients')
    if capped_sender and sent_today_by(table, capped_sender) + active > PER_SENDER_DAILY_CAP:
        raise TooManyRequestsError(SENDER_CAP_REFUSAL)
    settings = load_settings(table, engagement_config.brand_name())
    if sent_today(table) + active > int(settings['daily_send_cap']):
        raise TooManyRequestsError(DAILY_CAP_REFUSAL)


@app.post('/participants/asks')
@tracer.capture_method
def post_ask():
    """Create an ask and start sending it (202): see shared/participants_send.py."""
    if not engagement_config.email_from():
        raise ConflictError('email_not_configured')
    body = json_object_body(app)
    event = _event()
    fields = _ask_fields(body, event)
    table = _table()
    recipients = _recipients(table, body)
    people = get_people(table, recipients)
    if any(pid not in people for pid in body.get('person_ids') or ()):
        raise NotFoundError(PERSON_NOT_FOUND)
    recipients = [pid for pid in recipients if pid in people]
    active = sum(1 for pid in recipients if is_active(people[pid]))
    sender = get_caller_subject(event)
    # The per-sender cap holds any signed-in user's asks to 50 emails a day; an administrator, who
    # already sets the deployment's own daily cap, is bounded by that cap only.
    capped_sender = '' if is_admin(event) else sender
    _check_capacity(table, active, capped_sender)
    ask = create_ask(table, {**fields, **({CAP_SENDER_FIELD: capped_sender} if capped_sender else {})},
                     recipients, sender)
    participants_send.start(ask['ask_id'])
    logger.info('Ask created', extra={'ask_id': ask['ask_id'], 'recipients': len(recipients), 'active': active})
    return created({'ask': ask_view(ask)}, status_code=202)


def _listed(ask: Mapping[str, Any], wanted: str | None, event: dict[str, Any], seen: dict[str, bool]) -> bool:
    """Whether ``ask`` belongs in the list: the wanted project's only, else any the caller may view."""
    project_id = ask.get('project_id')
    if wanted:
        return project_id == wanted
    if not isinstance(project_id, str):
        return True
    if project_id not in seen:
        seen[project_id] = can_view_project(event, project_id)
    return seen[project_id]


@app.get('/participants/asks')
@tracer.capture_method
def get_asks():
    params = app.current_event.query_string_parameters or {}
    event = _event()
    wanted = params.get('project_id')
    if wanted:
        wanted = require_project_access(event, wanted, LEVEL_VIEW)
    seen: dict[str, bool] = {}
    return {'asks': [ask_view(ask) for ask in list_asks(_table()) if _listed(ask, wanted, event, seen)]}


def _recipient_view(row: Mapping[str, Any], person: Mapping[str, Any] | None) -> dict[str, Any]:
    """One recipient with the person's email and name read live (None once erased)."""
    return {
        'person_id': row['person_id'], 'email': person.get('email') if person else None,
        'name': person.get('name') if person else None, 'status': row.get('status'),
        'sent_at': row.get('sent_at'), 'responded_at': row.get('responded_at'), 'error': row.get('error'),
    }


@app.get('/participants/asks/<ask_id>')
@tracer.capture_method
def get_one_ask(ask_id: str):
    table = _table()
    ask = get_ask(table, ask_id) if is_id(ask_id, 'ask') else None
    if ask is None:
        raise NotFoundError(ASK_NOT_FOUND)
    if isinstance(ask.get('project_id'), str) and not can_view_project(_event(), ask['project_id']):
        raise NotFoundError(ASK_NOT_FOUND)
    rows = recipient_rows(table, ask_id)
    people = get_people(table, [str(row['person_id']) for row in rows])
    return {'ask': ask_view(ask), 'recipients': [_recipient_view(row, people.get(str(row['person_id'])))
                                                 for row in rows]}


# ── Unsubscribe (PUBLIC) ──────────────────────────────────────────────────────

def _unsubscribe_token() -> object:
    """``?t=`` (RFC 8058 one-click posts a form body, the token is in the URL), else JSON ``{token}``."""
    token = (app.current_event.query_string_parameters or {}).get('t')
    if token:
        return token
    try:
        body = json_body_value(app)
    except ValidationError:
        return None
    return body.get('token') if isinstance(body, dict) else None


@app.post('/unsubscribe')
@tracer.capture_method
def unsubscribe():
    """Always 200 ``{success: true}``: the answer never says whether the token was known."""
    try:
        table = _table()
        row = resolve_token(table, _unsubscribe_token(), UNSUBSCRIBE_SK)
        if row is not None and mark_unsubscribed(table, row['person_id']):
            logger.info('Participant unsubscribed', extra={'person_id': row['person_id']})
    except (ClientError, BotoCoreError):
        logger.exception('Unsubscribe could not be recorded')
    return {'success': True}
