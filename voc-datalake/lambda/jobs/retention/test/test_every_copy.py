"""voc-retention reaches every copy: tombstones first, legal basis, Radar, whole-file uploads, lineage."""
from typing import Any
from unittest.mock import patch

import pytest
from boto3.dynamodb.conditions import Key

from jobs.retention import boards, boards_rekey, copies, handler, lineage, runs
from jobs.retention.test.conftest import BUCKET, days_ago
from shared.digests import sha256_hex
from shared.legal_basis import LEGACY_LEGAL_BASIS

JOB_ID = 'er_00000000abcd'
BASIS = 'GDPR art. 17 request #123'


def _feedback(aws, feedback_id: str, source: str = 'web', **extra: Any) -> None:
    aws['feedback'].put_item(Item={'pk': f'SOURCE#{source}', 'sk': f'FEEDBACK#{feedback_id}',
                                   'feedback_id': feedback_id, 'source_id': feedback_id, 'source_platform': source,
                                   'date': days_ago(1), **extra})


def _radar(aws, feedback_id: str, source: str = 'web_rival', brand: str = 'rival', **extra: Any) -> str:
    key = f'raw/{source}/2026/01/01/{feedback_id}.json'
    aws['s3'].put_object(Bucket=BUCKET, Key=key, Body=b'{}')
    aws['radar'].put_item(Item={
        'pk': f'RADAR#{brand}#ITEMS#2026-01', 'sk': f'2026-01-01#{feedback_id}', 'feedback_id': feedback_id,
        'source_id': feedback_id, 'source_platform': source, 'radar_brand': brand, 'date': days_ago(1),
        's3_raw_uri': f's3://{BUCKET}/{key}', **extra})
    aws['radar'].put_item(Item={'pk': f'RADARID#{brand}', 'sk': feedback_id,
                                'item_pk': f'RADAR#{brand}#ITEMS#2026-01', 'item_sk': f'2026-01-01#{feedback_id}'})
    return key


def _job(aws, field: str, value: str, source: str | None = None, **extra: Any) -> dict:
    aws['aggregates'].put_item(Item={
        'pk': 'JOB#erasure', 'sk': JOB_ID, 'job_id': JOB_ID, 'status': 'queued', 'field': field,
        'value_hash': sha256_hex(value), **({'source': source} if source else {}), **extra})
    return {'mode': 'erase', 'job_id': JOB_ID, 'value': value}


def _job_row(aws) -> dict:
    return aws['aggregates'].get_item(Key={'pk': 'JOB#erasure', 'sk': JOB_ID})['Item']


def _tombstones(aws, source: str) -> list[dict]:
    return aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(f'AUDIT#tombstone#{source}'))['Items']


def _audit(aws) -> dict:
    [row] = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(runs.AUDIT_PK))['Items']
    return row


def _keys(aws) -> set[str]:
    page = aws['s3'].list_object_versions(Bucket=BUCKET)
    return {entry['Key'] for entry in page.get('Versions', [])}


