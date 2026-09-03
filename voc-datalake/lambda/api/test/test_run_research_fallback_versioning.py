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
            patch(
                'projects_handler.update_job_status',
                side_effect=overrides.get('status_effect'),
            ) as status,
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

    def test_a_failed_row_write_does_not_fail_a_committed_research(
        self, api_gateway_event, lambda_context,
    ):
        """The row is DERIVED state; the response is the authority.

        `update_job_status` runs after the document has durably committed and its
        result is what the route returns, so letting it raise turned a successful
        research into a 5xx: the client got an error for work that succeeded, and no
        document id with which to find it. `shared.jobs.update_job_status` swallows
        its own `update_item` failures, but it reaches `get_jobs_table()` first,
        outside that guard — which is the gap this closes.

        The same argument `projects._invalidate_project_cached_objects` makes for the
        cache, and the reason it is best-effort there too.
        """
        response, status, _ = self.call(
            api_gateway_event, lambda_context,
            status_effect=RuntimeError('jobs table unreachable'),
        )

        # It was attempted, so this is not passing because the write was skipped.
        status.assert_called_once()
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['document']['document_id'] == 'research_1'

    def test_a_result_with_no_document_is_not_reported_completed(
        self, api_gateway_event, lambda_context,
    ):
        """A `completed` row naming no document is worse than an un-finalized one.

        `step_save` RAISES for this condition rather than reporting a success whose
        `document_id` is `''`, and the two writers have to agree: the frontend's
        `firstPayloadMissesAnArtifact` reads an empty id as "names nothing" and skips
        the refresh, so a completed row with no document is a job the page will never
        reconcile — a provably wrong success envelope. Left `pending` instead, which
        is at least true. Unreachable in practice, since `run_research` either
        returns a committed document or raises.
        """
        _, status, _ = self.call(
            api_gateway_event, lambda_context,
            research=MagicMock(return_value={'success': True}),
        )

        status.assert_not_called()

    @pytest.mark.parametrize('result', [
        pytest.param({'success': True, 'document': 'not-a-dict'}, id='a truthy non-dict document'),
        pytest.param({'success': True, 'document': None}, id='a null document'),
        pytest.param({'success': True, 'document': {}}, id='an empty document'),
        pytest.param({'success': True, 'document': {'document_id': ''}}, id='an empty id'),
        pytest.param({'success': True, 'document': {'document_id': None}}, id='a null id'),
        pytest.param('not-a-dict', id='a non-dict result'),
    ])
    def test_no_result_shape_can_raise_out_of_the_terminal_write(
        self, api_gateway_event, lambda_context, result,
    ):
        """Every shape that a `(document or {}).get(...)` chain would have raised on.

        This runs after the document has committed, so an AttributeError here would
        turn a successful research into a 5xx just as surely as a failed write would
        — which is the failure the case above exists to prevent.
        """
        response, status, _ = self.call(
            api_gateway_event, lambda_context,
            research=MagicMock(return_value=result),
        )

        status.assert_not_called()
        assert response['statusCode'] == 200


def test_the_terminal_row_is_actually_stored(projects_table):
    """The row as a real reader finds it, not the call that wrote it.

    `TestTheFallbackFinishesItsJobRow` patches `update_job_status`, which pins the
    call SHAPE — the right tool for "did the route decide to finalize" and the wrong
    one for "did the row commit". This file's own standard is moto for that second
    question, since `update_job_status` builds an UpdateExpression the patch never
    executes: a `#status` name it forgot to declare would pass every case above and
    fail in production.
    """
    import boto3

    jobs = boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName='test-jobs',
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
    jobs.put_item(Item={
        'pk': 'PROJECT#proj-1', 'sk': 'JOB#job-1',
        'job_id': 'job-1', 'status': 'pending', 'progress': 0,
    })

    import projects_handler

    document = {'document_id': 'research_1', 'title': 'Churn drivers (v1)'}
    with (
        patch.dict('os.environ', {'RESEARCH_STATE_MACHINE_ARN': ''}),
        patch.object(projects_handler, 'create_job', return_value=('job-1', {})),
        patch.object(
            projects_handler, 'run_research',
            MagicMock(return_value={'success': True, 'document': document}),
        ),
        # Patched at the accessor `shared.jobs` calls, so the real
        # `update_job_status` runs its real UpdateExpression against a real table.
        patch('shared.jobs.get_jobs_table', return_value=jobs),
    ):
        projects_handler.api_run_research('proj-1')

    stored = jobs.get_item(
        Key={'pk': 'PROJECT#proj-1', 'sk': 'JOB#job-1'}, ConsistentRead=True,
    )['Item']
    assert stored['status'] == 'completed'
    assert stored['progress'] == 100
    assert stored['result'] == document


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
    # BOTH branches, which the strip above did not cover: a padded QUESTION composed
    # a different base title from its unpadded form, so the invariant held exactly
    # where the docstring claimed no strip was needed.
    assert research_base_title(
        None, '  What hurts most?  ',
    ) == research_base_title(None, 'What hurts most?')


def test_a_padded_question_does_not_spend_the_quote_budget_on_whitespace():
    """The strip has to happen BEFORE the slice, not after.

    `RESEARCH_TITLE_QUESTION_CHARS` is how much of the question a generated title may
    quote. Slicing first would spend part of that budget on leading whitespace, so
    two spellings of one question would quote different AMOUNTS of it and compose two
    series — the same defect, reached by the other order.
    """
    from shared.document_versions import (
        RESEARCH_TITLE_QUESTION_CHARS,
        research_base_title,
    )

    question = 'x' * RESEARCH_TITLE_QUESTION_CHARS

    assert research_base_title(None, f'   {question}') == research_base_title(None, question)
    # And the whole question is still quoted, not a shortened prefix of it.
    assert research_base_title(None, f'   {question}').endswith(question)


def test_a_padded_title_lands_in_the_same_series_as_its_unpadded_form(projects_table):
    """`'Churn drivers '` must not open a second series that renders identically.

    Both would display as `Churn drivers (v1)`, so the user sees two v1s of one
    title with no way to tell them apart.

    A LOCKSTEP test for a property the allocator owns, not a guard on the strip:
    `persist_versioned_document` runs the base title through
    `split_versioned_title`, which trims, so this passes with or without
    `research_base_title` stripping. What it pins is that the two layers keep
    agreeing — the guard on the strip itself is
    `test_the_two_research_writers_agree_on_the_untitled_series_key` above, which
    asserts the returned value.
    """
    run(projects_table, 'job_a', title='Churn drivers')
    run(projects_table, 'job_b', title='Churn drivers ')

    assert [row['title'] for row in research_rows(projects_table)] == [
        'Churn drivers (v1)', 'Churn drivers (v2)',
    ]
