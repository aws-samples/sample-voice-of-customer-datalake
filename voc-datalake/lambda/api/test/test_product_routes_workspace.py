"""A project's product documents and the Product tab's sources in a workspace, behind the seam (docs/multi-workspace.md,
"3h, the switch"; 3h-S3b, 7.106.00).

The projects API takes its scope from shared/project_request_scope.py ``project_scope``, which answers the deployment
until the flip (3h-S12). These cases turn its ``RESOLVE`` on, as test_project_routes_workspace.py does for the core
routes, and prove the product routes are ready: in moto, two workspaces, A (``alderbrook``) and B (``bramblewood``),
each with a project, and a deployment project beside them, each with one ready source and a product context of its
own. A's member reads and writes A's rows only (its sources, its context, its proposals, its objects under
``ws/{A}/`` and its counters under ``WS#{A}#``); B's member gets, for A's project, exactly the 404 of an id that exists
nowhere, on every route, with nothing written; a caller who is no member of A gets the one 404 of a workspace before
the gate reads anything; the twin reads the workspace its event names, set by the route from the resolved scope; an
image is refused at upload in a workspace with the extractor's own message (3f); the extract stays refused by name
(its job is 3h-S8's); and with the seam off a header changes nothing.
"""
from __future__ import annotations

import ast
import hashlib
import json
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table, seed_workspaces, workspace_route_call

import projects_handler
from shared.indexes import PROJECTS_BY_TYPE_INDEX
from shared.test.library_fixtures import pdf

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
P_A = 'proj_20261128090000_aaaa0000'
P_B = 'proj_20261128090000_bbbb1111'
P_DEP = 'proj_20261128090000_dddd3333'
UNKNOWN = 'proj_20261128090000_eeee4444'
NOW = '2026-11-28T09:00:00+00:00'
BUCKET = 'test-raw-data-bucket'
PROPOSAL = 'pp_20261128T090000000000Z_0123456789ab'
PROPOSAL_SK = 'PRODUCT_PROPOSAL#20261128T090000000000Z#0123456789ab'
DOC = pdf('Orbit Notes turns each meeting into a summary with its decisions.')
DOC_SHA256 = hashlib.sha256(DOC).hexdigest()
PDF = 'application/pdf'

ED = {'sub': 'sub-ed', 'cognito:username': 'ed', 'cognito:groups': 'users'}  # A's editor, an editor of A's project
VI = {'sub': 'sub-vi', 'cognito:username': 'vi', 'cognito:groups': 'users'}  # A's viewer
BEA = {'sub': 'sub-bramblewood-bea', 'cognito:username': 'bramblewood-bea', 'cognito:groups': 'users'}  # B's admin
#: In the deployment's ``admins``, no workspace's member.
DEPLOYMENT_ADMIN = {'sub': 'sub-dan', 'cognito:username': 'dan', 'cognito:groups': '[admins, users]'}

MEMBERS = {WS_A: {'sub-ed': 'editor', 'sub-vi': 'viewer'}, WS_B: {'sub-bramblewood-bea': 'admin'}}
_P = '/projects/<project_id>'


def _pk(ws: str | None, project_id: str) -> str:
    return f'PROJECT#{project_id}' if ws is None else f'WS#{ws}#PROJECT#{project_id}'


def _folder(ws: str | None, project_id: str) -> str:
    return f'projects/{project_id}/product_docs' if ws is None else f'ws/{ws}/projects/{project_id}/product_docs'


def _seed_project(projects: Any, s3: Any, ws: str | None, project_id: str, name: str, owner: str,
                  members: dict[str, str]) -> None:
    pk = _pk(ws, project_id)
    projects.put_item(Item={
        'pk': pk, 'sk': 'META', 'gsi1pk': 'TYPE#PROJECT' if ws is None else f'WS#{ws}#TYPE#PROJECT', 'gsi1sk': NOW,
        'project_id': project_id, 'name': name, 'status': 'active', 'created_at': NOW, 'updated_at': NOW,
        'visibility': 'private' if ws else 'public', 'owner_sub': owner,
        'members': {sub: {'role': role, 'username': sub.removeprefix('sub-')} for sub, role in members.items()}})
    text_key = f'{_folder(ws, project_id)}/extracted/d1.txt'
    s3.put_object(Bucket=BUCKET, Key=text_key, Body=f'{name} source text'.encode())
    projects.put_item(Item={
        'pk': pk, 'sk': 'PRODUCT_DOC#d1', 'doc_id': 'd1', 'filename': f'{name}.md', 'content_type': 'text/markdown',
        'size_bytes': 10, 's3_raw_key': f'{_folder(ws, project_id)}/raw/d1.md', 's3_extracted_key': text_key,
        'status': 'ready', 'error': None, 'extracted_chars': 10, 'created_at': NOW, 'source_kind': 'file'})
    projects.put_item(Item={'pk': pk, 'sk': 'PRODUCT_CONTEXT', 'product_name': name, 'created_at': NOW,
                            'updated_at': NOW, 'field_meta': {'product_name': {'by': 'person', 'sub': owner,
                                                                               'at': NOW}}})
    projects.put_item(Item={
        'pk': pk, 'sk': PROPOSAL_SK, 'proposal_id': PROPOSAL, 'status': 'open', 'created_at': NOW,
        'sources': [{'source_id': 'S1', 'doc_id': 'd1', 'name': f'{name}.md'}],
        'fields': {'one_liner': {'status': 'proposed', 'value': f'{name} in one line', 'seen': '',
                                 'citations': [{'source_id': 'S1', 'quote': name}]}}})


