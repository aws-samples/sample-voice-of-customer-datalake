"""A minimal Chrome DevTools Protocol client over one websocket.

Only what the plugin needs: send a command (optionally to an attached target's
session) and wait for ITS reply, skipping the events and other replies that
arrive in between. Every wait is bounded by a deadline, so a browser that stops
answering costs at most that long.

The websocket is anything with ``send(str)``, ``recv() -> str``,
``settimeout(float)`` and ``close()``: ``websocket-client``'s connection in the
Lambda (``open_websocket``), a scripted fake in the tests.
"""

import contextlib
import importlib
import json
import time
from collections.abc import Callable, Mapping
from typing import Any, Final, Protocol

#: Seconds one command may take unless the caller says otherwise.
DEFAULT_COMMAND_TIMEOUT: Final = 30.0
#: Largest websocket message accepted. A page snapshot is ~1.1 MB of capped content
#: (page_reader's limits), JSON-escaped twice; anything far beyond that is refused
#: rather than decoded (websocket-client itself has no size cap).
MAX_MESSAGE_CHARS: Final = 8 * 1024 * 1024
#: The websocket library; pinned in lambda/layers/ingestion-deps/requirements.txt.
WEBSOCKET_MODULE: Final = 'websocket'


class WebSocketLike(Protocol):
    def send(self, payload: str, /) -> object: ...
    def recv(self) -> str | bytes: ...
    def settimeout(self, timeout: float, /) -> None: ...
    def close(self) -> None: ...


class CdpError(RuntimeError):
    """The browser answered a command with an error, or did not answer in time."""


class _LibrarySocket:
    """websocket-client's connection, its exceptions mapped onto the builtin ones this module handles.

    Its timeout and closed-connection errors subclass neither ``TimeoutError`` nor
    ``OSError`` (1.9.2), so without this a stalled browser would escape as an
    unrelated exception type.
    """

    def __init__(self, connection: Any, library: Any):
        self._connection = connection
        self._timeout_error: type[Exception] = library.WebSocketTimeoutException
        self._library_error: type[Exception] = library.WebSocketException

    def send(self, payload: str, /) -> object:
        try:
            return self._connection.send(payload)
        except self._library_error as error:
            raise ConnectionError(type(error).__name__) from error

    def recv(self) -> str | bytes:
        try:
            return self._connection.recv()
        except self._timeout_error as error:
            raise TimeoutError from error
        except self._library_error as error:
            raise ConnectionError(type(error).__name__) from error

    def settimeout(self, timeout: float, /) -> None:
        self._connection.settimeout(timeout)

    def close(self) -> None:
        try:
            self._connection.close()
        except self._library_error as error:
            raise ConnectionError(type(error).__name__) from error


def open_websocket(url: str, headers: Mapping[str, str], timeout: float) -> WebSocketLike:
    """Connect to *url* with the (SigV4-signed) handshake *headers*.

    Imported by name at call time: the library ships in the ingestion layer, and
    nothing else in this module (or its tests, which pass a fake) needs it.
    """
    library = importlib.import_module(WEBSOCKET_MODULE)
    header_lines = [f'{name}: {value}' for name, value in headers.items()]
    return _LibrarySocket(library.create_connection(url, header=header_lines, timeout=timeout), library)


class CdpConnection:
    """Commands over one DevTools websocket, answered in order of request id."""

    def __init__(self, socket: WebSocketLike, clock: Callable[[], float] = time.monotonic):
        self._socket = socket
        self._clock = clock
        self._next_id = 0

    def call(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
        *,
        session_id: str | None = None,
        timeout: float = DEFAULT_COMMAND_TIMEOUT,
    ) -> dict[str, Any]:
        """Send *method* and return its ``result`` (``{}`` when it has none)."""
        self._next_id += 1
        request_id = self._next_id
        message: dict[str, Any] = {'id': request_id, 'method': method, 'params': dict(params or {})}
        if session_id is not None:
            message['sessionId'] = session_id
        self._socket.send(json.dumps(message))
        return self._await_reply(request_id, method, self._clock() + timeout)

    def _await_reply(self, request_id: int, method: str, deadline: float) -> dict[str, Any]:
        while True:
            remaining = deadline - self._clock()
            if remaining <= 0:
                raise CdpError(f'{method} timed out')
            self._socket.settimeout(remaining)
            try:
                raw = self._socket.recv()
            except TimeoutError as error:
                raise CdpError(f'{method} timed out') from error
            except ConnectionError as error:
                raise CdpError(f'{method}: the browser connection closed') from error
            if len(raw) > MAX_MESSAGE_CHARS:
                raise CdpError(f'{method}: the browser reply was too large ({len(raw) // 1_000_000} MB)')
            reply = _decoded(raw)
            if reply is None or reply.get('id') != request_id:
                continue  # an event, or a reply to a command already given up on
            error = reply.get('error')
            if error is not None:
                detail = error.get('message', 'error') if isinstance(error, dict) else 'error'
                raise CdpError(f'{method} failed: {detail}')
            result = reply.get('result')
            return result if isinstance(result, dict) else {}

    def close(self) -> None:
        with contextlib.suppress(OSError):  # the session is stopped next anyway
            self._socket.close()


def _decoded(raw: str | bytes) -> dict[str, Any] | None:
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None
