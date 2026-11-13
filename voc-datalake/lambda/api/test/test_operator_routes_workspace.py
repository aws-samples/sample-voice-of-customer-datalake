"""The operator routes that start and watch ingestion, on both paths (docs/multi-workspace.md, "Request flow").

With ``X-Workspace-Id`` the integrations and scrapers APIs act in that workspace: the admin routes need the caller's
admin role there (a workspace admin or an entered platform admin; the deployment's ``admins`` grants nothing, an
editor or a viewer gets 403, a non-member the one 404); Run now and a scraper's run carry the RESOLVED workspace on
their invoke payload (never a body field) and write and read the workspace's run rows; the breaker routes read and
clear the workspace's own TRIPPED row (enable and disable are refused: the schedule rule serves every workspace);
credentials, app connectors and scraper configs live in the workspace's own secret. The S3 import API refuses the
header outright. Without the header each route acts deployment-wide, as before.
"""
from __future__ import annotations

import ast
import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final
from unittest.mock import MagicMock, patch

import boto3
import pytest
from integrations_fixtures import stub_rule_lookup
from moto import mock_aws
from moto_helpers import pk_sk_table, rest_event

import integrations_handler
import s3_import_handler
import scrapers_handler
from shared.test.moto_tables import create_pk_sk_table
from shared.workspace_plugin_store import CREDENTIALS_MISSING, CREDENTIALS_NOT_READY
from shared.workspace_request import DEPLOYMENT_ONLY, RADAR_NOT_IN_WORKSPACES, RequestWorkspace
from shared.ws_repo import message_scope

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
#: A workspace whose credentials secret was never made (secret_status pending).
WS_PENDING = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DA'
SHARED_SECRET = 'shared-api-credentials'
PREFIX = 'voc/ws'


def _claims(sub: str, groups: str = 'users') -> dict:
    return {'sub': sub, 'cognito:groups': groups, 'cognito:username': sub}


#: A workspace admin who is NOT in the deployment's `admins` group: the workspace role alone admits them.
ADMIN_A = _claims('sub-admin-a')
EDITOR_A = _claims('sub-editor-a')
VIEWER_A = _claims('sub-viewer-a')
ADMIN_B = _claims('sub-admin-b')
ADMIN_PENDING = _claims('sub-admin-p')
#: The deployment's administrator, a member of no workspace.
DEPLOYMENT_ADMIN = _claims('sub-deploy', 'admins')
PLATFORM_ADMIN = _claims('sub-platform', 'admins,platform-admins')
MEMBERS = ((WS_A, ADMIN_A, 'admin'), (WS_A, EDITOR_A, 'editor'), (WS_A, VIEWER_A, 'viewer'),
           (WS_B, ADMIN_B, 'admin'), (WS_PENDING, ADMIN_PENDING, 'admin'))


@dataclass
class World:
    aggregates: Any
    workspaces: Any
    secrets: Any
    ingestor: MagicMock
    webscraper: MagicMock
    events: MagicMock
    resolver: RequestWorkspace

    def secret(self, name: str) -> dict:
        return json.loads(self.secrets.get_secret_value(SecretId=name)['SecretString'])

    def row(self, pk: str, sk: str) -> dict | None:
        return self.aggregates.get_item(Key={'pk': pk, 'sk': sk}).get('Item')

    def partitions(self) -> set[str]:
        return {item['pk'] for item in self.aggregates.scan()['Items']}

    def invoked_payload(self, client: MagicMock) -> dict:
        [call] = client.invoke.call_args_list
        payload = call.kwargs['Payload']
        return json.loads(payload.decode() if isinstance(payload, bytes) else payload)


def _ws_secret(ws: str) -> str:
    return f'{PREFIX}/{ws}/credentials'


