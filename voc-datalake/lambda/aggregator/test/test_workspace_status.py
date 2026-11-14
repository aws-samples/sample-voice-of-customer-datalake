"""The aggregator skips the stream records of a workspace that is not active (slice 4d-1 of the workspace hard
delete, docs/multi-workspace.md "Export and delete"): counted, no counter and no data version moved, in the one-record
path and in a coalesced run; a deployment-wide record reads nothing new. With the real status check
(shared/ws_repo.py ``WorkspaceStatusCheck``), which conftest.py otherwise stands in for."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from aggregator import handler
from aggregator.test.test_removal_run import _item, _raw, _rows
from aggregator.test.test_workspace_records import _apply, _in_workspace
from shared.test.moto_tables import create_pk_sk_table
from shared.ws_repo import ACTIVE_STATUS_TTL_SECONDS, WorkspaceStatusCache, WorkspaceStatusCheck

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
ITEMS = [_item(n) for n in range(1, 5)]


@pytest.fixture
def tables(monkeypatch):
    """voc-aggregates, and voc-workspaces with ``WS`` deleting and ``OTHER`` active, through the real check."""
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        aggregates = create_pk_sk_table('agg-status', resource)
        workspaces = create_pk_sk_table('workspaces-status', resource)
        workspaces.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'status': 'deleting'})
        workspaces.put_item(Item={'pk': f'WS#{OTHER}', 'sk': 'META', 'status': 'active'})
        monkeypatch.setattr(handler, 'workspace_active', WorkspaceStatusCheck(workspaces))
        yield aggregates, workspaces


class TestARecordOfAWorkspaceThatIsNotActive:
    def test_moves_no_counter_in_a_coalesced_run(self, tables):
        aggregates, _workspaces = tables
        records = [_raw('INSERT', n, new=_in_workspace(item, WS)) for n, item in enumerate(ITEMS)]

        response, names = _apply(aggregates, records)

        assert response == {'batchItemFailures': []}
        assert _rows(aggregates) == []
        assert names.count(handler.INACTIVE_WORKSPACE_METRIC) == len(ITEMS)

    def test_moves_no_counter_on_the_one_record_path(self, tables):
        aggregates, _workspaces = tables

        response, names = _apply(aggregates, [_raw('INSERT', 1, new=_in_workspace(ITEMS[0], WS))], coalesce=False)

        assert response == {'results': [{'status': 'skipped', 'reason': 'workspace not active'}]}
        assert _rows(aggregates) == []
        assert names == [handler.INACTIVE_WORKSPACE_METRIC]

    def test_the_hard_deletes_own_removals_reverse_nothing(self, tables):
        """The delete's REMOVE records arrive here too: its counters go with it, so nothing is decremented."""
        aggregates, _workspaces = tables
        aggregates.put_item(Item={'pk': f'WS#{WS}#METRIC#daily_total', 'sk': ITEMS[0]['date'], 'count': 1})
        before = _rows(aggregates)

        _apply(aggregates, [_raw('REMOVE', n, old=_in_workspace(item, WS)) for n, item in enumerate(ITEMS)])

        assert _rows(aggregates) == before

    def test_a_workspace_with_no_meta_is_skipped_too(self, tables):
        aggregates, workspaces = tables
        workspaces.delete_item(Key={'pk': f'WS#{OTHER}', 'sk': 'META'})

        response, names = _apply(aggregates, [_raw('INSERT', 1, new=_in_workspace(ITEMS[0], OTHER))], coalesce=False)

        assert response['results'][0]['status'] == 'skipped'
        assert _rows(aggregates) == []
        assert names == [handler.INACTIVE_WORKSPACE_METRIC]

    def test_the_status_is_read_once_for_a_batch(self, tables):
        aggregates, workspaces = tables
        with patch.object(workspaces, 'get_item', wraps=workspaces.get_item) as read:
            _apply(aggregates, [_raw('INSERT', n, new=_in_workspace(item, WS)) for n, item in enumerate(ITEMS)])

        assert read.call_count == 1