def _seed(projects: Any, workspaces: Any, s3: Any) -> None:
    seed_workspaces(workspaces, MEMBERS)
    _seed_project(projects, s3, WS_A, P_A, 'alderbrook', 'sub-ed', {'sub-vi': 'viewer'})
    _seed_project(projects, s3, WS_B, P_B, 'bramblewood', 'sub-bramblewood-bea', {})
    _seed_project(projects, s3, None, P_DEP, 'deployment', 'sub-dan', {})


@dataclass(frozen=True)
class World:
    """``world(method, path, claims, ws=None, body=None) -> (status, body)`` with the seam ON; the tables, the bucket
    and the twin's recorded invokes."""

    call: Callable[..., tuple[int, Any]]
    projects: Any
    aggregates: Any
    s3: Any
    invoke: MagicMock

    def __call__(self, method: str, path: str, claims: dict, **options: Any) -> tuple[int, Any]:
        return self.call(method, path, claims, **options)

    def rows(self) -> list[dict]:
        return sorted(self.projects.scan(ConsistentRead=True)['Items'], key=lambda row: (row['pk'], row['sk']))

    def counters(self) -> list[dict]:
        return sorted(self.aggregates.scan(ConsistentRead=True)['Items'], key=lambda row: row['pk'])

    def objects(self) -> list[str]:
        return sorted(entry['Key'] for entry in self.s3.list_objects_v2(Bucket=BUCKET).get('Contents', []))

    def row(self, ws: str | None, project_id: str, sk: str) -> dict | None:
        return self.projects.get_item(Key={'pk': _pk(ws, project_id), 'sk': sk}, ConsistentRead=True).get('Item')

    def payloads(self) -> list[dict]:
        return [entry.args[1] for entry in self.invoke.call_args_list]

    def state(self) -> tuple[list[dict], list[dict], list[str]]:
        return self.rows(), self.counters(), self.objects()


def _public_answers(*_args: Any, **_kwargs: Any) -> list:
    return [(2, 1, 6, '', ('93.184.216.34', 0))]


@pytest.fixture
def world(lambda_context, monkeypatch) -> Iterator[World]:
    """The two workspaces and the deployment project in moto, the projects API over them, the seam ON."""
    import product_context
    import projects
    from shared import (
        product_proposal_routes,
        product_source_routes,
        product_source_worker,
        product_sources,
        project_request_scope,
        request_workspace,
    )
    from shared.workspace import MembershipCache

    monkeypatch.setenv('WORKSPACES_TABLE', 'workspaces')
    monkeypatch.setenv('PROJECTS_TABLE', 'projects')
    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)
    monkeypatch.setenv('ASSIST_WORKER_FUNCTION', 'voc-projects-assist')
    monkeypatch.setattr(project_request_scope, 'RESOLVE', True)
    monkeypatch.setattr(request_workspace, '_MEMBERSHIPS', MembershipCache())
    invoke = MagicMock(name='invoke_lambda_async')
    with mock_aws():
        table = pk_sk_table('projects', gsi1_index=PROJECTS_BY_TYPE_INDEX)
        workspaces = pk_sk_table('workspaces')
        aggregates = pk_sk_table('aggregates')
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        _seed(table, workspaces, s3)
        monkeypatch.setattr(request_workspace, 'cached_table', lambda *_: workspaces)
        monkeypatch.setattr(projects, 'projects_table', table)
        monkeypatch.setattr(projects_handler, 'get_projects_table', lambda: table)
        monkeypatch.setattr(projects_handler, 'get_aggregates_table', lambda: aggregates)
        monkeypatch.setattr(product_context, 'projects_table', table)
        monkeypatch.setattr(product_context, 's3', s3)
        monkeypatch.setattr(product_sources, 'get_projects_table', lambda: table)
        monkeypatch.setattr(product_sources, 'get_s3_client', lambda: s3)
        monkeypatch.setattr(product_source_worker, 'get_s3_client', lambda: s3)
        monkeypatch.setattr(product_source_routes, 'get_aggregates_table', lambda: aggregates)
        monkeypatch.setattr(product_source_routes, 'invoke_lambda_async', invoke)
        monkeypatch.setattr(product_proposal_routes, 'get_projects_table', lambda: table)
        monkeypatch.setattr(product_proposal_routes, 'get_aggregates_table', lambda: aggregates)
        monkeypatch.setattr('shared.url_policy.socket.getaddrinfo', _public_answers)

        def call(method: str, path: str, claims: dict, *, ws: str | None = None, body: Any = None) -> tuple[int, Any]:
            return workspace_route_call(projects_handler, lambda_context, method, path, claims=claims, ws=ws, body=body)

        yield World(call, table, aggregates, s3, invoke)


# ── Which routes move ─────────────────────────────────────────────────────────────────────────────────────────────

