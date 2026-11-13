"""voc-retention erases in ONE named workspace (TENETS.md D5; docs/source-policies.md, "Workspace items").

A job row that names a workspace (``workspace_id``, written only by the settings API from the request's resolved
membership, shared/erasure_scope.py) reaches that workspace's items only: by author, source id or CSV row (inside one
workspace those are its own values) and by email, each item tombstoned first (``{ws}#{feedback_id}``), with its Silver
versions and every raw version under ``ws/{ws}/``. The deployment's items, another workspace's, Radar, the boards and
the memberships are never touched. The row lives in the workspace's own job partition (``WS#{ws}#JOB#erasure``,
shared/erasure_jobs.py), the event names the workspace so the worker finds it, and the row must name the same one. A
job that names no workspace runs exactly as before.
"""
from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

import pytest
from boto3.dynamodb.conditions import ConditionExpressionBuilder, Key
from botocore.exceptions import ClientError

from jobs.retention import boards, handler, members, runs
from jobs.retention.test.conftest import erasure_job, put_feedback
from jobs.retention.test.test_workspace_erasure import (
    BASIS,
    JOB_ID,
    WS,
    WS_TWO,
    _items,
    _run_seeing_tombstones,
    _tombstones,
    _versions,
    put_workspace_feedback,
)
from shared import retention
from shared.digests import sha256_hex
from shared.erasure_jobs import acquire_workspace_lock
from shared.ws_repo import WorkspaceScope

JANE = 'Jane Doe'
JANE_EMAIL = 'jane@example.com'
SAME = object()
# (field, value, the review's matching fields) of an erasure by author, source id or CSV row.
ID_AND_AUTHOR_ERASURES = [
    ('author', JANE, {'author': JANE}),
    ('source_id', '12345', {}),
    ('csv_row_id', 'row-7', {'csv_row_id': 'row-7'}),
]


def _partition(ws: str) -> str:
    return f'WS#{ws}#JOB#erasure'


def _job(aws, field: str, value: str, source: str | None = None, ws: str | None = WS, row_ws: Any = SAME,
         **row: Any) -> dict:
    """The job row in ``ws``'s own partition naming ``row_ws`` (``ws`` by default), and its invoke event (naming
    ``ws``), as the settings API writes them; ``ws`` None: the deployment's job, as before."""
    if ws is None:
        return erasure_job(aws, JOB_ID, field, value, legal_basis=BASIS, source=source, **row)
    named = ws if row_ws is SAME else row_ws
    item = {'pk': _partition(ws), 'sk': JOB_ID, 'job_id': JOB_ID, 'status': 'queued', 'field': field,
            'value_hash': sha256_hex(value), 'legal_basis': BASIS, **({'source': source} if source else {}),
            **row, **({} if named is None else {'workspace_id': named})}
    aws['aggregates'].put_item(Item=item)
    return {'mode': 'erase', 'job_id': JOB_ID, 'value': value, 'workspace_id': ws}


def _job_row(aws, ws: str = WS) -> dict:
    return aws['aggregates'].get_item(Key={'pk': _partition(ws), 'sk': JOB_ID})['Item']


def _audit(aws) -> dict:
    [audit] = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq('AUDIT#retention'))['Items']
    return audit


def _lock(aws, ws: str = WS) -> dict | None:
    return aws['aggregates'].get_item(Key={'pk': _partition(ws), 'sk': 'LOCK'}).get('Item')


def _same_review_in_three_scopes(aws, feedback_id: str = '12345', source: str = 'tickets', **extra: Any) -> None:
    """One review of ``source`` with the same id and fields in the deployment, ``WS`` and ``WS_TWO``."""
    put_feedback(aws, feedback_id, source, **extra)
    put_workspace_feedback(aws, WS, feedback_id, source, **extra)
    put_workspace_feedback(aws, WS_TWO, feedback_id, source, **extra)


