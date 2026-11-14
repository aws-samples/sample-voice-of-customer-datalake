"""Each entry of jobs/workspace_delete/sweeps.py SWEEPS on its own, on moto: it removes its family of the deleted
workspace and nothing of the other workspace or the deployment."""
from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError

from jobs.workspace_delete import handler, sweeps
from jobs.workspace_delete.sweeps import SWEEPS, Pacer, inventory
from jobs.workspace_delete.test.conftest import (
    BUCKET,
    COMPANY_MEMORIES,
    EVENTS_PER_MEMORY,
    FEEDBACK_ITEMS,
    OTHER,
    PERSONAL_MEMORIES,
    PLUGINS,
    PREFIX,
    WS,
    Budget,
    World,
    day,
    feedback_item,
    request_job,
    seed_deployment,
    seed_workspace,
    snapshot,
)
from shared.workspace_settings import settings_key
from shared.ws_repo import WorkspaceScope, WorkspaceTable

BY_NAME = {sweep.name: sweep for sweep in SWEEPS}


@pytest.fixture
def seeded(world: World) -> World:
    seed_workspace(world, WS, status='deleting')
    seed_workspace(world, OTHER, status='active')
    seed_deployment(world)
    request_job(world)
    return world


def _delete(world: World) -> handler.DeleteRun:
    row = world.workspaces.get_item(Key={'pk': 'WSDELETE', 'sk': WS})['Item']
    return handler.DeleteRun(WorkspaceScope(WS), row, handler.RunState(phase='credentials'), Budget())


def run(world: World, *names: str) -> dict[str, int]:
    """Run the named sweeps, in order, to their end in one invocation; their counts."""
    delete = _delete(world)
    for name in names:
        delete.run.phase, delete.run.cursor = name, None
        delete._sweep(BY_NAME[name])
    return delete.ctx.counts


def _partition(table: Any, pk: str) -> list[dict]:
    return table.query(KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': pk})['Items']


def test_the_entries_run_in_the_designs_order():
    assert [sweep.name for sweep in SWEEPS] == [
        'credentials', 'feedback', 'counters', 'source_runs', 'failures', 'circuits', 'logs', 'scraper_runs',
        'plugin_configs', 'feedback_forms', 'import_runs', 'erasure_jobs', 'reprocess_jobs', 'watermarks', 'memory',
        'exports', 'objects', 'radar', 'settings', 'user_contexts', 'control_rows']


def test_only_the_feedback_and_the_memory_are_tombstoned():
    assert {sweep.name for sweep in SWEEPS if sweep.tombstone is not None} == {'feedback', 'memory'}


class TestThrottling:
    """A throttled delete or tombstone write backs off and is retried (``unthrottled``); any other error is not."""

    @staticmethod
    def _flaky(code: str, failures: int):
        calls: list[int] = []

        def call() -> str:
            calls.append(1)
            if len(calls) <= failures:
                raise ClientError({'Error': {'Code': code, 'Message': 'x'}}, 'BatchWriteItem')
            return 'written'
        return call, calls

    def test_a_throttle_is_retried_with_a_growing_backoff(self):
        call, calls = self._flaky('ProvisionedThroughputExceededException', 3)
        with patch.object(sweeps.time, 'sleep') as sleep:
            assert sweeps.unthrottled(call) == 'written'
        assert len(calls) == 4
        waits = [c.args[0] for c in sleep.call_args_list]
        assert waits == sorted(waits)
        assert waits[0] < waits[-1]

    def test_a_throttle_past_the_last_try_raises(self):
        call, calls = self._flaky('ThrottlingException', sweeps.THROTTLE_ATTEMPTS)
        with patch.object(sweeps.time, 'sleep'), pytest.raises(ClientError):
            sweeps.unthrottled(call)
        assert len(calls) == sweeps.THROTTLE_ATTEMPTS

    def test_another_error_is_not_retried(self):
        call, calls = self._flaky('ValidationException', 1)
        with patch.object(sweeps.time, 'sleep') as sleep, pytest.raises(ClientError):
            sweeps.unthrottled(call)
        assert (len(calls), sleep.called) == (1, False)

    def test_a_sweep_rides_out_a_throttled_page(self, seeded):
        real, calls = WorkspaceTable._delete_chunk, []

        def throttled_once(view, keys):
            calls.append(1)
            if len(calls) == 1:
                raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'x'}},
                                  'BatchWriteItem')
            return real(view, keys)

        with patch.object(sweeps.time, 'sleep'), patch.object(WorkspaceTable, '_delete_chunk', throttled_once):
            counts = run(seeded, 'feedback')
        assert counts['feedback'] == FEEDBACK_ITEMS
        assert [row for row in snapshot(seeded)['feedback'] if str(row['pk']).startswith(f'WS#{WS}#')] == []


