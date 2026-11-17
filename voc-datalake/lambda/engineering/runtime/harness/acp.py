"""The harness's ACP client (7.53.00): JSON-RPC 2.0 over a child process's stdin and stdout, as the Agent Client
Protocol defines its one transport (agentclientprotocol.com: newline-delimited frames, the agent's logs on stderr).

The harness is the ONLY client of its agent (``kiro.py`` starts ``kiro-cli acp --agent-engine=v3`` as its child, and
nothing else holds the child's pipes): no socket, no listener, no port. What the client may say is fixed here, and
what it takes from the agent is bounded:

- **Client → agent**: only ``CLIENT_METHODS`` (``initialize``, ``session/new``, ``session/load``,
  ``session/set_config_option``, ``session/prompt``) and the notification ``session/cancel``; anything else is refused
  before it is written. ``initialize`` advertises no ``fs`` and no ``terminal`` capability, so a conforming agent never
  asks the harness to read or write a file or run a command.
- **Agent → client requests** go to the caller's ``on_request`` (the harness's permission policy), which answers each
  one at once; a method the harness offers none of (``fs/*``, ``terminal/*``, any other) is answered with JSON-RPC's
  method-not-found, never with an allow.
- **Frames**: a line over ``MAX_FRAME_BYTES`` is dropped unread (counted); a frame that is not a JSON object is
  dropped; a response is taken only for an id this client sent and is still waiting on (anything else is dropped), so
  the agent cannot answer for a request it was never sent.
- **Timeouts**: every request has a deadline (``wait``), and an agent that goes quiet past it is ``AcpTimeout``,
  which the adapter turns into a crash after saving its work (the supervisor continues it from the checkpoint).

Frames are never logged: what reaches the transcript is what the adapter records from them, redacted and cut
(``transcript.scrubbed``).
"""
from __future__ import annotations

import json
import queue
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import IO, Any, Final

#: ACP's protocol version this client speaks (``initialize``'s ``protocolVersion``).
PROTOCOL_VERSION: Final = 1
#: What the client may ask of its agent, and the one notification it may send.
CLIENT_METHODS: Final = frozenset({'initialize', 'session/new', 'session/load', 'session/set_config_option',
                                   'session/prompt'})
CLIENT_NOTIFICATIONS: Final = frozenset({'session/cancel'})
#: The capabilities ``initialize`` advertises: no file system and no terminal, so no ``fs/*`` or ``terminal/*`` call.
CLIENT_CAPABILITIES: Final = {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False}
#: The longest frame read (a tool call's whole output may come in one ``session/update``); a longer line is dropped.
MAX_FRAME_BYTES: Final = 4 * 1024 * 1024
#: JSON-RPC's error codes this client answers with.
METHOD_NOT_FOUND: Final = -32601


class AcpError(RuntimeError):
    """The agent answered a request with an error, broke the protocol, or ended: a crash of the session."""


class AcpTimeout(AcpError):
    """The agent did not answer within the deadline."""


@dataclass(frozen=True)
class Notification:
    method: str
    params: Mapping[str, Any]


@dataclass(frozen=True)
class Response:
    ident: int
    result: Mapping[str, Any] | None
    error: Mapping[str, Any] | None


