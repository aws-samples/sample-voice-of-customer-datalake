"""The operator routes that start and watch ingestion, on both paths (docs/multi-workspace.md, "Request flow").

With ``X-Workspace-Id`` the integrations and scrapers APIs act in that workspace: the admin routes need the caller's
admin role there (a workspace admin or an entered platform admin; the deployment's ``admins`` grants nothing, an
editor or a viewer gets 403, a non-member the one 404); Run now and a scraper's run carry the RESOLVED workspace on
their invoke payload (never a body field) and write and read the workspace's run rows; the breaker routes read and
clear the workspace's own TRIPPED row (enable and disable are refused: the schedule rule serves every workspace);
credentials, app connectors and scraper configs live in the workspace's own SSM parameters, one per plugin and kind
(decision 19). The S3 import API refuses the header outright. Without the header each route acts deployment-wide,
as before.
"""
from __future__ import annotations

import ast
import inspect
import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from integrations_fixtures import stub_rule_lookup
from moto import mock_aws
from moto_helpers import pk_sk_table, rest_event

import integrations_handler
import s3_import_handler
import scrapers_handler
from shared import workspace_plugin_settings
from shared.test.moto_tables import create_pk_sk_table
from shared.workspace_credentials import read_workspace
from shared.workspace_request import DEPLOYMENT_ONLY, RADAR_NOT_IN_WORKSPACES, RequestWorkspace
from shared.ws_repo import message_scope

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
#: A workspace created a moment ago: nothing saved in it yet.
WS_NEW = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DA'
SHARED_SECRET = 'shared-api-credentials'
PREFIX = '/voc/ws'
KEY = 'arn:aws:kms:us-east-1:123456789012:key/test'


def _claims(sub: str, groups: str = 'users') -> dict:
    return {'sub': sub, 'cognito:groups': groups, 'cognito:username': sub}


#: A workspace admin who is NOT in the deployment's `admins` group: the workspace role alone admits them.
ADMIN_A = _claims('sub-admin-a')
EDITOR_A = _claims('sub-editor-a')
VIEWER_A = _claims('sub-viewer-a')
ADMIN_B = _claims('sub-admin-b')
ADMIN_NEW = _claims('sub-admin-n')
#: The deployment's administrator, a member of no workspace.
DEPLOYMENT_ADMIN = _claims('sub-deploy', 'admins')
PLATFORM_ADMIN = _claims('sub-platform', 'admins,platform-admins')
MEMBERS = ((WS_A, ADMIN_A, 'admin'), (WS_A, EDITOR_A, 'editor'), (WS_A, VIEWER_A, 'viewer'),
           (WS_B, ADMIN_B, 'admin'), (WS_NEW, ADMIN_NEW, 'admin'))
#: The workspaces whose admins enabled the webscraper plugin (shared/workspace_plugin_settings.py); B has not.
ENABLED_WEBSCRAPER: Final = (WS_A, WS_NEW)


@dataclass
class World:
    aggregates: Any
    workspaces: Any
    secrets: Any
    ssm: Any
    ingestor: MagicMock
    webscraper: MagicMock
    events: MagicMock
    resolver: RequestWorkspace

    def secret(self, name: str) -> dict:
        return json.loads(self.secrets.get_secret_value(SecretId=name)['SecretString'])

    def stored(self, ws: str) -> dict:
        """Everything saved in workspace ``ws`` (its credentials parameters and its config rows), as the shared secret
        would hold it (``<plugin>_<key>``)."""
        credentials = {f'{plugin}_{key}': value for plugin, values in read_workspace(self.ssm, PREFIX, ws).items()
                       for key, value in values.items()}
        return {**credentials, **{f"{row['sk']}_configs": row['configs'] for row in self.config_rows(ws)}}

    def save(self, ws: str, name: str, value: str) -> None:
        """Saved by hand: ``credentials/{plugin}`` a parameter of the workspace, ``configs/{plugin}`` its row."""
        kind, plugin = name.split('/')
        if kind == 'configs':
            self.aggregates.put_item(Item={'pk': f'WS#{ws}#PLUGIN_CONFIG', 'sk': plugin, 'configs': value})
            return
        self.ssm.put_parameter(Name=f'{PREFIX}/{ws}/{name}', Value=value, Type='SecureString', KeyId=KEY,
                               Overwrite=True)

    def parameter_names(self) -> list[str]:
        return sorted(p['Name'] for p in self.ssm.describe_parameters()['Parameters'])

    def nothing_saved(self) -> bool:
        """No credentials parameter and no config row in any workspace."""
        return self.parameter_names() == [] and self.config_rows() == []

    def config_rows(self, ws: str | None = None) -> list[dict]:
        """Every workspace's config rows (``WS#{ws}#PLUGIN_CONFIG``), or ``ws``'s."""
        return [item for item in self.aggregates.scan()['Items'] if item['pk'].endswith('#PLUGIN_CONFIG')
                and (ws is None or item['pk'] == f'WS#{ws}#PLUGIN_CONFIG')]

    def row(self, pk: str, sk: str) -> dict | None:
        return self.aggregates.get_item(Key={'pk': pk, 'sk': sk}).get('Item')

    def partitions(self) -> set[str]:
        return {item['pk'] for item in self.aggregates.scan()['Items']}

    def invoked_payload(self, client: MagicMock) -> dict:
        [call] = client.invoke.call_args_list
        payload = call.kwargs['Payload']
        return json.loads(payload.decode() if isinstance(payload, bytes) else payload)


def _ws_parameter(ws: str, plugin: str) -> str:
    return f'{PREFIX}/{ws}/credentials/{plugin}'


