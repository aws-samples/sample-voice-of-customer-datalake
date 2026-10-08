"""Mutation hardening for `api/ballots_handler.py`.

`test_ballots_handler.py` pins the BEHAVIOUR of the one public write path — the
cap holds in the database, a dead session is refused with a reason, a correction
consumes no slot — and a mutation run of the module found the things a behaviour
test leaves unsaid:

* the LITERAL WORDING. Every refusal sentence, every validator message carried
  into an `invalid` refusal, every log line (and exactly how much of the session
  token each one carries), and the `error` of each 500 are read by somebody — a
  phone, a terminal, an operator — and none were pinned as text.
* the EXACT EXPRESSIONS handed to DynamoDB. The slot claim, the close and the
  ballot transaction were asserted by substring; a conjunct dropped from the end
  of a condition, an alias renamed, or `:one` becoming `2` passed every test.
* the DEFAULTS AND BOUNDS a facilitator never types: a cap of 40, a lifetime of
  180 minutes, a floor of 5 minutes and 1 ballot, a title cut at 200 characters.
* the RETRY SCHEDULE. Delays were asserted as "between 0 and 1"; the backoff
  base, the doubling, the jitter's range and the attempt count (3, not "the
  constant") are literal here.
* the TRANSIENT/PERMANENT SPLIT on a cancelled transaction, read at index 1 of
  the reasons and nowhere else, and the fail-closed readings of a reason list
  that is short, not a list, or not made of dicts.

Helpers (`FakeAggregatesTable`, `open_session`, the route callers) are the sibling
file's; nothing here computes an expectation.
"""
import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import ClassVar
from unittest.mock import MagicMock, call, patch

import pytest
from ballots_fixtures import cancelled_transaction, fail_updates_of
from botocore.exceptions import ClientError
from test_ballots_handler import (
    AXES,
    FUTURE,
    OPEN_SESSION_ID,
    PAST,
    FakeAggregatesTable,
    _call,
    _close,
    _config,
    _create,
    _session_route,
    _status,
    _submit,
    open_session,
)

import ballots_handler
from shared.exceptions import ServiceError

SESSION_SK = f'SESSION#{OPEN_SESSION_ID}'
ROW_ID = 'row_proj_20260817_default'
ROW_SK = f'ROW#{ROW_ID}'
REF = 'vs_1a1a1a1a...'
NOW = datetime(2026, 8, 17, 12, 0, 0, tzinfo=UTC)
NOW_ISO = '2026-08-17T12:00:00+00:00'
# `int(NOW.timestamp())`, written out so the `:now_epoch` and `ttl` pins are literal.
NOW_EPOCH = 1786968000


def _messages(logger, level):
    return [c.args[0] for c in getattr(logger, level).call_args_list]


def _frozen_now():
    return patch('ballots_handler._now', return_value=NOW)


def _raise_on(table, method, exc):
    """Make `table.<method>` raise `exc` on every call."""
    def failing(**_kwargs):
        raise exc
    setattr(table, method, failing)
    return table


class TestEveryRefusalIsSpelledOut:
    """The phone dispatches on `reason`, a terminal reads `error`: both are literal."""

    @pytest.mark.parametrize(('overrides', 'status', 'reason', 'error'), [
        ({'status': 'closed'}, 409, 'closed', 'This voting session is closed'),
        ({'ttl': PAST}, 409, 'expired', 'This voting session has expired'),
        ({'ballot_cap': 1, 'ballot_count': 1}, 429, 'cap_reached',
         'This voting session has reached its ballot limit'),
    ])
    def test_a_dead_or_full_session(self, api_gateway_event, lambda_context,
                                    overrides, status, reason, error):
        table = FakeAggregatesTable([open_session(**overrides)])
        got_status, body = _submit(table, api_gateway_event, lambda_context)
        assert (got_status, body) == (status, {'success': False, 'reason': reason, 'error': error})

    def test_an_unknown_session(self, api_gateway_event, lambda_context):
        status, body = _submit(FakeAggregatesTable([]), api_gateway_event, lambda_context)
        assert (status, body) == (404, {
            'success': False, 'reason': 'not_found', 'error': 'This voting session does not exist',
        })

    def test_a_row_that_vanished_after_the_vote_opened(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()], rows_exist=False)
        status, body = _submit(table, api_gateway_event, lambda_context)
        assert (status, body) == (404, {
            'success': False, 'reason': 'not_found', 'error': 'That proposal no longer exists',
        })

    @pytest.mark.parametrize(('body', 'error'), [
        ({}, 'a ballot must score at least one of: impact, time_to_market, confidence, strategic_fit'),
        ({'impact': 'four'}, 'impact must be a number between 0 and 5'),
        ({'strategic_fit': True}, 'strategic_fit must be a number between 0 and 5'),
        ({**AXES, 'notes': 7}, 'notes must be a string'),
        ({**AXES, 'notes': 'x' * 2001}, 'notes must be at most 2000 characters'),
    ])
    def test_a_ballot_that_cannot_be_read_carries_the_validators_sentence(
            self, api_gateway_event, lambda_context, body, error):
        table = FakeAggregatesTable([open_session()])
        status, response = _submit(table, api_gateway_event, lambda_context, body=body)
        assert (status, response) == (400, {'success': False, 'reason': 'invalid', 'error': error})

    def test_a_refusal_with_no_override_uses_the_reasons_own_sentence(self):
        response = ballots_handler._refusal('invalid')
        assert response.status_code == 400
        assert response.content_type == 'application/json'
        assert response.body is not None
        assert json.loads(response.body) == {
            'success': False, 'reason': 'invalid', 'error': 'This ballot could not be read',
        }


