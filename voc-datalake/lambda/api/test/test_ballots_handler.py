"""
Behaviour of the anonymous ballot routes — the ONE public write path in this API.

`test_anon_ballot_key_lockstep.py` reads source text: it pins the constants two
separate Lambda bundles have to agree on. This file runs the handler, because the
things that make a public write path safe are behaviours and not spellings:

  * the CAP actually refuses the ballot that would exceed it, and refuses it in
    the DATABASE rather than in arithmetic that a room submitting at once loses;
  * a session that is closed, expired or absent is refused with the reason a
    phone can render, and refused BEFORE anything is written;
  * a correction is refused by the same authority a new ballot is — including in
    the window between the read and the write, which is the one a facilitator
    closing the vote lands in;
  * a ballot id minted on ANOTHER session is not a free pass to overwrite;
  * the session token — a bearer credential while the session is open — never
    reaches a log line in full;
  * a ballot never carries `ttl`, because the aggregates table expires anything
    that does and the team's score would quietly drain weeks later.

AWS is mocked at the import boundary (`ballots_handler.get_aggregates_table`),
the convention in the sibling handler tests. `FakeAggregatesTable` is not a
general DynamoDB: it implements exactly the conditional expressions these routes
write, so a change to one of those expressions has to be reflected here.
"""
import json
import re
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

SESSION_PK = 'VOTING_SESSION'
PRIORITIZATION_PK = 'PRIORITIZATION'
OPEN_SESSION_ID = 'vs_' + '1a' * 16
AXES = {'impact': 4, 'time_to_market': 3, 'confidence': 2, 'strategic_fit': 5}

# A deadline comfortably in the future / past, in epoch seconds. Fixed numbers
# rather than `now ± delta` so a test's outcome cannot depend on how long the
# suite took to get here.
FUTURE = 4_000_000_000
PAST = 1_000_000_000


def _split_top_level(text, separator=','):
    """Split on `separator` outside parentheses.

    `if_not_exists(#frozen_at, :now)` carries a comma of its own, so a naive split
    would cut it in half and report an assignment the route never made.
    """
    parts, depth, current = [], 0, ''
    for character in text:
        if character == '(':
            depth += 1
        elif character == ')':
            depth -= 1
        if character == separator and depth == 0:
            parts.append(current)
            current = ''
            continue
        current += character
    parts.append(current)
    return [part.strip() for part in parts if part.strip()]


