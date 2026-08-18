"""
Tests for the per-reviewer prioritization ballots on /projects/prioritization.

The route used to keep ONE shared item (pk='PRIORITIZATION', sk='SCORES') holding
a single map of document_id -> score, written by every reviewer via
read-modify-write. Two reviewers saving at the same time silently lost each
other's edits and nothing recorded who scored. These tests pin the replacement:
one ballot per reviewer PER ROW, written atomically on its own key, still read in
ONE query.

A ROW is the thing scored: one project's set of documents, so a project whose PRD
and PR/FAQ describe one idea is one row and is scored once. Every ballot key,
every `scores` key and every `aggregates` key below is a row id — which is why
these tests name their subjects `row-1` rather than `doc-1`. The one place
document ids still appear is the legacy pre-ballot map, which predates rows
entirely and is keyed by document; `_legacy_row` below is the translation, and it
is the row's own composition that decides which row a legacy value lands on.

AWS is mocked at the import boundary (`projects_handler.get_aggregates_table`),
following the convention in the sibling handler tests. The fake table below is
not a general DynamoDB — it implements exactly the expressions this route
writes, so that a change to those expressions has to be reflected here.
"""
import json
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

PARTITION = 'PRIORITIZATION'
LEGACY_SK = 'SCORES'


def row_item(row_id, *, project_id=None, document_ids=None, is_default=True, **overrides):
    """A stored row record — a project and the concrete document ids it holds.

    Every test that expects a ballot to be READ BACK needs one, because the read
    ignores a ballot whose row does not resolve. That is deliberate on both sides:
    a stored key naming a row that no longer exists must not break the page, and a
    test that never seeds a row would be asserting against a response the page
    could not produce.

    `document_ids` defaults to one document named after the row, which is enough
    for the rows whose composition is beside the point. The legacy-map tests pass
    their own, because for those the composition is the whole question.
    """
    return {
        'pk': PARTITION,
        'sk': f'ROW#{row_id}',
        'row_id': row_id,
        'project_id': project_id or f'proj-{row_id}',
        'document_ids': document_ids if document_ids is not None else [f'{row_id}-prfaq'],
        'prototype_id': '',
        'is_default': is_default,
        'created_at': '2026-08-17T10:00:00+00:00',
        **overrides,
    }


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
        self.get_item_calls = []
        self.query_calls = []

    # -- writes ------------------------------------------------------------
    def put_item(self, **kwargs):
        """Honours `attribute_not_exists(sk)`, which is the only condition put here.

        Enforced rather than ignored, because that condition IS the row create's
        idempotence: a fake that accepted every put would let a second create
        silently replace a row whose ballots already exist, and the test asserting
        one row per project would pass against code that has the defect.
        """
        self.put_item_calls.append(kwargs)
        item = kwargs['Item']
        key = (item['pk'], item['sk'])
        condition = kwargs.get('ConditionExpression', '')
        if 'attribute_not_exists' in condition and key in self.items:
            raise ClientError(
                {'Error': {'Code': 'ConditionalCheckFailedException',
                           'Message': 'The conditional request failed'}},
                'PutItem',
            )
        self.items[key] = dict(item)
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
    def get_item(self, **kwargs):
        """One keyed read. Used by the row create (to hand back a row that already
        exists) and by the legacy migration (to learn which documents the saved row
        holds)."""
        self.get_item_calls.append(kwargs)
        key = (kwargs['Key']['pk'], kwargs['Key']['sk'])
        item = self.items.get(key)
        return {'Item': dict(item)} if item is not None else {}

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
    def ballot(self, row_id, subject):
        return self.items.get((PARTITION, f'BALLOT#{row_id}#user:{subject}'))

    @property
    def ballot_keys(self):
        return sorted(sk for (_, sk) in self.items if sk.startswith('BALLOT#'))

    def seed_rows(self, *row_ids, **kwargs):
        """Put a row record in place for each id, WITHOUT going through put_item.

        Direct insertion, because several tests assert that a save issues no
        `put_item` at all — seeding through the route's own create would make that
        assertion untestable. This is fixture setup standing in for "somebody
        already opened this project's default row", which is what the page does
        before it can score anything.

        A row already present is LEFT ALONE, which is the same idempotence the
        create route has. It also matters here: `_patch_scores` seeds by default,
        and clobbering would silently replace a row a test composed deliberately
        (the legacy-map fixtures compose theirs around specific document ids) with
        the generic one.
        """
        for row_id in row_ids:
            item = row_item(row_id, **kwargs)
            self.items.setdefault((item['pk'], item['sk']), item)
        return self


def _legacy_doc(row_id):
    """The document id a legacy pre-ballot value for `row_id` is stored under.

    The legacy map predates rows and is keyed by DOCUMENT, so a test about it has
    to name a document — and the value only surfaces on a row that HOLDS that
    document. Deriving the name from the row id keeps every existing assertion
    reading in the row unit while the stored shape stays the one that is actually
    deployed.
    """
    return f'{row_id}-doc'


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


def _patch_scores(table, api_gateway_event, lambda_context, scores, subject='reviewer-1',
                  seed_rows=True):
    """Save the caller's ballot on each row, seeding those rows first.

    Rows are seeded by default because that is the only state the page can reach:
    a reviewer scores a row that exists, and the READ drops a ballot whose row does
    not resolve. A test that saved without a row would be pinning a write nothing
    can read back, which is a different question — `seed_rows=False` is for the
    tests asking exactly that one.

    Keys are seeded verbatim, so a key the route will REFUSE (an empty string, one
    carrying '#') seeds nothing usable and the refusal is unaffected.
    """
    if seed_rows:
        table.seed_rows(*[key for key in scores if isinstance(key, str) and key.strip()])
    return _call(
        table,
        _event(api_gateway_event, method='PATCH', body={'scores': scores}, subject=subject),
        lambda_context,
    )


def _get_scores(table, api_gateway_event, lambda_context, subject='reviewer-1', logger=None):
    """`logger` follows the pattern in test_ballots_handler: pass a double to assert
    on what the read reported, rather than only on what it returned."""
    event = _event(api_gateway_event, method='GET', subject=subject)
    if logger is None:
        return _call(table, event, lambda_context)
    with patch('projects_handler.logger', logger):
        return _call(table, event, lambda_context)


AXES = {'impact': 4, 'time_to_market': 3, 'confidence': 2, 'strategic_fit': 5}


class TestTwoReviewersBothPersist:
    """The defect this change exists to remove: a second reviewer's save replaced
    the first reviewer's numbers, because both wrote one shared map."""

    def test_each_reviewer_keeps_their_own_numbers(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {**AXES, 'impact': 5, 'notes': 'ship it'}}, subject='alice')
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {**AXES, 'impact': 1, 'notes': 'not yet'}}, subject='bob')

        assert table.ballot('row-1', 'alice')['impact'] == 5
        assert table.ballot('row-1', 'alice')['notes'] == 'ship it'
        assert table.ballot('row-1', 'bob')['impact'] == 1
        assert table.ballot('row-1', 'bob')['notes'] == 'not yet'

    def test_the_page_shows_the_caller_their_own_ballot(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {**AXES, 'impact': 5}}, subject='alice')
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {**AXES, 'impact': 1}}, subject='bob')

        _, alice_view = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        _, bob_view = _get_scores(table, api_gateway_event, lambda_context, subject='bob')

        assert alice_view['scores']['row-1']['impact'] == 5
        assert bob_view['scores']['row-1']['impact'] == 1
        # ...and both see that two people scored it.
        assert alice_view['aggregates']['row-1']['reviewer_count'] == 2
        assert bob_view['aggregates']['row-1']['reviewer_count'] == 2

    def test_a_reviewers_ballot_lands_on_its_own_key(self, api_gateway_event, lambda_context):
        """Identity is in the sort key, kind-namespaced, in one partition — so a
        later anonymous ballot ('anon:') cannot land on a signed-in reviewer's key
        and the page's read stays a single query."""
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context, {'row-1': AXES}, subject='alice')
        _patch_scores(table, api_gateway_event, lambda_context, {'row-1': AXES}, subject='bob')

        assert table.ballot_keys == [
            'BALLOT#row-1#user:alice', 'BALLOT#row-1#user:bob',
        ]

    def test_the_read_is_a_single_query_on_one_partition(self, api_gateway_event, lambda_context):
        """One read for the whole page, not one per document: this page already
        fans out per project, so a per-document partition would multiply reads."""
        table = FakeAggregatesTable()
        for document_id in ('row-1', 'row-2', 'row-3'):
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
        for document_id in ('row-1', 'row-2', 'row-3'):
            _patch_scores(table, api_gateway_event, lambda_context,
                          {document_id: AXES}, subject='alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert sorted(body['scores']) == ['row-1', 'row-2', 'row-3']


class TestSaveIsAnAtomicUpdateOfOneKey:
    """The old save was get_item + merge + put_item of the whole map, which loses a
    concurrent writer's edits even when the final state looks plausible."""

    def test_a_save_is_one_update_item_on_the_ballot_key(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context, {'row-1': AXES}, subject='alice'
        )

        assert status == 200
        assert body == {'success': True, 'updated_count': 1}
        ballot_writes = [
            call for call in table.update_item_calls
            if call['Key']['sk'].startswith('BALLOT#')
        ]
        assert len(ballot_writes) == 1
        assert ballot_writes[0]['Key'] == {
            'pk': PARTITION, 'sk': 'BALLOT#row-1#user:alice',
        }
        assert ballot_writes[0]['UpdateExpression'].strip().upper().startswith('SET')

    def test_a_save_never_put_items_a_merged_map(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable(items=[{
            'pk': PARTITION, 'sk': LEGACY_SK, 'scores': {'row-9': {'impact': 2}},
        }])

        _patch_scores(table, api_gateway_event, lambda_context, {'row-1': AXES}, subject='alice')

        assert table.put_item_calls == []

    def test_a_ballot_carries_the_axes_the_note_and_a_timestamp(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {**AXES, 'notes': 'because'}}, subject='alice')

        ballot = table.ballot('row-1', 'alice')
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

        _patch_scores(table, api_gateway_event, lambda_context, {'row-1': AXES}, subject='alice')

        assert 'ttl' not in table.ballot('row-1', 'alice')
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
        ('row#1', "must not contain '#'"),
        ('x' * 300, 'at most 256 characters'),
    ])
    def test_an_unusable_row_id_is_refused_before_any_write(
        self, api_gateway_event, lambda_context, bad_key, expected
    ):
        """'#' is the sort-key delimiter and a server-minted row id never
        contains one; an id carrying it would make the key ambiguous to parse.
        Refused BEFORE the first write, so a bad key in a multi-row save
        cannot leave the request half-persisted.

        Each rule gets its OWN message: one shared message left a caller unable to
        tell a delimiter collision from an over-long id."""
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context, {'row-ok': AXES, bad_key: AXES}
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
            {'row-ok': AXES, 'row-bad': bad_entry},
        )

        assert status == 400
        assert 'must be objects' in body['error']
        assert table.update_item_calls == []
        assert table.ballot_keys == []

    def test_a_save_larger_than_the_bound_is_refused(self, api_gateway_event, lambda_context):
        """Each row costs the ballot write plus, when it scored, a read of the row
        and one conditional removal per document it holds — so an unbounded body
        turns one invocation into hundreds of sequential round trips, and a timeout
        part way through half-persists the save. A 400 naming the bound beats
        that."""
        table = FakeAggregatesTable()
        oversized = {f'row-{i}': AXES for i in range(101)}

        status, body = _patch_scores(table, api_gateway_event, lambda_context, oversized)

        assert status == 400
        assert 'at most 100 rows' in body['error']
        assert table.update_item_calls == []

    def test_a_save_at_the_bound_is_accepted(self, api_gateway_event, lambda_context):
        """The bound is a ceiling on absurdity, not a limit the product can hit —
        so exactly MAX_BALLOTS_PER_SAVE rows still saves."""
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context,
            {f'row-{i}': AXES for i in range(100)},
        )

        assert status == 200
        assert body['updated_count'] == 100

    def test_a_failure_part_way_through_still_reports_a_server_error(
        self, api_gateway_event, lambda_context
    ):
        """A throttle on row 3 of 10 leaves 1-2 durable. Validation cannot
        cause that, only a write failure can, so the request is a 500 and the count
        of rows that DID persist is logged rather than silently lost."""
        table = FakeAggregatesTable()
        real_update = table.update_item
        # Counts only BALLOT writes, so the legacy-migration removals a scoring save
        # also issues cannot absorb the injected failure and leave the request a 200.
        ballot_calls = {'n': 0}

        def failing_update(**kwargs):
            if kwargs['Key']['sk'].startswith('BALLOT#'):
                ballot_calls['n'] += 1
                if ballot_calls['n'] > 1:
                    raise ClientError(
                        {'Error': {'Code': 'ProvisionedThroughputExceededException'}},
                        'UpdateItem',
                    )
            return real_update(**kwargs)

        table.update_item = failing_update

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'row-1': AXES, 'row-2': AXES}, subject='alice',
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
        _patch_scores(table, api_gateway_event, lambda_context, {'row-1': AXES},
                      subject='alice')

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'impact': 5}}, subject='alice')

        ballot = table.ballot('row-1', 'alice')
        assert ballot['impact'] == 5
        assert ballot['time_to_market'] == AXES['time_to_market']
        assert ballot['confidence'] == AXES['confidence']
        assert ballot['strategic_fit'] == AXES['strategic_fit']

    def test_a_partial_entry_does_not_blank_an_existing_note(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {**AXES, 'notes': 'keep me'}}, subject='alice')

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'impact': 1}}, subject='alice')

        assert table.ballot('row-1', 'alice')['notes'] == 'keep me'

    def test_an_omitted_axis_is_absent_from_the_update_expression(
        self, api_gateway_event, lambda_context
    ):
        """Asserted on the expression, not just the end state: an expression that
        assigned the axis to its existing value would leave the same state while
        still being a write that could clobber a concurrent one."""
        table = FakeAggregatesTable()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'impact': 5}}, subject='alice')

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
                                  {'row-1': {'impact': 4}}, subject='alice')

        assert status == 200
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        entry = body['scores']['row-1']
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
                      {'row-1': {'notes': 'no numbers yet'}}, subject='alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        entry = body['scores']['row-1']
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
        _patch_scores(table, api_gateway_event, lambda_context, {'row-1': AXES},
                      subject='alice')

        status, _ = _patch_scores(table, api_gateway_event, lambda_context,
                                  {'row-1': {}}, subject='alice')

        assert status == 200
        ballot = table.ballot('row-1', 'alice')
        assert ballot['impact'] == AXES['impact']
        assert ballot['reviewer'] == 'user:alice'