class AcpClient:
    """The client end of one agent process's stdio. ``on_request(method, params)`` answers each agent → client request
    (the result object, or None for method-not-found); ``on_notification`` takes every ``session/update`` and other
    notification as it is read."""

    def __init__(self, stdin: IO[str], stdout: IO[str], *,
                 on_request: Callable[[str, Mapping[str, Any]], Mapping[str, Any] | None],
                 on_notification: Callable[[Notification], None],
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._stdin = stdin
        self._on_request = on_request
        self._on_notification = on_notification
        self._clock = clock
        self._frames: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._next_id = 0
        #: The requests sent and not yet answered, and the answers taken for them.
        self._pending: set[int] = set()
        self._answers: dict[int, Response] = {}
        self._write_lock = threading.Lock()
        self.closed = False
        #: Frames dropped (over the cap, not JSON, a response nobody waits on), for the session's status.
        self.dropped = 0
        #: When the last frame was read (the adapter's stall clock).
        self.last_frame_at = clock()
        threading.Thread(target=self._read, args=(stdout,), daemon=True).start()

    # -- reading ---------------------------------------------------------------------------------------------------

    def _read(self, stdout: IO[str]) -> None:
        try:
            for line in stdout:
                if len(line) > MAX_FRAME_BYTES:
                    self.dropped += 1
                    continue
                try:
                    frame = json.loads(line)
                except ValueError:
                    self.dropped += 1
                    continue
                if isinstance(frame, dict):
                    self._frames.put(frame)
                else:
                    self.dropped += 1
        except (OSError, ValueError):   # (the pipe closed under the reader: the agent ended)
            pass
        finally:
            self._frames.put(None)

    def pump(self, timeout: float) -> bool:
        """Handle the frames read so far, waiting up to ``timeout`` seconds for the first; False once the agent's
        stdout has ended."""
        try:
            frame = self._frames.get(timeout=max(timeout, 0.0))
        except queue.Empty:
            return not self.closed
        while True:
            if frame is None:
                self.closed = True
                return False
            self.last_frame_at = self._clock()
            self._handle(frame)
            try:
                frame = self._frames.get_nowait()
            except queue.Empty:
                return True

    def _handle(self, frame: Mapping[str, Any]) -> None:
        method, ident = frame.get('method'), frame.get('id')
        if isinstance(method, str):
            params = frame.get('params') if isinstance(frame.get('params'), dict) else {}
            if ident is None:
                self._on_notification(Notification(method, params))
            else:
                self._answer(ident, method, params)
            return
        if isinstance(ident, int) and ident in self._pending:
            self._pending.discard(ident)
            result, error = frame.get('result'), frame.get('error')
            self._answers[ident] = Response(ident, result if isinstance(result, dict) else ({} if error is None
                                                                                            else None),
                                            error if isinstance(error, dict) else None)
            return
        self.dropped += 1   # (a response to nothing this client is waiting on)

    def _answer(self, ident: object, method: str, params: Mapping[str, Any]) -> None:
        """An agent → client request: answered at once, from the caller's policy."""
        try:
            result = self._on_request(method, params)
        except Exception:  # noqa: BLE001 - a policy that fails refuses (never allows) and says nothing of why
            result = None
        if result is None:
            self._write({'jsonrpc': '2.0', 'id': ident,
                         'error': {'code': METHOD_NOT_FOUND, 'message': f'{method} is not offered by this client'}})
        else:
            self._write({'jsonrpc': '2.0', 'id': ident, 'result': dict(result)})

    # -- writing ---------------------------------------------------------------------------------------------------

    def _write(self, frame: Mapping[str, Any]) -> None:
        line = json.dumps(frame, ensure_ascii=False, separators=(',', ':')) + '\n'
        with self._write_lock:
            try:
                self._stdin.write(line)
                self._stdin.flush()
            except (OSError, ValueError) as error:
                raise AcpError(f'the agent\'s stdin is closed ({type(error).__name__})') from error

    def request(self, method: str, params: Mapping[str, Any]) -> int:
        """Send one of ``CLIENT_METHODS``; its id (``wait`` for its answer)."""
        if method not in CLIENT_METHODS:
            raise ValueError(f'{method} is not a method this client sends')
        self._next_id += 1
        ident = self._next_id
        self._pending.add(ident)
        self._write({'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': dict(params)})
        return ident

    def notify(self, method: str, params: Mapping[str, Any]) -> None:
        if method not in CLIENT_NOTIFICATIONS:
            raise ValueError(f'{method} is not a notification this client sends')
        self._write({'jsonrpc': '2.0', 'method': method, 'params': dict(params)})

    # -- answers ---------------------------------------------------------------------------------------------------

    def answered(self, ident: int) -> Response | None:
        """The answer to ``ident`` once it came (taken: asked again, None)."""
        return self._answers.pop(ident, None)

    def waiting(self, ident: int) -> bool:
        return ident in self._pending

    def wait(self, ident: int, timeout: float) -> Mapping[str, Any]:
        """The result of request ``ident``, handling every other frame meanwhile; ``AcpError`` for an error answer or
        an ended agent, ``AcpTimeout`` past ``timeout`` seconds."""
        deadline = self._clock() + timeout
        while True:
            found = self.answered(ident)
            if found is not None:
                if found.error is not None or found.result is None:
                    message = str((found.error or {}).get('message', 'no result'))[:300]
                    raise AcpError(f'the agent refused request {ident}: {message}')
                return found.result
            left = deadline - self._clock()
            if left <= 0:
                raise AcpTimeout(f'the agent did not answer request {ident} within {timeout:.0f} s')
            if not self.pump(min(left, 1.0)) and ident not in self._answers:
                raise AcpError('the agent ended before it answered')

    def initialize(self, timeout: float) -> Mapping[str, Any]:
        """``initialize`` with no fs or terminal capability; the agent's capabilities."""
        return self.wait(self.request('initialize', {'protocolVersion': PROTOCOL_VERSION,
                                                     'clientCapabilities': CLIENT_CAPABILITIES}), timeout)
