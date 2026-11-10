"""What a mutation run of ``agentcore_browser.py`` found that ``test_web_reviews_browser.py`` could not see.

That suite proves the session lifecycle (start, connect, always stop) but never looked at WHAT is sent:

* the exact StartBrowserSession request — the session name and the viewport were free to change;
* the session-timeout bounds themselves (60 and 900 were each one off without a failure);
* what reaches the websocket opener — the signed headers (``None`` passed) and the 30 s connect timeout;
* the request that is signed: a GET of the https form of the stream URL, only the scheme rewritten;
* the region chain AWS_REGION → AWS_DEFAULT_REGION → us-east-1, and the default client / credentials
  used when none is injected;
* the wording of the client-safe refusal and of both warning log lines.
"""
from typing import Any
from unittest.mock import MagicMock, patch

import agentcore_browser
import pytest
from agentcore_browser import (
    BrowserUnavailableError,
    browser_session,
    session_seconds,
    signed_handshake_headers,
)
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials
from botocore.exceptions import ClientError

STREAM = 'wss://bedrock-agentcore.eu-west-1.amazonaws.com/browser-streams/aws.browser.v1/sessions/s-9/automation'
PASSED = Credentials('AKIDPASSED', 'secret')
FROM_SESSION = Credentials('AKIDSESSION', 'secret')


class Opened:
    """An opener that records its arguments and hands back an inert socket."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any, float]] = []
        self.socket = MagicMock()

    def __call__(self, url: str, headers: Any, timeout: float) -> MagicMock:
        self.calls.append((url, headers, timeout))
        return self.socket


def started_client(session_id: str = 's-9') -> MagicMock:
    client = MagicMock()
    client.start_browser_session.return_value = {
        'sessionId': session_id, 'streams': {'automationStream': {'streamEndpoint': STREAM}},
    }
    return client


def client_error(code: str, message: str, operation: str) -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': message}}, operation)


def refusing_client() -> MagicMock:
    client = MagicMock()
    client.start_browser_session.side_effect = client_error('AccessDeniedException', 'no', 'StartBrowserSession')
    return client


@pytest.fixture
def region(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    monkeypatch.delenv('AWS_REGION', raising=False)
    monkeypatch.delenv('AWS_DEFAULT_REGION', raising=False)
    return monkeypatch


class TestTheStartRequest:
    def test_is_exactly_the_documented_request(self):
        client = started_client()
        with browser_session(420, client=client, opener=Opened(), credentials=PASSED):
            pass
        client.start_browser_session.assert_called_once_with(
            browserIdentifier='aws.browser.v1', name='voc-web-reviews',
            sessionTimeoutSeconds=420, viewPort={'width': 1366, 'height': 900},
        )

    @pytest.mark.parametrize(('remaining', 'expected'), [(59.9, 60), (60, 60), (61, 61), (899, 899), (900, 900), (901, 900)])
    def test_the_timeout_bounds_are_60_and_900_inclusive(self, remaining: float, expected: int):
        assert session_seconds(remaining) == expected


class TestWhatReachesTheOpener:
    def test_the_stream_url_signed_headers_and_a_30_second_timeout(self):
        opened = Opened()
        with browser_session(300, client=started_client(), opener=opened, credentials=PASSED):
            pass
        [(url, headers, timeout)] = opened.calls
        assert (url, timeout) == (STREAM, 30.0)
        assert headers['host'] == 'bedrock-agentcore.eu-west-1.amazonaws.com'
        assert headers['Authorization'].startswith('AWS4-HMAC-SHA256 Credential=AKIDPASSED/')

    def test_injected_credentials_are_used_without_a_boto3_session(self):
        with patch.object(agentcore_browser.boto3, 'Session') as boto_session, \
                browser_session(300, client=started_client(), opener=Opened(), credentials=PASSED):
            pass
        boto_session.assert_not_called()

    def test_without_credentials_the_default_session_signs(self):
        opened = Opened()
        with patch.object(agentcore_browser.boto3, 'Session') as boto_session:
            boto_session.return_value.get_credentials.return_value = FROM_SESSION
            with browser_session(300, client=started_client(), opener=opened):
                pass
        boto_session.assert_called_once_with()
        assert opened.calls[0][1]['Authorization'].startswith('AWS4-HMAC-SHA256 Credential=AKIDSESSION/')


class TestTheSignedRequest:
    def test_is_a_get_of_the_https_url_with_only_the_scheme_rewritten(self):
        url = 'wss://h.example.com/automation?next=wss://elsewhere'
        with patch.object(agentcore_browser, 'AWSRequest', wraps=AWSRequest) as request:
            signed_handshake_headers(url, 'eu-west-1', PASSED)
        request.assert_called_once_with(
            method='GET', url='https://h.example.com/automation?next=wss://elsewhere',
            headers={'host': 'h.example.com'},
        )


class TestTheRegion:
    @pytest.mark.parametrize(('env', 'expected'), [
        ({'AWS_REGION': 'eu-west-1', 'AWS_DEFAULT_REGION': 'ap-south-1'}, 'eu-west-1'),
        ({'AWS_REGION': 'eu-west-1'}, 'eu-west-1'),
        ({'AWS_DEFAULT_REGION': 'ap-south-1'}, 'ap-south-1'),
        ({}, 'us-east-1'),
    ])
    def test_names_the_region_in_the_refusal(self, region: pytest.MonkeyPatch, env: dict[str, str], expected: str):
        for name, value in env.items():
            region.setenv(name, value)
        with pytest.raises(BrowserUnavailableError) as raised, browser_session(300, client=refusing_client()):
            pytest.fail('the body must not run without a session')
        assert str(raised.value) == f'AgentCore Browser is unavailable in {expected}'

    def test_the_default_client_is_bedrock_agentcore_in_that_region(self, region: pytest.MonkeyPatch):
        region.setenv('AWS_REGION', 'eu-west-1')
        with patch.object(agentcore_browser.boto3, 'client', return_value=started_client()) as make_client, \
                browser_session(300, opener=Opened(), credentials=PASSED):
            pass
        make_client.assert_called_once_with('bedrock-agentcore', region_name='eu-west-1')


class TestTheLogLines:
    def test_a_refused_start_is_logged_with_region_and_error(self, region: pytest.MonkeyPatch):
        region.setenv('AWS_REGION', 'eu-west-1')
        with patch.object(agentcore_browser, 'logger') as logger, pytest.raises(BrowserUnavailableError), \
                browser_session(300, client=refusing_client()):
            pytest.fail('the body must not run without a session')
        logger.warning.assert_called_once_with(
            'StartBrowserSession failed in eu-west-1: An error occurred (AccessDeniedException) '
            'when calling the StartBrowserSession operation: no')

    def test_a_failed_stop_is_logged_and_swallowed(self):
        client = started_client()
        client.stop_browser_session.side_effect = client_error('ResourceNotFoundException', 'gone', 'StopBrowserSession')
        with patch.object(agentcore_browser, 'logger') as logger, \
                browser_session(300, client=client, opener=Opened(), credentials=PASSED):
            pass
        logger.warning.assert_called_once_with(
            'StopBrowserSession failed: An error occurred (ResourceNotFoundException) '
            'when calling the StopBrowserSession operation: gone')
