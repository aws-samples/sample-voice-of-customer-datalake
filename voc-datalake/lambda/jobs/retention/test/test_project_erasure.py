"""voc-retention reaches a workspace's projects (7.43.00, projects 3g-b; TENETS.md D5; docs/multi-workspace.md, 3g).

End to end in moto: workspace A has a live project and a deleted one, each with a review link whose audience names
a reviewer, the reviewer's comment thread (and a reply), a member's thread, a ``META`` naming the owner and a member
by address, a persona citing reviews, a text product document and an image one; workspace B has the same beside them.
The projects, links and threads are written by their own stores (``create_workspace_project``, ``create_share``,
``put_thread``). An erasure by email de-identifies the address wherever it is in the walked workspaces' projects (a
name that is the address too), revokes a link it leaves admitting nobody, lists for review the product documents
that hold the address and every image, and deletes the exports of the workspaces it changed; an erasure that deletes
a workspace's item, or de-identifies a board request, marks the artifacts that cite it, through the registries, never
a Scan; the deployment's lineage pass reads as before; a walk handed over after any step ends as one that never was;
every update the job sends names only the attributes IAM allows.
"""
from __future__ import annotations

import json
import re
from collections.abc import Generator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Final
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError, EndpointConnectionError

from jobs.retention import handler, lineage, project_people, runs, workspaces
from jobs.retention.test.conftest import BUCKET, PROJECTS_TABLE, erasure_job, erasure_rows, put_feedback
from jobs.retention.test.test_named_workspace_erasure import _job as _named_job
from jobs.retention.test.test_workspace_erasure import (
    BASIS,
    JOB_ID,
    WS,
    WS_TWO,
    _tombstones,
    put_workspace_feedback,
)
from jobs.workspace_export import project_fields
from jobs.workspace_export import projects as export_projects
from shared import document_comments as comments
from shared import document_share as ds
from shared import project_walk
from shared.project_keys import (
    comment_series_key,
    comments_pk,
    project_pk,
    project_registry_key,
    project_registry_pk,
    project_type_pk,
    review_link_key,
    review_link_registry_key,
)
from shared.project_writes import create_workspace_project, register_deployment_project
from shared.retention import BOARD_COUNTER, DOCS_NOT_CHECKED_COUNTER, MALFORMED_ID_COUNTER, PROJECT_COUNTER
from shared.review_share_audience import audience_admits
from shared.ws_repo import OutOfScopeError, WorkspaceScope

A, B = WorkspaceScope(WS), WorkspaceScope(WS_TWO)
LIVE, DELETED, ELSEWHERE = 'proj_live_000001', 'proj_gone_000002', 'proj_b_000003'
SERIES: Final = {'series_id': 'ser_' + 'a' * 24, 'document_type': 'prfaq', 'base_title': 'Launch'}
REVIEWER: Final = 'rae@partner.example'
OTHER_REVIEWER: Final = 'sam@partner.example'
OWNER: Final = 'Ada@Example.com'
MEMBER: Final = 'vic@example.com'
STAMP: Final = '2026-11-01T09:00:00+00:00'
RETENTION_WORKER: Final = Path(__file__).resolve().parents[4] / 'lib' / 'stacks' / 'retention-worker.ts'


@pytest.fixture
def projects_env(monkeypatch):
    monkeypatch.setenv('PROJECTS_TABLE', PROJECTS_TABLE)


def _list_workspace(aws, ws: str, name: str) -> None:
    """The platform's listing row of a workspace (shared/platform_workspaces.py)."""
    aws['workspaces'].put_item(Item={'pk': 'WORKSPACES', 'sk': f'{name.casefold()}#{ws}', 'workspace_id': ws,
                                     'name': name, 'slug': name.casefold(), 'status': 'active', 'created_at': STAMP,
                                     'secret_status': 'ready'})


def _docs(project_id: str, scope: WorkspaceScope) -> str:
    return f'ws/{scope.ws}/projects/{project_id}/product_docs/'


def _project(aws, project_id: str, scope: WorkspaceScope, doc_text: str = 'A spec.') -> dict[str, Any]:
    """A project with its link, two threads, a persona, a text product document (its text ``doc_text``) and an
    image one; the link made."""
    create_workspace_project(aws['projects'], {
        'pk': project_pk(project_id, workspace=scope), 'sk': 'META', 'project_id': project_id, 'name': 'Checkout',
        'gsi1pk': project_type_pk(workspace=scope), 'gsi1sk': STAMP, 'created_at': STAMP, 'owner_sub': 'sub-ada',
        'owner_username': 'ada', 'owner_email': OWNER,
        'members': {'sub-vic': {'role': 'editor', 'username': 'vic', 'email': MEMBER, 'added_by': 'sub-ada',
                                'added_at': STAMP},
                    'sub-kim': {'role': 'viewer', 'username': 'kim', 'email': 'kim@example.com'}}},
        workspace=scope)
    share, _ = ds.create_share(aws['projects'], project_id=project_id, series=SERIES, document_id='doc_1',
                               creator={'sub': 'sub-ada', 'name': 'Ada'}, values=ds.validate_share_body(
                                   {'audience': {'mode': 'list', 'emails': [REVIEWER, OTHER_REVIEWER],
                                                 'domains': ['partner.example']}}), workspace=scope)
    document = {'document_id': 'doc_1', 'version': 1}
    member = comments.thread_item(project_id=project_id, series_id=SERIES['series_id'], document=document,
                                  author=comments.user_author('sub-ada', 'Ada'), text='Member note', anchor=None,
                                  workspace=scope)
    member['replies'] = [comments.reply_item(comments.reviewer_author(REVIEWER), 'A reviewer reply.')]
    reviewer = comments.thread_item(project_id=project_id, series_id=SERIES['series_id'], document=document,
                                    author=comments.reviewer_author(REVIEWER, 'Rae'), text='Reviewer note',
                                    anchor=None, share_id=share['share_id'], workspace=scope)
    reviewer['replies'] = [comments.reply_item(comments.user_author('sub-ada', 'Ada'), 'Thanks.')]
    for thread in (member, reviewer):
        comments.put_thread(aws['projects'], thread, workspace=scope)
    own = project_pk(project_id, workspace=scope)
    folder = _docs(project_id, scope)
    for item in (
        {'pk': own, 'sk': 'PERSONA#per_1', 'persona_id': 'per_1', 'input_feedback_ids': ['f1', 'f2'],
         'evidence_feedback_ids': ['f1']},
        {'pk': own, 'sk': 'PRODUCT_DOC#pd_1', 'doc_id': 'pd_1', 'status': 'ready', 'content_type': 'text/markdown',
         's3_raw_key': f'{folder}raw/pd_1.md', 's3_extracted_key': f'{folder}extracted/pd_1.txt',
         'filename': 'spec.md'},
        {'pk': own, 'sk': 'PRODUCT_DOC#pd_2', 'doc_id': 'pd_2', 'status': 'failed', 'content_type': 'image/png',
         's3_raw_key': f'{folder}raw/pd_2.png'},
    ):
        aws['projects'].put_item(Item=item)
    aws['s3'].put_object(Bucket=BUCKET, Key=f'{folder}raw/pd_1.md', Body=doc_text.encode())
    aws['s3'].put_object(Bucket=BUCKET, Key=f'{folder}extracted/pd_1.txt', Body=doc_text.encode())
    return share


def _seed(aws) -> dict[tuple[str, str], dict[str, Any]]:
    """A's live and deleted projects, B's project, both workspaces listed; every link by (workspace, project). Only
    A's live project's text document names the reviewer."""
    _list_workspace(aws, WS, 'Alpha')
    _list_workspace(aws, WS_TWO, 'Beta')
    links = {(WS, LIVE): _project(aws, LIVE, A, f'Ask {REVIEWER.upper()} about it.'),
             (WS, DELETED): _project(aws, DELETED, A), (WS_TWO, ELSEWHERE): _project(aws, ELSEWHERE, B)}
    aws['projects'].update_item(Key=project_registry_key(DELETED, workspace=A), UpdateExpression='SET deleted_at = :at',
                                ExpressionAttributeValues={':at': STAMP})
    return links


#: The deployment's own projects (7.47.00, 3g-d): a live one, and a deleted one whose threads outlived its partition.
DEP_LIVE, DEP_GONE = 'proj_dep_000005', 'proj_dep_gone_000006'
#: A second series of the live project, whose link was revoked (its series' pointer deleted).
SERIES_TWO: Final = {'series_id': 'ser_' + 'b' * 24, 'document_type': 'prd', 'base_title': 'Pricing'}
#: The deployment project's team (role labels, no person's name) and the reviewer's display name.
LEAD: Final = 'Project lead'
REVIEWER_NAME: Final = 'Partner reviewer'
DEP_OWNER: Final = 'Lead@Example.com'
DEP_MEMBER: Final = 'editor@example.com'


def _dep_docs(project_id: str) -> str:
    return f'projects/{project_id}/product_docs/'


