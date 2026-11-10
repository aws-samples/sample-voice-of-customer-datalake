"""Per-project permissions on the prioritization board, against real (moto) tables.

`/projects/prioritization*` is a workspace route the central access gate skips, but
every row is composed from ONE project's documents. These tests pin that the board
applies the project's policy per row: composing needs EDIT, scoring needs VIEW, and
the page read withholds rows of projects the caller cannot VIEW.
"""
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

OWNER, VIEWER, EDITOR, STRANGER, ADMIN = 'owner-1', 'viewer-1', 'editor-1', 'stranger-1', 'admin-1'
AXES = {'impact': 4, 'time_to_market': 3, 'confidence': 2, 'strategic_fit': 5}


def _seed_project(projects, project_id, **meta):
    projects.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': 'META',
                            'project_id': project_id, 'name': project_id, **meta})
    projects.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': 'PRD#d1',
                            'document_id': f'{project_id}-prd', 'created_at': '2026-01-01'})
    projects.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': 'PRFAQ#d2',
                            'document_id': f'{project_id}-prfaq', 'created_at': '2026-01-02'})


def _seed(projects):
    _seed_project(projects, 'priv', visibility='private', owner_sub=OWNER, members={
        VIEWER: {'role': 'viewer', 'username': 'vic'},
        EDITOR: {'role': 'editor', 'username': 'eddie'},
    })
    _seed_project(projects, 'pub', visibility='public', owner_sub=OWNER)
    _seed_project(projects, 'legacy')  # no visibility, no owner: reads public
    return projects


def _call(aggregates, projects, method, path, body=None, subject=ADMIN):
    import projects_handler

    groups = 'admins' if subject == ADMIN else ''
    event = rest_event(method, path, claims={'sub': subject, 'cognito:groups': groups}, body=body)
    return invoke(projects_handler, event, MagicMock(), aggregates=aggregates, projects=projects)


def _compose(aggregates, projects, project_id, subject=ADMIN):
    return _call(aggregates, projects, 'POST', '/projects/prioritization/rows/compose',
                 {'project_id': project_id,
                  'document_ids': [f'{project_id}-prd', f'{project_id}-prfaq']},
                 subject=subject)


def _row_keys(aggregates):
    return [i['sk'] for i in aggregates.scan()['Items'] if i['sk'].startswith('ROW#')]


@pytest.fixture
def tables():
    with mock_aws():
        yield pk_sk_table('aggr'), _seed(pk_sk_table('projects'))


class TestComposingNeedsEditOnTheProject:

    def test_a_stranger_gets_404_for_a_private_project_and_nothing_is_written(self, tables):
        aggregates, projects = tables
        status, body = _compose(aggregates, projects, 'priv', subject=STRANGER)
        assert status == 404
        assert body['error'] == 'Project not found'
        assert _row_keys(aggregates) == []

    def test_a_viewer_member_gets_403(self, tables):
        aggregates, projects = tables
        status, body = _compose(aggregates, projects, 'priv', subject=VIEWER)
        assert status == 403
        assert body['error'] == 'You do not have permission to edit this project'
        assert _row_keys(aggregates) == []

    @pytest.mark.parametrize('subject', [EDITOR, OWNER, ADMIN])
    def test_an_editor_owner_or_admin_composes(self, tables, subject):
        aggregates, projects = tables
        status, body = _compose(aggregates, projects, 'priv', subject=subject)
        assert status == 200
        assert body['row']['project_id'] == 'priv'

    @pytest.mark.parametrize('project_id', ['pub', 'legacy'])
    def test_public_and_legacy_projects_stay_open_to_any_signed_in_user(self, tables, project_id):
        aggregates, projects = tables
        status, _ = _compose(aggregates, projects, project_id, subject=STRANGER)
        assert status == 200

    def test_a_legacy_meta_with_no_access_attributes_is_found_by_the_gate(self, tables):
        """A projection matching NO attribute returns an empty item; the gate must
        still read the project as existing (and public), not 404 it."""
        import projects_handler
        from shared.project_access import Caller

        _, projects = tables
        with patch.object(projects_handler, 'get_projects_table', return_value=projects):
            access = projects_handler._project_access_for(
                'legacy', Caller(subject=STRANGER), 'edit')
        assert access.can_edit

    def test_the_default_row_create_is_gated_the_same_way(self, tables):
        aggregates, projects = tables
        path = '/projects/prioritization/rows'
        assert _call(aggregates, projects, 'POST', path, {'project_id': 'priv'},
                     subject=STRANGER)[0] == 404
        assert _call(aggregates, projects, 'POST', path, {'project_id': 'priv'},
                     subject=VIEWER)[0] == 403
        assert _call(aggregates, projects, 'POST', path, {'project_id': 'priv'},
                     subject=EDITOR)[0] == 200


class TestRecomposingNeedsEditOnTheRowsProject:

    def test_a_stranger_naming_a_private_row_via_a_public_project_gets_404(self, tables):
        aggregates, projects = tables
        row_id = _compose(aggregates, projects, 'priv')[1]['row']['row_id']
        status, _ = _call(aggregates, projects, 'PATCH',
                          f'/projects/prioritization/rows/{row_id}',
                          {'project_id': 'pub', 'document_ids': ['pub-prd']},
                          subject=STRANGER)
        assert status == 404

    def test_a_viewer_gets_403_and_an_editor_recomposes(self, tables):
        aggregates, projects = tables
        row_id = _compose(aggregates, projects, 'priv')[1]['row']['row_id']
        path = f'/projects/prioritization/rows/{row_id}'
        body = {'project_id': 'priv', 'document_ids': ['priv-prd']}
        assert _call(aggregates, projects, 'PATCH', path, body, subject=VIEWER)[0] == 403
        status, result = _call(aggregates, projects, 'PATCH', path, body, subject=EDITOR)
        assert status == 200
        assert result['row']['document_ids'] == ['priv-prd']


