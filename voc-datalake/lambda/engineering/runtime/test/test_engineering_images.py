"""The toolchain images: one per language the egress allowlist knows, each on the shared base and entry point."""
import ast
import json
import re
import sys
import tomllib
from pathlib import Path

import pytest

from engineering.runtime import caps, unit_runner
from engineering.runtime.egress import REGISTRY_HOSTS
from engineering.runtime.harness import runner_client
from engineering.runtime.interface import ROLES, SESSION_LIFE_SECONDS

#: voc-datalake/, the images' build context; the images are its templates/orchestration/images (7.56.00).
DATALAKE = Path(__file__).resolve().parents[4]
IMAGES = DATALAKE / 'templates' / 'orchestration' / 'images'


RUNTIME = DATALAKE / 'lambda' / 'engineering' / 'runtime'
#: What the images run with their system python3 (3.11 on the Debian 12 based ones): the runner and the harness.
SHIPPED_RUNTIME = ('__init__.py', 'interface.py', 'tokens.py', 'checkout.py', 'checkpoints.py', 'outputs.py',
                   'unit_runner.py')
#: The broker's caller identity, which the runtime's agent roles come from (interface.ROLES).
CONNECTORS = RUNTIME.parent / 'connectors'
SHIPPED_CONNECTORS = ('__init__.py', 'identity.py')
#: The deterministic gate the gate runner's run_gate runs in the session (7.50.00): its standard-library-only modules,
#: and item A's orchestration loader once it lands (bundle.py, the standard library only: never its compiler,
#: validator or runner, which read YAML and JSON Schemas).
QUALITY_GATE = RUNTIME.parent / 'quality_gate'
SHIPPED_GATE = ('__init__.py', 'packs.py', 'checks.py', 'runner.py', 'text.py')
ORCHESTRATION = RUNTIME.parent / 'orchestration'
SHIPPED_ORCHESTRATION = ('__init__.py', 'bundle.py')
SHIPPED = sorted([RUNTIME / name for name in SHIPPED_RUNTIME] + [CONNECTORS / name for name in SHIPPED_CONNECTORS]
                 + list((RUNTIME / 'harness').glob('*.py')) + [QUALITY_GATE / name for name in SHIPPED_GATE]
                 + [ORCHESTRATION / name for name in SHIPPED_ORCHESTRATION if (ORCHESTRATION / name).is_file()])
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
    assert 'COPY templates/orchestration/images/common/harness.py /opt/voc/harness.py' in dockerfile
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
        assert f'templates/orchestration/images/{language}/{hook}' in dockerfile
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
    # (7.50.00: npm's registry is the Python and Rust images' too, for a mixed repository's TypeScript half)
    others = {host for other, hosts in REGISTRY_HOSTS.items() if other != language for host in hosts} - set(
        REGISTRY_HOSTS[language])
    assert not [host for host in others if host in ready]


