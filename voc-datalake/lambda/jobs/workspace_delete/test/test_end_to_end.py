"""voc-workspace-delete end to end on moto: deleting one workspace removes every row, object and parameter of it but
the kept ones, and leaves another workspace and every deployment-wide row exactly as they were; across hand-overs,
a failure and its resume, the verify pass, the fence and a cancel."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from unittest.mock import patch

import pytest
import time_machine
from botocore.exceptions import ClientError

from jobs.workspace_delete import handler, sweeps
from jobs.workspace_delete.test.conftest import (
    BUCKET,
    COMPANY_MEMORIES,
    FEEDBACK_ITEMS,
    OTHER,
    PERSONAL_MEMORIES,
    PREFIX,
    THIRD,
    WS,
    Budget,
    World,
    now,
    request_job,
    run_to_the_end,
    seed_deployment,
    seed_workspace,
    snapshot,
)
from shared import workspace_deletes
from shared.exceptions import ConflictError
from shared.ingest_tables import ingest_table

MEMORIES = len(COMPANY_MEMORIES) + len(PERSONAL_MEMORIES)


def _seed(world: World) -> dict[str, Any]:
    seed_workspace(world, WS, status='deleting')
    seed_workspace(world, OTHER, status='active')
    seed_deployment(world)
    return request_job(world)


def _job(world: World, ws: str = WS) -> dict[str, Any]:
    return world.workspaces.get_item(Key={'pk': 'WSDELETE', 'sk': ws})['Item']


#: The job's maxEventAge (lib/stacks/workspace-delete-worker.ts WORKSPACE_DELETE_MAX_EVENT_AGE_MINUTES): an event
#: throttled longer is dropped.
MAX_EVENT_AGE = timedelta(minutes=40)


def _is_kept(table: str, item: dict[str, Any]) -> bool:
    """A row of the deleted workspace the delete keeps, or one it writes."""
    pk, sk = str(item.get('pk', '')), str(item.get('sk', ''))
    if table == 'aggregates' and pk.startswith('AUDIT#tombstone#') and sk.startswith(f'{WS}#'):
        return True
    return table == 'workspaces' and (pk in (f'AUDIT#WS#{WS}', 'AUDIT#workspace-deletes', 'SLUG#acme')
                                      or (pk, sk) == ('WSDELETE', WS))


def _of_the_deleted(table: str, item: Any) -> bool:
    """A row, object or parameter of the deleted workspace (what must be gone, or kept)."""
    if table == 'objects':
        return item[0].startswith(f'ws/{WS}/')
    if table == 'uploads':
        return item.startswith(f'ws/{WS}/')
    if table == 'parameters':
        return item.startswith(f'{PREFIX}/{WS}/')
    key = str(item.get('source') if table == 'watermarks' else item.get('pk', ''))
    sk = str(item.get('sk', ''))
    return (key.startswith(f'WS#{WS}') or sk == f'WS#{WS}' or item.get('workspace_id') == WS
            or _is_kept(table, item))


class TestDeletingAWorkspace:
    def test_leaves_another_workspace_and_every_deployment_row_exactly_as_they_were(self, world):
        event = _seed(world)
        before = snapshot(world)

        outcomes = run_to_the_end(world, event)

        assert outcomes[-1] == {'status': 'completed', 'workspace_id': WS}
        after = snapshot(world)
        for table, rows in before.items():
            untouched = [row for row in rows if not _of_the_deleted(table, row)]
            assert [row for row in after[table] if not _of_the_deleted(table, row)] == untouched, table

    def test_removes_every_row_object_and_parameter_of_it_but_the_kept_ones(self, world):
        run_to_the_end(world, _seed(world))

        after = snapshot(world)
        left = {table: [row for row in rows if _of_the_deleted(table, row) and not (
            table not in ('objects', 'uploads', 'parameters') and _is_kept(table, row))]
            for table, rows in after.items()}
        assert left == {table: [] for table in after}

    def test_keeps_the_audit_trail_the_tombstones_the_job_and_the_slug(self, world):
        run_to_the_end(world, _seed(world))

        audit = world.workspaces.query(KeyConditionExpression='pk = :pk',
                                       ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})['Items']
        assert [row['kind'] for row in audit] == ['workspace_created']
        slug = world.workspaces.get_item(Key={'pk': 'SLUG#acme', 'sk': 'META'})['Item']
        assert (slug['workspace_id'], 'deleted_at' in slug) == (WS, True)
        job = _job(world)
        assert (job['status'], job['phase']) == ('completed', 'complete')
        tombstones = [row for row in snapshot(world)['aggregates']
                      if str(row['pk']).startswith('AUDIT#tombstone#') and str(row['sk']).startswith(f'{WS}#')]
        assert len([row for row in tombstones if row['store'] == 'feedback']) == FEEDBACK_ITEMS
        assert len([row for row in tombstones if row['store'] == 'memory']) == MEMORIES

    def test_the_tombstones_hold_no_content_only_the_job_the_basis_and_the_time(self, world):
        run_to_the_end(world, _seed(world))

        stone = world.aggregates.get_item(Key={'pk': 'AUDIT#tombstone#webscraper', 'sk': f'{WS}#fb-1'})['Item']
        assert set(stone) == {'pk', 'sk', 'workspace_id', 'store', 'mode', 'run_id', 'legal_basis', 'deleted_at',
                              'source', 'feedback_id'}
        assert (stone['mode'], stone['legal_basis'], stone['workspace_id']) == (
            'workspace_delete', 'Customer contract ended (ticket 4512)', WS)
        memory = world.aggregates.get_item(Key={'pk': 'AUDIT#tombstone#memory', 'sk': f'{WS}#mem_p1'})['Item']
        assert 'statement' not in memory
        assert memory['scope'] == 'personal'

    def test_no_tombstone_audit_row_or_job_row_holds_a_member_a_session_or_content(self, world):
        """Counts and item ids only: a member's sub (but the requester's, decision 17's "who"), a personal memory's
        partition, a session id or a row's text never reaches what the delete keeps."""
        run_to_the_end(world, _seed(world))

        kept = [row for row in snapshot(world)['aggregates'] if str(row['pk']).startswith('AUDIT#tombstone#')
                and str(row['sk']).startswith(f'{WS}#')]
        kept += [row for row in snapshot(world)['workspaces']
                 if row['pk'] in ('AUDIT#workspace-deletes', 'WSDELETE')]
        text = str(kept)
        for forbidden in ('sub-vic', 'MEM#user', 'SESSION#', 's1', 'parcel arrived', 'Parcels matter', 'k-secret',
                          'ada@example.com', 'MEMSTATUS'):
            assert forbidden not in text, forbidden
        memory = [row for row in kept if row.get('store') == 'memory']
        assert sorted(row['sk'] for row in memory) == sorted(
            f'{WS}#{memory_id}' for memory_id in (*COMPANY_MEMORIES, *(m for _o, m, _s in PERSONAL_MEMORIES)))
        assert {row['pk'] for row in memory} == {'AUDIT#tombstone#memory'}

    def test_the_completed_audit_row_counts_and_names_what_stays(self, world):
        run_to_the_end(world, _seed(world))

        [completed] = [row for row in world.workspaces.query(
            KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': 'AUDIT#workspace-deletes'})['Items']
            if row['kind'] == 'completed']
        assert (completed['workspace_id'], completed['slug'], completed['actor']) == (WS, 'acme', 'sub-ada')
        counts = completed['counts']
        assert counts['feedback'] == FEEDBACK_ITEMS
        assert counts['tombstones_written'] == FEEDBACK_ITEMS + MEMORIES
        assert counts['credentials'] == 2
        assert counts['objects'] >= 7
        assert set(completed['kept']) == set(handler.KEPT)
        assert 'original_text' not in str(completed)


class TestTombstonesComeFirst:
    def test_every_item_and_memory_has_its_tombstone_before_its_delete(self, world):
        event = _seed(world)
        aggregates = world.aggregates
        seen: list[str] = []
        real = sweeps._remove

        def checked(table_view, keys):
            for key in keys:
                pk = str(key.get('pk', ''))
                if pk.startswith(f'WS#{WS}#SOURCE#'):
                    stone = aggregates.get_item(Key={'pk': f'AUDIT#tombstone#{_source_of(world, key)}',
                                                     'sk': f'{WS}#{str(key["sk"]).removeprefix("FEEDBACK#")}'})
                    assert 'Item' in stone, f'deleted before its tombstone: {key}'
                    seen.append(pk)
                if pk.startswith((f'WS#{WS}#MEM#company', f'WS#{WS}#MEM#user#')):
                    memory_id = str(key['sk']).removeprefix('MEM#')
                    assert 'Item' in aggregates.get_item(Key={'pk': 'AUDIT#tombstone#memory', 'sk': f'{WS}#{memory_id}'})
                    seen.append(pk)
            return real(table_view, keys)

        with patch.object(sweeps, '_remove', checked):
            run_to_the_end(world, event)
        assert len(seen) == FEEDBACK_ITEMS + MEMORIES

    def test_an_erasures_tombstone_of_an_item_is_kept_as_it_was(self, world):
        event = _seed(world)
        erased = {'pk': 'AUDIT#tombstone#webscraper', 'sk': f'{WS}#fb-1', 'mode': 'erase', 'run_id': 'run-7',
                  'legal_basis': 'GDPR art. 17 request', 'workspace_id': WS}
        world.aggregates.put_item(Item=erased)

        run_to_the_end(world, event)

        assert world.aggregates.get_item(Key={'pk': erased['pk'], 'sk': erased['sk']})['Item'] == erased
        assert _job(world)['counts']['tombstones_kept'] == 1


def _source_of(world: World, key: dict[str, Any]) -> str:
    item = world.feedback.get_item(Key=key).get('Item') or {}
    return str(item.get('source_platform') or 'unknown')


class TestHandOvers:
    def test_a_job_handed_over_after_every_few_pages_ends_exactly_like_one_run(self, world):
        event = _seed(world)

        outcomes = run_to_the_end(world, event, budget=4, limit=400)
        handed = [call for call in outcomes if call['status'] == 'continued']

        assert outcomes[-1]['status'] == 'completed'
        assert len(handed) > 10
        after = snapshot(world)
        assert not [row for row in after['feedback'] if str(row['pk']).startswith(f'WS#{WS}#')]
        assert not [key for key, _version in after['objects'] if key.startswith(f'ws/{WS}/')]
        assert _job(world)['counts']['feedback'] == FEEDBACK_ITEMS

    @pytest.mark.parametrize('phase', ['feedback', 'objects', 'memory', 'counters'])
    def test_a_hand_over_mid_phase_resumes_from_its_cursor(self, world, phase):
        event = _seed(world)
        checkpoints: list[dict] = []
        for _ in range(400):
            world.invoke.reset_mock()
            handler.handle_event(event, Budget(3))
            if not world.invoke.called:
                break
            event = world.invoke.call_args.args[1]
            checkpoints.append(_job(world)['checkpoint'])
        assert any(run['phase'] == phase and run['cursor'] is not None for run in checkpoints)
        assert _job(world)['status'] == 'completed'

    def test_each_hand_over_records_its_checkpoint_on_the_row_and_sends_the_generation_only(self, world):
        event = _seed(world)
        world.invoke.reset_mock()
        assert handler.handle_event(event, Budget(3))['status'] == 'continued'
        job = _job(world)
        assert job['checkpoint']['phase'] == job['phase'] != 'fence'
        assert world.invoke.call_args.args[1] == {'workspace_id': WS, 'run': {'generation': 1}}
        assert job['generation'] == 0


class TestTheGenerationClaim:
    def test_a_duplicate_or_late_delivery_claims_nothing(self, world):
        event = _seed(world)
        world.invoke.reset_mock()
        handler.handle_event(event, Budget(3))
        follow_up = world.invoke.call_args.args[1]

        assert handler.handle_event(event, Budget()) == {'status': 'not_claimed', 'workspace_id': WS}
        handler.handle_event(follow_up, Budget(3))
        assert handler.handle_event(follow_up, Budget()) == {'status': 'not_claimed', 'workspace_id': WS}

    def test_an_event_naming_no_workspace_is_ignored(self, world):
        _seed(world)
        assert handler.handle_event({'workspace_id': 'ws_bad'}, Budget()) == {'status': 'ignored'}
        assert handler.handle_event({}, Budget()) == {'status': 'ignored'}

    def test_a_row_naming_another_workspace_fails_the_job_before_anything_is_deleted(self, world):
        event = _seed(world)
        world.workspaces.update_item(Key={'pk': 'WSDELETE', 'sk': WS}, UpdateExpression='SET workspace_id = :o',
                                     ExpressionAttributeValues={':o': OTHER})
        before = snapshot(world)
        assert handler.handle_event(event, Budget())['status'] == 'failed'
        after = snapshot(world)
        assert after['feedback'] == before['feedback']
        assert after['objects'] == before['objects']

    def test_too_many_hand_overs_fail_loudly(self, world):
        _seed(world)
        world.workspaces.update_item(Key={'pk': 'WSDELETE', 'sk': WS},
                                     UpdateExpression='SET #g = :g, #s = :s, progress_at = :at',
                                     ExpressionAttributeNames={'#g': 'generation', '#s': 'status'},
                                     ExpressionAttributeValues={':g': handler.MAX_GENERATIONS - 1, ':s': 'running',
                                                                ':at': now().isoformat()})
        event = {'workspace_id': WS, 'run': {'generation': handler.MAX_GENERATIONS}}
        assert handler.handle_event(event, Budget())['status'] == 'failed'
        assert _job(world)['error'] == handler.TOO_MANY_HAND_OVERS
        assert 'resume it, with 600 more' in handler.TOO_MANY_HAND_OVERS

        # The resume the message offers continues: a fresh budget of hand-overs, so the job completes.
        assert _resume_to_the_end(world)[-1]['status'] == 'completed'
        assert _job(world)['resumes'] == 1

    def test_resumes_are_bounded_and_the_last_refusal_says_what_to_do(self, world):
        _seed(world)
        world.workspaces.update_item(Key={'pk': 'WSDELETE', 'sk': WS},
                                     UpdateExpression='SET #s = :f, resumes = :r',
                                     ExpressionAttributeNames={'#s': 'status'},
                                     ExpressionAttributeValues={':f': 'failed', ':r': workspace_deletes.MAX_RESUMES})
        with pytest.raises(ConflictError, match='needs an operator'):
            workspace_deletes.resume_delete(world.workspaces, WS, 'sub-pat', world.invoke, now())
        # A finished one answers that it is not stopped, whatever its count.
        world.workspaces.update_item(Key={'pk': 'WSDELETE', 'sk': WS}, UpdateExpression='SET #s = :c',
                                     ExpressionAttributeNames={'#s': 'status'},
                                     ExpressionAttributeValues={':c': 'completed'})
        with pytest.raises(ConflictError, match='not stopped'):
            workspace_deletes.resume_delete(world.workspaces, WS, 'sub-pat', world.invoke, now())


class TestTheFence:
    def test_nothing_is_deleted_before_the_fence_and_the_wait_hands_over(self, world):
        seed_workspace(world, WS, status='deleting')
        event = request_job(world, fence_in=timedelta(minutes=10))
        before = snapshot(world)

        with patch.object(handler.time, 'sleep') as sleep:
            outcome = handler.handle_event(event, Budget())

        assert outcome == {'status': 'continued', 'workspace_id': WS, 'generation': 1}
        # A short step, never the whole fence: the invocation frees its reserved slot within two minutes.
        assert 0 < sleep.call_args.args[0] <= handler.FENCE_STEP_SECONDS
        after = snapshot(world)
        assert {table: rows for table, rows in after.items() if table != 'workspaces'} == {
            table: rows for table, rows in before.items() if table != 'workspaces'}
        job = _job(world)
        assert (job['status'], job['phase'], job['generation'], job['checkpoint']['phase']) == (
            'waiting', 'fence', 0, 'fence')

    def test_three_deletes_requested_together_all_reach_their_sweeps(self, world):
        """Two reserved slots, three deletes in their fence: each invocation sleeps one step and hands over, so the
        third start (throttled while two run) gets a slot within minutes, never past its 40-minute event age."""
        workspaces = (WS, OTHER, THIRD)
        waits: list[timedelta] = []
        with time_machine.travel(now(), tick=False) as traveller, \
                patch.object(handler.time, 'sleep', lambda seconds: traveller.shift(timedelta(seconds=seconds))):
            queue: list[tuple[dict, datetime]] = []
            for ws in workspaces:
                seed_workspace(world, ws, status='deleting')
                queue.append((request_job(world, ws, fence_in=timedelta(minutes=21)), now()))
            for _ in range(400):
                if not queue:
                    break
                running, queue = queue[:2], queue[2:]  # two slots; the rest wait (Lambda's throttling retries)
                for event, queued_at in running:
                    waits.append(now() - queued_at)
                    world.invoke.reset_mock()
                    handler.handle_event(event, Budget())
                    queue.extend((call.args[1], now()) for call in world.invoke.call_args_list)
        assert not queue
        assert max(waits) < MAX_EVENT_AGE
        assert [_job(world, ws)['status'] for ws in workspaces] == ['completed'] * 3
        assert all(_job(world, ws).get('started_at') for ws in workspaces)

    def test_a_job_that_sleeps_past_the_fence_begins_the_sweeps(self, world):
        seed_workspace(world, WS, status='deleting')
        event = request_job(world, fence_in=timedelta(seconds=1))
        outcomes = run_to_the_end(world, event)
        assert outcomes[-1]['status'] == 'completed'

    def test_a_cancel_during_the_fence_stops_the_waiting_job_and_deletes_nothing(self, world):
        seed_workspace(world, WS, status='deleting')
        event = request_job(world, fence_in=timedelta(minutes=10))
        with patch.object(handler.time, 'sleep'):
            handler.handle_event(event, Budget())
        follow_up = world.invoke.call_args.args[1]
        before = snapshot(world)

        workspace_deletes.cancel_delete(world.workspaces, _aggregates_view, WS, 'sub-pat', now())

        assert handler.handle_event(follow_up, Budget()) == {'status': 'not_claimed', 'workspace_id': WS}
        after = snapshot(world)
        assert after['feedback'] == before['feedback']
        assert after['objects'] == before['objects']
        meta = world.workspaces.get_item(Key={'pk': f'WS#{WS}', 'sk': 'META'})['Item']
        assert meta['status'] == 'active'
        assert 'deleting_at' not in meta

    def test_a_cancel_after_the_job_began_is_refused_and_the_delete_goes_on(self, world):
        event = _seed(world)
        world.invoke.reset_mock()
        handler.handle_event(event, Budget(3))  # past the fence: running, its first page done
        assert _job(world)['status'] == 'running'

        with pytest.raises(ConflictError, match='can no longer be cancelled'):
            workspace_deletes.cancel_delete(world.workspaces, _aggregates_view, WS, 'sub-pat', now())

        assert run_to_the_end(world, world.invoke.call_args.args[1])[-1]['status'] == 'completed'

    def test_the_cancel_wins_when_it_moves_the_row_first(self, world):
        seed_workspace(world, WS, status='deleting')
        event = request_job(world, fence_in=timedelta(seconds=30))
        workspace_deletes.cancel_delete(world.workspaces, _aggregates_view, WS, 'sub-pat', now())
        assert handler.handle_event(event, Budget()) == {'status': 'not_claimed', 'workspace_id': WS}

    def test_a_workspace_active_again_stops_the_job(self, world):
        event = _seed(world)
        world.invoke.reset_mock()
        handler.handle_event(event, Budget(3))
        world.workspaces.update_item(Key={'pk': f'WS#{WS}', 'sk': 'META'}, UpdateExpression='SET #s = :a',
                                     ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':a': 'active'})
        before = snapshot(world)
        assert handler.handle_event(world.invoke.call_args.args[1], Budget())['status'] == 'failed'
        assert snapshot(world)['objects'] == before['objects']
        assert _job(world)['error'] == 'The workspace is active again: the delete stopped'


