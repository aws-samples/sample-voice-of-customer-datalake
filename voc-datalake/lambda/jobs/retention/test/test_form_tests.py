"""voc-retention reaches a feedback form's test responses (form_tests.py, docs/source-policies.md).

A test link's tagged response is a row of voc-aggregates in the test responses' own partition (FEEDBACK_FORM_TEST),
never a feedback item, and never a row of the forms partition (FEEDBACK_FORM) the worker cannot delete in. The owner
keeps it until an admin or the form's creator deletes it, but the deployment's legal obligations still apply: the
feedback_form source's retention window, an erasure by email or name, and that source's whole-source erasure.
"""
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from jobs.retention import form_tests, handler, runs
from jobs.retention.test.conftest import (
    audit_row,
    days_ago,
    erasure_job_row,
    hand_over_mid_page,
    queue_erasure_job,
    save_source_profiles,
)
from shared import form_test_responses as test_rows

JOB_ID = 'er_0123456789ab'
BASIS = 'GDPR art. 17 request #123'
TEST_PK = test_rows.TEST_RESPONSES_PK
FORM_PK = 'FEEDBACK_FORM'
# The forms partition: a form, its revision, funnel and draft-counter rows, and a test response where voc-multiplayer
# 7.55.00 kept them (a FORMTEST# row there). The worker never reads or deletes any of them.
OTHER_FORM_ROWS = ('FORM#f1', 'FORMREV#f1#000001', 'FORMFUNNEL#f1#2026-11-01', 'FORMLEFT#f1#sess12345678',
                   'FORMDRAFT#sub#2026-11-01T10', 'FORMTEST#f1#2026-01-01T10:00:00+00:00#legacy')


def _row(aws, response_id: str, *, created: str | None = None, **extra: Any) -> str:
    """One test response of form f1 (its sort key returned); ``created`` as ``YYYY-MM-DD``, yesterday by default."""
    created_at = f'{created or days_ago(1)}T10:00:00+00:00'
    key = test_rows.test_response_key('f1', created_at, response_id)
    aws['aggregates'].put_item(Item={**key, 'form_id': 'f1', 'response_id': response_id, 'is_test': True,
                                     'created_at': created_at, 'text': 'Typed by a tester', 'answers': {'q_nps': 9},
                                     **extra})
    return key['sk']


def _other_rows(aws) -> None:
    for sk in OTHER_FORM_ROWS:
        aws['aggregates'].put_item(Item={'pk': FORM_PK, 'sk': sk, 'form_id': 'f1', 'response_id': 'legacy',
                                         'is_test': True, 'created_at': f'{days_ago(400)}T10:00:00+00:00',
                                         'submitter_email': 'jane@example.com', 'submitter_name': 'Jane Doe'})


def _left(aws) -> set[str]:
    """The response ids of the test rows still there."""
    rows = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(TEST_PK))
    return {row['response_id'] for row in rows['Items']}


def _others_kept(aws) -> bool:
    rows = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(FORM_PK))['Items']
    return {row['sk'] for row in rows} == set(OTHER_FORM_ROWS)


def _tombstones(aws) -> dict[str, dict]:
    rows = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq('AUDIT#tombstone#feedback_form'))['Items']
    return {row['sk']: row for row in rows}


def _job(aws, field: str, value: str, source: str | None = None) -> dict:
    return queue_erasure_job(aws, JOB_ID, field, value, source, legal_basis=BASIS)


class TestRetention:
    def test_the_feedback_form_window_deletes_the_test_responses_created_before_its_cutoff(self, aws, worker_context):
        save_source_profiles(aws, {'id': 'feedback_form', 'retention_days': 30, 'retention_legal_basis': 'DPA, 30 days'})
        _other_rows(aws)
        _row(aws, 'old', created=days_ago(31))
        _row(aws, 'edge', created=days_ago(30))
        _row(aws, 'fresh', created=days_ago(1))
        aws['aggregates'].put_item(Item={**test_rows.test_response_key('f1', 'unreadable', 'odd'),
                                         'response_id': 'odd', 'created_at': 'not a date'})
        result = handler.handle_event({'mode': 'retention'}, worker_context)
        assert (result['status'], result['form_test_responses_deleted']) == ('completed', 1)
        assert _left(aws) == {'edge', 'fresh', 'odd'}
        assert _others_kept(aws)
        audit = audit_row(aws)
        assert (audit['form_test_responses_deleted'], audit['deleted_items']) == (1, 0)
        assert _tombstones(aws)['test#old']['legal_basis'] == 'DPA, 30 days'

    @pytest.mark.parametrize('profiles', [[{'id': 'web', 'retention_days': 30}], [{'id': 'feedback_form'}]])
    def test_a_source_that_keeps_its_data_keeps_its_test_responses(self, aws, worker_context, profiles):
        save_source_profiles(aws, *profiles)
        _row(aws, 'old', created=days_ago(400))
        result = handler.handle_event({'mode': 'retention'}, worker_context)
        assert result['status'] == 'completed'
        assert 'form_test_responses_deleted' not in result
        assert 'form_test_responses_deleted' not in audit_row(aws)
        assert _left(aws) == {'old'}


