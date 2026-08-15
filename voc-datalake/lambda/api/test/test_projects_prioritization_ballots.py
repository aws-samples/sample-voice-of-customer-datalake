"""
Tests for the per-reviewer prioritization ballots on /projects/prioritization.

The route used to keep ONE shared item (pk='PRIORITIZATION', sk='SCORES') holding
a single map of document_id -> score, written by every reviewer via
read-modify-write. Two reviewers saving at the same time silently lost each
other's edits and nothing recorded who scored. These tests pin the replacement:
one ballot per reviewer per document, written atomically on its own key, still
read in ONE query, and still answering the shape the deployed frontend consumes.

AWS is mocked at the import boundary (`projects_handler.get_aggregates_table`),
following the convention in the sibling handler tests. The fake table below is
not a general DynamoDB — it implements exactly the two expressions this route
writes, so that a change to those expressions has to be reflected here.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError


PARTITION = 'PRIORITIZATION'
LEGACY_SK = 'SCORES'


class FakeAggregatesTable:
    """An in-memory stand-in for the aggregates table.

    Supports the single-key `SET` update a ballot save issues, the conditional
    `REMOVE #scores.#document` the legacy migration issues, and a paginated query
    of one partition. Every call is recorded so a test can assert HOW the write
    was made, not just what it left behind — "one update_item on its own key"
    is the invariant, and a put_item of a merged map would leave the same state.
    """

    def __init__(self, items=None, page_size=None):
        self.items = {(i['pk'], i['sk']): dict(i) for i in (items or [])}
        self.page_size = page_size
        self.update_item_calls = []
        self.put_item_calls = []
        self.query_calls = []

    # -- writes ------------------------------------------------------------
    def put_item(self, **kwargs):
        self.put_item_calls.append(kwargs)
        item = kwargs['Item']
        self.items[(item['pk'], item['sk'])] = dict(item)
        return {}

    def update_item(self, **kwargs):
        self.update_item_calls.append(kwargs)
        key = (kwargs['Key']['pk'], kwargs['Key']['sk'])
        expression = kwargs['UpdateExpression'].strip()
        names = kwargs.get('ExpressionAttributeNames', {})
        values = kwargs.get('ExpressionAttributeValues', {})

        if expression.upper().startswith('REMOVE'):
            target = expression[len('REMOVE'):].strip()
            attr_alias, _, member_alias = target.partition('.')
            attr = names[attr_alias]
            member = names[member_alias]
            item = self.items.get(key)
            present = isinstance(item, dict) and member in (item.get(attr) or {})
            if kwargs.get('ConditionExpression') and not present:
                raise ClientError(
                    {'Error': {'Code': 'ConditionalCheckFailedException',
                               'Message': 'The conditional request failed'}},
                    'UpdateItem',
                )
            if present:
                del item[attr][member]
            return {}

        assert expression.upper().startswith('SET'), expression
        item = self.items.setdefault(key, {'pk': key[0], 'sk': key[1]})
        for assignment in expression[len('SET'):].split(','):
            name_alias, _, value_alias = (part.strip() for part in assignment.partition('='))
            item[names[name_alias]] = values[value_alias]
        return {}

    # -- reads -------------------------------------------------------------
    def query(self, **kwargs):
        self.query_calls.append(kwargs)
        rows = [dict(i) for (pk, _), i in sorted(self.items.items()) if pk == PARTITION]
        start = kwargs.get('ExclusiveStartKey')
        if start:
            skips = [r['sk'] for r in rows]
            rows = rows[skips.index(start['sk']) + 1:]
        if self.page_size and len(rows) > self.page_size:
            page = rows[:self.page_size]
            return {'Items': page, 'LastEvaluatedKey': {'pk': PARTITION, 'sk': page[-1]['sk']}}
        return {'Items': rows}

    # -- helpers -----------------------------------------------------------
    def ballot(self, document_id, subject):
        return self.items.get((PARTITION, f'BALLOT#{document_id}#user:{subject}'))

    @property
    def ballot_keys(self):
        return sorted(sk for (_, sk) in self.items if sk.startswith('BALLOT#'))


def _event(api_gateway_event, *, method, body=None, subject='reviewer-1'):
    event = api_gateway_event(
        method=method, path='/projects/prioritization', body=body,
    )
    claims = event['requestContext']['authorizer']['claims']
    if subject is None:
        claims.pop('sub', None)
    else:
        claims['sub'] = subject
    return event


def _call(table, event, lambda_context):
    from projects_handler import lambda_handler

    with patch('projects_handler.get_aggregates_table', return_value=table):
        response = lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])


def _patch_scores(table, api_gateway_event, lambda_context, scores, subject='reviewer-1'):
    return _call(
        table,
        _event(api_gateway_event, method='PATCH', body={'scores': scores}, subject=subject),
        lambda_context,
    )


def _get_scores(table, api_gateway_event, lambda_context, subject='reviewer-1'):
    return _call(
        table, _event(api_gateway_event, method='GET', subject=subject), lambda_context
    )


AXES = {'impact': 4, 'time_to_market': 3, 'confidence': 2, 'strategic_fit': 5}


class TestTwoReviewersBothPersist:
    """The defect this change exists to remove: a second reviewer's save replaced
    the first reviewer's numbers, because both wrote one shared map."""

    def test_each_reviewer_keeps_their_own_numbers(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {**AXES, 'impact': 5, 'notes': 'ship it'}}, subject='alice')
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {**AXES, 'impact': 1, 'notes': 'not yet'}}, subject='bob')

        assert table.ballot('doc-1', 'alice')['impact'] == 5
        assert table.ballot('doc-1', 'alice')['notes'] == 'ship it'
        assert table.ballot('doc-1', 'bob')['impact'] == 1
        assert table.ballot('doc-1', 'bob')['notes'] == 'not yet'

    def test_the_page_shows_the_caller_their_own_ballot(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {**AXES, 'impact': 5}}, subject='alice')
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {**AXES, 'impact': 1}}, subject='bob')

        _, alice_view = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        _, bob_view = _get_scores(table, api_gateway_event, lambda_context, subject='bob')

        assert alice_view['scores']['doc-1']['impact'] == 5
        assert bob_view['scores']['doc-1']['impact'] == 1
        # ...and both see that two people scored it.
        assert alice_view['aggregates']['doc-1']['reviewer_count'] == 2
        assert bob_view['aggregates']['doc-1']['reviewer_count'] == 2

    def test_a_reviewers_ballot_lands_on_its_own_key(self, api_gateway_event, lambda_context):
        """Identity is in the sort key, kind-namespaced, in one partition — so a
        later anonymous ballot ('anon:') cannot land on a signed-in reviewer's key
        and the page's read stays a single query."""
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject='alice')
        _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject='bob')

        assert table.ballot_keys == [
            'BALLOT#doc-1#user:alice', 'BALLOT#doc-1#user:bob',
        ]

    def test_the_read_is_a_single_query_on_one_partition(self, api_gateway_event, lambda_context):
        """One read for the whole page, not one per document: this page already
        fans out per project, so a per-document partition would multiply reads."""
        table = FakeAggregatesTable()
        for document_id in ('doc-1', 'doc-2', 'doc-3'):
            _patch_scores(table, api_gateway_event, lambda_context,
                          {document_id: AXES}, subject='alice')
        table.query_calls.clear()

        status, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert status == 200
        assert len(body['scores']) == 3
        assert len(table.query_calls) == 1

    def test_the_read_follows_pagination(self, api_gateway_event, lambda_context):
        """DynamoDB caps a query page at 1MB. Without following LastEvaluatedKey a
        large backlog would silently return only the ballots that sort first."""
        table = FakeAggregatesTable(page_size=1)
        for document_id in ('doc-1', 'doc-2', 'doc-3'):
            _patch_scores(table, api_gateway_event, lambda_context,
                          {document_id: AXES}, subject='alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert sorted(body['scores']) == ['doc-1', 'doc-2', 'doc-3']


class TestSaveIsAnAtomicUpdateOfOneKey:
    """The old save was get_item + merge + put_item of the whole map, which loses a
    concurrent writer's edits even when the final state looks plausible."""

    def test_a_save_is_one_update_item_on_the_ballot_key(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject='alice'
        )

        assert status == 200
        assert body == {'success': True, 'updated_count': 1}
        ballot_writes = [
            call for call in table.update_item_calls
            if call['Key']['sk'].startswith('BALLOT#')
        ]
        assert len(ballot_writes) == 1
        assert ballot_writes[0]['Key'] == {
            'pk': PARTITION, 'sk': 'BALLOT#doc-1#user:alice',
        }
        assert ballot_writes[0]['UpdateExpression'].strip().upper().startswith('SET')

    def test_a_save_never_put_items_a_merged_map(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable(items=[{
            'pk': PARTITION, 'sk': LEGACY_SK, 'scores': {'doc-9': {'impact': 2}},
        }])

        _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject='alice')

        assert table.put_item_calls == []

    def test_a_ballot_carries_the_axes_the_note_and_a_timestamp(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {**AXES, 'notes': 'because'}}, subject='alice')

        ballot = table.ballot('doc-1', 'alice')
        assert ballot['impact'] == 4
        assert ballot['time_to_market'] == 3
        assert ballot['confidence'] == 2
        assert ballot['strategic_fit'] == 5
        assert ballot['notes'] == 'because'
        assert ballot['reviewer'] == 'user:alice'
        assert ballot['updated_at']

    def test_a_ballot_never_carries_a_ttl(self, api_gateway_event, lambda_context):
        """The aggregates table expires anything carrying `ttl`, and a ballot is a
        durable decision record — an expiring one would delete a reviewer's vote."""
        table = FakeAggregatesTable()

        _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject='alice')

        assert 'ttl' not in table.ballot('doc-1', 'alice')
        for call in table.update_item_calls:
            assert 'ttl' not in call['UpdateExpression']

    def test_an_empty_body_writes_nothing(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        status, body = _patch_scores(table, api_gateway_event, lambda_context, {})

        assert status == 200
        assert body['success'] is True
        assert table.update_item_calls == []

    @pytest.mark.parametrize('bad_key', ['', '   ', 'doc#1', 'x' * 300])
    def test_an_unusable_document_id_is_refused_before_any_write(
        self, api_gateway_event, lambda_context, bad_key
    ):
        """'#' is the sort-key delimiter and a server-minted document id never
        contains one; an id carrying it would make the key ambiguous to parse.
        Refused BEFORE the first write, so a bad key in a multi-document save
        cannot leave the request half-persisted."""
        table = FakeAggregatesTable()

        status, _ = _patch_scores(
            table, api_gateway_event, lambda_context, {'doc-ok': AXES, bad_key: AXES}
        )

        assert status == 400
        assert table.update_item_calls == []


class TestReviewerIdentityFailsClosed:
    """A placeholder reviewer such as 'unknown' would merge every unattributable
    save into one bucket — the exact defect per-reviewer ballots remove — and it
    would do so silently."""

    @pytest.mark.parametrize('subject', [None, '', '   '])
    def test_a_missing_or_empty_subject_is_refused_on_save(
        self, api_gateway_event, lambda_context, subject
    ):
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject=subject
        )

        assert status == 403
        assert body['success'] is False
        assert table.update_item_calls == []
        assert table.ballot_keys == []

    @pytest.mark.parametrize('subject', [None, '', '   '])
    def test_a_missing_or_empty_subject_is_refused_on_read(
        self, api_gateway_event, lambda_context, subject
    ):
        table = FakeAggregatesTable()

        status, _ = _get_scores(table, api_gateway_event, lambda_context, subject=subject)

        assert status == 403

    def test_no_ballot_is_ever_written_under_a_placeholder_reviewer(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()

        _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject=None)

        assert not any('unknown' in sk or 'anonymous' in sk for (_, sk) in table.items)


