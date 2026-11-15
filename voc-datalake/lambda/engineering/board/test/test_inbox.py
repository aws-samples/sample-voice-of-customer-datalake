"""An agent's inbox: the notices the delivery function records (INBOX# rows, its shape pinned here as on its side),
read after a seq across the agent's own, its role's and (the coordinator's) the conductor's, merged by seq, with the
tail window."""
from __future__ import annotations

import json
from typing import Any

from engineering.board.inbox import Inbox, addressees, inbox_prefix
from engineering.board.test.table import RUN, TABLE, engineering_table
from engineering.rows import run_pk


def notice(client: Any, addressee: str, seq: int, *, task_id: str = '', type_: str = 'msg.answer',
           event_id: str = '', conversation_seq: int | None = None) -> None:
    """A notice as the delivery function writes it: ``seq`` its ``inbox_seq`` (the run's write order), and the
    message's conversation seq (the same number unless given)."""
    item: dict[str, Any] = {
        'pk': {'S': run_pk('default', RUN)},
        'sk': {'S': inbox_prefix(addressee, seq) + (event_id or f'01JD{seq:022d}')},
        'event_id': {'S': event_id or f'01JD{seq:022d}'}, 'type': {'S': type_}, 'from_kind': {'S': 'human'},
        'from_id': {'S': 'admin-sub'}, 'summary': {'S': f'notice {seq}'}, 'at': {'N': str(1_700_000_000 + seq)},
        'refs': {'S': json.dumps({'s3': []})}, 'inbox_seq': {'N': str(seq)},
        'seq': {'N': str(seq if conversation_seq is None else conversation_seq)}}
    if task_id:
        item['task_id'] = {'S': task_id}
    client.put_item(TableName=TABLE, Item=item)


def test_the_row_shape_is_the_delivery_functions() -> None:
    assert inbox_prefix('agent:fixer-1', 42) + '01JD0000000000000000000042' == (
        'INBOX#agent:fixer-1#000000000042#01JD0000000000000000000042')
    assert addressees('fixer', 'fixer-1') == ('agent:fixer-1', 'role:fixer')
    assert addressees('coordinator', 'coordinator-0') == ('agent:coordinator-0', 'role:coordinator', 'conductor')


def test_a_notice_reads_as_the_message_it_announces() -> None:
    with engineering_table() as client:
        notice(client, 'role:fixer', 5, task_id='task-1', type_='task.posted')
        page = Inbox(client, TABLE).read('default', RUN, role='fixer', agent='fixer-1', after=0, limit=50)
        assert page['messages'] == [{'seq': 5, 'conversation_seq': 5, 'event_id': '01JD0000000000000000000005',
                                     'type': 'task.posted',
                                     'from': {'kind': 'human', 'id': 'admin-sub'}, 'summary': 'notice 5',
                                     'at': 1_700_000_005, 'refs': {'s3': []}, 'task_id': 'task-1'}]


def test_the_inboxes_merge_by_seq_and_another_agents_are_never_read() -> None:
    with engineering_table() as client:
        for addressee, seq in (('agent:fixer-1', 4), ('role:fixer', 2), ('agent:fixer-1', 1), ('agent:fixer-2', 3),
                               ('role:hunter', 5), ('conductor', 6)):
            notice(client, addressee, seq)
        page = Inbox(client, TABLE).read('default', RUN, role='fixer', agent='fixer-1', after=0, limit=50)
        assert [message['seq'] for message in page['messages']] == [1, 2, 4]


def test_a_page_moves_on_to_its_last_seq_and_every_page_reads_the_window_below_it_again() -> None:
    with engineering_table() as client:
        for seq in range(1, 31):
            notice(client, 'agent:fixer-1' if seq % 2 else 'role:fixer', seq)
        inbox = Inbox(client, TABLE)
        first = inbox.read('default', RUN, role='fixer', agent='fixer-1', after=0, limit=10)
        assert ([m['seq'] for m in first['messages']], first['next']) == (list(range(1, 11)), 10)
        second = inbox.read('default', RUN, role='fixer', agent='fixer-1', after=first['next'], limit=10)
        assert ([m['seq'] for m in second['messages']], second['next']) == (list(range(1, 21)), 20)
        tail = inbox.read('default', RUN, role='fixer', agent='fixer-1', after=25, limit=50)
        assert ([m['seq'] for m in tail['messages']], tail['next']) == (list(range(6, 31)), 30)   # from 25 - 20
        empty = inbox.read('default', RUN, role='fixer', agent='fixer-1', after=30, limit=50)
        assert ([m['seq'] for m in empty['messages']], empty['next']) == (list(range(11, 31)), 30)


def test_a_full_page_that_ends_at_the_tail_still_reads_a_notice_committed_late_below_it() -> None:
    """Notice 5 is numbered before 6 but commits after it: the page above 3 is full (4 and 6) and ends at the tail,
    so the next read, from 20 below its cursor, reads 5."""
    with engineering_table() as client:
        for seq in (1, 2, 3, 4, 6):
            notice(client, 'agent:fixer-1', seq)
        inbox = Inbox(client, TABLE)
        page = inbox.read('default', RUN, role='fixer', agent='fixer-1', after=3, limit=2)
        assert ([m['seq'] for m in page['messages'] if m['seq'] > 3], page['next']) == ([4, 6], 6)
        notice(client, 'agent:fixer-1', 5)
        again = inbox.read('default', RUN, role='fixer', agent='fixer-1', after=page['next'], limit=2)
        assert ([m['seq'] for m in again['messages']], again['next']) == ([1, 2, 3, 4, 5, 6], 6)


def test_a_notice_delivered_late_still_numbers_after_everything_read() -> None:
    """A late delivery (an async retry) of conversation seq 10 takes the next write-order number, so the cursor
    that passed 11..40 still reaches it."""
    with engineering_table() as client:
        for seq in range(1, 31):
            notice(client, 'agent:fixer-1', seq, conversation_seq=seq + 10)
        inbox = Inbox(client, TABLE)
        tail = inbox.read('default', RUN, role='fixer', agent='fixer-1', after=0, limit=50)
        notice(client, 'agent:fixer-1', 31, conversation_seq=10)
        later = inbox.read('default', RUN, role='fixer', agent='fixer-1', after=tail['next'], limit=50)
        late = [message for message in later['messages'] if message['conversation_seq'] == 10]
        assert (tail['next'], [message['seq'] for message in late]) == (30, [31])


def test_a_malformed_row_is_skipped_yet_counts_for_the_cursor() -> None:
    with engineering_table() as client:
        notice(client, 'agent:fixer-1', 3)
        pk = {'S': run_pk('default', RUN)}
        # No event id, no time, refs that are not JSON (a writer's bug), and a key that is not the shape.
        client.put_item(TableName=TABLE, Item={'pk': pk, 'sk': {'S': inbox_prefix('agent:fixer-1', 4) + 'x'},
                                               'type': {'S': 'msg.answer'}, 'refs': {'S': '[not json'}})
        client.put_item(TableName=TABLE, Item={'pk': pk, 'sk': {'S': 'INBOX#agent:fixer-1#zz'}})
        notice(client, 'agent:fixer-1', 6)
        page = Inbox(client, TABLE).read('default', RUN, role='fixer', agent='fixer-1', after=0, limit=3)
        assert ([message['seq'] for message in page['messages']], page['next']) == ([3, 6], 6)
