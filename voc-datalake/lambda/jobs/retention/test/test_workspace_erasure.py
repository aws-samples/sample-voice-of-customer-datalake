"""voc-retention reaches a workspace's copies of an erased person's data (TENETS.md D5, docs/multi-workspace.md).

An erasure is the deployment's (a deployment admin makes it) and a person's data is erased wherever it is: an
erasure by email, and a source profile's retention window (a workspace's items are processed under the deployment's
profiles), reach every workspace's matching item (``WS#{ws}#SOURCE#…``), its Silver versions under
``ws/{ws}/silver/`` and every version of its raw objects under ``ws/{ws}/raw/``, each item tombstoned before it is
deleted (``AUDIT#tombstone#{source}`` / ``{ws}#{feedback_id}``). A whole-source erasure (a request about the
deployment's own source) and an erasure by author (a display name), source id or CSV row (ids unique only within one
source account or upload) leave workspace items.
"""
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import ConditionExpressionBuilder, Key

from jobs.retention import copies, handler, lineage
from jobs.retention.test.conftest import BUCKET, days_ago, erasure_job, erasure_rows, put_feedback
from shared import retention

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_TWO = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
JOB_ID = 'er_00000000c0de'
BASIS = 'GDPR art. 17 request #789'
DIGESTS = ('0123456789abcdef', 'fedcba9876543210')
JANE_EMAIL = 'jane@example.com'
JANE = {'email': JANE_EMAIL}


def _job(aws, field: str, value: str, source: str | None = None) -> dict:
    return erasure_job(aws, JOB_ID, field, value, legal_basis=BASIS, source=source)


def _put_object(aws, key: str, versions: int = 1) -> str:
    for n in range(versions):
        aws['s3'].put_object(Bucket=BUCKET, Key=key, Body=f'{{"author": "Jane", "v": {n}}}'.encode())
    return key


def put_workspace_feedback(aws, ws: str, feedback_id: str, source: str = 'web', **extra: Any) -> dict[str, str]:
    """One workspace review with two raw versions (one of them written twice) and a kept Silver version (twice)."""
    folder = f'ws/{ws}/raw/{source}/2026/01/01/{feedback_id}/'
    first = _put_object(aws, f'{folder}{DIGESTS[0]}.json', versions=2)
    _put_object(aws, f'{folder}{DIGESTS[1]}.json')
    silver = _put_object(aws, f'ws/{ws}/silver/{source}/{feedback_id}/20260101T000000000000Z-0a0b0c0d.json', 2)
    item = {'pk': f'WS#{ws}#SOURCE#{source}', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
            'source_id': feedback_id, 'source_platform': source, 'date': days_ago(1),
            's3_raw_uri': f's3://{BUCKET}/{first}', 'gsi1pk': f'WS#{ws}#DATE#{days_ago(1)}', **extra}
    aws['feedback'].put_item(Item=item)
    return {'raw': first, 'silver': silver}


def _versions(aws, prefix: str) -> list[str]:
    page = aws['s3'].list_object_versions(Bucket=BUCKET, Prefix=prefix)
    return sorted(entry['Key'] for entry in [*page.get('Versions', []), *page.get('DeleteMarkers', [])])


def _items(aws) -> set[tuple[str, str]]:
    return {(row['pk'], row['sk']) for row in aws['feedback'].scan()['Items']}


def _tombstones(aws, source: str = 'web') -> dict[str, dict]:
    rows = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(f'AUDIT#tombstone#{source}'))['Items']
    return {str(row['sk']): row for row in rows}


def _run_seeing_tombstones(aws, event: dict, context: Any) -> tuple[dict, list[set[str]]]:
    """Run ``event``; the result and, at each item delete, the tombstone keys already written."""
    seen: list[set[str]] = []
    real_delete = copies.retention.delete_item

    def delete_after_looking(*args: Any) -> tuple[int, int]:
        seen.append(set(_tombstones(aws)))
        return real_delete(*args)

    with patch.object(copies.retention, 'delete_item', delete_after_looking):
        return handler.handle_event(event, context), seen


def _audit(aws) -> dict:
    return erasure_rows(aws, JOB_ID)[1]


