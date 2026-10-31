"""shared.http_cache through create_api_resolver: ETag / 304 / Cache-Control (docs/caching.md)."""
from __future__ import annotations

import hashlib
import re
from unittest.mock import MagicMock

import pytest
from aws_lambda_powertools.event_handler import Response, content_types

from shared.api import create_api_resolver
from shared.exceptions import NotFoundError
from shared.http_cache import etag_for, is_no_store_path, matches_if_none_match

ORIGIN = 'http://localhost:5173'
BODY = {'total': 3, 'items': ['a']}


def _app():
    app = create_api_resolver(ORIGIN)

    @app.get('/metrics/summary')
    def summary():
        return BODY

    @app.get('/chat/conversations/<cid>')
    def conversation(cid: str):
        return {'id': cid}

    @app.get('/missing')
    def missing():
        raise NotFoundError('nope')

    @app.get('/accepted')
    def accepted():
        return Response(status_code=202, content_type=content_types.APPLICATION_JSON, body='{"job":1}')

    @app.put('/metrics/summary')
    def put_summary():
        return BODY

    return app


def _call(path: str, method: str = 'GET', if_none_match: str | None = None) -> dict:
    headers = {'Origin': ORIGIN, **({'If-None-Match': if_none_match} if if_none_match else {})}
    return _app().resolve({'httpMethod': method, 'path': path, 'headers': headers, 'requestContext': {}}, MagicMock())


def _header(response: dict, name: str) -> str | None:
    values = response['multiValueHeaders'].get(name)
    return values[0] if values else None


class TestTaggedGet:
    def test_a_get_200_carries_a_weak_sha256_tag_of_its_body(self):
        response = _call('/metrics/summary')
        digest = hashlib.sha256(response['body'].encode()).hexdigest()[:32]
        assert _header(response, 'ETag') == f'W/"{digest}"'
        assert re.fullmatch(r'W/"[0-9a-f]{32}"', _header(response, 'ETag') or '')

    def test_it_must_be_revalidated_and_varies_by_credential(self):
        response = _call('/metrics/summary')
        assert _header(response, 'Cache-Control') == 'private, no-cache'
        assert _header(response, 'Vary') == 'Authorization'
        assert 'max-age' not in (_header(response, 'Cache-Control') or '')

    def test_a_matching_if_none_match_is_a_304_with_no_body(self):
        etag = _header(_call('/metrics/summary'), 'ETag')
        response = _call('/metrics/summary', if_none_match=etag)
        assert response['statusCode'] == 304
        assert response['body'] == ''
        assert _header(response, 'ETag') == etag

    def test_the_304_keeps_the_cors_headers(self):
        etag = _header(_call('/metrics/summary'), 'ETag')
        response = _call('/metrics/summary', if_none_match=etag)
        assert _header(response, 'Access-Control-Allow-Origin') == ORIGIN
        assert 'ETag' in (_header(response, 'Access-Control-Expose-Headers') or '')

    def test_a_stale_tag_gets_the_full_answer(self):
        response = _call('/metrics/summary', if_none_match='W/"0000"')
        assert response['statusCode'] == 200
        assert response['body']


class TestNosniff:
    """Every answer, of every method and status, says nosniff (EDGE-8)."""

    @pytest.mark.parametrize(('path', 'method'), [
        ('/metrics/summary', 'GET'), ('/metrics/summary', 'PUT'), ('/missing', 'GET'), ('/no-such-route', 'GET'),
    ])
    def test_every_answer_is_nosniff(self, path, method):
        assert _header(_call(path, method=method), 'X-Content-Type-Options') == 'nosniff'

    def test_a_304_is_nosniff_too(self):
        etag = _header(_call('/metrics/summary'), 'ETag')
        assert _header(_call('/metrics/summary', if_none_match=etag), 'X-Content-Type-Options') == 'nosniff'


class TestNotTagged:
    @pytest.mark.parametrize('path', ['/chat/conversations/c1', '/missing', '/accepted'])
    def test_live_state_errors_and_non_200s_are_no_store_without_a_tag(self, path):
        response = _call(path)
        assert _header(response, 'Cache-Control') == 'private, no-store'
        assert _header(response, 'ETag') is None

    def test_other_methods_are_left_alone(self):
        response = _call('/metrics/summary', method='PUT')
        assert _header(response, 'ETag') is None
        assert _header(response, 'Cache-Control') is None


class TestNoStorePaths:
    @pytest.mark.parametrize('path', [
        '/chat/conversations/_list', '/agents/a1/runs', '/agents/a1/runs/r1/events', '/agents/plans',
        '/agents/plans/p1', '/projects/p1/jobs', '/projects/p1/jobs/j1', '/settings/jobs/j1', '/scrapers/jobs/j1',
        '/settings/my-briefing', '/settings/my-briefing/brief', '/settings/categories/reprocess',
        '/settings/erasure', '/scrapers/manual/parse/j1',
        '/scrapers/s1/status', '/sources/status', '/connect/tokens',
        '/memory/imports/imp_1', '/logs/system',
    ])
    def test_per_user_live_routes(self, path):
        assert is_no_store_path(path) is True

    @pytest.mark.parametrize('path', [
        '/metrics/summary', '/feedback', '/feedback/urgent', '/radar', '/radar/brands/acme/reviews',
        '/settings/categories', '/agents', '/projects/p1', '/voting-sessions/v1/config',
        '/logs/processing',
    ])
    def test_shared_reads_are_revalidated(self, path):
        assert is_no_store_path(path) is False


class TestIfNoneMatch:
    TAG = etag_for('{"a":1}')

    @pytest.mark.parametrize('header', [TAG, TAG[2:], f'W/"x", {TAG}', '*'])
    def test_weak_comparison_lists_and_star(self, header):
        assert matches_if_none_match(header, self.TAG) is True

    @pytest.mark.parametrize('header', [None, '', 'W/"other"'])
    def test_no_match(self, header):
        assert matches_if_none_match(header, self.TAG) is False
