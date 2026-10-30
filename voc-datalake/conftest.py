"""Session-wide pytest hooks and the suite clock for both test trees (lambda/ and plugins/).

Per-tree environment and fixtures live in lambda/conftest.py and plugins/conftest.py; this file
keeps only what every tree shares: the X-Ray socket clean-up and the midday clock.
"""
import os
import socket
import sys

import pytest
from suite_clock import MIDDAY_ENV, controller_midday, suite_midday

try:
    import time_machine
except ImportError as exc:  # a venv made before 5.48.05
    raise ImportError('time-machine is missing: run `pip install -r requirements-dev.txt` in voc-datalake/') from exc

_TRAVELLER = pytest.StashKey[time_machine.travel]()


@pytest.hookimpl(tryfirst=True)
def pytest_configure(config: pytest.Config) -> None:
    """Move the clock to 12:00 UTC of today, still ticking, BEFORE collection imports any test module.

    ``tryfirst`` runs this before the other conftests' ``pytest_configure``; a date a conftest computes at its
    own import (none does today) would still be real-clock, since conftests load before any hook runs.

    Many fixtures write "today" / "N days ago" from the wall clock (some at import, e.g. a module-level
    ``NOW``) and the handler under test reads it again. A run that crossed midnight UTC between the two
    (CI started at 23:57 once) split them across two days, and four metrics tests failed for no code reason.
    From noon a run has 11 hours before the next midnight could matter, while every relative date stays the
    real day's. ``tick=True`` keeps time moving, so timeouts, TTLs and durations behave as before.

    The controlling process picks the noon and publishes it (overwriting any stale value from the shell);
    pytest-xdist workers, which inherit the environment, travel to that same noon. To reproduce a run from
    another day, set ``VOC_TEST_MIDDAY_FORCE=<that day>T12:00:00+00:00``.

    Caveats: the clock can sit up to 12 hours away from real time, so a file's ``st_mtime`` or a timestamp
    made outside Python (a subprocess) can look like the future or the past (no test compares either today).
    """
    is_worker = hasattr(config, 'workerinput')
    if not is_worker:
        os.environ[MIDDAY_ENV] = controller_midday().isoformat()
    traveller = time_machine.travel(suite_midday(require_published=is_worker), tick=True)
    traveller.start()
    config.stash[_TRAVELLER] = traveller


def pytest_unconfigure(config: pytest.Config) -> None:
    """Release process-wide resources the suite opened, once every test has run: the clock and the X-Ray socket."""
    traveller = config.stash.get(_TRAVELLER, None)
    if traveller is not None:
        traveller.stop()
    close_xray_emitter_socket()


def close_xray_emitter_socket() -> bool:
    """Close the UDP socket the X-Ray SDK's global recorder opened, if it exists.

    Importing ``aws_xray_sdk.core`` builds ``xray_recorder``, whose ``UDPEmitter``
    opens a datagram socket for the daemon and never closes it (the SDK has no
    close). In Lambda the process just ends; in a test session the interpreter
    reports it at exit as ``ResourceWarning: unclosed <socket.socket ... type=2>``.
    Nothing is imported here: a session that never loaded the SDK has no socket.

    Returns whether a socket was closed.
    """
    core = sys.modules.get('aws_xray_sdk.core')
    recorder = getattr(core, 'xray_recorder', None)
    emitter = getattr(recorder, 'emitter', None)
    udp_socket = getattr(emitter, '_socket', None)
    if not isinstance(udp_socket, socket.socket) or udp_socket.fileno() == -1:
        return False
    udp_socket.close()
    return True
