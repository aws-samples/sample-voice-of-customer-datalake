"""Properties of the erasure worker's hand-overs, locks and phase steps (lambda/jobs/retention/handler.py).

A hand-over that does not renew the run's locks lets a second erasure start under the first; a failed renewal or
release that fails the invocation loses the run's audit row; a step that loses its cursor, its phase or its value
re-reads, mislabels or matches the wrong rows; a count that leaves out a store skips the lineage pass that marks the
artifacts citing an erased item. Every client is a double, so the calls are checked as made.
"""
from __future__ import annotations

from datetime import UTC
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from hypothesis import given
from hypothesis import strategies as st

from jobs.retention import handler
from jobs.retention.boards import STORE_BOARDS
from jobs.retention.members import STORE_MEMBERS
from jobs.retention.runs import MODE_ERASE
from shared.retention import BOARD_COUNTER, WORKSPACE_ITEM_COUNTER
from shared.test.ws_properties import PROPERTY, exactly, workspace_ids
from shared.ws_repo import WorkspaceScope

FAULT = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': ''}}, 'UpdateItem')
JOB = 'er_0123456789ab'


def _walk(run: dict[str, Any], event: dict[str, Any] | None = None, **tables: Any) -> handler.Walk:
    return handler.Walk(tables={'aggregates': MagicMock(), **tables}, context=MagicMock(function_name='voc-retention'),
                        event=event or {}, run=run, filters=MagicMock(), s3=MagicMock())


# A workspace job's lock is renewed or released only for a run that has its job id and its workspace, with the
# workspace, the job and an aware UTC time; a whole-source job's source lock only for a whole-source run with its
# source. A failure of either is logged with the action and the error type only, and never fails the invocation.
@PROPERTY
@given(st.booleans(), st.one_of(st.none(), workspace_ids()), st.sampled_from(['source', 'email']),
       st.sampled_from(['', 'webscraper']), st.booleans(), st.sampled_from(['renew', 'release']))
def test_a_lock_call_names_its_own_lock_and_never_fails_the_run(has_job, ws, field, source, fails, action):
    run = {'field': field, 'source': source, **({'job_id': JOB} if has_job else {}),
           **({'workspace_id': ws} if ws else {})}
    for call, applies, args in (
            (handler._workspace_lock_call, has_job and ws is not None,
             lambda: (WorkspaceScope(ws) if ws else None, JOB)),
            (handler._whole_source_lock_call, has_job and field == 'source' and bool(source), lambda: (source, JOB))):
        operation = MagicMock(side_effect=FAULT if fails else None)
        table = MagicMock()
        with patch.object(handler, 'logger') as logger:
            call(table, run, operation, action)
        if not applies:
            assert not operation.called
            assert not logger.warning.called
            continue
        (given_table, first, job, at), _ = operation.call_args
        assert (given_table, first, job) == (table, *args())
        assert at.tzinfo is UTC
        if fails:
            lock = 'workspace erasure' if call is handler._workspace_lock_call else 'source erasure'
            logger.warning.assert_called_once_with(f'Could not update the {lock} lock',
                                                   extra={'action': action, 'error_type': 'ClientError'})
        else:
            assert not logger.warning.called


# A hand-over renews the run's source lock, its workspace lock and its pending exports' locks (each failure only
# logged, as "renew"), then re-invokes the worker with the event, the mode, the phase, the cursor and the carried run.
@PROPERTY
@given(workspace_ids(), st.sampled_from(['items', 'boards', 'exports']), st.one_of(st.none(), st.just({'pk': 'x'})),
       st.booleans())
