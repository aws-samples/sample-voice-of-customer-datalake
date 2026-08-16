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

    @pytest.mark.parametrize('bad_key,expected', [
        ('', 'non-empty'),
        ('   ', 'non-empty'),
        ('doc#1', "must not contain '#'"),
        ('x' * 300, 'at most 256 characters'),
    ])
    def test_an_unusable_document_id_is_refused_before_any_write(
        self, api_gateway_event, lambda_context, bad_key, expected
    ):
        """'#' is the sort-key delimiter and a server-minted document id never
        contains one; an id carrying it would make the key ambiguous to parse.
        Refused BEFORE the first write, so a bad key in a multi-document save
        cannot leave the request half-persisted.

        Each rule gets its OWN message: one shared message left a caller unable to
        tell a delimiter collision from an over-long id."""
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context, {'doc-ok': AXES, bad_key: AXES}
        )

        assert status == 400
        assert expected in body['error']
        assert table.update_item_calls == []

    @pytest.mark.parametrize('bad_entry', ['nonsense', None, [1, 2], 7, True])
    def test_a_non_object_score_entry_is_refused_before_any_write(
        self, api_gateway_event, lambda_context, bad_entry
    ):
        """Coercing a non-object into a ballot wrote a well-formed ALL-ZERO vote,
        indistinguishable from a deliberate one — inflating `reviewer_count` and
        dragging every axis mean down in the aggregate. The value's TYPE is the
        diagnostic that the caller meant something other than what would be
        inferred, so it is a 400, not a clamp."""
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'doc-ok': AXES, 'doc-bad': bad_entry},
        )

        assert status == 400
        assert 'must be objects' in body['error']
        assert table.update_item_calls == []
        assert table.ballot_keys == []

    def test_a_save_larger_than_the_bound_is_refused(self, api_gateway_event, lambda_context):
        """Each document costs TWO writes, so an unbounded body turns one
        invocation into hundreds of sequential round trips — and a timeout part way
        through half-persists the save. A 400 naming the bound beats that."""
        table = FakeAggregatesTable()
        oversized = {f'doc-{i}': AXES for i in range(101)}

        status, body = _patch_scores(table, api_gateway_event, lambda_context, oversized)

        assert status == 400
        assert 'at most 100 documents' in body['error']
        assert table.update_item_calls == []

    def test_a_save_at_the_bound_is_accepted(self, api_gateway_event, lambda_context):
        """The bound is a ceiling on absurdity, not a limit the product can hit —
        so exactly MAX_BALLOTS_PER_SAVE documents still saves."""
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context,
            {f'doc-{i}': AXES for i in range(100)},
        )

        assert status == 200
        assert body['updated_count'] == 100

    def test_a_failure_part_way_through_still_reports_a_server_error(
        self, api_gateway_event, lambda_context
    ):
        """A throttle on document 3 of 10 leaves 1-2 durable. Validation cannot
        cause that, only a write failure can, so the request is a 500 and the count
        of documents that DID persist is logged rather than silently lost."""
        table = FakeAggregatesTable()
        real_update = table.update_item
        calls = {'n': 0}

        def failing_update(**kwargs):
            calls['n'] += 1
            if calls['n'] > 2:
                raise ClientError(
                    {'Error': {'Code': 'ProvisionedThroughputExceededException'}},
                    'UpdateItem',
                )
            return real_update(**kwargs)

        table.update_item = failing_update

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'doc-1': AXES, 'doc-2': AXES}, subject='alice',
        )

        assert status == 500
        assert 'updated_count' not in body


class TestAPartialEntryLeavesTheOtherAxesAlone:
    """The verb is PATCH. Writing all four axes unconditionally, with an absent one
    defaulting to 0, meant a body carrying only `impact` silently rewrote the
    reviewer's other three axes to zero — this PR's own defect class, relocated
    from between reviewers to inside one reviewer's ballot."""

    def test_a_partial_entry_does_not_disturb_the_axes_it_omits(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': AXES},
                      subject='alice')

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {'impact': 5}}, subject='alice')

        ballot = table.ballot('doc-1', 'alice')
        assert ballot['impact'] == 5
        assert ballot['time_to_market'] == AXES['time_to_market']
        assert ballot['confidence'] == AXES['confidence']
        assert ballot['strategic_fit'] == AXES['strategic_fit']

    def test_a_partial_entry_does_not_blank_an_existing_note(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {**AXES, 'notes': 'keep me'}}, subject='alice')

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {'impact': 1}}, subject='alice')

        assert table.ballot('doc-1', 'alice')['notes'] == 'keep me'

    def test_an_omitted_axis_is_absent_from_the_update_expression(
        self, api_gateway_event, lambda_context
    ):
        """Asserted on the expression, not just the end state: an expression that
        assigned the axis to its existing value would leave the same state while
        still being a write that could clobber a concurrent one."""
        table = FakeAggregatesTable()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {'impact': 5}}, subject='alice')

        expression = table.update_item_calls[0]['UpdateExpression']
        assert 'impact' in expression
        for axis in ('time_to_market', 'confidence', 'strategic_fit', 'notes'):
            assert axis not in expression

    def test_a_first_ever_partial_save_still_creates_a_readable_ballot(
        self, api_gateway_event, lambda_context
    ):
        """No prior ballot to preserve, so a partial entry creates one carrying
        only what was sent — and the read fills the rest in for the page."""
        table = FakeAggregatesTable()

        status, _ = _patch_scores(table, api_gateway_event, lambda_context,
                                  {'doc-1': {'impact': 4}}, subject='alice')

        assert status == 200
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        entry = body['scores']['doc-1']
        assert entry['impact'] == 4
        assert entry['time_to_market'] == 0
        assert entry['notes'] == ''

    def test_a_notes_only_first_save_reads_back_a_zero_time_to_market(
        self, api_gateway_event, lambda_context
    ):
        """Pins the documented consequence of writing only what was sent, rather
        than leaving it described in a docstring.

        With no prior ballot there is nothing to fall back on, so an axis the
        caller never sent is simply absent — and `_axis_value` reads absent as 0.0.
        For `time_to_market` that diverges from the page, whose own DEFAULT_SCORE
        is 3 and whose `PRFAQRow` reads `time_to_market !== 3` as "touched": a
        reviewer who only left a note therefore appears to have deliberately rated
        it lowest. Deliberately not corrected on the read, because seeding the
        frontend's default would put a number nobody entered into a field named for
        what a reviewer scored; the aggregate makes the distinction instead, by
        asking whether the axis is carried at all."""
        table = FakeAggregatesTable()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {'notes': 'no numbers yet'}}, subject='alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        entry = body['scores']['doc-1']
        assert entry['time_to_market'] == 0
        assert entry['notes'] == 'no numbers yet'
        # ...and the aggregate does NOT read that 0 as a vote.
        assert body['aggregates'] == {}

    def test_an_entry_with_no_recognised_field_still_stamps_the_ballot(
        self, api_gateway_event, lambda_context
    ):
        """An empty object is a valid, if pointless, PATCH: it changes no axis. It
        must not be read as "set every axis to zero"."""
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': AXES},
                      subject='alice')

        status, _ = _patch_scores(table, api_gateway_event, lambda_context,
                                  {'doc-1': {}}, subject='alice')

        assert status == 200
        ballot = table.ballot('doc-1', 'alice')
        assert ballot['impact'] == AXES['impact']
        assert ballot['reviewer'] == 'user:alice'


