"""The Kiro harness around the harness (7.53.00): the deployment's switch and the launch's argv, the agent's egress, the
images' pinned kiro-cli, the runner's and the runtime's record of it, readiness's ``kiro`` check, a checkpoint's and a
child run's saved Kiro session, and the harness's entry point."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, replace
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from engineering.readiness import CHECK_IDS, REQUIRED, ReadFailed, SandboxSeen, Settings, Subject, evaluate
from engineering.runtime import egress, harness_switch, sandbox, unit_runner
from engineering.runtime.harness import main as harness_main
from engineering.runtime.harness import seed
from engineering.runtime.harness.kiro import KiroAcp
from engineering.runtime.harness.kiro_pin import KIRO_CLI_VERSION
from engineering.runtime.harness.skills import SKILLS, harness_argv
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.restart import _kiro_state
from engineering.runtime.test.harness_fakes import HARNESS_COMMIT, RUN_ID
from engineering.runtime.test.test_engineering_harness_main import _ports
from engineering.runtime.test.test_engineering_images import installed
from engineering.test.test_readiness import Ports as ReadyPorts

FIXER = SKILLS['fixer']

IMAGES = Path(__file__).resolve().parents[4] / 'engineering-images'
PARAMETER = '/voc/engineering/_kiro/api-key'
KIRO_ENV = {harness_switch.HARNESS_ENV: 'kiro', harness_switch.KEY_PARAMETER_ENV: PARAMETER}


# -- the switch and the argv -------------------------------------------------------------------------------------


def test_the_switch_is_native_by_default_kiro_for_every_launchable_role_or_for_the_named_ones():
    assert harness_switch.kiro_roles(None) == harness_switch.kiro_roles('native') == frozenset()
    assert harness_switch.kiro_roles('kiro') == harness_switch.KIRO_ROLES
    assert 'coach' not in harness_switch.KIRO_ROLES
    assert 'coordinator' in harness_switch.KIRO_ROLES
    assert harness_switch.kiro_roles('kiro:fixer, gate-runner') == frozenset({'fixer', 'gate-runner'})
    for wrong in ('Kiro', 'kiro:', 'kiro:coach', 'kiro:nobody', 'fixer', 'claude'):
        with pytest.raises(RuntimeRefused):
            harness_switch.kiro_roles(wrong)


def test_a_role_on_kiro_runs_the_kiro_adapter_with_the_pinned_cli_and_the_key_parameter():
    argv = harness_argv(FIXER)
    assert harness_switch.harness_for(argv, 'fixer', {}) == argv
    assert harness_switch.harness_for(argv, 'fixer', {harness_switch.HARNESS_ENV: 'kiro:hunter'}) == argv
    on_kiro = harness_switch.harness_for(argv, 'fixer', KIRO_ENV)
    assert on_kiro == (*argv[:argv.index('--adapter')], '--adapter', 'kiro', '--model', FIXER.model,
                       '--kiro-version', KIRO_CLI_VERSION, '--kiro-key-parameter', PARAMETER)
    assert harness_switch.is_kiro(on_kiro)
    assert not harness_switch.is_kiro(argv)
    # (the harness's own parser takes it)
    parsed = harness_main._parser().parse_args(list(on_kiro[3:]))
    assert (parsed.adapter, parsed.kiro_version, parsed.kiro_key_parameter) == ('kiro', KIRO_CLI_VERSION, PARAMETER)


def test_a_role_on_kiro_without_a_key_parameter_is_refused_at_its_launch():
    with pytest.raises(RuntimeRefused, match='names no Kiro key parameter'):
        harness_switch.harness_for(harness_argv(FIXER), 'fixer', {harness_switch.HARNESS_ENV: 'kiro'})
    with pytest.raises(RuntimeRefused, match='names no Kiro key parameter'):
        harness_switch.harness_for(harness_argv(FIXER), 'fixer', {**KIRO_ENV,
                                                                    harness_switch.KEY_PARAMETER_ENV: '/voc/other'})


# -- the egress -------------------------------------------------------------------------------------------------


def _allowlist(**kwargs: Any) -> tuple[str, ...]:
    return egress.egress_allowlist(role='fixer', language='python', region='us-west-2', bucket='voc-raw-test',
                                   workspace_bucket='voc-eng-workspace-test', **kwargs)


def test_an_agent_on_kiro_reaches_the_kiro_service_and_ssm_on_its_own_proxy_only():
    native, kiro = set(_allowlist()), set(_allowlist(kiro=True))
    assert kiro - native == {'management.us-east-1.kiro.dev', 'runtime.us-east-1.kiro.dev', 'ssm.us-west-2.amazonaws.com'}
    agent, code = egress.split(kiro)
    assert {'management.us-east-1.kiro.dev', 'runtime.us-east-1.kiro.dev', 'ssm.us-west-2.amazonaws.com'} <= set(agent)
    assert not {host for host in code if 'kiro' in host or host.startswith('ssm.')}


@pytest.mark.parametrize('host', ['runtime.us-east-1.kiro.dev', 'ssm.us-west-2.amazonaws.com'])
def test_an_extra_host_shaped_like_the_agents_kiro_hosts_is_refused(host):
    with pytest.raises(RuntimeRefused, match='extra hosts are for the dependency step only'):
        _allowlist(extra_hosts=[host])


# -- the images -------------------------------------------------------------------------------------------------


def _dockerfile(language: str) -> str:
    return (IMAGES / language / 'Dockerfile').read_text()


@pytest.mark.parametrize('language', sorted(egress.REGISTRY_HOSTS))
def test_each_image_installs_the_pinned_kiro_cli_and_ships_the_compiled_configs(language):
    dockerfile = _dockerfile(language)
    found = re.search(r'install-kiro\.sh (\S+) ([0-9a-f]{64}) ', dockerfile)
    assert found is not None
    assert found.group(1) == KIRO_CLI_VERSION
    assert 'COPY templates/orchestration/kiro-agents/ /opt/voc/orchestration/kiro-agents/' in dockerfile
    # (before the harness: the base's setuid sweep is done, and the binary is root's)
    assert dockerfile.index('install-kiro.sh') < dockerfile.index('COPY lambda/engineering/runtime/unit_runner.py')


def test_every_image_pins_the_same_kiro_archive():
    pins = {installed('install-kiro.sh', language) for language in sorted(egress.REGISTRY_HOSTS)}
    assert pins == {(KIRO_CLI_VERSION, '187905a1c931fde45ef0e03edd80d201f4f608e1a844d9508d80f558a593d499')}


def test_the_kiro_installer_checks_the_published_sha256_and_takes_only_the_binary():
    installer = (IMAGES / 'common' / 'install-kiro.sh').read_text()
    assert ('https://prod.download.cli.kiro.dev/stable/${version}/kirocli-${arch}-linux-musl.tar.gz'
            in installer)
    assert 'echo "${expected}  /tmp/kiro.tar.gz" | sha256sum -c -' in installer
    assert 'tar -xzf /tmp/kiro.tar.gz -C /tmp/kiro --no-same-owner kirocli/bin/kiro-cli' in installer
    assert 'install -o root -g root -m 0755 /tmp/kiro/kirocli/bin/kiro-cli /usr/local/bin/kiro-cli' in installer
    assert '[ "$shown" = "kiro-cli ${version}" ]' in installer
    assert f'> {unit_runner.KIRO_VERSION_FILE}' in installer
    assert 'curl -fsSL https://cli.kiro.dev/install' not in installer   # (never the moving installer)


# -- the runner's and the runtime's record of it ------------------------------------------------------------------


def test_the_runner_reports_the_images_kiro_cli_or_none(tmp_path):
    version = tmp_path / 'VERSION'
    assert unit_runner.kiro_cli_version(str(version)) == ''
    version.write_text('3.4.0\n')
    assert unit_runner.kiro_cli_version(str(version)) == '3.4.0'
    version.write_text('3.4.0; rm -rf /\n')
    assert unit_runner.kiro_cli_version(str(version)) == ''


class _Rows:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict[str, Any]] = {}

    def put_item(self, *, TableName: str, Item: dict[str, Any]) -> None:
        del TableName
        self.items[(Item['pk']['S'], Item['sk']['S'])] = Item

    def get_item(self, *, TableName: str, Key: dict[str, Any], ConsistentRead: bool) -> dict[str, Any]:
        del TableName, ConsistentRead
        found = self.items.get((Key['pk']['S'], Key['sk']['S']))
        return {} if found is None else {'Item': found}


def test_the_sessions_kiro_cli_is_recorded_with_its_walls_and_read_back():
    walls = sandbox.Walls.parse({'egress': 'namespaces', 'code': 'namespaces', 'hardlink_guard': ['own_device'],
                                 'kiro_cli': '3.4.0'})
    assert walls is not None
    assert walls.kiro_cli == '3.4.0'
    rows = _Rows()
    sandbox.record(rows, 't', 'python', walls, at='2026-11-17T12:00:00Z')
    read = sandbox.read_record(rows, 't', 'python')
    assert read is not None
    assert read.walls.kiro_cli == '3.4.0'
    older = sandbox.Walls.parse({'egress': 'namespaces', 'code': 'namespaces', 'hardlink_guard': ['own_device']})
    assert older is not None
    assert older.kiro_cli == ''
    odd = sandbox.Walls.parse({'egress': 'namespaces', 'code': 'namespaces', 'hardlink_guard': [], 'kiro_cli': 'x'})
    assert odd is not None
    assert odd.kiro_cli == ''


# -- readiness ---------------------------------------------------------------------------------------------------


@dataclass
class _Ports(ReadyPorts):
    """Readiness's ports, every one ready but the Kiro key's type (``kind``) and the sandbox's walls (``seen``)."""

    kind: Any = 'SecureString'
    seen: Any = None

    def kiro_key(self, parameter: str) -> str | None:
        self.asked.append(parameter)
        return self._answer(self.kind)

    def sandbox_walls(self, language: str) -> SandboxSeen | None:
        del language
        return self.seen