@pytest.fixture
def world(monkeypatch, request) -> Iterator[World]:
    """The operator routes in three workspaces; A and the new one enabled the webscraper plugin (their
    ``PLUGIN#webscraper`` rows), B enabled nothing."""
    request.getfixturevalue('plugin_secret_defaults')  # the plugins CDK tells the integrations API about
    monkeypatch.setenv('WORKSPACE_PARAMETER_PREFIX', PREFIX)
    monkeypatch.setenv('WORKSPACE_PARAMETER_KEY_ARN', KEY)
    monkeypatch.setenv('AGGREGATES_TABLE', 'aggregates')
    with mock_aws():
        aggregates = create_pk_sk_table('aggregates')
        workspaces = pk_sk_table('workspaces')
        for ws in (WS_A, WS_B, WS_NEW):
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'status': 'active', 'name': ws,
                                      'slug': ws[-6:].lower(), 'secret_status': 'ready'})
        for ws, claims, role in MEMBERS:
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': f"MEMBER#{claims['sub']}", 'role': role})
        for ws in ENABLED_WEBSCRAPER:
            workspaces.put_item(Item={'pk': 'PLUGIN#webscraper', 'sk': f'WS#{ws}', 'enabled_by': 'sub-admin',
                                      'enabled_at': '2026-11-13T00:00:00+00:00'})
        secrets =boto3.client('secretsmanager', region_name='us-east-1')
        secrets.create_secret(Name=SHARED_SECRET, SecretString='{}')
        ssm = boto3.client('ssm', region_name='us-east-1')
        resolver = RequestWorkspace(table=lambda: workspaces, confirm_platform_admin=lambda _event: True)
        ingestor = MagicMock()
        ingestor.exceptions.ResourceNotFoundException = type('ResourceNotFoundException', (Exception,), {})
        ingestor.invoke.return_value = {'StatusCode': 202}
        real_client = boto3.client
        events = MagicMock()
        stub_rule_lookup(events)
        webscraper = MagicMock()
        with patch.object(integrations_handler._request, 'workspace', resolver), \
                patch.object(scrapers_handler._request, 'workspace', resolver), \
                patch.object(integrations_handler, 'secretsmanager', secrets), \
                patch.object(scrapers_handler, 'secretsmanager', secrets), \
                patch.object(integrations_handler, 'ssm', ssm), \
                patch.object(scrapers_handler, 'ssm', ssm), \
                patch.object(integrations_handler, 'SECRETS_ARN', SHARED_SECRET), \
                patch.object(scrapers_handler, 'SECRETS_ARN', SHARED_SECRET), \
                patch.object(integrations_handler, 'events_client', events), \
                patch.object(integrations_handler.boto3, 'client',
                             side_effect=lambda name, *a, **k: ingestor if name == 'lambda' else real_client(name, *a, **k)), \
                patch.object(scrapers_handler, 'lambda_client', webscraper), \
                patch.object(scrapers_handler, 'WEBSCRAPER_FUNCTION_NAME', 'voc-ingestor-webscraper'), \
                patch.object(scrapers_handler, 'validate_url', return_value=(True, '')), \
                patch('shared.tables.get_aggregates_table', return_value=aggregates), \
                patch.object(scrapers_handler, 'get_aggregates_table', return_value=aggregates), \
                patch('shared.plugin_circuit.get_aggregates_table', return_value=aggregates), \
                patch('shared.workspace_plugin_store.get_dynamodb_resource',
                      return_value=boto3.resource('dynamodb', region_name='us-east-1')):
            yield World(aggregates, workspaces, secrets, ssm, ingestor, webscraper, events, resolver)


def _call(module: Any, lambda_context: Any, method: str, path: str, *, claims: dict, ws: str | None,
          body: Any = None, path_params: dict | None = None, query: dict | None = None) -> tuple[int, Any]:
    event = rest_event(method, path, claims=claims, body=body, path_params=path_params)
    if ws is not None:
        event['headers']['X-Workspace-Id'] = ws
    event['queryStringParameters'] = query
    response = module.lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])


def _integrations(lambda_context, method, path, **kwargs):
    parts = path.strip('/').split('/')
    params = {'source': parts[1]} if len(parts) >= 3 else None
    if len(parts) == 4:
        params = {'source': parts[1], 'app_id': parts[3]}
    return _call(integrations_handler, lambda_context, method, path, path_params=params, **kwargs)


def _scrapers(lambda_context, method, path, **kwargs):
    parts = path.strip('/').split('/')
    params = {'scraper_id': parts[1]} if len(parts) == 3 else None
    return _call(scrapers_handler, lambda_context, method, path, path_params=params, **kwargs)


# ── Run now ──────────────────────────────────────────────────────────────────────────────────────────────────────

class TestRunNowInAWorkspace:
    def test_the_payload_names_the_resolved_workspace_even_when_the_body_names_another(self, world, lambda_context):
        status, body = _integrations(lambda_context, 'POST', '/sources/webscraper/run', claims=ADMIN_A, ws=WS_A,
                                     body={'app_id': 'app-1', 'workspace_id': WS_B})

        assert status == 200, body
        payload = world.invoked_payload(world.ingestor)
        assert payload == {'execution_id': body['execution_id'], 'app_id': 'app-1', 'workspace_id': WS_A}
        # The ingestor's own router (plugins/_shared/base_ingestor.py run_in_workspace) runs it in WS_A.
        refused, scope = message_scope(payload)
        assert not refused
        assert scope is not None
        assert scope.ws == WS_A
        assert world.row(f'WS#{WS_A}#SOURCE_RUN#webscraper', body['execution_id'])['status'] == 'running'
        assert world.partitions() == {f'WS#{WS_A}#SOURCE_RUN#webscraper'}

    def test_without_the_header_it_runs_deployment_wide_as_before(self, world, lambda_context):
        status, body = _integrations(lambda_context, 'POST', '/sources/webscraper/run', claims=DEPLOYMENT_ADMIN,
                                     ws=None, body={'workspace_id': WS_A})

        assert status == 200, body
        assert world.invoked_payload(world.ingestor) == {'execution_id': body['execution_id']}
        assert world.partitions() == {'SOURCE_RUN#webscraper'}

    @pytest.mark.parametrize('claims', [EDITOR_A, VIEWER_A])
    def test_an_editor_or_a_viewer_is_refused(self, world, lambda_context, claims):
        status, _ = _integrations(lambda_context, 'POST', '/sources/webscraper/run', claims=claims, ws=WS_A)

        assert status == 403
        world.ingestor.invoke.assert_not_called()
        assert world.partitions() == set()

    @pytest.mark.parametrize('claims', [DEPLOYMENT_ADMIN, ADMIN_B])
    def test_a_non_member_gets_the_one_404(self, world, lambda_context, claims):
        status, body = _integrations(lambda_context, 'POST', '/sources/webscraper/run', claims=claims, ws=WS_A)

        assert (status, body['error']) == (404, 'Workspace not found')
        world.ingestor.invoke.assert_not_called()

    def test_a_platform_admin_enters_as_admin_audited(self, world, lambda_context):
        status, body = _integrations(lambda_context, 'POST', '/sources/webscraper/run', claims=PLATFORM_ADMIN, ws=WS_A)

        assert status == 200, body
        assert world.invoked_payload(world.ingestor)['workspace_id'] == WS_A
        audits = world.workspaces.query(KeyConditionExpression='pk = :p',
                                        ExpressionAttributeValues={':p': f'AUDIT#WS#{WS_A}'})['Items']
        assert [row['kind'] for row in audits] == ['platform_admin_entry']

    def test_an_admin_demoted_a_moment_ago_cannot_run(self, world, lambda_context):
        """A write never trusts the 30 s membership cache."""
        assert _integrations(lambda_context, 'GET', '/sources/status', claims=ADMIN_A, ws=WS_A,
                             query={'run_status': 'webscraper'})[0] == 200  # cached as admin
        world.workspaces.put_item(Item={'pk': f'WS#{WS_A}', 'sk': f"MEMBER#{ADMIN_A['sub']}", 'role': 'editor'})

        status, _ = _integrations(lambda_context, 'POST', '/sources/webscraper/run', claims=ADMIN_A, ws=WS_A)

        assert status == 403
        world.ingestor.invoke.assert_not_called()

    def test_the_run_status_is_the_workspaces(self, world, lambda_context):
        world.aggregates.put_item(Item={'pk': f'WS#{WS_A}#SOURCE_RUN#webscraper', 'sk': 'run_2', 'status': 'completed',
                                        'items_found': 7})
        world.aggregates.put_item(Item={'pk': 'SOURCE_RUN#webscraper', 'sk': 'run_9', 'status': 'error'})
        world.aggregates.put_item(Item={'pk': f'WS#{WS_B}#SOURCE_RUN#webscraper', 'sk': 'run_8', 'status': 'error'})

        status, body = _integrations(lambda_context, 'GET', '/sources/status', claims=VIEWER_A, ws=WS_A,
                                     query={'run_status': 'webscraper'})
        deployment = _integrations(lambda_context, 'GET', '/sources/status', claims=DEPLOYMENT_ADMIN, ws=None,
                                   query={'run_status': 'webscraper'})[1]

        assert status == 200
        assert (body['execution_id'], body['status'], body['items_found']) == ('run_2', 'completed', 7)
        assert (deployment['execution_id'], deployment['status']) == ('run_9', 'error')

    def test_a_workspace_that_never_ran_says_so(self, world, lambda_context):
        world.aggregates.put_item(Item={'pk': 'SOURCE_RUN#webscraper', 'sk': 'run_9', 'status': 'completed'})

        _status, body = _integrations(lambda_context, 'GET', '/sources/status', claims=VIEWER_A, ws=WS_B,
                                      query={'run_status': 'webscraper'})

        assert body['error'] == 'Workspace not found'
        assert _integrations(lambda_context, 'GET', '/sources/status', claims=ADMIN_B, ws=WS_B,
                             query={'run_status': 'webscraper'})[1]['status'] == 'never_run'


