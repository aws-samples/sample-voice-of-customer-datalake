"""shared/realtime.py: the signed publish request, best effort on every failure, a no-op without an endpoint."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
import requests
from botocore.credentials import Credentials

from shared import realtime

HOST = 'abc123.appsync-api.us-east-1.amazonaws.com'
SUB = '0a1b2c3d-1111-4222-8333-444455556666'


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv(realtime.HTTP_DNS_ENV, raising=False)
    monkeypatch.setenv('AWS_REGION', 'us-east-1')


@pytest.fixture
def credentials():
    session = MagicMock()
    session.get_credentials.return_value = Credentials('AKIDEXAMPLE', 'secret-example', 'token-example')
    session.region_name = 'us-east-1'
    with patch.object(realtime.boto3, 'Session', return_value=session):
        yield session


@pytest.fixture
def post():
    with patch.object(realtime.requests, 'post') as fake:
        fake.return_value = MagicMock(ok=True, status_code=200)
        yield fake


class TestNotConfigured:
    def test_without_an_endpoint_nothing_is_sent(self, post):
        assert realtime.configured() is False
        assert realtime.publish('jobs', SUB, {'type': 'job'}) is False
        post.assert_not_called()

    def test_a_malformed_host_is_no_endpoint(self, monkeypatch, post):
        monkeypatch.setenv(realtime.HTTP_DNS_ENV, 'https://evil.example/x')
        assert realtime.publish('jobs', SUB, {'type': 'job'}) is False
        post.assert_not_called()


@pytest.mark.usefixtures('credentials')
class TestPublish:
    def test_posts_one_signed_event_to_the_callers_own_channel(self, monkeypatch, post):
        monkeypatch.setenv(realtime.HTTP_DNS_ENV, HOST)
        assert realtime.publish('jobs', SUB, {'type': 'job', 'job_id': 'job_1', 'status': 'completed'}) is True
        url = post.call_args.args[0]
        kwargs = post.call_args.kwargs
        assert url == f'https://{HOST}/event'
        body = json.loads(kwargs['data'])
        assert body['channel'] == f'/jobs/{SUB}'
        assert [json.loads(event) for event in body['events']] == [{'type': 'job', 'job_id': 'job_1', 'status': 'completed'}]
        headers = kwargs['headers']
        assert headers['Authorization'].startswith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/')
        assert '/us-east-1/appsync/aws4_request' in headers['Authorization']
        assert headers['X-Amz-Security-Token'] == 'token-example'
        assert kwargs['timeout'] == realtime.TIMEOUT_SECONDS

    @pytest.mark.parametrize(('namespace', 'sub'), [
        ('other', SUB), ('jobs', ''), ('jobs', None), ('jobs', 'a/b'), ('jobs', '*'), ('jobs', 'heartbeat x'),
    ])
    def test_refuses_an_unknown_namespace_or_a_value_that_is_not_a_sub(self, monkeypatch, post, namespace, sub):
        monkeypatch.setenv(realtime.HTTP_DNS_ENV, HOST)
        assert realtime.publish(namespace, sub, {'type': 'job'}) is False
        post.assert_not_called()

    def test_a_network_failure_is_logged_never_raised(self, monkeypatch, post):
        monkeypatch.setenv(realtime.HTTP_DNS_ENV, HOST)
        post.side_effect = requests.ConnectionError('down')
        assert realtime.publish('chat', SUB, {'type': 'session'}) is False

    def test_a_refusal_is_reported_as_not_sent(self, monkeypatch, post):
        monkeypatch.setenv(realtime.HTTP_DNS_ENV, HOST)
        post.return_value = MagicMock(ok=False, status_code=403)
        assert realtime.publish('runs', SUB, {'type': 'run'}) is False

    def test_no_credentials_is_not_sent(self, monkeypatch, post, credentials):
        monkeypatch.setenv(realtime.HTTP_DNS_ENV, HOST)
        credentials.get_credentials.return_value = None
        assert realtime.publish('jobs', SUB, {'type': 'job'}) is False
        post.assert_not_called()

    def test_an_ssm_reference_is_no_endpoint(self, monkeypatch, post):
        # The 6.04.00 pre-release form (`ssm:<parameter>`) is gone: such a value is not a host.
        monkeypatch.setenv(realtime.HTTP_DNS_ENV, 'ssm:/voc/realtime/event-api-http-dns')
        assert realtime.configured() is False
        assert realtime.publish('runs', SUB, {'type': 'run'}) is False
        post.assert_not_called()
