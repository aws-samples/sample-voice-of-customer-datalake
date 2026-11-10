"""The engagement API's wire shapes, pinned in ``schemas/engagement-wire.json`` for the SPA.

One scenario drives the REAL handler (participants, asks, unsubscribe, the feature-request board)
and records every response body by name. The committed fixture must have exactly the same SHAPE
(keys, nesting and JSON types, recursively), so a field the backend adds, drops or retypes fails
here. ``frontend/src/api/engagementWire.contract.test.ts`` parses the same fixture with the SPA's
own Zod normalizers and fails when the UI reads a field the backend never sends or a value
(an enum, a number) degrades to its default. Together they are the contract test of the two sides.

Values are not compared (ids and timestamps change on every run). After a deliberate wire change,
regenerate the fixture: ``VOC_WRITE_ENGAGEMENT_WIRE=1 pytest lambda/api/test/test_engagement_wire_contract.py``.
"""
from __future__ import annotations

import json
import os
from typing import Any

import pytest
from engagement_fixtures import ADMIN, BOARD, BOARD_2, FORM_ID, PUBLIC_PROJECT, call, engagement_world, ok, run_send_job

from shared.test.repo_paths import repo_root

FIXTURE = repo_root() / 'schemas' / 'engagement-wire.json'
WRITE_ENV = 'VOC_WRITE_ENGAGEMENT_WIRE'

SUPPORT = {'customer': 'Example Air', 'deal': 'Example Air fleet', 'impact': 'committed', 'amount_usd': 50_000,
           'contact_email': 'ops@example.com', 'note': 'Blocks the renewal', 'name': 'Kim'}
REQUEST = {'title': 'SSO with SAML', 'description': 'Needed for the enterprise tier', 'customer': 'Acme',
           'deal': 'Acme renewal', 'impact': 'at_risk', 'amount_usd': 120_000, 'contact_email': 'cio@acme.example',
           'note': 'Their IT asks every week', 'name': 'Sam Seller'}


def _board(ctx: Any, bodies: dict[str, Any]) -> None:
    created = ok(ctx, 'POST', '/feature-requests', 201, claims=BOARD, body=REQUEST)
    bodies['fr_create'] = created
    request_id = created['request']['request_id']
    base = f'/feature-requests/{request_id}'
    added = ok(ctx, 'POST', f'{base}/supports', 201, claims=BOARD_2, body=SUPPORT)
    bodies['fr_support_create'] = added
    support = f'{base}/supports/{added["support"]["support_id"]}'
    bodies['fr_support_update'] = ok(ctx, 'PUT', support, claims=BOARD_2, body={**SUPPORT, 'amount_usd': 60_000})
    bodies['fr_update'] = ok(ctx, 'PUT', base, claims=BOARD, body={'title': 'SSO with SAML and OIDC'})
    bodies['fr_status'] = ok(ctx, 'PUT', f'{base}/status', body={'status': 'under_review'})
    bodies['fr_promote'] = ok(ctx, 'POST', f'{base}/promote', body={'project_id': PUBLIC_PROJECT})
    bodies['fr_list'] = ok(ctx, 'GET', '/feature-requests', claims=BOARD)
    bodies['fr_detail'] = ok(ctx, 'GET', base, claims=BOARD_2)
    bodies['fr_support_delete'] = ok(ctx, 'DELETE', support, claims=BOARD_2)


def _boards(ctx: Any, bodies: dict[str, Any]) -> None:
    """The board routes: list (seeds the Sales board), create, read, update, a request with fields, delete."""
    bodies['boards_list'] = ok(ctx, 'GET', '/feature-requests/boards', claims=BOARD)
    bodies['boards_list_admin'] = ok(ctx, 'GET', '/feature-requests/boards')
    bodies['board_create'] = ok(ctx, 'POST', '/feature-requests/boards', 201, body={
        'name': 'Beta feedback', 'template': 'beta', 'description': 'Early access builds',
        'audience': {'mode': 'list', 'domains': ['partner.example'], 'emails': ['kim@acme.example']}})
    board_id = bodies['board_create']['board']['board_id']
    bodies['board_get'] = ok(ctx, 'GET', f'/feature-requests/boards/{board_id}', claims=BOARD_2)
    bodies['board_update'] = ok(ctx, 'PUT', f'/feature-requests/boards/{board_id}', body={'name': 'Beta 2'})
    bodies['fr_create_fields'] = ok(ctx, 'POST', '/feature-requests', 201, claims=BOARD_2, body={
        'board': board_id, 'title': 'Seat map is slow', 'fields': {'area': 'Seat map', 'outcome': 'broken',
                                                                   'rating': 2, 'link': 'https://example.com/b'}})
    bodies['fr_list_board'] = ok(ctx, 'GET', '/feature-requests', claims=BOARD_2, query={'board': board_id})
    empty = ok(ctx, 'POST', '/feature-requests/boards', 201, body={'name': 'Empty', 'template': 'blank'})
    bodies['board_delete'] = ok(ctx, 'DELETE', f'/feature-requests/boards/{empty["board"]["board_id"]}')