def _seed_deployment(aws) -> dict[str, dict[str, Any]]:
    """The deployment's own rows, written by their own stores (no workspace): a project ``META`` naming the owner and a
    member by address; a link naming the reviewer and a revoked one; the reviewer's thread and reply and a member's
    thread; a persona whose research note the reviewer is the author of; three product documents (a PDF whose text
    names the reviewer, an image whose description does not, a PDF not extracted yet); and a deleted project whose
    partition its delete emptied, leaving its series' threads. The links by name."""
    deployment_project(aws, DEP_LIVE, owner_sub='sub-lead', owner_username='lead', owner_email=DEP_OWNER,
                       members={'sub-editor': {'role': 'editor', 'username': 'editor', 'email': DEP_MEMBER}})
    creator = {'sub': 'sub-lead', 'name': LEAD}
    live, _ = ds.create_share(aws['projects'], project_id=DEP_LIVE, series=SERIES, document_id='doc_1', creator=creator,
                              values=ds.validate_share_body({'audience': {
                                  'mode': 'list', 'emails': [REVIEWER, OTHER_REVIEWER], 'domains': ['partner.example']}}))
    revoked, _ = ds.create_share(aws['projects'], project_id=DEP_LIVE, series=SERIES_TWO, document_id='doc_2',
                                 creator=creator, values=ds.validate_share_body(
                                     {'audience': {'mode': 'list', 'emails': [REVIEWER]}}))
    assert ds.revoke_share(aws['projects'], DEP_LIVE, SERIES_TWO['series_id'], LEAD)
    document = {'document_id': 'doc_1', 'version': 1}
    for project_id in (DEP_LIVE, DEP_GONE):
        member = comments.thread_item(project_id=project_id, series_id=SERIES['series_id'], document=document,
                                      author=comments.user_author('sub-lead', LEAD), text='Member note', anchor=None)
        member['replies'] = [comments.reply_item(comments.reviewer_author(REVIEWER), 'A reviewer reply.')]
        reviewer = comments.thread_item(project_id=project_id, series_id=SERIES['series_id'], document=document,
                                        author=comments.reviewer_author(REVIEWER, REVIEWER_NAME), text='Reviewer note',
                                        anchor=None, share_id=live['share_id'])
        for thread in (member, reviewer):
            comments.put_thread(aws['projects'], thread)
    # The deleted project: its META tombstoned (off the index, kept in PROJECT_IDS), its partition emptied by its
    # delete.
    deployment_project(aws, DEP_GONE, status='deleted', deleted_at=STAMP, owner_email=REVIEWER)
    own, folder = project_pk(DEP_LIVE), _dep_docs(DEP_LIVE)
    for item in (
        {'pk': own, 'sk': 'PERSONA#per_1', 'persona_id': 'per_1', 'input_feedback_ids': ['f1', 'f2'],
         'research_notes': [{'note_id': 'n1', 'author': REVIEWER, 'text': 'Asked them'}]},
        {'pk': own, 'sk': 'PRODUCT_DOC#pd_1', 'status': 'ready', 'content_type': 'application/pdf',
         's3_raw_key': f'{folder}raw/pd_1.pdf', 's3_extracted_key': f'{folder}extracted/pd_1.txt', 'filename': 'a.pdf'},
        {'pk': own, 'sk': 'PRODUCT_DOC#pd_2', 'status': 'ready', 'content_type': 'image/png',
         's3_raw_key': f'{folder}raw/pd_2.png', 's3_extracted_key': f'{folder}extracted/pd_2.txt', 'filename': 'b.png'},
        {'pk': own, 'sk': 'PRODUCT_DOC#pd_3', 'status': 'pending', 'content_type': 'application/pdf',
         's3_raw_key': f'{folder}raw/pd_3.pdf', 'filename': 'c.pdf'},
    ):
        aws['projects'].put_item(Item=item)
    aws['s3'].put_object(Bucket=BUCKET, Key=f'{folder}extracted/pd_1.txt', Body=f'Ask {REVIEWER} first.'.encode())
    aws['s3'].put_object(Bucket=BUCKET, Key=f'{folder}extracted/pd_2.txt', Body=b'A chart of sign-ups by week.')
    return {'live': live, 'revoked': revoked}


def _threads(aws, project_id: str, scope: WorkspaceScope | None, series: str = SERIES['series_id']) -> list[
        dict[str, Any]]:
    pk = comments_pk(project_id, series, workspace=scope)
    rows = aws['projects'].query(KeyConditionExpression=Key('pk').eq(pk) & Key('sk').begins_with('C#'))['Items']
    return sorted(rows, key=lambda row: row['text'])


def _row(aws, key: dict[str, str]) -> dict[str, Any]:
    return aws['projects'].get_item(Key=key)['Item']


def _meta(aws, project_id: str, scope: WorkspaceScope | None) -> dict[str, Any]:
    return _row(aws, {'pk': project_pk(project_id, workspace=scope), 'sk': 'META'})


def _persona(aws, project_id: str, scope: WorkspaceScope) -> dict[str, Any]:
    return _row(aws, {'pk': project_pk(project_id, workspace=scope), 'sk': 'PERSONA#per_1'})


def _erase_by_email(aws, context, value: str = REVIEWER, job_id: str = JOB_ID) -> dict[str, Any]:
    return handler.handle_event(erasure_job(aws, job_id, 'email', value, legal_basis=BASIS), context)


@contextmanager
def scans_of(aws) -> Generator[list[str]]:
    """Every Scan the job sends to voc-projects, by table name (the handler's resource shares this client)."""
    seen: list[str] = []

    def record(params: dict[str, Any], **_kwargs: Any) -> None:
        if params.get('TableName') == PROJECTS_TABLE:
            seen.append(str(params['TableName']))

    events = aws['projects'].meta.client.meta.events
    events.register('provide-client-params.dynamodb.Scan', record)
    try:
        yield seen
    finally:
        events.unregister('provide-client-params.dynamodb.Scan', record)


def _done_records(aws) -> dict[str, dict[str, Any]]:
    return {sk: row for sk, row in _tombstones(aws, project_people.STORE_PROJECTS).items() if sk.endswith('#done')}