class TestBoundedAxisAndNoteValues:
    """The decision the change made where the task left room: an out-of-range
    NUMBER is CLAMPED rather than refused, because the value is bounded either way
    and a clamp keeps one odd axis from failing a whole multi-document save. It is
    a silent behaviour, so a test is the only thing that keeps a later refactor
    from changing it unnoticed.

    The note bound does NOT work that way and no longer sits in this class: the
    characters past it are content rather than a number pushed to the nearest legal
    value, so an over-long note is refused (see
    `TestAnOverLongNoteIsRefusedRatherThanTruncated`). What is pinned here is only
    that a note WITHIN the bound is stored exactly as sent.

    CLAMP A NUMBER, REFUSE A NON-NUMBER. The clamp argument is that the value is
    bounded either way, which is true of `99`, `-4`, `'3'` and `2.7` and false of
    `'high'` — there is no value to bound, so the 0 a fallback produces is invented.
    The refusals are in `TestANonNumberIsRefusedRatherThanFlooredAtZero` below."""

    @staticmethod
    def _saved(api_gateway_event, lambda_context, entry):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context, {'row-1': entry},
                      subject='alice')
        return table.ballot('row-1', 'alice')

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

    def test_a_note_at_the_bound_is_stored_verbatim(
        self, api_gateway_event, lambda_context
    ):
        """The bound is inclusive, and nothing on the write path shortens a note
        that fits. Over-long notes are REFUSED, not truncated — see
        `TestAnOverLongNoteIsRefusedRatherThanTruncated`."""
        from projects_handler import MAX_BALLOT_NOTE_LEN

        note = 'x' * MAX_BALLOT_NOTE_LEN
        ballot = self._saved(api_gateway_event, lambda_context, {'notes': note})

        assert ballot['notes'] == note


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
                          {'row-1': existing}, subject='alice')
        writes_before = len(table.update_item_calls)
        status, body = _patch_scores(table, api_gateway_event, lambda_context,
                                     {'row-1': entry}, subject='alice')
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
        assert table.ballot('row-1', 'alice')['impact'] == 4

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
                      {'row-1': dict.fromkeys(AXES, 5)}, subject='alice')

        status, _ = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'row-1': {'impact': 'high', 'time_to_market': 'fast',
                       'confidence': 'n/a', 'strategic_fit': 'yes'}},
            subject='bob')

        assert status == 400
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        assert body['aggregates']['row-1'] == {
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
            {'row-1': dict.fromkeys(AXES, False)}, subject='alice')

        assert status == 400
        assert table.ballot('row-1', 'alice') is None

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
        scores['row-3'] = {'impact': float('inf')}

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
                                  {'row-1': {'impact': value}}, subject='alice')

        assert status == 200
        assert 0 <= table.ballot('row-1', 'alice')['impact'] <= 5

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
                      {'row-1': {'notes': 'ship this in Q3'}}, subject='alice')
        writes_before = len(table.update_item_calls)

        status, body = _patch_scores(table, api_gateway_event, lambda_context,
                                     {'row-1': {'notes': value}}, subject='alice')

        assert status == 400
        assert 'notes' in body['error']
        assert table.ballot('row-1', 'alice')['notes'] == 'ship this in Q3'
        assert len(table.update_item_calls) == writes_before

    def test_the_caller_still_reads_back_the_note_they_saved(
        self, api_gateway_event, lambda_context
    ):
        """Through the route rather than the table, since the page is what a lost
        note would be lost from."""
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'notes': 'ship this in Q3'}}, subject='alice')

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'notes': 42}}, subject='alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        assert body['scores']['row-1']['notes'] == 'ship this in Q3'

    def test_a_string_note_is_still_written(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        status, _ = _patch_scores(table, api_gateway_event, lambda_context,
                                  {'row-1': {'notes': 'still fine'}}, subject='alice')

        assert status == 200
        assert table.ballot('row-1', 'alice')['notes'] == 'still fine'


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
            table, api_gateway_event, lambda_context, {'row-1': AXES}, subject=subject
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

        _patch_scores(table, api_gateway_event, lambda_context, {'row-1': AXES}, subject=None)

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
            table, api_gateway_event, lambda_context, {'row-1': AXES}, subject=subject
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
            table, api_gateway_event, lambda_context, {'row-1': AXES},
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
            table, api_gateway_event, lambda_context, {'row-1': AXES}, subject='has#hash'
        )

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        assert body['aggregates'] == {}

    def test_an_ordinary_subject_is_still_accepted(
        self, api_gateway_event, lambda_context
    ):
        """The guard must not refuse the identifiers Cognito actually mints."""
        table = FakeAggregatesTable()

        status, _ = _patch_scores(
            table, api_gateway_event, lambda_context, {'row-1': AXES},
            subject='b3f1c2de-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
        )

        assert status == 200
        assert table.ballot_keys == [
            'BALLOT#row-1#user:b3f1c2de-4a5b-6c7d-8e9f-0a1b2c3d4e5f'
        ]


