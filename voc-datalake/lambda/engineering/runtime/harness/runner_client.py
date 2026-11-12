"""The harness's way to run anything: the MicroVM's own runner (``unit_runner``), never a shell of its own.

A repository command (a build, a test, a gate tool) goes to the runner as repository code, so it runs as
``code``, boxed in its own namespaces, without network (the dependency step alone has the registries,
before any other repository code); the agent's own git commands go as the agent's. The runner masks
credentials in every output before the harness sees it.
"""
from __future__ import annotations

import json
import time
import urllib.request
from collections.abc import Callable, Sequence
from typing import Any, Final

from engineering.runtime.checkout import CHECKOUT_DIR as CHECKOUT

RUNNER_URL: Final = 'http://127.0.0.1:8080'
ENV: Final = '/usr/bin/env'
POLL_SECONDS: Final = 1.0
#: While a command runs, ``on_wait`` is called every this many polls (about a minute).
POLLS_PER_WAIT: Final = 60


class RunnerClient:
    """``run`` a command in the agent's MicroVM through its runner and wait for its result."""

    def __init__(self, base: str = RUNNER_URL, *, sleep: Callable[[float], None] = time.sleep,
                 opener: Callable[[urllib.request.Request], Any] | None = None) -> None:
        self._base = base
        self._sleep = sleep
        self._open = opener or _open_json

    def run(self, argv: Sequence[str], *, timeout_seconds: int, repository_code: bool = True,
            network: bool = False, in_checkout: bool = True,
            on_wait: Callable[[], None] | None = None) -> dict[str, Any]:
        """The command's result: ``exit_code``, ``stdout_tail``, ``stderr_tail``, ``duration_seconds``, ``timed_out``.

        ``in_checkout`` runs it from the checkout (``env -C``: the runner starts every command in ``/work``);
        ``on_wait`` is called about once a minute while it runs (a long build is progress, not a stall).
        """
        command = [ENV, '-C', CHECKOUT, *argv] if in_checkout else list(argv)
        body = {'argv': command, 'timeout_seconds': timeout_seconds, 'repository_code': repository_code,
                'network': network}
        started = self._open(urllib.request.Request(f'{self._base}/exec', data=json.dumps(body).encode(),
                                                    method='POST', headers={'Content-Type': 'application/json'}))
        exec_id = str(started['exec_id'])
        polls = 0
        while True:
            answer = self._open(urllib.request.Request(f'{self._base}/exec/{exec_id}'))
            if answer.get('state') == 'done':
                return {key: value for key, value in answer.items() if key != 'state'}
            polls += 1
            if on_wait is not None and polls % POLLS_PER_WAIT == 0:
                on_wait()
            self._sleep(POLL_SECONDS)


def _open_json(request: urllib.request.Request) -> Any:
    # The runner on the MicroVM's own loopback (a constant URL, never one from the model or the repository).
    with urllib.request.urlopen(request, timeout=30) as answer:
        return json.loads(answer.read())
