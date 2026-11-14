"""The toolchain images: one per language the egress allowlist knows, each on the shared base and entry point."""
import ast
import re
import sys
from pathlib import Path

import pytest

from engineering.runtime import caps, unit_runner
from engineering.runtime.egress import REGISTRY_HOSTS
from engineering.runtime.harness import runner_client
from engineering.runtime.interface import ROLES, SESSION_LIFE_SECONDS

IMAGES = Path(__file__).resolve().parents[4] / 'engineering-images'


RUNTIME = IMAGES.parent / 'lambda' / 'engineering' / 'runtime'
#: What the images run with their system python3 (3.11 on the Debian 12 based ones): the runner and the harness.
SHIPPED_RUNTIME = ('__init__.py', 'interface.py', 'tokens.py', 'checkout.py', 'checkpoints.py', 'outputs.py',
                   'unit_runner.py')
#: The broker's caller identity, which the runtime's agent roles come from (interface.ROLES).
CONNECTORS = RUNTIME.parent / 'connectors'
SHIPPED_CONNECTORS = ('__init__.py', 'identity.py')
SHIPPED = sorted([RUNTIME / name for name in SHIPPED_RUNTIME] + [CONNECTORS / name for name in SHIPPED_CONNECTORS]
                 + list((RUNTIME / 'harness').glob('*.py')))
#: typing names Python 3.11 lacks (3.12 and 3.13 added them).
NEWER_TYPING = {'override', 'TypeAliasType', 'TypeIs', 'ReadOnly', 'NoDefault', 'get_protocol_members', 'is_protocol'}


def _newer_than_3_11(path: Path) -> list[str]:
    source = path.read_text()
    tree = ast.parse(source, feature_version=(3, 11))  # refuses 3.12's type parameters and `type` statements
    found = []
    for node in tree.body:  # an import guarded by `if sys.version_info` is not at the top level
        if isinstance(node, ast.ImportFrom) and node.module == 'typing':
            found += [f'typing.{alias.name}' for alias in node.names if alias.name in NEWER_TYPING]
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            outer = (ast.get_source_segment(source, node) or '').lstrip('rRbBfFuU')[:1]
            for part in node.values:
                inner = ast.get_source_segment(source, part.value) if isinstance(part, ast.FormattedValue) else None
                if inner and ('\\' in inner or outer in inner):
                    found.append(f'line {node.lineno}: an f-string field with a backslash or its own quote')
    return found


@pytest.mark.parametrize('path', SHIPPED, ids=lambda path: str(path.relative_to(RUNTIME.parent)))
def test_what_the_images_run_needs_nothing_newer_than_python_3_11(path):
    assert _newer_than_3_11(path) == []


def test_the_python_3_11_check_catches_what_python_3_11_refuses(tmp_path):
    sample = tmp_path / 'sample.py'
    sample.write_text('from typing import override\nx = f"{"a".upper()}"\ny = f"{chr(10) + \'\\\\n\'}"\n')
    assert len(_newer_than_3_11(sample)) == 3
    sample.write_text('def f[T](value: T) -> T:\n    return value\n')
    with pytest.raises(SyntaxError):
        _newer_than_3_11(sample)


def _imports(path: Path) -> set[str]:
    """The modules ``path`` imports at run time (``if TYPE_CHECKING`` blocks are for the type checker only)."""
    tree = ast.parse(path.read_text())
    checking = {id(node) for block in ast.walk(tree)
                if isinstance(block, ast.If) and 'TYPE_CHECKING' in ast.unparse(block.test)
                for node in ast.walk(block)}
    found: set[str] = set()
    for node in ast.walk(tree):
        if id(node) in checking:
            continue
        if isinstance(node, ast.Import):
            found |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module)
    return found


def _module(path: Path) -> str:
    parts = path.relative_to(RUNTIME.parent.parent).with_suffix('').parts
    return '.'.join(parts[:-1] if parts[-1] == '__init__' else parts)