class TestTheSubmitResponseAndTheStoredBallot:
    def test_the_response_is_exactly_four_fields(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        status, body = _submit(table, api_gateway_event, lambda_context)
        ballot_id = body['ballot_id']
        assert status == 200
        assert body == {'success': True, 'ballot_id': ballot_id,
                        'corrected': False, 'row_title': 'Instant refunds'}
        assert len(ballot_id) == 32

    def test_the_stored_ballot_carries_exactly_these_attributes(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        with _frozen_now():
            _, body = _submit(table, api_gateway_event, lambda_context,
                              body={**AXES, 'notes': '  why  ', 'display_name': 'Sam'})
        ballot_id = body['ballot_id']
        assert table.ballot(f'BALLOT#{ROW_ID}#anon:{ballot_id}') == {
            'pk': 'PRIORITIZATION', 'sk': f'BALLOT#{ROW_ID}#anon:{ballot_id}',
            'row_id': ROW_ID, 'reviewer': f'anon:{ballot_id}', 'updated_at': NOW_ISO,
            'voting_session': OPEN_SESSION_ID, 'impact': 4, 'time_to_market': 3,
            'confidence': 2, 'strategic_fit': 5, 'notes': 'why', 'display_name': 'Sam',
        }

    def test_only_the_axes_scored_are_written_and_a_null_axis_is_not_scored(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        status, _ = _submit(table, api_gateway_event, lambda_context,
                            body={'confidence': '3', 'impact': None})
        stored = table.ballot(table.ballot_keys[0])
        assert status == 200
        assert stored['confidence'] == 3
        assert {'impact', 'time_to_market', 'strategic_fit', 'notes', 'display_name'}.isdisjoint(stored)

    def test_a_whitespace_note_is_no_note(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        _submit(table, api_gateway_event, lambda_context, body={**AXES, 'notes': ' \n '})
        assert 'notes' not in table.ballot(table.ballot_keys[0])

    def test_the_transaction_is_spelled_exactly(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        with _frozen_now():
            _, body = _submit(table, api_gateway_event, lambda_context,
                              body={'impact': 2, 'notes': 'n', 'display_name': 'D'})
        ballot_id = body['ballot_id']
        assert table.transact_calls == [[
            {'Update': {
                'TableName': 'test-aggregates',
                'Key': {'pk': 'PRIORITIZATION', 'sk': f'BALLOT#{ROW_ID}#anon:{ballot_id}'},
                'UpdateExpression': (
                    'SET #row_id = :row_id, #reviewer = :reviewer, #updated_at = :updated_at, '
                    '#voting_session = :voting_session, #impact = :impact, #notes = :notes, '
                    '#display_name = :display_name'
                ),
                'ExpressionAttributeNames': {
                    '#row_id': 'row_id', '#reviewer': 'reviewer', '#updated_at': 'updated_at',
                    '#voting_session': 'voting_session', '#impact': 'impact',
                    '#notes': 'notes', '#display_name': 'display_name',
                },
                'ExpressionAttributeValues': {
                    ':row_id': ROW_ID, ':reviewer': f'anon:{ballot_id}', ':updated_at': NOW_ISO,
                    ':voting_session': OPEN_SESSION_ID, ':impact': 2, ':notes': 'n',
                    ':display_name': 'D',
                },
            }},
            {'Update': {
                'TableName': 'test-aggregates',
                'Key': {'pk': 'PRIORITIZATION', 'sk': ROW_SK},
                'ConditionExpression': 'attribute_exists(sk)',
                'UpdateExpression': (
                    'SET #frozen_at = if_not_exists(#frozen_at, :now) ADD #ballot_writes :one'
                ),
                'ExpressionAttributeNames': {
                    '#frozen_at': 'first_ballot_at', '#ballot_writes': 'ballot_writes',
                },
                'ExpressionAttributeValues': {':now': NOW_ISO, ':one': 1},
            }},
        ]]
        assert table.row()['first_ballot_at'] == NOW_ISO

    def test_a_correction_tolerates_whitespace_around_the_returned_id(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        _, first = _submit(table, api_gateway_event, lambda_context)
        _, second = _submit(table, api_gateway_event, lambda_context,
                            body={**AXES, 'ballot_id': f"  {first['ballot_id']}\n"})
        assert (second['corrected'], second['ballot_id']) == (True, first['ballot_id'])
        assert table.get_item_calls[-1]['Key'] == {
            'pk': 'PRIORITIZATION', 'sk': f"BALLOT#{ROW_ID}#anon:{first['ballot_id']}",
        }


class TestTheHoldIsOneExactConditionalWrite:
    def test_a_new_ballot_claims_a_slot(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        with _frozen_now():
            _submit(table, api_gateway_event, lambda_context)
        assert table.update_item_calls == [{
            'Key': {'pk': 'VOTING_SESSION', 'sk': SESSION_SK},
            'UpdateExpression': 'SET updated_at = :now, ballot_count = ballot_count + :one',
            'ConditionExpression': (
                'attribute_exists(sk) AND #status = :open AND #ttl > :now_epoch '
                'AND ballot_count < ballot_cap'
            ),
            'ExpressionAttributeNames': {'#status': 'status', '#ttl': 'ttl'},
            'ExpressionAttributeValues': {
                ':now': NOW_ISO, ':open': 'open', ':now_epoch': NOW_EPOCH, ':one': 1,
            },
        }]
        assert table.session()['updated_at'] == NOW_ISO

    def test_a_correction_claims_nothing(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        _, first = _submit(table, api_gateway_event, lambda_context)
        with _frozen_now():
            _submit(table, api_gateway_event, lambda_context,
                    body={**AXES, 'ballot_id': first['ballot_id']})
        assert table.update_item_calls[1] == {
            'Key': {'pk': 'VOTING_SESSION', 'sk': SESSION_SK},
            'UpdateExpression': 'SET updated_at = :now',
            'ConditionExpression': 'attribute_exists(sk) AND #status = :open AND #ttl > :now_epoch',
            'ExpressionAttributeNames': {'#status': 'status', '#ttl': 'ttl'},
            'ExpressionAttributeValues': {':now': NOW_ISO, ':open': 'open', ':now_epoch': NOW_EPOCH},
        }

    def test_a_refused_hold_on_a_session_that_vanished_is_not_found(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        real = table.update_item

        def vanish(**kwargs):
            table.items.pop(('VOTING_SESSION', SESSION_SK))
            return real(**kwargs)

        table.update_item = vanish
        status, body = _submit(table, api_gateway_event, lambda_context)
        assert (status, body['reason']) == (404, 'not_found')

    def test_a_refused_correction_that_still_reads_open_is_answered_closed(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        _, first = _submit(table, api_gateway_event, lambda_context)
        fail_updates_of(table, SESSION_SK, code='ConditionalCheckFailedException')
        status, body = _submit(table, api_gateway_event, lambda_context,
                               body={**AXES, 'ballot_id': first['ballot_id']})
        assert (status, body['reason']) == (409, 'closed')

    @pytest.mark.parametrize('exc', [
        ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'UpdateItem'),
        RuntimeError('socket closed'),
    ])
    def test_any_other_failure_of_the_hold_is_a_500(
            self, api_gateway_event, lambda_context, exc):
        logger = MagicMock()
        table = _raise_on(FakeAggregatesTable([open_session()]), 'update_item', exc)
        status, body = _submit(table, api_gateway_event, lambda_context, logger=logger)
        assert (status, body) == (500, {'success': False, 'error': 'Failed to record the ballot'})
        assert _messages(logger, 'exception') == [
            f'Failed to claim a ballot slot on session {REF}: {exc}',
        ]


class TestTheSessionStateIsReadFromTheDeadline:
    def test_the_deadline_is_exclusive(self):
        assert ballots_handler._session_state(open_session(ttl=NOW_EPOCH), NOW) == 'expired'
        assert ballots_handler._session_state(open_session(ttl=NOW_EPOCH + 1), NOW) == 'open'

    @pytest.mark.parametrize(('ttl', 'state'), [
        (str(FUTURE), 'open'),
        (Decimal(FUTURE), 'open'),
        (float(PAST), 'expired'),
        ('not-a-number', 'expired'),
        (None, 'expired'),
        ([FUTURE], 'expired'),
    ])
    def test_every_representation_of_the_deadline(self, ttl, state):
        assert ballots_handler._session_state(open_session(ttl=ttl), NOW) == state

    @pytest.mark.parametrize(('item', 'row_id'), [
        (open_session(status='closed'), ROW_ID),
        (open_session(status=None), ROW_ID),
        (open_session(row_id=''), ''),
        (open_session(row_id=7), ''),
        (open_session(row_id='a#b'), ''),
    ])
    def test_a_record_that_is_not_open_on_a_usable_row_is_closed(self, item, row_id):
        assert ballots_handler._session_state(item, NOW) == 'closed'
        assert ballots_handler._session_row_id(item) == row_id

    def test_the_title_prefers_row_title_then_document_title_then_nothing(self):
        both = {'row_title': 'Row', 'document_title': 'Doc'}
        assert ballots_handler._session_row_title(both) == 'Row'
        assert ballots_handler._session_row_title({'row_title': '', 'document_title': 'Doc'}) == 'Doc'
        assert ballots_handler._session_row_title({'row_title': 3, 'document_title': None}) == ''


class TestTheSessionIdIsValidatedBeforeAnyRead:
    @pytest.mark.parametrize('raw', [
        f'  {OPEN_SESSION_ID}\n', OPEN_SESSION_ID,
    ])
    def test_a_padded_id_is_accepted_and_stripped(self, raw):
        assert ballots_handler._validated_session_id(raw) == OPEN_SESSION_ID

    @pytest.mark.parametrize('raw', [
        None, 42, 'vs_' + '1a' * 15, 'vs_' + '1a' * 16 + '1', 'vs_' + '1A' * 16,
        'VS_' + '1a' * 16, 'vs-' + '1a' * 16, '1a' * 16, 'vs_' + '1a' * 16 + 'x',
    ])
    def test_anything_else_is_none(self, raw):
        assert ballots_handler._validated_session_id(raw) is None


class TestTheFacilitatorRoutesAreSpelledOut:
    def test_opening_with_nothing_but_a_row_uses_the_defaults(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])
        with _frozen_now():
            status, body = _create(table, api_gateway_event, lambda_context,
                                   body={'row_id': 'row_p1_default'})
        session_id = body['session']['session_id']
        assert status == 200
        assert body == {'success': True, 'session': {
            'session_id': session_id, 'row_id': 'row_p1_default', 'row_title': '',
            'status': 'open', 'state': 'open', 'ballot_cap': 40, 'ballot_count': 0,
            'created_at': NOW_ISO, 'expires_at': '2026-08-17T15:00:00+00:00', 'closed_at': '',
        }}
        assert table.session(session_id) == {
            'pk': 'VOTING_SESSION', 'sk': f'SESSION#{session_id}', 'session_id': session_id,
            'row_id': 'row_p1_default', 'row_title': '', 'status': 'open', 'ballot_cap': 40,
            'ballot_count': 0, 'created_by': 'facilitator-sub', 'created_at': NOW_ISO,
            'updated_at': NOW_ISO, 'expires_at': '2026-08-17T15:00:00+00:00',
            'ttl': NOW_EPOCH + 3 * 3600,
        }

    def test_the_row_is_read_strongly_consistently(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])
        _create(table, api_gateway_event, lambda_context, body={'row_id': 'row_p1_default'})
        assert table.get_item_calls == [{
            'Key': {'pk': 'PRIORITIZATION', 'sk': 'ROW#row_p1_default'}, 'ConsistentRead': True,
        }]

    @pytest.mark.parametrize(('given', 'cap', 'minutes'), [
        ({'ballot_cap': 0, 'expires_in_minutes': 4}, 1, 5),
        ({'ballot_cap': 1, 'expires_in_minutes': 5}, 1, 5),
        ({'ballot_cap': 200, 'expires_in_minutes': 1440}, 200, 1440),
        ({'ballot_cap': 201, 'expires_in_minutes': 1441}, 200, 1440),
        ({'ballot_cap': 'x', 'expires_in_minutes': 'y'}, 40, 180),
    ])
    def test_the_cap_and_the_lifetime_bounds(self, api_gateway_event, lambda_context,
                                             given, cap, minutes):
        table = FakeAggregatesTable([])
        with _frozen_now():
            _, body = _create(table, api_gateway_event, lambda_context,
                              body={'row_id': 'a', **given})
        stored = table.session(body['session']['session_id'])
        expires = datetime.fromisoformat(stored['expires_at'])
        assert stored['ballot_cap'] == cap
        assert expires - NOW == timedelta(minutes=minutes)
        assert stored['ttl'] == int(expires.timestamp())

    def test_the_title_is_sanitised_and_cut_at_200(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])
        _, body = _create(table, api_gateway_event, lambda_context,
                          body={'row_id': 'a', 'row_title': 'A\tB\u200b  C' + 'x' * 300})
        assert body['session']['row_title'] == 'A B C' + 'x' * 195
        assert len(body['session']['row_title']) == 200

    def test_a_row_with_a_project_stamps_it_and_one_without_does_not(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])
        table.items[('PRIORITIZATION', 'ROW#scoped')] = {
            'pk': 'PRIORITIZATION', 'sk': 'ROW#scoped', 'project_id': 'p1',
        }
        table.items[('PRIORITIZATION', 'ROW#blank')] = {
            'pk': 'PRIORITIZATION', 'sk': 'ROW#blank', 'project_id': '',
        }
        _, scoped = _create(table, api_gateway_event, lambda_context, body={'row_id': 'scoped'})
        _, blank = _create(table, api_gateway_event, lambda_context, body={'row_id': 'blank'})
        assert table.session(scoped['session']['session_id'])['project_id'] == 'p1'
        assert 'project_id' not in table.session(blank['session']['session_id'])

    def test_a_failed_session_write_is_a_500_that_names_the_row(
            self, api_gateway_event, lambda_context):
        logger = MagicMock()
        exc = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'PutItem')
        table = _raise_on(FakeAggregatesTable([]), 'put_item', exc)
        with patch('ballots_handler.logger', logger):
            status, body = _create(table, api_gateway_event, lambda_context,
                                   body={'row_id': 'row_p1_default'})
        assert (status, body) == (500, {'success': False, 'error': 'Failed to open the voting session'})
        assert _messages(logger, 'exception') == [
            f'Failed to open voting session for row_p1_default: {exc}',
        ]

    def test_a_failed_row_read_names_itself(self, api_gateway_event, lambda_context):
        logger = MagicMock()
        table = _raise_on(FakeAggregatesTable([]), 'get_item', RuntimeError('boom'))
        with patch('ballots_handler.logger', logger):
            status, body = _create(table, api_gateway_event, lambda_context,
                                   body={'row_id': 'row_p1_default'})
        assert (status, body['error']) == (500, 'Failed to open the voting session')
        assert _messages(logger, 'exception') == [
            'Failed to read a prioritization row before opening a session: boom',
        ]

    def test_closing_is_one_exact_conditional_update(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        with _frozen_now():
            status, body = _close(table, api_gateway_event, lambda_context)
        assert status == 200
        assert table.update_item_calls == [{
            'Key': {'pk': 'VOTING_SESSION', 'sk': SESSION_SK},
            'UpdateExpression': 'SET #status = :closed, closed_at = :now, updated_at = :now',
            'ConditionExpression': 'attribute_exists(sk)',
            'ExpressionAttributeNames': {'#status': 'status'},
            'ExpressionAttributeValues': {':closed': 'closed', ':now': NOW_ISO},
            'ReturnValues': 'ALL_NEW',
        }]
        assert body == {'success': True, 'session': {
            'session_id': OPEN_SESSION_ID, 'row_id': ROW_ID, 'row_title': 'Instant refunds',
            'status': 'closed', 'state': 'closed', 'ballot_cap': 40, 'ballot_count': 0,
            'created_at': '2026-08-17T10:00:00+00:00',
            'expires_at': '2096-10-02T07:06:40+00:00', 'closed_at': NOW_ISO,
        }}

    def test_the_payload_fills_a_sparse_record_with_empty_defaults(
            self, api_gateway_event, lambda_context):
        sparse = {'pk': 'VOTING_SESSION', 'sk': SESSION_SK, 'row_id': ROW_ID}
        table = FakeAggregatesTable([sparse])
        status, body = _status(table, api_gateway_event, lambda_context)
        assert status == 200
        assert body == {'success': True, 'session': {
            'session_id': '', 'row_id': ROW_ID, 'row_title': '', 'status': 'closed',
            'state': 'closed', 'ballot_cap': 0, 'ballot_count': 0, 'created_at': '',
            'expires_at': '', 'closed_at': '',
        }}

    @pytest.mark.parametrize('exc', [
        ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'UpdateItem'),
        RuntimeError('socket closed'),
    ])
    def test_any_other_failure_of_the_close_is_a_500(self, api_gateway_event, lambda_context, exc):
        logger = MagicMock()
        table = _raise_on(FakeAggregatesTable([open_session()]), 'update_item', exc)
        with patch('ballots_handler.logger', logger):
            status, body = _close(table, api_gateway_event, lambda_context)
        assert (status, body) == (500, {'success': False, 'error': 'Failed to close the voting session'})
        assert _messages(logger, 'exception') == [f'Failed to close voting session {REF}: {exc}']
        assert table.session()['status'] == 'open'

    @pytest.mark.parametrize('route', [_status, _close])
    def test_a_failed_session_read_is_a_500(self, api_gateway_event, lambda_context, route):
        logger = MagicMock()
        exc = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'GetItem')
        table = _raise_on(FakeAggregatesTable([open_session()]), 'get_item', exc)
        with patch('ballots_handler.logger', logger):
            status, body = route(table, api_gateway_event, lambda_context)
        assert (status, body) == (500, {'success': False, 'error': 'Failed to read the voting session'})
        assert _messages(logger, 'exception') == [f'Failed to read voting session {REF}: {exc}']

    @pytest.mark.parametrize('session_id', ['nope', 'vs_' + '00' * 16])
    def test_a_malformed_or_absent_session_reads_and_closes_as_not_found(
            self, api_gateway_event, lambda_context, session_id):
        table = FakeAggregatesTable([open_session()])
        read = _session_route(table, api_gateway_event, lambda_context,
                              method='GET', suffix='', session_id=session_id)
        closed = _close(table, api_gateway_event, lambda_context, session_id=session_id)
        assert read == closed == (404, {'success': False, 'error': 'Voting session not found'})
        assert table.update_item_calls == []

    def test_a_non_admin_without_a_projects_table_is_a_configuration_fault(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session(project_id='p1')])
        event = api_gateway_event(
            method='GET', path=f'/voting-sessions/{OPEN_SESSION_ID}',
            path_params={'session_id': OPEN_SESSION_ID},
            claims={'sub': 'viewer', 'cognito:groups': ''},
        )
        with patch('ballots_handler.get_projects_table', return_value=None):
            status, body = _call(table, event, lambda_context)
        assert (status, body['error']) == (500, 'Projects table not configured')

    def test_no_aggregates_table_is_a_configuration_fault(self, api_gateway_event, lambda_context):
        status, body = _submit(None, api_gateway_event, lambda_context)
        assert (status, body['error']) == (500, 'Aggregates table not configured')


class TestThePublicConfigRoute:
    def test_an_unknown_or_malformed_link_is_exactly_this(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])
        status, body = _config(table, api_gateway_event, lambda_context, session_id='nope')
        assert (status, body) == (200, {'success': True, 'session': {
            'open': False, 'reason': 'not_found', 'row_title': '',
        }})
        assert table.get_item_calls == []

    def test_a_closed_session_still_names_its_row(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session(status='closed')])
        _, body = _config(table, api_gateway_event, lambda_context)
        assert body == {'success': True, 'session': {
            'open': False, 'reason': 'closed', 'row_title': 'Instant refunds',
        }}

    def test_a_failed_read_is_a_500(self, api_gateway_event, lambda_context):
        table = _raise_on(FakeAggregatesTable([open_session()]), 'get_item', RuntimeError('x'))
        status, body = _config(table, api_gateway_event, lambda_context)
        assert (status, body) == (500, {'success': False, 'error': 'Failed to read the voting session'})


