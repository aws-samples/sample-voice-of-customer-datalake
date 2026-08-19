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


class _RacingTable:
    """The real table, with ONE read hooked to land a concurrent write in the gap.

    Delegating rather than a `MagicMock`, and the difference is the whole point of
    this file. A `MagicMock` answers ANY attribute — so a future refactor having the
    delete path read something else off the table would get a mock back, and these
    tests would keep passing while exercising a call that returned no data. That is
    precisely the property these tests exist NOT to have: the module docstring's
    argument is that the fast suite's fake "accepts whatever `dict` it is handed", and
    a `MagicMock` is a strictly looser fake than the one being escaped.

    So everything except the hooked method reaches the real moto table, and an
    unanticipated call behaves — or fails — exactly as it would in production.
    """

    def __init__(self, table, *, get_item=None, query=None):
        self._table = table
        self._get_item = get_item
        self._query = query

    def __getattr__(self, attribute):
        # Reached only for what is not defined on this class, so `name`, `meta` and
        # every other member — including ones no test anticipated — come from the real
        # table rather than from a mock.
        return getattr(self._table, attribute)

    def get_item(self, **kwargs):
        return (self._get_item or self._table.get_item)(**kwargs)

    def query(self, **kwargs):
        return (self._query or self._table.query)(**kwargs)


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


def _room_ballot(aggregates, lambda_context, row_id, axes=None, ballot_id=None):
    """One ANONYMOUS ballot, through `ballots_handler`'s own public route.

    Both handlers against ONE table, which is the only way to show that the two
    bundles' duplicated attribute names actually meet. `test_anon_row_mark_lockstep.py`
    pins the spellings as source text; this exercises the consequence.
    """
    import ballots_handler

    session_id = 'vs_' + '1a' * 16
    aggregates.put_item(Item={
        'pk': 'VOTING_SESSION', 'sk': f'SESSION#{session_id}',
        'session_id': session_id, 'row_id': row_id, 'row_title': 'Instant refunds',
        'status': 'open', 'ballot_cap': 40, 'ballot_count': 0,
        'created_by': 'facilitator', 'created_at': '2026-08-17T10:00:00+00:00',
        'expires_at': '2096-10-02T07:06:40+00:00', 'ttl': 4_000_000_000,
    })
    body = dict(axes or AXES)
    if ballot_id:
        body['ballot_id'] = ballot_id
    path = f'/voting-sessions/{session_id}/submit'
    event = {
        'httpMethod': 'POST', 'path': path, 'resource': path,
        'headers': {'Content-Type': 'application/json'},
        'requestContext': {'requestId': 'test-request', 'stage': 'test',
                           'httpMethod': 'POST', 'path': path,
                           'identity': {'sourceIp': '1.2.3.4'}},
        'body': json.dumps(body),
        'pathParameters': {'session_id': session_id},
        'queryStringParameters': None, 'multiValueQueryStringParameters': None,
        'stageVariables': None, 'multiValueHeaders': {}, 'isBase64Encoded': False,
    }
    with patch.object(ballots_handler, 'get_aggregates_table', return_value=aggregates):
        response = ballots_handler.lambda_handler(event, lambda_context)
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
    def test_replaying_an_identical_save_converges_on_one_ballot_and_one_instant(
        self, lambda_context
    ):
        """The save's docstring tells a client that sees a 500 to RE-SEND THE WHOLE
        BODY, so what a replay does is a contract rather than an implementation
        detail — and the row half's `ADD` is not idempotent, which makes the claim
        worth executing rather than asserting.

        Both halves of it, against a real evaluator: the BALLOT converges (one record,
        the same values) and ROW_FROZEN_AT_FIELD converges (`if_not_exists` cannot move
        an instant a first ballot recorded), which is the whole of what "safe to
        retry" has to mean. ROW_BALLOT_WRITES_FIELD is asserted to ADVANCE, because it
        counts committed writes rather than reviewers and a fence that stood still
        under a replay would let a delete that enumerated before it commit over it.
        """
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows/compose',
                           {'project_id': 'p1', 'document_ids': ['d1']})
        row_id = created['row']['row_id']
        body = {'scores': {row_id: {**AXES, 'notes': 'ship it'}}}

        _call(aggregates, projects, lambda_context, 'PATCH',
              '/projects/prioritization', body)
        first = aggregates.get_item(
            Key={'pk': PARTITION, 'sk': f'ROW#{row_id}'})['Item']['first_ballot_at']
        status, replayed = _call(aggregates, projects, lambda_context, 'PATCH',
                                 '/projects/prioritization', body)

        assert (status, replayed['updated_count']) == (200, 1)
        ballots = [item for item in aggregates.scan()['Items']
                   if str(item['sk']).startswith('BALLOT#')]
        assert len(ballots) == 1, 'the replay overwrote the one record, not added one'
        assert (ballots[0]['impact'], ballots[0]['notes']) == (Decimal(4), 'ship it')
        row = aggregates.get_item(Key={'pk': PARTITION, 'sk': f'ROW#{row_id}'})['Item']
        assert row['first_ballot_at'] == first, 'if_not_exists held the first instant'
        assert row['ballot_writes'] == Decimal(2), (
            'the fence counts committed writes, so a replay advances it — which is '
            'what cancels a delete that enumerated before the replay landed'
        )

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

        racing = _RacingTable(aggregates, get_item=advance_the_fence_after_reading)

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


