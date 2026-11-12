"""voc-retention: an erasure by email reaches workspace memberships (members.py, docs/multi-workspace.md → Invites).

The person's ``MEMBER#`` rows in voc-workspaces keep the membership and lose the email and name, each after a
contentless tombstone; nothing else in the table changes; other erasures leave the table alone.
"""
from unittest.mock import patch

import pytest
from boto3.dynamodb.conditions import Key

from jobs.retention import handler, members
from shared.digests import sha256_hex

JOB_ID = 'er_00000000abcd'
BASIS = 'GDPR art. 17 request #123'
WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'


def _job(aws, field: str, value: str, source: str | None = None, job_id: str = JOB_ID) -> dict:
    """A queued erasure job row and the event that starts it."""
    job = {'pk': 'JOB#erasure', 'sk': job_id, 'job_id': job_id, 'status': 'queued', 'legal_basis': BASIS}
    job.update(field=field, value_hash=sha256_hex(value))
    if source:
        job['source'] = source
    aws['aggregates'].put_item(Item=job)
    return {'mode': 'erase', 'job_id': job_id, 'value': value}


def _seed(aws) -> None:
    table = aws['workspaces']
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'name': 'Acme Outfitters', 'slug': 'acme', 'status': 'active'})
    for ws, sub, email, name in ((WS, 'sub-jane', 'Jane@Example.com', 'Jane Roe'), (WS_B, 'sub-jane', 'jane@example.com',
                                 'Jane Roe'), (WS, 'sub-john', 'john@example.com', 'John Doe')):
        table.put_item(Item={'pk': f'WS#{ws}', 'sk': f'MEMBER#{sub}', 'role': 'editor', 'invited_by': 'sub-ada',
                             'joined_at': '2026-11-01T00:00:00Z', 'email': email, 'name': name})
    table.put_item(Item={'pk': 'USER#sub-jane', 'sk': f'WS#{WS}', 'name': 'Acme Outfitters', 'slug': 'acme',
                         'role': 'editor'})


def _member(aws, ws: str, sub: str) -> dict:
    return aws['workspaces'].get_item(Key={'pk': f'WS#{ws}', 'sk': f'MEMBER#{sub}'})['Item']


def _tombstones(aws) -> list[dict]:
    return aws['aggregates'].query(
        KeyConditionExpression=Key('pk').eq(f'AUDIT#tombstone#{members.STORE_MEMBERS}'))['Items']


def test_an_erasure_by_email_deidentifies_every_membership_row_of_the_email_in_any_case(aws, worker_context):
    _seed(aws)
    result = handler.handle_event(_job(aws, 'email', 'jane@example.com'), worker_context)
    assert result['member_rows_deidentified'] == 2
    for ws in (WS, WS_B):
        row = _member(aws, ws, 'sub-jane')
        assert 'email' not in row
        assert 'name' not in row
        assert (row['role'], row['invited_by'], row['joined_at']) == ('editor', 'sub-ada', '2026-11-01T00:00:00Z')
    assert _member(aws, WS, 'sub-john')['email'] == 'john@example.com'
    # The workspace's name and the "my workspaces" row (a workspace name, not the person's) are untouched.
    assert aws['workspaces'].get_item(Key={'pk': f'WS#{WS}', 'sk': 'META'})['Item']['name'] == 'Acme Outfitters'
    assert aws['workspaces'].get_item(Key={'pk': 'USER#sub-jane', 'sk': f'WS#{WS}'})['Item']['name'] == 'Acme Outfitters'
    job = aws['aggregates'].get_item(Key={'pk': 'JOB#erasure', 'sk': JOB_ID})['Item']
    assert job['member_rows_deidentified'] == 2


def test_each_row_leaves_a_contentless_tombstone_before_it_changes(aws, worker_context):
    _seed(aws)
    order: list[str] = []
    real_tombstones, real_deidentify = members.MemberEraser.tombstones, members.deidentify
    with patch.object(members.MemberEraser, 'tombstones',
                      lambda self, rows: (order.append('tombstones'), real_tombstones(self, rows))), \
            patch.object(members, 'deidentify', lambda table, row: (order.append('row'), real_deidentify(table, row))[1]):
        handler.handle_event(_job(aws, 'email', 'jane@example.com'), worker_context)
    assert order == ['tombstones', 'row', 'row']
    stones = {row['sk']: row for row in _tombstones(aws)}
    assert set(stones) == {f'{WS}#sub-jane#{JOB_ID}', f'{WS_B}#sub-jane#{JOB_ID}'}
    stone = stones[f'{WS}#sub-jane#{JOB_ID}']
    assert (stone['workspace_id'], stone['legal_basis'], stone['action'], stone['job_id']) == (
        WS, BASIS, 'deidentified', JOB_ID)
    assert 'jane@' not in str(stones).lower()
    assert 'Roe' not in str(stones)
    assert all('ttl' not in row for row in stones.values())