FLOW = {'schema': 'voc-workflow/2', 'nodes': [{'id': 'a', 'type': 'agent', 'data': {'params': {'role': 'fixer'}}}]}
SUBJECT = Subject(kind='automation', id='agent_1', name='Bug fixer', definition=FLOW, person='p',
                  requires={'image': True}, language='python', budget_usd=Decimal(5))
SETTINGS = Settings(image_languages=frozenset({'python'}), network=True, kiro_roles=frozenset({'fixer'}),
                    kiro_key_parameter=PARAMETER, kiro_version=KIRO_CLI_VERSION)
SEEN = SandboxSeen('namespaces', 'namespaces', ('own_device',), '2026-11-18T09:00:00Z', '3.4.0')


def _kiro_check(ports: _Ports, settings: Settings = SETTINGS) -> Any:
    report = evaluate(SUBJECT, ports, settings, ['kiro'])
    [check] = report.checks
    return check


def test_the_kiro_check_is_advice_after_the_sandbox_and_not_needed_on_the_native_harness():
    assert CHECK_IDS.index('kiro') == CHECK_IDS.index('sandbox') + 1
    assert 'kiro' not in REQUIRED
    check = _kiro_check(_Ports(), replace(SETTINGS, kiro_roles=frozenset()))
    assert (check.status, check.detail) == ('pass', "Not needed: this deployment runs the flow's agents on the native harness.")
    assert _kiro_check(_Ports(), replace(SETTINGS, kiro_roles=frozenset({'hunter'}))).detail.startswith('Not needed')


