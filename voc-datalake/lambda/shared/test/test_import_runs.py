"""Import history records (shared/import_runs.py, docs/import-history.md)."""
from datetime import UTC, datetime
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from shared import import_runs
from shared.import_runs import (
    ImportCounts,
    ImportRun,
    actor_from_event,
    get_import_run,
    list_import_runs,
    parse_limit,
    record_import_run,
    run_status,
)

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
RUN_ID = '0b1f3c4e-7a2d-4f6b-9c8e-1d2a3b4c5d6e'


def _run(**overrides) -> ImportRun:
    fields = {
        'method': 'csv', 'source': 'Example Air app store', 'actor': 'sub-1', 'actor_email': 'admin@example.com',
        'started_at': '2026-10-01T11:59:00+00:00', 'counts': ImportCounts(received=5, imported=3, skipped=1, duplicate=1),
        'warnings': ['row 2: empty text — skipped'], 'run_id': RUN_ID, 'raw_s3_key': 's3://raw/raw/csv_upload/x.csv',
    }
    return ImportRun(**{**fields, **overrides})


def _written(run: ImportRun) -> tuple[dict, dict]:
    table = MagicMock()
    assert record_import_run(table, run, now=NOW) == run.run_id
    detail, summary = (call.kwargs['Item'] for call in table.put_item.call_args_list)
    return summary, detail


class TestRecord:
    def test_a_run_is_listed_newest_first_under_one_partition_and_readable_by_id(self):
        summary, detail = _written(_run())
        assert (summary['pk'], summary['sk']) == ('IMPORT_RUN', f'2026-10-01T11:59:00+00:00#{RUN_ID}')
        assert (detail['pk'], detail['sk']) == (f'IMPORT_RUN#{RUN_ID}', 'RUN')

    def test_the_detail_row_is_written_before_the_summary(self):
        table = MagicMock()
        record_import_run(table, _run(), now=NOW)
        assert [c.kwargs['Item']['sk'] for c in table.put_item.call_args_list] == ['RUN', f'2026-10-01T11:59:00+00:00#{RUN_ID}']

    def test_both_rows_expire_after_90_days(self):
        summary, detail = _written(_run())
        assert summary['ttl'] == detail['ttl'] == int(NOW.timestamp()) + 90 * 24 * 3600

    def test_the_summary_carries_counts_but_not_the_message_lists(self):
        summary, detail = _written(_run(errors=['send failed']))
        assert {k: summary[k] for k in ('received', 'imported', 'skipped', 'duplicate', 'failed')} == {
            'received': 5, 'imported': 3, 'skipped': 1, 'duplicate': 1, 'failed': 0}
        assert 'warnings' not in summary
        assert 'errors' not in summary
        assert detail['warnings'] == ['row 2: empty text — skipped']
        assert detail['errors'] == ['send failed']
        assert (summary['warning_count'], summary['error_count']) == (1, 1)
        assert (summary['actor'], summary['actor_email']) == ('sub-1', 'admin@example.com')
        assert summary['finished_at'] == NOW.isoformat()

    def test_at_most_200_messages_are_kept_and_the_record_says_so(self):
        _, detail = _written(_run(warnings=[f'row {i}: note' for i in range(250)]))
        assert len(detail['warnings']) == 200
        assert detail['warnings'][-1] == 'row 199: note'
        assert detail['warning_count'] == 250
        assert detail['truncated'] is True

    def test_a_long_message_is_cut_to_300_characters(self):
        _, detail = _written(_run(errors=['x' * 1000]))
        assert len(detail['errors'][0]) == 300
        assert detail['errors'][0].endswith('…')
        assert detail['truncated'] is True

    def test_a_run_within_the_bounds_is_not_truncated(self):
        _, detail = _written(_run(warnings=['x' * 300] * 200))
        assert detail['truncated'] is False

    def test_a_failed_write_is_logged_not_raised(self):
        table = MagicMock()
        table.put_item.side_effect = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'PutItem')
        assert record_import_run(table, _run(), now=NOW) is None

    def test_no_table_writes_nothing(self):
        assert record_import_run(None, _run(), now=NOW) is None

    def test_an_unknown_method_is_not_recorded(self):
        table = MagicMock()
        assert record_import_run(table, _run(method='email'), now=NOW) is None
        table.put_item.assert_not_called()


