"""voc-retention reaches the deployment's own projects (7.48.00, projects 3g-d; TENETS.md D5; docs/multi-workspace.md,
the project plan's 3g-d).

End to end in moto. The deployment's rows are written by their own stores (``create_share``, ``revoke_share``,
``put_thread``, and a project's create, without a workspace), which since 7.48.00 also list the deployment's links
(``DOCSHARE_IDS``), commented series (``COMMENT_SERIES_IDS``) and projects (``PROJECT_IDS``); older rows (no registry
row) are listed by the backfill (scripts/projects/backfill_review_registries.py). An erasure by email de-identifies the
address in a deployment link's audience (a revoked one too), the threads and replies (a deleted project's too), a
``META`` (a deleted or half-deleted project's too) and a persona's research note, by the same code as a workspace's;
lists for review a product document whose extracted text holds it (every kind alike: a PDF, an image's description),
and as not checked only one with no text; finds the links, series and projects by the registries, which since 7.93.00
(3g-d2) require the backfill's marker (no Scan: test_registries_required.py; the conftest's tables carry the marker);
leaves every workspace's rows to the workspace's walk and the other way round; and a walk handed over after every step
ends as one that never was.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import UTC, datetime, timedelta
from typing import Any, Final
from unittest.mock import patch

import pytest
from boto3.dynamodb.conditions import Key

from jobs.retention import boards, handler, project_people, registries, runs, workspaces
from jobs.retention.test.conftest import BUCKET, PROJECTS_TABLE, erasure_job, erasure_rows, put_feedback
from jobs.retention.test.test_named_workspace_erasure import _job as _named_job
from jobs.retention.test.test_project_erasure import (
    DEP_GONE,
    DEP_LIVE,
    DEP_MEMBER,
    DEP_OWNER,
    LEAD,
    LIVE,
    OTHER_REVIEWER,
    REVIEWER,
    REVIEWER_NAME,
    SERIES,
    SERIES_TWO,
    STAMP,
    A,
    _dep_docs,
    _erase_by_email,
    _list_workspace,
    _meta,
    _one_row_pages,
    _row,
    _run,
    _seed,
    _seed_deployment,
    _sorted,
    _tables,
    _threads,
    _walk_to_the_end,
    deployment_project,
    reseed,
    scans_of,
)
from jobs.retention.test.test_workspace_erasure import BASIS, JOB_ID, WS, _tombstones
from shared import document_comments as comments
from shared import document_share as ds
from shared import project_walk
from shared.project_keys import (
    comments_pk,
    deployment_link_registry_key,
    project_pk,
    project_type_pk,
    review_link_key,
)
from shared.retention import DOCS_NOT_CHECKED_COUNTER, MALFORMED_ID_COUNTER, PROJECT_COUNTER
from shared.test.repo_paths import load_module_from_path, repo_root
from shared.ws_repo import OutOfScopeError

#: A complete marker, as the backfill writes it (an incomplete one reads as absent).
MARKER: Final = {'pk': 'DOCSHARE_IDS', 'sk': 'MIGRATION#review-registries', 'completed_at': STAMP, 'links_found': 0,
                 'series_found': 0, 'projects_found': 0, 'release': '7.48.0'}
#: The rows the seeded erasure of REVIEWER changes: two links, four threads, the deleted project's META, a persona.
CHANGED: Final = 8


@pytest.fixture
def projects_env(monkeypatch):
    monkeypatch.setenv('PROJECTS_TABLE', PROJECTS_TABLE)


@pytest.fixture
def backfill():
    module = load_module_from_path('backfill_review_registries', repo_root() / 'scripts' / 'projects'
                                   / 'backfill_review_registries.py')
    try:
        yield module
    finally:
        sys.modules.pop(module.__name__, None)


def ready_writers(updated: datetime) -> list[dict[str, Any]]:
    """The two writers of links and threads as the backfill reads them, both on 7.48.0, last updated ``updated``."""
    return [{'name': f'{base}-1-r', 'base': base, 'version': '7.48.0', 'last_modified': updated,
             'status': 'Successful', 'timeout': 900}
            for base in ('voc-projects-api', 'voc-projects-assist')]


def _with_marker(aws) -> None:
    aws['projects'].put_item(Item=dict(MARKER))


def _unmark(aws) -> None:
    aws['projects'].delete_item(Key={'pk': MARKER['pk'], 'sk': MARKER['sk']})


def _registries(aws, pk: str) -> list[str]:
    """The sort keys of one of the deployment's registries, the backfill's own rows (``MIGRATION#…``) left out."""
    rows = aws['projects'].query(KeyConditionExpression=Key('pk').eq(pk))['Items']
    return sorted(str(row['sk']) for row in rows if not str(row['sk']).startswith('MIGRATION#'))


def _deployment_records(aws) -> dict[str, dict[str, Any]]:
    return _tombstones(aws, project_people.STORE_DEPLOYMENT_PROJECTS)


def _member_thread(text: str) -> dict[str, Any]:
    """A team member's thread on project p1's series, as the routes build it."""
    return comments.thread_item(project_id='p1', series_id=SERIES['series_id'],
                                document={'document_id': 'd', 'version': 1},
                                author=comments.user_author('s', LEAD), text=text, anchor=None)


def _link(aws, share: dict[str, Any]) -> dict[str, Any]:
    return _row(aws, review_link_key(share['share_id']))


def _everything(aws) -> dict[str, Any]:
    """Every project row, and every record of either scope without its time and run."""
    records = [{name: value for name, value in row.items() if name not in ('deleted_at', 'run_id')}
               for store in (project_people.STORE_PROJECTS, project_people.STORE_DEPLOYMENT_PROJECTS)
               for row in _tombstones(aws, store).values()]
    return {'projects': _sorted(aws['projects'].scan()['Items']),
            'records': sorted(records, key=lambda row: (str(row['pk']), str(row['sk'])))}


@pytest.mark.usefixtures('projects_env')
class TestAnErasureByEmailReachesTheDeploymentsProjects:
    def test_every_row_that_holds_the_address_is_de_identified(self, aws, worker_context):
        links = _seed_deployment(aws)

        result = _erase_by_email(aws, worker_context, REVIEWER.upper())

        live, revoked = _link(aws, links['live']), _link(aws, links['revoked'])
        assert (live['audience'], live['revoked']) == (
            {'mode': 'list', 'emails': [OTHER_REVIEWER], 'domains': ['partner.example']}, False)
        # A revoked link (its series' pointer gone, found through the registry) loses the address and stays revoked.
        assert (revoked['audience']['emails'], revoked['revoked'], revoked['revoked_by']) == ([], True, LEAD)
        for project_id in (DEP_LIVE, DEP_GONE):
            member, reviewer = _threads(aws, project_id, None)
            assert (reviewer['author'], reviewer['text']) == ({'kind': 'reviewer'}, 'Reviewer note')
            assert member['replies'][0]['author'] == {'kind': 'reviewer'}
            assert member['author'] == {'kind': 'user', 'sub': 'sub-lead', 'name': LEAD}
        assert 'owner_email' not in _meta(aws, DEP_GONE, None)
        assert _meta(aws, DEP_LIVE, None)['owner_email'] == DEP_OWNER
        persona = _row(aws, {'pk': project_pk(DEP_LIVE), 'sk': 'PERSONA#per_1'})
        assert persona['research_notes'][0]['author'] == comments.TEAM_MEMBER_NAME
        assert result[PROJECT_COUNTER] == CHANGED

    def test_the_registries_are_walked_by_query_and_nothing_is_scanned(self, aws, worker_context):
        _seed_deployment(aws)
        with scans_of(aws) as scanned:
            first = _erase_by_email(aws, worker_context)
            again = _erase_by_email(aws, worker_context, DEP_MEMBER, job_id='er_00000000c0df')
        assert scanned == []
        assert (first[PROJECT_COUNTER], again[PROJECT_COUNTER]) == (CHANGED, 1)  # then the live project's member

    def test_a_document_is_judged_by_its_extracted_text_of_any_kind(self, aws, worker_context):
        _seed_deployment(aws)

        result = _erase_by_email(aws, worker_context)

        job, audit = erasure_rows(aws, JOB_ID)
        folder = _dep_docs(DEP_LIVE)
        # The PDF's text names the reviewer; the image's description does not; the PDF not extracted yet is not
        # checked, by its upload's key; the live project's folder is not listed whole, the deleted one's is (round 3:
        # an object its delete could not remove outlives its record).
        assert job['files_needing_review']['keys'] == audit['files_needing_review']['keys'] == [
            f'{folder}raw/pd_1.pdf']
        assert sorted(job['files_not_checked']['keys']) == sorted([f'{folder}raw/pd_3.pdf', _dep_docs(DEP_GONE)])
        assert result[DOCS_NOT_CHECKED_COUNTER] == 2
        # The deployment's projects have no export: no workspace's is closed.
        assert 'erased_workspaces' not in result

    def test_only_the_extracted_text_is_read_in_the_deployment(self, aws):
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER, aws['s3'], BUCKET)
        folder = _dep_docs(DEP_LIVE)
        aws['s3'].put_object(Bucket=BUCKET, Key=f'{folder}raw/a.md', Body=f'Ask {REVIEWER}'.encode())
        with patch.object(eraser, '_holds_address', wraps=eraser._holds_address) as read:
            # A text upload not extracted: not read (the grant is on extracted/ only), not checked.
            eraser._product_doc(None, DEP_LIVE, {'sk': 'PRODUCT_DOC#a', 'status': 'failed',
                                                 's3_raw_key': f'{folder}raw/a.md'})
            # Ready but its text elsewhere: not read either.
            eraser._product_doc(None, DEP_LIVE, {'sk': 'PRODUCT_DOC#b', 'status': 'ready',
                                                 's3_raw_key': f'{folder}raw/b.png',
                                                 's3_extracted_key': 'elsewhere/b.txt'})
        read.assert_not_called()
        assert eraser._run[runs.UNCHECKED_FILES] == [f'{folder}raw/a.md', f'{folder}raw/b.png']
        # A filename that holds the address is listed whatever its text.
        eraser._product_doc(None, DEP_LIVE, {'sk': 'PRODUCT_DOC#c', 'filename': f'{REVIEWER}.pdf',
                                             's3_raw_key': f'{folder}raw/c.pdf'})
        assert eraser._run['review_files'] == [f'{folder}raw/c.pdf']

    def test_each_change_is_recorded_without_the_address_the_link_id_or_a_workspace(self, aws, worker_context):
        links = _seed_deployment(aws)

        _erase_by_email(aws, worker_context)

        records = _deployment_records(aws)
        done = {sk: row for sk, row in records.items() if sk.endswith('#done')}
        assert (len(records), len(done)) == (2 * CHANGED, CHANGED)
        assert {row['kind'] for row in records.values()} == {'thread', 'link', 'project', 'persona'}
        assert all('workspace_id' not in row and row['source'] == 'deployment_projects' for row in records.values())
        assert all(sk.endswith((f'#{JOB_ID}', f'#{JOB_ID}#done')) for sk in records)
        text = json.dumps(list(records.values()), default=str)
        assert REVIEWER not in text
        assert REVIEWER_NAME not in text
        assert not any(share['share_id'] in text for share in links.values())
        assert _tombstones(aws, project_people.STORE_PROJECTS) == {}

    def test_nothing_matched_changes_nothing(self, aws, worker_context):
        _seed_deployment(aws)
        before = aws['projects'].scan()['Items']
        result = _erase_by_email(aws, worker_context, 'nobody@example.com')
        assert _sorted(aws['projects'].scan()['Items']) == _sorted(before)
        assert PROJECT_COUNTER not in result

    def test_malformed_registry_rows_are_counted_and_the_backfills_rows_are_not(self, aws, worker_context):
        _with_marker(aws)
        for item in ({**deployment_link_registry_key('shr_bad')}, {'pk': 'COMMENT_SERIES_IDS', 'sk': 'p1#ser_x'},
                     {'pk': 'COMMENT_SERIES_IDS', 'sk': 'bad#id#ser_' + 'a' * 24}, {'pk': 'PROJECT_IDS', 'sk': 'bad#id'},
                     # A stopped backfill's progress row (``MIGRATION#…``), beside the marker.
                     {'pk': 'DOCSHARE_IDS', 'sk': 'MIGRATION#review-registries#progress', 'run_id': 'r'}):
            aws['projects'].put_item(Item=item)

        result = _erase_by_email(aws, worker_context)

        # The marker and the progress row are the backfill's own rows, never counted; the four others are.
        assert result[MALFORMED_ID_COUNTER] == 4