def test_a_hand_over_renews_every_lock_and_carries_the_run(ws, phase, cursor, fails):
    run = {'job_id': JOB, 'field': 'source', 'source': 'webscraper', 'workspace_id': ws, 'mode': MODE_ERASE,
           'run_id': 'r1'}
    walk = _walk(run, {'job_id': JOB, 'value': 'v'})
    side = FAULT if fails else None
    with patch.object(handler, 'refresh_source_lock', side_effect=side) as source_lock, \
            patch.object(handler, 'refresh_workspace_lock', side_effect=side) as workspace_lock, \
            patch.object(handler.exports, 'renew', side_effect=side) as renew, \
            patch.object(handler, 'carried_state', return_value={'carried': True}), \
            patch.object(handler, 'invoke_lambda_async') as invoke, patch.object(handler, 'logger') as logger:
        assert handler._hand_over(walk, phase, cursor) == {'status': 'continued', 'run_id': 'r1'}
    assert source_lock.call_args.args[1:3] == ('webscraper', JOB)
    assert workspace_lock.call_args.args[1:3] == (WorkspaceScope(ws), JOB)
    renew.assert_called_once_with(run, walk.aggregates)
    invoke.assert_called_once_with('voc-retention', {'job_id': JOB, 'value': 'v', 'mode': MODE_ERASE, 'phase': phase,
                                                     'cursor': cursor, 'run': {'carried': True}})
    expected = [('Could not update the source erasure lock', {'action': 'renew', 'error_type': 'ClientError'}),
                ('Could not update the workspace erasure lock', {'action': 'renew', 'error_type': 'ClientError'}),
                ('Could not renew the workspace export locks', {'error_type': 'ClientError'})] if fails else []
    assert [(call.args[0], call.kwargs['extra']) for call in logger.warning.call_args_list] == expected


# A job's event sets the run's job id and workspace from the start only when both are well formed (``er_`` and 12
# hex; a workspace id); otherwise the run keeps neither.
@PROPERTY
@given(st.sampled_from([JOB, 'er_0123', 'er_0123456789AB', 'x', None, 7]),
       st.one_of(st.none(), workspace_ids(), st.sampled_from(['acme', ''])))
def test_a_workspace_job_is_named_only_by_a_well_formed_event(job_id, ws):
    event = {**({'job_id': job_id} if job_id is not None else {}), **({'workspace_id': ws} if ws is not None else {})}
    run: dict[str, Any] = {}
    handler._workspace_job(event, run)
    named = job_id == JOB and ws is not None and ws.startswith('ws_')
    assert run == ({'job_id': JOB, 'workspace_id': ws} if named else {})


# A whole-source erasure runs only for the one source it was invoked for, and that a source id.
@PROPERTY
@given(st.sampled_from(['webscraper', 'app_store']), st.sampled_from(['webscraper', 'other', '../x', 'a/b', '']))
def test_a_whole_source_erasure_names_the_source_it_runs_for(source, value):
    if source == value:
        handler._check_whole_source(source, value)
        return
    with pytest.raises(ValueError, match=exactly('The whole-source erasure does not name one valid source')):
        handler._check_whole_source(source, value)


# The retention run's skip of unscoped rows is logged by count and metered, nothing more.
@PROPERTY
@given(st.integers(min_value=1, max_value=4))
def test_a_skip_is_logged_by_count(skipped):
    run: dict[str, Any] = {}
    page = {'Items': [{'pk': 'WS#acme#SOURCE#x', 'sk': f'F#{n}'} for n in range(skipped)]}
    with patch.object(handler, 'metrics') as metrics, patch.object(handler, 'logger') as logger:
        handler._without_unscoped_rows(run, page)
    logger.warning.assert_called_once_with('Retention skipped rows whose WS# partition names no workspace',
                                           extra={'rows': skipped})
    metrics.add_metric.assert_called_once_with(name='RetentionUnscopedRowsSkipped', unit='Count', value=skipped)


# A matched page with no Items field holds no row of another workspace: a named job goes on (and the same page with
# a deployment row stops it).
@PROPERTY
@given(workspace_ids())
def test_an_empty_page_is_no_row_of_another_workspace(ws):
    handler._only_in_workspace(ws, {})
    handler._only_in_workspace(ws, {'Items': []})
    with pytest.raises(ValueError, match=exactly('A matched row is outside the named workspace')):
        handler._only_in_workspace(ws, {'Items': [{'pk': 'SOURCE#web', 'sk': 'FEEDBACK#1'}]})