class TestLegacyScoresReadThroughAndMigrateOnWrite:
    """The pre-ballot shared map is not migrated by a script: it is read through so
    nothing looks lost, and its entries are removed as reviewers save over them."""

    @staticmethod
    def _with_legacy(scores, page_size=None):
        """The deployed legacy map, plus the rows its documents belong to.

        The map's keys are DOCUMENT ids (`_legacy_doc`), because that is the shape
        actually stored — it predates rows — and each is put on the default row of
        its own project, which is where `_legacy_scores_by_row` makes it surface.
        Tests then talk about rows throughout, which is the unit the response is in.
        """
        table = FakeAggregatesTable(
            items=[{
                'pk': PARTITION, 'sk': LEGACY_SK,
                'scores': {_legacy_doc(row_id): entry for row_id, entry in scores.items()},
            }],
            page_size=page_size,
        )
        for row_id in scores:
            table.seed_rows(row_id, document_ids=[_legacy_doc(row_id)])
        return table

    def test_a_legacy_score_is_returned_when_the_caller_has_no_ballot(
        self, api_gateway_event, lambda_context
    ):
        table = self._with_legacy({'row-1': {
            'document_id': _legacy_doc('row-1'), 'impact': 4, 'time_to_market': 2,
            'confidence': 3, 'strategic_fit': 1, 'notes': 'from before',
        }})

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores']['row-1']['impact'] == 4
        assert body['scores']['row-1']['notes'] == 'from before'

    def test_a_legacy_score_counts_as_one_unattributed_ballot(
        self, api_gateway_event, lambda_context
    ):
        table = self._with_legacy({'row-1': {'impact': 4, 'time_to_market': 4,
                                             'confidence': 4, 'strategic_fit': 4}})

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['reviewer_count'] == 1

    def test_the_callers_own_ballot_wins_over_the_legacy_value(
        self, api_gateway_event, lambda_context
    ):
        table = self._with_legacy({'row-1': {'impact': 1}, 'row-2': {'impact': 2}})

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {**AXES, 'impact': 5}}, subject='alice')
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores']['row-1']['impact'] == 5
        # The untouched document still reads through.
        assert body['scores']['row-2']['impact'] == 2

    def test_the_first_save_removes_that_documents_legacy_entry(
        self, api_gateway_event, lambda_context
    ):
        """Scoring one row retires the pre-ballot value of the documents THAT ROW
        holds, and nothing else's. The map is document-keyed, so a save that wiped
        it wholesale — or that removed nothing, leaving a value the read has already
        stopped counting for a later row to pick up — are the two ways to get this
        wrong."""
        table = self._with_legacy({'row-1': {'impact': 1}, 'row-2': {'impact': 2}})

        _patch_scores(table, api_gateway_event, lambda_context, {'row-1': AXES}, subject='alice')

        legacy = table.items[(PARTITION, LEGACY_SK)]['scores']
        assert _legacy_doc('row-1') not in legacy
        assert _legacy_doc('row-2') in legacy, 'migration must be per row, not a wipe'

    def test_a_document_is_never_counted_twice(self, api_gateway_event, lambda_context):
        """A legacy value plus a real ballot for the same document would be two
        reviewers where there is one. The removal happens in the same save."""
        table = self._with_legacy({'row-1': {'impact': 1, 'time_to_market': 1,
                                             'confidence': 1, 'strategic_fit': 1}})

        _patch_scores(table, api_gateway_event, lambda_context, {'row-1': AXES}, subject='alice')
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['reviewer_count'] == 1
        assert body['aggregates']['row-1']['impact'] == 4

    def test_a_second_reviewer_saving_the_same_document_still_succeeds(
        self, api_gateway_event, lambda_context
    ):
        """The legacy entry is already gone by then, so the conditional removal is a
        no-op rather than an error the reviewer sees."""
        table = self._with_legacy({'row-1': {'impact': 1}})

        _patch_scores(table, api_gateway_event, lambda_context, {'row-1': AXES}, subject='alice')
        status, body = _patch_scores(
            table, api_gateway_event, lambda_context, {'row-1': AXES}, subject='bob'
        )

        assert status == 200
        assert body['success'] is True
        assert table.ballot('row-1', 'bob') is not None

    def test_a_save_with_no_legacy_item_at_all_succeeds(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        status, _ = _patch_scores(table, api_gateway_event, lambda_context, {'row-1': AXES})

        assert status == 200


class TestTheMigrationCostsNothingWhereThereIsNothingToMigrate:
    """This path is permanent (see `_drop_legacy_score`'s RETIREMENT note), so its
    steady-state cost is a cost every deployment pays forever — including every
    deployment that never ran the pre-ballot version and so holds no legacy entry
    at all.

    Per scored row, attempting it blindly means one read of the row plus one
    conditional delete per document it holds: up to MAX_BALLOTS_PER_SAVE ×
    MAX_ROW_DOCUMENT_IDS sequential writes in a single invocation, to discover
    nothing. One read of the map decides instead, once per save.
    """

    @staticmethod
    def _rows(count, documents_each):
        table = FakeAggregatesTable()
        row_ids = [f'row-{n}' for n in range(count)]
        for row_id in row_ids:
            table.seed_rows(
                row_id,
                document_ids=[f'{row_id}-doc-{d}' for d in range(documents_each)],
            )
        return table, row_ids

    def _legacy_reads(self, table):
        return [
            call for call in table.get_item_calls
            if call['Key']['sk'] == LEGACY_SK
        ]

    def _row_reads(self, table):
        return [
            call for call in table.get_item_calls
            if str(call['Key']['sk']).startswith('ROW#')
        ]

    def _removals(self, table):
        return [
            call for call in table.update_item_calls
            if call['UpdateExpression'].strip().upper().startswith('REMOVE')
        ]

    def test_a_deployment_with_no_legacy_map_issues_no_removals_and_no_row_reads(
        self, api_gateway_event, lambda_context
    ):
        """The common case, forever. Ten scored rows of five documents each would
        otherwise be ten row reads and fifty refused conditional writes."""
        table, row_ids = self._rows(10, 5)

        status, _ = _patch_scores(
            table, api_gateway_event, lambda_context,
            {row_id: AXES for row_id in row_ids},
        )

        assert status == 200
        assert self._removals(table) == []
        assert self._row_reads(table) == []

    def test_the_map_is_read_once_per_save_not_once_per_row(
        self, api_gateway_event, lambda_context
    ):
        """Per row it would scale with the body; the entries a save can supersede
        are the ones present when it started, so once is the right number."""
        table, row_ids = self._rows(10, 5)

        _patch_scores(table, api_gateway_event, lambda_context,
                      {row_id: AXES for row_id in row_ids})

        assert len(self._legacy_reads(table)) == 1

    def test_a_save_that_scores_nothing_does_not_read_the_map_at_all(
        self, api_gateway_event, lambda_context
    ):
        """`_is_a_vote` gates the whole path, and the read is lazy behind it: an
        entry that expressed no axis supersedes nothing, so there is nothing to
        ask about."""
        table, _ = self._rows(3, 2)

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-0': {'notes': 'thinking about it'}})

        assert self._legacy_reads(table) == []

    def test_only_documents_the_map_actually_holds_are_deleted(
        self, api_gateway_event, lambda_context
    ):
        """A deployment that DOES hold one legacy entry still pays one write, not
        one per document of the row: the read already said which id is there."""
        table = FakeAggregatesTable(items=[{
            'pk': PARTITION, 'sk': LEGACY_SK, 'scores': {'row-0-doc-3': {'impact': 2}},
        }])
        table.seed_rows('row-0', document_ids=[f'row-0-doc-{d}' for d in range(25)])

        _patch_scores(table, api_gateway_event, lambda_context, {'row-0': AXES})

        removals = self._removals(table)
        assert len(removals) == 1
        assert removals[0]['ExpressionAttributeNames']['#document'] == 'row-0-doc-3'
        assert 'row-0-doc-3' not in table.items[(PARTITION, LEGACY_SK)]['scores']

    def test_two_rows_sharing_a_document_attempt_its_removal_once(
        self, api_gateway_event, lambda_context
    ):
        """Phase 2 can compose two rows over one document. The removal is
        idempotent either way — the condition sees it gone — but the second attempt
        is a round trip that buys nothing."""
        table = FakeAggregatesTable(items=[{
            'pk': PARTITION, 'sk': LEGACY_SK, 'scores': {'shared-doc': {'impact': 2}},
        }])
        table.seed_rows('row-a', document_ids=['shared-doc'])
        table.seed_rows('row-b', document_ids=['shared-doc'])

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-a': AXES, 'row-b': AXES})

        assert len(self._removals(table)) == 1

    def test_an_unreadable_map_leaves_the_ballot_landed(
        self, api_gateway_event, lambda_context
    ):
        """Best effort throughout: the ballot is already durably written by the time
        this runs, so a failed read must not tell a reviewer their vote failed."""
        table = FakeAggregatesTable()
        table.seed_rows('row-1')
        original = table.get_item

        def failing_get_item(**kwargs):
            if kwargs['Key']['sk'] == LEGACY_SK:
                table.get_item_calls.append(kwargs)
                raise RuntimeError('DynamoDB is having a day')
            return original(**kwargs)

        table.get_item = failing_get_item

        status, body = _patch_scores(table, api_gateway_event, lambda_context,
                                     {'row-1': AXES})

        assert status == 200
        assert body['updated_count'] == 1
        assert table.ballot('row-1', 'reviewer-1') is not None


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
        """See the sibling helper in `TestLegacyScoresReadThroughAndMigrateOnWrite`:
        document-keyed legacy entries, each on the default row that holds it."""
        table = FakeAggregatesTable(
            items=[{
                'pk': PARTITION, 'sk': LEGACY_SK,
                'scores': {_legacy_doc(row_id): entry for row_id, entry in scores.items()},
            }]
        )
        for row_id in scores:
            table.seed_rows(row_id, document_ids=[_legacy_doc(row_id)])
        return table

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
        table = self._with_legacy({'row-1': entry})

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
            'row-1': {'impact': 4, 'time_to_market': 2,
                      'confidence': 3, 'strategic_fit': 1},
            'row-2': {'impact': 2},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores']['row-1']['impact'] == 4
        assert body['scores']['row-2']['impact'] == 2
        assert set(body['aggregates']) == {'row-1', 'row-2'}

    def test_a_legacy_entry_carrying_only_a_note_still_reads_through(
        self, api_gateway_event, lambda_context
    ):
        """The read-through's question is WIDER than the aggregate's. A note is
        something a reviewer wrote, so dropping it would lose it from the page — but
        it is not a score, so it must still not count as a reviewer. This is the one
        case where the two halves legitimately differ, and the reason the filter is
        `_expresses_something` rather than `_is_a_vote`."""
        table = self._with_legacy({'row-1': {'notes': 'from before the sliders'}})

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores']['row-1']['notes'] == 'from before the sliders'
        assert body['scores']['row-1']['impact'] == 0.0
        assert body['aggregates'] == {}

    def test_a_note_beside_an_unreadable_axis_reads_the_note_and_no_score(
        self, api_gateway_event, lambda_context
    ):
        """The shape where the two halves look like they disagree, and do not.

        `{'notes': 'x', 'impact': 'high'}` is read through for the NOTE, because a
        reviewer wrote it, so the caller sees `impact: 0.0` while `aggregates` omits
        the document. The 0.0 is `_axis_value` reporting an axis nobody expressed —
        the same value the page already shows a reviewer whose first save carried
        only a note — not the read claiming somebody scored zero.

        Pinned rather than described because the alternative is tempting: seeding the
        frontend's default would put a number nobody entered into a field named for
        what a reviewer scored, and would destroy the silence-versus-vote distinction
        the aggregate depends on.
        """
        table = self._with_legacy({'row-1': {'notes': 'no numbers, just a view',
                                             'impact': 'high'}})

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores']['row-1']['notes'] == 'no numbers, just a view'
        assert body['scores']['row-1']['impact'] == 0
        assert body['aggregates'] == {}, 'an unreadable axis is not a vote'

    def test_an_unreadable_legacy_entry_still_migrates_on_write(
        self, api_gateway_event, lambda_context
    ):
        """Not reading it through must not strand it: the first save against the
        document still removes it, so it cannot resurface later."""
        table = self._with_legacy({'row-1': 'garbage'})

        status, _ = _patch_scores(table, api_gateway_event, lambda_context,
                                  {'row-1': AXES}, subject='alice')

        assert status == 200
        assert 'row-1' not in table.items[(PARTITION, LEGACY_SK)]['scores']

    def test_the_callers_own_ballot_is_unaffected_by_a_sibling_unreadable_entry(
        self, api_gateway_event, lambda_context
    ):
        table = self._with_legacy({'row-1': 'garbage', 'row-2': {'impact': 3}})

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-3': AXES}, subject='alice')
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert set(body['scores']) == {'row-2', 'row-3'}


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
            'alice': {'row-1': {'impact': 4, 'time_to_market': 3,
                                'confidence': 2, 'strategic_fit': 5}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['row-1']
        assert aggregate['reviewer_count'] == 1
        assert aggregate['impact'] == 4
        assert aggregate['time_to_market'] == 3
        assert aggregate['confidence'] == 2
        assert aggregate['strategic_fit'] == 5
        assert aggregate['score_spread'] == 0, 'one ballot cannot disagree with itself'

    def test_each_axis_is_the_mean_across_reviewers(self, api_gateway_event, lambda_context):
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'row-1': {'impact': 5, 'time_to_market': 4,
                                'confidence': 3, 'strategic_fit': 2}},
            'bob': {'row-1': {'impact': 1, 'time_to_market': 2,
                              'confidence': 3, 'strategic_fit': 4}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['row-1']
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
            'alice': {'row-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'row-1': {'impact': 1, 'time_to_market': 1,
                              'confidence': 1, 'strategic_fit': 1}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['score_spread'] == pytest.approx(4.0)

    def test_a_document_nobody_scored_has_no_aggregate(self, api_gateway_event, lambda_context):
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'row-1': AXES},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert list(body['aggregates']) == ['row-1']

    def test_a_reviewer_with_no_ballot_of_their_own_still_sees_the_aggregate(
        self, api_gateway_event, lambda_context
    ):
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'row-1': {'impact': 4, 'time_to_market': 4,
                                'confidence': 4, 'strategic_fit': 4}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='carol')

        assert body['scores'] == {}, "carol has scored nothing, so her sliders start empty"
        assert body['aggregates']['row-1']['reviewer_count'] == 1


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
            'alice': {'row-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'row-1': {'notes': 'agree'}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['reviewer_count'] == 1

    def test_a_notes_only_ballot_leaves_the_real_reviewers_means_intact(
        self, api_gateway_event, lambda_context
    ):
        """Was 2.5 on every axis: one reviewer scoring 5 across the board, averaged
        against a reviewer who moved no slider at all."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'row-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'row-1': {'notes': 'agree'}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['row-1']
        for axis in ('impact', 'time_to_market', 'confidence', 'strategic_fit'):
            assert aggregate[axis] == 5, axis

    def test_a_notes_only_ballot_manufactures_no_disagreement(
        self, api_gateway_event, lambda_context
    ):
        """`score_spread` is the field most damaged by this, because an axis-less
        ballot always sits at composite 0 — so it reported the maximum possible
        disagreement (5.0) out of a reviewer who expressed no numbers."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'row-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'row-1': {'notes': 'agree'}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['score_spread'] == 0

    def test_several_notes_only_ballots_still_leave_one_reviewer(
        self, api_gateway_event, lambda_context
    ):
        """Each extra note-only reviewer used to pull the mean further down: two
        took it to 1.67."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'row-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'row-1': {'notes': 'agree'}},
            'carol': {'row-1': {'notes': 'same'}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['reviewer_count'] == 1
        assert body['aggregates']['row-1']['impact'] == 5

    def test_a_document_only_commented_on_has_no_aggregate_row(
        self, api_gateway_event, lambda_context
    ):
        """Presence in `aggregates` means somebody SCORED it, so a document that
        only carries notes is absent rather than a row of zeros."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'bob': {'row-1': {'notes': 'no opinion yet'}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='bob')

        assert body['aggregates'] == {}
        # ...but the note itself is not lost: it is still the caller's ballot.
        assert body['scores']['row-1']['notes'] == 'no opinion yet'

    def test_a_notes_only_ballot_is_still_saved(self, api_gateway_event, lambda_context):
        """Not counting it as a vote must not turn it into a refusal — commenting
        without scoring is a thing a reviewer may legitimately do."""
        table = FakeAggregatesTable()

        status, _ = _patch_scores(table, api_gateway_event, lambda_context,
                                  {'row-1': {'notes': 'later'}}, subject='bob')

        assert status == 200
        assert table.ballot('row-1', 'bob')['notes'] == 'later'

    def test_a_partially_scored_ballot_counts_only_on_the_axes_it_carries(
        self, api_gateway_event, lambda_context
    ):
        """Bob scored impact only. His silence on the other three axes is not a
        zero, so alice's numbers stand there — while impact is the mean of both."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'row-1': {'impact': 4, 'time_to_market': 4,
                                'confidence': 4, 'strategic_fit': 4}},
            'bob': {'row-1': {'impact': 2}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['row-1']
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
            'alice': {'row-1': {'impact': 4}},
        })

        status, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert status == 200
        assert body['aggregates']['row-1']['impact'] == 4
        assert body['aggregates']['row-1']['confidence'] == 0

    def test_a_legacy_entry_with_no_axes_is_not_a_reviewer_either(
        self, api_gateway_event, lambda_context
    ):
        """The same rule applies to the pre-ballot map, whose entries may predate
        an axis entirely."""
        table = FakeAggregatesTable(items=[{
            'pk': PARTITION, 'sk': LEGACY_SK,
            'scores': {'row-1': {'notes': 'no numbers'}},
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
            'alice': {'row-1': {'impact': 4, 'time_to_market': 4,
                                'confidence': 4, 'strategic_fit': 4}},
            'bob': {'row-1': {'impact': 4}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['row-1']
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
            'alice': {'row-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'row-1': {'impact': 1, 'time_to_market': 1,
                              'confidence': 1, 'strategic_fit': 1}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['score_spread'] == pytest.approx(4.0)

    def test_one_fully_scored_ballot_beside_a_partial_one_has_no_spread(
        self, api_gateway_event, lambda_context
    ):
        """Fewer than two comparable ballots means there is nothing to compare —
        even when the partial one disagrees on the axis it did score."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'row-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'row-1': {'impact': 1}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['row-1']
        assert aggregate['score_spread'] == 0.0
        assert aggregate['reviewer_count'] == 2

    def test_two_reviewers_scoring_disjoint_axes_report_no_spread(
        self, api_gateway_event, lambda_context
    ):
        """Neither ballot is comparable, so there is no disagreement to report —
        previously this manufactured 1.5 out of two reviewers who never addressed
        the same axis."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'row-1': {'impact': 5}},
            'bob': {'row-1': {'confidence': 5}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['score_spread'] == 0.0

    def test_a_partial_ballot_does_not_widen_a_real_disagreement(
        self, api_gateway_event, lambda_context
    ):
        """Two comparable ballots set the spread; a third partial one is ignored by
        it rather than stretching it to the floor."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'row-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'row-1': {'impact': 3, 'time_to_market': 3,
                              'confidence': 3, 'strategic_fit': 3}},
            'carol': {'row-1': {'impact': 1}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        aggregate = body['aggregates']['row-1']
        assert aggregate['score_spread'] == pytest.approx(2.0)
        assert aggregate['reviewer_count'] == 3

    def test_a_legacy_entry_missing_an_axis_is_not_compared_either(
        self, api_gateway_event, lambda_context
    ):
        """The reachable source of a partial entry: a pre-ballot value predating an
        axis, surfacing on the default row that holds its document."""
        table = FakeAggregatesTable(items=[{
            'pk': PARTITION, 'sk': LEGACY_SK,
            'scores': {_legacy_doc('row-1'): {'impact': 4}},
        }])
        table.seed_rows('row-1', document_ids=[_legacy_doc('row-1')])
        _patch_scores(
            table, api_gateway_event, lambda_context,
            {'row-2': {'impact': 4, 'time_to_market': 4,
                       'confidence': 4, 'strategic_fit': 4}},
            subject='alice',
        )

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['score_spread'] == 0.0

    def test_a_fully_scored_zero_ballot_is_still_comparable(
        self, api_gateway_event, lambda_context
    ):
        """A deliberate zero on every axis is a vote, not silence, so it must still
        set the spread against a high ballot — the distinction `_carries_axis`
        exists to preserve."""
        table = self._seeded(api_gateway_event, lambda_context, {
            'alice': {'row-1': {'impact': 5, 'time_to_market': 5,
                                'confidence': 5, 'strategic_fit': 5}},
            'bob': {'row-1': {'impact': 0, 'time_to_market': 0,
                              'confidence': 0, 'strategic_fit': 0}},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['score_spread'] == pytest.approx(5.0)


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
        _patch_scores(table, api_gateway_event, lambda_context, {'row-1': AXES},
                      subject='alice')

        status, _ = _patch_scores(table, api_gateway_event, lambda_context,
                                  {'row-1': {'impact': None}}, subject='alice')

        assert status == 200
        assert table.ballot('row-1', 'alice')['impact'] == AXES['impact']

    def test_a_null_axis_is_absent_from_the_update_expression(
        self, api_gateway_event, lambda_context
    ):
        """Asserted on the expression, not the end state: assigning the axis to the
        value it already holds leaves identical state while still being a write
        that could clobber a concurrent one."""
        table = FakeAggregatesTable()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'impact': 3, 'confidence': None}}, subject='alice')

        expression = table.update_item_calls[0]['UpdateExpression']
        assert 'impact' in expression
        assert 'confidence' not in expression

    def test_a_null_note_preserves_the_stored_note(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {**AXES, 'notes': 'keep me'}}, subject='alice')

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'notes': None}}, subject='alice')

        assert table.ballot('row-1', 'alice')['notes'] == 'keep me'

    def test_an_all_null_entry_scores_nothing_and_votes_nothing(
        self, api_gateway_event, lambda_context
    ):
        """The null-is-absent reading and the axis-less-is-not-a-vote reading have
        to agree, or a body of nulls would land a ballot that votes zero."""
        table = FakeAggregatesTable()

        status, _ = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'row-1': {axis: None for axis in
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
        _patch_scores(table, api_gateway_event, lambda_context, {'row-1': AXES},
                      subject='alice')

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'impact': 0}}, subject='alice')

        assert table.ballot('row-1', 'alice')['impact'] == 0
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')
        assert body['aggregates']['row-1']['reviewer_count'] == 1