@pytest.mark.usefixtures('projects_env')
class TestTheRowsMadeBeforeTheRegistries:
    @staticmethod
    def _legacy(aws) -> dict[str, str]:
        """Rows as the stores wrote them before 7.48.00, with no registry row: a revoked link whose series' pointer
        is gone, a deleted project's reviewer thread, and that project's tombstoned META (off the index, as the
        delete's fence leaves it, naming the reviewer as its owner)."""
        revoked = 'shr_' + '7' * 32
        aws['projects'].put_item(Item={**review_link_key(revoked), 'share_id': revoked, 'project_id': DEP_LIVE,
                                       'series_id': SERIES_TWO['series_id'], 'revoked': True, 'revoked_by': LEAD,
                                       'audience': {'mode': 'list', 'emails': [REVIEWER], 'domains': []}})
        thread = comments.thread_item(project_id=DEP_GONE, series_id=SERIES['series_id'],
                                      document={'document_id': 'doc_1', 'version': 1},
                                      author=comments.reviewer_author(REVIEWER, REVIEWER_NAME), text='Old note',
                                      anchor=None)
        aws['projects'].put_item(Item=thread)
        aws['projects'].put_item(Item={'pk': project_pk(DEP_GONE), 'sk': 'META', 'project_id': DEP_GONE,
                                       'status': 'deleted', 'deleted_at': STAMP, 'owner_email': REVIEWER})
        return {'revoked': revoked}

    def _assert_reached(self, aws, legacy: dict[str, str]) -> None:
        link = _row(aws, review_link_key(legacy['revoked']))
        assert (link['audience']['emails'], link['revoked']) == ([], True)
        [thread] = _threads(aws, DEP_GONE, None)
        assert thread['author'] == {'kind': 'reviewer'}
        assert 'owner_email' not in _meta(aws, DEP_GONE, None)

    def test_the_erasure_refuses_them_until_the_backfill_then_reaches_them_by_query(self, aws, worker_context,
                                                                                   backfill):
        legacy = self._legacy(aws)
        _unmark(aws)
        with scans_of(aws) as scanned:
            refused = _erase_by_email(aws, worker_context, job_id='er_00000000beef')
        # 7.93.00: no Scan finds them any more; the job fails by name and its row says to run the backfill.
        assert (scanned, refused['status']) == ([], 'failed')
        assert _row(aws, review_link_key(legacy['revoked']))['audience']['emails'] == [REVIEWER]

        drained = datetime(2026, 11, 1, tzinfo=UTC)
        report = backfill.run(aws['projects'], apply=True, now=lambda: STAMP, clock=lambda: drained + timedelta(hours=1),
                              deployed=lambda: ready_writers(drained))
        assert report.marked
        assert _row(aws, {'pk': 'PROJECT_IDS', 'sk': DEP_GONE})['created_at'] == STAMP

        with scans_of(aws) as scanned:
            _erase_by_email(aws, worker_context)

        assert scanned == []
        self._assert_reached(aws, legacy)


