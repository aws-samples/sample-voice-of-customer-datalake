"""The shared pieces of the operator routes' two paths (docs/multi-workspace.md): shared/workspace_request.py
(``ResolvedRoutes``: its middleware, admin gate, context, secret and Radar refusal; ``workspace_payload``,
``deployment_only``), shared/workspace_plugin_store.py (the secret a request reads and writes), shared/run_rows.py
(the run partitions) and shared/plugin_circuit.py (the breaker's TRIPPED row per path).
"""
from __future__ import annotations

import re
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared import plugin_circuit, workspace_plugin_settings
from shared.exceptions import AuthorizationError, ConfigurationError, ConflictError, ValidationError
from shared.run_rows import latest_run, scraper_run_partition, source_run_partition
from shared.workspace import WorkspaceContext
from shared.workspace_plugin_settings import INGESTION_NOT_YET
from shared.workspace_plugin_store import (
    CREDENTIALS_MISSING,
    CREDENTIALS_NOT_READY,
    credentials_secret_id,
    read_secret_json,
)
from shared.workspace_request import (
    DEPLOYMENT_ONLY,
    RADAR_NOT_IN_WORKSPACES,
    WORKSPACE_CONTEXT_KEY,
    ResolvedRoutes,
    WorkspaceNotResolved,
    deployment_only,
)
from shared.workspace_routing import workspace_payload
from shared.ws_repo import OutOfScopeError, scope_from_key

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
SCOPE = scope_from_key(f'WS#{WS}#SOURCE#web')


def _context(role: str = 'admin', ws: str = WS, status: str = 'ready') -> WorkspaceContext:
    """A resolved membership; ``status`` is its workspace META's ``secret_status``."""
    return WorkspaceContext(ws=ws, role=role, name='Team', slug='team', platform_admin=False, secret_status=status)


def _event(groups: str = 'users', header: str | None = None) -> dict:
    headers = {} if header is None else {'X-Workspace-Id': header}
    return {'headers': headers, 'requestContext': {'authorizer': {'claims': {'sub': 's', 'cognito:groups': groups}}}}


def _app(raw_event: dict, method: str, path: str) -> SimpleNamespace:
    """A resolver as a middleware sees it: the request's raw event, method and path."""
    return SimpleNamespace(current_event=SimpleNamespace(raw_event=raw_event, http_method=method, path=path))


class _Resolver:
    def __init__(self, method: str, groups: str = 'users') -> None:
        self.current_event = SimpleNamespace(raw_event=_event(groups, header=WS), http_method=method)
        self.context: dict = {}

    def append_context(self, **values) -> None:
        self.context.update(values)


def _routes(context: WorkspaceContext | None, groups: str = 'users') -> ResolvedRoutes:
    """The routes' view of a request the middleware already resolved to ``context``."""
    resolver = _Resolver('GET', groups)
    resolver.context[WORKSPACE_CONTEXT_KEY] = context
    return ResolvedRoutes(resolver, MagicMock())


class TestTheTwoPathAdminGate:
    def test_deployment_wide_the_admins_group_decides(self):
        _routes(None, 'admins').require_request_admin()
        with pytest.raises(AuthorizationError):
            _routes(None, 'users').require_request_admin()

    @pytest.mark.parametrize('role', ['editor', 'viewer'])
    def test_in_a_workspace_only_its_admin_role_does_and_admins_grants_nothing(self, role):
        _routes(_context('admin'), 'users').require_request_admin()
        with pytest.raises(AuthorizationError):
            _routes(_context(role), 'admins').require_request_admin()


class TestTheInvokePayload:
    @pytest.mark.usefixtures('ingestion_on')
    def test_in_a_workspace_the_resolved_one_is_set_after_every_field(self):
        payload = workspace_payload({'execution_id': 'e', 'workspace_id': OTHER}, _context())

        assert payload == {'execution_id': 'e', 'workspace_id': WS}
        assert list(payload)[-1] == 'workspace_id'

    def test_deployment_wide_it_names_no_workspace(self):
        assert workspace_payload({'execution_id': 'e', 'workspace_id': OTHER}, None) == {'execution_id': 'e'}

    def test_a_stand_in_for_a_resolved_membership_is_refused(self):
        with pytest.raises(TypeError):
            workspace_payload({}, SimpleNamespace(ws=OTHER))  # type: ignore[arg-type]