@pytest.mark.usefixtures('projects_env')
class TestAnErasureByEmailReachesTheWorkspacesProjects:
    def test_a_review_link_loses_the_address_from_its_audience_and_keeps_the_rest(self, aws, worker_context):
        links = _seed(aws)

        _erase_by_email(aws, worker_context, REVIEWER.upper())

        for (ws, project_id), share in links.items():
            link = _row(aws, review_link_key(share['share_id'], workspace=WorkspaceScope(ws)))
            assert link['audience'] == {'mode': 'list', 'emails': [OTHER_REVIEWER], 'domains': ['partner.example']}
            assert (link['project_id'], link['revoked']) == (project_id, False)

    def test_a_link_left_admitting_nobody_is_revoked_and_the_next_share_makes_a_new_one(self, aws, worker_context):
        _list_workspace(aws, WS, 'Alpha')
        create_workspace_project(aws['projects'], {'pk': project_pk(LIVE, workspace=A), 'sk': 'META',
                                                   'project_id': LIVE, 'created_at': STAMP}, workspace=A)
        values = ds.validate_share_body({'audience': {'mode': 'list', 'emails': [REVIEWER]}})
        share, _ = ds.create_share(aws['projects'], project_id=LIVE, series=SERIES, document_id='doc_1',
                                   creator={'sub': 'sub-ada', 'name': 'Ada'}, values=values, workspace=A)

        _erase_by_email(aws, worker_context)

        link = _row(aws, review_link_key(share['share_id'], workspace=A))
        assert (link['audience'], link['revoked'], link['revoked_by']) == (
            {'mode': 'list', 'emails': [], 'domains': []}, True, 'erasure')
        assert not audience_admits(link['audience'], REVIEWER)
        again, created = ds.create_share(aws['projects'], project_id=LIVE, series=SERIES, document_id='doc_1',
                                         creator={'sub': 'sub-ada', 'name': 'Ada'}, values=values, workspace=A)
        assert (created, again['share_id'] != share['share_id']) == (True, True)

    def test_the_reviewers_thread_and_reply_lose_their_address_and_name_and_keep_their_text(
            self, aws, worker_context):
        _seed(aws)

        result = _erase_by_email(aws, worker_context)

        member, reviewer = _threads(aws, LIVE, A)
        assert reviewer['author'] == {'kind': 'reviewer'}
        assert reviewer['text'] == 'Reviewer note'
        assert reviewer['replies'][0]['author'] == {'kind': 'user', 'sub': 'sub-ada', 'name': 'Ada'}
        assert member['author'] == {'kind': 'user', 'sub': 'sub-ada', 'name': 'Ada'}
        assert member['replies'][0]['author'] == {'kind': 'reviewer'}
        assert member['replies'][0]['text'] == 'A reviewer reply.'
        assert not comments.is_reviewer_thread(reviewer, REVIEWER)
        assert REVIEWER not in json.dumps(_threads(aws, DELETED, A), default=str)
        # Per project: two threads and a link (the deleted project's rows too), in both workspaces.
        assert result[PROJECT_COUNTER] == 9

    def test_a_name_that_is_the_address_becomes_the_neutral_label(self, aws, worker_context):
        """A member named by their address (before 7.43.00 a nameless member was): a thread's and a reply's author,
        its resolver, a link's creator and revoker."""
        _list_workspace(aws, WS, 'Alpha')
        create_workspace_project(aws['projects'], {'pk': project_pk(LIVE, workspace=A), 'sk': 'META',
                                                   'project_id': LIVE, 'created_at': STAMP}, workspace=A)
        share, _ = ds.create_share(aws['projects'], project_id=LIVE, series=SERIES, document_id='doc_1',
                                   creator={'sub': 'sub-vic', 'name': MEMBER.upper()},
                                   values=ds.validate_share_body({}), workspace=A)
        aws['projects'].update_item(Key=review_link_key(share['share_id'], workspace=A),
                                    UpdateExpression='SET revoked_by = :by', ExpressionAttributeValues={':by': MEMBER})
        thread = comments.thread_item(project_id=LIVE, series_id=SERIES['series_id'],
                                      document={'document_id': 'doc_1', 'version': 1},
                                      author=comments.user_author('sub-vic', MEMBER), text='Mine', anchor=None,
                                      workspace=A)
        thread.update(status_by=MEMBER, replies=[comments.reply_item(comments.user_author('sub-vic', MEMBER), 'Hi')])
        comments.put_thread(aws['projects'], thread, workspace=A)

        _erase_by_email(aws, worker_context, MEMBER)

        [stored] = _threads(aws, LIVE, A)
        label = comments.TEAM_MEMBER_NAME
        assert (stored['author'], stored['replies'][0]['author'], stored['status_by']) == (
            {'kind': 'user', 'sub': 'sub-vic', 'name': label}, {'kind': 'user', 'sub': 'sub-vic', 'name': label}, label)
        link = _row(aws, review_link_key(share['share_id'], workspace=A))
        assert (link['created_by_name'], link['revoked_by'], link['created_by_sub']) == (label, label, 'sub-vic')

    def test_a_projects_owner_and_member_addresses_are_removed_and_their_access_kept(self, aws, worker_context):
        _seed(aws)

        _erase_by_email(aws, worker_context, 'ada@example.com')
        again = _erase_by_email(aws, worker_context, MEMBER, job_id='er_00000000c0df')

        meta = _meta(aws, LIVE, A)
        assert 'owner_email' not in meta
        assert (meta['owner_sub'], meta['owner_username']) == ('sub-ada', 'ada')
        assert meta['members'] == {'sub-vic': {'role': 'editor', 'username': 'vic', 'added_by': 'sub-ada',
                                               'added_at': STAMP},
                                   'sub-kim': {'role': 'viewer', 'username': 'kim', 'email': 'kim@example.com'}}
        assert again[PROJECT_COUNTER] == 3

    def test_each_change_is_recorded_before_and_after_without_the_address_or_the_links_id(self, aws, worker_context):
        links = _seed(aws)

        result = _erase_by_email(aws, worker_context)

        tombstones = _tombstones(aws, project_people.STORE_PROJECTS)
        done = _done_records(aws)
        # One attempt and one outcome per changed row; the outcomes are the count.
        assert (len(tombstones), len(done), result[PROJECT_COUNTER]) == (18, 9, 9)
        assert {row['action'] for row in done.values()} == {'deidentified'}
        assert {row['action'] for sk, row in tombstones.items() if sk not in done} == {'deidentifying'}
        assert {row['kind'] for row in tombstones.values()} == {'thread', 'link'}
        assert {row['workspace_id'] for row in tombstones.values()} == {WS, WS_TWO}
        text = json.dumps(list(tombstones.values()), default=str)
        assert REVIEWER not in text
        assert 'Rae' not in text
        assert not any(share['share_id'] in text for share in links.values())
        assert all(row['legal_basis'] == BASIS and row['job_id'] == JOB_ID and 'ttl' not in row
                   for row in tombstones.values())

    def test_a_document_that_holds_the_address_is_listed_and_the_images_folders_apart(self, aws, worker_context):
        _seed(aws)

        result = _erase_by_email(aws, worker_context)

        job, audit = erasure_rows(aws, JOB_ID)
        # Only A's live project's text holds the address; every folder of images is listed once, as not checked.
        assert job['files_needing_review']['keys'] == audit['files_needing_review']['keys'] == [
            f'{_docs(LIVE, A)}raw/pd_1.md']
        folders = sorted(_docs(project, scope) for project, scope in ((LIVE, A), (DELETED, A), (ELSEWHERE, B)))
        assert sorted(job['files_not_checked']['keys']) == sorted(audit['files_not_checked']['keys']) == folders
        assert job['files_not_checked']['more'] is False
        assert result[DOCS_NOT_CHECKED_COUNTER] == 3

    def test_a_matching_document_alone_closes_the_workspaces_exports(self, aws, worker_context):
        _list_workspace(aws, WS, 'Alpha')
        create_workspace_project(aws['projects'], {'pk': project_pk(LIVE, workspace=A), 'sk': 'META',
                                                   'project_id': LIVE, 'created_at': STAMP}, workspace=A)
        folder = _docs(LIVE, A)
        aws['projects'].put_item(Item={'pk': project_pk(LIVE, workspace=A), 'sk': 'PRODUCT_DOC#pd_1',
                                       'status': 'pending', 'content_type': 'text/plain',
                                       's3_raw_key': f'{folder}raw/pd_1.txt', 'filename': 'notes.txt'})
        aws['s3'].put_object(Bucket=BUCKET, Key=f'{folder}raw/pd_1.txt', Body=f'Call {REVIEWER}'.encode())
        aws['s3'].put_object(Bucket=BUCKET, Key=f'ws/{WS}/exports/exp_1/export.zip', Body=b'zip')

        result = _erase_by_email(aws, worker_context)

        assert result['deleted_export_objects'] == 1
        assert erasure_rows(aws, JOB_ID)[0]['files_needing_review']['keys'] == [f'{folder}raw/pd_1.txt']

    @pytest.mark.parametrize(('record', 'reviewed', 'unchecked'), [
        # A filename that holds the address: listed, whatever the file says.
        ({'filename': f'For {REVIEWER}.png', 'content_type': 'image/png', 's3_raw_key': 'raw/a.png'},
         ['raw/a.png'], []),
        # A kind neither text nor image: not read, listed apart.
        ({'filename': 'a.bin', 'content_type': 'application/octet-stream', 's3_raw_key': 'raw/a.bin'}, [],
         ['raw/a.bin']),
        # Text not extracted yet and an upload that is no text: not read, listed apart.
        ({'filename': 'a.pdf', 'status': 'pending', 'content_type': 'application/pdf', 's3_raw_key': 'raw/a.pdf'},
         [], ['raw/a.pdf']),
        # A record whose upload is not under its folder: the folder listed, counted malformed.
        ({'filename': 'a.md', 's3_raw_key': 'elsewhere/a.md'}, [], ['']),
    ])
    def test_each_kind_of_record_is_judged(self, aws, record, reviewed, unchecked):
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER, aws['s3'], BUCKET)
        folder = _docs(LIVE, A)
        raw = record['s3_raw_key']
        row = {**record, 'sk': 'PRODUCT_DOC#d1',
               's3_raw_key': raw if raw.startswith('elsewhere') else f'{folder}{raw}'}
        eraser._product_doc(A, LIVE, row)
        assert eraser._run['review_files'] == [f'{folder}{key}' for key in reviewed]
        assert eraser._run.get(runs.UNCHECKED_FILES, []) == [f'{folder}{key}' for key in unchecked]

    def test_a_missing_key_answering_403_is_not_checked_and_never_fails_the_job(self, aws):
        """Without ListBucket, S3 answers 403 for a key that is not there (moto's NoSuchKey would hide it)."""
        s3 = MagicMock()
        s3.get_object.side_effect = ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'denied'}}, 'GetObject')
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER, s3, BUCKET)
        folder = _docs(LIVE, A)
        for doc, record in (('pending', {'status': 'pending', 's3_raw_key': f'{folder}raw/pending.md'}),
                            ('ready', {'status': 'ready', 's3_raw_key': f'{folder}raw/ready.txt',
                                       's3_extracted_key': f'{folder}extracted/ready.txt'})):
            eraser._product_doc(A, LIVE, {**record, 'sk': f'PRODUCT_DOC#{doc}', 'content_type': 'text/plain'})
        assert eraser._run[runs.UNCHECKED_FILES] == [f'{folder}raw/pending.md', f'{folder}raw/ready.txt']
        # The extracted text is read for a ready record, the upload for one not extracted yet.
        assert [call.kwargs['Key'] for call in s3.get_object.call_args_list] == [
            f'{folder}raw/pending.md', f'{folder}extracted/ready.txt']
        # Any answer S3 gives instead of the object (a KMS refusal, an archived object) is "not checked", counted.
        for code in ('KMS.DisabledException', 'InvalidObjectState'):
            s3.get_object.side_effect = ClientError({'Error': {'Code': code, 'Message': 'x'}}, 'GetObject')
            eraser._product_doc(A, LIVE, {'sk': f'PRODUCT_DOC#{code}', 'status': 'pending',
                                          's3_raw_key': f'{folder}raw/{code}.md'})
        assert eraser._run[DOCS_NOT_CHECKED_COUNTER] == 4
        # A failure with no answer (a timeout) is raised: the job fails and is rerun, never reads it as clean.
        s3.get_object.side_effect = EndpointConnectionError(endpoint_url='https://s3.example')
        with pytest.raises(EndpointConnectionError):
            eraser._product_doc(A, LIVE, {'sk': 'PRODUCT_DOC#other', 'status': 'pending',
                                          's3_raw_key': f'{folder}raw/other.md'})

    def test_a_document_too_large_to_read_is_not_checked(self, aws):
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER, aws['s3'], BUCKET)
        folder = _docs(LIVE, A)
        aws['s3'].put_object(Bucket=BUCKET, Key=f'{folder}raw/big.txt', Body=b'x' * 11)
        with patch.object(project_people, 'MAX_TEXT_BYTES', 10):
            eraser._product_doc(A, LIVE, {'sk': 'PRODUCT_DOC#big', 's3_raw_key': f'{folder}raw/big.txt'})
        assert (eraser._run['review_files'], eraser._run[runs.UNCHECKED_FILES]) == ([], [f'{folder}raw/big.txt'])

    def test_the_not_checked_list_keeps_its_own_cap(self):
        run = _run()
        for n in range(runs.MAX_REVIEW_FILES + 3):
            runs.note_unchecked_file(run, f'folder_{n}/')
        runs.note_review_file(run, 'a match')
        assert (len(run[runs.UNCHECKED_FILES]), (runs.files_not_checked(run) or {}).get('more')) == (
            runs.MAX_REVIEW_FILES, True)
        assert runs.files_needing_review(run) == {'count': 1, 'keys': ['a match'], 'more': False}
        carried = runs.new_run({'run': json.loads(json.dumps(runs.carried_state(run)))}, 'erase')
        assert runs.files_not_checked(carried) == runs.files_not_checked(run)

    def test_a_match_closes_and_deletes_that_workspaces_exports_only(self, aws, worker_context):
        _list_workspace(aws, WS, 'Alpha')
        _list_workspace(aws, WS_TWO, 'Beta')
        _project(aws, LIVE, A)
        create_workspace_project(aws['projects'], {'pk': project_pk(ELSEWHERE, workspace=B), 'sk': 'META',
                                                   'project_id': ELSEWHERE, 'created_at': STAMP}, workspace=B)
        zips = {ws: f'ws/{ws}/exports/exp_1/export.zip' for ws in (WS, WS_TWO)}
        for key in zips.values():
            aws['s3'].put_object(Bucket=BUCKET, Key=key, Body=b'zip')

        result = _erase_by_email(aws, worker_context)

        listed = aws['s3'].list_object_versions(Bucket=BUCKET, Prefix='ws/').get('Versions', [])
        assert [entry['Key'] for entry in listed if '/exports/' in entry['Key']] == [zips[WS_TWO]]
        assert result['deleted_export_objects'] == 1

    def test_an_erasure_that_matches_nothing_changes_nothing_and_closes_no_export(self, aws, worker_context):
        _seed(aws)
        before = aws['projects'].scan()['Items']

        with patch.object(project_people.exports, 'note_workspace') as noted:
            result = _erase_by_email(aws, worker_context, 'nobody@example.com')

        noted.assert_not_called()
        assert aws['projects'].scan()['Items'] == before
        assert PROJECT_COUNTER not in result

    def test_an_erasure_within_a_source_or_by_author_never_walks_the_projects(self, aws, worker_context):
        _seed(aws)
        before = aws['projects'].scan()['Items']
        with patch.object(project_people.ProjectPeopleEraser, 'step') as step:
            handler.handle_event(erasure_job(aws, JOB_ID, 'email', REVIEWER, legal_basis=BASIS, source='web'),
                                 worker_context)
            handler.handle_event(erasure_job(aws, 'er_00000000c0df', 'author', REVIEWER, legal_basis=BASIS),
                                 worker_context)
        step.assert_not_called()
        assert aws['projects'].scan()['Items'] == before

    def test_an_erasure_in_one_workspace_reaches_its_own_projects_only(self, aws, worker_context):
        links = _seed(aws)

        handler.handle_event(_named_job(aws, 'email', REVIEWER), worker_context)

        assert _threads(aws, LIVE, A)[1]['author'] == {'kind': 'reviewer'}
        b_share = links[(WS_TWO, ELSEWHERE)]
        assert _threads(aws, ELSEWHERE, B)[1]['author']['email'] == REVIEWER
        assert REVIEWER in _row(aws, review_link_key(b_share['share_id'], workspace=B))['audience']['emails']

    def test_a_late_reply_on_a_thread_whose_replies_did_not_match_is_caught_by_the_reread(self, aws, worker_context):
        """The reviewer's own thread: its author matches, its replies (a member's) do not; a reply of the reviewer's
        lands between the read and the one conditional write, which fails; the row is read again, whole, and both
        the author and the late reply are de-identified."""
        _seed(aws)
        reviewer_pk = comments_pk(LIVE, SERIES['series_id'], workspace=A)
        real = project_people.ProjectPeopleEraser._write
        raced: list[bool] = []

        def racing(self, scope, row, kind, found):
            if kind == 'thread' and row['pk'] == reviewer_pk and 'replies' not in found and not raced:
                raced.append(True)
                comments.append_reply(aws['projects'], row, comments.reply_item(
                    comments.reviewer_author(REVIEWER), 'Late reply.'), workspace=A)
            return real(self, scope, row, kind, found)

        with patch.object(project_people.ProjectPeopleEraser, '_write', racing):
            _erase_by_email(aws, worker_context)

        _member, reviewer = _threads(aws, LIVE, A)
        assert raced == [True]
        assert reviewer['author'] == {'kind': 'reviewer'}
        assert [reply['author'] for reply in reviewer['replies']] == [
            {'kind': 'user', 'sub': 'sub-ada', 'name': 'Ada'}, {'kind': 'reviewer'}]

    def test_a_row_that_keeps_changing_raises_and_the_job_reads_failed(self, aws, worker_context):
        _seed(aws)
        with patch.object(project_people.ProjectPeopleEraser, '_write', return_value=False) as write:
            result = _erase_by_email(aws, worker_context)
        assert result['status'] == 'failed'
        assert write.call_count == project_people.MAX_TRIES
        job, audit = erasure_rows(aws, JOB_ID)
        assert (job['status'], job['error'], audit['error']) == ('failed', 'Run failed (RowKeptChanging)',
                                                                 'Run failed (RowKeptChanging)')

    def test_malformed_ids_are_counted_not_read(self, aws, worker_context):
        _list_workspace(aws, WS, 'Alpha')
        create_workspace_project(aws['projects'], {'pk': project_pk(LIVE, workspace=A), 'sk': 'META',
                                                   'project_id': LIVE, 'created_at': STAMP}, workspace=A)
        for item in ({'pk': project_registry_pk(A), 'sk': 'bad#id'},
                     {**review_link_registry_key('shr_bad', workspace=A)},
                     {**comment_series_key(LIVE, 'ser_nope', workspace=A)}):
            aws['projects'].put_item(Item=item)

        result = _erase_by_email(aws, worker_context)

        assert result[MALFORMED_ID_COUNTER] == 3
        assert erasure_rows(aws, JOB_ID)[0][MALFORMED_ID_COUNTER] == 3