class TestErasure:
    def test_an_email_erasure_reaches_both_stored_shapes_ignoring_case(self, aws, worker_context):
        """From 7.04.00 the row keeps ``submitter_email`` lower-cased; a 7.55 row has it only in its contact
        answer, as typed."""
        _other_rows(aws)
        _row(aws, 'top', submitter_email='jane@example.com')
        _row(aws, 'answer', answers={'q_contact': {'email': ' Jane@Example.COM ', 'name': 'Jane'}, 'q_nps': 3})
        _row(aws, 'john', submitter_email='john@example.com', answers={'q_contact': {'email': 'john@example.com'}})
        _row(aws, 'choice', answers={'q_pick': {'code': 'jane@example.com'}, 'q_text': 'jane@example.com'})
        result = handler.handle_event(_job(aws, 'email', 'JANE@example.com'), worker_context)
        assert (result['status'], result['form_test_responses_deleted']) == ('completed', 2)
        assert _left(aws) == {'john', 'choice'}
        assert _others_kept(aws)
        job = erasure_job_row(aws, JOB_ID)
        assert (job['status'], job['form_test_responses_deleted'], job['deleted_items']) == ('completed', 2, 0)
        assert 'jane' not in str(audit_row(aws)).lower()

    def test_an_erasure_by_name_matches_the_contact_name_exactly(self, aws, worker_context):
        _row(aws, 'top', submitter_name='Jane Doe')
        _row(aws, 'answer', answers={'q_contact': {'name': 'Jane Doe', 'email': 'x@example.com'}})
        _row(aws, 'case', submitter_name='jane doe')
        result = handler.handle_event(_job(aws, 'author', 'Jane Doe'), worker_context)
        assert result['form_test_responses_deleted'] == 2
        assert _left(aws) == {'case'}

    def test_the_whole_source_erasure_of_feedback_form_deletes_every_test_response(self, aws, worker_context):
        _other_rows(aws)
        _row(aws, 'a')
        _row(aws, 'b', created=days_ago(900))
        result = handler.handle_event(_job(aws, 'source', 'feedback_form', source='feedback_form'), worker_context)
        assert (result['status'], result['form_test_responses_deleted']) == ('completed', 2)
        assert _left(aws) == set()
        assert _others_kept(aws)

    @pytest.mark.parametrize(('field', 'value', 'source'), [
        ('email', 'jane@example.com', 'web'),
        ('author', 'Jane', 'web'),
        ('source_id', 'r1', 'feedback_form'),
        ('csv_row_id', 'r1', 'feedback_form'),
        ('source', 'web', 'web'),
    ])
    def test_other_erasures_leave_the_test_responses_alone(self, aws, worker_context, field, value, source):
        _row(aws, 'r1', submitter_email='jane@example.com', submitter_name='Jane')
        with patch.object(form_tests, 'query_page', side_effect=AssertionError('the phase must not run')):
            result = handler.handle_event(_job(aws, field, value, source), worker_context)
        assert result['status'] == 'completed'
        assert 'form_test_responses_deleted' not in result
        assert _left(aws) == {'r1'}

    def test_an_email_erasure_limited_to_feedback_form_reaches_them(self, aws, worker_context):
        _row(aws, 'r1', submitter_email='jane@example.com')
        assert handler.handle_event(_job(aws, 'email', 'jane@example.com', 'feedback_form'),
                                    worker_context)['form_test_responses_deleted'] == 1


