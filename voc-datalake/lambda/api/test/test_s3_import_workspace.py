"""The S3 import in a workspace (docs/multi-workspace.md "Request flow"; lambda/api/s3_import_handler.py).

With ``X-Workspace-Id`` every route acts in that workspace, its admins only (an editor or a viewer 403, a non-member
the one 404, the deployment's ``admins`` nothing there): its files are the bucket's ``ws/{ws}/<source>/<file>``,
named on the wire as ``<source>/<file>`` (the prefix comes from the resolved workspace, never from the request), its
reprocess runs are ``WS#{ws}#SOURCE_RUN#s3_import`` rows and the ingestor's event names the bucket key and the
workspace. Without the header everything is the deployment's as before, but its listings never show a workspace's
files, and ``ws`` (the workspaces' folder) is no source name in either place. Moto S3 and DynamoDB; made-up names.
"""
from __future__ import annotations

import json
import urllib.parse
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table, rest_event

import s3_import_handler as h
from shared import s3_import_runs
from shared.workspace import NOT_FOUND
from shared.workspace_request import RequestWorkspace

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
BUCKET = 'voc-import-ws'
INGESTOR = 'voc-ingestor-s3_import-ws'
ADMIN_A = {'sub': 'sub-admin-a', 'cognito:groups': 'users', 'cognito:username': 'a'}
EDITOR_A = {'sub': 'sub-editor-a', 'cognito:groups': 'users', 'cognito:username': 'e'}
VIEWER_A = {'sub': 'sub-viewer-a', 'cognito:groups': 'users', 'cognito:username': 'v'}
ADMIN_B = {'sub': 'sub-admin-b', 'cognito:groups': 'users', 'cognito:username': 'b'}
DEPLOYMENT_ADMIN = {'sub': 'sub-deploy', 'cognito:groups': 'admins', 'cognito:username': 'd'}
BODY = b'text,rating\nGreat trail shoes,5\n'
#: Every object of the world: the deployment's, A's and B's.
OBJECTS = (
    'reviews/june.csv', 'support/', 'processed/reviews/may.csv',
    f'ws/{WS_A}/reviews/june.csv', f'ws/{WS_A}/reviews/', f'ws/{WS_A}/surveys/q3.json',
    f'ws/{WS_A}/processed/reviews/april.csv',
    f'ws/{WS_B}/reviews/bramblewood.csv', f'ws/{WS_B}/partners/',
)


@dataclass
class World:
    s3: Any
    aggregates: Any
    ingestor: MagicMock

    def objects(self) -> set[str]:
        return {o['Key'] for o in self.s3.list_objects_v2(Bucket=BUCKET).get('Contents', [])}

    def rows(self) -> list[dict]:
        return self.aggregates.scan()['Items']


@pytest.fixture(autouse=True)
def world() -> Iterator[World]:
    with mock_aws():
        aggregates, workspaces = pk_sk_table('aggregates'), pk_sk_table('workspaces')
        for ws in (WS_A, WS_B):
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'status': 'active', 'name': ws, 'slug': ws[-6:]})
        for ws, claims, role in ((WS_A, ADMIN_A, 'admin'), (WS_A, EDITOR_A, 'editor'), (WS_A, VIEWER_A, 'viewer'),
                                 (WS_B, ADMIN_B, 'admin')):
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': f"MEMBER#{claims['sub']}", 'role': role})
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        for key in OBJECTS:
            s3.put_object(Bucket=BUCKET, Key=key, Body=b'' if key.endswith('/') else BODY)
        ingestor = MagicMock(name='invoke_lambda_async')
        resolver = RequestWorkspace(table=lambda: workspaces, confirm_platform_admin=lambda _event: False)
        with patch.object(h._request, 'workspace', resolver), patch.object(h, 's3_client', s3), \
                patch.object(h, 'S3_IMPORT_BUCKET', BUCKET), patch.object(h, 'S3_IMPORT_INGESTOR_FUNCTION', INGESTOR), \
                patch.object(h, 'get_aggregates_table', return_value=aggregates), \
                patch.object(s3_import_runs, 'invoke_lambda_async', ingestor):
            yield World(s3, aggregates, ingestor)