#: A request valid inside A for each product route this slice threads (3h-S3b: the product documents and the Product
#: tab's sources and proposals), its placeholders filled (the project's own per case).
PRODUCT_ROUTE_REQUESTS: dict[tuple[str, str], tuple[str, dict | None]] = {
    ('GET', f'{_P}/product-context'): ('product-context', None),
    ('PUT', f'{_P}/product-context'): ('product-context', {'one_liner': 'Edited'}),
    ('GET', f'{_P}/product-docs'): ('product-docs', None),
    ('POST', f'{_P}/product-docs/upload-url'): ('product-docs/upload-url', {
        'filename': 'notes.md', 'content_type': 'text/markdown', 'size_bytes': 10}),
    ('DELETE', f'{_P}/product-docs/<doc_id>'): ('product-docs/d1', None),
    ('POST', f'{_P}/product-docs/<doc_id>/uploaded'): ('product-docs/d1/uploaded', {}),
    ('POST', f'{_P}/product-docs/<doc_id>/refresh'): ('product-docs/d1/refresh', {}),
    ('POST', f'{_P}/product-docs/urls'): ('product-docs/urls', {'url': 'https://www.example.com/product'}),
    ('POST', f'{_P}/product-docs/answers'): ('product-docs/answers', {
        'mode': 'typed', 'answers': [{'field': 'one_liner', 'question': 'In one line?', 'answer': 'Notes'}]}),
    ('GET', f'{_P}/product-proposals/latest'): ('product-proposals/latest', None),
    ('POST', f'{_P}/product-proposals/<proposal_id>/accept'): (
        f'product-proposals/{PROPOSAL}/accept', {'fields': {'one_liner': {'seen': ''}}}),
    ('POST', f'{_P}/product-proposals/<proposal_id>/dismiss'): (f'product-proposals/{PROPOSAL}/dismiss', {}),
}
PRODUCT_ROUTES = frozenset(PRODUCT_ROUTE_REQUESTS)


def test_the_product_routes_are_threaded_and_the_extract_waits_for_its_job_slice():
    """The handler's list is exactly the routes this file has a case for, every one threaded."""
    assert frozenset(projects_handler.PRODUCT_ROUTES) == PRODUCT_ROUTES
    assert PRODUCT_ROUTES <= projects_handler.THREADED_ROUTES
    assert PRODUCT_ROUTES.isdisjoint(projects_handler.NOT_YET)
    # The extract starts a document-generator job, whose row and work are 3h-S8's (shared/jobs.py, job_handler).
    assert projects_handler.NOT_YET[('POST', f'{_P}/product-extract')] == '3h-S8'
    assert '3h-S3b' not in projects_handler.NOT_YET.values()


@pytest.mark.parametrize('route', sorted(PRODUCT_ROUTE_REQUESTS), ids=lambda route: f'{route[0]} {route[1]}')
def test_another_workspaces_member_gets_a_missing_projects_404_and_changes_nothing(world, route):
    method, _ = route
    rest, body = PRODUCT_ROUTE_REQUESTS[route]
    before = world.state()
    refused = world(method, f'/projects/{P_A}/{rest}', BEA, ws=WS_B, body=body)
    unknown = world(method, f'/projects/{UNKNOWN}/{rest}', BEA, ws=WS_B, body=body)
    assert refused == unknown
    assert refused[0] == 404
    assert world.state() == before
    world.invoke.assert_not_called()


@pytest.mark.parametrize('route', sorted(PRODUCT_ROUTE_REQUESTS), ids=lambda route: f'{route[0]} {route[1]}')
@pytest.mark.parametrize('claims', [DEPLOYMENT_ADMIN, BEA], ids=['deployment-admin', 'b-admin'])
def test_a_caller_who_is_no_member_of_the_workspace_gets_its_404_before_any_read(world, route, claims):
    """A's header from someone outside A: the one 404 of a workspace that does not exist, decided before the gate reads
    the project or any product row (the deployment's ``admins`` group grants nothing in A)."""
    method, _ = route
    rest, body = PRODUCT_ROUTE_REQUESTS[route]
    before = world.state()
    with patch('projects_handler.project_gate.read_gate_meta', side_effect=AssertionError('read')), \
            patch('shared.product_sources.list_sources', side_effect=AssertionError('read')), \
            patch('shared.product_proposals.context_state', side_effect=AssertionError('read')):
        status, answer = world(method, f'/projects/{P_A}/{rest}', claims, ws=WS_A, body=body)
    assert (status, answer['error']) == (404, 'Workspace not found')
    assert world.state() == before


# ── Each route acts in the request's workspace ────────────────────────────────────────────────────────────────────

def test_the_context_is_read_and_written_in_the_workspace(world):
    status, answer = world('GET', f'/projects/{P_A}/product-context', ED, ws=WS_A)
    assert (status, answer['context']['product_name']) == (200, 'alderbrook')
    status, answer = world('PUT', f'/projects/{P_A}/product-context', ED, ws=WS_A, body={'one_liner': 'Edited'})
    assert (status, answer['context']['one_liner']) == (200, 'Edited')
    assert world.row(WS_A, P_A, 'PRODUCT_CONTEXT')['one_liner'] == 'Edited'
    assert 'one_liner' not in world.row(None, P_DEP, 'PRODUCT_CONTEXT')
    assert 'one_liner' not in world.row(WS_B, P_B, 'PRODUCT_CONTEXT')


def test_a_workspace_viewer_reads_and_does_not_write(world):
    before = world.state()
    assert world('GET', f'/projects/{P_A}/product-docs', VI, ws=WS_A)[0] == 200
    assert world('GET', f'/projects/{P_A}/product-proposals/latest', VI, ws=WS_A)[0] == 200
    assert world('PUT', f'/projects/{P_A}/product-context', VI, ws=WS_A, body={'one_liner': 'x'})[0] == 403
    assert world('DELETE', f'/projects/{P_A}/product-docs/d1', VI, ws=WS_A)[0] == 403
    assert world.state() == before


