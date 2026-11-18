"""The namespace wall's command wrapper, run for real (7.50.03: unit_runner.own_namespaces and ``forward``).

Linux only, and only where this host lets an unprivileged user make a user and network namespace of its own (as
AgentCore Runtime does, probed 2026-11-17); elsewhere (macOS, a kernel or an AppArmor profile that refuses
unprivileged user namespaces) every test is skipped, saying why. The image's tools are where the images put them
(util-linux's unshare and setpriv, iproute2's ip): a host without them skips too.

Each test runs the wrapper as this test's own user: the drop to ``unit`` or ``code`` before it is root's, and is
pinned by the argv tests (test_engineering_local_runtime.py) and the walls' harness (test_engineering_walls.py). The
checkout's tests of both users (7.54.00: repository code's read-only git) drive the runner itself, as root drops each
command to its user in the image: they need root and the image's users, and skip elsewhere.
"""
import grp
import json
import os
import pwd
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

from engineering.runtime import checkout, unit_runner

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


#: The probe's interfaces, every one and those up (SIOCGIFFLAGS' IFF_UP; /sys shows the network namespace of
#: whoever mounted it, never the probe's own).
INTERFACES = '''
import fcntl, socket, struct
def interfaces():
    def up(name):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            request = struct.pack('16sH22x', name.encode(), 0)
            return bool(struct.unpack('16sH22x', fcntl.ioctl(probe, 0x8913, request))[1] & 1)
    every = [name for _, name in socket.if_nameindex()]
    return {'all': every, 'up': [name for name in every if up(name)]}
'''
#: The tunnels a kernel may make in every new network namespace (``net.core.fb_tunnels_only_for_init_net`` 0, as on
#: Docker Desktop's, found when these tests first ran, 7.51.03): down and with no underlay, so no way out. walls.sh
#: counts only the interfaces that are up.
FALLBACK_TUNNELS = frozenset({'tunl0', 'gre0', 'gretap0', 'erspan0', 'ip_vti0', 'ip6_vti0', 'sit0', 'ip6tnl0',
                              'ip6gre0'})


def _only_loopback(seen: dict) -> bool:
    """Only the loopback is up, and anything else is a kernel's fallback tunnel."""
    return seen['up'] == ['lo'] and set(seen['all']) - {'lo'} <= FALLBACK_TUNNELS


PROBE = INTERFACES + '''
import json, os, socket, sys
def reach(address, port):
    try:
        with socket.create_connection((address, port), timeout=2):
            return True
    except OSError:
        return False
status = dict(line.split(':', 1) for line in open('/proc/self/status') if ':' in line)
print(json.dumps({'interfaces': interfaces(),
                  'outside_loopback': reach('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else PORT),
                  'metadata': reach('169.254.169.254', 80), 'anywhere': reach('52.94.1.1', 443),
                  'caps': status['CapEff'].strip(), 'bounding': status['CapBnd'].strip(),
                  'no_new_privs': status.get('NoNewPrivs', '').strip(), 'uid': os.getuid()}))
'''


def test_a_command_sees_only_its_own_loopback_and_reaches_nothing_outside(outside: int):
    seen = _inside(PROBE.replace('PORT', str(outside)))
    # Its own network namespace: only its loopback, nothing on the host's network, no link-local credential endpoint.
    assert _only_loopback(seen['interfaces']), seen['interfaces']
    assert (seen['outside_loopback'], seen['metadata'], seen['anywhere']) == (False, False, False)


def test_a_command_runs_with_no_capability_and_no_new_privileges():
    seen = _inside(PROBE.replace('PORT', '9'))
    assert (int(seen['caps'], 16), int(seen['bounding'], 16), seen['no_new_privs']) == (0, 0, '1')
    assert seen['uid'] == 0   # (root of a user namespace that owns nothing but its own network namespace)


