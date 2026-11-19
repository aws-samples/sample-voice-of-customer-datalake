"""The image's walls (templates/orchestration/images/common/walls.sh, 7.50.03): its decision tree, walked with stub
tools, and the runner each outcome makes (unit_runner.build): the firewall where iptables works, else the namespaces
where each user can make its own, else nothing, and the runner then fails closed; the hard-link guard read, never
written.

walls.sh names its tools in plain assignments at its top; the harness copies the script with only those lines
pointing at stubs (in a directory of the test's own), and runs it with the system's /bin/sh.
"""
import atexit
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path

import pytest

from engineering.runtime import unit_runner
from engineering.runtime.test.local_runtime import close_sockets

WALLS = Path(__file__).resolve().parents[4] / 'templates' / 'orchestration' / 'images' / 'common' / 'walls.sh'
#: A stub that logs its argv (one line per call, in $LOG) and answers as its scenario says.
LOGGING = 'printf "%s\\n" "$(basename "$0") $*" >> "$LOG"\n'


@dataclass(frozen=True)
class Container:
    """What the container lets the entry point do."""

    iptables: bool = False
    #: The users that may make a user and network namespace of their own.
    namespaces: frozenset[str] = frozenset()
    #: Interfaces up in a new network namespace once its loopback is (1: only the loopback).
    up_in_namespace: int = 1
    own_device: bool = True
    protected_hardlinks: str | None = '1'


def _stub(directory: Path, name: str, body: str) -> Path:
    path = directory / name
    path.write_text(f'#!/bin/sh\n{LOGGING}{body}')
    path.chmod(0o755)
    return path


def _run(tmp_path: Path, container: Container) -> tuple[str, list[str]]:
    """walls.sh's printed flags, and the stubs' calls, in ``container``."""
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    log = tmp_path / 'calls.log'
    log.write_text('')
    allowed = ' '.join(sorted(container.namespaces)) or 'nobody'
    tools = {
        'IPTABLES': _stub(bin_dir, 'iptables', 'exit 0\n' if container.iptables else
                          'echo "iptables v1.8.9 (nf_tables): Could not fetch rule set generation id: Permission denied '
                          '(you must be root)" >&2; exit 4\n'),
        'IP6TABLES': _stub(bin_dir, 'ip6tables', 'exit 0\n' if container.iptables else 'exit 4\n'),
        # setpriv: the drop to a user, then the rest of its argv (after --); unshare: the namespaces, if allowed.
        'SETPRIV': _stub(bin_dir, 'setpriv', 'for a; do case "$a" in --reuid=*) echo "${a#--reuid=}" > "$LOG.user";; '
                         '--) shift; exec "$@";; esac; shift; done\n'),
        'UNSHARE': _stub(bin_dir, 'unshare', f'user=$(cat "$LOG.user"); case " {allowed} " in *" $user "*) ;; '
                         '*) echo "unshare: unshare failed: Operation not permitted" >&2; exit 1;; esac\n'
                         'while [ "$1" != -- ]; do shift; done; shift; exec "$@"\n'),
        'IP': _stub(bin_dir, 'ip', 'case "$*" in "link set lo up") exit 0;; "-o link show up") i=0; '
                    f'while [ $i -lt {container.up_in_namespace} ]; do echo "$i: if$i: <UP>"; i=$((i+1)); done;; '
                    'esac\n'),
        'TRUE': _stub(bin_dir, 'true', 'exit 0\n'),
        'STAT': _stub(bin_dir, 'stat', f'case "$3" in */secrets) echo {47 if container.own_device else 45};; '
                      '*) echo 45;; esac\n'),
    }
    hardlinks = tmp_path / 'protected_hardlinks'
    if container.protected_hardlinks is not None:
        hardlinks.write_text(f'{container.protected_hardlinks}\n')
    # The host's own cat and wc (the image's are at /usr/bin; a developer's macOS has cat at /bin only).
    host = {name: shutil.which(name.lower()) or f'/usr/bin/{name.lower()}' for name in ('CAT', 'WC')}
    values = {**{name: str(path) for name, path in tools.items()}, **host, 'HARDLINKS': str(hardlinks),
              'SECRETS': str(tmp_path / 'secrets'), 'WORK': str(tmp_path / 'work')}
    script = WALLS.read_text()
    for name, value in values.items():
        script, found = re.subn(rf'^{name}=\S+$', f'{name}={value}', script, count=1, flags=re.MULTILINE)
        assert found == 1, f'walls.sh names {name} in one plain assignment'
    copied = tmp_path / 'walls.sh'
    copied.write_text(script)
    answer = subprocess.run(['/bin/sh', str(copied)], capture_output=True, text=True, check=True,  # noqa: S603 - the system shell on the test's own copy of walls.sh
                            env={'PATH': '/usr/bin:/bin', 'LOG': str(log)}, timeout=30)
    return answer.stdout.strip(), log.read_text().splitlines()


BOTH_GUARDS = '--hardlink-guard own_device,protected_hardlinks'


def test_where_iptables_works_the_firewall_is_the_wall_and_no_namespace_is_tried(tmp_path):
    flags, calls = _run(tmp_path, Container(iptables=True))
    assert flags == f'--code-firewall --egress-firewall {BOTH_GUARDS}'
    assert not [call for call in calls if call.startswith('unshare')]
    assert len([call for call in calls if call.startswith(('iptables', 'ip6tables'))]) == 10


