"""shared/ws_repo.py, slice 4d-1 of the workspace hard delete (docs/multi-workspace.md, "Export and delete"): the
status check every writer of a workspace's data asks before it writes (``workspace_is_active``, its cache keeping an
active answer 300 s and a not-active one 30 s, and ``WorkspaceStatusCheck``), and the watermark directory row's key.
Nothing here deletes anything."""
import re
import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.test.moto_tables import create_pk_sk_table
from shared.ws_repo import (
    ACTIVE_STATUS_TTL_SECONDS,
    INACTIVE_STATUS_TTL_SECONDS,
    MAX_CACHED_STATUSES,
    STATUS_READ_ATTRIBUTES,
    OutOfScopeError,
    WorkspaceScope,
    WorkspaceStatusCache,
    WorkspaceStatusCheck,
    watermark_directory_key,
    watermark_key,
    workspace_is_active,
    ws_table,
)

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'
A = WorkspaceScope(WS)
B = WorkspaceScope(OTHER_WS)


class Clock:
    """A monotonic clock a test moves by hand."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _meta_table(status: str | None = 'active') -> MagicMock:
    """voc-workspaces as a double: one ``META`` row with ``status`` (None: no ``META`` at all)."""
    table = MagicMock()
    table.get_item.return_value = {} if status is None else {'Item': {'pk': f'WS#{WS}', 'sk': 'META', 'status': status}}
    return table


class TestTheStatusCheck:
    def test_reads_meta_strongly_consistent_and_only_its_status(self):
        table = _meta_table()

        assert workspace_is_active(table, A, WorkspaceStatusCache()) is True
        table.get_item.assert_called_once_with(
            Key={'pk': f'WS#{WS}', 'sk': 'META'}, ConsistentRead=True, ProjectionExpression='#a0, #a1, #a2',
            ExpressionAttributeNames={'#a0': 'pk', '#a1': 'sk', '#a2': 'status'})

    @pytest.mark.parametrize('status', ['deleting', 'ACTIVE', '', None])
    def test_any_other_status_or_no_meta_is_not_active(self, status):
        assert workspace_is_active(_meta_table(status), A, WorkspaceStatusCache()) is False

    def test_against_a_real_table_a_deleting_workspace_and_a_missing_one(self):
        with mock_aws():
            table = create_pk_sk_table('voc-workspaces')
            table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'status': 'deleting', 'name': 'Acme Outfitters'})
            cache = WorkspaceStatusCache()
            assert workspace_is_active(table, A, cache) is False
            assert workspace_is_active(table, B, cache) is False
            table.put_item(Item={'pk': f'WS#{OTHER_WS}', 'sk': 'META', 'status': 'active'})
            assert workspace_is_active(table, B, WorkspaceStatusCache()) is True

    def test_the_writers_grant_allows_exactly_the_projected_attributes(self):
        """lib/utils/workspace-resolution-grants.ts WORKSPACE_STATUS_ATTRIBUTES is the read's projection."""
        source = (Path(__file__).resolve().parents[3] / 'lib/utils/workspace-resolution-grants.ts').read_text('utf-8')
        match = re.search(r"WORKSPACE_STATUS_ATTRIBUTES = \[([^\]]*)\]", source)
        assert match is not None
        assert tuple(re.findall(r"'([a-z_]+)'", match.group(1))) == STATUS_READ_ATTRIBUTES