class TestAnAnonymousBallotCarriesTheSameInvariantsAsASignedInOne:
    """BOTH HANDLERS, ONE TABLE — which is the only place the two bundles' duplicated
    attribute names actually meet.

    `test_anon_row_mark_lockstep.py` pins the spellings as source text, and
    `test_ballots_handler.py` shows the anonymous write stamps them. Neither can show
    the CONSEQUENCE: that the mark one bundle writes is the mark the other bundle's
    condition refuses on. That is what these tests are for, and they are here rather
    than in either handler's own file because they are about the pair.

    A room's ballots are the least attributable votes in the product — nobody's name
    is on them — so an invariant that held for signed-in reviewers and not for these
    would fail exactly where it is hardest to notice.
    """

    @mock_aws
    def test_a_room_ballot_freezes_the_row_against_a_recompose(self, lambda_context):
        """The invariant #339 advertises as database-enforced, across the bundle
        boundary. Before the anonymous write stamped the mark, a row carrying nothing
        but real room votes stayed recomposable — and recomposing it left every one of
        those ballots describing documents the room never saw."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows/compose',
                           {'project_id': 'p1', 'document_ids': ['d1']})
        row_id = created['row']['row_id']

        assert _room_ballot(aggregates, lambda_context, row_id)[0] == 200

        status, body = _call(aggregates, projects, lambda_context, 'PATCH',
                             f'/projects/prioritization/rows/{row_id}',
                             {'project_id': 'p1', 'document_ids': ['d2']})

        assert status == 409
        assert 'frozen' in body['error']
        row = aggregates.get_item(Key={'pk': PARTITION, 'sk': f'ROW#{row_id}'})['Item']
        assert row['document_ids'] == ['d1'], 'the refusal wrote nothing'

    @mock_aws
    def test_the_page_reports_a_row_frozen_by_a_room_as_frozen(self, lambda_context):
        """`is_frozen` is one question with one answer, whoever voted. A page that
        showed such a row as editable would offer a control the server refuses."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows/compose',
                           {'project_id': 'p1', 'document_ids': ['d1']})
        row_id = created['row']['row_id']
        _room_ballot(aggregates, lambda_context, row_id)

        _, body = _call(aggregates, projects, lambda_context, 'GET',
                        '/projects/prioritization')

        assert body['rows'][row_id]['is_frozen'] is True
        assert body['aggregates'][row_id]['reviewer_count'] == 1

    @mock_aws
    def test_a_room_ballot_racing_a_delete_cancels_it_rather_than_being_orphaned(
        self, lambda_context
    ):
        """The #342 fault the fence exists to close, in the path that used to bypass
        it. The ballot is cast from inside the delete's ballot enumeration — the only
        point where the two can cross — and it moves `ballot_writes`, so the delete's
        fence fails and the whole transaction is cancelled. Before the anonymous write
        moved that counter the delete committed and left the ballot behind."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows/compose',
                           {'project_id': 'p1', 'document_ids': ['d1']})
        row_id = created['row']['row_id']

        real_query = aggregates.query
        raced = {'done': False}

        def ballot_mid_enumeration(**kwargs):
            response = real_query(**kwargs)
            # From inside the BALLOT enumeration specifically — the only point where
            # a ballot and this delete can cross. Recognised by the projection the
            # enumeration takes, since the delete's other read (the sibling lookup)
            # projects `sk, project_id`.
            if not raced['done'] and kwargs.get('ProjectionExpression') == 'sk':
                raced['done'] = True
                assert _room_ballot(aggregates, lambda_context, row_id)[0] == 200
            return response

        racing = _RacingTable(aggregates, query=ballot_mid_enumeration)

        status, body = _call(racing, projects, lambda_context, 'DELETE',
                             f'/projects/prioritization/rows/{row_id}')

        assert raced['done'], 'the race never happened, so this asserts nothing'
        assert status == 409
        assert 'reload' in body['error']
        stored = sorted(item['sk'] for item in aggregates.scan()['Items']
                        if item['pk'] == PARTITION)
        assert stored[-1] == f'ROW#{row_id}', 'the row survived'
        assert any(sk.startswith(f'BALLOT#{row_id}#anon:') for sk in stored), (
            "and so did the room's ballot"
        )

    @mock_aws
    def test_a_delete_takes_a_rooms_ballots_with_the_row(self, lambda_context):
        """The other half of the same contract: once nothing is racing, a room's
        ballots go with their row exactly as a reviewer's do. The enumeration is by
        row prefix, so nothing about which kind wrote a ballot decides whether it
        goes."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows/compose',
                           {'project_id': 'p1', 'document_ids': ['d1']})
        row_id = created['row']['row_id']
        _room_ballot(aggregates, lambda_context, row_id)
        _call(aggregates, projects, lambda_context, 'PATCH', '/projects/prioritization',
              {'scores': {row_id: AXES}})

        status, body = _call(aggregates, projects, lambda_context, 'DELETE',
                             f'/projects/prioritization/rows/{row_id}')

        assert status == 200
        assert body['ballots_deleted'] == 2, 'the room ballot and the reviewer ballot'
        assert [item['sk'] for item in aggregates.scan()['Items']
                if item['pk'] == PARTITION] == []

    @mock_aws
    def test_a_room_ballot_on_a_deleted_row_is_refused_rather_than_resurrecting_it(
        self, lambda_context
    ):
        """A session is opened against a row that exists, but the room can vote an
        hour later. `attribute_exists(sk)` on the row half of the anonymous write is
        what makes a ballot on a row deleted in between fail — rather than recreating
        the row as a bare record, which `update_item`'s upsert would otherwise do."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows/compose',
                           {'project_id': 'p1', 'document_ids': ['d1']})
        row_id = created['row']['row_id']
        _call(aggregates, projects, lambda_context, 'DELETE',
              f'/projects/prioritization/rows/{row_id}')

        status, _ = _room_ballot(aggregates, lambda_context, row_id)

        assert status == 404
        assert [item['sk'] for item in aggregates.scan()['Items']
                if item['pk'] == PARTITION] == [], 'nothing was resurrected'

    @mock_aws
    def test_a_room_correction_leaves_the_freeze_instant_where_the_first_ballot_put_it(
        self, lambda_context
    ):
        """`if_not_exists` across the bundle boundary and across a correction: the
        composition froze when the first phone submitted, and a device amending its
        own vote is not a new decision about which documents the row holds."""
        aggregates, projects = _table('aggr'), _seeded_project(_table('projects'))
        _, created = _call(aggregates, projects, lambda_context, 'POST',
                           '/projects/prioritization/rows/compose',
                           {'project_id': 'p1', 'document_ids': ['d1']})
        row_id = created['row']['row_id']
        _, first = _room_ballot(aggregates, lambda_context, row_id)
        froze_at = aggregates.get_item(
            Key={'pk': PARTITION, 'sk': f'ROW#{row_id}'})['Item'][ 'first_ballot_at']

        status, corrected = _room_ballot(aggregates, lambda_context, row_id,
                                        axes={**AXES, 'impact': 1},
                                        ballot_id=first['ballot_id'])

        assert status == 200
        assert corrected['corrected'] is True
        row = aggregates.get_item(Key={'pk': PARTITION, 'sk': f'ROW#{row_id}'})['Item']
        assert row['first_ballot_at'] == froze_at
        assert row['ballot_writes'] == Decimal(2), (
            'the fence moves for a correction, so a delete that listed the ballots '
            'before it landed is cancelled rather than committing over it'
        )