# ── A scraper's run ──────────────────────────────────────────────────────────────────────────────────────────────

class TestAScrapersRunInAWorkspace:
    def test_the_payload_names_the_resolved_workspace_and_the_row_is_its(self, world, lambda_context):
        status, body = _scrapers(lambda_context, 'POST', '/scrapers/site-1/run', claims=ADMIN_A, ws=WS_A,
                                 body={'workspace_id': WS_B})

        assert status == 200, body
        payload = world.invoked_payload(world.webscraper)
        assert payload == {'scraper_id': 'site-1', 'execution_id': body['execution_id'],
                           'workspace_id': WS_A}
        assert world.partitions() == {f'WS#{WS_A}#SCRAPER_RUN#site-1'}

    def test_without_the_header_as_before(self, world, lambda_context):
        status, body = _scrapers(lambda_context, 'POST', '/scrapers/site-1/run', claims=DEPLOYMENT_ADMIN, ws=None)

        assert status == 200, body
        assert 'workspace_id' not in world.invoked_payload(world.webscraper)
        assert world.partitions() == {'SCRAPER_RUN#site-1'}

    @pytest.mark.parametrize(('claims', 'expected'), [(EDITOR_A, 403), (VIEWER_A, 403), (DEPLOYMENT_ADMIN, 404)])
    def test_only_the_workspaces_admins_run_it(self, world, lambda_context, claims, expected):
        status, _ = _scrapers(lambda_context, 'POST', '/scrapers/site-1/run', claims=claims, ws=WS_A)

        assert status == expected
        world.webscraper.invoke.assert_not_called()
        assert world.partitions() == set()

    def test_the_status_reads_the_workspaces_row(self, world, lambda_context):
        world.aggregates.put_item(Item={'pk': f'WS#{WS_A}#SCRAPER_RUN#site-1', 'sk': 'run_1', 'status': 'completed',
                                        'pages_scraped': 3})
        world.aggregates.put_item(Item={'pk': 'SCRAPER_RUN#site-1', 'sk': 'run_5', 'status': 'error'})

        _status, body = _scrapers(lambda_context, 'GET', '/scrapers/site-1/status', claims=VIEWER_A, ws=WS_A)

        assert (body['execution_id'], body['status'], body['pages_scraped']) == ('run_1', 'completed', 3)


# ── The breaker ──────────────────────────────────────────────────────────────────────────────────────────────────

def _trip(world: World, pk: str, error: str) -> None:
    world.aggregates.put_item(Item={'pk': pk, 'sk': 'TRIPPED', 'tripped_at': '2026-11-01T00:00:00+00:00',
                                    'failure_count': 5, 'last_error': error})


@pytest.fixture
def tripped(world) -> World:
    _trip(world, 'CIRCUIT#webscraper', 'deployment error')
    _trip(world, f'WS#{WS_A}#CIRCUIT#webscraper', 'workspace A error')
    _trip(world, f'WS#{WS_B}#CIRCUIT#webscraper', 'workspace B error')
    return world