class TestTombstones:
    def test_every_deleted_item_leaves_a_contentless_tombstone_with_its_legal_basis(self, aws, worker_context):
        event = _job(aws, 'author', 'Jane', legal_basis=BASIS)
        _feedback(aws, 'f1', author='Jane', text='I hate it')
        _feedback(aws, 'f2', author='John')
        handler.handle_event(event, worker_context)
        [tombstone] = _tombstones(aws, 'web')
        assert {key: value for key, value in tombstone.items() if key != 'deleted_at'} == {
            'pk': 'AUDIT#tombstone#web', 'sk': 'f1', 'feedback_id': 'f1', 'source': 'web', 'store': 'feedback',
            'mode': 'erase', 'run_id': tombstone['run_id'], 'job_id': JOB_ID, 'legal_basis': BASIS}
        assert 'ttl' not in tombstone
        assert 'Jane' not in str(tombstone)
        assert 'hate' not in str(tombstone)
        assert (_job_row(aws)['legal_basis'], _audit(aws)['legal_basis']) == (BASIS, BASIS)

    def test_the_tombstones_are_written_before_any_item_is_deleted(self, aws, worker_context):
        event = _job(aws, 'author', 'Jane', legal_basis=BASIS)
        _feedback(aws, 'f1', author='Jane')
        _feedback(aws, 'f2', author='Jane')
        order: list[str] = []
        real_write, real_delete = copies.write_tombstones, copies.retention.delete_item

        def write(*args: Any) -> None:
            real_write(*args)
            order.append('tombstones')

        def delete(*args: Any) -> tuple[int, int]:
            order.append('delete')
            return real_delete(*args)

        with patch.object(handler, 'write_tombstones', write), patch.object(copies.retention, 'delete_item', delete):
            handler.handle_event(event, worker_context)
        assert order[:3] == ['tombstones', 'delete', 'delete']

    def test_a_failed_delete_leaves_the_tombstone_and_a_retry_rewrites_the_same_key(self, aws, worker_context):
        event = _job(aws, 'author', 'Jane', legal_basis=BASIS)
        _feedback(aws, 'f1', author='Jane')
        with patch.object(copies.retention, 'delete_item', side_effect=RuntimeError('boom')):
            assert handler.handle_event(event, worker_context)['status'] == 'failed'
        assert [row['sk'] for row in _tombstones(aws, 'web')] == ['f1']
        aws['aggregates'].update_item(Key={'pk': 'JOB#erasure', 'sk': JOB_ID}, UpdateExpression='SET #s = :q',
                                      ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':q': 'queued'})
        assert handler.handle_event(event, worker_context)['deleted_items'] == 1
        assert [row['sk'] for row in _tombstones(aws, 'web')] == ['f1']

    def test_a_job_from_before_6_00_reads_not_recorded(self, aws, worker_context):
        event = _job(aws, 'author', 'Jane')
        _feedback(aws, 'f1', author='Jane')
        handler.handle_event(event, worker_context)
        assert _tombstones(aws, 'web')[0]['legal_basis'] == LEGACY_LEGAL_BASIS

    def test_retention_records_each_profiles_basis_and_a_legacy_profile_keeps_running(self, aws, worker_context):
        aws['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': [
            {'id': 'tickets', 'retention_days': 30, 'retention_legal_basis': 'DPA with vendor X, 12 months'},
            {'id': 'legacy', 'retention_days': 30}]})
        _feedback(aws, 't1', 'tickets', date=days_ago(40))
        _feedback(aws, 'l1', 'legacy', date=days_ago(40))
        result = handler.handle_event({'mode': 'retention'}, worker_context)
        assert result['deleted_items'] == 2
        assert _tombstones(aws, 'tickets')[0]['legal_basis'] == 'DPA with vendor X, 12 months'
        assert _tombstones(aws, 'legacy')[0]['legal_basis'] == LEGACY_LEGAL_BASIS
        assert _tombstones(aws, 'legacy')[0]['mode'] == 'retention'
        assert _audit(aws)['legal_bases'] == {'tickets': 'DPA with vendor X, 12 months', 'legacy': LEGACY_LEGAL_BASIS}


