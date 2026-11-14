"""shared/workspace_deletes.py: the delete job row's claim, its fence and its race with a cancel, what a reader sees,
and shared/workspace_credentials.py's list and delete of a workspace's parameters (moto)."""
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import pytest
from moto import mock_aws

from shared import workspace_deletes as deletes
from shared.test.moto_tables import create_pk_sk_table
from shared.workspace_credentials import delete_parameters, list_parameter_names

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'


@pytest.fixture
def table() -> Iterator[Any]:
    with mock_aws():
        yield create_pk_sk_table('voc-workspaces')


def _now() -> datetime:
    return datetime.now(UTC)


def _job(table: Any, **fields: Any) -> dict:
    row = {'pk': 'WSDELETE', 'sk': WS, 'workspace_id': WS, 'status': 'waiting', 'phase': 'fence',
           'requested_at': _now().isoformat(), 'fence_at': (_now() + timedelta(minutes=21)).isoformat(), **fields}
    table.put_item(Item=row)
    return row


def _row(table: Any) -> dict:
    return table.get_item(Key={'pk': 'WSDELETE', 'sk': WS})['Item']


class TestTheGenerationClaim:
    def test_generation_0_claims_a_fresh_waiting_job_once(self, table):
        _job(table)
        assert (deletes.claim_generation(table, WS, 0, _now()) or {}).get('generation') == 0
        assert deletes.claim_generation(table, WS, 0, _now()) is None

    def test_a_start_delivered_past_the_hour_claims_nothing(self, table):
        _job(table, requested_at=(_now() - timedelta(hours=2)).isoformat())
        assert deletes.claim_generation(table, WS, 0, _now()) is None

    def test_generation_g_claims_only_after_g_minus_1_moved_within_the_hour(self, table):
        _job(table, generation=3, progress_at=_now().isoformat(), status='running')
        assert deletes.claim_generation(table, WS, 5, _now()) is None
        assert deletes.claim_generation(table, WS, 3, _now()) is None
        assert (deletes.claim_generation(table, WS, 4, _now()) or {}).get('generation') == 4
        table.put_item(Item={**_row(table), 'progress_at': (_now() - timedelta(hours=2)).isoformat()})
        assert deletes.claim_generation(table, WS, 5, _now()) is None

    @pytest.mark.parametrize('status', ['completed', 'failed', 'cancelled'])
    def test_a_finished_job_is_never_claimed(self, table, status):
        _job(table, status=status, generation=1, progress_at=_now().isoformat())
        assert deletes.claim_generation(table, WS, 2, _now()) is None

    def test_a_missing_row_is_never_claimed_nor_created(self, table):
        assert deletes.claim_generation(table, WS, 0, _now()) is None
        assert 'Item' not in table.get_item(Key={'pk': 'WSDELETE', 'sk': WS})


class TestTheFenceAndTheCancel:
    def test_the_fence_ends_once_and_only_from_waiting_at_its_generation(self, table):
        _job(table, generation=1)
        assert deletes.begin_sweeps(table, WS, 0, 'credentials', _now()) is False
        assert deletes.begin_sweeps(table, WS, 1, 'credentials', _now()) is True
        assert (_row(table)['status'], _row(table)['phase']) == ('running', 'credentials')
        assert deletes.begin_sweeps(table, WS, 1, 'credentials', _now()) is False

    def test_progress_and_the_outcome_are_written_only_at_the_claimed_generation(self, table):
        _job(table, generation=2, status='running')
        assert deletes.record_progress(table, WS, 1, {'phase': 'memory'}) is False
        assert deletes.record_progress(table, WS, 2, {'phase': 'memory'}) is True
        assert deletes.finish_job(table, WS, 1, 'completed', {}) is False
        assert deletes.finish_job(table, WS, 2, 'completed', {}) is True
        assert deletes.finish_job(table, WS, 2, 'failed', {'error': 'x'}) is False
        assert _row(table)['status'] == 'completed'


class TestWhatAReaderSees:
    def test_a_job_that_stopped_moving_reads_failed_never_its_requester_or_checkpoint(self, table):
        row = _job(table, status='running', progress_at=(_now() - timedelta(hours=2)).isoformat(),
                   requested_by_sub='sub-ada', checkpoint={'phase': 'objects'})
        view = deletes.job_view(row, _now())
        assert (view['status'], view['error']) == ('failed', deletes.STALLED)
        assert not {'requested_by_sub', 'checkpoint', 'pk', 'sk', 'legal_basis'} & set(view)

    def test_a_row_naming_another_workspace_than_its_key_is_refused(self):
        with pytest.raises(ValueError, match='another workspace'):
            deletes.stored_scope({'pk': 'WSDELETE', 'sk': WS, 'workspace_id': OTHER})
        assert deletes.stored_scope({'pk': 'WSDELETE', 'sk': WS, 'workspace_id': WS}).ws == WS

    def test_the_lock_holder_names_the_workspace(self):
        assert deletes.holder(WS) == f'delete-{WS}'


@pytest.fixture
def ssm() -> Iterator[Any]:
    with mock_aws():
        client = boto3.client('ssm', region_name='us-east-1')
        for ws in (WS, OTHER):
            for plugin in ('webscraper', 'app_reviews_ios'):
                client.put_parameter(Name=f'/voc/ws/{ws}/credentials/{plugin}', Value='{"k": "v"}', Type='SecureString')
        yield client


class TestTheCredentialsSweep:
    def test_lists_names_only_and_deletes_the_workspaces_parameters(self, ssm):
        names = list_parameter_names(ssm, '/voc/ws', WS)
        assert sorted(names) == [f'/voc/ws/{WS}/credentials/app_reviews_ios', f'/voc/ws/{WS}/credentials/webscraper']
        assert delete_parameters(ssm, '/voc/ws', WS, names) == 2
        assert list_parameter_names(ssm, '/voc/ws', WS) == []
        assert len(list_parameter_names(ssm, '/voc/ws', OTHER)) == 2

    @pytest.mark.parametrize('name', [f'/voc/ws/{OTHER}/credentials/webscraper', f'/voc/ws/{WS}/credentials',
                                      f'/voc/ws/{WS}/credentials/', f'/voc/ws/{WS}/credentials/a/b', '/voc/radar/key'])
    def test_a_name_outside_the_workspaces_credentials_refuses_the_whole_delete(self, ssm, name):
        with pytest.raises(ValueError, match='outside'):
            delete_parameters(ssm, '/voc/ws', WS, [f'/voc/ws/{WS}/credentials/webscraper', name])
        assert len(list_parameter_names(ssm, '/voc/ws', WS)) == 2

    def test_a_listed_name_outside_the_path_is_refused(self):
        class Lying:
            def get_parameters_by_path(self, **_kwargs):
                return {'Parameters': [{'Name': f'/voc/ws/{OTHER}/credentials/webscraper'}]}

        with pytest.raises(ValueError, match='outside'):
            list_parameter_names(Lying(), '/voc/ws', WS)

    @pytest.mark.parametrize('count', [0, 11])
    def test_a_delete_takes_one_to_ten_names(self, ssm, count):
        with pytest.raises(ValueError, match='1 to 10'):
            delete_parameters(ssm, '/voc/ws', WS, [f'/voc/ws/{WS}/credentials/p{n}' for n in range(count)])
