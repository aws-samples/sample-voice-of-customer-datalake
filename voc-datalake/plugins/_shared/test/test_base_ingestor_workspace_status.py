"""An ingestor stops for a workspace that is not active (slice 4d-1 of the workspace hard delete,
docs/multi-workspace.md "Export and delete"), and lists each watermark it writes in a workspace.

* ``run_in_workspace`` refuses an event of a workspace whose ``META`` is not ``active`` (``deleting``, or no
  ``META``): logged, metered, nothing built or written, the shape of the invalid-workspace refusal;
* the scheduled tick's fan-out skips such a workspace (counted), and invokes the rest;
* a deployment-wide event reads no status;
* ``set_watermark`` in a workspace puts the watermark's directory row in voc-aggregates (its key alone, idempotent)
  before the watermark;
* a refused Run now or scraper run ends its run row; a status that cannot be read leaves it to Lambda's retry.

With the real check and the real listing, which plugins/conftest.py otherwise stands in for."""
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError

from _shared import base_ingestor
from _shared.test.ingestor_fixtures import ingestor_yielding
from _shared.test.workspace_fixtures import OTHER_WS, SCHEDULED_TICK, SCOPE, WS
from shared.exceptions import ConfigurationError
from shared.ws_repo import watermark_directory_key, ws_table

#: The real check and listing, taken before plugins/conftest.py's autouse stand-ins replace them for each test.
REAL_WORKSPACE_ACTIVE = base_ingestor.workspace_active
REAL_LIST_WATERMARK = base_ingestor.BaseIngestor._list_watermark
NOT_ACTIVE = {'status': 'refused', 'reason': 'workspace_not_active'}


def _meta(status: str | None) -> dict:
    return {} if status is None else {'Item': {'pk': f'WS#{WS}', 'sk': 'META', 'status': status}}


@pytest.fixture
def workspaces(monkeypatch):
    """voc-workspaces as a double behind the real check: ``statuses[ws]`` is each workspace's ``META`` status (a
    missing one: no ``META``)."""
    monkeypatch.setattr(base_ingestor, 'workspace_active', REAL_WORKSPACE_ACTIVE)
    monkeypatch.setattr(base_ingestor, '_status_check', None)  # bound afresh, to this test's table, on first use
    monkeypatch.setattr(base_ingestor, 'WORKSPACES_TABLE', 'test-workspaces')
    statuses: dict[str, str] = {WS: 'active', OTHER_WS: 'active'}
    with patch('_shared.base_ingestor.get_dynamodb_resource') as dynamo:
        table = dynamo.return_value.Table.return_value
        table.get_item.side_effect = lambda **request: _meta(statuses.get(request['Key']['pk'].removeprefix('WS#')))
        yield SimpleNamespace(table=table, statuses=statuses, dynamo=dynamo)


class TestARunInAWorkspaceThatIsNotActive:
    @pytest.mark.parametrize('status', ['deleting', None])
    def test_is_refused_and_nothing_runs(self, workspaces, status):
        if status is None:
            del workspaces.statuses[WS]
        else:
            workspaces.statuses[WS] = status
        run = MagicMock()
        with patch.object(base_ingestor, 'metrics') as metrics:
            result = base_ingestor.run_in_workspace({'workspace_id': WS, 'execution_id': 'exec-1'}, run)

        assert result == NOT_ACTIVE
        run.assert_not_called()
        metrics.add_metric.assert_called_once_with(name='IngestorWorkspaceNotActive', unit='Count', value=1)

    def test_an_active_workspace_runs_and_its_status_is_read_once_per_ttl(self, workspaces):
        run = MagicMock(return_value={'status': 'success'})

        for _ in range(3):
            assert base_ingestor.run_in_workspace({'workspace_id': WS}, run) == {'status': 'success'}

        assert run.call_count == 3
        assert workspaces.table.get_item.call_args_list == [call(
            Key={'pk': f'WS#{WS}', 'sk': 'META'}, ConsistentRead=True, ProjectionExpression='#a0, #a1, #a2',
            ExpressionAttributeNames={'#a0': 'pk', '#a1': 'sk', '#a2': 'status'})]
        workspaces.dynamo.return_value.Table.assert_called_with('test-workspaces')

    def test_a_status_that_cannot_be_read_raises_and_nothing_runs(self, workspaces):
        workspaces.table.get_item.side_effect = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'GetItem')
        run = MagicMock()

        with pytest.raises(ClientError):
            base_ingestor.run_in_workspace({'workspace_id': WS}, run)
        run.assert_not_called()

    @pytest.mark.usefixtures('workspaces')
    def test_without_the_workspaces_table_a_run_in_a_workspace_refuses_to_guess(self, monkeypatch):
        monkeypatch.setattr(base_ingestor, 'WORKSPACES_TABLE', '')
        run = MagicMock()

        with pytest.raises(ConfigurationError):
            base_ingestor.run_in_workspace({'workspace_id': WS}, run)
        run.assert_not_called()


