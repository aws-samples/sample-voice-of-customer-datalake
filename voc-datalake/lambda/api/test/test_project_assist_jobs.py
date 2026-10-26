"""The five project assists run as assist jobs.

Through the real handler, gate and shared/assist_jobs.py against moto tables:
a route answers 202 and writes a pending `assist_*` row, the worker branch of
`lambda_handler` runs the work, and `GET /projects/{id}/jobs/{job_id}` returns the
body the synchronous route used to answer as `result`. Cheap refusals stay
synchronous; the Background jobs list never shows an assist; a caller who cannot
view the project gets 404 on the poll.
"""
import json
from contextlib import ExitStack
from unittest.mock import patch

import pytest
import test_project_jobs_access as job_routes

from shared.exceptions import ServiceError

# The same moto tables and project (owner + one editor) as the other job routes' suite.
_tables = job_routes._tables
tables = job_routes.tables
existing_project = job_routes.existing_project
EDITOR, PROJECT = job_routes.EDITOR, job_routes.PROJECT

STRANGER = {'sub': 'stranger-sub', 'cognito:username': 'sam', 'email': 'sam@example.com'}
WORKER = 'voc-projects-assist'

# (path, body, job type, patched work target, its answer)
ASSISTS = [
    (f'/projects/{PROJECT}/prfaq-autofill', {'title': 'Acme rides'}, 'assist_prfaq_autofill',
     'projects.autofill_prfaq_questions', {'answers': ['a', '', '', '', '']}),
    (f'/projects/{PROJECT}/documents/suggest-brief', {'doc_type': 'prd'}, 'assist_document_brief',
     'projects.suggest_document_brief', {'title': 'T', 'feature_idea': 'F'}),
    (f'/projects/{PROJECT}/research/suggest-questions', {'filters': {'days': 7}}, 'assist_research_questions',
     'projects.suggest_research_questions', {'suggestions': [{'title': 't', 'question': 'q?'}]}),
    (f'/projects/{PROJECT}/product-context/interview', {'message': 'We sell bikes'}, 'assist_interview_turn',
     'product_context.interview_turn', {'assistant_message': 'ok', 'applied_patch': {}, 'context': {}}),
    (f'/projects/{PROJECT}/personas/x1/regenerate-avatar', None, 'assist_persona_avatar',
     'projects.regenerate_persona_avatar', {'success': True, 'avatar_url': 'https://cdn/a.png', 'avatar_prompt': 'p'}),
]


@pytest.fixture
def persona(tables, request):
    request.getfixturevalue('existing_project')
    tables[0].put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'PERSONA#x1', 'persona_id': 'x1'})


@pytest.fixture
def world(tables, request, api_gateway_event, lambda_context, monkeypatch):
    """``call`` one request as ``claims``; ``work`` delivers every recorded worker invoke."""
    request.getfixturevalue('persona')
    import projects
    import projects_handler
    from shared import assist_jobs

    projects_table, jobs_table, aggregates_table = tables
    monkeypatch.setenv('ASSIST_WORKER_FUNCTION', WORKER)
    invokes: list[tuple[str, dict]] = []
    patches = [
        patch.object(projects_handler, 'get_projects_table', return_value=projects_table),
        patch.object(projects_handler, 'get_aggregates_table', return_value=aggregates_table),
        patch.object(projects_handler, 'get_jobs_table', return_value=jobs_table),
        patch.object(projects, 'projects_table', projects_table),
        patch.object(assist_jobs, 'get_jobs_table', return_value=jobs_table),
        patch.object(assist_jobs, 'invoke_lambda_async', side_effect=lambda fn, ev: invokes.append((fn, ev))),
    ]
    stack = ExitStack()
    for p in patches:
        stack.enter_context(p)

    class World:
        def call(self, claims, method, path, body=None):
            event = api_gateway_event(method=method, path=path, body=body, claims=claims,
                                      path_params={'project_id': path.split('/')[2]})
            response = projects_handler.lambda_handler(event, lambda_context)
            return response['statusCode'], json.loads(response['body'])

        def work(self):
            outcomes = [projects_handler.lambda_handler(ev, lambda_context) for _, ev in invokes]
            invokes.clear()
            return outcomes

        invoked = invokes
        jobs = jobs_table

    with stack:
        yield World()


