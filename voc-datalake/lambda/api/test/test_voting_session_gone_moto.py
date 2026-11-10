"""A room vote ends with its row or project (5.34 e2e: a session stayed readable after both were deleted).

Two halves, both against moto:

* the WRITE side — deleting a row (`DELETE /projects/prioritization/rows/{id}`) or a
  project (`DELETE /projects/{id}`) closes the row's open session
  (`shared.voting_session_close`);
* the READ side, the guarantee when that best-effort close did not happen — the public
  config and submit routes refuse a session whose row or project is gone (410 `gone`),
  and the facilitator status read answers 404.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

from shared import voting_session_close

SESSION_ID = 'vs_' + '2b' * 16
ROW_ID = 'r1'
OTHER_ROW_ID = 'r2'
ADMIN = {'sub': 'admin-1', 'cognito:groups': 'admins', 'cognito:username': 'admin'}


@pytest.fixture
def tables():
    with mock_aws():
        aggregates, projects = pk_sk_table('agg'), pk_sk_table('proj')
        projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'visibility': 'public'})
        for row_id in (ROW_ID, OTHER_ROW_ID):
            # Two composed rows, so deleting one is allowed (a default row alone is not).
            aggregates.put_item(Item={'pk': 'PRIORITIZATION', 'sk': f'ROW#{row_id}', 'row_id': row_id,
                                      'project_id': 'p1', 'document_ids': ['d1']})
        aggregates.put_item(Item={
            'pk': 'VOTING_SESSION', 'sk': f'SESSION#{SESSION_ID}', 'session_id': SESSION_ID,
            'row_id': ROW_ID, 'row_title': 'Instant refunds', 'project_id': 'p1', 'status': 'open',
            'ballot_cap': 40, 'ballot_count': 0, 'created_by': 'f', 'created_at': '2026-10-25T10:00:00+00:00',
            'expires_at': '2096-10-02T07:06:40+00:00', 'ttl': 4_000_000_000,
        })
        aggregates.put_item(Item={'pk': 'VOTING_SESSION_ROW', 'sk': f'ROW#{ROW_ID}', 'session_id': SESSION_ID,
                                  'ttl': 4_000_000_000})
        yield aggregates, projects


def _ballots_call(tables, method, path, body=None, claims=None):
    """A ballots route; the public ones simply carry no claims anybody checks."""
    import ballots_handler

    aggregates, projects = tables
    event = rest_event(method, path, claims=claims or {}, body=body, path_params={'session_id': SESSION_ID})
    return invoke(ballots_handler, event, MagicMock(), aggregates=aggregates, projects=projects)


def _public(tables, method, suffix, body=None):
    return _ballots_call(tables, method, f'/voting-sessions/{SESSION_ID}/{suffix}', body)


def _status_read(tables):
    return _ballots_call(tables, 'GET', f'/voting-sessions/{SESSION_ID}', claims=ADMIN)


def _projects_call(tables, method, path):
    import projects_handler

    aggregates, projects = tables
    return invoke(projects_handler, rest_event(method, path, claims=ADMIN), MagicMock(),
                  aggregates=aggregates, projects=projects)


def _delete_row_record(tables):
    aggregates, _ = tables
    aggregates.delete_item(Key={'pk': 'PRIORITIZATION', 'sk': f'ROW#{ROW_ID}'})


def _tombstone_project(tables):
    _, projects = tables
    projects.update_item(Key={'pk': 'PROJECT#p1', 'sk': 'META'}, UpdateExpression='SET #s = :d',
                         ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':d': 'deleted'})


def _session(tables):
    aggregates, _ = tables
    return aggregates.get_item(Key={'pk': 'VOTING_SESSION', 'sk': f'SESSION#{SESSION_ID}'})['Item']


def _ballots(tables):
    aggregates, _ = tables
    return [item for item in aggregates.scan()['Items'] if str(item['sk']).startswith('BALLOT#')]


class TestTheRoomIsToldTheProposalIsGone:
    def test_a_live_session_still_shows_its_form(self, tables):
        status, body = _public(tables, 'GET', 'config')
        assert (status, body['session']['open']) == (200, True)

    @pytest.mark.parametrize('remove', [_delete_row_record, _tombstone_project], ids=['row', 'project'])
    def test_the_config_of_a_session_whose_row_or_project_was_deleted_is_refused(self, tables, remove):
        remove(tables)
        status, body = _public(tables, 'GET', 'config')
        assert (status, body['reason']) == (410, 'gone')
        assert 'Instant refunds' not in json.dumps(body), 'the deleted proposal is not published'

    def test_a_ballot_on_a_session_whose_project_was_deleted_is_refused_and_writes_nothing(self, tables):
        _tombstone_project(tables)
        status, body = _public(tables, 'POST', 'submit', {'impact': 4})
        assert (status, body['reason']) == (410, 'gone')
        assert _ballots(tables) == []
        assert _session(tables)['ballot_count'] == 0, 'no slot of the cap was spent'

    def test_the_facilitator_status_of_a_session_whose_row_was_deleted_is_404(self, tables):
        _delete_row_record(tables)
        assert _status_read(tables)[0] == 404


class TestDeletingCloses:
    def test_deleting_the_row_closes_its_open_vote(self, tables):
        status, _ = _projects_call(tables, 'DELETE', f'/projects/prioritization/rows/{ROW_ID}')
        aggregates, _ = tables
        assert status == 200
        assert _session(tables)['status'] == 'closed'
        assert 'Item' not in aggregates.get_item(Key={'pk': 'VOTING_SESSION_ROW', 'sk': f'ROW#{ROW_ID}'})

    def test_deleting_the_project_closes_its_rows_open_votes(self, tables):
        # The project sweep itself (`projects.delete_project`) has its own suites; this
        # pins what the route does after it.
        with patch('projects_handler.delete_project', return_value={'success': True}):
            status, _ = _projects_call(tables, 'DELETE', '/projects/p1')
        assert status == 200
        assert _session(tables)['status'] == 'closed'

    def test_a_failed_close_never_fails_the_delete_it_rides_on(self):
        table = MagicMock()
        table.get_item.side_effect = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'GetItem')
        assert voting_session_close.close_row_sessions(table, [ROW_ID]) == 0

    def test_an_already_closed_vote_is_left_as_it_is(self, tables):
        aggregates, _ = tables
        aggregates.update_item(Key={'pk': 'VOTING_SESSION', 'sk': f'SESSION#{SESSION_ID}'},
                               UpdateExpression='SET #s = :c, closed_at = :t',
                               ExpressionAttributeNames={'#s': 'status'},
                               ExpressionAttributeValues={':c': 'closed', ':t': 'earlier'})
        assert voting_session_close.close_row_sessions(aggregates, [ROW_ID]) == 0
        assert _session(tables)['closed_at'] == 'earlier'
