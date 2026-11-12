"""The platform's tools for a coding-agent CLI: a Model Context Protocol server on stdin/stdout.

The CLI starts this server itself (``cli.ClaudeCli`` hands it the platform's own server config and no
other), with every built-in tool of its own off, so these are the only tools it has. Messages are JSON-RPC
2.0, one per line: ``initialize``, ``tools/list``, ``tools/call``, ``ping``; notifications get no answer.
What ``finish`` and ``save_checkpoint`` return is handed back to the harness through ``SessionFiles`` in the
agent's home (the CLI is the harness's child; the server is the CLI's).
"""
from __future__ import annotations

import contextlib
import json
import os
import secrets
import time
from collections.abc import Mapping
from typing import IO, Any, Final

from engineering.runtime.harness.tools import AgentContext, ToolBox, ToolResult, as_data

PROTOCOL_VERSION: Final = '2025-06-18'
SERVER_NAME: Final = 'voc'
_METHOD_NOT_FOUND: Final = -32601
_INVALID: Final = -32602
_INTERNAL: Final = -32603


class SessionFiles:
    """What the tool server tells the harness: the agent's last checkpoint notes, and its finish."""

    def __init__(self, directory: str) -> None:
        self.directory = directory

    def _path(self, name: str) -> str:
        return os.path.join(self.directory, f'{name}.json')

    def write(self, name: str, value: Mapping[str, Any]) -> None:
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        staged = self._path(f'.{name}-{os.getpid()}')
        with open(staged, 'w') as stream:
            json.dump(dict(value), stream)
        os.replace(staged, self._path(name))

    def read(self, name: str) -> dict[str, Any] | None:
        try:
            with open(self._path(name)) as stream:
                value = json.load(stream)
        except (OSError, ValueError):
            return None
        return value if isinstance(value, dict) else None

    def post(self, messages: list[dict[str, str]]) -> None:
        """Leave inbox messages for the agent: one file per batch, never rewritten (nothing lost to a race)."""
        self.write(f'messages-{time.time_ns():020d}-{secrets.token_hex(4)}', {'messages': messages})

    def take_messages(self) -> list[dict[str, Any]]:
        """Every batch left so far, oldest first, each taken once (renamed away before it is read)."""
        taken: list[dict[str, Any]] = []
        with contextlib.suppress(FileNotFoundError):
            names = sorted(name for name in os.listdir(self.directory)
                           if name.startswith('messages-') and name.endswith('.json'))
            for name in names:
                claimed = os.path.join(self.directory, f'.taken-{name}')
                try:
                    os.rename(os.path.join(self.directory, name), claimed)
                except FileNotFoundError:
                    continue
                with open(claimed) as stream, contextlib.suppress(ValueError):
                    batch = json.load(stream)
                    taken += [item for item in batch.get('messages', []) if isinstance(item, dict)]
                os.remove(claimed)
        return taken

    def record(self, result: ToolResult, context: AgentContext) -> None:
        """What the harness needs from this process: the agent's notes (each save its own, even when the same),
        its finish and its step."""
        if result.checkpoint is not None:
            self.write('checkpoint', {**result.checkpoint, 'save': secrets.token_hex(8)})
        if result.finished is not None:
            self.write('finished', {'summary': result.finished})
        self.write('state', {'step': context.status.step})


def _messages(files: SessionFiles) -> str:
    """The inbox's messages the harness left for the agent, fenced as data (empty when there are none)."""
    fenced = [as_data('message:' + str(item.get('kind', '')), str(item.get('summary', '')))
              for item in files.take_messages()]
    return ''.join('\n' + text for text in fenced)


def answer(toolbox: ToolBox, files: SessionFiles, request: Mapping[str, Any]) -> dict[str, Any] | None:
    """The JSON-RPC answer to ``request`` (None for a notification)."""
    method, ident = request.get('method'), request.get('id')
    if ident is None:
        return None
    raw = request.get('params')
    params: Mapping[str, Any] = raw if isinstance(raw, dict) else {}
    if method == 'initialize':
        result: dict[str, Any] = {'protocolVersion': str(params.get('protocolVersion') or PROTOCOL_VERSION),
                                  'capabilities': {'tools': {}},
                                  'serverInfo': {'name': SERVER_NAME, 'version': '1'}}
    elif method == 'ping':
        result = {}
    elif method == 'tools/list':
        result = {'tools': [{'name': spec.name, 'description': spec.description, 'inputSchema': spec.schema()}
                            for spec in toolbox.specs]}
    elif method == 'tools/call':
        arguments = params.get('arguments')
        if not isinstance(params.get('name'), str) or not isinstance(arguments, dict | None):
            return {'jsonrpc': '2.0', 'id': ident, 'error': {'code': _INVALID, 'message': 'name and arguments'}}
        try:
            outcome = toolbox.call(params['name'], arguments or {})
        except Exception as error:  # noqa: BLE001 - said to the harness, which crashes the session from it
            # A port failing (the board, the broker): the session crashes and is continued from its checkpoint,
            # never ends as done because the CLI went on without its tools.
            files.write('crashed', {'error': f'{type(error).__name__}: {error}'[:300]})
            return {'jsonrpc': '2.0', 'id': ident, 'error': {'code': _INTERNAL, 'message': 'the tool failed'}}
        files.record(outcome, toolbox.context)
        result = {'content': [{'type': 'text', 'text': outcome.text + _messages(files)}], 'isError': outcome.error}
    else:
        return {'jsonrpc': '2.0', 'id': ident, 'error': {'code': _METHOD_NOT_FOUND, 'message': f'no method {method}'}}
    return {'jsonrpc': '2.0', 'id': ident, 'result': result}


def serve(toolbox: ToolBox, files: SessionFiles, reader: IO[str], writer: IO[str]) -> None:
    """Answer requests from ``reader`` until it ends."""
    for line in reader:
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if not isinstance(request, dict):
            continue
        reply = answer(toolbox, files, request)
        if reply is not None:
            writer.write(json.dumps(reply) + '\n')
            writer.flush()