@pytest.mark.usefixtures('projects_env')
class TestTheDeploymentAndTheWorkspacesStayApart:
    def test_the_deployments_walk_leaves_every_workspaces_rows(self, aws):
        _seed(aws)
        _seed_deployment(aws)
        workspace_rows = [row for row in aws['projects'].scan()['Items'] if str(row['pk']).startswith('WS#')]
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER, aws['s3'], BUCKET)
        cursor = eraser.step(None)
        while cursor is not None and project_people.DEPLOYMENT in cursor:
            cursor = eraser.step(cursor)
        after = [row for row in aws['projects'].scan()['Items'] if str(row['pk']).startswith('WS#')]
        assert _sorted(after) == _sorted(workspace_rows)
        assert eraser._run[PROJECT_COUNTER] == CHANGED
        # Then the listed workspaces, as before.
        assert cursor is not None
        assert (cursor['ws'], cursor['listing_done']) == ([], False)

    def test_a_workspaces_own_erasure_leaves_the_deployments_rows(self, aws, worker_context):
        _seed(aws)
        _seed_deployment(aws)
        deployment_rows = [row for row in aws['projects'].scan()['Items'] if not str(row['pk']).startswith('WS#')]

        handler.handle_event(_named_job(aws, 'email', REVIEWER), worker_context)

        after = [row for row in aws['projects'].scan()['Items'] if not str(row['pk']).startswith('WS#')]
        assert _sorted(after) == _sorted(deployment_rows)
        assert _threads(aws, LIVE, A)[1]['author'] == {'kind': 'reviewer'}

    def test_a_one_workspace_job_refuses_a_cursor_carrying_the_deployments_walk(self, aws):
        run = {**_run(), 'workspace_id': WS}
        with pytest.raises(ValueError, match="deployment's walk"):
            project_people.ProjectPeopleEraser(run, _tables(aws), REVIEWER).step(
                {'ws': [WS], 'listing_done': True, 'at': {}, project_people.DEPLOYMENT: {}})

    @pytest.mark.parametrize(('cursor', 'message'), [
        ({project_people.DEPLOYMENT: 'x'}, 'not a map'),
        ({project_people.DEPLOYMENT: {'links': ['shr_nope']}},
         'not a page of ids'),
        ({project_people.DEPLOYMENT: {'links_done': True,
                                      'pairs': ['p#ser_x']}}, 'not a page'),
        ({project_people.DEPLOYMENT: {'links_from': 'x'}}, 'not a map'),
    ])
    def test_a_carried_deployment_cursor_of_the_wrong_shape_fails_the_step(self, aws, cursor, message):
        with pytest.raises(ValueError, match=message):
            project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER).step({'ws': [], **cursor})

    def test_without_voc_workspaces_the_deployments_projects_are_still_walked(self, aws):
        _seed_deployment(aws)
        tables = {name: table for name, table in _tables(aws).items() if name != 'workspace_members'}
        run = {**_run()}
        assert project_people.applies(run, tables)
        eraser = project_people.ProjectPeopleEraser(run, tables, REVIEWER, aws['s3'], BUCKET)
        cursor, steps = eraser.step(None), 1
        while cursor is not None and steps < 500:
            cursor, steps = eraser.step(cursor), steps + 1
        assert (cursor, run[PROJECT_COUNTER]) == (None, CHANGED)


