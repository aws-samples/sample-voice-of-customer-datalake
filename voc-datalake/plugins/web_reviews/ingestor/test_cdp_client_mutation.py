"""What the mutation run of cdp_client.py found that the browser-layer tests could not see.

Those tests match error messages with ``re.search`` and never sit on a boundary: the
default 30 s command timeout, the exact 8 MiB message cap and the MB figure in its
refusal, a deadline that is exactly (or under a second from being) spent, request ids
past the first, the fallback ``error`` detail, and the websocket-client adapter
(``_LibrarySocket`` / ``open_websocket``) were all unpinned. Every expectation below is
a literal.
"""
import json
from types import SimpleNamespace
from typing import Any

import cdp_client
import pytest
from cdp_client import CdpConnection, CdpError, _LibrarySocket, open_websocket
from test_web_reviews_browser import FakeSocket, reply

#: 8 MiB, the largest reply accepted.
CAP = 8_388_608


def frame_of_length(message: dict[str, Any], length: int) -> str:
    """A reply to *message* padded to exactly *length* characters."""
    empty = json.dumps({'id': message['id'], 'result': {'v': ''}})
    return json.dumps({'id': message['id'], 'result': {'v': 'x' * (length - len(empty))}})


def refusal(call: Any) -> str:
    with pytest.raises(CdpError) as caught:
        call()
    return str(caught.value)


class TestTheDefaultTimeout:
    def test_a_command_waits_thirty_seconds_unless_told_otherwise(self):
        socket = FakeSocket(lambda m: [reply(m, {})])
        CdpConnection(socket, clock=lambda: 100.0).call('Page.enable')
        assert socket.timeouts == [30.0]


class TestTheMessageCap:
    def test_a_reply_of_exactly_eight_mebibytes_is_accepted(self):
        socket = FakeSocket(lambda m: [frame_of_length(m, CAP)])
        assert len(CdpConnection(socket).call('Runtime.evaluate')['v']) == CAP - 30

    @pytest.mark.parametrize(('length', 'shown'), [(CAP + 1, '8 MB'), (9_000_000, '9 MB')])
    def test_one_character_more_is_refused_with_its_whole_megabytes(self, length, shown):
        socket = FakeSocket(lambda m: [frame_of_length(m, length)])
        assert refusal(lambda: CdpConnection(socket).call('Runtime.evaluate')) == (
            f'Runtime.evaluate: the browser reply was too large ({shown})')


class TestTheDeadline:
    def test_a_spent_deadline_raises_without_waiting(self):
        ticks = iter([0.0, 2.0])
        socket = FakeSocket(lambda m: [reply(m, {'late': True})])
        connection = CdpConnection(socket, clock=lambda: next(ticks))
        assert refusal(lambda: connection.call('Page.navigate', timeout=2)) == 'Page.navigate timed out'
        assert socket.timeouts == []

    def test_under_a_second_left_still_waits_for_the_reply(self):
        ticks = iter([0.0, 1.5])
        socket = FakeSocket(lambda m: [reply(m, {'ok': 1})])
        assert CdpConnection(socket, clock=lambda: next(ticks)).call('Page.navigate', timeout=2) == {'ok': 1}
        assert socket.timeouts == [0.5]


class TestEveryRefusalNamesItsCause:
    def test_no_reply(self):
        connection = CdpConnection(FakeSocket(lambda _m: []))
        assert refusal(lambda: connection.call('Page.navigate', timeout=1)) == 'Page.navigate timed out'

    def test_a_closed_connection(self):
        class ClosedSocket(FakeSocket):
            def recv(self) -> str:
                raise ConnectionError('gone')

        connection = CdpConnection(ClosedSocket(lambda _m: []))
        assert refusal(lambda: connection.call('Page.enable')) == 'Page.enable: the browser connection closed'

    @pytest.mark.parametrize(('error', 'detail'), [
        ({'message': 'No target'}, 'No target'), ({'code': -32000}, 'error'), ('boom', 'error'),
    ])
    def test_an_error_reply(self, error, detail):
        socket = FakeSocket(lambda m: [json.dumps({'id': m['id'], 'error': error})])
        assert refusal(lambda: CdpConnection(socket).call('Target.attachToTarget')) == (
            f'Target.attachToTarget failed: {detail}')