def test_the_sources_listed_are_the_workspaces(world):
    status, answer = world('GET', f'/projects/{P_A}/product-docs', ED, ws=WS_A)
    assert (status, [doc['filename'] for doc in answer['docs']]) == (200, ['alderbrook.md'])


def test_a_stalled_upload_is_failed_in_the_workspaces_record(world):
    world.projects.put_item(Item={'pk': _pk(WS_A, P_A), 'sk': 'PRODUCT_DOC#d2', 'doc_id': 'd2', 'filename': 'old.md',
                                  'content_type': 'text/markdown', 'status': 'pending',
                                  'created_at': '2026-01-01T00:00:00+00:00', 'source_kind': 'file'})
    status, answer = world('GET', f'/projects/{P_A}/product-docs', ED, ws=WS_A)
    assert status == 200
    assert {doc['doc_id']: doc['status'] for doc in answer['docs']}['d2'] == 'failed'
    assert world.row(WS_A, P_A, 'PRODUCT_DOC#d2')['status'] == 'failed'


def test_an_upload_writes_the_workspaces_record_under_its_ws_key(world):
    status, answer = world('POST', f'/projects/{P_A}/product-docs/upload-url', ED, ws=WS_A,
                           body={'filename': 'notes.md', 'content_type': 'text/markdown', 'size_bytes': 10})
    assert status == 200
    row = world.row(WS_A, P_A, f'PRODUCT_DOC#{answer["doc_id"]}')
    assert row['s3_raw_key'] == f'ws/{WS_A}/projects/{P_A}/product_docs/raw/{answer["doc_id"]}.md'
    assert f'/ws/{WS_A}/projects/{P_A}/product_docs/raw/' in answer['presigned_url']
    status, answer = world('POST', f'/projects/{P_A}/product-docs/upload-url', ED, ws=WS_A,
                           body={'filename': 'notes.pdf', 'content_type': PDF, 'size_bytes': len(DOC),
                                 'sha256': DOC_SHA256})
    assert status == 200
    row = world.row(WS_A, P_A, f'PRODUCT_DOC#{answer["doc_id"]}')
    assert row['s3_raw_key'] == f'ws/{WS_A}/projects/{P_A}/product_docs/source/{answer["doc_id"]}.pdf'


def _extractor_image_message() -> str:
    """The S3 extractor's own refusal of a workspace's image (product_doc_extractor/handler.py, 3f), read from its
    source: the extractor is a stdlib-only Lambda the API cannot import."""
    path = Path(__file__).resolve().parents[2] / 'product_doc_extractor' / 'handler.py'
    for node in ast.parse(path.read_text(encoding='utf-8')).body:
        if (isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'WORKSPACE_IMAGE_MESSAGE'
                                                 for t in node.targets) and isinstance(node.value, ast.Constant)):
            return str(node.value.value)
    raise AssertionError('WORKSPACE_IMAGE_MESSAGE is gone from the extractor')


def test_the_upload_refuses_an_image_in_a_workspace_with_the_extractors_message_and_writes_nothing(world):
    import product_context

    extractors = _extractor_image_message()
    assert extractors == product_context.WORKSPACE_IMAGE_MESSAGE
    before = world.state()
    status, answer = world('POST', f'/projects/{P_A}/product-docs/upload-url', ED, ws=WS_A,
                           body={'filename': 'screen.png', 'content_type': 'image/png', 'size_bytes': 10})
    assert (status, answer['error'], answer.get('code')) == (400, _extractor_image_message(), 'image_in_workspace')
    assert world.state() == before


def test_the_deployment_still_takes_an_image(world, monkeypatch):
    from shared import project_request_scope

    monkeypatch.setattr(project_request_scope, 'RESOLVE', False)
    status, answer = world('POST', f'/projects/{P_DEP}/product-docs/upload-url', ED, ws=WS_A,
                           body={'filename': 'screen.png', 'content_type': 'image/png', 'size_bytes': 10})
    assert status == 200
    assert world.row(None, P_DEP, f'PRODUCT_DOC#{answer["doc_id"]}')['s3_raw_key'].startswith(f'projects/{P_DEP}/')


def test_a_delete_takes_the_workspaces_record_and_objects_and_its_proposals_citations(world):
    before = world.objects()
    status, _ = world('DELETE', f'/projects/{P_A}/product-docs/d1', ED, ws=WS_A)
    assert status == 200
    assert world.row(WS_A, P_A, 'PRODUCT_DOC#d1') is None
    assert world.row(WS_B, P_B, 'PRODUCT_DOC#d1') is not None
    assert world.row(None, P_DEP, 'PRODUCT_DOC#d1') is not None
    gone = sorted(set(before) - set(world.objects()))
    assert gone == [f'ws/{WS_A}/projects/{P_A}/product_docs/extracted/d1.txt']
    assert world.row(WS_A, P_A, PROPOSAL_SK)['fields']['one_liner']['citations'] == []
    assert world.row(None, P_DEP, PROPOSAL_SK)['fields']['one_liner']['citations'] != []
    [audit] = [row for row in world.rows() if row['pk'] == 'AUDIT#delete']
    assert (audit['kind'], audit['target']) == ('product_doc', {'project_id': P_A, 'doc_id': 'd1', 'workspace': WS_A})


