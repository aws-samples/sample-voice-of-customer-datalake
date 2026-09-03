"""The synchronous research fallback allocates the same identity as the async path.

`api_run_research` prefers Step Functions and falls back to `projects.run_research`
only when `RESEARCH_STATE_MACHINE_ARN` is unset. Both are LIVE research writers, so
both must go through the shared allocator with the JOB ID as the allocation
identity — otherwise a deployment that lost the state machine would restart the
`(vN)` series and a retry would create a duplicate report.

Real table (moto) rather than a request-shape mock: the version, the title and the
project's `document_count` all come out of one conditional transaction.

`TestTheFallbackFinishesItsJobRow` covers the other half of the parity: the job row
the route creates must reach a terminal state on this path too, because the frontend
polls and refetches off it.
"""
import json
from unittest.mock import MagicMock, patch

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws


@pytest.fixture
def projects_table():
    with mock_aws():
        table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='test-projects',
            KeySchema=[
                {'AttributeName': 'pk', 'KeyType': 'HASH'},
                {'AttributeName': 'sk', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'pk', 'AttributeType': 'S'},
                {'AttributeName': 'sk', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST',
        )
        table.put_item(Item={
            'pk': 'PROJECT#proj-1',
            'sk': 'META',
            'project_id': 'proj-1',
            'document_count': 0,
        })
        yield table


def run(table, allocation_id: str, title: str = 'Churn drivers') -> dict:
    import projects

    with (
        patch.object(projects, 'projects_table', table),
        patch.object(projects, 'get_project', return_value={
            'project': {'project_id': 'proj-1', 'filters': {'days': 30}},
        }),
        patch.object(projects, 'get_feedback_context', return_value=[{'text': 'slow'}]),
        patch.object(projects, 'format_feedback_for_llm', return_value='- slow'),
        patch.object(projects, 'get_feedback_statistics', return_value='1 review'),
        patch.object(projects, 'get_research_analysis_steps', return_value=[]),
        patch.object(projects, 'converse_chain', return_value=['A', 'S', 'V']),
    ):
        return projects.run_research(
            'proj-1',
            {'question': 'Why do users churn?', 'title': title},
            allocation_id,
        )


def research_rows(table) -> list[dict]:
    items = table.query(
        KeyConditionExpression=Key('pk').eq('PROJECT#proj-1'),
        ConsistentRead=True,
    )['Items']
    return sorted(
        (item for item in items if str(item.get('sk', '')).startswith('RESEARCH#')),
        key=lambda item: int(item['version']),
    )


def document_count(table) -> int:
    return int(table.get_item(
        Key={'pk': 'PROJECT#proj-1', 'sk': 'META'}, ConsistentRead=True,
    )['Item']['document_count'])


def test_the_first_fallback_report_is_stored_as_v1(projects_table):
    result = run(projects_table, 'job_a')

    assert result['document']['version'] == 1
    assert result['document']['title'] == 'Churn drivers (v1)'
    assert result['document']['base_title'] == 'Churn drivers'
    assert result['document']['document_type'] == 'research'
    assert document_count(projects_table) == 1


def test_a_second_fallback_report_advances_to_v2(projects_table):
    run(projects_table, 'job_a')
    run(projects_table, 'job_b')

    assert [row['title'] for row in research_rows(projects_table)] == [
        'Churn drivers (v1)', 'Churn drivers (v2)',
    ]
    assert document_count(projects_table) == 2


def test_replaying_one_job_id_returns_the_committed_report(projects_table):
    first = run(projects_table, 'job_a')
    replay = run(projects_table, 'job_a')

    assert replay['document']['document_id'] == first['document']['document_id']
    assert len(research_rows(projects_table)) == 1
    assert document_count(projects_table) == 1


def test_a_replay_does_not_re_run_the_llm_chain(projects_table):
    """The replay check runs BEFORE any Bedrock call, so a client retry after a
    gateway timeout costs nothing."""
    import projects

    run(projects_table, 'job_a')
    chain = MagicMock(return_value=['A', 'S', 'V'])
    with (
        patch.object(projects, 'projects_table', projects_table),
        patch.object(projects, 'converse_chain', chain),
    ):
        projects.run_research('proj-1', {'question': 'Why?', 'title': 'X'}, 'job_a')

    chain.assert_not_called()


class TestTheFallbackFinishesItsJobRow:
    """Both research paths leave the job row TERMINAL, not just the async one.

    The Step Functions path finishes the row in `step_save`. The fallback used to
    return the committed document and leave the row at `pending` until its TTL, and
    the frontend reads that row: `jobsPollInterval` polls for as long as anything is
    `pending`, and `newlyTerminalJobIds` fires the project refetch on the
    TRANSITION — so a page open during a fallback research polled forever and never
    refreshed. Asserted through the ROUTE, because the route is where the job id and
    the terminal write meet.
    """

    @staticmethod
    def call(api_gateway_event, lambda_context, **overrides):
        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-1/research',
            path_params={'project_id': 'proj-1'},
            body={'question': 'Why do users churn?', 'title': 'Churn drivers'},
        )
        document = {'document_id': 'research_1', 'title': 'Churn drivers (v1)'}
        research = overrides.get(
            'research', MagicMock(return_value={'success': True, 'document': document}),
        )
        # No RESEARCH_STATE_MACHINE_ARN: the whole point is the fallback branch.
        with (
            patch.dict('os.environ', {'RESEARCH_STATE_MACHINE_ARN': ''}),
            patch('projects_handler.create_job', return_value=('job-1', {})),
            patch('projects_handler.run_research', research),
            patch('projects_handler.update_job_status') as status,
        ):
            response = lambda_handler(event, lambda_context)
        return response, status, research

    def test_the_row_reaches_completed_with_the_stored_document(
        self, api_gateway_event, lambda_context,
    ):
        response, status, _ = self.call(api_gateway_event, lambda_context)

        assert json.loads(response['body'])['success'] is True
        status.assert_called_once()
        arguments = status.call_args.args
        assert arguments[0] == 'proj-1'
        # The id `create_job` minted, which is also the allocation identity.
        assert arguments[1] == 'job-1'
        assert arguments[2] == 'completed'
        assert arguments[3] == 100
        # The STORED `(vN)` title, so the job panel and the Documents tab name the
        # same document — the same result shape `step_save` writes.
        assert status.call_args.kwargs['result'] == {
            'document_id': 'research_1', 'title': 'Churn drivers (v1)',
        }

    def test_a_failure_leaves_the_row_alone_because_the_response_carries_it(
        self, api_gateway_event, lambda_context,
    ):
        """No `failed` write here: a raise propagates with the REQUEST.

        The caller learns of the failure from its own response, which is why
        `step_error` exists only for the async path — that one has no response left
        to fail. Writing `failed` here would be a second, weaker signal.
        """
        from shared.exceptions import ServiceError

        _, status, _ = self.call(
            api_gateway_event, lambda_context,
            research=MagicMock(side_effect=ServiceError('Bedrock said no')),
        )

        status.assert_not_called()