# Each step hands its own phase, cursor and value on: the boards and members erase the event's value ('' when there
# is none) from the cursor given; lineage pages from its cursor; the exports step records its own phase.
@PROPERTY
@given(st.one_of(st.none(), st.just({'pk': 'p', 'sk': 's'})), st.one_of(st.none(), st.just('a@example.com')))
def test_each_step_hands_on_its_phase_cursor_and_value(cursor, value):
    event = {} if value is None else {'value': value}
    walk = _walk({'mode': MODE_ERASE}, event, **{STORE_BOARDS: MagicMock(), STORE_MEMBERS: MagicMock(),
                                                 'projects': MagicMock()})
    for step, module, phase in ((handler._erase_from_boards, handler.boards, 'boards'),
                                (handler._erase_from_members, handler.members, 'members')):
        with patch.object(handler, '_erase_pages', return_value=None) as pages, \
                patch.object(module, 'scan_page') as scan_page:
            step(walk, cursor)
            given_walk, given_phase, given_cursor, scan, _tombstones, _erase = pages.call_args.args
            assert (given_walk, given_phase, given_cursor) == (walk, phase, cursor)
            scan({'pk': 'next'})
            assert scan_page.call_args.args[1:] == (value or '', {'pk': 'next'})
    with patch.object(handler, '_walk', return_value=None) as walked, \
            patch.object(handler.lineage, 'scan_page') as scan_page, \
            patch.object(handler.lineage, 'mark_rows') as mark_rows:
        handler._mark_lineage(walk, cursor)
        given_walk, phase, given_cursor, scan, handle = walked.call_args.args
        assert (given_walk, phase, given_cursor) == (walk, 'lineage', cursor)
        scan({'pk': 'next'})
        assert scan_page.call_args.args[1] == {'pk': 'next'}
        assert handle({}, None) is None
        assert mark_rows.call_args.args[3] == []
    with patch.object(handler, 'RAW_DATA_BUCKET', 'raw-bucket'), \
            patch.object(handler.exports, 'clear', return_value=True), \
            patch.object(handler, 'record_progress') as progress:
        assert handler._erase_exports(walk, None) is None
    progress.assert_called_once_with(walk.aggregates, walk.run, 'exports')


# A raw sweep needs a source whose per-item archives it may sweep and a bucket to sweep them in: a run with no
# source, one naming a whole-upload folder (its files go only with a whole-source erasure of their own, listed for
# review otherwise), or a deployment with no raw bucket deletes nothing.
@PROPERTY
@given(st.sampled_from([None, '', 'csv_upload', 'json_upload', '..', 'a/b', 'webscraper']),
       st.sampled_from(['raw-bucket', '']))
def test_a_raw_sweep_without_a_sweepable_source_or_bucket_deletes_nothing(source, bucket):
    if source == 'webscraper' and bucket:
        return  # the one sweepable case: the worker's own suite sweeps it against moto
    walk = _walk({'source': source} if source is not None else {})
    with patch.object(handler, 'RAW_DATA_BUCKET', bucket), \
            patch.object(handler.retention, 'delete_raw_prefix_page') as delete:
        assert handler._sweep_raw(walk, None) is None
    assert not delete.called


# The lineage pass runs when the run deleted any item the deployment's artifacts may cite: a deployment item, a
# Radar item or a board request; a workspace's items alone never count.
@PROPERTY
@given(st.integers(min_value=0, max_value=3), st.integers(min_value=0, max_value=3),
       st.integers(min_value=0, max_value=3), st.one_of(st.none(), st.integers(min_value=0, max_value=3)))
def test_lineage_runs_when_a_citable_item_was_deleted(deployment, workspace, radar, boards):
    run = {'deleted_items': deployment + workspace, WORKSPACE_ITEM_COUNTER: workspace, 'deleted_radar_items': radar,
           **({BOARD_COUNTER: boards} if boards is not None else {})}
    assert handler._deleted_anything(run) is (deployment + radar + (boards or 0) > 0)