class TestTheRecord:
    def test_each_test_response_leaves_a_contentless_tombstone_before_its_delete(self, aws, worker_context):
        _row(aws, 'r1', submitter_email='jane@example.com', page_url='https://example.com/jane')
        _row(aws, 'r2', submitter_email='jane@example.com')
        order: list[str] = []
        real_tombstones, real_erase = form_tests.FormTestEraser.tombstones, form_tests.FormTestEraser.erase
        with patch.object(form_tests.FormTestEraser, 'tombstones',
                          lambda self, rows: (order.append(f'tombstones:{len(rows)}'), real_tombstones(self, rows))), \
                patch.object(form_tests.FormTestEraser, 'erase',
                             lambda self, row: (order.append(f"delete:{len(_tombstones(aws))}"), real_erase(self, row))):
            handler.handle_event(_job(aws, 'email', 'jane@example.com'), worker_context)
        assert order == ['tombstones:2', 'delete:2', 'delete:2']
        stones = _tombstones(aws)
        assert set(stones) == {'test#r1', 'test#r2'}
        stone = stones['test#r1']
        assert (stone['source'], stone['store'], stone['mode'], stone['job_id'], stone['legal_basis']) == (
            'feedback_form', 'form_test', 'erase', JOB_ID, BASIS)
        assert (stone['form_id'], stone['response_id']) == ('f1', 'r1')
        assert 'ttl' not in stone
        assert 'jane' not in str(stones).lower()
        assert 'Typed' not in str(stones)

    def test_test_responses_never_start_the_lineage_pass(self, aws, worker_context):
        """A test response is never cited by a document or persona: deleting one alone marks nothing."""
        aws['projects'].put_item(Item={'pk': 'PROJECT#p', 'sk': 'PRD#a', 'input_feedback_ids': ['r1']})
        _row(aws, 'r1', submitter_email='jane@example.com')
        with patch.object(handler, '_mark_lineage', side_effect=AssertionError('no lineage pass')):
            result = handler.handle_event(_job(aws, 'email', 'jane@example.com'), worker_context)
        assert (result['form_test_responses_deleted'], result['artifacts_marked']) == (1, 0)
        assert 'erased_evidence' not in aws['projects'].get_item(Key={'pk': 'PROJECT#p', 'sk': 'PRD#a'})['Item']

    def test_a_row_deleted_meanwhile_is_not_counted(self, aws, worker_context):
        """The form's own Delete all ran between the read and the delete: the run counts what it deleted."""
        sk = _row(aws, 'r1', submitter_email='jane@example.com')
        _row(aws, 'r2', submitter_email='jane@example.com')
        real_tombstones = form_tests.FormTestEraser.tombstones

        def then_deleted(self, rows):
            real_tombstones(self, rows)
            aws['aggregates'].delete_item(Key={'pk': TEST_PK, 'sk': sk})

        with patch.object(form_tests.FormTestEraser, 'tombstones', then_deleted):
            result = handler.handle_event(_job(aws, 'email', 'jane@example.com'), worker_context)
        assert result['form_test_responses_deleted'] == 1
        assert _left(aws) == set()

    def test_any_other_delete_failure_fails_the_run(self, aws, worker_context):
        _row(aws, 'r1', submitter_email='jane@example.com')
        denied = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'DeleteItem')
        with patch.object(form_tests.FormTestEraser, 'erase', side_effect=denied):
            result = handler.handle_event(_job(aws, 'email', 'jane@example.com'), worker_context)
        assert result['status'] == 'failed'
        assert erasure_job_row(aws, JOB_ID)['error'] == 'Run failed (ClientError)'
        assert _left(aws) == {'r1'}

    def test_the_eraser_raises_a_refused_delete_and_counts_nothing(self):
        table = MagicMock()
        table.delete_item.side_effect = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}},
                                                    'DeleteItem')
        run: dict[str, Any] = {}
        eraser = form_tests.FormTestEraser(run, table, lambda _row: True)
        with pytest.raises(ClientError):
            eraser.erase({'pk': TEST_PK, 'sk': 'f1#t#r1'})
        assert run == {}
        assert table.delete_item.call_args.kwargs == {'Key': {'pk': TEST_PK, 'sk': 'f1#t#r1'},
                                                      'ConditionExpression': 'attribute_exists(pk)'}


class TestTheHandOver:
    def test_the_phase_hands_over_with_its_cursor_and_its_count(self, aws, worker_context, invoke_mock):
        for n in range(3):
            _row(aws, f'r{n}', submitter_email='jane@example.com')
        event = _job(aws, 'email', 'jane@example.com')
        budget = iter([900_000] * 3)
        worker_context.get_remaining_time_in_millis.side_effect = lambda: next(budget, 0)
        with patch.object(form_tests, 'PAGE_SIZE', 1):
            assert handler.handle_event(event, worker_context)['status'] == 'continued'
            payload = invoke_mock.call_args.args[1]
            assert payload['phase'] == 'form_tests'
            assert payload['cursor']['pk'] == TEST_PK
            assert payload['run']['form_test_responses_deleted'] >= 1
            assert erasure_job_row(aws, JOB_ID)['phase'] == 'form_tests'
            worker_context.get_remaining_time_in_millis.side_effect = None
            result = handler.handle_event(payload, worker_context)
        assert result['form_test_responses_deleted'] == 3
        assert _left(aws) == set()
        assert audit_row(aws)['form_test_responses_deleted'] == 3

    def test_a_page_left_half_done_resumes_after_the_last_deleted_row(self, aws, worker_context, invoke_mock):
        for n in range(3):
            _row(aws, f'r{n}', submitter_email='jane@example.com')
        event = _job(aws, 'email', 'jane@example.com')
        # One page of three: the first row is deleted, and the time runs out before the second.
        payload = hand_over_mid_page(event, worker_context, invoke_mock)
        assert (payload['phase'], payload['run']['form_test_responses_deleted']) == ('form_tests', 1)
        # The cursor is the deleted row's key: the next generation reads on from there.
        assert payload['cursor'] == test_rows.test_response_key('f1', f'{days_ago(1)}T10:00:00+00:00', 'r0')
        assert _left(aws) == {'r1', 'r2'}
        worker_context.get_remaining_time_in_millis.side_effect = None
        assert handler.handle_event(payload, worker_context)['form_test_responses_deleted'] == 3
        # Every row's tombstone exactly once (a resumed page rewrites the same keys, never a second record).
        assert set(_tombstones(aws)) == {'test#r0', 'test#r1', 'test#r2'}