class TestCredentials:
    def test_deletes_every_parameter_of_the_workspace_and_lists_its_plugins(self, seeded):
        listed = []
        real = seeded.ssm.get_parameters_by_path

        def spy(**kwargs):
            listed.append(kwargs)
            return real(**kwargs)

        with patch.object(seeded.ssm, 'get_parameters_by_path', spy):
            counts = run(seeded, 'credentials')

        assert counts['credentials'] == len(PLUGINS)
        assert snapshot(seeded)['parameters'] == sorted(f'{PREFIX}/{OTHER}/credentials/{p}' for p in PLUGINS)
        assert {call['WithDecryption'] for call in listed} == {False}
        assert {call['Path'] for call in listed} == {f'{PREFIX}/{WS}/credentials'}
        assert sorted(inventory(_delete(seeded).ctx, 'plugin')) == sorted(PLUGINS)


class TestFeedback:
    def test_every_item_goes_each_after_its_tombstone_and_the_other_workspaces_stay(self, seeded):
        before = snapshot(seeded)['feedback']

        counts = run(seeded, 'feedback')

        after = snapshot(seeded)['feedback']
        assert [row for row in after if str(row['pk']).startswith(f'WS#{WS}#')] == []
        assert after == [row for row in before if not str(row['pk']).startswith(f'WS#{WS}#')]
        assert (counts['feedback'], counts['tombstones_written']) == (FEEDBACK_ITEMS, FEEDBACK_ITEMS)

    def test_finds_a_brands_partition_by_the_days_and_a_dateless_item_by_its_plugin(self, seeded):
        run(seeded, 'feedback')
        listed = set(inventory(_delete(seeded).ctx, 'feedback'))
        assert {f'WS#{WS}#SOURCE#acme-store', f'WS#{WS}#SOURCE#acme-app', f'WS#{WS}#SOURCE#webscraper'} <= listed
        assert 'Item' in seeded.aggregates.get_item(
            Key={'pk': 'AUDIT#tombstone#webscraper', 'sk': f'{WS}#fb-{FEEDBACK_ITEMS - 2}'})

    def test_lists_the_counter_partitions_its_items_touched(self, seeded):
        run(seeded, 'feedback')
        counters = set(inventory(_delete(seeded).ctx, 'counter'))
        assert {f'WS#{WS}#METRIC#daily_total', f'WS#{WS}#METRIC#daily_category#delivery',
                f'WS#{WS}#METRIC#daily_tag#parcel', f'WS#{WS}#METRIC#urgent'} <= counters
        assert all(partition.startswith(f'WS#{WS}#METRIC#') for partition in counters)


class TestTheTimeInsideAPage:
    def test_a_page_stopped_mid_tombstones_deletes_nothing_and_its_replay_completes_keeping_none(self, seeded):
        """More than TIME_CHECK_EVERY items on one day, and the time gone at the first look inside that page:
        OutOfTime, none of the page deleted; the page done again from the same cursor deletes every item, and its
        own tombstones from the stopped attempt are not counted as kept (nor twice as written)."""
        extra = [feedback_item(WS, 1000 + n, day(0)) for n in range(sweeps.TIME_CHECK_EVERY + 15)]
        for item in extra:
            seeded.feedback.put_item(Item=item)
        delete = _delete(seeded)
        time = {'left': False}
        delete.ctx.time_left = lambda: time['left']
        delete.run.phase, delete.run.cursor = 'feedback', None

        with pytest.raises(sweeps.OutOfTime):
            delete._sweep(BY_NAME['feedback'])
        assert all('Item' in seeded.feedback.get_item(Key={'pk': i['pk'], 'sk': i['sk']}) for i in extra)
        assert delete.ctx.counts['tombstones_written'] > 0

        time['left'] = True
        delete._sweep(BY_NAME['feedback'])  # from the cursor the stop left (the page's own)
        assert [row for row in snapshot(seeded)['feedback'] if str(row['pk']).startswith(f'WS#{WS}#')] == []
        assert delete.ctx.counts.get('tombstones_kept', 0) == 0
        assert delete.ctx.counts['tombstones_written'] == FEEDBACK_ITEMS + len(extra)


