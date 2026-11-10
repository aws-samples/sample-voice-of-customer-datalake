"""The browser layer without AWS: the CDP client over a fake websocket, the session lifecycle, one tab."""
import json
import shutil
import subprocess
from collections.abc import Callable
from typing import Any
from unittest.mock import MagicMock

import pytest
from agentcore_browser import (
    BROWSER_IDENTIFIER,
    MAX_SESSION_SECONDS,
    MIN_SESSION_SECONDS,
    BrowserUnavailableError,
    browser_session,
    session_seconds,
    signed_handshake_headers,
)
from block_detection import blocked_by
from botocore.credentials import Credentials
from botocore.exceptions import ClientError
from cdp_client import MAX_MESSAGE_CHARS, CdpConnection, CdpError
from page_reader import (
    MAX_JSONLD_BLOCKS,
    MAX_JSONLD_CHARS,
    MAX_JSONLD_TOTAL_CHARS,
    SNAPSHOT_JS,
    BrowserTab,
    PageLoadError,
)

STREAM = 'wss://bedrock-agentcore.us-east-1.amazonaws.com/browser-streams/aws.browser.v1/sessions/s-1/automation'
CREDENTIALS = Credentials('AKIDEXAMPLE', 'secret')


class FakeSocket:
    """Answers each sent command with ``responder(message)`` (a list of raw frames), in order."""

    def __init__(self, responder: Callable[[dict[str, Any]], list[str]]):
        self.responder = responder
        self.sent: list[dict[str, Any]] = []
        self.inbox: list[str] = []
        self.closed = False
        self.timeouts: list[float] = []

    def send(self, payload: str, /) -> None:
        message = json.loads(payload)
        self.sent.append(message)
        self.inbox.extend(self.responder(message))

    def recv(self) -> str:
        if not self.inbox:
            raise TimeoutError
        return self.inbox.pop(0)

    def settimeout(self, timeout: float, /) -> None:
        self.timeouts.append(timeout)

    def close(self) -> None:
        self.closed = True


def reply(message: dict[str, Any], result: dict[str, Any]) -> str:
    return json.dumps({'id': message['id'], 'result': result})


class TestCdpConnection:
    def test_skips_events_and_stale_replies(self):
        socket = FakeSocket(lambda m: [
            json.dumps({'method': 'Page.loadEventFired', 'params': {}}), 'not json',
            json.dumps({'id': 999, 'result': {}}), reply(m, {'ok': True}),
        ])
        assert CdpConnection(socket).call('Page.enable') == {'ok': True}

    def test_addresses_the_attached_target(self):
        socket = FakeSocket(lambda m: [reply(m, {})])
        CdpConnection(socket).call('Runtime.evaluate', {'expression': '1'}, session_id='tab-1')
        assert socket.sent[0] == {'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': '1'}, 'sessionId': 'tab-1'}

    def test_the_deadline_bounds_every_wait(self):
        ticks = iter([0.0, 0.0, 5.0])
        socket = FakeSocket(lambda _m: [json.dumps({'method': 'event'})])
        with pytest.raises(CdpError, match='timed out'):
            CdpConnection(socket, clock=lambda: next(ticks)).call('Page.navigate', timeout=2)
        assert socket.timeouts == [2.0]


def agentcore_client() -> MagicMock:
    client = MagicMock()
    client.start_browser_session.return_value = {
        'sessionId': 's-1', 'streams': {'automationStream': {'streamEndpoint': STREAM}},
    }
    return client


