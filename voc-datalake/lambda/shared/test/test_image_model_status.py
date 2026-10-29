"""`shared/image_model_status.py`: the persona-avatar image model row of Administration -> AI models.

boto3 clients are MagicMocks patched at ``boto3.client`` in the module, so nothing
reaches AWS and every request the module makes is asserted.
"""
import io
import json
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError, ReadTimeoutError

from shared import image_model_status as status
from shared.avatar import get_image_model_config
from shared.model_capacity import STATUS_MESSAGES
from shared.test.repo_paths import repo_root

AVAILABILITY_OK = {
    'agreementAvailability': {'status': 'AVAILABLE'},
    'authorizationStatus': 'AUTHORIZED',
    'entitlementAvailability': 'AVAILABLE',
    'regionAvailability': 'AVAILABLE',
}


def _config_file() -> dict:
    path = repo_root() / 'lambda' / 'api' / 'prompts' / 'avatar-generation.json'
    return json.loads(path.read_text(encoding='utf-8'))['image_model']


IMAGE = _config_file()


def _client_error(code: str, message: str = 'boom', operation: str = 'InvokeModel') -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': message}}, operation)


def _body(payload: object) -> dict:
    raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    return {'body': io.BytesIO(raw)}


@pytest.fixture(autouse=True)
def _empty_access_cache() -> Iterator[None]:
    status._access_cache.clear()
    status._client.cache_clear()
    yield
    status._access_cache.clear()
    status._client.cache_clear()


@pytest.fixture
def client() -> Iterator[MagicMock]:
    """The client ``boto3.client`` hands the module (bedrock or bedrock-runtime alike)."""
    mock = MagicMock()
    with patch.object(status.boto3, 'client', return_value=mock) as factory:
        mock.factory = factory
        yield mock


class TestImageModelInfo:
    def test_it_names_the_configured_model_its_label_and_region(self, monkeypatch):
        monkeypatch.delenv('AVATARS_ENABLED', raising=False)
        assert status.image_model_info() == {
            'id': IMAGE['model_id'],
            'label': status.IMAGE_MODEL_LABELS[IMAGE['model_id']],
            'region': IMAGE['region'],
            'avatars_enabled': True,
        }

    def test_the_configured_model_is_stable_image_core_in_us_west_2(self):
        assert (IMAGE['model_id'], IMAGE['region']) == ('stability.stable-image-core-v1:1', 'us-west-2')
        assert status.image_model_info()['label'] == 'Stable Image Core 1.0'

    @pytest.mark.parametrize(('value', 'enabled'), [('false', False), ('FALSE', False), ('true', True), ('', True)])
    def test_avatars_enabled_follows_the_switch(self, monkeypatch, value, enabled):
        monkeypatch.setenv('AVATARS_ENABLED', value)
        assert status.image_model_info()['avatars_enabled'] is enabled

    def test_an_unlisted_model_is_labelled_with_its_id(self):
        with patch.object(status, 'get_image_model_config', return_value={'model_id': 'x.y', 'region': 'r'}):
            assert status.image_model_info()['label'] == 'x.y'


class TestAccessStatus:
    @pytest.mark.parametrize(('overrides', 'expected'), [
        ({}, 'available'),
        ({'regionAvailability': 'NOT_AVAILABLE'}, 'not_in_region'),
        # Region wins over everything else.
        ({'regionAvailability': 'NOT_AVAILABLE', 'authorizationStatus': 'NOT_AUTHORIZED'}, 'not_in_region'),
        ({'authorizationStatus': 'NOT_AUTHORIZED'}, 'no_access'),
        # IAM wins over the agreement.
        ({'authorizationStatus': 'NOT_AUTHORIZED', 'agreementAvailability': {'status': 'NOT_AVAILABLE'}},
         'no_access'),
        ({'agreementAvailability': {'status': 'NOT_AVAILABLE'}}, 'not_subscribed'),
        ({'agreementAvailability': {'status': 'PENDING'}}, 'not_subscribed'),
        ({'agreementAvailability': {'status': 'ERROR'}}, 'not_subscribed'),
        ({'entitlementAvailability': 'NOT_AVAILABLE'}, 'not_subscribed'),
        # An absent agreement is not a missing subscription.
        ({'agreementAvailability': None}, 'available'),
        ({'agreementAvailability': {}}, 'available'),
        ({'regionAvailability': ''}, 'unknown'),
        ({'authorizationStatus': ''}, 'unknown'),
        ({'authorizationStatus': 'SOMETHING_NEW'}, 'unknown'),
    ])
    def test_the_availability_answer_maps_to_the_access_vocabulary(self, overrides, expected):
        availability = {k: v for k, v in {**AVAILABILITY_OK, **overrides}.items() if v is not None}
        assert status.access_status(availability) == expected

    def test_an_empty_answer_is_unknown(self):
        assert status.access_status({}) == 'unknown'


