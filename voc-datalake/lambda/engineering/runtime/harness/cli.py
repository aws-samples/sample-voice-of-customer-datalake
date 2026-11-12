"""The CLI adapter: a coding-agent CLI in its headless mode, with the platform's tools only.

Which CLI: the same order as the repository's own AI reviews (scripts/ai-review/lib.mjs: kiro-cli, else
claude), minus any that needs an endpoint or a login other than Bedrock with the agent's session. kiro-cli
signs in to its own service, which a MicroVM neither reaches nor holds a login for, so it is not offered;
``claude`` reaches models through Bedrock (``CLAUDE_CODE_USE_BEDROCK=1``, the agent's session through
``AWS_CONFIG_FILE``) and is offered at one pinned version only.

How it runs (the flags the repository's AI review already uses, scripts/ai-review/lib.mjs ``runnerCommand``,
with every built-in tool off instead of Read and Glob):

- ``--tools ""``: none of its own tools (no shell, no file or web tool); ``--strict-mcp-config`` with the
  platform's server config alone (``tool_server``), and only those tools allowed;
- started in a fresh directory of the agent's home, outside the checkout, with ``HOME`` and
  ``CLAUDE_CONFIG_DIR`` there too, so no repository's or user's configuration (hooks, tool servers, steering
  or instruction files, settings) is ever loaded; ``--no-session-persistence``;
- its environment is built here (``cli_env``), never inherited: no variable of the runner's or the image's
  reaches it but the ones listed.

While it runs, the harness saves a checkpoint each time the agent calls ``save_checkpoint`` (and once more
before a crash is raised), takes the tool server's step and patches, and takes the inbox: ``save``
checkpoints, ``pause`` checkpoints, ends the CLI's whole session (its tool server too) and pauses; any other
message reaches the agent, as data, with its next tool result. The CLI's session is ended on every way out.
"""
from __future__ import annotations

import contextlib
import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
from collections.abc import Callable, Mapping
from typing import Any, Final

from engineering.runtime.harness.converse_loop import SYSTEM_PROMPT, opening
from engineering.runtime.harness.interface import AgentSession, Ending
from engineering.runtime.harness.tool_server import SERVER_NAME, SessionFiles

CLAUDE: Final = 'claude'
#: The CLIs the repository's AI reviews know, and why each is or is not offered in a MicroVM.
NOT_OFFERED: Final = {'kiro': 'kiro-cli signs in to its own service: a MicroVM has no such login or endpoint'}
#: The harness's own tool server, as the CLI starts it (the image's copy of this package; ``-I``: isolated).
TOOL_SERVER: Final = ('/usr/bin/python3', '-I', '/opt/voc/harness.py', 'tool-server')
INBOX_POLL_SECONDS: Final = 5.0
PATH: Final = '/usr/local/bin:/usr/bin:/bin'


class CliNotOffered(RuntimeError):
    """A CLI the harness does not offer here (unknown, needs its own login, missing, or not the pinned version)."""


def cli_env(home: str, *, region: str, aws_config: str) -> dict[str, str]:
    """The CLI's whole environment: Bedrock with the agent's session, a home of its own, nothing inherited."""
    return {'PATH': PATH, 'HOME': home, 'CLAUDE_CONFIG_DIR': os.path.join(home, '.claude'), 'LANG': 'C.UTF-8',
            'CLAUDE_CODE_USE_BEDROCK': '1', 'AWS_REGION': region, 'AWS_CONFIG_FILE': aws_config,
            'AWS_SDK_LOAD_CONFIG': '1'}