def _call(lambda_context, method: str, path: str, *, claims: dict = ADMIN_A, ws: str | None = WS_A,
          body: Any = None, query: dict[str, str] | None = None) -> tuple[int, Any]:
    event = rest_event(method, path, claims=claims, body=body)
    event['queryStringParameters'] = query
    if ws is not None:
        event['headers']['X-Workspace-Id'] = ws
    response = h.lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])


def _delete(lambda_context, key: str, **kwargs: Any) -> tuple[int, Any]:
    return _call(lambda_context, 'DELETE', f"/s3-import/file/{urllib.parse.quote(key, safe='')}", **kwargs)


def _files(lambda_context, **kwargs: Any) -> list[str]:
    status, body = _call(lambda_context, 'GET', '/s3-import/files', **kwargs)
    assert status == 200, body
    return sorted(f['key'] for f in body['files'])


#: One request of every route (the reprocess poll with a well-formed run id).
ROUTES = [
    ('GET', '/s3-import/sources', None),
    ('POST', '/s3-import/sources', {'name': 'web'}),
    ('GET', '/s3-import/files', None),
    ('POST', '/s3-import/upload-url', {'filename': 'a.csv', 'source': 'web'}),
    ('DELETE', '/s3-import/file/reviews%2Fjune.csv', None),
    ('POST', '/s3-import/reprocess', {'key': 'reviews/june.csv'}),
    ('GET', '/s3-import/reprocess/run_s3_import_20260310120000_0a1b2c3d', None),
]


class TestWhoActsInAWorkspace:
    @pytest.mark.parametrize(('method', 'path', 'body'), ROUTES)
    @pytest.mark.parametrize('claims', [EDITOR_A, VIEWER_A], ids=['editor', 'viewer'])
    def test_an_editor_or_a_viewer_is_refused_and_nothing_changes(self, world, lambda_context, claims,
                                                                  method, path, body):
        keys = world.objects()
        status, answer = _call(lambda_context, method, path, claims=claims, body=body)
        assert (status, answer) == (403, {'success': False, 'error': 'Workspace admin access required'})
        assert world.objects() == keys
        assert world.rows() == []
        world.ingestor.assert_not_called()

    @pytest.mark.parametrize(('method', 'path', 'body'), ROUTES)
    @pytest.mark.parametrize('claims', [DEPLOYMENT_ADMIN, ADMIN_B], ids=['deployment-admin', 'other-admin'])
    def test_a_non_member_gets_the_one_404(self, world, lambda_context, claims, method, path, body):
        status, answer = _call(lambda_context, method, path, claims=claims, body=body)
        assert (status, answer) == (404, {'success': False, 'error': NOT_FOUND})
        world.ingestor.assert_not_called()

    @pytest.mark.parametrize(('method', 'path', 'body'), ROUTES)
    def test_its_admin_is_past_the_gate(self, lambda_context, method, path, body):
        status, _ = _call(lambda_context, method, path, body=body)
        assert status not in (400, 403)


class TestTheSourcesOfAWorkspace:
    def test_a_workspace_lists_its_own_folders_only(self, lambda_context):
        status, body = _call(lambda_context, 'GET', '/s3-import/sources')
        assert status == 200
        assert body['sources'] == [{'name': 'reviews', 'display_name': 'S3 - reviews'},
                                   {'name': 'surveys', 'display_name': 'S3 - surveys'}]

    def test_the_deployment_lists_its_own_folders_never_the_workspaces_one(self, lambda_context):
        status, body = _call(lambda_context, 'GET', '/s3-import/sources', claims=DEPLOYMENT_ADMIN, ws=None)
        assert status == 200
        assert [s['name'] for s in body['sources']] == ['reviews', 'support']

    def test_a_new_source_is_a_folder_of_the_workspace(self, world, lambda_context):
        status, body = _call(lambda_context, 'POST', '/s3-import/sources', body={'name': 'web forms'})
        assert (status, body['source']) == (200, {'name': 'web_forms', 'display_name': 'S3 - web_forms'})
        assert f'ws/{WS_A}/web_forms/' in world.objects()
        assert 'web_forms/' not in world.objects()

    @pytest.mark.parametrize('ws', [WS_A, None], ids=['workspace', 'deployment'])
    @pytest.mark.parametrize('name', ['ws', 'processed'])
    def test_a_reserved_name_is_no_source(self, world, lambda_context, ws, name):
        keys = world.objects()
        claims = ADMIN_A if ws else DEPLOYMENT_ADMIN
        status, body = _call(lambda_context, 'POST', '/s3-import/sources', claims=claims, ws=ws, body={'name': name})
        assert (status, body['error']) == (400, f'"{name}" is reserved; choose another source folder')
        assert world.objects() == keys