class TestRadar:
    def test_an_erasure_by_author_deletes_the_radar_review_its_marker_and_raw_but_not_its_counters(
            self, aws, worker_context):
        event = _job(aws, 'author', 'Jane', legal_basis=BASIS)
        key = _radar(aws, 'r1', author='Jane')
        _radar(aws, 'r2', author='John')
        aws['radar'].put_item(Item={'pk': 'RADAR#rival#daily_total', 'sk': '2026-01-01', 'count': 2})
        result = handler.handle_event(event, worker_context)
        assert (result['deleted_items'], result['deleted_radar_items'], result['deleted_objects']) == (0, 1, 1)
        rows = {(row['pk'], row['sk']) for row in aws['radar'].scan()['Items']}
        assert ('RADARID#rival', 'r1') not in rows
        assert ('RADAR#rival#ITEMS#2026-01', '2026-01-01#r1') not in rows
        assert ('RADAR#rival#daily_total', '2026-01-01') in rows
        assert ('RADARID#rival', 'r2') in rows
        assert key not in _keys(aws)
        assert _tombstones(aws, 'web_rival')[0]['store'] == 'radar'
        assert _job_row(aws)['deleted_radar_items'] == 1

    def test_a_whole_source_erasure_of_a_radar_routed_source(self, aws, worker_context):
        event = _job(aws, 'source', 'web_rival', 'web_rival', legal_basis=BASIS)
        _radar(aws, 'r1')
        _radar(aws, 'r2')
        _radar(aws, 'kept', source='web_other')
        result = handler.handle_event(event, worker_context)
        assert result['deleted_radar_items'] == 2
        assert {row['feedback_id'] for row in aws['radar'].scan()['Items'] if 'feedback_id' in row} == {'kept'}

    def test_a_counter_row_never_matches_even_with_an_items_category(self, aws, worker_context):
        event = _job(aws, 'source', 'web_rival', 'web_rival', legal_basis=BASIS)
        aws['radar'].put_item(Item={'pk': 'RADAR#rival#category_sentiment#ITEMS#positive', 'sk': '2026-01-01',
                                    'source_platform': 'web_rival', 'count': 1})
        handler.handle_event(event, worker_context)
        assert aws['radar'].scan()['Count'] == 1

    def test_without_a_radar_table_the_phase_is_skipped(self, aws, worker_context):
        event = _job(aws, 'author', 'Jane', legal_basis=BASIS)
        _radar(aws, 'r1', author='Jane')
        with patch.object(handler, 'RADAR_TABLE', ''):
            assert handler.handle_event(event, worker_context)['deleted_radar_items'] == 0

    def test_a_radar_delete_bumps_the_radar_version(self, aws, worker_context):
        event = _job(aws, 'author', 'Jane', legal_basis=BASIS)
        _radar(aws, 'r1', author='Jane')
        handler.handle_event(event, worker_context)
        assert aws['radar'].get_item(Key={'pk': 'SETTINGS#radar', 'sk': 'version'}).get('Item')


UPLOAD = 'raw/csv_upload/2026/01/01/job.csv'


class TestWholeFileUploads:
    def _from_upload(self, aws, feedback_id: str, source: str, **extra: Any) -> None:
        _feedback(aws, feedback_id, source, s3_raw_uri=f's3://{BUCKET}/{UPLOAD}', **extra)

    def test_a_whole_source_erasure_deletes_the_sources_uploaded_file_every_version(self, aws, worker_context):
        aws['s3'].put_object(Bucket=BUCKET, Key=UPLOAD, Body=b'a')
        aws['s3'].put_object(Bucket=BUCKET, Key=UPLOAD, Body=b'b')
        event = _job(aws, 'source', 'tickets', 'tickets', legal_basis=BASIS)
        self._from_upload(aws, 'c1', 'tickets')
        self._from_upload(aws, 'c2', 'tickets')
        result = handler.handle_event(event, worker_context)
        assert result['deleted_items'] == 2
        assert aws['s3'].list_object_versions(Bucket=BUCKET, Prefix=UPLOAD).get('Versions') is None
        assert 'files_needing_review' not in _job_row(aws)

    def test_any_other_erasure_keeps_the_file_and_lists_it_for_review(self, aws, worker_context):
        aws['s3'].put_object(Bucket=BUCKET, Key=UPLOAD, Body=b'a')
        event = _job(aws, 'author', 'Jane', legal_basis=BASIS)
        self._from_upload(aws, 'c1', 'tickets', author='Jane')
        self._from_upload(aws, 'c2', 'tickets', author='Jane')
        self._from_upload(aws, 'c3', 'tickets', author='John')
        result = handler.handle_event(event, worker_context)
        assert (result['deleted_items'], result['deleted_objects']) == (2, 0)
        assert UPLOAD in _keys(aws)
        assert _job_row(aws)['files_needing_review'] == {'count': 1, 'keys': [UPLOAD], 'more': False}
        assert _audit(aws)['files_needing_review']['keys'] == [UPLOAD]

    def test_the_review_list_survives_a_hand_over(self, aws, worker_context, invoke_mock):
        event = _job(aws, 'author', 'Jane', legal_basis=BASIS)
        self._from_upload(aws, 'c1', 'tickets', author='Jane')
        self._from_upload(aws, 'c2', 'tickets', author='Jane')
        # Time for one item: the hand-over comes mid-page, after the first row of the upload.
        budget = iter([900_000, 0])
        worker_context.get_remaining_time_in_millis.side_effect = lambda: next(budget, 0)
        assert handler.handle_event(event, worker_context)['status'] == 'continued'
        payload = invoke_mock.call_args.args[1]
        assert payload['run']['review_files'] == [UPLOAD]
        worker_context.get_remaining_time_in_millis.side_effect = None
        handler.handle_event(payload, worker_context)
        assert _job_row(aws)['files_needing_review']['keys'] == [UPLOAD]