class TestBoundedAxisAndNoteValues:
    """The two decisions the change made where the task left room: an out-of-range
    NUMBER is CLAMPED rather than refused (the value is bounded either way, and a
    clamp keeps one odd axis from failing a whole multi-document save), and a note
    is truncated because it is stored verbatim and re-read on every page load.
    Both are silent behaviours, so a test is the only thing that keeps a later
    refactor from changing them unnoticed.

    CLAMP A NUMBER, REFUSE A NON-NUMBER. The clamp argument is that the value is
    bounded either way, which is true of `99`, `-4`, `'3'` and `2.7` and false of
    `'high'` — there is no value to bound, so the 0 a fallback produces is invented.
    The refusals are in `TestANonNumberIsRefusedRatherThanFlooredAtZero` below."""

    @staticmethod
    def _saved(api_gateway_event, lambda_context, entry):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': entry},
                      subject='alice')
        return table.ballot('doc-1', 'alice')

    def test_an_axis_above_the_ceiling_is_clamped_not_refused(
        self, api_gateway_event, lambda_context
    ):
        assert self._saved(api_gateway_event, lambda_context, {'impact': 99})['impact'] == 5

    def test_an_axis_below_the_floor_is_clamped_not_refused(
        self, api_gateway_event, lambda_context
    ):
        ballot = self._saved(api_gateway_event, lambda_context, {'time_to_market': -4})
        assert ballot['time_to_market'] == 0

    def test_a_fractional_axis_is_truncated_to_an_integer(
        self, api_gateway_event, lambda_context
    ):
        """Sliders are integers; 2.7 becomes 2 rather than being stored as a
        Decimal the page would render between two notches."""
        assert self._saved(api_gateway_event, lambda_context,
                           {'confidence': 2.7})['confidence'] == 2

    def test_a_numeric_string_axis_is_accepted(self, api_gateway_event, lambda_context):
        """A form post or an over-eager serialiser sends '3'; the number it plainly
        means is stored."""
        assert self._saved(api_gateway_event, lambda_context,
                           {'strategic_fit': '3'})['strategic_fit'] == 3

    def test_an_over_long_note_is_truncated_to_the_bound(
        self, api_gateway_event, lambda_context
    ):
        ballot = self._saved(api_gateway_event, lambda_context, {'notes': 'x' * 2500})

        assert len(ballot['notes']) == 2000