class ClaudeCli:
    """``Adapter`` on the ``claude`` CLI, at ``version`` exactly."""

    def __init__(self, *, binary: str, version: str, model_id: str, home_root: str, region: str, aws_config: str,
                 tool_env: Mapping[str, str], run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
                 popen: Callable[..., subprocess.Popen[str]] = subprocess.Popen,
                 sleep: Callable[[float], None] = time.sleep,
                 killpg: Callable[[int, int], None] = os.killpg) -> None:
        self._binary = binary
        self._version = version
        self._model_id = model_id
        self._home_root = home_root
        self._region = region
        self._aws_config = aws_config
        self._tool_env = dict(tool_env)
        self._run = run
        self._popen = popen
        self._sleep = sleep
        self._killpg = killpg

    def check(self) -> None:
        """Refuse a CLI that is missing or not the pinned version."""
        if not os.path.isabs(self._binary) or not os.access(self._binary, os.X_OK):
            raise CliNotOffered(f'{self._binary} is not an installed CLI (an absolute path is needed)')
        shown = self._run([self._binary, '--version'], capture_output=True, text=True, timeout=60,
                          env={'PATH': PATH, 'HOME': self._home_root}, check=False).stdout.strip()
        if shown.split(' ', 1)[0] != self._version:
            raise CliNotOffered(f'{self._binary} is {shown!r}, not the pinned {self._version}')

    def command(self, session: AgentSession, config: str) -> list[str]:
        allowed = ','.join(f'mcp__{SERVER_NAME}__{spec.name}' for spec in session.tools.specs)
        return [self._binary, '-p', '--append-system-prompt', SYSTEM_PROMPT, '--tools', '',
                '--strict-mcp-config', '--mcp-config', config, '--permission-mode', 'dontAsk',
                '--allowedTools', allowed, '--no-session-persistence', '--output-format', 'text',
                '--model', self._model_id]

    def prepare(self, session: AgentSession) -> tuple[str, str, list[str], dict[str, str]]:
        """A fresh home outside the checkout, the tool server's config in it: (home, files dir, argv, env)."""
        os.makedirs(self._home_root, mode=0o700, exist_ok=True)
        home = tempfile.mkdtemp(prefix='cli-', dir=self._home_root)
        files = os.path.join(home, 'session')
        config = os.path.join(home, 'tools.json')
        server_env = {**self._tool_env, 'VOC_SESSION_FILES': files}
        with open(config, 'w') as stream:
            json.dump({'mcpServers': {SERVER_NAME: {'command': TOOL_SERVER[0], 'args': list(TOOL_SERVER[1:]),
                                                    'env': server_env}}}, stream)
        env = cli_env(home, region=self._region, aws_config=self._aws_config)
        return home, files, self.command(session, config), env

    def run(self, session: AgentSession) -> Ending:
        self.check()
        home, directory, argv, env = self.prepare(session)
        files = SessionFiles(directory)
        process: subprocess.Popen[str] | None = None
        try:
            process = self._popen(argv, cwd=home, env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, text=True, start_new_session=True)
            if process.stdin is not None:
                process.stdin.write(opening(session))
                process.stdin.close()
            return self._watch(session, process, files)
        finally:
            if process is not None:
                self._end(process)
            shutil.rmtree(home, ignore_errors=True)

    def _end(self, process: subprocess.Popen[str]) -> None:
        """End the CLI and every process of its session (its tool server included)."""
        if process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                self._killpg(process.pid, signal.SIGKILL)
            process.wait()

    def _watch(self, session: AgentSession, process: subprocess.Popen[str], files: SessionFiles) -> Ending:
        try:
            return self._watched(session, process, files)
        except Exception:
            # Whatever failed (the inbox, a sync, a port), the CLI is ended and its work saved before the crash.
            self._end(process)
            with contextlib.suppress(Exception):
                session.checkpoint(turn=-1)
            raise

    def _watched(self, session: AgentSession, process: subprocess.Popen[str], files: SessionFiles) -> Ending:
        turn, seen = 0, None
        while process.poll() is None:
            seen = _sync(session, files, seen, turn)
            if files.read('crashed') is not None:
                self._end(process)
                break
            others, pause = session.take_messages()
            if pause:
                # Ended first, so nothing it writes after the checkpoint is lost; a git command its tool server
                # started may still be finishing in the runner, which the checkpoint's own git waits for.
                self._end(process)
                _sync(session, files, seen, turn)
                session.checkpoint(turn=turn)
                return 'paused'
            if others:
                files.post([{'kind': message.kind, 'summary': message.summary} for message in others])
            turn += 1
            self._sleep(INBOX_POLL_SECONDS)
        _sync(session, files, seen, turn)
        crashed = files.read('crashed')
        if crashed is not None or (files.read('finished') is None and process.returncode != 0):
            # Its work so far is saved before the crash, so the continuation starts from it.
            session.checkpoint(turn=turn)
            why = (f'a platform tool failed: {crashed.get("error", "")}' if crashed is not None
                   else f'the CLI ended with exit code {process.returncode}')
            raise RuntimeError(f'{why} before the task was finished')
        # Finished, or ended cleanly without saying so (as the Converse loop's two answers without a tool): done.
        return 'done'


def _sync(session: AgentSession, files: SessionFiles, seen: dict[str, Any] | None, turn: int) -> dict[str, Any] | None:
    """Take what the tool server recorded (its step); a new ``save_checkpoint`` is saved at once."""
    state = files.read('state')
    if state is not None:
        session.context.status.step = str(state.get('step', ''))
    notes = files.read('checkpoint')
    if notes is not None and notes != seen:
        session.remember(notes)
        session.checkpoint(turn=turn)
        return notes
    return seen


def choose_cli(name: str) -> str:
    """``claude`` when asked for; any other CLI is refused with the reason (``NOT_OFFERED``)."""
    if name in NOT_OFFERED:
        raise CliNotOffered(f'{name} is not offered: {NOT_OFFERED[name]}')
    if name != CLAUDE:
        raise CliNotOffered(f'no CLI {name!r}')
    return name