class TestDuplicateRowKeysAreRefused:
    """Two keys that differ only in whitespace address the same ballot.

    Both were written, so one silently overwrote the other with the winner decided
    by object order rather than by anything the caller said — and `updated_count`
    reported two rows saved where one ballot exists. Refused up front, in the
    same pass as the ids and the entry types, so the "nothing malformed can leave a
    multi-row save half-persisted" guarantee stays true.
    """

    def test_two_keys_differing_only_in_whitespace_are_refused(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'row-1': {'impact': 5}, ' row-1': {'impact': 1}}, subject='alice',
        )

        assert status == 400
        assert 'distinct' in body['error']

    def test_a_duplicate_key_writes_nothing_at_all(self, api_gateway_event, lambda_context):
        """Refused BEFORE the first write, so neither of the two conflicting values
        lands and the other rows in the same save are untouched."""
        table = FakeAggregatesTable()

        _patch_scores(
            table, api_gateway_event, lambda_context,
            {'row-ok': AXES, 'row-1': {'impact': 5}, 'row-1 ': {'impact': 1}},
            subject='alice',
        )

        assert table.update_item_calls == []
        assert table.ballot_keys == []

    def test_distinct_keys_are_still_accepted(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'row-1': AXES, 'row-2': AXES}, subject='alice',
        )

        assert status == 200
        assert body['updated_count'] == 2
        assert table.ballot_keys == [
            'BALLOT#row-1#user:alice', 'BALLOT#row-2#user:alice',
        ]