class TestANonNumberIsRefusedRatherThanFlooredAtZero:
    """An axis value no number can be read out of used to be STORED AS A REAL 0.

    `validate_int` returns its `default` — here the floor — for anything it cannot
    read, so `{'impact': 'high'}` did not fall through and was not refused: it
    became a deliberate lowest score. `_carries_axis` then reported it as a vote, so
    four such axes reproduced exactly the aggregate this file's other classes exist
    to prevent — a team mean of 2.5 and the maximum 5.0 spread beside a reviewer who
    scored 5 across the board — while also destroying whatever the sender had
    stored. Numbers still clamp (see the class above); a non-number is a 400.

    Three encodings, each of which defeats a numeric check written the obvious way:
    a bool (`isinstance(True, int)` is true and `int(True)` is 1), a non-finite
    float (`int(float('inf'))` raises `OverflowError`, which `validate_int` did not
    catch, so it escaped the validation pass entirely and half-persisted a save),
    and a `NaN` (`ValueError`, swallowed into the invented 0)."""

    @staticmethod
    def _refused(api_gateway_event, lambda_context, entry, *, existing=None):
        table = FakeAggregatesTable()
        if existing:
            _patch_scores(table, api_gateway_event, lambda_context,
                          {'doc-1': existing}, subject='alice')
        writes_before = len(table.update_item_calls)
        status, body = _patch_scores(table, api_gateway_event, lambda_context,
                                     {'doc-1': entry}, subject='alice')
        return status, body, table, len(table.update_item_calls) - writes_before

    @pytest.mark.parametrize('value', ['high', [1, 2], {'a': 1}, True, False,
                                       float('inf'), float('-inf'), float('nan')])
    def test_an_axis_that_is_not_a_number_is_refused(
        self, api_gateway_event, lambda_context, value
    ):
        status, body, _, writes = self._refused(
            api_gateway_event, lambda_context, {'impact': value})

        assert status == 400
        assert 'impact' in body['error']
        assert writes == 0

    @pytest.mark.parametrize('value', ['high', True, False, float('inf'), float('nan')])
    def test_a_refused_axis_leaves_the_stored_score_alone(
        self, api_gateway_event, lambda_context, value
    ):
        """The destructive half, which a first-save assertion cannot see: the
        refusal has to preserve what the reviewer already scored, not merely avoid
        storing the invented value."""
        status, _, table, writes = self._refused(
            api_gateway_event, lambda_context, {'impact': value},
            existing={'impact': 4})

        assert status == 400
        assert writes == 0
        assert table.ballot('doc-1', 'alice')['impact'] == 4

    def test_a_non_number_cannot_manufacture_a_disagreement(
        self, api_gateway_event, lambda_context
    ):
        """The aggregate consequence, stated in the unit the reviewer sees.

        Four unparseable axes stored as zeros are FULLY scored, so they set the
        spread as well as the means: alice scoring 5 across the board beside them
        reported a mean of 2.5 and a spread of 5.0, the maximum possible
        disagreement, out of a reviewer who expressed no numbers."""
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': dict.fromkeys(AXES, 5)}, subject='alice')

        status, _ = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'doc-1': {'impact': 'high', 'time_to_market': 'fast',
                       'confidence': 'n/a', 'strategic_fit': 'yes'}},
            subject='bob')

        assert status == 400
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        assert body['aggregates']['doc-1'] == {
            'impact': 5.0, 'time_to_market': 5.0, 'confidence': 5.0,
            'strategic_fit': 5.0, 'reviewer_count': 1, 'score_spread': 0.0,
        }

    def test_a_false_axis_is_refused_rather_than_stored_as_a_zero(
        self, api_gateway_event, lambda_context
    ):
        """`false` is the bool that reaches the aggregate: it lands on the same
        invented 0 as `'high'` and is fully-scored-eligible, without ever being an
        unparseable value. `true` is no better — `impact: 1` is a slider position
        nobody chose."""
        table = FakeAggregatesTable()

        status, _ = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'doc-1': dict.fromkeys(AXES, False)}, subject='alice')

        assert status == 400
        assert table.ballot('doc-1', 'alice') is None

    def test_a_non_finite_axis_cannot_half_persist_a_multi_document_save(
        self, api_gateway_event, lambda_context
    ):
        """The one encoding that was a PARTIAL WRITE rather than a wrong value.

        `int(float('inf'))` raises `OverflowError`, which `validate_int` did not
        catch, so it was not floored and not refused: it propagated out of the write
        loop mid-save, after earlier documents had been durably written, and
        surfaced as a bare 500. That contradicted the promise the up-front pass
        exists to make, so the assertion is on the WRITES, not just the status."""
        table = FakeAggregatesTable()
        scores = {f'doc-{i}': dict.fromkeys(AXES, 3) for i in range(1, 6)}
        scores['doc-3'] = {'impact': float('inf')}

        status, body = _patch_scores(table, api_gateway_event, lambda_context,
                                     scores, subject='alice')

        assert status == 400
        assert 'impact' in body['error']
        assert table.ballot_keys == []
        assert table.update_item_calls == []

    @pytest.mark.parametrize('value', [99, -4, 2.7, '3', 0, 5])
    def test_a_number_still_clamps_rather_than_being_refused(
        self, api_gateway_event, lambda_context, value
    ):
        """The other half of the rule: everything `int()` can plainly read is still
        bounded rather than rejected, so one odd slider cannot fail a whole
        multi-document save."""
        table = FakeAggregatesTable()

        status, _ = _patch_scores(table, api_gateway_event, lambda_context,
                                  {'doc-1': {'impact': value}}, subject='alice')

        assert status == 200
        assert 0 <= table.ballot('doc-1', 'alice')['impact'] <= 5

    def test_the_refusal_never_echoes_the_rejected_value(
        self, api_gateway_event, lambda_context
    ):
        """Caller input is unbounded and a response body gains nothing by repeating
        it — the reasoning `_validated_ballot_document_id` records for keys."""
        _, body, _, _ = self._refused(
            api_gateway_event, lambda_context,
            {'impact': 'sensitive-looking-garbage'})

        assert 'sensitive-looking-garbage' not in json.dumps(body)


