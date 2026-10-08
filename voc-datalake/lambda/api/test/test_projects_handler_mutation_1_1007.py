"""Mutation hardening for `api/projects_handler.py` lines 1-1007 (gate, CRUD wrappers, job routes).

`test_projects_handler.py`, `test_project_permissions.py` and `test_project_jobs_access.py`
pin that each route reaches the right `projects` function, that the gate refuses
the right callers and that every job route records a JOB row for an existing
project. A mutation run over these lines found what they cannot see:

* the ARGUMENTS each thin route forwards. The earlier tests mostly checked
  `assert_called_once()`, so a swapped `project_id`/`document_id`, a dropped
  body, a body defaulted to `{}` when one was sent, or a lost caller all passed.
  Each route is called here once and its delegate's exact call is pinned.
* the full CONFIG each job route records and sends: every default (the research
  question, `days=30`, `persona_count=3`, the 30-day persona TTL, `'Merged
  Document'`), the starter's category scope, the job type, the `status`, the
  invoke/Step Functions payload and the response message.
* the gate's batched read: the request shape (`ConsistentRead`, projection),
  the back-off schedule, items that are not a project META, the 100-key chunking
  and the wording of its refusal and log line.
* the boundaries of the jobs list (scan cap 1000, limit 50, `created_at` order,
  the `job_id` fall-back) and the duplicate route's target validation (128 chars).
* the job Lambdas' names are read from the environment at import.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
from boto3.dynamodb.conditions import Key
from handler_events_fixtures import keyed_get_item, project_meta_table
from module_reload_fixtures import reload_cycle

import projects_handler
from shared.category_access import SCOPE_CONFIG_KEY, CategoryScope
from shared.exceptions import AuthorizationError, ConfigurationError, ServiceError
from shared.project_access import ROLE_ADMIN, Caller, ProjectAccess
from shared.test.instrumentation_fixtures import assert_tracer_wrapped

ADMIN = Caller(subject='test-user-id', is_admin=True, email='test@example.com')
STRANGER_CLAIMS = {'sub': 'stranger-sub', 'email': 's@example.com'}
VIEWER_CLAIMS = {'sub': 'viewer-sub', 'email': 'v@example.com'}
SCOPE = CategoryScope(all=False, categories=frozenset({'billing', 'app'}))
SCOPE_CONFIG = {'all': False, 'categories': ['app', 'billing']}
NOT_FOUND = {'success': False, 'error': 'Project not found'}


def _private_meta(project_id: str) -> dict:
    return {'pk': f'PROJECT#{project_id}', 'sk': 'META', 'visibility': 'private',
            'owner_sub': 'owner-sub', 'members': {'viewer-sub': {'role': 'viewer'}}}


@dataclass
class World:
    """The doubles every route test runs against."""

    event_factory: Any
    context: Any
    create_job: MagicMock
    invoke: MagicMock
    boto_client: MagicMock
    scope_for_event: MagicMock
    aggregates: MagicMock

    def call(self, method: str, path: str, body: Any = None, query: dict | None = None,
             claims: dict | None = None) -> tuple[int, Any, dict]:
        event = self.event_factory(method=method, path=path, body=body, query_params=query,
                                   claims=claims)
        response = projects_handler.lambda_handler(event, self.context)
        return response['statusCode'], json.loads(response['body']), event

    @property
    def sfn(self) -> MagicMock:
        return self.boto_client.return_value


@pytest.fixture
def world(api_gateway_event, lambda_context, monkeypatch) -> Iterator[World]:
    """Projects p1 and p2 exist; job creation, invocation, Step Functions and the scope are doubled."""
    monkeypatch.delenv('RESEARCH_STATE_MACHINE_ARN', raising=False)
    monkeypatch.delenv('DOCUMENT_STATE_MACHINE_ARN', raising=False)
    aggregates = MagicMock(name='aggregates')
    with (
        patch.object(projects_handler, 'get_projects_table', return_value=project_meta_table('p1', 'p2')),
        patch.object(projects_handler, 'get_aggregates_table', return_value=aggregates),
        patch.object(projects_handler, 'create_job', return_value=('job-1', {})) as create_job,
        patch.object(projects_handler, 'invoke_lambda_async') as invoke,
        patch.object(projects_handler.boto3, 'client') as boto_client,
        patch.object(projects_handler.category_gate, 'scope_for_event', return_value=SCOPE) as scope,
        # The "no matching feedback" 400 prechecks read the feedback table; here feedback exists.
        patch.object(projects_handler, 'ensure_persona_feedback', return_value=None),
        patch.object(projects_handler, 'ensure_research_feedback', return_value=None),
    ):
        yield World(api_gateway_event, lambda_context, create_job, invoke, boto_client, scope, aggregates)


# ---------------------------------------------------------------------------
# Thin routes: each forwards exactly its path ids, body and caller.
# ---------------------------------------------------------------------------

BODY = {'name': 'N', 'role': 'editor'}
ADMIN_ACCESS = ProjectAccess(role=ROLE_ADMIN)

# (method, path, body, query, delegate, expected args, expected kwargs)
THIN_ROUTES = [
    ('GET', '/projects', None, None, 'list_projects', (ADMIN,), {}),
    ('POST', '/projects', BODY, None, 'create_project', (BODY, ADMIN), {}),
    ('POST', '/projects', None, None, 'create_project', ({}, ADMIN), {}),
    ('GET', '/projects/p1', None, None, 'get_project', ('p1', ADMIN), {}),
    ('POST', '/projects/p1/chat-context', {'selected_document_ids': ['d1']}, None,
     'get_project_chat_context', ('p1', ['d1'], ADMIN), {}),
    ('POST', '/projects/p1/chat-context', {'other': 1}, None,
     'get_project_chat_context', ('p1', [], ADMIN), {}),
    ('PUT', '/projects/p1', BODY, None, 'update_project', ('p1', BODY), {}),
    ('DELETE', '/projects/p1', None, None, 'delete_project', ('p1',), {}),
    ('PUT', '/projects/p1/visibility', BODY, None, 'set_project_visibility', ('p1', BODY), {}),
    ('GET', '/projects/p1/members', None, None, 'get_project_members', ('p1', ADMIN), {}),
    ('GET', '/projects/p1/members/candidates', None, {'q': 'ad'}, 'search_member_candidates',
     ('p1', 'ad'), {}),
    ('GET', '/projects/p1/members/candidates', None, None, 'search_member_candidates', ('p1', ''), {}),
    ('POST', '/projects/p1/members', BODY, None, 'add_project_member', ('p1', BODY, ADMIN), {}),
    ('PUT', '/projects/p1/members/m1', BODY, None, 'update_project_member', ('p1', 'm1', BODY), {}),
    ('DELETE', '/projects/p1/members/m1', None, None, 'remove_project_member',
     ('p1', 'm1', ADMIN, ADMIN_ACCESS), {}),
    ('POST', '/projects/p1/owner', BODY, None, 'transfer_project_owner', ('p1', BODY, ADMIN), {}),
    ('POST', '/projects/p1/personas', BODY, None, 'create_persona', ('p1', BODY), {}),
    ('PUT', '/projects/p1/personas/x1', BODY, None, 'update_persona', ('p1', 'x1', BODY), {}),
    ('DELETE', '/projects/p1/personas/x1', None, None, 'delete_persona', ('p1', 'x1'), {}),
    ('POST', '/projects/p1/personas/x1/notes', BODY, None, 'add_persona_note', ('p1', 'x1', BODY), {}),
    ('PUT', '/projects/p1/personas/x1/notes/n1', BODY, None, 'update_persona_note',
     ('p1', 'x1', 'n1', BODY), {}),
    ('DELETE', '/projects/p1/personas/x1/notes/n1', None, None, 'delete_persona_note',
     ('p1', 'x1', 'n1'), {}),
    ('POST', '/projects/p1/personas/x1/regenerate-avatar', None, None, 'regenerate_persona_avatar',
     ('p1', 'x1'), {}),
    ('POST', '/projects/p1/documents', BODY, None, 'create_document', ('p1', BODY), {}),
    ('PUT', '/projects/p1/documents/d1', BODY, None, 'update_document', ('p1', 'd1', BODY), {}),
    ('GET', '/projects/p1/documents/d1/versions', None, None, 'get_document_versions', ('p1', 'd1'), {}),
    ('POST', '/projects/p1/documents/d1/versions/v1/restore', BODY, None, 'restore_document',
     ('p1', 'd1', 'v1', BODY), {}),
    ('DELETE', '/projects/p1/documents/d1', None, None, 'delete_document', ('p1', 'd1'), {}),
]


class TestEveryThinRouteForwardsExactlyItsArguments:
    @pytest.mark.parametrize(('method', 'path', 'body', 'query', 'delegate', 'args', 'kwargs'),
                             THIN_ROUTES)
    def test_the_delegate_gets_the_path_ids_body_and_caller(
        self, world, method, path, body, query, delegate, args, kwargs,
    ):
        answer = {'success': True, 'from': delegate}
        with patch.object(projects_handler, delegate, return_value=answer) as mock:
            status, response, _ = world.call(method, path, body=body, query=query)
        assert (status, response) == (200, answer)
        mock.assert_called_once_with(*args, **kwargs)


class TestEveryRouteIsTraced:
    @pytest.mark.parametrize('route', [
        'api_list_projects', 'api_create_project', 'api_get_project', 'api_project_chat_context',
        'api_update_project', 'api_delete_project', 'api_set_project_visibility',
        'api_list_project_members', 'api_member_candidates', 'api_add_project_member',
        'api_update_project_member', 'api_remove_project_member', 'api_transfer_project_owner',
        'api_create_persona', 'api_import_persona', 'api_update_persona',
        'api_delete_persona', 'api_add_persona_note', 'api_update_persona_note',
        'api_delete_persona_note', 'api_regenerate_persona_avatar', 'api_generate_personas',
        'api_run_research', 'api_generate_document', 'api_create_document', 'api_merge_documents',
        'api_update_document', 'api_document_versions', 'api_restore_document_version',
        'api_delete_document', 'api_duplicate_document', 'api_get_job_status', 'api_list_jobs',
        'api_delete_job',
    ])
    def test_route_is_the_tracer_wrapper(self, route):
        assert_tracer_wrapped(projects_handler, route)


# ---------------------------------------------------------------------------
# Job routes: the exact config, job row, dispatch and answer.
# ---------------------------------------------------------------------------

def _started(world: World, job_type: str, config_key: str, config: dict, **kwargs) -> None:
    world.create_job.assert_called_once_with('p1', job_type, config_key, config,
                                             initiated_by='test-user-id', **kwargs)


class TestThePersonaJobs:
    def test_an_import_records_and_sends_its_config(self, world):
        status, body, _ = world.call('POST', '/projects/p1/personas/import',
                                     body={'input_type': 'text', 'content': 'A described persona.'})
        config = {'input_type': 'text', 'content': 'A described persona.', 'media_type': ''}
        assert (status, body) == (200, {'success': True, 'job_id': 'job-1', 'status': 'running',
                                        'message': 'Persona import started.'})
        _started(world, 'import_persona', 'import_config', config)
        world.invoke.assert_called_once_with(
            projects_handler.PERSONA_IMPORTER_FUNCTION,
            {'project_id': 'p1', 'job_id': 'job-1', 'import_config': config},
        )

    def test_a_generation_records_every_default(self, world):
        with patch.object(projects_handler, 'feedback_filters_from_body',
                          return_value={'sources': ['web']}) as filters_from_body:
            status, body, event = world.call('POST', '/projects/p1/personas/generate',
                                             body={'note': 1})
        filters = {
            'sources': ['web'], 'date_basis': 'imported', 'persona_count': 3,
            'custom_instructions': '', 'response_language': None, 'generate_avatars': True,
            SCOPE_CONFIG_KEY: SCOPE_CONFIG,
        }
        assert (status, body) == (200, {'success': True, 'job_id': 'job-1', 'status': 'running',
                                        'message': 'Persona generation started.'})
        filters_from_body.assert_called_once_with({'note': 1})
        _started(world, 'generate_personas', 'filters', filters, ttl_minutes=43200)
        world.invoke.assert_called_once_with(
            projects_handler.PERSONA_GENERATOR_FUNCTION,
            {'project_id': 'p1', 'job_id': 'job-1', 'filters': filters},
        )
        world.scope_for_event.assert_called_once_with(event, world.aggregates)

    def test_a_generation_forwards_what_the_caller_set(self, world):
        world.call('POST', '/projects/p1/personas/generate', body={
            'date_basis': 'review', 'persona_count': 5, 'custom_instructions': 'Be brief',
            'response_language': 'ko', 'generate_avatars': False,
        })
        filters = world.create_job.call_args.args[3]
        assert {key: filters[key] for key in (
            'date_basis', 'persona_count', 'custom_instructions', 'response_language',
            'generate_avatars')} == {
            'date_basis': 'review', 'persona_count': 5, 'custom_instructions': 'Be brief',
            'response_language': 'ko', 'generate_avatars': False,
        }

    def test_a_non_boolean_avatar_flag_is_refused_by_name(self, world):
        status, body, _ = world.call('POST', '/projects/p1/personas/generate',
                                     body={'generate_avatars': 'false'})
        assert (status, body['error']) == (400, 'generate_avatars must be true or false, got str')
        world.create_job.assert_not_called()

    @pytest.mark.parametrize(('value', 'expected'), [(1, 1), (0, 1), (10, 10), (11, 10)])
    def test_the_persona_count_bounds(self, value, expected):
        assert projects_handler.validate_persona_count(value) == expected

    def test_the_persona_count_default_is_three(self):
        assert projects_handler.validate_persona_count(None) == 3


RESEARCH_DEFAULTS = {
    'question': 'What are the main customer pain points?', 'title': '', 'sources': [],
    'categories': [], 'sentiments': [], 'days': 30, 'date_basis': 'imported',
    'selected_persona_ids': [], 'selected_document_ids': [], 'response_language': None,
    'use_web_search': False, 'filters': {}, SCOPE_CONFIG_KEY: SCOPE_CONFIG,
}
RESEARCH_BODY = {
    'question': 'Why churn?', 'title': 'Churn', 'sources': ['web'], 'categories': ['app'],
    'sentiments': ['negative'], 'days': 7, 'date_basis': 'review',
    'selected_persona_ids': ['x1'], 'selected_document_ids': ['d1'], 'response_language': 'ko',
    'use_web_search': True,
}


class TestTheResearchJob:
    def test_with_a_state_machine_the_defaults_start_an_execution(self, world, monkeypatch):
        monkeypatch.setenv('RESEARCH_STATE_MACHINE_ARN', 'arn:research')
        status, body, _ = world.call('POST', '/projects/p1/research')
        assert (status, body) == (200, {'success': True, 'job_id': 'job-1', 'status': 'pending',
                                        'message': 'Research started.'})
        _started(world, 'research', 'research_config', RESEARCH_DEFAULTS, status='pending')
        world.boto_client.assert_called_once_with('stepfunctions')
        world.sfn.start_execution.assert_called_once_with(
            stateMachineArn='arn:research', name='job-1',
            input=json.dumps({'job_id': 'job-1', 'project_id': 'p1',
                              'research_config': RESEARCH_DEFAULTS}),
        )

    def test_every_field_the_caller_sets_is_forwarded(self, world, monkeypatch):
        monkeypatch.setenv('RESEARCH_STATE_MACHINE_ARN', 'arn:research')
        world.call('POST', '/projects/p1/research', body=RESEARCH_BODY)
        assert world.create_job.call_args.args[3] == {
            **RESEARCH_BODY, 'filters': RESEARCH_BODY, SCOPE_CONFIG_KEY: SCOPE_CONFIG,
        }

    def test_a_truthy_non_boolean_web_search_stays_off(self, world, monkeypatch):
        monkeypatch.setenv('RESEARCH_STATE_MACHINE_ARN', 'arn:research')
        world.call('POST', '/projects/p1/research', body={'use_web_search': 'true'})
        assert world.create_job.call_args.args[3]['use_web_search'] is False

    def test_without_a_state_machine_research_runs_inline(self, world):
        with patch.object(projects_handler, 'run_research',
                          return_value={'success': True, 'inline': 1}) as run:
            status, body, _ = world.call('POST', '/projects/p1/research', body={'question': 'Q'})
        assert (status, body) == (200, {'success': True, 'inline': 1})
        run.assert_called_once_with('p1', {'question': 'Q'}, category_scope=SCOPE_CONFIG)
        world.boto_client.assert_not_called()


class TestTheDocumentJob:
    @pytest.mark.parametrize(('doc_type', 'message'), [('prd', 'PRD generation started.'),
                                                       ('prfaq', 'PRFAQ generation started.')])
    def test_with_a_state_machine_a_chain_type_starts_an_execution(
        self, world, monkeypatch, doc_type, message,
    ):
        monkeypatch.setenv('DOCUMENT_STATE_MACHINE_ARN', 'arn:doc')
        status, body, _ = world.call('POST', '/projects/p1/document',
                                     body={'doc_type': doc_type, 'title': 'Spec (v3)', 'x': 1})
        config = {'doc_type': doc_type, 'title': 'Spec', 'x': 1, SCOPE_CONFIG_KEY: SCOPE_CONFIG}
        assert (status, body) == (200, {'success': True, 'job_id': 'job-1', 'status': 'pending',
                                        'message': message})
        _started(world, f'generate_{doc_type}', 'doc_config', config, status='pending')
        world.boto_client.assert_called_once_with('stepfunctions')
        world.sfn.start_execution.assert_called_once_with(
            stateMachineArn='arn:doc', name='job-1',
            input=json.dumps({'job_id': 'job-1', 'project_id': 'p1', 'doc_config': config}),
        )
        world.invoke.assert_not_called()

    def test_without_a_state_machine_the_generator_is_invoked(self, world):
        world.call('POST', '/projects/p1/document', body={'x': 1})
        config = {'x': 1, 'doc_type': 'prd', 'title': 'Untitled', SCOPE_CONFIG_KEY: SCOPE_CONFIG}
        world.invoke.assert_called_once_with(
            projects_handler.DOCUMENT_GENERATOR_FUNCTION,
            {'project_id': 'p1', 'job_id': 'job-1', 'doc_config': config},
        )
        world.boto_client.assert_not_called()

    @pytest.mark.parametrize(('raw', 'name'), [(7, 'int'), ('PRD', 'str'), ([], 'list')])
    def test_an_unknown_doc_type_names_the_allowlist_and_the_type(self, world, raw, name):
        status, body, _ = world.call('POST', '/projects/p1/document', body={'doc_type': raw})
        assert (status, body['error']) == (400, f'doc_type must be one of: prd, prfaq (got {name})')
        world.create_job.assert_not_called()


class TestTheMergeJob:
    def test_a_custom_merge_keeps_the_title_and_carries_the_scope(self, world):
        status, body, _ = world.call('POST', '/projects/p1/documents/merge',
                                     body={'document_ids': ['d1'], 'title': 'Notes (v2)'})
        config = {'document_ids': ['d1'], 'title': 'Notes (v2)', SCOPE_CONFIG_KEY: SCOPE_CONFIG}
        assert (status, body) == (200, {'success': True, 'job_id': 'job-1', 'status': 'pending',
                                        'message': 'Document merge started.'})
        _started(world, 'merge_documents', 'merge_config', config, status='pending')
        world.invoke.assert_called_once_with(
            projects_handler.DOCUMENT_MERGER_FUNCTION,
            {'project_id': 'p1', 'job_id': 'job-1', 'merge_config': config},
        )

    @pytest.mark.parametrize('output_type', ['prd', 'prfaq'])
    def test_a_managed_merge_defaults_and_canonicalizes_its_title(self, world, output_type):
        world.call('POST', '/projects/p1/documents/merge', body={'output_type': output_type})
        assert world.create_job.call_args.args[3] == {
            'output_type': output_type, SCOPE_CONFIG_KEY: SCOPE_CONFIG, 'title': 'Merged Document',
        }

    @pytest.mark.parametrize(('raw', 'name'), [('research', 'str'), (3, 'int')])
    def test_an_unknown_output_type_names_the_allowlist_and_the_type(self, world, raw, name):
        status, body, _ = world.call('POST', '/projects/p1/documents/merge', body={'output_type': raw})
        assert (status, body['error']) == (
            400, f'output_type must be one of: prd, prfaq, custom (got {name})')
        world.create_job.assert_not_called()


class TestAJobForAMissingProject:
    def test_an_admin_gets_404_before_any_job_row(self, world):
        status, body, _ = world.call('POST', '/projects/nope/documents/merge', body={'x': 1})
        assert (status, body) == (404, NOT_FOUND)
        world.create_job.assert_not_called()

    def test_a_tombstoned_project_is_missing(self, world):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'pk': 'PROJECT#p1', 'sk': 'META', 'status': 'deleted'}}
        with patch.object(projects_handler, 'get_projects_table', return_value=table):
            status, body, _ = world.call('POST', '/projects/p1/documents/merge', body={'x': 1})
        assert (status, body) == (404, NOT_FOUND)
        world.create_job.assert_not_called()


# ---------------------------------------------------------------------------
# Duplicate: the target's validation and its own gate.
# ---------------------------------------------------------------------------

class TestTheDuplicateTarget:
    @pytest.mark.parametrize('target', [None, '', 7, ' p2', 'p2 ', 'p' * 129])
    def test_an_unusable_target_is_refused(self, world, target):
        with patch.object(projects_handler, 'duplicate_document') as duplicate:
            status, body, _ = world.call('POST', '/projects/p1/documents/d1/duplicate',
                                         body={'target_project_id': target, 'x': 1})
        assert (status, body['error']) == (400, 'target_project_id is required')
        duplicate.assert_not_called()

    def test_a_128_character_target_is_accepted(self, world):
        target = 'p' * 128
        with (
            patch.object(projects_handler, 'get_projects_table', return_value=project_meta_table(target)),
            patch.object(projects_handler, 'duplicate_document', return_value={'success': True}) as dup,
        ):
            status, _, _ = world.call('POST', '/projects/p1/documents/d1/duplicate',
                                      body={'target_project_id': target})
        assert status == 200
        dup.assert_called_once_with('p1', 'd1', target)

    def test_a_missing_target_is_404_for_an_admin(self, world):
        with patch.object(projects_handler, 'duplicate_document') as duplicate:
            status, body, _ = world.call('POST', '/projects/p1/documents/d1/duplicate',
                                         body={'target_project_id': 'nope'})
        assert (status, body) == (404, NOT_FOUND)
        duplicate.assert_not_called()

    def test_a_view_only_target_is_403(self, world):
        metas = {('PROJECT#src', 'META'): {**_private_meta('src'),
                                           'members': {'viewer-sub': {'role': 'editor'}}},
                 ('PROJECT#dst', 'META'): _private_meta('dst')}
        table = MagicMock()
        table.get_item.side_effect = keyed_get_item(metas)
        with (
            patch.object(projects_handler, 'get_projects_table', return_value=table),
            patch.object(projects_handler, 'duplicate_document') as duplicate,
        ):
            status, body, _ = world.call('POST', '/projects/src/documents/d1/duplicate',
                                         body={'target_project_id': 'dst'}, claims=VIEWER_CLAIMS)
        assert status == 403
        assert body['success'] is False
        duplicate.assert_not_called()


# ---------------------------------------------------------------------------
# Job reads and delete.
# ---------------------------------------------------------------------------

JOB_FIELDS = ('status', 'current_step', 'job_type', 'created_at', 'updated_at', 'completed_at',
              'error', 'result', 'initiated_by')


@pytest.fixture
def jobs_table() -> Iterator[MagicMock]:
    table = MagicMock()
    with patch.object(projects_handler, 'get_jobs_table', return_value=table):
        yield table


class TestTheJobStatus:
    def test_every_field_is_read_from_the_job_row(self, world, jobs_table):
        item = {field: f'{field}-v' for field in JOB_FIELDS}
        jobs_table.get_item.return_value = {'Item': {**item, 'progress': 40}}
        status, body, _ = world.call('GET', '/projects/p1/jobs/j1')
        assert (status, body) == (200, {'success': True, 'job_id': 'j1', 'progress': 40, **item})
        jobs_table.get_item.assert_called_once_with(Key={'pk': 'PROJECT#p1', 'sk': 'JOB#j1'})

    def test_an_unstarted_job_reads_zero_progress(self, world, jobs_table):
        jobs_table.get_item.return_value = {'Item': {'status': 'pending'}}
        _, body, _ = world.call('GET', '/projects/p1/jobs/j1')
        assert body['progress'] == 0

    def test_a_missing_job_is_404(self, world, jobs_table):
        jobs_table.get_item.return_value = {}
        status, body, _ = world.call('GET', '/projects/p1/jobs/j1')
        assert (status, body) == (404, {'success': False, 'error': 'Job not found'})

    def test_delete_addresses_the_job_key(self, world, jobs_table):
        status, body, _ = world.call('DELETE', '/projects/p1/jobs/j1')
        assert (status, body) == (200, {'success': True})
        jobs_table.delete_item.assert_called_once_with(Key={'pk': 'PROJECT#p1', 'sk': 'JOB#j1'})


def _job(n: int, created_at: str | None = None) -> dict:
    row = {'sk': f'JOB#j{n:04d}'}
    if created_at is not None:
        row['created_at'] = created_at
    return row


class TestTheJobsList:
    def test_every_field_is_listed_and_the_query_names_the_partition(self, world, jobs_table):
        item = {field: f'{field}-v' for field in JOB_FIELDS}
        jobs_table.query.side_effect = [{'Items': [{**item, 'job_id': 'j1', 'progress': 7}]}]
        status, body, _ = world.call('GET', '/projects/p1/jobs')
        assert (status, body) == (200, {'success': True, 'jobs': [
            {'job_id': 'j1', 'progress': 7, **item}]})
        jobs_table.query.assert_called_once_with(KeyConditionExpression=Key('pk').eq('PROJECT#p1'))

    @pytest.mark.parametrize(('row', 'job_id'), [
        ({'sk': 'JOB#from-sk'}, 'from-sk'), ({}, None), ({'job_id': '', 'sk': 'JOB#'}, None),
    ])
    def test_the_job_id_falls_back_to_the_sort_key(self, world, jobs_table, row, job_id):
        jobs_table.query.side_effect = [{'Items': [row]}]
        _, body, _ = world.call('GET', '/projects/p1/jobs')
        assert (body['jobs'][0]['job_id'], body['jobs'][0]['progress']) == (job_id, 0)

    def test_pages_are_followed_with_the_cursor(self, world, jobs_table):
        jobs_table.query.side_effect = [
            {'Items': [_job(1, '2026-01-01')], 'LastEvaluatedKey': {'sk': 'JOB#j0001'}},
            {'Items': [_job(2, '2026-01-02')]},
        ]
        _, body, _ = world.call('GET', '/projects/p1/jobs')
        assert [job['job_id'] for job in body['jobs']] == ['j0002', 'j0001']
        assert jobs_table.query.call_args_list[1] == call(
            KeyConditionExpression=Key('pk').eq('PROJECT#p1'), ExclusiveStartKey={'sk': 'JOB#j0001'})

    def test_the_read_stops_at_the_scan_cap(self, jobs_table):
        cursor = {'sk': 'more'}
        jobs_table.query.side_effect = [
            {'Items': [_job(n) for n in range(999)], 'LastEvaluatedKey': cursor},
            {'Items': [_job(999)], 'LastEvaluatedKey': cursor},
        ]
        assert len(projects_handler._project_job_rows('p1')) == 50
        assert jobs_table.query.call_count == 2

    def test_newest_first_undated_last_and_at_most_fifty(self, jobs_table):
        rows = [_job(n, f'2026-01-01T00:{n:02d}') for n in range(51)] + [_job(99)]
        jobs_table.query.side_effect = [{'Items': list(reversed(rows))}]
        listed = projects_handler._project_job_rows('p1')
        assert [row['sk'] for row in listed] == [f'JOB#j{n:04d}' for n in range(50, 0, -1)]


# ---------------------------------------------------------------------------
# The gate: middleware, context guards and the batched access read.
# ---------------------------------------------------------------------------

class TestTheMiddleware:
    def test_a_preflight_needs_no_caller(self, world):
        event = world.event_factory(method='OPTIONS', path='/projects/p1', claims={})
        response = projects_handler.lambda_handler(event, world.context)
        assert (response['statusCode'], response['body']) == (204, '')

    def test_a_caller_without_a_subject_is_refused(self, world):
        status, body, _ = world.call('GET', '/projects/p1', claims={})
        assert status == 403
        assert body['success'] is False

    def test_the_level_is_the_methods(self, world):
        """A viewer may GET the project, but not PUT it (403, edit), and a stranger sees 404."""
        table = MagicMock()
        table.get_item.side_effect = keyed_get_item({('PROJECT#p1', 'META'): _private_meta('p1')})
        with (
            patch.object(projects_handler, 'get_projects_table', return_value=table),
            patch.object(projects_handler, 'get_project', return_value={'success': True}),
            patch.object(projects_handler, 'update_project', return_value={'success': True}) as upd,
        ):
            assert world.call('GET', '/projects/p1', claims=VIEWER_CLAIMS)[0] == 200
            assert world.call('PUT', '/projects/p1', body=BODY, claims=VIEWER_CLAIMS)[0] == 403
            assert world.call('GET', '/projects/p1', claims=STRANGER_CLAIMS)[:2] == (404, NOT_FOUND)
        upd.assert_not_called()

    def test_an_unconfigured_projects_table_is_named(self):
        with (
            patch.object(projects_handler, 'get_projects_table', return_value=None),
            pytest.raises(ConfigurationError) as raised,
        ):
            projects_handler._gate_meta('p1')
        assert raised.value.message == 'Projects table not configured'

    def test_the_caller_guard_names_its_refusal(self):
        app = MagicMock()
        app.context = {}
        with patch.object(projects_handler, 'app', app), pytest.raises(AuthorizationError) as raised:
            projects_handler._request_caller()
        assert raised.value.message == 'Caller identity could not be determined'

    def test_the_access_guard_returns_the_gated_access(self):
        app = MagicMock()
        app.context = {'project_access': ADMIN_ACCESS}
        with patch.object(projects_handler, 'app', app):
            assert projects_handler._request_access() is ADMIN_ACCESS

    def test_a_doubled_slash_is_gated_on_the_path_segment(self, world):
        """`//projects/p1` matches no route, yet the gate still decides p1 from the path."""
        table = MagicMock()
        table.get_item.side_effect = keyed_get_item({('PROJECT#p1', 'META'): _private_meta('p1')})
        with patch.object(projects_handler, 'get_projects_table', return_value=table):
            viewer = world.call('GET', '//projects/p1', claims=VIEWER_CLAIMS)[:2]
            stranger = world.call('GET', '//projects/p1', claims=STRANGER_CLAIMS)[:2]
        assert viewer[0] == 404
        assert viewer[1] != NOT_FOUND
        assert stranger == (404, NOT_FOUND)

    def test_the_access_guard_names_its_refusal(self):
        app = MagicMock()
        app.context = {'project_access': None}
        with patch.object(projects_handler, 'app', app), pytest.raises(AuthorizationError) as raised:
            projects_handler._request_access()
        assert raised.value.message == 'You do not have permission to manage this project'


def _batch_table(*responses: dict) -> MagicMock:
    table = MagicMock()
    table.name = 't'
    table.meta.client.batch_get_item.side_effect = list(responses)
    return table


class TestTheBatchedAccessRead:
    def test_the_request_is_consistent_and_projected(self):
        table = _batch_table({'Responses': {'t': [{'pk': 'PROJECT#a'}]}})
        projects_handler._gate_meta_batch_chunk(table, ['a', 'b'])
        request = table.meta.client.batch_get_item.call_args.kwargs['RequestItems']['t']
        assert request['Keys'] == [{'pk': 'PROJECT#a', 'sk': 'META'}, {'pk': 'PROJECT#b', 'sk': 'META'}]
        assert request['ConsistentRead'] is True
        assert set(request) == {'Keys', 'ConsistentRead', 'ProjectionExpression',
                                'ExpressionAttributeNames'}
        assert '#' in request['ProjectionExpression']
        assert request['ExpressionAttributeNames']

    def test_only_project_metas_are_kept(self):
        table = _batch_table({'Responses': {'t': [
            {'pk': 'PROJECT#a', 'v': 1}, {'pk': 'OTHER#b'}, {'pk': 7}, 'junk', {},
        ]}})
        assert projects_handler._gate_meta_batch_chunk(table, ['a']) == {'a': {'pk': 'PROJECT#a', 'v': 1}}

    def test_a_response_without_responses_is_empty(self):
        assert projects_handler._gate_meta_batch_chunk(_batch_table({}), ['a']) == {}

    def test_unprocessed_keys_are_re_asked_after_a_growing_back_off(self):
        left = {'t': {'Keys': [{'pk': 'PROJECT#b', 'sk': 'META'}]}}
        table = _batch_table(
            {'Responses': {'t': [{'pk': 'PROJECT#a'}]}, 'UnprocessedKeys': left},
            {'UnprocessedKeys': left},
            {'Responses': {'t': [{'pk': 'PROJECT#b'}]}, 'UnprocessedKeys': {'t': {'Keys': []}}},
        )
        with patch.object(projects_handler.time, 'sleep') as sleep:
            metas = projects_handler._gate_meta_batch_chunk(table, ['a', 'b'])
        assert metas == {'a': {'pk': 'PROJECT#a'}, 'b': {'pk': 'PROJECT#b'}}
        assert sleep.call_args_list == [call(0.1), call(0.2)]
        assert table.meta.client.batch_get_item.call_args_list[1] == call(RequestItems=left)

    def test_still_unprocessed_after_five_attempts_fails_closed_and_logs(self):
        stuck = {'UnprocessedKeys': {'t': {'Keys': [{'pk': 'PROJECT#a', 'sk': 'META'}]}}}
        table = _batch_table(*[stuck] * 5)
        logger = MagicMock()
        with (
            patch.object(projects_handler.time, 'sleep') as sleep,
            patch.object(projects_handler, 'logger', logger),
            pytest.raises(ServiceError) as raised,
        ):
            projects_handler._gate_meta_batch_chunk(table, ['a'])
        assert raised.value.message == 'Failed to check project access'
        # Doubling from the second attempt: 0.05 * 2**n, so the fourth wait is 0.8 s.
        assert [c.args[0] for c in sleep.call_args_list] == pytest.approx([0.1, 0.2, 0.4, 0.8])
        logger.error.assert_called_once_with(
            'Project access check left keys unprocessed after %d attempts', 5)
        assert table.meta.client.batch_get_item.call_count == 5


class TestTheViewableProjects:
    def test_ids_are_distinct_sorted_and_read_in_chunks_of_one_hundred(self):
        ids = [f'p{n:03d}' for n in range(101)]
        chunks: list[list[str]] = []

        def chunk(_table, project_ids):
            chunks.append(project_ids)
            return {pid: {'pk': f'PROJECT#{pid}', 'visibility': 'public'} for pid in project_ids}

        with (
            patch.object(projects_handler, 'get_projects_table', return_value=MagicMock()),
            patch.object(projects_handler, '_gate_meta_batch_chunk', side_effect=chunk),
        ):
            viewable = projects_handler._viewable_project_ids(
                [*reversed(ids), 'p000', ''], Caller(subject='s'))
        assert chunks == [ids[:100], ids[100:]]
        assert viewable == set(ids)

    def test_private_and_tombstoned_projects_are_not_viewable(self):
        metas = {'pub': {'visibility': 'public'}, 'priv': _private_meta('priv'),
                 'gone': {'visibility': 'public', 'status': 'deleted'}}
        with (
            patch.object(projects_handler, 'get_projects_table', return_value=MagicMock()),
            patch.object(projects_handler, '_gate_meta_batch_chunk', return_value=metas),
        ):
            assert projects_handler._viewable_project_ids(['pub'], Caller(subject='s')) == {'pub'}

    def test_an_unconfigured_projects_table_is_named(self):
        with (
            patch.object(projects_handler, 'get_projects_table', return_value=None),
            pytest.raises(ConfigurationError) as raised,
        ):
            projects_handler._viewable_project_ids(['a'], Caller(subject='s'))
        assert raised.value.message == 'Projects table not configured'


class TestTheRowsHiddenFromTheCaller:
    def _hidden(self, caller: Caller, rows: dict, viewable: set[str]) -> tuple[set[str], MagicMock]:
        app = MagicMock()
        app.context = {'project_caller': caller}
        with (
            patch.object(projects_handler, 'app', app),
            patch.object(projects_handler, '_viewable_project_ids', return_value=viewable) as read,
        ):
            return projects_handler._rows_hidden_from_caller(rows), read

    def test_an_admin_sees_every_row_without_a_read(self):
        hidden, read = self._hidden(ADMIN, {'r1': {'project_id': 'x'}}, set())
        assert hidden == set()
        read.assert_not_called()

    def test_no_rows_cost_no_read(self):
        hidden, read = self._hidden(Caller(subject='s'), {}, set())
        assert hidden == set()
        read.assert_not_called()

    def test_rows_of_unviewable_or_unnamed_projects_are_hidden(self):
        rows = {'r1': {'project_id': 'a'}, 'r2': {'project_id': 'b'}, 'r3': {'project_id': 7},
                'r4': {}}
        hidden, read = self._hidden(Caller(subject='s'), rows, {'a'})
        assert hidden == {'r2', 'r3', 'r4'}
        assert list(read.call_args.args[0]) == ['a', 'b']
        assert read.call_args.args[1] == Caller(subject='s')


# ---------------------------------------------------------------------------
# Cold start: the job Lambdas' names come from the environment.
# ---------------------------------------------------------------------------

@pytest.fixture
def reload(monkeypatch):
    yield from reload_cycle(monkeypatch, projects_handler)


class TestTheJobFunctionNamesAreReadAtImport:
    NAMES = ('PERSONA_GENERATOR_FUNCTION', 'DOCUMENT_GENERATOR_FUNCTION',
             'DOCUMENT_MERGER_FUNCTION', 'PERSONA_IMPORTER_FUNCTION')

    def test_each_name_is_its_variable(self, reload):
        module = reload(**{name: f'fn-{name}' for name in self.NAMES})
        assert {name: getattr(module, name) for name in self.NAMES} == {
            name: f'fn-{name}' for name in self.NAMES}

    def test_an_unset_name_is_empty(self, reload):
        module = reload(**dict.fromkeys(self.NAMES))
        assert {getattr(module, name) for name in self.NAMES} == {''}

    def test_the_chat_context_ceiling(self):
        assert projects_handler.MAX_CHAT_CONTEXT_LAMBDA_RESPONSE_BYTES == 5242880
        assert projects_handler._CHAT_CONTEXT_PATH_SUFFIX == '/chat-context'
