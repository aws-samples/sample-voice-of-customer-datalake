"""The processor stops for a workspace that is not active (slice 4d-1 of the workspace hard delete,
docs/multi-workspace.md "Export and delete"): its message is acked as dropped, counted and logged without its
content, nothing written and nothing sent to the DLQ; a deployment-wide message reads nothing new. Driven through the
real ``record_handler`` (and ``lambda_handler`` for the batch's answer) with the real status check
(shared/ws_repo.py ``WorkspaceStatusCheck``), which conftest.py otherwise stands in for."""
import json
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from processor import handler
from processor.test import test_source_updates as issues
from processor.test.sqs_fixtures import sqs_record
from shared.test.moto_tables import create_pk_sk_table
from shared.ws_repo import WorkspaceStatusCheck

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
TEXT = 'The parcel came late again and the box was crushed'


def review(**fields) -> dict:
    return {'id': 'rev-1', 'source_platform': 'webscraper', 'source_channel': 'reviews', 'text': TEXT,
            'created_at': '2026-01-01T00:00:00Z', **fields}


@contextmanager
def world(status: str | None, monkeypatch):
    """``issues.world`` plus voc-aggregates (log rows) and voc-workspaces holding the workspace's ``META`` with
    ``status`` (None: no ``META``), behind the real status check with a fresh cache."""
    with issues.world() as (feedback, llm):
        aggregates = create_pk_sk_table('test-aggregates')
        workspaces = create_pk_sk_table('test-workspaces')
        if status is not None:
            workspaces.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'status': status, 'name': 'Acme Outfitters'})
        monkeypatch.setattr(handler, 'workspace_active', WorkspaceStatusCheck(workspaces))
        with patch.object(handler, 'aggregates_table', aggregates), patch.object(handler, 'metrics') as metrics:
            yield SimpleNamespace(feedback=feedback, llm=llm, aggregates=aggregates, metrics=metrics,
                                  workspaces=workspaces)


def _metric_names(metrics) -> list[str]:
    return [call.kwargs['name'] for call in metrics.add_metric.call_args_list]


class TestAMessageOfAWorkspaceThatIsNotActive:
    @pytest.mark.parametrize('status', ['deleting', None])
    def test_is_acked_as_dropped_and_nothing_is_written(self, status, monkeypatch):
        with world(status, monkeypatch) as w:
            result = issues.deliver(review(workspace_id=WS))
            stored, logged = w.feedback.scan()['Items'], w.aggregates.scan()['Items']

        assert result == {'status': 'dropped', 'reason': 'workspace_not_active'}
        assert stored == []
        assert logged == []  # not even a log row under the workspace
        w.llm.assert_not_called()
        assert _metric_names(w.metrics).count('WorkspaceMessagesDropped') == 1

    def test_even_an_invalid_one_writes_no_validation_row(self, monkeypatch):
        with world('deleting', monkeypatch) as w:
            result = issues.deliver(review(workspace_id=WS, text=''))
            logged = w.aggregates.scan()['Items']

        assert result['status'] == 'dropped'
        assert logged == []

    def test_its_log_line_holds_no_content(self, monkeypatch):
        with world('deleting', monkeypatch), patch.object(handler, 'logger') as logger:
            issues.deliver(review(workspace_id=WS, author='Sam Rivera'))

        logged = json.dumps([(call.args, call.kwargs) for call in logger.method_calls], default=str)
        assert 'Dropped a message of a workspace that is not active' in logged
        assert TEXT not in logged
        assert 'Sam Rivera' not in logged

    def test_is_never_a_batch_item_failure_so_it_never_reaches_the_dlq(self, monkeypatch, lambda_context):
        """A redrive of the DLQ would bring the message back after the hard delete: it is acked instead."""
        with world('deleting', monkeypatch) as w:
            response = handler.lambda_handler(
                {'Records': [sqs_record('msg-1', review(workspace_id=WS)),
                             sqs_record('msg-2', review(id='rev-2', workspace_id=WS))]}, lambda_context)
            stored = w.feedback.scan()['Items']

        assert response == {'batchItemFailures': []}
        assert stored == []

    def test_the_status_is_read_once_for_a_burst(self, monkeypatch):
        with world('deleting', monkeypatch) as w, \
                patch.object(w.workspaces, 'get_item', wraps=w.workspaces.get_item) as read:
            for n in range(5):
                issues.deliver(review(id=f'rev-{n}', workspace_id=WS))

        assert read.call_count == 1


class TestAMessageOfAnActiveWorkspace:
    def test_is_stored_as_before(self, monkeypatch):
        with world('active', monkeypatch) as w:
            result = issues.deliver(review(workspace_id=WS))
            (item,) = w.feedback.scan()['Items']

        assert result['status'] == 'success'
        assert item['pk'] == f'WS#{WS}#SOURCE#webscraper'
        w.llm.assert_called_once()
        assert 'WorkspaceMessagesDropped' not in _metric_names(w.metrics)

    def test_a_status_that_cannot_be_read_fails_the_record_and_stores_nothing(self, monkeypatch):
        """Retried by SQS (a failed read is never cached), never dropped on a guess."""
        with world('active', monkeypatch) as w:
            throttled = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'GetItem')
            with patch.object(w.workspaces, 'get_item', side_effect=throttled), pytest.raises(ClientError):
                issues.deliver(review(workspace_id=WS))
            stored = w.feedback.scan()['Items']
            # The next delivery reads again and goes through.
            assert issues.deliver(review(workspace_id=WS))['status'] == 'success'

        assert stored == []
        w.llm.assert_called_once()


class TestADeploymentWideMessage:
    def test_reads_no_status_and_is_stored_as_before(self, monkeypatch):
        with world(None, monkeypatch) as w:
            spy = MagicMock()
            monkeypatch.setattr(handler, 'workspace_active', WorkspaceStatusCheck(spy))
            result = issues.deliver(review())
            (item,) = w.feedback.scan()['Items']

        assert result['status'] == 'success'
        assert item['pk'] == 'SOURCE#webscraper'
        assert spy.method_calls == []