class FakeAggregatesTable:
    """An in-memory stand-in for the aggregates table.

    Supports `get_item`, `put_item`, the conditional `SET`/`ADD` updates these
    routes issue, and the `transact_write_items` the ballot write issues. The
    condition evaluator understands only the four forms the handler uses
    (`attribute_exists(sk)`, `#name = :value`, `#name > :value`, `attr < attr`) and
    raises on anything else, so a new conjunct cannot pass unnoticed by being
    silently treated as true.

    The TRANSACTION is all-or-nothing here as it is in DynamoDB — every condition is
    evaluated before any item is applied — because that is the property the ballot
    write depends on: the ballot and its row's freeze mark land together or neither
    does, and a fake that applied items as it walked them would let a test about that
    pass against code that wrote one without the other.
    """

    def __init__(self, items=None, close_after_reads=None, rows_exist=True):
        self.items = {(i['pk'], i['sk']): dict(i) for i in (items or [])}
        if rows_exist:
            # THE ROW RECORD OF EVERY SEEDED SESSION, because that is the only state
            # the product can reach: a session is created only for a row that exists
            # (`_row_exists` gates it), and a ballot now asserts the row still does —
            # it stamps that record's freeze mark and moves the fence a row delete
            # reads. A fixture with a session and no row is a row deleted after the
            # vote opened, which is what `rows_exist=False` is for.
            for (pk, _), item in list(self.items.items()):
                if pk != SESSION_PK:
                    continue
                row_id = item.get('row_id')
                if not isinstance(row_id, str) or not row_id:
                    continue
                key = (PRIORITIZATION_PK, f'ROW#{row_id}')
                self.items.setdefault(key, {
                    'pk': key[0], 'sk': key[1], 'row_id': row_id,
                    'project_id': 'proj', 'document_ids': [f'{row_id}-prd'],
                    'is_default': True, 'created_at': '2026-08-17T10:00:00+00:00',
                })
        self.get_item_calls = []
        self.put_item_calls = []
        self.update_item_calls = []
        self.transact_calls = []
        # `table.name` and `table.meta.client` are what a transaction needs: it is
        # issued on the resource's underlying CLIENT, which takes the table name per
        # item rather than being bound to one table.
        self.name = 'test-aggregates'
        self.meta = SimpleNamespace(client=SimpleNamespace(
            transact_write_items=self._transact_write_items,
        ))
        # Models the RACE: the facilitator closes the vote after the handler has
        # read the session and before it writes. `None` disables it.
        self.close_after_reads = close_after_reads

    # -- reads -------------------------------------------------------------
    def get_item(self, **kwargs):
        self.get_item_calls.append(kwargs)
        key = (kwargs['Key']['pk'], kwargs['Key']['sk'])
        stored = self.items.get(key)
        # The SNAPSHOT IS TAKEN FIRST, before `close_after_reads` fires. That
        # ordering is the whole point of the fixture: the caller must be handed the
        # session as it was when it read it, and find it closed only when it
        # writes. Copying after the mutation instead would hand back an
        # already-closed record, the handler would refuse at the read, and a test
        # meaning to exercise the WRITE-time condition would pass without ever
        # reaching it.
        snapshot = {'Item': dict(stored)} if stored is not None else {}
        if (self.close_after_reads is not None
                and len(self.get_item_calls) >= self.close_after_reads):
            for (pk, _), session in self.items.items():
                if pk == SESSION_PK:
                    session['status'] = 'closed'
        return snapshot

    # -- writes ------------------------------------------------------------
    def put_item(self, **kwargs):
        self.put_item_calls.append(kwargs)
        item = kwargs['Item']
        self.items[(item['pk'], item['sk'])] = dict(item)
        return {}

    def update_item(self, **kwargs):
        self.update_item_calls.append(kwargs)
        key = (kwargs['Key']['pk'], kwargs['Key']['sk'])
        names = kwargs.get('ExpressionAttributeNames', {})
        values = kwargs.get('ExpressionAttributeValues', {})
        item = self.items.get(key)

        condition = kwargs.get('ConditionExpression')
        if condition and not self._holds(condition, item, names, values):
            raise ClientError(
                {'Error': {'Code': 'ConditionalCheckFailedException',
                           'Message': 'The conditional request failed'}},
                'UpdateItem',
            )

        self._apply(key, kwargs)
        item = self.items[key]
        return {'Attributes': dict(item)} if kwargs.get('ReturnValues') == 'ALL_NEW' else {}

    def _apply(self, key, kwargs):
        """The `SET` / `ADD` clauses these routes write, condition already checked."""
        names = kwargs.get('ExpressionAttributeNames', {})
        values = kwargs.get('ExpressionAttributeValues', {})
        item = self.items.get(key)
        if item is None:
            item = {'pk': key[0], 'sk': key[1]}
            self.items[key] = item

        expression = kwargs['UpdateExpression'].strip()
        # One expression may carry both clauses: the row half of the ballot
        # transaction is `SET #frozen_at = if_not_exists(...) ADD #ballot_writes :one`.
        set_clause, add_clause = expression, ''
        if ' ADD ' in expression:
            set_clause, _, add_clause = expression.partition(' ADD ')
        elif expression.upper().startswith('ADD'):
            set_clause, add_clause = '', expression[len('ADD'):]
        if set_clause:
            assert set_clause.strip().upper().startswith('SET'), expression
            for assignment in _split_top_level(set_clause.strip()[len('SET'):]):
                target, _, source = (part.strip() for part in assignment.partition('='))
                attribute = names.get(target, target)
                if source.startswith('if_not_exists('):
                    existing, fallback = _split_top_level(
                        source[len('if_not_exists('):-1]
                    )
                    # `if_not_exists` is what makes the freeze mark record the FIRST
                    # ballot rather than the latest, so it is honoured rather than
                    # treated as a plain assignment: a fake that overwrote would let
                    # an assignment pass as a freeze instant.
                    if names.get(existing.strip(), existing.strip()) in item:
                        continue
                    item[attribute] = values[fallback.strip()]
                    continue
                item[attribute] = self._value(source, item, names, values)
        if add_clause:
            target, source = add_clause.split()
            attribute = names.get(target, target)
            item[attribute] = (item.get(attribute) or 0) + values[source]

    def _transact_write_items(self, TransactItems):
        """All-or-nothing, which is what the ballot write depends on.

        The capitalised parameter is boto3's own spelling of it, kept so the fake
        accepts exactly the call the route makes.

        `CancellationReasons` is ONE ENTRY PER ITEM, POSITIONALLY, with `'None'` for
        the items that did not fail — DynamoDB's own shape. The route reads the reason
        at the ROW's index to tell a vanished row from a write conflict, so a
        single-element list would let it pass here while reading the wrong position in
        production.
        """
        self.transact_calls.append(TransactItems)
        reasons = []
        for entry in TransactItems:
            (operation, request), = entry.items()
            assert operation == 'Update', operation
            assert request['TableName'] == self.name, request['TableName']
            key = (request['Key']['pk'], request['Key']['sk'])
            holds = self._holds(
                request['ConditionExpression'], self.items.get(key),
                request.get('ExpressionAttributeNames', {}),
                request.get('ExpressionAttributeValues', {}),
            ) if request.get('ConditionExpression') else True
            reasons.append({'Code': 'None'} if holds else {
                'Code': 'ConditionalCheckFailed',
                'Message': 'The conditional request failed',
            })
        if any(reason['Code'] != 'None' for reason in reasons):
            raise ClientError(
                {'Error': {'Code': 'TransactionCanceledException',
                           'Message': 'Transaction cancelled'},
                 'CancellationReasons': reasons},
                'TransactWriteItems',
            )
        for entry in TransactItems:
            (_, request), = entry.items()
            self._apply((request['Key']['pk'], request['Key']['sk']), request)
        return {}

    # -- expression evaluation --------------------------------------------
    def _value(self, source, item, names, values):
        """`:alias`, or `attr + :alias` (the atomic increment)."""
        if '+' in source:
            left, right = (part.strip() for part in source.split('+'))
            return self._operand(left, item, names, values) + self._operand(right, item, names, values)
        return self._operand(source, item, names, values)

    def _operand(self, token, item, names, values):
        if token.startswith(':'):
            return values[token]
        return item.get(names.get(token, token))

    def _holds(self, condition, item, names, values):
        for conjunct in condition.split(' AND '):
            if not self._conjunct_holds(conjunct.strip(), item, names, values):
                return False
        return True

    def _conjunct_holds(self, conjunct, item, names, values):
        if conjunct.startswith('attribute_exists('):
            return item is not None
        match = re.fullmatch(r'(\S+)\s*(=|<|>)\s*(\S+)', conjunct)
        assert match, f'unsupported condition: {conjunct}'
        left, operator, right = match.groups()
        if item is None:
            return False
        left_value = self._operand(left, item, names, values)
        right_value = self._operand(right, item, names, values)
        if left_value is None or right_value is None:
            # A missing attribute makes a DynamoDB comparison false, which is the
            # direction the cap check relies on failing in.
            return False
        if operator == '=':
            return left_value == right_value
        if operator == '<':
            return left_value < right_value
        return left_value > right_value

    # -- helpers -----------------------------------------------------------
    @property
    def ballot_keys(self):
        """Only the BALLOT keys. The row records the ballot write now stamps share
        this partition, and every "nothing was written" assertion here is about
        ballots — counting a fixture's row record among them would make each of them
        fail while saying nothing about the ballot."""
        return sorted(
            sk for (pk, sk) in self.items
            if pk == PRIORITIZATION_PK and sk.startswith('BALLOT#')
        )

    def ballot(self, sort_key):
        return self.items.get((PRIORITIZATION_PK, sort_key))

    def row(self, row_id='row_proj_20260817_default'):
        """The ROW record a ballot stamps — the freeze mark and the delete's fence."""
        return self.items.get((PRIORITIZATION_PK, f'ROW#{row_id}'))

    def session(self, session_id=OPEN_SESSION_ID):
        return self.items.get((SESSION_PK, f'SESSION#{session_id}'))


def open_session(session_id=OPEN_SESSION_ID, **overrides):
    """A stored session record, open and unexpired unless overridden."""
    return {
        'pk': SESSION_PK,
        'sk': f'SESSION#{session_id}',
        'session_id': session_id,
        'row_id': 'row_proj_20260817_default',
        'row_title': 'Instant refunds',
        'status': 'open',
        'ballot_cap': 40,
        'ballot_count': 0,
        'created_by': 'facilitator-sub',
        'created_at': '2026-08-17T10:00:00+00:00',
        'expires_at': '2096-10-02T07:06:40+00:00',
        'ttl': FUTURE,
        **overrides,
    }


def _call(table, event, lambda_context, logger=None):
    from ballots_handler import lambda_handler

    with patch('ballots_handler.get_aggregates_table', return_value=table):
        if logger is None:
            response = lambda_handler(event, lambda_context)
        else:
            with patch('ballots_handler.logger', logger):
                response = lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])


def _submit(table, api_gateway_event, lambda_context, *,
            session_id=OPEN_SESSION_ID, body=None, logger=None):
    event = api_gateway_event(
        method='POST',
        path=f'/voting-sessions/{session_id}/submit',
        body=AXES if body is None else body,
        path_params={'session_id': session_id},
    )
    return _call(table, event, lambda_context, logger=logger)


def _config(table, api_gateway_event, lambda_context, *, session_id=OPEN_SESSION_ID):
    event = api_gateway_event(
        method='GET',
        path=f'/voting-sessions/{session_id}/config',
        path_params={'session_id': session_id},
    )
    return _call(table, event, lambda_context)


