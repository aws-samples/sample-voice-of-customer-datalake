"""The manual import in a workspace, and the import wizard's routes on it (7.67.00, docs/import-wizard.md;
docs/multi-workspace.md "Request flow").

With ``X-Workspace-Id`` every manual-import route acts in that workspace: its admins only (an editor 403, a
non-member the one 404, the deployment's ``admins`` nothing there), under its own source profiles, raw copies under
``ws/{ws}/raw/…``, every queued message stamped with the RESOLVED workspace (never a body field), the run in
``WS#{ws}#IMPORT_RUN`` and the history read from there; a Radar brand is refused and a parse job started elsewhere is
the unknown job's 404. Without the header, everything is the deployment's as before. The wizard's CSV mapping and
detect run on both paths. Made-up people and companies only.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, ClassVar
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table, workspace_route_call

import manual_import_handler as h
from shared import source_profiles
from shared.csv_datasets import csv_row_id_v2, dataset_key
from shared.feedback_keys import feedback_item_id
from shared.import_runs import _put_rows as write_run_rows
from shared.workspace_request import RADAR_NOT_IN_WORKSPACES, RequestWorkspace

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
BUCKET = 'raw-bucket'
QUEUE = 'https://sqs.example.com/q'
ADMIN_A = {'sub': 'sub-admin-a', 'cognito:groups': 'users', 'cognito:username': 'a'}
EDITOR_A = {'sub': 'sub-editor-a', 'cognito:groups': 'users', 'cognito:username': 'e'}
ADMIN_B = {'sub': 'sub-admin-b', 'cognito:groups': 'users', 'cognito:username': 'b'}
DEPLOYMENT_ADMIN = {'sub': 'sub-deploy', 'cognito:groups': 'admins', 'cognito:username': 'd'}
#: A source profile that keeps the whole file (allow, kept for good), saved in workspace A and the deployment.
KEEP = [{'id': 'manual_import', 'label': 'Manual', 'pii': 'allow'}]
CSV = 'id,text,rating\n1,Login fails on iOS,2\n2,Great support from the team,5\n'
WIZARD_CSV = (
    '\ufeffResponse ID;Submitted;How likely are you to recommend us?;Score;Comments;Email\n'
    'r1;46095;0;9;"Too slow; crashes";ana@example.com\n'
    'r2;14/03/2026;10;3;Lovely;bo@example.com\n'
)


@dataclass
class World:
    aggregates: Any
    feedback: Any
    s3: Any
    sqs: MagicMock

    def messages(self) -> list[dict]:
        return [json.loads(entry['MessageBody']) for call in self.sqs.send_message_batch.call_args_list
                for entry in call.kwargs['Entries']]

    def keys(self) -> list[str]:
        return [o['Key'] for o in self.s3.list_objects_v2(Bucket=BUCKET).get('Contents', [])]

    def partitions(self) -> set[str]:
        return {item['pk'] for item in self.aggregates.scan()['Items']}


def _upload_profile(_table: object, source_id: object = None, scope: Any = None) -> dict:
    """Workspace A and the deployment saved ``KEEP``; workspace B saved nothing (its default redacts)."""
    profiles = KEEP if scope is None or scope.ws == WS_A else []
    return source_profiles.profile_for(profiles, str(source_id or 'manual_import'), workspace=scope is not None)


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws():
        aggregates, feedback, workspaces = pk_sk_table('aggregates'), pk_sk_table('feedback'), pk_sk_table('workspaces')
        for ws in (WS_A, WS_B):
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'status': 'active', 'name': ws, 'slug': ws[-6:]})
        for ws, claims, role in ((WS_A, ADMIN_A, 'admin'), (WS_A, EDITOR_A, 'editor'), (WS_B, ADMIN_B, 'admin')):
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': f"MEMBER#{claims['sub']}", 'role': role})
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        sqs = MagicMock()
        sqs.send_message_batch.side_effect = lambda Entries, **_k: {'Successful': [{'Id': e['Id']} for e in Entries]}
        resolver = RequestWorkspace(table=lambda: workspaces, confirm_platform_admin=lambda _event: False)
        with patch.object(h._request, 'workspace', resolver), patch.object(h, 'aggregates_table', aggregates), \
                patch.object(h, 'feedback_table', feedback), patch.object(h, 's3', s3), patch.object(h, 'sqs', sqs), \
                patch.object(h, 'RAW_DATA_BUCKET', BUCKET), patch.object(h, 'PROCESSING_QUEUE_URL', QUEUE), \
                patch.object(h, 'upload_profile', side_effect=_upload_profile), \
                patch('shared.import_runs._put_rows', side_effect=write_run_rows):
            yield World(aggregates, feedback, s3, sqs)


def _call(lambda_context, method: str, path: str, **kwargs: Any) -> tuple[int, Any]:
    return workspace_route_call(h, lambda_context, method, path, **kwargs)


class TestACsvUploadInAWorkspace:
    def test_it_is_the_workspaces_own(self, world, lambda_context):
        status, body = _call(lambda_context, 'POST', '/scrapers/manual/csv-upload', claims=ADMIN_A, ws=WS_A,
                             body={'csv_text': CSV, 'workspace_id': WS_B})
        assert (status, body['imported_count']) == (200, 2)
        assert {m['workspace_id'] for m in world.messages()} == {WS_A}  # the resolved one, never the body's
        [key] = world.keys()
        assert key.startswith(f'ws/{WS_A}/raw/csv_upload/')
        assert {m['s3_raw_uri'] for m in world.messages()} == {f's3://{BUCKET}/{key}'}
        assert {f'WS#{WS_A}#IMPORT_RUN'} <= world.partitions()
        assert 'IMPORT_RUN' not in world.partitions()

    @pytest.mark.usefixtures('world')
    def test_its_history_lists_its_runs_only(self, lambda_context):
        _call(lambda_context, 'POST', '/scrapers/manual/csv-upload', claims=ADMIN_A, ws=WS_A, body={'csv_text': CSV})
        _call(lambda_context, 'POST', '/scrapers/manual/csv-upload', claims=DEPLOYMENT_ADMIN, ws=None,
              body={'csv_text': CSV})
        status, own = _call(lambda_context, 'GET', '/scrapers/manual/history', claims=ADMIN_A, ws=WS_A)
        assert (status, [run['method'] for run in own['runs']]) == (200, ['csv'])
        run_id = own['runs'][0]['run_id']
        assert _call(lambda_context, 'GET', f'/scrapers/manual/history/{run_id}', claims=ADMIN_A, ws=WS_A,
                     path_params={'run_id': run_id})[0] == 200
        assert _call(lambda_context, 'GET', f'/scrapers/manual/history/{run_id}', claims=DEPLOYMENT_ADMIN, ws=None,
                     path_params={'run_id': run_id})[0] == 404
        _status, deployment = _call(lambda_context, 'GET', '/scrapers/manual/history', claims=DEPLOYMENT_ADMIN, ws=None)
        assert [run['run_id'] for run in deployment['runs']] != [run_id]
        assert len(deployment['runs']) == 1

    @pytest.mark.parametrize(('claims', 'ws', 'status'), [
        (EDITOR_A, WS_A, 403), (DEPLOYMENT_ADMIN, WS_A, 404), (ADMIN_B, WS_A, 404)])
    def test_only_its_admins_import(self, world, lambda_context, claims, ws, status):
        assert _call(lambda_context, 'POST', '/scrapers/manual/csv-upload', claims=claims, ws=ws,
                     body={'csv_text': CSV})[0] == status
        assert world.messages() == []
        assert world.keys() == []

    @pytest.mark.usefixtures('world')
    def test_a_radar_brand_is_refused(self, lambda_context):
        status, body = _call(lambda_context, 'POST', '/scrapers/manual/csv-upload', claims=ADMIN_A, ws=WS_A,
                             body={'csv_text': CSV, 'radar_brand': 'example'})
        assert (status, body['error']) == (400, RADAR_NOT_IN_WORKSPACES)

    def test_a_workspace_without_a_profile_keeps_no_copy(self, world, lambda_context):
        """Workspace B saved no profile: its default redacts, so no whole file is kept (privacy by default)."""
        status, _body = _call(lambda_context, 'POST', '/scrapers/manual/csv-upload', claims=ADMIN_B, ws=WS_B,
                              body={'csv_text': CSV})
        assert status == 200
        assert world.keys() == []
        assert {m['workspace_id'] for m in world.messages()} == {WS_B}

    def test_without_the_header_it_is_the_deployments(self, world, lambda_context):
        status, _body = _call(lambda_context, 'POST', '/scrapers/manual/csv-upload', claims=DEPLOYMENT_ADMIN, ws=None,
                              body={'csv_text': CSV})
        assert status == 200
        assert all('workspace_id' not in m for m in world.messages())
        assert world.keys()[0].startswith('raw/csv_upload/')


class TestADatasetInAWorkspace:
    def test_its_rows_are_compared_with_the_workspaces_own_items(self, world, lambda_context):
        """A corrected re-upload reads the stored rows in the workspace's partition only (shared/csv_dataset_plan.py)."""
        dataset = dataset_key('Example reviews')
        assert dataset is not None
        stored = feedback_item_id('manual_import', csv_row_id_v2(dataset, '1'))
        world.feedback.put_item(Item={'pk': f'WS#{WS_A}#SOURCE#manual_import', 'sk': f'FEEDBACK#{stored}',
                                      'csv_content_hash': '0' * 32, 'original_text': 'Login fails on Android'})
        # The same row in the deployment's partition must not count: it is not this workspace's.
        world.feedback.put_item(Item={'pk': 'SOURCE#manual_import', 'sk': f'FEEDBACK#{stored}', 'csv_content_hash': '1' * 32})
        status, body = _call(lambda_context, 'POST', '/scrapers/manual/csv-upload', claims=ADMIN_A, ws=WS_A,
                             body={'csv_text': CSV, 'dataset_name': 'Example reviews', 'dry_run': True})
        assert status == 200
        assert body['counts'] == {'new': 1, 'changed': 1, 'unchanged': 0, 'v1_rows': 0}
        assert body['changed_rows'][0]['before'] == 'Login fails on Android'
        status, body = _call(lambda_context, 'POST', '/scrapers/manual/csv-upload', claims=DEPLOYMENT_ADMIN, ws=None,
                             body={'csv_text': CSV, 'dataset_name': 'Example reviews', 'dry_run': True})
        assert body['counts']['changed'] == 1
        assert body['changed_rows'][0]['before'] == ''