def test_the_two_research_writers_agree_on_the_untitled_series_key():
    """One shared helper, so an untitled request cannot land in two series
    depending on which writer served it."""
    from shared.document_versions import research_base_title

    assert research_base_title('', 'What hurts most?') == 'Research: What hurts most?'
    assert research_base_title(None, 'What hurts most?') == 'Research: What hurts most?'
    assert research_base_title('  ', 'What hurts most?') == 'Research: What hurts most?'
    assert research_base_title('Chosen', 'What hurts most?') == 'Chosen'
    assert research_base_title('', '') == 'Research: Research'
    # Stripped, so the returned value is already the key it claims to be rather
    # than relying on `split_versioned_title` downstream to make it one.
    assert research_base_title('Chosen ', 'What hurts most?') == 'Chosen'
    assert research_base_title('  Chosen', 'What hurts most?') == 'Chosen'


def test_a_padded_title_lands_in_the_same_series_as_its_unpadded_form(projects_table):
    """`'Churn drivers '` must not open a second series that renders identically.

    Both would display as `Churn drivers (v1)`, so the user sees two v1s of one
    title with no way to tell them apart. Asserted end to end through the real
    allocator rather than on the helper alone, because that is where the series key
    is actually decided.
    """
    run(projects_table, 'job_a', title='Churn drivers')
    run(projects_table, 'job_b', title='Churn drivers ')

    assert [row['title'] for row in research_rows(projects_table)] == [
        'Churn drivers (v1)', 'Churn drivers (v2)',
    ]