class TestTheBreakerInAWorkspace:
    @pytest.mark.usefixtures('tripped')
    def test_the_status_reports_the_workspaces_breaker(self, lambda_context):
        _, admin = _integrations(lambda_context, 'GET', '/sources/status', claims=ADMIN_A, ws=WS_A,
                                 query={'sources': 'webscraper'})
        _, viewer = _integrations(lambda_context, 'GET', '/sources/status', claims=VIEWER_A, ws=WS_A,
                                  query={'sources': 'webscraper'})
        _, deployment = _integrations(lambda_context, 'GET', '/sources/status', claims=DEPLOYMENT_ADMIN, ws=None,
                                      query={'sources': 'webscraper'})

        assert admin['sources']['webscraper']['circuit']['last_error'] == 'workspace A error'
        assert viewer['sources']['webscraper']['circuit'] == {**admin['sources']['webscraper']['circuit'],
                                                              'last_error': None}
        assert deployment['sources']['webscraper']['circuit']['last_error'] == 'deployment error'

    def test_reset_clears_the_workspaces_row_only(self, tripped, lambda_context):
        status, body = _integrations(lambda_context, 'POST', '/sources/webscraper/reset', claims=ADMIN_A, ws=WS_A)

        assert status == 200, body
        assert tripped.row(f'WS#{WS_A}#CIRCUIT#webscraper', 'TRIPPED') is None
        assert tripped.row('CIRCUIT#webscraper', 'TRIPPED') is not None
        assert tripped.row(f'WS#{WS_B}#CIRCUIT#webscraper', 'TRIPPED') is not None
        tripped.events.enable_rule.assert_not_called()

    def test_reset_without_the_header_clears_the_deployments_row_only(self, tripped, lambda_context):
        status, _ = _integrations(lambda_context, 'POST', '/sources/webscraper/reset', claims=DEPLOYMENT_ADMIN, ws=None)

        assert status == 200
        assert tripped.row('CIRCUIT#webscraper', 'TRIPPED') is None
        assert tripped.row(f'WS#{WS_A}#CIRCUIT#webscraper', 'TRIPPED') is not None

    @pytest.mark.parametrize(('claims', 'expected'), [(EDITOR_A, 403), (VIEWER_A, 403), (DEPLOYMENT_ADMIN, 404)])
    def test_reset_is_for_the_workspaces_admins(self, tripped, lambda_context, claims, expected):
        status, _ = _integrations(lambda_context, 'POST', '/sources/webscraper/reset', claims=claims, ws=WS_A)

        assert status == expected
        assert tripped.row(f'WS#{WS_A}#CIRCUIT#webscraper', 'TRIPPED') is not None

    @pytest.mark.parametrize('action', ['enable', 'disable'])
    def test_the_schedule_is_not_a_workspaces_to_switch(self, tripped, lambda_context, action):
        status, body = _integrations(lambda_context, 'PUT', f'/sources/webscraper/{action}', claims=ADMIN_A, ws=WS_A)

        assert (status, body['error']) == (400, integrations_handler.SCHEDULE_IS_THE_DEPLOYMENTS)
        tripped.events.enable_rule.assert_not_called()
        tripped.events.disable_rule.assert_not_called()
        assert tripped.row(f'WS#{WS_A}#CIRCUIT#webscraper', 'TRIPPED') is not None

    @pytest.mark.parametrize('action', ['enable', 'disable'])
    @pytest.mark.usefixtures('tripped')
    def test_the_gate_answers_before_the_refusal(self, lambda_context, action):
        assert _integrations(lambda_context, 'PUT', f'/sources/webscraper/{action}', claims=VIEWER_A, ws=WS_A)[0] == 403
        assert _integrations(lambda_context, 'PUT', f'/sources/webscraper/{action}', claims=ADMIN_B, ws=WS_A)[0] == 404


# ── Credentials ──────────────────────────────────────────────────────────────────────────────────────────────────

class TestCredentialsInAWorkspace:
    def test_a_save_writes_the_workspaces_parameter_of_the_plugin_only(self, world, lambda_context):
        status, body = _integrations(lambda_context, 'PUT', '/integrations/app_reviews_ios/credentials', claims=ADMIN_A,
                                     ws=WS_A, body={'app_name': 'Example App'})

        assert status == 200, body
        assert world.stored(WS_A) == {'app_reviews_ios_app_name': 'Example App'}
        assert world.parameter_names() == [_ws_parameter(WS_A, 'app_reviews_ios')]
        assert world.secret(SHARED_SECRET) == {}
        assert world.stored(WS_B) == {}

    def test_no_request_field_reaches_the_parameter_name(self, world, lambda_context):
        """The name comes from the resolved membership and the validated source only: a body, a path and a query
        naming another workspace or the shared secret change nothing."""
        hostile = {'app_name': 'x', 'workspace_id': WS_B}
        with patch.object(world.ssm, 'put_parameter', wraps=world.ssm.put_parameter) as put:
            status, body = _call(integrations_handler, lambda_context, 'PUT',
                                 '/integrations/app_reviews_ios/credentials', claims=ADMIN_A, ws=WS_A, body=hostile,
                                 path_params={'source': 'app_reviews_ios', 'workspace_id': WS_B},
                                 query={'secret': SHARED_SECRET, 'workspace_id': WS_B})

        assert status == 200, body
        assert [call.kwargs['Name'] for call in put.call_args_list] == [_ws_parameter(WS_A, 'app_reviews_ios')]
        assert {(call.kwargs['Type'], call.kwargs['KeyId'], call.kwargs['Tier'], call.kwargs['Overwrite'])
                for call in put.call_args_list} == {('SecureString', KEY, 'Standard', True)}
        # A body key is only ever a value inside the plugin's own parameter of the resolved workspace.
        assert world.stored(WS_A) == {'app_reviews_ios_app_name': 'x', 'app_reviews_ios_workspace_id': WS_B}
        assert world.stored(WS_B) == {}
        assert world.secret(SHARED_SECRET) == {}

    def test_a_save_over_one_parameters_4096_bytes_is_a_400_and_nothing_is_written(self, world, lambda_context):
        world.save(WS_A, 'credentials/app_reviews_ios', json.dumps({'app_name': 'Kept'}))

        status, body = _integrations(lambda_context, 'PUT', '/integrations/app_reviews_ios/credentials', claims=ADMIN_A,
                                     ws=WS_A, body={'app_name': 'x' * 4100})

        assert status == 400
        assert 'over the 4096-byte limit of one stored value' in body['error']
        assert world.stored(WS_A) == {'app_reviews_ios_app_name': 'Kept'}

    def test_reads_come_from_the_workspaces_parameter_masked_as_before(self, world, lambda_context):
        world.save(WS_A, 'credentials/app_reviews_ios',
                   json.dumps({'app_name': 'Workspace App', 'sort_by': 'most_helpful'}))
        world.secrets.put_secret_value(SecretId=SHARED_SECRET, SecretString=json.dumps(
            {'app_reviews_ios_app_name': 'Deployment App'}))

        _, values = _integrations(lambda_context, 'GET', '/integrations/app_reviews_ios/credentials', claims=ADMIN_A,
                                  ws=WS_A, query={'keys': 'app_name,sort_by'})
        _, status = _integrations(lambda_context, 'GET', '/integrations/status', claims=ADMIN_A, ws=WS_A)
        _, deployment = _integrations(lambda_context, 'GET', '/integrations/app_reviews_ios/credentials',
                                      claims=DEPLOYMENT_ADMIN, ws=None, query={'keys': 'app_name'})

        assert values == {'app_name': 'Workspace App', 'sort_by': 'most_helpful'}
        assert status['app_reviews_ios']['credentials_set'] == ['app_name', 'sort_by']
        assert deployment == {'app_name': 'Deployment App'}

    @pytest.mark.parametrize(('method', 'path'), [('GET', '/integrations/status'),
                                                  ('GET', '/integrations/app_reviews_ios/credentials'),
                                                  ('PUT', '/integrations/app_reviews_ios/credentials')])
    @pytest.mark.parametrize(('claims', 'expected'), [(EDITOR_A, 403), (VIEWER_A, 403), (DEPLOYMENT_ADMIN, 404)])
    def test_credentials_are_for_the_workspaces_admins(self, world, lambda_context, method, path, claims, expected):
        status, _ = _integrations(lambda_context, method, path, claims=claims, ws=WS_A, body={'app_name': 'x'},
                                  query={'keys': 'app_name'})

        assert status == expected
        assert world.nothing_saved()

    def test_a_new_workspaces_first_save_creates_its_parameter(self, world, lambda_context):
        """Nothing is made with a workspace (decision 19): its first save creates the plugin's parameter."""
        status, body = _integrations(lambda_context, 'PUT', '/integrations/app_reviews_ios/credentials',
                                     claims=ADMIN_NEW, ws=WS_NEW, body={'app_name': 'x'})

        assert status == 200, body
        assert world.stored(WS_NEW) == {'app_reviews_ios_app_name': 'x'}
        assert world.secret(SHARED_SECRET) == {}

    def test_an_app_connector_lives_in_the_workspaces_config_row(self, world, lambda_context):
        status, body = _integrations(lambda_context, 'POST', '/integrations/app_reviews_ios/apps', claims=ADMIN_A,
                                     ws=WS_A, body={'app': {'id': 'a1', 'app_name': 'Example', 'app_id': '123'}})
        assert status == 200, body

        _, listed = _integrations(lambda_context, 'GET', '/integrations/app_reviews_ios/apps', claims=VIEWER_A, ws=WS_A)
        _, deployment = _integrations(lambda_context, 'GET', '/integrations/app_reviews_ios/apps',
                                      claims=DEPLOYMENT_ADMIN, ws=None)
        assert [app['id'] for app in listed['apps']] == ['a1']
        assert deployment['apps'] == []
        assert world.secret(SHARED_SECRET) == {}
        # A list is a row of the workspace (decision 19), not a parameter.
        assert world.parameter_names() == []
        assert [(row['pk'], row['sk']) for row in world.config_rows()] == [(f'WS#{WS_A}#PLUGIN_CONFIG', 'app_reviews_ios')]

        status, _ = _integrations(lambda_context, 'DELETE', '/integrations/app_reviews_ios/apps/a1', claims=ADMIN_A,
                                  ws=WS_A)
        assert status == 200
        assert json.loads(world.stored(WS_A)['app_reviews_ios_configs']) == []

    def test_an_editor_cannot_save_an_app_connector(self, world, lambda_context):
        status, _ = _integrations(lambda_context, 'POST', '/integrations/app_reviews_ios/apps', claims=EDITOR_A,
                                  ws=WS_A, body={'app': {'id': 'a1', 'app_name': 'Example'}})

        assert status == 403
        assert world.nothing_saved()