def test_the_entry_point_turns_the_sandbox_on_behind_the_walls_and_mounts_nothing_before_a_session():
    entrypoint = (IMAGES / 'common' / 'entrypoint.sh').read_text()
    walls = (IMAGES / 'common' / 'walls.sh').read_text()
    # The walls' flags are walls.sh's to print (whichever wall holds, or none: the runner then fails closed).
    assert 'walls=$(/bin/sh /opt/voc/walls.sh)' in entrypoint
    assert '--secrets-dir /run/voc --sandbox $walls' in entrypoint
    assert "flags='--code-firewall --egress-firewall'" in walls
    assert "flags='--egress-namespaces'" in walls
    assert '--code-namespaces' in walls
    # The service's port, and the two egress proxies on loopback: the agent's and the dependency step's.
    assert '--port 8080 --agent-port 8081 --proxy-port 3128' in entrypoint
    assert '--code-proxy-port 3129 --workdir /work' in entrypoint
    for tables in ('IPTABLES', 'IP6TABLES'):
        # First in OUTPUT: no earlier ACCEPT lets `code` or `unit` past them. Repository code reaches only its own
        # proxy; the agent only the runner and its own proxy; neither a name lookup, a link-local address, the other's
        # proxy nor anything else.
        assert f'"${tables}" -I OUTPUT 1 -o lo -p tcp --dport 3129 -m owner --uid-owner code -j ACCEPT' in walls
        assert '--dport 3128 -m owner --uid-owner code' not in walls
        assert '--dport 3129 -m owner --uid-owner unit' not in walls
        assert f'"${tables}" -I OUTPUT 2 -m owner --uid-owner code -j REJECT' in walls
        # The agent reaches the runner's agent API (8081) only: never 8080, the service's (session, start, hold, wake).
        assert f'"${tables}" -I OUTPUT 3 -o lo -p tcp --dport 8081 -m owner --uid-owner unit -j ACCEPT' in walls
        assert '--dport 8080 -m owner --uid-owner unit' not in walls
        assert f'"${tables}" -I OUTPUT 4 -o lo -p tcp --dport 3128 -m owner --uid-owner unit -j ACCEPT' in walls
        assert f'"${tables}" -I OUTPUT 5 -m owner --uid-owner unit -j REJECT' in walls
    assert ' -A OUTPUT' not in walls
    assert '--dport 53' not in walls
    assert (unit_runner.AGENT_PORT, unit_runner.PROXY_PORT, unit_runner.CODE_PROXY_PORT) == (8081, 3128, 3129)
    assert f'http://127.0.0.1:{unit_runner.AGENT_PORT}' == runner_client.RUNNER_URL
    assert f'127.0.0.1:{unit_runner.AGENT_PORT}' in (IMAGES / 'common' / 'check-runner.sh').read_text()
    # The hard-link guard is read, never written (/proc/sys is read-only on AgentCore Runtime), and named.
    assert '/proc/sys/fs/protected_hardlinks' not in entrypoint
    assert 'HARDLINKS=/proc/sys/fs/protected_hardlinks' in walls
    assert '> "$HARDLINKS"' not in walls
    assert '--hardlink-guard $guards' in walls
    assert 'mount-s3' not in entrypoint
    assert 'mount-s3' not in walls


def test_the_namespace_probe_is_the_runners_own_chain():
    # walls.sh checks each user's namespaces exactly as the runner makes them (unit_runner.own_namespaces).
    walls = (IMAGES / 'common' / 'walls.sh').read_text()
    chain = unit_runner.own_namespaces(['true'], [])
    assert chain[:5] == [unit_runner.UNSHARE, '--user', '--map-root-user', '--net', '--']
    assert '"$UNSHARE" --user --map-root-user --net --' in walls
    assert ('"$SETPRIV" --reuid="$1" --regid=work --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs'
            in walls)
    assert '--inh-caps=-all --bounding-set=-all --no-new-privs' in ' '.join(chain)
    for tool, path in (('UNSHARE', unit_runner.UNSHARE), ('SETPRIV', unit_runner.SETPRIV), ('IP', unit_runner.IP),
                       ('SH', unit_runner.SH)):
        assert f'\n{tool}={path}\n' in walls


@pytest.mark.parametrize('language', sorted(REGISTRY_HOSTS))
def test_each_image_ships_the_walls_script_beside_its_entry_point(language):
    assert ('COPY templates/orchestration/images/common/entrypoint.sh templates/orchestration/images/common/walls.sh '
            '/opt/voc/' in (IMAGES / language / 'Dockerfile').read_text())
    assert unit_runner.RUNNER_PATH == '/opt/voc/unit_runner.py'


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
    stack = (DATALAKE / 'lib' / 'stacks' / 'engineering-runtime.ts').read_text()
    listed = re.search(r'const AGENT_ROLES = \[(.*?)\];', stack, re.DOTALL)
    assert listed is not None
    assert set(re.findall(r"'([a-z-]+)'", listed.group(1))) == set(ROLES)


