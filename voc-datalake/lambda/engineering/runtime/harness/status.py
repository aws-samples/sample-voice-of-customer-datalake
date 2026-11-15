"""The harness's own report for the run monitor: its step, its recent tool calls, its tokens per model.

Written to ``~/.voc/status.json`` in the agent's home (the runner reads it without following links,
bounded and scrubbed: ``unit_runner.Runner.status``), atomically, after every model call and tool call.
"""
from __future__ import annotations

import json
import os
import tempfile
from collections import deque
from typing import Final

MAX_RECENT: Final = 10


class StatusReport:
    def __init__(self, home: str) -> None:
        self._directory = os.path.join(home, '.voc')
        self.step = ''
        self.recent_tools: deque[str] = deque(maxlen=MAX_RECENT)
        #: ``{model_id: {'in': n, 'out': n}}``, cumulated over this session's life.
        self.tokens: dict[str, dict[str, int]] = {}

    def add_tokens(self, model_id: str, tokens_in: int, tokens_out: int) -> None:
        counts = self.tokens.setdefault(model_id, {'in': 0, 'out': 0})
        counts['in'] += tokens_in
        counts['out'] += tokens_out
        self.write()

    def tool(self, name: str) -> None:
        self.recent_tools.append(name)
        self.write()

    def at(self, step: str) -> None:
        self.step = step
        self.write()

    def write(self) -> None:
        os.makedirs(self._directory, mode=0o700, exist_ok=True)
        body = json.dumps({'step': self.step, 'recent_tools': list(self.recent_tools), 'tokens': self.tokens})
        fd, staged = tempfile.mkstemp(dir=self._directory, prefix='.status-')
        with os.fdopen(fd, 'w') as stream:
            stream.write(body)
        os.replace(staged, os.path.join(self._directory, 'status.json'))
