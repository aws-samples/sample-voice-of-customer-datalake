"""
Tests for app config CRUD endpoints in integrations_handler.py.
Tests /integrations/{source}/apps GET, POST, DELETE for multi-instance plugins.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
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
            {'id': 'a1', 'app_name': 'Example Air', 'package_name': 'com.exampleair.app'},
            {'id': 'a2', 'app_name': 'Acme Shop', 'package_name': 'com.acme.shop'},
        ]})
        response, body = _apps_route(api_gateway_event, lambda_context, 'GET', 'app_reviews_android')

        assert response['statusCode'] == 200
        assert len(body['apps']) == 2
        assert body['apps'][0]['app_name'] == 'Example Air'
        assert body['apps'][1]['app_name'] == 'Acme Shop'



class TestSaveAppConfig:
    """Tests for POST /integrations/{source}/apps endpoint."""

    @patch('integrations_handler.secretsmanager')
    def test_creates_new_app_config(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        _stored_configs(mock_secrets)
        response, body = _apps_route(
            api_gateway_event, lambda_context, 'POST', 'app_reviews_ios',
            body={'app': {'app_name': 'Example Music', 'app_id': '987654321'}},
        )

        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['app']['app_name'] == 'Example Music'
        assert body['app']['app_id'] == '987654321'
        assert 'id' in body['app']  # auto-generated

        # Verify secrets manager was updated
        saved_configs = _saved_configs(mock_secrets, 'app_reviews_ios')
        assert len(saved_configs) == 1
        assert saved_configs[0]['app_name'] == 'Example Music'

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

    @pytest.mark.parametrize('value', ['web', ['x'], 42, True])
    @patch('integrations_handler.secretsmanager')
    def test_a_non_object_app_is_a_400(self, mock_secrets, value, api_gateway_event, lambda_context):
        _stored_configs(mock_secrets)
        response, _body = _apps_route(api_gateway_event, lambda_context, 'POST', 'web_reviews', body={'app': value})

        assert response['statusCode'] == 400
        mock_secrets.put_secret_value.assert_not_called()


WEB_TARGET = {'app_name': 'Trustpilot', 'url': 'https://www.trustpilot.com/review/example.com'}


@pytest.fixture
def _public_dns():
    with patch('shared.web_review_targets.validate_url', return_value=(True, '')):
        yield


class TestSaveWebReviewsTarget:
    """POST /integrations/web_reviews/apps: the target is validated in full before it is stored."""

    @patch('shared.web_review_targets.validate_url', return_value=(True, ''))
    @patch('integrations_handler.secretsmanager')
    def test_stores_the_cleaned_target(self, mock_secrets, mock_validate_url, api_gateway_event, lambda_context):
        _stored_configs(mock_secrets)
        response, body = _apps_route(
            api_gateway_event, lambda_context, 'POST', 'web_reviews',
            body={'app': {**WEB_TARGET, 'max_pages': '3', 'unexpected': 'dropped'}},
        )
        assert response['statusCode'] == 200
        saved = _saved_configs(mock_secrets, 'web_reviews')[0]
        assert {k: v for k, v in saved.items() if k != 'id'} == {
            **WEB_TARGET, 'max_pages': '3', 'max_reviews': '0', 'frequency_minutes': '0', 'enabled': 'true',
            'source_id': 'web_trustpilot_trustpilot'}
        assert saved['id'] == body['app']['id']
        assert body['app']['source_id'] == 'web_trustpilot_trustpilot'
        mock_validate_url.assert_called_once_with(WEB_TARGET['url'])

    @patch('integrations_handler.secretsmanager')
    def test_refuses_plain_http(self, mock_secrets, api_gateway_event, lambda_context):
        _stored_configs(mock_secrets)
        response, body = _apps_route(
            api_gateway_event, lambda_context, 'POST', 'web_reviews',
            body={'app': {**WEB_TARGET, 'url': 'http://www.trustpilot.com/review/example.com'}},
        )
        assert response['statusCode'] == 400
        assert 'https' in json.dumps(body)
        mock_secrets.put_secret_value.assert_not_called()

    @patch('integrations_handler.secretsmanager')
    def test_refuses_an_internal_address(self, mock_secrets, api_gateway_event, lambda_context):
        _stored_configs(mock_secrets)
        response, _ = _apps_route(
            api_gateway_event, lambda_context, 'POST', 'web_reviews',
            body={'app': {**WEB_TARGET, 'url': 'https://169.254.169.254/latest/meta-data'}},
        )
        assert response['statusCode'] == 400
        mock_secrets.put_secret_value.assert_not_called()

    @pytest.mark.usefixtures('_public_dns')
    @patch('integrations_handler.secretsmanager')
    def test_refuses_too_many_pages(self, mock_secrets, api_gateway_event, lambda_context):
        _stored_configs(mock_secrets)
        response, _ = _apps_route(
            api_gateway_event, lambda_context, 'POST', 'web_reviews', body={'app': {**WEB_TARGET, 'max_pages': '101'}},
        )
        assert response['statusCode'] == 400
        mock_secrets.put_secret_value.assert_not_called()

    @pytest.mark.usefixtures('_public_dns')
    @patch('integrations_handler.secretsmanager')
    def test_refuses_too_many_reviews(self, mock_secrets, api_gateway_event, lambda_context):
        _stored_configs(mock_secrets)
        response, _ = _apps_route(
            api_gateway_event, lambda_context, 'POST', 'web_reviews', body={'app': {**WEB_TARGET, 'max_reviews': '5001'}},
        )
        assert response['statusCode'] == 400
        mock_secrets.put_secret_value.assert_not_called()

    @pytest.mark.usefixtures('_public_dns')
    @patch('integrations_handler.secretsmanager')
    def test_stores_every_page_and_a_review_limit(self, mock_secrets, api_gateway_event, lambda_context):
        _stored_configs(mock_secrets)
        response, _ = _apps_route(
            api_gateway_event, lambda_context, 'POST', 'web_reviews',
            body={'app': {**WEB_TARGET, 'max_pages': '0', 'max_reviews': '200'}},
        )
        assert response['statusCode'] == 200
        saved = _saved_configs(mock_secrets, 'web_reviews')[0]
        assert (saved['max_pages'], saved['max_reviews']) == ('0', '200')


EXAMPLE_AIR = {'app_name': 'Example Air', 'url': 'https://www.trustpilot.com/review/www.example-air.com'}


@pytest.mark.usefixtures('_public_dns')
class TestTheWebReviewsSourceLabel:
    """The target's source label is minted once, server-side, and kept across edits."""

    @staticmethod
    def _save(mock_secrets, api_gateway_event, lambda_context, app: dict, stored: list | None = None) -> tuple[dict, dict]:
        _stored_configs(mock_secrets, {'web_reviews': stored or []})
        response, body = _apps_route(api_gateway_event, lambda_context, 'POST', 'web_reviews', body={'app': app})
        assert response['statusCode'] == 200
        return _saved_configs(mock_secrets, 'web_reviews')[0], body

    @patch('integrations_handler.secretsmanager')
    def test_create_mints_it_from_the_site_and_name(self, mock_secrets, api_gateway_event, lambda_context):
        saved, body = self._save(mock_secrets, api_gateway_event, lambda_context, EXAMPLE_AIR)
        assert saved['source_id'] == body['app']['source_id'] == 'web_trustpilot_example_air'

    @pytest.mark.parametrize('client_source_id', ['web_trustpilot_other', 'not a source id'])
    @patch('integrations_handler.secretsmanager')
    def test_create_ignores_a_client_source_id(self, mock_secrets, client_source_id, api_gateway_event, lambda_context):
        saved, _ = self._save(mock_secrets, api_gateway_event, lambda_context,
                              {**EXAMPLE_AIR, 'source_id': client_source_id})
        assert saved['source_id'] == 'web_trustpilot_example_air'

    @patch('integrations_handler.secretsmanager')
    def test_a_rename_keeps_the_stored_label(self, mock_secrets, api_gateway_event, lambda_context):
        stored = [{**EXAMPLE_AIR, 'id': 't1', 'source_id': 'web_trustpilot_example_air'}]
        saved, body = self._save(mock_secrets, api_gateway_event, lambda_context,
                                 {**EXAMPLE_AIR, 'id': 't1', 'app_name': 'Example Air main', 'source_id': 'web_x_y'},
                                 stored)
        assert (saved['app_name'], saved['source_id']) == ('Example Air main', 'web_trustpilot_example_air')
        assert body['app']['source_id'] == 'web_trustpilot_example_air'

    @patch('integrations_handler.secretsmanager')
    def test_a_target_saved_before_labels_is_minted_from_its_stored_values(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        stored = [{**EXAMPLE_AIR, 'id': 't1'}]
        saved, _ = self._save(mock_secrets, api_gateway_event, lambda_context,
                              {**EXAMPLE_AIR, 'id': 't1', 'app_name': 'Example Air main'}, stored)
        assert (saved['app_name'], saved['source_id']) == ('Example Air main', 'web_trustpilot_example_air')

    @patch('integrations_handler.secretsmanager')
    def test_an_app_review_connector_gets_no_label(self, mock_secrets, api_gateway_event, lambda_context):
        _stored_configs(mock_secrets)
        _apps_route(api_gateway_event, lambda_context, 'POST', 'app_reviews_ios',
                    body={'app': {'app_name': 'Example Air', 'app_id': '1'}})
        assert 'source_id' not in _saved_configs(mock_secrets, 'app_reviews_ios')[0]




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
        payload = self._run_payload(mock_boto3, api_gateway_event, lambda_context, body={'app_id': 'com.exampleair.app'})

        assert payload['app_id'] == 'com.exampleair.app'

    @patch('integrations_handler.boto3')
    def test_runs_without_app_id_for_all_apps(
        self, mock_boto3, api_gateway_event, lambda_context
    ):
        payload = self._run_payload(mock_boto3, api_gateway_event, lambda_context)

        assert 'app_id' not in payload
