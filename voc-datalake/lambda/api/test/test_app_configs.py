"""
Tests for app config CRUD endpoints in integrations_handler.py.
Tests /integrations/{source}/apps GET, POST, DELETE for multi-instance plugins.
"""
import json
from unittest.mock import patch, MagicMock


class TestListAppConfigs:
    """Tests for GET /integrations/{source}/apps endpoint."""

    @patch('integrations_handler.secretsmanager')
    def test_returns_empty_list_when_no_configs_exist(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/integrations/app_reviews_android/apps',
            path_params={'source': 'app_reviews_android'},
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['apps'] == []

    @patch('integrations_handler.secretsmanager')
    def test_returns_saved_app_configs(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        configs = [
            {'id': 'a1', 'app_name': 'Zara', 'package_name': 'com.inditex.zara'},
            {'id': 'a2', 'app_name': 'H&M', 'package_name': 'com.hm.app'},
        ]
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                'app_reviews_android_configs': json.dumps(configs)
            })
        }
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/integrations/app_reviews_android/apps',
            path_params={'source': 'app_reviews_android'},
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert len(body['apps']) == 2
        assert body['apps'][0]['app_name'] == 'Zara'
        assert body['apps'][1]['app_name'] == 'H&M'

    @patch('integrations_handler.secretsmanager')
    def test_rejects_unsupported_source(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/integrations/webscraper/apps',
            path_params={'source': 'webscraper'},
        )

        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400



class TestSaveAppConfig:
    """Tests for POST /integrations/{source}/apps endpoint."""

    @patch('integrations_handler.secretsmanager')
    def test_creates_new_app_config(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/integrations/app_reviews_ios/apps',
            path_params={'source': 'app_reviews_ios'},
            body={'app': {'app_name': 'Spotify', 'app_id': '324684580'}},
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['app']['app_name'] == 'Spotify'
        assert body['app']['app_id'] == '324684580'
        assert 'id' in body['app']  # auto-generated

        # Verify secrets manager was updated
        put_call = mock_secrets.put_secret_value.call_args
        saved_secrets = json.loads(put_call.kwargs['SecretString'])
        saved_configs = json.loads(saved_secrets['app_reviews_ios_configs'])
        assert len(saved_configs) == 1
        assert saved_configs[0]['app_name'] == 'Spotify'

    @patch('integrations_handler.secretsmanager')
    def test_updates_existing_app_config(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        existing = [{'id': 'x1', 'app_name': 'OldName', 'app_id': '123'}]
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                'app_reviews_ios_configs': json.dumps(existing)
            })
        }
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/integrations/app_reviews_ios/apps',
            path_params={'source': 'app_reviews_ios'},
            body={'app': {'id': 'x1', 'app_name': 'NewName', 'app_id': '123'}},
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['app']['app_name'] == 'NewName'

        put_call = mock_secrets.put_secret_value.call_args
        saved_secrets = json.loads(put_call.kwargs['SecretString'])
        saved_configs = json.loads(saved_secrets['app_reviews_ios_configs'])
        assert len(saved_configs) == 1
        assert saved_configs[0]['app_name'] == 'NewName'

    @patch('integrations_handler.secretsmanager')
    def test_rejects_missing_app_name(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/integrations/app_reviews_android/apps',
            path_params={'source': 'app_reviews_android'},
            body={'app': {'package_name': 'com.test'}},
        )

        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400

    @patch('integrations_handler.secretsmanager')
    def test_rejects_missing_app_body(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/integrations/app_reviews_android/apps',
            path_params={'source': 'app_reviews_android'},
            body={},
        )

        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400


class TestDeleteAppConfig:
    """Tests for DELETE /integrations/{source}/apps/{appId} endpoint."""

    @patch('integrations_handler.secretsmanager')
    def test_deletes_app_config_by_id(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        configs = [
            {'id': 'a1', 'app_name': 'Keep', 'package_name': 'com.keep'},
            {'id': 'a2', 'app_name': 'Remove', 'package_name': 'com.remove'},
        ]
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                'app_reviews_android_configs': json.dumps(configs)
            })
        }
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE',
            path='/integrations/app_reviews_android/apps/a2',
            path_params={'source': 'app_reviews_android', 'app_id': 'a2'},
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True

        put_call = mock_secrets.put_secret_value.call_args
        saved_secrets = json.loads(put_call.kwargs['SecretString'])
        saved_configs = json.loads(saved_secrets['app_reviews_android_configs'])
        assert len(saved_configs) == 1
        assert saved_configs[0]['id'] == 'a1'

    @patch('integrations_handler.secretsmanager')
    def test_succeeds_when_app_id_not_found(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        configs = [{'id': 'a1', 'app_name': 'Keep'}]
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                'app_reviews_android_configs': json.dumps(configs)
            })
        }
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE',
            path='/integrations/app_reviews_android/apps/nonexistent',
            path_params={'source': 'app_reviews_android', 'app_id': 'nonexistent'},
        )

        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200


class TestRunSourceWithAppId:
    """Tests for POST /sources/{source}/run with optional app_id."""

    @patch('integrations_handler.boto3')
    def test_passes_app_id_to_lambda_payload(
        self, mock_boto3, api_gateway_event, lambda_context
    ):
        mock_lambda = MagicMock()
        mock_lambda.invoke.return_value = {'StatusCode': 202}
        mock_lambda.exceptions.ResourceNotFoundException = type('ResourceNotFoundException', (Exception,), {})
        mock_boto3.client.return_value = mock_lambda

        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/sources/app_reviews_android/run',
            path_params={'source': 'app_reviews_android'},
            body={'app_id': 'com.inditex.zara'},
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True

        invoke_call = mock_lambda.invoke.call_args
        payload = json.loads(invoke_call.kwargs['Payload'])
        assert payload['app_id'] == 'com.inditex.zara'
        assert payload['manual_trigger'] is True

    @patch('integrations_handler.boto3')
    def test_runs_without_app_id_for_all_apps(
        self, mock_boto3, api_gateway_event, lambda_context
    ):
        mock_lambda = MagicMock()
        mock_lambda.invoke.return_value = {'StatusCode': 202}
        mock_lambda.exceptions.ResourceNotFoundException = type('ResourceNotFoundException', (Exception,), {})
        mock_boto3.client.return_value = mock_lambda

        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/sources/app_reviews_android/run',
            path_params={'source': 'app_reviews_android'},
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True

        invoke_call = mock_lambda.invoke.call_args
        payload = json.loads(invoke_call.kwargs['Payload'])
        assert 'app_id' not in payload
        assert payload['manual_trigger'] is True
