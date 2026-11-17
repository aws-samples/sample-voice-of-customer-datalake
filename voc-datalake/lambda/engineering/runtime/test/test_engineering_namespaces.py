"""The namespace wall's command wrapper, run for real (7.50.03: unit_runner.own_namespaces and ``forward``).

Linux only, and only where this host lets an unprivileged user make a user and network namespace of its own (as
AgentCore Runtime does, probed 2026-11-17); elsewhere (macOS, a kernel or an AppArmor profile that refuses
unprivileged user namespaces) every test is skipped, saying why. The image's tools are where the images put them
(util-linux's unshare and setpriv, iproute2's ip): a host without them skips too.

Each test runs the wrapper as this test's own user: the drop to ``unit`` or ``code`` before it is root's, and is
pinned by the argv tests (test_engineering_local_runtime.py) and the walls' harness (test_engineering_walls.py).
"""
import json
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from engineering.runtime import unit_runner

#: This file's runner, as the forwarder runs it in the image (``python3 -I /opt/voc/unit_runner.py forward``).
FORWARDER = (sys.executable, '-I', unit_runner.__file__)


def _why_not() -> str:
    """Why the wrapper cannot run here ('' when it can)."""
    if sys.platform != 'linux':
        return f'Linux only: user and network namespaces are a Linux kernel feature (this host is {sys.platform})'
    missing = [tool for tool in (unit_runner.UNSHARE, unit_runner.SETPRIV, unit_runner.IP, unit_runner.SH)
               if not os.access(tool, os.X_OK)]
    if missing:
        return f'the image\'s tools are not on this host: {", ".join(missing)}'
    probe = subprocess.run(unit_runner.own_namespaces(['true'], []), capture_output=True, text=True, timeout=30,  # noqa: S603 - the wrapper's own constant argv
                           check=False)
    if probe.returncode != 0:
        return ('this host refuses an unprivileged user its own user and network namespace '
                f'({probe.stderr.strip()[:160] or probe.returncode})')
    return ''


WHY_NOT = _why_not()
pytestmark = pytest.mark.skipif(bool(WHY_NOT), reason=WHY_NOT or 'runs')


def _inside(code: str, forwards: list[tuple[int, str]] | None = None) -> dict:
    """``code`` (Python printing one JSON line) run in its own namespaces through the wrapper, its answer."""
    argv = unit_runner.own_namespaces([sys.executable, '-I', '-c', code], forwards or [], FORWARDER)
    answer = subprocess.run(argv, capture_output=True, text=True, timeout=60, check=False)  # noqa: S603 - the wrapper's argv around a constant probe
    assert answer.returncode == 0, answer.stderr
    return json.loads(answer.stdout.strip().splitlines()[-1])


@pytest.fixture
def outside() -> Iterator[int]:
    """A TCP server on this host's own loopback (outside the namespaces): its port."""
    server = socket.create_server(('127.0.0.1', 0))
    try:
        yield server.getsockname()[1]
    finally:
        server.close()


@pytest.fixture
def unix_echo() -> Iterator[str]:
    """A Unix socket server outside the namespaces that answers each line with ``echo:<line>``: its path."""
    directory = tempfile.mkdtemp(prefix='voc-ns-', dir='/tmp')
    path = os.path.join(directory, 's.sock')

    class Echo(socketserver.StreamRequestHandler):
        def handle(self) -> None:
            self.wfile.write(b'echo:' + self.rfile.readline())

    server = unit_runner.UnixServer(path, Echo, os.getuid())
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield path
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(directory, ignore_errors=True)


PROBE = '''
import json, os, socket, sys
def reach(address, port):
    try:
        with socket.create_connection((address, port), timeout=2):
            return True
    except OSError:
        return False
status = dict(line.split(':', 1) for line in open('/proc/self/status') if ':' in line)
print(json.dumps({'interfaces': [name for _, name in socket.if_nameindex()],
                  'outside_loopback': reach('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else PORT),
                  'metadata': reach('169.254.169.254', 80), 'anywhere': reach('52.94.1.1', 443),
                  'caps': status['CapEff'].strip(), 'bounding': status['CapBnd'].strip(),
                  'no_new_privs': status.get('NoNewPrivs', '').strip(), 'uid': os.getuid()}))
'''


def test_a_command_sees_only_its_own_loopback_and_reaches_nothing_outside(outside: int):
    seen = _inside(PROBE.replace('PORT', str(outside)))
    # Its own network namespace: only its loopback, nothing on the host's network, no link-local credential endpoint.
    assert seen['interfaces'] == ['lo']
    assert (seen['outside_loopback'], seen['metadata'], seen['anywhere']) == (False, False, False)


def test_a_command_runs_with_no_capability_and_no_new_privileges():
    seen = _inside(PROBE.replace('PORT', '9'))
    assert (int(seen['caps'], 16), int(seen['bounding'], 16), seen['no_new_privs']) == (0, 0, '1')
    assert seen['uid'] == 0   # (root of a user namespace that owns nothing but its own network namespace)


def test_the_forwarder_bridges_its_port_to_its_socket_and_nothing_else(unix_echo: str, outside: int):
    bridged = '''
import json, socket
with socket.create_connection(('127.0.0.1', 3128), timeout=5) as tunnel:
    tunnel.sendall(b'ping\\n')
    answer = tunnel.recv(64).decode()
try:
    socket.create_connection(('127.0.0.1', PORT), timeout=2).close()
    other = True
except OSError:
    other = False
print(json.dumps({'answer': answer, 'other': other, 'interfaces': [n for _, n in socket.if_nameindex()]}))
'''.replace('PORT', str(outside))
    seen = _inside(bridged, [(3128, unix_echo)])
    assert seen == {'answer': 'echo:ping\n', 'other': False, 'interfaces': ['lo']}


def test_a_socket_that_is_gone_or_another_users_is_a_refused_connection(tmp_path: Path):
    gone = str(tmp_path / 'closed.sock')
    refused = '''
import json, socket
with socket.create_connection(('127.0.0.1', 3129), timeout=5) as tunnel:
    tunnel.sendall(b'CONNECT pypi.org:443 HTTP/1.1\\r\\n\\r\\n')
    print(json.dumps({'answer': tunnel.recv(64).decode()}))
'''
    assert _inside(refused, [(3129, gone)]) == {'answer': ''}


def test_the_forwarder_ends_with_its_command():
    # The command exits at once; the wrapper returns, so nothing of it (the bridging child) holds its pipes open.
    answer = subprocess.run(  # noqa: S603 - the wrapper's argv around a constant command
        unit_runner.own_namespaces([sys.executable, '-c', 'print("done")'], [(3128, '/nonexistent.sock')], FORWARDER),
        capture_output=True, text=True, timeout=30, check=False)
    assert (answer.returncode, answer.stdout.strip()) == (0, 'done')