def _aggregates_view(scope):
    return ingest_table(scope, handler.get_dynamodb_resource(), handler.AGGREGATES_TABLE)


class TestResume:
    def test_a_failed_job_resumes_from_its_checkpoint_and_ends_like_a_clean_run(self, world):
        event = _seed(world)
        before = snapshot(world)
        # Not a throttle: a throttle is retried in the sweep (test_sweeps.py TestThrottling), this fails the job.
        fault = ClientError({'Error': {'Code': 'ValidationException', 'Message': 'x'}}, 'BatchWriteItem')
        real, calls = sweeps._remove, []

        def flaky(table_view, keys):
            calls.append(1)
            if len(calls) == 5:
                raise fault
            return real(table_view, keys)

        with patch.object(sweeps, '_remove', flaky):
            outcomes = run_to_the_end(world, event)
        assert outcomes[-1]['status'] == 'failed'
        failed = _job(world)
        assert failed['error'].endswith('(ClientError)')
        assert failed['checkpoint']['phase'] != 'fence'

        world.invoke.reset_mock()
        workspace_deletes.resume_delete(world.workspaces, WS, 'sub-pat', world.invoke, now())
        resumed_event = world.invoke.call_args.args[0]
        # The generation only: the job resumes from the row's checkpoint.
        assert resumed_event == {'workspace_id': WS, 'run': {'generation': int(failed['generation']) + 1}}
        assert run_to_the_end(world, resumed_event)[-1]['status'] == 'completed'

        after = snapshot(world)
        for table, rows in before.items():
            assert ([row for row in after[table] if not _of_the_deleted(table, row)]
                    == [row for row in rows if not _of_the_deleted(table, row)]), table
        assert not [row for row in after['feedback'] if str(row['pk']).startswith(f'WS#{WS}#')]

    def test_a_job_that_stopped_past_the_fence_before_its_first_checkpoint_resumes_at_the_rows_phase(self, world):
        """Generation 0 began the sweeps (the row ``running`` in the first one) and died before any hand-over: the
        resume carries no checkpoint, so the row's phase, not the fence, is where it starts."""
        event = _seed(world)
        # The invocation dies (a timeout writes nothing).
        with patch.object(handler.DeleteRun, '_sweeps', side_effect=SystemExit), pytest.raises(SystemExit):
            handler.handle_event(event, Budget())
        job = _job(world)
        assert (job['status'], job['phase'], 'checkpoint' in job) == ('running', handler.SWEEP_NAMES[0], False)
        _make_stale(world)

        world.invoke.reset_mock()
        workspace_deletes.resume_delete(world.workspaces, WS, 'sub-pat', world.invoke, now())
        resumed_event = world.invoke.call_args.args[0]
        assert 'phase' not in resumed_event['run']

        with patch.object(handler.time, 'sleep') as sleep:
            assert run_to_the_end(world, resumed_event)[-1]['status'] == 'completed'
        assert not sleep.called  # never back in the fence
        assert not [row for row in snapshot(world)['feedback'] if str(row['pk']).startswith(f'WS#{WS}#')]

    def test_a_hand_over_whose_invoke_fails_fails_the_row_then_raises(self, world):
        event = _seed(world)
        world.invoke.side_effect = ClientError({'Error': {'Code': 'TooManyRequestsException', 'Message': 'x'}},
                                               'Invoke')
        with pytest.raises(ClientError):
            handler.handle_event(event, Budget(3))
        job = _job(world)
        assert job['status'] == 'failed'
        assert job['error'].startswith('The hand-over failed in ')
        assert job['error'].endswith('(ClientError)')
        assert job['checkpoint']['phase'] == job['phase'] != 'fence'

        world.invoke.side_effect = None
        assert _resume_to_the_end(world)[-1]['status'] == 'completed'