class TestTheResponseIsThreeMapsKeyedByRow:
    """`rows`, `scores` and `aggregates`, all addressed by row id, out of ONE query.

    `rows` is what lets the page know what each row HOLDS without a second round
    trip per row, which is the whole reason the row records live in the partition
    the read already scans."""

    def test_the_get_response_matches_the_shape_the_page_consumes(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {**AXES, 'notes': 'keep'}}, subject='alice')

        status, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert status == 200
        assert 'scores' in body
        entry = body['scores']['row-1']
        assert set(entry) == {
            'row_id', 'impact', 'time_to_market', 'confidence',
            'strategic_fit', 'notes',
        }
        assert entry['row_id'] == 'row-1'
        assert isinstance(entry['notes'], str)
        for axis in ('impact', 'time_to_market', 'confidence', 'strategic_fit'):
            assert isinstance(entry[axis], (int, float))

    def test_the_rows_arrive_with_their_documents_in_the_same_read(
        self, api_gateway_event, lambda_context
    ):
        """The page needs the composition to render what a row contains, and a
        route of its own — or one read per row — is what putting the rows in this
        partition avoids. Asserted together with the query count, because "in the
        same read" is the claim."""
        table = FakeAggregatesTable().seed_rows(
            'row-1', project_id='proj-1', document_ids=['prd-1', 'prfaq-1'],
        )
        table.query_calls.clear()

        status, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert status == 200
        assert body['rows']['row-1']['project_id'] == 'proj-1'
        assert body['rows']['row-1']['document_ids'] == ['prd-1', 'prfaq-1']
        assert len(table.query_calls) == 1

    def test_a_ballot_naming_a_row_that_no_longer_resolves_is_ignored(
        self, api_gateway_event, lambda_context
    ):
        """A stored sort key naming a vanished row must not break the page, and must
        not appear as a row nothing describes — in EITHER half of the response. The
        two halves filtering separately is how `scores` and `aggregates` came to
        disagree about the legacy value once already."""
        table = FakeAggregatesTable(items=[{
            'pk': PARTITION, 'sk': 'BALLOT#row-gone#user:alice',
            'row_id': 'row-gone', 'reviewer': 'user:alice', **AXES,
        }])

        status, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert status == 200
        assert body['scores'] == {}
        assert body['aggregates'] == {}
        assert body['rows'] == {}

    def test_a_ballot_keyed_by_a_DOCUMENT_is_abandoned_by_decision_not_by_accident(
        self, api_gateway_event, lambda_context
    ):
        """A ballot written by the PREVIOUS deployment is dropped, and that is a
        product decision rather than an oversight — which is why it has a test of
        its own rather than riding on the vanished-row case above.

        #333 keyed a signed-in ballot `BALLOT#{document_id}#user:{sub}` and #340
        keyed a room ballot `BALLOT#{document_id}#anon:{ballot_id}`. Both were live
        when this change was written, and the first key segment is now read as a ROW
        id, so neither resolves. No migration is provided: the product owner decided
        (2026-08-18) that the handful of ballots cast under the old key are
        expendable, in preference to carrying a re-key nothing will need again.

        The distinction this pins is that the drop is TOTAL and QUIET: absent from
        `scores`, from `aggregates` and from `rows`, with a 200 and no warning. That
        is the accepted behaviour, and a future reader wondering whether it was
        noticed should find this test rather than infer it from silence.

        NOT covered here on purpose: nothing deletes the orphaned items, so they
        remain in the partition counting against `MAX_PRIORITIZATION_PAGES`. Harmless
        at the two rows that existed; it becomes a cleanup task if a deployment ever
        carries a large backlog across this change.
        """
        table = FakeAggregatesTable(items=[
            # The two shapes the deployed code wrote, on a real-looking document id.
            {
                'pk': PARTITION, 'sk': 'BALLOT#prfaq_20260101120000#user:alice',
                'document_id': 'prfaq_20260101120000', 'reviewer': 'user:alice', **AXES,
            },
            {
                'pk': PARTITION, 'sk': 'BALLOT#prfaq_20260101120000#anon:ballot-1',
                'document_id': 'prfaq_20260101120000', 'reviewer': 'anon:ballot-1',
                'voting_session': 'vs_old', **AXES,
            },
        ]).seed_rows(
            # A row that legitimately holds that very document. The ballots are still
            # dropped: they are keyed by the DOCUMENT, and nothing maps one onto the
            # row containing it. This is the assertion that makes the test about the
            # decision rather than about an unresolvable id.
            'row-1', project_id='proj-1', document_ids=['prfaq_20260101120000'],
        )

        status, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert status == 200
        assert body['scores'] == {}
        assert body['aggregates'] == {}
        # The row itself is unaffected and reads as never scored.
        assert body['rows']['row-1']['document_ids'] == ['prfaq_20260101120000']

    def test_discarding_a_ballot_is_reported_rather_than_done_in_silence(
        self, api_gateway_event, lambda_context
    ):
        """A discarded ballot is somebody's opinion disappearing, so the read has to
        say it happened.

        The one-time cost of this change is accepted: ballots written before rows
        existed were keyed `BALLOT#{document_id}#…` (#333 signed-in, #340 room), the
        first segment is now read as a ROW id, and no migration is provided. What is
        NOT accepted is that happening quietly — the drop used to be a bare
        `continue` with no log, no count, a 200, and a row reading as never scored.
        This asserts the counts, which are what make a future loss detectable and
        tell the one-off from a leak: the number should be flat after the first read
        of an environment, and a growing one means ballots are being written against
        rows that do not exist.

        The row ids must NOT be in the message — one of them is a document id from
        the old key shape, and this module does not echo stored identifiers into
        logs.
        """
        document_id = 'prfaq_20260101120000'
        table = FakeAggregatesTable(items=[
            {
                'pk': PARTITION, 'sk': f'BALLOT#{document_id}#user:alice',
                'reviewer': 'user:alice', **AXES,
            },
            {
                'pk': PARTITION, 'sk': f'BALLOT#{document_id}#anon:ballot-1',
                'reviewer': 'anon:ballot-1', **AXES,
            },
            {
                'pk': PARTITION, 'sk': 'BALLOT#row-gone#user:alice',
                'reviewer': 'user:alice', **AXES,
            },
        ]).seed_rows('row-1', project_id='proj-1', document_ids=[document_id])
        logger = MagicMock()

        status, body = _get_scores(
            table, api_gateway_event, lambda_context, subject='alice', logger=logger,
        )

        # Dropped from both halves, and the surviving row is untouched.
        assert status == 200
        assert body['scores'] == {}
        assert body['aggregates'] == {}
        assert body['rows']['row-1']['document_ids'] == [document_id]
        # Reported once, with both counts: three ballots across two unresolved ids.
        assert logger.warning.call_count == 1
        args = logger.warning.call_args[0]
        assert args[1] == 3, f'ballot count, got {args[1]}'
        assert args[2] == 2, f'distinct unresolved row ids, got {args[2]}'
        # Neither identifier reaches the log line, in the template or the arguments.
        assert document_id not in str(args)
        assert 'row-gone' not in str(args)

    def test_a_read_with_nothing_to_discard_says_nothing(
        self, api_gateway_event, lambda_context
    ):
        """The positive control for the report above: a warning on every read would be
        noise, and would make the growing-count signal unreadable."""
        table = FakeAggregatesTable().seed_rows(
            'row-1', project_id='proj-1', document_ids=['prd-1'],
        )
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {**AXES}}, subject='alice')
        logger = MagicMock()

        status, _ = _get_scores(
            table, api_gateway_event, lambda_context, subject='alice', logger=logger,
        )

        assert status == 200
        assert logger.warning.call_count == 0

    def test_an_empty_backlog_still_returns_an_empty_score_map(
        self, api_gateway_event, lambda_context
    ):
        status, body = _get_scores(FakeAggregatesTable(), api_gateway_event, lambda_context)

        assert status == 200
        assert body['scores'] == {}
        assert body['aggregates'] == {}

    def test_patch_accepts_an_entry_carrying_its_own_row_id(
        self, api_gateway_event, lambda_context
    ):
        """The page sends the identity inside each entry as well as as the key. The
        KEY is what addresses the ballot — an entry disagreeing with its own key
        would otherwise produce a ballot nothing can find."""
        table = FakeAggregatesTable()

        status, body = _patch_scores(table, api_gateway_event, lambda_context, {
            'row-1': {
                'row_id': 'row-1', 'impact': 4, 'time_to_market': 3,
                'confidence': 2, 'strategic_fit': 5, 'notes': 'ok',
            },
        }, subject='alice')

        assert status == 200
        assert body['updated_count'] == 1
        assert table.ballot('row-1', 'alice')['impact'] == 4


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
        with patch('projects_handler.update_project') as update_project:
            status, body = _call(
                FakeAggregatesTable(),
                _event(api_gateway_event, method='PUT', body={'scores': {'row-1': AXES}}),
                lambda_context,
            )

        # 405, not 400: the body was well-formed and the VERB is what is gone. A 400
        # sends a client looking at its payload for a fault that is not there.
        assert status == 405
        assert body['success'] is False
        assert 'no longer supported' in body['error']
        assert update_project.call_count == 0, \
            'the path must not fall through to the generic project route'

    def test_the_refusal_names_the_verbs_that_do_work(
        self, api_gateway_event, lambda_context
    ):
        """A 405 is required to carry `Allow`, and it is the actionable half: the
        caller is on a route that exists, with a verb that does not, and needs to be
        told which verbs remain rather than left to guess. OPTIONS is included
        because preflight really is answered on this path, by API Gateway and by the
        resolver both."""
        from projects_handler import lambda_handler

        with patch('projects_handler.get_aggregates_table', return_value=FakeAggregatesTable()):
            response = lambda_handler(
                _event(api_gateway_event, method='PUT', body={'scores': {}}),
                lambda_context,
            )

        # Powertools emits REST responses with `multiValueHeaders`, so a test that
        # reads only `headers` finds nothing and reports a missing header that is
        # actually present. Both shapes are flattened rather than assuming one.
        raw = {**(response.get('headers') or {}),
               **{k: v[0] for k, v in (response.get('multiValueHeaders') or {}).items()}}
        headers = {k.lower(): v for k, v in raw.items()}
        assert headers.get('allow') == 'GET, PATCH, OPTIONS', headers

    def test_the_refusal_writes_nothing(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        _call(
            table,
            _event(api_gateway_event, method='PUT', body={'scores': {'row-1': AXES}}),
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
    """Following LastEvaluatedKey forever made the documented ceiling (rows x
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
            table.items[(PARTITION, f'BALLOT#row-{i:03d}#user:alice')] = {
                'pk': PARTITION, 'sk': f'BALLOT#row-{i:03d}#user:alice', **AXES,
            }

        status, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert status == 500
        assert 'scores' not in body, 'a short read must not look like a small backlog'

    def test_a_partition_within_the_page_cap_reads_every_page(
        self, api_gateway_event, lambda_context
    ):
        import projects_handler

        # HALF the budget in ballots, because each ballot's row record is an item in
        # the same partition and so occupies a page of its own at this page size.
        # Spending the whole budget on ballots alone would exceed the cap for a
        # reason this test is not about.
        ballots = projects_handler.MAX_PRIORITIZATION_PAGES // 2
        table = FakeAggregatesTable(page_size=1)
        for i in range(ballots):
            row_id = f'row-{i:03d}'
            table.seed_rows(row_id)
            table.items[(PARTITION, f'BALLOT#{row_id}#user:alice')] = {
                'pk': PARTITION, 'sk': f'BALLOT#{row_id}#user:alice',
                'row_id': row_id, 'reviewer': 'user:alice', **AXES,
            }

        status, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert status == 200
        assert len(body['scores']) == ballots


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
        with (
            patch('projects_handler.get_caller_subject', return_value='alice') as helper,
            patch('projects_handler.get_aggregates_table', return_value=table),
        ):
            projects_handler.lambda_handler(
                _event(api_gateway_event, method='PATCH', body={'scores': {'row-1': AXES}}),
                lambda_context,
            )

        assert helper.call_count == 1
        assert table.ballot('row-1', 'alice') is not None

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
            'pk': PARTITION, 'sk': LEGACY_SK,
            'scores': {_legacy_doc('row-1'): {'impact': 1}},
        }])
        table.seed_rows('row-1', document_ids=[_legacy_doc('row-1')])
        real_update = table.update_item

        def update(**kwargs):
            if kwargs['Key']['sk'] == LEGACY_SK:
                raise ClientError(
                    {'Error': {'Code': 'ValidationException'}}, 'UpdateItem',
                )
            return real_update(**kwargs)

        table.update_item = update

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context, {'row-1': AXES}, subject='alice'
        )

        assert status == 200
        assert body['updated_count'] == 1
        assert table.ballot('row-1', 'alice')['impact'] == AXES['impact']


class TestASaveThatExpressesNothingDestroysNothing:
    """The last place the defect this change exists to remove survived: one
    reviewer's write deleting a score another reviewer can see.

    The legacy removal fired for every validated key, before anything asked whether
    the ballot said anything. So `{}` (a legal no-op by design),
    `{'notes': null}` and `{'impact': null}` (silence, by round 3's reading), and an
    entry whose only key is a typo'd axis each permanently deleted the pre-ballot
    score for that document, for every reviewer, on a 200 — worse than the
    shared-map race it replaced, because the winning write expressed no opinion at
    all.

    `_drop_legacy_score`'s own justification is "the reviewer who saved has just
    expressed the newer opinion". These tests pin that the code only acts when that
    clause is TRUE."""

    LEGACY: ClassVar[dict] = {'impact': 4, 'time_to_market': 3, 'confidence': 5,
                              'strategic_fit': 4}

    @classmethod
    def _with_legacy(cls):
        table = FakeAggregatesTable(
            items=[{
                'pk': PARTITION, 'sk': LEGACY_SK,
                'scores': {_legacy_doc('row-1'): dict(cls.LEGACY)},
            }],
        )
        return table.seed_rows('row-1', document_ids=[_legacy_doc('row-1')])

    @staticmethod
    def _legacy_map(table):
        """The stored map, re-keyed by ROW so assertions read in the response's unit.

        The stored keys are document ids because that is the shape deployed; the
        rows these tests seed hold exactly one document each, so the translation is
        exact rather than a convenience.
        """
        stored = table.items[(PARTITION, LEGACY_SK)]['scores']
        return {
            row_id: stored[document_id]
            for row_id in ('row-1',)
            if (document_id := _legacy_doc(row_id)) in stored
        }

    # Every encoding of "this entry says nothing", including the two this PR made
    # legal on purpose and the one a client typo produces.
    NOTHING: ClassVar[list] = [{}, {'notes': None}, {'impact': None},
                               {'impact': None, 'notes': None}, {'impactt': 5}]

    @pytest.mark.parametrize('entry', NOTHING)
    def test_the_legacy_value_survives_a_save_that_scored_nothing(
        self, api_gateway_event, lambda_context, entry
    ):
        table = self._with_legacy()

        status, _ = _patch_scores(table, api_gateway_event, lambda_context,
                                  {'row-1': entry}, subject='alice')

        assert status == 200
        assert self._legacy_map(table)['row-1'] == self.LEGACY

    @pytest.mark.parametrize('entry', NOTHING)
    def test_another_reviewer_still_reads_the_value_through(
        self, api_gateway_event, lambda_context, entry
    ):
        """Asserted through the route, because the page is where the loss showed:
        bob's rows went from scored to unscored because alice sent an empty
        object."""
        table = self._with_legacy()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': entry}, subject='alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='bob')

        assert body['scores']['row-1']['impact'] == self.LEGACY['impact']

    @pytest.mark.parametrize('entry', NOTHING)
    def test_the_document_is_still_scored_in_the_aggregate(
        self, api_gateway_event, lambda_context, entry
    ):
        """Absence from `aggregates` is what `PrioritizationAggregate` documents as
        "nobody scored this", so losing the row is a second, separate lie."""
        table = self._with_legacy()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': entry}, subject='alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='bob')

        assert body['aggregates']['row-1']['reviewer_count'] == 1
        assert body['aggregates']['row-1']['impact'] == self.LEGACY['impact']

    @pytest.mark.parametrize('entry', NOTHING)
    def test_no_removal_is_even_attempted(
        self, api_gateway_event, lambda_context, entry
    ):
        """The state assertions above would also pass if the removal were attempted
        and merely failed its condition. The write must not be issued at all — it is
        a round trip per document, and one that could succeed."""
        table = self._with_legacy()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': entry}, subject='alice')

        removals = [c for c in table.update_item_calls
                    if c['Key']['sk'] == LEGACY_SK]
        assert removals == []

    def test_a_notes_only_save_does_not_supersede_a_score(
        self, api_gateway_event, lambda_context
    ):
        """A note is not a newer opinion about the SCORE.

        This is where the fix diverges from `_expresses_something`, which is the
        read-through's wider question ("any axis, OR a note"). Gating the migration
        on that predicate would leave the same defect open for the one encoding the
        shipped page can produce from its own textarea: a reviewer typing a comment
        would delete a pre-ballot score they never touched."""
        table = self._with_legacy()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'notes': 'needs discussion'}}, subject='alice')

        assert self._legacy_map(table)['row-1'] == self.LEGACY
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='bob')
        assert body['aggregates']['row-1']['reviewer_count'] == 1

    @pytest.mark.parametrize('entry', [
        {'impact': 5},
        {'impact': 0},
        {'impact': 5, 'time_to_market': 4, 'confidence': 3, 'strategic_fit': 2},
        {'impact': 2, 'notes': 'and a note'},
    ])
    def test_a_save_that_scored_something_still_migrates(
        self, api_gateway_event, lambda_context, entry
    ):
        """The other half of the gate, and the one that makes the tests above
        meaningful: migrate-on-write still happens for a real vote, including a
        partial one and a deliberate zero.

        Without this, "the legacy entry survives" would be satisfied by a fix that
        simply never migrates."""
        table = self._with_legacy()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': entry}, subject='alice')

        assert 'row-1' not in self._legacy_map(table)


class TestAFailedMigrationCannotDoubleCountAReviewer:
    """`_drop_legacy_score` is best-effort by design, so the no-double-count
    guarantee cannot rest on it.

    Fail only the REMOVE and the legacy value stayed beside the ballot that
    replaced it: one human reported `reviewer_count: 2` and a non-zero
    `score_spread` — her own superseded pre-ballot value read as a second reviewer
    disagreeing with her, in the two fields whose contracts are "reviewers who
    scored something" and "zero means agreement". Sticky, too: nothing retries the
    removal, so every later GET repeated it.

    The read is what prevents the double count now. These tests therefore run with
    the removal BROKEN, which is the state the best-effort decision accepts."""

    LEGACY: ClassVar[dict] = {'impact': 4, 'time_to_market': 3, 'confidence': 5,
                              'strategic_fit': 4}

    @classmethod
    def _with_failing_removal(cls):
        table = FakeAggregatesTable(
            items=[{
                'pk': PARTITION, 'sk': LEGACY_SK,
                'scores': {_legacy_doc('row-1'): dict(cls.LEGACY)},
            }],
        ).seed_rows('row-1', document_ids=[_legacy_doc('row-1')])
        real_update = table.update_item

        def update(**kwargs):
            if kwargs['Key']['sk'] == LEGACY_SK:
                raise ClientError(
                    {'Error': {'Code': 'ProvisionedThroughputExceededException'}},
                    'UpdateItem',
                )
            return real_update(**kwargs)

        table.update_item = update
        return table

    def test_one_reviewer_is_counted_once(self, api_gateway_event, lambda_context):
        table = self._with_failing_removal()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'impact': 5, 'time_to_market': 5,
                                 'confidence': 5, 'strategic_fit': 5}}, subject='alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['reviewer_count'] == 1

    def test_one_reviewer_does_not_disagree_with_herself(
        self, api_gateway_event, lambda_context
    ):
        table = self._with_failing_removal()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'impact': 5, 'time_to_market': 5,
                                 'confidence': 5, 'strategic_fit': 5}}, subject='alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['score_spread'] == 0.0

    def test_the_means_are_the_reviewers_own_numbers(
        self, api_gateway_event, lambda_context
    ):
        """`reviewer_count: 1` alone would also be satisfied by counting the legacy
        entry INSTEAD of the ballot. The numbers have to be hers."""
        table = self._with_failing_removal()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'impact': 5, 'time_to_market': 5,
                                 'confidence': 5, 'strategic_fit': 5}}, subject='alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['impact'] == 5
        assert body['aggregates']['row-1']['time_to_market'] == 5

    def test_the_stale_value_is_not_read_through_to_anyone_else(
        self, api_gateway_event, lambda_context
    ):
        """The read-through is the other half of the same response, and it had the
        same seam: a reviewer with no ballot of their own would be handed a value
        the aggregate had already stopped counting — so `scores` and `aggregates`
        would disagree about the same document, and only when a write nobody was
        told about had failed."""
        table = self._with_failing_removal()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'impact': 5, 'time_to_market': 5,
                                 'confidence': 5, 'strategic_fit': 5}}, subject='alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='bob')

        assert 'row-1' not in body['scores']
        assert body['aggregates']['row-1']['reviewer_count'] == 1

    def test_a_second_real_reviewer_is_still_two(
        self, api_gateway_event, lambda_context
    ):
        """Positive control: suppressing the legacy entry must not suppress a real
        second ballot, or `reviewer_count: 1` would be right for the wrong reason."""
        table = self._with_failing_removal()
        full = {'impact': 5, 'time_to_market': 5, 'confidence': 5, 'strategic_fit': 5}
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': full}, subject='alice')
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {**full, 'impact': 1}}, subject='bob')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-1']['reviewer_count'] == 2
        assert body['aggregates']['row-1']['score_spread'] > 0

    def test_a_notes_only_ballot_does_not_suppress_the_legacy_value(
        self, api_gateway_event, lambda_context
    ):
        """Superseded means SOMEBODY VOTED, not "a ballot exists".

        Suppressing on the mere existence of a ballot — the narrower fix — would let
        a reviewer's comment silently remove a pre-ballot score from the aggregate,
        which is the same loss as the migration finding with the delete replaced by a
        filter."""
        table = self._with_failing_removal()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'notes': 'needs discussion'}}, subject='alice')
        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='bob')

        assert body['aggregates']['row-1']['reviewer_count'] == 1
        assert body['aggregates']['row-1']['impact'] == self.LEGACY['impact']

    def test_the_reviewer_is_still_told_the_save_succeeded(
        self, api_gateway_event, lambda_context
    ):
        """The ballot is durable before the removal runs, so a failure there must
        not surface — the round-2 decision this fix is built on top of, re-asserted
        here so a change to one is not mistaken for permission to change the
        other."""
        table = self._with_failing_removal()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'row-1': {'impact': 5}}, subject='alice',
        )

        assert status == 200
        assert body['updated_count'] == 1


class TestAnOverLongNoteIsRefusedRatherThanTruncated:
    """Truncating to MAX_BALLOT_NOTE_LEN discarded the tail of a durable decision
    record and answered 200.

    It is the same silent loss the non-string refusal was introduced to prevent, on
    the same field — and unlike an out-of-range axis there is no "bounded either
    way" defence, because the discarded characters are content rather than a number
    pushed to the nearest legal value. A justification runs long exactly when it is
    doing the most work, and the conclusion sits at the end.

    Asserted across TWO saves against ONE table for the same reason the non-string
    tests are: after a first save there is nothing to lose, so a single-save
    assertion passes whether the code refuses or truncates."""

    @staticmethod
    def _over_long():
        from projects_handler import MAX_BALLOT_NOTE_LEN

        return 'A' * MAX_BALLOT_NOTE_LEN + ' CONCLUSION: do not ship'

    def test_an_over_long_note_is_refused(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()

        status, body = _patch_scores(table, api_gateway_event, lambda_context,
                                     {'row-1': {'notes': self._over_long()}},
                                     subject='alice')

        assert status == 400
        assert 'notes' in body['error']

    def test_the_previously_stored_note_is_unchanged(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'notes': 'ship this in Q3'}}, subject='alice')

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'notes': self._over_long()}}, subject='alice')

        assert table.ballot('row-1', 'alice')['notes'] == 'ship this in Q3'

    def test_nothing_is_written_at_all(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'notes': 'ship this in Q3'}}, subject='alice')
        writes_before = len(table.update_item_calls)

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'notes': self._over_long()}}, subject='alice')

        assert len(table.update_item_calls) == writes_before

    def test_an_over_long_note_cannot_half_persist_a_multi_document_save(
        self, api_gateway_event, lambda_context
    ):
        """Refused in the up-front pass, so the sibling document in the same body is
        not written either. That is the property the up-front pass exists for, and
        the reason the check does not live at the write."""
        table = FakeAggregatesTable()

        status, _ = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'row-1': AXES, 'row-2': {'notes': self._over_long()}}, subject='alice',
        )

        assert status == 400
        assert table.ballot_keys == []

    def test_the_refusal_names_the_bound_without_echoing_the_note(
        self, api_gateway_event, lambda_context
    ):
        """The bound is the part a caller can act on; the note is unbounded caller
        input a response body gains nothing by repeating — and a reviewer's
        justification is the last thing that should be echoed into a log or an error
        surface."""
        from projects_handler import MAX_BALLOT_NOTE_LEN

        table = FakeAggregatesTable()

        _, body = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'row-1': {'notes': 'B' * (MAX_BALLOT_NOTE_LEN + 1) + 'SECRET-TAIL'}},
            subject='alice',
        )

        assert str(MAX_BALLOT_NOTE_LEN) in body['error']
        assert 'SECRET-TAIL' not in json.dumps(body)

    def test_the_note_bound_is_the_one_the_page_enforces(self):
        """A server bound the page does not know about becomes a save that appears
        to do nothing: `fetchApi` discards the response body, so the page cannot
        report a refusal it can now receive. The textarea's `maxLength` is what keeps
        the shipped page from composing a body this route refuses, and
        `test_prioritization_note_bound_lockstep.py` is what keeps the two numbers
        equal."""
        from pathlib import Path

        lockstep = Path(__file__).with_name('test_prioritization_note_bound_lockstep.py')
        assert lockstep.is_file(), (
            'the note bound is duplicated in the frontend; the lockstep test that '
            'pins the pair must exist'
        )


class TestUpdatedCountCountsBallotsNotKeys:
    """`updated_count` incremented once per key written, including entries that
    stored nothing a reviewer entered.

    That is the unit the duplicate-key refusal in the same function is justified on
    — its comment says refusing keeps the counter "counted in the unit they claim —
    ballots written, not keys received" — so two keys collapsing onto one ballot was
    closed while one key writing no value was not.

    MAX_BALLOTS_PER_SAVE deliberately stays in the OTHER unit: it bounds round
    trips, and an entry that expresses nothing still costs its `update_item`."""

    def test_a_body_of_empty_entries_reports_no_ballots(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()

        status, body = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'row-1': {}, 'row-2': {}, 'row-3': {}}, subject='alice',
        )

        assert status == 200
        assert body['updated_count'] == 0

    def test_those_ballots_are_still_stamped(self, api_gateway_event, lambda_context):
        """The count changes; the write does not. An empty entry is still a legal
        PATCH that records who looked at the document and when."""
        table = FakeAggregatesTable()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {}, 'row-2': {}}, subject='alice')

        assert len(table.ballot_keys) == 2
        assert table.ballot('row-1', 'alice')['reviewer'] == 'user:alice'

    @pytest.mark.parametrize('entry', [{'notes': None}, {'impact': None}, {'typo': 5}])
    def test_every_encoding_of_nothing_counts_as_nothing(
        self, api_gateway_event, lambda_context, entry
    ):
        table = FakeAggregatesTable()

        _, body = _patch_scores(table, api_gateway_event, lambda_context,
                                {'row-1': entry}, subject='alice')

        assert body['updated_count'] == 0

    def test_clearing_a_note_is_a_ballot_written(
        self, api_gateway_event, lambda_context
    ):
        """The counter's question is "did this store something the reviewer
        entered?", NOT `_is_a_vote`'s "did they score?". Deliberately clearing a
        note is a real change to a real ballot, so counting 0 for it would be the
        same dishonesty pointing the other way."""
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {'notes': 'ship this in Q3'}}, subject='alice')

        _, body = _patch_scores(table, api_gateway_event, lambda_context,
                               {'row-1': {'notes': ''}}, subject='alice')

        assert body['updated_count'] == 1
        assert table.ballot('row-1', 'alice')['notes'] == ''

    def test_a_mixed_body_counts_only_the_entries_that_stored_something(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()

        _, body = _patch_scores(
            table, api_gateway_event, lambda_context,
            {'row-1': AXES, 'row-2': {}, 'row-3': {'notes': 'thinking'}},
            subject='alice',
        )

        assert body['updated_count'] == 2

    def test_an_ordinary_save_still_counts_every_document(
        self, api_gateway_event, lambda_context
    ):
        """What the shipped page sends: `getScore` seeds every entry with all four
        axes, so no browser body is affected by this change."""
        table = FakeAggregatesTable()

        _, body = _patch_scores(table, api_gateway_event, lambda_context,
                                {'row-1': AXES, 'row-2': AXES}, subject='alice')

        assert body['updated_count'] == 2

    def test_an_empty_entry_writes_only_the_stamp_fields(
        self, api_gateway_event, lambda_context
    ):
        """The counter subtracts BALLOT_STAMP_FIELDS from the fields the update
        assigns, so a new always-written field that is not listed there would make
        every entry look like a ballot. This is the assertion that fails if the two
        drift."""
        from projects_handler import BALLOT_STAMP_FIELDS

        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {}}, subject='alice')

        assigned = set(table.update_item_calls[0]['ExpressionAttributeNames'].values())
        assert assigned == set(BALLOT_STAMP_FIELDS)

    def test_the_save_bound_still_counts_keys(self, api_gateway_event, lambda_context):
        """The bound and the counter are in different units ON PURPOSE, because they
        describe different work: the bound protects the Lambda from round trips an
        empty entry still costs, the counter describes what the caller achieved."""
        from projects_handler import MAX_BALLOTS_PER_SAVE

        table = FakeAggregatesTable()
        at_the_bound = {f'doc-{i}': {} for i in range(MAX_BALLOTS_PER_SAVE)}
        over_the_bound = {f'doc-{i}': {} for i in range(MAX_BALLOTS_PER_SAVE + 1)}

        ok, body = _patch_scores(table, api_gateway_event, lambda_context, at_the_bound)
        refused, _ = _patch_scores(
            FakeAggregatesTable(), api_gateway_event, lambda_context, over_the_bound,
        )

        assert (ok, body['updated_count']) == (200, 0)
        assert refused == 400


class TestAColonInTheSubjectIsNotTheDelimiter:
    """'#' is refused because it is PARSED; ':' is not, because it is only composed.

    `_parse_ballot_sk` splits the sort key on '#', so a '#' inside a subject moves
    where the document id is taken to end — the silent corruption round 4 closed.
    Nothing splits on ':': `_reviewer_segment` writes it and the whole segment is
    compared as one string, so a subject containing one round-trips intact.

    Refusing it anyway would not be free. Identity providers do mint namespaced
    subjects, and a guard would lock out a whole deployment to protect an invariant
    that already holds."""

    def test_a_subject_containing_a_colon_is_accepted(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()

        status, body = _patch_scores(table, api_gateway_event, lambda_context,
                                     {'row-1': AXES}, subject='tenant:alice')

        assert status == 200
        assert body['updated_count'] == 1

    def test_that_reviewer_reads_back_their_own_ballot(
        self, api_gateway_event, lambda_context
    ):
        """The property a '#' breaks and a ':' does not: the ballot the write landed
        on is the ballot the read addresses."""
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': AXES}, subject='tenant:alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context,
                             subject='tenant:alice')

        assert body['scores']['row-1']['impact'] == AXES['impact']

    def test_no_phantom_document_row_appears(self, api_gateway_event, lambda_context):
        """A mis-split key produced an `aggregates` row under a document id that
        never existed, which `PrioritizationAggregate` tells consumers means
        somebody scored it."""
        table = FakeAggregatesTable()
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': AXES}, subject='tenant:alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context,
                             subject='tenant:alice')

        assert list(body['aggregates']) == ['row-1']

    def test_two_tenants_with_the_same_local_name_stay_distinct(
        self, api_gateway_event, lambda_context
    ):
        table = FakeAggregatesTable()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {**AXES, 'impact': 5}}, subject='tenant-a:alice')
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-1': {**AXES, 'impact': 1}}, subject='tenant-b:alice')

        _, body = _get_scores(table, api_gateway_event, lambda_context,
                             subject='tenant-a:alice')
        assert body['scores']['row-1']['impact'] == 5
        assert body['aggregates']['row-1']['reviewer_count'] == 2


class FakeProjectsTable:
    """The projects table, only as far as a row composition reads it.

    One paginated `query` on a project's partition, which is exactly what
    `_project_documents` issues. Nothing else, so a composition that reached for
    another read would fail here rather than pass against a permissive fake.

    `page_size` is what makes the pagination observable, and it mirrors
    `FakeAggregatesTable`'s: unset, the whole partition comes back in one page and
    no `LastEvaluatedKey` is offered, which is the shape every test that does not
    care about paging already relies on. Set, a partition longer than one page
    comes back cut, exactly as DynamoDB cuts a query at 1MB — and a reader that
    ignores the continuation key sees a project it has only partly read.
    """

    def __init__(self, items=None, page_size=None):
        self.items = [dict(item) for item in (items or [])]
        self.page_size = page_size
        self.query_calls = []

    def query(self, **kwargs):
        self.query_calls.append(kwargs)
        # The condition is `Key('pk').eq(f'PROJECT#{project_id}')`; read the value
        # back out of it rather than accepting every query, so a composition
        # reading the WRONG project's partition fails here. Asked on EVERY page, so
        # a continuation that lost the project id fails here too.
        expression = kwargs['KeyConditionExpression']
        wanted = expression._values[1]
        items = [item for item in self.items if item['pk'] == wanted]
        start = kwargs.get('ExclusiveStartKey')
        if start:
            items = items[[item['sk'] for item in items].index(start['sk']) + 1:]
        if self.page_size and len(items) > self.page_size:
            page = items[:self.page_size]
            return {'Items': page,
                    'LastEvaluatedKey': {'pk': wanted, 'sk': page[-1]['sk']}}
        return {'Items': items}


def project_document(project_id, sk_prefix, document_id, created_at):
    return {
        'pk': f'PROJECT#{project_id}',
        'sk': f'{sk_prefix}{document_id}',
        'document_id': document_id,
        'created_at': created_at,
    }


def project_meta(project_id):
    return {'pk': f'PROJECT#{project_id}', 'sk': 'META', 'project_id': project_id}


def _create_row(aggregates, projects, api_gateway_event, lambda_context,
                body=None, subject='reviewer-1', raw_body=None):
    """`raw_body` puts bytes on the wire as they arrive, bypassing `body`.

    Needed because the event fixture serialises whatever it is handed, so a body
    that is not JSON at all cannot be expressed as `body=` — `'{not json'` would go
    out as the valid JSON string `'"{not json"'`. Same technique
    `test_ballots_handler` uses for the non-object bodies of its own submit route.
    """
    from projects_handler import lambda_handler

    event = api_gateway_event(
        method='POST', path='/projects/prioritization/rows', body=body,
    )
    if raw_body is not None:
        event['body'] = raw_body
    event['requestContext']['authorizer']['claims']['sub'] = subject
    with (
        patch('projects_handler.get_aggregates_table', return_value=aggregates),
        patch('projects_handler.get_projects_table', return_value=projects),
    ):
        response = lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])


class TestADefaultRowExistsPerProjectWithoutASetupStep:
    """A project that has scorable documents ends up with exactly ONE row, and
    nobody performs a setup step to get it.

    The idempotence is the load-bearing half. A minted id plus a read-then-write
    would leave two callers racing on the same project with TWO default rows, each
    collecting its own ballots — the split-identity defect this whole change exists
    to remove, reintroduced one level up.
    """

    @staticmethod
    def _projects(project_id='p1'):
        return FakeProjectsTable([
            project_meta(project_id),
            project_document(project_id, 'PRD#', 'prd-1', '2026-08-01T00:00:00+00:00'),
            project_document(project_id, 'PRFAQ#', 'prfaq-1', '2026-08-02T00:00:00+00:00'),
            project_document(project_id, 'PROTOTYPE#', 'proto-old', '2026-08-03T00:00:00+00:00'),
            project_document(project_id, 'PROTOTYPE#', 'proto-new', '2026-08-04T00:00:00+00:00'),
            project_document(project_id, 'RESEARCH#', 'research-1', '2026-08-05T00:00:00+00:00'),
        ])

    def test_a_project_with_scorable_documents_gets_one_row_holding_them(
        self, api_gateway_event, lambda_context
    ):
        aggregates = FakeAggregatesTable()

        status, body = _create_row(aggregates, self._projects(), api_gateway_event,
                                   lambda_context, body={'project_id': 'p1'})

        assert status == 200
        assert body['created'] is True
        assert sorted(body['row']['document_ids']) == ['prd-1', 'prfaq-1']
        assert body['row']['project_id'] == 'p1'
        assert body['row']['is_default'] is True

    def test_a_revised_prd_puts_only_its_latest_revision_on_the_row(
        self, api_gateway_event, lambda_context
    ):
        """LATEST PER TYPE, not every revision. A superseded draft is not a separate
        thing to score — it is the same thing, earlier — and putting all four
        revisions on the row would give the collapsed header five type badges and
        make the room's copy say "5 documents, one ballot" about one idea. That is
        the defect this whole change removes, one level down."""
        projects = FakeProjectsTable([
            project_meta('p1'),
            project_document('p1', 'PRD#', 'prd-v1', '2026-08-01T00:00:00+00:00'),
            project_document('p1', 'PRD#', 'prd-v2', '2026-08-05T00:00:00+00:00'),
            project_document('p1', 'PRD#', 'prd-v3', '2026-08-03T00:00:00+00:00'),
            project_document('p1', 'PRFAQ#', 'prfaq-old', '2026-08-02T00:00:00+00:00'),
            project_document('p1', 'PRFAQ#', 'prfaq-new', '2026-08-04T00:00:00+00:00'),
        ])
        aggregates = FakeAggregatesTable()

        _, body = _create_row(aggregates, projects, api_gateway_event,
                              lambda_context, body={'project_id': 'p1'})

        # Newest of each, and not by document order in the partition: `prd-v2` is
        # newer than `prd-v3` while sorting earlier by id.
        assert body['row']['document_ids'] == ['prd-v2', 'prfaq-new']

    def test_the_stored_composition_is_ordered_by_type_not_by_recency(
        self, api_gateway_event, lambda_context
    ):
        """`document_ids` is stored in TYPE order, so two projects holding the same
        two types compose identically whichever document was generated last.

        A property of the STORED record, and deliberately not justified by what the
        page renders: `collectRows` re-sorts a row's resolved documents newest-first,
        and the badges and the row's title follow THAT order — so nothing downstream
        may rely on this one. What it buys is a record two projects can be compared
        by, which is what lets the two assertions below differ only in their ids."""
        aggregates = FakeAggregatesTable()

        _, prfaq_newer = _create_row(aggregates, FakeProjectsTable([
            project_meta('p1'),
            project_document('p1', 'PRD#', 'prd-1', '2026-08-01T00:00:00+00:00'),
            project_document('p1', 'PRFAQ#', 'prfaq-1', '2026-08-09T00:00:00+00:00'),
        ]), api_gateway_event, lambda_context, body={'project_id': 'p1'})
        _, prd_newer = _create_row(FakeAggregatesTable(), FakeProjectsTable([
            project_meta('p2'),
            project_document('p2', 'PRD#', 'prd-2', '2026-08-09T00:00:00+00:00'),
            project_document('p2', 'PRFAQ#', 'prfaq-2', '2026-08-01T00:00:00+00:00'),
        ]), api_gateway_event, lambda_context, body={'project_id': 'p2'})

        assert prfaq_newer['row']['document_ids'] == ['prd-1', 'prfaq-1']
        assert prd_newer['row']['document_ids'] == ['prd-2', 'prfaq-2']

    def test_a_project_holding_one_scorable_type_gets_a_single_document_row(
        self, api_gateway_event, lambda_context
    ):
        """The one-row-per-project rule does not require two documents to be worth a
        row — most projects start with a PRD alone."""
        aggregates = FakeAggregatesTable()

        _, body = _create_row(aggregates, FakeProjectsTable([
            project_meta('p1'),
            project_document('p1', 'PRD#', 'prd-1', '2026-08-01T00:00:00+00:00'),
            project_document('p1', 'PRD#', 'prd-2', '2026-08-02T00:00:00+00:00'),
        ]), api_gateway_event, lambda_context, body={'project_id': 'p1'})

        assert body['row']['document_ids'] == ['prd-2']

    def test_a_document_with_no_readable_timestamp_loses_to_one_that_has_it(
        self, api_gateway_event, lambda_context
    ):
        """"Latest" has to decide something for a stored document missing
        `created_at`. Oldest is the right way for an unreadable timestamp to lose:
        the alternative puts an undatable draft on the row over a dated one."""
        undated = project_document('p1', 'PRD#', 'prd-undated', '')
        del undated['created_at']
        aggregates = FakeAggregatesTable()

        _, body = _create_row(aggregates, FakeProjectsTable([
            project_meta('p1'),
            undated,
            project_document('p1', 'PRD#', 'prd-dated', '2026-08-01T00:00:00+00:00'),
        ]), api_gateway_event, lambda_context, body={'project_id': 'p1'})

        assert body['row']['document_ids'] == ['prd-dated']

    def test_two_same_type_documents_sharing_a_timestamp_keep_the_earlier_key(
        self, api_gateway_event, lambda_context
    ):
        """Two PRDs generated in the same second have to resolve to ONE of them, and
        which one is frozen into the row forever: the create is idempotent on the row
        id and there is no recompose route, so every ballot cast afterwards describes
        whichever document this tie handed back.

        The incumbent wins — the first the query returned, which is the lower sort
        key, since `sk` carries the document id and DynamoDB returns a partition in
        sort-key order. Pinned because the comparison is a strict `>` whose tie
        behaviour is invisible: relaxing it to `>=` flips the frozen document to the
        LAST one read while every other composition test still passes, so nothing
        else in this file would notice a project's row quietly changing what it is
        about.

        Distinct from its absent-timestamp sibling above: that one asks which of an
        undated and a dated document wins, this one asks what happens when neither
        is newer."""
        aggregates = FakeAggregatesTable()

        _, body = _create_row(aggregates, FakeProjectsTable([
            project_meta('p1'),
            project_document('p1', 'PRD#', 'prd-a', '2026-08-01T00:00:00+00:00'),
            project_document('p1', 'PRD#', 'prd-b', '2026-08-01T00:00:00+00:00'),
        ]), api_gateway_event, lambda_context, body={'project_id': 'p1'})

        assert body['row']['document_ids'] == ['prd-a']

    def test_only_scorable_documents_and_the_latest_prototype_are_on_it(
        self, api_gateway_event, lambda_context
    ):
        """A prototype rides along as CONTEXT in its own field — the newest one —
        and research is neither scored nor carried."""
        aggregates = FakeAggregatesTable()

        _, body = _create_row(aggregates, self._projects(), api_gateway_event,
                              lambda_context, body={'project_id': 'p1'})

        assert 'research-1' not in body['row']['document_ids']
        assert 'proto-new' not in body['row']['document_ids']
        assert body['row']['prototype_id'] == 'proto-new'

    def test_asking_twice_yields_the_same_row_rather_than_a_second_one(
        self, api_gateway_event, lambda_context
    ):
        aggregates = FakeAggregatesTable()

        _, first = _create_row(aggregates, self._projects(), api_gateway_event,
                               lambda_context, body={'project_id': 'p1'})
        status, second = _create_row(aggregates, self._projects(), api_gateway_event,
                                     lambda_context, body={'project_id': 'p1'})

        assert status == 200
        assert second['created'] is False
        assert second['row']['row_id'] == first['row']['row_id']
        assert len([sk for (_, sk) in aggregates.items if sk.startswith('ROW#')]) == 1

    def test_the_second_ask_is_refused_by_the_database_not_by_a_prior_read(
        self, api_gateway_event, lambda_context
    ):
        """The idempotence has to be a CONDITION, because two callers racing both
        read "no row" and both write. Pinned on the write itself: a read-then-write
        would leave this assertion with nothing to find."""
        aggregates = FakeAggregatesTable()

        _create_row(aggregates, self._projects(), api_gateway_event, lambda_context,
                    body={'project_id': 'p1'})

        assert aggregates.put_item_calls
        for call in aggregates.put_item_calls:
            assert 'attribute_not_exists' in call['ConditionExpression']

    def test_the_stored_composition_wins_over_what_latest_would_pick_today(
        self, api_gateway_event, lambda_context
    ):
        """"Latest of each type" composes a row ONCE. Generating a new PRD must not
        rewrite what an existing row's ballots describe — so the second ask reads the
        stored row back rather than answering the freshly composed one."""
        aggregates = FakeAggregatesTable()
        _create_row(aggregates, self._projects(), api_gateway_event, lambda_context,
                    body={'project_id': 'p1'})

        grown = self._projects()
        grown.items.append(
            project_document('p1', 'PRD#', 'prd-2', '2026-09-01T00:00:00+00:00'),
        )
        _, body = _create_row(aggregates, grown, api_gateway_event, lambda_context,
                              body={'project_id': 'p1'})

        assert 'prd-2' not in body['row']['document_ids']
        assert sorted(body['row']['document_ids']) == ['prd-1', 'prfaq-1']

    def test_a_project_with_no_scorable_document_gets_no_row(
        self, api_gateway_event, lambda_context
    ):
        """The page keeps its existing invitation to create a PRD or a PR/FAQ, so a
        row with nothing to score must not be created for it to render."""
        projects = FakeProjectsTable([
            project_meta('p2'),
            project_document('p2', 'RESEARCH#', 'research-1', '2026-08-01T00:00:00+00:00'),
            project_document('p2', 'PROTOTYPE#', 'proto-1', '2026-08-02T00:00:00+00:00'),
        ])
        aggregates = FakeAggregatesTable()

        status, body = _create_row(aggregates, projects, api_gateway_event,
                                   lambda_context, body={'project_id': 'p2'})

        assert status == 400
        assert 'no PRD or PR/FAQ' in body['error']
        assert aggregates.put_item_calls == []

    def test_a_project_that_does_not_exist_is_a_404(self, api_gateway_event, lambda_context):
        aggregates = FakeAggregatesTable()

        status, _ = _create_row(aggregates, FakeProjectsTable([]), api_gateway_event,
                                lambda_context, body={'project_id': 'nope'})

        assert status == 404
        assert aggregates.put_item_calls == []

    @pytest.mark.parametrize('project_id,expected', [
        (None, 'required'),
        ('', 'required'),
        ('p#1', "must not contain '#'"),
        ('x' * 300, 'at most 256 characters'),
    ])
    def test_a_project_id_that_cannot_name_a_row_is_refused(
        self, api_gateway_event, lambda_context, project_id, expected
    ):
        """The row id is DERIVED from the project id and goes into a sort key, so the
        no-'#' rule every other half of a ballot key is held to is checked here —
        which is what lets the save path refuse a '#' without having to explain where
        one could have come from."""
        aggregates = FakeAggregatesTable()

        status, body = _create_row(aggregates, FakeProjectsTable([]), api_gateway_event,
                                   lambda_context, body={'project_id': project_id})

        assert status == 400
        assert expected in body['error']
        assert aggregates.put_item_calls == []

    def test_the_row_never_carries_an_expiry(self, api_gateway_event, lambda_context):
        """The aggregates table expires anything carrying `ttl`. A row is as durable
        as the ballots keyed to it — an expiring row would take a whole project's
        team score off the page weeks after the meeting."""
        aggregates = FakeAggregatesTable()

        _create_row(aggregates, self._projects(), api_gateway_event, lambda_context,
                    body={'project_id': 'p1'})

        for call in aggregates.put_item_calls:
            assert 'ttl' not in call['Item']

    def test_a_ballot_on_that_row_is_keyed_to_it_and_reads_back(
        self, api_gateway_event, lambda_context
    ):
        """End to end, in the unit that matters: the row the create route produced is
        the row a save addresses and the read answers about."""
        aggregates = FakeAggregatesTable()
        _, created = _create_row(aggregates, self._projects(), api_gateway_event,
                                 lambda_context, body={'project_id': 'p1'})
        row_id = created['row']['row_id']

        _patch_scores(aggregates, api_gateway_event, lambda_context,
                      {row_id: AXES}, subject='alice', seed_rows=False)
        _, body = _get_scores(aggregates, api_gateway_event, lambda_context, subject='alice')

        assert aggregates.ballot_keys == [f'BALLOT#{row_id}#user:alice']
        assert body['aggregates'][row_id]['reviewer_count'] == 1
        assert sorted(body['rows'][row_id]['document_ids']) == ['prd-1', 'prfaq-1']


class TestAPartlyReadProjectCannotBeFrozenIntoARow:
    """A composition reads a whole project or refuses. It never composes from part
    of one.

    DynamoDB cuts a query at 1MB, and project documents store their body inline, so
    a project with a few revisions and a product report reaches that without being
    unusual. What a short read costs here is not a hidden document: `sk` sorts
    ascending and `DOC#` precedes `META`, so truncation inside the document range
    makes the existence check answer 404 for a project that exists — and truncation
    later composes the row from a SUPERSEDED PRD, or refuses a project that has one.

    Then it sticks. The create is idempotent on the row id and there is no recompose
    route, so a row built from a short read cannot be corrected through the product,
    and every ballot cast on it afterwards describes documents nobody chose. That
    asymmetry between a refusal (retryable) and a wrong composition (permanent) is
    why the page bound raises instead of returning what it has.
    """

    @staticmethod
    def _one_document_per_page(project_id='p1', documents=()):
        return FakeProjectsTable([project_meta(project_id), *documents], page_size=1)

    def test_the_newest_prd_still_composes_the_row_when_it_arrives_on_a_later_page(
        self, api_gateway_event, lambda_context
    ):
        """The read has to follow the continuation key, and the test has to make the
        difference visible in the STORED row rather than in a page count: a reader
        that stopped at the first page would compose this project's row around its
        superseded PRD and freeze it there, which is a wrong row rather than a
        missing one."""
        projects = self._one_document_per_page(documents=[
            project_document('p1', 'PRD#', 'prd-old', '2026-08-01T00:00:00+00:00'),
            project_document('p1', 'PRD#', 'prd-new', '2026-08-09T00:00:00+00:00'),
        ])
        aggregates = FakeAggregatesTable()

        status, body = _create_row(aggregates, projects, api_gateway_event,
                                   lambda_context, body={'project_id': 'p1'})

        assert status == 200
        assert body['row']['document_ids'] == ['prd-new']
        assert len(projects.query_calls) == 3, 'the read stopped before the partition did'

    def test_a_project_whose_meta_arrives_after_its_documents_is_not_reported_missing(
        self, api_gateway_event, lambda_context
    ):
        """The worst shape a short read produces, because it does not look like a
        paging fault to anybody — it looks like a deleted project.

        Seeded in the sort-key order storage actually returns: `DOC#` precedes `META`,
        which precedes `PRD#`, so a project carrying generic documents hands back
        neither its own record nor its PRD until the pages before them are done. A
        reader stopping early answers 404 for a project sitting right there, and the
        page's own words for that are about a project that does not exist."""
        projects = FakeProjectsTable([
            project_document('p1', 'DOC#', 'doc-1', '2026-08-01T00:00:00+00:00'),
            project_meta('p1'),
            project_document('p1', 'PRD#', 'prd-1', '2026-08-02T00:00:00+00:00'),
        ], page_size=1)

        status, body = _create_row(FakeAggregatesTable(), projects, api_gateway_event,
                                   lambda_context, body={'project_id': 'p1'})

        assert status == 200
        assert body['row']['document_ids'] == ['prd-1']

    def test_the_read_asks_only_for_the_fields_the_composition_uses(
        self, api_gateway_event, lambda_context
    ):
        """Documents keep their body in `content`, so an unprojected read drags every
        full PRD, PR/FAQ, research doc and product report across the wire to pick two
        ids — and the page asks for one composition per project on mount. Asserted on
        the request rather than on the response, because projecting fewer fields
        changes nothing a composition returns: the cost is the whole observable
        effect."""
        projects = self._one_document_per_page(documents=[
            project_document('p1', 'PRD#', 'prd-old', '2026-08-01T00:00:00+00:00'),
            project_document('p1', 'PRD#', 'prd-new', '2026-08-09T00:00:00+00:00'),
        ])

        _create_row(FakeAggregatesTable(), projects, api_gateway_event,
                    lambda_context, body={'project_id': 'p1'})

        assert projects.query_calls
        for call in projects.query_calls:
            projected = {field.strip() for field in call['ProjectionExpression'].split(',')}
            assert projected == {'sk', 'document_id', 'created_at'}, (
                'the composition selects on the type, the id and the timestamp; '
                'anything else here is a document body being paid for'
            )

    def test_a_project_with_more_pages_than_the_bound_refuses_rather_than_composing(
        self, api_gateway_event, lambda_context
    ):
        """Past the bound there are two options and only one of them is recoverable.
        A refusal is a 500 the caller can retry against a fixed bound; a row composed
        from what arrived is frozen, and it is frozen holding a document chosen by
        where the page happened to end.

        The bound is read from the module rather than spelled here, so raising it
        moves this test with it instead of leaving a stale number asserting nothing.
        """
        from projects_handler import MAX_PROJECT_DOCUMENT_PAGES

        # One document per page, one more page than the read will follow.
        projects = self._one_document_per_page(documents=[
            project_document('p1', 'PRD#', f'prd-{n}', f'2026-08-01T00:00:{n:02d}+00:00')
            for n in range(1, MAX_PROJECT_DOCUMENT_PAGES + 1)
        ])
        aggregates = FakeAggregatesTable()

        status, body = _create_row(aggregates, projects, api_gateway_event,
                                   lambda_context, body={'project_id': 'p1'})

        assert status == 500
        assert 'Too many project documents' in body['error']
        assert aggregates.put_item_calls == [], 'a partial read must freeze no row'
        assert len(projects.query_calls) == MAX_PROJECT_DOCUMENT_PAGES, (
            'the bound is what stopped the read'
        )


class TestTheOneLegacyScoreLandsOnItsProjectsDefaultRow:
    """The single pre-ballot entry in the deployed partition is keyed by DOCUMENT.
    It must surface on the default row of the project owning that document rather
    than disappearing when the unit became the row.

    Nothing rewrites the stored map: the translation is a read-side one, so a
    rollback reads exactly what it wrote.
    """

    @staticmethod
    def _table(*, document_id='prd-1', **row_kwargs):
        return FakeAggregatesTable(items=[{
            'pk': PARTITION, 'sk': LEGACY_SK,
            'scores': {document_id: {'impact': 4, 'time_to_market': 3,
                                     'confidence': 5, 'strategic_fit': 4}},
        }]).seed_rows('row-p1', document_ids=['prd-1', 'prfaq-1'], **row_kwargs)

    def test_it_surfaces_on_the_row_holding_its_document(
        self, api_gateway_event, lambda_context
    ):
        table = self._table()

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores']['row-p1']['impact'] == 4
        assert body['aggregates']['row-p1']['reviewer_count'] == 1

    def test_it_does_not_surface_on_a_non_default_row(
        self, api_gateway_event, lambda_context
    ):
        """A phase-2 row for another combination may hold the same document.
        Attaching an unattributed pre-ballot value to every row holding it would
        multiply one old score into several unattributed ballots."""
        table = self._table(is_default=False)

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores'] == {}
        assert body['aggregates'] == {}

    def test_an_entry_whose_document_is_on_no_row_is_left_out_rather_than_invented(
        self, api_gateway_event, lambda_context
    ):
        """Not lost: nothing deletes it, and it surfaces as soon as the owning
        project's default row exists. The alternative is a score appearing under a
        row that does not contain the document it was cast on."""
        table = self._table(document_id='prd-elsewhere')

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores'] == {}
        assert body['aggregates'] == {}
        assert table.items[(PARTITION, LEGACY_SK)]['scores']['prd-elsewhere']

    def test_scoring_the_row_retires_the_value_for_every_document_it_holds(
        self, api_gateway_event, lambda_context
    ):
        """The map is document-keyed and the ballot is row-keyed, so "superseded"
        has to mean the documents THAT ROW holds — otherwise a value the read has
        already stopped counting sits in the map for a differently-composed row to
        pick up later."""
        table = FakeAggregatesTable(items=[{
            'pk': PARTITION, 'sk': LEGACY_SK,
            'scores': {'prd-1': {'impact': 4}, 'prfaq-1': {'impact': 2},
                       'prd-elsewhere': {'impact': 1}},
        }]).seed_rows('row-p1', document_ids=['prd-1', 'prfaq-1'])

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-p1': AXES}, subject='alice', seed_rows=False)

        stored = table.items[(PARTITION, LEGACY_SK)]['scores']
        assert 'prd-1' not in stored
        assert 'prfaq-1' not in stored
        assert 'prd-elsewhere' in stored, 'a save must not wipe another row\'s value'

    def test_the_row_is_counted_once_even_when_the_removal_fails(
        self, api_gateway_event, lambda_context
    ):
        """`_drop_legacy_scores_for_row` is best-effort like the removal it wraps, so
        the read's own suppression is what keeps the count honest — a reviewer's own
        superseded pre-ballot value must not read as a second reviewer disagreeing
        with her."""
        table = self._table()
        real_update = table.update_item

        def update(**kwargs):
            if kwargs['Key']['sk'] == LEGACY_SK:
                raise ClientError(
                    {'Error': {'Code': 'ProvisionedThroughputExceededException'}},
                    'UpdateItem',
                )
            return real_update(**kwargs)

        table.update_item = update
        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-p1': AXES}, subject='alice', seed_rows=False)

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-p1']['reviewer_count'] == 1
        assert body['aggregates']['row-p1']['score_spread'] == 0.0

    def test_a_save_that_scored_nothing_reads_no_row_and_removes_nothing(
        self, api_gateway_event, lambda_context
    ):
        """The row read costs a round trip, so it is only paid for by a save that
        actually scored — and a save expressing nothing must not delete a value it
        did not replace."""
        table = self._table()

        _patch_scores(table, api_gateway_event, lambda_context,
                      {'row-p1': {}}, subject='alice', seed_rows=False)

        assert table.get_item_calls == []
        assert table.items[(PARTITION, LEGACY_SK)]['scores']['prd-1']['impact'] == 4


class TestABodyThatIsNotAJsonObjectIsTheCallersMistake:
    """A malformed request is answered 400, on both routes that take a body.

    It used to be 500 `Internal server error`. `json_body` has two unhandled
    failures: unparseable JSON raises, and a body parsing to a LIST or a string
    passes an `or {}` guard truthy and then dies on `.get` with an `AttributeError`
    that has no registered handler. Probed before the fix, `[1, 2]`, `"hi"` and
    `{not json` each answered 500 on each route.

    Which is worse than a wrong number. A 500 tells the caller the fault is the
    service's, so a client retries a body that can never succeed; it puts a page
    error and an alarmable server-fault count on somebody's dashboard for a request
    the sender could have corrected; and the log carries a traceback rather than the
    one thing worth knowing, which is that the body was not an object.

    Both routes, because they are the two doors into the same partition and a
    contract that holds on one of them is a coincidence.
    """

    # The three shapes probed on the way in. Written as wire bytes rather than as
    # objects because the event fixture serialises what it is handed — `'{not json'`
    # passed as `body=` would arrive as the perfectly valid JSON string
    # `'"{not json"'` and never reach the parse failure at all.
    NON_OBJECT_BODIES: ClassVar[list] = ['[1, 2]', '"hi"', '{not json']

    @pytest.mark.parametrize('raw_body', NON_OBJECT_BODIES)
    def test_the_save_refuses_it_instead_of_reporting_a_server_fault(
        self, api_gateway_event, lambda_context, raw_body
    ):
        table = FakeAggregatesTable()
        event = _event(api_gateway_event, method='PATCH')
        event['body'] = raw_body

        status, body = _call(table, event, lambda_context)

        assert status == 400
        assert 'JSON' in body['error']
        assert table.update_item_calls == []
        assert table.ballot_keys == []

    @pytest.mark.parametrize('raw_body', NON_OBJECT_BODIES)
    def test_the_row_create_refuses_it_instead_of_reporting_a_server_fault(
        self, api_gateway_event, lambda_context, raw_body
    ):
        aggregates = FakeAggregatesTable()
        projects = FakeProjectsTable([project_meta('p1')])

        status, body = _create_row(aggregates, projects, api_gateway_event,
                                   lambda_context, raw_body=raw_body)

        assert status == 400
        assert 'JSON' in body['error']
        assert aggregates.put_item_calls == []
        assert projects.query_calls == [], 'a body that cannot name a project is not read for'


class TestTwoPreBallotValuesOnOneRowAreOneUnattributedOpinion:
    """A row holding two documents that each carry a pre-ballot value has ONE old
    opinion on it, not two reviewers.

    The pre-ballot item was a single shared map that every reviewer wrote into, with
    no attribution anywhere in it — that is why #333 replaced it. So a value on a
    project's PRD and another on its PR/FAQ is most plausibly one person scoring one
    idea twice, which is exactly the duplication the row unit exists to collapse.
    Before rows those were two separate rows, each reporting one reviewer and no
    spread.

    Counting them separately made the response say things nobody said, in the two
    fields whose documented meanings are "reviewers who scored something" and "zero
    means agreement" — and it made `scores` and `aggregates` disagree by
    construction, since the read-through took the first entry that expressed
    anything while the aggregate counted every entry as its own reviewer.
    """

    @staticmethod
    def _with_legacy(scores):
        """One default row holding BOTH documents, and whichever of them the
        pre-ballot map carries an entry for.

        The row's composition is fixed and the MAP is what each test varies, because
        the question here is which of a row's pre-ballot values is read — not which
        row they land on, which is the sibling class above.
        """
        table = FakeAggregatesTable(items=[{
            'pk': PARTITION, 'sk': LEGACY_SK, 'scores': dict(scores),
        }])
        return table.seed_rows('row-p1', document_ids=['doc-a', 'doc-b'])

    def test_two_values_on_one_row_report_one_reviewer_who_agreed_with_herself(
        self, api_gateway_event, lambda_context
    ):
        """The measured defect: a project whose PRD read all-5s and whose PR/FAQ read
        all-1s reported `reviewer_count: 2` and `score_spread: 4.0` — two reviewers at
        maximum disagreement about a row on which nobody ever disagreed. `score_spread`
        is the field a reader consults to decide whether a room needs to talk, so a
        manufactured 4.0 out of 5.0 sends people into a meeting about an agreement.

        The numbers read back are the first document's, in the order sorting fixed, so
        `scores` and `aggregates` describe the same opinion rather than one each."""
        table = self._with_legacy({
            'doc-a': {'impact': 5, 'time_to_market': 5, 'confidence': 5,
                      'strategic_fit': 5},
            'doc-b': {'impact': 1, 'time_to_market': 1, 'confidence': 1,
                      'strategic_fit': 1},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['aggregates']['row-p1']['reviewer_count'] == 1
        assert body['aggregates']['row-p1']['score_spread'] == 0.0
        assert body['aggregates']['row-p1']['impact'] == 5
        assert body['scores']['row-p1']['impact'] == 5

    @pytest.mark.parametrize('voting_document', ['doc-a', 'doc-b'])
    def test_the_value_that_scored_something_is_read_over_a_notes_only_sibling(
        self, api_gateway_event, lambda_context, voting_document
    ):
        """Choosing has to prefer the VOTE, and both document orders have to be tried
        to know that it does — pick the first entry that merely expressed something
        and the answer is right only when the vote happens to sort first.

        What losing costs is a real score leaving the response entirely: a notes-only
        entry is not a vote, so the row would drop out of `aggregates` altogether
        while `scores` showed the caller four zeros beside somebody's note. The old
        pre-ballot map has no attribution to reconstruct that number from later."""
        note_document = 'doc-b' if voting_document == 'doc-a' else 'doc-a'
        table = self._with_legacy({
            voting_document: {**AXES, 'notes': 'scored before the sliders'},
            note_document: {'notes': 'no numbers from me'},
        })

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores']['row-p1']['impact'] == AXES['impact']
        assert body['scores']['row-p1']['notes'] == 'scored before the sliders'
        assert body['aggregates']['row-p1']['reviewer_count'] == 1
        assert body['aggregates']['row-p1']['impact'] == AXES['impact']

    def test_the_single_value_a_deployed_partition_holds_still_reads_through(
        self, api_gateway_event, lambda_context
    ):
        """Choosing among a row's values must not cost the one case that is actually
        in the field. The deployed partition holds exactly ONE pre-ballot entry, so
        the multi-entry rule above is about being explainable — this is the path every
        real read takes, and it is on the document that sorts SECOND so that "the one
        that is there" cannot be confused with "the first one"."""
        table = self._with_legacy({'doc-b': dict(AXES)})

        _, body = _get_scores(table, api_gateway_event, lambda_context, subject='alice')

        assert body['scores']['row-p1']['impact'] == AXES['impact']
        assert body['aggregates']['row-p1']['reviewer_count'] == 1
        assert body['aggregates']['row-p1']['score_spread'] == 0.0


class TestTheRowCreateRouteIsNotShadowedByTheProjectUpsert:
    """`POST /projects/prioritization/rows` must reach its own handler.

    This module already carries a deliberate 405 on `PUT /projects/prioritization`
    whose whole justification is that the path otherwise falls through to
    `PUT /projects/<project_id>` and upserts a phantom project. Powertools sorts
    routes into static and dynamic buckets and resolves static first regardless of
    registration order, so the reasoning is about SEGMENT COUNT, not order — and the
    new route is the same class of risk one segment longer:
    `POST /projects/<project_id>/documents` and
    `POST /projects/<project_id>/personas` are both registered, both two segments
    under `/projects`, and both take a dynamic first segment that `prioritization`
    matches.

    Pinned by resolving the real path through the real resolver, not by reading the
    decorator: what a route table does with a path is the only thing that answers
    this, and every other assertion in this file about the create route calls the
    handler indirectly through exactly this resolution — so a shadowing bug would
    make them all fail confusingly rather than fail HERE with a reason.
    """

    def test_the_path_reaches_the_row_create_and_not_a_document_or_persona_route(
        self, api_gateway_event, lambda_context
    ):
        projects = FakeProjectsTable([
            project_meta('p1'),
            project_document('p1', 'PRD#', 'prd-1', '2026-08-01T00:00:00+00:00'),
        ])
        with (
            patch('projects_handler.create_document') as create_document,
            patch('projects_handler.update_project') as update_project,
        ):
            status, body = _create_row(
                FakeAggregatesTable(), projects, api_gateway_event, lambda_context,
                body={'project_id': 'p1'},
            )

        assert status == 200
        assert body['row']['document_ids'] == ['prd-1']
        assert create_document.call_count == 0, (
            'the path fell through to a document route; `prioritization` was read '
            'as a project id'
        )
        assert update_project.call_count == 0

    def test_a_project_named_prioritization_still_reaches_its_own_document_route(
        self, api_gateway_event, lambda_context
    ):
        """The mirror of the shadowing question: the literal route must not swallow
        a request meant for the dynamic one. `/projects/prioritization/rows` is the
        row create; a project genuinely called `prioritization` addresses its
        documents at `/projects/prioritization/documents`, which is a different
        two-segment path and still dynamic.

        Asserted POSITIVELY — the document route ran, with the project id it was
        addressed with — because the negative cannot fail. Powertools binds the
        handler OBJECT into its route table when the decorator runs at import, so
        patching `projects_handler.api_create_prioritization_row` afterwards replaces
        a module attribute the resolver never consults again: a mock recording zero
        calls is what a genuinely shadowed route would report too. `create_document`
        is different, and is the technique its sibling above relies on: it lives in
        `projects.py` and is looked up in this module's globals at CALL time, so the
        patch does intercept, and the interception is only reached by resolving this
        path to the route that takes a project id."""
        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/prioritization/documents',
            body={'title': 'x'},
            path_params={'project_id': 'prioritization'},
        )
        with (
            # The aggregates fake is here so that a path resolving to a prioritization
            # route fails on THIS assertion rather than against real AWS.
            patch('projects_handler.get_aggregates_table', return_value=FakeAggregatesTable()),
            patch('projects_handler.create_document',
                  return_value={'success': True}) as create_document,
        ):
            response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert create_document.call_count == 1, (
            'the literal route swallowed a request addressed to a project called '
            '`prioritization`'
        )
        assert create_document.call_args.args[0] == 'prioritization'

    def test_the_405_stub_still_covers_the_shorter_path(
        self, api_gateway_event, lambda_context
    ):
        """Adding a longer literal route under `/projects/prioritization` must not
        make the two-segment path resolvable again — that is the fall-through to
        `update_project('prioritization')` the stub exists to prevent, and it
        answers 200 while discarding the body."""
        with patch('projects_handler.update_project') as update_project:
            status, _ = _call(
                FakeAggregatesTable(),
                _event(api_gateway_event, method='PUT', body={'scores': {'row-1': AXES}}),
                lambda_context,
            )

        assert status == 405
        assert update_project.call_count == 0
