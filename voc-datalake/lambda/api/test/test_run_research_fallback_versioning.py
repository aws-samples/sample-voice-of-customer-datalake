"""The synchronous research fallback allocates the same identity as the async path.

`api_run_research` prefers Step Functions and falls back to `projects.run_research`
only when `RESEARCH_STATE_MACHINE_ARN` is unset. Both are LIVE research writers, so
both must go through the shared allocator with the JOB ID as the allocation
identity — otherwise a deployment that lost the state machine would restart the
`(vN)` series and a retry would create a duplicate report.

Real table (moto) rather than a request-shape mock: the version, the title and the
project's `document_count` all come out of one conditional transaction.
"""
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


def test_the_two_research_writers_agree_on_the_untitled_series_key():
    """One shared helper, so an untitled request cannot land in two series
    depending on which writer served it."""
    from shared.document_versions import research_base_title

    assert research_base_title('', 'What hurts most?') == 'Research: What hurts most?'
    assert research_base_title(None, 'What hurts most?') == 'Research: What hurts most?'
    assert research_base_title('  ', 'What hurts most?') == 'Research: What hurts most?'
    assert research_base_title('Chosen', 'What hurts most?') == 'Chosen'
    assert research_base_title('', '') == 'Research: Research'