def _resume_to_the_end(world: World) -> list[dict]:
    """A platform admin's resume of the job, then every invocation it leads to; their outcomes."""
    world.invoke.reset_mock()
    workspace_deletes.resume_delete(world.workspaces, WS, 'sub-pat', world.invoke, now())
    return run_to_the_end(world, world.invoke.call_args.args[0])


def _feedback_of_the_workspace(world: World) -> list[dict]:
    return [row for row in snapshot(world)['feedback'] if str(row['pk']).startswith(f'WS#{WS}#')]


def _feedback_never_deleted():
    """Every delete of the workspace's feedback items does nothing (a row the sweeps cannot remove)."""
    real = sweeps._remove

    def never_feedback(table_view, keys):
        keys = list(keys)
        return 0 if keys and str(keys[0].get('pk', '')).startswith(f'WS#{WS}#SOURCE#') else real(table_view, keys)

    return patch.object(sweeps, '_remove', never_feedback)


def _make_stale(world: World) -> None:
    """The row's ``progress_at`` past ``STALE_AFTER``: what an hour without a move leaves (a resume is allowed)."""
    stale = (now() - workspace_deletes.STALE_AFTER - timedelta(minutes=1)).isoformat()
    world.workspaces.update_item(Key={'pk': 'WSDELETE', 'sk': WS}, UpdateExpression='SET progress_at = :at',
                                 ExpressionAttributeValues={':at': stale})