class TestDeploymentOnly:
    @pytest.mark.parametrize('header', [WS, '', 'not-a-workspace'])
    def test_any_header_is_refused_before_the_route(self, header):
        app, route = _app(_event(header=header), 'GET', '/s3-import/files'), MagicMock()

        with pytest.raises(ValidationError, match=DEPLOYMENT_ONLY):
            deployment_only(app, route)
        route.assert_not_called()

    @pytest.mark.parametrize('header', [WS, ''])
    def test_a_reprocess_that_names_a_workspace_gets_the_ingestion_hold(self, header):
        app, route = _app(_event(header=header), 'POST', '/s3-import/reprocess'), MagicMock()

        with pytest.raises(ConflictError, match=re.escape(INGESTION_NOT_YET)):
            deployment_only(app, route)
        route.assert_not_called()

    def test_once_the_hold_lifts_a_reprocess_gets_the_one_400(self, monkeypatch):
        monkeypatch.setattr(workspace_plugin_settings, 'PER_WORKSPACE_INGESTION', True)


        app, route = _app(_event(header=WS), 'POST', '/s3-import/reprocess'), MagicMock()

        with pytest.raises(ValidationError, match=DEPLOYMENT_ONLY):
            deployment_only(app, route)

    def test_without_it_the_route_runs(self):
        app, route = _app(_event(), 'POST', '/s3-import/reprocess'), MagicMock(return_value='ok')

        assert deployment_only(app, route) == 'ok'


class TestTheMiddleware:
    @pytest.mark.parametrize(('method', 'fresh'), [('GET', False), ('POST', True), ('PUT', True), ('DELETE', True)])
    def test_a_write_resolves_from_the_table_a_read_may_use_the_cache(self, method, fresh):
        resolver, workspace = _Resolver(method), MagicMock()
        workspace.context.return_value = _context()
        routes = ResolvedRoutes(resolver, workspace)

        assert routes.middleware(resolver, lambda _r: routes.context()) == _context()

        workspace.context.assert_called_once_with(resolver.current_event.raw_event, fresh=fresh)
        assert resolver.context[WORKSPACE_CONTEXT_KEY] == _context()

    def test_reading_it_outside_the_middleware_fails_closed(self):
        with pytest.raises(WorkspaceNotResolved):
            ResolvedRoutes(_Resolver('GET'), MagicMock()).context()


class TestResolvedRoutes:
    def test_the_middleware_resolves_with_the_modules_workspace_then_hands_on(self):
        resolver, workspace = _Resolver('POST'), MagicMock()
        workspace.context.return_value = _context('viewer')
        routes = ResolvedRoutes(resolver, workspace)

        assert routes.middleware(resolver, lambda _r: 'route ran') == 'route ran'
        scope = routes.scope()
        assert routes.context() == _context('viewer')
        assert scope is not None
        assert scope.ws == WS
        with pytest.raises(AuthorizationError):  # a viewer: the workspace's admin role decides
            routes.require_request_admin()

    def test_no_configured_secret_is_none_for_a_read(self, monkeypatch):
        monkeypatch.delenv('WORKSPACE_SECRET_PREFIX', raising=False)

        assert _routes(_context()).secret_id_or_none('arn:shared') is None
        assert _routes(None).secret_id_or_none('') is None
        assert _routes(None).secret_id_or_none('arn:shared') == 'arn:shared'

    def test_a_pending_workspace_is_not_none_but_a_409_for_a_read_too(self, monkeypatch):
        monkeypatch.setenv('WORKSPACE_SECRET_PREFIX', 'voc/ws')

        with pytest.raises(ConflictError, match=re.escape(CREDENTIALS_NOT_READY)):
            _routes(_context(status='pending')).secret_id_or_none('arn:shared')


class TestNoRadarBrandInAWorkspace:
    @pytest.mark.parametrize('brand', ['rival', 'x'])
    def test_a_brand_in_a_workspace_is_refused(self, brand):
        with pytest.raises(ValidationError, match=re.escape(RADAR_NOT_IN_WORKSPACES)):
            _routes(_context()).refuse_radar_brand(brand)

    @pytest.mark.parametrize(('context', 'brand'), [(None, 'rival'), (_context(), ''), (_context(), None)])
    def test_none_or_deployment_wide_is_fine(self, context, brand):
        assert _routes(context).refuse_radar_brand(brand) is None  # returns: no 400 raised


