"""settings_handler: the image model in Administration -> AI models, and the built-in dimension routes.

- ``POST /settings/model/test {model_id: <image model>}`` (admin): one image probe, the
  text-model test's answer shape;
- ``GET /settings/model`` carries ``image_model``;
- the ``image_model_quota.REFRESH_ACTION`` event runs the quota refresh, not a route;
- ``PUT /settings/dimensions`` never stores the built-in ``feedback_type``.
"""
import io
import json
from functools import partial
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import call_route
from moto import mock_aws

import settings_handler
from settings_handler import lambda_handler
from shared import image_model_quota, image_model_status
from shared.dimension_config import DIMENSIONS_SETTINGS_KEY
from shared.feedback_types import feedback_type_dimension
from shared.model_capacity import STATUS_MESSAGES
from shared.test.moto_tables import create_pk_sk_table

IMAGE_ID = 'stability.stable-image-core-v1:1'
IMAGE_REGION = 'us-west-2'
OPUS55 = 'global.anthropic.claude-opus-5-5'
USER_CLAIMS = {'sub': 'user-1', 'cognito:username': 'casey', 'cognito:groups': 'users'}
PRODUCT = {'key': 'product', 'label': 'Product', 'values': [{'name': 'App'}, {'name': 'Web'}]}


@pytest.fixture
def route(api_gateway_event, lambda_context):
    """``route(method, path, body=None, claims=None)`` -> ``(response, decoded body)``."""
    return partial(_settings_call, api_gateway_event, lambda_context)


def _settings_call(event_factory, context, method: str, path: str, **event):
    return call_route(lambda_handler, event_factory, context, method=method, path=path, **event)


@pytest.fixture
def runtime():
    """The bedrock-runtime client the image probe builds (patched at ``boto3.client``)."""
    client = MagicMock()
    image_model_status._client.cache_clear()
    with patch('shared.image_model_status.boto3.client', return_value=client) as factory:
        client.factory = factory
        yield client
    image_model_status._client.cache_clear()


@pytest.fixture
def table():
    with mock_aws():
        moto_table = create_pk_sk_table('test-aggregates-settings-image-model')
        with patch.object(settings_handler, 'aggregates_table', moto_table):
            yield moto_table