@pytest.mark.usefixtures('projects_env')
class TestTheDeploymentsWalkHandsOver:
    def test_a_walk_resumed_after_every_step_ends_as_one_that_never_was(self, aws):
        _list_workspace(aws, WS, 'Alpha')
        _seed_deployment(aws)
        # More threads than a page, so each series takes several pages, every one resumed from a key.
        for n in range(3):
            aws['projects'].put_item(Item=comments.thread_item(
                project_id=DEP_LIVE, series_id=SERIES['series_id'], document={'document_id': 'd', 'version': 1},
                author=comments.reviewer_author(REVIEWER), text=f'More {n}', anchor=None))
        before = aws['projects'].scan()['Items']
        one_run, _steps = _walk_to_the_end(aws, hand_over_each_step=False)
        expected = _everything(aws)
        reseed(aws, before)

        first, second, third = _one_row_pages()
        with first, second, third:
            run, steps = _walk_to_the_end(aws, hand_over_each_step=True)

        assert steps > 40
        assert _everything(aws) == expected
        assert run[PROJECT_COUNTER] == one_run[PROJECT_COUNTER] == CHANGED + 3
        assert run['review_files'] == one_run['review_files'] == [f'{_dep_docs(DEP_LIVE)}raw/pd_1.pdf']
        assert run[runs.UNCHECKED_FILES] == one_run[runs.UNCHECKED_FILES]

    def test_a_page_of_threads_is_cut_after_a_row_when_the_time_runs_low(self, aws):
        _seed_deployment(aws)
        pair = f"{DEP_LIVE}#{SERIES['series_id']}"
        first, second = sorted(_threads(aws, DEP_LIVE, None), key=lambda row: row['sk'])
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER, time_left=lambda: False)
        at = {'links_done': True, 'pairs_done': True, 'pairs': [pair], 'threads_from': None}
        moved = eraser._threads_step(None, dict(at))
        assert (moved['threads_from'], moved['pairs']) == (
            {'pk': comments_pk(DEP_LIVE, SERIES['series_id']), 'sk': first['sk']}, [pair])
        assert _threads(aws, DEP_LIVE, None)[1]['author']['email'] == REVIEWER  # the second, not yet
        after = eraser._threads_step(None, json.loads(json.dumps(moved)))
        assert (after['pairs'], after['threads_from']) == ([], None)
        # The resumed page de-identified the second thread too.
        assert [row['author'] for row in sorted(_threads(aws, DEP_LIVE, None), key=lambda row: row['sk'])][1] == {
            'kind': 'reviewer'}
        assert second['sk'] > first['sk']

    @pytest.mark.parametrize(('at', 'state'), [
        ({}, 'link_pages'),
        ({'links': ['shr_' + 'a' * 32]}, 'link'),
        ({'links_done': True}, 'pair_pages'),
        ({'links_done': True, 'pairs': ['p#ser_' + 'a' * 24]}, 'threads'),
        ({'links_done': True, 'pairs_done': True}, 'projects'),
        ({'links_done': True, 'pairs_done': True, 'ids': ['p'],
          'part': 'personas'}, 'personas'),
        ({'links_done': True, 'pairs_done': True, 'ids': ['p'],
          'part': 'series'}, 'project_done'),
        ({'links_done': True, 'pairs_done': True, 'projects_done': True},
         'library'),
        ({'links_done': True, 'pairs_done': True, 'projects_done': True,
          'library': True}, 'documents_library'),
        ({'links_done': True, 'pairs_done': True, 'projects_done': True,
          'library': True, 'documents_library_done': True, 'pin_forms_done': True}, 'done'),
    ])
    def test_each_hand_made_cursor_names_its_step(self, at, state):
        assert project_people.ProjectPeopleEraser.deployment_state(at) == state