class TestEveryLogLineCarriesElevenCharactersOfTheToken:
    """`_session_ref` keeps the prefix plus eight hex characters and appends '...'."""

    def test_the_reference_shape(self):
        assert ballots_handler._session_ref(OPEN_SESSION_ID) == 'vs_1a1a1a1a...'
        assert ballots_handler._session_ref('vs_' + 'f' * 32) == 'vs_ffffffff...'

    def test_recording_a_ballot_and_a_correction(self, api_gateway_event, lambda_context):
        logger = MagicMock()
        table = FakeAggregatesTable([open_session()])
        _, first = _submit(table, api_gateway_event, lambda_context, logger=logger)
        _submit(table, api_gateway_event, lambda_context, logger=logger,
                body={**AXES, 'ballot_id': first['ballot_id']})
        assert _messages(logger, 'info') == [
            f'Recorded an anonymous ballot on session {REF} (correction=False)',
            f'Recorded an anonymous ballot on session {REF} (correction=True)',
        ]

    def test_opening_and_closing(self, api_gateway_event, lambda_context):
        logger = MagicMock()
        table = FakeAggregatesTable([open_session()])
        with patch('ballots_handler.logger', logger):
            _, body = _create(table, api_gateway_event, lambda_context,
                              body={'row_id': 'row_p1_default'})
            _close(table, api_gateway_event, lambda_context)
        opened = body['session']['session_id']
        assert _messages(logger, 'info') == [
            f'Opened voting session {opened[:11]}... for row row_p1_default',
            f'Closed voting session {REF}',
        ]

    def test_a_failed_ballot_read_names_the_session(self, api_gateway_event, lambda_context):
        logger = MagicMock()
        table = FakeAggregatesTable([open_session()])
        real = table.get_item

        def failing(**kwargs):
            if kwargs['Key']['sk'].startswith('BALLOT#'):
                raise RuntimeError('boom')
            return real(**kwargs)

        table.get_item = failing
        status, body = _submit(table, api_gateway_event, lambda_context, logger=logger,
                               body={**AXES, 'ballot_id': 'ab' * 16})
        assert (status, body['error']) == (500, 'Failed to record the ballot')
        assert _messages(logger, 'exception') == [
            f'Failed to read an anonymous ballot for session {REF}: boom',
        ]
        assert table.session()['ballot_count'] == 0


