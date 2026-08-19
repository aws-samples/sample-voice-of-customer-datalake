"""The row lifecycle against a REAL DynamoDB implementation, not the suite's fake.

`test_projects_prioritization_ballots.py` holds the behaviour, one assertion per
test, against an in-memory fake that evaluates condition expressions. That fake is
what makes those tests fast and precise, and it is also the one thing that cannot
tell whether the REQUEST SHAPE is legal: it accepts whatever `dict` the route hands
it, so a `transact_write_items` call built wrong — resource-shaped values where the
low-level client wants `{'S': ...}`, a key the `Update` struct does not accept —
would pass every one of those tests and fail on the first real invocation.

So these tests exist for the WIRE, not the behaviour, and there are deliberately few
of them: three shapes the fake cannot vouch for.

  * the ballot save's transaction, which carries native Python values, an
    `if_not_exists` and an `ADD` in one expression;
  * the row delete's transaction, whose fence value is a `Decimal` read at the
    RESOURCE layer and passed back through a CLIENT-layer call unconverted;
  * a stale fence, which is the one condition whose failure this module answers with
    a 409 rather than a 500.

moto rather than a live table: it implements the transaction semantics these routes
depend on (all-or-nothing, per-item `CancellationReasons`, `if_not_exists`, `ADD`)
and it rejects a malformed request the way DynamoDB does, which is the whole point.
Anything about WHICH conditions the routes should carry belongs in the fast suite,
where a failure names the behaviour rather than the protocol.
"""
import json
from decimal import Decimal
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws

PARTITION = 'PRIORITIZATION'
AXES = {'impact': 4, 'time_to_market': 3, 'confidence': 2, 'strategic_fit': 5}


def _table(name):
    return boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName=name,
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


def _seeded_project(projects):
    """One project holding a PRD and a PR/FAQ, which is enough to compose a row."""
    projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1',
                            'name': 'Project One'})
    projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PRD#d1', 'document_id': 'd1',
                            'created_at': '2026-01-01'})
    projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d2', 'document_id': 'd2',
                            'created_at': '2026-01-02'})
    return projects


def _call(aggregates, projects, lambda_context, method, path, body=None,
          subject='alice', groups='admins'):
    """One request through `lambda_handler`, with both tables real."""
    import projects_handler

    event = {
        'httpMethod': method,
        'path': path,
        'resource': path,
        'headers': {'Content-Type': 'application/json'},
        'requestContext': {
            'authorizer': {'claims': {'sub': subject, 'cognito:groups': groups}},
            'requestId': 'test-request', 'stage': 'test',
            'httpMethod': method, 'path': path,
            'identity': {'sourceIp': '1.2.3.4'},
        },
        'body': json.dumps(body) if body is not None else None,
        'queryStringParameters': None,
        'multiValueQueryStringParameters': None,
        'pathParameters': None,
        'stageVariables': None,
        'multiValueHeaders': {},
        'isBase64Encoded': False,
    }
    with (
        patch.object(projects_handler, 'get_aggregates_table', return_value=aggregates),
        patch.object(projects_handler, 'get_projects_table', return_value=projects),
    ):
        response = projects_handler.lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])


@pytest.fixture()
def lambda_context():
    return MagicMock()


