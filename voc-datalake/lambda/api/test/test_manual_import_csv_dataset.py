"""CSV dataset uploads (issue #411): `csv-row-v2` identity, the preview, confirmed updates.

A row with its own `id`, uploaded under a dataset name, keeps its identity when its content
is corrected, so re-uploading the corrected file updates the stored row instead of adding a
second one. The update is visible: a dry run lists what would change, and a real upload
that changes stored rows is refused (409) until the caller confirms with `apply_updates`.
Stored rows are read from a moto feedback table, because the plan is keyed reads only.
"""
import json
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws

import manual_import_handler as h
from shared.csv_datasets import csv_row_id_v2, dataset_key
from shared.feedback_keys import feedback_item_key
from shared.test.moto_tables import create_pk_sk_table
from shared.test.source_profile_fixtures import unconfigured_upload_profile

QUEUE = 'https://sqs.example.com/q'
DATASET = 'Example Air Q3'


@pytest.fixture(autouse=True)
def _no_source_profiles() -> Iterator[None]:
    with patch('manual_import_handler.upload_profile', side_effect=unconfigured_upload_profile):
        yield


@pytest.fixture
def feedback():
    """A moto feedback table wired into the handler; the SQS client captured."""
    with mock_aws():
        table = create_pk_sk_table('test-feedback-dataset')
        sqs = MagicMock()
        sqs.send_message_batch.side_effect = lambda Entries, **_kw: {
            'Successful': [{'Id': e['Id']} for e in Entries], 'Failed': []}
        with patch.object(h, 'feedback_table', table), patch.object(h, 'sqs', sqs), \
             patch.object(h, 'PROCESSING_QUEUE_URL', QUEUE), patch.object(h, 'RAW_DATA_BUCKET', ''):
            yield table, sqs


def _post(api_gateway_event, lambda_context, body: dict) -> tuple[int, dict]:
    response = h.lambda_handler(
        api_gateway_event(method='POST', path='/scrapers/manual/csv-upload', body=body), lambda_context)
    return response['statusCode'], json.loads(response['body'])


def _sent(sqs) -> list[dict]:
    return [json.loads(e['MessageBody']) for c in sqs.send_message_batch.call_args_list for e in c.kwargs['Entries']]


def _store(table, row_id: str, content_hash: str, text: str = 'stored text', **extra) -> None:
    """A row as the processor stored it from an earlier upload of the dataset."""
    table.put_item(Item={**feedback_item_key('manual_import', row_id), 'feedback_id': 'x',
                         'csv_content_hash': content_hash, 'original_text': text, **extra})


def _hash_of(csv_text: str, dataset: str = DATASET) -> dict[str, str]:
    """``{csv_row_id: content_hash}`` the boundary computes for ``csv_text``."""
    items, _ = h._parse_csv_to_items(csv_text, 'csv_upload', None, dataset_key(dataset))
    return {i['csv_row_id']: i['content_hash'] for i in items if i.get('content_hash')}


class TestDatasetName:
    @pytest.mark.parametrize(('raw', 'key'), [
        (None, None), ('', None), ('   ', None), ('  Example Air Q3 ', 'example air q3'),
        ('example   AIR q3', 'example air q3'), ('a.b-c_d 9', 'a.b-c_d 9'), ('x' * 64, 'x' * 64),
    ])
    def test_a_name_is_trimmed_and_matched_case_insensitively(self, raw, key):
        assert dataset_key(raw) == key

    @pytest.mark.parametrize('raw', ['x' * 65, 'q3/2026', 'émission', 'a#b', 7])
    def test_an_invalid_name_is_refused(self, raw):
        with pytest.raises(ValueError, match='dataset_name'):
            dataset_key(raw)

    @pytest.mark.usefixtures('feedback')
    def test_an_invalid_name_is_a_400(self, api_gateway_event, lambda_context):
        status, body = _post(api_gateway_event, lambda_context, {'csv_text': 'id,text\n1,a\n', 'dataset_name': 'a/b'})
        assert status == 400
        assert 'dataset_name' in body['error']

    @pytest.mark.usefixtures('feedback')
    def test_a_dataset_cannot_go_to_radar(self, api_gateway_event, lambda_context):
        status, body = _post(api_gateway_event, lambda_context,
                             {'csv_text': 'id,text\n1,a\n', 'dataset_name': DATASET, 'radar_brand': 'other-air'})
        assert status == 400
        assert body['error'] == 'dataset_name cannot be combined with radar_brand'


