"""A session's transcript (7.50.00): everything the agent was told, did and was answered, kept forever.

Each session writes it under its own create-only keys (the agent's prefix, which its role alone may write)::

    ws/<ws>/runs/<run>/<agent>/commits/<sha>/_transcripts/attempt-<n>/<chunk:04d>.jsonl

one JSON event a line: the session's start (role, skill label, model, harness, task, attempt), every message to and
from the model, every tool call and its result (a gate's outputs among them), every model call's model, tokens and
time, every checkpoint, and the end (how it ended, the tokens per model). Chunks are flushed at each checkpoint, when
the events held pass ``FLUSH_BYTES``, and at the session's end (a crash included): a continuation of the same
attempt goes on with the next free chunk number (a put of a chunk that exists is refused, so the number moves on).

Nothing secret is written: every text an event holds is redacted (``quality_gate/text.redact``) and cut
(``MAX_TEXT``) before its put; the session's credentials never pass through the harness's tools. The text an event
holds is data from the repository, a host, a model or a person: a reader (Learn, the run inspector) fences it as data
again before any model reads it. The transcripts are kept forever (owner decision, 2026-11-16): no expiry; only the
multi-workspace erasure and a workspace's hard delete remove one, where personal data requires it.
"""
from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, Final, Protocol

from engineering.quality_gate.text import redact

SCHEMA: Final = 'voc-transcript/1'
#: The events a session holds before it flushes them on its own (bytes of their JSON lines).
FLUSH_BYTES: Final = 512 * 1024
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
    'install_dependencies': 'execute', 'run_gate': 'execute',
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
    """The session's transcript under ``prefix`` (``checkpoints.artifact_prefix(..., 'transcripts')``)."""

    def __init__(self, store: Store, prefix: str, *, clock: Callable[[], float] = time.time) -> None:
        self._store = store
        self._prefix = prefix
        self._clock = clock
        self._lines: list[str] = []
        self._held = 0
        self._chunk = 1
        #: The chunks this session wrote (their keys), in order.
        self.written: list[str] = []

    @property
    def prefix(self) -> str:
        return self._prefix

    def record(self, kind: str, **fields: Any) -> None:
        """One event, held until the next flush (one past ``FLUSH_BYTES`` flushes at once). Never raises for what it
        holds: a value that is not JSON is written as its redacted text."""
        at = datetime.fromtimestamp(self._clock(), UTC).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        line = json.dumps({'schema': SCHEMA, 'at': at, 'kind': kind, **scrubbed(fields)}, ensure_ascii=False,
                          sort_keys=True, default=str)
        self._lines.append(line)
        self._held += len(line.encode()) + 1
        if self._held >= FLUSH_BYTES:
            self.flush()

    def flush(self) -> str | None:
        """The events held, as the next free chunk (create-only); its key, None when nothing was held. A failure
        other than a taken key is raised, with the events still held for the next flush."""
        if not self._lines:
            return None
        body = ''.join(f'{line}\n' for line in self._lines).encode()
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
            self._lines, self._held = [], 0
            self.written.append(key)
            return key
        raise RuntimeError(f'the transcript found no free chunk under {self._prefix}')

    def flush_quietly(self) -> None:
        """``flush``, never raising (a session's end and its crash: the transcript must not hide the outcome)."""
        try:
            self.flush()
        except Exception:  # noqa: BLE001 - a transcript that cannot be written never ends a session another way
            self._lines, self._held = [], 0