def test_the_forwarder_bridges_its_port_to_its_socket_and_nothing_else(unix_echo: str, outside: int):
    bridged = INTERFACES + '''
import json, socket
with socket.create_connection(('127.0.0.1', 3128), timeout=5) as tunnel:
    tunnel.sendall(b'ping\\n')
    answer = tunnel.recv(64).decode()
try:
    socket.create_connection(('127.0.0.1', PORT), timeout=2).close()
    other = True
except OSError:
    other = False
print(json.dumps({'answer': answer, 'other': other, 'interfaces': interfaces()}))
'''.replace('PORT', str(outside))
    seen = _inside(bridged, [(3128, unix_echo)])
    assert (seen['answer'], seen['other']) == ('echo:ping\n', False)
    assert _only_loopback(seen['interfaces']), seen['interfaces']


def test_a_socket_that_is_gone_or_another_users_is_a_refused_connection(tmp_path: Path):
    gone = str(tmp_path / 'closed.sock')
    # The forwarder closes the connection at once. When the request reached it first, the close is a reset, which is
    # refused all the same: nothing comes back either way.
    refused = '''
import json, socket
try:
    with socket.create_connection(('127.0.0.1', 3129), timeout=5) as tunnel:
        tunnel.sendall(b'CONNECT pypi.org:443 HTTP/1.1\\r\\n\\r\\n')
        answer = tunnel.recv(64).decode()
except (ConnectionResetError, BrokenPipeError):
    answer = ''
print(json.dumps({'answer': answer}))
'''
    assert _inside(refused, [(3129, gone)]) == {'answer': ''}


def test_the_forwarder_ends_with_its_command():
    # The command exits at once; the wrapper returns, so nothing of it (the bridging child) holds its pipes open.
    answer = subprocess.run(  # noqa: S603 - the wrapper's argv around a constant command
        unit_runner.own_namespaces([sys.executable, '-c', 'print("done")'], [(3128, '/nonexistent.sock')], FORWARDER),
        capture_output=True, text=True, timeout=30, check=False)
    assert (answer.returncode, answer.stdout.strip()) == (0, 'done')


#: Git as the agent's checkout runs it (checkout.GIT): the test's repositories are made with it too.
GIT = '/usr/bin/git'
#: A uid no namespace of these tests maps (``nobody``'s): a file it owns shows inside as the overflow uid.
OTHER_UID = 65534


def _git(*argv: str) -> str:
    return subprocess.run((GIT, *argv), check=True, capture_output=True, text=True,  # noqa: S603 - git on the test's own repositories
                          timeout=60).stdout.strip()


def _cache_entry(tmp_path: Path) -> tuple[str, str]:
    """A repository with a file in and a file out of the sparse paths, and the cache's entry of its commit as its
    writer keeps one (bare, depth 1, filters allowed): the entry's path and the commit."""
    if not os.access(GIT, os.X_OK):
        pytest.skip(f'no {GIT} on this host')
    origin = tmp_path / 'origin'
    (origin / 'pkg').mkdir(parents=True)
    (origin / 'docs').mkdir()
    (origin / 'pkg' / 'divide.py').write_text('def divide(a, b):\n    return a // b\n')
    (origin / 'docs' / 'notes.md').write_text('outside the sparse paths\n')
    _git('-c', 'init.defaultBranch=main', 'init', '--quiet', str(origin))
    _git('-C', str(origin), 'add', '.')
    _git('-C', str(origin), '-c', 'user.name=Example', '-c', 'user.email=dev@example.org', 'commit', '--quiet',
         '-m', 'first')
    commit = _git('-C', str(origin), 'rev-parse', 'HEAD')
    entry = tmp_path / 'cache' / commit / 'g1' / 'repo.git'
    _git('clone', '--quiet', '--bare', '--depth=1', f'file://{origin}', str(entry))
    _git('-C', str(entry), 'config', 'uploadpack.allowFilter', 'true')
    return str(entry), commit


def _as_agent(argv: tuple[str, ...], cwd: Path) -> subprocess.CompletedProcess[str]:
    """``argv`` in its own namespaces, as the agent's commands run (no forwarder: nothing here calls out)."""
    return subprocess.run(unit_runner.own_namespaces(list(argv), []), cwd=cwd, capture_output=True, text=True,  # noqa: S603 - the wrapper's argv around the checkout's own commands
                          timeout=120, check=False)