def _create(table, api_gateway_event, lambda_context, *, body, subject='facilitator-sub',
            seed_row=True):
    """Open a session, seeding the named row's record first.

    Seeded by default because that is the only state the page can reach: a
    facilitator opens a vote from a row the page rendered, and the route refuses
    a row with no record (#342). `seed_row=False` is for the tests asking about
    exactly that refusal. A row id the route will refuse on SHAPE (empty, '#')
    seeds nothing usable and the shape refusal is unaffected — the same rule
    `_patch_scores` follows in the sibling harness.
    """
    row_id = body.get('row_id') if isinstance(body, dict) else None
    if seed_row and isinstance(row_id, str) and row_id.strip() and '#' not in row_id:
        table.items.setdefault(
            (PRIORITIZATION_PK, f'ROW#{row_id}'),
            {'pk': PRIORITIZATION_PK, 'sk': f'ROW#{row_id}', 'row_id': row_id},
        )
    event = api_gateway_event(method='POST', path='/voting-sessions', body=body)
    claims = event['requestContext']['authorizer']['claims']
    if subject is None:
        claims.pop('sub', None)
    else:
        claims['sub'] = subject
    return _call(table, event, lambda_context)


def _close(table, api_gateway_event, lambda_context, *, session_id=OPEN_SESSION_ID):
    event = api_gateway_event(
        method='POST',
        path=f'/voting-sessions/{session_id}/close',
        path_params={'session_id': session_id},
    )
    return _call(table, event, lambda_context)


class TestTheCapIsEnforcedByTheDatabase:
    """The cap is what bounds ballot stuffing, and a room submits at once — so it
    has to be a condition on a write, not a number compared after a read."""

    def test_a_full_session_refuses_the_next_ballot_and_writes_nothing(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session(ballot_cap=2, ballot_count=2)])

        status, body = _submit(table, api_gateway_event, lambda_context)

        assert status == 429
        assert body['reason'] == 'cap_reached'
        assert table.ballot_keys == []

    def test_ballots_are_accepted_up_to_the_cap_and_then_refused(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session(ballot_cap=2, ballot_count=0)])

        first = _submit(table, api_gateway_event, lambda_context)
        second = _submit(table, api_gateway_event, lambda_context)
        third = _submit(table, api_gateway_event, lambda_context)

        assert [first[0], second[0], third[0]] == [200, 200, 429]
        assert table.session()['ballot_count'] == 2
        assert len(table.ballot_keys) == 2

    def test_the_claim_is_one_conditional_increment_not_a_read_then_write(
            self, api_gateway_event, lambda_context):
        # A read-then-write would have to read the count first. The only read this
        # route makes of the session is the one that supplies the refusal wording,
        # and the count it returns is never written back.
        table = FakeAggregatesTable([open_session(ballot_count=7)])

        _submit(table, api_gateway_event, lambda_context)

        claim = table.update_item_calls[0]
        assert claim['Key']['sk'] == f'SESSION#{OPEN_SESSION_ID}'
        assert 'ballot_count = ballot_count + :one' in claim['UpdateExpression']
        assert 'ballot_count < ballot_cap' in claim['ConditionExpression']
        assert table.session()['ballot_count'] == 8

    def test_a_session_missing_its_cap_attributes_is_refused(
            self, api_gateway_event, lambda_context):
        # The comparison against an absent attribute is false in DynamoDB, and
        # refusing is the direction to fail in for a public write.
        session = open_session()
        del session['ballot_cap']
        table = FakeAggregatesTable([session])

        status, body = _submit(table, api_gateway_event, lambda_context)

        assert status == 429
        assert body['reason'] == 'cap_reached'
        assert table.ballot_keys == []


class TestRefusalsAPhoneCanRender:
    """Every refusal carries a stable `reason` beside the sentence, because
    `fetchApi` discards a body and the page has to say which state it hit."""

    def test_a_closed_session_is_refused_as_closed(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session(status='closed')])

        status, body = _submit(table, api_gateway_event, lambda_context)

        assert (status, body['reason']) == (409, 'closed')
        assert table.ballot_keys == []

    def test_an_expired_session_is_refused_as_expired_though_it_still_says_open(
            self, api_gateway_event, lambda_context):
        # This is the case TTL deletion lags on: for up to about 48 hours the row
        # is still there and its `status` still reads `open`. Expiry is decided by
        # the stored deadline, not by the row's absence.
        table = FakeAggregatesTable([open_session(status='open', ttl=PAST)])

        status, body = _submit(table, api_gateway_event, lambda_context)

        assert (status, body['reason']) == (409, 'expired')
        assert table.ballot_keys == []

    def test_a_session_with_no_readable_deadline_fails_closed(
            self, api_gateway_event, lambda_context):
        session = open_session()
        del session['ttl']
        table = FakeAggregatesTable([session])

        status, body = _submit(table, api_gateway_event, lambda_context)

        assert (status, body['reason']) == (409, 'expired')

    def test_an_unknown_session_is_refused_as_not_found(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])

        status, body = _submit(table, api_gateway_event, lambda_context)

        assert (status, body['reason']) == (404, 'not_found')

    def test_a_malformed_session_id_costs_no_database_read(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])

        status, body = _submit(
            table, api_gateway_event, lambda_context, session_id='not-a-session-id')

        assert (status, body['reason']) == (404, 'not_found')
        assert table.get_item_calls == []


class TestOneDeviceOneBallot:
    """A device corrects its own vote by sending back the id it was given. That is
    what makes "one ballot each" true without cookies or fingerprinting."""

    def test_re_submitting_with_the_returned_id_corrects_and_consumes_no_slot(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        _, first = _submit(table, api_gateway_event, lambda_context)

        status, second = _submit(
            table, api_gateway_event, lambda_context,
            body={**AXES, 'impact': 1, 'ballot_id': first['ballot_id']},
        )

        assert status == 200
        assert second['corrected'] is True
        assert second['ballot_id'] == first['ballot_id']
        assert len(table.ballot_keys) == 1
        assert table.session()['ballot_count'] == 1
        assert table.ballot(table.ballot_keys[0])['impact'] == 1

    def test_a_ballot_id_from_another_session_is_not_a_free_pass(
            self, api_gateway_event, lambda_context):
        other_id = 'vs_' + '2b' * 16
        table = FakeAggregatesTable([open_session(), open_session(session_id=other_id)])
        _, mine = _submit(table, api_gateway_event, lambda_context, session_id=other_id)
        before = dict(table.ballot(table.ballot_keys[0]))

        status, body = _submit(
            table, api_gateway_event, lambda_context,
            body={**AXES, 'impact': 1, 'ballot_id': mine['ballot_id']},
        )

        # Treated as a FIRST submission: a new id, a slot consumed, and the ballot
        # cast on the other session left exactly as it was.
        assert status == 200
        assert body['corrected'] is False
        assert body['ballot_id'] != mine['ballot_id']
        assert table.session()['ballot_count'] == 1
        assert table.ballot(f"BALLOT#{before['row_id']}#anon:{mine['ballot_id']}") == before

    def test_an_unrecognised_ballot_id_is_a_first_submission(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])

        status, body = _submit(
            table, api_gateway_event, lambda_context,
            body={**AXES, 'ballot_id': 'ff' * 16},
        )

        assert status == 200
        assert body['corrected'] is False
        assert body['ballot_id'] != 'ff' * 16
        assert table.session()['ballot_count'] == 1

    def test_the_ballot_id_is_never_taken_from_the_caller(
            self, api_gateway_event, lambda_context):
        # The id is the second half of a sort key. A caller-chosen one would put
        # that half under the control of the one unauthenticated writer here.
        #
        # Asserted as PROVENANCE — the caller's id addresses nothing — rather than
        # as consistency between the response and the key. Those agree either way,
        # so a handler that echoed the caller's choice would satisfy the weaker form.
        chosen = 'ab' * 16
        table = FakeAggregatesTable([open_session()])

        _, body = _submit(table, api_gateway_event, lambda_context,
                          body={**AXES, 'ballot_id': chosen})

        assert body['ballot_id'] != chosen
        assert table.ballot(f'BALLOT#row_proj_20260817_default#anon:{chosen}') is None
        assert table.ballot_keys == [
            f"BALLOT#row_proj_20260817_default#anon:{body['ballot_id']}"
        ]


