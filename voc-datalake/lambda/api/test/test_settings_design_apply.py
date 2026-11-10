"""Wave 12/13 design-system routes of settings_handler.py: live-website references, components (PUT/GET),
apply (a draft, never saved) and "Use this logo" (an SSRF-guarded server-side download), against moto."""
from unittest.mock import MagicMock, patch

import boto3
import pytest
import requests
from botocore.config import Config
from handler_events_fixtures import call_route
from moto import mock_aws

import settings_handler
from settings_handler import lambda_handler
from shared import design_logo
from shared.http_utils import UnsafeURLError
from shared.test.moto_tables import create_pk_sk_table

ADMIN = {'sub': 'admin-sub', 'cognito:username': 'alice', 'cognito:groups': 'admins'}
USER = {'sub': 'user-sub', 'cognito:username': 'bob', 'cognito:groups': 'users'}
REF_ID = 'ref_0123456789ab'
PNG = b'\x89PNG\r\n\x1a\n' + b'0' * 32
DESIGN = {
    'colors': [{'name': 'primary', 'value': '#7c3aed'}, {'name': 'surface', 'value': '#ffffff'}],
    'typography': [{'role': 'heading', 'family': '"Space Grotesk", sans-serif'}],
    'spacing': [], 'radius': [{'name': 'card', 'value': '12px'}],
    'guidelines_md': 'Purple for one primary action per screen.',
    'components': [{'name': 'Button', 'description': 'Solid purple'}],
    'logo': {'source_url': 'https://kiro.dev/logo.png', 'content_type': 'image/png'},
    'source': 'computed_styles',
}


@pytest.fixture
def table():
    """The aggregates table (moto) behind the handler; no integrations secret configured."""
    patches = (('aggregates_table', None), ('_read_integration_secret', MagicMock(return_value={})))
    with mock_aws():
        aggregates = create_pk_sk_table('test-aggregates')
        with patch.multiple(settings_handler, **{name: value or aggregates for name, value in patches}):
            yield aggregates


@pytest.fixture
def s3(table):
    """The raw bucket (moto, SigV4 like production) the logo lands in; ``table`` opened mock_aws."""
    del table
    bucket_client = boto3.client('s3', config=Config(signature_version='s3v4'), region_name='us-east-1')
    bucket_client.create_bucket(Bucket=settings_handler.RAW_DATA_BUCKET)
    with patch.object(settings_handler, 'get_s3_client', return_value=bucket_client):
        yield bucket_client


def _call(api_gateway_event, lambda_context, method, path, body=None, claims=ADMIN):
    return call_route(lambda_handler, api_gateway_event, lambda_context,
                      method=method, path=path, body=body, claims=claims)


def _seed(table, **attrs):
    item = {'pk': 'SETTINGS#design_system', 'sk': f'REF#{REF_ID}', 'id': REF_ID, 'kind': 'website',
            'title': 'kirocrew.dev', 'url': 'https://kirocrew.dev', 'status': 'ready', 'created_at': '2026',
            'extracted_summary': 'Purple.', 'extracted_design': DESIGN, **attrs}
    table.put_item(Item=item)