def _job_row(aws) -> dict:
    return erasure_rows(aws, JOB_ID)[0]


class TestErasureReachesWorkspaces:
    def test_it_tombstones_then_deletes_the_item_its_silver_versions_and_every_raw_version(self, aws, worker_context):
        put_workspace_feedback(aws, WS, 'f1', metadata=JANE, text='I hate it')
        put_workspace_feedback(aws, WS, 'f2', metadata={'email': 'john@example.com'})

        result = handler.handle_event(_job(aws, 'email', JANE_EMAIL), worker_context)

        assert _items(aws) == {(f'WS#{WS}#SOURCE#web', 'FEEDBACK#f2')}
        assert _versions(aws, f'ws/{WS}/raw/web/2026/01/01/f1/') == []
        assert _versions(aws, f'ws/{WS}/silver/web/f1/') == []
        assert _versions(aws, f'ws/{WS}/raw/web/2026/01/01/f2/') != []
        # Two raw files and one Silver file held data (every object version of each went).
        assert (result['deleted_items'], result['deleted_workspace_items'], result['deleted_objects']) == (1, 1, 3)
        tombstone = _tombstones(aws)[f'{WS}#f1']
        assert {key: value for key, value in tombstone.items() if key not in ('deleted_at', 'run_id')} == {
            'pk': 'AUDIT#tombstone#web', 'sk': f'{WS}#f1', 'feedback_id': 'f1', 'source': 'web', 'store': 'feedback',
            'mode': 'erase', 'job_id': JOB_ID, 'legal_basis': BASIS, 'workspace_id': WS}
        assert 'jane@' not in str(tombstone)
        assert 'hate' not in str(tombstone)
        assert 'ttl' not in tombstone
        assert _job_row(aws)['deleted_workspace_items'] == 1
        assert _audit(aws)['deleted_workspace_items'] == 1

    def test_the_tombstone_is_written_before_the_workspace_item_is_deleted(self, aws, worker_context):
        put_workspace_feedback(aws, WS, 'f1', metadata=JANE)
        _result, seen_at_delete = _run_seeing_tombstones(aws, _job(aws, 'email', JANE_EMAIL), worker_context)
        assert seen_at_delete == [{f'{WS}#f1'}]

    def test_two_workspaces_and_the_deployment_each_lose_their_copy_under_their_own_tombstone(
            self, aws, worker_context):
        put_workspace_feedback(aws, WS, 'f1', metadata={'email': 'jane@example.com'})
        put_workspace_feedback(aws, WS_TWO, 'f1', metadata={'email': 'jane@example.com'})
        put_feedback(aws, 'f1', metadata={'email': 'jane@example.com'})

        result = handler.handle_event(_job(aws, 'email', 'Jane@Example.com'), worker_context)

        assert _items(aws) == set()
        assert _versions(aws, 'ws/') == []
        assert (result['deleted_items'], result['deleted_workspace_items']) == (3, 2)
        tombstones = _tombstones(aws)
        assert set(tombstones) == {'f1', f'{WS}#f1', f'{WS_TWO}#f1'}
        assert (tombstones[f'{WS}#f1']['workspace_id'], tombstones[f'{WS_TWO}#f1']['workspace_id']) == (WS, WS_TWO)
        assert 'workspace_id' not in tombstones['f1']

    def test_an_erasure_within_one_source_reaches_that_source_in_every_workspace_only(self, aws, worker_context):
        put_workspace_feedback(aws, WS, 'f1', 'web', metadata=JANE)
        put_workspace_feedback(aws, WS, 'f2', 'tickets', metadata=JANE)

        handler.handle_event(_job(aws, 'email', JANE_EMAIL, source='web'), worker_context)

        assert _items(aws) == {(f'WS#{WS}#SOURCE#tickets', 'FEEDBACK#f2')}

    @pytest.mark.parametrize(('field', 'value'), [
        # Ticket 12345 of the deployment's account is not ticket 12345 of the workspace's own account.
        ('source_id', '12345'),
        # A display name is not one person: the deployment's Jane Doe is not the workspace's Jane Doe.
        ('author', 'Jane Doe'),
    ])
    def test_an_erasure_by_author_or_source_id_leaves_a_workspaces_same_valued_item(
            self, aws, worker_context, field: str, value: str):
        put_feedback(aws, '12345', 'tickets', author='Jane Doe')
        put_workspace_feedback(aws, WS, '12345', 'tickets', author='Jane Doe')
        before = _versions(aws, 'ws/')

        result = handler.handle_event(_job(aws, field, value, source='tickets'), worker_context)

        assert (result['deleted_items'], 'deleted_workspace_items' in result) == (1, False)
        assert _items(aws) == {(f'WS#{WS}#SOURCE#tickets', 'FEEDBACK#12345')}
        assert _versions(aws, 'ws/') == before

    def test_a_deployment_only_erasure_reads_as_before(self, aws, worker_context):
        put_feedback(aws, 'f1', metadata=JANE)
        put_workspace_feedback(aws, WS, 'f2', metadata={'email': 'john@example.com'})

        result = handler.handle_event(_job(aws, 'email', JANE_EMAIL), worker_context)

        assert (result['deleted_items'], 'deleted_workspace_items' in result) == (1, False)
        assert 'deleted_workspace_items' not in _job_row(aws)
        assert 'deleted_workspace_items' not in _audit(aws)
        assert _items(aws) == {(f'WS#{WS}#SOURCE#web', 'FEEDBACK#f2')}
        assert _audit(aws)['erased_sources'] == ['web']

    @staticmethod
    def _erase_jane_citing(aws, context: Any, cited: list[str]) -> tuple[dict, Any]:
        """A persona citing ``cited``; erase Jane's reviews, watching the lineage pass's project scan."""
        aws['projects'].put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PERSONA#a', 'input_feedback_ids': cited})
        with patch.object(lineage, 'scan_page', wraps=lineage.scan_page) as scan:
            return handler.handle_event(_job(aws, 'email', JANE_EMAIL), context), scan

    def test_a_run_that_deleted_only_workspace_items_never_scans_the_projects(self, aws, worker_context):
        put_workspace_feedback(aws, WS, 'f1', metadata=JANE)

        result, scan = self._erase_jane_citing(aws, worker_context, ['f1'])

        # The deployment's persona cites the deployment's f1, not the workspace's: nothing to mark, nothing read.
        scan.assert_not_called()
        assert result['artifacts_marked'] == 0

    def test_a_run_with_one_deployment_item_scans_the_projects(self, aws, worker_context):
        put_workspace_feedback(aws, WS, 'f1', metadata=JANE)
        put_feedback(aws, 'f2', metadata=JANE)

        result, scan = self._erase_jane_citing(aws, worker_context, ['f1', 'f2'])

        scan.assert_called()
        # Only the deployment's f2 is erased evidence: the workspace's f1 tombstone is `{ws}#f1`, never matched.
        assert result['artifacts_marked'] == 1
        [persona] = aws['projects'].scan()['Items']
        assert persona['input_feedback_ids'] == ['f1']

    def test_a_workspace_item_never_takes_another_scopes_objects(self, aws, worker_context):
        deployment_key = _put_object(aws, 'raw/web/2026/01/01/f1/0123456789abcdef.json')
        other_workspace = _put_object(aws, f'ws/{WS_TWO}/raw/web/2026/01/01/f2/0123456789abcdef.json')
        for feedback_id, key in (('f1', deployment_key), ('f2', other_workspace)):
            aws['feedback'].put_item(Item={
                'pk': f'WS#{WS}#SOURCE#web', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
                'source_id': feedback_id, 'source_platform': 'web', 'metadata': JANE,
                's3_raw_uri': f's3://{BUCKET}/{key}'})
        deployment_silver = _put_object(aws, 'silver/web/f1/20260101T000000000000Z-0a0b0c0d.json')

        result = handler.handle_event(_job(aws, 'email', JANE_EMAIL), worker_context)

        assert (result['deleted_items'], result['deleted_objects']) == (2, 0)
        assert _versions(aws, 'raw/') == [deployment_key]
        assert _versions(aws, f'ws/{WS_TWO}/') == [other_workspace]
        assert _versions(aws, 'silver/') == [deployment_silver]

    def test_a_deployment_item_never_takes_a_workspaces_objects(self, aws, worker_context):
        key = _put_object(aws, f'ws/{WS}/raw/web/2026/01/01/f1/0123456789abcdef.json')
        put_feedback(aws, 'f1', metadata=JANE, s3_raw_uri=f's3://{BUCKET}/{key}')

        assert handler.handle_event(_job(aws, 'email', JANE_EMAIL), worker_context)['deleted_objects'] == 0
        assert _versions(aws, 'ws/') == [key]

    def test_a_ws_key_that_names_no_workspace_fails_the_run_and_deletes_nothing(self, aws, worker_context):
        aws['feedback'].put_item(Item={'pk': 'WS#not-a-workspace#SOURCE#web', 'sk': 'FEEDBACK#f1',
                                       'feedback_id': 'f1', 'source_platform': 'web', 'metadata': JANE})

        result = handler.handle_event(_job(aws, 'email', JANE_EMAIL), worker_context)

        assert result['status'] == 'failed'
        assert _items(aws) == {('WS#not-a-workspace#SOURCE#web', 'FEEDBACK#f1')}
        assert _job_row(aws)['error'] == 'Run failed (ValueError)'

    def test_a_hand_over_resumes_across_workspace_items_and_carries_their_count(
            self, aws, worker_context, invoke_mock):
        put_workspace_feedback(aws, WS, 'f1', metadata=JANE)
        put_workspace_feedback(aws, WS, 'f2', metadata=JANE)
        put_workspace_feedback(aws, WS_TWO, 'f3', metadata=JANE)
        budget = iter([900_000, 0])
        worker_context.get_remaining_time_in_millis.side_effect = lambda: next(budget, 0)

        assert handler.handle_event(_job(aws, 'email', JANE_EMAIL), worker_context)['status'] == 'continued'
        payload = invoke_mock.call_args.args[1]
        assert (payload['phase'], payload['run']['deleted_items'], payload['run']['deleted_workspace_items']) == (
            'items', 1, 1)
        assert payload['cursor']['pk'].startswith('WS#')
        assert len(_items(aws)) == 2

        worker_context.get_remaining_time_in_millis.side_effect = None
        result = handler.handle_event(payload, worker_context)

        assert _items(aws) == set()
        assert _versions(aws, 'ws/') == []
        assert (result['deleted_items'], result['deleted_workspace_items']) == (3, 3)
        assert _job_row(aws)['deleted_workspace_items'] == 3


