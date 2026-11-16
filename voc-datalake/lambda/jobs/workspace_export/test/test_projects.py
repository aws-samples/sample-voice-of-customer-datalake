"""voc-workspace-export, projects 3g-a (7.39.00, jobs/workspace_export/projects.py): a workspace's projects in its
export, end to end in moto. Workspace A has a live project and a deleted one, each with its own rows, personas,
document versions and a saved revision, comment threads (a member's and a reviewer's), a review link whose audience
lists an address, jobs (one an assist), a link to a participant list and a product document (its record and its
upload), and a company persona library; workspace B has a project of its own beside them. The projects, their
claims and registry rows, the review links and the threads are written by their own stores
(shared/project_writes.py ``create_workspace_project``, shared/document_share.py ``create_share``,
shared/document_comments.py ``put_thread``), the rest with shared/project_keys.py's key builders as their stores
write them. The export holds exactly the allowlisted fields of the live project, skips and counts the deleted one,
never names a partition of another workspace, resumes from a checkpoint of 7.38.00, and counts nothing twice
across hand-overs."""
from __future__ import annotations

import json
from typing import Any, Final
from unittest.mock import MagicMock

import pytest

from jobs.workspace_export import handler, projects
from jobs.workspace_export.pages import Page, Row
from jobs.workspace_export.test.conftest import EXPORT_ID, OTHER, WS, Budget, World, queue, seed
from jobs.workspace_export.test.test_handler import _jsonl, _unzip
from jobs.workspace_export.test.test_handler import _run as _run_from
from jobs.workspace_export.test.test_memory import _run as _run_export
from shared import document_comments as comments
from shared import document_share as ds
from shared.company_personas import COMPANY_PERSONAS_CONTAINER
from shared.participants_keys import project_link_key
from shared.project_keys import (
    document_revision_key,
    project_pk,
    project_registry_key,
    project_registry_pk,
    project_type_pk,
    review_link_key,
    version_counter_key,
)
from shared.project_writes import create_workspace_project
from shared.ws_repo import WorkspaceScope

A, B = WorkspaceScope(WS), WorkspaceScope(OTHER)
LIVE, DELETED, ELSEWHERE = 'proj_live_000001', 'proj_gone_000002', 'proj_else_000003'
SERIES: Final = {'series_id': 'ser_' + 'a' * 24, 'document_type': 'prfaq', 'base_title': 'Launch'}
CREATOR: Final = {'sub': 'sub-ada', 'name': 'Ada Admin'}
REVIEWER: Final = 'rev@partner.example'
STAMP: Final = '2026-11-01T09:00:00+00:00'
#: Text only the deleted project's and the other workspace's rows hold.
DELETED_TEXT, ELSEWHERE_TEXT = 'The deleted project said this.', 'Workspace B wrote this.'


def _create_project(world: World, project_id: str, scope: WorkspaceScope, name: str) -> None:
    create_workspace_project(world.projects, {
        'pk': project_pk(project_id, workspace=scope), 'sk': 'META', 'project_id': project_id, 'name': name,
        'gsi1pk': project_type_pk(workspace=scope), 'gsi1sk': STAMP, 'created_at': STAMP, 'status': 'active',
        'owner_email': 'ada@example.com',
        'members': {'sub-vic': {'role': 'editor', 'email': 'vic@example.com', 'invite_token': 'not for the export'}}},
        workspace=scope)