SCRAPER: Final = MappingProxyType({
    'id': 'site-1', 'name': 'Example site', 'base_url': 'https://www.example.com/reviews',
    'extraction_method': 'css', 'container_selector': '.review', 'text_selector': '.text'})


class TestScraperConfigsInAWorkspace:

    def test_a_scraper_saved_in_a_workspace_is_its_own(self, world, lambda_context):
        status, body = _scrapers(lambda_context, 'POST', '/scrapers', claims=ADMIN_A, ws=WS_A,
                                 body={'scraper': dict(SCRAPER)})
        assert status == 200, body

        _, listed = _scrapers(lambda_context, 'GET', '/scrapers', claims=VIEWER_A, ws=WS_A)
        _, deployment = _scrapers(lambda_context, 'GET', '/scrapers', claims=DEPLOYMENT_ADMIN, ws=None)
        assert [s['id'] for s in listed['scrapers']] == ['site-1']
        assert deployment['scrapers'] == []
        # The row the webscraper's run in WS_A reads (its own configs, shared/plugin_configs.py).
        assert world.parameter_names() == []
        assert [(row['pk'], row['sk']) for row in world.config_rows()] == [(f'WS#{WS_A}#PLUGIN_CONFIG', 'webscraper')]
        assert [c['id'] for c in json.loads(world.stored(WS_A)['webscraper_configs'])] == ['site-1']

        status, _ = _scrapers(lambda_context, 'DELETE', '/scrapers/site-1', claims=ADMIN_A, ws=WS_A)
        assert status == 200
        assert json.loads(world.stored(WS_A)['webscraper_configs']) == []

    @pytest.mark.parametrize(('claims', 'expected'), [(EDITOR_A, 403), (ADMIN_B, 404)])
    def test_only_the_workspaces_admins_save(self, world, lambda_context, claims, expected):
        status, _ = _scrapers(lambda_context, 'POST', '/scrapers', claims=claims, ws=WS_A,
                              body={'scraper': dict(SCRAPER)})

        assert status == expected
        assert world.nothing_saved()

    def test_the_connectors_listing_reads_the_workspaces_config_rows(self, world, lambda_context):
        world.save(WS_A, 'configs/app_reviews_ios', json.dumps([{'id': 'a1', 'app_name': 'Workspace App'}]))
        world.save(WS_B, 'configs/app_reviews_ios', json.dumps([{'id': 'b1', 'app_name': 'Other Workspace App'}]))

        _, body = _scrapers(lambda_context, 'GET', '/scrapers/connectors', claims=VIEWER_A, ws=WS_A)
        _, deployment = _scrapers(lambda_context, 'GET', '/scrapers/connectors', claims=DEPLOYMENT_ADMIN, ws=None)

        assert [c['app_name'] for c in body['connectors']] == ['Workspace App']
        assert deployment['connectors'] == []