class TestCounters:
    def test_every_listed_fixed_and_indexed_counter_goes(self, seeded):
        counts = run(seeded, 'feedback', 'counters')

        rows = snapshot(seeded)['aggregates']
        assert [row for row in rows if str(row['pk']).startswith(f'WS#{WS}#METRIC#')] == []
        assert [row for row in rows if str(row['pk']).startswith(f'WS#{OTHER}#METRIC#')] != []
        assert [row['pk'] for row in rows if row['pk'] == 'METRIC#daily_total'] == ['METRIC#daily_total']
        assert counts['counters'] > 10

    def test_with_no_saved_categories_the_default_ones_are_closed_too(self, seeded):
        """No SETTINGS#categories row: the model answers with the default categories, so theirs are listed."""
        orphan = f'WS#{WS}#METRIC#daily_category#pricing'
        seeded.aggregates.put_item(Item={'pk': orphan, 'sk': '2026-01-01', 'count': 1})
        # No item names it: the seeded items are all deleted first, and their counters with them.
        for row in snapshot(seeded)['feedback']:
            if str(row['pk']).startswith(f'WS#{WS}#') and row.get('category') == 'pricing':
                seeded.feedback.delete_item(Key={'pk': row['pk'], 'sk': row['sk']})
        assert 'Item' not in seeded.aggregates.get_item(Key={'pk': 'SETTINGS#categories', 'sk': 'config'})

        run(seeded, 'feedback', 'counters')

        assert _partition(seeded.aggregates, orphan) == []

    def test_the_closed_families_go_even_with_no_item_naming_them(self, seeded):
        """A category the workspace configures (and its subcategory) or a sentiment label is listed from the
        workspace's own settings (7.08.00), so its counters go though every item of it was erased before the delete;
        the deployment's categories are never read (a counter only they name stays, as does their row)."""
        seeded.aggregates.put_item(Item={**settings_key(WS, 'categories'), 'categories': [
            {'name': 'erased_only', 'subcategories': [{'name': 'late'}]}]})
        seeded.aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': [
            {'name': 'deployment_only'}]})
        deployments = f'WS#{WS}#METRIC#daily_category#deployment_only'
        seeded.aggregates.put_item(Item={'pk': deployments, 'sk': '2026-01-01', 'count': 1})
        orphans = [f'WS#{WS}#METRIC#daily_category#erased_only', f'WS#{WS}#METRIC#daily_subcategory#erased_only#late',
                   f'WS#{WS}#METRIC#category_sentiment#erased_only#negative',
                   f'WS#{WS}#METRIC#daily_sentiment#mixed']
        for pk in orphans:
            seeded.aggregates.put_item(Item={'pk': pk, 'sk': '2026-01-01', 'count': 1})

        run(seeded, 'feedback', 'counters')

        assert [pk for pk in orphans if _partition(seeded.aggregates, pk)] == []
        assert _partition(seeded.aggregates, 'SETTINGS#categories') != []
        assert _partition(seeded.aggregates, deployments) != []


@pytest.mark.parametrize(('name', 'partitions'), [
    ('source_runs', ['SOURCE_RUN#webscraper', 'SOURCE_RUN#app_reviews_ios']),
    ('failures', ['FAILURES#webscraper']),
    ('circuits', ['CIRCUIT#webscraper']),
    ('logs', ['LOGS#validation#webscraper', 'LOGS#processing#feedback_form']),
    ('scraper_runs', ['SCRAPER_RUN#s1', 'SCRAPER_RUN#s0']),
    ('plugin_configs', ['PLUGIN_CONFIG', 'PLUGIN_CONFIG#HISTORY']),
    ('feedback_forms', ['FEEDBACK_FORM']),
    ('import_runs', ['IMPORT_RUN', 'IMPORT_RUN#run1']),
    ('erasure_jobs', ['JOB#erasure']),
])
def test_each_aggregates_family_goes_for_the_workspace_only(seeded, name, partitions):
    # The sources these families are keyed by are the ones the feedback sweep met.
    run(seeded, 'feedback', name)
    for part in partitions:
        assert _partition(seeded.aggregates, f'WS#{WS}#{part}') == [], part
        assert _partition(seeded.aggregates, f'WS#{OTHER}#{part}') != [], part
    assert _partition(seeded.aggregates, 'PLUGIN_CONFIG') != []