def test_the_agents_checkout_clones_and_reads_a_cache_its_own_user_owns(tmp_path: Path):
    """7.51.03: the cache mount's files are ``unit``'s (``--uid``/``--gid``), the user the agent's namespace maps, so
    inside it they are its root's and git takes the cache's repository as its own. The clone, the sparse checkout,
    the checkout and a later fetch of a blob outside the sparse paths all succeed."""
    entry, commit = _cache_entry(tmp_path)
    work = tmp_path / 'work'
    work.mkdir()
    for command in checkout.checkout_commands(commit, ['pkg'], 1, source=f'file://{entry}'):
        ran = _as_agent(command.argv, work)
        assert ran.returncode == 0, ran.stderr
    assert (work / 'repo' / 'pkg' / 'divide.py').is_file()
    assert not (work / 'repo' / 'docs').exists()
    lazy = _as_agent(checkout.repo_git('show', f'{commit}:docs/notes.md'), work)
    assert (lazy.returncode, lazy.stdout) == (0, 'outside the sparse paths\n'), lazy.stderr


def test_the_agents_checkout_refuses_a_cache_another_uid_owns_as_dubious(tmp_path: Path):
    """The failure 7.51.03 fixes: a cache owned by a uid the namespace does not map (root's, as the mount showed it)
    shows inside as the overflow uid, and git refuses it (exit 128), whatever its file modes allow."""
    if os.geteuid() != 0:
        pytest.skip('making a repository another uid owns needs root (chown)')
    entry, commit = _cache_entry(tmp_path)
    for root, directories, files in os.walk(tmp_path / 'cache'):
        for name in (root, *(os.path.join(root, found) for found in (*directories, *files))):
            os.lchown(name, OTHER_UID, OTHER_UID)
    work = tmp_path / 'work'
    work.mkdir()
    clone = checkout.checkout_commands(commit, ['pkg'], 1, source=f'file://{entry}')[0]
    ran = _as_agent(clone.argv, work)
    assert ran.returncode == 128
    assert 'detected dubious ownership' in ran.stderr


def _why_not_as_the_image() -> str:
    """Why the runner cannot drop commands to the image's two users here ('' when it can)."""
    if os.geteuid() != 0:
        return 'the runner drops each command to `unit` or `code`, which needs root (as the image\'s entry point is)'
    try:
        for user in ('unit', 'code'):
            pwd.getpwnam(user)
        grp.getgrnam('work')
    except KeyError:
        return 'the image\'s users (`unit` and `code`, in the group `work`) are not on this host'
    return ''


AS_THE_IMAGE = _why_not_as_the_image()


@dataclass(frozen=True)
class ImageCheckout:
    """A runner as the image's (sandbox on, the namespace walls), its working directory and the commit checked out."""

    runner: unit_runner.Runner
    work: Path
    commit: str

    def run(self, argv: tuple[str, ...], *, repository_code: bool) -> dict:
        """``argv`` through the runner, as ``code`` (repository code) or ``unit`` (the agent): its result."""
        exec_id = self.runner.start({'argv': list(argv), 'timeout_seconds': 120, 'repository_code': repository_code})
        deadline = time.monotonic() + 120
        while (result := self.runner.poll(exec_id)) is None:
            assert time.monotonic() < deadline, argv
            time.sleep(0.05)
        return result

    def code(self, *argv: str) -> dict:
        return self.run(argv, repository_code=True)

    def agent(self, *argv: str) -> dict:
        return self.run(argv, repository_code=False)


def _own(path: str | Path, user: str) -> None:
    os.lchown(path, pwd.getpwnam(user).pw_uid, grp.getgrnam('work').gr_gid)


