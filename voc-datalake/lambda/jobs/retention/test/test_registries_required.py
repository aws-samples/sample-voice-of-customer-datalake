"""voc-retention's ``registries`` phase and the lineage it owes (7.93.00, projects 3g-d2; docs/multi-workspace.md,
the project plan's 3g-d2).

Every run of the worker that names no workspace starts with the ``registries`` phase (jobs/retention/registries.py):
the review registries' marker (scripts/projects/backfill_review_registries.py), then the gap check, one page of the
live projects on ``gsi1-by-type`` and one BatchGetItem of their ``PROJECT_IDS`` rows a step. Its result is the run's
(``complete``, ``not_backfilled``, ``incomplete``), on the job and audit rows. An erasure by email without a source
fails there, by name, before it deletes anything (its people walk is the erasure itself and the address is not stored,
so it cannot be owed). Every other run deletes as usual and, when the registries are not complete, OWES its deployment
lineage pass in one durable row (``JOB#retention`` / ``LINEAGE_OWED``: the sources and the runs owed); the next run of
the deployment whose registries are complete replays it, deleting anything or not, and clears what it replayed. The
marker is read again at each invocation's start, so an ``--unmark`` during a run is seen. End to end in moto; every
test here was seen failing before its fix.
"""
from __future__ import annotations

import json
import re
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Final
from unittest.mock import patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from jobs.retention import handler, lineage, project_people, registries, runs, workspaces
from jobs.retention.test.conftest import BUCKET, PROJECTS_TABLE, days_ago, erasure_job, erasure_rows, put_feedback
from jobs.retention.test.test_deployment_project_erasure import CHANGED, MARKER, _link
from jobs.retention.test.test_named_workspace_erasure import _job as _named_job
from jobs.retention.test.test_project_erasure import (
    OTHER_REVIEWER,
    REVIEWER,
    STAMP,
    _erase_by_email,
    _list_workspace,
    _one_row_pages,
    _row,
    _run,
    _seed_deployment,
    _sorted,
    _tables,
    deployment_project,
)
from jobs.retention.test.test_workspace_erasure import BASIS, JOB_ID, WS, put_workspace_feedback
from shared import ops_alerts
from shared.ids import timestamped_id
from shared.project_keys import project_pk, project_type_pk
from shared.project_writes import is_verification_fixture_project
from shared.retention import PROJECT_COUNTER
from shared.test.moto_tables import mark_review_registries_backfilled

MARKER_KEY: Final = {'pk': MARKER['pk'], 'sk': MARKER['sk']}
NOT_BACKFILLED_ERROR: Final = 'ReviewRegistriesNotBackfilled'
INCOMPLETE_ERROR: Final = 'ReviewRegistriesIncomplete'
LATER: Final = '2026-12-01T00:00:00+00:00'


@pytest.fixture(autouse=True)
def projects_env(monkeypatch):
    monkeypatch.setenv('PROJECTS_TABLE', PROJECTS_TABLE)


def _unmark(aws) -> None:
    aws['projects'].delete_item(Key=dict(MARKER_KEY))


def _unlisted_live_project(aws, project_id: str = 'proj_unlisted_0001', listed_at: str = STAMP) -> None:
    """A live project on ``gsi1-by-type`` that ``PROJECT_IDS`` does not name (an older writer's, after a single-stack
    rollback or an older bundle's import), sorted on the index by ``listed_at``."""
    aws['projects'].put_item(Item={'pk': project_pk(project_id), 'sk': 'META', 'project_id': project_id,
                                   'created_at': STAMP, 'gsi1pk': project_type_pk(), 'gsi1sk': listed_at,
                                   'owner_email': REVIEWER})


@contextmanager
def calls_on_projects(aws) -> Generator[list[tuple[str, dict[str, Any]]]]:
    """Every call the job sends to voc-projects: its operation and its parameters (the tables share one client)."""
    seen: list[tuple[str, dict[str, Any]]] = []

    def record(params: dict[str, Any], **kwargs: Any) -> None:
        if params.get('TableName') == PROJECTS_TABLE or PROJECTS_TABLE in (params.get('RequestItems') or {}):
            seen.append((str(kwargs['event_name']).rsplit('.', 1)[-1], dict(params)))

    events = aws['projects'].meta.client.meta.events
    events.register('provide-client-params.dynamodb', record)
    try:
        yield seen
    finally:
        events.unregister('provide-client-params.dynamodb', record)


def _kind(call: tuple[str, dict[str, Any]]) -> str:
    """What a call to voc-projects read: the marker, the project index, the registry's rows, or something else."""
    operation, params = call
    values = params.get('ExpressionAttributeValues') or {}
    if operation == 'Query' and values.get(':p') == MARKER['pk'] and values.get(':sk') == MARKER['sk']:
        return 'marker'
    if operation == 'Query' and params.get('IndexName') == 'gsi1-by-type':
        return 'index'
    keys = ((params.get('RequestItems') or {}).get(PROJECTS_TABLE) or {}).get('Keys') or []
    if operation == 'BatchGetItem' and keys and all(key['pk'] == 'PROJECT_IDS' for key in keys):
        return 'registry'
    return operation