class TestTheFilesOfAWorkspace:
    def test_a_workspace_lists_its_files_as_wire_keys(self, lambda_context):
        status, body = _call(lambda_context, 'GET', '/s3-import/files', query={'include_processed': 'true'})
        assert status == 200
        rows = {f['key']: (f['source'], f['filename'], f['status']) for f in body['files']}
        assert rows == {
            'reviews/june.csv': ('reviews', 'june.csv', 'pending'),
            'surveys/q3.json': ('surveys', 'q3.json', 'pending'),
            'processed/reviews/april.csv': ('processed', 'april.csv', 'processed'),
        }
        assert body['bucket'] == BUCKET

    def test_a_source_lists_that_folder_of_the_workspace(self, lambda_context):
        assert _files(lambda_context, query={'source': 'reviews'}) == ['reviews/june.csv']

    def test_the_deployment_never_lists_a_workspaces_files(self, lambda_context):
        listed = _files(lambda_context, claims=DEPLOYMENT_ADMIN, ws=None, query={'include_processed': 'true'})
        assert listed == ['processed/reviews/may.csv', 'reviews/june.csv']

    @pytest.mark.parametrize('query', [None, {'include_processed': 'true'}, {'source': 'reviews'}])
    def test_no_deployment_listing_lists_under_ws(self, world, lambda_context, query):
        """Every ListObjectsV2 the deployment's listing sends (botocore's own parameters, pages included) stays out of
        the workspaces' folder: no Prefix under `ws/`, and no listing of the whole bucket without a delimiter."""
        sent: list[dict] = []
        world.s3.meta.events.register('before-parameter-build.s3.ListObjectsV2',
                                      lambda params, **_: sent.append(dict(params)))
        _files(lambda_context, claims=DEPLOYMENT_ADMIN, ws=None, query=query)
        assert sent
        for params in sent:
            prefix = params.get('Prefix', '')
            assert not prefix.startswith('ws/'), params
            assert prefix or params.get('Delimiter') == '/', params

    def test_a_root_folder_named_ws_is_not_listed(self, world, lambda_context):
        """`ws` is the workspaces' folder: a file a deployment left at `ws/<file>` is hidden like theirs."""
        world.s3.put_object(Bucket=BUCKET, Key='ws/legacy.csv', Body=BODY)
        assert _files(lambda_context, claims=DEPLOYMENT_ADMIN, ws=None) == ['reviews/june.csv']

    @pytest.mark.parametrize('ws', [WS_A, None], ids=['workspace', 'deployment'])
    @pytest.mark.parametrize('source', [f'ws/{WS_B}', 'ws', 'reviews/', '../reviews', 'a b', f'{WS_B}/reviews'])
    def test_a_source_that_is_not_a_folder_name_is_a_400(self, lambda_context, ws, source):
        claims = ADMIN_A if ws else DEPLOYMENT_ADMIN
        status, body = _call(lambda_context, 'GET', '/s3-import/files', claims=claims, ws=ws, query={'source': source})
        assert status == 400
        assert 'bramblewood' not in json.dumps(body)


