"""Agent-facing project features, through the real projects handler and moto.

* the project ``purpose`` field (create / update / list),
* project creation by an ``agent:`` principal (owner from ``voc:agent_owner_sub``,
  editors from ``voc:agent_editor_subs``, ``created_by_agent`` provenance, and the
  agent keeping edit on what it created),
* ``POST /projects/{id}/documents/{doc_id}/duplicate`` (edit on both projects,
  copies, idempotent, never moves).
"""
import json
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

from shared import project_access
from shared.indexes import PROJECTS_BY_TYPE_INDEX
from shared.prototypes import prototype_s3_key

OWNER = {'sub': 'owner-sub', 'cognito:username': 'olivia', 'email': 'olivia@example.com'}
STRANGER = {'sub': 'stranger-sub', 'cognito:username': 'sam', 'email': 'sam@example.com'}
BUCKET = 'test-raw-data-bucket'
NOT_FOUND = {'success': False, 'error': 'Project not found'}


def _agent(owner_sub='owner-sub', **extra):
    return {
        'sub': 'agent:ag_1', 'cognito:groups': '', 'email': 'agent:ag_1',
        project_access.ACTING_SUBJECT_CLAIM: owner_sub, **extra,
    }


def _user(sub, username, enabled=True):
    return {
        'Username': username, 'Enabled': enabled,
        'Attributes': [{'Name': 'sub', 'Value': sub}, {'Name': 'email', 'Value': f'{username}@example.com'}],
    }


class FakeCognito:
    def __init__(self, users):
        self.users = users

    def list_users(self, **kwargs):
        wanted = kwargs['Filter'].split('"')[1]
        found = [u for u in self.users if any(
            a['Name'] == 'sub' and a['Value'] == wanted for a in u['Attributes'])]
        return {'Users': found[: kwargs['Limit']]}


DIRECTORY = [
    _user('owner-sub', 'olivia'), _user('po-sub', 'paula'), _user('ed-sub', 'eddie'),
    _user('gone-sub', 'gone', enabled=False),
]


@pytest.fixture
def aws():
    with mock_aws():
        table = pk_sk_table('test-projects', gsi1_index=PROJECTS_BY_TYPE_INDEX)
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        yield table, s3


@pytest.fixture
def call(aws, api_gateway_event, lambda_context):
    import projects
    import projects_handler

    table, s3 = aws

    def _call(claims, method, path, body=None):
        event = api_gateway_event(method=method, path=path, body=body, claims=claims)
        with (
            patch.object(projects_handler, 'get_projects_table', return_value=table),
            patch.object(projects, 'projects_table', table),
            patch.object(projects, '_get_cognito_client', return_value=FakeCognito(DIRECTORY)),
            patch.object(projects, 'get_s3_client', return_value=s3),
        ):
            response = projects_handler.lambda_handler(event, lambda_context)
        return response['statusCode'], json.loads(response['body'])

    return _call


def _seed(table, project_id, owner_sub='owner-sub', visibility='private', **extra):
    table.put_item(Item={
        'pk': f'PROJECT#{project_id}', 'sk': 'META', 'project_id': project_id,
        'gsi1pk': 'TYPE#PROJECT', 'gsi1sk': f'2026-01-01#{project_id}', 'name': project_id,
        'status': 'active', 'owner_sub': owner_sub, 'visibility': visibility, 'members': {},
        'document_count': 0, **extra,
    })