class TestTheRowLifecycleAgainstARealTable:
    """Every write these routes make, executed by an implementation that would reject
    a malformed one."""

    @mock_aws
    def test_a_ballot_transaction_lands_and_stamps_its_rows_freeze(self, lambda_context):
        """The shape the fake cannot vouch for: one `transact_write_items` carrying
        native Python values, `SET ... if_not_exists(...)` and `ADD` in ONE expression,
        issued on `table.meta.client`. A request built for the low-level client with
        resource-shaped values would fail here with `ParamValidationError` before any
        condition was evaluated."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows/compose',
                           {'project_id': 'p1', 'document_ids': ['d1', 'd2']})
        row_id = created['row']['row_id']

        status, body = _call(aggregates, projects, lambda_context, 'PATCH',
                             '/projects/prioritization',
                             {'scores': {row_id: {**AXES, 'notes': 'ship it'}}})

        assert status == 200
        assert body['updated_count'] == 1
        row = aggregates.get_item(
            Key={'pk': PARTITION, 'sk': f'ROW#{row_id}'})['Item']
        assert row['first_ballot_at']
        assert row['ballot_writes'] == Decimal(1)
        ballot = aggregates.get_item(
            Key={'pk': PARTITION, 'sk': f'BALLOT#{row_id}#user:alice'})['Item']
        assert ballot['impact'] == Decimal(4)
        assert ballot['notes'] == 'ship it'

    @mock_aws
    def test_the_freeze_mark_records_the_first_ballot_and_no_later_one(
        self, lambda_context
    ):
        """`if_not_exists` executed by something that implements it, rather than by
        the fake's reading of the expression."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows/compose',
                           {'project_id': 'p1', 'document_ids': ['d1']})
        row_id = created['row']['row_id']

        _call(aggregates, projects, lambda_context, 'PATCH', '/projects/prioritization',
              {'scores': {row_id: AXES}}, subject='alice')
        first = aggregates.get_item(
            Key={'pk': PARTITION, 'sk': f'ROW#{row_id}'})['Item']['first_ballot_at']
        _call(aggregates, projects, lambda_context, 'PATCH', '/projects/prioritization',
              {'scores': {row_id: AXES}}, subject='bob')

        row = aggregates.get_item(Key={'pk': PARTITION, 'sk': f'ROW#{row_id}'})['Item']
        assert row['first_ballot_at'] == first
        assert row['ballot_writes'] == Decimal(2), 'ADD moved for each of them'

    @mock_aws
    def test_a_frozen_row_is_refused_by_the_database_not_by_the_handler(
        self, lambda_context
    ):
        """The recompose condition, evaluated by DynamoDB. The fake reads the
        expression; this asserts the expression means what the fake thinks."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows/compose',
                           {'project_id': 'p1', 'document_ids': ['d1']})
        row_id = created['row']['row_id']
        _call(aggregates, projects, lambda_context, 'PATCH', '/projects/prioritization',
              {'scores': {row_id: AXES}})

        status, body = _call(aggregates, projects, lambda_context, 'PATCH',
                             f'/projects/prioritization/rows/{row_id}',
                             {'project_id': 'p1', 'document_ids': ['d2']})

        assert status == 409
        assert 'frozen' in body['error']
        row = aggregates.get_item(Key={'pk': PARTITION, 'sk': f'ROW#{row_id}'})['Item']
        assert row['document_ids'] == ['d1'], 'the refusal wrote nothing'

    @mock_aws
    def test_a_row_and_its_ballots_go_in_one_real_transaction(self, lambda_context):
        """The delete's transaction, including the part only a real table exercises:
        the fence value is a `Decimal` read through the RESOURCE and passed back
        unconverted into a CLIENT-layer condition. Coercing it to `int`, or issuing
        this on a bare `boto3.client('dynamodb')`, breaks here and nowhere else."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows/compose',
                           {'project_id': 'p1', 'document_ids': ['d1']})
        row_id = created['row']['row_id']
        for subject in ('alice', 'bob'):
            _call(aggregates, projects, lambda_context, 'PATCH',
                  '/projects/prioritization', {'scores': {row_id: AXES}},
                  subject=subject)

        status, body = _call(aggregates, projects, lambda_context, 'DELETE',
                             f'/projects/prioritization/rows/{row_id}')

        assert status == 200
        assert body['ballots_deleted'] == 2
        assert aggregates.scan()['Items'] == [], (
            'the row and both ballots went together'
        )

    @mock_aws
    def test_a_stale_fence_cancels_the_delete_and_writes_nothing(self, lambda_context):
        """The fence, failed on purpose against a real evaluator. `ballot_writes` is
        advanced behind the route's back after it reads the row, which is exactly what
        a ballot landing in the gap does — and the transaction has to be cancelled
        WHOLE, leaving both the row and every ballot in place."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows/compose',
                           {'project_id': 'p1', 'document_ids': ['d1']})
        row_id = created['row']['row_id']
        _call(aggregates, projects, lambda_context, 'PATCH', '/projects/prioritization',
              {'scores': {row_id: AXES}})

        real_get_item = aggregates.get_item

        def advance_the_fence_after_reading(**kwargs):
            response = real_get_item(**kwargs)
            if str(kwargs['Key']['sk']).startswith('ROW#'):
                aggregates.update_item(
                    Key=kwargs['Key'],
                    UpdateExpression='ADD #bw :one',
                    ExpressionAttributeNames={'#bw': 'ballot_writes'},
                    ExpressionAttributeValues={':one': 1},
                )
            return response

        racing = MagicMock()
        racing.name = aggregates.name
        racing.meta = aggregates.meta
        racing.get_item.side_effect = advance_the_fence_after_reading
        racing.query.side_effect = aggregates.query

        status, body = _call(racing, projects, lambda_context, 'DELETE',
                             f'/projects/prioritization/rows/{row_id}')

        assert status == 409
        assert 'reload' in body['error']
        assert sorted(item['sk'] for item in aggregates.scan()['Items']) == [
            f'BALLOT#{row_id}#user:alice', f'ROW#{row_id}',
        ]

    @mock_aws
    def test_a_projects_only_default_row_is_refused_by_the_sibling_check(
        self, lambda_context
    ):
        """The `ConditionCheck` participant, which a real transaction validates the
        struct of — it takes no `UpdateExpression` and would be rejected outright if
        one were built for it."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows', {'project_id': 'p1'})
        default_row = created['row']['row_id']
        assert created['row']['is_default'] is True

        refused, _ = _call(aggregates, projects, lambda_context, 'DELETE',
                           f'/projects/prioritization/rows/{default_row}')
        assert refused == 409

        _call(aggregates, projects, lambda_context, 'POST',
              '/projects/prioritization/rows/compose',
              {'project_id': 'p1', 'document_ids': ['d2']})
        allowed, _ = _call(aggregates, projects, lambda_context, 'DELETE',
                           f'/projects/prioritization/rows/{default_row}')

        assert allowed == 200
        assert [item['sk'] for item in aggregates.scan()['Items']] != []

    @mock_aws
    def test_a_ballot_on_a_deleted_row_is_refused_rather_than_resurrecting_it(
        self, lambda_context
    ):
        """`attribute_exists(sk)` on the row half, evaluated for real. `update_item`
        is an upsert, so without it this transaction would CREATE a bare row record
        for a row somebody deleted."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows/compose',
                           {'project_id': 'p1', 'document_ids': ['d1']})
        row_id = created['row']['row_id']
        _call(aggregates, projects, lambda_context, 'DELETE',
              f'/projects/prioritization/rows/{row_id}')

        status, _ = _call(aggregates, projects, lambda_context, 'PATCH',
                          '/projects/prioritization', {'scores': {row_id: AXES}})

        assert status == 404
        assert aggregates.scan()['Items'] == [], 'nothing was resurrected'

    @mock_aws
    def test_the_page_read_answers_with_the_frozen_flag_the_write_set(
        self, lambda_context
    ):
        """End to end through both halves, so `is_frozen` is not merely computed but
        computed from what a real write actually stored."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, open_row = _call(aggregates, projects, lambda_context, 'POST',
                            '/projects/prioritization/rows/compose',
                            {'project_id': 'p1', 'document_ids': ['d1']})
        _, balloted = _call(aggregates, projects, lambda_context, 'POST',
                            '/projects/prioritization/rows/compose',
                            {'project_id': 'p1', 'document_ids': ['d2']})
        balloted_id = balloted['row']['row_id']
        _call(aggregates, projects, lambda_context, 'PATCH', '/projects/prioritization',
              {'scores': {balloted_id: AXES}})

        status, body = _call(aggregates, projects, lambda_context, 'GET',
                             '/projects/prioritization')

        assert status == 200
        assert body['rows'][balloted_id]['is_frozen'] is True
        assert body['rows'][open_row['row']['row_id']]['is_frozen'] is False