class TestAnUploadInAWorkspace:
    def test_the_url_is_for_the_workspaces_key_and_answers_the_wire_key(self, lambda_context):
        status, body = _call(lambda_context, 'POST', '/s3-import/upload-url',
                             body={'filename': 'f.csv', 'source': 'src', 'content_type': 'text/csv'})
        assert status == 200
        assert body['key'] == 'src/f.csv'
        url = urllib.parse.urlparse(body['upload_url'])
        assert urllib.parse.unquote(url.path).endswith(f'/ws/{WS_A}/src/f.csv')
        assert body['upload_headers'] == {'Content-Type': 'text/csv', 'If-None-Match': '*'}

    @pytest.mark.parametrize(('ws', 'seconds'), [(WS_A, 900), (None, 7200)], ids=['workspace', 'deployment'])
    def test_a_workspaces_link_lives_15_minutes_the_deployments_2_hours(self, world, lambda_context, ws, seconds):
        """S3 checks the expiry when the PUT starts, so a long upload begun in time still completes; a workspace's
        short link narrows what can land after its delete's `import_objects` sweep."""
        claims = ADMIN_A if ws else DEPLOYMENT_ADMIN
        with patch.object(world.s3, 'generate_presigned_url', wraps=world.s3.generate_presigned_url) as presign:
            status, body = _call(lambda_context, 'POST', '/s3-import/upload-url', claims=claims, ws=ws,
                                 body={'filename': 'f.csv', 'source': 'src'})
        assert (status, body['expires_in']) == (200, seconds)
        assert presign.call_args.kwargs['ExpiresIn'] == seconds

    def test_a_taken_key_of_the_workspace_is_a_409_naming_the_wire_key(self, lambda_context):
        status, body = _call(lambda_context, 'POST', '/s3-import/upload-url',
                             body={'filename': 'june.csv', 'source': 'reviews'})
        assert (status, body['error']) == (
            409, 'A file named reviews/june.csv already exists. Delete it first to upload it again.')

    def test_another_places_file_does_not_take_the_name(self, lambda_context):
        status, body = _call(lambda_context, 'POST', '/s3-import/upload-url',
                             body={'filename': 'bramblewood.csv', 'source': 'reviews'})
        assert (status, body['key']) == (200, 'reviews/bramblewood.csv')

    @pytest.mark.parametrize('ws', [WS_A, None], ids=['workspace', 'deployment'])
    def test_ws_is_no_upload_source(self, lambda_context, ws):
        claims = ADMIN_A if ws else DEPLOYMENT_ADMIN
        status, body = _call(lambda_context, 'POST', '/s3-import/upload-url', claims=claims, ws=ws,
                             body={'filename': 'f.csv', 'source': 'ws'})
        assert (status, body['error']) == (400, '"ws" is reserved; choose another source folder')


class TestADeleteInAWorkspace:
    def test_it_deletes_the_workspaces_file_only(self, world, lambda_context):
        assert _delete(lambda_context, 'reviews/june.csv') == (200, {'success': True, 'deleted_key': 'reviews/june.csv'})
        assert f'ws/{WS_A}/reviews/june.csv' not in world.objects()
        assert 'reviews/june.csv' in world.objects()

    def test_the_deployment_deletes_its_own_file_only(self, world, lambda_context):
        assert _delete(lambda_context, 'reviews/june.csv', claims=DEPLOYMENT_ADMIN, ws=None)[0] == 200
        assert 'reviews/june.csv' not in world.objects()
        assert f'ws/{WS_A}/reviews/june.csv' in world.objects()

    @pytest.mark.parametrize('ws', [WS_A, None], ids=['workspace', 'deployment'])
    @pytest.mark.parametrize('key', ['reviews/bramblewood.csv', 'reviews/nowhere.csv'])
    def test_a_missing_file_is_a_404_that_writes_nothing(self, world, lambda_context, ws, key):
        """On a versioned bucket a delete of a missing key would still write a delete marker: it is never sent."""
        claims = ADMIN_A if ws else DEPLOYMENT_ADMIN
        with patch.object(world.s3, 'delete_object', wraps=world.s3.delete_object) as delete:
            assert _delete(lambda_context, key, claims=claims, ws=ws) == (
                404, {'success': False, 'error': 'File not found'})
        delete.assert_not_called()

    @pytest.mark.parametrize('ws', [WS_A, None], ids=['workspace', 'deployment'])
    @pytest.mark.parametrize('key', ['ws/reviews.csv', f'ws/{WS_A}/reviews/june.csv', 'processed/ws/a.csv'])
    def test_a_key_under_ws_is_refused(self, world, lambda_context, ws, key):
        claims = ADMIN_A if ws else DEPLOYMENT_ADMIN
        keys = world.objects()
        assert _delete(lambda_context, key, claims=claims, ws=ws)[0] == 400
        assert world.objects() == keys

    def test_ws_as_a_source_says_it_is_reserved(self, lambda_context):
        assert _delete(lambda_context, 'ws/reviews.csv') == (
            400, {'success': False, 'error': '"ws" is reserved; choose another source folder'})