class TestWebsiteReference:
    @pytest.fixture
    def invoke(self):
        with patch.object(settings_handler, 'invoke_lambda_async') as mock_invoke, \
                patch.object(settings_handler, 'DESIGN_CAPTURE_FUNCTION', 'voc-design-capture'):
            yield mock_invoke

    @pytest.mark.usefixtures('table')
    def test_create_starts_the_capture_worker(self, api_gateway_event, lambda_context, invoke):
        with patch.object(settings_handler, 'validate_url', return_value=(True, '')) as guard:
            response, body = _call(api_gateway_event, lambda_context, 'POST', '/settings/design-system/references',
                                   {'kind': 'website', 'title': 'Kiro', 'url': 'https://kiro.dev'})
        assert response['statusCode'] == 201
        guard.assert_called_once_with('https://kiro.dev')
        invoke.assert_called_once_with('voc-design-capture', {
            'action': 'design_capture', 'ref_id': body['reference']['id']})
        assert body['reference']['status'] == 'pending'

    @pytest.mark.usefixtures('table')
    @pytest.mark.parametrize('url', ['https://127.0.0.1/', 'https://localhost/x', 'http://kiro.dev'])
    def test_private_loopback_or_plain_http_is_400(self, api_gateway_event, lambda_context, invoke, url):
        response, _ = _call(api_gateway_event, lambda_context, 'POST', '/settings/design-system/references',
                            {'kind': 'website', 'title': 'Bad', 'url': url})
        assert response['statusCode'] == 400
        invoke.assert_not_called()

    def test_refresh_of_a_website_goes_to_the_capture_worker(self, api_gateway_event, lambda_context, table, invoke):
        _seed(table)
        response, _ = _call(api_gateway_event, lambda_context, 'POST',
                            f'/settings/design-system/references/{REF_ID}/refresh')
        assert response['statusCode'] == 202
        invoke.assert_called_once_with('voc-design-capture', {'action': 'design_capture', 'ref_id': REF_ID})

    def test_no_capture_worker_is_recorded_on_the_reference(self, api_gateway_event, lambda_context, table):
        _seed(table)
        with patch.object(settings_handler, 'DESIGN_CAPTURE_FUNCTION', ''):
            _call(api_gateway_event, lambda_context, 'POST', f'/settings/design-system/references/{REF_ID}/refresh')
        stored = table.get_item(Key={'pk': 'SETTINGS#design_system', 'sk': f'REF#{REF_ID}'})['Item']
        assert stored['status'] == 'error'
        assert stored['error'] == 'Reading live websites is not available in this deployment'

    def test_get_returns_the_extracted_design_per_reference(self, api_gateway_event, lambda_context, table):
        _seed(table)
        _, body = _call(api_gateway_event, lambda_context, 'GET', '/settings/design-system', claims=USER)
        assert body['references'][0]['extracted_design']['colors'][0] == {'name': 'primary', 'value': '#7c3aed'}


class TestApply:
    def test_draft_is_returned_and_nothing_is_saved(self, api_gateway_event, lambda_context, table):
        _seed(table)
        table.put_item(Item={'pk': 'SETTINGS#design_system', 'sk': 'config', 'guidelines': 'Calm.',
                             'tokens': {'colors': [{'name': 'primary', 'value': '#000000'}], 'typography': []}})
        response, body = _call(api_gateway_event, lambda_context, 'POST',
                               f'/settings/design-system/references/{REF_ID}/apply')
        assert response['statusCode'] == 200
        assert body['draft']['tokens']['colors'] == DESIGN['colors']
        assert body['changes']['colors'] == {'added': 1, 'replaced': 1}
        assert body['draft']['guidelines'].startswith('Calm.\n\n## From kirocrew.dev\n\n')
        assert body['draft']['logo_candidate'] == DESIGN['logo']
        stored = table.get_item(Key={'pk': 'SETTINGS#design_system', 'sk': 'config'})['Item']
        assert stored['tokens']['colors'] == [{'name': 'primary', 'value': '#000000'}]

    @pytest.mark.parametrize(('attrs', 'status'), [
        ({'extracted_design': None}, 409), ({'status': 'archived'}, 409)])
    def test_no_design_or_archived_is_409(self, api_gateway_event, lambda_context, table, attrs, status):
        _seed(table, **attrs)
        response, _ = _call(api_gateway_event, lambda_context, 'POST',
                            f'/settings/design-system/references/{REF_ID}/apply')
        assert response['statusCode'] == status

    @pytest.mark.usefixtures('table')
    def test_admin_only_and_404(self, api_gateway_event, lambda_context):
        path = f'/settings/design-system/references/{REF_ID}/apply'
        assert _call(api_gateway_event, lambda_context, 'POST', path, claims=USER)[0]['statusCode'] == 403
        assert _call(api_gateway_event, lambda_context, 'POST', path)[0]['statusCode'] == 404


def _response(status: int, body: bytes) -> requests.Response:
    response = requests.Response()
    response.status_code = status
    response._content = body
    return response


