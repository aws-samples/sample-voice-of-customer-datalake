"""GET /scrapers/connectors: the app connectors and review pages with their Radar brand (5.47, docs/radar.md).

The AI assistant's list_scrapers reads it (the stream may invoke the scrapers API, not the integrations
API). Pins: every connector source, only the listed fields, a bad entry skipped, a failed read is an
empty list, and a signed-in non-admin may read it like GET /integrations/<source>/apps.
"""
import json
from unittest.mock import patch

from botocore.exceptions import ClientError

from scrapers_handler import lambda_handler
from shared.app_connector_listing import CONNECTOR_FIELDS, connectors_in_secret

USER = {'sub': 'user-1', 'email': 'user@example.com', 'cognito:groups': 'users'}
SECRET = {
    'webscraper_configs': '[]',
    'app_reviews_ios_configs': json.dumps([
        {'id': 'ios1', 'app_name': 'Example Air', 'app_id': '123456789', 'enabled': 'true', 'radar_brand': 'example-air',
         'sort_by': 'most_recent', 'internal_note': 'never shown'},
    ]),
    'app_reviews_android_configs': json.dumps([{'id': 'and1', 'app_name': 'Our app', 'package_name': 'com.example.app'}, 'bad']),
    'web_reviews_configs': json.dumps([{'id': 'web1', 'app_name': 'Trustpilot - Globex', 'url': 'https://reviews.example/globex',
                                        'source_id': 'web_reviews_globex', 'radar_brand': 'globex', 'radar_brand_extra': ''}]),
    'some_api_key': 'secret-value',
}


def _get(api_gateway_event, lambda_context, secret=SECRET, claims=None):
    with patch('scrapers_handler.SECRETS_ARN', 'arn:secret'), patch('scrapers_handler.secretsmanager') as secrets:
        if isinstance(secret, Exception):
            secrets.get_secret_value.side_effect = secret
        else:
            secrets.get_secret_value.return_value = {'SecretString': json.dumps(secret)}
        response = lambda_handler(api_gateway_event(method='GET', path='/scrapers/connectors', claims=claims), lambda_context)
    return response['statusCode'], json.loads(response['body'])


def test_every_connector_source_with_its_radar_brand_and_only_the_listed_fields(api_gateway_event, lambda_context):
    status, body = _get(api_gateway_event, lambda_context)
    assert status == 200
    assert body['connectors'] == [
        {'source': 'app_reviews_ios', 'id': 'ios1', 'app_name': 'Example Air', 'app_id': '123456789', 'enabled': 'true',
         'radar_brand': 'example-air'},
        {'source': 'app_reviews_android', 'id': 'and1', 'app_name': 'Our app', 'package_name': 'com.example.app'},
        {'source': 'web_reviews', 'id': 'web1', 'app_name': 'Trustpilot - Globex', 'url': 'https://reviews.example/globex',
         'source_id': 'web_reviews_globex', 'radar_brand': 'globex'},
    ]
    assert 'secret-value' not in json.dumps(body)
    assert 'never shown' not in json.dumps(body)


def test_a_signed_in_non_admin_may_read_it(api_gateway_event, lambda_context):
    status, body = _get(api_gateway_event, lambda_context, claims=USER)
    assert (status, len(body['connectors'])) == (200, 3)


def test_a_failed_secret_read_is_an_empty_list(api_gateway_event, lambda_context):
    error = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'GetSecretValue')
    assert _get(api_gateway_event, lambda_context, secret=error) == (200, {'connectors': []})


def test_a_malformed_scraper_list_does_not_hide_the_connectors(api_gateway_event, lambda_context):
    _, body = _get(api_gateway_event, lambda_context, secret={**SECRET, 'webscraper_configs': 'not json'})
    assert len(body['connectors']) == 3


def test_a_source_whose_value_is_not_a_json_list_is_skipped():
    assert connectors_in_secret({'app_reviews_ios_configs': '{"id": "x"}', 'web_reviews_configs': 'not json'}) == []
    assert connectors_in_secret({}) == []
    assert 'radar_brand' in CONNECTOR_FIELDS