class TestTheRead:
    def test_the_phase_queries_the_test_responses_partition_alone(self):
        """One key condition, the partition: never the forms partition (FEEDBACK_FORM), never a scan."""
        table = MagicMock()
        form_tests.query_page(table, None)
        form_tests.query_page(table, {'pk': TEST_PK, 'sk': 'f1#t#r1'})
        first, resumed = (call.kwargs for call in table.query.call_args_list)
        assert first == {'KeyConditionExpression': Key('pk').eq(TEST_PK), 'Limit': form_tests.PAGE_SIZE}
        assert resumed['ExclusiveStartKey'] == {'pk': TEST_PK, 'sk': 'f1#t#r1'}
        table.scan.assert_not_called()

    @pytest.mark.parametrize(('field', 'value', 'source'), [
        ('email', 'jane@example.com', None), ('author', 'Jane Doe', None),
        ('source', 'feedback_form', 'feedback_form')])
    def test_a_run_that_matches_them_leaves_the_forms_partition_whole(self, aws, worker_context, field, value,
                                                                       source):
        """Every forms-partition row holds the person (a 7.55 test response there too): none is read, tombstoned
        or deleted."""
        _other_rows(aws)
        _row(aws, 'r1', submitter_email='jane@example.com', submitter_name='Jane Doe')
        result = handler.handle_event(_job(aws, field, value, source), worker_context)
        assert (result['status'], result['form_test_responses_deleted']) == ('completed', 1)
        assert _others_kept(aws)
        assert set(_tombstones(aws)) == {'test#r1'}


class TestTheMatch:
    @pytest.mark.parametrize(('run', 'value'), [
        ({'mode': 'retention'}, ''),
        ({'mode': 'retention', 'cutoffs': 'not a map'}, ''),
        ({'mode': 'retention', 'cutoffs': {'web': '2026-01-01'}}, ''),
        ({'mode': 'erase', 'field': 'email', 'source': None}, ''),
        ({'mode': 'erase', 'field': None}, 'jane@example.com'),
        ({'mode': 'erase', 'field': 'source', 'source': 'web'}, 'web'),
    ])
    def test_a_run_that_reaches_none_has_no_matcher(self, run, value):
        assert form_tests.row_matcher(run, value) is None

    def test_a_retention_cutoff_compares_the_created_day(self):
        matches = form_tests.row_matcher({'mode': 'retention', 'cutoffs': {'feedback_form': '2026-03-01'}}, '')
        assert matches is not None
        assert [matches({'created_at': value}) for value in (
            '2026-02-28T23:59:59+00:00', '2026-03-01T00:00:00+00:00', None, '2026', 20260101)] == [
            True, False, False, False, False]

    def test_a_tombstone_falls_back_to_the_sort_keys_response_id(self):
        run = {'mode': 'erase', 'run_id': 'r', 'legal_basis': BASIS}
        stone = form_tests.tombstone(run, {'pk': TEST_PK, 'sk': 'f1#t#abc'}, 'NOW')
        assert (stone['sk'], stone['response_id'], 'form_id' in stone) == ('test#abc', 'abc', False)


def test_the_counter_is_carried_only_once_it_counts() -> None:
    run = runs.new_run({'run': {'form_test_responses_deleted': 2, 'board_items_deidentified': 1}}, 'erase')
    assert runs.carried_state(run)['form_test_responses_deleted'] == 2
    assert runs.optional_counts(run) == {'board_items_deidentified': 1, 'form_test_responses_deleted': 2}
    assert runs.optional_counts(runs.new_run({}, 'erase')) == {}