class TestACorrectionIsRefusedByTheSameAuthority:
    """A correction consumes no slot, but it must not land after the room closed.
    Checking the session only at the READ left that window open."""

    def test_a_correction_is_refused_when_the_vote_closes_mid_request(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        _, first = _submit(table, api_gateway_event, lambda_context)
        stored = dict(table.ballot(table.ballot_keys[0]))
        # From here the session reads OPEN and is closed before the write lands —
        # the interleaving a facilitator pressing Close actually produces.
        table.close_after_reads = len(table.get_item_calls) + 1

        status, body = _submit(
            table, api_gateway_event, lambda_context,
            body={**AXES, 'impact': 1, 'ballot_id': first['ballot_id']},
        )

        assert (status, body['reason']) == (409, 'closed')
        assert table.ballot(table.ballot_keys[0]) == stored

    def test_a_new_ballot_is_refused_in_the_same_window(
            self, api_gateway_event, lambda_context):
        # The control: this path already held the line, and it must keep holding it.
        table = FakeAggregatesTable([open_session()], close_after_reads=1)

        status, body = _submit(table, api_gateway_event, lambda_context)

        assert (status, body['reason']) == (409, 'closed')
        assert table.ballot_keys == []

    def test_a_correction_claims_no_slot_of_the_cap(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session(ballot_cap=1, ballot_count=0)])
        _, first = _submit(table, api_gateway_event, lambda_context)

        status, _ = _submit(
            table, api_gateway_event, lambda_context,
            body={**AXES, 'ballot_id': first['ballot_id']},
        )

        # The cap is 1 and it is already reached, yet correcting one's own ballot
        # still works: the conditional write it makes carries no cap conjunct.
        assert status == 200
        assert table.session()['ballot_count'] == 1


class TestWhatABallotIsAndIsNot:
    def test_a_ballot_never_carries_ttl(self, api_gateway_event, lambda_context):
        # The aggregates table expires anything with this attribute. A ballot with
        # one would leave the team's score weeks after the meeting, silently.
        table = FakeAggregatesTable([open_session()])

        _submit(table, api_gateway_event, lambda_context)

        assert 'ttl' not in table.ballot(table.ballot_keys[0])

    def test_the_session_carries_ttl_because_its_own_state_expires_with_it(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])

        status, body = _create(table, api_gateway_event, lambda_context,
                               body={'row_id': 'row_p1_default', 'row_title': 'Refunds'})

        assert status == 200
        stored = table.session(body['session']['session_id'])
        assert isinstance(stored['ttl'], int)
        assert stored['ballot_count'] == 0

    def test_the_row_comes_from_the_session_not_from_the_body(
            self, api_gateway_event, lambda_context):
        # A public caller does not get to choose which proposal it is scoring.
        table = FakeAggregatesTable([open_session()])

        _submit(table, api_gateway_event, lambda_context,
                body={**AXES, 'row_id': 'row_somebody_elses_default'})

        assert table.ballot_keys[0].startswith('BALLOT#row_proj_20260817_default#anon:')

    def test_the_ballot_lands_on_the_session_s_row_so_a_room_scores_a_whole_proposal(
            self, api_gateway_event, lambda_context):
        # The unit, not merely the shape: a ballot keyed to a ROW is what makes a
        # room's vote cover a project's PRD and its PR/FAQ together instead of
        # whichever one the QR happened to sit on. The stored attribute matches the
        # signed-in save path's `row_id` stamp, so one page reads both.
        table = FakeAggregatesTable([open_session()])

        _submit(table, api_gateway_event, lambda_context)

        stored = table.ballot(table.ballot_keys[0])
        assert stored['row_id'] == 'row_proj_20260817_default'
        assert 'document_id' not in stored

    def test_the_ballot_records_which_session_cast_it(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])

        _submit(table, api_gateway_event, lambda_context)

        assert table.ballot(table.ballot_keys[0])['voting_session'] == OPEN_SESSION_ID


