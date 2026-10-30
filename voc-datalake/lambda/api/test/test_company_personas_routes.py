"""The company persona library and project persona copying, end to end through projects_handler.

``shared/company_personas_routes.py`` and ``shared/persona_copy_routes.py`` are included by the
handler, so these drive the real handler (its project-access middleware included) against moto
DynamoDB + S3. docs/project-workspace.md → Company personas is the contract.
"""
import os
from collections.abc import Iterator
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

import boto3
import pytest
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import pk_sk_table

from shared.avatar import AVATAR_OWNER_METADATA_KEY
from shared.indexes import PROJECTS_BY_TYPE_INDEX

BUCKET = os.environ['RAW_DATA_BUCKET']
CONTAINER = 'company_personas'
ADMIN = {'sub': 'admin-sub', 'cognito:username': 'ada', 'cognito:groups': 'admins'}
OWNER = {'sub': 'owner-sub', 'cognito:username': 'olivia'}
MEMBER = {'sub': 'member-sub', 'cognito:username': 'mel'}
STRANGER = {'sub': 'stranger-sub', 'cognito:username': 'sam'}
NOT_FOUND = {'success': False, 'error': 'Project not found'}
ADMIN_REQUIRED = {'success': False, 'error': 'Admin access required'}
AVATAR_KEY = 'avatars/persona_a/abc.png'


def _meta(project_id, *, name, owner='owner-sub', members=None, visibility='private', **extra):
    return {'pk': f'PROJECT#{project_id}', 'sk': 'META', 'project_id': project_id, 'name': name,
            'gsi1pk': 'TYPE#PROJECT', 'gsi1sk': f'2026-01-01#{project_id}', 'status': 'active',
            'owner_sub': owner, 'visibility': visibility, 'members': members or {}, 'persona_count': 1, **extra}


def _persona(container, persona_id, *, name, created_at='2026-10-01T00:00:00+00:00', **extra):
    return {'pk': f'PROJECT#{container}', 'sk': f'PERSONA#{persona_id}', 'persona_id': persona_id,
            'name': name, 'tagline': f'{name} tagline', 'research_notes': [{'note_id': 'n1', 'text': 'secret'}],
            'created_at': created_at, 'updated_at': created_at, **extra}


@pytest.fixture
def world(monkeypatch) -> Iterator[dict]:
    monkeypatch.setenv('ASSIST_WORKER_FUNCTION', 'projects-assist')
    with mock_aws():
        table = pk_sk_table('projects', gsi1_index=PROJECTS_BY_TYPE_INDEX)
        jobs = pk_sk_table('jobs')
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        s3.put_object(Bucket=BUCKET, Key=AVATAR_KEY, Body=b'png', ContentType='image/png',
                      Metadata={AVATAR_OWNER_METADATA_KEY: 'p1'})
        table.put_item(Item=_meta('p1', name='Alpha', members={'member-sub': {'role': 'viewer'}}))
        table.put_item(Item=_meta('p2', name='Beta', members={'member-sub': {'role': 'editor'}}))
        table.put_item(Item=_meta('p3', name='Public stranger project', owner='someone', visibility='public'))
        table.put_item(Item=_persona('p1', 'persona_a', name='Ana', avatar_url=f's3://{BUCKET}/{AVATAR_KEY}'))
        table.put_item(Item=_persona('p3', 'persona_c', name='Cy'))
        invoke = MagicMock()
        with ExitStack() as stack:
            for target in ('projects_handler.get_projects_table', 'shared.company_personas_routes.get_projects_table'):
                stack.enter_context(patch(target, return_value=table))
            stack.enter_context(patch('projects.projects_table', table))
            for target in ('projects_handler.get_jobs_table', 'shared.jobs.get_jobs_table',
                           'shared.assist_jobs.get_jobs_table'):
                stack.enter_context(patch(target, return_value=jobs))
            stack.enter_context(patch('projects_handler.invoke_lambda_async', invoke))
            stack.enter_context(patch('shared.assist_jobs.invoke_lambda_async', invoke))
            stack.enter_context(patch('projects_handler.ensure_persona_feedback'))
            stack.enter_context(patch('projects.get_avatar_cdn_url', side_effect=lambda uri: f'signed:{uri}'))
            yield {'table': table, 'jobs': jobs, 's3': s3, 'invoke': invoke}