def _cited_by_a_persona(aws, ids: list[str], **review: Any) -> None:
    """Review f1 by Reviewer One, and deployment project p1 whose persona cites ``ids``."""
    put_feedback(aws, 'f1', author='Reviewer One', **review)
    deployment_project(aws, 'p1')
    aws['projects'].put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PERSONA#a', 'input_feedback_ids': ids})


def _persona(aws) -> list[str]:
    return list(_row(aws, {'pk': 'PROJECT#p1', 'sk': 'PERSONA#a'})['input_feedback_ids'])


def _web_reviews(aws) -> int:
    return int(aws['feedback'].query(KeyConditionExpression=Key('pk').eq('SOURCE#web'))['Count'])


def _failed(aws, result: dict[str, Any], name: str) -> dict[str, Any]:
    """The job's row, once the run and its row read failed by ``name``."""
    job, _audit = erasure_rows(aws, JOB_ID)
    assert (result['status'], job['status']) == ('failed', 'failed')
    assert name in job['error']
    return job


def _erase_reviewer_one(aws, context, job_id: str = JOB_ID) -> dict[str, Any]:
    """An erasure by author (deletes f1, then the lineage pass), as the settings API queues it."""
    return handler.handle_event(erasure_job(aws, job_id, 'author', 'Reviewer One', legal_basis=BASIS), context)


def _retain_web(aws) -> None:
    """A 30-day window on the web source."""
    aws['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config',
                                     'sources': [{'id': 'web', 'retention_days': 30}]})


def _window(context) -> dict[str, Any]:
    return handler.handle_event({'mode': 'retention'}, context)


def _audits(aws) -> list[dict[str, Any]]:
    rows = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(runs.AUDIT_PK))['Items']
    return sorted(rows, key=lambda row: str(row['sk']))


def _owed(aws) -> dict[str, Any]:
    return aws['aggregates'].get_item(Key=dict(registries.OWED_KEY)).get('Item') or {}


def _emf(capsys, metric: str) -> list[dict[str, Any]]:
    """The EMF lines the run printed for ``metric``."""
    return _emf_of(capsys.readouterr().out, metric)


def _emf_of(out: str, metric: str) -> list[dict[str, Any]]:
    """The EMF lines for ``metric`` in a run's captured output ``out``."""
    found = []
    for line in out.splitlines():
        try:
            document = json.loads(line)
        except ValueError:
            continue
        if isinstance(document, dict) and metric in document and '_aws' in document:
            found.append(document)
    return found


class TestAnErasureByEmail:
    @pytest.mark.parametrize('marker', [
        None,
        {key: value for key, value in MARKER.items() if key != 'projects_found'},
        {**MARKER, 'release': '7.43.0'},
    ])
    def test_without_the_marker_it_fails_by_name_and_deletes_and_reads_nothing(self, aws, worker_context, marker,
                                                                               capsys):
        _seed_deployment(aws)
        _unmark(aws)
        if marker is not None:
            aws['projects'].put_item(Item=marker)
        put_feedback(aws, 'f1', metadata={'email': REVIEWER})
        before = _sorted(aws['projects'].scan()['Items'])

        with calls_on_projects(aws) as calls:
            result = _erase_by_email(aws, worker_context)

        job = _failed(aws, result, NOT_BACKFILLED_ERROR)
        assert "ask the deployment's operator to run scripts/projects/backfill_review_registries.py --apply" in job[
            'error']
        assert 'then run the erasure again' in job['error']
        assert (job['review_registries'], job['phase']) == ('not_backfilled', 'registries')
        assert [_kind(call) for call in calls] == ['marker']
        assert _sorted(aws['projects'].scan()['Items']) == _sorted(before)
        assert (result['deleted_items'], _web_reviews(aws)) == (0, 1)
        [failed] = _emf(capsys, 'RetentionRunFailed')
        assert (failed['error_type'], failed['_aws']['CloudWatchMetrics'][0]['Dimensions']) == (
            NOT_BACKFILLED_ERROR, [['service'], ['service', 'error_type']])

    def test_with_a_gap_it_fails_by_name_reading_the_marker_the_index_and_the_registry_only(self, aws, worker_context):
        links = _seed_deployment(aws)
        _unlisted_live_project(aws)
        put_feedback(aws, 'f1', metadata={'email': REVIEWER})

        with calls_on_projects(aws) as calls:
            result = _erase_by_email(aws, worker_context)

        job = _failed(aws, result, INCOMPLETE_ERROR)
        assert '--unmark' in job['error']
        assert job['review_registries'] == 'incomplete'
        # The marker, then the index's one page and one BatchGetItem of its ids in PROJECT_IDS: nothing else.
        assert [_kind(call) for call in calls] == ['marker', 'index', 'registry']
        assert REVIEWER in _link(aws, links['live'])['audience']['emails']
        assert (result['deleted_items'], _web_reviews(aws)) == (0, 1)

    def test_with_complete_registries_it_completes(self, aws, worker_context):
        links = _seed_deployment(aws)

        result = _erase_by_email(aws, worker_context)

        job, _audit = erasure_rows(aws, JOB_ID)
        assert (result['status'], job['status'], job['review_registries']) == ('completed', 'completed', 'complete')
        assert (job['deployment_rows_found'], job['deployment_projects_walked']) == ('registry', True)
        assert result[PROJECT_COUNTER] == CHANGED
        assert _link(aws, links['live'])['audience']['emails'] == [OTHER_REVIEWER]

    def test_an_unmark_during_the_run_is_seen_at_the_next_invocation_before_it_deletes(self, aws, worker_context):
        put_feedback(aws, 'f1', metadata={'email': REVIEWER})
        event = erasure_job(aws, JOB_ID, 'email', REVIEWER, legal_basis=BASIS)
        run = {**runs.new_run({}, 'erase'), registries.RESULT: registries.REGISTRIES_COMPLETE, 'generation': 0}
        _unmark(aws)

        result = handler.handle_event({**event, 'phase': 'items', 'cursor': None, 'run': runs.carried_state(run)},
                                      worker_context)

        _failed(aws, result, NOT_BACKFILLED_ERROR)
        assert _web_reviews(aws) == 1