class TestLegacyScoresReadThroughAndMigrateOnWrite:
    """The pre-ballot shared map is not migrated by a script: it is read through so
    nothing looks lost, and its entries are removed as reviewers save over them."""

    @staticmethod
    def _with_legacy(scores, page_size=None):
        return FakeAggregatesTable(
            items=[{'pk': PARTITION, 'sk': LEGACY_SK, 'scores': scores}],
            page_size=page_size,
        )

    def test_a_legacy_score_is_returned_when_the_caller_has_no_ballot(
        self, api_gateway_event, lambda_context
    ):
        table = self._with_legacy({'doc-1': {
            'document_id': 'doc-1', 'impact': 4, 'time_to_market': 2,
            'confidence': 3, 'strategic_fit': 1, 'notes': 'from before',
        }})

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores']['doc-1']['impact'] == 4
        assert body['scores']['doc-1']['notes'] == 'from before'

    def test_a_legacy_score_counts_as_one_unattributed_ballot(
        self, api_gateway_event, lambda_context
    ):
        table = self._with_legacy({'doc-1': {'impact': 4, 'time_to_market': 4,
                                             'confidence': 4, 'strategic_fit': 4}})

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['doc-1']['reviewer_count'] == 1

    def test_the_callers_own_ballot_wins_over_the_legacy_value(
        self, api_gateway_event, lambda_context
    ):
        table = self._with_legacy({'doc-1': {'impact': 1}, 'doc-2': {'impact': 2}})

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {**AXES, 'impact': 5}}, subject='alice')
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores']['doc-1']['impact'] == 5
        # The untouched document still reads through.
        assert body['scores']['doc-2']['impact'] == 2

    def test_the_first_save_removes_that_documents_legacy_entry(
        self, api_gateway_event, lambda_context
    ):
        table = self._with_legacy({'doc-1': {'impact': 1}, 'doc-2': {'impact': 2}})

        _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject='alice')

        legacy = table.items[(PARTITION, LEGACY_SK)]['scores']
        assert 'doc-1' not in legacy
        assert 'doc-2' in legacy, 'migration must be per document, not a wipe'

    def test_a_document_is_never_counted_twice(self, api_gateway_event, lambda_context):
        """A legacy value plus a real ballot for the same document would be two
        reviewers where there is one. The removal happens in the same save."""
        table = self._with_legacy({'doc-1': {'impact': 1, 'time_to_market': 1,
                                             'confidence': 1, 'strategic_fit': 1}})

        _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject='alice')
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['doc-1']['reviewer_count'] == 1
        assert body['aggregates']['doc-1']['impact'] == 4

    def test_a_second_reviewer_saving_the_same_document_still_succeeds(
        self, api_gateway_event, lambda_context
    ):
        """The legacy entry is already gone by then, so the conditional removal is a
        no-op rather than an error the reviewer sees."""
        table = self._with_legacy({'doc-1': {'impact': 1}})

        _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject='alice')
        status, body = _patch_scores(
            table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject='bob'
        )

        assert status == 200
        assert body['success'] is True
        assert table.ballot('doc-1', 'bob') is not None

    def test_a_save_with_no_legacy_item_at_all_succeeds(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        status, _ = _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': AXES})

        assert status == 200


class TestAggregateArithmetic:
    """The aggregate is a NEW field beside `scores`, for a later frontend change."""

    @staticmethod
    def _seeded(api_gateway_event, lambda_context, by_reviewer):
        table = FakeAggregatesTable()
        for subject, scores in by_reviewer.items():
            _patch_scores(table, api_gateway_event, lambda_context, scores, subject=subject)
        return table

    def test_a_single_reviewer_has_their_own_numbers_and_no_spread(
        self, api_gateway_event, lambda_context
    ):
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 4, 'time_to_market': 3,
                                'confidence': 2, 'strategic_fit': 5}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['doc-1']
        assert aggregate['reviewer_count'] == 1
        assert aggregate['impact'] == 4
        assert aggregate['time_to_market'] == 3
        assert aggregate['confidence'] == 2
        assert aggregate['strategic_fit'] == 5
        assert aggregate['score_spread'] == 0, 'one ballot cannot disagree with itself'

    def test_each_axis_is_the_mean_across_reviewers(self, api_gateway_event, lambda_context):
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 5, 'time_to_market': 4,
                                'confidence': 3, 'strategic_fit': 2}},
            'bob': {'doc-1': {'impact': 1, 'time_to_market': 2,
                              'confidence': 3, 'strategic_fit': 4}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['doc-1']
        assert aggregate['reviewer_count'] == 2
        assert aggregate['impact'] == 3
        assert aggregate['time_to_market'] == 3
        assert aggregate['confidence'] == 3
        assert aggregate['strategic_fit'] == 3

    def test_the_spread_is_the_composite_range(self, api_gateway_event, lambda_context):
        """Composite weights match the page's calculatePriorityScore
        (impact .4, time_to_market .3, strategic_fit .2, confidence .1), so the
        spread is in the unit the page already sorts by.

        alice: 5*.4 + 5*.3 + 5*.2 + 5*.1 = 5.0
        bob:   1*.4 + 1*.3 + 1*.2 + 1*.1 = 1.0
        """
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'doc-1': {'impact': 1, 'time_to_market': 1,
                              'confidence': 1, 'strategic_fit': 1}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['doc-1']['score_spread'] == pytest.approx(4.0)

    def test_a_document_nobody_scored_has_no_aggregate(self, api_gateway_event, lambda_context):
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': AXES},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert list(body['aggregates']) == ['doc-1']

    def test_a_reviewer_with_no_ballot_of_their_own_still_sees_the_aggregate(
        self, api_gateway_event, lambda_context
    ):
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 4, 'time_to_market': 4,
                                'confidence': 4, 'strategic_fit': 4}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='carol')

        assert body['scores'] == {}, "carol has scored nothing, so her sliders start empty"
        assert body['aggregates']['doc-1']['reviewer_count'] == 1


