"""What a mutation run of ``agentcore_browser.py`` found that ``test_web_reviews_browser.py`` could not see.

That suite proves the session lifecycle (start, connect, always stop) but never looked at WHAT is sent:

* the exact StartBrowserSession request — the session name and the viewport were free to change;
* the session-timeout bounds themselves (60 and 900 were each one off without a failure);
* what reaches the websocket opener — the signed headers (``None`` passed) and the 30 s connect timeout;
* the request that is signed: a GET of the https form of the stream URL, only the scheme rewritten;
* the region chain AWS_REGION → AWS_DEFAULT_REGION → us-east-1, and the default client / credentials
  used when none is injected;
* the wording of the client-safe refusal and of both warning log lines.

Since 7.41.00 the browser and the profile come from the environment (lib/stacks/ingestion-browser.ts):
``TestTheBrowserAndProfile`` pins that both calls name ``BROWSER_IDENTIFIER``'s browser (else
``aws.browser.v1``), that a profile is loaded at the start and saved while the session runs, before
the stop, and that an SDK without profiles, or a failed save, never costs the run.
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
from botocore.exceptions import ClientError, ParamValidationError

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


@pytest.fixture(autouse=True)
def no_browser_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    """No browser or profile named: the AWS-managed browser, no profile (a case sets what it needs)."""
    monkeypatch.delenv('BROWSER_IDENTIFIER', raising=False)
    monkeypatch.delenv('BROWSER_PROFILE_IDENTIFIER', raising=False)
    return monkeypatch


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


CUSTOM = 'voc_web_reviews-AbCdEf0123'
PROFILE = 'voc_web_reviews-Zy9876XwVu'


def _work_that_fails() -> None:
    """The work inside a browser session, failing (a helper, so what follows its ``pytest.raises`` reads as reached)."""
    raise RuntimeError('boom')


class TestTheBrowserAndProfile:
    @pytest.mark.parametrize(('value', 'expected'), [(CUSTOM, CUSTOM), ('', 'aws.browser.v1'), (None, 'aws.browser.v1')])
    def test_start_and_stop_name_the_environments_browser(
        self, no_browser_env: pytest.MonkeyPatch, value: str | None, expected: str,
    ):
        if value is not None:
            no_browser_env.setenv('BROWSER_IDENTIFIER', value)
        client = started_client()
        with browser_session(300, client=client, opener=Opened(), credentials=PASSED):
            pass
        assert client.start_browser_session.call_args.kwargs['browserIdentifier'] == expected
        client.stop_browser_session.assert_called_once_with(browserIdentifier=expected, sessionId='s-9')
        assert 'profileConfiguration' not in client.start_browser_session.call_args.kwargs
        client.save_browser_session_profile.assert_not_called()

    def test_a_profile_is_loaded_and_saved_while_the_session_runs(self, no_browser_env: pytest.MonkeyPatch):
        no_browser_env.setenv('BROWSER_IDENTIFIER', CUSTOM)
        no_browser_env.setenv('BROWSER_PROFILE_IDENTIFIER', PROFILE)
        client = started_client()
        opened = Opened()
        order: list[str] = []
        client.save_browser_session_profile.side_effect = lambda **_kw: order.append('save')
        opened.socket.close.side_effect = lambda: order.append('close')
        client.stop_browser_session.side_effect = lambda **_kw: order.append('stop')
        with browser_session(420, client=client, opener=opened, credentials=PASSED):
            pass
        client.start_browser_session.assert_called_once_with(
            browserIdentifier=CUSTOM, name='voc-web-reviews', sessionTimeoutSeconds=420,
            viewPort={'width': 1366, 'height': 900}, profileConfiguration={'profileIdentifier': PROFILE},
        )
        client.save_browser_session_profile.assert_called_once_with(
            profileIdentifier=PROFILE, browserIdentifier=CUSTOM, sessionId='s-9')
        assert order == ['save', 'close', 'stop']

    def test_the_profile_is_saved_when_the_work_fails(self, no_browser_env: pytest.MonkeyPatch):
        no_browser_env.setenv('BROWSER_PROFILE_IDENTIFIER', PROFILE)
        client = started_client()
        with pytest.raises(RuntimeError, match='boom'), \
                browser_session(300, client=client, opener=Opened(), credentials=PASSED):
            _work_that_fails()
        client.save_browser_session_profile.assert_called_once()
        client.stop_browser_session.assert_called_once()

    def test_a_failed_save_is_logged_and_the_session_still_stopped(self, no_browser_env: pytest.MonkeyPatch):
        no_browser_env.setenv('BROWSER_PROFILE_IDENTIFIER', PROFILE)
        client = started_client()
        client.save_browser_session_profile.side_effect = client_error('ConflictException', 'saving', 'SaveBrowserSessionProfile')
        with patch.object(agentcore_browser, 'logger') as logger, \
                browser_session(300, client=client, opener=Opened(), credentials=PASSED):
            pass
        logger.warning.assert_called_once_with(
            'SaveBrowserSessionProfile failed: An error occurred (ConflictException) '
            'when calling the SaveBrowserSessionProfile operation: saving')
        client.stop_browser_session.assert_called_once_with(browserIdentifier='aws.browser.v1', sessionId='s-9')

    def test_an_sdk_without_profiles_starts_without_one_and_saves_nothing(self, no_browser_env: pytest.MonkeyPatch):
        no_browser_env.setenv('BROWSER_PROFILE_IDENTIFIER', PROFILE)
        client = started_client()
        session = client.start_browser_session.return_value
        refused = ParamValidationError(report='Unknown parameter in input: "profileConfiguration"')
        client.start_browser_session.side_effect = [refused, session]
        with patch.object(agentcore_browser, 'logger') as logger, \
                browser_session(300, client=client, opener=Opened(), credentials=PASSED):
            pass
        first, second = client.start_browser_session.call_args_list
        assert first.kwargs['profileConfiguration'] == {'profileIdentifier': PROFILE}
        assert 'profileConfiguration' not in second.kwargs
        client.save_browser_session_profile.assert_not_called()
        [(message,), _] = logger.warning.call_args
        assert message.startswith('StartBrowserSession without the browser profile, which this SDK does not know: ')

    def test_a_refused_start_without_a_profile_is_not_retried(self):
        client = MagicMock()
        client.start_browser_session.side_effect = ParamValidationError(report='Invalid type')
        with pytest.raises(BrowserUnavailableError), browser_session(300, client=client):
            pytest.fail('the body must not run without a session')
        client.start_browser_session.assert_called_once()