class TestANonStringNoteCannotDestroyTheStoredNote:
    """A `notes` of the wrong type was COERCED TO `''`, so a request that expressed
    no note at all erased the note that was there — and answered 200.

    Round 3 established the rule for `null` (absent, leave it alone) and this is the
    same rule for the other encoding of "not a note". A stored note is a durable
    decision record, so overwriting it while reporting success is the worst of the
    available behaviours; refusing it up front also keeps it from half-persisting a
    multi-document save.

    Deliberately asserted across TWO saves against ONE table. The test this replaces
    asserted `stored == ''` after a FIRST save, where there was nothing to lose — so
    it was satisfied by both "coerced to empty" and "erased what was there", and
    passed identically whichever the code did."""

    @pytest.mark.parametrize('value', [42, [1, 2], {'a': 1}, True])
    def test_a_non_string_note_is_refused_and_the_stored_note_survives(
        self, api_gateway_event, lambda_context, value
    ):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {'notes': 'ship this in Q3'}}, subject='alice')
        writes_before = len(table.update_item_calls)

        status, body = _patch_scores(table, api_gateway_event, lambda_context,
                                     {'doc-1': {'notes': value}}, subject='alice')

        assert status == 400
        assert 'notes' in body['error']
        assert table.ballot('doc-1', 'alice')['notes'] == 'ship this in Q3'
        assert len(table.update_item_calls) == writes_before

    def test_the_caller_still_reads_back_the_note_they_saved(
        self, api_gateway_event, lambda_context
    ):
        """Through the route rather than the table, since the page is what a lost
        note would be lost from."""
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {'notes': 'ship this in Q3'}}, subject='alice')

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {'notes': 42}}, subject='alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        assert body['scores']['doc-1']['notes'] == 'ship this in Q3'

    def test_a_string_note_is_still_written(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        status, _ = _patch_scores(table, api_gateway_event, lambda_context,
                                  {'doc-1': {'notes': 'still fine'}}, subject='alice')

        assert status == 200
        assert table.ballot('doc-1', 'alice')['notes'] == 'still fine'


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


class TestAReviewerSubjectCannotCorruptTheBallotKey:
    """'#' is the sort-key delimiter, and the subject is interpolated into the key.

    A subject carrying one made `_parse_ballot_sk`'s `rpartition('#')` mis-split
    the key, failing three ways at once and all of them silently: the save answered
    200, the reviewer's own ballot was unreadable so the page showed it as unscored,
    and `aggregates` grew a row under a document id that never existed. The write
    landed on a key no read could address, so it was unreclaimable without a scan.

    A Cognito `sub` is a v4 UUID, so this is not reachable through the authorizer
    today. Pinned because the module comment presents the no-'#' rule as
    load-bearing, document ids are already held to it, and the 'anon:' kind the key
    is namespaced for would supply identifiers nobody vetted.
    """

    @pytest.mark.parametrize('subject', [
        'has#hash', '#leading', 'trailing#', 'a#b#c', 'user:spoofed#x',
    ])
    def test_a_subject_containing_the_delimiter_is_refused_on_save(
        self, api_gateway_event, lambda_context, subject
    ):
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject=subject
        )

        assert status == 403
        assert body['success'] is False
        assert "'#'" in body['error']
        assert table.update_item_calls == [], 'nothing may be written under a bad key'
        assert table.ballot_keys == []

    @pytest.mark.parametrize('subject', ['has#hash', '#leading', 'trailing#'])
    def test_a_subject_containing_the_delimiter_is_refused_on_read(
        self, api_gateway_event, lambda_context, subject
    ):
        """Refused on the read too: `scores` is a specific caller's ballots, and a
        key that cannot be built is a key that cannot be matched — answering an
        empty map would show the reviewer their own votes as unscored."""
        table = FakeAggregatesTable()

        status, body = _get_scores(
            table, api_gateway_event, lambda_context, subject=subject
        )

        assert status == 403
        assert body['success'] is False

    def test_the_refusal_never_echoes_the_subject(
        self, api_gateway_event, lambda_context
    ):
        """The subject identifies a person and must not be logged or returned
        (`get_caller_subject`'s contract). The message names the RULE."""
        table = FakeAggregatesTable()

        _, body = _patch_scores(
            table, api_gateway_event, lambda_context, {'doc-1': AXES},
            subject='sensitive#identity',
        )

        assert 'sensitive' not in json.dumps(body)

    def test_no_phantom_document_row_can_be_created(
        self, api_gateway_event, lambda_context
    ):
        """The consequence worth blocking on: a mis-split key put a row in
        `aggregates` under a document id that does not exist, which
        `PrioritizationAggregate` tells consumers means 'somebody scored this'."""
        table = FakeAggregatesTable()

        _patch_scores(
            table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject='has#hash'
        )

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        assert body['aggregates'] == {}

    def test_an_ordinary_subject_is_still_accepted(
        self, api_gateway_event, lambda_context
    ):
        """The guard must not refuse the identifiers Cognito actually mints."""
        table = FakeAggregatesTable()

        status, _ = _patch_scores(
            table, api_gateway_event, lambda_context, {'doc-1': AXES},
            subject='b3f1c2de-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
        )

        assert status == 200
        assert table.ballot_keys == [
            'BALLOT#doc-1#user:b3f1c2de-4a5b-6c7d-8e9f-0a1b2c3d4e5f'
        ]


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