class TestAnErasureInOneWorkspace:
    @pytest.mark.parametrize(('field', 'value', 'extra'), ID_AND_AUTHOR_ERASURES)
    def test_it_deletes_that_workspaces_match_and_its_copies_only(self, aws, worker_context, field, value, extra):
        _same_review_in_three_scopes(aws, **extra)
        other = _versions(aws, f'ws/{WS_TWO}/')

        result = handler.handle_event(_job(aws, field, value, source='tickets'), worker_context)

        assert result['status'] == 'completed'
        assert _items(aws) == {('SOURCE#tickets', 'FEEDBACK#12345'), (f'WS#{WS_TWO}#SOURCE#tickets', 'FEEDBACK#12345')}
        assert _versions(aws, f'ws/{WS}/') == []
        assert _versions(aws, f'ws/{WS_TWO}/') == other
        # Two raw files and one Silver file held data (every object version of each went).
        assert (result['deleted_items'], result['deleted_workspace_items'], result['deleted_objects']) == (1, 1, 3)
        tombstones = _tombstones(aws, 'tickets')
        assert set(tombstones) == {f'{WS}#12345'}
        assert (tombstones[f'{WS}#12345']['workspace_id'], tombstones[f'{WS}#12345']['legal_basis']) == (WS, BASIS)
        assert (_job_row(aws)['workspace_id'], _job_row(aws)['deleted_workspace_items']) == (WS, 1)
        assert (_audit(aws)['workspace_id'], _audit(aws)['deleted_workspace_items']) == (WS, 1)

    def test_an_author_erasure_reaches_every_source_of_the_workspace_and_no_other_author(self, aws, worker_context):
        put_workspace_feedback(aws, WS, 'f1', 'web', author=JANE)
        put_workspace_feedback(aws, WS, 'f2', 'tickets', author=JANE)
        put_workspace_feedback(aws, WS, 'f3', 'web', author='John Roe')

        result = handler.handle_event(_job(aws, 'author', JANE), worker_context)

        assert result['deleted_workspace_items'] == 2
        assert _items(aws) == {(f'WS#{WS}#SOURCE#web', 'FEEDBACK#f3')}

    def test_each_tombstone_is_written_before_its_item_is_deleted(self, aws, worker_context):
        put_workspace_feedback(aws, WS, 'f1', author=JANE)
        put_workspace_feedback(aws, WS, 'f2', author=JANE)

        _result, seen_at_delete = _run_seeing_tombstones(aws, _job(aws, 'author', JANE), worker_context)

        assert seen_at_delete == [{f'{WS}#f1', f'{WS}#f2'}] * 2

    def test_an_email_erasure_in_a_workspace_stays_in_it(self, aws, worker_context):
        """The workspace's admin answers for its data only: the deployment's copy, another workspace's, the boards and
        the memberships are left to the deployment's erasure by email (which reaches every workspace)."""
        put_feedback(aws, 'f1', metadata={'email': JANE_EMAIL})
        put_workspace_feedback(aws, WS, 'f1', metadata={'email': JANE_EMAIL})
        put_workspace_feedback(aws, WS_TWO, 'f1', metadata={'email': JANE_EMAIL})
        member = {'pk': f'WS#{WS_TWO}', 'sk': 'MEMBER#sub-jane', 'role': 'viewer', 'email': JANE_EMAIL, 'name': JANE}
        aws['workspaces'].put_item(Item=member)

        with patch.object(boards, 'scan_page') as board_scan, patch.object(members, 'scan_page') as member_scan:
            result = handler.handle_event(_job(aws, 'email', 'Jane@Example.com'), worker_context)

        assert (result['deleted_items'], result['deleted_workspace_items']) == (1, 1)
        assert _items(aws) == {('SOURCE#web', 'FEEDBACK#f1'), (f'WS#{WS_TWO}#SOURCE#web', 'FEEDBACK#f1')}
        board_scan.assert_not_called()
        member_scan.assert_not_called()
        assert aws['workspaces'].get_item(Key={'pk': member['pk'], 'sk': member['sk']})['Item'] == member
        assert 'member_rows_deidentified' not in result

    @pytest.mark.usefixtures('aws')
    def test_a_named_workspace_walks_the_item_scan_only(self, worker_context):
        run = {'mode': 'erase', 'field': 'email', 'workspace_id': WS}
        walk = handler.Walk(handler._tables(), worker_context, {}, run,
                            lambda store: retention.erase_filter('email', 'x', None, store), None)
        assert handler._phases(walk) == [handler.PHASE_ITEMS]

    def test_a_radar_review_of_the_same_author_is_left(self, aws, worker_context):
        review = {'pk': 'RADAR#rival#ITEMS#2026-01', 'sk': 'REVIEW#r1', 'feedback_id': 'r1', 'radar_brand': 'rival',
                  'author': JANE, 'source_platform': 'web'}
        aws['radar'].put_item(Item=review)
        put_workspace_feedback(aws, WS, 'f1', author=JANE)

        result = handler.handle_event(_job(aws, 'author', JANE), worker_context)

        assert (result['deleted_items'], result['deleted_radar_items']) == (1, 0)
        assert aws['radar'].scan()['Count'] == 1

    def test_a_hand_over_stays_in_the_workspace_its_row_names(self, aws, worker_context, invoke_mock):
        for feedback_id in ('f1', 'f2'):
            put_workspace_feedback(aws, WS, feedback_id, author=JANE)
        put_workspace_feedback(aws, WS_TWO, 'f3', author=JANE)
        budget = iter([900_000, 0])
        worker_context.get_remaining_time_in_millis.side_effect = lambda: next(budget, 0)

        assert handler.handle_event(_job(aws, 'author', JANE), worker_context)['status'] == 'continued'
        payload = invoke_mock.call_args.args[1]
        # The hand-over names the workspace (where its row is) and carries no run-level one.
        assert payload['workspace_id'] == WS
        assert 'workspace_id' not in payload['run']

        worker_context.get_remaining_time_in_millis.side_effect = None
        result = handler.handle_event(payload, worker_context)

        assert (result['deleted_items'], result['deleted_workspace_items']) == (2, 2)
        assert _items(aws) == {(f'WS#{WS_TWO}#SOURCE#web', 'FEEDBACK#f3')}

    def test_the_job_row_in_the_workspaces_partition_is_closed(self, aws, worker_context):
        put_workspace_feedback(aws, WS, 'f1', author=JANE)

        handler.handle_event(_job(aws, 'author', JANE), worker_context)

        row = _job_row(aws)
        assert (row['status'], row['deleted_items'], row['workspace_id']) == ('completed', 1, WS)
        deployment_jobs = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq('JOB#erasure'))['Items']
        assert deployment_jobs == []

    def test_the_workspaces_lock_is_renewed_at_a_hand_over_and_released_at_the_end(
            self, aws, worker_context, invoke_mock):
        acquire_workspace_lock(aws['aggregates'], WorkspaceScope(WS), JOB_ID, datetime(2026, 1, 1, tzinfo=UTC))
        put_workspace_feedback(aws, WS, 'f1', author=JANE)
        put_workspace_feedback(aws, WS, 'f2', author=JANE)
        budget = iter([900_000, 0])
        worker_context.get_remaining_time_in_millis.side_effect = lambda: next(budget, 0)

        handler.handle_event(_job(aws, 'author', JANE), worker_context)
        lock = _lock(aws)
        assert lock is not None
        assert lock['locked_at'] > '2026-01-01T00:00:00+00:00'
        assert 'released_at' not in lock

        worker_context.get_remaining_time_in_millis.side_effect = None
        handler.handle_event(invoke_mock.call_args.args[1], worker_context)
        lock = _lock(aws)
        assert lock is not None
        assert lock['released_at']

    def test_the_workspaces_data_version_moves_not_the_deployments(self, aws, worker_context):
        put_workspace_feedback(aws, WS, 'f1', author=JANE)

        handler.handle_event(_job(aws, 'author', JANE), worker_context)

        versions = {row['pk']: row['v'] for row in aws['aggregates'].scan()['Items'] if row['sk'] == 'data_version'}
        assert versions == {f'WS#{WS}#METRIC#meta': 1}