@pytest.mark.usefixtures('projects_env')
class TestTheWrites:
    @staticmethod
    def _eraser(aws) -> project_people.ProjectPeopleEraser:
        return project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER)

    def test_a_row_gone_before_its_write_is_left_alone(self, aws):
        eraser = self._eraser(aws)
        row = {'pk': f'WS#{WS}#DCOMMENTS#p#s', 'sk': 'C#x', 'author': comments.reviewer_author(REVIEWER)}
        # Never written: the conditional write fails, the read finds no row, nothing is created or counted.
        eraser._erase_row(A, row, 'thread', 'p#x')
        assert 'Item' not in aws['projects'].get_item(Key={'pk': row['pk'], 'sk': row['sk']})
        assert PROJECT_COUNTER not in eraser._run
        assert _done_records(aws) == {}

    def test_any_other_failure_is_raised(self, aws):
        view = MagicMock()
        view.update_item.side_effect = ClientError({'Error': {'Code': 'ValidationException', 'Message': 'x'}},
                                                   'UpdateItem')
        eraser = self._eraser(aws)
        row = {'pk': 'p', 'sk': 's', 'author': comments.reviewer_author(REVIEWER)}
        with patch.object(project_people.ProjectPeopleEraser, '_view', return_value=view), \
                pytest.raises(ClientError):
            eraser._write(A, row, 'thread', eraser.changes('thread', row))

    def test_values_that_hold_no_address_change_nothing(self, aws):
        eraser = self._eraser(aws)
        assert [eraser._replies(None), eraser._members('x'), eraser._audience({'mode': 'anyone'}),
                eraser._author({'kind': 'user'}), eraser._owner(None), eraser._label('Ada')] == [None] * 6

    def test_every_personal_field_the_export_carries_is_erased_listed_or_justified(self):
        """Every field the export writes that can hold an address or a person's name (``*email*``, ``*name*``,
        ``*user*``, ``author``, ``actor``, ``*_by``, an audience): a project row's top-level attributes
        (project_fields.py ``EXPORTED``), a members entry's (``MEMBER_FIELDS``), a thread's, an author's, a reply's
        and a link's (projects.py's lists), a product document record's and a persona's research note's. Each is
        rewritten (``ERASED_FIELDS``), listed for review (``LISTED_FIELDS``) or kept here with its reason, and no
        reason names a field the export does not carry: the lists cannot drift apart."""
        handled = {field for fields in (*project_people.ERASED_FIELDS.values(),
                                        *project_people.LISTED_FIELDS.values()) for field in fields}
        personal = re.compile(r'email|name|user|author|actor|_by$|audience')
        carried = {
            *(f'{name}' for name in project_fields.EXPORTED),
            *(f'members.{name}' for name in project_fields.MEMBER_FIELDS),
            *(f'thread.{name}' for name in export_projects.THREAD_FIELDS),
            *(f'author.{name}' for name in export_projects.AUTHOR_FIELDS),
            *(f'replies.author.{name}' for name in export_projects.AUTHOR_FIELDS),
            *(f'link.{name}' for name in export_projects.LINK_FIELDS),
            'research_notes.author',
        }
        aliases = {'thread.author': 'author.name', 'thread.status_by': 'status_by', 'link.audience': 'audience.emails',
                   'link.created_by_name': 'created_by_name', 'link.revoked_by': 'revoked_by',
                   'members': 'members.email', 'filename': 'filename'}
        kept = {
            'name': "a project's, a document's or a persona's name the team gave it",
            'project_name': "a prompt section naming the project (the generator's template)",
            'step_name': "a research step's name",
            'title': "a document's title", 'base_title': "a series' title", 'normalized_base_title': 'the same, folded',
            'link.base_title': "the linked series' title",
            'owner_username': "the owner's account handle, kept with their sub (the access entry)",
            'username': 'an account handle (a members entry key the static view sees), kept with the sub',
            'members.username': "a member's account handle, kept with their sub (the access entry)",
            'email': "a members entry key the static view sees as an attribute: erased as members.email",
            'user': "a prompt step's user text (api/projects.py), no person's",
            'author': "a persona research note's author, erased as research_notes.author",
            'replies.author.name': 'erased (replies.author.name)',
            'actor': "a job config's {sub, kind}, never an address",
            'added_by': "the sub of who added a member", 'members.added_by': "the sub of who added the member",
            'edited_by': "a revision's {sub, kind}, never an address",
            'thread.replies': 'each reply author is erased (replies.author.*)',
            'link.created_by_sub': "the creator's sub",
        }
        wanted = {aliases.get(name, name) for name in carried if personal.search(name.rsplit('.', 1)[-1])}
        assert sorted(name for name in wanted if name not in handled and name not in kept) == []
        assert sorted(name for name in kept if name not in carried) == []

    def test_every_update_names_only_the_attributes_iam_allows(self, aws, worker_context):
        """Every UpdateItem the job sends to voc-projects names the attributes of one of the two statements IAM grants
        (retention-worker.ts): the lineage marks' (``LINEAGE_UPDATE_ATTRIBUTES``, the deployment's or a workspace's
        ``PROJECT#`` partition only, since 7.47.00), or the de-identification's (``PEOPLE_UPDATE_ATTRIBUTES``, the
        deployment's or a workspace's ``PROJECT#``, ``DCOMMENTS#`` or ``DOCSHARE#`` partition only); each list is the
        TypeScript one of the same name."""
        _seed(aws)
        _seed_deployment(aws)
        put_workspace_feedback(aws, WS, 'f1', metadata={'email': REVIEWER})
        put_feedback(aws, 'fd', metadata={'email': REVIEWER})
        deployment_project(aws, 'dep')
        aws['projects'].put_item(Item={'pk': 'PROJECT#dep', 'sk': 'PERSONA#a', 'input_feedback_ids': ['fd']})
        sent: list[tuple[str, set[str]]] = []

        def record(params: dict[str, Any], **_kwargs: Any) -> None:
            if params.get('TableName') == PROJECTS_TABLE:
                sent.append((str(params['Key']['pk']), {'pk', 'sk',
                                                        *(params.get('ExpressionAttributeNames') or {}).values()}))

        aws['projects'].meta.client.meta.events.register('provide-client-params.dynamodb.UpdateItem', record)
        result = _erase_by_email(aws, worker_context)

        assert (result[PROJECT_COUNTER] > 0, result['artifacts_marked'] > 0) == (True, True)
        lineage_names, people_names = set(lineage.LINEAGE_UPDATE_ATTRIBUTES), set(
            project_people.PEOPLE_UPDATE_ATTRIBUTES)
        scopes = rf'(WS#{WS}#|WS#{WS_TWO}#)?'
        people_partition = re.compile(rf'^{scopes}(PROJECT|DCOMMENTS|DOCSHARE)#')
        lineage_partition = re.compile(rf'^{scopes}PROJECT#')
        assert [(pk, names) for pk, names in sent if not (
            (names <= lineage_names and lineage_partition.match(pk))
            or (names <= people_names and people_partition.match(pk)))] == []
        named = {name for _pk, names in sent for name in names}
        assert {'author', 'erased_evidence'} <= named
        # The deployment's rows were written too: a thread, a link, a META, and a lineage mark.
        assert {pk.split('#')[0] for pk, _names in sent if not pk.startswith('WS#')} == {
            'PROJECT', 'DCOMMENTS', 'DOCSHARE'}
        source = RETENTION_WORKER.read_text(encoding='utf-8')
        for name, listed in (('LINEAGE_UPDATE_ATTRIBUTES', lineage.LINEAGE_UPDATE_ATTRIBUTES),
                             ('PEOPLE_UPDATE_ATTRIBUTES', project_people.PEOPLE_UPDATE_ATTRIBUTES)):
            found = re.search(rf'const {name} = \[([^\]]*)\]', source)
            assert found is not None
            assert re.findall(r"'([^']+)'", found.group(1)) == list(listed)


def _walk_to_the_end(aws, *, hand_over_each_step: bool) -> tuple[dict[str, Any], int]:
    """The projects walk of an erasure of ``REVIEWER`` from its start to its end: in one invocation, or each step in a
    fresh one, the run and the cursor as a hand-over carries them (JSON). The run's state at the end and the steps."""
    run, cursor = _run(), None
    eraser = project_people.ProjectPeopleEraser(run, _tables(aws), REVIEWER, aws['s3'], BUCKET)
    for steps in range(1, 2000):
        if hand_over_each_step:
            carried = json.loads(json.dumps(runs.carried_state(run), default=str))
            run = {**runs.new_run({'run': carried}, 'erase'), 'field': 'email', 'job_id': JOB_ID,
                   'legal_basis': BASIS}
            eraser = project_people.ProjectPeopleEraser(run, _tables(aws), REVIEWER, aws['s3'], BUCKET)
            cursor = json.loads(json.dumps(cursor)) if cursor else None
        cursor = eraser.step(cursor)
        if cursor is None:
            return run, steps
    raise AssertionError('the walk did not end')