class TestTheStoresWriteTheRegistries:
    """Since 7.48.00 a deployment's link create and a series' first thread list them; a workspace's never do."""

    def test_a_link_and_its_series_are_listed_with_the_link_and_the_revoke_keeps_them(self, aws):
        share, _ = ds.create_share(aws['projects'], project_id='p1', series=SERIES, document_id='d',
                                   creator={'sub': 's', 'name': LEAD}, values=ds.validate_share_body({}))
        listed = _row(aws, deployment_link_registry_key(share['share_id']))
        assert {name: listed[name] for name in ('project_id', 'series_id')} == {
            'project_id': 'p1', 'series_id': SERIES['series_id']}
        assert _row(aws, {'pk': 'COMMENT_SERIES_IDS', 'sk': f"p1#{SERIES['series_id']}"})['series_id'] == SERIES[
            'series_id']
        assert ds.revoke_share(aws['projects'], 'p1', SERIES['series_id'], LEAD)
        assert 'Item' in aws['projects'].get_item(Key=deployment_link_registry_key(share['share_id']))
        # A second link of the same series (the first revoked) is listed beside it.
        again, _ = ds.create_share(aws['projects'], project_id='p1', series=SERIES, document_id='d',
                                   creator={'sub': 's', 'name': LEAD}, values=ds.validate_share_body({}))
        assert _registries(aws, 'DOCSHARE_IDS') == sorted([share['share_id'], again['share_id']])

    def test_a_series_first_thread_lists_it_once_and_a_later_thread_keeps_the_row(self, aws):
        comments.put_thread(aws['projects'], _member_thread('one'))
        key = {'pk': 'COMMENT_SERIES_IDS', 'sk': f"p1#{SERIES['series_id']}"}
        first = _row(aws, key)
        comments.put_thread(aws['projects'], _member_thread('two'))
        assert _row(aws, key) == first
        assert len(_threads(aws, 'p1', None)) == 2

    def test_a_thread_outside_its_series_partition_is_refused_before_anything_is_written(self, aws):
        item = _member_thread('x')
        with pytest.raises(comments.OutOfScopeError):
            comments.put_thread(aws['projects'], {**item, 'pk': 'DCOMMENTS#p2#' + SERIES['series_id']})
        # Nothing but the backfill's marker the tables start with.
        assert [row['sk'] for row in aws['projects'].scan()['Items']] == [MARKER['sk']]

    def test_a_workspace_writes_none_of_the_deployments_registries(self, aws):
        _list_workspace(aws, WS, 'Alpha')
        _seed(aws)
        assert (_registries(aws, 'DOCSHARE_IDS'), _registries(aws, 'COMMENT_SERIES_IDS')) == ([], [])