class TestAnAnonymousBallotMarksItsRowLikeAnyOther:
    """An anonymous ballot is A BALLOT: a durable decision record about the set of
    documents the row held when the room voted, counted in the same aggregate a
    signed-in reviewer's is.

    So it has to do the same three things to its row, and all three are properties of
    the write rather than of some later reconciliation — which is why they are
    asserted here, against the real route, rather than trusted to the attribute names
    the lockstep test pins.
    """

    ROW = 'row_proj_20260817_default'

    def test_a_room_ballot_freezes_the_rows_composition(
            self, api_gateway_event, lambda_context):
        """Without this, a row carrying nothing but REAL anonymous votes stayed
        recomposable — and recomposing it would leave every one of those ballots
        describing documents the room never saw. `first_ballot_at` is exactly what
        `projects_handler`'s recompose route asserts the absence of."""
        table = FakeAggregatesTable([open_session()])
        assert 'first_ballot_at' not in table.row()

        _submit(table, api_gateway_event, lambda_context)

        assert table.row()['first_ballot_at']

    def test_the_freeze_mark_records_the_first_room_ballot_and_not_the_latest(
            self, api_gateway_event, lambda_context):
        """`if_not_exists`, so it is a freeze instant and not a last-modified stamp:
        the composition froze when the FIRST phone submitted."""
        table = FakeAggregatesTable([open_session()])

        _submit(table, api_gateway_event, lambda_context)
        first = table.row()['first_ballot_at']
        _submit(table, api_gateway_event, lambda_context)

        assert table.row()['first_ballot_at'] == first

    def test_a_room_ballot_moves_the_deletes_fence(
            self, api_gateway_event, lambda_context):
        """`ballot_writes` is what a row delete asserts has not changed since it
        enumerated the row's ballots. An anonymous ballot that did not move it left
        the delete free to commit and orphan that ballot — the #342 fault the fence
        exists to close, surviving in the one path least able to notice it."""
        table = FakeAggregatesTable([open_session()])

        _submit(table, api_gateway_event, lambda_context)
        _submit(table, api_gateway_event, lambda_context)

        assert table.row()['ballot_writes'] == 2

    def test_a_correction_moves_the_fence_without_moving_the_freeze(
            self, api_gateway_event, lambda_context):
        """A correction is a write, so the fence has to move: a delete that listed the
        row's ballots before the correction landed must be cancelled rather than
        committing over it. The freeze instant does not move, because the first ballot
        is what froze the composition and a correction is not a new decision about
        which documents the row holds."""
        table = FakeAggregatesTable([open_session()])
        _, first = _submit(table, api_gateway_event, lambda_context)
        froze_at = table.row()['first_ballot_at']

        _, second = _submit(table, api_gateway_event, lambda_context,
                            body={**AXES, 'ballot_id': first['ballot_id']})

        assert second['corrected'] is True
        assert table.row()['first_ballot_at'] == froze_at
        assert table.row()['ballot_writes'] == 2

    def test_the_ballot_and_its_rows_marks_land_in_ONE_write(
            self, api_gateway_event, lambda_context):
        """Two writes would leave a window in which the ballot exists and its row is
        still recomposable — the freeze arriving a moment late, which is precisely the
        interleaving the condition on a composition change exists to lose to."""
        table = FakeAggregatesTable([open_session()])

        _submit(table, api_gateway_event, lambda_context)

        assert len(table.transact_calls) == 1
        keys = sorted(
            request['Key']['sk'] for entry in table.transact_calls[0]
            for request in entry.values()
        )
        assert keys == [
            f'BALLOT#{self.ROW}#anon:{table.ballot_keys[0].rsplit(":", 1)[1]}',
            f'ROW#{self.ROW}',
        ]

    def test_a_ballot_on_a_row_deleted_after_the_vote_opened_is_refused(
            self, api_gateway_event, lambda_context):
        """`_row_exists` is checked when the session is OPENED, which can be an hour
        before the room votes. `attribute_exists(sk)` on the write is what makes a
        ballot on a row deleted in between fail — instead of resurrecting the row as
        a bare record, since `update_item` is an upsert."""
        table = FakeAggregatesTable([open_session()], rows_exist=False)

        status, body = _submit(table, api_gateway_event, lambda_context)

        assert status == 404
        assert table.ballot_keys == [], 'no orphan was left behind'
        assert table.row() is None, 'and the row was not resurrected'
        assert body['success'] is False

    def test_the_vanished_row_is_refused_with_a_reason_the_page_can_state(
            self, api_gateway_event, lambda_context):
        """THE SHAPE, not the status. The page dispatches on `reason` alone —
        `submitBallot` parses the body with `ballotRefusalSchema` and falls back to
        `unknown` when the field is absent, which renders as "try again in a moment".

        A bare `NotFoundError` is rendered by the shared handler WITHOUT a `reason`,
        so the one case where the row is permanently gone got the copy reserved for
        transient failures — inverting the very distinction the cancellation-reason
        read exists to draw. `not_found` already has its own translated sentence."""
        table = FakeAggregatesTable([open_session()], rows_exist=False)

        _, body = _submit(table, api_gateway_event, lambda_context)

        assert body['reason'] == 'not_found'

    def test_a_vanished_row_is_not_retried(
            self, api_gateway_event, lambda_context):
        """A deleted row does not come back, so re-attempting would spend the room's
        request time to reach the same answer. Only a cancellation NO CONDITION caused
        is transient."""
        table = FakeAggregatesTable([open_session()], rows_exist=False)

        _submit(table, api_gateway_event, lambda_context)

        assert len(table.transact_calls) == 1

    def test_a_write_conflict_is_a_retryable_failure_not_a_vanished_proposal(
            self, api_gateway_event, lambda_context):
        """The ordinary case in this handler: a room of phones submitting at once all
        write the SAME row record, so `TransactionConflict` is what contention looks
        like here. Reading it as "the row is gone" would tell a phone that lost a race
        that the proposal no longer exists — a settled refusal in place of the
        transient failure the page already retries."""
        table = FakeAggregatesTable([open_session()])

        def conflict(**kwargs):
            raise ClientError(
                {'Error': {'Code': 'TransactionCanceledException',
                           'Message': 'Transaction cancelled'},
                 'CancellationReasons': [{'Code': 'None'},
                                         {'Code': 'TransactionConflict'}]},
                'TransactWriteItems',
            )

        table.meta.client.transact_write_items = conflict

        status, _ = _submit(table, api_gateway_event, lambda_context)

        assert status == 500, 'a retryable failure, not a 404'

    def test_a_conflict_that_clears_records_the_ballot_rather_than_failing(
            self, api_gateway_event, lambda_context):
        """CONTENTION IS THE DESIGNED CASE, so it is retried rather than reported.

        Every ballot of a session `ADD`s to the SAME row record, so a room submitting
        on the facilitator's count of three conflicts by construction — and botocore
        does not auto-retry `TransactionCanceledException`, so it arrives at the
        handler. Reporting it costs the voter their ballot AND their cap slot: the
        slot was claimed before this write, and the page renders a terminal panel
        with no way to resubmit, so a contended room would burn slots on conflicts
        and then refuse ballots with `cap_reached` it should have accepted."""
        table = FakeAggregatesTable([open_session()])
        real = table.meta.client.transact_write_items
        attempts = []

        def conflict_once(**kwargs):
            attempts.append(kwargs)
            if len(attempts) == 1:
                raise ClientError(
                    {'Error': {'Code': 'TransactionCanceledException',
                               'Message': 'Transaction cancelled'},
                     'CancellationReasons': [{'Code': 'None'},
                                             {'Code': 'TransactionConflict'}]},
                    'TransactWriteItems',
                )
            return real(**kwargs)

        table.meta.client.transact_write_items = conflict_once

        status, body = _submit(table, api_gateway_event, lambda_context)

        assert status == 200
        assert body['success'] is True
        assert len(attempts) == 2, 'the conflict was re-attempted'

    def test_a_retried_ballot_is_written_exactly_once(
            self, api_gateway_event, lambda_context):
        """The retry is safe BECAUSE the ballot's half is an upsert on this device's
        own key: re-attempting cannot leave two records or count a vote twice. The
        fence moves once too, since the cancelled attempt wrote nothing at all."""
        table = FakeAggregatesTable([open_session()])
        real = table.meta.client.transact_write_items
        attempts = []

        def conflict_once(**kwargs):
            attempts.append(kwargs)
            if len(attempts) == 1:
                raise ClientError(
                    {'Error': {'Code': 'TransactionCanceledException',
                               'Message': 'Transaction cancelled'},
                     'CancellationReasons': [{'Code': 'None'},
                                             {'Code': 'TransactionConflict'}]},
                    'TransactWriteItems',
                )
            return real(**kwargs)

        table.meta.client.transact_write_items = conflict_once

        _submit(table, api_gateway_event, lambda_context)

        assert len(table.ballot_keys) == 1
        assert table.row()['ballot_writes'] == 1

    def test_a_conflict_that_never_clears_is_still_a_retryable_500(
            self, api_gateway_event, lambda_context):
        """The retries are BOUNDED. A room holding phones cannot be made to wait
        indefinitely, and a conflict that outlasts the attempts is reported as the
        transient failure it is — a 500, which the page may retry, rather than a 404
        claiming the proposal is gone."""
        import ballots_handler

        table = FakeAggregatesTable([open_session()])
        attempts = []

        def always_conflict(**kwargs):
            attempts.append(kwargs)
            raise ClientError(
                {'Error': {'Code': 'TransactionCanceledException',
                           'Message': 'Transaction cancelled'},
                 'CancellationReasons': [{'Code': 'None'},
                                         {'Code': 'TransactionConflict'}]},
                'TransactWriteItems',
            )

        table.meta.client.transact_write_items = always_conflict

        status, _ = _submit(table, api_gateway_event, lambda_context)

        assert status == 500, 'transient, not a vanished proposal'
        assert len(attempts) == ballots_handler.BALLOT_WRITE_ATTEMPTS
        assert table.ballot_keys == [], 'and nothing was written'

    def test_the_write_attempts_bound_leaves_at_least_one_attempt(self):
        """A bound of 0 makes `range` yield nothing, so the write loop is never
        entered — and this function signals a written ballot by returning, which makes
        falling out of the loop indistinguishable from success. Pinned as a number the
        way `MAX_ROW_BALLOTS_PER_DELETE + 2 <= 100` pins the delete's reservation,
        because it is a tuning constant and a later change may lower it."""
        import ballots_handler

        assert ballots_handler.BALLOT_WRITE_ATTEMPTS >= 1

    def test_a_bound_that_allows_no_attempt_is_a_500_and_not_a_silent_success(
            self, api_gateway_event, lambda_context):
        """The guard for the bound going wrong anyway. Without the raise after the
        loop the device is told 200 and the room is thanked for a ballot that was
        never written — the one failure this module makes loud everywhere else. A
        misconfigured bound is a server fault, so it reads as one."""
        import ballots_handler

        table = FakeAggregatesTable([open_session()])

        with patch.object(ballots_handler, 'BALLOT_WRITE_ATTEMPTS', 0):
            status, body = _submit(table, api_gateway_event, lambda_context)

        assert status == 500
        assert body['success'] is False
        assert table.transact_calls == [], 'no attempt was made'
        assert table.ballot_keys == [], 'and nothing was written'

    def test_the_marks_are_spelled_the_way_the_other_bundle_reads_them(
            self, api_gateway_event, lambda_context):
        """The two handlers are separate Lambda bundles and neither may import the
        other, so the attribute names are duplicated. Pinned against the real writer
        here and across the two source files by `test_anon_row_mark_lockstep.py`: a
        drift is a freeze that does not freeze and a fence that does not fence, and
        neither failure is loud."""
        import ballots_handler

        table = FakeAggregatesTable([open_session()])
        _submit(table, api_gateway_event, lambda_context)

        row = table.row()
        assert ballots_handler.ROW_FROZEN_AT_FIELD in row
        assert ballots_handler.ROW_BALLOT_WRITES_FIELD in row