def test_an_announced_upload_is_read_by_the_twin_in_the_workspace_its_event_names(world):
    from shared import product_source_worker

    world.projects.put_item(Item={'pk': _pk(WS_A, P_A), 'sk': 'PRODUCT_DOC#d2', 'doc_id': 'd2', 'filename': 'n.pdf',
                                  'content_type': PDF, 'size_bytes': len(DOC), 'sha256': DOC_SHA256,
                                  'status': 'pending', 'created_at': NOW, 'source_kind': 'file'})
    world.s3.put_object(Bucket=BUCKET, Key=f'ws/{WS_A}/projects/{P_A}/product_docs/source/d2.pdf', Body=DOC,
                        ContentType=PDF)
    status, answer = world('POST', f'/projects/{P_A}/product-docs/d2/uploaded', ED, ws=WS_A)
    assert (status, answer['doc']['status']) == (202, 'extracting')
    token = world.row(WS_A, P_A, 'PRODUCT_DOC#d2')['extract_token']
    # The twin's event names the workspace the request resolved, set by the route (never a caller's field).
    assert world.payloads() == [{'action': 'product_source_extract', 'project_id': P_A, 'doc_id': 'd2',
                                 'token': token, 'workspace_id': WS_A}]
    assert product_source_worker.run(world.payloads()[0]) == {'status': 'done'}
    row = world.row(WS_A, P_A, 'PRODUCT_DOC#d2')
    assert (row['status'], row['s3_extracted_key']) == ('ready', f'ws/{WS_A}/projects/{P_A}/product_docs/extracted/d2.txt')
    assert 'Orbit Notes' in world.s3.get_object(Bucket=BUCKET, Key=row['s3_extracted_key'])['Body'].read().decode()
    [files] = [row for row in world.counters() if 'PRODUCTFILE#' in row['pk']]
    assert files['pk'] == f'WS#{WS_A}#PRODUCTFILE#USER#sub-ed#{datetime.now(UTC):%Y-%m-%d}'


def test_a_link_and_its_refresh_are_the_workspaces_and_counted_under_it(world):
    status, answer = world('POST', f'/projects/{P_A}/product-docs/urls', ED, ws=WS_A,
                           body={'url': 'https://www.example.com/product'})
    assert status == 201
    doc_id = answer['doc']['doc_id']
    row = world.row(WS_A, P_A, f'PRODUCT_DOC#{doc_id}')
    assert (row['source_kind'], row['status']) == ('url', 'extracting')
    assert world.payloads()[-1]['workspace_id'] == WS_A
    world.projects.update_item(Key={'pk': _pk(WS_A, P_A), 'sk': f'PRODUCT_DOC#{doc_id}'},
                               UpdateExpression='SET #s = :failed', ExpressionAttributeNames={'#s': 'status'},
                               ExpressionAttributeValues={':failed': 'failed'})
    assert world('POST', f'/projects/{P_A}/product-docs/{doc_id}/refresh', ED, ws=WS_A)[0] == 202
    day = f'{datetime.now(UTC):%Y-%m-%d}'
    assert {row['pk']: int(row['count']) for row in world.counters()} == {
        f'WS#{WS_A}#PRODUCTURL#PROJECT#{P_A}#{day}': 2, f'WS#{WS_A}#PRODUCTURL#USER#sub-ed#{day}': 2}


def test_typed_answers_are_saved_as_the_workspaces_source(world):
    status, answer = world('POST', f'/projects/{P_A}/product-docs/answers', ED, ws=WS_A,
                           body={'mode': 'typed', 'answers': [{'field': 'one_liner', 'question': 'In one line?',
                                                               'answer': 'Meeting notes'}]})
    assert status == 201
    doc_id = answer['doc']['doc_id']
    row = world.row(WS_A, P_A, f'PRODUCT_DOC#{doc_id}')
    assert row['s3_extracted_key'] == f'ws/{WS_A}/projects/{P_A}/product_docs/extracted/{doc_id}.txt'
    assert 'Meeting notes' in world.s3.get_object(Bucket=BUCKET, Key=row['s3_extracted_key'])['Body'].read().decode()


def test_the_latest_proposal_and_its_accept_and_dismiss_are_the_workspaces(world):
    status, answer = world('GET', f'/projects/{P_A}/product-proposals/latest', ED, ws=WS_A)
    assert (status, answer['proposal']['proposal_id'], answer['context']['product_name']) == (
        200, PROPOSAL, 'alderbrook')
    assert [source['filename'] for source in answer['sources']] == ['alderbrook.md']
    status, answer = world('POST', f'/projects/{P_A}/product-proposals/{PROPOSAL}/accept', ED, ws=WS_A,
                           body={'fields': {'one_liner': {'seen': ''}}})
    assert (status, answer['applied']) == (200, ['one_liner'])
    assert world.row(WS_A, P_A, 'PRODUCT_CONTEXT')['one_liner'] == 'alderbrook in one line'
    assert world.row(None, P_DEP, PROPOSAL_SK)['status'] == 'open'
    # The audit row is the workspace's own (review F-1): none in the deployment's partition.
    assert [row for row in world.rows() if row['pk'] == 'AUDIT#product_context'] == []
    [audit] = [row for row in world.rows() if row['pk'] == f'WS#{WS_A}#AUDIT#product_context']
    assert (audit['project_id'], audit['workspace'], audit['fields']) == (P_A, WS_A, ['one_liner'])
    world.projects.put_item(Item={**world.row(WS_A, P_A, PROPOSAL_SK), 'status': 'open'})
    assert world('POST', f'/projects/{P_A}/product-proposals/{PROPOSAL}/dismiss', ED, ws=WS_A)[0] == 200
    assert world.row(WS_A, P_A, PROPOSAL_SK)['status'] == 'dismissed'
    assert world.row(WS_B, P_B, PROPOSAL_SK)['status'] == 'open'