class TestEveryAssistIsAJob:
    @pytest.mark.parametrize(('path', 'body', 'job_type', 'target', 'answer'), ASSISTS)
    def test_the_route_answers_202_and_the_poll_returns_the_old_body(
        self, world, path, body, job_type, target, answer,
    ):
        status, started = world.call(EDITOR, 'POST', path, body)

        assert status == 202
        assert started == {'success': True, 'job_id': started['job_id'], 'status': 'pending'}
        [(function, event)] = world.invoked
        assert function == WORKER
        assert event == {'action': 'assist_job', 'pk': f'PROJECT#{PROJECT}', 'job_id': started['job_id']}
        row = world.jobs.get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': f'JOB#{started["job_id"]}'})['Item']
        assert (row['job_type'], row['initiated_by'], row['project_id']) == (job_type, EDITOR['sub'], PROJECT)

        with patch(target, return_value=answer):
            assert world.work() == [{'status': 'completed'}]

        status, polled = world.call(EDITOR, 'GET', f'/projects/{PROJECT}/jobs/{started["job_id"]}')
        assert status == 200
        assert (polled['status'], polled['job_type'], polled['result']) == ('completed', job_type, answer)

    def test_a_model_failure_reads_as_the_assists_message(self, world):
        _, started = world.call(EDITOR, 'POST', f'/projects/{PROJECT}/prfaq-autofill', {})

        with patch('projects.autofill_prfaq_questions', side_effect=RuntimeError('bedrock down')):
            assert world.work() == [{'status': 'failed'}]

        _, polled = world.call(EDITOR, 'GET', f'/projects/{PROJECT}/jobs/{started["job_id"]}')
        assert (polled['status'], polled['error']) == ('failed', 'Could not draft the answers. Please try again.')

    def test_the_interview_keeps_its_unavailable_message(self, world):
        _, started = world.call(EDITOR, 'POST', f'/projects/{PROJECT}/product-context/interview', {'message': 'm'})

        with patch('product_context.interview_turn', side_effect=ServiceError('anything')):
            world.work()

        _, polled = world.call(EDITOR, 'GET', f'/projects/{PROJECT}/jobs/{started["job_id"]}')
        assert polled['error'] == 'AI interview unavailable. Please try again.'


class TestCheapRefusalsStaySynchronous:
    def test_a_missing_persona_is_404_and_starts_nothing(self, world):
        status, answer = world.call(EDITOR, 'POST', f'/projects/{PROJECT}/personas/nope/regenerate-avatar')

        assert (status, answer) == (404, {'success': False, 'error': 'Persona not found'})
        assert world.invoked == []
        assert world.jobs.scan()['Items'] == []

    def test_an_empty_interview_message_is_400_and_starts_nothing(self, world):
        status, answer = world.call(EDITOR, 'POST', f'/projects/{PROJECT}/product-context/interview', {})

        assert (status, answer) == (400, {'success': False, 'error': 'message is required'})
        assert world.jobs.scan()['Items'] == []

    @pytest.mark.parametrize(('path', 'body', 'error'), [
        ('documents/suggest-brief', {'title': 'x' * 201}, 'Title is too long (at most 200 characters)'),
        ('documents/suggest-brief', {'feature_idea': 'x' * 4001}, 'Description is too long (at most 4000 characters)'),
        ('documents/suggest-brief', {'title': 7}, 'Title must be text'),
        ('documents/suggest-brief', {'filters': 'all'}, 'filters must be an object'),
        ('prfaq-autofill', {'title': 'x' * 201}, 'Title is too long (at most 200 characters)'),
        ('prfaq-autofill', {'answers': ['', 'x' * 4001]}, 'Answer 2 is too long (at most 4000 characters)'),
        ('prfaq-autofill', {'answers': [''] * 6}, 'answers must be a list of at most 5 texts'),
        ('prfaq-autofill', {'answers': 'typed'}, 'answers must be a list of at most 5 texts'),
        ('prfaq-autofill', {'answers': [None, 3]}, 'Answer 2 must be text'),
    ])
    def test_typed_text_over_its_cap_is_400_and_starts_nothing(self, world, path, body, error):
        status, answer = world.call(EDITOR, 'POST', f'/projects/{PROJECT}/{path}', body)

        assert (status, answer) == (400, {'success': False, 'error': error})
        assert world.jobs.scan()['Items'] == []

    @pytest.mark.parametrize(('path', 'target'), [
        ('documents/suggest-brief', 'projects.suggest_document_brief'),
        ('prfaq-autofill', 'projects.autofill_prfaq_questions'),
    ])
    def test_text_at_its_cap_reaches_the_work_unchanged(self, world, path, target):
        body = {'title': 't' * 200, 'feature_idea': 'd' * 4000, 'answers': ['a' * 4000, '', '', '', '']}
        assert world.call(EDITOR, 'POST', f'/projects/{PROJECT}/{path}', body)[0] == 202

        with patch(target, return_value={}) as work:
            world.work()

        assert work.call_args.args[1] == body

    @pytest.mark.parametrize(('path', 'body'), [(path, body) for path, body, *_ in ASSISTS])
    def test_a_caller_who_cannot_view_the_project_gets_404(self, world, path, body):
        assert world.call(STRANGER, 'POST', path, body)[0] == 404
        assert world.jobs.scan()['Items'] == []


class TestAccessAndListing:
    def test_the_poll_is_404_for_a_caller_who_cannot_view_the_project(self, world):
        _, started = world.call(EDITOR, 'POST', f'/projects/{PROJECT}/prfaq-autofill', {})

        status, _ = world.call(STRANGER, 'GET', f'/projects/{PROJECT}/jobs/{started["job_id"]}')

        assert status == 404

    def test_the_background_jobs_list_leaves_assists_out(self, world):
        world.jobs.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'JOB#job_real', 'job_id': 'job_real',
                                  'job_type': 'research', 'status': 'completed', 'created_at': '2026-01-01'})
        world.call(EDITOR, 'POST', f'/projects/{PROJECT}/prfaq-autofill', {})

        _, listed = world.call(EDITOR, 'GET', f'/projects/{PROJECT}/jobs')

        assert [job['job_id'] for job in listed['jobs']] == ['job_real']
