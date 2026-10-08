"""Every route that starts an async job writes its JOB row for an EXISTING project,
as the CALLING user.

Two properties of `projects_handler._started_job`, checked against real (moto)
tables through the real handler and gate:

  * An admin is decided by the gate without a META read, so before this an admin
    hitting a missing project id left a JOB row (and an async invocation) behind
    for a project that was never there. Now every job route answers 404 first.
  * A job carries `initiated_by`, the subject of the caller whose request the gate
    allowed, and both job reads expose it.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

from shared.indexes import PROJECTS_BY_TYPE_INDEX

EDITOR = {'sub': 'editor-sub', 'cognito:username': 'eddie', 'email': 'eddie@example.com'}
ADMIN = {'sub': 'admin-sub', 'cognito:username': 'ada', 'cognito:groups': 'admins'}
PROJECT = 'p1'

# (method, path, body) for every route in projects_handler.py that records a job.
JOB_ROUTES = [
    ('POST', f'/projects/{PROJECT}/personas/import',
     {'input_type': 'text', 'content': 'A persona described in words.'}),
    ('POST', f'/projects/{PROJECT}/personas/generate', {'persona_count': 1}),
    ('POST', f'/projects/{PROJECT}/research', {'question': 'Why do customers churn?'}),
    ('POST', f'/projects/{PROJECT}/document', {'doc_type': 'prd', 'title': 'Spec'}),
    ('POST', f'/projects/{PROJECT}/documents/merge', {'output_type': 'custom', 'document_ids': []}),
    ('POST', f'/projects/{PROJECT}/build-prototype', {'title': 'Proto'}),
    ('POST', f'/projects/{PROJECT}/product-report', {}),
]


@pytest.fixture(scope='module')
def _tables():
    with mock_aws():
        yield (pk_sk_table('jobs-projects', gsi1_index=PROJECTS_BY_TYPE_INDEX),
               pk_sk_table('jobs-jobs'),
               # Read by the category gate on every job route (an absent access row = full scope).
               pk_sk_table('jobs-aggregates'))


@pytest.fixture
def tables(_tables):
    yield _tables
    for table in _tables:
        with table.batch_writer() as batch:
            for item in table.scan(ProjectionExpression='pk, sk')['Items']:
                batch.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})


@pytest.fixture
def existing_project(tables):
    projects, _, _ = tables
    projects.put_item(Item={
        'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT, 'name': 'One',
        'gsi1pk': 'TYPE#PROJECT', 'gsi1sk': f'2026-01-01#{PROJECT}', 'status': 'active',
        'visibility': 'private', 'owner_sub': 'owner-sub',
        'members': {EDITOR['sub']: {'role': 'editor'}},
    })


@pytest.fixture
def feedback_read():
    """The F1 no-feedback pre-check's one-item read (persona generate, research).

    Feedback exists by default, because most cases here are about the job row;
    set ``return_value = []`` for the no-feedback cases.
    """
    return MagicMock(return_value=[{'feedback_id': 'f1'}])


@pytest.fixture
def call(tables, api_gateway_event, lambda_context, monkeypatch, feedback_read):
    """One request through lambda_handler as ``claims`` with every job side effect doubled."""
    import projects
    import projects_handler
    from shared import jobs

    projects_table, jobs_table, aggregates_table = tables
    # Both async executors are configured, so the routes take their job path
    # rather than the synchronous fallback that would call Bedrock.
    monkeypatch.setenv('RESEARCH_STATE_MACHINE_ARN', 'arn:aws:states:us-east-1:1:stateMachine:r')
    monkeypatch.setenv('DOCUMENT_STATE_MACHINE_ARN', 'arn:aws:states:us-east-1:1:stateMachine:d')

    def _call(claims, method, path, body):
        event = api_gateway_event(method=method, path=path, body=body, claims=claims,
                                  path_params={'project_id': path.split('/')[2]})
        with (
            patch.object(projects_handler, 'get_projects_table', return_value=projects_table),
            patch.object(projects_handler, 'get_aggregates_table', return_value=aggregates_table),
            patch.object(projects, 'projects_table', projects_table),
            patch.object(jobs, 'get_jobs_table', return_value=jobs_table),
            patch.object(projects_handler, 'get_jobs_table', return_value=jobs_table),
            patch.object(projects_handler, 'invoke_lambda_async') as invoke,
            patch.object(projects_handler.boto3, 'client', return_value=MagicMock()) as sfn,
            patch.object(projects, 'get_feedback_context', feedback_read),
        ):
            response = projects_handler.lambda_handler(event, lambda_context)
        started = invoke.call_count + sfn.return_value.start_execution.call_count
        return response['statusCode'], json.loads(response['body']), started

    return _call


def _job_rows(tables):
    _, jobs_table, _ = tables
    return jobs_table.scan()['Items']


class TestAMissingProjectIsRefusedBeforeAnyJobRowIsWritten:
    @pytest.mark.parametrize(('method', 'path', 'body'), JOB_ROUTES)
    def test_an_admin_gets_404_and_nothing_is_recorded_or_started(self, call, tables, method, path, body):
        status, response, started = call(ADMIN, method, path, body)

        assert (status, response) == (404, {'success': False, 'error': 'Project not found'})
        assert _job_rows(tables) == []
        assert started == 0

    @pytest.mark.parametrize(('method', 'path', 'body'), JOB_ROUTES)
    def test_a_tombstoned_project_reads_as_missing_for_an_admin(self, call, tables, method, path, body):
        projects, _, _ = tables
        projects.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT,
                                'status': 'deleted'})

        assert call(ADMIN, method, path, body)[0] == 404
        assert _job_rows(tables) == []


@pytest.mark.usefixtures('existing_project')
class TestAJobRecordsWhoStartedIt:
    @pytest.mark.parametrize(('method', 'path', 'body'), JOB_ROUTES)
    def test_every_job_route_stamps_the_callers_subject(self, call, tables, method, path, body):
        status, response, started = call(EDITOR, method, path, body)

        assert status == 200, response
        assert started == 1
        [row] = _job_rows(tables)
        assert row['job_id'] == response['job_id']
        assert row['initiated_by'] == EDITOR['sub']

    def test_an_admin_is_recorded_too(self, call, tables):
        call(ADMIN, 'POST', f'/projects/{PROJECT}/product-report', {})

        assert [row['initiated_by'] for row in _job_rows(tables)] == [ADMIN['sub']]

    def test_both_job_reads_expose_it(self, call):
        _, started, _ = call(EDITOR, 'POST', f'/projects/{PROJECT}/product-report', {})
        job_id = started['job_id']

        _, one, _ = call(EDITOR, 'GET', f'/projects/{PROJECT}/jobs/{job_id}', None)
        _, listed, _ = call(EDITOR, 'GET', f'/projects/{PROJECT}/jobs', None)

        assert one['initiated_by'] == EDITOR['sub']
        assert [job['initiated_by'] for job in listed['jobs']] == [EDITOR['sub']]

    def test_a_job_written_before_the_field_existed_reads_as_null(self, call, tables):
        _, jobs_table, _ = tables
        jobs_table.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'JOB#job_old', 'job_id': 'job_old',
                                  'job_type': 'research', 'status': 'completed'})

        _, listed, _ = call(EDITOR, 'GET', f'/projects/{PROJECT}/jobs', None)

        assert listed['jobs'][0]['initiated_by'] is None


@pytest.mark.usefixtures('existing_project')
class TestTheJobsListIsNewestFirst:
    """QA s3 Low: the list was in sort-key order, i.e. by RANDOM job id, not by time."""

    def test_jobs_are_ordered_by_created_at_descending_whatever_their_ids(self, call, tables):
        _, jobs_table, _ = tables
        # Ids chosen so key order (descending) is the exact reverse of time order.
        for job_id, created_at in [('job_a', '2026-03-03T00:00:00+00:00'),
                                   ('job_b', '2026-03-02T00:00:00+00:00'),
                                   ('job_c', '2026-03-01T00:00:00+00:00'),
                                   ('job_d', None)]:
            item = {'pk': f'PROJECT#{PROJECT}', 'sk': f'JOB#{job_id}', 'job_id': job_id,
                    'job_type': 'research', 'status': 'completed'}
            if created_at:
                item['created_at'] = created_at
            jobs_table.put_item(Item=item)

        _, listed, _ = call(EDITOR, 'GET', f'/projects/{PROJECT}/jobs', None)

        assert [job['job_id'] for job in listed['jobs']] == ['job_a', 'job_b', 'job_c', 'job_d']

    def test_the_list_keeps_the_newest_fifty_not_the_first_fifty_keys(self, call, tables):
        _, jobs_table, _ = tables
        with jobs_table.batch_writer() as batch:
            for n in range(60):
                # Lower ids are NEWER, so a key-descending page of 50 would drop the newest.
                batch.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': f'JOB#job_{n:03d}',
                                     'job_id': f'job_{n:03d}', 'status': 'completed',
                                     'created_at': f'2026-01-01T00:{59 - n:02d}:00+00:00'})

        _, listed, _ = call(EDITOR, 'GET', f'/projects/{PROJECT}/jobs', None)

        ids = [job['job_id'] for job in listed['jobs']]
        assert len(ids) == 50
        assert ids[0] == 'job_000'
        assert ids[-1] == 'job_049'


@pytest.mark.usefixtures('existing_project')
class TestNoFeedbackIsA400BeforeAnyJob:
    """F1 (2026-10): persona generation (and research) with no matching feedback.

    The persona job used to find nothing, fail, and land in the async-failure
    DLQ. The route now answers 400 with the job's own message first: no job
    row, no Lambda invoke, no Step Functions execution.
    """

    @pytest.mark.parametrize(('path', 'body', 'message'), [
        (f'/projects/{PROJECT}/personas/generate', {'persona_count': 1, 'days': 30},
         'No feedback data found for the given filters'),
        (f'/projects/{PROJECT}/research', {'question': 'Why?', 'days': 30},
         'No feedback data found matching the filters. Try adjusting your filter criteria.'),
    ])
    def test_answers_400_with_the_jobs_message_and_starts_nothing(
        self, call, tables, feedback_read, path, body, message,
    ):
        feedback_read.return_value = []

        status, response, started = call(EDITOR, 'POST', path, body)

        assert (status, response) == (400, {'success': False, 'error': message})
        assert _job_rows(tables) == []
        assert started == 0
        # One bounded read, never the job's full fetch.
        assert feedback_read.call_args.kwargs['limit'] == 1

    def test_the_persona_precheck_reads_the_jobs_filters_and_scope(self, call, feedback_read):
        feedback_read.return_value = []

        call(EDITOR, 'POST', f'/projects/{PROJECT}/personas/generate',
             {'persona_count': 1, 'days': 7, 'sources': ['webscraper']})

        filters = feedback_read.call_args.args[0]
        assert (filters['days'], filters['sources']) == (7, ['webscraper'])
        # No CATEGORY_ACCESS row = full scope, captured exactly as the job stores it.
        assert filters['category_scope'] == {'all': True, 'categories': []}

    def test_a_missing_project_is_still_404_not_400(self, call, tables, feedback_read):
        feedback_read.return_value = []
        projects_table, _, _ = tables
        projects_table.delete_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'})

        status, _, started = call(ADMIN, 'POST', f'/projects/{PROJECT}/personas/generate', {'persona_count': 1})

        assert (status, started) == (404, 0)
        feedback_read.assert_not_called()
