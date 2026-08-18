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


class FakeAggregatesTable:
    """An in-memory stand-in for the aggregates table.

    Supports `get_item`, `put_item`, and the conditional `SET` updates these
    routes issue. The condition evaluator understands only the four forms the
    handler uses (`attribute_exists(sk)`, `#name = :value`, `#name > :value`,
    `attr < attr`) and raises on anything else, so a new conjunct cannot pass
    unnoticed by being silently treated as true.
    """

    def __init__(self, items=None, close_after_reads=None):
        self.items = {(i['pk'], i['sk']): dict(i) for i in (items or [])}
        self.get_item_calls = []
        self.put_item_calls = []
        self.update_item_calls = []
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

        if item is None:
            item = {'pk': key[0], 'sk': key[1]}
            self.items[key] = item

        expression = kwargs['UpdateExpression'].strip()
        assert expression.upper().startswith('SET'), expression
        for assignment in expression[len('SET'):].split(','):
            target, _, source = (part.strip() for part in assignment.partition('='))
            attribute = names.get(target, target)
            item[attribute] = self._value(source, item, names, values)
        return {'Attributes': dict(item)} if kwargs.get('ReturnValues') == 'ALL_NEW' else {}

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
        return sorted(sk for (pk, sk) in self.items if pk == PRIORITIZATION_PK)

    def ballot(self, sort_key):
        return self.items.get((PRIORITIZATION_PK, sort_key))

    def session(self, session_id=OPEN_SESSION_ID):
        return self.items.get((SESSION_PK, f'SESSION#{session_id}'))


def open_session(session_id=OPEN_SESSION_ID, **overrides):
    """A stored session record, open and unexpired unless overridden."""
    return {
        'pk': SESSION_PK,
        'sk': f'SESSION#{session_id}',
        'session_id': session_id,
        'document_id': 'prfaq_20260817',
        'document_title': 'Instant refunds',
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


def _create(table, api_gateway_event, lambda_context, *, body, subject='facilitator-sub'):
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
        assert table.ballot(f"BALLOT#{before['document_id']}#anon:{mine['ballot_id']}") == before

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
        assert table.ballot(f'BALLOT#prfaq_20260817#anon:{chosen}') is None
        assert table.ballot_keys == [f"BALLOT#prfaq_20260817#anon:{body['ballot_id']}"]


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
                               body={'document_id': 'prd_1', 'document_title': 'Refunds'})

        assert status == 200
        stored = table.session(body['session']['session_id'])
        assert isinstance(stored['ttl'], int)
        assert stored['ballot_count'] == 0

    def test_the_document_comes_from_the_session_not_from_the_body(
            self, api_gateway_event, lambda_context):
        # A public caller does not get to choose which proposal it is scoring.
        table = FakeAggregatesTable([open_session()])

        _submit(table, api_gateway_event, lambda_context,
                body={**AXES, 'document_id': 'prd_somebody_elses'})

        assert table.ballot_keys[0].startswith('BALLOT#prfaq_20260817#anon:')

    def test_the_ballot_records_which_session_cast_it(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])

        _submit(table, api_gateway_event, lambda_context)

        assert table.ballot(table.ballot_keys[0])['voting_session'] == OPEN_SESSION_ID


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
                              body={'document_id': 'prd_1'})
        lines = self._logged(logger)

        assert body['session']['session_id'] not in lines
        assert 'prd_1' in lines, 'an operator still needs the document'

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
    def test_an_open_session_names_the_document_and_nothing_else(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session(ballot_count=11)])

        status, body = _config(table, api_gateway_event, lambda_context)

        assert status == 200
        assert body['session'] == {
            'open': True, 'reason': None, 'document_title': 'Instant refunds',
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
                          body={'document_id': 'prd_1'}, subject='alice')

        assert table.session(body['session']['session_id'])['created_by'] == 'alice'
        assert 'alice' not in json.dumps(body)

    def test_a_caller_with_no_readable_subject_cannot_open_one(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])

        status, _ = _create(table, api_gateway_event, lambda_context,
                            body={'document_id': 'prd_1'}, subject=None)

        assert status == 403
        assert table.put_item_calls == []

    def test_a_document_id_carrying_the_key_delimiter_is_refused(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])

        status, _ = _create(table, api_gateway_event, lambda_context,
                            body={'document_id': 'prd#1'})

        assert status == 400
        assert table.put_item_calls == []

    def test_the_session_id_is_unguessable_and_recognisable(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])

        _, first = _create(table, api_gateway_event, lambda_context, body={'document_id': 'a'})
        _, second = _create(table, api_gateway_event, lambda_context, body={'document_id': 'a'})

        assert re.fullmatch(r'vs_[0-9a-f]{32}', first['session']['session_id'])
        assert first['session']['session_id'] != second['session']['session_id']

    def test_the_cap_and_the_lifetime_are_clamped_not_trusted(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])

        _, body = _create(table, api_gateway_event, lambda_context,
                          body={'document_id': 'a', 'ballot_cap': 10_000,
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
