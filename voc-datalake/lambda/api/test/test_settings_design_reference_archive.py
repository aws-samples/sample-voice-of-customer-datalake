"""Archiving a design reference deletes its logo PREVIEW (5.47.00): ``DELETE /settings/design-system/references/{id}``.

Moto aggregates table + S3. Pins: the preview objects (any type) go, the row's ``preview_key`` goes, the
uploaded file and every other object stay; a reference without a logo archives as before; repeating the call
is safe; an S3 failure answers 503 with the reference archived, and a retry then removes the preview; the
SVG-logo hand-off starts only when a capture function is configured.
"""
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import call_route
from moto import mock_aws

import settings_handler
from settings_handler import lambda_handler
from shared.company_context import DESIGN_SYSTEM_PK, get_reference
from shared.test.moto_tables import create_pk_sk_table

ADMIN = {'sub': 'admin-sub', 'cognito:username': 'alice', 'cognito:groups': 'admins'}
REF_ID = 'ref_0123456789ab'
PREVIEW = f'company-context/design/logo_preview_{REF_ID}.png'
OLD_PREVIEW = f'company-context/design/logo_preview_{REF_ID}.webp'
UPLOAD = f'company-context/design/{REF_ID}.png'
OTHER = 'company-context/design/logo_preview_ref_aaaaaaaaaaaa.png'
PATH = f'/settings/design-system/references/{REF_ID}'


@pytest.fixture
def world():
    with mock_aws():
        table = create_pk_sk_table('test-aggregates')
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='raw')
        with patch.object(settings_handler, 'aggregates_table', table), \
                patch.object(settings_handler, 'RAW_DATA_BUCKET', 'raw'), \
                patch.object(settings_handler, 'get_s3_client', return_value=s3):
            yield table, s3


def _row(table, logo: object) -> None:
    table.put_item(Item={'pk': DESIGN_SYSTEM_PK, 'sk': f'REF#{REF_ID}', 'id': REF_ID, 'kind': 'website',
                         'title': 'Site', 'url': 'https://kirocrew.dev', 'status': 'ready', 'created_at': '1',
                         'extracted_design': {'source': 'computed_styles', 'logo': logo}})


def _keys(s3) -> list[str]:
    return sorted(o['Key'] for o in s3.list_objects_v2(Bucket='raw').get('Contents', []))


def _stored(table) -> dict:
    item = get_reference(table, REF_ID)
    assert item is not None
    return item


def _archive(api_gateway_event, lambda_context):
    return call_route(lambda_handler, api_gateway_event, lambda_context, method='DELETE', path=PATH, claims=ADMIN)


def test_the_preview_objects_and_key_go_and_everything_else_stays(world, api_gateway_event, lambda_context):
    table, s3 = world
    _row(table, {'source_url': 'https://kirocrew.dev/logo.png', 'content_type': 'image/png', 'preview_key': PREVIEW})
    for key in (PREVIEW, OLD_PREVIEW, UPLOAD, OTHER):
        s3.put_object(Bucket='raw', Key=key, Body=b'x')

    response, body = _archive(api_gateway_event, lambda_context)

    assert response['statusCode'] == 200
    assert body['reference']['status'] == 'archived'
    assert _keys(s3) == sorted([UPLOAD, OTHER])
    stored = _stored(table)
    assert stored['extracted_design']['logo'] == {'source_url': 'https://kirocrew.dev/logo.png',
                                                  'content_type': 'image/png'}


@pytest.mark.parametrize('logo', [None, {'source_url': 'https://kirocrew.dev/logo.png', 'content_type': 'image/png'}])
def test_a_reference_without_a_preview_key_archives_and_repeats_safely(world, api_gateway_event, lambda_context, logo):
    table, s3 = world
    _row(table, logo)
    s3.put_object(Bucket='raw', Key=PREVIEW, Body=b'x')   # an orphan from before 5.47.00
    for _ in range(2):
        response, body = _archive(api_gateway_event, lambda_context)
        assert response['statusCode'] == 200
        assert body['reference']['status'] == 'archived'
    assert _keys(s3) == []


def test_an_s3_failure_is_a_503_and_a_retry_cleans_up(world, api_gateway_event, lambda_context):
    table, s3 = world
    _row(table, {'source_url': 'https://kirocrew.dev/logo.png', 'content_type': 'image/png', 'preview_key': PREVIEW})
    s3.put_object(Bucket='raw', Key=PREVIEW, Body=b'x')
    failing = MagicMock()
    failing.delete_objects.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'DeleteObjects')
    with patch.object(settings_handler, 'get_s3_client', return_value=failing):
        response, body = _archive(api_gateway_event, lambda_context)
    assert response['statusCode'] == 503
    assert 'try again' in str(body)
    assert _stored(table)['status'] == 'archived'

    response, _ = _archive(api_gateway_event, lambda_context)
    assert response['statusCode'] == 200
    assert _keys(s3) == []


def test_an_unknown_reference_is_404_and_deletes_nothing(world, api_gateway_event, lambda_context):
    _, s3 = world
    s3.put_object(Bucket='raw', Key=PREVIEW, Body=b'x')
    response, _ = _archive(api_gateway_event, lambda_context)
    assert response['statusCode'] == 404
    assert _keys(s3) == [PREVIEW]


class TestTheSvgLogoHandOff:
    def _deps(self, function: str):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'id': REF_ID, 'kind': 'github', 'status': 'pending',
                                                'url': 'https://github.com/acme/ui'}}
        with patch.object(settings_handler, 'aggregates_table', table), \
                patch.object(settings_handler, 'DESIGN_CAPTURE_FUNCTION', function), \
                patch.object(settings_handler, '_read_integration_secret', return_value={}), \
                patch.object(settings_handler, 'get_s3_client'), \
                patch.object(settings_handler.design_references, 'process_reference',
                             return_value={'status': 'ready'}) as process:
            settings_handler._process_reference_event({'ref_id': REF_ID})
        return process.call_args.args[2]

    def test_without_a_capture_function_there_is_no_hand_off(self):
        assert self._deps('').start_logo_render is None

    def test_the_hand_off_invokes_the_capture_function_and_reports_a_failure(self):
        start = self._deps('voc-design-capture').start_logo_render
        assert start is not None
        with patch.object(settings_handler, 'DESIGN_CAPTURE_FUNCTION', 'voc-design-capture'), \
                patch.object(settings_handler, 'invoke_lambda_async') as invoke:
            assert start({'action': 'design_logo_render'}) is True
            invoke.assert_called_once_with('voc-design-capture', {'action': 'design_logo_render'})
            invoke.side_effect = RuntimeError('RequestEntityTooLarge')
            assert start({'action': 'design_logo_render'}) is False