def _projects_and_tombstones(aws) -> dict[str, Any]:
    """Every project row, and every tombstone without its time and run (each run has its own)."""
    tombstones = [{name: value for name, value in row.items() if name not in ('deleted_at', 'run_id')}
                  for row in _tombstones(aws, project_people.STORE_PROJECTS).values()]
    return {'projects': _sorted(aws['projects'].scan()['Items']),
            'tombstones': sorted(tombstones, key=lambda row: str(row['sk']))}


def reseed(aws, rows: list[dict[str, Any]]) -> None:
    """voc-projects holding ``rows`` again, and voc-aggregates emptied: a walk's tables as they were before it."""
    for row in aws['projects'].scan()['Items']:
        aws['projects'].delete_item(Key={'pk': row['pk'], 'sk': row['sk']})
    for row in rows:
        aws['projects'].put_item(Item=row)
    for row in aws['aggregates'].scan()['Items']:
        aws['aggregates'].delete_item(Key={'pk': row['pk'], 'sk': row['sk']})


def _one_row_pages():
    """Every page one row: the listing, the registries, the series lists, the threads, the documents."""
    return patch.multiple(project_walk, ID_PAGE=1), patch.multiple(project_people, ID_PAGE=1, DOCS_PAGE=1), \
        patch.multiple(workspaces, ID_PAGE=1)


@pytest.mark.usefixtures('projects_env')
class TestTheWalkHandsOver:
    @pytest.fixture
    def one_shot(self, aws) -> tuple[dict[str, Any], dict[str, Any]]:
        """The rows and tombstones a walk in one invocation leaves, and its run; the tables then seeded afresh."""
        _seed(aws)
        before = aws['projects'].scan()['Items']
        run, _steps = _walk_to_the_end(aws, hand_over_each_step=False)
        after = _projects_and_tombstones(aws)
        reseed(aws, before)
        return after, run

    def test_a_walk_resumed_after_every_step_ends_as_one_that_never_was(self, aws, one_shot):
        """Each step in a fresh invocation, and every page one row, so every carried key is resumed from."""
        expected, one_run = one_shot
        first, second, third = _one_row_pages()

        with first, second, third:
            run, steps = _walk_to_the_end(aws, hand_over_each_step=True)

        assert steps > 40
        assert _projects_and_tombstones(aws) == expected
        assert run[PROJECT_COUNTER] == one_run[PROJECT_COUNTER] == 9
        assert run[DOCS_NOT_CHECKED_COUNTER] == one_run[DOCS_NOT_CHECKED_COUNTER] == 3
        assert run['review_files'] == one_run['review_files'] == [f'{_docs(LIVE, A)}raw/pd_1.md']
        assert run[runs.UNCHECKED_FILES] == one_run[runs.UNCHECKED_FILES]
        assert run['erased_workspaces'] == one_run['erased_workspaces'] == [WS, WS_TWO]

    def test_a_carried_thread_start_key_resumes_after_that_thread(self, aws):
        _seed(aws)
        pk = comments_pk(LIVE, SERIES['series_id'], workspace=A)
        member, reviewer = sorted(_threads(aws, LIVE, A), key=lambda row: row['sk'])
        cursor = {'ws': [WS], 'listing_done': True, 'deployment_done': True, 'at': {
            'links_done': True, 'ids': [LIVE], 'part': 'series', 'series': [SERIES['series_id']],
            'start': {'pk': pk, 'sk': member['sk']}}}

        following = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER).step(cursor)

        member_after, reviewer_after = sorted(_threads(aws, LIVE, A), key=lambda row: row['sk'])
        assert member_after == member
        assert (reviewer['author']['email'], reviewer_after['author']) == (REVIEWER, {'kind': 'reviewer'})
        assert following is not None
        assert following['at']['series'] == []

    @pytest.mark.parametrize(('at', 'state'), [
        ({}, 'link_registry'),
        ({'links': ['shr_' + 'a' * 32]}, 'link'),
        ({'links_done': True}, 'registry'),
        ({'links_done': True, 'ids': [LIVE]}, 'meta'),
        ({'links_done': True, 'ids': [LIVE], 'part': 'docs'}, 'docs'),
        ({'links_done': True, 'ids': [LIVE], 'part': 'series'}, 'series'),
        ({'links_done': True, 'ids': [LIVE], 'part': 'series', 'series': ['ser_' + 'a' * 24]}, 'threads'),
        ({'links_done': True, 'ids': [LIVE], 'part': 'series', 'series_listed': True}, 'project_done'),
        ({'links_done': True, 'ids': [LIVE], 'part': 'personas'}, 'personas'),
        ({'links_done': True, 'registry_done': True}, 'library'),
        ({'links_done': True, 'registry_done': True, 'library': True}, 'done'),
    ])
    def test_each_hand_made_cursor_names_its_step(self, at, state):
        assert project_people.ProjectPeopleEraser.state(at) == state

    def test_the_links_are_scrubbed_before_the_projects(self, aws):
        _seed(aws)
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER)
        states, cursor = [], None
        for _step in range(400):
            here = cursor or workspaces.listing_start(NOW)
            states.append(eraser.state(here.get('at') or {}) if here.get('ws') else 'listing')
            cursor = eraser.step(cursor)
            if cursor is None:
                break
        first_workspace = states[1:states.index('done') + 1]
        assert first_workspace.index('link') < first_workspace.index('meta')

    def test_the_step_walk_hands_over_with_the_cursor_when_time_runs_low(self):
        walk = MagicMock(run={}, aggregates=MagicMock())
        walk.time_left.side_effect = [True, False]
        cursors = iter([{'n': 1}, {'n': 2}, {'n': 3}])
        with patch.object(handler, '_hand_over', return_value={'status': 'continued'}) as hand_over, \
                patch.object(handler, 'record_progress'):
            assert handler._step_walk(walk, 'workspace_projects', None, lambda _at: next(cursors)) == {
                'status': 'continued'}
        hand_over.assert_called_once_with(walk, 'workspace_projects', {'n': 2})

    def test_the_step_walk_hands_over_at_its_page_cap_whatever_the_clock_says(self):
        walk = MagicMock(run={}, aggregates=MagicMock())
        walk.time_left.return_value = True
        with patch.object(handler, 'MAX_PAGES', 2), patch.object(handler, 'record_progress'), \
                patch.object(handler, '_page_cap', return_value={'status': 'continued'}) as cap:
            assert handler._step_walk(walk, 'workspace_lineage', None, lambda at: {'n': (at or {}).get('n', 0) + 1}) \
                == {'status': 'continued'}
        cap.assert_called_once_with(walk, 'workspace_lineage', {'n': 2})

    def test_a_carried_id_of_the_wrong_shape_fails_the_step(self, aws):
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER)
        for cursor in ({'ws': ['not-a-workspace']}, {'ws': [WS], 'at': {'links_done': True, 'ids': ['bad#id']}},
                       {'ws': [WS], 'at': {'links': ['shr_nope']}},
                       {'ws': [WS], 'at': {'links_done': True, 'ids': [LIVE], 'part': 'series', 'series': ['ser_x']}},
                       {'ws': [WS], 'at': {'links_done': True, 'ids': [LIVE] * 101}}):
            with pytest.raises(ValueError, match='not a page of ids'):
                eraser.step({**cursor, 'deployment_done': True})

    @pytest.mark.parametrize(('cursor', 'message'), [
        ({'ws': [], 'listing': 'not a key'}, 'not a map'),
        ({'ws': [WS], 'at': {'links_done': True, 'ids': [LIVE], 'part': 'elsewhere'}}, 'project part'),
        ({'ws': [WS], 'at': {'links_done': True, 'registry': 'not a key'}}, 'not a map'),
    ])
    def test_a_carried_cursor_of_the_wrong_shape_fails_the_step(self, aws, cursor, message):
        with pytest.raises(ValueError, match=message):
            project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER).step({**cursor, 'deployment_done': True})

    @pytest.mark.parametrize('cursor', [
        {'ws': [WS_TWO], 'listing_done': True, 'at': {}},
        {'ws': [WS, WS_TWO], 'listing_done': True, 'at': {}},
        {'ws': [WS], 'listing_done': False, 'at': {}},
        {'ws': [], 'listing': None, 'listing_done': False, 'at': {}},
    ])
    def test_a_one_workspace_job_refuses_a_cursor_naming_another_or_the_listing(self, aws, cursor):
        run = {**_run(), 'workspace_id': WS}
        with pytest.raises(ValueError, match='another workspace'):
            project_people.ProjectPeopleEraser(run, _tables(aws), REVIEWER).step(cursor)
        first = project_people.ProjectPeopleEraser(run, _tables(aws), REVIEWER).step(None)
        assert first is not None
        assert first['ws'] == [WS]

    def test_a_query_answering_with_its_own_start_stops_the_walk(self):
        view = MagicMock()
        view.query.return_value = {'Items': [], 'LastEvaluatedKey': {'pk': 'p', 'sk': 's'}}
        with pytest.raises(project_walk.StuckQuery):
            project_walk.query_page(view, f'WS#{WS}#PROJECT_IDS', {'pk': 'p', 'sk': 's'})
        assert view.query.call_args.kwargs['ExclusiveStartKey'] == {'pk': 'p', 'sk': 's'}


def _run() -> dict[str, Any]:
    return {**runs.new_run({}, 'erase'), 'field': 'email', 'job_id': JOB_ID, 'legal_basis': BASIS}


def _tables(aws) -> dict[str, Any]:
    return {'projects': aws['projects'], 'aggregates': aws['aggregates'], 'workspace_members': aws['workspaces']}