class TestUseLogo:
    PATH = f'/settings/design-system/references/{REF_ID}/logo'

    def test_downloads_through_the_guard_into_the_draft_and_saves_nothing(self, api_gateway_event, lambda_context, table, s3):
        _seed(table)
        fetch = MagicMock(return_value=_response(200, PNG))
        with patch.object(design_logo, 'fetch_public_url', fetch):
            response, body = _call(api_gateway_event, lambda_context, 'POST', self.PATH)
        assert response['statusCode'] == 200
        fetch.assert_called_once_with('https://kiro.dev/logo.png', timeout=10, max_redirects=3, max_bytes=2_000_001)
        assert 'logo_s3_key' not in (table.get_item(Key={'pk': 'SETTINGS#design_system', 'sk': 'config'}).get('Item') or {})
        assert body['logo_id'].startswith('logo_')
        assert body['logo_id'].endswith('.png')
        key = f'company-context/design/{body["logo_id"]}'
        obj = s3.get_object(Bucket=settings_handler.RAW_DATA_BUCKET, Key=key)
        assert obj['ContentType'] == 'image/png'
        assert key in body['logo_url']
        _, view = _call(api_gateway_event, lambda_context, 'GET', '/settings/design-system')
        assert 'logo_url' not in view   # the company logo is unchanged until Save

    def test_saving_the_design_system_with_the_logo_id_makes_it_the_logo(self, api_gateway_event, lambda_context, table, s3):
        _seed(table)
        with patch.object(design_logo, 'fetch_public_url', MagicMock(return_value=_response(200, PNG))):
            _, drafted = _call(api_gateway_event, lambda_context, 'POST', self.PATH)
        response, body = _call(api_gateway_event, lambda_context, 'PUT', '/settings/design-system',
                               {'tokens': {}, 'guidelines': 'Calm.', 'logo_id': drafted['logo_id']})
        assert response['statusCode'] == 200
        key = table.get_item(Key={'pk': 'SETTINGS#design_system', 'sk': 'config'})['Item']['logo_s3_key']
        assert key == f'company-context/design/{drafted["logo_id"]}'
        assert key in body['logo_url']
        assert s3.head_object(Bucket=settings_handler.RAW_DATA_BUCKET, Key=key)

    @pytest.mark.usefixtures('s3')
    @pytest.mark.parametrize('logo_id', ['../config.png', 'logo_0123456789ab.svg', 'logo_0123456789ab.png', 7])
    def test_a_logo_id_that_is_malformed_or_was_never_stored_is_400(self, api_gateway_event, lambda_context, table, logo_id):
        _seed(table)
        response, _ = _call(api_gateway_event, lambda_context, 'PUT', '/settings/design-system',
                            {'tokens': {}, 'guidelines': '', 'logo_id': logo_id})
        assert response['statusCode'] == 400

    @pytest.mark.usefixtures('s3')
    @pytest.mark.parametrize('failure', [
        UnsafeURLError('https://kiro.dev/logo.png', 'private'), _response(200, b'<svg onload=x>'),
        _response(200, PNG + b'0' * 2_000_000), _response(404, b''),
    ])
    def test_unsafe_wrong_type_too_large_or_missing_is_400(self, api_gateway_event, lambda_context, table, failure):
        _seed(table)
        fetch = MagicMock(side_effect=failure) if isinstance(failure, Exception) else MagicMock(return_value=failure)
        with patch.object(design_logo, 'fetch_public_url', fetch):
            response, _ = _call(api_gateway_event, lambda_context, 'POST', self.PATH)
        assert response['statusCode'] == 400
        assert 'logo_s3_key' not in (table.get_item(Key={'pk': 'SETTINGS#design_system', 'sk': 'config'}).get('Item') or {})

    @pytest.mark.usefixtures('s3')
    def test_no_candidate_is_409_and_users_are_403(self, api_gateway_event, lambda_context, table):
        _seed(table, extracted_design={**DESIGN, 'logo': None})
        assert _call(api_gateway_event, lambda_context, 'POST', self.PATH)[0]['statusCode'] == 409
        assert _call(api_gateway_event, lambda_context, 'POST', self.PATH, claims=USER)[0]['statusCode'] == 403


PREVIEW_KEY = f'company-context/design/logo_preview_{REF_ID}.png'
RENDERED_LOGO = {'source_url': 'https://kirocrew.dev/brand/logo.svg', 'content_type': 'image/png',
                 'rendered': True, 'preview_key': PREVIEW_KEY}