def test_the_stack_takes_an_image_for_exactly_the_languages_with_an_image():
    stack = (DATALAKE / 'lib' / 'stacks' / 'engineering-agentcore.ts').read_text()
    listed = re.search(r'const IMAGE_LANGUAGES = \[(.*?)\];', stack, re.DOTALL)
    assert listed is not None
    assert set(re.findall(r"'([a-z]+)'", listed.group(1))) == set(REGISTRY_HOSTS)


def test_the_stack_and_the_runtime_agree_on_the_rates_the_idle_timeout_and_the_session_life():
    stack = (DATALAKE / 'lib' / 'stacks' / 'engineering-agentcore.ts').read_text()
    rates = re.search(r'DEFAULT_RATES: Readonly<Record<string, string>> = \{(.*?)\};', stack, re.DOTALL)
    assert rates is not None
    assert dict(re.findall(r"(\w+): '([0-9.]+)'", rates.group(1))) == caps.DEFAULT_RATES
    assert f'IDLE_TIMEOUT_SECONDS = {caps.IDLE_TIMEOUT_SECONDS}' in stack
    assert 'MAX_LIFETIME_SECONDS = 8 * 3600' in stack
    assert SESSION_LIFE_SECONDS == 8 * 3600
    assert f'BUILD_MEMORY_MIB = {sorted(caps.BUILD_SIZES)[0]}' in stack
    assert f'SESSION_QUOTA = {caps.DEFAULT_MAX_SESSIONS}' in stack
    assert f'MIN_MAX_SESSIONS = {caps.MIN_MAX_SESSIONS}' in stack
    # -c engineeringModelPrices (7.50.00): the synth refuses what the runtime would.
    assert f'MAX_USD_PER_MILLION_TOKENS = {caps.MAX_USD_PER_MILLION_TOKENS}' in stack
    parts = re.search(r'const PRICE_PARTS = \[(.*?)\];', stack)
    assert parts is not None
    assert tuple(re.findall(r"'(\w+)'", parts.group(1))) == caps.TOKEN_PRICE_PARTS
    model_id = re.search(r'const MODEL_ID_RE = /\^(.*?)\$/;', stack)
    assert model_id is not None
    assert f'{model_id.group(1)}\\Z' == caps.MODEL_ID.pattern


def test_the_fewest_sessions_a_deployment_may_set_fit_one_run_the_agents_api_starts():
    # (the cap of every run the Agents API and the agents' heartbeat start: their shared request builder's, 7.47.00)
    api = (RUNTIME.parent.parent / 'shared' / 'engineering_agent_runs.py').read_text()
    cap = re.search(r'^RUN_TASK_CAP: Final = (\d+)$', api, re.MULTILINE)
    assert cap is not None
    assert int(cap.group(1)) + 1 == caps.MIN_MAX_SESSIONS   # (its tasks and its coordinator)


def test_each_toolchain_is_pointed_at_the_dependency_steps_own_proxy():
    # Maven reads no HTTPS_PROXY: the Java image gives `code` settings that name the dependency step's proxy.
    dockerfile = (IMAGES / 'java' / 'Dockerfile').read_text()
    settings = (IMAGES / 'java' / 'maven-settings.xml').read_text()
    assert 'COPY templates/orchestration/images/java/maven-settings.xml /home/code/.m2/settings.xml' in dockerfile
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


# ── the deterministic gate and the pinned toolchains (7.50.00) ─────────────────────────────────────────────────────
#: Item A's paths every image copies before they land in this tree (the orchestration loader, the gate packs' new
#: home): each is held to the images as soon as it exists (``test_item_as_paths_are_copied_once_they_land``).
LANDING_WITH_ITEM_A: dict[str, str] = {
    'lambda/engineering/orchestration/__init__.py': 'item A lands the orchestration package',
    'lambda/engineering/orchestration/bundle.py': 'item A lands the orchestration loader',
    'templates/orchestration/gates/': 'item A moves the gate packs to templates/orchestration/gates',
}
#: The gate packs each image's toolchains are pinned to: a repository's TypeScript half (python-ts, rust-ts) runs on
#: the typescript pack's Node, which the Python pack names itself and the Rust image adds.
IMAGE_PACKS: dict[str, tuple[str, ...]] = {
    'python': ('python',), 'node': ('typescript',), 'rust': ('rust', 'typescript'), 'java': ('java',)}