def test_a_workspace_accepts_audit_row_is_in_its_transaction_so_a_refused_accept_writes_none(world):
    """Review F-1: the workspace's audit row (``WS#{ws}#AUDIT#product_context``) is one of the accept's own
    transaction entries, as the deployment's is: an accept whose transaction is refused (the proposal closed meanwhile)
    leaves no audit row and no field written."""
    from shared import product_proposals

    real = product_proposals.transact_project_actions
    seen: list[list[dict]] = []

    def closed_meanwhile(table: Any, project_id: str, actions: list[dict], **kwargs: Any) -> None:
        seen.append(actions)
        world.projects.put_item(Item={**world.row(WS_A, P_A, PROPOSAL_SK), 'status': 'dismissed'})
        real(table, project_id, actions, **kwargs)

    before = world.rows()
    with patch.object(product_proposals, 'transact_project_actions', side_effect=closed_meanwhile):
        status, _ = world('POST', f'/projects/{P_A}/product-proposals/{PROPOSAL}/accept', ED, ws=WS_A,
                          body={'fields': {'one_liner': {'seen': ''}}})
    assert status == 409
    assert [entry['Put']['Item']['pk'] for entry in seen[0] if 'Put' in entry] == [
        f'WS#{WS_A}#AUDIT#product_context']
    assert [row for row in world.rows() if 'AUDIT#product_context' in row['pk']] == []
    assert world.row(WS_A, P_A, 'PRODUCT_CONTEXT') == next(
        row for row in before if row['pk'] == f'WS#{WS_A}#PROJECT#{P_A}' and row['sk'] == 'PRODUCT_CONTEXT')


def test_the_extract_is_still_refused_by_name_in_a_workspace_and_reads_nothing(world):
    before = world.state()
    with patch('projects_handler.project_gate.read_gate_meta', side_effect=AssertionError('read')), \
            patch('projects_handler.logger') as log:
        assert world('POST', f'/projects/{P_A}/product-extract', ED, ws=WS_A, body={})[0] == 500
    assert 'The projects route POST /projects/<project_id>/product-extract (3h-S8) is not per workspace yet' in str(
        log.exception.call_args)
    assert world.state() == before


# ── The twin takes its scope from its event ───────────────────────────────────────────────────────────────────────

def _claimed(world: World, ws: str | None, project_id: str, doc_id: str) -> None:
    world.projects.put_item(Item={'pk': _pk(ws, project_id), 'sk': f'PRODUCT_DOC#{doc_id}', 'doc_id': doc_id,
                                  'filename': 'n.pdf', 'content_type': PDF, 'size_bytes': len(DOC),
                                  'sha256': DOC_SHA256, 'status': 'extracting', 'extract_token': 'tok-1',
                                  'claimed_at': NOW, 'created_at': NOW, 'source_kind': 'file'})
    world.s3.put_object(Bucket=BUCKET, Key=f'{_folder(ws, project_id)}/source/{doc_id}.pdf', Body=DOC,
                        ContentType=PDF)


def test_the_twin_reads_only_the_workspace_its_event_names(world):
    from shared import product_source_worker

    _claimed(world, WS_A, P_A, 'd2')
    event = {'action': 'product_source_extract', 'project_id': P_A, 'doc_id': 'd2', 'token': 'tok-1'}
    # No workspace named: the deployment's row, which does not exist; nothing of A's is read or written.
    assert product_source_worker.run(event) == {'status': 'skipped'}
    assert world.row(WS_A, P_A, 'PRODUCT_DOC#d2')['status'] == 'extracting'
    # Another workspace named: B's row, which does not exist either.
    assert product_source_worker.run({**event, 'workspace_id': WS_B}) == {'status': 'skipped'}
    assert world.row(WS_A, P_A, 'PRODUCT_DOC#d2')['status'] == 'extracting'
    # A workspace field that is not one is refused, never read as the deployment's.
    assert product_source_worker.run({**event, 'workspace_id': 'not-a-workspace'}) == {'status': 'ignored'}
    assert product_source_worker.run({**event, 'workspace_id': WS_A}) == {'status': 'done'}
    assert world.row(WS_A, P_A, 'PRODUCT_DOC#d2')['status'] == 'ready'
    assert f'ws/{WS_A}/projects/{P_A}/product_docs/extracted/d2.txt' in world.objects()


@pytest.mark.usefixtures('world')
def test_the_twins_event_takes_the_resolved_workspace_over_any_field_of_that_name():
    """Review S-3: the context a request resolved in A (``ProjectScope.context``) names A on the twin's event, even when
    the fields handed in already carry B's ``workspace_id``."""
    from moto_helpers import rest_event

    from shared import project_request_scope
    from shared.workspace_routing import workspace_payload

    event = rest_event('POST', f'/projects/{P_A}/product-docs/urls', claims=ED)
    event['headers']['X-Workspace-Id'] = WS_A
    scope = project_request_scope.project_scope(event, fresh=True)
    assert scope.context is not None
    payload = workspace_payload({'action': 'product_source_extract', 'workspace_id': WS_B, 'doc_id': 'd1'},
                                scope.context)
    assert payload == {'action': 'product_source_extract', 'doc_id': 'd1', 'workspace_id': WS_A}
    assert workspace_payload({'workspace_id': WS_B, 'doc_id': 'd1'}, project_request_scope.DEPLOYMENT.context) == {
        'doc_id': 'd1'}