def _rows_of(world: World, project_id: str, scope: WorkspaceScope, text: str) -> dict[str, Any]:
    """One project's rows beside its META, its link and its threads; the link it made."""
    own = project_pk(project_id, workspace=scope)
    for item in (
        # Excluded: a credential-shaped attribute, a stored signed URL, index keys; one no list classifies yet.
        {'pk': own, 'sk': 'PRD#doc_1', 'document_id': 'doc_1', 'title': 'Checkout PRD', 'content': text,
         'token_hash': 'h' * 64, 'prototype_url': 'https://cdn.example/signed?x=1', 'gsi1pk': f'{own}#DOCUMENTS',
         'gsi1sk': STAMP, 'later_attribute': 'not classified yet'},
        {'pk': own, 'sk': 'PRODUCT_DOC#pd_1', 'doc_id': 'pd_1', 'status': 'ready', 'title': 'Spec',
         's3_raw_key': f'ws/{scope.ws}/projects/{project_id}/product_docs/raw/pd_1.md'},
        {'pk': own, 'sk': 'PRODUCT_CONTEXT', 'summary': text},
        # A nested key named like a secret, refused at any depth.
        {'pk': own, 'sk': 'PERSONA#per_1', 'persona_id': 'per_1', 'name': 'Mobile shopper', 'quotes': [text],
         'identity': {'age_range': '30s', 'source': {'api_key': 'nested secret value'}}},
        # A kind no release lists: never read.
        {'pk': own, 'sk': 'LATER_KIND#x', 'secret': 'not for the export'},
    ):
        world.projects.put_item(Item=item)
    counter = version_counter_key(project_id, 'prd', 'checkout prd', workspace=scope)
    world.projects.put_item(Item={**counter, 'last_version': 2, 'base_title': 'Checkout PRD',
                                  'migration_owner': 'lease-1', 'migration_expires_at': 99})
    world.projects.put_item(Item={**document_revision_key(project_id, 'doc_1', 1, workspace=scope),
                                  'document_id': 'doc_1', 'revision': 1, 'title': 'Checkout PRD', 'content': text,
                                  'saved_at': STAMP, 'replaced_at': STAMP})
    share, _ = ds.create_share(world.projects, project_id=project_id, series=SERIES, document_id='doc_1',
                               creator=CREATOR, values=ds.validate_share_body(
                                   {'audience': {'mode': 'list', 'emails': [REVIEWER]}}), workspace=scope)
    member = comments.thread_item(project_id=project_id, series_id=SERIES['series_id'],
                                  document={'document_id': 'doc_1', 'version': 1},
                                  author=comments.user_author('sub-ada', 'Ada Admin'), text=text, anchor=None,
                                  workspace=scope)
    member['addressed_history'] = [{'version': 2, 'document_id': 'doc_2', 'at': STAMP, 'by_kind': 'user',
                                    'by_sub': 'sub-ada', 'addressed': True}]
    reviewer = comments.thread_item(project_id=project_id, series_id=SERIES['series_id'],
                                    document={'document_id': 'doc_1', 'version': 1},
                                    author=comments.reviewer_author(REVIEWER, 'Rae Reviewer'), text=text,
                                    anchor=None, share_id=share['share_id'], workspace=scope)
    reviewer['replies'] = [comments.reply_item(comments.reviewer_author(REVIEWER), 'One more thing.')]
    for thread in (member, reviewer):
        comments.put_thread(world.projects, thread, workspace=scope)
    for item in (
        {'pk': own, 'sk': 'JOB#job_1', 'job_id': 'job_1', 'project_id': project_id, 'job_type': 'generate_prd',
         'status': 'completed', 'doc_config': {'title': text, 'category_scope': {'all': False}}, 'ttl': 99,
         'gsi1pk': f'WS#{scope.ws}#STATUS#completed', 'gsi1sk': STAMP, 'initiated_by': 'sub-ada'},
        {'pk': own, 'sk': 'JOB#job_2', 'job_id': 'job_2', 'job_type': 'assist_prfaq_autofill', 'config': {}},
    ):
        world.jobs.put_item(Item=item)
    world.participants.put_item(Item={**project_link_key(project_id, 'LIST', 'lst_1', workspace=scope),
                                      'target_id': 'lst_1', 'added_at': STAMP, 'added_by': 'sub-ada',
                                      'later_field': 'a later field'})
    world.s3.seed(f'ws/{scope.ws}/projects/{project_id}/product_docs/raw/pd_1.md', b'# Spec', 'text/markdown')
    return share