class TestTheStatusCache:
    def test_an_active_answer_is_read_once_per_ttl(self):
        table = _meta_table()
        cache = WorkspaceStatusCache(Clock())

        assert [workspace_is_active(table, A, cache) for _ in range(5)] == [True] * 5
        assert table.get_item.call_count == 1

    def test_a_not_active_answer_is_cached_too(self):
        """A deleted workspace's records are not each a read."""
        table = _meta_table('deleting')
        cache = WorkspaceStatusCache(Clock())

        assert [workspace_is_active(table, A, cache) for _ in range(5)] == [False] * 5
        assert table.get_item.call_count == 1

    def test_a_missing_meta_is_cached_as_not_active(self):
        table = _meta_table(None)
        cache = WorkspaceStatusCache(Clock())

        assert workspace_is_active(table, A, cache) is False
        assert workspace_is_active(table, A, cache) is False
        assert table.get_item.call_count == 1

    def test_a_failed_read_raises_and_is_not_cached(self):
        table = _meta_table()
        table.get_item.side_effect = [ClientError({'Error': {'Code': 'ThrottlingException'}}, 'GetItem'),
                                      {'Item': {'status': 'active'}}]
        cache = WorkspaceStatusCache(Clock())

        with pytest.raises(ClientError):
            workspace_is_active(table, A, cache)
        assert cache.get(WS) is None
        assert workspace_is_active(table, A, cache) is True
        assert table.get_item.call_count == 2

    def test_an_active_answer_is_kept_300_s(self):
        """It only lengthens the hard delete's fence (21 min), and keeps the hot paths' reads low."""
        clock, table = Clock(), _meta_table()
        cache = WorkspaceStatusCache(clock)
        assert workspace_is_active(table, A, cache) is True

        table.get_item.return_value = {'Item': {'status': 'deleting'}}
        clock.now += ACTIVE_STATUS_TTL_SECONDS - 0.001
        assert workspace_is_active(table, A, cache) is True  # still the cached answer
        clock.now += 0.001
        assert workspace_is_active(table, A, cache) is False  # 300 s on: read again
        assert table.get_item.call_count == 2

    def test_a_not_active_answer_is_kept_30_s(self):
        """A delete cancelled during the fence: its workspace's messages are dropped for at most 30 s more."""
        clock, table = Clock(), _meta_table('deleting')
        cache = WorkspaceStatusCache(clock)
        assert workspace_is_active(table, A, cache) is False

        table.get_item.return_value = {'Item': {'status': 'active'}}
        clock.now += INACTIVE_STATUS_TTL_SECONDS - 0.001
        assert workspace_is_active(table, A, cache) is False
        clock.now += 0.001
        assert workspace_is_active(table, A, cache) is True  # 30 s on: read again
        assert table.get_item.call_count == 2
        assert INACTIVE_STATUS_TTL_SECONDS < ACTIVE_STATUS_TTL_SECONDS

    def test_the_check_binds_a_table_and_its_own_cache(self):
        table = _meta_table()
        check = WorkspaceStatusCheck(table)

        assert (check(A), check(A)) == (True, True)
        assert table.get_item.call_count == 1

    def test_each_workspace_has_its_own_answer(self):
        table = MagicMock()
        table.get_item.side_effect = lambda **request: {
            'Item': {'status': 'active' if request['Key']['pk'] == f'WS#{WS}' else 'deleting'}}
        cache = WorkspaceStatusCache(Clock())

        assert (workspace_is_active(table, A, cache), workspace_is_active(table, B, cache)) == (True, False)

    def test_a_full_cache_drops_the_expired_answers_first(self):
        clock = Clock()
        cache = WorkspaceStatusCache(clock)
        for n in range(10):
            cache.put(f'old-{n}', False)
        clock.now += INACTIVE_STATUS_TTL_SECONDS
        for n in range(MAX_CACHED_STATUSES - 10):
            cache.put(f'ws-{n}', True)

        cache.put(WS, False)

        assert cache.get(WS) is False
        # Every live answer is kept, the oldest live one included; the expired ones made the room.
        assert all(cache.get(f'ws-{n}') is True for n in range(MAX_CACHED_STATUSES - 10))
        assert len(cache._entries) == MAX_CACHED_STATUSES - 9

    def test_a_full_cache_of_live_answers_drops_the_one_that_expires_soonest(self):
        """With two TTLs the order put is not the order of expiry: a not-active answer put last goes before the oldest
        active one."""
        clock = Clock()
        cache = WorkspaceStatusCache(clock)
        for n in range(MAX_CACHED_STATUSES - 1):
            cache.put(f'ws-{n}', True)
            clock.now += 0.001
        cache.put('late', False)  # put last, expires first (30 s against 300 s)
        cache.put('ws-0', True)  # put again: nothing dropped
        assert len(cache._entries) == MAX_CACHED_STATUSES

        cache.put(WS, True)

        assert cache.get('late') is None
        assert (cache.get('ws-0'), cache.get('ws-1'), cache.get(WS)) == (True, True, True)
        assert len(cache._entries) == MAX_CACHED_STATUSES

    def test_a_full_cache_of_one_ttl_drops_the_oldest(self):
        clock = Clock()
        cache = WorkspaceStatusCache(clock)
        for n in range(MAX_CACHED_STATUSES):
            cache.put(f'ws-{n}', True)
            clock.now += 0.001

        cache.put(WS, True)

        assert (cache.get('ws-0'), cache.get('ws-1'), cache.get(WS)) == (None, True, True)

    def test_concurrent_gets_and_puts_keep_it_bounded_and_consistent(self):
        """The processor's records run on worker threads: after each put, a get answers what that thread just put,
        or None (evicted), never another value, and the bound holds."""
        clock = Clock()
        cache = WorkspaceStatusCache(clock)
        errors: list[BaseException] = []

        def worker(offset: int) -> None:
            try:
                for n in range(2000):
                    ws = f'ws-{offset}-{n % 300}'  # each thread's own keys: only a race could change its value
                    value = (n // 300) % 2 == 0
                    cache.put(ws, value)
                    assert cache.get(ws) in (value, None)
                    clock.now += 0.0001
            except BaseException as error:  # noqa: BLE001 — reported by the main thread below
                errors.append(error)

        threads = [threading.Thread(target=worker, args=(offset,)) for offset in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert errors == []
        assert len(cache._entries) <= MAX_CACHED_STATUSES
        cache.put(WS, True)
        assert cache.get(WS) is True


class TestTheWatermarkDirectory:
    def test_lists_a_watermark_under_its_workspace(self):
        row = watermark_directory_key(A, 'webscraper', 'last_id')

        assert row == {'pk': f'WS#{WS}#WATERMARK_KEYS', 'sk': 'webscraper#last_id'}
        # The watermark's key is the scope's prefix and the row's sort key.
        assert A.prefix + row['sk'] == watermark_key(A, 'webscraper', 'last_id')

    @pytest.mark.parametrize(('plugin', 'key'), [('', 'last_id'), ('webscraper', '')])
    def test_refuses_an_empty_part(self, plugin, key):
        with pytest.raises(ValueError, match='watermark directory key'):
            watermark_directory_key(A, plugin, key)

    def test_its_row_goes_through_the_workspace_view(self):
        backing = MagicMock()
        ws_table(A, backing).put_item(watermark_directory_key(A, 'webscraper', 'last_id'))
        with pytest.raises(OutOfScopeError):
            ws_table(B, backing).put_item(watermark_directory_key(A, 'webscraper', 'last_id'))
        assert backing.put_item.call_count == 1