class TestTheRowDecidesThePhase:
    def test_a_forged_event_naming_a_sweep_while_the_row_waits_deletes_nothing(self, world):
        """B2: generation 0 claimed by an event that says it is past the fence: the row (``waiting``, in the
        fence) wins, so the run waits for the fence, deleting nothing while a cancel can still take the row."""
        seed_workspace(world, WS, status='deleting')
        request_job(world, fence_in=timedelta(minutes=10))
        before = snapshot(world)
        forged = {'workspace_id': WS, 'run': {'generation': 0, 'phase': 'feedback', 'cursor': None}}

        with patch.object(handler.time, 'sleep'):
            outcome = handler.handle_event(forged, Budget())

        assert outcome['status'] == 'continued'
        assert _job(world)['checkpoint']['phase'] == 'fence'
        after = snapshot(world)
        assert {t: rows for t, rows in after.items() if t != 'workspaces'} == {
            t: rows for t, rows in before.items() if t != 'workspaces'}
        job = _job(world)
        assert (job['status'], job['phase']) == ('waiting', 'fence')
        workspace_deletes.cancel_delete(world.workspaces, _aggregates_view, WS, 'sub-pat', now())
        assert _job(world)['status'] == 'cancelled'

    @pytest.mark.parametrize('phase', ['work_partition', 'complete', 'verify'])
    def test_a_forged_phase_past_the_fence_skips_nothing(self, world, phase):
        """The event carries a generation only: a forged phase (and cursor and counts) is never read, so it cannot
        skip the sweeps and the verify pass to a completion; the run goes on from the row's checkpoint."""
        event = _seed(world)
        world.invoke.reset_mock()
        assert handler.handle_event(event, Budget(3))['status'] == 'continued'
        real_phase = _job(world)['checkpoint']['phase']
        forged = {'workspace_id': WS, 'run': {'generation': 1, 'phase': phase, 'cursor': None,
                                              'counts': {'feedback': 10 ** 6}}}

        world.invoke.reset_mock()
        assert handler.handle_event(forged, Budget(3))['status'] == 'continued'
        assert _job(world)['status'] == 'running'
        assert handler.PHASES.index(_job(world)['checkpoint']['phase']) <= handler.PHASES.index('feedback')
        assert real_phase in handler.SWEEP_NAMES

        assert run_to_the_end(world, world.invoke.call_args.args[1])[-1]['status'] == 'completed'
        assert _feedback_of_the_workspace(world) == []
        assert _job(world)['counts']['feedback'] == FEEDBACK_ITEMS

    def test_progress_past_the_fence_is_never_recorded_on_a_waiting_row(self, world):
        seed_workspace(world, WS, status='deleting')
        request_job(world, fence_in=timedelta(minutes=10))
        workspace_deletes.claim_generation(world.workspaces, WS, 0, now())
        assert not workspace_deletes.record_progress(world.workspaces, WS, 0, {'phase': 'feedback'})
        assert workspace_deletes.record_progress(world.workspaces, WS, 0, {'phase': 'fence'})
        assert _job(world)['phase'] == 'fence'