class TestAnActiveWorkspaceBesideIt:
    def test_is_counted_while_the_deleting_ones_records_are_skipped(self, tables):
        aggregates, _workspaces = tables
        records = [_raw('INSERT', 1, new=_in_workspace(ITEMS[0], WS)), _raw('INSERT', 2, new=_in_workspace(ITEMS[1], OTHER)),
                   _raw('INSERT', 3, new=_in_workspace(ITEMS[2], WS)), _raw('INSERT', 4, new=_in_workspace(ITEMS[3], OTHER))]

        response, names = _apply(aggregates, records)

        assert response == {'batchItemFailures': []}
        prefixes = {row['pk'].split('#METRIC#')[0] for row in _rows(aggregates)}
        assert prefixes == {f'WS#{OTHER}'}
        assert names.count(handler.INACTIVE_WORKSPACE_METRIC) == 2

    def test_a_status_that_cannot_be_read_fails_that_record_alone(self, tables):
        aggregates, workspaces = tables
        throttled = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'GetItem')
        real = workspaces.get_item

        def get_item(**request):
            if request['Key']['pk'] == f'WS#{OTHER}':
                raise throttled
            return real(**request)

        records = [_raw('INSERT', 1, new=_in_workspace(ITEMS[0], OTHER)), _raw('INSERT', 2, new=ITEMS[1])]
        with patch.object(workspaces, 'get_item', side_effect=get_item):
            response, _names = _apply(aggregates, records)

        assert response == {'batchItemFailures': [{'itemIdentifier': '1001'}]}
        assert {row['pk'] for row in _rows(aggregates) if row['pk'].startswith('WS#')} == set()
        assert any(not row['pk'].startswith('WS#') for row in _rows(aggregates))  # the deployment's still counted


class TestAStaleActiveAnswer:
    def test_is_used_for_at_most_the_ttl_then_a_coalesced_run_reads_again(self, tables, monkeypatch):
        """A workspace set to deleting after a container read it active is still counted until the active TTL (300 s)
        ends, never after: the next coalesced run past it reads the status again and skips it."""
        aggregates, workspaces = tables
        now = [1000.0]
        monkeypatch.setattr(handler, 'workspace_active',
                            WorkspaceStatusCheck(workspaces, WorkspaceStatusCache(lambda: now[0])))

        def run(seq: int) -> list[dict]:
            return [_raw('INSERT', seq + n, new=_in_workspace(item, OTHER)) for n, item in enumerate(ITEMS)]

        _apply(aggregates, run(10))
        counted = _rows(aggregates)
        workspaces.put_item(Item={'pk': f'WS#{OTHER}', 'sk': 'META', 'status': 'deleting'})

        now[0] += ACTIVE_STATUS_TTL_SECONDS - 1
        _, stale = _apply(aggregates, run(20))
        assert handler.INACTIVE_WORKSPACE_METRIC not in stale  # within the TTL: the cached answer
        assert _rows(aggregates) != counted

        moved = _rows(aggregates)
        now[0] += 1
        _, fresh = _apply(aggregates, run(30))
        assert fresh.count(handler.INACTIVE_WORKSPACE_METRIC) == len(ITEMS)  # past it: read again, skipped
        assert _rows(aggregates) == moved


class TestADeploymentWideRecord:
    def test_reads_no_status_and_is_counted_as_before(self, tables, monkeypatch):
        aggregates, _workspaces = tables
        spy = MagicMock()
        monkeypatch.setattr(handler, 'workspace_active', WorkspaceStatusCheck(spy))

        response, _names = _apply(aggregates, [_raw('INSERT', n, new=item) for n, item in enumerate(ITEMS)])

        assert response == {'batchItemFailures': []}
        assert _rows(aggregates)
        assert spy.method_calls == []