def _sorted(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(rows, key=lambda row: (row['pk'], row['sk']))


def _lineage_to_the_end(aws, run: dict[str, Any], workspaces_table: Any = None) -> tuple[dict[str, Any], int]:
    """The ``workspace_lineage`` phase from its start to its end, each step in a fresh invocation."""
    cursor, steps = None, 0
    while steps < 500:
        steps += 1
        carried = json.loads(json.dumps(runs.carried_state(run), default=str))
        run = {**runs.new_run({'run': carried}, 'erase'), 'job_id': JOB_ID,
               **({'workspace_id': run['workspace_id']} if run.get('workspace_id') else {})}
        cursor = lineage.workspace_step(aws['projects'], aws['aggregates'], run,
                                        json.loads(json.dumps(cursor)) if cursor else None, workspaces_table)
        if cursor is None:
            return run, steps
    raise AssertionError('the lineage walk did not end')


@pytest.mark.usefixtures('projects_env')
class TestTheWorkspacesLineage:
    def test_a_workspaces_erased_item_marks_its_own_artifacts_only(self, aws, worker_context):
        _seed(aws)
        put_workspace_feedback(aws, WS, 'f1', metadata={'email': 'jane@example.com'})
        put_workspace_feedback(aws, WS_TWO, 'f1', metadata={'email': 'john@example.com'})
        put_feedback(aws, 'f1', metadata={'email': 'john@example.com'})
        aws['projects'].put_item(Item={'pk': 'PROJECT#dep', 'sk': 'PERSONA#a', 'input_feedback_ids': ['f1']})

        result = _erase_by_email(aws, worker_context, 'jane@example.com')

        live = _persona(aws, LIVE, A)
        assert (live['input_feedback_ids'], live['evidence_feedback_ids']) == (['f2'], [])
        assert {key: live['erased_evidence'][key] for key in ('count', 'job_id', 'mode')} == {
            'count': 2, 'job_id': JOB_ID, 'mode': 'erase'}
        # The deleted project's rows are still there until its delete sweeps them: marked too.
        assert _persona(aws, DELETED, A)['input_feedback_ids'] == ['f2']
        # Workspace B's and the deployment's personas cite their own f1, kept.
        assert _persona(aws, ELSEWHERE, B)['input_feedback_ids'] == ['f1', 'f2']
        assert _row(aws, {'pk': 'PROJECT#dep', 'sk': 'PERSONA#a'})['input_feedback_ids'] == ['f1']
        assert result['artifacts_marked'] == 2

    def test_the_library_is_marked_and_no_scan_is_made(self, aws, worker_context):
        _list_workspace(aws, WS, 'Alpha')
        put_workspace_feedback(aws, WS, 'f1', metadata={'email': 'jane@example.com'})
        aws['projects'].put_item(Item={'pk': project_pk('company_personas', workspace=A), 'sk': 'PERSONA#lib',
                                       'input_feedback_ids': ['f1']})
        # The backfill ran (7.47.00): the deployment's links and series are found by Query too.
        with_marker(aws)

        with scans_of(aws) as scanned:
            result = _erase_by_email(aws, worker_context, 'jane@example.com')

        assert scanned == []
        assert result['artifacts_marked'] == 1
        assert _row(aws, {'pk': project_pk('company_personas', workspace=A), 'sk': 'PERSONA#lib'})[
            'input_feedback_ids'] == []

    def test_a_workspaces_own_erasure_by_author_marks_too(self, aws, worker_context):
        _seed(aws)
        put_workspace_feedback(aws, WS, 'f1', author='Jane')

        result = handler.handle_event(_named_job(aws, 'author', 'Jane'), worker_context)

        assert _persona(aws, LIVE, A)['input_feedback_ids'] == ['f2']
        assert result['artifacts_marked'] == 2

    def test_a_workspace_artifact_citing_an_erased_board_request_is_marked(self, aws):
        """A board request's tombstone is the deployment's: once the run de-identified one, every listed workspace's
        artifacts are looked at, and a request id is looked up there, not under the workspace."""
        _seed(aws)
        aws['projects'].put_item(Item={'pk': project_pk(ELSEWHERE, workspace=B), 'sk': 'PRD#doc_1',
                                       'input_feature_request_ids': ['fr_1', 'fr_2']})
        aws['aggregates'].put_item(Item={'pk': 'AUDIT#tombstone#feature_requests', 'sk': 'fr_1'})
        run = {**_run(), 'erased_sources': ['feature_requests'], BOARD_COUNTER: 1}
        assert lineage.has_work(run, aws['workspaces'])

        run, _steps = _lineage_to_the_end(aws, run, aws['workspaces'])

        assert _row(aws, {'pk': project_pk(ELSEWHERE, workspace=B), 'sk': 'PRD#doc_1'})[
            'input_feature_request_ids'] == ['fr_2']
        assert run['artifacts_marked'] == 1

    def test_the_marks_hand_over_and_resume_between_workspaces(self, aws):
        _seed(aws)
        run = {**_run(), 'erased_sources': ['web'], runs.LINEAGE_WORKSPACES: [WS, WS_TWO]}
        for ws in (WS, WS_TWO):
            aws['aggregates'].put_item(Item={'pk': 'AUDIT#tombstone#web', 'sk': f'{ws}#f1'})
        # More rows in the live project, so its partition takes several one-row pages (every page resumed from a key).
        for n in range(3):
            aws['projects'].put_item(Item={'pk': project_pk(LIVE, workspace=A), 'sk': f'PRD#doc_{n}',
                                           'input_feedback_ids': ['f1'] if n == 2 else ['f9']})
        with patch.object(lineage, 'PAGE_SIZE', 1), patch.object(project_walk, 'ID_PAGE', 1):
            run, steps = _lineage_to_the_end(aws, run)
        assert runs.LINEAGE_WORKSPACES not in run
        assert lineage.workspace_step(aws['projects'], aws['aggregates'], run, None) is None
        # A's live persona and document, its deleted project's persona, B's persona.
        assert run['artifacts_marked'] == 4
        assert _persona(aws, LIVE, A)['input_feedback_ids'] == ['f2']
        assert _row(aws, {'pk': project_pk(LIVE, workspace=A), 'sk': 'PRD#doc_2'})['input_feedback_ids'] == []
        assert _persona(aws, ELSEWHERE, B)['input_feedback_ids'] == ['f2']
        assert steps > 10

    def test_a_one_workspace_job_refuses_a_list_naming_another(self, aws):
        run = {**_run(), 'workspace_id': WS, runs.LINEAGE_WORKSPACES: [WS_TWO]}
        with pytest.raises(ValueError, match='another workspace'):
            lineage.workspace_step(aws['projects'], aws['aggregates'], run, None)
        with pytest.raises(ValueError, match='lineage mode'):
            lineage.workspace_step(aws['projects'], aws['aggregates'], {**run, runs.LINEAGE_WORKSPACES: [WS]},
                                   {'mode': 'elsewhere'})

    def test_a_malformed_registry_row_is_counted(self, aws):
        aws['projects'].put_item(Item={'pk': project_registry_pk(A), 'sk': 'bad#id'})
        run, _steps = _lineage_to_the_end(aws, {**_run(), 'erased_sources': ['web'], runs.LINEAGE_WORKSPACES: [WS]})
        assert run[MALFORMED_ID_COUNTER] == 1

    def test_a_workspace_lineage_write_goes_through_the_workspace_layer(self, aws):
        row = {'pk': f'WS#{WS_TWO}#PROJECT#p', 'sk': 'PERSONA#a', 'input_feedback_ids': ['f1']}
        with pytest.raises(OutOfScopeError):
            lineage.mark_artifact(aws['projects'], row, {'f1'}, _run(), A)


def deployment_project(aws, project_id: str, **meta: Any) -> None:
    """A deployment project as api/projects.py ``create_project`` writes it: listed in ``PROJECT_IDS`` (the same
    writer), then its ``META`` on ``gsi1-by-type``; one whose ``status`` is ``deleting`` or ``deleted`` as the
    delete's fence leaves it (``_start_project_deletion`` removes ``gsi1pk`` and ``gsi1sk``)."""
    register_deployment_project(aws['projects'], project_id, STAMP)
    index = {} if meta.get('status') in ('deleting', 'deleted') else {'gsi1pk': project_type_pk(), 'gsi1sk': STAMP}
    aws['projects'].put_item(Item={'pk': project_pk(project_id), 'sk': 'META', 'project_id': project_id,
                                   'created_at': STAMP, **index, **meta})


def with_marker(aws) -> None:
    """The backfill's complete marker (shared/review_registries.py ``marker_complete``)."""
    aws['projects'].put_item(Item={'pk': 'DOCSHARE_IDS', 'sk': 'MIGRATION#review-registries', 'completed_at': STAMP,
                                   'links_found': 0, 'series_found': 0, 'projects_found': 0, 'release': '7.47.0'})


class TestTheDeploymentsLineageByQuery:
    """Since 7.47.00 (3g-d) the deployment's pass reads its projects through ``PROJECT_IDS`` (a deleted or half-deleted
    one too: the delete takes it off ``gsi1-by-type``, never off the registry) and each one's own partition by Query,
    the persona library too; until the backfill's marker is there, it finds the projects by its own Scan."""

    @pytest.mark.parametrize('backfilled', [False, True])
    def test_the_pass_marks_its_projects_a_half_deleted_one_and_the_library(self, aws, worker_context, backfilled):
        put_feedback(aws, 'f1', author='Reviewer One')
        deployment_project(aws, 'p1')
        deployment_project(aws, 'p2', status='deleting')  # the fence ran, the sweep did not finish
        if backfilled:
            with_marker(aws)
        for pk in ('PROJECT#p1', 'PROJECT#p2', 'PROJECT#company_personas'):
            aws['projects'].put_item(Item={'pk': pk, 'sk': 'PERSONA#a', 'input_feedback_ids': ['f1', 'f9']})
        aws['projects'].put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PRD#d', 'input_feature_request_ids': ['fr_1']})

        with scans_of(aws) as scanned:
            result = handler.handle_event(erasure_job(aws, JOB_ID, 'author', 'Reviewer One', legal_basis=BASIS),
                                          worker_context)

        # By Query once the backfill ran; until then, one Scan of the projects' META rows.
        assert scanned == ([] if backfilled else ['test-projects'])
        assert result['artifacts_marked'] == 3
        for pk in ('PROJECT#p1', 'PROJECT#p2', 'PROJECT#company_personas'):
            assert _row(aws, {'pk': pk, 'sk': 'PERSONA#a'})['input_feedback_ids'] == ['f9']

    def test_its_steps_hand_over_and_resume_with_one_row_pages(self, aws):
        aws['aggregates'].put_item(Item={'pk': 'AUDIT#tombstone#web', 'sk': 'f1'})
        for project_id in ('p1', 'p2', 'p3'):
            deployment_project(aws, project_id)
            for n in range(2):
                aws['projects'].put_item(Item={'pk': project_pk(project_id), 'sk': f'PRD#d{n}',
                                               'input_feedback_ids': ['f1'] if n else ['f9']})
        with_marker(aws)
        run, cursor, steps = {**_run(), 'erased_sources': ['web']}, None, 0
        with patch.object(lineage, 'PAGE_SIZE', 1), patch.object(project_walk, 'ID_PAGE', 1):
            while steps < 200:
                steps += 1
                cursor = lineage.deployment_step(aws['projects'], aws['aggregates'], run,
                                                 json.loads(json.dumps(cursor, default=str)) if cursor else None)
                if cursor is None:
                    break
        assert (run['artifacts_marked'], steps > 10) == (3, True)
        assert lineage.deployment_step(aws['projects'], aws['aggregates'], run, {
            'found': 'registry', 'projects_done': True, 'library': True}) is None

    def test_a_cursor_of_the_scan_before_starts_the_pass_again(self, aws):
        """A hand-over across the upgrade carries the old Scan's row key: the pass starts from the top."""
        deployment_project(aws, 'p1')
        with_marker(aws)
        found = lineage.deployment_step(aws['projects'], aws['aggregates'], _run(), {'pk': 'PROJECT#x', 'sk': 'y'})
        assert found == {'found': 'registry'}
        moved = lineage.deployment_step(aws['projects'], aws['aggregates'], _run(), found)
        assert (moved or {}).get('ids') == ['p1']

    def test_a_registry_row_not_shaped_like_a_project_is_counted(self, aws):
        aws['projects'].put_item(Item={'pk': 'PROJECT_IDS', 'sk': 'bad#id'})
        run = _run()
        moved = lineage.deployment_step(aws['projects'], aws['aggregates'], run, {'found': 'registry'})
        assert ((moved or {}).get('ids'), run[MALFORMED_ID_COUNTER]) == ([], 1)

    def test_a_workspace_row_is_never_marked_by_the_deployments_pass(self, aws, worker_context):
        put_feedback(aws, 'f1', metadata={'email': 'jane@example.com'})
        deployment_project(aws, 'p1')
        aws['projects'].put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PERSONA#a', 'input_feedback_ids': ['f1']})
        aws['projects'].put_item(Item={'pk': f'WS#{WS}#PROJECT#p1', 'sk': 'PERSONA#a', 'input_feedback_ids': ['f1']})

        result = _erase_by_email(aws, worker_context, 'jane@example.com')

        assert result['artifacts_marked'] == 1
        assert _row(aws, {'pk': 'PROJECT#p1', 'sk': 'PERSONA#a'})['input_feedback_ids'] == []
        assert _row(aws, {'pk': f'WS#{WS}#PROJECT#p1', 'sk': 'PERSONA#a'})['input_feedback_ids'] == ['f1']

    def test_a_deployment_only_erasure_walks_no_workspace_and_carries_no_workspace_list(self, aws, worker_context):
        put_feedback(aws, 'f1', author='Jane')
        states: list[dict[str, Any]] = []
        real_new_run = runs.new_run

        def kept(event: dict[str, Any], mode: str) -> dict[str, Any]:
            state = real_new_run(event, mode)
            states.append(state)
            return state

        with patch.object(lineage, 'workspace_step') as step, patch.object(handler, 'new_run', kept):
            result = handler.handle_event(erasure_job(aws, JOB_ID, 'author', 'Jane', legal_basis=BASIS),
                                          worker_context)
        step.assert_not_called()
        assert result['deleted_items'] == 1
        [state] = states
        assert (runs.LINEAGE_WORKSPACES in state, runs.LINEAGE_WORKSPACES in runs.carried_state(state)) == (
            False, False)


@pytest.mark.usefixtures('projects_env')
class TestRound2:
    def test_a_member_named_by_the_address_and_a_list_of_members_are_de_identified(self, aws):
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER)
        by_name = {'sub-r': {'role': 'viewer', 'username': 'rae', 'name': REVIEWER.upper(), 'added_by': 'sub-ada'},
                   'sub-k': {'role': 'viewer', 'username': 'kim', 'email': 'kim@example.com'}}
        assert eraser._members(by_name) == {'sub-r': {'role': 'viewer', 'username': 'rae', 'added_by': 'sub-ada'},
                                            'sub-k': by_name['sub-k']}
        listed = [{'sub': 'sub-r', 'email': REVIEWER}, {'sub': 'sub-k', 'email': 'kim@example.com'}]
        assert eraser._members(listed) == [{'sub': 'sub-r'}, listed[1]]
        assert eraser._members([{'sub': 'sub-k'}]) is None

    def test_a_personas_research_note_by_the_address_is_relabelled(self, aws, worker_context):
        _list_workspace(aws, WS, 'Alpha')
        create_workspace_project(aws['projects'], {'pk': project_pk(LIVE, workspace=A), 'sk': 'META',
                                                   'project_id': LIVE, 'created_at': STAMP}, workspace=A)
        notes = [{'note_id': 'n1', 'text': 'Asked them', 'author': REVIEWER}, {'note_id': 'n2', 'author': 'Ada'}]
        for pk in (project_pk(LIVE, workspace=A), project_pk('company_personas', workspace=A)):
            aws['projects'].put_item(Item={'pk': pk, 'sk': 'PERSONA#p1', 'research_notes': notes})

        result = _erase_by_email(aws, worker_context)

        for pk in (project_pk(LIVE, workspace=A), project_pk('company_personas', workspace=A)):
            stored = _row(aws, {'pk': pk, 'sk': 'PERSONA#p1'})['research_notes']
            assert stored == [{**notes[0], 'author': comments.TEAM_MEMBER_NAME}, notes[1]]
        assert result[PROJECT_COUNTER] == 2

    def test_a_page_of_threads_or_documents_is_cut_after_a_row_when_the_time_runs_low(self, aws):
        _seed(aws)
        pk = comments_pk(LIVE, SERIES['series_id'], workspace=A)
        first, second = sorted(_threads(aws, LIVE, A), key=lambda row: row['sk'])
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER, time_left=lambda: False)
        at = {'links_done': True, 'ids': [LIVE], 'part': 'series', 'series': [SERIES['series_id']], 'start': None}
        moved = eraser._threads_step(A, dict(at))
        assert moved['start'] == {'pk': pk, 'sk': first['sk']}
        assert moved['series'] == [SERIES['series_id']]
        assert eraser._run[PROJECT_COUNTER] == 1
        # The carried key fed back in (as a hand-over would, through JSON): the next row is done, the first not again.
        resumed = project_people.ProjectPeopleEraser(eraser._run, _tables(aws), REVIEWER)
        with patch.object(resumed, '_erase_row', wraps=resumed._erase_row) as erase_row:
            after = resumed._threads_step(A, json.loads(json.dumps(moved)))
        assert [call.args[1]['sk'] for call in erase_row.call_args_list] == [second['sk']]
        assert (after['series'], eraser._run[PROJECT_COUNTER]) == ([], 2)
        assert all(REVIEWER not in json.dumps(thread, default=str) for thread in _threads(aws, LIVE, A))
        docs = eraser._docs_step(A, {**at, 'part': 'docs', 'docs_from': None})
        assert docs['docs_from'] == {'pk': project_pk(LIVE, workspace=A), 'sk': 'PRODUCT_DOC#pd_1'}

    def test_past_the_cap_the_lineage_list_gives_way_to_every_listed_workspace(self, aws):
        run = _run()
        for n in range(runs.MAX_LINEAGE_WORKSPACES + 1):
            runs.note_lineage_workspace(run, f'ws_{n:026d}')
        assert (runs.LINEAGE_WORKSPACES in run, run[runs.LINEAGE_ALL]) == (False, True)
        carried = runs.new_run({'run': runs.carried_state(run)}, 'erase')
        assert carried[runs.LINEAGE_ALL] is True
        assert lineage.has_work(carried, aws['workspaces'])
        # Without voc-workspaces the phase cannot reach them: it fails, named, never skips.
        assert lineage.has_work(carried, None)
        with pytest.raises(lineage.ListingUnavailable):
            lineage.workspace_step(aws['projects'], aws['aggregates'], carried, None, None)
        _list_workspace(aws, WS, 'Alpha')
        first = lineage.workspace_step(aws['projects'], aws['aggregates'], carried, None, aws['workspaces'])
        assert (first or {}).get('mode') == 'listing'

    def test_the_listing_counts_a_malformed_row_and_refuses_a_stuck_page(self, aws):
        _list_workspace(aws, WS, 'Alpha')
        aws['workspaces'].put_item(Item={'pk': 'WORKSPACES', 'sk': 'odd#x', 'workspace_id': 'not-an-id'})
        run = _run()
        page = workspaces.listing_page(run, aws['workspaces'], workspaces.listing_start(NOW), NOW)
        assert (page['ws'], run[MALFORMED_ID_COUNTER]) == ([WS], 1)
        table = MagicMock()
        table.query.return_value = {'Items': [], 'LastEvaluatedKey': {'pk': 'WORKSPACES', 'sk': 'a'}}
        for rewalk in (0, 1):  # the listing's own pages, and a re-walk pass's
            here = {**workspaces.listing_start(NOW), 'pass': rewalk, 'pass_at': NOW.isoformat(),
                    'listing': {'pk': 'WORKSPACES', 'sk': 'a'}}
            with pytest.raises(project_walk.StuckQuery):
                workspaces.listing_page(run, table, here, NOW)

    @pytest.mark.parametrize(('body', 'verdict'), [
        (f'Ask {REVIEWER}'.encode('utf-16'), True),  # a byte-order mark: UTF-16
        (f'Ask {REVIEWER}'.encode('utf-16-le'), True),  # NUL bytes, no mark: UTF-16
        ('Nothing here'.encode('utf-16'), False),
        (b'\xff\xfe\x00', None),  # a mark, then an odd byte: cannot decode
        (b'Ask \xc3\x28 ' + REVIEWER.encode(), None),  # not UTF-8: cannot judge, never "does not hold it"
        (f'﻿Ask {REVIEWER}'.encode(), True),  # UTF-8 with its mark (U+FEFF first)
    ])
    def test_text_is_decoded_strictly_or_not_judged(self, aws, body, verdict):
        aws['s3'].put_object(Bucket=BUCKET, Key='ws/x/doc.txt', Body=body)
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER, aws['s3'], BUCKET)
        assert eraser._holds_address('ws/x/doc.txt') is verdict

    def test_a_research_note_author_holding_the_address_is_replaced_whole(self, aws):
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER)
        notes = [{'author': f'Rae <{REVIEWER.upper()}>'}, {'author': 'Ada'}]
        assert eraser._research_notes(notes) == [{'author': comments.TEAM_MEMBER_NAME}, {'author': 'Ada'}]

    def test_a_long_address_cut_to_the_name_length_still_matches(self, aws):
        long_address = 'r' * 130 + '@partner.example'
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), long_address)
        cut = long_address[:comments.MAX_NAME_CHARS]
        assert eraser._label(cut) == comments.TEAM_MEMBER_NAME
        assert eraser._author({'kind': 'user', 'sub': 's', 'name': cut}) == {
            'kind': 'user', 'sub': 's', 'name': comments.TEAM_MEMBER_NAME}
        assert eraser._label('r' * 10) is None

    def test_a_malformed_record_whose_filename_holds_the_address_is_listed_and_closes_exports(self, aws):
        eraser = project_people.ProjectPeopleEraser(_run(), _tables(aws), REVIEWER, aws['s3'], BUCKET)
        with patch.object(project_people.exports, 'note_workspace') as noted:
            eraser._product_doc(A, LIVE, {'sk': 'PRODUCT_DOC#bad#id', 'filename': f'{REVIEWER}.md',
                                          's3_raw_key': 'elsewhere/a.md'})
        noted.assert_called_once()
        assert (eraser._run['review_files'], eraser._run[MALFORMED_ID_COUNTER]) == ([_docs(LIVE, A)], 1)
        assert runs.UNCHECKED_FILES not in eraser._run

    def test_a_reviewer_without_a_name_keeps_none(self):
        assert comments.reviewer_author(REVIEWER)['name'] == ''
        assert comments.reviewer_author(REVIEWER, 'Rae')['name'] == 'Rae'