class TestTheVerifyPass:
    def test_a_row_that_arrived_after_its_sweep_sends_the_job_back_once_then_it_completes(self, world):
        event = _seed(world)
        real = handler.DeleteRun._verify
        late = {'pk': f'WS#{WS}#SOURCE#webscraper', 'sk': 'FEEDBACK#late', 'feedback_id': 'late',
                'source_platform': 'webscraper'}
        arrived: list[bool] = []

        def verify_after_a_late_arrival(run):
            if not arrived:
                world.feedback.put_item(Item=late)
                arrived.append(True)
            return real(run)

        with patch.object(handler.DeleteRun, '_verify', verify_after_a_late_arrival):
            assert run_to_the_end(world, event)[-1]['status'] == 'completed'
        assert 'Item' not in world.feedback.get_item(Key={'pk': late['pk'], 'sk': late['sk']})
        assert 'Item' in world.aggregates.get_item(Key={'pk': 'AUDIT#tombstone#webscraper', 'sk': f'{WS}#late'})

    def test_rows_that_stay_after_two_passes_fail_the_job_naming_their_family(self, world):
        event = _seed(world)
        with _feedback_never_deleted():
            outcomes = run_to_the_end(world, event)
        assert outcomes[-1]['status'] == 'failed'
        assert _job(world)['error'] == 'The verify pass found rows left in feedback'

    def test_a_resume_after_a_failed_verify_sweeps_and_verifies_again_never_completing_while_rows_remain(self, world):
        """The failed verify's checkpoint is the first sweep, its rounds reset: a resume runs every sweep and the
        verify pass again, so it fails again while the rows stay, and completes only once they are gone."""
        event = _seed(world)
        with _feedback_never_deleted():
            assert run_to_the_end(world, event)[-1]['status'] == 'failed'
            failed = _job(world)
            assert (failed['phase'], failed['checkpoint']['phase']) == (handler.SWEEP_NAMES[0], handler.SWEEP_NAMES[0])
            assert (failed['checkpoint']['cursor'], failed['checkpoint']['verify_rounds']) == (None, 0)
            outcomes = _resume_to_the_end(world)
        assert (outcomes[-1]['status'], _job(world)['status']) == ('failed', 'failed')
        assert _feedback_of_the_workspace(world) != []

        assert _resume_to_the_end(world)[-1]['status'] == 'completed'
        assert _feedback_of_the_workspace(world) == []

    def test_a_job_with_nothing_left_writes_no_leftovers(self, world):
        run_to_the_end(world, _seed(world))
        assert _job(world)['checkpoint']['leftovers'] == {}
        assert _job(world)['checkpoint']['verify_rounds'] == 0