def test_request_ids_count_up_per_connection():
    socket = FakeSocket(lambda m: [reply(m, {})])
    connection = CdpConnection(socket)
    connection.call('Page.enable')
    connection.call('Runtime.enable')
    assert [m['id'] for m in socket.sent] == [1, 2]


class LibraryTimeout(Exception):
    pass


class LibraryError(Exception):
    pass


LIBRARY = SimpleNamespace(WebSocketTimeoutException=LibraryTimeout, WebSocketException=LibraryError)


class LibraryConnection:
    """websocket-client's connection: records calls; the *failing* one raises *failure*."""

    def __init__(self, failure: Exception | None = None, failing: str = 'recv'):
        self.failure = failure
        self.failing = failing
        self.calls: list[tuple[str, object]] = []

    def _record(self, name: str, value: object = None) -> object:
        self.calls.append((name, value))
        if self.failure is not None and name == self.failing:
            raise self.failure
        return f'{name}-ok'

    def send(self, payload: str) -> object:
        return self._record('send', payload)

    def recv(self) -> object:
        return self._record('recv')

    def settimeout(self, timeout: float) -> None:
        self._record('settimeout', timeout)

    def close(self) -> None:
        self._record('close')


class TestTheLibraryAdapter:
    def test_every_call_reaches_the_connection(self):
        connection = LibraryConnection()
        socket = _LibrarySocket(connection, LIBRARY)
        assert (socket.send('{}'), socket.recv()) == ('send-ok', 'recv-ok')
        socket.settimeout(2.5)
        socket.close()
        assert connection.calls == [('send', '{}'), ('recv', None), ('settimeout', 2.5), ('close', None)]

    def test_a_library_timeout_is_a_timeout_error(self):
        with pytest.raises(TimeoutError):
            _LibrarySocket(LibraryConnection(LibraryTimeout()), LIBRARY).recv()

    @pytest.mark.parametrize('method', ['send', 'recv', 'close'])
    def test_a_library_error_is_a_connection_error_named_after_it(self, method):
        socket = _LibrarySocket(LibraryConnection(LibraryError(), failing=method), LIBRARY)
        operation = {'send': lambda: socket.send('{}'), 'recv': socket.recv, 'close': socket.close}[method]
        with pytest.raises(ConnectionError) as caught:
            operation()
        assert str(caught.value) == 'LibraryError'

    def test_a_stalled_browser_becomes_a_timed_out_command(self):
        socket = _LibrarySocket(LibraryConnection(LibraryTimeout()), LIBRARY)
        assert refusal(lambda: CdpConnection(socket).call('Page.enable')) == 'Page.enable timed out'


def test_open_websocket_connects_with_the_signed_header_lines(monkeypatch):
    connection = LibraryConnection()
    imported: list[str] = []
    created: list[tuple[str, list[str], float]] = []

    def create_connection(url: str, *, header: list[str], timeout: float) -> LibraryConnection:
        created.append((url, header, timeout))
        return connection

    library = SimpleNamespace(**vars(LIBRARY), create_connection=create_connection)

    def import_module(name: str) -> SimpleNamespace:
        imported.append(name)
        return library

    monkeypatch.setattr(cdp_client.importlib, 'import_module', import_module)
    socket = open_websocket('wss://host/automation', {'host': 'h', 'Authorization': 'AWS4 x'}, 7.0)
    assert imported == ['websocket']
    assert created == [('wss://host/automation', ['host: h', 'Authorization: AWS4 x'], 7.0)]
    assert socket.recv() == 'recv-ok'
