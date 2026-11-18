"""voc-retention reaches a feedback form's test responses (form_tests.py, docs/source-policies.md).

A test link's tagged response is a row of its scope's test partition of voc-aggregates (the deployment's
``FEEDBACK_FORM_TEST``, a workspace's ``WS#{ws}#FEEDBACK_FORM_TEST``, beside its forms partition), never a feedback
item. The owner keeps it until an admin
or the form's creator deletes it, but the deployment's legal obligations still apply, in the scopes the same run
reaches feedback items in: the feedback_form source's retention window and an erasure by email (the deployment's and
every listed workspace's), an erasure by name and that source's whole-source erasure (the deployment's), and a job
that names one workspace (that workspace's only).
"""
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from jobs.retention import form_tests, handler, runs
from jobs.retention.test.conftest import days_ago, erasure_job, erasure_rows
from jobs.retention.test.test_export_erasure import _seed_exports
from jobs.retention.test.test_handler import _profiles
from jobs.retention.test.test_project_erasure import _list_workspace
from jobs.retention.test.test_workspace_erasure import WS, WS_TWO, _versions
from shared.digests import sha256_hex
from shared.ws_repo import WorkspaceScope

JOB_ID = 'er_0123456789ab'
BASIS = 'GDPR art. 17 request #123'
FORM_PK = 'FEEDBACK_FORM'
TEST_PK = 'FEEDBACK_FORM_TEST'
JANE = 'jane@example.com'
# The form's own rows are in its forms partition: the phase never reads it, and the worker may not delete there.
OTHER_FORM_ROWS = ('FORM#f1', 'FORMREV#f1#000001', 'FORMFUNNEL#f1#2026-11-01', 'FORMSESSION#f1#sess12345678',
                   'FORMDRAFT#sub#2026-11-01T10')


def _pk(ws: str | None, pk: str = TEST_PK) -> str:
    """The scope's test partition (``pk``: another of its partitions, the forms one)."""
    return pk if ws is None else f'WS#{ws}#{pk}'


def _row(aws, response_id: str, *, created: str | None = None, ws: str | None = None, **extra: Any) -> str:
    """One test response of form f1 (its sort key returned); ``created`` as ``YYYY-MM-DD``, yesterday by default."""
    created_at = f'{created or days_ago(1)}T10:00:00+00:00'
    sk = f'f1#{created_at}#{response_id}'
    aws['aggregates'].put_item(Item={'pk': _pk(ws), 'sk': sk, 'form_id': 'f1', 'response_id': response_id,
                                     'is_test': True, 'created_at': created_at, 'text': 'Typed by a tester',
                                     'answers': {'q_nps': 9}, **extra})
    return sk


def _other_rows(aws, ws: str | None = None) -> None:
    for sk in OTHER_FORM_ROWS:
        aws['aggregates'].put_item(Item={'pk': _pk(ws, FORM_PK), 'sk': sk, 'form_id': 'f1',
                                         'created_at': f'{days_ago(400)}T10:00:00+00:00', 'submitter_email': JANE})


def _left(aws, ws: str | None = None) -> set[str]:
    """The response ids of the scope's test rows still there."""
    rows = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(_pk(ws)))
    return {row['response_id'] for row in rows['Items']}


def _others_kept(aws, ws: str | None = None) -> bool:
    rows = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(_pk(ws, FORM_PK)))['Items']
    return set(OTHER_FORM_ROWS) <= {row['sk'] for row in rows}


def _tombstones(aws) -> dict[str, dict]:
    rows = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq('AUDIT#tombstone#feedback_form'))['Items']
    return {row['sk']: row for row in rows}


def _retention_audit(aws) -> dict:
    [row] = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(runs.AUDIT_PK))['Items']
    return row


def _job(aws, field: str, value: str, source: str | None = None) -> dict:
    return erasure_job(aws, JOB_ID, field, value, legal_basis=BASIS, source=source)


def _workspace_job(aws, field: str, value: str, ws: str = WS) -> dict:
    """A job that names ``ws``, in its own job partition, as the settings API writes it (shared/erasure_scope.py)."""
    aws['aggregates'].put_item(Item={'pk': f'WS#{ws}#JOB#erasure', 'sk': JOB_ID, 'job_id': JOB_ID, 'status': 'queued',
                                     'field': field, 'value_hash': sha256_hex(value), 'legal_basis': BASIS,
                                     'workspace_id': ws})
    return {'mode': 'erase', 'job_id': JOB_ID, 'value': value, 'workspace_id': ws}


