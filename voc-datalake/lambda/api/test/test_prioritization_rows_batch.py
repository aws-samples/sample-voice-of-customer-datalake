"""`POST /projects/prioritization/rows` with `{project_ids: [...]}`: one request, many rows.

Pins the batch shape against real (moto) tables: every item goes through the
single-row access check (no view = the same 404 as a missing project, view-only =
403), failures are per item, the batch is capped, and the single-row shape answers
exactly as before.
"""
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

from shared.prioritization_row_batch import MAX_ROW_ENSURE_BATCH

OWNER, VIEWER, STRANGER, ADMIN = 'owner-1', 'viewer-1', 'stranger-1', 'admin-1'
PATH = '/projects/prioritization/rows'


def _seed_project(projects, project_id, *, scorable=True, **meta):
    projects.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': 'META',
                            'project_id': project_id, 'name': project_id, **meta})
    if scorable:
        projects.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': 'PRD#d1',
                                'document_id': f'{project_id}-prd', 'created_at': '2026-01-01'})


def _seed(projects):
    _seed_project(projects, 'priv', visibility='private', owner_sub=OWNER,
                  members={VIEWER: {'role': 'viewer', 'username': 'vic'}})
    _seed_project(projects, 'pub', visibility='public', owner_sub=OWNER)
    _seed_project(projects, 'empty', visibility='public', owner_sub=OWNER, scorable=False)
    return projects


def _call(tables, body, subject=STRANGER):
    import projects_handler

    aggregates, projects = tables
    groups = 'admins' if subject == ADMIN else ''
    event = rest_event('POST', PATH, claims={'sub': subject, 'cognito:groups': groups}, body=body)
    return invoke(projects_handler, event, MagicMock(), aggregates=aggregates, projects=projects)


def _row_project_ids(tables):
    aggregates, _ = tables
    return sorted(i['project_id'] for i in aggregates.scan()['Items'] if i['sk'].startswith('ROW#'))


@pytest.fixture
def tables():
    with mock_aws():
        yield pk_sk_table('aggr'), _seed(pk_sk_table('projects'))


class TestBatch:

    def test_one_request_ensures_every_project_and_answers_each_row(self, tables):
        status, body = _call(tables, {'project_ids': ['pub', 'priv']}, subject=OWNER)
        assert status == 200
        assert [(r['project_id'], r['created']) for r in body['rows']] == [('pub', True), ('priv', True)]
        assert body['errors'] == []
        assert _row_project_ids(tables) == ['priv', 'pub']

    def test_asking_again_creates_nothing_and_answers_the_stored_rows(self, tables):
        first = _call(tables, {'project_ids': ['pub']}, subject=OWNER)[1]['rows']
        again = _call(tables, {'project_ids': ['pub', 'pub']}, subject=OWNER)[1]['rows']
        assert [r['created'] for r in again] == [False]
        assert again[0]['row'] == first[0]['row']

    def test_failures_are_per_item_and_the_rest_still_succeeds(self, tables):
        status, body = _call(tables, {'project_ids': ['empty', 'pub', 'gone']})
        assert status == 200
        assert [r['project_id'] for r in body['rows']] == ['pub']
        assert [(e['project_id'], e['status']) for e in body['errors']] == [('empty', 400), ('gone', 404)]

    def test_an_unexpected_failure_is_a_generic_500_for_that_item_only(self, tables):
        import projects_handler

        real = projects_handler._project_documents

        def flaky(project_id):
            if project_id == 'pub':
                raise RuntimeError('table arn:aws:dynamodb:secret')
            return real(project_id)

        with patch.object(projects_handler, '_project_documents', side_effect=flaky):
            body = _call(tables, {'project_ids': ['pub', 'priv']}, subject=OWNER)[1]
        assert [r['project_id'] for r in body['rows']] == ['priv']
        assert body['errors'] == [{'project_id': 'pub', 'status': 500,
                                   'error': 'Failed to create the prioritization row'}]


class TestMixedAccess:

    def test_a_project_the_caller_cannot_view_reads_exactly_like_a_missing_one(self, tables):
        body = _call(tables, {'project_ids': ['priv', 'missing', 'pub']}, subject=STRANGER)[1]
        assert [r['project_id'] for r in body['rows']] == ['pub']
        hidden, missing = body['errors']
        assert {k: v for k, v in hidden.items() if k != 'project_id'} == \
            {k: v for k, v in missing.items() if k != 'project_id'}
        assert hidden['status'] == 404
        assert _row_project_ids(tables) == ['pub']

    def test_a_viewer_gets_403_for_that_item_and_nothing_is_written(self, tables):
        body = _call(tables, {'project_ids': ['priv']}, subject=VIEWER)[1]
        assert body['rows'] == []
        assert [(e['project_id'], e['status']) for e in body['errors']] == [('priv', 403)]
        assert _row_project_ids(tables) == []


class TestBounds:

    def test_the_cap_is_inclusive(self, tables):
        ids = ['pub'] + [f'p{n}' for n in range(MAX_ROW_ENSURE_BATCH - 1)]
        status, body = _call(tables, {'project_ids': ids})
        assert status == 200
        assert len(body['rows']) + len(body['errors']) == MAX_ROW_ENSURE_BATCH

    def test_past_the_cap_is_refused_before_anything_is_written(self, tables):
        ids = ['pub'] + [f'p{n}' for n in range(MAX_ROW_ENSURE_BATCH)]
        status, body = _call(tables, {'project_ids': ids})
        assert status == 400
        assert str(MAX_ROW_ENSURE_BATCH) in body['error']
        assert _row_project_ids(tables) == []

    @pytest.mark.parametrize('project_ids', [[], 'pub', [''], ['a#b'], [3]])
    def test_a_malformed_list_is_refused(self, tables, project_ids):
        assert _call(tables, {'project_ids': project_ids})[0] == 400

    def test_naming_both_shapes_is_refused(self, tables):
        assert _call(tables, {'project_id': 'pub', 'project_ids': ['pub']})[0] == 400
        assert _row_project_ids(tables) == []


class TestSingleShapeIsUnchanged:

    def test_the_single_shape_answers_created_and_row(self, tables):
        status, body = _call(tables, {'project_id': 'pub'})
        assert status == 200
        assert set(body) == {'success', 'created', 'row'}
        assert body['row']['project_id'] == 'pub'

    def test_the_single_shape_still_fails_with_the_items_status(self, tables):
        assert _call(tables, {'project_id': 'priv'}, subject=STRANGER)[0] == 404
        assert _call(tables, {'project_id': 'empty'})[0] == 400
