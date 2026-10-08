"""
Tests for app config CRUD endpoints in integrations_handler.py.
Tests /integrations/{source}/apps GET, POST, DELETE for multi-instance plugins.
"""
import json
from unittest.mock import MagicMock, patch

from handler_events_fixtures import call_route
from integrations_fixtures import ingestor_behind

from integrations_handler import lambda_handler


def _stored_configs(mock_secrets: MagicMock, configs_by_source: dict[str, list] | None = None) -> None:
    """Make the shared secret hold `configs_by_source` as `<source>_configs` JSON strings."""
    secret = {f'{source}_configs': json.dumps(configs) for source, configs in (configs_by_source or {}).items()}
    mock_secrets.get_secret_value.return_value = {'SecretString': json.dumps(secret)}


def _saved_configs(mock_secrets: MagicMock, source: str) -> list:
    """The `<source>_configs` array the route last wrote back to the secret."""
    put_call = mock_secrets.put_secret_value.call_args
    saved_secrets = json.loads(put_call.kwargs['SecretString'])
    return json.loads(saved_secrets[f'{source}_configs'])


def _apps_route(api_gateway_event, lambda_context, method: str, source: str, *,
                app_id: str | None = None, body: dict | None = None):
    """Call `/integrations/<source>/apps[/<app_id>]`; `(response, body)`."""
    path_params = {'source': source}
    path = f'/integrations/{source}/apps'
    if app_id is not None:
        path_params['app_id'] = app_id
        path = f'{path}/{app_id}'
    kwargs = {'body': body} if body is not None else {}
    return call_route(
        lambda_handler, api_gateway_event, lambda_context,
        method=method, path=path, path_params=path_params, **kwargs,
    )


class TestListAppConfigs:
    """Tests for GET /integrations/{source}/apps endpoint."""

    @patch('integrations_handler.secretsmanager')
    def test_returns_empty_list_when_no_configs_exist(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        _stored_configs(mock_secrets)
        response, body = _apps_route(api_gateway_event, lambda_context, 'GET', 'app_reviews_android')

        assert response['statusCode'] == 200
        assert body['apps'] == []

    @patch('integrations_handler.secretsmanager')
    def test_returns_saved_app_configs(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        _stored_configs(mock_secrets, {'app_reviews_android': [
            {'id': 'a1', 'app_name': 'Zara', 'package_name': 'com.inditex.zara'},
            {'id': 'a2', 'app_name': 'H&M', 'package_name': 'com.hm.app'},
        ]})
        response, body = _apps_route(api_gateway_event, lambda_context, 'GET', 'app_reviews_android')

        assert response['statusCode'] == 200
        assert len(body['apps']) == 2
        assert body['apps'][0]['app_name'] == 'Zara'
        assert body['apps'][1]['app_name'] == 'H&M'



class TestSaveAppConfig:
    """Tests for POST /integrations/{source}/apps endpoint."""

    @patch('integrations_handler.secretsmanager')
    def test_creates_new_app_config(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        _stored_configs(mock_secrets)
        response, body = _apps_route(
            api_gateway_event, lambda_context, 'POST', 'app_reviews_ios',
            body={'app': {'app_name': 'Spotify', 'app_id': '324684580'}},
        )

        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['app']['app_name'] == 'Spotify'
        assert body['app']['app_id'] == '324684580'
        assert 'id' in body['app']  # auto-generated

        # Verify secrets manager was updated
        saved_configs = _saved_configs(mock_secrets, 'app_reviews_ios')
        assert len(saved_configs) == 1
        assert saved_configs[0]['app_name'] == 'Spotify'

    @patch('integrations_handler.secretsmanager')
    def test_updates_existing_app_config(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        _stored_configs(mock_secrets, {'app_reviews_ios': [{'id': 'x1', 'app_name': 'OldName', 'app_id': '123'}]})
        response, body = _apps_route(
            api_gateway_event, lambda_context, 'POST', 'app_reviews_ios',
            body={'app': {'id': 'x1', 'app_name': 'NewName', 'app_id': '123'}},
        )

        assert response['statusCode'] == 200
        assert body['app']['app_name'] == 'NewName'

        saved_configs = _saved_configs(mock_secrets, 'app_reviews_ios')
        assert len(saved_configs) == 1
        assert saved_configs[0]['app_name'] == 'NewName'




class TestDeleteAppConfig:
    """Tests for DELETE /integrations/{source}/apps/{appId} endpoint."""

    @patch('integrations_handler.secretsmanager')
    def test_deletes_app_config_by_id(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        _stored_configs(mock_secrets, {'app_reviews_android': [
            {'id': 'a1', 'app_name': 'Keep', 'package_name': 'com.keep'},
            {'id': 'a2', 'app_name': 'Remove', 'package_name': 'com.remove'},
        ]})
        response, body = _apps_route(api_gateway_event, lambda_context, 'DELETE', 'app_reviews_android', app_id='a2')

        assert response['statusCode'] == 200
        assert body['success'] is True

        saved_configs = _saved_configs(mock_secrets, 'app_reviews_android')
        assert len(saved_configs) == 1
        assert saved_configs[0]['id'] == 'a1'

    @patch('integrations_handler.secretsmanager')
    def test_succeeds_when_app_id_not_found(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        _stored_configs(mock_secrets, {'app_reviews_android': [{'id': 'a1', 'app_name': 'Keep'}]})
        response, _ = _apps_route(
            api_gateway_event, lambda_context, 'DELETE', 'app_reviews_android', app_id='nonexistent',
        )

        assert response['statusCode'] == 200


class TestRunSourceWithAppId:
    """Tests for POST /sources/{source}/run with optional app_id."""

    @staticmethod
    def _run_payload(mock_boto3, api_gateway_event, lambda_context, **event_kwargs) -> dict:
        """POST /sources/app_reviews_android/run; assert it succeeded and return the invoke payload."""
        mock_lambda = ingestor_behind(mock_boto3)
        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='POST',
            path='/sources/app_reviews_android/run',
            path_params={'source': 'app_reviews_android'},
            **event_kwargs,
        )
        assert response['statusCode'] == 200
        assert body['success'] is True
        return json.loads(mock_lambda.invoke.call_args.kwargs['Payload'])

    @patch('integrations_handler.boto3')
    def test_passes_app_id_to_lambda_payload(
        self, mock_boto3, api_gateway_event, lambda_context
    ):
        payload = self._run_payload(mock_boto3, api_gateway_event, lambda_context, body={'app_id': 'com.inditex.zara'})

        assert payload['app_id'] == 'com.inditex.zara'
        assert payload['manual_trigger'] is True

    @patch('integrations_handler.boto3')
    def test_runs_without_app_id_for_all_apps(
        self, mock_boto3, api_gateway_event, lambda_context
    ):
        payload = self._run_payload(mock_boto3, api_gateway_event, lambda_context)

        assert 'app_id' not in payload
        assert payload['manual_trigger'] is True