def _jane_everywhere(aws) -> None:
    """Jane's test response in the deployment's test partition and in two listed workspaces'."""
    _list_workspace(aws, WS, 'Alpha')
    _list_workspace(aws, WS_TWO, 'Beta')
    for ws in (None, WS, WS_TWO):
        _other_rows(aws, ws)
        _row(aws, 'jane', ws=ws, submitter_email=JANE, submitter_name='Jane Doe')
        _row(aws, 'john', ws=ws, submitter_email='john@example.com', submitter_name='John')


class TestRetention:
    def test_the_feedback_form_window_deletes_the_test_responses_created_before_its_cutoff(self, aws, worker_context):
        _profiles(aws, {'id': 'feedback_form', 'retention_days': 30, 'retention_legal_basis': 'DPA, 30 days'})
        _other_rows(aws)
        _row(aws, 'old', created=days_ago(31))
        _row(aws, 'edge', created=days_ago(30))
        _row(aws, 'fresh', created=days_ago(1))
        aws['aggregates'].put_item(Item={'pk': TEST_PK, 'sk': 'f1#unreadable#odd', 'response_id': 'odd',
                                         'created_at': 'not a date'})
        result = handler.handle_event({'mode': 'retention'}, worker_context)
        assert (result['status'], result['form_test_responses_deleted']) == ('completed', 1)
        assert _left(aws) == {'edge', 'fresh', 'odd'}
        assert _others_kept(aws)
        audit = _retention_audit(aws)
        assert (audit['form_test_responses_deleted'], audit['deleted_items']) == (1, 0)
        assert _tombstones(aws)['test#old']['legal_basis'] == 'DPA, 30 days'

    def test_the_window_is_the_deployments_for_every_listed_workspace_too(self, aws, worker_context):
        """As for feedback items (shared/retention.py ``retention_filter``): a workspace sets no window of its own."""
        _profiles(aws, {'id': 'feedback_form', 'retention_days': 30, 'retention_legal_basis': 'DPA, 30 days'})
        _list_workspace(aws, WS, 'Alpha')
        _other_rows(aws, WS)
        _row(aws, 'old', created=days_ago(31), ws=WS)
        _row(aws, 'fresh', ws=WS)
        result = handler.handle_event({'mode': 'retention'}, worker_context)
        assert result['form_test_responses_deleted'] == 1
        assert (_left(aws, WS), _others_kept(aws, WS)) == ({'fresh'}, True)
        stone = _tombstones(aws)[f'{WS}#test#old']
        assert (stone['workspace_id'], stone['store'], stone['legal_basis']) == (WS, 'form_test', 'DPA, 30 days')

    @pytest.mark.parametrize('profiles', [[{'id': 'web', 'retention_days': 30}], [{'id': 'feedback_form'}]])
    def test_a_source_that_keeps_its_data_keeps_its_test_responses(self, aws, worker_context, profiles):
        _profiles(aws, *profiles)
        _row(aws, 'old', created=days_ago(400))
        with patch.object(form_tests, 'query_page', side_effect=AssertionError('the phase must not read')):
            result = handler.handle_event({'mode': 'retention'}, worker_context)
        assert result['status'] == 'completed'
        assert 'form_test_responses_deleted' not in result
        assert 'form_test_responses_deleted' not in _retention_audit(aws)
        assert _left(aws) == {'old'}


