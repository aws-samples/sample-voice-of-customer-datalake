"""`radar_brand` on an app connector, a web-review target and a CSV upload (docs/radar.md).

Each save path keeps a Radar brand key, drops a blank one (an ordinary source) and refuses a
malformed one with a 400 before anything is written; a CSV upload stamps every row. The
scraper's own cases are in `test_scrapers_save_bounds.py::TestRadarBrand`.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
from test_app_configs import _apps_route, _saved_configs, _stored_configs
from test_manual_import_csv_upload import CSV_BASIC, _make_sqs

from shared.test.source_profile_fixtures import unconfigured_upload_profile

WEB_TARGET_URL = 'https://www.trustpilot.com/review/x.com'


@pytest.fixture
def allow_urls():
    with patch('shared.web_review_targets.validate_url', return_value=(True, '')):
        yield


class TestAppConnector:
    @patch('integrations_handler.secretsmanager')
    def test_an_app_connector_keeps_its_radar_brand(self, secrets, api_gateway_event, lambda_context):
        _stored_configs(secrets)
        response, body = _apps_route(api_gateway_event, lambda_context, 'POST', 'app_reviews_ios',
                                     body={'app': {'app_name': 'Rival', 'app_id': '9', 'radar_brand': 'initech'}})
        assert (response['statusCode'], body['app']['radar_brand']) == (200, 'initech')
        assert _saved_configs(secrets, 'app_reviews_ios')[0]['radar_brand'] == 'initech'

    @patch('integrations_handler.secretsmanager')
    def test_a_blank_radar_brand_is_dropped(self, secrets, api_gateway_event, lambda_context):
        _stored_configs(secrets)
        _apps_route(api_gateway_event, lambda_context, 'POST', 'app_reviews_android',
                    body={'app': {'app_name': 'Ours', 'package_name': 'com.us', 'radar_brand': '  '}})
        assert 'radar_brand' not in _saved_configs(secrets, 'app_reviews_android')[0]

    @pytest.mark.usefixtures('allow_urls')
    @pytest.mark.parametrize('source', ['app_reviews_ios', 'web_reviews'])
    @patch('integrations_handler.secretsmanager')
    def test_a_malformed_radar_brand_is_a_400(self, secrets, api_gateway_event, lambda_context, source):
        _stored_configs(secrets)
        app = {'app_name': 'Rival', 'app_id': '9', 'url': WEB_TARGET_URL, 'radar_brand': 'Initech Corp'}
        response, _ = _apps_route(api_gateway_event, lambda_context, 'POST', source, body={'app': app})
        assert response['statusCode'] == 400
        secrets.put_secret_value.assert_not_called()

    @pytest.mark.usefixtures('allow_urls')
    @patch('integrations_handler.secretsmanager')
    def test_a_web_review_target_keeps_its_radar_brand(self, secrets, api_gateway_event, lambda_context):
        _stored_configs(secrets)
        app = {'app_name': 'Rival', 'url': WEB_TARGET_URL, 'radar_brand': 'initech'}
        response, _ = _apps_route(api_gateway_event, lambda_context, 'POST', 'web_reviews', body={'app': app})
        assert response['statusCode'] == 200
        assert _saved_configs(secrets, 'web_reviews')[0]['radar_brand'] == 'initech'


JSON_ITEMS = [
    {'id': f'j{n}', 'text': f'Review {n}', 'source': 'store', 'timestamp': '2026-10-01T10:00:00Z'} for n in (1, 2)
]
UPLOADS = {
    'csv': ('/scrapers/manual/csv-upload', {'csv_text': CSV_BASIC}),
    'json': ('/scrapers/manual/json-upload', {'items': JSON_ITEMS}),
}


class TestUploads:
    """CSV and JSON uploads take the same optional ``radar_brand`` (a brand key) and stamp every row."""

    @pytest.fixture(params=sorted(UPLOADS))
    def upload(self, request):
        return UPLOADS[request.param]

    @pytest.fixture(autouse=True)
    def _no_source_profiles(self):
        with patch('manual_import_handler.upload_profile', side_effect=unconfigured_upload_profile), \
             patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/q'), \
             patch('manual_import_handler.RAW_DATA_BUCKET', ''):
            yield

    @staticmethod
    def _upload(upload, api_gateway_event, lambda_context, **extra) -> tuple[int, dict, MagicMock]:
        from manual_import_handler import lambda_handler
        sqs = _make_sqs()
        path, body = upload
        event = api_gateway_event(method='POST', path=path, body={**body, **extra})
        with patch('manual_import_handler.sqs', sqs):
            response = lambda_handler(event, lambda_context)
        return response['statusCode'], json.loads(response['body']), sqs

    @staticmethod
    def _messages(sqs: MagicMock) -> list[dict]:
        if not sqs.send_message_batch.call_args:
            return []
        return [json.loads(e['MessageBody']) for e in sqs.send_message_batch.call_args.kwargs['Entries']]

    def test_every_row_of_a_radar_upload_is_stamped(self, upload, api_gateway_event, lambda_context):
        status, body, sqs = self._upload(upload, api_gateway_event, lambda_context, radar_brand='initech')
        assert (status, body['radar_brand']) == (200, 'initech')
        assert [m['radar_brand_key'] for m in self._messages(sqs)] == ['initech', 'initech']

    def test_an_ordinary_upload_carries_no_key(self, upload, api_gateway_event, lambda_context):
        _, body, sqs = self._upload(upload, api_gateway_event, lambda_context)
        assert 'radar_brand' not in body
        assert not any('radar_brand_key' in m for m in self._messages(sqs))

    def test_a_malformed_radar_brand_is_a_400_and_nothing_is_queued(self, upload, api_gateway_event, lambda_context):
        status, _, sqs = self._upload(upload, api_gateway_event, lambda_context, radar_brand='Initech Corp')
        assert (status, self._messages(sqs)) == (400, [])
