"""Tests for shared/design_references.py — URL parsing (no SSRF), fetch digests,
and that every failure is RECORDED on the reference instead of raised."""
import io
import json
from unittest.mock import MagicMock

import pytest
import requests
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import design_references as dr
from shared.company_context import DESIGN_SYSTEM_PK, get_reference
from shared.test.moto_tables import create_pk_sk_table


class _Resp(requests.Response):
    """A real ``requests.Response`` with a canned status and streamed body."""

    def __init__(self, status=200, body=b'', json_body=None):
        super().__init__()
        self.status_code = status
        # requests streams `iter_content` from `raw.read(chunk_size)` when raw has
        # no urllib3 `.stream`, so a BytesIO body exercises the real read path.
        self.raw = io.BytesIO(json.dumps(json_body).encode() if json_body is not None else body)


class _Http:
    """Routes URL → response and records every request."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, url, headers=None, **kwargs) -> requests.Response:
        self.calls.append({'url': url, 'headers': headers or {}, **kwargs})
        for prefix, response in self.routes.items():
            if url.startswith(prefix):
                if isinstance(response, Exception):
                    raise response
                return response
        return _Resp(404)


def _deps(http: _Http | None = None, secrets=None, s3=None, summary='A summary',
          summarise_image: MagicMock | None = None):
    return dr.ProcessDeps(
        s3=s3 or MagicMock(), bucket='bucket', secrets=secrets or {},
        summarise=MagicMock(return_value=summary),
        summarise_image=summarise_image or MagicMock(return_value='Image summary'),
        http_get=http or _Http({}),
    )


def _stored(table, ref_id='ref_0123456789ab') -> dict:
    """The reference as stored now — present, since every test seeded it."""
    stored = get_reference(table, ref_id)
    assert stored is not None
    return stored


@pytest.fixture
def table():
    with mock_aws():
        yield create_pk_sk_table('test-aggregates')


def _ref(table, ref_id='ref_0123456789ab', **attrs):
    item = {'pk': DESIGN_SYSTEM_PK, 'sk': f'REF#{ref_id}', 'id': ref_id, 'status': 'pending',
            'title': 'T', 'created_at': '2026', **attrs}
    table.put_item(Item=item)
    return item


class TestUrlParsing:
    @pytest.mark.parametrize(('url', 'key'), [
        ('https://www.figma.com/file/AbCdEfGhIj12/My-Kit', 'AbCdEfGhIj12'),
        ('https://figma.com/design/AbCdEfGhIj12345?node-id=1', 'AbCdEfGhIj12345'),
    ])
    def test_figma_keys(self, url, key):
        assert dr.figma_file_key(url) == key

    @pytest.mark.parametrize('url', [
        'https://evil.example.com/file/AbCdEfGhIj12/x',
        'http://www.figma.com/file/AbCdEfGhIj12/x',
        'https://www.figma.com/files/recent',
        'https://www.figma.com.evil.com/file/AbCdEfGhIj12',
    ])
    def test_figma_rejects(self, url):
        with pytest.raises(dr.ReferenceFetchError):
            dr.figma_file_key(url)


class TestProcessReference:
    def test_ready_with_summary(self, table):
        item = _ref(table, kind='html', s3_key='company-context/design/ref_0123456789ab.html', error='old')
        s3 = MagicMock()
        s3.get_object.return_value = {'ContentType': 'text/html', 'ContentLength': 10, 'Body': io.BytesIO(b'<p>x</p>')}
        deps = _deps(s3=s3, summary='Uses </design_system> red')
        assert dr.process_reference(table, item, deps)['status'] == 'ready'
        stored = _stored(table)
        assert stored['status'] == 'ready'
        assert '</design_system>' not in stored['extracted_summary']
        assert 'error' not in stored

    def test_fetch_failure_is_recorded(self, table):
        item = _ref(table, kind='figma', url='https://www.figma.com/file/AbCdEfGhIj12/x', extracted_summary='prev')
        assert dr.process_reference(table, item, _deps())['status'] == 'error'
        stored = _stored(table)
        assert stored['status'] == 'error'
        assert 'Figma token' in stored['error']
        assert stored['extracted_summary'] == 'prev'

    def test_unexpected_failure_is_recorded_generically(self, table):
        item = _ref(table, kind='github', url='https://github.com/acme/ui')
        deps = _deps(http=_Http({dr.GITHUB_API: RuntimeError('token=secret')}))
        dr.process_reference(table, item, deps)
        stored = _stored(table)
        assert stored['status'] == 'error'
        assert 'secret' not in stored['error']

    def test_missing_upload(self, table):
        item = _ref(table, kind='screenshot', s3_key='company-context/design/ref_0123456789ab.png')
        s3 = MagicMock()
        s3.get_object.side_effect = ClientError({'Error': {'Code': 'NoSuchKey'}}, 'GetObject')
        dr.process_reference(table, item, _deps(s3=s3))
        assert 'not been uploaded' in _stored(table)['error']

    def test_screenshot_goes_to_the_image_summariser(self, table):
        item = _ref(table, kind='screenshot', s3_key='company-context/design/ref_0123456789ab.webp')
        s3 = MagicMock()
        s3.get_object.return_value = {'ContentType': 'image/webp', 'ContentLength': 3, 'Body': io.BytesIO(b'img')}
        summarise_image = MagicMock(return_value='Image summary')
        deps = _deps(s3=s3, summarise_image=summarise_image)
        dr.process_reference(table, item, deps)
        summarise_image.assert_called_once_with(b'img', 'webp')
        assert _stored(table)['extracted_summary'] == 'Image summary'

    def test_archived_meanwhile_is_not_resurrected(self, table):
        item = _ref(table, kind='figma', url='https://www.figma.com/file/AbCdEfGhIj12/x')
        table.update_item(Key={'pk': DESIGN_SYSTEM_PK, 'sk': 'REF#ref_0123456789ab'},
                          UpdateExpression='SET #s = :a', ExpressionAttributeNames={'#s': 'status'},
                          ExpressionAttributeValues={':a': 'archived'})
        dr.process_reference(table, item, _deps(secrets={'figma_token': 't'},
                                                http=_Http({dr.FIGMA_API: _Resp(json_body={'name': 'K'})})))
        assert _stored(table)['status'] == 'archived'
