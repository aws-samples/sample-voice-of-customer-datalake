"""The facilitator routes are gated on the row's project.

A session is a public write window onto one prioritization row, and a row belongs
to one project, so the three authenticated routes apply that project's policy
(`shared.project_access`) against real (moto) tables: opening (`POST
/voting-sessions`) and closing (`POST /voting-sessions/{id}/close`) need EDIT,
reading the status (`GET /voting-sessions/{id}`) needs VIEW. A session id is shown
on a screen to a whole room, so it cannot stand in for that check.
"""
from unittest.mock import MagicMock

import pytest
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

OWNER, VIEWER, EDITOR, STRANGER, ADMIN = 'owner-1', 'viewer-1', 'editor-1', 'stranger-1', 'admin-1'


@pytest.fixture
def tables():
    import ballots_handler

    with mock_aws():
        aggregates, projects = pk_sk_table('agg'), pk_sk_table('proj')
        projects.put_item(Item={
            'pk': 'PROJECT#priv', 'sk': 'META', 'project_id': 'priv',
            'visibility': 'private', 'owner_sub': OWNER,
            'members': {VIEWER: {'role': 'viewer'}, EDITOR: {'role': 'editor'}},
        })
        projects.put_item(Item={'pk': 'PROJECT#legacy', 'sk': 'META', 'project_id': 'legacy'})
        projects.put_item(Item={
            'pk': 'PROJECT#gone', 'sk': 'META', 'project_id': 'gone',
            'visibility': 'public', 'status': 'deleted',
        })
        for row_id, project_id in (('r-priv', 'priv'), ('r-legacy', 'legacy'), ('r-gone', 'gone')):
            aggregates.put_item(Item={
                'pk': ballots_handler.PRIORITIZATION_PK,
                'sk': f'{ballots_handler.ROW_SK_PREFIX}{row_id}',
                'project_id': project_id,
            })
        aggregates.put_item(Item={
            'pk': ballots_handler.PRIORITIZATION_PK,
            'sk': f'{ballots_handler.ROW_SK_PREFIX}r-unscoped',
        })
        yield aggregates, projects


def _open(tables, row_id, subject):
    import ballots_handler

    aggregates, projects = tables
    event = rest_event(
        'POST', '/voting-sessions',
        claims={'sub': subject, 'cognito:groups': 'admins' if subject == ADMIN else ''},
        body={'row_id': row_id, 'row_title': 'A row'},
    )
    return invoke(ballots_handler, event, MagicMock(), aggregates=aggregates, projects=projects)


def _session_count(tables):
    import ballots_handler

    aggregates, _ = tables
    return sum(
        1 for item in aggregates.scan()['Items']
        if item['pk'] == ballots_handler.VOTING_SESSION_PK
    )


@pytest.mark.parametrize('subject', [OWNER, EDITOR, ADMIN])
def test_editors_owners_and_admins_can_open_a_session(tables, subject):
    status, body = _open(tables, 'r-priv', subject)
    assert status == 200, body
    assert _session_count(tables) == 1


def test_a_viewer_is_refused_with_403_and_nothing_opens(tables):
    status, body = _open(tables, 'r-priv', VIEWER)
    assert status == 403
    assert body['error'] == 'You do not have permission to edit this project'
    assert _session_count(tables) == 0


def test_a_stranger_gets_the_missing_row_404_so_the_row_is_not_confirmed(tables):
    status, stranger_body = _open(tables, 'r-priv', STRANGER)
    _, missing_body = _open(tables, 'r-nope', STRANGER)
    assert status == 404
    assert stranger_body == missing_body
    assert _session_count(tables) == 0


def test_a_tombstoned_project_reads_as_missing_for_non_admins(tables):
    assert _open(tables, 'r-gone', STRANGER)[0] == 404


@pytest.mark.parametrize('row_id', ['r-legacy', 'r-unscoped'])
def test_legacy_projects_and_unscoped_rows_stay_open_to_every_signed_in_user(tables, row_id):
    assert _open(tables, row_id, STRANGER)[0] == 200


# ---------------------------------------------------------------------------
# GET / close follow the session's project
# ---------------------------------------------------------------------------


def _session_for(tables, row_id, *, project_id=None, stamp_project=True):
    """A session record as `create_voting_session` writes it (optionally pre-dating `project_id`)."""
    import ballots_handler

    aggregates, _ = tables
    session_id = f'{ballots_handler.SESSION_ID_PREFIX}{"ab" * ballots_handler.SESSION_ID_BYTES}'
    item = {
        'pk': ballots_handler.VOTING_SESSION_PK,
        'sk': f'{ballots_handler.SESSION_SK_PREFIX}{session_id}',
        'session_id': session_id, 'row_id': row_id, 'row_title': 'A row',
        'status': ballots_handler.STATUS_OPEN, 'ballot_cap': 40, 'ballot_count': 3,
        'created_by': OWNER, 'created_at': '2026-01-01T00:00:00+00:00',
        'updated_at': '2026-01-01T00:00:00+00:00', 'expires_at': '2999-01-01T00:00:00+00:00',
        'ttl': 32503680000,
    }
    if stamp_project and project_id:
        item['project_id'] = project_id
    aggregates.put_item(Item=item)
    return session_id