class TestImageAccess:
    def test_it_asks_bedrock_in_the_image_region_and_records_the_fields(self, client):
        client.get_foundation_model_availability.return_value = AVAILABILITY_OK
        access = status.image_access('stability.stable-image-core-v1:1', 'us-west-2')
        assert access['status'] == 'available'
        assert (access['agreement'], access['authorization'], access['entitlement'],
                access['region_availability']) == ('AVAILABLE', 'AUTHORIZED', 'AVAILABLE', 'AVAILABLE')
        assert access['checked_at']
        client.get_foundation_model_availability.assert_called_once_with(modelId='stability.stable-image-core-v1:1')
        args, kwargs = client.factory.call_args
        assert (args, kwargs['region_name']) == (('bedrock',), 'us-west-2')

    def test_the_answer_is_cached_per_model(self, client):
        client.get_foundation_model_availability.return_value = AVAILABILITY_OK
        first = status.image_access('m', 'us-west-2')
        assert status.image_access('m', 'us-west-2') is first
        assert client.get_foundation_model_availability.call_count == 1

    def test_an_expired_cache_entry_is_read_again(self, client):
        client.get_foundation_model_availability.return_value = AVAILABILITY_OK
        with patch.object(status.time, 'time', return_value=1000.0):
            status.image_access('m', 'us-west-2')
        with patch.object(status.time, 'time', return_value=1000.0 + status.ACCESS_CACHE_SECONDS + 1):
            status.image_access('m', 'us-west-2')
        assert client.get_foundation_model_availability.call_count == 2

    @pytest.mark.parametrize('error', [
        _client_error('AccessDeniedException', operation='GetFoundationModelAvailability'),
        _client_error('ValidationException', operation='GetFoundationModelAvailability'),
        EndpointConnectionError(endpoint_url='https://bedrock.us-west-2.amazonaws.com'),
    ])
    def test_a_client_error_is_unknown_and_not_cached(self, client, error):
        client.get_foundation_model_availability.side_effect = error
        access = status.image_access('m', 'us-west-2')
        assert access['status'] == 'unknown'
        assert (access['agreement'], access['authorization']) == ('', '')
        assert 'm' not in status._access_cache


class TestImageCapacity:
    def test_it_combines_info_access_and_quota(self, monkeypatch):
        monkeypatch.delenv('AVATARS_ENABLED', raising=False)
        quota = {'name': 'q', 'value': 10, 'unit': 'requests_per_minute'}
        access = {'status': 'available'}
        with patch.object(status, 'image_quota', return_value={'quota': quota, 'state': 'stale'}) as read, \
             patch.object(status, 'image_access', return_value=access) as probe:
            capacity = status.image_capacity()
        assert capacity == {
            'id': IMAGE['model_id'], 'label': 'Stable Image Core 1.0', 'region': IMAGE['region'],
            'avatars_enabled': True, 'access': access, 'quota': quota, 'quota_state': 'stale',
        }
        read.assert_called_once_with(IMAGE['model_id'], IMAGE['region'], 'Stable Image Core 1.0')
        probe.assert_called_once_with(IMAGE['model_id'], IMAGE['region'])