#: Every route of the two modules that reads or writes the workspace's parameters: (module, method, path, params,
#: body, what a new workspace's read answers: None for a write or a run).
STORE_ROUTES: Final = (
    (scrapers_handler, 'GET', '/scrapers', None, None, {'scrapers': []}),
    (scrapers_handler, 'GET', '/scrapers/connectors', None, None, {'connectors': []}),
    (scrapers_handler, 'POST', '/scrapers', None, {'scraper': dict(SCRAPER)}, None),
    (scrapers_handler, 'DELETE', '/scrapers/site-1', {'scraper_id': 'site-1'}, None, None),
    (integrations_handler, 'GET', '/integrations/app_reviews_ios/credentials', {'source': 'app_reviews_ios'}, None,
     {}),
    (integrations_handler, 'PUT', '/integrations/app_reviews_ios/credentials', {'source': 'app_reviews_ios'},
     {'app_name': 'x'}, None),
    (integrations_handler, 'GET', '/integrations/app_reviews_ios/apps', {'source': 'app_reviews_ios'}, None,
     {'apps': []}),
    (integrations_handler, 'POST', '/integrations/app_reviews_ios/apps', {'source': 'app_reviews_ios'},
     {'app': {'id': 'a1', 'app_name': 'Example'}}, None),
    (integrations_handler, 'DELETE', '/integrations/app_reviews_ios/apps/d1',
     {'source': 'app_reviews_ios', 'app_id': 'd1'}, None, None),
    (integrations_handler, 'POST', '/sources/webscraper/run', {'source': 'webscraper'}, None, None),
    (scrapers_handler, 'POST', '/scrapers/site-1/run', {'scraper_id': 'site-1'}, None, None),
)


def _shared_secret_with_values(world: World) -> None:
    world.secrets.put_secret_value(SecretId=SHARED_SECRET, SecretString=json.dumps({
        'webscraper_configs': json.dumps([dict(SCRAPER)]), 'app_reviews_ios_app_name': 'Deployment App',
        'app_reviews_ios_configs': json.dumps([{'id': 'd1', 'app_name': 'Deployment App'}])}))


class TestAWorkspaceWithNothingSavedYet:
    """Decision 19: nothing is made with a workspace, so a new one is ready at once. Every route answers (no 409, no
    pending state): a read answers empty (``ParameterNotFound`` is "nothing saved"), never the shared secret's
    values; a write creates only the plugin's own parameter or config row; a run goes ahead (it ends WorkspaceCredentialsNotSet
    in the ingestor when nothing of its plugin is saved: plugins/_shared/test/test_base_ingestor.py)."""

    @pytest.mark.parametrize(('module', 'method', 'path', 'params', 'body', 'empty'), STORE_ROUTES,
                             ids=[f'{method} {path}' for _m, method, path, _p, _b, _e in STORE_ROUTES])
    def test_every_route_answers_from_the_workspaces_own_parameters(self, world, lambda_context, module, method,
                                                                    path, params, body, empty):
        _shared_secret_with_values(world)

        status, answer = _call(module, lambda_context, method, path, claims=ADMIN_NEW, ws=WS_NEW,
                               path_params=params, body=body, query={'keys': 'app_name'})

        assert status == 200, answer
        if empty is not None:
            assert answer == empty
        assert 'Deployment App' not in json.dumps(answer)
        assert all(name.startswith(f'{PREFIX}/{WS_NEW}/') for name in world.parameter_names())
        assert all(row['pk'] == f'WS#{WS_NEW}#PLUGIN_CONFIG' for row in world.config_rows())

    def test_the_status_of_a_new_workspace_reports_nothing_configured(self, world, lambda_context):
        _shared_secret_with_values(world)

        status, answer = _integrations(lambda_context, 'GET', '/integrations/status', claims=ADMIN_NEW, ws=WS_NEW)

        assert status == 200
        assert answer['app_reviews_ios'] == {'configured': False, 'credentials_set': []}
        assert answer['webscraper'] == {'configured': False, 'credentials_set': []}

    def test_the_status_lists_the_workspaces_own_keys(self, world, lambda_context):
        world.save(WS_A, 'credentials/app_reviews_ios', json.dumps({'app_name': 'Workspace App'}))
        world.save(WS_A, 'configs/webscraper', json.dumps([dict(SCRAPER)]))
        world.save(WS_B, 'credentials/webscraper', json.dumps({'api_key': 'other workspace'}))

        _, answer = _integrations(lambda_context, 'GET', '/integrations/status', claims=ADMIN_A, ws=WS_A)

        assert answer['app_reviews_ios']['credentials_set'] == ['app_name']
        assert answer['webscraper']['credentials_set'] == ['configs']

    def test_a_parameter_read_fault_is_the_routes_fault_never_the_shared_secret(self, world, lambda_context):
        _shared_secret_with_values(world)
        denied = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'GetParameter')
        with patch.object(world.ssm, 'get_parameter', side_effect=denied) as get_parameter:
            status, answer = _scrapers(lambda_context, 'GET', '/scrapers', claims=ADMIN_A, ws=WS_A)
            read_by_the_list = get_parameter.call_count
            put_status, _ = _scrapers(lambda_context, 'POST', '/scrapers', claims=ADMIN_A, ws=WS_A,
                                      body={'scraper': dict(SCRAPER)})

        # The member-open list reads the config row alone, never a credentials parameter; the save reads both.
        assert (status, answer, read_by_the_list) == (200, {'scrapers': []}, 0)
        assert put_status == 500
        assert world.nothing_saved()

    @pytest.mark.parametrize(('module', 'path'), [(scrapers_handler, '/scrapers'),
                                                  (scrapers_handler, '/scrapers/connectors'),
                                                  (integrations_handler, '/integrations/app_reviews_ios/apps')])
    def test_the_member_open_list_routes_never_read_a_credentials_parameter(self, world, lambda_context, module,
                                                                           path):
        world.save(WS_A, 'credentials/app_reviews_ios', json.dumps({'app_name': 'secret-ish'}))
        with patch.object(world.ssm, 'get_parameter', wraps=world.ssm.get_parameter) as get_parameter, \
                patch.object(world.ssm, 'get_paginator', wraps=world.ssm.get_paginator) as by_path:
            status, _ = _call(module, lambda_context, 'GET', path, claims=VIEWER_A, ws=WS_A,
                              path_params={'source': 'app_reviews_ios'} if 'integrations' in path else None)

        assert (status, get_parameter.call_count, by_path.call_count) == (200, 0, 0)


