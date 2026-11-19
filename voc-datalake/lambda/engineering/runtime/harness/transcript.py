"""A session's transcript (7.50.00): everything the agent was told, did and was answered, kept forever.

Each session writes it under its own create-only keys (the agent's prefix, which its role alone may write)::

    ws/<ws>/runs/<run>/<agent>/commits/<sha>/_transcripts/attempt-<n>/<chunk:04d>.jsonl

one JSON event a line: the session's start (role, skill label, model, harness, task, attempt), every message to and
from the model, every tool call and its result (a gate's outputs among them), every model call's model, tokens and
time, every checkpoint, every steering instruction that reached the model (7.51.00: ``steer``), and the end (how it
ended, the tokens per model). Chunks are flushed at each checkpoint, when the events held pass ``FLUSH_BYTES``, every
``FLUSH_SECONDS`` while the session holds events (7.51.00: the run workspace's live thread, at about 240 puts an
agent-hour; ``main.py`` runs the clock), and at the session's end (a crash included): a continuation of the same
attempt goes on with the next free chunk number (a put of a chunk that exists is refused, so the number moves on).
A tool call's event carries its call id, its ACP kind (``TOOL_KINDS``) and, on its result, its ACP status, so the
transcript and 7.53.00's ACP ``session/update`` stream are one shape.

Nothing secret is written: every text an event holds is redacted (``quality_gate/text.redact``) and cut
(``MAX_TEXT``) before its put; the session's credentials never pass through the harness's tools. The text an event
holds is data from the repository, a host, a model or a person: a reader (Learn, the run inspector) fences it as data
again before any model reads it. The transcripts are kept forever (owner decision, 2026-11-16): no expiry; only the
multi-workspace erasure and a workspace's hard delete remove one, where personal data requires it.
"""
from __future__ import annotations

import json
import sys
import threading
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, Final, Protocol

from engineering.quality_gate.text import redact

SCHEMA: Final = 'voc-transcript/1'
#: The events a session holds before it flushes them on its own (bytes of their JSON lines).
FLUSH_BYTES: Final = 512 * 1024
#: The longest the session holds an event before it flushes it on its own (7.51.00: a live thread lags by this at most).
FLUSH_SECONDS: Final = 15.0
#: One text of an event at most (a file read whole, a long command output): its start and its end are kept.
MAX_TEXT: Final = 20_000
#: The chunk numbers a session tries past a taken one (a continuation's, the CLI's tool server's).
MAX_SKIPS: Final = 200
MAX_CHUNK: Final = 9_999
#: Each platform tool's kind as ACP names a tool call's (7.51.00; ``session/update`` ``tool_call``'s ``kind``: read, edit,
#: delete, move, search, execute, think, fetch, other), recorded on every ``tool_call`` event so the transcript and
#: 7.53.00's ACP channel tell one stream; a tool not listed is ``other``.
TOOL_KINDS: Final = {
    'read_file': 'read', 'list_files': 'read', 'read_board': 'read', 'read_flow': 'read', 'read_gate_record': 'read',
    'read_findings': 'read', 'read_knowledge': 'fetch', 'read_issue': 'fetch', 'write_file': 'edit', 'run': 'execute',
    'install_dependencies': 'execute', 'run_gate': 'execute', 'read_skill': 'read',
}
#: A tool call's statuses as ACP names them (``tool_call_update``'s ``status``).
TOOL_STATUSES: Final = ('pending', 'in_progress', 'completed', 'failed')


def tool_kind(name: str) -> str:
    """The ACP kind of a platform tool (``other`` for one not listed)."""
    return TOOL_KINDS.get(name, 'other')


class Store(Protocol):
    def put(self, key: str, body: bytes) -> None: ...


def _cut(text: str) -> str:
    if len(text) <= MAX_TEXT:
        return text
    half = MAX_TEXT // 2
    return f'{text[:half]}\n[… {len(text) - MAX_TEXT} characters cut …]\n{text[-half:]}'