def _cancel_with(table, reasons, *, times=None):
    """Every (or the first `times`) ballot transaction is cancelled with `reasons`."""
    real = table.meta.client.transact_write_items
    attempts = []

    def cancelling(**kwargs):
        attempts.append(kwargs)
        if times is None or len(attempts) <= times:
            raise cancelled_transaction(reasons)
        return real(**kwargs)

    table.meta.client.transact_write_items = cancelling
    return attempts


class TestACancelledTransactionIsReadAtTheRowsIndex:
    ROW_GONE: ClassVar[list[dict[str, str]]] = [{'Code': 'None'}, {'Code': 'ConditionalCheckFailed'}]

    def test_the_rows_failed_condition_is_final_and_logged_once(
            self, api_gateway_event, lambda_context):
        logger = MagicMock()
        table = FakeAggregatesTable([open_session()])
        attempts = _cancel_with(table, self.ROW_GONE)
        with patch('ballots_handler.time.sleep') as slept:
            status, body = _submit(table, api_gateway_event, lambda_context, logger=logger)
        assert (status, body['reason']) == (404, 'not_found')
        assert (len(attempts), slept.call_count) == (1, 0)
        assert _messages(logger, 'warning') == [
            f'An anonymous ballot named a row that no longer exists, on session {REF}. '
            'Nothing was written.',
        ]

    @pytest.mark.parametrize('reasons', [
        pytest.param([{'Code': 'ConditionalCheckFailed'}, {'Code': 'None'}], id='ballot_index'),
        pytest.param([{'Code': 'ConditionalCheckFailed'}], id='too_short'),
        pytest.param({'Code': 'ConditionalCheckFailed'}, id='not_a_list'),
        pytest.param([{'Code': 'None'}, 'ConditionalCheckFailed'], id='not_a_dict'),
        pytest.param([{'Code': 'None'}, {'Code': 'TransactionConflict'}], id='conflict'),
    ])
    def test_anything_else_is_transient_and_retried_three_times(
            self, api_gateway_event, lambda_context, reasons):
        logger = MagicMock()
        table = FakeAggregatesTable([open_session()])
        attempts = _cancel_with(table, reasons)
        with patch('ballots_handler.time.sleep'):
            status, body = _submit(table, api_gateway_event, lambda_context, logger=logger)
        assert (status, body) == (500, {'success': False, 'error': 'Failed to record the ballot'})
        assert len(attempts) == 3
        assert _messages(logger, 'warning') == [
            f'An anonymous ballot write was cancelled without a failed condition on session '
            f'{REF}; retrying (attempt 2 of 3).',
            f'An anonymous ballot write was cancelled without a failed condition on session '
            f'{REF}; retrying (attempt 3 of 3).',
        ]
        assert len(_messages(logger, 'exception')) == 1
        assert _messages(logger, 'exception')[0].startswith(
            f'Failed to write an anonymous ballot for session {REF}: An error occurred '
            '(TransactionCanceledException)'
        )

    def test_the_predicate_itself(self):
        failed = ballots_handler._row_condition_failed
        assert failed(cancelled_transaction(self.ROW_GONE)) is True
        assert failed(cancelled_transaction([{'Code': 'None'}, {'Code': 'None'}])) is False
        assert failed(cancelled_transaction([{'Code': 'ConditionalCheckFailed'}])) is False
        assert failed(ClientError({'Error': {'Code': 'TransactionCanceledException'}}, 'x')) is False

    @pytest.mark.parametrize('exc', [
        ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'TransactWriteItems'),
        RuntimeError('socket closed'),
    ])
    def test_a_failure_that_is_not_a_cancellation_is_not_retried(
            self, api_gateway_event, lambda_context, exc):
        logger = MagicMock()
        table = FakeAggregatesTable([open_session()])
        attempts = []

        def failing(**kwargs):
            attempts.append(kwargs)
            raise exc

        table.meta.client.transact_write_items = failing
        with patch('ballots_handler.time.sleep') as slept:
            status, body = _submit(table, api_gateway_event, lambda_context, logger=logger)
        assert (status, body['error']) == (500, 'Failed to record the ballot')
        assert (len(attempts), slept.call_count) == (1, 0)
        assert _messages(logger, 'exception') == [
            f'Failed to write an anonymous ballot for session {REF}: {exc}',
        ]