@pytest.fixture
def world(monkeypatch, request) -> Iterator[World]:
    request.getfixturevalue('plugin_secret_defaults')  # the plugins CDK tells the integrations API about
    monkeypatch.setenv('WORKSPACE_SECRET_PREFIX', PREFIX)
    with mock_aws():
        aggregates = create_pk_sk_table('aggregates')
        workspaces = pk_sk_table('workspaces')
        for ws, secret_status in ((WS_A, 'ready'), (WS_B, 'ready'), (WS_PENDING, 'pending')):
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'status': 'active', 'name': ws,
                                      'slug': ws[-6:].lower(), 'secret_status': secret_status})
        for ws, claims, role in MEMBERS:
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': f"MEMBER#{claims['sub']}", 'role': role})
        secrets = boto3.client('secretsmanager', region_name='us-east-1')
        for name in (SHARED_SECRET, _ws_secret(WS_A), _ws_secret(WS_B)):
            secrets.create_secret(Name=name, SecretString='{}')
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
                patch('shared.plugin_circuit.get_aggregates_table', return_value=aggregates):
            yield World(aggregates, workspaces, secrets, ingestor, webscraper, events, resolver)


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
    def test_a_save_writes_the_workspaces_secret_only(self, world, lambda_context):
        status, body = _integrations(lambda_context, 'PUT', '/integrations/app_reviews_ios/credentials', claims=ADMIN_A,
                                     ws=WS_A, body={'app_name': 'Example App'})

        assert status == 200, body
        assert world.secret(_ws_secret(WS_A)) == {'app_reviews_ios_app_name': 'Example App'}
        assert world.secret(SHARED_SECRET) == {}
        assert world.secret(_ws_secret(WS_B)) == {}

    def test_no_request_field_reaches_the_secret_name(self, world, lambda_context):
        """The name comes from the resolved membership only: a body, a path and a query naming another workspace or
        the shared secret change nothing, and no secret is created."""
        hostile = {'app_name': 'x', 'workspace_id': WS_B}
        with patch.object(world.secrets, 'put_secret_value', wraps=world.secrets.put_secret_value) as put:
            status, body = _call(integrations_handler, lambda_context, 'PUT',
                                 '/integrations/app_reviews_ios/credentials', claims=ADMIN_A, ws=WS_A, body=hostile,
                                 path_params={'source': 'app_reviews_ios', 'workspace_id': WS_B},
                                 query={'secret': SHARED_SECRET, 'workspace_id': WS_B})

        assert status == 200, body
        assert [call.kwargs['SecretId'] for call in put.call_args_list] == [_ws_secret(WS_A)]
        # A body key is only ever a value inside the plugin's namespace of the resolved workspace's secret.
        assert world.secret(_ws_secret(WS_A)) == {'app_reviews_ios_app_name': 'x', 'app_reviews_ios_workspace_id': WS_B}
        assert world.secret(_ws_secret(WS_B)) == {}
        assert world.secret(SHARED_SECRET) == {}
        assert sorted(s['Name'] for s in world.secrets.list_secrets()['SecretList']) == sorted(
            [SHARED_SECRET, _ws_secret(WS_A), _ws_secret(WS_B)])

    def test_reads_come_from_the_workspaces_secret_masked_as_before(self, world, lambda_context):
        world.secrets.put_secret_value(SecretId=_ws_secret(WS_A), SecretString=json.dumps(
            {'app_reviews_ios_app_name': 'Workspace App', 'app_reviews_ios_sort_by': 'most_helpful'}))
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
        assert world.secret(_ws_secret(WS_A)) == {}

    def test_a_workspace_without_its_secret_yet_is_told_so(self, world, lambda_context):
        status, body = _integrations(lambda_context, 'PUT', '/integrations/app_reviews_ios/credentials',
                                     claims=ADMIN_PENDING, ws=WS_PENDING, body={'app_name': 'x'})

        assert status == 409
        assert body['error'] == (f'{CREDENTIALS_NOT_READY}: an operator must create {_ws_secret(WS_PENDING)} and mark the '
                                 'workspace ready (see the recovery steps in docs/multi-workspace.md, Credentials).')
        assert world.secret(SHARED_SECRET) == {}

    def test_an_app_connector_lives_in_the_workspaces_secret(self, world, lambda_context):
        status, body = _integrations(lambda_context, 'POST', '/integrations/app_reviews_ios/apps', claims=ADMIN_A,
                                     ws=WS_A, body={'app': {'id': 'a1', 'app_name': 'Example', 'app_id': '123'}})
        assert status == 200, body

        _, listed = _integrations(lambda_context, 'GET', '/integrations/app_reviews_ios/apps', claims=VIEWER_A, ws=WS_A)
        _, deployment = _integrations(lambda_context, 'GET', '/integrations/app_reviews_ios/apps',
                                      claims=DEPLOYMENT_ADMIN, ws=None)
        assert [app['id'] for app in listed['apps']] == ['a1']
        assert deployment['apps'] == []
        assert world.secret(SHARED_SECRET) == {}

        status, _ = _integrations(lambda_context, 'DELETE', '/integrations/app_reviews_ios/apps/a1', claims=ADMIN_A,
                                  ws=WS_A)
        assert status == 200
        assert json.loads(world.secret(_ws_secret(WS_A))['app_reviews_ios_configs']) == []

    def test_an_editor_cannot_save_an_app_connector(self, world, lambda_context):
        status, _ = _integrations(lambda_context, 'POST', '/integrations/app_reviews_ios/apps', claims=EDITOR_A,
                                  ws=WS_A, body={'app': {'id': 'a1', 'app_name': 'Example'}})

        assert status == 403
        assert world.secret(_ws_secret(WS_A)) == {}


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
        # The key the webscraper's run in WS_A reads (`webscraper_` namespace, plugins/_shared/plugin_secrets.py).
        assert [c['id'] for c in json.loads(world.secret(_ws_secret(WS_A))['webscraper_configs'])] == ['site-1']

        status, _ = _scrapers(lambda_context, 'DELETE', '/scrapers/site-1', claims=ADMIN_A, ws=WS_A)
        assert status == 200
        assert json.loads(world.secret(_ws_secret(WS_A))['webscraper_configs']) == []

    @pytest.mark.parametrize(('claims', 'expected'), [(EDITOR_A, 403), (ADMIN_B, 404)])
    def test_only_the_workspaces_admins_save(self, world, lambda_context, claims, expected):
        status, _ = _scrapers(lambda_context, 'POST', '/scrapers', claims=claims, ws=WS_A,
                              body={'scraper': dict(SCRAPER)})

        assert status == expected
        assert world.secret(_ws_secret(WS_A)) == {}

    def test_the_connectors_listing_reads_the_workspaces_secret(self, world, lambda_context):
        world.secrets.put_secret_value(SecretId=_ws_secret(WS_A), SecretString=json.dumps({
            'app_reviews_ios_configs': json.dumps([{'id': 'a1', 'app_name': 'Workspace App'}])}))

        _, body = _scrapers(lambda_context, 'GET', '/scrapers/connectors', claims=VIEWER_A, ws=WS_A)
        _, deployment = _scrapers(lambda_context, 'GET', '/scrapers/connectors', claims=DEPLOYMENT_ADMIN, ws=None)

        assert [c['app_name'] for c in body['connectors']] == ['Workspace App']
        assert deployment['connectors'] == []