WS_THREE: Final = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DA'
C = WorkspaceScope(WS_THREE)
THIRD: Final = 'proj_c_000004'
NOW: Final = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)


def _moved_meanwhile(aws, ws: str, old: str | None, new: str, stamp: str) -> None:
    """A rename (or, ``old`` None, a create) landing while a walk pages the listing: the listing row moved to its new
    name's key and stamped as shared/workspace_rename.py stamps it (a create's row carries its ``created_at``)."""
    if old is not None:
        aws['workspaces'].delete_item(Key={'pk': 'WORKSPACES', 'sk': f'{old.casefold()}#{ws}'})
    stamps = {'created_at': STAMP, 'renamed_at': stamp} if old is not None else {'created_at': stamp}
    aws['workspaces'].put_item(Item={'pk': 'WORKSPACES', 'sk': f'{new.casefold()}#{ws}', 'workspace_id': ws,
                                     'name': new, 'slug': 'third', 'status': 'active', 'secret_status': 'ready',
                                     **stamps})


class _Listing:
    """Counts the walk's Queries of the listing partition (the real table answers them)."""

    def __init__(self, table: Any) -> None:
        self.table, self.requests = table, []

    def query(self, **request: Any) -> dict[str, Any]:
        if request.get('ExpressionAttributeValues', {}).get(':pk') == 'WORKSPACES':
            self.requests.append(request)
        return self.table.query(**request)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.table, name)