def _artifact(aws, sk: str, **lists: Any) -> None:
    aws['projects'].put_item(Item={'pk': 'PROJECT#p1', 'sk': sk, 'name': 'Shopper', 'text': 'quote', **lists})


def _row(aws, sk: str) -> dict:
    return aws['projects'].get_item(Key={'pk': 'PROJECT#p1', 'sk': sk})['Item']


class TestLineage:
    def test_artifacts_that_cited_an_erased_item_lose_the_id_and_say_so(self, aws, worker_context):
        event = _job(aws, 'author', 'Jane', legal_basis=BASIS)
        _feedback(aws, 'f1', author='Jane')
        _feedback(aws, 'f2', author='John')
        _artifact(aws, 'PERSONA#a', input_feedback_ids=['f1', 'f2'], evidence_feedback_ids=['f1'])
        _artifact(aws, 'PRD#b', input_feedback_ids=['f2'])
        _artifact(aws, 'META')
        result = handler.handle_event(event, worker_context)
        assert result['artifacts_marked'] == 1
        persona = _row(aws, 'PERSONA#a')
        assert (persona['input_feedback_ids'], persona['evidence_feedback_ids']) == (['f2'], [])
        mark = persona['erased_evidence']
        assert (mark['count'], mark['job_id'], mark['mode']) == (2, JOB_ID, 'erase')
        assert persona['text'] == 'quote'
        assert 'erased_evidence' not in _row(aws, 'PRD#b')
        assert _job_row(aws)['artifacts_marked'] == 1

    def test_the_count_adds_up_over_runs(self, aws, worker_context):
        _artifact(aws, 'PERSONA#a', input_feedback_ids=['f1'], erased_evidence={'count': 3, 'job_id': 'er_old'})
        _feedback(aws, 'f1', author='Jane')
        handler.handle_event(_job(aws, 'author', 'Jane', legal_basis=BASIS), worker_context)
        assert _row(aws, 'PERSONA#a')['erased_evidence']['count'] == 4

    def test_a_run_that_deleted_nothing_never_scans_the_projects(self, aws, worker_context):
        _artifact(aws, 'PERSONA#a', input_feedback_ids=['f1'])
        with patch.object(lineage, 'scan_page') as scan:
            handler.handle_event(_job(aws, 'author', 'Nobody', legal_basis=BASIS), worker_context)
        scan.assert_not_called()

    def test_an_artifact_changed_meanwhile_is_left_for_the_next_run(self, aws):
        _artifact(aws, 'PERSONA#a', input_feedback_ids=['f1', 'f2'])
        stale = {'pk': 'PROJECT#p1', 'sk': 'PERSONA#a', 'input_feedback_ids': ['f1']}
        run = runs.new_run({}, 'erase')
        assert lineage.mark_artifact(aws['projects'], stale, {'f1'}, run) is False
        assert _row(aws, 'PERSONA#a')['input_feedback_ids'] == ['f1', 'f2']

    def test_the_lineage_pass_hands_over_with_its_cursor(self, aws, worker_context, invoke_mock):
        _feedback(aws, 'f1', author='Jane')
        _artifact(aws, 'PERSONA#a', input_feedback_ids=['f1'])
        _artifact(aws, 'PERSONA#b', input_feedback_ids=['f1'])
        event = _job(aws, 'author', 'Jane', legal_basis=BASIS)
        # Budget for the one item only; the lineage pass hands over after its first one-row page.
        budget = iter([900_000])
        worker_context.get_remaining_time_in_millis.side_effect = lambda: next(budget, 0)
        with patch.object(lineage, 'PAGE_SIZE', 1):
            assert handler.handle_event(event, worker_context)['status'] == 'continued'
            payload = invoke_mock.call_args.args[1]
            assert (payload['phase'], payload['run']['artifacts_marked']) == ('lineage', 1)
            assert payload['cursor']
            worker_context.get_remaining_time_in_millis.side_effect = None
            assert handler.handle_event(payload, worker_context)['artifacts_marked'] == 2

    @pytest.mark.parametrize('sources', [[], ['other']])
    def test_an_id_without_a_tombstone_in_the_runs_sources_is_not_erased(self, aws, sources):
        aws['aggregates'].put_item(Item={'pk': 'AUDIT#tombstone#web', 'sk': 'f1'})
        assert lineage.erased_ids(aws['aggregates'], sources, ['f1']) == set()
        assert lineage.erased_ids(aws['aggregates'], ['web', *sources], ['f1', 'f1', 'f9']) == {'f1'}