class TestTheOwnerListKind:
    """``owner_list_sweep``, on the import runs: every listed partition goes, the list last."""

    def _seed_runs(self, world: World, runs: int) -> None:
        for n in range(runs):
            world.aggregates.put_item(Item={'pk': f'WS#{WS}#IMPORT_RUN', 'sk': f'2026-11-01#{n:03d}', 'run_id': f'r{n}'})
            for row in range(3):
                world.aggregates.put_item(Item={'pk': f'WS#{WS}#IMPORT_RUN#r{n}', 'sk': f'ROW#{row}'})

    def test_deletes_each_listed_partition_in_full_then_the_list(self, seeded):
        self._seed_runs(seeded, 5)
        run(seeded, 'import_runs')
        for n in range(5):
            assert _partition(seeded.aggregates, f'WS#{WS}#IMPORT_RUN#r{n}') == []
        assert _partition(seeded.aggregates, f'WS#{WS}#IMPORT_RUN') == []
        assert _partition(seeded.aggregates, f'WS#{OTHER}#IMPORT_RUN#run1') != []

    def test_the_list_stays_until_every_partition_it_names_is_gone(self, seeded):
        self._seed_runs(seeded, 5)
        delete = _delete(seeded)
        sweep, cursor, lists_seen = BY_NAME['import_runs'], None, []
        while True:
            batch = sweep.pages(delete.ctx, cursor)
            if batch.rows:
                sweep.delete(delete.ctx, batch)
            details = [n for n in range(5) if _partition(seeded.aggregates, f'WS#{WS}#IMPORT_RUN#r{n}')]
            lists_seen.append((bool(details), bool(_partition(seeded.aggregates, f'WS#{WS}#IMPORT_RUN'))))
            cursor = batch.following
            if cursor is None:
                break
            # A stop anywhere resumes from the checkpoint the job would carry (here, the same cursor).
        assert all(listed for details_left, listed in lists_seen if details_left)
        assert lists_seen[-1] == (False, False)

    def test_a_row_naming_another_workspaces_partition_is_never_followed(self):
        from jobs.workspace_delete.sweeps import OWNER_LISTS

        owners = OWNER_LISTS['import_runs']
        assert owners.listed(WorkspaceScope(WS), {'run_id': 'r1#x'}) == []
        assert owners.listed(WorkspaceScope(WS), {'run_id': ''}) == []
        assert owners.listed(WorkspaceScope(WS), {'run_id': 'r1'}) == [f'WS#{WS}#IMPORT_RUN#r1']


def test_the_forms_sweep_lists_each_form_for_its_lookup_row(seeded):
    run(seeded, 'feedback_forms')
    assert list(inventory(_delete(seeded).ctx, 'form')) == ['ff_1']


class TestWatermarks:
    def test_each_listed_watermark_and_its_row_go(self, seeded):
        counts = run(seeded, 'watermarks')
        watermarks = [row['source'] for row in snapshot(seeded)['watermarks']]
        assert counts['watermarks'] == 2
        assert sorted(watermarks) == sorted([f'WS#{OTHER}#webscraper#last_id', f'WS#{OTHER}#app_reviews_ios#cursor',
                                             'webscraper#last_id'])
        assert _partition(seeded.aggregates, f'WS#{WS}#WATERMARK_KEYS') == []
        assert len(_partition(seeded.aggregates, f'WS#{OTHER}#WATERMARK_KEYS')) == 2


class TestMemory:
    def test_every_memory_its_events_the_cursors_and_imports_go_each_memory_tombstoned(self, seeded):
        counts = run(seeded, 'memory')
        rows = snapshot(seeded)['memory']
        assert [row for row in rows if str(row['pk']).startswith(f'WS#{WS}#')] == []
        assert [row for row in rows if str(row['pk']).startswith(f'WS#{OTHER}#')] != []
        assert [row['pk'] for row in rows if not str(row['pk']).startswith('WS#')] == ['MEM#company']
        memories = len(COMPANY_MEMORIES) + len(PERSONAL_MEMORIES)
        assert counts['memory_events'] == memories * EVENTS_PER_MEMORY
        assert counts['tombstones_written'] == memories
        stones = _partition(seeded.aggregates, 'AUDIT#tombstone#memory')
        assert sorted(row['sk'] for row in stones) == sorted(
            f'{WS}#{memory_id}' for memory_id in (*COMPANY_MEMORIES, *(m for _o, m, _s in PERSONAL_MEMORIES)))