def scrubbed(value: Any) -> Any:
    """``value`` with every text in it redacted and cut (keys kept as they are: the harness's own names)."""
    if isinstance(value, str):
        return _cut(redact(value))
    if isinstance(value, Mapping):
        return {str(key): scrubbed(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [scrubbed(item) for item in value]
    if value is None or isinstance(value, bool | int | float):
        return value
    return _cut(redact(str(value)))


def _taken(error: Exception) -> bool:
    """S3's answer to a create-only put of a key that exists (``If-None-Match``)."""
    response = getattr(error, 'response', None)
    return isinstance(response, Mapping) and response.get('Error', {}).get('Code') == 'PreconditionFailed'


class Transcript:
    """The session's transcript under ``prefix`` (``checkpoints.artifact_prefix(..., 'transcripts')``). Thread-safe:
    the session records from its own thread while ``main.py``'s clock flushes what is due (``flush_due``)."""

    def __init__(self, store: Store, prefix: str, *, clock: Callable[[], float] = time.time) -> None:
        self._store = store
        self._prefix = prefix
        self._clock = clock
        self._lines: list[str] = []
        self._held = 0
        #: When the oldest event held was recorded (None: none held).
        self._held_since: float | None = None
        self._chunk = 1
        #: The events held; and one flush at a time (its chunk number and its put).
        self._lock = threading.Lock()
        self._flushing = threading.Lock()
        #: The chunks this session wrote (their keys), in order.
        self.written: list[str] = []

    @property
    def prefix(self) -> str:
        return self._prefix

    def record(self, kind: str, **fields: Any) -> None:
        """One event, held until the next flush (one past ``FLUSH_BYTES`` flushes at once). Never raises for what it
        holds: a value that is not JSON is written as its redacted text."""
        now = self._clock()
        at = datetime.fromtimestamp(now, UTC).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        line = json.dumps({'schema': SCHEMA, 'at': at, 'kind': kind, **scrubbed(fields)}, ensure_ascii=False,
                          sort_keys=True, default=str)
        with self._lock:
            self._lines.append(line)
            self._held += len(line.encode()) + 1
            if self._held_since is None:
                self._held_since = now
            full = self._held >= FLUSH_BYTES
        if full:
            self.flush()

    def due(self) -> bool:
        """Whether the oldest event held is ``FLUSH_SECONDS`` old."""
        with self._lock:
            return self._held_since is not None and self._clock() - self._held_since >= FLUSH_SECONDS

    def flush(self) -> str | None:
        """The events held, as the next free chunk (create-only); its key, None when nothing was held. A failure
        other than a taken key is raised, with the events still held for the next flush."""
        with self._flushing:
            with self._lock:
                lines = list(self._lines)
            if not lines:
                return None
            body = ''.join(f'{line}\n' for line in lines).encode()
            for _ in range(MAX_SKIPS):
                if self._chunk > MAX_CHUNK:
                    break
                key = f'{self._prefix}{self._chunk:04d}.jsonl'
                try:
                    self._store.put(key, body)
                except Exception as error:
                    if not _taken(error):
                        raise
                    self._chunk += 1   # (written by an earlier session of this attempt, or the CLI's tool server)
                    continue
                self._chunk += 1
                self._drop(len(lines))
                self.written.append(key)
                return key
            raise RuntimeError(f'the transcript found no free chunk under {self._prefix}')

    def _drop(self, count: int) -> None:
        """The first ``count`` events held are written (those recorded meanwhile stay held, their clock from now)."""
        with self._lock:
            del self._lines[:count]
            self._held = sum(len(line.encode()) + 1 for line in self._lines)
            self._held_since = self._clock() if self._lines else None

    def flush_due(self) -> None:
        """``flush`` when the oldest event held is due (``main.py``'s clock), never raising: what could not be written
        stays held for the next flush."""
        if not self.due():
            return
        try:
            self.flush()
        except Exception as error:  # noqa: BLE001 - the clock's flush never ends a session; the next one tries again
            sys.stderr.write(f'harness: the transcript was not flushed ({type(error).__name__}); trying again\n')

    def flush_quietly(self) -> None:
        """``flush``, never raising (a session's end and its crash: the transcript must not hide the outcome)."""
        try:
            self.flush()
        except Exception:  # noqa: BLE001 - a transcript that cannot be written never ends a session another way
            with self._lock:
                self._lines, self._held, self._held_since = [], 0, None