class TestARefusedRunNowEndsItsRunRow:
    """The API wrote the run row (``running``) before it invoked; a refused run ends it, so its Run now never spins."""

    @pytest.fixture(autouse=True)
    def aggregates(self, monkeypatch):
        monkeypatch.setattr(base_ingestor, 'AGGREGATES_TABLE', 'test-aggregates')

    @staticmethod
    def _ended(table, partition: str, reason: str) -> object:
        return call(Key={'pk': f'WS#{WS}#{partition}', 'sk': 'exec-1'},
                    UpdateExpression='SET #status = :status, #errors = :errors, #completed_at = :completed_at',
                    ConditionExpression='attribute_exists(pk)',
                    ExpressionAttributeNames={'#status': 'status', '#errors': 'errors', '#completed_at': 'completed_at'},
                    ExpressionAttributeValues={':status': 'error', ':errors': [reason],
                                               ':completed_at': table.update_item.call_args.kwargs[
                                                   'ExpressionAttributeValues'][':completed_at']})

    def test_a_source_run_of_a_workspace_that_is_not_active(self, workspaces):
        workspaces.statuses[WS] = 'deleting'

        assert base_ingestor.run_in_workspace({'workspace_id': WS, 'execution_id': 'exec-1'}, MagicMock()) == NOT_ACTIVE

        assert workspaces.table.update_item.call_args_list == [
            self._ended(workspaces.table, 'SOURCE_RUN#test_source', 'workspace_not_active')]

    def test_a_scraper_run_ends_its_scraper_row(self, workspaces):
        workspaces.statuses[WS] = 'deleting'

        base_ingestor.run_in_workspace({'workspace_id': WS, 'execution_id': 'exec-1', 'scraper_id': 'sc-1'}, MagicMock())

        assert workspaces.table.update_item.call_args_list == [
            self._ended(workspaces.table, 'SCRAPER_RUN#sc-1', 'workspace_not_active')]

    def test_a_status_that_cannot_be_read_raises_and_leaves_the_row_to_the_retry(self, workspaces):
        """Not a refusal: Lambda's retry reads the status again and the run may still go ahead."""
        workspaces.table.get_item.side_effect = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'GetItem')

        with pytest.raises(ClientError):
            base_ingestor.run_in_workspace({'workspace_id': WS, 'execution_id': 'exec-1'}, MagicMock())

        workspaces.table.update_item.assert_not_called()

    def test_a_scheduled_run_has_no_row_to_end(self, workspaces):
        workspaces.statuses[WS] = 'deleting'

        assert base_ingestor.run_in_workspace({'workspace_id': WS}, MagicMock()) == NOT_ACTIVE
        workspaces.table.update_item.assert_not_called()

    def test_a_row_already_gone_is_not_made_again_and_the_refusal_stands(self, workspaces):
        """The condition (attribute_exists) is what keeps a deleted workspace's row from coming back."""
        workspaces.statuses[WS] = 'deleting'
        workspaces.table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException'}}, 'UpdateItem')

        assert base_ingestor.run_in_workspace({'workspace_id': WS, 'execution_id': 'exec-1'}, MagicMock()) == NOT_ACTIVE

    def test_any_other_failure_to_end_it_is_logged_and_the_refusal_stands(self, workspaces):
        workspaces.statuses[WS] = 'deleting'
        workspaces.table.update_item.side_effect = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'UpdateItem')

        with patch.object(base_ingestor, 'logger') as logger:
            assert base_ingestor.run_in_workspace({'workspace_id': WS, 'execution_id': 'exec-1'}, MagicMock()) == (
                NOT_ACTIVE)
        logger.warning.assert_any_call("Refused run's row not ended: ClientError", extra={'workspace_id': WS})

    def test_an_active_workspace_s_run_row_is_left_to_the_run(self, workspaces):
        base_ingestor.run_in_workspace({'workspace_id': WS, 'execution_id': 'exec-1'}, MagicMock())
        workspaces.table.update_item.assert_not_called()


