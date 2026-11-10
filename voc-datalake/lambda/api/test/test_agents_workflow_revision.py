"""GET /workflows/{workflow_id}/revisions/{revision} (api/agents_handler.py): one saved revision, read-only."""
from __future__ import annotations

import pytest
from agents_handler_fixtures import USER, api, call, create_workflow

from shared import agents_store as store
from shared import workflow_schema

SERVED_FIELDS = {'workflow_id', 'revision', 'name', 'definition', 'saved_at', 'saved_by_username'}


def _created(lambda_context, name: str = 'Research flow') -> tuple[str, dict]:
    created = create_workflow(lambda_context, name)
    return created['workflow_id'], created['definition']


def _revision(lambda_context, workflow_id: str, revision: object, **kwargs) -> tuple[int, dict]:
    return call(lambda_context, 'GET', f'/workflows/{workflow_id}/revisions/{revision}', **kwargs)


def _save(lambda_context, workflow_id: str, definition: dict, expected: int) -> None:
    status, body = call(lambda_context, 'PUT', f'/workflows/{workflow_id}',
                        body={'definition': definition, 'expected_revision': expected})
    if status != 200:
        raise AssertionError(f'PUT /workflows answered {status}: {body}')


def test_an_older_revision_is_served_with_its_own_definition_after_a_newer_save(lambda_context):
    with api():
        workflow_id, first = _created(lambda_context)
        _save(lambda_context, workflow_id, {**first, 'name': 'Weekly research'}, expected=1)
        status, body = _revision(lambda_context, workflow_id, 1)
        assert status == 200
        assert set(body) == SERVED_FIELDS
        assert (body['workflow_id'], body['revision'], body['name']) == (workflow_id, 1, 'Research flow')
        assert body['definition'] == first
        assert body['saved_by_username'] == 'alice'
        assert isinstance(body['saved_at'], str)
        newer = _revision(lambda_context, workflow_id, 2)[1]
        assert (newer['revision'], newer['name']) == (2, 'Weekly research')


def test_the_savers_sub_is_stored_but_never_served(lambda_context):
    with api() as env:
        workflow_id, _ = _created(lambda_context)
        stored = env.agents.get_item(Key=store.workflow_revision_key(workflow_id, 1))['Item']
        assert stored['saved_by'] == 'admin-sub'
        body = _revision(lambda_context, workflow_id, 1)[1]
        assert 'saved_by' not in body
        assert 'admin-sub' not in str(body)


def test_a_signed_in_user_who_is_not_an_admin_reads_history(lambda_context):
    with api():
        workflow_id, _ = _created(lambda_context)
        assert _revision(lambda_context, workflow_id, 1, claims=USER)[0] == 200


def test_the_builtin_has_one_revision_the_builtin_template(lambda_context):
    with api():
        status, body = _revision(lambda_context, workflow_schema.DEFAULT_WORKFLOW_ID, 1, claims=USER)
        assert status == 200
        assert body['definition'] == workflow_schema.default_template()
        assert (body['revision'], body['saved_at'], body['saved_by_username']) == (1, None, None)
        assert _revision(lambda_context, workflow_schema.DEFAULT_WORKFLOW_ID, 2)[0] == 404


def test_an_unsaved_revision_an_unknown_and_another_workflows_revision_are_404(lambda_context):
    with api():
        workflow_id, _ = _created(lambda_context)
        other_id, first = _created(lambda_context, 'Other flow')
        _save(lambda_context, other_id, {**first, 'name': 'Other flow two'}, expected=1)
        assert _revision(lambda_context, workflow_id, 2)[0] == 404
        assert _revision(lambda_context, 'wf_000000000000', 1)[0] == 404
        assert _revision(lambda_context, 'not-a-workflow', 1)[0] == 404


@pytest.mark.parametrize('revision', ['0', '-1', 'abc', '1.5', '01x', '1000000', '9' * 5000])
def test_a_revision_that_is_not_a_whole_number_in_range_is_400(lambda_context, revision):
    with api():
        workflow_id, _ = _created(lambda_context)
        assert _revision(lambda_context, workflow_id, revision)[0] == 400


def test_an_archived_workflows_history_is_404_for_a_user_and_readable_by_an_admin(lambda_context):
    with api():
        workflow_id, _ = _created(lambda_context)
        assert call(lambda_context, 'DELETE', f'/workflows/{workflow_id}')[0] == 200
        assert _revision(lambda_context, workflow_id, 1, claims=USER)[0] == 404
        assert _revision(lambda_context, workflow_id, 1)[0] == 200