class TestEveryOtherRunOwesItsLineage:
    def test_a_window_without_the_marker_deletes_and_owes_then_a_later_run_marks_and_clears(self, aws, worker_context,
                                                                                         capsys):
        _cited_by_a_persona(aws, ['f1', 'f9'], date=days_ago(400))
        _retain_web(aws)
        _unmark(aws)

        owing = _window(worker_context)

        assert (owing['status'], owing['deleted_items'], _web_reviews(aws)) == ('completed', 1, 0)
        assert _persona(aws) == ['f1', 'f9']
        [audit] = _audits(aws)
        assert (audit['review_registries'], audit['lineage_owed']) == ('not_backfilled', True)
        assert 'the next daily retention window makes them on its own' in audit['incomplete_reason']
        assert "ask the deployment's operator" in audit['incomplete_reason']
        assert (audit['lineage_owed_reason'], audit['lineage_owed_mode']) == ('not_backfilled', 'retention')
        owed = _owed(aws)
        assert (owed['sources'], owed['runs']) == (['web'], [audit['run_id']])
        [line] = _emf(capsys, 'RetentionLineageOwed')
        assert line['error_type'] == 'not_backfilled'

        mark_review_registries_backfilled(aws['projects'])
        replay = _window(worker_context)

        assert (replay['status'], replay['deleted_items'], replay['artifacts_marked']) == ('completed', 0, 1)
        assert _persona(aws) == ['f9']
        assert (_owed(aws)['sources'], _owed(aws)['runs']) == ([], [])
        assert _audits(aws)[-1]['lineage_owed_replayed'] is True

    def test_a_daily_run_with_no_retention_window_still_replays_what_is_owed(self, aws, worker_context):
        """Review round 2: retention is opt-in (D5), so a deployment may retain nothing; its daily run still replays
        the lineage an erasure owed (the registries phase, then the lineage pass, nothing else) and clears the row."""
        _cited_by_a_persona(aws, ['f1', 'f9'])
        _unmark(aws)
        _erase_reviewer_one(aws, worker_context)
        assert (_owed(aws)['sources'], _persona(aws)) == (['web'], ['f1', 'f9'])
        mark_review_registries_backfilled(aws['projects'])

        result = _window(worker_context)

        assert (result['status'], result['deleted_items'], result['artifacts_marked']) == ('completed', 0, 1)
        assert _persona(aws) == ['f9']
        assert _owed(aws)['sources'] == []
        assert _audits(aws)[-1]['lineage_owed_replayed'] is True

    def test_a_daily_run_with_nothing_owed_and_no_window_reads_no_project(self, aws, worker_context):
        with calls_on_projects(aws) as calls:
            result = _window(worker_context)
        assert (result['status'], calls) == ('completed', [])

    def test_a_gap_during_a_window_deletes_and_owes(self, aws, worker_context):
        _cited_by_a_persona(aws, ['f1'], date=days_ago(400))
        _retain_web(aws)
        _unlisted_live_project(aws)

        result = _window(worker_context)

        assert (result['status'], result['deleted_items']) == ('completed', 1)
        [audit] = _audits(aws)
        assert (audit['review_registries'], audit['lineage_owed']) == ('incomplete', True)
        assert '--unmark' in audit['incomplete_reason']
        assert audit['lineage_owed_reason'] == 'incomplete'
        assert _owed(aws)['sources'] == ['web']
        assert _persona(aws) == ['f1']

    def test_an_erasure_by_author_without_the_marker_deletes_and_owes_and_names_the_erasures_reason(
            self, aws, worker_context):
        _cited_by_a_persona(aws, ['f1', 'f9'])
        _unmark(aws)

        result = _erase_reviewer_one(aws, worker_context)

        job, _audit = erasure_rows(aws, JOB_ID)
        assert (result['status'], job['status'], result['deleted_items']) == ('completed', 'completed', 1)
        assert (job['review_registries'], job['lineage_owed']) == ('not_backfilled', True)
        assert 'the next erasure of the deployment' in job['incomplete_reason']
        assert (job['lineage_owed_reason'], job['lineage_owed_mode']) == ('not_backfilled', 'erase')
        assert _owed(aws)['runs'] == [JOB_ID]
        mark_review_registries_backfilled(aws['projects'])
        # A later erasure that deletes nothing still replays what is owed.
        _erase_reviewer_one(aws, worker_context, job_id='er_00000000c0df')
        assert _persona(aws) == ['f9']

    def test_an_erasure_by_email_that_already_deleted_owes_before_it_fails(self, aws, worker_context):
        """An ``--unmark`` between two invocations of an erasure by email that has already deleted: it owes its
        lineage marks, then fails by name before its people walk."""
        _cited_by_a_persona(aws, ['f1'])
        event = erasure_job(aws, JOB_ID, 'email', REVIEWER, legal_basis=BASIS)
        run = {**runs.new_run({}, 'erase'), registries.RESULT: registries.REGISTRIES_COMPLETE, 'deleted_items': 1,
               'erased_sources': ['web']}
        _unmark(aws)

        result = handler.handle_event({**event, 'phase': 'workspace_projects', 'cursor': None,
                                       'run': runs.carried_state(run)}, worker_context)

        _failed(aws, result, NOT_BACKFILLED_ERROR)
        assert _owed(aws)['sources'] == ['web']

    def test_a_workspaces_own_job_has_no_registries_phase(self, aws, worker_context):
        _unmark(aws)
        _list_workspace(aws, WS, 'Alpha')
        put_workspace_feedback(aws, WS, 'f1', metadata={'email': REVIEWER})
        with calls_on_projects(aws) as calls:
            result = handler.handle_event(_named_job(aws, 'email', REVIEWER), worker_context)
        assert (result['status'], result['deleted_items']) == ('completed', 1)
        assert 'marker' not in [_kind(call) for call in calls]