def test_the_kiro_check_passes_only_with_the_key_stored_and_the_pinned_cli_seen():
    ports = _Ports(seen=SEEN)
    check = _kiro_check(ports)
    assert check.status == 'pass'
    assert 'kiro-cli 3.4.0' in check.detail
    assert ports.asked == [PARAMETER]


@pytest.mark.parametrize(('ports', 'status', 'said'), [
    (_Ports(kind=None, seen=SEEN), 'fail', 'no Kiro API key is stored at /voc/engineering/_kiro/api-key'),
    (_Ports(kind='String', seen=SEEN), 'fail', 'is a String, not a SecureString'),
    (_Ports(kind=ReadFailed('the Kiro API key: AccessDenied'), seen=SEEN), 'unknown', 'AccessDenied'),
    (_Ports(seen=None), 'unknown', 'unknown until its first session (it must be 3.4.0)'),
    (_Ports(seen=replace(SEEN, kiro_cli='')), 'fail', 'had no kiro-cli, not the pinned 3.4.0'),
    (_Ports(seen=replace(SEEN, kiro_cli='3.3.0')), 'fail', 'had kiro-cli 3.3.0, not the pinned 3.4.0'),
])
def test_the_kiro_check_says_what_is_missing(ports, status, said):
    check = _kiro_check(ports)
    assert check.status == status, check
    assert said in check.detail, check
    if status == 'fail' and 'key' in said:
        assert 'aws ssm put-parameter --name /voc/engineering/_kiro/api-key --type SecureString' in check.fix