class TestIdentity:
    def test_an_edited_row_of_a_dataset_keeps_its_identity(self):
        before, _ = h._parse_csv_to_items('id,text\n1,teh app crashes\n', 'w', None, 'q3')
        after, _ = h._parse_csv_to_items('id,text\n1,the app crashes\n', 'w', None, 'q3')
        assert before[0]['id'] == after[0]['id'] == csv_row_id_v2('q3', '1')
        assert before[0]['content_hash'] != after[0]['content_hash']

    def test_the_same_id_in_two_datasets_does_not_collide(self):
        one, _ = h._parse_csv_to_items('id,text\n1,hello\n', 'w', None, 'q3')
        two, _ = h._parse_csv_to_items('id,text\n1,hello\n', 'w', None, 'q4')
        assert one[0]['id'] != two[0]['id']

    def test_a_row_without_an_id_keeps_the_v1_identity(self):
        with_dataset, _ = h._parse_csv_to_items('id,text\n,hello\n', 'w', None, 'q3')
        without, _ = h._parse_csv_to_items('id,text\n,hello\n', 'w')
        assert with_dataset[0]['id'] == without[0]['id']
        assert 'content_hash' not in with_dataset[0]

    def test_a_repeated_id_in_one_dataset_is_skipped_with_a_warning(self):
        items, warnings = h._parse_csv_to_items('id,text\n1,a\n1,b\n', 'w', None, 'q3')
        assert [i['text'] for i in items] == ['a']
        assert warnings == ['row 2: id "1" appears again in this dataset — skipped']

    def test_dimension_and_tag_columns_are_not_part_of_the_content_digest(self):
        one, _ = h._parse_csv_to_items('id,text,tags\n1,a,vip\n', 'w', None, 'q3')
        two, _ = h._parse_csv_to_items('id,text,tags\n1,a,other\n', 'w', None, 'q3')
        assert one[0]['content_hash'] == two[0]['content_hash']

    def test_the_v2_recipe_is_pinned(self):
        # A PERSISTED CONTRACT value (see csv-row-v1's CSV_BASIC_ROW1_ID): never recompute it.
        assert csv_row_id_v2('example air q3', '4711') == csv_row_id_v2(dataset_key(' Example  Air Q3 '), '4711')
        assert csv_row_id_v2('example air q3', '4711') == '9c77b9d45d211abc7e3d8acf25e7f503'


CSV = 'id,text,date\n1,unchanged row,2026-01-01\n2,corrected row,\n3,brand new row,2026-01-03\n,no id row,2026-01-04\n'


def _seed(table) -> None:
    hashes = _hash_of(CSV)
    _store(table, csv_row_id_v2('example air q3', '1'), hashes['1'])
    _store(table, csv_row_id_v2('example air q3', '2'), 'f' * 32, text='corected row',
           source_created_at='2025-12-31T00:00:00Z')