class TestAPasteInAWorkspace:
    @pytest.mark.usefixtures('world')
    def test_a_parse_job_is_read_only_where_it_started(self, lambda_context):
        with patch.object(h, 'invoke_lambda_async'), patch.object(h, 'MANUAL_IMPORT_PROCESSOR_FUNCTION', 'parser'):
            status, started = _call(lambda_context, 'POST', '/scrapers/manual/parse', claims=ADMIN_A, ws=WS_A,
                                    body={'source_url': 'https://g2.com/x', 'raw_text': 'Great product'})
        assert status == 200
        job = started['job_id']
        path = f'/scrapers/manual/parse/{job}'
        assert _call(lambda_context, 'GET', path, claims=ADMIN_A, ws=WS_A, path_params={'job_id': job})[0] == 200
        assert _call(lambda_context, 'GET', path, claims=ADMIN_B, ws=WS_B, path_params={'job_id': job})[0] == 404
        assert _call(lambda_context, 'GET', path, claims=DEPLOYMENT_ADMIN, ws=None, path_params={'job_id': job})[0] == 404

    def test_a_confirm_queues_into_the_workspace_and_keeps_its_copy_there(self, world, lambda_context):
        world.aggregates.put_item(Item={'pk': 'MANUAL_IMPORT#job-a', 'sk': 'JOB', 'status': 'completed',
                                        'source_url': 'https://g2.com/x', 'source_origin': 'g2', 'raw_text': 't',
                                        'reviews': [], 'workspace_id': WS_A})
        status, _body = _call(lambda_context, 'POST', '/scrapers/manual/confirm', claims=ADMIN_A, ws=WS_A,
                              body={'job_id': 'job-a', 'reviews': [{'text': 'Nice', 'date': '2026-03-01'}]})
        assert status == 200
        [call] = world.sqs.send_message.call_args_list
        assert json.loads(call.kwargs['MessageBody'])['workspace_id'] == WS_A
        assert world.keys()[0].startswith(f'ws/{WS_A}/raw/manual_import/')
        assert _call(lambda_context, 'POST', '/scrapers/manual/confirm', claims=ADMIN_B, ws=WS_B,
                     body={'job_id': 'job-a', 'reviews': [{'text': 'x', 'date': '2026-03-01'}]})[0] == 404