#: The base image each language's FROM names, and the toolchain it is.
BASE_TOOLCHAIN: dict[str, str] = {'python': 'python', 'node': 'node', 'rust': 'rust', 'eclipse-temurin': 'java'}
#: An exact release: major, minor and patch (Temurin's build after ``_``), never a floating tag.
EXACT: re.Pattern[str] = re.compile(r'\d+\.\d+\.\d+(?:\.\d+)?(?:_\d+)?\Z')


def _dockerfile(language: str) -> str:
    return (IMAGES / language / 'Dockerfile').read_text()


def installed(script: str, language: str) -> tuple[str, str]:
    """The version and checksum ``language``'s image runs its ``script`` (``install-node.sh``, …) with."""
    found = re.search(rf'{re.escape(script)} (\S+) (\S+) ', _dockerfile(language))
    assert found is not None
    return found.group(1), found.group(2)


def _copy_sources(dockerfile: str) -> list[str]:
    """The build-context paths an image's ``COPY`` lines name (continued lines joined; never a ``--from`` stage)."""
    sources: list[str] = []
    for line in dockerfile.replace('\\\n', ' ').splitlines():
        if line.startswith('COPY ') and '--from=' not in line:
            sources += [word for word in line.split()[1:-1] if not word.startswith('--')]
    return sources


def _in_context(source: str) -> bool:
    return any(DATALAKE.glob(source.rstrip('/'))) if '*' in source else (DATALAKE / source).exists()


def _pack_images() -> dict[str, dict[str, str]]:
    """Each gate pack's ``[image]`` (toolchain to version): its manifest under templates/orchestration/gates once item A
    moves the packs there, else the committed bundle's gates (the same manifests, compiled)."""
    manifests = sorted((DATALAKE / 'templates' / 'orchestration' / 'gates').glob('*/manifest.toml'))
    if manifests:
        return {path.parent.name: dict(tomllib.loads(path.read_text()).get('image', {})) for path in manifests}
    bundle = json.loads((DATALAKE / 'templates' / 'orchestration' / 'bundle.json').read_text())
    return {pack['id']: dict(pack['image']) for pack in bundle['gates']['packs']}


def _pins(language: str) -> dict[str, str]:
    """What an image installs, toolchain to version: its FROM's, Node's tarball, Maven's and Gradle's archives."""
    dockerfile = _dockerfile(language)
    base = re.search(r'^FROM --platform=linux/arm64 public\.ecr\.aws/docker/library/([a-z-]+):(\S+)$', dockerfile,
                     re.MULTILINE)
    assert base is not None
    version = re.match(r'[0-9][0-9._]*[0-9]', base.group(2))
    assert version is not None
    pins = {BASE_TOOLCHAIN[base.group(1)]: version.group(0)}
    node = re.search(r'install-node\.sh (\S+) ([0-9a-f]+) ', dockerfile)
    if node is not None:
        pins['node'] = node.group(1)
    tools = re.search(r'install-build-tools\.sh (\S+) \\\n\s+([0-9a-f]+) \\\n\s+(\S+) ([0-9a-f]+) ', dockerfile)
    if tools is not None:
        pins['maven'], pins['gradle'] = tools.group(1), tools.group(3)
    return pins