@pytest.fixture
def image_checkout() -> Iterator[ImageCheckout]:
    """The image's layout in a directory of its own: a working directory like ``/work`` (``unit``'s, group ``work``, not
    group-writable), the cache's entry as its mount shows it (``unit``'s, 7.51.03), a runner over them behind the
    namespace walls, and the agent's checkout of ``pkg`` made through it, every step exiting 0."""
    if AS_THE_IMAGE:
        pytest.skip(AS_THE_IMAGE)
    base = Path(tempfile.mkdtemp(prefix='voc-checkout-', dir='/tmp'))
    runner: unit_runner.Runner | None = None
    try:
        os.chmod(base, 0o755)  # noqa: S103 - traversable by both users, as / is: only its subdirectories are theirs
        entry, commit = _cache_entry(base)
        for root, directories, files in os.walk(base / 'cache'):
            for name in (root, *(os.path.join(root, found) for found in (*directories, *files))):
                _own(name, 'unit')
        work, home = base / 'work', base / 'unit-home'
        work.mkdir()
        home.mkdir(mode=0o700)
        for made in (work, home):
            _own(made, 'unit')
        os.chmod(work, 0o2755)  # noqa: S103 - the image's /work (install-base.sh): never the group's to write
        (base / 'secrets').mkdir()
        runner = unit_runner.Runner(
            str(work), sandbox=True, secrets_dir=str(base / 'secrets'), agent_home=str(home),
            egress_namespaces=True, code_namespaces=True, hardlink_guard='protected_hardlinks',
            namespaces=unit_runner.Namespaces(socket_dir=str(base / 'sockets'), forwarder=FORWARDER))
        assert (runner.walls()['egress'], runner.walls()['code']) == ('namespaces', 'namespaces')
        session = ImageCheckout(runner, work, commit)
        for command in checkout.checkout_commands(commit, ['pkg'], 1, source=f'file://{entry}'):
            ran = session.run(command.argv, repository_code=command.repository_code)
            assert ran['exit_code'] == 0, ran['stderr_tail']
        yield session
    finally:
        if runner is not None:
            runner.kill_all()
        shutil.rmtree(base, ignore_errors=True)


IDENTITY = ('-c', 'user.name=Example', '-c', 'user.email=dev@example.org')


def test_repository_codes_git_reads_the_checkout_and_writes_nothing_in_its_git_directory(image_checkout: ImageCheckout):
    """7.54.00: as ``code`` (in a user namespace of its own, where the checkout is the overflow uid's), git's read-only
    commands work on the agent's checkout, from its root or below it, and without the runner's keys they are refused
    (7.51.03's finding); every write in the git directory fails, and the agent's own commands see none of them."""
    session = image_checkout
    git_dir = session.work / unit_runner.GIT_DIR
    config = (git_dir / 'config').read_bytes()
    changed = session.code(sys.executable, '-c', "open('repo/pkg/divide.py', 'a').write('# changed\\n')")
    assert changed['exit_code'] == 0, changed['stderr_tail']
    status = session.code(GIT, '-C', 'repo', 'status', '--porcelain')
    diff = session.code(GIT, '-C', 'repo', 'diff')
    listed = session.code(GIT, '-C', 'repo', 'ls-files')
    last = session.code(GIT, '-C', 'repo', 'log', '-1', '--format=%H')
    below = session.code(GIT, '-C', 'repo/pkg', 'rev-parse', '--show-toplevel')
    for ran in (status, diff, listed, last, below):
        assert (ran['exit_code'], ran['stderr_tail']) == (0, ''), ran
    assert status['stdout_tail'].splitlines() == [' M pkg/divide.py']
    assert '+# changed' in diff['stdout_tail'].splitlines()
    assert 'pkg/divide.py' in listed['stdout_tail'].split()
    assert last['stdout_tail'].strip() == session.commit
    assert below['stdout_tail'].strip() == str(session.work / unit_runner.CHECKOUT_DIR)
    # Without the runner's keys git refuses the checkout, as it did before 7.54.00.
    unnamed = session.code('/usr/bin/env', '-u', 'GIT_CONFIG_COUNT', GIT, '-C', 'repo', 'status')
    assert (unnamed['exit_code'], 'detected dubious ownership' in unnamed['stderr_tail']) == (128, True), unnamed
    # Every write in the git directory is refused: the index (a commit, an add), a ref, the config.
    for write in (('commit', '--quiet', '--all', '-m', 'planted'), ('add', 'pkg/divide.py'),
                  ('update-ref', 'refs/heads/planted', 'HEAD'), ('config', 'core.fsmonitor', 'touch /tmp/ran')):
        ran = session.code(GIT, '-C', 'repo', *IDENTITY, *write)
        assert (ran['exit_code'] != 0, 'Permission denied' in ran['stderr_tail']) == (True, True), (write, ran)
    assert (git_dir / 'config').read_bytes() == config
    assert not (git_dir / 'refs' / 'heads' / 'planted').exists()
    # The agent's own commands pass, and see the file repository code changed and nothing of what it tried.
    head = session.agent(*checkout.repo_git('rev-parse', 'HEAD'))
    seen = session.agent(*checkout.repo_git('status', '--porcelain'))
    assert (head['exit_code'], head['stdout_tail'].strip()) == (0, session.commit), head
    assert (seen['exit_code'], seen['stdout_tail'].splitlines()) == (0, [' M pkg/divide.py']), seen