class TestTheWizardsCsvMapping:
    MAPPING: ClassVar[dict[str, str]] = {'Response ID': 'id', 'Submitted': 'date', 'How likely are you to recommend us?': 'nps_0_10',
               'Score': 'rating_1_10', 'Comments': 'open_text', 'Email': 'email'}

    def _upload(self, world, lambda_context, **extra):
        status, body = _call(lambda_context, 'POST', '/scrapers/manual/csv-upload', claims=ADMIN_A, ws=WS_A,
                             body={'csv_text': WIZARD_CSV, 'mapping': self.MAPPING, 'delimiter': ';',
                                   'date_order': 'dmy', 'import_tag': 'import-2026-11-21-ab12', **extra})
        return status, body, {m['csv_row_id']: m for m in world.messages()}

    def test_rows_become_reviews_with_a_five_point_rating_and_the_nps_in_metadata(self, world, lambda_context):
        status, body, messages = self._upload(world, lambda_context)
        assert (status, body['imported_count']) == (200, 2)
        first, second = messages['r1'], messages['r2']
        assert (first['text'], first['rating'], first['created_at']) == ('Too slow; crashes', 5,
                                                                          '2026-03-14T00:00:00+00:00')
        assert second['rating'] == 2
        assert second['created_at'] == '2026-03-14T00:00:00+00:00'
        assert first['metadata'] == {'How likely are you to recommend us?': '0', 'Score': '9'}
        assert first['tags'] == ['import-2026-11-21-ab12']
        assert 'ana@example.com' not in json.dumps(list(messages.values()))
        assert {m['workspace_id'] for m in messages.values()} == {WS_A}

    @pytest.mark.parametrize(('extra', 'status'), [
        ({'column_map': {'Comments': 'text'}}, 400), ({'date_order': 'ydm'}, 400), ({'import_tag': 'a,b'}, 400),
        ({'delimiter': '#'}, 400), ({'mapping': {'Comments': 'choice'}}, 400)])
    def test_a_bad_wizard_option_is_a_400(self, world, lambda_context, extra, status):
        assert self._upload(world, lambda_context, **extra)[0] == status
        assert world.messages() == []

    def test_the_detect_route_reads_a_sample(self, world, lambda_context):
        status, body = _call(lambda_context, 'POST', '/scrapers/manual/detect', claims=ADMIN_A, ws=WS_A,
                             body={'format': 'csv', 'sample': WIZARD_CSV})
        assert status == 200
        assert body['delimiter'] == ';'
        assert body['suggested']['target'] == 'survey'
        assert [c['kind'] for c in body['columns']] == ['id', 'date', 'nps_0_10', 'rating_1_10', 'open_text', 'email']
        assert world.messages() == []
        assert world.keys() == []
        assert world.partitions() == set()
        assert _call(lambda_context, 'POST', '/scrapers/manual/detect', claims=EDITOR_A, ws=WS_A,
                     body={'format': 'csv', 'sample': WIZARD_CSV})[0] == 403