class TestTheReadThroughAndTheAggregateAgree:
    """A legacy value the write path would REFUSE is not read back as if a reviewer
    had entered it.

    `_aggregate_scores` already ignored these — `_carries_axis` asks whether an axis
    is a readable number — so the two halves of the same response disagreed about
    the same stored value: `aggregates` omitted the document (which
    `PrioritizationAggregate` tells consumers means nobody scored it) while `scores`
    showed the caller a deliberate lowest score on all four axes. An invented number
    in a field named for what a reviewer entered.

    The legacy map has no type discipline — it was written by the pre-ballot handler
    and predates this route's validation — and nothing migrates an entry away until
    the first save against that document, so the disagreement was not merely
    theoretical. Both halves now ask the same predicate, so a shape neither
    anticipated is closed at both ends at once."""

    @staticmethod
    def _with_legacy(scores):
        return FakeAggregatesTable(
            items=[{'pk': PARTITION, 'sk': LEGACY_SK, 'scores': scores}]
        )

    @pytest.mark.parametrize('entry', [
        'garbage',
        42,
        [1, 2],
        {'impact': 'high'},
        {'impact': 'high', 'time_to_market': 'fast',
         'confidence': 'n/a', 'strategic_fit': 'yes'},
        {'impact': True},
        {},
    ])
    def test_an_unreadable_legacy_entry_appears_in_neither_half(
        self, api_gateway_event, lambda_context, entry
    ):
        table = self._with_legacy({'doc-1': entry})

        status, body = _get_scores(table, api_gateway_event, lambda_context,
                                   subject='alice')

        assert status == 200
        assert body['scores'] == {}, 'a refused value must not read back as a score'
        assert body['aggregates'] == {}

    def test_a_readable_legacy_score_still_reads_through(
        self, api_gateway_event, lambda_context
    ):
        """The filter must not cost the pre-ballot values this route exists to
        preserve, including a partial one, whose axes are absent rather than
        unreadable."""
        table = self._with_legacy({
            'doc-1': {'impact': 4, 'time_to_market': 2,
                      'confidence': 3, 'strategic_fit': 1},
            'doc-2': {'impact': 2},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores']['doc-1']['impact'] == 4
        assert body['scores']['doc-2']['impact'] == 2
        assert set(body['aggregates']) == {'doc-1', 'doc-2'}

    def test_a_legacy_entry_carrying_only_a_note_still_reads_through(
        self, api_gateway_event, lambda_context
    ):
        """The read-through's question is WIDER than the aggregate's. A note is
        something a reviewer wrote, so dropping it would lose it from the page — but
        it is not a score, so it must still not count as a reviewer. This is the one
        case where the two halves legitimately differ, and the reason the filter is
        `_expresses_something` rather than `_is_a_vote`."""
        table = self._with_legacy({'doc-1': {'notes': 'from before the sliders'}})

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores']['doc-1']['notes'] == 'from before the sliders'
        assert body['scores']['doc-1']['impact'] == 0.0
        assert body['aggregates'] == {}

    def test_an_unreadable_legacy_entry_still_migrates_on_write(
        self, api_gateway_event, lambda_context
    ):
        """Not reading it through must not strand it: the first save against the
        document still removes it, so it cannot resurface later."""
        table = self._with_legacy({'doc-1': 'garbage'})

        status, _ = _patch_scores(table, api_gateway_event, lambda_context,
                                  {'doc-1': AXES}, subject='alice')

        assert status == 200
        assert 'doc-1' not in table.items[(PARTITION, LEGACY_SK)]['scores']

    def test_the_callers_own_ballot_is_unaffected_by_a_sibling_unreadable_entry(
        self, api_gateway_event, lambda_context
    ):
        table = self._with_legacy({'doc-1': 'garbage', 'doc-2': {'impact': 3}})

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-3': AXES}, subject='alice')
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert set(body['scores']) == {'doc-2', 'doc-3'}


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


class TestAnAxisLessBallotIsNotAVote:
    """A ballot that scored nothing must not vote zero.

    Accepting `{}` (or a notes-only entry) as a legal PATCH is right on the WRITE
    side — it changes no axis. The hole was on the READ side: once stored, the
    ballot item exists, so it was counted as one reviewer and every axis it did
    not carry was read as 0.0. That is the same "an all-zero ballot inflates
    reviewer_count and drags every mean down" defect `_validated_ballot_entry`
    refuses a non-dict to prevent, re-entering through a different door — and
    reachable from the shipped page, whose notes textarea saves through the same
    path as the sliders.
    """

    @staticmethod
    def _seeded(api_gateway_event, lambda_context, by_reviewer):
        table = FakeAggregatesTable()
        for subject, scores in by_reviewer.items():
            _patch_scores(table, api_gateway_event, lambda_context, scores, subject=subject)
        return table

    def test_a_notes_only_ballot_does_not_count_as_a_reviewer(
        self, api_gateway_event, lambda_context
    ):
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'doc-1': {'notes': 'agree'}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['doc-1']['reviewer_count'] == 1

    def test_a_notes_only_ballot_leaves_the_real_reviewers_means_intact(
        self, api_gateway_event, lambda_context
    ):
        """Was 2.5 on every axis: one reviewer scoring 5 across the board, averaged
        against a reviewer who moved no slider at all."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'doc-1': {'notes': 'agree'}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['doc-1']
        for axis in ('impact', 'time_to_market', 'confidence', 'strategic_fit'):
            assert aggregate[axis] == 5, axis

    def test_a_notes_only_ballot_manufactures_no_disagreement(
        self, api_gateway_event, lambda_context
    ):
        """`score_spread` is the field most damaged by this, because an axis-less
        ballot always sits at composite 0 — so it reported the maximum possible
        disagreement (5.0) out of a reviewer who expressed no numbers."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'doc-1': {'notes': 'agree'}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['doc-1']['score_spread'] == 0

    def test_several_notes_only_ballots_still_leave_one_reviewer(
        self, api_gateway_event, lambda_context
    ):
        """Each extra note-only reviewer used to pull the mean further down: two
        took it to 1.67."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'doc-1': {'notes': 'agree'}},
            'carol': {'doc-1': {'notes': 'same'}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['doc-1']['reviewer_count'] == 1
        assert body['aggregates']['doc-1']['impact'] == 5

    def test_a_document_only_commented_on_has_no_aggregate_row(
        self, api_gateway_event, lambda_context
    ):
        """Presence in `aggregates` means somebody SCORED it, so a document that
        only carries notes is absent rather than a row of zeros."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'bob': {'doc-1': {'notes': 'no opinion yet'}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='bob')

        assert body['aggregates'] == {}
        # ...but the note itself is not lost: it is still the caller's ballot.
        assert body['scores']['doc-1']['notes'] == 'no opinion yet'

    def test_a_notes_only_ballot_is_still_saved(self, api_gateway_event, lambda_context):
        """Not counting it as a vote must not turn it into a refusal — commenting
        without scoring is a thing a reviewer may legitimately do."""
        table = FakeAggregatesTable()

        status, _ = _patch_scores(table, api_gateway_event, lambda_context,
                                  {'doc-1': {'notes': 'later'}}, subject='bob')

        assert status == 200
        assert table.ballot('doc-1', 'bob')['notes'] == 'later'

    def test_a_partially_scored_ballot_counts_only_on_the_axes_it_carries(
        self, api_gateway_event, lambda_context
    ):
        """Bob scored impact only. His silence on the other three axes is not a
        zero, so alice's numbers stand there — while impact is the mean of both."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 4, 'time_to_market': 4,
                                'confidence': 4, 'strategic_fit': 4}},
            'bob': {'doc-1': {'impact': 2}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['doc-1']
        assert aggregate['reviewer_count'] == 2, 'bob scored an axis, so he voted'
        assert aggregate['impact'] == 3
        assert aggregate['time_to_market'] == 4
        assert aggregate['confidence'] == 4
        assert aggregate['strategic_fit'] == 4

    def test_an_axis_nobody_scored_reports_zero_rather_than_failing(
        self, api_gateway_event, lambda_context
    ):
        """Averaging over the reviewers who scored an axis has to survive the case
        where that set is empty — a divide by zero would be a 500 on the page's
        primary read."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 4}},
        })

        status, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert status == 200
        assert body['aggregates']['doc-1']['impact'] == 4
        assert body['aggregates']['doc-1']['confidence'] == 0

    def test_a_legacy_entry_with_no_axes_is_not_a_reviewer_either(
        self, api_gateway_event, lambda_context
    ):
        """The same rule applies to the pre-ballot map, whose entries may predate
        an axis entirely."""
        table = FakeAggregatesTable(items=[{
            'pk': PARTITION, 'sk': LEGACY_SK,
            'scores': {'doc-1': {'notes': 'no numbers'}},
        }])

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates'] == {}