class TestBrowserSession:
    def test_yields_a_connection_and_stops_the_session(self):
        client = agentcore_client()
        socket = FakeSocket(lambda m: [reply(m, {})])
        with browser_session(300, client=client, opener=lambda *_a: socket, credentials=CREDENTIALS) as cdp:
            cdp.call('Page.enable')
        client.stop_browser_session.assert_called_once_with(browserIdentifier=BROWSER_IDENTIFIER, sessionId='s-1')
        assert socket.closed

    def test_the_connection_names_its_browser_session_for_the_logs(self):
        socket = FakeSocket(lambda m: [reply(m, {})])
        with browser_session(300, client=agentcore_client(), opener=lambda *_a: socket, credentials=CREDENTIALS) as cdp:
            assert cdp.browser_session_id == 's-1'

    def test_the_session_is_stopped_when_the_work_fails(self):
        client = agentcore_client()

        def boom() -> None:
            raise RuntimeError('boom')

        with pytest.raises(RuntimeError, match='boom'), \
                browser_session(300, client=client, opener=lambda *_a: FakeSocket(lambda _m: []), credentials=CREDENTIALS):
            boom()
        client.stop_browser_session.assert_called_once()

    def test_the_session_is_stopped_when_the_connection_fails(self):
        client = agentcore_client()

        def refuse(*_args: object) -> FakeSocket:
            raise ConnectionError('handshake refused')

        with pytest.raises(ConnectionError), browser_session(300, client=client, opener=refuse, credentials=CREDENTIALS):
            pytest.fail('the body must not run without a connection')
        client.stop_browser_session.assert_called_once()

    def test_the_session_is_stopped_when_a_reply_is_oversized(self):
        client = agentcore_client()
        socket = FakeSocket(lambda m: [json.dumps({'id': m['id'], 'result': {'v': 'x' * MAX_MESSAGE_CHARS}})])
        with pytest.raises(CdpError, match='too large'), \
                browser_session(300, client=client, opener=lambda *_a: socket, credentials=CREDENTIALS) as cdp:
            cdp.call('Runtime.evaluate')
        client.stop_browser_session.assert_called_once()

    def test_a_refused_start_is_reported_as_unavailable(self):
        client = MagicMock()
        client.start_browser_session.side_effect = ClientError(
            {'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'StartBrowserSession')
        with pytest.raises(BrowserUnavailableError, match='unavailable'), browser_session(300, client=client):
            pytest.fail('the body must not run without a session')
        client.stop_browser_session.assert_not_called()

    @pytest.mark.parametrize(('remaining', 'expected'), [(10, MIN_SESSION_SECONDS), (500.7, 500), (5000, MAX_SESSION_SECONDS)])
    def test_session_timeout_follows_the_lambda(self, remaining, expected):
        assert session_seconds(remaining) == expected

    def test_handshake_is_sigv4_signed_for_agentcore(self):
        headers = signed_handshake_headers(STREAM, 'us-east-1', CREDENTIALS)
        assert '/us-east-1/bedrock-agentcore/aws4_request' in headers['Authorization']
        assert headers['host'] == 'bedrock-agentcore.us-east-1.amazonaws.com'


def snapshot_value(**fields: Any) -> str:
    base = {'status': 200, 'url': 'https://reviews.example.com/r', 'title': 'Reviews', 'text': 'x' * 600,
            'html': '<html></html>', 'ld': [], 'next': None}
    return json.dumps({**base, **fields})


def tab_socket(evaluations: Callable[[str], object], navigate: dict[str, Any] | None = None) -> FakeSocket:
    def respond(message: dict[str, Any]) -> list[str]:
        method = message['method']
        if method == 'Target.createTarget':
            return [reply(message, {'targetId': 't-1'})]
        if method == 'Target.attachToTarget':
            return [reply(message, {'sessionId': 'tab-1'})]
        if method == 'Page.navigate':
            return [reply(message, navigate or {'frameId': 'f'})]
        if method == 'Runtime.evaluate':
            return [reply(message, {'result': {'type': 'string', 'value': evaluations(message['params']['expression'])}})]
        return [reply(message, {})]
    return FakeSocket(respond)


def opened_tab(socket: FakeSocket) -> BrowserTab:
    tab = BrowserTab(CdpConnection(socket), sleep=lambda _s: None)
    tab.open()
    return tab


def evaluator(location: str = 'https://reviews.example.com/r') -> Callable[[str], object]:
    def evaluate(expression: str) -> object:
        if expression.startswith('JSON.stringify([document.readyState'):
            return json.dumps(['complete', 600])
        if expression == 'location.href':
            return location
        return snapshot_value(next='https://reviews.example.com/r?page=2')
    return evaluate


class TestBrowserTab:
    def test_load_waits_for_a_settled_page_and_reads_it(self):
        snapshot = opened_tab(tab_socket(evaluator())).load('https://reviews.example.com/r')
        assert (snapshot.status, snapshot.next_url) == (200, 'https://reviews.example.com/r?page=2')

    def test_a_failed_navigation_raises(self):
        tab = opened_tab(tab_socket(evaluator(), navigate={'errorText': 'net::ERR_NAME_NOT_RESOLVED'}))
        with pytest.raises(PageLoadError, match='ERR_NAME_NOT_RESOLVED'):
            tab.load('https://reviews.example.com/r')

    def test_an_http_error_page_is_still_read_for_block_detection(self):
        def evaluate(expression: str) -> object:
            return snapshot_value(status=403, text='Please enable JS', next=None) if ')("navigate"' in expression else ''

        tab = opened_tab(tab_socket(evaluate, navigate={'errorText': 'net::ERR_HTTP_RESPONSE_CODE_FAILURE'}))
        assert blocked_by(tab.load('https://reviews.example.com/r').signals()) == 'HTTP 403'

    def test_a_same_origin_page_is_fetched_in_the_page(self):
        socket = tab_socket(evaluator())
        opened_tab(socket).fetch('https://reviews.example.com/r?page=2')
        assert not [m for m in socket.sent if m['method'] == 'Page.navigate']

    def test_another_origin_is_navigated_to(self):
        socket = tab_socket(evaluator(location='https://other.example.org/'))
        opened_tab(socket).fetch('https://reviews.example.com/r?page=2')
        assert [m['params']['url'] for m in socket.sent if m['method'] == 'Page.navigate'] == [
            'https://reviews.example.com/r?page=2']

    def test_a_failed_in_page_fetch_falls_back_to_navigating(self):
        def evaluate(expression: str) -> object:
            if ')("fetch"' in expression:  # the snapshot called in fetch mode
                return json.dumps({'error': 'TypeError'})
            return evaluator()(expression)

        socket = tab_socket(evaluate)
        opened_tab(socket).fetch('https://reviews.example.com/r?page=2')
        assert len([m for m in socket.sent if m['method'] == 'Page.navigate']) == 1



class TestJsonLdCaps:
    def test_an_oversized_snapshot_fails_the_page_not_the_lambda(self):
        socket = tab_socket(lambda e: json.dumps(['complete', 600]) if 'readyState' in e else 'x' * MAX_MESSAGE_CHARS)
        with pytest.raises(PageLoadError, match='did not answer'):
            opened_tab(socket).load('https://reviews.example.com/r')


NODE = shutil.which('node') or ''
#: Runs SNAPSHOT_JS in node against a fake document holding twenty 400k-char JSON-LD blocks (8 MB).
SNAPSHOT_HARNESS = """
const blocks = Array.from({ length: 20 }, (_, i) => ({ textContent: String(i % 10).repeat(400000) }));
globalThis.location = { href: 'https://reviews.example.com/r' };
globalThis.document = {
  title: 'Reviews', body: { innerText: 'text' }, documentElement: { outerHTML: '<html></html>' },
  querySelectorAll: (selector) => (selector.includes('ld+json') ? blocks : []),
  querySelector: () => null,
};
const snapshot = (__SNAPSHOT_JS__);
snapshot('navigate', null, [], __LIMITS__).then((out) => process.stdout.write(out));
"""


def run_node(script: str, *arguments: str) -> str:
    """stdout of ``node -e script arguments...`` (a fixed argv, test-only)."""
    assert NODE, 'node is needed to run the snapshot script'
    result = subprocess.run([NODE, '-e', script, *arguments], capture_output=True, text=True, timeout=60, check=True)  # noqa: S603 — fixed argv: the located node binary, -e, a test script
    return result.stdout


@pytest.mark.skipif(not NODE, reason='node is not installed')
def test_snapshot_js_caps_the_total_json_ld_in_the_page():
    limits = {'jsonldChars': MAX_JSONLD_CHARS, 'jsonldBlocks': MAX_JSONLD_BLOCKS,
              'jsonldTotalChars': MAX_JSONLD_TOTAL_CHARS, 'htmlChars': 100, 'textChars': 100}
    script = SNAPSHOT_HARNESS.replace('__SNAPSHOT_JS__', SNAPSHOT_JS).replace('__LIMITS__', json.dumps(limits))
    blocks = json.loads(run_node(script))['ld']
    assert 0 < sum(len(block) for block in blocks) <= MAX_JSONLD_TOTAL_CHARS