class TestErasure:
    def test_an_email_erasure_reaches_both_stored_shapes_ignoring_case(self, aws, worker_context):
        """The row keeps ``submitter_email`` lower-cased since the AI review's round 1; one written before has it only
        in its contact answer, as typed."""
        _other_rows(aws)
        _row(aws, 'top', submitter_email=JANE)
        _row(aws, 'answer', answers={'q_contact': {'email': ' Jane@Example.COM ', 'name': 'Jane'}, 'q_nps': 3})
        _row(aws, 'john', submitter_email='john@example.com', answers={'q_contact': {'email': 'john@example.com'}})
        _row(aws, 'choice', answers={'q_pick': {'code': JANE}, 'q_text': JANE})
        result = handler.handle_event(_job(aws, 'email', 'JANE@example.com'), worker_context)
        assert (result['status'], result['form_test_responses_deleted']) == ('completed', 2)
        assert _left(aws) == {'john', 'choice'}
        assert _others_kept(aws)
        job, audit = erasure_rows(aws, JOB_ID)
        assert (job['status'], job['form_test_responses_deleted'], job['deleted_items']) == ('completed', 2, 0)
        assert 'jane' not in str(audit).lower()

    def test_an_email_erasure_reaches_every_listed_workspace_and_clears_its_exports(self, aws, worker_context):
        """One address is one person (shared/retention.py ``reaches_workspaces``); an export holds the forms
        partition, so a workspace whose test response goes has its exports cleared too (exports.py)."""
        _jane_everywhere(aws)
        _seed_exports(aws, WS)
        result = handler.handle_event(_job(aws, 'email', JANE), worker_context)
        assert (result['status'], result['form_test_responses_deleted']) == ('completed', 3)
        assert [_left(aws, ws) for ws in (None, WS, WS_TWO)] == [{'john'}] * 3
        assert all(_others_kept(aws, ws) for ws in (None, WS, WS_TWO))
        assert set(_tombstones(aws)) == {'test#jane', f'{WS}#test#jane', f'{WS_TWO}#test#jane'}
        assert _versions(aws, f'ws/{WS}/exports/') == []

    def test_an_erasure_by_name_matches_the_contact_name_exactly_and_stays_the_deployments(self, aws, worker_context):
        """As for feedback items: a display name is not unique, so the deployment's erasure by name is its own."""
        _jane_everywhere(aws)
        _row(aws, 'answer', answers={'q_contact': {'name': 'Jane Doe', 'email': 'x@example.com'}})
        _row(aws, 'case', submitter_name='jane doe')
        result = handler.handle_event(_job(aws, 'author', 'Jane Doe'), worker_context)
        assert result['form_test_responses_deleted'] == 2
        assert _left(aws) == {'john', 'case'}
        assert _left(aws, WS) == _left(aws, WS_TWO) == {'jane', 'john'}

    def test_the_whole_source_erasure_of_feedback_form_deletes_the_deployments_test_responses(self, aws,
                                                                                             worker_context):
        _jane_everywhere(aws)
        _row(aws, 'b', created=days_ago(900))
        result = handler.handle_event(_job(aws, 'source', 'feedback_form', source='feedback_form'), worker_context)
        assert (result['status'], result['form_test_responses_deleted']) == ('completed', 3)
        assert _left(aws) == set()
        assert _others_kept(aws)
        assert _left(aws, WS) == {'jane', 'john'}

    @pytest.mark.parametrize(('field', 'value', 'source'), [
        ('email', JANE, 'web'),
        ('author', 'Jane', 'web'),
        ('source_id', 'r1', 'feedback_form'),
        ('csv_row_id', 'r1', 'feedback_form'),
        ('source', 'web', 'web'),
    ])
    def test_other_erasures_leave_the_test_responses_alone(self, aws, worker_context, field, value, source):
        _row(aws, 'r1', submitter_email=JANE, submitter_name='Jane')
        with patch.object(form_tests, 'query_page', side_effect=AssertionError('the phase must not run')):
            result = handler.handle_event(_job(aws, field, value, source), worker_context)
        assert result['status'] == 'completed'
        assert 'form_test_responses_deleted' not in result
        assert _left(aws) == {'r1'}

    def test_an_email_erasure_limited_to_feedback_form_reaches_them(self, aws, worker_context):
        _row(aws, 'r1', submitter_email=JANE)
        assert handler.handle_event(_job(aws, 'email', JANE, 'feedback_form'),
                                    worker_context)['form_test_responses_deleted'] == 1


class TestAJobThatNamesAWorkspace:
    @pytest.mark.parametrize(('field', 'value'), [('email', JANE), ('author', 'Jane Doe')])
    def test_it_reaches_that_workspaces_test_responses_only(self, aws, worker_context, field, value):
        _jane_everywhere(aws)
        result = handler.handle_event(_workspace_job(aws, field, value), worker_context)
        assert (result['status'], result['form_test_responses_deleted']) == ('completed', 1)
        assert (_left(aws), _left(aws, WS), _left(aws, WS_TWO)) == ({'jane', 'john'}, {'john'}, {'jane', 'john'})
        assert set(_tombstones(aws)) == {f'{WS}#test#jane'}
        job = aws['aggregates'].get_item(Key={'pk': f'WS#{WS}#JOB#erasure', 'sk': JOB_ID})['Item']
        assert (job['status'], job['form_test_responses_deleted']) == ('completed', 1)

    @pytest.mark.parametrize('cursor', [
        {'deployment': {}},
        {'ws': [WS_TWO], 'listing_done': True, 'at': {}},
        {'ws': [], 'listing': None, 'listing_done': False, 'at': {}},
    ])
    def test_its_cursor_never_reaches_the_deployment_or_another_workspace(self, aws, cursor):
        run = {'mode': 'erase', 'field': 'email', 'workspace_id': WS, 'run_id': 'r', 'legal_basis': BASIS}
        eraser = form_tests.FormTestEraser(run, {'aggregates': aws['aggregates']}, lambda _row: True)
        with pytest.raises(ValueError, match=r"^a one-workspace job carried (the deployment's test partition|another workspace)$"):
            eraser.step(cursor)