class TestFailurePaths:
    def test_a_deployment_claim_fault_fails_no_row_and_tells_nobody(self, aws, worker_context):
        """The path without a workspace keeps its order: the job id goes on the run after a successful claim, so a
        throttled claim writes no `failed` row (and no stub row), and sends no notice."""
        event = _job(aws, 'author', JANE, ws=None)
        throttle = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'UpdateItem')
        with patch.object(handler, 'claim_erasure_job', side_effect=throttle), \
                patch.object(runs.job_notices, 'notify') as notify:
            result = handler.handle_event(event, worker_context)

        assert result['status'] == 'failed'
        stored = aws['aggregates'].get_item(Key={'pk': 'JOB#erasure', 'sk': JOB_ID})['Item']
        assert stored['status'] == 'queued'
        notify.assert_not_called()

    def test_a_deployment_job_past_its_generations_is_left_as_before(self, aws, worker_context):
        event = {**_job(aws, 'author', JANE, ws=None), 'run': {'generation': handler.MAX_GENERATIONS}}

        assert handler.handle_event(event, worker_context)['status'] == 'failed'

        stored = aws['aggregates'].get_item(Key={'pk': 'JOB#erasure', 'sk': JOB_ID})['Item']
        assert stored['status'] == 'queued'

    def test_a_workspace_job_past_its_generations_is_failed_and_frees_its_lock(self, aws, worker_context):
        acquire_workspace_lock(aws['aggregates'], WorkspaceScope(WS), JOB_ID, datetime.now(UTC))
        put_workspace_feedback(aws, WS, 'f1', author=JANE)
        event = {**_job(aws, 'author', JANE), 'run': {'generation': handler.MAX_GENERATIONS}}

        assert handler.handle_event(event, worker_context)['status'] == 'failed'

        row = _job_row(aws)
        assert (row['status'], row['error']) == ('failed', 'Stopped after too many hand-overs')
        lock = _lock(aws)
        assert lock is not None
        assert lock['released_at']
        assert (f'WS#{WS}#SOURCE#web', 'FEEDBACK#f1') in _items(aws)

    def test_a_workspace_claim_fault_fails_its_row_and_frees_its_lock(self, aws, worker_context):
        acquire_workspace_lock(aws['aggregates'], WorkspaceScope(WS), JOB_ID, datetime.now(UTC))
        event = _job(aws, 'author', JANE)
        throttle = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'UpdateItem')
        with patch.object(handler, 'claim_erasure_job', side_effect=throttle):
            assert handler.handle_event(event, worker_context)['status'] == 'failed'

        assert _job_row(aws)['status'] == 'failed'
        lock = _lock(aws)
        assert lock is not None
        assert lock['released_at']