@pytest.fixture
def call(request, api_gateway_event, lambda_context):
    request.getfixturevalue('world')
    from projects_handler import lambda_handler

    def _call(method, path, claims, body=None, query=None):
        response, payload = call_route(lambda_handler, api_gateway_event, lambda_context, method=method,
                                       path=path, body=body, claims=claims, query_params=query)
        return response['statusCode'], payload
    return _call


def _library(table):
    return [item for item in table.scan()['Items']
            if item['pk'] == f'PROJECT#{CONTAINER}' and item['sk'].startswith('PERSONA#')]


def _promote(call, persona_id='persona_a'):
    status, body = call('POST', f'/projects/p1/personas/{persona_id}/promote', ADMIN)
    assert status == 201, body
    return body['persona']


class TestTheContainerIsNotAProject:
    @pytest.mark.parametrize('claims', [ADMIN, STRANGER])
    @pytest.mark.parametrize(('method', 'path'), [
        ('GET', f'/projects/{CONTAINER}'), ('GET', f'/projects/{CONTAINER}/documents'),
        ('DELETE', f'/projects/{CONTAINER}'), ('PUT', f'/projects/{CONTAINER}/personas/x'),
        ('DELETE', f'/projects/{CONTAINER}/personas/x'), ('GET', f'/projects/{CONTAINER}/jobs'),
        ('POST', f'/projects/{CONTAINER}/personas/copy'),
    ])
    def test_every_project_route_answers_404(self, call, world, claims, method, path):
        world['table'].put_item(Item={'pk': f'PROJECT#{CONTAINER}', 'sk': 'META', 'owner_sub': 'system:company'})

        assert call(method, path, claims, body={'name': 'x'}) == (404, NOT_FOUND)

    def test_the_batch_read_drops_it(self, call):
        _promote(call)

        status, body = call('GET', '/projects', ADMIN, query={'ids': f'{CONTAINER},p1'})

        assert status == 200
        assert [detail['project']['project_id'] for detail in body['details']] == ['p1']

    def test_the_project_list_never_shows_it(self, call):
        _promote(call)

        status, body = call('GET', '/projects', ADMIN)

        assert status == 200
        assert CONTAINER not in {project['project_id'] for project in body['projects']}


class TestLibraryReads:
    def test_any_signed_in_user_reads_the_library_newest_first(self, call, world):
        world['table'].put_item(Item=_persona(CONTAINER, 'old', name='Old', created_at='2026-01-01'))
        world['table'].put_item(Item=_persona(CONTAINER, 'new', name='New', created_at='2026-02-01',
                                              avatar_url=f's3://{BUCKET}/avatars/new/x.png'))

        status, body = call('GET', '/company-personas', STRANGER)

        assert status == 200
        assert [p['persona_id'] for p in body['personas']] == ['new', 'old']
        assert body['personas'][0]['avatar_url'] == f'signed:s3://{BUCKET}/avatars/new/x.png'
        assert body['can_edit'] is False

    def test_can_edit_is_true_for_an_admin_only(self, call):
        assert call('GET', '/company-personas', ADMIN)[1]['can_edit'] is True
        delegated = {'sub': 'mcp:tok', 'voc:acting_subject': 'admin-sub', 'cognito:groups': 'admins'}
        assert call('GET', '/company-personas', delegated)[1]['can_edit'] is False

    def test_an_empty_library_reads_as_empty(self, call):
        assert call('GET', '/company-personas', STRANGER) == (200, {'personas': [], 'can_edit': False})