def test_a_body_cannot_name_the_twins_workspace(world):
    """The link's body names only ``url`` (anything else is a 400), and the event's ``workspace_id`` is the route's
    resolved scope, set last (shared/workspace_routing.py ``workspace_payload``)."""
    status, answer = world('POST', f'/projects/{P_A}/product-docs/urls', ED, ws=WS_A,
                           body={'url': 'https://www.example.com/product', 'workspace_id': WS_B})
    assert (status, answer['success']) == (400, False)
    world.invoke.assert_not_called()


# ── The keys and the counters in scope ────────────────────────────────────────────────────────────────────────────

def test_every_key_and_counter_takes_the_workspace_and_none_is_exactly_the_deployments():
    from shared import product_proposals, product_sources
    from shared.ws_repo import WorkspaceScope

    scope, now = WorkspaceScope(WS_A), datetime(2026, 11, 28, 9, 30, tzinfo=UTC)
    for workspace, prefix in ((None, ''), (scope, f'WS#{WS_A}#')):
        assert product_sources.link_reads_key(P_A, now, workspace=workspace) == {
            'pk': f'{prefix}PRODUCTURL#PROJECT#{P_A}#2026-11-28', 'sk': 'COUNT'}
        assert [c.key['pk'] for c in product_sources.link_read_counters(P_A, 'sub-ed', now, workspace=workspace)] == [
            f'{prefix}PRODUCTURL#PROJECT#{P_A}#2026-11-28', f'{prefix}PRODUCTURL#USER#sub-ed#2026-11-28']
        assert [c.key['pk'] for c in product_sources.file_read_counters('sub-ed', now, workspace=workspace)] == [
            f'{prefix}PRODUCTFILE#USER#sub-ed#2026-11-28']
        assert [key['pk'] for key, _ in product_proposals.extract_counter_keys(P_A, 'sub-ed', now,
                                                                                 workspace=workspace)] == [
            f'{prefix}PRODUCTX#PROJECT#{P_A}#202611280930', f'{prefix}PRODUCTX#PROJECT#{P_A}#2026-11-28',
            f'{prefix}PRODUCTX#USER#sub-ed#2026-11-28']
        pk = f'{prefix}PROJECT#{P_A}'
        assert product_sources.source_row_key(P_A, 'd1', workspace=workspace) == {'pk': pk, 'sk': 'PRODUCT_DOC#d1'}
        _, key = product_proposals.new_proposal_key(P_A, now, workspace=workspace)
        assert key['pk'] == pk
        folder = f'projects/{P_A}/product_docs' if workspace is None else f'ws/{WS_A}/projects/{P_A}/product_docs'
        assert product_sources.product_doc_raw_key(P_A, 'd1', 'md', workspace=workspace) == f'{folder}/raw/d1.md'
        assert product_sources.product_doc_source_key(P_A, 'd1', 'pdf', workspace=workspace) == f'{folder}/source/d1.pdf'
        assert product_sources.product_doc_extracted_key(P_A, 'd1', workspace=workspace) == f'{folder}/extracted/d1.txt'


def test_the_extracts_stores_still_refuse_a_workspace_until_its_job_moves():
    """The lock, the proposal's put and the extract's counters are reached only by the extract (3h-S8): refused."""
    from shared import product_proposals
    from shared.project_keys import NotPerWorkspaceError
    from shared.ws_repo import WorkspaceScope

    scope, now, table = WorkspaceScope(WS_A), datetime(2026, 11, 28, 9, 30, tzinfo=UTC), MagicMock()
    for attempt in (lambda: product_proposals.take_lock(table, P_A, 'l1', 'sub-ed', now, workspace=scope),
                    lambda: product_proposals.note_lock_job(table, P_A, 'l1', 'j1', workspace=scope),
                    lambda: product_proposals.release_lock(table, P_A, 'l1', workspace=scope),
                    lambda: product_proposals.put_proposal(table, P_A, {}, workspace=scope),
                    lambda: product_proposals.count_extract(table, P_A, 'sub-ed', now, workspace=scope)):
        with pytest.raises(NotPerWorkspaceError):
            attempt()
    assert table.mock_calls == []


# ── With the seam off (production), nothing changes ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize('route', sorted(PRODUCT_ROUTE_REQUESTS), ids=lambda route: f'{route[0]} {route[1]}')
def test_with_the_seam_off_a_header_changes_nothing(world, monkeypatch, route):
    """Production today: every product route acts on the deployment's project, whatever the header names, exactly as
    with no header; A's project is not reachable."""
    from shared import project_request_scope

    monkeypatch.setattr(project_request_scope, 'RESOLVE', False)
    method, _ = route
    rest, body = PRODUCT_ROUTE_REQUESTS[route]
    # A's editor names A: the deployment has no such project (an admin's gate skips the read, so a member asks).
    assert world(method, f'/projects/{P_A}/{rest}', ED, ws=WS_A, body=body)[0] == 404
    assert world.row(WS_A, P_A, 'PRODUCT_DOC#d1') is not None
    status, answer = world(method, f'/projects/{P_DEP}/{rest}', DEPLOYMENT_ADMIN, ws=WS_A, body=body)
    assert status < 500, answer
    assert not [row for row in world.rows() if row['pk'].startswith('WS#') and row['pk'].endswith(P_DEP)]
    assert all(not row['pk'].startswith('WS#') for row in world.counters())
    assert all('workspace_id' not in payload for payload in world.payloads())