class TestRetentionWindowsReachWorkspaces:
    """A workspace's message is processed under the deployment's source profiles, so their windows bind it too."""

    @staticmethod
    def _window(aws, days: int = 30) -> None:
        aws['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': [
            {'id': 'web', 'retention_days': days, 'retention_legal_basis': BASIS}]})

    def test_a_window_deletes_expired_workspace_items_with_every_copy_in_two_workspaces(self, aws, worker_context):
        self._window(aws)
        put_feedback(aws, 'old', date=days_ago(400))
        put_feedback(aws, 'new')
        put_workspace_feedback(aws, WS, 'old_ws', date=days_ago(400))
        put_workspace_feedback(aws, WS_TWO, 'old_ws', date=days_ago(400))
        kept = put_workspace_feedback(aws, WS, 'new_ws')

        result, seen_at_delete = _run_seeing_tombstones(aws, {'mode': 'retention'}, worker_context)

        assert _items(aws) == {('SOURCE#web', 'FEEDBACK#new'), (f'WS#{WS}#SOURCE#web', 'FEEDBACK#new_ws')}
        assert (result['deleted_items'], result['deleted_workspace_items']) == (3, 2)
        # Every expired item's tombstone was there before the first delete (one page).
        assert len(seen_at_delete) == 3
        assert all(seen == {'old', f'{WS}#old_ws', f'{WS_TWO}#old_ws'} for seen in seen_at_delete)
        tombstones = _tombstones(aws)
        assert {row['mode'] for row in tombstones.values()} == {'retention'}
        assert tombstones[f'{WS_TWO}#old_ws']['workspace_id'] == WS_TWO
        assert tombstones[f'{WS}#old_ws']['legal_basis'] == BASIS
        for ws in (WS, WS_TWO):
            assert _versions(aws, f'ws/{ws}/raw/web/2026/01/01/old_ws/') == []
            assert _versions(aws, f'ws/{ws}/silver/web/old_ws/') == []
        assert kept['raw'] in _versions(aws, f'ws/{WS}/raw/')
        assert kept['silver'] in _versions(aws, f'ws/{WS}/silver/')

    def test_a_ws_row_that_names_no_workspace_is_skipped_and_counted_never_deleted(self, aws, worker_context):
        self._window(aws)
        put_feedback(aws, 'old', date=days_ago(400))
        aws['feedback'].put_item(Item={'pk': 'WS#not-a-workspace#SOURCE#web', 'sk': 'FEEDBACK#bad',
                                       'feedback_id': 'bad', 'source_platform': 'web', 'date': days_ago(400)})

        with patch.object(handler.metrics, 'add_metric') as add_metric:
            result = handler.handle_event({'mode': 'retention'}, worker_context)

        # One bad row never stalls the deployment's windows: the run completes, the row stays, untombstoned.
        assert (result['status'], result['deleted_items'], result['unscoped_rows_skipped']) == ('completed', 1, 1)
        assert _items(aws) == {('WS#not-a-workspace#SOURCE#web', 'FEEDBACK#bad')}
        assert set(_tombstones(aws)) == {'old'}
        add_metric.assert_any_call(name='RetentionUnscopedRowsSkipped', unit='Count', value=1)
        [audit] = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq('AUDIT#retention'))['Items']
        assert audit['unscoped_rows_skipped'] == 1

    def test_the_deployment_reads_as_before_when_no_workspace_item_expired(self, aws, worker_context):
        self._window(aws)
        put_feedback(aws, 'old', date=days_ago(400))
        put_workspace_feedback(aws, WS, 'new_ws')
        before = _versions(aws, 'ws/')

        result = handler.handle_event({'mode': 'retention'}, worker_context)

        assert result['deleted_items'] == 1
        assert 'deleted_workspace_items' not in result
        assert set(_tombstones(aws)) == {'old'}
        assert _versions(aws, 'ws/') == before