@pytest.mark.parametrize(('field', 'value', 'source'), [
    ('author', 'Jane Roe', None), ('email', 'jane@example.com', 'web'), ('email', 'jane@example.com', 'feature_requests')])
def test_other_erasures_leave_the_memberships_alone(aws, worker_context, field, value, source):
    _seed(aws)
    handler.handle_event(_job(aws, field, value, source), worker_context)
    assert _member(aws, WS, 'sub-jane')['email'] == 'Jane@Example.com'
    assert _tombstones(aws) == []


def test_a_row_removed_since_the_scan_is_not_counted(aws, worker_context):
    _seed(aws)
    real_deidentify = members.deidentify

    def removed_meanwhile(table, row):
        table.delete_item(Key={'pk': row['pk'], 'sk': row['sk']})
        return real_deidentify(table, row)

    with patch.object(members, 'deidentify', removed_meanwhile):
        result = handler.handle_event(_job(aws, 'email', 'jane@example.com'), worker_context)
    assert 'member_rows_deidentified' not in result
    assert aws['workspaces'].get_item(Key={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-jane'}).get('Item') is None


def test_the_member_pass_hands_over_with_its_cursor(aws, worker_context, invoke_mock):
    _seed(aws)
    event = _job(aws, 'email', 'jane@example.com')
    with patch.object(members, 'PAGE_SIZE', 1), patch.object(handler, 'has_time_left', side_effect=[True] * 3 + [False]):
        assert handler.handle_event(event, worker_context)['status'] == 'continued'
    payload = invoke_mock.call_args.args[1]
    assert payload['phase'] == 'members'
    assert payload['run']['member_rows_deidentified'] == 1
    erased = [ws for ws in (WS, WS_B) if 'email' not in _member(aws, ws, 'sub-jane')]
    assert len(erased) == 1
    # The hand-over resumes where the Scan stopped, not from the top of the table.
    assert str(payload['cursor']['sk']).startswith('MEMBER#')
    scanned_from: list = []
    real_scan_page = members.scan_page
    with patch.object(members, 'PAGE_SIZE', 1), patch.object(
            members, 'scan_page', lambda table, value, cursor: (scanned_from.append(cursor),
                                                                 real_scan_page(table, value, cursor))[1]):
        result = handler.handle_event(payload, worker_context)
    assert result['status'] == 'completed'
    assert scanned_from[0] == payload['cursor']
    assert result['member_rows_deidentified'] == 2
    assert 'email' not in _member(aws, WS, 'sub-jane')
    assert 'email' not in _member(aws, WS_B, 'sub-jane')


def test_each_erasure_job_keeps_its_own_tombstone_of_a_membership(aws, worker_context):
    _seed(aws)
    handler.handle_event(_job(aws, 'email', 'jane@example.com'), worker_context)
    aws['workspaces'].update_item(Key={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-jane'},
                                  UpdateExpression='SET email = :e', ExpressionAttributeValues={':e': 'jane@example.com'})
    handler.handle_event(_job(aws, 'email', 'jane@example.com', job_id='er_00000000beef'), worker_context)
    keys = {row['sk'] for row in _tombstones(aws)}
    assert {f'{WS}#sub-jane#{JOB_ID}', f'{WS}#sub-jane#er_00000000beef'} <= keys


def test_without_the_workspaces_table_the_pass_is_skipped(aws, worker_context):
    _seed(aws)
    with patch.object(handler, 'WORKSPACES_TABLE', ''):
        result = handler.handle_event(_job(aws, 'email', 'jane@example.com'), worker_context)
    assert result['status'] == 'completed'
    assert _member(aws, WS, 'sub-jane')['email'] == 'Jane@Example.com'


def test_the_scan_projects_the_key_and_the_email_only_and_matches_member_rows():
    class Table:
        def __init__(self):
            self.kwargs: dict = {}

        def scan(self, **kwargs):
            self.kwargs = kwargs
            return {'Items': [
                {'pk': f'WS#{WS}', 'sk': 'MEMBER#a', 'email': ' JANE@example.com '},
                {'pk': f'WS#{WS}', 'sk': 'META', 'email': 'jane@example.com'},
                {'pk': 'AUDIT#x', 'sk': 'MEMBER#b', 'email': 'jane@example.com'},
                {'pk': f'WS#{WS}', 'sk': 'MEMBER#c', 'email': 'other@example.com'},
            ], 'LastEvaluatedKey': {'pk': 'k', 'sk': 'k'}}

    table = Table()
    page = members.scan_page(table, 'jane@example.com', {'pk': 'p', 'sk': 's'})
    assert page['Items'] == [{'pk': f'WS#{WS}', 'sk': 'MEMBER#a'}]
    assert page['LastEvaluatedKey'] == {'pk': 'k', 'sk': 'k'}
    assert table.kwargs['ExclusiveStartKey'] == {'pk': 'p', 'sk': 's'}
    assert table.kwargs['Limit'] == members.PAGE_SIZE
    assert sorted(table.kwargs['ExpressionAttributeNames'].values()) == ['email', 'pk', 'sk']