def _erase_with(aws, listing: Any, meanwhile: Any = None) -> dict[str, Any]:
    """The projects walk of an erasure of ``REVIEWER``, every listing page one row and each step handed over
    (JSON), its clock ``NOW``; ``meanwhile(step, cursor)`` runs after each step. The run at the end."""
    run, cursor = _run(), None
    tables = {**_tables(aws), 'workspace_members': listing}
    with patch.multiple(workspaces, ID_PAGE=1):
        for step in range(1, 2000):
            eraser = project_people.ProjectPeopleEraser(run, tables, REVIEWER, aws['s3'], BUCKET, clock=lambda: NOW)
            cursor = eraser.step(json.loads(json.dumps(cursor)) if cursor else None)
            if cursor is None:
                return run
            if meanwhile is not None:
                meanwhile(step, cursor)
    raise AssertionError('the walk did not end')


def _noting_walks(walked: list[str]) -> Any:
    """``workspaces.registry_step`` patched to note each workspace as its walk reaches its registry's first page."""
    real = workspaces.registry_step

    def noted(projects_table, run, scope, at, **starting):
        if scope is not None and not at.get('registry'):
            walked.append(scope.ws)
        return real(projects_table, run, scope, at, **starting)

    return patch.object(workspaces, 'registry_step', noted)


def _erased(aws, project_id: str, scope: WorkspaceScope) -> bool:
    return all(REVIEWER not in json.dumps(thread, default=str) for thread in _threads(aws, project_id, scope))


@pytest.mark.usefixtures('projects_env')
class TestAWorkspaceMovedInTheListingMeanwhileIsWalked:
    """The listing is sorted by name: a rename moves a row to its new name's key, maybe behind the page a walk already
    read. When the listing ends the walk reads again the rows renamed or created since it began (less ``SKEW``)."""

    @pytest.fixture(autouse=True)
    def _seeded(self, aws):
        _list_workspace(aws, WS, 'Alpha')
        _list_workspace(aws, WS_TWO, 'Beta')
        _list_workspace(aws, WS_THREE, 'Gamma')
        _project(aws, THIRD, C)

    @pytest.mark.parametrize(('old', 'new'), [('Gamma', 'Aardvark'), (None, 'Aaron')])
    def test_a_workspace_renamed_or_created_behind_the_cursor_is_walked(self, aws, old, new):
        stamp = (NOW + timedelta(seconds=1)).isoformat()
        if old is None:
            aws['workspaces'].delete_item(Key={'pk': 'WORKSPACES', 'sk': f'gamma#{WS_THREE}'})

        def moved_after_the_first_page(step: int, _cursor: dict[str, Any]) -> None:
            if step == 1:
                _moved_meanwhile(aws, WS_THREE, old, new, stamp)

        run = _erase_with(aws, aws['workspaces'], moved_after_the_first_page)
        assert _erased(aws, THIRD, C)
        assert WS_THREE in run['erased_workspaces']

    def test_the_lineage_walk_of_every_listed_workspace_reaches_a_moved_one_too(self, aws):
        run = {**_run(), runs.LINEAGE_ALL: True}
        walked: list[str] = []
        cursor = None
        with patch.multiple(workspaces, ID_PAGE=1), _noting_walks(walked):
            for step in range(1, 500):
                cursor = lineage.workspace_step(aws['projects'], aws['aggregates'], run,
                                                json.loads(json.dumps(cursor)) if cursor else None, aws['workspaces'],
                                                lambda: NOW)
                if step == 1:
                    _moved_meanwhile(aws, WS_THREE, 'Gamma', 'Aardvark', (NOW + timedelta(seconds=1)).isoformat())
                if cursor is None:
                    break
        assert walked == [WS, WS_TWO, WS_THREE]

    def test_without_the_rewalk_that_workspace_would_be_missed(self, aws):
        """The red proof: the listing's own pages alone never reach the moved row."""
        listing = workspaces.listing_start(NOW)
        seen: list[str] = []
        with patch.multiple(workspaces, ID_PAGE=1):
            here = workspaces.listing_page(_run(), aws['workspaces'], listing, NOW)
            seen += here['ws']
            _moved_meanwhile(aws, WS_THREE, 'Gamma', 'Aardvark', NOW.isoformat())
            while here['pass'] == 0:
                here = workspaces.listing_page(_run(), aws['workspaces'], {**here, 'ws': []}, NOW)
                seen += here['ws']
        assert WS_THREE not in seen

    def test_with_nothing_moved_the_walk_ends_after_exactly_one_more_query(self, aws):
        listing = _Listing(aws['workspaces'])
        _erase_with(aws, listing)
        listing_pages = listing.requests
        filtered = [r for r in listing_pages if 'FilterExpression' in r]
        # Three pages of one row (the last says no more), then one filtered Query that finds nothing.
        assert (len(listing_pages) - len(filtered), len(filtered)) == (3, 1)
        assert filtered[0]['ConsistentRead'] is True
        assert filtered[0]['ExpressionAttributeValues'][':since'] == (NOW - workspaces.SKEW).isoformat()

    def test_a_row_renamed_once_is_walked_once_more_and_the_walk_ends(self, aws):
        """Pass 1 walks it; pass 2 finds the same row with the same stamp, already walked: the walk ends."""
        listing = _Listing(aws['workspaces'])
        _moved_meanwhile(aws, WS_THREE, 'Gamma', 'Aardvark', NOW.isoformat())
        walked: list[str] = []
        with _noting_walks(walked):
            _erase_with(aws, listing)
        filtered = [r for r in listing.requests if 'FilterExpression' in r]
        assert len(filtered) == 2
        # The listing's own pages (Aardvark first by name), then pass 1's re-walk of it; pass 2 skips it.
        assert walked == [WS_THREE, WS, WS_TWO, WS_THREE]

    def test_a_listing_that_keeps_moving_fails_the_job_past_the_pass_cap(self):
        table = MagicMock()
        stamps = iter(range(1, 100))

        def renamed_again(**_request: Any) -> dict[str, Any]:
            at = (NOW + timedelta(seconds=next(stamps))).isoformat()
            return {'Items': [{'pk': 'WORKSPACES', 'sk': f'x#{WS_THREE}', 'workspace_id': WS_THREE,
                               'created_at': STAMP, 'renamed_at': at}]}

        table.query.side_effect = renamed_again
        start = {**workspaces.listing_start(NOW), 'pass': 1, 'listing': None}

        def every_pass(here: dict[str, Any]) -> None:
            for _ in range(10):
                here = workspaces.listing_page(_run(), table, {**here, 'ws': []}, NOW)

        with pytest.raises(workspaces.ListingKeptMoving, match='kept moving'):
            every_pass(start)
        assert table.query.call_count == workspaces.MAX_REWALKS == 3

    def test_more_moved_rows_than_a_pass_carries_fail_the_job(self):
        table = MagicMock()
        row = {'pk': 'WORKSPACES', 'sk': f'x#{WS_THREE}', 'workspace_id': WS_THREE, 'created_at': NOW.isoformat()}
        table.query.return_value = {'Items': [row] * workspaces.MAX_MOVED}
        here = {**workspaces.listing_start(NOW), 'pass': 1}
        assert len(workspaces.listing_page(_run(), table, here, NOW)['ws']) == workspaces.MAX_MOVED
        table.query.return_value = {'Items': [row] * (workspaces.MAX_MOVED + 1)}
        with pytest.raises(workspaces.ListingKeptMoving, match='More than 100'):
            workspaces.listing_page(_run(), table, here, NOW)

    def test_the_hand_over_carries_the_start_and_the_rewalk_state(self, aws):
        start = workspaces.listing_start(NOW)
        assert (start['since'], start['pass']) == ((NOW - workspaces.SKEW).isoformat(), 0)
        later = NOW + timedelta(minutes=20)
        # Renamed as the first re-walk pass begins: that pass walks it, and a second must look again.
        _moved_meanwhile(aws, WS_THREE, 'Gamma', 'Aardvark', later.isoformat())
        here = {**start, 'pass': 1, 'listing': None}
        page = workspaces.listing_page(_run(), aws['workspaces'], here, later)
        carried = json.loads(json.dumps(page))
        assert carried['ws'] == [WS_THREE]
        # The next pass reads from this one's start (less SKEW), and skips the row this one walked, as stamped.
        assert (carried['pass'], carried['since'], carried['seen'], carried['listing'], carried['listing_done']) == (
            2, (later - workspaces.SKEW).isoformat(), [[WS_THREE, later.isoformat()]], None, False)
        resumed = workspaces.listing_page(_run(), aws['workspaces'], {**carried, 'ws': []}, later)
        assert (resumed['ws'], resumed['listing_done']) == ([], True)

    @pytest.mark.parametrize('broken', [
        {'pass': 4}, {'pass': -1}, {'pass': '1'}, {'since': 7}, {'seen': [['not-a-ws', STAMP]]},
        {'seen': [[WS, STAMP]] * 101}, {'seen': 'x'}, {'newer': 'yes'},
    ])
    def test_a_carried_rewalk_state_of_the_wrong_shape_fails_the_step(self, aws, broken):
        here = {**workspaces.listing_start(NOW), 'pass': 1, **broken}
        with pytest.raises(ValueError, match='listing pass'):
            workspaces.listing_page(_run(), aws['workspaces'], here, NOW)