class TestADeploymentWideRun:
    @pytest.mark.parametrize('event', [{}, {'execution_id': 'exec-7'}])
    def test_reads_no_status(self, workspaces, event):
        run = MagicMock(return_value={'status': 'success'})

        assert base_ingestor.run_in_workspace(event, run) == {'status': 'success'}
        run.assert_called_once_with(None)
        workspaces.table.get_item.assert_not_called()


class TestTheTickSkipsAWorkspaceThatIsNotActive:
    @pytest.fixture
    def tick(self, workspaces, monkeypatch):
        monkeypatch.setenv('AWS_LAMBDA_FUNCTION_NAME', 'voc-ingestor-test_source')
        with patch('_shared.base_ingestor.workspaces_with_plugin', return_value=[WS, OTHER_WS]), \
                patch('_shared.self_invoke.invoke_lambda_async', return_value={'StatusCode': 202}) as invoke, \
                patch.object(base_ingestor, 'metrics') as metrics:
            yield SimpleNamespace(invoke=invoke, metrics=metrics, workspaces=workspaces)

    def test_only_the_active_workspace_is_invoked(self, tick):
        tick.workspaces.statuses[WS] = 'deleting'

        result = base_ingestor.fan_out_tick('test_source')

        assert tick.invoke.call_args_list == [call('voc-ingestor-test_source', {'workspace_id': OTHER_WS})]
        assert result == {'status': 'fanned_out', 'workspaces': 1, 'failed': 0, 'skipped': 1}
        tick.metrics.add_metric.assert_called_once_with(name='IngestFanOutSkipped', unit='Count', value=1)

    def test_a_workspace_with_no_meta_is_skipped(self, tick):
        del tick.workspaces.statuses[OTHER_WS]

        result = base_ingestor.fan_out_tick('test_source')

        assert tick.invoke.call_args_list == [call('voc-ingestor-test_source', {'workspace_id': WS})]
        assert result['skipped'] == 1

    def test_a_status_that_cannot_be_read_counts_as_failed_and_is_not_invoked(self, tick):
        def get_item(**request):
            if request['Key']['pk'] == f'WS#{WS}':
                raise ClientError({'Error': {'Code': 'ThrottlingException'}}, 'GetItem')
            return _meta('active')

        tick.workspaces.table.get_item.side_effect = get_item

        result = base_ingestor.fan_out_tick('test_source')

        assert tick.invoke.call_args_list == [call('voc-ingestor-test_source', {'workspace_id': OTHER_WS})]
        assert result == {'status': 'fanned_out', 'workspaces': 1, 'failed': 1, 'skipped': 0}

    def test_the_skipped_workspace_s_own_run_is_refused_too(self, tick):
        """Should a run of it come anyway (an invoke from before the change, a Run now), it writes nothing."""
        tick.workspaces.statuses[WS] = 'deleting'
        base_ingestor.fan_out_tick('test_source')
        run = MagicMock()

        assert base_ingestor.run_in_workspace({'workspace_id': WS}, run) == NOT_ACTIVE
        run.assert_not_called()

    def test_the_tick_s_own_deployment_wide_run_still_runs(self, tick):
        tick.workspaces.statuses[WS] = 'deleting'
        run = MagicMock(return_value={'status': 'success'})
        with patch('_shared.base_ingestor._claim_the_tick', return_value=True):
            assert base_ingestor.run_in_workspace(dict(SCHEDULED_TICK), run) == {'status': 'success'}
        run.assert_called_once_with(None)


