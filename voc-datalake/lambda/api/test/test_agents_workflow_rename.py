"""POST /workflows/{workflow_id}/rename (api/agents_handler.py): a new revision with only the name changed."""
from __future__ import annotations

import pytest
from agents_handler_fixtures import USER, api, call, create_workflow

from shared import agents_store as store
from shared import workflow_schema


def _created(lambda_context, name: str = 'Research flow') -> str:
    return create_workflow(lambda_context, name)['workflow_id']


def _rename(lambda_context, workflow_id: str, name: object, **kwargs) -> tuple[int, dict]:
    return call(lambda_context, 'POST', f'/workflows/{workflow_id}/rename', body={'name': name}, **kwargs)


def _stored(env, workflow_id: str) -> dict:
    return store.get_workflow(env.agents, workflow_id) or {}


def test_rename_saves_a_revision_with_only_the_name_changed(lambda_context):
    with api() as env:
        workflow_id = _created(lambda_context)
        before = workflow_schema.decode_definition(_stored(env, workflow_id).get('definition')) or {}
        status, body = _rename(lambda_context, workflow_id, '  Weekly research  ')
        assert (status, body['workflow']['name'], body['workflow']['revision']) == (200, 'Weekly research', 2)
        after = workflow_schema.decode_definition(_stored(env, workflow_id).get('definition')) or {}
        assert after == {**before, 'name': 'Weekly research'}
        listed = call(lambda_context, 'GET', '/workflows')[1]['items']
        assert 'Weekly research' in [w['name'] for w in listed]


def test_renaming_to_the_same_name_saves_nothing(lambda_context):
    with api() as env:
        workflow_id = _created(lambda_context)
        status, body = _rename(lambda_context, workflow_id, 'Research flow')
        assert (status, body['workflow']['revision']) == (200, 1)
        assert store.plain(_stored(env, workflow_id).get('revision')) == 1


def test_a_workflow_saved_before_a_newer_rule_can_still_be_renamed(lambda_context):
    """Rename does not re-validate the graph: a stored loop the new rules refuse keeps its name change."""
    with api() as env:
        workflow_id = _created(lambda_context)
        row = _stored(env, workflow_id)
        definition = workflow_schema.decode_definition(row.get('definition')) or {}
        # An unlabelled arrow out of a loop's review: refused on save since 3.22.00, stored before it.
        for edge in definition['edges']:
            edge.pop('label', None)
        assert not workflow_schema.validate_definition(definition).valid
        env.agents.update_item(Key=store.workflow_current_key(workflow_id), UpdateExpression='SET #d = :d', ExpressionAttributeNames={'#d': 'definition'},
                               ExpressionAttributeValues={':d': workflow_schema.encode_definition(definition)})
        status, body = _rename(lambda_context, workflow_id, 'Old flow')
        assert (status, body['workflow']['name']) == (200, 'Old flow')


@pytest.mark.parametrize('name', ['', '   ', 'x' * (workflow_schema.MAX_NAME_CHARS + 1), 7, None])
def test_a_missing_or_overlong_name_is_400(lambda_context, name):
    with api():
        workflow_id = _created(lambda_context)
        assert _rename(lambda_context, workflow_id, name)[0] == 400


def test_the_builtin_is_409_an_unknown_workflow_404_and_a_user_403(lambda_context):
    with api():
        workflow_id = _created(lambda_context)
        assert _rename(lambda_context, workflow_schema.DEFAULT_WORKFLOW_ID, 'Mine')[0] == 409
        assert _rename(lambda_context, 'wf_000000000000', 'Mine')[0] == 404
        assert _rename(lambda_context, workflow_id, 'Mine', claims=USER)[0] == 403


def test_an_archived_workflow_cannot_be_renamed(lambda_context):
    with api():
        workflow_id = _created(lambda_context)
        assert call(lambda_context, 'DELETE', f'/workflows/{workflow_id}')[0] == 200
        assert _rename(lambda_context, workflow_id, 'Back again')[0] == 404