class TestKnownGaps:
    def test_a_counter_of_a_value_no_stored_item_and_no_index_names_is_left(self, world):
        """D5's gap, pinned: a counter of a category no setting configures, whose items were all erased before the
        delete, keeps its counts and that value until the counters' TTL: nothing lists its partition without a Scan
        (a configured category is listed from the settings, test_sweeps.py; a source counter, on the metric-type
        index, is found)."""
        event = _seed(world)
        orphan = {'pk': f'WS#{WS}#METRIC#daily_category#erased_only', 'sk': '2026-01-01', 'count': 1}
        world.aggregates.put_item(Item=orphan)
        run_to_the_end(world, event)
        assert 'Item' in world.aggregates.get_item(Key={'pk': orphan['pk'], 'sk': orphan['sk']})
        found_by_index = {'pk': f'WS#{WS}#METRIC#daily_source#retired_source', 'sk': (now().date() - timedelta(days=9)).isoformat()}
        assert 'Item' not in world.aggregates.get_item(Key=found_by_index)


def test_the_export_lock_is_held_to_the_last_step_then_deleted(world):
    event = _seed(world)
    lock = {'pk': f'WS#{WS}#JOB#export', 'sk': 'LOCK'}
    seen_in_verify: list[bool] = []
    real = handler.DeleteRun._verify

    def verify(run):
        seen_in_verify.append('Item' in world.aggregates.get_item(Key=lock))
        return real(run)

    with patch.object(handler.DeleteRun, '_verify', verify):
        assert run_to_the_end(world, event)[-1]['status'] == 'completed'
    assert seen_in_verify
    assert all(seen_in_verify)
    assert 'Item' not in world.aggregates.get_item(Key=lock)