def test_where_iptables_is_refused_each_users_own_namespaces_are_the_wall(tmp_path):
    # AgentCore Runtime, 2026-11-17: no CAP_NET_ADMIN, user and network namespaces allowed for both users.
    flags, calls = _run(tmp_path, Container(namespaces=frozenset({'unit', 'code'})))
    assert flags == f'--egress-namespaces --code-namespaces {BOTH_GUARDS}'
    # Each user's chain, as the runner makes it: dropped to it, its own namespaces, the loopback up, one interface up,
    # then every capability gone.
    for user in ('unit', 'code'):
        assert (f'setpriv --reuid={user} --regid=work --clear-groups --inh-caps=-all --bounding-set=-all '
                '--no-new-privs -- ' in '\n'.join(calls))
    assert calls.count('ip link set lo up') == 2
    assert calls.count('ip -o link show up') == 2
    assert len([call for call in calls if call.startswith('true')]) == 2


@pytest.mark.parametrize(('container', 'flags'), [
    (Container(), BOTH_GUARDS),
    (Container(namespaces=frozenset({'unit'})), f'--egress-namespaces {BOTH_GUARDS}'),
    (Container(namespaces=frozenset({'code'})), f'--code-namespaces {BOTH_GUARDS}'),
    (Container(namespaces=frozenset({'unit', 'code'}), up_in_namespace=2), BOTH_GUARDS),
], ids=['neither-wall', 'the-agents-only', 'repository-codes-only', 'a-namespace-with-a-way-out'])
def test_a_wall_that_does_not_hold_is_never_claimed(tmp_path, container: Container, flags: str):
    assert _run(tmp_path, container)[0] == flags


@pytest.mark.parametrize(('own_device', 'hardlinks', 'flag'), [
    (True, '1', BOTH_GUARDS),
    (True, '0', '--hardlink-guard own_device'),
    (False, '1', '--hardlink-guard protected_hardlinks'),
    (False, '0', ''),
    (False, None, ''),
    (True, None, '--hardlink-guard own_device'),
], ids=['both', 'own-device', 'protected-hardlinks', 'neither', 'unreadable', 'unreadable-own-device'])
def test_the_hard_link_guard_is_read_and_named_never_written(tmp_path, own_device: bool, hardlinks: str | None,
                                                              flag: str):
    flags, _ = _run(tmp_path, Container(iptables=True, own_device=own_device, protected_hardlinks=hardlinks))
    assert flags == f'--code-firewall --egress-firewall {flag}'.strip()
    if hardlinks is not None:
        assert (tmp_path / 'protected_hardlinks').read_text() == f'{hardlinks}\n'   # (read, never written)


def _runner(tmp_path: Path, flags: str) -> unit_runner.Runner:
    """The runner the entry point makes with ``flags`` (its proxies on free loopback ports, its users the test's)."""
    # (a short directory: a Unix socket's path is at most 104 bytes on macOS; removed when the tests end)
    short = tempfile.mkdtemp(prefix='voc-walls-', dir='/tmp')
    atexit.register(shutil.rmtree, short, True)
    sockets = os.path.join(short, 'net')
    arguments = ['--host', '127.0.0.1', '--port', '0', '--workdir', str(tmp_path), '--agent-home', str(tmp_path),
                 '--secrets-dir', str(tmp_path), '--sandbox', '--socket-dir', sockets]
    _, runner = unit_runner.build([*arguments, *flags.split()])
    if runner.namespaces is not None:
        runner.namespaces = replace(runner.namespaces, agent_uid=os.getuid(), code_uid=os.getuid())
    runner.proxy, runner.code_proxy = unit_runner.EgressProxy(port=0), unit_runner.EgressProxy(port=0)
    return runner


START = {'environment': {'VOC_RUN_ID': '01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'VOC_AGENT_ID': 'fixer-1'},
         'egress': ['bedrock-runtime.us-east-1.amazonaws.com'], 'code_egress': ['pypi.org']}


@pytest.mark.parametrize(('container', 'walls'), [
    (Container(iptables=True), ('iptables', 'iptables')),
    (Container(namespaces=frozenset({'unit', 'code'})), ('namespaces', 'namespaces')),
    (Container(), None),
], ids=['the-firewall', 'the-namespaces', 'no-wall'])
def test_the_runner_starts_an_agent_behind_each_wall_and_none_without_one(tmp_path, container: Container,
                                                                          walls: tuple[str, str] | None):
    flags, _ = _run(tmp_path, container)
    runner = _runner(tmp_path, flags)
    try:
        if walls is None:
            with pytest.raises(ValueError, match='no egress wall'):
                runner.begin(START)
            with pytest.raises(ValueError, match='code firewall or its namespaces'):
                runner.start({'argv': ['npm', 'ci'], 'timeout_seconds': 10, 'network': True})
            return
        answer = runner.begin(START)
        assert (answer['started'], answer['sandbox']['egress'], answer['sandbox']['code']) == (True, *walls)
        assert answer['sandbox']['hardlink_guard'] == ['own_device', 'protected_hardlinks']
    finally:
        close_sockets(runner)
        for proxy in (runner.proxy, runner.code_proxy):
            if proxy is not None:
                proxy.server.server_close()


def test_a_hard_link_guard_the_runner_does_not_know_is_refused():
    with pytest.raises(ValueError, match='hard-link guard'):
        unit_runner.Runner('/work', sandbox=True, secrets_dir='/run/voc', agent_home='/home/unit',
                           hardlink_guard='trust_me')