#: Every route of the two modules that reads or writes the workspace's secret: (module, method, path, params, body).
SECRET_ROUTES: Final = (
    (scrapers_handler, 'GET', '/scrapers', None, None),
    (scrapers_handler, 'GET', '/scrapers/connectors', None, None),
    (scrapers_handler, 'POST', '/scrapers', None, {'scraper': dict(SCRAPER)}),
    (scrapers_handler, 'DELETE', '/scrapers/site-1', {'scraper_id': 'site-1'}, None),
    (integrations_handler, 'GET', '/integrations/status', None, None),
    (integrations_handler, 'GET', '/integrations/app_reviews_ios/credentials', {'source': 'app_reviews_ios'}, None),
    (integrations_handler, 'PUT', '/integrations/app_reviews_ios/credentials', {'source': 'app_reviews_ios'},
     {'app_name': 'x'}),
    (integrations_handler, 'GET', '/integrations/app_reviews_ios/apps', {'source': 'app_reviews_ios'}, None),
    (integrations_handler, 'POST', '/integrations/app_reviews_ios/apps', {'source': 'app_reviews_ios'},
     {'app': {'id': 'a1', 'app_name': 'Example'}}),
    (integrations_handler, 'DELETE', '/integrations/app_reviews_ios/apps/d1',
     {'source': 'app_reviews_ios', 'app_id': 'd1'}, None),
    # A run reads the workspace's secret: refused before its row is written or its ingestor invoked.
    (integrations_handler, 'POST', '/sources/webscraper/run', {'source': 'webscraper'}, None),
    (scrapers_handler, 'POST', '/scrapers/site-1/run', {'scraper_id': 'site-1'}, None),
)