class TestAReprocessInAWorkspace:
    def test_it_writes_the_workspaces_run_and_invokes_with_the_bucket_key_and_workspace(self, world, lambda_context):
        status, body = _call(lambda_context, 'POST', '/s3-import/reprocess',
                             body={'key': 'reviews/june.csv', 'workspace_id': WS_B})
        assert status == 202
        assert body['run']['key'] == 'reviews/june.csv'
        [row] = world.rows()
        assert row['pk'] == f'WS#{WS_A}#SOURCE_RUN#s3_import'
        assert (row['sk'], row['file_key'], row['status']) == (body['run']['run_id'], 'reviews/june.csv', 'running')
        [(function_name, payload)] = [c.args for c in world.ingestor.call_args_list]
        assert function_name == INGESTOR
        assert payload['workspace_id'] == WS_A  # the resolved one, never the body's
        assert payload['execution_id'] == body['run']['run_id']
        [record] = payload['Records']
        assert urllib.parse.unquote_plus(record['s3']['object']['key']) == f'ws/{WS_A}/reviews/june.csv'

    def test_an_archived_file_of_the_workspace_is_reprocessed(self, world, lambda_context):
        status, _ = _call(lambda_context, 'POST', '/s3-import/reprocess', body={'key': 'processed/reviews/april.csv'})
        assert status == 202
        [payload] = [c.args[1] for c in world.ingestor.call_args_list]
        assert urllib.parse.unquote_plus(payload['Records'][0]['s3']['object']['key']) == (
            f'ws/{WS_A}/processed/reviews/april.csv')

    def test_the_deployment_writes_its_own_run_and_names_no_workspace(self, world, lambda_context):
        status, _ = _call(lambda_context, 'POST', '/s3-import/reprocess', claims=DEPLOYMENT_ADMIN, ws=None,
                          body={'key': 'reviews/june.csv', 'workspace_id': WS_A})
        assert status == 202
        [row] = world.rows()
        assert row['pk'] == 'SOURCE_RUN#s3_import'
        [payload] = [c.args[1] for c in world.ingestor.call_args_list]
        assert 'workspace_id' not in payload
        assert urllib.parse.unquote_plus(payload['Records'][0]['s3']['object']['key']) == 'reviews/june.csv'

    @pytest.mark.parametrize('ws', [WS_A, None], ids=['workspace', 'deployment'])
    @pytest.mark.parametrize('key', ['reviews/bramblewood.csv', 'reviews/nowhere.csv'])
    def test_a_missing_file_is_one_404_that_does_not_repeat_the_key(self, world, lambda_context, ws, key):
        claims = ADMIN_A if ws else DEPLOYMENT_ADMIN
        hint = h.WORKSPACE_STAGED_FILE_GONE if ws else h.STAGED_FILE_GONE
        status, body = _call(lambda_context, 'POST', '/s3-import/reprocess', claims=claims, ws=ws, body={'key': key})
        assert (status, body) == (404, {'success': False, 'error': f'File not found. {hint}'})
        assert world.rows() == []
        world.ingestor.assert_not_called()

    def test_the_gone_files_hint_names_each_places_raw_folder(self):
        """The deployment's originals are the raw lake's `raw/s3_import/`, a workspace's its `ws/{ws}/raw/s3_import/`;
        the hint names no workspace id (it is one fixed text, the same for every workspace and for a key of none)."""
        assert 'under raw/s3_import/.' in h.STAGED_FILE_GONE
        assert "under the workspace's own folder, ws/<workspace>/raw/s3_import/." in h.WORKSPACE_STAGED_FILE_GONE
        assert 'ws_' not in h.WORKSPACE_STAGED_FILE_GONE
        assert h.WORKSPACE_STAGED_FILE_GONE.replace(
            "the workspace's own folder, ws/<workspace>/raw/s3_import/", 'raw/s3_import/') == h.STAGED_FILE_GONE

    def test_a_failed_invoke_closes_the_workspaces_run_as_not_started(self, world, lambda_context):
        world.ingestor.side_effect = RuntimeError('Lambda throttled')
        status, body = _call(lambda_context, 'POST', '/s3-import/reprocess', body={'key': 'reviews/june.csv'})
        assert (status, body) == (500, {'success': False, 'error': s3_import_runs.START_FAILED})
        [row] = world.rows()
        assert row['pk'] == f'WS#{WS_A}#SOURCE_RUN#s3_import'
        assert (row['status'], row['errors'], row['file_key']) == ('error', [s3_import_runs.INVOKE_FAILED],
                                                                   'reviews/june.csv')
        assert row['completed_at']
        assert not [r for r in world.rows() if r['pk'] == s3_import_runs.SOURCE_RUN_PK]

    @pytest.mark.parametrize('key', ['ws/a.csv', 'processed/ws/a.csv', f'ws/{WS_A}/reviews/june.csv'])
    def test_a_key_under_ws_is_refused(self, world, lambda_context, key):
        assert _call(lambda_context, 'POST', '/s3-import/reprocess', body={'key': key})[0] == 400
        world.ingestor.assert_not_called()

    def test_a_running_reprocess_blocks_its_own_place_only(self, lambda_context):
        assert _call(lambda_context, 'POST', '/s3-import/reprocess', body={'key': 'reviews/june.csv'})[0] == 202
        assert _call(lambda_context, 'POST', '/s3-import/reprocess', body={'key': 'reviews/june.csv'})[0] == 409
        assert _call(lambda_context, 'POST', '/s3-import/reprocess', claims=DEPLOYMENT_ADMIN, ws=None,
                     body={'key': 'reviews/june.csv'})[0] == 202