class TestPreview:
    def test_a_dry_run_counts_every_row_and_lists_the_changed_ones(self, api_gateway_event, lambda_context, feedback):
        table, sqs = feedback
        _seed(table)
        status, body = _post(api_gateway_event, lambda_context, {'csv_text': CSV, 'dataset_name': DATASET, 'dry_run': True})
        assert status == 200
        assert body['counts'] == {'new': 1, 'changed': 1, 'unchanged': 1, 'v1_rows': 1}
        assert body['changed_rows'] == [{'row': 2, 'csv_row_id': '2', 'before': 'corected row', 'after': 'corrected row'}]
        assert (body['dry_run'], body['total_rows'], body['changed_rows_truncated']) == (True, 4, False)
        sqs.send_message_batch.assert_not_called()

    @pytest.mark.usefixtures('feedback')
    def test_without_a_dataset_every_row_is_not_eligible_for_update(self, api_gateway_event, lambda_context):
        _, body = _post(api_gateway_event, lambda_context, {'csv_text': CSV, 'dry_run': True})
        assert body['counts'] == {'new': 0, 'changed': 0, 'unchanged': 0, 'v1_rows': 4}

    def test_the_changed_list_is_capped_and_says_so(self, api_gateway_event, lambda_context, feedback):
        table, _ = feedback
        rows = ''.join(f'{n},row {n}\n' for n in range(1, 53))
        for n in range(1, 53):
            _store(table, csv_row_id_v2('example air q3', str(n)), 'f' * 32)
        _, body = _post(api_gateway_event, lambda_context,
                        {'csv_text': 'id,text\n' + rows, 'dataset_name': DATASET, 'dry_run': True})
        assert body['counts']['changed'] == 52
        assert len(body['changed_rows']) == 50
        assert body['changed_rows_truncated'] is True


class TestConfirmedUpload:
    def test_changes_are_refused_until_confirmed(self, api_gateway_event, lambda_context, feedback):
        table, sqs = feedback
        _seed(table)
        status, body = _post(api_gateway_event, lambda_context, {'csv_text': CSV, 'dataset_name': DATASET})
        assert status == 409
        assert 'apply_updates' in body['error']
        sqs.send_message_batch.assert_not_called()

    def test_a_confirmed_upload_marks_updates_and_leaves_unchanged_rows_out(self, api_gateway_event, lambda_context, feedback):
        table, sqs = feedback
        _seed(table)
        status, body = _post(api_gateway_event, lambda_context,
                             {'csv_text': CSV, 'dataset_name': DATASET, 'apply_updates': True})
        sent = {m['text']: m for m in _sent(sqs)}
        assert status == 200
        assert body['counts'] == {'new': 1, 'changed': 1, 'unchanged': 1, 'v1_rows': 1}
        assert set(sent) == {'corrected row', 'brand new row', 'no id row'}
        assert sent['corrected row']['csv_replace'] is True
        # The corrected row had no date: it keeps the stored review date, not "now".
        assert sent['corrected row']['created_at'] == '2025-12-31T00:00:00Z'
        assert 'csv_replace' not in sent['brand new row']
        assert sent['brand new row']['csv_dataset'] == 'example air q3'
        assert 'csv_dataset' not in sent['no id row']

    def test_an_upload_without_a_dataset_is_unchanged(self, api_gateway_event, lambda_context, feedback):
        table, sqs = feedback
        _seed(table)
        status, body = _post(api_gateway_event, lambda_context, {'csv_text': CSV})
        assert status == 200
        assert 'counts' not in body
        assert all('csv_dataset' not in m and 'csv_replace' not in m for m in _sent(sqs))
        assert len(_sent(sqs)) == 4

    def test_unreadable_stored_rows_are_a_503_not_a_guess(self, api_gateway_event, lambda_context, feedback):
        table, sqs = feedback
        with patch.object(table.meta.client, 'batch_get_item',
                          return_value={'Responses': {}, 'UnprocessedKeys': {table.name: {'Keys': [{}]}}}), \
             patch('shared.csv_dataset_plan.time.sleep'):
            status, _ = _post(api_gateway_event, lambda_context, {'csv_text': CSV, 'dataset_name': DATASET})
        assert status == 503
        sqs.send_message_batch.assert_not_called()


def test_the_preview_reads_the_key_the_processor_writes():
    """Lockstep: shared.feedback_keys is the processor's own derivation (else every change reads as new)."""
    from processor.handler import generate_deterministic_id
    assert feedback_item_key('manual_import', 'abc')['sk'] == f"FEEDBACK#{generate_deterministic_id('manual_import', 'abc')}"