class TestNoRadarBrandInAWorkspace:
    """Radar is not keyed by workspace (phase 3): the processor refuses a workspace's message stamped with a Radar
    brand, so every save that would stamp one is refused (400), and the credentials route takes no `configs` list in
    a workspace. Without the header the brand is saved as before. (A deployment source profile's Radar brand claims
    no workspace message: lambda/processor/test/test_workspace_path.py.)"""

    def test_a_scraper_naming_a_radar_brand_is_refused(self, world, lambda_context):
        status, body = _scrapers(lambda_context, 'POST', '/scrapers', claims=ADMIN_A, ws=WS_A,
                                 body={'scraper': {**SCRAPER, 'radar_brand': 'rival'}})

        assert (status, body['error']) == (400, RADAR_NOT_IN_WORKSPACES)
        assert world.nothing_saved()

    def test_without_the_header_the_brand_is_saved(self, world, lambda_context):
        status, body = _scrapers(lambda_context, 'POST', '/scrapers', claims=DEPLOYMENT_ADMIN, ws=None,
                                 body={'scraper': {**SCRAPER, 'radar_brand': 'rival'}})

        assert status == 200, body
        assert json.loads(world.secret(SHARED_SECRET)['webscraper_configs'])[0]['radar_brand'] == 'rival'

    def test_a_workspace_scraper_without_a_brand_is_saved(self, world, lambda_context):
        status, _ = _scrapers(lambda_context, 'POST', '/scrapers', claims=ADMIN_A, ws=WS_A,
                              body={'scraper': {**SCRAPER, 'radar_brand': ' '}})

        assert status == 200
        assert 'radar_brand' not in json.loads(world.stored(WS_A)['webscraper_configs'])[0]

    def test_an_app_connector_naming_a_radar_brand_is_refused(self, world, lambda_context):
        status, body = _integrations(lambda_context, 'POST', '/integrations/app_reviews_ios/apps', claims=ADMIN_A,
                                     ws=WS_A, body={'app': {'id': 'a1', 'app_name': 'Example', 'radar_brand': 'rival'}})

        assert (status, body['error']) == (400, RADAR_NOT_IN_WORKSPACES)
        assert world.nothing_saved()

    def test_a_review_page_naming_a_radar_brand_is_refused(self, world, lambda_context):
        target = {'id': 'p1', 'app_name': 'Example page', 'url': 'https://www.example.com/reviews',
                  'radar_brand': 'rival'}
        with patch('shared.web_review_targets.checked_url', side_effect=lambda url: url):
            status, body = _integrations(lambda_context, 'POST', '/integrations/web_reviews/apps', claims=ADMIN_A,
                                         ws=WS_A, body={'app': target})

        assert (status, body['error']) == (400, RADAR_NOT_IN_WORKSPACES)
        assert world.nothing_saved()

    @pytest.mark.parametrize('source', ['webscraper', 'app_reviews_ios', 'web_reviews'])
    @pytest.mark.parametrize('configs', [json.dumps([{**SCRAPER, 'radar_brand': 'rival'}]), '[]', None])
    def test_a_configs_list_on_the_credentials_route_is_refused_whatever_it_holds(
            self, world, lambda_context, source, configs):
        """The lists are saved through POST /scrapers and POST /integrations/{source}/apps, which check every
        entry (a Radar brand among them): the credentials route takes no `configs` key in a workspace."""
        status, body = _integrations(lambda_context, 'PUT', f'/integrations/{source}/credentials', claims=ADMIN_A,
                                     ws=WS_A, body={'configs': configs, 'app_name': 'x'})

        assert (status, body['error']) == (400, integrations_handler.CONFIGS_HAVE_THEIR_OWN_ROUTES)
        assert world.nothing_saved()

    def test_without_the_header_the_credentials_route_still_takes_configs(self, world, lambda_context):
        configs = json.dumps([dict(SCRAPER)])
        status, body = _integrations(lambda_context, 'PUT', '/integrations/webscraper/credentials',
                                     claims=DEPLOYMENT_ADMIN, ws=None, body={'configs': configs})

        assert status == 200, body
        assert world.secret(SHARED_SECRET) == {'webscraper_configs': configs}


def test_run_now_of_the_s3_import_is_deployment_wide_only(world, lambda_context):
    status, body = _integrations(lambda_context, 'POST', '/sources/s3_import/run', claims=ADMIN_A, ws=WS_A)

    assert (status, body['error']) == (400, DEPLOYMENT_ONLY)
    world.ingestor.invoke.assert_not_called()
    assert world.partitions() == set()


#: What a route may hand `_request.credentials` as the plugins it serves: the route's validated `source` path
#: parameter, or a constant of the module (never another request field).
PLUGIN_ARGUMENTS = frozenset({'source', 'WEBSCRAPER_PLUGIN', 'CONNECTOR_SOURCES'})
#: No handler reads or writes a secret, a parameter or a config row itself: only shared/workspace_plugin_store.py does.
DIRECT_CALLS = frozenset({'get_secret_value', 'put_secret_value', 'get_parameter', 'get_parameters',
                          'get_parameters_by_path', 'put_parameter', 'save_configs', 'read_configs'})


def _calls(node: ast.AST) -> list[ast.Call]:
    return [n for n in ast.walk(node) if isinstance(n, ast.Call)]


def _name(call: ast.Call) -> str | None:
    func = call.func
    return func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None


def _argument_name(node: ast.expr) -> str | None:
    node = node.value if isinstance(node, ast.Starred) else node
    return node.id if isinstance(node, ast.Name) else None


@pytest.mark.parametrize('module', [integrations_handler, scrapers_handler])
def test_no_handler_builds_a_secret_or_parameter_name_from_request_input(module):
    """Every store a route reads or writes comes from the module's `_request.credentials` (the shared ARN, or
    shared/workspace_plugin_store.py `credentials_store` of the resolved membership), named by the route's validated
    source or a module constant; no handler names a secret, a parameter or a config row itself."""
    source = Path(module.__file__).read_text(encoding='utf-8')
    tree = ast.parse(source)
    for forbidden in ('credentials_parameter_name', 'plugin_config_key', 'WORKSPACE_PARAMETER_PREFIX'):
        assert forbidden not in source
    assert not any(keyword.arg == 'SecretId' for call in _calls(tree) for keyword in call.keywords)
    assert not [call for call in _calls(tree) if _name(call) in DIRECT_CALLS]
    opened = [call for call in _calls(tree) if _name(call) in {'credentials', 'credentials_or_none'}]
    assert opened
    for call in opened:
        assert isinstance(call.func, ast.Attribute)
        assert isinstance(call.func.value, ast.Name)
        assert call.func.value.id == '_request'
        assert {_argument_name(arg) for arg in call.args} <= PLUGIN_ARGUMENTS
        assert call.keywords == []


def test_the_workspace_store_is_opened_from_the_resolved_workspace_only():
    """shared/workspace_plugin_store.py: the store's workspace is `scope_of(context)` (the table's scope, which names
    every parameter and row), after an `isinstance(context, WorkspaceContext)` check."""
    from shared import workspace_plugin_store
    tree = ast.parse(Path(workspace_plugin_store.__file__).read_text(encoding='utf-8'))
    function = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'credentials_store')
    [scope] = [call for call in _calls(function) if _name(call) == 'scope_of']
    [context] = scope.args
    assert isinstance(context, ast.Name)
    assert context.id == 'context'
    assert any(_name(call) == 'isinstance' for call in _calls(function))
    [store] = [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == 'WorkspaceStore']
    assert 'self.ws = table.scope.ws' in ast.unparse(store)


