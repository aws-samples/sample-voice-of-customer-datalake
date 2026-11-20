"""A model call in flight counts as liveness (7.58.01, the review gate's R2-3).

The supervisor's stall rule (``runtime/liveness.py``) reads progress reports only: none for ``stall_after`` (10
minutes) and it asks the agent for its state, none within the answer window (3 minutes) after that and it stops the
task. A Converse call answers once its whole reply is written (``converse_loop.MAX_TOKENS``, thinking included), and a
reply cut at the cap is asked for again, so the native harness's model calls can keep an agent busy, not stalled, for
minutes on end: before 7.58.01 such a call could get its task stopped mid-call, and the paid call was lost.

The Converse loop holds ``ModelWait.calling`` around each call, and botocore says each request it sends for it
(``sent``, on ``before-send``: the call's first, or the same request sent again after a read timeout, each a request
of its own). The harness's heartbeat (``main._heartbeat``, once a minute) reports ``WAITING_ON_THE_MODEL`` for a
request still in flight ``after`` seconds after it was sent: one line per request, so a short call reports nothing and
a long one one line, never one a minute. The harness's Bedrock timeouts bound how long a request can run after its
line (``main.BEDROCK_READ_TIMEOUT``: a test holds them inside the stall rule's window).
"""
from __future__ import annotations

import contextlib
import threading
import time
from collections.abc import Callable, Generator
from typing import Any, Final

#: The progress step the heartbeat reports for a request in flight (one board line: ``tools.progress_line``).
WAITING_ON_THE_MODEL: Final = 'waiting on the model'


class ModelWait:
    """The request in flight of the session's model call, as the heartbeat reads it (thread-safe: the call runs on the
    session's thread, the heartbeat on its own)."""

    def __init__(self, after: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._after = after
        self._clock = clock
        self._lock = threading.Lock()
        self._calling = False
        #: The requests sent so far; the one in flight's number and when it was sent (``clock``), None for none; and
        #: the last one whose line was reported.
        self._requests = 0
        self._sent: float | None = None
        self._reported = 0

    @contextlib.contextmanager
    def calling(self) -> Generator[None]:
        """Around one model call: its first request is sent now, and none is in flight once it returns or raises."""
        with self._lock:
            self._calling = True
        self.sent()
        try:
            yield
        finally:
            with self._lock:
                self._calling, self._sent = False, None

    def sent(self, **_: Any) -> None:
        """A request of the call is sent (botocore's ``before-send`` handler: it returns None, so the request goes);
        it is reported once if it runs past ``after``. Outside a call, nothing."""
        with self._lock:
            if self._calling:
                self._requests += 1
                self._sent = self._clock()

    def due(self) -> int | None:
        """The request in flight to report now (its number, for ``reported``): sent at least ``after`` seconds ago,
        and not reported yet; None for none."""
        with self._lock:
            if self._sent is None or self._reported == self._requests or self._clock() - self._sent < self._after:
                return None
            return self._requests

    def reported(self, request: int) -> None:
        """Request ``request`` (``due``'s) was reported: it is not again (one that failed is, at the next look)."""
        with self._lock:
            self._reported = max(self._reported, request)