@pytest.mark.parametrize('path', SHIPPED, ids=lambda path: str(path.relative_to(RUNTIME.parent)))
def test_what_the_images_run_imports_only_the_standard_library_boto3_and_each_other(path):
    shipped = {_module(module) for module in SHIPPED} | {'engineering'}
    foreign = {name for name in _imports(path)
               if name.split('.')[0] not in {*sys.stdlib_module_names, 'boto3', 'botocore'} and name not in shipped}
    assert foreign == set()


@pytest.mark.parametrize('language', sorted(REGISTRY_HOSTS))
def test_each_image_ships_the_harness_and_pins_boto3(language):
    dockerfile = (IMAGES / language / 'Dockerfile').read_text()
    for name in SHIPPED_RUNTIME:
        assert f'lambda/engineering/runtime/{name}' in dockerfile
    connectors = ' '.join(f'lambda/engineering/connectors/{name}' for name in SHIPPED_CONNECTORS)
    assert f'COPY {connectors} /opt/voc/engineering/connectors/' in dockerfile
    assert 'COPY lambda/engineering/runtime/harness/*.py /opt/voc/engineering/runtime/harness/' in dockerfile
    assert 'COPY engineering-images/common/harness.py /opt/voc/harness.py' in dockerfile
    assert 'ARG BOTO3_VERSION' in dockerfile
    assert '"$MOUNTPOINT_VERSION" "$MOUNTPOINT_SHA256" "$BOTO3_VERSION"' in dockerfile


def test_the_base_installs_exactly_the_pinned_boto3():
    base = (IMAGES / 'common' / 'install-base.sh').read_text()
    assert 'boto3_version="${3:?' in base
    assert '"boto3==${boto3_version}"' in base


def test_there_is_an_image_for_exactly_the_languages_with_registries():
    languages = {path.name for path in IMAGES.iterdir() if (path / 'Dockerfile').is_file()}
    assert languages == set(REGISTRY_HOSTS)


@pytest.mark.parametrize('language', sorted(REGISTRY_HOSTS))
def test_each_image_installs_the_shared_base_and_starts_through_the_shared_entry_point(language):
    dockerfile = (IMAGES / language / 'Dockerfile').read_text()
    assert 'RUN sh /tmp/install-base.sh' in dockerfile
    assert 'COPY lambda/engineering/runtime/unit_runner.py /opt/voc/unit_runner.py' in dockerfile
    assert 'ENTRYPOINT ["sh", "/opt/voc/entrypoint.sh"]' in dockerfile
    for hook in ('ready.sh', 'validate.sh'):
        assert f'engineering-images/{language}/{hook}' in dockerfile
        assert (IMAGES / language / hook).read_text().startswith('#!/bin/sh\n')


@pytest.mark.parametrize('language', sorted(REGISTRY_HOSTS))
def test_each_image_is_built_for_arm64_and_serves_agentcores_port(language):
    # AgentCore Runtime (platform version V2) runs arm64 images that answer /ping and /invocations on port 8080.
    dockerfile = (IMAGES / language / 'Dockerfile').read_text()
    assert [line for line in dockerfile.splitlines() if line.startswith('FROM ')] == [
        line for line in dockerfile.splitlines() if line.startswith('FROM --platform=linux/arm64 ')]
    assert 'EXPOSE 8080' in dockerfile


@pytest.mark.parametrize('language', sorted(REGISTRY_HOSTS))
def test_each_ready_hook_names_only_its_own_registries(language):
    ready = (IMAGES / language / 'ready.sh').read_text()
    others = {host for other, hosts in REGISTRY_HOSTS.items() if other != language for host in hosts}
    assert not [host for host in others if host in ready]