def _board_rows(aws) -> dict[str, str]:
    """A request by Jane with her own +1 and John's, each with a raw copy; the raw keys by row."""
    rows = {
        'fr_000000000001': {'pk': 'FR#fr_000000000001', 'sk': 'META', 'request_id': 'fr_000000000001',
                            'title': 'Split invoices', 'reporter_email': 'jane@example.com', 'reporter_name': 'Jane',
                            'created_at': '2026-03-04T10:00:00+00:00', 'totals': {'supporters': 2}, 'version': 0},
        'sup_0000000000aa': {'pk': 'FR#fr_000000000001', 'sk': 'SUP#sup_0000000000aa', 'support_id': 'sup_0000000000aa',
                     'request_id': 'fr_000000000001', 'email': 'jane@example.com', 'name': 'Jane',
                     'is_reporter': True, 'created_at': '2026-03-04T10:00:00+00:00'},
        'sup_0000000000bb': {'pk': 'FR#fr_000000000001', 'sk': 'SUP#sup_0000000000bb', 'support_id': 'sup_0000000000bb',
                     'request_id': 'fr_000000000001', 'email': 'john@example.com', 'name': 'John',
                     'created_at': '2026-03-05T10:00:00+00:00'},
    }
    keys = {}
    for item_id, row in rows.items():
        aws['feature_requests'].put_item(Item=row)
        keys[item_id] = f"raw/feature_requests/2026/03/0{4 if item_id != 'sup_0000000000bb' else 5}/{item_id}/abc.json"
        for body in (b'{"v": 1}', b'{"v": 2}'):
            aws['s3'].put_object(Bucket=BUCKET, Key=keys[item_id], Body=body)
    return keys


def _board_row(aws, sk: str) -> dict:
    return aws['feature_requests'].get_item(Key={'pk': 'FR#fr_000000000001', 'sk': sk})['Item']


def _rekeyed_support(aws) -> dict:
    """Jane's +1 after the erasure: the one support whose id is not one of the fixture's."""
    rows = [row for row in aws['feature_requests'].scan()['Items']
            if str(row['sk']).startswith('SUP#') and row['sk'] not in ('SUP#sup_0000000000aa', 'SUP#sup_0000000000bb')]
    assert len(rows) == 1
    return rows[0]