class TestStatus:
    @pytest.mark.parametrize(('counts', 'status'), [
        (ImportCounts(received=3, imported=3), 'completed'),
        (ImportCounts(received=3, imported=2, skipped=1), 'completed'),
        (ImportCounts(received=3, imported=2, failed=1), 'partial'),
        (ImportCounts(received=3, imported=0, failed=3), 'failed'),
        (ImportCounts(received=0, imported=0), 'failed'),
    ])
    def test_status_follows_the_counts(self, counts, status):
        assert run_status(counts) == status


class TestActor:
    def test_the_caller_is_the_cognito_sub_and_email(self):
        event = {'requestContext': {'authorizer': {'claims': {'sub': 's-1', 'email': 'a@example.com'}}}}
        assert actor_from_event(event) == ('s-1', 'a@example.com')

    @pytest.mark.parametrize('event', [None, {}, {'requestContext': {}}, {'requestContext': {'authorizer': {'claims': 'x'}}}])
    def test_an_event_without_claims_is_unknown(self, event):
        assert actor_from_event(event) == ('unknown', '')


def _stored(sk_time: str, run_id: str, **extra) -> dict:
    return {'pk': 'IMPORT_RUN', 'sk': f'{sk_time}#{run_id}', 'run_id': run_id, 'method': 'json',
            'received': Decimal(2), 'imported': Decimal(2), 'status': 'completed', 'ttl': Decimal(4_000_000_000), **extra}


class TestList:
    def test_queries_newest_first_and_hands_back_a_cursor(self):
        table = MagicMock()
        table.query.return_value = {'Items': [_stored('2026-10-02', 'b')], 'LastEvaluatedKey': {'pk': 'IMPORT_RUN', 'sk': '2026-10-02#b'}}
        runs, cursor = list_import_runs(table, limit=1)
        assert table.query.call_args.kwargs['ScanIndexForward'] is False
        assert table.query.call_args.kwargs['Limit'] == 1
        assert runs[0]['counts'] == {'received': 2, 'imported': 2, 'skipped': 0, 'duplicate': 0, 'failed': 0}
        assert 'warnings' not in runs[0]
        table.query.return_value = {'Items': []}
        assert list_import_runs(table, limit=1, cursor=cursor) == ([], None)
        assert table.query.call_args.kwargs['ExclusiveStartKey'] == {'pk': 'IMPORT_RUN', 'sk': '2026-10-02#b'}

    def test_an_expired_row_dynamodb_has_not_deleted_yet_is_hidden(self):
        table = MagicMock()
        table.query.return_value = {'Items': [_stored('2026-01-01', 'a', ttl=Decimal(1))]}
        assert list_import_runs(table, limit=10) == ([], None)

    def test_a_cursor_from_another_listing_is_refused(self):
        from shared.feedback_cursor import encode_key_cursor
        with pytest.raises(ValueError, match='not valid'):
            list_import_runs(MagicMock(), limit=10, cursor=encode_key_cursor({'pk': 'OTHER', 'sk': 'x'}))

    @pytest.mark.parametrize(('raw', 'limit'), [(None, 25), ('', 25), ('5', 5), ('0', 1), ('500', 100)])
    def test_limit_is_bounded(self, raw, limit):
        assert parse_limit(raw) == limit

    def test_a_non_numeric_limit_is_refused(self):
        with pytest.raises(ValueError, match='invalid literal'):
            parse_limit('ten')


class TestGet:
    def test_reads_the_detail_row_with_its_messages(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {**_stored('t', RUN_ID), 'warnings': ['w'], 'errors': ['e', 7]}}
        run = get_import_run(table, RUN_ID)
        table.get_item.assert_called_once_with(Key={'pk': f'IMPORT_RUN#{RUN_ID}', 'sk': 'RUN'})
        assert run is not None
        assert (run['warnings'], run['errors']) == (['w'], ['e'])

    def test_an_id_that_is_not_a_uuid_is_not_read(self):
        table = MagicMock()
        assert get_import_run(table, 'IMPORT_RUN') is None
        table.get_item.assert_not_called()

    def test_a_missing_run_is_none(self):
        table = MagicMock()
        table.get_item.return_value = {}
        assert get_import_run(table, RUN_ID) is None


def test_the_written_record_reads_back_as_written():
    summary, detail = _written(_run())
    view = import_runs.run_view(detail, detail=True)
    assert view['status'] == 'completed'
    assert view['raw_s3_key'] == 's3://raw/raw/csv_upload/x.csv'
    assert view['warnings'] == ['row 2: empty text — skipped']
    assert import_runs.run_view(summary)['run_id'] == RUN_ID