def test_the_entry_point_turns_the_sandbox_on_and_mounts_nothing_before_a_session():
    entrypoint = (IMAGES / 'common' / 'entrypoint.sh').read_text()
    assert '--secrets-dir /run/voc --sandbox $firewall' in entrypoint
    assert "firewall='--code-firewall --egress-firewall'" in entrypoint
    # The service's port, and the two egress proxies on loopback: the agent's and the dependency step's.
    assert '--port 8080 --agent-port 8081 --proxy-port 3128' in entrypoint
    assert '--code-proxy-port 3129 --workdir /work' in entrypoint
    for tables in ('iptables', 'ip6tables'):
        # First in OUTPUT: no earlier ACCEPT lets `code` or `unit` past them. Repository code reaches only its own
        # proxy; the agent only the runner and its own proxy; neither a name lookup, a link-local address, the other's
        # proxy nor anything else.
        assert f'{tables} -I OUTPUT 1 -o lo -p tcp --dport 3129 -m owner --uid-owner code -j ACCEPT' in entrypoint
        assert '--dport 3128 -m owner --uid-owner code' not in entrypoint
        assert '--dport 3129 -m owner --uid-owner unit' not in entrypoint
        assert f'{tables} -I OUTPUT 2 -m owner --uid-owner code -j REJECT' in entrypoint
        # The agent reaches the runner's agent API (8081) only: never 8080, the service's (session, start, hold, wake).
        assert f'{tables} -I OUTPUT 3 -o lo -p tcp --dport 8081 -m owner --uid-owner unit -j ACCEPT' in entrypoint
        assert '--dport 8080 -m owner --uid-owner unit' not in entrypoint
        assert f'{tables} -I OUTPUT 4 -o lo -p tcp --dport 3128 -m owner --uid-owner unit -j ACCEPT' in entrypoint
        assert f'{tables} -I OUTPUT 5 -m owner --uid-owner unit -j REJECT' in entrypoint
    assert ' -A OUTPUT' not in entrypoint
    assert '--dport 53' not in entrypoint
    assert (unit_runner.AGENT_PORT, unit_runner.PROXY_PORT, unit_runner.CODE_PROXY_PORT) == (8081, 3128, 3129)
    assert f'http://127.0.0.1:{unit_runner.AGENT_PORT}' == runner_client.RUNNER_URL
    assert f'127.0.0.1:{unit_runner.AGENT_PORT}' in (IMAGES / 'common' / 'check-runner.sh').read_text()
    # The hard-link guard is said only when the session's file system is its own or protected links are on.
    assert "guard='--hardlink-guard'" in entrypoint
    assert '--sandbox $firewall $guard' in entrypoint
    assert 'mount-s3' not in entrypoint


def _image_env(language: str) -> dict[str, str]:
    """The ``ENV`` names and values a toolchain image sets (its continued lines joined)."""
    text = (IMAGES / language / 'Dockerfile').read_text().replace('\\\n', ' ')
    return dict(item.split('=', 1) for line in text.splitlines() if line.startswith('ENV ')
                for item in line.removeprefix('ENV ').split())


@pytest.mark.parametrize('language', sorted(REGISTRY_HOSTS))
def test_every_variable_an_image_sets_reaches_the_repositorys_code(language):
    # The runner passes only the names it lists: one an image sets and the runner drops does nothing.
    assert set(_image_env(language)) <= {*unit_runner.PASSED_ENV, *unit_runner.TOOLCHAIN_ENV}


def test_the_java_image_runs_gradle_without_its_daemon():
    # The daemon's client talks to it over loopback, which the code firewall rejects in the dependency step.
    assert _image_env('java')['GRADLE_OPTS'] == '-Dorg.gradle.daemon=false'
    env = unit_runner.command_env({'GRADLE_OPTS': '-Dorg.gradle.daemon=false', 'PATH': '/usr/bin'}, repository_code=True)
    assert env['GRADLE_OPTS'] == '-Dorg.gradle.daemon=false'


@pytest.mark.parametrize('language', sorted(REGISTRY_HOSTS))
def test_every_hook_runs_from_a_directory_no_repository_can_write(language):
    for hook in ('ready.sh', 'validate.sh'):
        assert '\ncd /\n' in (IMAGES / language / hook).read_text()