class TestImageModelTest:
    def test_admin_probe_answers_the_text_model_test_shape(self, route, runtime):
        runtime.invoke_model.return_value = {'body': io.BytesIO(json.dumps({'images': ['x']}).encode())}
        response, body = route('POST', '/settings/model/test', body={'model_id': IMAGE_ID})
        assert response['statusCode'] == 200
        assert set(body) == {'model_id', 'invoked_id', 'status', 'ok', 'latency_ms', 'message', 'quota',
                             'checked_at'}
        assert (body['model_id'], body['invoked_id'], body['status'], body['ok']) == (
            IMAGE_ID, IMAGE_ID, 'available', True)
        assert body['quota'] is None
        assert runtime.invoke_model.call_args.kwargs['modelId'] == IMAGE_ID
        assert runtime.factory.call_args.kwargs['region_name'] == IMAGE_REGION

    def test_a_failed_image_probe_is_still_200_with_the_status(self, route, runtime):
        runtime.invoke_model.side_effect = ClientError(
            {'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'InvokeModel')
        response, body = route('POST', '/settings/model/test', body={'model_id': IMAGE_ID})
        assert response['statusCode'] == 200
        assert (body['status'], body['ok'], body['latency_ms']) == ('no_access', False, None)
        assert body['message'] == f"{STATUS_MESSAGES['no_access']} (AccessDeniedException)"

    @patch('settings_handler.model_capacity.probe_model')
    @patch('settings_handler.image_model_status.probe_image_model')
    def test_the_image_id_takes_the_image_probe_not_the_text_probe(self, image_probe, text_probe, route):
        image_probe.return_value = {'model_id': IMAGE_ID, 'status': 'available'}
        _, body = route('POST', '/settings/model/test', body={'model_id': IMAGE_ID})
        assert body == {'model_id': IMAGE_ID, 'status': 'available'}
        image_probe.assert_called_once_with()
        text_probe.assert_not_called()

    @patch('settings_handler.model_capacity.probe_model')
    @patch('settings_handler.image_model_status.probe_image_model')
    def test_a_claude_id_still_takes_the_text_probe(self, image_probe, text_probe, route):
        text_probe.return_value = {'model_id': OPUS55, 'status': 'available'}
        route('POST', '/settings/model/test', body={'model_id': OPUS55})
        text_probe.assert_called_once_with(OPUS55)
        image_probe.assert_not_called()

    @patch('settings_handler.image_model_status.probe_image_model')
    def test_non_admin_is_403_and_nothing_is_probed(self, image_probe, route):
        response, _ = route('POST', '/settings/model/test', body={'model_id': IMAGE_ID}, claims=USER_CLAIMS)
        assert response['statusCode'] == 403
        image_probe.assert_not_called()

    @pytest.mark.parametrize('model_id', [
        'stability.stable-image-ultra-v1:1', 'stability.stable-image-core-v1:0', IMAGE_ID.upper(), None, 7,
    ])
    @patch('settings_handler.model_capacity.probe_model')
    @patch('settings_handler.image_model_status.probe_image_model')
    def test_another_or_malformed_id_is_400(self, image_probe, text_probe, route, model_id):
        response, _ = route('POST', '/settings/model/test', body={'model_id': model_id})
        assert response['statusCode'] == 400
        image_probe.assert_not_called()
        text_probe.assert_not_called()

    def test_the_400_lists_the_image_model_as_allowed(self, route):
        _, body = route('POST', '/settings/model/test', body={'model_id': 'nope'})
        assert IMAGE_ID in json.dumps(body)


class TestModelSettingsCarriesTheImageModel:
    @pytest.mark.usefixtures('table')
    def test_any_signed_in_user_sees_the_image_model(self, route, monkeypatch):
        monkeypatch.delenv('AVATARS_ENABLED', raising=False)
        response, body = route('GET', '/settings/model', claims=USER_CLAIMS)
        assert response['statusCode'] == 200
        assert body['image_model'] == {'id': IMAGE_ID, 'label': 'Stable Image Core 1.0',
                                       'region': IMAGE_REGION, 'avatars_enabled': True}

    @pytest.mark.usefixtures('table')
    def test_avatars_switched_off_is_reported(self, route, monkeypatch):
        monkeypatch.setenv('AVATARS_ENABLED', 'false')
        _, body = route('GET', '/settings/model')
        assert body['image_model']['avatars_enabled'] is False


class TestImageQuotaRefreshEvent:
    @patch('settings_handler.image_model_quota.run_refresh_event', return_value={'refreshed': True})
    def test_the_refresh_event_runs_the_image_quota_refresh(self, refresh, lambda_context):
        event = {'action': image_model_quota.REFRESH_ACTION, 'model_id': IMAGE_ID, 'region': IMAGE_REGION,
                 'label': 'Stable Image Core 1.0'}
        assert lambda_handler(event, lambda_context) == {'refreshed': True}
        refresh.assert_called_once_with(event)

    @patch('settings_handler.model_capacity.run_refresh_event')
    @patch('settings_handler.image_model_quota.run_refresh_event', return_value={'refreshed': False})
    def test_it_does_not_run_the_text_quota_refresh(self, image_refresh, text_refresh, lambda_context):
        lambda_handler({'action': image_model_quota.REFRESH_ACTION}, lambda_context)
        image_refresh.assert_called_once()
        text_refresh.assert_not_called()


@pytest.mark.usefixtures('table')
class TestBuiltinDimensionRoutes:
    def test_a_feedback_type_entry_in_a_put_is_not_stored(self, route, table):
        redefined = {'key': 'feedback_type', 'label': 'Mine', 'values': [{'name': 'review'}]}
        response, body = route('PUT', '/settings/dimensions', body={'dimensions': [redefined, PRODUCT]})
        assert response['statusCode'] == 200
        stored = table.get_item(Key=DIMENSIONS_SETTINGS_KEY)['Item']['dimensions']
        assert [d['key'] for d in stored] == ['product']
        assert body['dimensions'][0] == feedback_type_dimension()
        assert [d['key'] for d in body['dimensions']] == ['feedback_type', 'product']

    def test_the_spa_echo_with_builtin_true_round_trips_unchanged(self, route, table):
        route('PUT', '/settings/dimensions', body={'dimensions': [feedback_type_dimension(), PRODUCT]})
        stored = table.get_item(Key=DIMENSIONS_SETTINGS_KEY)['Item']['dimensions']
        assert all('builtin' not in d for d in stored)
        _, body = route('GET', '/settings/dimensions', claims=USER_CLAIMS)
        assert body['dimensions'][0] == feedback_type_dimension()
        assert len(body['dimensions']) == 2

    def test_an_admin_cannot_redefine_feedback_type(self, route):
        route('PUT', '/settings/dimensions', body={'dimensions': [
            {'key': 'feedback_type', 'infer': False, 'values': [{'name': 'review'}]}]})
        _, body = route('GET', '/settings/dimensions')
        assert body['dimensions'] == [feedback_type_dimension()]

    def test_a_stored_legacy_feedback_type_reads_as_the_builtin(self, route, table):
        legacy = {'key': 'feedback_type', 'infer': False, 'values': [{'name': 'review'}]}
        table.put_item(Item={**DIMENSIONS_SETTINGS_KEY, 'dimensions': [legacy, PRODUCT]})
        _, body = route('GET', '/settings/dimensions')
        assert [d['key'] for d in body['dimensions']] == ['feedback_type', 'product']
        assert body['dimensions'][0] == feedback_type_dimension()

    def test_a_non_admin_put_is_403(self, route, table):
        response, _ = route('PUT', '/settings/dimensions', body={'dimensions': [PRODUCT]}, claims=USER_CLAIMS)
        assert response['statusCode'] == 403
        assert 'Item' not in table.get_item(Key=DIMENSIONS_SETTINGS_KEY)