class TestLibraryWritesAreAdminOnly:
    @pytest.mark.parametrize(('method', 'path'), [
        ('POST', '/company-personas/generate'), ('POST', '/company-personas/import'),
        ('GET', '/company-personas/jobs/job_1'), ('PUT', '/company-personas/p'),
        ('DELETE', '/company-personas/p'), ('POST', '/company-personas/p/notes'),
        ('POST', '/company-personas/p/regenerate-avatar'),
    ])
    def test_a_non_admin_is_refused(self, call, world, method, path):
        assert call(method, path, OWNER, body={'text': 'x'}) == (403, ADMIN_REQUIRED)
        assert _library(world['table']) == []

    def test_generate_is_always_additive_and_runs_on_the_container(self, call, world):
        status, body = call('POST', '/company-personas/generate', ADMIN,
                            body={'persona_count': 2, 'keep_existing_personas': False})

        assert status == 200
        assert body['success'] is True
        assert body['status'] == 'running'
        payload = world['invoke'].call_args.args[1]
        assert payload['project_id'] == CONTAINER
        assert payload['filters']['keep_existing_personas'] is True
        assert payload['filters']['persona_count'] == 2
        job = world['jobs'].get_item(Key={'pk': f'PROJECT#{CONTAINER}', 'sk': f"JOB#{body['job_id']}"})['Item']
        assert job['initiated_by'] == 'admin-sub'
        assert world['table'].get_item(Key={'pk': f'PROJECT#{CONTAINER}', 'sk': 'META'})['Item']['kind'] == CONTAINER

    def test_import_validates_then_starts_a_job(self, call, world):
        assert call('POST', '/company-personas/import', ADMIN, body={'input_type': 'pdf'})[0] == 400

        status, _ = call('POST', '/company-personas/import', ADMIN,
                         body={'input_type': 'text', 'content': 'A frequent flyer on Example Air'})

        assert status == 200
        assert world['invoke'].call_args.args[1]['project_id'] == CONTAINER

    def test_jobs_are_listed_for_everyone_and_polled_by_admins(self, call):
        job_id = call('POST', '/company-personas/generate', ADMIN, body={})[1]['job_id']

        status, body = call('GET', '/company-personas/jobs', STRANGER)
        assert status == 200
        assert [job['job_id'] for job in body['jobs']] == [job_id]
        assert not {'error', 'result', 'initiated_by'} & set(body['jobs'][0])

        status, body = call('GET', '/company-personas/jobs', ADMIN)
        assert status == 200
        assert body['jobs'][0]['initiated_by']

        status, body = call('GET', f'/company-personas/jobs/{job_id}', ADMIN)
        assert status == 200
        assert body['job_type'] == 'generate_personas'
        assert call('GET', '/company-personas/jobs/job_missing', ADMIN)[0] == 404

    def test_update_notes_and_delete(self, call, world):
        persona = _promote(call)
        path = f"/company-personas/{persona['persona_id']}"

        assert call('PUT', path, ADMIN, body={'name': 'Ana Library'}) == (200, {'success': True})
        status, body = call('POST', f'{path}/notes', ADMIN, body={'text': 'Library note'})
        assert status == 200
        assert body['note']['text'] == 'Library note'
        [stored] = _library(world['table'])
        assert stored['name'] == 'Ana Library'
        assert [note['text'] for note in stored['research_notes']] == ['Library note']

        assert call('DELETE', path, ADMIN) == (200, {'success': True})
        assert _library(world['table']) == []
        keys = [obj['Key'] for obj in world['s3'].list_objects_v2(Bucket=BUCKET).get('Contents', [])]
        assert keys == [AVATAR_KEY]

    @pytest.mark.parametrize(('method', 'suffix'), [('PUT', ''), ('DELETE', ''), ('POST', '/notes'),
                                                    ('POST', '/regenerate-avatar')])
    def test_a_missing_persona_is_a_404(self, call, method, suffix):
        answer = call(method, f'/company-personas/persona_nope{suffix}', ADMIN, body={'text': 'x'})

        assert answer == (404, {'success': False, 'error': 'Persona not found'})

    def test_regenerate_avatar_starts_an_assist_job_on_the_container(self, call, world):
        persona = _promote(call)

        status, body = call('POST', f"/company-personas/{persona['persona_id']}/regenerate-avatar", ADMIN)

        assert status == 202
        assert world['invoke'].call_args.args[1]['pk'] == f'PROJECT#{CONTAINER}'
        row = world['jobs'].get_item(Key={'pk': f'PROJECT#{CONTAINER}', 'sk': f"JOB#{body['job_id']}"})['Item']
        assert row['config'] == {'project_id': CONTAINER, 'persona_id': persona['persona_id']}
        assert call('GET', f"/company-personas/jobs/{body['job_id']}", ADMIN)[0] == 200


