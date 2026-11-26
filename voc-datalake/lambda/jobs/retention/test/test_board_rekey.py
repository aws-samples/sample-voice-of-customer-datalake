"""The boards phase re-keys an erased +1 (boards_rekey.py): new random id, old row gone, totals kept."""
from typing import Any
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError

from jobs.retention import boards_rekey
from shared.feature_boards_store import board_key
from shared.feature_requests_store import compute_totals, support_id_for, support_key

REQUEST = 'fr_000000000001'


def _seed(aws, *, version: int | None = 0) -> str:
    """A sales-board request with the account manager's own +1 (email-derived id) and the support engineer's; the
    account manager's old support id."""
    table = aws['feature_requests']
    table.put_item(Item={**board_key('brd_ops'), 'board_id': 'brd_ops', 'template': 'sales'})
    meta = {'pk': f'FR#{REQUEST}', 'sk': 'META', 'request_id': REQUEST, 'board_id': 'brd_ops',
            'totals': {'supporters': 2, 'customers': 2}}
    if version is not None:
        meta['version'] = version
    table.put_item(Item=meta)
    old_id = support_id_for(REQUEST, 'account.manager@example.com')
    table.put_item(Item={**support_key(REQUEST, old_id), 'support_id': old_id, 'request_id': REQUEST,
                         'email': 'account.manager@example.com', 'name': 'Account manager', 'is_reporter': True, 'customer': 'Example Air',
                         'impact': 'committed', 'amount_usd': 500, 'created_at': '2026-03-04T10:00:00+00:00'})
    engineer = support_id_for(REQUEST, 'support.engineer@example.com')
    table.put_item(Item={**support_key(REQUEST, engineer), 'support_id': engineer, 'request_id': REQUEST,
                         'email': 'support.engineer@example.com', 'customer': 'Other Co', 'created_at': '2026-03-05T10:00:00+00:00'})
    return old_id


def test_the_rekeyed_support_keeps_its_values_without_the_person(aws):
    table = aws['feature_requests']
    old_id = _seed(aws)
    new_id = boards_rekey.new_support_id()
    assert new_id.startswith('sup_')
    assert new_id != old_id
    current = boards_rekey.current_support(table, REQUEST, old_id)
    assert current is not None
    assert boards_rekey.rekey(table, current, new_id) == boards_rekey.SUPPORT_REKEYED
    assert 'Item' not in table.get_item(Key=support_key(REQUEST, old_id))
    row = table.get_item(Key=support_key(REQUEST, new_id))['Item']
    assert (row['support_id'], row['request_id'], row['is_reporter']) == (new_id, REQUEST, True)
    assert (row['customer'], row['impact'], row['amount_usd']) == ('Example Air', 'committed', 500)
    assert row['created_at'] == '2026-03-04T10:00:00+00:00'
    assert row['deidentified_at']
    assert 'email' not in row
    assert 'name' not in row
    assert old_id not in str(row)


def test_a_support_gone_meanwhile_is_not_brought_back(aws):
    table = aws['feature_requests']
    old_id = _seed(aws)
    current = boards_rekey.current_support(table, REQUEST, old_id)
    assert current is not None
    table.delete_item(Key=support_key(REQUEST, old_id))  # removed between the read and the write
    assert boards_rekey.rekey(table, current, 'sup_00000000000f') == boards_rekey.SUPPORT_GONE
    assert boards_rekey.current_support(table, REQUEST, old_id) is None
    assert 'Item' not in table.get_item(Key=support_key(REQUEST, 'sup_00000000000f'))


@pytest.mark.parametrize('edit', ['SET updated_at = :u', 'SET customer = :c, updated_at = :u'])
def test_a_support_changed_meanwhile_is_left_as_it_now_is(aws, edit):
    """The Delete holds only while the row is as read (``updated_at``; none at the seed): an edit between the read and
    the write cancels the move, and the edit stands."""
    table = aws['feature_requests']
    old_id = _seed(aws)
    current = boards_rekey.current_support(table, REQUEST, old_id)
    assert current is not None
    values = {':u': '2026-11-26T10:00:00+00:00', **({':c': 'Edited Co'} if ':c' in edit else {})}
    table.update_item(Key=support_key(REQUEST, old_id), UpdateExpression=edit, ExpressionAttributeValues=values)

    assert boards_rekey.rekey(table, current, 'sup_00000000000f') == boards_rekey.SUPPORT_CHANGED

    assert boards_rekey.current_support(table, REQUEST, old_id) == {
        **current, 'updated_at': values[':u'], **({'customer': 'Edited Co'} if ':c' in edit else {})}
    assert 'Item' not in table.get_item(Key=support_key(REQUEST, 'sup_00000000000f'))
    again = boards_rekey.current_support(table, REQUEST, old_id)
    assert again is not None
    assert boards_rekey.rekey(table, again, 'sup_00000000000f') == boards_rekey.SUPPORT_REKEYED


def _cancelled(*codes: str, item: bool = False) -> ClientError:
    reasons: list[Any] = [{'Code': code, **({'Item': {'pk': {'S': 'x'}}} if item and n == 1 else {})}
                          for n, code in enumerate(codes)]
    return ClientError({'Error': {'Code': 'TransactionCanceledException'}, 'CancellationReasons': reasons},
                       'TransactWriteItems')


@pytest.mark.parametrize(('error', 'outcome'), [
    (_cancelled('None', 'ConditionalCheckFailed'), boards_rekey.SUPPORT_GONE),
    (_cancelled('None', 'ConditionalCheckFailed', item=True), boards_rekey.SUPPORT_CHANGED),
    (_cancelled('None', 'TransactionConflict'), boards_rekey.SUPPORT_CHANGED),
    (_cancelled('ConditionalCheckFailed', 'None'), boards_rekey.SUPPORT_CHANGED),
    (_cancelled(), boards_rekey.SUPPORT_CHANGED),
])
def test_the_cancellation_reasons_tell_a_gone_row_from_a_changed_one(error, outcome):
    assert boards_rekey._cancelled(error) == outcome


def test_any_other_cancellation_reason_raises():
    with pytest.raises(ClientError):
        boards_rekey._cancelled(_cancelled('None', 'ValidationError'))


def test_the_recount_keeps_the_erased_supporter(aws):
    table = aws['feature_requests']
    old_id = _seed(aws)
    current = boards_rekey.current_support(table, REQUEST, old_id)
    assert current is not None
    boards_rekey.rekey(table, current, 'sup_00000000000f')
    boards_rekey.recount(table, REQUEST)
    meta = table.get_item(Key={'pk': f'FR#{REQUEST}', 'sk': 'META'})['Item']
    assert (meta['totals']['supporters'], meta['totals']['customers'], meta['totals']['committed_usd']) == (2, 2, 500)
    assert meta['version'] == 1


def test_a_recount_that_cannot_write_is_skipped_not_raised(aws):
    table = aws['feature_requests']
    _seed(aws, version=None)
    with patch.object(boards_rekey.logger, 'warning') as warning:
        boards_rekey.recount(table, REQUEST)  # no version attribute: the conditional write never matches
    warning.assert_called_once()


def test_a_recount_of_a_deleted_request_does_nothing(aws):
    table = aws['feature_requests']
    boards_rekey.recount(table, 'fr_00000000dead')
    assert table.scan()['Items'] == []


def test_compute_totals_counts_a_deidentified_support_once():
    supports = [{'email': 'a@example.com'}, {'email': 'A@example.com'}, {'deidentified_at': 'x'}, {}]
    assert compute_totals(supports, 'blank')['supporters'] == 2