def _facilitator(tables, method, path, subject):
    import ballots_handler

    aggregates, projects = tables
    event = rest_event(
        method, path,
        claims={'sub': subject, 'cognito:groups': 'admins' if subject == ADMIN else ''},
    )
    return invoke(ballots_handler, event, MagicMock(), aggregates=aggregates, projects=projects)


def _stored_session(tables, session_id):
    import ballots_handler

    aggregates, _ = tables
    return aggregates.get_item(Key={
        'pk': ballots_handler.VOTING_SESSION_PK,
        'sk': f'{ballots_handler.SESSION_SK_PREFIX}{session_id}',
    })['Item']


def _status_of(tables, session_id):
    return _stored_session(tables, session_id)['status']


def test_opening_a_session_stamps_the_rows_project_on_the_record(tables):
    status, body = _open(tables, 'r-priv', OWNER)
    stored = _stored_session(tables, body['session']['session_id'])
    assert status == 200
    assert stored['project_id'] == 'priv'


def test_opening_a_session_on_an_unscoped_row_stamps_no_project(tables):
    _, body = _open(tables, 'r-unscoped', STRANGER)
    stored = _stored_session(tables, body['session']['session_id'])
    assert 'project_id' not in stored


@pytest.mark.parametrize('subject', [OWNER, EDITOR, VIEWER, ADMIN])
def test_anyone_who_may_view_the_project_reads_the_status(tables, subject):
    session_id = _session_for(tables, 'r-priv', project_id='priv')
    status, body = _facilitator(tables, 'GET', f'/voting-sessions/{session_id}', subject)
    assert status == 200, body
    assert body['session']['ballot_count'] == 3


def test_a_stranger_reading_the_status_gets_the_missing_session_404(tables):
    session_id = _session_for(tables, 'r-priv', project_id='priv')
    status, stranger_body = _facilitator(tables, 'GET', f'/voting-sessions/{session_id}', STRANGER)
    missing_id = session_id[:-2] + 'ff'
    _, missing_body = _facilitator(tables, 'GET', f'/voting-sessions/{missing_id}', STRANGER)
    assert status == 404
    assert stranger_body == missing_body


@pytest.mark.parametrize('subject', [OWNER, EDITOR, ADMIN])
def test_editors_owners_and_admins_close_the_session(tables, subject):
    session_id = _session_for(tables, 'r-priv', project_id='priv')
    status, body = _facilitator(tables, 'POST', f'/voting-sessions/{session_id}/close', subject)
    assert status == 200, body
    assert body['session']['status'] == 'closed'
    assert _status_of(tables, session_id) == 'closed'


def test_a_viewer_cannot_close_and_the_session_stays_open(tables):
    session_id = _session_for(tables, 'r-priv', project_id='priv')
    status, body = _facilitator(tables, 'POST', f'/voting-sessions/{session_id}/close', VIEWER)
    assert status == 403
    assert body['error'] == 'You do not have permission to edit this project'
    assert _status_of(tables, session_id) == 'open'


def test_a_stranger_cannot_close_and_learns_nothing(tables):
    session_id = _session_for(tables, 'r-priv', project_id='priv')
    status, body = _facilitator(tables, 'POST', f'/voting-sessions/{session_id}/close', STRANGER)
    assert (status, body['error']) == (404, 'Voting session not found')
    assert _status_of(tables, session_id) == 'open'


def test_a_session_predating_the_project_stamp_is_gated_through_its_row(tables):
    session_id = _session_for(tables, 'r-priv', stamp_project=False)
    assert _facilitator(tables, 'GET', f'/voting-sessions/{session_id}', STRANGER)[0] == 404
    assert _facilitator(tables, 'GET', f'/voting-sessions/{session_id}', VIEWER)[0] == 200
    assert _facilitator(tables, 'POST', f'/voting-sessions/{session_id}/close', VIEWER)[0] == 403
    assert _facilitator(tables, 'POST', f'/voting-sessions/{session_id}/close', EDITOR)[0] == 200


def test_the_stamp_outlives_the_row(tables):
    """The row is deleted after the vote: the session still belongs to its project."""
    import ballots_handler

    aggregates, _ = tables
    session_id = _session_for(tables, 'r-priv', project_id='priv')
    aggregates.delete_item(Key={
        'pk': ballots_handler.PRIORITIZATION_PK, 'sk': f'{ballots_handler.ROW_SK_PREFIX}r-priv',
    })
    assert _facilitator(tables, 'GET', f'/voting-sessions/{session_id}', STRANGER)[0] == 404
    assert _facilitator(tables, 'GET', f'/voting-sessions/{session_id}', OWNER)[0] == 200


@pytest.mark.parametrize('row_id', ['r-legacy', 'r-unscoped'])
def test_legacy_and_unscoped_sessions_stay_open_to_every_signed_in_user(tables, row_id):
    session_id = _session_for(tables, row_id, stamp_project=False)
    assert _facilitator(tables, 'GET', f'/voting-sessions/{session_id}', STRANGER)[0] == 200
    assert _facilitator(tables, 'POST', f'/voting-sessions/{session_id}/close', STRANGER)[0] == 200