class TestProbe:
    def test_an_image_is_available_with_a_latency(self, client):
        client.invoke_model.return_value = _body({'images': ['aGVsbG8='], 'finish_reasons': [None]})
        result = status.probe_image_model()
        assert result['status'] == 'available'
        assert result['ok'] is True
        assert isinstance(result['latency_ms'], int)
        assert result['message'] == STATUS_MESSAGES['available']

    def test_the_answer_has_the_text_model_test_shape(self, client):
        client.invoke_model.return_value = _body({'images': ['x']})
        result = status.probe_image_model()
        assert set(result) == {'model_id', 'invoked_id', 'status', 'ok', 'latency_ms', 'message', 'quota',
                               'checked_at'}
        assert result['model_id'] == result['invoked_id'] == IMAGE['model_id']
        assert result['quota'] is None
        assert result['checked_at']

    def test_it_sends_one_fixed_minimal_request_to_the_image_region(self, client):
        client.invoke_model.return_value = _body({'images': ['x']})
        status.probe_image_model()
        client.invoke_model.assert_called_once()
        kwargs = client.invoke_model.call_args.kwargs
        assert kwargs['modelId'] == IMAGE['model_id']
        assert json.loads(kwargs['body']) == {
            'prompt': status.PROBE_PROMPT, 'mode': 'text-to-image', 'aspect_ratio': '1:1',
            'output_format': get_image_model_config()['output_format'], 'seed': status.PROBE_SEED,
        }
        args, factory_kwargs = client.factory.call_args
        assert (args, factory_kwargs['region_name']) == (('bedrock-runtime',), IMAGE['region'])

    def test_the_probe_never_writes_to_s3(self, client):
        client.invoke_model.return_value = _body({'images': ['x']})
        status.probe_image_model()
        services = [call.args[0] for call in client.factory.call_args_list]
        assert services == ['bedrock-runtime']
        client.put_object.assert_not_called()
        client.upload_fileobj.assert_not_called()

    @pytest.mark.parametrize('finish_reasons', [['CONTENT_FILTERED'], ['Filter reason: prompt']])
    def test_a_content_filter_finish_reason_still_means_the_model_answered(self, client, finish_reasons):
        client.invoke_model.return_value = _body({'images': [], 'finish_reasons': finish_reasons})
        assert status.probe_image_model()['status'] == 'available'

    @pytest.mark.parametrize('payload', [{'images': []}, {}, [], {'finish_reasons': [None]}])
    def test_no_image_is_an_error(self, client, payload):
        client.invoke_model.return_value = _body(payload)
        result = status.probe_image_model()
        assert (result['status'], result['ok'], result['latency_ms']) == ('error', False, None)
        assert result['message'] == f"{STATUS_MESSAGES['error']} (NoImageReturned)"

    def test_unparseable_json_is_an_invalid_response(self, client):
        client.invoke_model.return_value = _body(b'not json')
        result = status.probe_image_model()
        assert result['status'] == 'error'
        assert result['message'].endswith('(InvalidResponse)')

    @pytest.mark.parametrize(('code', 'message', 'expected'), [
        ('ThrottlingException', 'slow down', 'throttled'),
        ('TooManyRequestsException', 'slow down', 'throttled'),
        ('ServiceQuotaExceededException', 'quota', 'throttled'),
        ('ServiceUnavailableException', 'busy', 'throttled'),
        ('ModelNotReadyException', 'warming', 'throttled'),
        ('AccessDeniedException', 'not authorized', 'no_access'),
        ('UnrecognizedClientException', 'bad token', 'no_access'),
        ('ExpiredTokenException', 'expired', 'no_access'),
        ('ResourceNotFoundException', 'gone', 'not_in_region'),
        ('ModelNotFoundException', 'gone', 'not_in_region'),
        ('ValidationException', 'The provided model identifier is invalid.', 'not_in_region'),
        ('ValidationException', 'This model is not available in your region', 'unavailable'),
        ('ValidationException', 'Malformed input request', 'error'),
        # The content-filter reason has no test status of its own: an error.
        ('ValidationException', 'blocked by content filter', 'error'),
        ('InternalServerException', 'oops', 'error'),
    ])
    def test_a_client_error_is_classified_like_an_avatar_failure(self, client, code, message, expected):
        client.invoke_model.side_effect = _client_error(code, message)
        result = status.probe_image_model()
        assert result['status'] == expected
        assert result['ok'] is False
        assert result['latency_ms'] is None
        assert result['message'] == f'{STATUS_MESSAGES[expected]} ({code})'

    @pytest.mark.parametrize(('error', 'expected', 'code'), [
        (EndpointConnectionError(endpoint_url='https://x'), 'unavailable', 'EndpointConnectionError'),
        (ReadTimeoutError(endpoint_url='https://x'), 'error', 'ReadTimeoutError'),
    ])
    def test_a_botocore_error_is_classified_by_its_type(self, client, error, expected, code):
        client.invoke_model.side_effect = error
        result = status.probe_image_model()
        assert (result['status'], result['message']) == (expected, f'{STATUS_MESSAGES[expected]} ({code})')

    def test_every_reason_maps_to_a_known_status(self):
        assert set(status._REASON_STATUS.values()) <= set(STATUS_MESSAGES)