def _shared_secret_with_values(world: World) -> None:
    world.secrets.put_secret_value(SecretId=SHARED_SECRET, SecretString=json.dumps({
        'webscraper_configs': json.dumps([dict(SCRAPER)]), 'app_reviews_ios_app_name': 'Deployment App',
        'app_reviews_ios_configs': json.dumps([{'id': 'd1', 'app_name': 'Deployment App'}])}))


class TestAWorkspaceWhoseSecretIsPending:
    """Every route in a workspace whose META's secret_status is not `ready`, or whose secret is missing, answers
    409, a read too: never an empty list, never the shared secret's values, and nothing written."""

    @pytest.mark.parametrize(('module', 'method', 'path', 'params', 'body'), SECRET_ROUTES,
                             ids=[f'{method} {path}' for _m, method, path, _p, _b in SECRET_ROUTES])
    def test_every_route_is_told_so(self, world, lambda_context, module, method, path, params, body):
        _shared_secret_with_values(world)

        status, answer = _call(module, lambda_context, method, path, claims=ADMIN_PENDING, ws=WS_PENDING,
                               path_params=params, body=body, query={'keys': 'app_name'})

        assert status == 409
        assert answer['error'].startswith(CREDENTIALS_NOT_READY)
        assert sorted(s['Name'] for s in world.secrets.list_secrets()['SecretList']) == sorted(
            [SHARED_SECRET, _ws_secret(WS_A), _ws_secret(WS_B)])
        assert world.partitions() == set()
        world.ingestor.invoke.assert_not_called()
        world.webscraper.invoke.assert_not_called()

    def test_meta_pending_wins_over_a_secret_at_the_name(self, world, lambda_context):
        """A secret already at `voc/ws/{ws}/credentials` is not used while META says pending (it may not be this
        workspace's: the create flow decides that and marks ready)."""
        world.secrets.create_secret(Name=_ws_secret(WS_PENDING), SecretString=json.dumps({
            'webscraper_configs': json.dumps([dict(SCRAPER)])}))

        status, answer = _scrapers(lambda_context, 'GET', '/scrapers', claims=ADMIN_PENDING, ws=WS_PENDING)
        put_status, _ = _scrapers(lambda_context, 'POST', '/scrapers', claims=ADMIN_PENDING, ws=WS_PENDING,
                                  body={'scraper': {**SCRAPER, 'id': 'site-2'}})

        assert (status, put_status) == (409, 409)
        assert answer['error'].startswith(CREDENTIALS_NOT_READY)
        assert [c['id'] for c in json.loads(world.secret(_ws_secret(WS_PENDING))['webscraper_configs'])] == [
            'site-1']

    def test_a_ready_workspace_whose_secret_is_missing_is_told_so_too(self, world, lambda_context):
        world.secrets.delete_secret(SecretId=_ws_secret(WS_A), ForceDeleteWithoutRecovery=True)
        _shared_secret_with_values(world)

        status, answer = _scrapers(lambda_context, 'GET', '/scrapers', claims=ADMIN_A, ws=WS_A)

        assert status == 409
        assert answer['error'] == (f'{CREDENTIALS_MISSING}: {_ws_secret(WS_A)} does not exist (see the recovery steps in '
                                   'docs/multi-workspace.md, Credentials).')