def _lists_and_people(ctx: Any, bodies: dict[str, Any]) -> dict[str, str]:
    created = ok(ctx, 'POST', '/participants/lists', 201, body={'name': 'Beta customers', 'kind': 'beta',
                                                                'description': 'Early access'})
    bodies['list_create'] = created
    list_id = created['list']['list_id']
    bodies['list_update'] = ok(ctx, 'PUT', f'/participants/lists/{list_id}', body={'description': 'Early access 2027'})
    bodies['person_create'] = ok(ctx, 'POST', '/participants/people', 201, body={
        'email': 'pat@example.com', 'name': 'Pat', 'company': 'Example Air', 'title': 'Pilot', 'notes': 'Met at a fair',
        'tags': ['pilot'], 'list_ids': [list_id]})
    person_id = bodies['person_create']['person']['person_id']
    bodies['person_update'] = ok(ctx, 'PUT', f'/participants/people/{person_id}', body={'title': 'Captain'})
    bodies['list_members_add'] = ok(ctx, 'POST', f'/participants/lists/{list_id}/members', body={
        'person_ids': [person_id], 'people': [{'email': 'lee@acme.example', 'name': 'Lee'}, {'email': 'nope'}]})
    bodies['project_link'] = ok(ctx, 'POST', f'/participants/projects/{PUBLIC_PROJECT}', body={
        'list_ids': [list_id], 'people': [{'email': 'ana@example.com', 'name': 'Ana'}, {'email': 'nope'}]})
    bodies['project_get'] = ok(ctx, 'GET', f'/participants/projects/{PUBLIC_PROJECT}')
    return {'list_id': list_id, 'person_id': person_id}


def _asks(ctx: Any, world: Any, ids: dict[str, str], bodies: dict[str, Any]) -> None:
    bodies['ask_create'] = ok(ctx, 'POST', '/participants/asks', 202, body={
        'project_id': PUBLIC_PROJECT, 'list_ids': [ids['list_id']], 'subject': 'Two minutes on seat choice',
        'message': 'We changed how seats are chosen.', 'link': {'kind': 'form', 'form_id': FORM_ID}})
    run_send_job(ctx, world)
    # Pat unsubscribes (a fixed person, so the recorded shapes do not depend on the send order).
    (sent,) = [c.kwargs for c in world.ses.send_email.call_args_list
               if c.kwargs['Destination']['ToAddresses'] == ['pat@example.com']]
    text = sent['Content']['Simple']['Body']['Text']['Data']
    token = text.split('/unsubscribe?t=')[1].split()[0]
    status, bodies['unsubscribe'] = call(ctx, 'POST', '/unsubscribe', claims=None, body={'token': token})
    assert status == 200
    ask_id = bodies['ask_create']['ask']['ask_id']
    bodies['asks'] = ok(ctx, 'GET', '/participants/asks', query={'project_id': PUBLIC_PROJECT})
    bodies['ask_detail'] = ok(ctx, 'GET', f'/participants/asks/{ask_id}')
    bodies['people'] = ok(ctx, 'GET', '/participants/people')
    bodies['person_detail'] = ok(ctx, 'GET', f'/participants/people/{ids["person_id"]}')
    bodies['lists'] = ok(ctx, 'GET', '/participants/lists')
    bodies['list_detail'] = ok(ctx, 'GET', f'/participants/lists/{ids["list_id"]}')


def record_wire(ctx: Any) -> dict[str, Any]:
    """Every engagement response body the SPA parses, by name, from one scenario."""
    bodies: dict[str, Any] = {}
    with engagement_world() as world:
        bodies['settings_put'] = ok(ctx, 'PUT', '/participants/settings', body={
            'company_domains': ['example.com', 'acme.example'], 'allow_external_people': True,
            'daily_send_cap': 100, 'sender_name': 'Example Air research'})
        bodies['settings_get'] = ok(ctx, 'GET', '/participants/settings')
        _board(ctx, bodies)
        _boards(ctx, bodies)
        ids = _lists_and_people(ctx, bodies)
        _asks(ctx, world, ids, bodies)
        bodies['error'] = call(ctx, 'POST', '/participants/people', body={'email': 'pat@example.com'})[1]
        bodies['success'] = ok(ctx, 'DELETE', f'/participants/projects/{PUBLIC_PROJECT}/lists/{ids["list_id"]}',
                               claims=ADMIN)
    return bodies


def shape(value: Any) -> Any:
    """The JSON shape: keys and nesting kept, every scalar replaced by its JSON type name."""
    if isinstance(value, dict):
        return {key: shape(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        # The distinct item shapes, in a stable order (item order and which row varies are not the contract).
        distinct = {json.dumps(shape(item), sort_keys=True): shape(item) for item in value}
        return [distinct[key] for key in sorted(distinct)]
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, int | float):
        return 'number'
    return 'null' if value is None else type(value).__name__


def test_the_backend_answers_the_pinned_wire_shapes(lambda_context):
    bodies = record_wire(lambda_context)
    if os.environ.get(WRITE_ENV) == '1':
        FIXTURE.write_text(json.dumps(bodies, indent=2, sort_keys=True) + '\n', encoding='utf-8')
        pytest.skip(f'{FIXTURE.name} rewritten; commit it')
    pinned = json.loads(FIXTURE.read_text(encoding='utf-8'))
    assert sorted(bodies) == sorted(pinned)
    for name, body in bodies.items():
        assert shape(body) == shape(pinned[name]), f'{name}: the wire shape changed; regenerate {FIXTURE.name}'


def test_the_scenario_reaches_every_optional_field_the_spa_reads():
    """Fields absent until something happens must appear somewhere, or the SPA side checks nothing."""
    text = FIXTURE.read_text(encoding='utf-8')
    for field in ('unsubscribed_at', 'feature_request_id', 'project_id', 'list_id', 'list_ids', 'responded_at',
                  'updated_by', 'rejected', 'skipped', 'contact_email', 'note', 'deal', 'share_url',
                  'request_count', 'avg_rating', 'board_id'):
        assert f'"{field}"' in text, field