class TestResponseStaysBackwardCompatible:
    """The deployed frontend is NOT changing in this request, so the shape it
    consumes — {'scores': {document_id: {impact, time_to_market, confidence,
    strategic_fit, notes}}} — has to survive verbatim."""

    def test_the_get_response_matches_the_shape_the_frontend_consumes(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {**AXES, 'notes': 'keep'}}, subject='alice')

        status, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert status == 200
        assert 'scores' in body
        entry = body['scores']['doc-1']
        assert set(entry) == {
            'document_id', 'impact', 'time_to_market', 'confidence',
            'strategic_fit', 'notes',
        }
        assert entry['document_id'] == 'doc-1'
        assert isinstance(entry['notes'], str)
        for axis in ('impact', 'time_to_market', 'confidence', 'strategic_fit'):
            assert isinstance(entry[axis], (int, float))

    def test_an_empty_backlog_still_returns_an_empty_score_map(
        self, api_gateway_event, lambda_context
    ):
        status, body = _get_scores(FakeAggregatesTable(), api_gateway_event, lambda_context)

        assert status == 200
        assert body['scores'] == {}
        assert body['aggregates'] == {}

    def test_patch_still_accepts_the_existing_body(self, api_gateway_event, lambda_context):
        """Same request body the deployed client sends, including its
        `document_id` field inside each entry."""
        table = FakeAggregatesTable()

        status, body = _patch_scores(table, api_gateway_event, lambda_context, {
            'doc-1': {
                'document_id': 'doc-1', 'impact': 4, 'time_to_market': 3,
                'confidence': 2, 'strategic_fit': 5, 'notes': 'ok',
            },
        }, subject='alice')

        assert status == 200
        assert body['updated_count'] == 1
        assert table.ballot('doc-1', 'alice')['impact'] == 4