class TestBoards:
    def test_an_erasure_by_email_deidentifies_the_board_rows_and_deletes_their_raw_copies(self, aws, worker_context):
        keys = _board_rows(aws)
        result = handler.handle_event(_job(aws, 'email', 'Jane@Example.com', legal_basis=BASIS), worker_context)
        assert result['board_items_deidentified'] == 2
        meta, other = _board_row(aws, 'META'), _board_row(aws, 'SUP#sup_0000000000bb')
        assert 'reporter_email' not in meta
        assert 'reporter_name' not in meta
        assert (meta['title'], meta['totals']['supporters']) == ('Split invoices', 2)
        own = _rekeyed_support(aws)
        assert 'email' not in own
        assert 'name' not in own
        assert own['is_reporter'] is True
        assert (other['email'], other['name']) == ('john@example.com', 'John')
        assert _keys(aws) == {keys['sup_0000000000bb']}
        assert result['deleted_objects'] == 2
        assert (_job_row(aws)['board_items_deidentified'], _audit(aws)['board_items_deidentified']) == (2, 2)

    def test_each_board_row_leaves_a_contentless_tombstone_first(self, aws, worker_context):
        _board_rows(aws)
        order: list[str] = []
        real_put, real_deidentify, real_rekey = boards.BoardEraser.tombstones, boards.deidentify, boards_rekey.rekey
        with patch.object(boards.BoardEraser, 'tombstones',
                          lambda self, rows: (order.append('tombstones'), real_put(self, rows))), \
                patch.object(boards, 'deidentify', lambda table, row: (order.append('row'), real_deidentify(table, row))[1]), \
                patch.object(boards_rekey, 'rekey', lambda table, key, new_id: (
                    order.append(f'rekey:{len(_tombstones(aws, "feature_requests"))}'), real_rekey(table, key, new_id))[1]):
            handler.handle_event(_job(aws, 'email', 'jane@example.com', legal_basis=BASIS), worker_context)
        # The request's tombstone before the page changes; the +1's (the 2nd) before its re-key.
        assert order == ['tombstones', 'row', 'rekey:2']
        stones = {row['sk']: row for row in _tombstones(aws, 'feature_requests')}
        new_id = _rekeyed_support(aws)['support_id']
        assert set(stones) == {'fr_000000000001', new_id}
        assert stones[new_id]['support_id'] == new_id
        assert stones[new_id]['feature_request_id'] == 'fr_000000000001'
        assert (stones[new_id]['legal_basis'], stones[new_id]['action']) == (BASIS, 'deidentified')
        assert 'sup_0000000000aa' not in str(stones)
        assert 'jane' not in str(stones).lower()
        assert 'Split' not in str(stones)
        assert all('ttl' not in row for row in stones.values())

    def test_a_support_removed_since_the_scan_leaves_no_tombstone(self, aws, worker_context):
        """A +1 deleted between the scan and its re-key: no tombstone names an id that was never stored."""
        _board_rows(aws)
        table = aws['feature_requests']
        real_current = boards_rekey.current_support

        def removed_meanwhile(tbl, key):
            table.delete_item(Key=dict(key))
            return real_current(tbl, key)

        with patch.object(boards_rekey, 'current_support', removed_meanwhile):
            handler.handle_event(_job(aws, 'email', 'jane@example.com', legal_basis=BASIS), worker_context)
        assert {row['sk'] for row in _tombstones(aws, 'feature_requests')} == {'fr_000000000001'}
        assert _job_row(aws)['board_items_deidentified'] == 1

    @pytest.mark.parametrize(('field', 'value', 'source'), [
        ('author', 'Jane', None), ('email', 'jane@example.com', 'web')])
    def test_other_erasures_leave_the_boards_alone(self, aws, worker_context, field, value, source):
        keys = _board_rows(aws)
        handler.handle_event(_job(aws, field, value, source, legal_basis=BASIS), worker_context)
        assert _board_row(aws, 'META')['reporter_email'] == 'jane@example.com'
        assert _keys(aws) == set(keys.values())

    def test_a_document_that_read_the_request_is_marked(self, aws, worker_context):
        _board_rows(aws)
        _artifact(aws, 'PRD#b', input_feature_request_ids=['fr_000000000001', 'fr_000000000009'])
        result = handler.handle_event(_job(aws, 'email', 'jane@example.com', legal_basis=BASIS), worker_context)
        assert result['artifacts_marked'] == 1
        prd = _row(aws, 'PRD#b')
        assert prd['input_feature_request_ids'] == ['fr_000000000009']
        assert prd['erased_evidence']['count'] == 1

    def test_the_board_pass_hands_over_with_its_cursor(self, aws, worker_context, invoke_mock):
        _board_rows(aws)
        event = _job(aws, 'email', 'jane@example.com', legal_basis=BASIS)
        budget = iter([900_000, 900_000, 900_000])
        worker_context.get_remaining_time_in_millis.side_effect = lambda: next(budget, 0)
        with patch.object(boards, 'PAGE_SIZE', 1):
            assert handler.handle_event(event, worker_context)['status'] == 'continued'
            payload = invoke_mock.call_args.args[1]
            assert payload['phase'] == 'boards'
            worker_context.get_remaining_time_in_millis.side_effect = None
            assert handler.handle_event(payload, worker_context)['board_items_deidentified'] == 2

    def test_the_worker_deletes_only_the_old_key_of_a_rekeyed_support(self, aws, worker_context):
        _board_rows(aws)
        with patch.object(aws['feature_requests'].meta.client, 'delete_item') as delete:
            handler.handle_event(_job(aws, 'email', 'jane@example.com', legal_basis=BASIS), worker_context)
        delete.assert_not_called()
        sks = {row['sk'] for row in aws['feature_requests'].scan()['Items']}
        assert 'SUP#sup_0000000000aa' not in sks
        assert {'META', 'SUP#sup_0000000000bb'} < sks
        assert len(sks) == 3