def test_the_readiness_port_reads_the_keys_metadata_never_its_value():
    from engineering.readiness_aws import AwsReadinessPorts

    class Ssm:
        def __init__(self) -> None:
            self.asked: list[dict[str, Any]] = []

        def describe_parameters(self, **request: Any) -> dict[str, Any]:
            self.asked.append(request)
            return {'Parameters': [{'Name': PARAMETER, 'Type': 'SecureString'}]}

    ssm = Ssm()
    ports = AwsReadinessPorts(agents=None, aggregates=None, engineering=None, engineering_client=None,
                              engineering_table='t', s3=None, workspace_bucket='b', quotas=lambda: None,
                              bedrock=lambda: None, inspect=lambda _: {}, ssm=lambda: ssm)
    assert ports.kiro_key(PARAMETER) == 'SecureString'
    assert ssm.asked == [{'ParameterFilters': [{'Key': 'Name', 'Option': 'Equals', 'Values': [PARAMETER]}],
                          'MaxResults': 1}]
    with pytest.raises(ReadFailed, match='not wired'):
        replace(ports, ssm=None).kiro_key(PARAMETER)


def test_the_readiness_settings_take_the_switch_from_the_environment(monkeypatch):
    from engineering.readiness_aws import settings_from_environment
    monkeypatch.setenv('ENGINEERING_HARNESS', 'kiro:fixer')
    monkeypatch.setenv('ENGINEERING_KIRO_KEY_PARAMETER', PARAMETER)
    settings = settings_from_environment({}, 'us-west-2')
    assert (settings.kiro_roles, settings.kiro_key_parameter, settings.kiro_version) == (
        frozenset({'fixer'}), PARAMETER, KIRO_CLI_VERSION)
    monkeypatch.setenv('ENGINEERING_HARNESS', 'nonsense')
    assert settings_from_environment({}, 'us-west-2').kiro_roles == frozenset()


# -- a child run's seed -----------------------------------------------------------------------------------------


CHILD = '01JD3R4NZXQ7Y2W8K4M6P9T0CD'


def _seed(**kiro: Any) -> dict[str, Any]:
    return {'schema': seed.SCHEMA,
            'parent': {'run_id': RUN_ID, 'agent_id': 'fixer-1', 'task_id': 't1', 'attempt': 1, 'commit': HARNESS_COMMIT},
            'task': {'role': 'fixer', 'title': 't', 'instructions': 'i'}, 'checkpoint': None, 'patch_key': '',
            'base': 'same', 'history': {'kind': 'excerpts', 'lines': []}, 'steering': [], **kiro}