class TestValidationRefusalsAreTheirOwnReason:
    """A malformed ballot is PERMANENT. Answered as `invalid` rather than left to
    the shared 400 handler, whose body carries no reason — so the page rendered
    every one of these as "try again in a moment"."""

    @pytest.mark.parametrize('body', [
        {'impact': True},
        {'impact': float('inf')},
        {'impact': 'four'},
        {'impact': None},
        {},
    ])
    def test_a_ballot_that_scores_nothing_usable_is_refused_as_invalid(
            self, api_gateway_event, lambda_context, body):
        table = FakeAggregatesTable([open_session()])

        status, response = _submit(table, api_gateway_event, lambda_context, body=body)

        assert (status, response['reason']) == (400, 'invalid')
        assert table.ballot_keys == []
        assert table.session()['ballot_count'] == 0

    def test_an_over_long_note_is_refused_rather_than_truncated(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])

        status, response = _submit(table, api_gateway_event, lambda_context,
                                   body={**AXES, 'notes': 'x' * 2001})

        assert (status, response['reason']) == (400, 'invalid')
        assert table.ballot_keys == []

    def test_a_note_at_the_bound_is_accepted_whole(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])

        status, _ = _submit(table, api_gateway_event, lambda_context,
                            body={**AXES, 'notes': 'x' * 2000})

        assert status == 200
        assert table.ballot(table.ballot_keys[0])['notes'] == 'x' * 2000

    def test_a_body_that_is_not_a_json_object_is_refused_as_invalid(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        event = api_gateway_event(
            method='POST',
            path=f'/voting-sessions/{OPEN_SESSION_ID}/submit',
            path_params={'session_id': OPEN_SESSION_ID},
        )
        event['body'] = '[1, 2, 3]'

        status, response = _call(table, event, lambda_context)

        assert (status, response['reason']) == (400, 'invalid')

    def test_a_body_that_is_not_json_at_all_is_refused_as_invalid(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        event = api_gateway_event(
            method='POST',
            path=f'/voting-sessions/{OPEN_SESSION_ID}/submit',
            path_params={'session_id': OPEN_SESSION_ID},
        )
        event['body'] = '{not json'

        status, response = _call(table, event, lambda_context)

        assert (status, response['reason']) == (400, 'invalid')

    @pytest.mark.parametrize('validator,body', [
        # One case per validator that can reach the refusal, named for the one it
        # actually reaches — the note bound only fires when the note is over it, and
        # a body with no scorable axis is refused before the note is ever read.
        ('the note bound', {**AXES, 'notes': 'x' * 2001 + 'SUBMITTED-CONTENT'}),
        ('a non-numeric axis', {'impact': 'SUBMITTED-CONTENT'}),
        ('nothing scored', {'notes': 'SUBMITTED-CONTENT'}),
        ('a non-string note', {**AXES, 'notes': ['SUBMITTED-CONTENT']}),
    ])
    def test_the_refusal_never_echoes_what_was_submitted(
            self, api_gateway_event, lambda_context, validator, body):
        # The validator's own message is carried into the refusal body so somebody
        # holding a terminal can see WHICH field and WHICH bound. That is only safe
        # while those messages name the field and the limit and never the value —
        # this is a public route, and its response is the one place submitted text
        # could be reflected back.
        table = FakeAggregatesTable([open_session()])

        status, response = _submit(table, api_gateway_event, lambda_context, body=body)

        assert (status, response['reason']) == (400, 'invalid'), validator
        assert 'SUBMITTED-CONTENT' not in json.dumps(response), validator

    def test_an_out_of_range_number_is_clamped_rather_than_refused(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])

        status, _ = _submit(table, api_gateway_event, lambda_context,
                            body={'impact': 9, 'confidence': -4})

        assert status == 200
        stored = table.ballot(table.ballot_keys[0])
        assert (stored['impact'], stored['confidence']) == (5, 0)


class TestTheDisplayNameIsUntrustedOptionalPii:
    def test_control_characters_become_spaces_so_two_lines_do_not_merge(
            self, api_gateway_event, lambda_context):
        # Deleting the newline would read back as the single name 'SamADMIN' — a
        # plausible name nobody typed, which is worse than the newline.
        table = FakeAggregatesTable([open_session()])

        _submit(table, api_gateway_event, lambda_context,
                body={**AXES, 'display_name': 'Sam\nADMIN'})

        assert table.ballot(table.ballot_keys[0])['display_name'] == 'Sam ADMIN'

    def test_format_characters_are_deleted_because_they_separate_nothing(
            self, api_gateway_event, lambda_context):
        # U+202E is the bidi override that makes one displayed name impersonate
        # another. A space in its place would put a gap inside a legitimate name.
        table = FakeAggregatesTable([open_session()])

        _submit(table, api_gateway_event, lambda_context,
                body={**AXES, 'display_name': 'Sa\u202em'})

        assert table.ballot(table.ballot_keys[0])['display_name'] == 'Sam'

    def test_a_long_name_is_truncated_rather_than_refusing_the_whole_ballot(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])

        status, _ = _submit(table, api_gateway_event, lambda_context,
                            body={**AXES, 'display_name': 'n' * 200})

        assert status == 200
        assert table.ballot(table.ballot_keys[0])['display_name'] == 'n' * 60

    def test_whitespace_only_is_not_a_name_and_is_not_stored(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])

        _submit(table, api_gateway_event, lambda_context,
                body={**AXES, 'display_name': '   \t  '})

        assert 'display_name' not in table.ballot(table.ballot_keys[0])

    def test_it_is_never_echoed_back_to_the_submitter(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])

        _, body = _submit(table, api_gateway_event, lambda_context,
                          body={**AXES, 'display_name': 'Sam'})

        assert 'display_name' not in json.dumps(body)