class TestTheSpreadOnlyComparesComparableBallots:
    """`score_spread` must measure DISAGREEMENT, not completeness.

    `_composite` floors an absent axis at 0, so a partially-scored ballot always
    composites lower than a complete one carrying the same numbers. Ranging over
    every voting ballot therefore reported disagreement between reviewers who
    agreed exactly, purely because one of them scored fewer axes — and the field's
    own documented contract ("zero spread means agreement") made that a lie a
    consumer would act on. Only fully-scored ballots are compared; below two of
    them the spread is 0.0.

    Fixed by restricting WHICH ballots are compared rather than renormalising
    `_composite`'s weights: renormalised weights leave the four-axis 0-5 scale, so
    the spread would stop being in the unit the page sorts by — the property
    `test_prioritization_weights_lockstep.py` protects.
    """

    @staticmethod
    def _seeded(api_gateway_event, lambda_context, by_reviewer):
        table = FakeAggregatesTable()
        for subject, scores in by_reviewer.items():
            _patch_scores(table, api_gateway_event, lambda_context, scores, subject=subject)
        return table

    def test_reviewers_agreeing_on_their_shared_axis_report_no_disagreement(
        self, api_gateway_event, lambda_context
    ):
        """The reported defect: alice scores all four axes at 4, bob scores only
        `impact: 4`. Nobody contradicted anybody, and the spread said 2.4/5.0."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 4, 'time_to_market': 4,
                                'confidence': 4, 'strategic_fit': 4}},
            'bob': {'doc-1': {'impact': 4}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['doc-1']
        assert aggregate['score_spread'] == 0.0
        # The means still describe everyone who scored, so the partial ballot is
        # counted as a reviewer even though it cannot be compared.
        assert aggregate['reviewer_count'] == 2
        assert aggregate['impact'] == 4

    def test_two_fully_scored_reviewers_still_report_the_composite_range(
        self, api_gateway_event, lambda_context
    ):
        """The fix must not flatten real disagreement.

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

    def test_one_fully_scored_ballot_beside_a_partial_one_has_no_spread(
        self, api_gateway_event, lambda_context
    ):
        """Fewer than two comparable ballots means there is nothing to compare —
        even when the partial one disagrees on the axis it did score."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'doc-1': {'impact': 1}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['doc-1']
        assert aggregate['score_spread'] == 0.0
        assert aggregate['reviewer_count'] == 2

    def test_two_reviewers_scoring_disjoint_axes_report_no_spread(
        self, api_gateway_event, lambda_context
    ):
        """Neither ballot is comparable, so there is no disagreement to report —
        previously this manufactured 1.5 out of two reviewers who never addressed
        the same axis."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 5}},
            'bob': {'doc-1': {'confidence': 5}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['doc-1']['score_spread'] == 0.0

    def test_a_partial_ballot_does_not_widen_a_real_disagreement(
        self, api_gateway_event, lambda_context
    ):
        """Two comparable ballots set the spread; a third partial one is ignored by
        it rather than stretching it to the floor."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'doc-1': {'impact': 3, 'time_to_market': 3,
                              'confidence': 3, 'strategic_fit': 3}},
            'carol': {'doc-1': {'impact': 1}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['doc-1']
        assert aggregate['score_spread'] == pytest.approx(2.0)
        assert aggregate['reviewer_count'] == 3

    def test_a_legacy_entry_missing_an_axis_is_not_compared_either(
        self, api_gateway_event, lambda_context
    ):
        """The reachable source of a partial entry: a pre-ballot value predating an
        axis, read through beside a real ballot for the same document."""
        table = FakeAggregatesTable(items=[{
            'pk': PARTITION, 'sk': LEGACY_SK, 'scores': {'doc-1': {'impact': 4}},
        }])
        _patch_scores(
            table, api_gateway_event, lambda_context,
            {'doc-2': {'impact': 4, 'time_to_market': 4,
                       'confidence': 4, 'strategic_fit': 4}},
            subject='alice',
        )

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['doc-1']['score_spread'] == 0.0

    def test_a_fully_scored_zero_ballot_is_still_comparable(
        self, api_gateway_event, lambda_context
    ):
        """A deliberate zero on every axis is a vote, not silence, so it must still
        set the spread against a high ballot — the distinction `_carries_axis`
        exists to preserve."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'doc-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'doc-1': {'impact': 0, 'time_to_market': 0,
                              'confidence': 0, 'strategic_fit': 0}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['doc-1']['score_spread'] == pytest.approx(5.0)