#: Generated values a write's answer and keys carry (a source's id, a claim's token, an audit row's suffix, a time, a
#: counter's expiry, a signed URL): masked, so two runs of the same write compare equal.
_GENERATED = re.compile(r'\b[0-9a-f]{16,32}\b|\d{4}-\d{2}-\d{2}T[0-9:.]+(?:\+00:00|Z)?|https://\S+?(?=["\s]|$)'
                        r'|(?<="ttl": ")\d+')


@dataclass(frozen=True)
class Snapshot:
    projects: list[dict]
    aggregates: list[dict]
    objects: dict[str, bytes]


def _snapshot(world: World) -> Snapshot:
    return Snapshot(world.rows(), world.counters(), {
        key: world.s3.get_object(Bucket=BUCKET, Key=key)['Body'].read() for key in world.objects()})


def _restore(world: World, snapshot: Snapshot) -> None:
    """The world as ``snapshot`` held it: every row and object put back, every other one removed."""
    for table, rows in ((world.projects, snapshot.projects), (world.aggregates, snapshot.aggregates)):
        for row in table.scan(ConsistentRead=True)['Items']:
            table.delete_item(Key={'pk': row['pk'], 'sk': row['sk']})
        for row in rows:
            table.put_item(Item=row)
    versions = world.s3.list_object_versions(Bucket=BUCKET)
    for entry in [*versions.get('Versions', []), *versions.get('DeleteMarkers', [])]:
        world.s3.delete_object(Bucket=BUCKET, Key=entry['Key'], VersionId=entry['VersionId'])
    for key, body in snapshot.objects.items():
        world.s3.put_object(Bucket=BUCKET, Key=key, Body=body)
    world.invoke.reset_mock()


def _written(world: World, before: Snapshot) -> tuple[list[str], list[str], list[str], list[str]]:
    """What a write changed: the rows and counters it put or changed, the objects it added or removed, the twin's
    events, every generated value masked."""
    def mask(value: object) -> str:
        return _GENERATED.sub('<gen>', json.dumps(value, sort_keys=True, default=str))

    rows = sorted(mask(row) for row in world.rows() if row not in before.projects)
    counters = sorted(mask(row) for row in world.counters() if row not in before.aggregates)
    objects = sorted(mask(key) for key in set(world.objects()) ^ set(before.objects))
    return rows, counters, objects, sorted(mask(payload) for payload in world.payloads())


WRITE_ROUTES = sorted(route for route in PRODUCT_ROUTE_REQUESTS if route[0] != 'GET')


@pytest.mark.parametrize('route', WRITE_ROUTES, ids=lambda route: f'{route[0]} {route[1]}')
def test_with_the_seam_off_a_write_answers_and_writes_exactly_as_with_no_header(world, monkeypatch, route):
    """Review Q-3: each write route on the deployment's project, with A's header and without one, from the same
    state: the same answer and the same rows, counters, objects and twin events written (generated ids masked)."""
    from shared import project_request_scope

    monkeypatch.setattr(project_request_scope, 'RESOLVE', False)
    method, _ = route
    rest, body = PRODUCT_ROUTE_REQUESTS[route]
    before = _snapshot(world)
    runs = []
    for ws in (WS_A, None):
        _restore(world, before)
        status, answer = world(method, f'/projects/{P_DEP}/{rest}', DEPLOYMENT_ADMIN, ws=ws, body=body)
        runs.append((status, _GENERATED.sub('<gen>', json.dumps(answer, sort_keys=True)), _written(world, before)))
    assert runs[0] == runs[1]
    assert runs[0][0] < 500, runs[0]


def test_with_the_seam_off_the_deployments_answers_match_a_request_naming_no_workspace(world, monkeypatch):
    from shared import project_request_scope

    monkeypatch.setattr(project_request_scope, 'RESOLVE', False)
    for rest in ('product-context', 'product-docs', 'product-proposals/latest'):
        assert world('GET', f'/projects/{P_DEP}/{rest}', ED, ws=WS_A) == world('GET', f'/projects/{P_DEP}/{rest}', ED)
    status, answer = world('GET', f'/projects/{P_DEP}/product-docs', ED, ws=WS_A)
    assert (status, [doc['filename'] for doc in answer['docs']]) == (200, ['deployment.md'])


def test_the_seam_on_with_no_workspace_named_is_the_deployments(world):
    status, answer = world('GET', f'/projects/{P_DEP}/product-context', ED)
    assert (status, answer['context']['product_name']) == (200, 'deployment')
    status, _ = world('POST', f'/projects/{P_DEP}/product-docs/urls', DEPLOYMENT_ADMIN,
                      body={'url': 'https://www.example.com/product'})
    assert status == 201
    assert 'workspace_id' not in world.payloads()[-1]
    day = f'{datetime.now(UTC):%Y-%m-%d}'
    assert {row['pk'] for row in world.counters()} == {f'PRODUCTURL#PROJECT#{P_DEP}#{day}',
                                                       f'PRODUCTURL#USER#sub-dan#{day}'}