class TestPromote:
    def test_an_admin_promotes_a_copy_without_the_notes(self, call, world):
        persona = _promote(call)

        assert persona['persona_id'] != 'persona_a'
        assert persona['research_notes'] == []
        assert persona['copied_from']['scope'] == 'project'
        assert persona['copied_from']['project_name'] == 'Alpha'
        assert persona['avatar_url'] == f"signed:s3://{BUCKET}/avatars/{persona['persona_id']}/abc.png"
        assert [p['persona_id'] for p in _library(world['table'])] == [persona['persona_id']]
        meta = world['table'].get_item(Key={'pk': f'PROJECT#{CONTAINER}', 'sk': 'META'})['Item']
        assert meta['persona_count'] == 1

    def test_the_owner_who_is_not_an_admin_is_refused(self, call, world):
        assert call('POST', '/projects/p1/personas/persona_a/promote', OWNER) == (403, ADMIN_REQUIRED)
        assert _library(world['table']) == []

    def test_a_stranger_gets_the_gate_404(self, call):
        assert call('POST', '/projects/p1/personas/persona_a/promote', STRANGER) == (404, NOT_FOUND)

    def test_a_missing_project_or_persona_is_a_404(self, call):
        assert call('POST', '/projects/nope/personas/persona_a/promote', ADMIN) == (404, NOT_FOUND)
        assert call('POST', '/projects/p1/personas/persona_nope/promote', ADMIN)[0] == 404


class TestCopySources:
    def test_the_library_and_the_callers_other_projects_with_personas(self, call, world):
        _promote(call)
        world['table'].put_item(Item=_persona('p2', 'persona_b', name='Bo'))

        status, body = call('GET', '/projects/p2/personas/copy-sources', MEMBER)

        assert status == 200
        assert [summary['name'] for summary in body['company']] == ['Ana']
        assert set(body['company'][0]) == {'persona_id', 'name', 'tagline', 'avatar_url', 'copied_from'}
        # p2 is this project, p3 is public but MEMBER is neither its owner nor a member.
        assert body['projects'] == [{'project_id': 'p1', 'name': 'Alpha', 'persona_count': 1}]

    def test_projects_without_personas_or_being_deleted_are_left_out(self, call, world):
        world['table'].put_item(Item=_meta('p4', name='Empty', persona_count=0))
        world['table'].put_item(Item=_meta('p5', name='Going', deletion_started_at='now'))
        world['table'].put_item(Item=_persona('p5', 'persona_g', name='Gone'))

        status, body = call('GET', '/projects/p2/personas/copy-sources', OWNER)

        assert status == 200
        assert body['projects'] == [{'project_id': 'p1', 'name': 'Alpha', 'persona_count': 1}]

    def test_the_stored_persona_count_is_used_and_a_legacy_meta_without_one_is_counted(self, call, world):
        world['table'].put_item(Item=_meta('p6', name='Stored', persona_count=4))
        legacy = _meta('p7', name='Legacy')
        del legacy['persona_count']
        world['table'].put_item(Item=legacy)
        world['table'].put_item(Item=_persona('p7', 'persona_l1', name='Lee'))
        world['table'].put_item(Item=_persona('p7', 'persona_l2', name='Lou'))

        status, body = call('GET', '/projects/p2/personas/copy-sources', OWNER)

        assert status == 200
        counts = {source['project_id']: source['persona_count'] for source in body['projects']}
        assert counts['p6'] == 4
        assert counts['p7'] == 2

    def test_a_viewer_may_list_sources(self, call):
        assert call('GET', '/projects/p1/personas/copy-sources', MEMBER)[0] == 200