class TestTheWorkspaceComesFromTheServer:
    def test_an_event_naming_a_workspace_finds_no_deployment_job(self, aws, worker_context):
        _same_review_in_three_scopes(aws, author=JANE)
        before = _items(aws)
        event = {**_job(aws, 'author', JANE, source='tickets', ws=None), 'workspace_id': WS}

        result = handler.handle_event(event, worker_context)

        # The row is not in the workspace's partition: no job, nothing read or deleted, the deployment's row as it was.
        assert result == {'status': 'nothing_to_do'}
        assert _items(aws) == before
        stored = aws['aggregates'].get_item(Key={'pk': 'JOB#erasure', 'sk': JOB_ID})['Item']
        assert stored['status'] == 'queued'

    @pytest.mark.parametrize('row_ws', [WS_TWO, None, 'not-a-workspace', ''])
    def test_a_row_naming_another_or_no_workspace_fails_and_deletes_nothing(self, aws, worker_context, row_ws):
        _same_review_in_three_scopes(aws, author=JANE)
        before = _items(aws)

        result = handler.handle_event(_job(aws, 'author', JANE, row_ws=row_ws), worker_context)

        assert result['status'] == 'failed'
        assert _items(aws) == before
        assert _tombstones(aws, 'tickets') == {}
        assert _job_row(aws)['error'] == 'Run failed (ValueError)'

    @pytest.mark.parametrize('named', ['not-a-workspace', '', None, 7])
    def test_an_event_naming_no_valid_workspace_is_refused_before_any_read(self, aws, worker_context, named):
        _same_review_in_three_scopes(aws, author=JANE)
        before = _items(aws)
        event = {**_job(aws, 'author', JANE), 'workspace_id': named}

        assert handler.handle_event(event, worker_context) == {'status': 'nothing_to_do'}
        assert _items(aws) == before
        assert _job_row(aws)['status'] == 'queued'

    def test_a_whole_source_job_that_names_a_workspace_fails_and_deletes_nothing(self, aws, worker_context):
        put_feedback(aws, 'f1')
        put_workspace_feedback(aws, WS, 'f2')
        before = (_items(aws), _versions(aws, ''))

        result = handler.handle_event(_job(aws, 'source', 'web', source='web'), worker_context)

        assert result['status'] == 'failed'
        assert (_items(aws), _versions(aws, '')) == before

    def test_a_matched_row_outside_the_workspace_fails_the_run_before_any_tombstone(self, aws, worker_context):
        """Defence in depth: should the filter ever match another scope's row, nothing is tombstoned or deleted."""
        put_feedback(aws, 'f1', author=JANE)
        put_workspace_feedback(aws, WS, 'f2', author=JANE)
        before = _items(aws)
        broad = retention.erase_filter('author', JANE, None)  # the deployment's filter, no scope

        with patch.object(handler.retention, 'erase_filter', return_value=broad):
            result = handler.handle_event(_job(aws, 'author', JANE), worker_context)

        assert result['status'] == 'failed'
        assert _items(aws) == before
        assert _tombstones(aws) == {}