class TestExports:
    def test_marks_aborts_and_deletes_the_export_jobs_of_the_workspace_only(self, seeded):
        counts = run(seeded, 'exports')
        # Only the delete's own LOCK stays: it is deleted last, with the inventory (handler.py).
        assert [(row['sk'], row['job_id']) for row in _partition(seeded.aggregates, f'WS#{WS}#JOB#export')] == [
            ('LOCK', f'delete-{WS}')]
        assert len(_partition(seeded.aggregates, f'WS#{OTHER}#JOB#export')) == 2
        assert counts['export_uploads_aborted'] == 1
        uploads = snapshot(seeded)['uploads']
        assert f'ws/{WS}/exports/ex_2/workspace-export.zip' not in uploads
        assert f'ws/{OTHER}/exports/ex_2/workspace-export.zip' in uploads


class TestObjects:
    def test_every_version_marker_and_upload_of_the_workspace_goes(self, seeded):
        before = snapshot(seeded)
        counts = run(seeded, 'objects')
        after = snapshot(seeded)
        assert [key for key, _version in after['objects'] if key.startswith(f'ws/{WS}/')] == []
        assert after['objects'] == [entry for entry in before['objects'] if not entry[0].startswith(f'ws/{WS}/')]
        assert [key for key in after['uploads'] if key.startswith(f'ws/{WS}/')] == []
        assert counts['objects'] == len([e for e in before['objects'] if e[0].startswith(f'ws/{WS}/')])
        assert counts['uploads_aborted'] == 2

    def test_a_version_s3_will_not_delete_fails_the_sweep_after_its_retries(self, seeded):
        from shared.ws_repo import VersionDeleteFailure, WorkspaceObjectVersions

        def refuse(_self, versions):
            return [VersionDeleteFailure(v.key, v.version_id, 'AccessDenied') for v in versions]

        with patch.object(WorkspaceObjectVersions, 'delete', refuse), pytest.raises(RuntimeError, match='versions'):
            run(seeded, 'objects')
        listed = seeded.s3.list_object_versions(Bucket=BUCKET, Prefix=f'ws/{WS}/')
        assert listed.get('Versions')


class TestControlRows:
    def test_the_workspaces_rows_go_its_audit_trail_stays_and_its_slug_is_marked(self, seeded):
        seeded.workspaces.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'name': 'Acme Outfitters', 'slug': 'acme',
                                         'status': 'deleting'})
        run(seeded, 'feedback_forms', 'control_rows')
        rows = {(row['pk'], row['sk']): row for row in snapshot(seeded)['workspaces']}
        of_ws = sorted(key for key, row in rows.items() if WS in str(key) or row.get('workspace_id') == WS)
        assert of_ws == sorted([(f'AUDIT#WS#{WS}', '2026-01-01T00:00:00#aa'), ('SLUG#acme', 'META'), ('WSDELETE', WS)])
        assert 'deleted_at' in rows[('SLUG#acme', 'META')]
        assert ('USER#sub-ada', 'PROFILE') in rows
        assert (f'WS#{OTHER}', 'META') in rows
        assert ('PLUGIN#webscraper', f'WS#{OTHER}') in rows

    def test_a_lookup_row_of_another_workspace_under_a_listed_form_is_kept(self, seeded):
        seeded.workspaces.put_item(Item={'pk': 'FORM#ff_1', 'sk': 'META', 'workspace_id': OTHER})
        counts = run(seeded, 'feedback_forms', 'control_rows')
        assert seeded.workspaces.get_item(Key={'pk': 'FORM#ff_1', 'sk': 'META'})['Item']['workspace_id'] == OTHER
        assert counts['control_rows_of_another_workspace'] == 1

    def test_an_active_workspaces_meta_is_never_deleted(self, seeded):
        from shared.ws_repo import OutOfScopeError

        seeded.workspaces.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'status': 'active'})
        with pytest.raises(OutOfScopeError, match='not being deleted'):
            run(seeded, 'control_rows')
        assert 'Item' in seeded.workspaces.get_item(Key={'pk': f'WS#{WS}', 'sk': 'META'})


def test_the_pacer_holds_the_tombstones_near_their_rate():
    moments, slept = [100.0], []

    def sleep(seconds: float) -> None:
        slept.append(seconds)
        moments[0] += seconds

    pacer = Pacer(per_second=800, clock=lambda: moments[0], sleep=sleep)
    for _ in range(801):
        pacer.wait()
    assert sum(slept) == pytest.approx(1.0)