class TestCopyIn:
    def test_copy_from_another_project_the_caller_is_a_member_of(self, call, world):
        status, body = call('POST', '/projects/p2/personas/copy', MEMBER,
                            body={'source': {'scope': 'project', 'project_id': 'p1'}, 'persona_ids': ['persona_a']})

        assert status == 201
        [copy] = body['personas']
        assert copy['research_notes'] == []
        assert copy['copied_from']['project_id'] == 'p1'
        assert copy['copied_from']['copied_by'] == 'member-sub'
        head = world['s3'].head_object(Bucket=BUCKET, Key=f"avatars/{copy['persona_id']}/abc.png")
        assert head['Metadata'] == {AVATAR_OWNER_METADATA_KEY: 'p2'}

    def test_copy_from_the_library(self, call):
        library = _promote(call)

        status, body = call('POST', '/projects/p2/personas/copy', OWNER,
                            body={'source': {'scope': 'company'}, 'persona_ids': [library['persona_id']]})

        assert status == 201
        assert body['personas'][0]['copied_from']['scope'] == 'company'
        assert 'project_id' not in body['personas'][0]['copied_from']

    def test_a_viewer_of_the_target_cannot_copy_in(self, call):
        status, _ = call('POST', '/projects/p1/personas/copy', MEMBER,
                         body={'source': {'scope': 'company'}, 'persona_ids': ['x']})

        assert status == 403

    @pytest.mark.parametrize('source', [
        {'scope': 'project', 'project_id': 'p3'},  # public, but not owned / a member of
        {'scope': 'project', 'project_id': 'nope'},
        {'scope': 'project', 'project_id': CONTAINER},
    ])
    def test_a_source_the_caller_does_not_belong_to_is_a_404(self, call, source):
        body = {'source': source, 'persona_ids': ['persona_c']}

        assert call('POST', '/projects/p2/personas/copy', OWNER, body=body) == (404, NOT_FOUND)

    def test_an_admin_who_is_not_a_member_cannot_use_a_project_as_source(self, call):
        body = {'source': {'scope': 'project', 'project_id': 'p3'}, 'persona_ids': ['persona_c']}

        assert call('POST', '/projects/p2/personas/copy', ADMIN, body=body) == (404, NOT_FOUND)

    def test_a_persona_missing_from_the_source_is_a_404(self, call):
        body = {'source': {'scope': 'project', 'project_id': 'p1'}, 'persona_ids': ['persona_a', 'nope']}

        assert call('POST', '/projects/p2/personas/copy', OWNER, body=body) == (
            404, {'success': False, 'error': 'Persona not found'})

    @pytest.mark.parametrize('body', [
        {},
        {'source': {'scope': 'elsewhere'}, 'persona_ids': ['a']},
        {'source': {'scope': 'project'}, 'persona_ids': ['a']},
        {'source': {'scope': 'project', 'project_id': 'p2'}, 'persona_ids': ['a']},  # this project
        {'source': {'scope': 'company'}, 'persona_ids': []},
        {'source': {'scope': 'company'}, 'persona_ids': ['a', 'a']},
        {'source': {'scope': 'company'}, 'persona_ids': ['a', '']},
        {'source': {'scope': 'company'}, 'persona_ids': ['a', 7]},
        {'source': {'scope': 'company'}, 'persona_ids': 'a'},
        {'source': {'scope': 'company'}, 'persona_ids': [f'p{i}' for i in range(21)]},
    ])
    def test_a_bad_body_is_a_400(self, call, body):
        assert call('POST', '/projects/p2/personas/copy', OWNER, body=body)[0] == 400

    def test_a_copy_into_a_deleted_project_is_a_404_for_an_admin(self, call, world):
        world['table'].update_item(Key={'pk': 'PROJECT#p2', 'sk': 'META'}, UpdateExpression='SET deletion_started_at = :t',
                                   ExpressionAttributeValues={':t': 'now'})
        body = {'source': {'scope': 'project', 'project_id': 'p1'}, 'persona_ids': ['persona_a']}
        world['table'].update_item(Key={'pk': 'PROJECT#p1', 'sk': 'META'}, UpdateExpression='SET owner_sub = :a',
                                   ExpressionAttributeValues={':a': 'admin-sub'})

        assert call('POST', '/projects/p2/personas/copy', ADMIN, body=body) == (404, NOT_FOUND)
        keys = [obj['Key'] for obj in world['s3'].list_objects_v2(Bucket=BUCKET).get('Contents', [])]
        assert keys == [AVATAR_KEY]