class TestWholeSourceErasureLeavesWorkspaces:
    def test_a_whole_source_erasure_leaves_workspace_items_and_their_objects(self, aws, worker_context):
        put_feedback(aws, 'f1')
        put_workspace_feedback(aws, WS, 'f2')
        before = _versions(aws, 'ws/')

        result = handler.handle_event(_job(aws, 'source', 'web', source='web'), worker_context)

        assert result['deleted_items'] == 1
        assert _items(aws) == {(f'WS#{WS}#SOURCE#web', 'FEEDBACK#f2')}
        assert _versions(aws, 'ws/') == before


class TestS3ImportOriginals:
    """No row links an S3 import's item to the original file it came from, so the run lists the folder for review."""

    def test_a_workspace_imports_original_is_kept_and_its_folder_listed(self, aws, worker_context):
        original = _put_object(aws, f'ws/{WS}/raw/s3_import/2026/01/01/batch__feedback/0123456789abcdef.csv')
        put_workspace_feedback(aws, WS, 'f1', 'S3 - batch', metadata=JANE)
        put_workspace_feedback(aws, WS, 'f2', 'S3 - batch', metadata=JANE)

        with patch.object(copies.retention, 'holds_files', wraps=retention.holds_files) as holds_files:
            result = handler.handle_event(_job(aws, 'email', JANE_EMAIL), worker_context)

        # Two items of one folder: the folder is listed once per invocation.
        assert holds_files.call_count == 1
        assert result['deleted_workspace_items'] == 2
        assert _versions(aws, f'ws/{WS}/raw/s3_import/') == [original]
        assert _job_row(aws)['files_needing_review'] == {
            'count': 1, 'keys': [f'ws/{WS}/raw/s3_import/'], 'more': False}

    def test_the_deployments_originals_folder_is_listed_the_same_way(self, aws, worker_context):
        _put_object(aws, 'raw/s3_import/2026/01/01/batch__feedback/0123456789abcdef.csv')
        put_feedback(aws, 'f1', 'S3 - batch', metadata=JANE)

        handler.handle_event(_job(aws, 'email', JANE_EMAIL), worker_context)

        assert _job_row(aws)['files_needing_review']['keys'] == ['raw/s3_import/']

    def test_an_empty_originals_folder_or_another_source_lists_nothing(self, aws, worker_context):
        _put_object(aws, f'ws/{WS_TWO}/raw/s3_import/2026/01/01/batch__feedback/0123456789abcdef.csv')
        put_workspace_feedback(aws, WS, 'f1', 'S3 - batch', metadata=JANE)
        put_workspace_feedback(aws, WS_TWO, 'f2', 'web', metadata=JANE)

        handler.handle_event(_job(aws, 'email', JANE_EMAIL), worker_context)

        assert 'files_needing_review' not in _job_row(aws)

    def test_a_folder_whose_first_page_is_delete_markers_still_holds_files(self):
        # A stub client: moto does not page delete markers apart from versions.
        s3 = MagicMock()
        s3.get_paginator.return_value.paginate.return_value = [
            {'DeleteMarkers': [{'Key': 'raw/s3_import/a/x.csv', 'VersionId': 'm1'}]},
            {'Versions': [{'Key': 'raw/s3_import/b/y.csv', 'VersionId': 'v1'}]},
        ]
        assert retention.holds_files(s3, BUCKET, 'raw/s3_import/')
        s3.get_paginator.return_value.paginate.return_value = [
            {'DeleteMarkers': [{'Key': 'raw/s3_import/a/x.csv', 'VersionId': 'm1'}]}, {}]
        assert not retention.holds_files(s3, BUCKET, 'raw/s3_import/')

    def test_a_folder_of_delete_markers_only_lists_nothing(self, aws, worker_context):
        key = _put_object(aws, f'ws/{WS}/raw/s3_import/2026/01/01/batch__feedback/0123456789abcdef.csv')
        aws['s3'].delete_object(Bucket=BUCKET, Key=key)  # a marker over the one version
        version = next(entry for entry in aws['s3'].list_object_versions(Bucket=BUCKET, Prefix=key)['Versions'])
        aws['s3'].delete_object(Bucket=BUCKET, Key=key, VersionId=version['VersionId'])
        put_workspace_feedback(aws, WS, 'f1', 'S3 - batch', metadata=JANE)

        handler.handle_event(_job(aws, 'email', JANE_EMAIL), worker_context)

        assert 'files_needing_review' not in _job_row(aws)

    def test_the_originals_folder_of_an_items_scope(self):
        assert retention.import_originals_prefix({'pk': f'WS#{WS}#SOURCE#x', 'source_platform': 'S3 - x'}) == (
            f'ws/{WS}/raw/s3_import/')
        assert retention.import_originals_prefix({'pk': 'SOURCE#x', 'source_platform': 'S3 - x'}) == 'raw/s3_import/'
        assert retention.import_originals_prefix({'pk': 'SOURCE#x', 'source_platform': 'web'}) is None


class TestFilters:
    @staticmethod
    def _reaches_workspace_items(condition: Any) -> bool:
        built = ConditionExpressionBuilder().build_expression(condition)
        return 'WS#' not in built.attribute_value_placeholders.values()

    def test_an_email_erasure_and_a_window_reach_workspaces_and_the_other_fields_do_not(self):
        assert retention.reaches_workspaces('email')
        assert self._reaches_workspace_items(retention.erase_filter('email', 'x', None))
        assert self._reaches_workspace_items(retention.retention_filter({'web': '2026-01-01'}))
        for field in ('author', 'source_id', 'csv_row_id', 'source'):
            assert not retention.reaches_workspaces(field)
            assert not self._reaches_workspace_items(retention.erase_filter(field, 'web', 'web'))

    def test_an_items_scope(self):
        assert retention.item_scope({'pk': 'SOURCE#web'}) is None
        assert retention.item_scope({'pk': 'RADAR#rival#ITEMS#2026-01'}) is None
        scope = retention.item_scope({'pk': f'WS#{WS}#SOURCE#web'})
        assert scope is not None
        assert scope.ws == WS