class TestWholeMapOverwriteRouteIsGone:
    """PUT /projects/prioritization replaced every reviewer's scores with the
    caller's map. It has no caller in the product, and under per-reviewer ballots
    there is no honest thing for it to mean.

    Asserted at the route table rather than by sending a PUT: with the literal
    route gone, `PUT /projects/<project_id>` now matches that path (as it does for
    any other unknown /projects/<x>), so a request-level assertion would be
    describing the generic project route, not this one. The unused frontend client
    function is deliberately left for the frontend pull request.
    """

    @staticmethod
    def _prioritization_routes():
        import projects_handler

        return {
            route.method
            for route in projects_handler.app._static_routes
            if 'prioritization' in str(route.rule)
        }

    def test_only_get_and_patch_are_registered(self):
        assert self._prioritization_routes() == {'GET', 'PATCH'}

    def test_the_handler_no_longer_exists(self):
        import projects_handler

        assert not hasattr(projects_handler, 'api_save_prioritization_scores')


class TestAFailedReadIsNotAnUnscoredBacklog:
    """The old GET swallowed every exception and returned an empty map, so a
    transient DynamoDB error was indistinguishable from "nobody has scored
    anything" — and a save from that state would persist zeros over real
    ballots."""

    def test_a_failed_query_is_a_server_error_not_an_empty_map(
        self, api_gateway_event, lambda_context
    ):
        table = MagicMock()
        table.query.side_effect = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'Query',
        )

        status, body = _call(
            table, _event(api_gateway_event, method='GET'), lambda_context
        )

        assert status == 500
        assert 'scores' not in body

    def test_an_unconfigured_table_is_a_server_error(self, api_gateway_event, lambda_context):
        status, body = _call(None, _event(api_gateway_event, method='GET'), lambda_context)

        assert status == 500
        assert 'scores' not in body