def test_the_stack_has_an_execution_role_for_exactly_the_runtimes_agent_roles():
    stack = (IMAGES.parent / 'lib' / 'stacks' / 'engineering-runtime.ts').read_text()
    listed = re.search(r'const AGENT_ROLES = \[(.*?)\];', stack, re.DOTALL)
    assert listed is not None
    assert set(re.findall(r"'([a-z-]+)'", listed.group(1))) == set(ROLES)


def test_the_stack_takes_an_image_for_exactly_the_languages_with_an_image():
    stack = (IMAGES.parent / 'lib' / 'stacks' / 'engineering-agentcore.ts').read_text()
    listed = re.search(r'const IMAGE_LANGUAGES = \[(.*?)\];', stack, re.DOTALL)
    assert listed is not None
    assert set(re.findall(r"'([a-z]+)'", listed.group(1))) == set(REGISTRY_HOSTS)


def test_the_stack_and_the_runtime_agree_on_the_rates_the_idle_timeout_and_the_session_life():
    stack = (IMAGES.parent / 'lib' / 'stacks' / 'engineering-agentcore.ts').read_text()
    rates = re.search(r'DEFAULT_RATES: Readonly<Record<string, string>> = \{(.*?)\};', stack, re.DOTALL)
    assert rates is not None
    assert dict(re.findall(r"(\w+): '([0-9.]+)'", rates.group(1))) == caps.DEFAULT_RATES
    assert f'IDLE_TIMEOUT_SECONDS = {caps.IDLE_TIMEOUT_SECONDS}' in stack
    assert 'MAX_LIFETIME_SECONDS = 8 * 3600' in stack
    assert SESSION_LIFE_SECONDS == 8 * 3600
    assert f'BUILD_MEMORY_MIB = {sorted(caps.BUILD_SIZES)[0]}' in stack
    assert f'SESSION_QUOTA = {caps.DEFAULT_MAX_SESSIONS}' in stack
    assert f'MIN_MAX_SESSIONS = {caps.MIN_MAX_SESSIONS}' in stack


def test_the_fewest_sessions_a_deployment_may_set_fit_one_run_the_agents_api_starts():
    api = (RUNTIME.parent.parent / 'api' / 'agents_handler.py').read_text()
    cap = re.search(r'^RUN_TASK_CAP = (\d+)$', api, re.MULTILINE)
    assert cap is not None
    assert int(cap.group(1)) + 1 == caps.MIN_MAX_SESSIONS   # (its tasks and its coordinator)


def test_each_toolchain_is_pointed_at_the_dependency_steps_own_proxy():
    # Maven reads no HTTPS_PROXY: the Java image gives `code` settings that name the dependency step's proxy.
    dockerfile = (IMAGES / 'java' / 'Dockerfile').read_text()
    settings = (IMAGES / 'java' / 'maven-settings.xml').read_text()
    assert 'COPY engineering-images/java/maven-settings.xml /home/code/.m2/settings.xml' in dockerfile
    assert ('<host>127.0.0.1</host>' in settings, f'<port>{unit_runner.CODE_PROXY_PORT}</port>' in settings) == (
        True, True)
    # Node's fetch reads the proxy variables only when asked; pip, npm and cargo read them.
    assert unit_runner.CODE_PROXY_ENV['NODE_USE_ENV_PROXY'] == '1'


def test_the_base_strips_every_setuid_and_setgid_bit_so_no_command_regains_root():
    base = (IMAGES / 'common' / 'install-base.sh').read_text()
    assert 'find / -xdev -type f -perm /6000 -exec chmod ug-s {} +' in base


def test_the_base_keeps_the_agents_home_from_repository_code():
    base = (IMAGES / 'common' / 'install-base.sh').read_text()
    assert 'useradd --create-home --uid 10002 --gid work code' in base
    assert 'chmod 700 /home/unit' in base