def test_with_the_flag_off_the_job_refuses_every_event_and_writes_nothing(world):
    """``-c workspaceHardDelete`` absent (the default): no claim, no read, no delete."""
    event = _seed(world)
    before = snapshot(world)
    with patch.dict('os.environ', {'WORKSPACE_HARD_DELETE': 'false'}):
        assert handler.handle_event(event, Budget()) == {'status': 'disabled'}
        assert handler.handle_event({**event, 'run': {'generation': 1}}, Budget()) == {'status': 'disabled'}
    assert snapshot(world) == before
    assert not world.invoke.called


def test_an_erasure_meeting_the_deleted_workspace_recreates_no_export_lock(world):
    """voc-retention's exports phase (renew, then clear) for a workspace it noted before the delete: the workspace
    is not active (its META is gone), so no lock row is created where the delete removed its own."""
    from jobs.retention import exports, runs

    assert run_to_the_end(world, _seed(world))[-1]['status'] == 'completed'
    run = runs.new_run({}, 'erase')
    run[exports.ERASED_WORKSPACES] = [WS]
    exports.renew(run, world.aggregates)
    assert exports.clear(run, world.s3, BUCKET, world.aggregates, lambda: True) is True
    assert 'Item' not in world.aggregates.get_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': 'LOCK'})
    assert not [row for row in snapshot(world)['aggregates'] if str(row['pk']).startswith(f'WS#{WS}#')]


def test_the_bucket_holds_no_version_of_the_workspace_after_the_delete(world):
    run_to_the_end(world, _seed(world))
    listed = world.s3.list_object_versions(Bucket=BUCKET, Prefix=f'ws/{WS}/')
    assert not listed.get('Versions')
    assert not listed.get('DeleteMarkers')
    assert not world.s3.list_multipart_uploads(Bucket=BUCKET, Prefix=f'ws/{WS}/').get('Uploads')