class TestTheRecord:
    def test_each_test_response_leaves_a_contentless_tombstone_before_its_delete(self, aws, worker_context):
        _row(aws, 'r1', submitter_email=JANE, page_url='https://example.com/jane')
        _row(aws, 'r2', submitter_email=JANE)
        order: list[str] = []
        real_tombstones, real_erase = form_tests.FormTestEraser.tombstones, form_tests.FormTestEraser.erase

        def tombstones(self, rows, scope=None):
            order.append(f'tombstones:{len(rows)}')
            real_tombstones(self, rows, scope)

        def erase(self, view, row):
            order.append(f'delete:{len(_tombstones(aws))}')
            real_erase(self, view, row)

        with patch.object(form_tests.FormTestEraser, 'tombstones', tombstones), \
                patch.object(form_tests.FormTestEraser, 'erase', erase):
            handler.handle_event(_job(aws, 'email', JANE), worker_context)
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

    def test_test_responses_never_start_a_lineage_pass(self, aws, worker_context):
        """A test response is never cited by a document or persona: deleting one alone marks nothing."""
        _row(aws, 'r1', submitter_email=JANE)
        with patch.object(handler, '_mark_lineage', side_effect=AssertionError('no lineage pass')), \
                patch.object(handler, '_mark_workspace_lineage', side_effect=AssertionError('no lineage pass')):
            result = handler.handle_event(_job(aws, 'email', JANE), worker_context)
        assert (result['form_test_responses_deleted'], result['artifacts_marked']) == (1, 0)

    def test_a_row_deleted_meanwhile_is_not_counted(self, aws, worker_context):
        """The form's own Delete all ran between the read and the delete: the run counts what it deleted."""
        sk = _row(aws, 'r1', submitter_email=JANE)
        _row(aws, 'r2', submitter_email=JANE)
        real_tombstones = form_tests.FormTestEraser.tombstones

        def then_deleted(self, rows, scope=None):
            real_tombstones(self, rows, scope)
            aws['aggregates'].delete_item(Key={'pk': TEST_PK, 'sk': sk})

        with patch.object(form_tests.FormTestEraser, 'tombstones', then_deleted):
            result = handler.handle_event(_job(aws, 'email', JANE), worker_context)
        assert result['form_test_responses_deleted'] == 1
        assert _left(aws) == set()

    def test_any_other_delete_failure_fails_the_run(self, aws, worker_context):
        _row(aws, 'r1', submitter_email=JANE)
        denied = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'DeleteItem')
        with patch.object(form_tests.FormTestEraser, 'erase', side_effect=denied):
            result = handler.handle_event(_job(aws, 'email', JANE), worker_context)
        assert result['status'] == 'failed'
        assert erasure_rows(aws, JOB_ID)[0]['error'] == 'Run failed (ClientError)'
        assert _left(aws) == {'r1'}

    def test_the_eraser_raises_a_refused_delete_and_counts_nothing(self):
        view = MagicMock()
        view.delete_item.side_effect = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}},
                                                   'DeleteItem')
        run: dict[str, Any] = {}
        eraser = form_tests.FormTestEraser(run, {'aggregates': MagicMock()}, lambda _row: True)
        with pytest.raises(ClientError):
            eraser.erase(view, {'pk': TEST_PK, 'sk': 'f1#t#r1'})
        assert run == {}
        assert view.delete_item.call_args.args == ({'pk': TEST_PK, 'sk': 'f1#t#r1'},)
        assert view.delete_item.call_args.kwargs == {'ConditionExpression': 'attribute_exists(pk)'}