class TestTheSessionTokenNeverReachesALog:
    """While the session is open the id is a bearer credential: a log line
    carrying it turns log read access into vote access."""

    @staticmethod
    def _logged(logger):
        lines = []
        for method in ('info', 'warning', 'error', 'exception', 'debug'):
            for call in getattr(logger, method).call_args_list:
                lines.extend(str(argument) for argument in call.args)
                lines.extend(str(value) for value in call.kwargs.values())
        return '\n'.join(lines)

    def test_recording_a_ballot_logs_only_a_truncated_reference(
            self, api_gateway_event, lambda_context):
        logger = MagicMock()
        table = FakeAggregatesTable([open_session()])

        _submit(table, api_gateway_event, lambda_context, logger=logger)
        lines = self._logged(logger)

        assert lines, 'the route logged nothing at all, so this proves nothing'
        assert OPEN_SESSION_ID not in lines
        assert OPEN_SESSION_ID[:11] in lines

    def test_opening_a_session_logs_only_a_truncated_reference(
            self, api_gateway_event, lambda_context):
        logger = MagicMock()
        table = FakeAggregatesTable([])

        with patch('ballots_handler.logger', logger):
            _, body = _create(table, api_gateway_event, lambda_context,
                              body={'row_id': 'row_p1_default'})
        lines = self._logged(logger)

        assert body['session']['session_id'] not in lines
        assert 'row_p1_default' in lines, 'an operator still needs the row'

    def test_closing_a_session_logs_only_a_truncated_reference(
            self, api_gateway_event, lambda_context):
        logger = MagicMock()
        table = FakeAggregatesTable([open_session()])

        with patch('ballots_handler.logger', logger):
            _close(table, api_gateway_event, lambda_context)

        assert OPEN_SESSION_ID not in self._logged(logger)

    def test_the_ballot_id_is_not_logged_either(self, api_gateway_event, lambda_context):
        # It is the device's own credential for correcting its vote.
        logger = MagicMock()
        table = FakeAggregatesTable([open_session()])

        _, body = _submit(table, api_gateway_event, lambda_context, logger=logger)

        assert body['ballot_id'] not in self._logged(logger)


class TestThePublicConfigRouteIsANarrowProjection:
    def test_an_open_session_names_the_row_and_nothing_else(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session(ballot_count=11)])

        status, body = _config(table, api_gateway_event, lambda_context)

        assert status == 200
        # `row_title`, because what is being scored is a project's set of documents
        # rather than one document — the public page states plainly what a ballot
        # covers, and a field named for a document would be the wrong claim.
        assert body['session'] == {
            'open': True, 'reason': None, 'row_title': 'Instant refunds',
        }

    @pytest.mark.parametrize('overrides,reason', [
        ({'status': 'closed'}, 'closed'),
        ({'ttl': PAST}, 'expired'),
    ])
    def test_a_dead_session_answers_200_with_a_reason_in_words(
            self, api_gateway_event, lambda_context, overrides, reason):
        # Not an error: the page's job in this state is to say so, and an error
        # would leave a room looking at a blank screen.
        table = FakeAggregatesTable([open_session(**overrides)])

        status, body = _config(table, api_gateway_event, lambda_context)

        assert status == 200
        assert (body['session']['open'], body['session']['reason']) == (False, reason)

    def test_an_unknown_link_answers_not_found_without_leaking_whether_it_existed(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])

        status, body = _config(table, api_gateway_event, lambda_context, session_id='vs_' + '00' * 16)
        _, malformed = _config(table, api_gateway_event, lambda_context, session_id='nope')

        assert status == 200
        assert body['session']['reason'] == 'not_found'
        assert malformed['session'] == body['session']