class TestTheOwedRow:
    def test_it_holds_the_sources_and_a_bounded_list_of_runs(self, aws):
        for n in range(registries.MAX_OWED_RUNS + 5):
            registries.owe(aws['aggregates'], {**_run(), 'job_id': f'er_{n:012d}', 'erased_sources': ['web', f's{n % 2}'],
                                               registries.RESULT: registries.REGISTRIES_NOT_BACKFILLED})
        owed = _owed(aws)
        assert owed['sources'] == ['s0', 's1', 'web']
        assert (len(owed['runs']), owed['runs'][-1], owed['runs_more']) == (
            registries.MAX_OWED_RUNS, f'er_{registries.MAX_OWED_RUNS + 4:012d}', True)

    def test_a_clear_keeps_what_was_owed_after_the_replay_read_it(self, aws):
        registries.owe(aws['aggregates'], {**_run(), 'erased_sources': ['web'],
                                           registries.RESULT: registries.REGISTRIES_NOT_BACKFILLED})
        run = {**_run(), registries.RESULT: registries.REGISTRIES_COMPLETE}
        registries.load_owed(aws['aggregates'], run)
        assert run[registries.OWED_SOURCES] == ['web']
        registries.owe(aws['aggregates'], {**_run(), 'job_id': 'er_000000000002', 'erased_sources': ['tickets'],
                                           registries.RESULT: registries.REGISTRIES_NOT_BACKFILLED})
        registries.clear_owed(aws['aggregates'], run)
        assert _owed(aws)['sources'] == ['tickets', 'web']  # kept: the next complete run replays it all again

    def test_a_hand_over_carrying_more_owed_sources_than_a_row_holds_is_refused_not_cut(self):
        """Round 2 (q-2): a carried list past ``MAX_OWED_SOURCES`` fails the invocation; none is dropped."""
        sources = [f's{n:04d}' for n in range(registries.MAX_OWED_SOURCES + 1)]
        carried = {**runs.carried_state(runs.new_run({}, 'retention')), registries.OWED_SOURCES: sources,
                   registries.OWED_VERSION: 3}
        with pytest.raises(ValueError, match='owed sources'):
            runs.new_run({'run': carried}, 'retention')
        kept = runs.new_run({'run': {**carried, registries.OWED_SOURCES: sources[:-1]}}, 'retention')
        assert kept[registries.OWED_SOURCES] == sources[:-1]

    def test_the_lineage_pass_looks_up_the_owed_sources_too(self):
        assert lineage.lineage_sources({'erased_sources': ['web'], registries.OWED_SOURCES: ['tickets', 'web']}) == [
            'web', 'tickets']