RETENTION_WORKER: Final = repo_root() / 'lib' / 'stacks' / 'retention-worker.ts'


def _ts_list(name: str) -> list[str]:
    """A string list constant of lib/stacks/retention-worker.ts."""
    source = RETENTION_WORKER.read_text(encoding='utf-8')
    found = re.search(rf'const {name} = \[([^\]]*)\]', source)
    assert found is not None, name
    return re.findall(r"'([^']+)'", found.group(1))


@pytest.mark.usefixtures('projects_env')
class TestRound1:
    """Review round 1 of 3g-d: each test failed before its fix."""

    @pytest.mark.parametrize('marker', [
        {'pk': MARKER['pk'], 'sk': MARKER['sk']},
        {key: value for key, value in MARKER.items() if key != 'projects_found'},
        {key: value for key, value in MARKER.items() if key != 'release'},
        {**MARKER, 'release': '7.43.0'},  # taken under an older release: a rollback's leftover
        {**MARKER, 'release': 'x'},
    ])
    def test_an_incomplete_or_older_marker_reads_as_absent(self, aws, worker_context, marker):
        """Since 7.93.00 an absent marker fails the job by name (test_registries_required.py), with no Scan."""
        _seed_deployment(aws)
        _unmark(aws)
        aws['projects'].put_item(Item=marker)
        with scans_of(aws) as scanned:
            result = _erase_by_email(aws, worker_context)
        assert (scanned, result['status']) == ([], 'failed')
        assert PROJECT_COUNTER not in result
        assert 'ReviewRegistriesNotBackfilled' in erasure_rows(aws, JOB_ID)[0]['error']

    def test_a_cursor_carried_from_7_43_walks_the_deployment_first(self, aws):
        """A hand-over across the upgrade: the 7.43.00 cursor names neither ``deployment`` nor ``deployment_done``."""
        _seed_deployment(aws)
        _list_workspace(aws, WS, 'Alpha')
        run = _run()
        eraser = project_people.ProjectPeopleEraser(run, _tables(aws), REVIEWER, aws['s3'], BUCKET)
        cursor: Any = {'ws': [WS], 'listing': None, 'listing_done': True, 'at': {'links_done': True}}
        first = eraser.step(json.loads(json.dumps(cursor)))
        assert first is not None
        assert project_people.DEPLOYMENT in first
        assert (first['ws'], first['at']) == ([WS], {'links_done': True})
        cursor, seen_done = first, False
        for _step in range(500):
            cursor = eraser.step(cursor)
            if cursor is None:
                break
            seen_done = seen_done or (cursor.get('deployment_done') is True
                                      and project_people.DEPLOYMENT not in cursor)
        assert (cursor, seen_done, run[PROJECT_COUNTER]) == (None, True, CHANGED)
        assert run[runs.DEPLOYMENT_WALKED] is True

    def test_the_job_row_says_how_the_deployment_was_found_and_whether_it_was_walked(self, aws, worker_context):
        _seed_deployment(aws)
        _erase_by_email(aws, worker_context)
        job, audit = erasure_rows(aws, JOB_ID)
        assert (job['deployment_rows_found'], job['deployment_projects_walked']) == ('registry', True)
        assert (audit['deployment_rows_found'], audit['deployment_projects_walked']) == ('registry', True)
        # Refused without the marker (7.93.00): it says it did not walk them, and names no way it found them.
        _unmark(aws)
        for row in aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(runs.AUDIT_PK))['Items']:
            aws['aggregates'].delete_item(Key={'pk': row['pk'], 'sk': row['sk']})
        _erase_by_email(aws, worker_context, job_id='er_00000000c0df')
        job, _audit = erasure_rows(aws, 'er_00000000c0df')
        assert (job.get('deployment_rows_found'), job['deployment_projects_walked']) == (None, False)

    def test_only_the_deployments_erasure_by_email_says_whether_it_walked(self, aws, worker_context):
        """Round 2: the fields are the deployment's erasures by email without a source only; any other job writes
        neither (an erasure by author or of one source never walks the projects, a workspace's never the
        deployment's)."""
        put_feedback(aws, 'f1', author='Reviewer One')
        handler.handle_event(erasure_job(aws, JOB_ID, 'author', 'Reviewer One', legal_basis=BASIS), worker_context)
        job, audit = erasure_rows(aws, JOB_ID)
        assert [name for name in (*job, *audit) if name.startswith('deployment_')] == []

    def test_a_deployment_job_handed_over_past_the_phase_says_it_did_not_walk(self):
        """A 7.43.00 job handed over past its ``workspace_projects`` phase during the deploy finishes with false."""
        run = {**runs.new_run({}, 'erase'), 'field': 'email', 'job_id': JOB_ID}
        assert runs.deployment_fields(run) == {runs.DEPLOYMENT_WALKED: False, runs.PINS_WALKED: False}
        assert runs.deployment_fields({**run, 'source': 'web'}) == {}
        assert runs.deployment_fields({**run, 'workspace_id': WS}) == {}

    def test_a_deployment_write_refuses_a_workspace_partition(self, aws):
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER)
        row = {'pk': f'WS#{WS}#DCOMMENTS#p#ser_' + 'a' * 24, 'sk': 'C#x', 'author': comments.reviewer_author(REVIEWER)}
        aws['projects'].put_item(Item=row)
        with pytest.raises(OutOfScopeError):
            eraser._write(None, row, 'thread', eraser.changes('thread', row))
        assert _row(aws, {'pk': row['pk'], 'sk': row['sk']})['author']['email'] == REVIEWER

    def test_the_worker_holds_no_scan_of_the_projects_and_its_index_query_reads_the_keys(self):
        """7.93.00 (3g-d2): the Scan fallback and its grant are gone; the gap check's index Query is held to the keys
        the code projects and queries by (registries.py ``INDEX_ATTRIBUTES``), on the index the code names."""
        source = RETENTION_WORKER.read_text(encoding='utf-8')
        assert 'SCAN_ATTRIBUTES' not in source
        assert _ts_list('PROJECTS_INDEX_ATTRIBUTES') == list(registries.INDEX_ATTRIBUTES)
        assert _ts_list('PROJECT_REGISTRY_KEYS') == ['pk', 'sk']
        assert f"const PROJECTS_INDEX = '{registries.PROJECTS_BY_TYPE_INDEX}';" in source
        # The one partition, also the marker seed's (review-registries-marker.ts).
        assert f"export const DEPLOYMENT_PROJECTS_PARTITION = '{project_type_pk()}';" in source
        assert 'const PROJECTS_INDEX_PARTITIONS = [DEPLOYMENT_PROJECTS_PARTITION];' in source

    def test_every_deployment_query_reads_only_what_iam_allows(self, aws, worker_context):
        """Round 2: the deployment's Query statement holds ``dynamodb:Attributes`` to ``DEPLOYMENT_QUERY_ATTRIBUTES``;
        every Query the job sends to a deployment partition projects a subset of it and says ``Select``
        ``SPECIFIC_ATTRIBUTES``, which the statement requires (round 3: none reads a whole item)."""
        _seed_deployment(aws)
        put_feedback(aws, 'f1', metadata={'email': REVIEWER})
        aws['projects'].put_item(Item={'pk': project_pk(DEP_LIVE), 'sk': 'PERSONA#lin', 'input_feedback_ids': ['f1']})
        _with_marker(aws)
        sent: list[tuple[str, list[str], object]] = []

        def record(params: dict[str, Any], **_kwargs: Any) -> None:
            if params.get('TableName') != aws['projects'].name:
                return  # the tables share one client: voc-aggregates' Queries (a form's test responses) are not these
            names = params.get('ExpressionAttributeNames') or {}
            partition = (params.get('ExpressionAttributeValues') or {}).get(':p') or ''
            projection = params.get('ProjectionExpression')
            fields = [names.get(part.strip(), part.strip()) for part in projection.split(',')] if projection else ['*']
            sent.append((str(partition), fields, params.get('Select')))

        aws['projects'].meta.client.meta.events.register('provide-client-params.dynamodb.Query', record)
        _erase_by_email(aws, worker_context)
        allowed = set(_ts_list('DEPLOYMENT_QUERY_ATTRIBUTES'))
        deployment = [sent_one for sent_one in sent if sent_one[0] and not sent_one[0].startswith('WS#')]
        assert deployment
        assert [one for one in deployment if not set(one[1]) <= allowed or one[2] != 'SPECIFIC_ATTRIBUTES'] == []

    def test_one_predicate_judges_a_series_in_the_walk_and_the_backfill(self, backfill):
        assert project_walk.is_series_ref(f"{DEP_LIVE}#ser_{'a' * 24}")
        for bad in ('p!x#ser_' + 'a' * 24, 'p#ser_x', 'a#b#ser_' + 'a' * 24, '', 7):
            assert not project_walk.is_series_ref(bad)
        assert backfill.is_series_ref is project_walk.is_series_ref
        assert project_people.is_series_ref is project_walk.is_series_ref

    def test_a_thread_of_a_listed_series_reads_the_registry_and_writes_nothing_there(self, aws):
        calls: list[str] = []

        def record(params, **kwargs):
            if params.get('Key', params.get('Item', {})).get('pk') == 'COMMENT_SERIES_IDS':
                calls.append(str(kwargs['event_name']).rsplit('.', 1)[-1])

        events = aws['projects'].meta.client.meta.events
        for operation in ('GetItem', 'PutItem'):
            events.register(f'provide-client-params.dynamodb.{operation}', record)

        comments.put_thread(aws['projects'], _member_thread('one'))
        comments.put_thread(aws['projects'], _member_thread('two'))
        comments.put_thread(aws['projects'], _member_thread('three'), series_listed=True)
        assert calls == ['GetItem', 'PutItem', 'GetItem']