# ── The S3 import API: deployment-wide only ─────────────────────────────────────────────────────────────────────

class TestTheS3ImportApiRefusesAWorkspace:
    @pytest.mark.parametrize(('method', 'path', 'claims'), [
        ('POST', '/s3-import/reprocess', ADMIN_A), ('POST', '/s3-import/reprocess', DEPLOYMENT_ADMIN),
        ('GET', '/s3-import/files', VIEWER_A), ('GET', '/s3-import/reprocess/run_s3_import_20261101000000_0a0b0c0d',
                                                ADMIN_B)])
    @pytest.mark.parametrize('ws', [WS_A, ''])
    def test_one_answer_for_everyone_before_anything_is_read(self, lambda_context, method, path, claims, ws):
        # A reprocess too: the import bucket is the deployment's, so no plugin of a workspace is ever named here.
        with patch.object(s3_import_handler, 's3_client') as s3, \
                patch.object(s3_import_handler, 'get_aggregates_table') as table:
            status, body = _call(s3_import_handler, lambda_context, method, path, claims=claims, ws=ws,
                                 body={'key': 'default/reviews.csv'})

        assert (status, body['error']) == (400, DEPLOYMENT_ONLY)
        assert s3.mock_calls == []
        assert table.mock_calls == []


# ── A run in a workspace needs its plugin enabled there (shared/workspace_plugin_settings.py) ─────────────────────

NOT_ENABLED: Final = (409, workspace_plugin_settings.PLUGIN_NOT_ENABLED)


class TestARunNeedsThePluginEnabledInTheWorkspace:
    """Since 7.14.00 a workspace's Run now and a scraper's run run only a plugin the workspace enabled (its
    ``PLUGIN#{plugin}`` / ``WS#{ws}`` row, the one the scheduled tick fans out over): otherwise 409
    ``PLUGIN_NOT_ENABLED``, after the admin gate and the source check, before a row is written or a run invoked.
    Deployment-wide nothing is read and the run starts as before."""

    def test_run_now_of_a_plugin_the_workspace_has_not_enabled_starts_nothing(self, world, lambda_context):
        status, body = _integrations(lambda_context, 'POST', '/sources/webscraper/run', claims=ADMIN_B, ws=WS_B)

        assert (status, body['error']) == NOT_ENABLED
        assert world.ingestor.invoke.call_count == 0
        assert world.aggregates.scan()['Items'] == []

    def test_another_workspaces_enable_counts_for_nothing(self, world, lambda_context):
        """WS_A enabled the webscraper; its app reviews plugin is not on, whatever another workspace enabled."""
        world.workspaces.put_item(Item={'pk': 'PLUGIN#app_reviews_ios', 'sk': f'WS#{WS_B}'})

        status, body = _integrations(lambda_context, 'POST', '/sources/app_reviews_ios/run', claims=ADMIN_A, ws=WS_A)

        assert (status, body['error']) == NOT_ENABLED
        assert world.ingestor.invoke.call_count == 0

    def test_a_scraper_run_of_a_workspace_without_the_webscraper_starts_nothing(self, world, lambda_context):
        status, body = _scrapers(lambda_context, 'POST', '/scrapers/shop/run', claims=ADMIN_B, ws=WS_B)

        assert (status, body['error']) == NOT_ENABLED
        assert world.webscraper.invoke.call_count == 0
        assert world.aggregates.scan()['Items'] == []

    def test_once_its_admin_enables_the_plugin_the_run_starts_and_a_disable_stops_it_again(self, world,
                                                                                        lambda_context):
        event = rest_event('PUT', '/me/workspaces/current/plugins/webscraper', claims=ADMIN_B)
        event['headers']['X-Workspace-Id'] = WS_B
        context = world.resolver.context(event, fresh=True)
        assert context is not None
        workspace_plugin_settings.set_plugin_enabled(world.workspaces, context, 'webscraper', True, ADMIN_B['sub'])
        started, body = _integrations(lambda_context, 'POST', '/sources/webscraper/run', claims=ADMIN_B, ws=WS_B)
        workspace_plugin_settings.set_plugin_enabled(world.workspaces, context, 'webscraper', False, ADMIN_B['sub'])
        refused, again = _integrations(lambda_context, 'POST', '/sources/webscraper/run', claims=ADMIN_B, ws=WS_B)

        assert started == 200, body
        assert world.invoked_payload(world.ingestor)['workspace_id'] == WS_B
        assert (refused, again['error']) == NOT_ENABLED

    @pytest.mark.parametrize('claims', [EDITOR_A, VIEWER_A])
    @pytest.mark.usefixtures('world')
    def test_the_admin_gate_answers_first(self, lambda_context, claims):
        status, _ = _integrations(lambda_context, 'POST', '/sources/app_reviews_ios/run', claims=claims, ws=WS_A)

        assert status == 403

    def test_the_source_is_checked_and_s3_import_refused_before_the_plugin(self, world, lambda_context):
        unknown, _ = _integrations(lambda_context, 'POST', '/sources/no_such_plugin/run', claims=ADMIN_B, ws=WS_B)
        s3_import, body = _integrations(lambda_context, 'POST', '/sources/s3_import/run', claims=ADMIN_B, ws=WS_B)

        assert unknown == 400
        assert (s3_import, body['error']) == (400, DEPLOYMENT_ONLY)
        assert world.ingestor.invoke.call_count == 0

    def test_a_read_fault_is_the_fixed_500_and_starts_nothing(self, world, lambda_context):
        denied = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'GetItem')
        with patch('shared.workspace_request.require_plugin_enabled', side_effect=denied):
            status, _ = _integrations(lambda_context, 'POST', '/sources/webscraper/run', claims=ADMIN_A, ws=WS_A)

        assert status == 500
        assert world.ingestor.invoke.call_count == 0

    def test_a_deployment_wide_run_reads_no_plugin_row(self, world, lambda_context):
        with patch('shared.workspace_request.require_plugin_enabled') as enabled:
            status, body = _integrations(lambda_context, 'POST', '/sources/webscraper/run', claims=DEPLOYMENT_ADMIN,
                                         ws=None)

        assert status == 200, body
        enabled.assert_not_called()
        assert 'workspace_id' not in world.invoked_payload(world.ingestor)

    def test_both_run_routes_check_the_plugin_through_the_one_gate(self):
        for module, plugin in ((integrations_handler, '_request.require_plugin_enabled(source)'),
                               (scrapers_handler, '_request.require_plugin_enabled(WEBSCRAPER_PLUGIN)')):
            assert inspect.getsource(module).count(plugin) == 1