class TestThePhaseHandsOver:
    def test_one_row_pages_check_each_project_in_order_and_find_the_later_gap(self, aws):
        for n in range(3):
            deployment_project(aws, f'proj_live_00000{n}')
        _unlisted_live_project(aws, 'proj_unlisted_9999', listed_at=LATER)
        run, at, checked = _run(), None, []
        first, second, third = _one_row_pages()
        with first, second, third:
            for _step in range(20):
                at = registries.step(aws['projects'], run, json.loads(json.dumps(at)) if at else None)
                if at is None:
                    break
                checked.append(at['gap_checked'])
        assert checked == [1, 2, 3]
        assert run[registries.RESULT] == registries.REGISTRIES_INCOMPLETE

    def test_the_handler_hands_the_phase_over_and_resumes_it(self, aws, worker_context, invoke_mock):
        for n in range(3):
            deployment_project(aws, f'proj_live_00000{n}')
        put_feedback(aws, 'f1', metadata={'email': REVIEWER})
        budget = iter([900_000])
        worker_context.get_remaining_time_in_millis.side_effect = lambda: next(budget, 0)
        first, second, third = _one_row_pages()
        with first, second, third:
            assert _erase_by_email(aws, worker_context)['status'] == 'continued'
            payload = invoke_mock.call_args.args[1]
            # One answer with time left: two one-row steps, then the hand-over, before any delete.
            assert (payload['phase'], payload['cursor']['gap_checked'], _web_reviews(aws)) == ('registries', 2, 1)
            worker_context.get_remaining_time_in_millis.side_effect = None
            assert handler.handle_event(payload, worker_context)['status'] == 'completed'
        assert erasure_rows(aws, JOB_ID)[0]['review_registries'] == 'complete'

    @pytest.mark.parametrize(('cursor', 'message'), [
        ({'gap_from': 'not a key', 'gap_checked': 0}, 'not a map'),
        ({'gap_from': None, 'gap_checked': 'x'}, 'gap count'),
        ({'gap_from': None, 'gap_checked': -1}, 'gap count'),
    ])
    def test_a_carried_phase_state_of_the_wrong_shape_fails_the_step(self, aws, cursor, message):
        with pytest.raises(ValueError, match=message):
            registries.step(aws['projects'], _run(), cursor)


class TestWhatTheCheckReads:
    def test_the_index_query_and_the_registry_lookup_read_only_keys(self, aws):
        deployment_project(aws, 'p1')
        with calls_on_projects(aws) as calls:
            registries.step(aws['projects'], _run(), None)
        [(_q, index)] = [call for call in calls if _kind(call) == 'index']
        [(_b, batch)] = [call for call in calls if _kind(call) == 'registry']
        names = index['ExpressionAttributeNames']
        assert {names[part.strip()] for part in index['ProjectionExpression'].split(',')} <= set(
            registries.INDEX_ATTRIBUTES)
        assert (index['Select'], index['ExpressionAttributeValues'][':p']) == ('SPECIFIC_ATTRIBUTES', project_type_pk())
        request = batch['RequestItems'][PROJECTS_TABLE]
        projected = {request['ExpressionAttributeNames'][part.strip()] for part in
                     request['ProjectionExpression'].split(',')}
        assert (projected, request['ConsistentRead']) == ({'pk', 'sk'}, True)

    def test_a_verification_fixtures_project_of_the_exact_shape_is_no_gap(self, aws):
        deployment_project(aws, 'p1')
        _unlisted_live_project(aws, f'proj_vf_{"a" * 24}')
        run = _run()
        assert registries.step(aws['projects'], run, None) is None
        assert run[registries.RESULT] == registries.REGISTRIES_COMPLETE
        _unlisted_live_project(aws, 'proj_vf_short')
        run = _run()
        registries.step(aws['projects'], run, None)
        assert run[registries.RESULT] == registries.REGISTRIES_INCOMPLETE

    def test_the_fixture_shape_is_exact_and_no_create_mints_it(self):
        """The provider's own ids are tested where it mints them (lambda/api/test/test_verification_fixture_provider.py
        ``test_every_minted_project_id_is_the_shape_the_retention_gap_check_passes``)."""
        assert is_verification_fixture_project(f'proj_vf_{"0123456789abcdef01234567"}')
        for other in ('proj_vf_', f'proj_vf_{"A" * 24}', f'proj_vf_{"a" * 25}', f'xproj_vf_{"a" * 24}',
                      timestamped_id('proj')):
            assert not is_verification_fixture_project(other)

    def test_an_owed_only_run_never_scans_a_store(self, worker_context):
        walk = handler.Walk({'aggregates': None}, worker_context, {}, runs.new_run({}, 'retention'), None, None,
                            lambda: True, owed_only=True)
        for phase in (handler.PHASE_ITEMS, handler.PHASE_RADAR):
            with pytest.raises(RuntimeError, match='owed lineage only'):
                handler._walk_store(walk, phase, None)

    def test_no_walk_module_scans(self):
        """The fallback is gone: no walk module calls a Scan (the backfill keeps its own)."""
        for module in (workspaces, project_people, lineage, registries):
            source = Path(str(module.__file__)).read_text(encoding='utf-8')
            assert re.search(r'\.scan\(', source) is None, module.__name__
            assert 'scan_page' not in source