def _meta(table, project_id):
    return table.get_item(Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'})['Item']


# ---------------------------------------------------------------------------
# purpose
# ---------------------------------------------------------------------------

class TestPurpose:
    def test_create_update_and_list_carry_purpose(self, call, aws):
        table, _ = aws
        status, body = call(OWNER, 'POST', '/projects', {'name': 'P', 'purpose': '  Checkout issues '})
        assert status == 200
        project_id = body['project']['project_id']
        assert _meta(table, project_id)['purpose'] == 'Checkout issues'

        assert call(OWNER, 'PUT', f'/projects/{project_id}', {'purpose': 'Delivery'})[0] == 200
        assert _meta(table, project_id)['purpose'] == 'Delivery'

        listed = call(OWNER, 'GET', '/projects')[1]['projects']
        assert [p['purpose'] for p in listed] == ['Delivery']

    @pytest.mark.parametrize('purpose', [7, 'x' * 2001])
    def test_purpose_is_validated(self, call, aws, purpose):
        table, _ = aws
        _seed(table, 'p1')
        assert call(OWNER, 'POST', '/projects', {'purpose': purpose})[0] == 400
        assert call(OWNER, 'PUT', '/projects/p1', {'purpose': purpose})[0] == 400


# ---------------------------------------------------------------------------
# agent-created projects
# ---------------------------------------------------------------------------

class TestAgentCreate:
    def test_agent_creates_for_the_handoff_owner_with_editors(self, call, aws):
        table, _ = aws
        claims = _agent(**{
            project_access.AGENT_OWNER_CLAIM: 'po-sub',
            project_access.AGENT_EDITORS_CLAIM: 'ed-sub,po-sub,gone-sub,unknown-sub',
        })

        status, body = call(claims, 'POST', '/projects', {'name': 'Auto', 'visibility': 'private'})

        assert status == 200
        meta = _meta(table, body['project']['project_id'])
        assert (meta['owner_sub'], meta['owner_username']) == ('po-sub', 'paula')
        assert meta[project_access.CREATED_BY_AGENT_ATTRIBUTE] == 'ag_1'
        assert set(meta['members']) == {'ed-sub'}
        assert meta['members']['ed-sub']['role'] == 'editor'
        assert meta['members']['ed-sub']['added_by'] == 'agent:ag_1'
        # The agent reads back the project it created, as an editor, never manager.
        assert body['project']['access']['role'] == 'editor'

    def test_without_a_handoff_target_the_agent_owner_owns_it(self, call, aws):
        table, _ = aws
        status, body = call(_agent(), 'POST', '/projects', {'name': 'Auto'})
        assert status == 200
        assert _meta(table, body['project']['project_id'])['owner_sub'] == 'owner-sub'

    def test_an_inactive_handoff_owner_refuses_the_create(self, call):
        claims = _agent(**{project_access.AGENT_OWNER_CLAIM: 'gone-sub'})
        assert call(claims, 'POST', '/projects', {'name': 'Auto'})[0] == 400

    def test_an_ownerless_agent_cannot_create(self, call):
        assert call(_agent(owner_sub=''), 'POST', '/projects', {'name': 'Auto'})[0] == 403

    def test_mcp_tokens_still_cannot_name_an_owner(self, call):
        claims = {'sub': 'mcp:tok', project_access.ACTING_SUBJECT_CLAIM: 'owner-sub',
                  project_access.AGENT_OWNER_CLAIM: 'po-sub'}
        assert call(claims, 'POST', '/projects', {'name': 'x'})[0] == 403

    def test_the_agent_keeps_edit_but_not_manage_on_its_project(self, call, aws):
        table, _ = aws
        claims = _agent(**{project_access.AGENT_OWNER_CLAIM: 'po-sub'})
        project_id = call(claims, 'POST', '/projects', {'name': 'Auto'})[1]['project']['project_id']

        assert call(claims, 'PUT', f'/projects/{project_id}', {'purpose': 'p'})[0] == 200
        assert call(claims, 'PUT', f'/projects/{project_id}/visibility', {'visibility': 'public'})[0] == 403
        assert call(claims, 'DELETE', f'/projects/{project_id}')[0] == 403
        assert _meta(table, project_id)['visibility'] == 'private'

    def test_update_cannot_forge_created_by_agent(self, call, aws):
        table, _ = aws
        _seed(table, 'p1')
        call(OWNER, 'PUT', '/projects/p1', {project_access.CREATED_BY_AGENT_ATTRIBUTE: 'ag_1'})
        assert project_access.CREATED_BY_AGENT_ATTRIBUTE not in _meta(table, 'p1')


# ---------------------------------------------------------------------------
# duplicate
# ---------------------------------------------------------------------------

def _doc(table, project_id, sk, **fields):
    table.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': sk, **fields})


class TestDuplicate:
    def test_custom_document_is_copied_idempotently(self, call, aws):
        table, _ = aws
        _seed(table, 'src')
        _seed(table, 'dst')
        _doc(table, 'src', 'DOC#d1', document_id='d1', document_type='custom', title='Notes',
             content='hello', created_at='2026-01-01T00:00:00+00:00')

        first = call(OWNER, 'POST', '/projects/src/documents/d1/duplicate', {'target_project_id': 'dst'})
        second = call(OWNER, 'POST', '/projects/src/documents/d1/duplicate', {'target_project_id': 'dst'})

        assert first[0] == 200
        assert first == second
        copy = first[1]['document']
        item = table.get_item(Key={'pk': 'PROJECT#dst', 'sk': f"DOC#{copy['document_id']}"})['Item']
        assert item['content'] == 'hello'
        assert item['duplicated_from'] == {'project_id': 'src', 'document_id': 'd1'}
        assert _meta(table, 'dst')['document_count'] == 1
        # Never moved: the source is untouched.
        assert table.get_item(Key={'pk': 'PROJECT#src', 'sk': 'DOC#d1'})['Item']['content'] == 'hello'

    def test_managed_prfaq_joins_the_target_version_series(self, call, aws):
        table, _ = aws
        _seed(table, 'src')
        _seed(table, 'dst')
        _doc(table, 'src', 'PRFAQ#prfaq_a', document_id='prfaq_a', document_type='prfaq',
             title='Checkout (v3)', base_title='Checkout', version=3, content='# PR/FAQ',
             version_allocation_id='job1', created_at='2026-01-01T00:00:00+00:00')

        status, body = call(OWNER, 'POST', '/projects/src/documents/prfaq_a/duplicate',
                            {'target_project_id': 'dst'})

        assert status == 200
        assert body['document']['title'] == 'Checkout (v1)'
        item = table.get_item(Key={'pk': 'PROJECT#dst', 'sk': f"PRFAQ#{body['document']['document_id']}"})['Item']
        assert item['content'] == '# PR/FAQ'
        assert item['version'] == 1

    def test_prototype_html_is_copied_to_the_target_key(self, call, aws):
        table, s3 = aws
        _seed(table, 'src')
        _seed(table, 'dst')
        _doc(table, 'src', 'PROTOTYPE#prototype_a', document_id='prototype_a',
             document_type='prototype', title='Proto (v1)', base_title='Proto', version=1,
             version_allocation_id='job2', created_at='2026-01-01T00:00:00+00:00')
        s3.put_object(Bucket=BUCKET, Key=prototype_s3_key('src', 'prototype_a'), Body=b'<html>x</html>')

        status, body = call(OWNER, 'POST', '/projects/src/documents/prototype_a/duplicate',
                            {'target_project_id': 'dst'})

        assert status == 200
        new_id = body['document']['document_id']
        copied = s3.get_object(Bucket=BUCKET, Key=prototype_s3_key('dst', new_id))['Body'].read()
        assert copied == b'<html>x</html>'
        assert s3.get_object(Bucket=BUCKET, Key=prototype_s3_key('src', 'prototype_a'))

    def test_target_requires_edit_and_hides_its_existence(self, call, aws):
        table, _ = aws
        _seed(table, 'src', visibility='public')
        _seed(table, 'dst')  # private, STRANGER has no access
        _doc(table, 'src', 'DOC#d1', document_id='d1', document_type='custom', title='N', content='c')

        result = call(STRANGER, 'POST', '/projects/src/documents/d1/duplicate', {'target_project_id': 'dst'})

        assert result == (404, NOT_FOUND)

    @pytest.mark.parametrize('body', [{}, {'target_project_id': ''}, {'target_project_id': 5},
                                      {'target_project_id': 'src'}])
    def test_bad_targets_are_refused(self, call, aws, body):
        table, _ = aws
        _seed(table, 'src')
        _doc(table, 'src', 'DOC#d1', document_id='d1', document_type='custom', title='N', content='c')

        assert call(OWNER, 'POST', '/projects/src/documents/d1/duplicate', body)[0] == 400

    def test_a_missing_document_is_404(self, call, aws):
        table, _ = aws
        _seed(table, 'src')
        _seed(table, 'dst')
        assert call(OWNER, 'POST', '/projects/src/documents/nope/duplicate',
                    {'target_project_id': 'dst'})[0] == 404