class TestUseRenderedLogo:
    """A reference whose SVG logo the capture worker rendered: its stored PNG is copied, the SVG never downloaded."""
    PATH = f'/settings/design-system/references/{REF_ID}/logo'

    @pytest.fixture
    def fetch(self):
        with patch.object(design_logo, 'fetch_logo') as fetch_logo:
            yield fetch_logo

    def test_the_rendered_preview_is_copied_into_the_draft(self, api_gateway_event, lambda_context, table, s3, fetch):
        _seed(table, extracted_design={**DESIGN, 'logo': RENDERED_LOGO})
        s3.put_object(Bucket=settings_handler.RAW_DATA_BUCKET, Key=PREVIEW_KEY, Body=PNG, ContentType='image/png')
        response, body = _call(api_gateway_event, lambda_context, 'POST', self.PATH)
        assert response['statusCode'] == 200
        fetch.assert_not_called()
        assert body['logo_id'].startswith('logo_')
        assert body['logo_id'].endswith('.png')
        obj = s3.get_object(Bucket=settings_handler.RAW_DATA_BUCKET, Key=f'company-context/design/{body["logo_id"]}')
        assert (obj['ContentType'], obj['Body'].read()) == ('image/png', PNG)

    @pytest.mark.usefixtures('s3')
    def test_a_missing_preview_is_409_refresh(self, api_gateway_event, lambda_context, table, fetch):
        _seed(table, extracted_design={**DESIGN, 'logo': RENDERED_LOGO})
        response, body = _call(api_gateway_event, lambda_context, 'POST', self.PATH)
        assert response['statusCode'] == 409
        assert 'Refresh the reference' in str(body)
        fetch.assert_not_called()

    @pytest.mark.parametrize('stored', [b'<svg onload="alert(1)"/>', PNG + b'0' * 2_000_000])
    def test_a_non_png_or_oversized_preview_is_refused(self, api_gateway_event, lambda_context, table, s3, fetch, stored):
        _seed(table, extracted_design={**DESIGN, 'logo': RENDERED_LOGO})
        s3.put_object(Bucket=settings_handler.RAW_DATA_BUCKET, Key=PREVIEW_KEY, Body=stored)
        response, _ = _call(api_gateway_event, lambda_context, 'POST', self.PATH)
        assert response['statusCode'] == 400
        fetch.assert_not_called()
        keys = [o['Key'] for o in s3.list_objects_v2(Bucket=settings_handler.RAW_DATA_BUCKET)['Contents']]
        assert keys == [PREVIEW_KEY]   # no drafted logo was stored


def test_logo_fetcher_refuses_http_before_any_request():
    fetch = MagicMock()
    with pytest.raises(design_logo.LogoFetchError, match='https'):
        design_logo.fetch_logo('http://kiro.dev/logo.png', fetch)
    fetch.assert_not_called()


@pytest.mark.parametrize(('data', 'expected'), [
    (PNG, 'image/png'), (b'\xff\xd8\xff\xe0', 'image/jpeg'), (b'RIFF\x00\x00\x00\x00WEBPVP8 ', 'image/webp'),
    (b'<svg/>', None), (b'GIF89a', None),
])
def test_type_is_decided_by_the_bytes(data, expected):
    assert design_logo.sniff_image_type(data) == expected


def test_logo_fetch_network_failure_is_user_safe():
    fetch = MagicMock(side_effect=requests.exceptions.ConnectionError('token=x'))
    with pytest.raises(design_logo.LogoFetchError) as exc_info:
        design_logo.fetch_logo('https://kiro.dev/l.png', fetch)
    assert str(exc_info.value) == 'The logo could not be downloaded; try again later'


# ── Components (wave 13) ──

CONFIG_KEY = {'pk': 'SETTINGS#design_system', 'sk': 'config'}
COMPONENT_BUTTON = {'name': 'Button', 'description': 'Main action', 'variants': [
    {'name': 'primary', 'styles': {'background': 'var:primary', 'color': '#ffffff', 'radius': '8px',
                                   'padding': '8px 16px'},
     'hover': {'background': '#6d28d9'}, 'focus': {'outline': '2px solid #a78bfa'}}],
    'example_html': '<button class="btn" onclick="steal()">Buy</button>'}