def test_the_run_partitions_are_the_ones_the_ingestor_moves():
    """The deployment's spelled-out partition (CDK's test reads it) is run_rows' own, and a workspace's is the
    `WS#{ws}#SOURCE_RUN#s3_import` the ingestor's `_update_source_run_status` writes in that workspace."""
    from shared.ws_repo import WorkspaceScope
    assert s3_import_runs.run_partition(None) == s3_import_runs.SOURCE_RUN_PK == 'SOURCE_RUN#s3_import'
    assert s3_import_runs.run_partition(WorkspaceScope(WS_A)) == f'WS#{WS_A}#SOURCE_RUN#s3_import'


class TestPollingARunInAWorkspace:
    def _start(self, lambda_context, **kwargs: Any) -> str:
        status, body = _call(lambda_context, 'POST', '/s3-import/reprocess', **kwargs)
        assert status == 202, body
        return body['run']['run_id']

    def test_a_workspace_reads_its_own_run(self, lambda_context):
        run_id = self._start(lambda_context, body={'key': 'reviews/june.csv'})
        status, body = _call(lambda_context, 'GET', f'/s3-import/reprocess/{run_id}')
        assert (status, body['run']['key'], body['run']['status']) == (200, 'reviews/june.csv', 'running')

    def test_another_places_run_is_the_unknown_runs_404(self, lambda_context):
        run_b = self._start(lambda_context, claims=ADMIN_B, ws=WS_B, body={'key': 'reviews/bramblewood.csv'})
        run_d = self._start(lambda_context, claims=DEPLOYMENT_ADMIN, ws=None, body={'key': 'reviews/june.csv'})
        unknown = 'run_s3_import_20260310120000_0a1b2c3d'
        answers = {run: _call(lambda_context, 'GET', f'/s3-import/reprocess/{run}') for run in (run_b, run_d, unknown)}
        assert set(map(json.dumps, answers.values())) == {
            json.dumps((404, {'success': False, 'error': 'Run not found'}))}

    def test_the_deployment_does_not_read_a_workspaces_run(self, lambda_context):
        run_a = self._start(lambda_context, body={'key': 'reviews/june.csv'})
        assert _call(lambda_context, 'GET', f'/s3-import/reprocess/{run_a}', claims=DEPLOYMENT_ADMIN, ws=None) == (
            404, {'success': False, 'error': 'Run not found'})
