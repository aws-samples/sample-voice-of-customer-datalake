"""Tombstones are written one PutItem each, never in a batch (jobs/retention/copies.py).

voc-retention holds no ``dynamodb:BatchWriteItem`` on voc-aggregates: IAM cannot tell a batch put from a batch
delete, so the grant would let it remove audit rows (lib/utils/audit-row-guard.ts denies every role that).
"""
from unittest.mock import MagicMock

from jobs.retention.copies import write_tombstones

RUN = {'mode': 'erase', 'run_id': 'run_1', 'job_id': 'er_1', 'legal_basis': 'GDPR art. 17 request #1'}


def _item(feedback_id: str) -> dict:
    return {'pk': 'SOURCE#webscraper', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
            'source_platform': 'webscraper'}


def test_each_tombstone_is_one_put_item_and_no_batch_is_opened():
    table = MagicMock()
    write_tombstones(table, RUN, [_item('a'), _item('b')], 'feedback')
    assert table.put_item.call_count == 2
    table.batch_writer.assert_not_called()


def test_a_tombstone_holds_ids_and_the_legal_basis_never_content():
    table = MagicMock()
    write_tombstones(table, RUN, [{**_item('a'), 'original_text': 'secret words', 'author': 'Ann'}], 'feedback')
    row = table.put_item.call_args.kwargs['Item']
    assert row['pk'].startswith('AUDIT#tombstone#')
    assert (row['feedback_id'], row['legal_basis'], row['job_id']) == ('a', 'GDPR art. 17 request #1', 'er_1')
    assert 'secret words' not in str(row)
    assert 'Ann' not in str(row)
    assert 'ttl' not in row


def test_no_items_writes_nothing():
    table = MagicMock()
    write_tombstones(table, RUN, [], 'feedback')
    table.put_item.assert_not_called()