class TestWithoutAWorkspaceNothingChanges:
    @pytest.mark.parametrize(('field', 'value', 'extra'), ID_AND_AUTHOR_ERASURES)
    def test_an_id_or_author_erasure_stays_the_deployments(self, aws, worker_context, field, value, extra):
        _same_review_in_three_scopes(aws, **extra)
        before = _versions(aws, 'ws/')

        result = handler.handle_event(_job(aws, field, value, source='tickets', ws=None), worker_context)

        assert (result['deleted_items'], 'deleted_workspace_items' in result) == (1, False)
        assert ('SOURCE#tickets', 'FEEDBACK#12345') not in _items(aws)
        assert len(_items(aws)) == 2
        assert _versions(aws, 'ws/') == before
        assert 'workspace_id' not in _audit(aws)


class TestTheFilter:
    @staticmethod
    def _values(condition: Any) -> set[object]:
        return set(ConditionExpressionBuilder().build_expression(condition).attribute_value_placeholders.values())

    @pytest.mark.parametrize('field', retention.WORKSPACE_ERASE_FIELDS)
    def test_a_named_workspace_reaches_its_own_partitions_only(self, field):
        scope = WorkspaceScope(WS)
        values = self._values(retention.erase_filter(field, 'x', 'web', scope=scope))
        assert scope.prefix in values
        assert 'WS#' not in values

    def test_a_named_workspace_cannot_erase_a_whole_source_or_radar(self):
        scope = WorkspaceScope(WS)
        with pytest.raises(ValueError, match='cannot erase by "source"'):
            retention.erase_filter('source', 'web', 'web', scope=scope)
        with pytest.raises(ValueError, match='feedback items only'):
            retention.erase_filter('author', JANE, None, retention.STORE_RADAR, scope)
