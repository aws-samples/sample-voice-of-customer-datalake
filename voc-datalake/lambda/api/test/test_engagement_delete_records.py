"""Feedback-board deletes are recorded (shared/delete_audit.py): requests, +1s and boards."""
from __future__ import annotations

import pytest
from boto3.dynamodb.conditions import Key
from engagement_fixtures import ADMIN, BOARD, BOARD_2, USER, boards_world, engagement_world, ok

from shared.participants_settings import SETTINGS_KEY

ADMIN_ACTOR = {'sub': 'admin-sub', 'kind': 'admin'}


@pytest.fixture
def world():
    with engagement_world() as w:
        w.participants.put_item(Item={**SETTINGS_KEY, 'company_domains': ['acme.example']})
        yield w


def _audit(world) -> list[dict]:
    return world.requests.query(KeyConditionExpression=Key('pk').eq('AUDIT#delete'))['Items']


def _request(ctx) -> str:
    body = {'title': 'SSO', 'description': 'Needed', 'customer': 'Acme', 'deal': 'Renewal', 'impact': 'at_risk',
            'amount_usd': 1, 'name': 'Sam'}
    return ok(ctx, 'POST', '/feature-requests', 201, claims=BOARD, body=body)['request']['request_id']


def test_a_deleted_request_is_recorded_as_the_admin(world, lambda_context):
    request_id = _request(lambda_context)
    ok(lambda_context, 'DELETE', f'/feature-requests/{request_id}', claims=ADMIN)
    [row] = _audit(world)
    assert (row['kind'], row['target']['request_id'], row['actor']) == ('feature_request', request_id, ADMIN_ACTOR)
    assert 'ttl' not in row


def test_a_removed_support_is_recorded_as_its_board_pool_owner_never_admin(world, lambda_context):
    request_id = _request(lambda_context)
    body = {'customer': 'Example Air', 'impact': 'committed', 'amount_usd': 5, 'name': 'Kim'}
    support_id = ok(lambda_context, 'POST', f'/feature-requests/{request_id}/supports', 201, claims=BOARD_2,
                    body=body)['support']['support_id']
    ok(lambda_context, 'DELETE', f'/feature-requests/{request_id}/supports/{support_id}', claims=BOARD_2)
    [row] = _audit(world)
    assert (row['kind'], row['target'], row['actor']) == (
        'feature_request_support', {'request_id': request_id, 'support_id': support_id},
        {'sub': 'board-sub-2', 'kind': 'user'})


def test_a_board_deleted_with_its_requests_records_each_and_the_board(lambda_context):
    with boards_world() as world:
        board = ok(lambda_context, 'POST', '/feature-requests/boards', 201,
                   body={'name': 'Beta feedback', 'template': 'beta'})['board']
        request_id = ok(lambda_context, 'POST', '/feature-requests', 201, claims=USER, body={
            'board': board['board_id'], 'title': 'Slow', 'fields': {'area': 'Seats', 'outcome': 'broken'}},
        )['request']['request_id']
        removal = ok(lambda_context, 'DELETE', f"/feature-requests/boards/{board['board_id']}",
                     query={'with_requests': 'true'})
        rows = sorted(_audit(world), key=lambda r: r['kind'])
    assert removal['done'] is True
    assert [(r['kind'], r.get('reason')) for r in rows] == [('feature_board', None), ('feature_request', 'board deleted')]
    assert rows[0]['target'] == {'board_id': board['board_id']}
    assert rows[1]['target'] == {'request_id': request_id, 'board_id': board['board_id']}
    assert [r['actor'] for r in rows] == [ADMIN_ACTOR, ADMIN_ACTOR]


def test_a_removed_member_and_a_deleted_list_are_recorded(world, lambda_context):
    list_id = ok(lambda_context, 'POST', '/participants/lists', 201, body={'name': 'Beta', 'kind': 'beta'})['list']['list_id']
    person_id = ok(lambda_context, 'POST', '/participants/people', 201, body={'email': 'pat@example.com'})['person']['person_id']
    ok(lambda_context, 'POST', f'/participants/lists/{list_id}/members', body={'person_ids': [person_id]})
    path = f'/participants/lists/{list_id}/members/{person_id}'
    ok(lambda_context, 'DELETE', path)
    ok(lambda_context, 'DELETE', path)  # no longer a member: nothing to record
    ok(lambda_context, 'DELETE', f'/participants/lists/{list_id}')
    rows = world.participants.query(KeyConditionExpression=Key('pk').eq('AUDIT#delete'))['Items']
    assert sorted((r['kind'], tuple(sorted(r['target'].items()))) for r in rows) == [
        ('participant_list', (('list_id', list_id),)),
        ('participant_list_member', (('list_id', list_id), ('person_id', person_id))),
    ]
    assert 'pat@example.com' not in str(rows)