class TestTheBackoffSchedule:
    """`0.05 * 2**attempt`, times a jitter in [0.5, 1.0) drawn as `randbelow(500) / 1000`."""

    @pytest.mark.parametrize(('draw', 'delays'), [
        (0, [0.025, 0.05]),
        (499, [0.05 * 0.999, 0.1 * 0.999]),
    ])
    def test_two_retries_sleep_these_exact_delays(self, api_gateway_event, lambda_context,
                                                  draw, delays):
        table = FakeAggregatesTable([open_session()])
        _cancel_with(table, [{'Code': 'None'}, {'Code': 'TransactionConflict'}])
        with patch('ballots_handler.time.sleep') as slept, \
                patch('ballots_handler.secrets.randbelow', return_value=draw) as randbelow:
            _submit(table, api_gateway_event, lambda_context)
        assert [c.args[0] for c in slept.call_args_list] == pytest.approx(delays)
        assert randbelow.call_args_list == [call(500), call(500)]

    def test_a_conflict_that_clears_on_the_third_attempt_is_recorded(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        attempts = _cancel_with(table, [{'Code': 'None'}, {'Code': 'TransactionConflict'}], times=2)
        with patch('ballots_handler.time.sleep') as slept:
            status, _ = _submit(table, api_gateway_event, lambda_context)
        assert (status, len(attempts), slept.call_count) == (200, 3, 2)
        assert table.row()['ballot_writes'] == 1

    def test_a_bound_of_zero_logs_the_misconfiguration(self, api_gateway_event, lambda_context):
        logger = MagicMock()
        table = FakeAggregatesTable([open_session()])
        with patch.object(ballots_handler, 'BALLOT_WRITE_ATTEMPTS', 0):
            status, body = _submit(table, api_gateway_event, lambda_context, logger=logger)
        assert (status, body['error']) == (500, 'Failed to record the ballot')
        assert _messages(logger, 'error') == [
            'An anonymous ballot write made no attempt at all, which means '
            'BALLOT_WRITE_ATTEMPTS is not at least 1. Refusing rather than reporting a '
            'ballot that was never written.',
        ]

    def test_the_constants_themselves(self):
        assert ballots_handler.BALLOT_WRITE_ATTEMPTS == 3
        assert ballots_handler.BALLOT_WRITE_BACKOFF_SECONDS == 0.05
        assert ballots_handler.BALLOT_TRANSACT_ROW_INDEX == 1
        assert ballots_handler.SESSION_LOG_REF_CHARS == 8


class TestTheRowIsGoneSignalIsAnException:
    def test_it_is_raised_from_the_cancellation(self):
        table = FakeAggregatesTable([open_session()])
        _cancel_with(table, [{'Code': 'None'}, {'Code': 'ConditionalCheckFailed'}])
        with patch('ballots_handler.get_aggregates_table', return_value=table), \
                pytest.raises(ballots_handler._RowIsGone) as info:
            ballots_handler._write_ballot(ROW_ID, 'ab' * 16, OPEN_SESSION_ID, {'impact': 1},
                                          None, '', NOW)
        assert isinstance(info.value.__cause__, ClientError)

    def test_a_service_error_is_raised_from_the_last_cancellation(self):
        table = FakeAggregatesTable([open_session()])
        _cancel_with(table, [{'Code': 'None'}, {'Code': 'TransactionConflict'}])
        with patch('ballots_handler.get_aggregates_table', return_value=table), \
                patch('ballots_handler.time.sleep'), \
                pytest.raises(ServiceError, match='Failed to record the ballot') as info:
            ballots_handler._write_ballot(ROW_ID, 'ab' * 16, OPEN_SESSION_ID, {'impact': 1},
                                          None, '', NOW)
        assert isinstance(info.value.__cause__, ClientError)


class TestTheProjectGateIsConsultedExactlyWhenThereIsAProject:
    """`_require_project_level` is skipped only for a MISSING or EMPTY project id; a
    session's stamp wins over its row, and a non-string stamp falls back to the row."""

    @staticmethod
    def _gated_call(table, api_gateway_event, lambda_context, *, method='GET', path=None,
                    body=None):
        """Call a facilitator route as a NON-admin with `project_gate` replaced, and
        return `(status, gate)` so the test can read what the gate was asked."""
        event = api_gateway_event(
            method=method, path=path or f'/voting-sessions/{OPEN_SESSION_ID}', body=body,
            path_params={'session_id': OPEN_SESSION_ID},
            claims={'sub': 'someone', 'cognito:groups': ''},
        )
        gate = MagicMock()
        with patch('ballots_handler.project_gate', gate):
            status, _ = _call(table, event, lambda_context)
            if gate.require_project_level.called:
                read_meta = gate.require_project_level.call_args.args[0]
                with patch('ballots_handler.get_projects_table', return_value='projects'):
                    assert read_meta() is gate.read_gate_meta.return_value
        return status, gate

    @staticmethod
    def _session_and_row(stamp, row_project):
        session = open_session()
        if stamp is not None:
            session['project_id'] = stamp
        table = FakeAggregatesTable([session])
        table.row()['project_id'] = row_project
        return table

    @pytest.mark.parametrize(('stamp', 'row_project', 'gated_on'), [
        ('p-session', 'p-row', 'p-session'),
        (7, 'p-row', 'p-row'),
        (None, 'p-row', 'p-row'),
    ])
    def test_the_status_route_gates_on_the_resolved_project(
            self, api_gateway_event, lambda_context, stamp, row_project, gated_on):
        table = self._session_and_row(stamp, row_project)
        status, gate = self._gated_call(table, api_gateway_event, lambda_context)
        assert status == 200
        _, caller, level = gate.require_project_level.call_args.args
        assert (caller, level) == (gate.caller_from_event.return_value, 'view')
        assert gate.require_project_level.call_args.kwargs == {
            'missing_message': 'Voting session not found',
        }
        gate.read_gate_meta.assert_called_once_with('projects', gated_on)

    @pytest.mark.parametrize('project_id', ['', None, 7])
    def test_a_row_without_a_usable_project_gates_nothing(
            self, api_gateway_event, lambda_context, project_id):
        table = self._session_and_row(project_id, project_id)
        status, gate = self._gated_call(table, api_gateway_event, lambda_context)
        assert status == 200
        gate.require_project_level.assert_not_called()
        gate.caller_from_event.assert_not_called()

    def test_opening_a_session_gates_on_edit_with_the_missing_row_message(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([])
        table.items[('PRIORITIZATION', 'ROW#r1')] = {
            'pk': 'PRIORITIZATION', 'sk': 'ROW#r1', 'project_id': 'p1',
        }
        status, gate = self._gated_call(table, api_gateway_event, lambda_context,
                                        method='POST', path='/voting-sessions',
                                        body={'row_id': 'r1'})
        assert status == 200
        assert gate.require_project_level.call_args.args[2] == 'edit'
        assert gate.require_project_level.call_args.kwargs == {
            'missing_message': 'that prioritization row does not exist; reload the page and '
                               'reopen the vote',
        }
        gate.read_gate_meta.assert_called_once_with('projects', 'p1')

    def test_opening_a_session_on_a_row_with_an_empty_project_gates_nothing(
            self, api_gateway_event, lambda_context):
        # The row's id is handed to the gate as-is (no session normalises it first),
        # so the EMPTY string has to be read as "no project" here too.
        table = FakeAggregatesTable([])
        table.items[('PRIORITIZATION', 'ROW#r1')] = {
            'pk': 'PRIORITIZATION', 'sk': 'ROW#r1', 'project_id': '',
        }
        status, gate = self._gated_call(table, api_gateway_event, lambda_context,
                                        method='POST', path='/voting-sessions',
                                        body={'row_id': 'r1'})
        assert status == 200
        gate.require_project_level.assert_not_called()
        gate.caller_from_event.assert_not_called()

    def test_closing_gates_on_edit(self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session(project_id='p1')])
        status, gate = self._gated_call(table, api_gateway_event, lambda_context,
                                        method='POST',
                                        path=f'/voting-sessions/{OPEN_SESSION_ID}/close')
        assert status == 200
        assert gate.require_project_level.call_args.args[2] == 'edit'

    def test_the_missing_row_is_the_same_404_for_absent_and_unviewable(
            self, api_gateway_event, lambda_context):
        status, body = _create(FakeAggregatesTable([]), api_gateway_event, lambda_context,
                               body={'row_id': 'row_gone'}, seed_row=False)
        assert (status, body) == (404, {
            'success': False,
            'error': 'that prioritization row does not exist; reload the page and reopen the vote',
        })

    def test_resolving_the_sessions_project(self):
        table = FakeAggregatesTable([open_session()])
        table.row()['project_id'] = 7
        with patch('ballots_handler.get_aggregates_table', return_value=table):
            assert ballots_handler._session_project_id({'project_id': 'p', 'row_id': ROW_ID}) == 'p'
            assert ballots_handler._session_project_id({'project_id': '', 'row_id': ROW_ID}) is None
            assert ballots_handler._session_project_id({'project_id': 'p', 'row_id': ''}) == 'p'
            assert ballots_handler._session_project_id({'row_id': ''}) is None
        assert len(table.get_item_calls) == 1


class TestSanitisingIsByUnicodeCategory:
    def test_a_non_whitespace_control_character_becomes_a_space(
            self, api_gateway_event, lambda_context):
        # `\\x01` is 'Cc' and NOT whitespace, so the whitespace collapse alone would
        # keep it; only the category test turns it into a space.
        table = FakeAggregatesTable([open_session()])
        _submit(table, api_gateway_event, lambda_context,
                body={**AXES, 'display_name': 'Sam\x01ADMIN'})
        assert table.ballot(table.ballot_keys[0])['display_name'] == 'Sam ADMIN'

    @pytest.mark.parametrize('raw', [5, None, ['Sam'], {'name': 'Sam'}])
    def test_a_display_name_that_is_not_a_string_is_not_a_name(
            self, api_gateway_event, lambda_context, raw):
        table = FakeAggregatesTable([open_session()])
        _submit(table, api_gateway_event, lambda_context, body={**AXES, 'display_name': raw})
        assert 'display_name' not in table.ballot(table.ballot_keys[0])

    def test_a_row_title_that_is_not_a_string_is_empty(self, api_gateway_event, lambda_context):
        _, body = _create(FakeAggregatesTable([]), api_gateway_event, lambda_context,
                          body={'row_id': 'a', 'row_title': 12})
        assert body['session']['row_title'] == ''


class TestTheCloseRace:
    def test_a_session_deleted_between_the_read_and_the_write_is_not_found(
            self, api_gateway_event, lambda_context):
        table = FakeAggregatesTable([open_session()])
        fail_updates_of(table, SESSION_SK, code='ConditionalCheckFailedException')
        status, body = _close(table, api_gateway_event, lambda_context)
        assert (status, body) == (404, {'success': False, 'error': 'Voting session not found'})


class TestTheBeltAndBracesRowGuard:
    def test_a_session_the_state_test_lets_through_without_a_row_is_still_refused(
            self, api_gateway_event, lambda_context):
        """Reachable only if `_session_state` is ever relaxed — simulated by relaxing it."""
        logger = MagicMock()
        session = open_session()
        session['document_id'] = session.pop('row_id')
        table = FakeAggregatesTable([session])
        with patch('ballots_handler._session_state', return_value='open'):
            status, body = _submit(table, api_gateway_event, lambda_context, logger=logger)
        assert (status, body['reason']) == (409, 'closed')
        assert _messages(logger, 'error') == [f'Voting session {REF} has no usable row_id']
        assert (table.update_item_calls, table.ballot_keys) == ([], [])


class TestEveryEntryPointIsInstrumented:
    """The routes carry the tracer and the handler carries `api_handler` (logger
    context, tracer, metrics); each decorator leaves `__wrapped__` behind."""

    @pytest.mark.parametrize('name', [
        'create_voting_session', 'get_voting_session', 'close_voting_session',
        'get_ballot_config', 'submit_ballot', 'lambda_handler',
    ])
    def test_it_is_wrapped(self, name):
        assert getattr(ballots_handler, name).__wrapped__.__qualname__ == name