class TestACursorCarriedAcrossTheUpgrade:
    def test_a_scan_cursor_of_7_84_starts_the_deployments_walk_again(self, aws):
        _seed_deployment(aws)
        run = _run()
        eraser = project_people.ProjectPeopleEraser(run, _tables(aws), REVIEWER, aws['s3'], BUCKET)
        carried = {project_people.DEPLOYMENT: {'found': 'scan', 'links_done': True,
                                               'pairs_from': {'pk': 'x', 'sk': 'y'}}}
        with calls_on_projects(aws) as calls:
            cursor = eraser.step({'ws': [], **carried})
        assert cursor is not None
        assert [operation for operation, _params in calls if operation == 'Scan'] == []
        for _step in range(500):
            cursor = eraser.step(cursor)
            if cursor is None:
                break
        assert run[PROJECT_COUNTER] == CHANGED

    def test_a_scan_cursor_of_the_lineage_pass_starts_it_again(self, aws):
        deployment_project(aws, 'p1')
        moved = lineage.deployment_step(aws['projects'], aws['aggregates'], _run(),
                                        {'found': 'scan', 'projects_from': {'pk': 'x'}})
        assert (moved or {}).get('ids') == ['p1']

    def test_a_hand_over_from_7_84_without_a_result_reads_the_marker_only(self, aws, worker_context):
        _cited_by_a_persona(aws, ['f1'])
        event = erasure_job(aws, JOB_ID, 'author', 'Reviewer One', legal_basis=BASIS)
        run = runs.new_run({}, 'erase')
        result = handler.handle_event({**event, 'phase': 'items', 'cursor': None, 'run': runs.carried_state(run)},
                                      worker_context)
        assert (result['status'], result['deleted_items']) == ('completed', 1)
        assert erasure_rows(aws, JOB_ID)[0]['review_registries'] == 'complete'
        assert _persona(aws) == []


def _radar_fails(error: Exception) -> Any:
    """The radar phase (after the items, before the lineage pass) failing with ``error``."""
    def boom(_walk: Any, _cursor: Any) -> None:
        raise error
    return patch.dict(handler._PHASE_RUNNERS, {handler.PHASE_RADAR: boom})