class TestAnExplicitNullAxisMeansLeaveItAlone:
    """`{'impact': null}` must not destroy a stored score.

    The omission rule was membership (`axis not in entry`), which counts a key
    whose value is null as sent — so it went through `validate_int(default=0)` and
    clamped a reviewer's stored 4 to 0. That is the partial-write data loss this
    save path exists to prevent, surviving for one specific encoding of "no value".
    Read as ABSENT rather than refused, because a serialiser that writes untouched
    fields as null is expressing precisely the intent the PATCH verb already has,
    and `shared/api.py` documents the same null-is-absent reading for `validate_bool`.
    """

    def test_a_null_axis_preserves_the_stored_score(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': AXES},
                      subject='alice')

        status, _ = _patch_scores(table, api_gateway_event, lambda_context,
                                  {'doc-1': {'impact': None}}, subject='alice')

        assert status == 200
        assert table.ballot('doc-1', 'alice')['impact'] == AXES['impact']

    def test_a_null_axis_is_absent_from_the_update_expression(
        self, api_gateway_event, lambda_context
    ):
        """Asserted on the expression, not the end state: assigning the axis to the
        value it already holds leaves identical state while still being a write
        that could clobber a concurrent one."""
        table = FakeAggregatesTable()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {'impact': 3, 'confidence': None}}, subject='alice')

        expression = table.update_item_calls[0]['UpdateExpression']
        assert 'impact' in expression
        assert 'confidence' not in expression

    def test_a_null_note_preserves_the_stored_note(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {**AXES, 'notes': 'keep me'}}, subject='alice')

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {'notes': None}}, subject='alice')

        assert table.ballot('doc-1', 'alice')['notes'] == 'keep me'

    def test_an_all_null_entry_scores_nothing_and_votes_nothing(
        self, api_gateway_event, lambda_context
    ):
        """The null-is-absent reading and the axis-less-is-not-a-vote reading have
        to agree, or a body of nulls would land a ballot that votes zero."""
        table = FakeAggregatesTable()

        status, _ = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'doc-1': {axis: None for axis in
                       ('impact', 'time_to_market', 'confidence', 'strategic_fit')}},
            subject='alice',
        )

        assert status == 200
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        assert body['aggregates'] == {}

    def test_a_zero_is_still_a_deliberate_score(self, api_gateway_event, lambda_context):
        """The whole distinction rests on this: null is silence, 0 is a vote. Read
        them the same way and "I rate this lowest" becomes unexpressible."""
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context, {'doc-1': AXES},
                      subject='alice')

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'doc-1': {'impact': 0}}, subject='alice')

        assert table.ballot('doc-1', 'alice')['impact'] == 0
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        assert body['aggregates']['doc-1']['reviewer_count'] == 1