class TestNoRadarBrandInAWorkspace:
    """Radar is not keyed by workspace (phase 3): the processor refuses a workspace's message stamped with a Radar
    brand, so every save that would stamp one is refused (400), and the credentials route takes no `configs` list in
    a workspace. Without the header the brand is saved as before. (A deployment source profile's Radar brand claims
    no workspace message: lambda/processor/test/test_workspace_path.py.)"""

    def test_a_scraper_naming_a_radar_brand_is_refused(self, world, lambda_context):
        status, body = _scrapers(lambda_context, 'POST', '/scrapers', claims=ADMIN_A, ws=WS_A,
                                 body={'scraper': {**SCRAPER, 'radar_brand': 'rival'}})

        assert (status, body['error']) == (400, RADAR_NOT_IN_WORKSPACES)
        assert world.secret(_ws_secret(WS_A)) == {}

    def test_without_the_header_the_brand_is_saved(self, world, lambda_context):
        status, body = _scrapers(lambda_context, 'POST', '/scrapers', claims=DEPLOYMENT_ADMIN, ws=None,
                                 body={'scraper': {**SCRAPER, 'radar_brand': 'rival'}})

        assert status == 200, body
        assert json.loads(world.secret(SHARED_SECRET)['webscraper_configs'])[0]['radar_brand'] == 'rival'

    def test_a_workspace_scraper_without_a_brand_is_saved(self, world, lambda_context):
        status, _ = _scrapers(lambda_context, 'POST', '/scrapers', claims=ADMIN_A, ws=WS_A,
                              body={'scraper': {**SCRAPER, 'radar_brand': ' '}})

        assert status == 200
        assert 'radar_brand' not in json.loads(world.secret(_ws_secret(WS_A))['webscraper_configs'])[0]

    def test_an_app_connector_naming_a_radar_brand_is_refused(self, world, lambda_context):
        status, body = _integrations(lambda_context, 'POST', '/integrations/app_reviews_ios/apps', claims=ADMIN_A,
                                     ws=WS_A, body={'app': {'id': 'a1', 'app_name': 'Example', 'radar_brand': 'rival'}})

        assert (status, body['error']) == (400, RADAR_NOT_IN_WORKSPACES)
        assert world.secret(_ws_secret(WS_A)) == {}

    def test_a_review_page_naming_a_radar_brand_is_refused(self, world, lambda_context):
        target = {'id': 'p1', 'app_name': 'Example page', 'url': 'https://www.example.com/reviews',
                  'radar_brand': 'rival'}
        with patch('shared.web_review_targets.checked_url', side_effect=lambda url: url):
            status, body = _integrations(lambda_context, 'POST', '/integrations/web_reviews/apps', claims=ADMIN_A,
                                         ws=WS_A, body={'app': target})

        assert (status, body['error']) == (400, RADAR_NOT_IN_WORKSPACES)
        assert world.secret(_ws_secret(WS_A)) == {}

    @pytest.mark.parametrize('source', ['webscraper', 'app_reviews_ios', 'web_reviews'])
    @pytest.mark.parametrize('configs', [json.dumps([{**SCRAPER, 'radar_brand': 'rival'}]), '[]', None])
    def test_a_configs_list_on_the_credentials_route_is_refused_whatever_it_holds(
            self, world, lambda_context, source, configs):
        """The lists are saved through POST /scrapers and POST /integrations/{source}/apps, which check every
        entry (a Radar brand among them): the credentials route takes no `configs` key in a workspace."""
        status, body = _integrations(lambda_context, 'PUT', f'/integrations/{source}/credentials', claims=ADMIN_A,
                                     ws=WS_A, body={'configs': configs, 'app_name': 'x'})

        assert (status, body['error']) == (400, integrations_handler.CONFIGS_HAVE_THEIR_OWN_ROUTES)
        assert world.secret(_ws_secret(WS_A)) == {}

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