def test_put_stores_sanitised_components_and_everyone_reads_them(api_gateway_event, lambda_context, table):
    response, body = _call(api_gateway_event, lambda_context, 'PUT', '/settings/design-system',
                           {'tokens': {'colors': [{'name': 'primary', 'value': '#7c3aed'}]}, 'components': [COMPONENT_BUTTON]})
    assert response['statusCode'] == 200
    assert body['components'][0]['example_html'] == '<button class="btn">Buy</button>'
    stored = table.get_item(Key=CONFIG_KEY)['Item']
    assert stored['components'][0]['variants'][0]['styles']['background'] == 'var:primary'
    _, view = _call(api_gateway_event, lambda_context, 'GET', '/settings/design-system', claims=USER)
    assert view['components'] == body['components']


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize('components', [
    [{'name': 'Button', 'variants': [{'name': 'p', 'styles': {'background': 'url(javascript:alert(1))'}}]}],
    [{'name': 'Button'}, {'name': 'BUTTON'}],
    [{'name': f'c{i}'} for i in range(31)],
])
def test_invalid_components_are_400_and_nothing_is_saved(api_gateway_event, lambda_context, table, components):
    response, body = _call(api_gateway_event, lambda_context, 'PUT', '/settings/design-system',
                           {'components': components})
    assert response['statusCode'] == 400
    assert 'components' in str(body)
    assert 'Item' not in table.get_item(Key=CONFIG_KEY)


def test_a_user_cannot_write_components(api_gateway_event, lambda_context, table):
    response, _ = _call(api_gateway_event, lambda_context, 'PUT', '/settings/design-system',
                        {'components': [COMPONENT_BUTTON]}, claims=USER)
    assert response['statusCode'] == 403
    assert 'Item' not in table.get_item(Key=CONFIG_KEY)


def test_apply_merges_components_by_name_and_counts_them(api_gateway_event, lambda_context, table):
    table.put_item(Item={**CONFIG_KEY, 'guidelines': 'Calm.', 'tokens': {'colors': [], 'typography': []},
                         'components': [{'name': 'button', 'description': 'old', 'variants': []},
                                        {'name': 'Card', 'description': 'Kept', 'variants': []}]})
    table.put_item(Item={'pk': 'SETTINGS#design_system', 'sk': f'REF#{REF_ID}', 'id': REF_ID, 'kind': 'github',
                         'title': 'KiroCrew', 'status': 'ready', 'created_at': '2026', 'extracted_design': {
                             'guidelines_md': 'Quiet chrome.', 'components': [COMPONENT_BUTTON, {'name': 'Badge'}],
                             'source': 'repo_files'}})
    response, body = _call(api_gateway_event, lambda_context, 'POST',
                           f'/settings/design-system/references/{REF_ID}/apply')
    assert response['statusCode'] == 200
    assert [c['name'] for c in body['draft']['components']] == ['Button', 'Card', 'Badge']
    assert body['changes']['components'] == {'added': 1, 'replaced': 1}
    assert body['draft']['guidelines'] == 'Calm.\n\n## From KiroCrew\n\nQuiet chrome.'
    assert table.get_item(Key=CONFIG_KEY)['Item']['components'][0]['description'] == 'old'


# ── Logo candidate preview (wave 13) ──

@pytest.mark.parametrize(('preview_key', 'signed'), [
    ('company-context/design/logo_preview_ref_0123456789ab.png', True),
    ('company-context/design/logo_abc.png', False),
])
def test_get_serves_the_preview_signed_and_never_the_key(api_gateway_event, lambda_context, table, s3, preview_key,
                                                          signed):
    del s3
    _seed(table, extracted_design={**DESIGN, 'logo': {**DESIGN['logo'], 'preview_key': preview_key}})
    _, body = _call(api_gateway_event, lambda_context, 'GET', '/settings/design-system', claims=USER)
    logo = body['references'][0]['extracted_design']['logo']
    assert 'preview_key' not in logo
    assert ('preview_url' in logo) is signed
    assert preview_key in logo.get('preview_url', preview_key)


def test_the_apply_draft_never_carries_the_preview_key(api_gateway_event, lambda_context, table):
    _seed(table, extracted_design={**DESIGN, 'logo': {
        **DESIGN['logo'], 'preview_key': 'company-context/design/logo_preview_ref_0123456789ab.png'}})
    _, body = _call(api_gateway_event, lambda_context, 'POST', f'/settings/design-system/references/{REF_ID}/apply')
    assert body['draft']['logo_candidate'] == DESIGN['logo']