class TestThePageReadWithholdsRowsTheCallerCannotView:

    def _board(self, aggregates, projects):
        rows = {pid: _compose(aggregates, projects, pid)[1]['row']['row_id']
                for pid in ('priv', 'pub', 'legacy')}
        # An admin ballot on the private row, so its aggregate exists.
        assert _call(aggregates, projects, 'PATCH', '/projects/prioritization',
                     {'scores': {rows['priv']: AXES}})[0] == 200
        return rows

    def test_a_stranger_sees_only_public_and_legacy_rows(self, tables):
        aggregates, projects = tables
        rows = self._board(aggregates, projects)
        status, body = _call(aggregates, projects, 'GET', '/projects/prioritization',
                             subject=STRANGER)
        assert status == 200
        assert set(body['rows']) == {rows['pub'], rows['legacy']}
        assert rows['priv'] not in body['aggregates']
        assert rows['priv'] not in body['scores']

    @pytest.mark.parametrize('subject', [VIEWER, EDITOR, OWNER, ADMIN])
    def test_members_owner_and_admin_see_the_private_row(self, tables, subject):
        aggregates, projects = tables
        rows = self._board(aggregates, projects)
        _, body = _call(aggregates, projects, 'GET', '/projects/prioritization',
                        subject=subject)
        assert set(body['rows']) == set(rows.values())
        assert rows['priv'] in body['aggregates']

    def test_a_row_whose_project_is_gone_shows_to_admins_only(self, tables):
        aggregates, projects = tables
        row_id = _compose(aggregates, projects, 'pub')[1]['row']['row_id']
        projects.delete_item(Key={'pk': 'PROJECT#pub', 'sk': 'META'})
        assert row_id in _call(aggregates, projects, 'GET',
                               '/projects/prioritization')[1]['rows']
        assert row_id not in _call(aggregates, projects, 'GET', '/projects/prioritization',
                                   subject=STRANGER)[1]['rows']


class TestScoringNeedsViewOnTheRowsProject:

    def test_a_stranger_cannot_score_a_private_row_and_nothing_is_written(self, tables):
        aggregates, projects = tables
        priv = _compose(aggregates, projects, 'priv')[1]['row']['row_id']
        pub = _compose(aggregates, projects, 'pub')[1]['row']['row_id']
        status, _ = _call(aggregates, projects, 'PATCH', '/projects/prioritization',
                          {'scores': {pub: AXES, priv: AXES}}, subject=STRANGER)
        assert status == 404
        assert not [i for i in aggregates.scan()['Items'] if i['sk'].startswith('BALLOT#')]

    def test_a_viewer_member_may_score(self, tables):
        aggregates, projects = tables
        priv = _compose(aggregates, projects, 'priv')[1]['row']['row_id']
        status, body = _call(aggregates, projects, 'PATCH', '/projects/prioritization',
                             {'scores': {priv: AXES}}, subject=VIEWER)
        assert status == 200
        assert body['updated_count'] == 1


class TestTheBatchedAccessRead:

    def test_more_than_one_batch_of_projects_is_resolved(self, tables):
        import projects_handler
        from shared.project_access import Caller

        _, projects = tables
        ids = [f'bulk-{n:03d}' for n in range(150)]
        for project_id in ids:
            projects.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': 'META'})
        with patch.object(projects_handler, 'get_projects_table', return_value=projects):
            viewable = projects_handler._viewable_project_ids(
                [*ids, 'priv', 'missing'], Caller(subject=STRANGER))
        assert viewable == set(ids)

    def _stub_table(self, *responses):
        client = MagicMock()
        client.batch_get_item.side_effect = list(responses)
        table = MagicMock()
        table.name = 't'
        table.meta.client = client
        return table, client

    def test_unprocessed_keys_are_retried(self):
        import projects_handler

        table, client = self._stub_table(
            {'Responses': {'t': [{'pk': 'PROJECT#a'}]},
             'UnprocessedKeys': {'t': {'Keys': [{'pk': 'PROJECT#b', 'sk': 'META'}]}}},
            {'Responses': {'t': [{'pk': 'PROJECT#b'}]}, 'UnprocessedKeys': {}},
        )
        with patch.object(projects_handler.time, 'sleep'):
            metas = projects_handler._gate_meta_batch_chunk(table, ['a', 'b'])
        assert set(metas) == {'a', 'b'}
        assert client.batch_get_item.call_count == 2

    def test_keys_still_unprocessed_fail_closed(self):
        import projects_handler
        from shared.exceptions import ServiceError

        stuck = {'Responses': {},
                 'UnprocessedKeys': {'t': {'Keys': [{'pk': 'PROJECT#a', 'sk': 'META'}]}}}
        table, _ = self._stub_table(*[stuck] * projects_handler._GATE_BATCH_ATTEMPTS)
        with patch.object(projects_handler.time, 'sleep'), pytest.raises(ServiceError):
            projects_handler._gate_meta_batch_chunk(table, ['a'])
