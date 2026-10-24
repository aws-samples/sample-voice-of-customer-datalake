"""Memory scanner (session end + direct enqueue) and the daily retention sweep."""
from datetime import UTC, datetime, timedelta

import pytest

from memory.retention import handler as retention
from memory.scanner import handler as scanner
from shared import memory_store as store
from shared.test.memory_fixtures import candidate

NOW = datetime.now(UTC)


def _conv(world, session_id, *, minutes_ago, count=4, kind: str | None = 'assistant', owner='sub-a'):
    item = {'pk': f'USER#{owner}', 'sk': f'CONV#{session_id}', 'conversation_id': session_id,
            'message_count': count, 'updated_at': (NOW - timedelta(minutes=minutes_ago)).isoformat()}
    if kind:
        item['kind'] = kind
    world.conversations.put_item(Item=item)


def test_scanner_enqueues_only_ended_sessions_with_new_messages(world, worker_context):
    _conv(world, 'ended', minutes_ago=45)
    _conv(world, 'active', minutes_ago=5)
    _conv(world, 'legacy', minutes_ago=45, kind=None)
    _conv(world, 'ancient', minutes_ago=60 * 24 * 30)
    _conv(world, 'done', minutes_ago=45)
    store.save_cursor(world.memory, 'done', {'extracted_count': 4}, now=NOW)
    result = scanner.lambda_handler({'source': 'aws.events'}, worker_context)
    assert result == {'scanned': 2, 'enqueued': 1}
    assert world.queued() == [{'kind': 'session', 'session_id': 'ended', 'owner_sub': 'sub-a'}]
    # In flight: not enqueued again on the next tick.
    assert scanner.lambda_handler({}, worker_context)['enqueued'] == 0


@pytest.mark.parametrize(('cursor', 'count', 'expected'), [
    (None, 4, True),
    ({'extracted_count': 4}, 4, False),
    ({'extracted_count': 2, 'enqueued_at': NOW.isoformat()}, 4, False),
    ({'extracted_count': 2, 'enqueued_at': (NOW - timedelta(hours=3)).isoformat()}, 4, True),
    ({'extracted_count': 2, 'enqueued_at': (NOW - timedelta(minutes=5)).isoformat(),
      'extracted_at': NOW.isoformat()}, 4, True),
    ({'extracted_count': 9}, 4, True),
    (None, 0, False),
])
def test_needs_extraction(cursor, count, expected):
    assert scanner.needs_extraction({'message_count': count}, cursor, NOW) is expected


def test_retention_archives_decayed_and_expired_but_never_long_term(world, worker_context):
    old = NOW - timedelta(days=120)
    store.write_automated(world.memory, [
        candidate('Customers want faster refunds'),
        candidate('Vision is to be the most loved store', kind='strategy'),
    ], now=old)
    store.write_automated(world.memory, [candidate('Mobile checkout crashes on Android')], now=NOW)
    rows = {r['statement']: r for r in world.memories()}
    store.set_fields(world.memory, rows['Vision is to be the most loved store'], {'retention': 'long_term'}, now=old)
    store.set_fields(world.memory, rows['Mobile checkout crashes on Android'],
                     {'retention': 'dated', 'expires_at': (NOW - timedelta(days=1)).date().isoformat()}, now=NOW)
    result = retention.lambda_handler({}, worker_context)
    assert (result['decayed'], result['expired']) == (1, 1)
    after = {r['statement']: r for r in world.memories()}
    assert after['Customers want faster refunds']['status'] == 'archived'
    assert after['Customers want faster refunds']['archived_reason'] == 'decayed'
    assert after['Customers want faster refunds']['gsi1pk'] == 'MEMSTATUS#company#archived'
    assert after['Mobile checkout crashes on Android']['archived_reason'] == 'expired'
    assert after['Vision is to be the most loved store']['status'] == 'active'
    assert after['Customers want faster refunds']['tombstoned'] is False  # archive is restorable