@pytest.mark.usefixtures('projects_env')
class TestRound2:
    """Review round 2 of 3g-d: each test failed before its fix."""

    def test_a_half_deleted_project_off_the_index_is_walked(self, aws, worker_context):
        """The delete's fence removes ``gsi1pk``/``gsi1sk`` before its sweep: a project whose sweep stopped keeps its
        META (owner, members) and leftover personas, reached through ``PROJECT_IDS``."""
        deployment_project(aws, 'proj_half_000007', status='deleting', owner_email=REVIEWER,
                           members={'sub-r': {'role': 'viewer', 'username': 'r', 'email': REVIEWER}})
        aws['projects'].put_item(Item={'pk': project_pk('proj_half_000007'), 'sk': 'PERSONA#p',
                                       'research_notes': [{'author': REVIEWER, 'text': 'x'}]})
        result = _erase_by_email(aws, worker_context)
        meta = _meta(aws, 'proj_half_000007', None)
        assert ('owner_email' in meta, meta['members']['sub-r']) == (False, {'role': 'viewer', 'username': 'r'})
        persona = _row(aws, {'pk': project_pk('proj_half_000007'), 'sk': 'PERSONA#p'})
        assert persona['research_notes'][0]['author'] == comments.TEAM_MEMBER_NAME
        assert result[PROJECT_COUNTER] == 2

    def test_the_listing_start_is_taken_again_once_a_fresh_deployment_walk_ends(self, aws):
        """A long deployment walk must not count its own hours as the listing's moving window (ListingKeptMoving)."""
        _seed_deployment(aws)
        times = iter([datetime(2026, 11, 16, 8, 0, tzinfo=UTC)] + [datetime(2026, 11, 16, 12, 0, tzinfo=UTC)] * 500)
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER, aws['s3'], BUCKET,
                                                    clock=lambda: next(times))
        cursor = eraser.step(None)
        assert cursor is not None
        assert cursor['since'] == '2026-11-16T07:55:00+00:00'
        while cursor is not None and project_people.DEPLOYMENT in cursor:
            cursor = eraser.step(cursor)
        assert cursor is not None
        assert (cursor['deployment_done'], cursor['since'], cursor['pass']) == (True, '2026-11-16T11:55:00+00:00', 0)

    def test_a_carried_cursor_keeps_its_listing_state(self, aws):
        _seed_deployment(aws)
        carried: Any = {'ws': [], 'listing': {'pk': 'WORKSPACES', 'sk': 'm#x'}, 'listing_done': False, 'at': {},
                        'pass': 0, 'since': '2026-11-16T01:00:00+00:00', 'pass_at': None, 'seen': [],
                        'seen_next': [], 'newer': False}
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER, aws['s3'], BUCKET)
        cursor: Any = eraser.step(dict(carried))
        while cursor is not None and project_people.DEPLOYMENT in cursor:
            cursor = eraser.step(cursor)
        assert cursor is not None
        assert {key: cursor[key] for key in carried} == carried