def seed_projects(world: World, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Workspace A's live and deleted projects and its persona library; workspace B's project. The links made."""
    monkeypatch.setenv('PROJECTS_TABLE', world.projects.name)
    _create_project(world, LIVE, A, 'Checkout')
    _create_project(world, DELETED, A, 'Old idea')
    _create_project(world, ELSEWHERE, B, 'Elsewhere')
    links = {LIVE: _rows_of(world, LIVE, A, 'The checkout is slow on a phone.'),
             DELETED: _rows_of(world, DELETED, A, DELETED_TEXT),
             ELSEWHERE: _rows_of(world, ELSEWHERE, B, ELSEWHERE_TEXT)}
    # A project delete in a workspace keeps its registry row, marked deleted (3h).
    world.projects.update_item(Key=project_registry_key(DELETED, workspace=A), UpdateExpression='SET deleted_at = :at',
                               ExpressionAttributeValues={':at': STAMP})
    # A registry row not shaped like a project id (counted malformed), and one naming the library's reserved id
    # (skipped, not counted: the library is walked once, after the registry).
    for odd in ('bad#id', COMPANY_PERSONAS_CONTAINER):
        world.projects.put_item(Item={'pk': project_registry_pk(A), 'sk': odd, 'created_at': STAMP})
    library = project_pk(COMPANY_PERSONAS_CONTAINER, workspace=A)
    world.projects.put_item(Item={'pk': library, 'sk': 'META', 'kind': 'company_personas', 'name': 'Company personas'})
    world.projects.put_item(Item={'pk': library, 'sk': 'PERSONA#per_lib', 'persona_id': 'per_lib', 'name': 'Buyer'})
    return links


@pytest.fixture
def queried(world: World) -> list[str]:
    """Every partition a Query of the project tables named (botocore's own parameters, before the call)."""
    seen: list[str] = []
    names = {world.projects.name, world.jobs.name, world.participants.name}

    def record(params: dict[str, Any], **_kwargs: Any) -> None:
        if params.get('TableName') in names:
            seen.append(str(params['ExpressionAttributeValues'][':p']))

    world.projects.meta.client.meta.events.register('provide-client-params.dynamodb.Query', record)
    return seen


def _resume(world: World, event: dict[str, Any]) -> None:
    """Every invocation from ``event`` (a checkpoint) on, to a completed export."""
    assert _run_from(world, event)[-1]['status'] == 'completed'


def _export(world: World, checks: int | None = None) -> tuple[dict[str, bytes], list[dict[str, Any]]]:
    """One export from its start, each invocation a budget of ``checks``: its zip's files and every hand-over's
    payload."""
    payloads = _run_export(world, checks)
    return _unzip(world), payloads


def _every_byte(files: dict[str, bytes]) -> str:
    return json.dumps({name: body.decode(errors='replace') for name, body in files.items()})


def test_the_live_project_is_exported_with_only_its_allowlisted_fields(world, monkeypatch):
    seed(world)
    links = seed_projects(world, monkeypatch)
    files, _ = _export(world)

    own = project_pk(LIVE, workspace=A)
    documents = _jsonl(files, 'projects_documents')
    library = project_pk(COMPANY_PERSONAS_CONTAINER, workspace=A)
    assert sorted((row['pk'], row['sk']) for row in documents) == sorted([
        (own, 'META'), (own, 'PRODUCT_CONTEXT'), (own, 'PRD#doc_1'), (own, 'PRODUCT_DOC#pd_1'), (library, 'META')])
    by_sk = {(row['pk'], row['sk']): row for row in documents}
    # The stored row through its classification: what project_fields.py excludes, or classifies neither way, is out.
    assert by_sk[(own, 'PRD#doc_1')] == {'pk': own, 'sk': 'PRD#doc_1', 'document_id': 'doc_1', 'title': 'Checkout PRD',
                                         'content': 'The checkout is slow on a phone.'}
    # The META's owner email is exported (collaboration data); its index keys are not.
    assert {name: by_sk[(own, 'META')].get(name) for name in ('owner_email', 'gsi1pk', 'gsi1sk')} == {
        'owner_email': 'ada@example.com', 'gsi1pk': None, 'gsi1sk': None}
    # Each member's listed fields only, emails included.
    assert by_sk[(own, 'META')]['members'] == {'sub-vic': {'role': 'editor', 'email': 'vic@example.com'}}
    personas = _jsonl(files, 'personas')
    assert [row['name'] for row in personas] == ['Mobile shopper', 'Buyer']
    # A nested secret-named key is refused, the rest of its map exported.
    assert personas[0]['identity'] == {'age_range': '30s', 'source': {}}

    versions = _jsonl(files, 'document_versions')
    assert all(set(row) <= set(projects.VERSION_FIELDS) for row in versions)
    assert sorted(row.get('content', '') for row in versions) == ['', 'The checkout is slow on a phone.']
    assert not [row for row in versions if 'migration_owner' in row]

    threads = _jsonl(files, 'document_comments')
    assert all(set(row) <= {*projects.THREAD_FIELDS, 'from_review_link'} for row in threads)
    by_kind = {row['author']['kind']: row for row in threads}
    assert by_kind['user']['author'] == {'kind': 'user', 'sub': 'sub-ada', 'name': 'Ada Admin'}
    assert by_kind['user']['addressed_history'] == [{'version': 2, 'document_id': 'doc_2', 'at': STAMP,
                                                     'by_kind': 'user', 'addressed': True}]
    # A reviewer's address is the workspace's own collaboration data; its digest and the link id are not exported.
    assert by_kind['reviewer']['author'] == {'kind': 'reviewer', 'email': REVIEWER, 'name': 'Rae Reviewer'}
    # A reviewer who gave no name keeps none (7.43.00: the address is never copied into a name).
    assert by_kind['reviewer']['replies'][0]['author'] == {'kind': 'reviewer', 'email': REVIEWER, 'name': ''}
    assert (by_kind['reviewer']['from_review_link'], by_kind['user']['from_review_link']) == (True, False)

    [link] = _jsonl(files, 'review_links')
    assert set(link) == set(projects.LINK_FIELDS) - {'revoked_by'}
    assert (link['project_id'], link['audience']['emails'], link['created_by_name']) == (LIVE, [REVIEWER], 'Ada Admin')

    [job] = _jsonl(files, 'project_jobs')
    assert job == {'pk': own, 'sk': 'JOB#job_1', 'job_id': 'job_1', 'project_id': LIVE, 'job_type': 'generate_prd',
                   'status': 'completed', 'doc_config': {'title': 'The checkout is slow on a phone.'},
                   'initiated_by': 'sub-ada'}
    assert _jsonl(files, 'project_lists') == [{'pk': own, 'sk': 'LIST#lst_1', 'target_id': 'lst_1',
                                               'added_at': STAMP, 'added_by': 'sub-ada'}]
    # A regression guard of the manifest's product_documents note (the objects phase, 4b, copies the upload; this
    # slice changes nothing there).
    assert files[f'objects/projects/{LIVE}/product_docs/raw/pd_1.md'] == b'# Spec'

    every = _every_byte(files)
    for secret in (links[LIVE]['share_id'], comments.email_digest(REVIEWER), 'h' * 64, 'lease-1', 'LATER_KIND',
                   'a later field', 'assist_prfaq_autofill', 'not classified yet', 'cdn.example',
                   'nested secret value', 'invite_token', 'category_scope'):
        assert secret not in every


def test_the_deleted_project_is_skipped_never_exported_and_counted(world, monkeypatch, queried):
    """None of a deleted project's rows is exported: its own partitions are never read, and its link's row is read
    (to find the project it names) and dropped."""
    seed(world)
    links = seed_projects(world, monkeypatch)
    files, _ = _export(world)
    every = _every_byte(files)
    assert DELETED_TEXT not in every
    assert links[DELETED]['share_id'] not in every
    assert not [partition for partition in queried if DELETED in partition]
    assert review_link_key(links[DELETED]['share_id'], workspace=A)['pk'] in queried
    # Its objects, when any are left, are still copied by the objects phase (the per-project delete, 3h, removes them).
    assert f'objects/projects/{DELETED}/product_docs/raw/pd_1.md' in files
    manifest = json.loads(files['manifest.json'])
    section = manifest['projects']
    assert (section['exported'], section['live'], section['deleted_skipped'], section['malformed_skipped'],
            section['review_links_skipped'], section['unclassified_fields'], section['secret_named_fields_refused'],
            section['deleted_during_export']) == (True, 1, 1, 1, 1, {'later_attribute': 1}, 1, {})
    assert 'product_docs' in section['product_documents']
    counts = {entity: manifest['entities'][entity]['count'] for entity in projects.ENTITIES}
    assert counts == {'projects_documents': 5, 'personas': 2, 'document_versions': 2, 'document_comments': 2,
                      'review_links': 1, 'project_jobs': 1, 'project_lists': 1}
    assert {'projects_documents', 'personas'}.isdisjoint(manifest['not_per_workspace'])
    assert 'agents_workflows' in manifest['not_per_workspace']


def test_another_workspaces_rows_are_never_read(world, monkeypatch, queried):
    seed(world)
    links = seed_projects(world, monkeypatch)
    files, _ = _export(world)
    assert queried
    assert all(partition.startswith(f'WS#{WS}#') for partition in queried)
    every = _every_byte(files)
    for absent in (OTHER, ELSEWHERE, ELSEWHERE_TEXT, links[ELSEWHERE]['share_id']):
        assert absent not in every


def test_a_resume_from_a_checkpoint_of_7_38_00(world, monkeypatch):
    """A 7.38.00 checkpoint carries no ``projects_exported``: one still in the memory entities writes the projects;
    one already at the objects finishes without them and its manifest says so."""
    seed(world)
    seed_projects(world, monkeypatch)
    before = {**queue(world), 'run': {'generation': 0, 'phase': 'memory_events'}}
    _resume(world, before)
    assert json.loads(_unzip(world)['manifest.json'])['projects']['live'] == 1
    assert _jsonl(_unzip(world), 'projects_documents')

    world.s3.objects.clear()
    world.aggregates.delete_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': EXPORT_ID})
    past = {**queue(world), 'run': {'generation': 0, 'phase': 'objects'}}
    _resume(world, past)
    files = _unzip(world)
    manifest = json.loads(files['manifest.json'])
    assert not [name for name in files if name.split('/', 1)[0] in projects.ENTITIES]
    assert (manifest['projects']['exported'], 'projects' in manifest['not_exported']) == (False, True)
    assert handler.RunState.from_event({'run': {'generation': 1, 'phase': 'objects'}}, A).projects_exported is False


#: Every phase a 7.38.00 checkpoint can name (its entities, then the objects, the counts and the completion).
PHASES_7_38: Final = ('feedback', 'plugin_configs', 'feedback_forms', 'import_runs', 'erasure_jobs', 'workspace',
                      'members', 'audit', 'plugin_config_history', 'memory_company', 'memory_imports',
                      'memory_events', 'objects', 'memory_counts', 'conversation_counts', 'manifest')


@pytest.mark.parametrize('phase', [*PHASES_7_38, 8, 9])
def test_a_checkpoint_without_the_flag_writes_the_projects_only_before_them(phase):
    """Each 7.38.00 phase, and 4b's numbered 8 (plugin_config_history) and 9 (the objects): still in the entities,
    the projects are written; past them, they are not."""
    run = handler.RunState.from_event({'run': {'generation': 1, 'phase': phase}}, A)
    assert run.projects_exported is (run.phase in PHASES_7_38[:12])


@pytest.mark.parametrize('checks', [3, 4, 5, 7])
def test_a_hand_over_mid_entity_counts_nothing_twice(world, monkeypatch, checks):
    """Small budgets hand over everywhere, between rows of a project entity too (its registry read in one page at
    a time); the rows and the counts are those of a one-shot export."""
    seed(world)
    seed_projects(world, monkeypatch)
    monkeypatch.setattr(projects, 'ID_PAGE', 1)
    one_shot, _ = _export(world)
    world.s3.objects.clear()
    world.aggregates.delete_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': EXPORT_ID})
    resumed, payloads = _export(world, checks)
    mid_entity = [payload for payload in payloads
                  if payload['run']['phase'] in projects.ENTITIES and payload['run']['cursor'] is not None]
    assert mid_entity
    rows = {entity: _jsonl(one_shot, entity) for entity in projects.ENTITIES}
    assert {entity: _jsonl(resumed, entity) for entity in projects.ENTITIES} == rows
    sections = [json.loads(files['manifest.json'])['projects'] for files in (one_shot, resumed)]
    assert sections[0] == sections[1]


def test_a_link_whose_row_expired_is_counted_not_exported(world, monkeypatch):
    seed(world)
    links = seed_projects(world, monkeypatch)
    world.projects.delete_item(Key=review_link_key(links[LIVE]['share_id'], workspace=A))
    files, _ = _export(world)
    assert _jsonl(files, 'review_links') == []
    section = json.loads(files['manifest.json'])['projects']
    assert (section['review_links_expired'], section['review_links_skipped']) == (1, 1)


def test_a_carried_cursor_naming_a_malformed_id_fails_the_export(world, monkeypatch):
    seed(world)
    seed_projects(world, monkeypatch)
    event = {**queue(world), 'run': {'generation': 0, 'phase': 'personas', 'cursor': {'ids': ['a#b']}}}
    assert handler.handle_event(event, Budget())['status'] == 'failed'
    # A malformed run state, failed as such before anything is read (handler.py ``_fail_malformed``).
    row = world.aggregates.get_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': EXPORT_ID})['Item']
    assert (row['status'], row['error']) == ('failed', handler.MALFORMED_RUN)


def test_a_project_deleted_after_its_registry_page_was_read_is_skipped_by_the_next_entity(world, monkeypatch):
    """The registry page named the project live; it is deleted before ``personas`` reaches it (a hand-over's cursor
    carries it): the entity reads the registry again as the project starts, skips it and counts it."""
    seed(world)
    seed_projects(world, monkeypatch)
    world.projects.update_item(Key=project_registry_key(LIVE, workspace=A), UpdateExpression='SET deleted_at = :at',
                               ExpressionAttributeValues={':at': STAMP})
    cursor = {'ids': [LIVE], 'registry': None, 'registry_done': True}
    _resume(world, {**queue(world), 'run': {'generation': 0, 'phase': 'personas', 'cursor': cursor}})
    files = _unzip(world)
    assert [row['name'] for row in _jsonl(files, 'personas')] == ['Buyer']  # the library's only
    # The later entities read the registry afresh, which names it deleted (deleted_skipped, not counted here).
    assert json.loads(files['manifest.json'])['projects']['deleted_during_export'] == {'personas': 1}


MORE: Final = f'{projects.UNCLASSIFIED}{projects.UNCLASSIFIED_MORE}'


def test_the_carried_counts_keep_at_most_fifty_unclassified_entries_the_bucket_among_them():
    """7.43.00: the bucket is one of the fifty (before, fifty names and the bucket made 51)."""
    counts: dict[str, int] = {'feedback': 3}
    for n in range(60):
        projects.add_tally(counts, {f'{projects.UNCLASSIFIED}field_{n}': 1, 'probe': 1})
    named = [name for name in counts if name.startswith(projects.UNCLASSIFIED)]
    assert (len(named), counts[MORE], counts['probe']) == (50, 11, 60)
    assert f'{projects.UNCLASSIFIED}field_48' in counts
    assert f'{projects.UNCLASSIFIED}field_49' not in counts


def test_forty_nine_names_need_no_bucket_and_a_carried_bucket_keeps_counting():
    counts: dict[str, int] = {}
    projects.add_tally(counts, {f'{projects.UNCLASSIFIED}field_{n}': 1 for n in range(49)})
    assert (len(counts), MORE in counts) == (49, False)
    # A hand-over carries the counts: the bucket, once there, takes every new name, and a kept name still counts.
    projects.add_tally(counts, {f'{projects.UNCLASSIFIED}field_50': 2, f'{projects.UNCLASSIFIED}field_0': 1})
    projects.add_tally(counts, {f'{projects.UNCLASSIFIED}field_51': 1})
    assert (len(counts), counts[MORE], counts[f'{projects.UNCLASSIFIED}field_0']) == (50, 3, 2)


@pytest.mark.parametrize('checks', [None, 3, 5])
def test_a_page_with_rows_and_counts_adds_its_counts_once(world, monkeypatch, checks):
    """A page that holds rows and its own counts: the counts go in once, after its last row is written, however a
    hand-over cuts it (a page cut after its first row is read again from that row, and counts then)."""
    seed(world)
    real_page = projects.ProjectSource.page

    def with_counts(source: projects.ProjectSource, entity: str, cursor: dict[str, Any]) -> Page:
        if entity != 'project_lists':
            return real_page(source, entity, cursor)
        rows = [Row({'n': n}, {'start': {'pk': 'p', 'sk': str(n)}}) for n in (1, 2) if cursor.get('start') is None
                or n > int(cursor['start']['sk'])]
        return Page(rows, None, {'probe': 1})

    monkeypatch.setattr(projects.ProjectSource, 'page', with_counts)
    _run_export(world, checks)
    row = world.aggregates.get_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': EXPORT_ID})['Item']
    assert (row['counts']['project_lists'], row['counts']['probe']) == (2, 1)


def test_the_registry_is_read_a_page_of_a_hundred_strongly_consistent_with_its_deleted_marks():
    """7.43.00: the registry read is shared/project_walk.py's ``registry_page``; its request is pinned here (since
    7.44.00 a projected Query also says ``Select`` ``SPECIFIC_ATTRIBUTES``)."""
    view = MagicMock()
    view.query.return_value = {'Items': []}
    projects.ProjectSource(A, view, MagicMock(), MagicMock()).page('personas', {})
    [(args, kwargs)] = [(call.args, call.kwargs) for call in view.query.call_args_list]
    assert (args, kwargs) == (('pk', f'WS#{WS}#PROJECT_IDS'), {'Limit': 100, 'ConsistentRead': True,
                                                             'ProjectionExpression': 'sk, deleted_at',
                                                             'Select': 'SPECIFIC_ATTRIBUTES'})


@pytest.mark.parametrize('name', ['registry', 'series_from', 'start'])
def test_a_carried_key_that_is_not_a_map_is_a_malformed_run_state(name):
    with pytest.raises(ValueError, match='not a map'):
        projects.check_cursor({name: 'not a key'})
    projects.check_cursor({name: {'pk': f'WS#{WS}#PROJECT_IDS', 'sk': 'p'}})


def test_a_series_list_page_answering_with_its_own_start_fails_the_export():
    view = MagicMock()
    start_key = {'pk': f'WS#{WS}#PROJECT#{LIVE}', 'sk': 'COMMENT_SERIES#x'}
    view.query.return_value = {'Items': [], 'LastEvaluatedKey': start_key}
    source = projects.ProjectSource(A, view, MagicMock(), MagicMock())
    with pytest.raises(RuntimeError, match='started from'):
        source.page('document_comments', {'ids': [LIVE], 'checked': True, 'series_from': start_key})