def test_a_repository_planted_below_the_checkout_stays_refused_to_repository_codes_git(image_checkout: ImageCheckout):
    """``safe.directory`` names the checkout's two directories exactly, never a prefix: a repository the agent made
    below the working tree, or one repository code made in a directory of the checkout's (the agent's), is refused."""
    session = image_checkout
    made = session.agent(GIT, 'init', '--quiet', 'repo/pkg/nested')
    assert made['exit_code'] == 0, made['stderr_tail']
    nested = session.code(GIT, '-C', 'repo/pkg/nested', 'status')
    assert (nested['exit_code'], 'detected dubious ownership' in nested['stderr_tail']) == (128, True), nested
    planted = session.code(GIT, 'init', '--quiet', 'repo/pkg')
    assert planted['exit_code'] == 0, planted['stderr_tail']
    inside = session.code(GIT, '-C', 'repo/pkg', 'status')
    assert (inside['exit_code'], 'detected dubious ownership' in inside['stderr_tail']) == (128, True), inside


@pytest.mark.parametrize('how', ['git-file-changed', 'git-directory-planted'])
def test_a_git_file_repository_code_changes_never_moves_the_agents_git(image_checkout: ImageCheckout, how: str):
    """The working tree's ``.git`` file is the group's to write: repository code's own git follows what it put there,
    and the agent's never reads it (``checkout.repo_git`` names its git directory and work tree)."""
    session = image_checkout
    planted = session.work / unit_runner.CHECKOUT_DIR / 'planted'
    for argv in ((GIT, 'init', '--quiet', 'repo/planted'),
                 (GIT, '-C', 'repo/planted', *IDENTITY, 'commit', '--quiet', '--allow-empty', '-m', 'planted')):
        ran = session.code(*argv)
        assert ran['exit_code'] == 0, ran['stderr_tail']
    if how == 'git-file-changed':
        move = f"open('repo/.git', 'w').write('gitdir: {planted}/.git\\n')"
    else:
        move = "import os; os.remove('repo/.git'); os.rename('repo/planted/.git', 'repo/.git')"
    moved = session.code(sys.executable, '-c', move)
    assert moved['exit_code'] == 0, moved['stderr_tail']
    own = session.code(GIT, '-C', 'repo', 'rev-parse', 'HEAD')
    assert (own['exit_code'], own['stdout_tail'].strip() != session.commit) == (0, True), own
    for argv in (('rev-parse', 'HEAD'), ('log', '-1', '--format=%H'), ('ls-files', 'pkg')):
        ran = session.agent(*checkout.repo_git(*argv))
        assert ran['exit_code'] == 0, ran['stderr_tail']
        assert ran['stdout_tail'].strip() == ('pkg/divide.py' if argv[0] == 'ls-files' else session.commit)