@pytest.mark.usefixtures('projects_env')
class TestRound3:
    """Review round 3 of 3g-d (quality and security): each test failed before its fix."""

    def test_a_deleted_projects_product_documents_folder_is_listed_as_not_checked(self, aws):
        """Its delete sweeps the objects before the records, but an object S3 refused outlives its record."""
        deployment_project(aws, 'proj_half_000008', status='deleting')
        deployment_project(aws, 'proj_live_000009')
        run = _run()
        eraser = project_people.ProjectPeopleEraser(run, _tables(aws), REVIEWER, aws['s3'], BUCKET)
        for project_id in ('proj_half_000008', 'proj_live_000009'):
            eraser._meta_step(None, {'ids': [project_id], 'part': 'meta'})
        assert (run[runs.UNCHECKED_FILES], run[DOCS_NOT_CHECKED_COUNTER]) == (
            [_dep_docs('proj_half_000008')], 1)

    @pytest.mark.parametrize('named', ['', 'nope', 7, 'ws_short'])
    def test_a_job_naming_a_workspace_id_that_is_not_one_fails(self, named):
        with pytest.raises(ValueError, match='not one'):
            workspaces.named({'workspace_id': named})
        assert (workspaces.named({}), workspaces.named({'workspace_id': None})) == (None, None)
        assert workspaces.named({'workspace_id': WS}) == WS

    def test_the_email_field_is_the_boards_erase_field(self):
        assert runs._EMAIL_FIELD == boards.ERASE_FIELD