class TestTheHandOver:
    def test_the_phase_hands_over_between_pages_with_its_cursor_and_its_count(self, aws, worker_context, invoke_mock):
        for n in range(3):
            _row(aws, f'r{n}', submitter_email=JANE)
        _list_workspace(aws, WS, 'Alpha')
        _row(aws, 'w0', ws=WS, submitter_email=JANE)
        event = _job(aws, 'email', JANE)
        # The first check of the clock is after the phase's first page: the time has run out there.
        worker_context.get_remaining_time_in_millis.return_value = 0
        with patch.object(form_tests, 'PAGE_SIZE', 1):
            assert handler.handle_event(event, worker_context)['status'] == 'continued'
            payload = invoke_mock.call_args.args[1]
            assert payload['phase'] == 'form_tests'
            assert payload['cursor']['deployment']['start']['pk'] == TEST_PK
            assert payload['run']['form_test_responses_deleted'] == 1
            assert erasure_rows_phase(aws) == 'form_tests'
            worker_context.get_remaining_time_in_millis.return_value = 900_000
            result = handler.handle_event(payload, worker_context)
        assert result['form_test_responses_deleted'] == 4
        assert _left(aws) == _left(aws, WS) == set()

    def test_a_hand_over_in_a_workspace_resumes_there(self, aws, worker_context, invoke_mock):
        _list_workspace(aws, WS, 'Alpha')
        for n in range(2):
            _row(aws, f'w{n}', ws=WS, submitter_email=JANE)
        event = _workspace_job(aws, 'email', JANE)
        worker_context.get_remaining_time_in_millis.return_value = 0
        with patch.object(form_tests, 'PAGE_SIZE', 1):
            handler.handle_event(event, worker_context)
            payload = invoke_mock.call_args.args[1]
            assert (payload['phase'], payload['cursor']['ws']) == ('form_tests', [WS])
            assert payload['cursor']['at']['start']['pk'] == f'WS#{WS}#{TEST_PK}'
            worker_context.get_remaining_time_in_millis.return_value = 900_000
            assert handler.handle_event(payload, worker_context)['form_test_responses_deleted'] == 2
        assert _left(aws, WS) == set()


def erasure_rows_phase(aws) -> str:
    """The running job row's phase (before the run ends: no audit row yet)."""
    return aws['aggregates'].get_item(Key={'pk': 'JOB#erasure', 'sk': JOB_ID})['Item']['phase']


class TestTheRead:
    def test_the_phase_queries_the_test_partitions_alone_never_a_forms_partition(self, aws, worker_context):
        """One key condition, the scope's test partition (no sort-key condition: it holds nothing else); never the
        forms partition (FEEDBACK_FORM, a workspace's WS#{ws}#FEEDBACK_FORM), never a scan."""
        _jane_everywhere(aws)
        read: list[str] = []
        real = form_tests.query_page

        def recorded(view: Any, partition: str, start: Any, **options: Any) -> Any:
            read.append(partition)
            assert set(options) == {'Limit'}
            return real(view, partition, start, **options)

        with patch.object(form_tests, 'query_page', recorded):
            result = handler.handle_event(_job(aws, 'email', JANE), worker_context)
        assert result['form_test_responses_deleted'] == 3
        assert read == [TEST_PK, f'WS#{WS}#{TEST_PK}', f'WS#{WS_TWO}#{TEST_PK}']
        assert all(_others_kept(aws, ws) for ws in (None, WS, WS_TWO))


class TestTheMatch:
    @pytest.mark.parametrize(('run', 'value'), [
        ({'mode': 'retention'}, ''),
        ({'mode': 'retention', 'cutoffs': 'not a map'}, ''),
        ({'mode': 'retention', 'cutoffs': {'web': '2026-01-01'}}, ''),
        ({'mode': 'erase', 'field': 'email', 'source': None}, ''),
        ({'mode': 'erase', 'field': None}, JANE),
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

    @pytest.mark.parametrize(('run', 'walks'), [
        ({'mode': 'retention'}, True), ({'mode': 'erase', 'field': 'email'}, True),
        ({'mode': 'erase', 'field': 'author'}, False), ({'mode': 'erase', 'field': 'source'}, False),
    ])
    def test_the_workspaces_are_walked_as_for_feedback_items(self, run, walks):
        assert form_tests.walks_workspaces(run) is walks

    def test_a_tombstone_falls_back_to_the_sort_keys_response_id_and_names_its_workspace(self):
        run = {'mode': 'erase', 'run_id': 'r', 'legal_basis': BASIS}
        stone = form_tests.tombstone(run, {'pk': TEST_PK, 'sk': 'f1#t#abc'}, 'NOW')
        assert (stone['sk'], stone['response_id'], 'form_id' in stone, 'workspace_id' in stone) == (
            'test#abc', 'abc', False, False)
        in_ws = form_tests.tombstone(run, {'pk': f'WS#{WS}#{TEST_PK}', 'sk': 'f1#t#abc'}, 'NOW',
                                     WorkspaceScope(WS))
        assert (in_ws['sk'], in_ws['workspace_id']) == (f'{WS}#test#abc', WS)


def test_the_counter_is_carried_only_once_it_counts() -> None:
    run = runs.new_run({'run': {'form_test_responses_deleted': 2, 'board_items_deidentified': 1}}, 'erase')
    assert runs.carried_state(run)['form_test_responses_deleted'] == 2
    assert runs.optional_counts(run) == {'board_items_deidentified': 1, 'form_test_responses_deleted': 2}
    assert runs.optional_counts(runs.new_run({}, 'erase')) == {}