@pytest.mark.parametrize('language', sorted(REGISTRY_HOSTS))
def test_each_image_ships_the_deterministic_gate_its_packs_and_the_bundle(language):
    dockerfile = _dockerfile(language)
    gate = ' '.join(f'lambda/engineering/quality_gate/{name}' for name in SHIPPED_GATE)
    assert f'COPY {gate} /opt/voc/engineering/quality_gate/' in dockerfile
    loader = ' '.join(f'lambda/engineering/orchestration/{name}' for name in SHIPPED_ORCHESTRATION)
    assert f'COPY {loader} /opt/voc/engineering/orchestration/' in dockerfile
    assert 'COPY templates/orchestration/bundle.json /opt/voc/orchestration/bundle.json' in dockerfile
    # (quality_gate/packs.py default_packs_dir: the templates folder in the repository, /opt/voc/gates in an image)
    assert 'COPY templates/orchestration/gates/ /opt/voc/gates/' in dockerfile


@pytest.mark.parametrize('language', sorted(REGISTRY_HOSTS))
def test_every_path_an_image_copies_is_in_the_build_context(language):
    missing = [source for source in _copy_sources(_dockerfile(language)) if not _in_context(source)]
    assert [source for source in missing if source not in LANDING_WITH_ITEM_A] == []


@pytest.mark.parametrize('path', sorted(LANDING_WITH_ITEM_A))
def test_item_as_paths_are_copied_once_they_land(path):
    if not _in_context(path):
        pytest.skip(f'{LANDING_WITH_ITEM_A[path]}: not in this tree yet, so no image build succeeds before it does')
    for language in sorted(REGISTRY_HOSTS):
        assert path in _copy_sources(_dockerfile(language)), language


@pytest.mark.parametrize('language', sorted(REGISTRY_HOSTS))
def test_each_images_toolchains_are_exactly_its_gate_packs_pinned_never_floating(language):
    wanted: dict[str, str] = {}
    packs = _pack_images()
    for pack in IMAGE_PACKS[language]:
        wanted.update(packs[pack])
    pins = _pins(language)
    assert set(pins) == set(wanted), 'every toolchain a pack names is installed, and nothing else is pinned'
    for toolchain, version in pins.items():
        assert EXACT.fullmatch(version), f'{toolchain} {version} is not an exact release'
        assert version == wanted[toolchain] or version.startswith(f'{wanted[toolchain]}.'), (
            f'{toolchain} {version} is not the pack\'s {wanted[toolchain]}')


def test_the_python_and_rust_images_install_one_checked_node_tarball():
    found = {installed('install-node.sh', language) for language in ('python', 'rust')}
    ((version, sha256),) = found
    assert EXACT.fullmatch(version)
    assert re.fullmatch(r'[0-9a-f]{64}', sha256)
    installer = (IMAGES / 'common' / 'install-node.sh').read_text()
    assert 'https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch}.tar.gz' in installer
    assert 'echo "${expected}  /tmp/node.tar.gz" | sha256sum -c -' in installer
    # Root's tree, linked into a directory `code` cannot write; never the tarball's own file owners.
    assert '--no-same-owner' in installer
    assert 'ln -sf "/opt/node/bin/${tool}" "/usr/local/bin/${tool}"' in installer
    assert 'install-node.sh' not in _dockerfile('node')   # (its base image is Node's own)


def test_the_java_image_checks_maven_and_gradle_against_their_published_checksums():
    tools = re.search(r'install-build-tools\.sh (\S+) \\\n\s+(\S+) \\\n\s+(\S+) (\S+) ', _dockerfile('java'))
    assert tools is not None
    assert re.fullmatch(r'[0-9a-f]{128}', tools.group(2))   # (Maven publishes a sha512)
    assert re.fullmatch(r'[0-9a-f]{64}', tools.group(4))
    installer = (IMAGES / 'java' / 'install-build-tools.sh').read_text()
    assert 'echo "${maven_sha512}  /tmp/maven.tar.gz" | sha512sum -c -' in installer
    assert 'echo "${gradle_sha256}  /tmp/gradle.zip" | sha256sum -c -' in installer
    assert '--no-same-owner' in installer
    # (never the distribution's Maven, whose version moves with the base image)
    assert 'install -y --no-install-recommends maven' not in _dockerfile('java')