@pytest.fixture
def listing(ingestor_aws, monkeypatch):
    """The real directory listing, over the ``ingestor_aws`` table double (every table is that one double), with an
    aggregates table configured."""
    monkeypatch.setattr(base_ingestor.BaseIngestor, '_list_watermark', REAL_LIST_WATERMARK)
    monkeypatch.setattr(base_ingestor, 'AGGREGATES_TABLE', 'test-aggregates')
    return ingestor_aws.table


def _puts(table) -> list[dict]:
    """Every put's item; each put sends its item alone (no condition)."""
    assert all(set(c.kwargs) == {'Item'} for c in table.put_item.call_args_list)
    return [c.kwargs['Item'] for c in table.put_item.call_args_list]


class TestTheWatermarkDirectory:
    def test_is_put_before_each_watermark(self, listing):
        ingestor = ingestor_yielding()

        ingestor.set_watermark('last_id', 'review-1')
        ingestor.set_watermark('last_id', 'review-2')

        puts = _puts(listing)
        directory = {'pk': f'WS#{WS}#WATERMARK_KEYS', 'sk': 'test_source#last_id'}  # the key alone, no condition
        assert [put if 'pk' in put else put['value'] for put in puts] == [directory, 'review-1', directory, 'review-2']

    @pytest.mark.usefixtures('listing')
    def test_written_twice_it_is_one_row(self):
        """The row is its key alone, so a second put of it writes the same row again: still one row, nothing else.
        (A table keyed as DynamoDB keys it; moto cannot run under plugins/.)"""
        rows: dict[tuple[str, str], dict] = {}

        def put_item(*, Item):
            rows[(Item['pk'], Item['sk'])] = dict(Item)

        ingestor = ingestor_yielding()
        ingestor.aggregates_table = ws_table(SCOPE, MagicMock(put_item=put_item))
        ingestor.set_watermark('last_id', 'review-1')
        ingestor.set_watermark('last_id', 'review-2')

        assert list(rows.values()) == [watermark_directory_key(SCOPE, 'test_source', 'last_id')]

    def test_each_key_and_each_workspace_is_listed(self, listing):
        from _shared.test.workspace_fixtures import OTHER_SCOPE

        ingestor_yielding().set_watermark('last_id', 'a')
        ingestor_yielding().set_watermark('last_timestamp', 'b')
        ingestor_yielding(scope=OTHER_SCOPE).set_watermark('last_id', 'c')

        listed = [(put['pk'], put['sk']) for put in _puts(listing) if 'pk' in put]
        assert listed == [(f'WS#{WS}#WATERMARK_KEYS', 'test_source#last_id'),
                          (f'WS#{WS}#WATERMARK_KEYS', 'test_source#last_timestamp'),
                          (f'WS#{OTHER_WS}#WATERMARK_KEYS', 'test_source#last_id')]

    def test_when_the_row_cannot_be_written_the_watermark_is_not_either(self, listing):
        """No watermark of a workspace is ever unlisted: the next run starts from the one before."""
        listing.put_item.side_effect = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'PutItem')

        with patch.object(base_ingestor, 'metrics') as metrics:
            ingestor_yielding().set_watermark('last_id', 'review-1')

        assert len(_puts(listing)) == 1  # the directory row's attempt only
        metrics.add_metric.assert_called_once_with(name='WatermarkNotListed', unit='Count', value=1)

    def test_without_the_aggregates_table_a_workspace_run_raises(self, listing, monkeypatch):
        """A deploy fault, never swallowed: the run fails and says so."""
        monkeypatch.setattr(base_ingestor, 'AGGREGATES_TABLE', '')

        with pytest.raises(ConfigurationError, match='AGGREGATES_TABLE'):
            ingestor_yielding().set_watermark('last_id', 'review-1')

        assert _puts(listing) == []

    def test_a_deployment_wide_watermark_lists_nothing(self, listing):
        ingestor_yielding(scope=None).set_watermark('last_id', '42')

        assert [put['source'] for put in _puts(listing)] == ['test_source#last_id']