class TestTheCredentialsSecret:
    def test_deployment_wide_the_shared_one(self):
        assert credentials_secret_id(None, 'arn:shared') == 'arn:shared'
        with pytest.raises(ConfigurationError):
            credentials_secret_id(None, '')

    def test_in_a_workspace_its_own_from_the_resolved_id(self, monkeypatch):
        monkeypatch.setenv('WORKSPACE_SECRET_PREFIX', 'stg-voc/ws')

        assert credentials_secret_id(_context(), 'arn:shared') == f'stg-voc/ws/{WS}/credentials'
        with pytest.raises(TypeError):
            credentials_secret_id(SimpleNamespace(ws=OTHER), 'arn:shared')  # type: ignore[arg-type]

    @pytest.mark.parametrize('status', ['pending', ''])
    def test_a_workspace_whose_meta_is_not_ready_is_refused_whatever_exists(self, monkeypatch, status):
        monkeypatch.setenv('WORKSPACE_SECRET_PREFIX', 'voc/ws')

        with pytest.raises(ConflictError) as refused:
            credentials_secret_id(_context(status=status), 'arn:shared')
        assert str(refused.value) == (f'{CREDENTIALS_NOT_READY}: an operator must create voc/ws/{WS}/credentials and mark '
                                      'the workspace ready (see the recovery steps in docs/multi-workspace.md, '
                                      'Credentials).')

    def test_a_workspace_without_the_prefix_is_not_served_the_shared_secret(self, monkeypatch):
        monkeypatch.delenv('WORKSPACE_SECRET_PREFIX', raising=False)

        with pytest.raises(ConfigurationError):
            credentials_secret_id(_context(), 'arn:shared')

    def test_a_missing_workspace_secret_is_missing(self):
        client = MagicMock()
        client.get_secret_value.side_effect = ClientError(
            {'Error': {'Code': 'ResourceNotFoundException', 'Message': 'x'}}, 'GetSecretValue')

        with pytest.raises(ConflictError, match=re.escape(f'{CREDENTIALS_MISSING}: voc/ws/x/credentials does not exist')):
            read_secret_json(client, 'voc/ws/x/credentials', _context())
        with pytest.raises(ClientError):  # the shared secret missing is the deployment's fault, raised as it was
            read_secret_json(client, 'arn:shared', None)

    def test_another_fault_raises_as_boto3_raised_it(self):
        client = MagicMock()
        client.get_secret_value.side_effect = ClientError({'Error': {'Code': 'AccessDeniedException'}}, 'Get')

        with pytest.raises(ClientError):
            read_secret_json(client, 'voc/ws/x/credentials', _context())

    def test_it_reads_the_json_object(self):
        client = MagicMock()
        client.get_secret_value.return_value = {'SecretString': '{"a_b": "c"}'}

        assert read_secret_json(client, 's', None) == {'a_b': 'c'}

    def test_a_secret_that_is_not_a_json_object_is_malformed(self):
        client = MagicMock()
        client.get_secret_value.return_value = {'SecretString': '["a"]'}

        with pytest.raises(ValueError, match='not a JSON object'):
            read_secret_json(client, 's', _context())


class TestRunRows:
    def test_the_partitions_on_each_path(self):
        assert source_run_partition(None, 'webscraper') == 'SOURCE_RUN#webscraper'
        assert source_run_partition(SCOPE, 'webscraper') == f'WS#{WS}#SOURCE_RUN#webscraper'
        assert scraper_run_partition(None, 'site') == 'SCRAPER_RUN#site'
        assert scraper_run_partition(SCOPE, 'site') == f'WS#{WS}#SCRAPER_RUN#site'

    def test_deployment_wide_the_query_it_always_sent(self):
        table = MagicMock()
        table.query.return_value = {'Items': [{'sk': 'r1'}]}

        assert latest_run(table, 'SOURCE_RUN#webscraper') == {'sk': 'r1'}
        table.query.assert_called_once_with(KeyConditionExpression=Key('pk').eq('SOURCE_RUN#webscraper'),
                                            ScanIndexForward=False, Limit=1)

    def test_in_a_workspace_another_partition_is_refused_before_dynamodb(self):
        table = MagicMock()

        with pytest.raises(OutOfScopeError):
            latest_run(table, 'SOURCE_RUN#webscraper', SCOPE)
        assert table.mock_calls == []


class TestTheBreakerPerPath:
    def test_the_key_on_each_path(self):
        assert plugin_circuit.circuit_key(None, 'webscraper') == {'pk': 'CIRCUIT#webscraper', 'sk': 'TRIPPED'}
        assert plugin_circuit.circuit_key(SCOPE, 'webscraper') == {'pk': f'WS#{WS}#CIRCUIT#webscraper',
                                                                   'sk': 'TRIPPED'}

    def test_a_workspace_clear_deletes_its_own_row(self):
        table = MagicMock()
        with patch.object(plugin_circuit, 'get_aggregates_table', return_value=table):
            plugin_circuit.clear_circuit('webscraper', SCOPE)

        table.delete_item.assert_called_once_with(Key={'pk': f'WS#{WS}#CIRCUIT#webscraper', 'sk': 'TRIPPED'})

    def test_a_workspace_read_asks_for_its_own_rows_only(self):
        table = MagicMock()
        with patch.object(plugin_circuit, 'get_aggregates_table', return_value=table), \
                patch.object(plugin_circuit, 'batch_get_all', return_value=[
                    {'pk': f'WS#{WS}#CIRCUIT#webscraper', 'sk': 'TRIPPED', 'last_error': 'e'}]) as batch:
            states = plugin_circuit.read_circuits(['webscraper', 'github_issues'], include_error=True, scope=SCOPE)

        assert batch.call_args.args[1] == [{'pk': f'WS#{WS}#CIRCUIT#{s}', 'sk': 'TRIPPED'}
                                           for s in ('webscraper', 'github_issues')]
        assert (states['webscraper']['tripped'], states['webscraper']['last_error']) == (True, 'e')
        assert states['github_issues']['tripped'] is False