#: Where the two handlers get the secret a route reads and writes: the request's resolved membership only.
SECRET_SOURCES = frozenset({'secret_id', 'secret_id_or_none'})


def _calls(node: ast.AST) -> list[ast.Call]:
    return [n for n in ast.walk(node) if isinstance(n, ast.Call)]


def _name(call: ast.Call) -> str | None:
    func = call.func
    return func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None


@pytest.mark.parametrize('module', [integrations_handler, scrapers_handler])
def test_no_handler_builds_the_secret_name_from_request_input(module):
    """Every secret a route reads or writes is `secret_id`, assigned only from the module's request secret (the shared
    ARN, or shared/workspace_plugin_store.py `credentials_secret_id` of the resolved membership); no handler names a
    secret itself (no `SecretId=`, no `credentials_secret_name`, no `WORKSPACE_SECRET_PREFIX`)."""
    source = Path(module.__file__).read_text(encoding='utf-8')
    tree = ast.parse(source)
    assert 'credentials_secret_name' not in source
    assert 'WORKSPACE_SECRET_PREFIX' not in source
    assert not any(keyword.arg == 'SecretId' for call in _calls(tree) for keyword in call.keywords)
    puts = [call for call in _calls(tree) if _name(call) == 'put_secret_json']
    assert puts
    assert all(isinstance(call.args[1], ast.Name) and call.args[1].id == 'secret_id' for call in puts)
    assigned = [node.value for node in ast.walk(tree) if isinstance(node, ast.Assign)
                for target in node.targets if isinstance(target, ast.Name) and target.id == 'secret_id']
    assert assigned
    assert all(isinstance(value, ast.Call) and _name(value) in SECRET_SOURCES for value in assigned)


def test_the_workspace_secret_name_is_built_from_the_resolved_workspace_only():
    """shared/workspace_plugin_store.py: the name is `credentials_secret_name(prefix, context.ws)`, after an
    `isinstance(context, WorkspaceContext)` check."""
    from shared import workspace_plugin_store
    tree = ast.parse(Path(workspace_plugin_store.__file__).read_text(encoding='utf-8'))
    function = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'credentials_secret_id')
    [build] = [call for call in _calls(function) if _name(call) == 'credentials_secret_name']
    ws = build.args[1]
    assert isinstance(ws, ast.Attribute)
    assert ws.attr == 'ws'
    assert isinstance(ws.value, ast.Name)
    assert ws.value.id == 'context'
    assert any(_name(call) == 'isinstance' for call in _calls(function))


# ── The S3 import API: deployment-wide only ─────────────────────────────────────────────────────────────────────

class TestTheS3ImportApiRefusesAWorkspace:
    @pytest.mark.parametrize(('method', 'path', 'claims'), [
        ('POST', '/s3-import/reprocess', ADMIN_A), ('POST', '/s3-import/reprocess', DEPLOYMENT_ADMIN),
        ('GET', '/s3-import/files', VIEWER_A), ('GET', '/s3-import/reprocess/run_s3_import_20261101000000_0a0b0c0d',
                                                ADMIN_B)])
    @pytest.mark.parametrize('ws', [WS_A, ''])
    def test_one_answer_for_everyone_before_anything_is_read(self, lambda_context, method, path, claims, ws):
        with patch.object(s3_import_handler, 's3_client') as s3, \
                patch.object(s3_import_handler, 'get_aggregates_table') as table:
            status, body = _call(s3_import_handler, lambda_context, method, path, claims=claims, ws=ws,
                                 body={'key': 'default/reviews.csv'})

        assert (status, body['error']) == (400, DEPLOYMENT_ONLY)
        assert s3.mock_calls == []
        assert table.mock_calls == []