class TestDuplicateDocumentKeysAreRefused:
    """Two keys that differ only in whitespace address the same ballot.

    Both were written, so one silently overwrote the other with the winner decided
    by object order rather than by anything the caller said — and `updated_count`
    reported two documents saved where one ballot exists. Refused up front, in the
    same pass as the ids and the entry types, so the "nothing malformed can leave a
    multi-document save half-persisted" guarantee stays true.
    """

    def test_two_keys_differing_only_in_whitespace_are_refused(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'doc-1': {'impact': 5}, ' doc-1': {'impact': 1}}, subject='alice',
        )

        assert status == 400
        assert 'distinct' in body['error']

    def test_a_duplicate_key_writes_nothing_at_all(self, api_gateway_event, lambda_context):
        """Refused BEFORE the first write, so neither of the two conflicting values
        lands and the other documents in the same save are untouched."""
        table = FakeAggregatesTable()

        _patch_scores(
            table, api_gateway_event, lambda_context,
            {'doc-ok': AXES, 'doc-1': {'impact': 5}, 'doc-1 ': {'impact': 1}},
            subject='alice',
        )

        assert table.update_item_calls == []
        assert table.ballot_keys == []

    def test_distinct_keys_are_still_accepted(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'doc-1': AXES, 'doc-2': AXES}, subject='alice',
        )

        assert status == 200
        assert body['updated_count'] == 2
        assert table.ballot_keys == [
            'BALLOT#doc-1#user:alice', 'BALLOT#doc-2#user:alice',
        ]


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

    It was NOT dead code before this change: Powertools sorts routes into static
    and dynamic buckets at registration time and resolves static first regardless
    of registration order, so `PUT /projects/prioritization` really did reach the
    old handler and really did overwrite the shared map. Deleting it is therefore a
    BEHAVIOUR CHANGE, not a cleanup.

    Which is also why the path is refused explicitly rather than simply left
    unregistered: with no literal route, that same static-before-dynamic ordering
    sends the path to `PUT /projects/<project_id>` and so to
    `update_project('prioritization')`, whose `update_item` upserts — answering 200
    while discarding the scores and leaving a phantom project item. Reporting
    success for data it dropped is worse than the route that at least stored
    something.
    """

    def test_the_whole_map_overwrite_is_refused(self, api_gateway_event, lambda_context):
        from unittest.mock import patch as patch_fn

        with patch_fn('projects_handler.update_project') as update_project:
            status, body = _call(
                FakeAggregatesTable(),
                _event(api_gateway_event, method='PUT', body={'scores': {'doc-1': AXES}}),
                lambda_context,
            )

        assert status == 400
        assert body['success'] is False
        assert 'no longer supported' in body['error']
        assert update_project.call_count == 0, \
            'the path must not fall through to the generic project route'

    def test_the_refusal_writes_nothing(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        _call(
            table,
            _event(api_gateway_event, method='PUT', body={'scores': {'doc-1': AXES}}),
            lambda_context,
        )

        assert table.put_item_calls == []
        assert table.update_item_calls == []

    def test_the_old_whole_map_handler_no_longer_exists(self):
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


class TestTheDocumentedScaleCeilingHasAnObservableEdge:
    """Following LastEvaluatedKey forever made the documented ceiling (documents x
    reviewers in one partition) manifest as a slowly-worsening GET and eventually a
    Lambda timeout on the page's PRIMARY read. A refusal that names the ceiling is
    diagnosable; a timeout is not — and truncating would be worse still, since a
    silently-short window is how this codebase has been bitten before."""

    def test_a_partition_past_the_page_cap_is_refused_not_truncated(
        self, api_gateway_event, lambda_context
    ):
        import projects_handler

        table = FakeAggregatesTable(page_size=1)
        for i in range(projects_handler.MAX_PRIORITIZATION_PAGES + 5):
            table.items[(PARTITION, f'BALLOT#doc-{i:03d}#user:alice')] = {
                'pk': PARTITION, 'sk': f'BALLOT#doc-{i:03d}#user:alice', **AXES,
            }

        status, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert status == 500
        assert 'scores' not in body, 'a short read must not look like a small backlog'

    def test_a_partition_within_the_page_cap_reads_every_page(
        self, api_gateway_event, lambda_context
    ):
        import projects_handler

        pages = projects_handler.MAX_PRIORITIZATION_PAGES
        table = FakeAggregatesTable(page_size=1)
        for i in range(pages):
            table.items[(PARTITION, f'BALLOT#doc-{i:03d}#user:alice')] = {
                'pk': PARTITION, 'sk': f'BALLOT#doc-{i:03d}#user:alice', **AXES,
            }

        status, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert status == 200
        assert len(body['scores']) == pages


class TestReviewerIdentityComesFromTheSharedHelper:
    """`shared.api.get_caller_subject` is the one place this codebase reads the
    authenticated subject. A second local copy of the same logic is what this repo
    normally forbids outright — a comment saying "keep these in step" cannot fail
    CI — so the route delegates rather than reimplementing."""

    def test_the_route_delegates_to_the_shared_helper(
        self, api_gateway_event, lambda_context
    ):
        import projects_handler

        table = FakeAggregatesTable()
        with patch('projects_handler.get_caller_subject', return_value='alice') as helper:
            with patch('projects_handler.get_aggregates_table', return_value=table):
                projects_handler.lambda_handler(
                    _event(api_gateway_event, method='PATCH', body={'scores': {'doc-1': AXES}}),
                    lambda_context,
                )

        assert helper.call_count == 1
        assert table.ballot('doc-1', 'alice') is not None

    def test_there_is_no_second_local_implementation(self):
        import projects_handler

        assert not hasattr(projects_handler, '_caller_subject'), \
            'reading the subject twice, two ways, is how the two silently drift'


class TestTheLegacyMigrationNeverFailsALandedBallot:
    """The ballot is already durably written by the time the migration runs, so any
    failure there would tell a reviewer their vote failed when it landed."""

    def test_an_unexpected_migration_error_does_not_fail_the_save(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable(items=[{
            'pk': PARTITION, 'sk': LEGACY_SK, 'scores': {'doc-1': {'impact': 1}},
        }])
        real_update = table.update_item

        def update(**kwargs):
            if kwargs['Key']['sk'] == LEGACY_SK:
                raise ClientError(
                    {'Error': {'Code': 'ValidationException'}}, 'UpdateItem',
                )
            return real_update(**kwargs)

        table.update_item = update

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context, {'doc-1': AXES}, subject='alice'
        )

        assert status == 200
        assert body['updated_count'] == 1
        assert table.ballot('doc-1', 'alice')['impact'] == AXES['impact']