class TestTheFacilitatorHalf:
    def test_opening_a_session_records_the_creator_but_never_returns_it(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])

        _, body = _create(table, api_gateway_event, lambda_context,
                          body={'row_id': 'row_p1_default'}, subject='alice')

        assert table.session(body['session']['session_id'])['created_by'] == 'alice'
        assert 'alice' not in json.dumps(body)

    def test_a_caller_with_no_readable_subject_cannot_open_one(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])

        status, _ = _create(table, api_gateway_event, lambda_context,
                            body={'row_id': 'row_p1_default'}, subject=None)

        assert status == 403
        assert table.put_item_calls == []

    def test_a_row_id_carrying_the_key_delimiter_is_refused(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])

        status, _ = _create(table, api_gateway_event, lambda_context,
                            body={'row_id': 'row_p1#default'})

        assert status == 400
        assert table.put_item_calls == []

    def test_a_row_with_no_record_opens_no_session(
            self, api_gateway_event, lambda_context):
        """The anonymous half of #342. A session is a public write window onto its
        row; opened for a row nothing describes, it collects a room's ballots that
        the page then discards on read — and a room's votes cannot be recast. So
        the window is refused at creation, where the facilitator is present to see
        the answer, rather than the loss surfacing later as a warning in a log.

        404, not 400: the id is well-formed and the page sent one it was shown —
        the world changed, not the request. Reverting the fix (removing the
        `_row_exists` check) fails this on the status: the session opens."""
        table = FakeAggregatesTable([])

        status, body = _create(table, api_gateway_event, lambda_context,
                               body={'row_id': 'row_gone_default'}, seed_row=False)

        assert status == 404
        assert 'does not exist' in body['error']
        assert 'row_gone_default' not in body['error'], 'no echo of caller input'
        assert table.put_item_calls == []

    def test_a_failed_row_read_is_a_server_fault_not_a_refusal(
            self, api_gateway_event, lambda_context):
        """'Missing' would refuse a facilitator standing in front of a room over a
        transient throttle; 'present' would open the window #342 exists to close.
        A failed read is neither — it raises, and the facilitator retries."""
        table = FakeAggregatesTable([])
        real_get = table.get_item

        def failing_get(**kwargs):
            if str(kwargs['Key']['sk']).startswith('ROW#'):
                raise ClientError(
                    {'Error': {'Code': 'ProvisionedThroughputExceededException'}},
                    'GetItem',
                )
            return real_get(**kwargs)

        table.get_item = failing_get

        status, _ = _create(table, api_gateway_event, lambda_context,
                            body={'row_id': 'row_p1_default'})

        assert status == 500
        assert table.put_item_calls == []

    def test_the_session_id_is_unguessable_and_recognisable(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])

        _, first = _create(table, api_gateway_event, lambda_context, body={'row_id': 'a'})
        _, second = _create(table, api_gateway_event, lambda_context, body={'row_id': 'a'})

        assert re.fullmatch(r'vs_[0-9a-f]{32}', first['session']['session_id'])
        assert first['session']['session_id'] != second['session']['session_id']

    def test_the_cap_and_the_lifetime_are_clamped_not_trusted(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])

        _, body = _create(table, api_gateway_event, lambda_context,
                          body={'row_id': 'a', 'ballot_cap': 10_000,
                                'expires_in_minutes': 100_000})

        assert body['session']['ballot_cap'] == 200

    def test_closing_is_idempotent_because_it_is_done_under_pressure(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])

        first = _close(table, api_gateway_event, lambda_context)
        second = _close(table, api_gateway_event, lambda_context)

        assert first[0] == second[0] == 200
        assert table.session()['status'] == 'closed'

    def test_closing_a_session_that_never_existed_creates_no_stub(
            self, api_gateway_event, lambda_context):
        # `update_item` is an upsert; without the existence condition this would
        # leave a bare {pk, sk, status: closed} record behind.
        table = FakeAggregatesTable([])

        status, _ = _close(table, api_gateway_event, lambda_context)

        assert status == 404
        assert table.items == {}

    def test_the_status_view_reports_expiry_separately_from_closure(
            self, api_gateway_event, lambda_context):
        # The facilitator UI keys its QR on `state`, so the two have to be
        # distinguishable in the response: `status` says who ended the vote,
        # `state` says whether it still takes ballots.
        table = FakeAggregatesTable([open_session(ttl=PAST)])
        event = api_gateway_event(
            method='GET',
            path=f'/voting-sessions/{OPEN_SESSION_ID}',
            path_params={'session_id': OPEN_SESSION_ID},
        )

        status, body = _call(table, event, lambda_context)

        assert status == 200
        assert body['session']['status'] == 'open'
        assert body['session']['state'] == 'expired'


class TestASessionOpenedBeforeThisChangeDoesNotEatARoomsBallots:
    """A session record written by the PREVIOUS deployment names a `document_id` and
    no `row_id`, and one such session can be open, unexpired and on a screen at the
    moment this deploys.

    The failure this pins out is silent and happens mid-meeting. The room's phones
    ask the config route, it answers `open: true`, everyone fills in the form, and
    every submission is refused — or, had the document id been adopted as a row id,
    every ballot lands on `BALLOT#{document_id}#anon:...`, a key the page resolves
    to no row and drops on read, so each phone says "thanks" and the team's score
    does not move. Either way the facilitator learns nothing until they look at a
    score that did not change.

    CLOSED is the answer, everywhere, because it is true of what can be done with
    the session and both pages already have words for it: the room reads "this
    voting session is closed" and the facilitator re-opens, which composes a session
    on the row.
    """

    @staticmethod
    def _pre_row_session(**overrides):
        item = open_session(**overrides)
        item['document_id'] = item.pop('row_id')
        item['document_title'] = item.pop('row_title')
        return item

    def test_the_public_config_route_says_closed_rather_than_inviting_a_ballot(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([self._pre_row_session()])

        status, body = _config(table, api_gateway_event, lambda_context)

        assert status == 200
        assert body['session']['open'] is False
        assert body['session']['reason'] == 'closed'

    def test_it_still_names_the_thing_so_the_page_is_not_blank(
            self, api_gateway_event, lambda_context):
        """Titling is presentation and a stale title misleads nobody; keying is not,
        which is why the row id has no matching fallback."""
        table = FakeAggregatesTable([self._pre_row_session()])

        _, body = _config(table, api_gateway_event, lambda_context)

        assert body['session']['row_title'] == 'Instant refunds'

    def test_a_ballot_submitted_through_it_is_refused_as_closed(
            self, api_gateway_event, lambda_context):
        """`closed` and not `not_found`: the session exists and the room can see it
        did. `not_found` would have the page say the link is wrong."""
        table = FakeAggregatesTable([self._pre_row_session()])

        status, body = _submit(table, api_gateway_event, lambda_context)

        assert status == 409
        assert body['reason'] == 'closed'

    def test_no_ballot_is_written_on_a_document_keyed_sort_key(
            self, api_gateway_event, lambda_context):
        """THE POINT. A ballot on `BALLOT#{document_id}#anon:...` is a vote the
        aggregate never reads — recorded, acknowledged, and invisible. Nothing is
        better than that."""
        table = FakeAggregatesTable([self._pre_row_session()])

        _submit(table, api_gateway_event, lambda_context)

        assert table.ballot_keys == []

    def test_the_slot_claim_never_runs_so_the_count_does_not_move(
            self, api_gateway_event, lambda_context):
        """Refused before the conditional hold, so a room retrying against a dead
        session cannot exhaust its cap."""
        table = FakeAggregatesTable([self._pre_row_session()])

        _submit(table, api_gateway_event, lambda_context)

        assert table.session(OPEN_SESSION_ID)['ballot_count'] == 0

    def test_the_facilitators_status_view_agrees_it_is_closed(
            self, api_gateway_event, lambda_context):
        """The facilitator UI keys its QR on `state`, so this is what takes a dead
        QR off the screen and offers re-opening."""
        table = FakeAggregatesTable([self._pre_row_session()])
        event = api_gateway_event(
            method='GET',
            path=f'/voting-sessions/{OPEN_SESSION_ID}',
            path_params={'session_id': OPEN_SESSION_ID},
        )

        status, body = _call(table, event, lambda_context)

        assert status == 200
        assert body['session']['state'] == 'closed'
        assert body['session']['row_id'] == '', (
            'a document id must not be handed back as a row id: the page would '
            'address a row that does not exist'
        )

    def test_a_session_naming_a_row_is_unaffected(
            self, api_gateway_event, lambda_context):
        """The guard must not cost the normal case anything — this is the regression
        that fails if the state test is widened past "names no usable row"."""
        table = FakeAggregatesTable([open_session()])

        status, body = _submit(table, api_gateway_event, lambda_context)

        assert status == 200
        assert body['success'] is True
        assert table.ballot_keys and table.ballot_keys[0].startswith(
            'BALLOT#row_proj_20260817_default#anon:'
        )

    def test_a_row_id_carrying_the_key_delimiter_is_treated_the_same_way(
            self, api_gateway_event, lambda_context):
        """Unreachable through `create_voting_session`, which refuses it. Still
        refused here rather than trusted, because the write would land on a
        mis-split key and surface in the aggregate as a phantom row."""
        table = FakeAggregatesTable([open_session(row_id='row#injected')])

        status, body = _submit(table, api_gateway_event, lambda_context)

        assert status == 409
        assert body['reason'] == 'closed'
        assert table.ballot_keys == []