class TestEveryFailurePathOwes:
    """Review round 2 (R2-1, R2-2): a run that deleted and then fails before its lineage pass owes the pass, on every
    failure path, and every failure is counted by the alarm's metric."""

    def test_a_window_that_deletes_then_fails_in_radar_owes_and_the_next_run_marks(self, aws, worker_context, capsys):
        _cited_by_a_persona(aws, ['f1', 'f9'], date=days_ago(400))
        _retain_web(aws)

        with _radar_fails(RuntimeError('radar down')):
            failed = _window(worker_context)

        assert (failed['status'], failed['deleted_items'], _persona(aws)) == ('failed', 1, ['f1', 'f9'])
        assert _owed(aws)['sources'] == ['web']
        [audit] = _audits(aws)
        assert (audit['lineage_owed'], audit['review_registries']) == (True, 'complete')
        assert 'failed before its lineage marks' in audit['incomplete_reason']
        assert audit['lineage_owed_reason'] == 'failed_before_marks'
        assert [line['error_type'] for line in _emf(capsys, registries.FAILED_METRIC)] == ['RuntimeError']
        replay = _window(worker_context)
        assert (replay['status'], replay['artifacts_marked'], _persona(aws)) == ('completed', 1, ['f9'])
        assert _owed(aws)['sources'] == []

    def test_a_run_stopped_after_too_many_hand_overs_owes_and_is_counted(self, aws, worker_context, capsys):
        _retain_web(aws)
        run = {**runs.new_run({}, 'retention'), 'generation': handler.MAX_GENERATIONS - 1, 'deleted_items': 1,
               'erased_sources': ['web'], registries.RESULT: registries.REGISTRIES_COMPLETE}

        result = handler.handle_event({'mode': 'retention', 'phase': 'items', 'cursor': None,
                                       'run': runs.carried_state(run)}, worker_context)

        assert result['status'] == 'failed'
        assert _owed(aws)['sources'] == ['web']
        assert [line['error_type'] for line in _emf(capsys, registries.FAILED_METRIC)] == ['TooManyHandOvers']

    def test_an_unexpected_exception_is_counted_owes_and_still_raises(self, aws, worker_context, capsys):
        _cited_by_a_persona(aws, ['f1'], date=days_ago(400))
        _retain_web(aws)

        with _radar_fails(KeyError('x')), pytest.raises(KeyError):
            _window(worker_context)

        assert [line['error_type'] for line in _emf(capsys, registries.FAILED_METRIC)] == ['KeyError']
        assert _owed(aws)['sources'] == ['web']

    def test_a_run_whose_lineage_pass_ended_owes_nothing_when_it_fails_after(self, aws, worker_context):
        _cited_by_a_persona(aws, ['f1', 'f9'], date=days_ago(400))
        _retain_web(aws)
        # The workspaces' lineage phase, after the deployment's pass, made to run and fail.
        with patch.dict(handler._PHASE_RUNNERS, {handler.PHASE_WORKSPACE_LINEAGE: _boom_after_lineage}), \
                patch.object(handler.lineage, 'has_work', return_value=True):
            result = _window(worker_context)
        assert (result['status'], _persona(aws)) == ('failed', ['f9'])
        assert _owed(aws).get('sources', []) == []

    @pytest.mark.parametrize('owe_fails', [
        pytest.param(lambda: patch.object(registries, 'MAX_OWED_SOURCES', 0), id='too-many-owed-sources'),
        pytest.param(lambda: patch.object(registries, '_put_versioned', return_value=False), id='kept-changing'),
        pytest.param(lambda: patch.object(registries, '_put_versioned', side_effect=ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow down'}}, 'PutItem')),
                     id='client-error'),
    ])
    def test_a_run_whose_owe_fails_still_says_its_lineage_is_owed(self, aws, worker_context, capsys, owe_fails):
        """Round 2 (q-1, fp-3): the owed row could not be written, so the run's own rows and the metric say so."""
        _cited_by_a_persona(aws, ['f1', 'f9'], date=days_ago(400))
        _retain_web(aws)

        with _radar_fails(RuntimeError('radar down')), owe_fails():
            failed = _window(worker_context)

        assert (failed['status'], failed['deleted_items']) == ('failed', 1)
        [audit] = _audits(aws)
        assert audit['lineage_owed'] is True
        assert 'could not be recorded' in audit['incomplete_reason']
        assert audit['lineage_owed_reason'] == 'owe_failed'
        assert 'RuntimeError' in audit['error']
        assert _owed(aws).get('sources', []) == []
        lines = capsys.readouterr().out
        assert [line['error_type'] for line in _emf_of(lines, registries.OWED_METRIC)] == [registries.OWE_FAILED]
        assert [line['error_type'] for line in _emf_of(lines, registries.FAILED_METRIC)] == ['RuntimeError']

    def test_too_many_owed_sources_is_named(self, aws):
        with patch.object(registries, 'MAX_OWED_SOURCES', 1), pytest.raises(registries.TooManyOwedSources):
            registries.owe(aws['aggregates'], {**_run(), 'erased_sources': ['web', 'tickets'],
                                               registries.RESULT: registries.REGISTRIES_NOT_BACKFILLED})
        assert _owed(aws) == {}

    def test_an_owed_row_that_kept_changing_is_named(self, aws):
        with patch.object(registries, '_put_versioned', return_value=False), pytest.raises(
                RuntimeError, match='kept changing'):
            registries.owe(aws['aggregates'], {**_run(), 'erased_sources': ['web'],
                                               registries.RESULT: registries.REGISTRIES_NOT_BACKFILLED})

    @pytest.mark.parametrize(('original', 'named'), [(RuntimeError('radar down'), True), (KeyError('x'), False)])
    def test_an_unexpected_error_while_owing_never_hides_the_runs_own_failure(self, aws, worker_context, capsys,
                                                                              original, named):
        """Round 2 (q-10): ``_owe_after_failure`` raising outside what it expects leaves the original failure the one
        recorded (a named failure) or raised (an unexpected one), and the run still says its lineage is owed."""
        _cited_by_a_persona(aws, ['f1'], date=days_ago(400))
        _retain_web(aws)

        with _radar_fails(original), patch.object(registries, 'owe', side_effect=ZeroDivisionError('owe')):
            if named:
                result = _window(worker_context)
                assert result['status'] == 'failed'
                [audit] = _audits(aws)
                assert ('RuntimeError' in audit['error'], audit['lineage_owed']) == (True, True)
            else:
                with pytest.raises(KeyError):
                    _window(worker_context)
        assert [line['error_type'] for line in _emf(capsys, registries.OWED_METRIC)] == [registries.OWE_FAILED]


def _boom_after_lineage(_walk: Any, _cursor: Any) -> None:
    raise RuntimeError('a phase after the lineage pass')


class TestEveryRunThatCannotReplaySaysSo:
    """R2-3: while something is owed and the registries are not complete, every run says the lineage is owed and
    prints the metric, the daily run that only replays included."""

    def test_an_owed_only_daily_run_without_the_marker_says_owed(self, aws, worker_context, capsys):
        registries.owe(aws['aggregates'], {**_run(), 'erased_sources': ['web'],
                                           registries.RESULT: registries.REGISTRIES_NOT_BACKFILLED})
        capsys.readouterr()
        _unmark(aws)

        result = _window(worker_context)

        assert result['status'] == 'completed'
        audit = _audits(aws)[-1]
        assert (audit['review_registries'], audit['lineage_owed']) == ('not_backfilled', True)
        assert "ask the deployment's operator" in audit['incomplete_reason']
        assert [line['error_type'] for line in _emf(capsys, registries.OWED_METRIC)] == ['not_backfilled']
        assert _owed(aws)['sources'] == ['web']


class TestTheRegistriesPhaseResumed:
    """R2-4: the marker is read again when the ``registries`` phase resumes with a cursor, before any delete."""

    _CURSOR: Final = {'gap_from': {'pk': 'PROJECT#p1', 'sk': 'META', 'gsi1pk': 'TYPE#PROJECT', 'gsi1sk': STAMP},
                      'gap_checked': 1}

    def test_an_erasure_by_email_resumed_mid_phase_after_an_unmark_fails_before_it_deletes(self, aws,
                                                                                         worker_context):
        put_feedback(aws, 'f1', metadata={'email': REVIEWER})
        event = erasure_job(aws, JOB_ID, 'email', REVIEWER, legal_basis=BASIS)
        _unmark(aws)

        result = handler.handle_event({**event, 'phase': 'registries', 'cursor': dict(self._CURSOR),
                                       'run': runs.carried_state(runs.new_run({}, 'erase'))}, worker_context)

        _failed(aws, result, NOT_BACKFILLED_ERROR)
        assert _web_reviews(aws) == 1

    def test_a_window_resumed_mid_phase_after_an_unmark_deletes_and_owes(self, aws, worker_context):
        _cited_by_a_persona(aws, ['f1'], date=days_ago(400))
        _retain_web(aws)
        _unmark(aws)

        result = handler.handle_event({'mode': 'retention', 'phase': 'registries', 'cursor': dict(self._CURSOR),
                                       'run': runs.carried_state(runs.new_run({}, 'retention'))}, worker_context)

        assert (result['status'], result['deleted_items']) == ('completed', 1)
        assert (_audits(aws)[-1]['review_registries'], _owed(aws)['sources']) == ('not_backfilled', ['web'])


class TestTheAlarm:
    """shared/ops_alerts.py's retention alarm (created at runtime, as every alert, once an admin turns alerting on):
    the metrics the worker prints (registries.py ``emit``), by the worker's service."""

    BASE: Final = {'OPS_ALERTS_TOPIC_ARN': 'arn:aws:sns:us-east-1:123456789012:voc-ops-alarms',
                   'OPS_ALERTS_ALARM_PREFIX': 'voc-alerts-123456789012-us-east-1'}

    def _alarms(self, env: dict[str, str]) -> dict[str, dict[str, Any]]:
        targets = ops_alerts.load_targets(env)
        assert targets is not None
        prefix = f"{self.BASE['OPS_ALERTS_ALARM_PREFIX']}-"
        return {d['AlarmName'].removeprefix(prefix): d for d in ops_alerts.alarm_definitions(targets)}

    def test_no_alarm_without_the_service(self):
        assert 'retention-runs' not in self._alarms(self.BASE)

    def test_one_alarm_sums_the_failed_and_owed_metrics_of_the_worker(self):
        alarm = self._alarms({**self.BASE, 'OPS_ALERTS_RETENTION_SERVICE': 'voc-retention'})['retention-runs']
        stats = [metric['MetricStat']['Metric'] for metric in alarm['Metrics'] if 'MetricStat' in metric]
        assert [(stat['Namespace'], stat['MetricName'], stat['Dimensions']) for stat in stats] == [
            (registries.METRICS_NAMESPACE, metric, [{'Name': 'service', 'Value': 'voc-retention'}])
            for metric in (registries.FAILED_METRIC, registries.OWED_METRIC)]
        assert ops_alerts.RETENTION_ALARM_METRICS == (registries.FAILED_METRIC, registries.OWED_METRIC)
        assert (alarm['Metrics'][-1]['Expression'], alarm['Threshold'], alarm['TreatMissingData']) == (
            'SUM([m0,m1])', 0, 'notBreaching')
        # q-6: the sum names exactly the metric ids it is given.
        ids = [metric['Id'] for metric in alarm['Metrics'] if 'MetricStat' in metric]
        assert alarm['Metrics'][-1]['Expression'] == f"SUM([{','.join(ids)}])"
        assert ops_alerts.billed_metric_count([alarm]) == 2
        # R2-2: it names every failure it counts, an unexpected error and the hand-over cap included; fp-4: and what it
        # cannot count (a run the handler never sees fail); q-1: an owed row that could not be written.
        for words in ('an unexpected error', 'too many hand-overs', 'owes its lineage marks', 'as the worker saw it',
                      'a timeout or a killed run shows in its Lambda Errors instead', 'its owed row could not be written'):
            assert words in alarm['AlarmDescription']
        assert len(alarm['AlarmDescription']) <= 1024