def test_a_seed_names_the_parents_kiro_session_only_under_the_childs_own_seed():
    state = seed.kiro_key(CHILD, 't1')
    assert state == f'ws/default/runs/{CHILD}/_seed/t1/kiro.tgz'
    assert seed.checked(_seed(kiro={'session_id': 'sess_a', 'state': state}), CHILD)['kiro'] == {
        'session_id': 'sess_a', 'state': state}
    assert 'kiro' not in seed.checked(_seed(), CHILD)
    for wrong in ({'session_id': 'sess a', 'state': state},
                  {'session_id': 'sess_a', 'state': f'ws/default/runs/{RUN_ID}/_seed/t1/kiro.tgz'},
                  {'session_id': 'sess_a', 'state': seed.patch_key(CHILD, 't1')}):
        with pytest.raises(seed.SeedError):
            seed.checked(_seed(kiro=wrong), CHILD)


def test_the_runtime_copies_only_a_kiro_state_under_the_parent_attempts_own_kiro_keys():
    from engineering.runtime.checkpoints import artifact_prefix
    from engineering.runtime.restart import Attempt
    where = Attempt(RUN_ID, 'fixer-1', HARNESS_COMMIT, 1)
    own = artifact_prefix(RUN_ID, 'fixer-1', HARNESS_COMMIT, 1, 'kiro')
    assert _kiro_state({'session_id': 'sess_a', 'state': f'{own}000002-ab12cd34.tgz'}, where) == {
        'session_id': 'sess_a', 'state': f'{own}000002-ab12cd34.tgz'}
    for wrong in (None, {'session_id': 'sess_a'}, {'session_id': 'sess_a', 'state': f'{own}x/y.tgz'},
                  {'session_id': 'sess_a', 'state': own.replace('fixer-1', 'hunter-1') + '1.tgz'}):
        assert _kiro_state(wrong, where) is None


# -- the harness's entry point ----------------------------------------------------------------------------------


def test_the_entry_point_builds_the_kiro_adapter_with_the_ssm_key_and_the_tool_servers_proxy():
    args = harness_main._parser().parse_args(['run', '--adapter', 'kiro', '--model', 'm', '--kiro-version', '3.4.0',
                                              '--kiro-key-parameter', PARAMETER])
    env = {'HOME': '/home/unit', 'AWS_REGION': 'us-west-2', 'AWS_CONFIG_FILE': '/run/voc/aws-config',
           'HTTPS_PROXY': 'http://127.0.0.1:3128', 'VOC_RUN_ID': RUN_ID, 'KIRO_API_KEY': 'never-passed-on'}
    adapter = harness_main.adapter_for(args, env, lambda: None)
    assert isinstance(adapter, KiroAcp)
    assert adapter.binary == '/usr/local/bin/kiro-cli'
    assert adapter.version == '3.4.0'
    assert adapter.root == '/home/unit/.voc/kiro'
    assert adapter.tool_env['HTTPS_PROXY'] == 'http://127.0.0.1:3128'
    assert adapter.tool_env['VOC_RUN_ID'] == RUN_ID
    assert 'KIRO_API_KEY' not in adapter.tool_env


def test_the_tool_server_drops_any_kiro_key_from_its_own_environment(monkeypatch):
    monkeypatch.setenv('KIRO_API_KEY', 'leaked')
    seen: dict[str, Any] = {}

    def build(env: Any, **_: Any) -> Any:
        seen['env'] = dict(env)
        raise SystemExit(0)

    monkeypatch.setattr(harness_main, 'build_session', build)
    with pytest.raises(SystemExit):
        harness_main.main(['tool-server'], {'KIRO_API_KEY': 'leaked', 'VOC_SESSION_FILES': '/x'}, s3=object(),
                          ports=_ports())
    import os
    assert 'KIRO_API_KEY' not in os.environ
    assert 'KIRO_API_KEY' not in seen['env']


def test_the_compiled_configs_are_what_the_harness_reads():
    configs = sorted(path.stem for path in (IMAGES.parent / 'templates' / 'orchestration' / 'kiro-agents').glob('*.json'))
    assert configs == sorted(harness_switch.KIRO_ROLES)
    assert json.loads((IMAGES.parent / 'templates' / 'orchestration' / 'kiro-agents' / 'fixer.json').read_text())[
        'tools'] == ['@voc']
