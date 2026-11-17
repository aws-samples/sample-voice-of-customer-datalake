"""``npm run orchestration:validate``: the shipped templates pass every check, and each check catches what it is for
(on a copy of the folder, one thing broken at a time)."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from engineering.orchestration import compile as compiler
from engineering.orchestration import validate
from engineering.orchestration.compile import compile_bundle, kiro_files, load, render, write, write_kiro_agents
from engineering.orchestration.schema import ROOT


def test_the_shipped_templates_and_both_bundles_pass_every_check() -> None:
    assert validate.problems(ROOT) == []


@pytest.fixture
def copy(tmp_path: Path) -> Path:
    """A copy of the templates folder, its two bundles beside it and its Kiro agent configs compiled."""
    root = tmp_path / 'orchestration'
    shutil.copytree(ROOT, root)
    sources = load(root)
    write(render(compile_bundle(sources)), root)
    write_kiro_agents(kiro_files(sources), root)
    return root


def _edit(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding='utf-8')
    assert old in text, f'{old!r} not in {path.name}'
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


def _json(path: Path, change: Callable[[dict], None]) -> None:
    document = json.loads(path.read_text(encoding='utf-8'))
    change(document)
    path.write_text(json.dumps(document), encoding='utf-8')


def test_a_copy_passes_and_a_stale_or_missing_bundle_is_drift(copy: Path) -> None:
    assert validate.problems(copy) == []
    _edit(copy / 'flows' / 'pr-review.yaml', 'title: Leave the review comments', 'title: Comment on the pull request')
    assert validate.problems(copy) == [
        "bundle.json: it is not the compile's output (npm run orchestration:compile writes it)",
        ("orchestration_bundle.json: it is not the compile's output (npm run orchestration:compile "
        'writes it)')]
    assert validate.problems(copy, drift=False) == []
    (copy / 'bundle.json').unlink()
    assert len(validate.drift_problems('{}', copy)) == 2


@pytest.mark.parametrize(('where', 'old', 'new', 'problem'), [
    # schemas
    ('agents/fixer/agent.yaml', 'harness: converse', 'harness: shell', r'agents/fixer/agent.yaml: harness'),
    ('flows/feature.yaml', 'version: 2', 'version: zero', r'flows/feature.yaml: version'),
    ('automations/bug-fixer.yaml', 'enabled: false', 'enabled: true', r'automations/bug-fixer.yaml: enabled'),
    ('agents/hunter/SKILL.md', 'name: hunter', 'name: Hunter', r'SKILL.md front matter: name'),
    # SKILL.md
    ('agents/fixer/SKILL.md', '## Rules', '## Constraints', r'its sections are Role, Reads'),
    ('agents/fixer/SKILL.md', 'voc-template-version: 3', 'voc-template-version: 9', r"card's version 3"),
    ('agents/committer/SKILL.md', 'Push with `push_commit`', 'Push with `submit_work`',
     r'names tools its card does not list: submit_work'),
    ('agents/mapper/SKILL.md', '**When:** The shard holds', 'When: The shard holds', r'is "\*\*When:\*\* \.\.\. \*\*Do:'),
    # cards
    ('agents/committer/agent.yaml', 'tools: [read_file, list_files, push_commit,', ('tools: [read_file, write_file, '
     'push_commit,'), r'the harness offers role committer no tool write_file'),
    ('agents/fixer/agent.yaml', 'broker_ops: [read]\n', 'pending_tools: [run]\nbroker_ops: [read]\n',
     r'the harness offers run now: move it from pending_tools into tools'),
    ('agents/fixer/agent.yaml', 'broker_ops: [read]', 'broker_ops: [read, push_bundle]',
     r'the broker lets role fixer make no push_bundle'),
    ('agents/pr-reviewer/agent.yaml', 'broker_ops: [read, post_comment]', ('broker_ops: [read]\npending_broker_ops: '
     '[post_comment]'), r'the broker lets role pr-reviewer make post_comment now: move it into broker_ops'),
    ('agents/fixer/agent.yaml', 'claude-sonnet-5-5', 'claude-sonnet-0-1', r'is not in ALLOWED_MODEL_IDS'),
    ('agents/fixer/agent.yaml', 'bug-hunt-and-fix/divide-floor-bug,', 'bug-hunt-and-fix/no-such-case,',
     r'no eval case bug-hunt-and-fix/no-such-case'),
    ('agents/fixer/agent.yaml', 'id: fixer', 'id: fixer-two', r'its id is its directory'),
    # flows
    ('flows/bug-hunt-and-fix.yaml', 'on: {pass: commit, fail: human}', 'on: {pass: commit, fail: nobody}',
     r'sends its fail arrow to nobody'),
    ('flows/bug-hunt-and-fix.yaml', 'packs: auto', 'packs: [python, cobol]', r'quality_gate/packs'),
    ('flows/bug-hunt-and-fix.yaml', '{check: patch.submitted, on_fail: block}',
     '{check: tasks.posted, args: {role: fixer}}', r"'min' is a required property"),
    ('flows/bug-hunt-and-fix.yaml', 'pr: ready\n', '', r'says how it opens'),
    ('flows/bug-hunt-and-fix.yaml', 'roles: [hunter, fixer,', 'roles: [builder, fixer,',
     r'learn names builder, which the flow does not run'),
    ('flows/issue-triage.yaml', '  - id: locate', '  - id: classify', r'the step id classify is used twice'),
    ('flows/issue-triage.yaml', 'model: global.anthropic.claude-sonnet-5-5', 'model: other-model',
     r'model other-model is not in ALLOWED_MODEL_IDS'),
    ('flows/feature.yaml', 'id: feature\n', 'id: features\n', r"its id is its file's name"),
    ('flows/understand-repository.yaml', '  - {id: reduce, title: Bring the shards together, reduce: {}}\n', '',
     r'compiled: a map needs exactly one reduce'),
    # automations
    ('automations/bug-fixer.yaml', 'flow: bug-hunt-and-fix', 'flow: bug-hunt', r'no flow bug-hunt'),
    ('automations/bug-fixer.yaml', 'budget: {monthly_usd: 50,', 'budget: {', r'a monthly budget above 0'),
    ('automations/bug-fixer.yaml', ' issue_label, triage_enabled]', ' issue_label]', (r'its readiness misses '
     'triage_enabled')),
    ('automations/autonomous-product.yaml', 'flow: wf_default', 'flow: feature', (r'an engineering flow is an '
     "engineering agent's")),
    ('automations/feature-builder.yaml', 'AGENTSEED#feature-builder', 'AGENTSEED#bug-fixer',
     r'the seed marker AGENTSEED#bug-fixer is used twice'),
    # placeholders
    ('_shared/PLATFORM_RULES.md', '## Customer data', '## Customer data (TODO)', r'a placeholder is left'),
    ('gates/README.md', '# Engineering gate packs', '# Engineering gate packs <PACK_NAME>', r'a placeholder is left'),
])
def test_each_check_catches_what_it_is_for(copy: Path, where: str, old: str, new: str, problem: str) -> None:
    _edit(copy / where, old, new)
    found = validate.problems(copy, drift=False)
    assert any(re.search(problem, line) for line in found), found


def test_the_vocabulary_lists_and_the_eval_cases_are_checked_too(copy: Path) -> None:
    _json(copy / 'schemas' / 'assertion.schema.json', lambda d: d['properties']['check']['enum'].append('pr.merged'))
    assert validate.problems(copy, drift=False)[-1] == (
        'schemas/assertion.schema.json: its check enum is not assertions.VOCABULARY')


@pytest.mark.parametrize(('case', 'change', 'problem'), [
    ('issue-triage/cases/divide-floors', lambda d: d['expected'].update(severity='S9'), r'a severity S1-S4'),
    ('issue-triage/cases/divide-floors', lambda d: d['expected'].update(paths=['calculator/nothing.py']),
     r'the fixture has no calculator/nothing.py'),
    ('issue-triage/cases/divide-floors', lambda d: d.update(fixture='nowhere/none'), r'its fixture is an eval case'),
    ('issue-triage/cases/divide-floors', lambda d: d.update(id='other'), r"its id is its directory's name"),
    ('issue-triage/cases/divide-floors', lambda d: d['issue'].update(body=''), r'the issue has a title and a body'),
    ('issue-triage/cases/divide-floors', lambda d: d['expected'].update(tenets='none'), r'expected.tenets lists'),
    ('bug-hunt-and-fix/cases/divide-floor-bug', lambda d: d.update(kind='chore'), r"a case's kind is one of"),
])
def test_an_eval_case_that_does_not_load_is_a_problem(copy: Path, case: str, change: Callable[[dict], None],
                                                       problem: str) -> None:
    _json(copy / 'evals' / case / 'case.json', change)
    found = validate.problems(copy, drift=False)
    assert any(re.search(problem, line) for line in found), found


def test_a_missing_card_a_stray_card_a_missing_skill_and_broken_packs_are_problems(copy: Path) -> None:
    shutil.rmtree(copy / 'agents' / 'mapper')
    shutil.copytree(copy / 'agents' / 'fixer', copy / 'agents' / 'refactorer')
    (copy / 'agents' / 'builder' / 'SKILL.md').unlink()
    found = validate.problems(copy, drift=False)
    assert 'agents/mapper/: a role of the agent catalog has its card' in found
    assert 'agents/refactorer/: not a role of the agent catalog' in found
    assert 'agents/builder/SKILL.md: a launchable role has its SKILL.md' in found
    _edit(copy / 'gates' / 'java' / 'manifest.toml', 'schema = "voc-gate-pack/1"', 'schema = "voc-gate-pack/9"')
    assert validate.problems(copy, drift=False)[0].startswith('gates: ')


def test_a_source_that_does_not_read_is_the_one_problem(copy: Path) -> None:
    (copy / 'flows' / 'feature.yaml').write_text('steps: [unclosed', encoding='utf-8')
    [problem] = validate.problems(copy)
    assert problem.startswith('flows/feature.yaml: not readable YAML')


SERVER = r"its one tool server is the harness's, voc: /usr/bin/python3 -I /opt/voc/harness\.py tool-server"


ONLY_SERVER = r"tool server alone \(@voc\): no Kiro builtin, no subagent"


@pytest.mark.parametrize(('role', 'change', 'problem'), [
    ('fixer', lambda d: d['tools'].append('subagent'), rf'fixer\.json: it offers the platform\'s {ONLY_SERVER}'),
    ('fixer', lambda d: d['tools'].append('web_fetch'), rf'fixer\.json: it offers the platform\'s {ONLY_SERVER}'),
    ('committer', lambda d: d['tools'].append('write'), rf'committer\.json: it offers the platform\'s {ONLY_SERVER}'),
    ('mapper', lambda d: d.update(tools='read'), rf'mapper\.json: it offers the platform\'s {ONLY_SERVER}'),
    ('fixer', lambda d: d['permissions']['rules'].append({'capability': 'fs_write', 'effect': 'allow'}),
     r'fixer\.json: allows fs_write \(anything\) without asking: only an mcp rule for its card\'s tools'),
    ('fixer', lambda d: d['permissions']['rules'].append({'capability': 'fs_read', 'match': ['./**'],
                                                          'effect': 'allow'}),
     r'fixer\.json: allows fs_read \./\*\* without asking'),
    ('hunter', lambda d: d['permissions']['rules'].append({'capability': 'shell', 'match': ['*'], 'effect': 'allow'}),
     r'hunter\.json: allows shell \* without asking'),
    ('mapper', lambda d: d['permissions']['rules'].append({'capability': 'mcp', 'match': ['voc/run'], 'effect': 'allow'}),
     r'mapper\.json: allows mcp voc/run without asking'),
    ('builder', lambda d: d['allowedTools'].append('write'), r'builder\.json: allows write without asking'),
    ('mapper', lambda d: d['allowedTools'].append('@voc/push_commit'),
     r'mapper\.json: allows @voc/push_commit without asking'),
    ('fixer', lambda d: d.update(prompt='You are a helpful agent.'),
     r'fixer\.json: its prompt starts with the platform rules'),
    ('fixer', lambda d: d['mcpServers']['voc'].update(command='/usr/local/bin/python3'), SERVER),
    ('fixer', lambda d: d['mcpServers']['voc'].update(args=['/opt/voc/harness.py', 'tool-server']), SERVER),
    ('fixer', lambda d: d['mcpServers'].update(other={'command': '/usr/bin/true'}), SERVER),
    ('fixer', lambda d: d.update(mcpServers=[]), SERVER),
])
def test_each_kiro_agent_check_catches_what_it_is_for(copy: Path, role: str, change: Callable[[dict], None],
                                                      problem: str) -> None:
    _json(copy / 'kiro-agents' / f'{role}.json', change)
    found = validate.problems(copy)
    assert any(re.search(problem, line) for line in found), found
    assert f"kiro-agents/{role}.json: it is not the compile's output (npm run orchestration:compile writes it)" in found


def test_a_kiro_agent_config_that_does_not_parse_is_missing_is_stray_or_is_stale_is_a_problem(copy: Path) -> None:
    folder = copy / 'kiro-agents'
    (folder / 'fixer.json').write_text('{"name": "fixer",', encoding='utf-8')
    (folder / 'mapper.json').write_text('["mapper"]', encoding='utf-8')
    (folder / 'hunter.json').unlink()
    (folder / 'coach.json').write_text('{}', encoding='utf-8')
    _json(folder / 'builder.json', lambda d: d.update(permissions='all', allowedTools={'read': True}))
    found = validate.problems(copy)
    assert found[:2] == [found[0], 'kiro-agents/mapper.json: not a JSON object']
    assert found[0].startswith('kiro-agents/fixer.json: not readable JSON (')
    # (malformed permissions and allowedTools only differ from the compile's output: never a crash)
    assert found[2:] == [
        "kiro-agents/mapper.json: it is not the compile's output (npm run orchestration:compile writes it)",
        "kiro-agents/hunter.json: it is not the compile's output (npm run orchestration:compile writes it)",
        "kiro-agents/fixer.json: it is not the compile's output (npm run orchestration:compile writes it)",
        "kiro-agents/builder.json: it is not the compile's output (npm run orchestration:compile writes it)",
        "kiro-agents/coach.json: not a launchable role's config (npm run orchestration:compile removes it)"]
    changed = write_kiro_agents(kiro_files(load(copy)), copy)
    assert sorted(path.name for path in changed) == ['builder.json', 'coach.json', 'fixer.json', 'hunter.json',
                                                     'mapper.json']
    assert validate.problems(copy) == []


def test_a_card_change_is_drift_of_its_kiro_config_and_a_compile_that_would_allow_a_command_is_refused(
        copy: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _edit(copy / 'agents' / 'fixer' / 'agent.yaml', 'purpose: Smallest fix', 'purpose: The smallest fix')
    found = validate.problems(copy)
    assert "kiro-agents/fixer.json: it is not the compile's output (npm run orchestration:compile writes it)" in found
    assert [line for line in found if line.startswith('kiro-agents/')] == [
        "kiro-agents/fixer.json: it is not the compile's output (npm run orchestration:compile writes it)"]
    monkeypatch.setattr(compiler, 'KIRO_TOOLS', ('@voc', 'shell'))
    found = validate.problems(copy, drift=False)
    assert "kiro-agents/fixer.json: it offers the platform's tool server alone (@voc): no Kiro builtin, no subagent" in found


KEY = 'kiro-key-that-is-never-shown'


def _home(tmp_path: Path, key: str | None = KEY) -> Path:
    home = tmp_path / 'home'
    (home / '.config' / 'voc-kiro').mkdir(parents=True)
    if key is not None:
        (home / '.config' / 'voc-kiro' / 'api-key').write_text(f'{key}\n', encoding='utf-8')
    return home


def _kiro(*, code: Callable[[str], int] = lambda _name: 0, said: str = '',
          calls: list[dict[str, Any]] | None = None) -> Callable[..., subprocess.CompletedProcess[str]]:
    def run(argv: list[str], **options: Any) -> subprocess.CompletedProcess[str]:
        if calls is not None:
            calls.append({'argv': argv, **options, 'home_there': Path(options['env']['HOME']).is_dir()})
        name = Path(argv[-1]).name
        return subprocess.CompletedProcess(argv, code(name), '', said if code(name) else '')
    return run


def test_kiro_cli_is_optional_without_it_or_its_key_the_check_is_skipped_with_a_notice(tmp_path: Path) -> None:
    def never(*_args: object, **_options: object) -> subprocess.CompletedProcess[str]:
        raise AssertionError('kiro-cli is not run')

    assert validate.kiro_cli_problems(ROOT, which=lambda _name: None, run=never, home=_home(tmp_path)) == (
        [], 'kiro-cli: skipped, kiro-cli is not on PATH (its check of the Kiro agent configs is optional)')
    assert validate.kiro_cli_problems(ROOT, which=lambda _name: '/opt/kiro/kiro-cli', run=never,
                                      home=_home(tmp_path / 'b', key=None)) == (
        [], ('kiro-cli: skipped, no Kiro API key in ~/.config/voc-kiro/api-key (its check of the Kiro agent configs '
             'is optional)'))


def test_kiro_cli_validates_each_config_in_a_fresh_home_of_its_own_with_the_key_alone(tmp_path: Path) -> None:
    calls: list[dict[str, Any]] = []
    home = _home(tmp_path)
    found = validate.kiro_cli_problems(ROOT, which=lambda _name: '/opt/kiro/kiro-cli', run=_kiro(calls=calls),
                                       home=home)
    assert found == ([], 'kiro-cli: the 12 Kiro agent configs pass `kiro-cli agent validate`')
    assert sorted(call['argv'][-1] for call in calls) == sorted(
        str(ROOT / 'kiro-agents' / name) for name in kiro_files(load()))
    for call in calls:
        assert call['argv'][:4] == ['/opt/kiro/kiro-cli', 'agent', 'validate', '--path']
        assert set(call['env']) == {'PATH', 'HOME', 'KIRO_API_KEY'}
        assert (call['env']['KIRO_API_KEY'], call['cwd'], call['home_there']) == (KEY, call['env']['HOME'], True)
        assert not Path(call['env']['HOME']).exists()   # (removed after its run)
        assert not call['env']['HOME'].startswith(str(home))
        assert (call['check'], call['timeout']) == (False, validate.KIRO_CLI_SECONDS)
    assert len({call['env']['HOME'] for call in calls}) == 12


def test_a_config_kiro_cli_refuses_is_a_problem_and_the_key_never_shows(tmp_path: Path) -> None:
    said = f'\x1b[38;5;9mError: \x1b[0mJson supplied at fixer.json is invalid: key {KEY}\n  at line 1'
    problems, notice = validate.kiro_cli_problems(
        ROOT, which=lambda _name: '/opt/kiro/kiro-cli', run=_kiro(code=lambda name: int(name == 'fixer.json'),
                                                                   said=said), home=_home(tmp_path))
    assert (problems, notice) == ([('kiro-agents/fixer.json: kiro-cli agent validate refuses it: Error: Json '
                                    'supplied at fixer.json is invalid: key <the key> at line 1')], '')
    assert KEY not in ' '.join(problems)


@pytest.mark.parametrize(('failure', 'notice'), [
    (subprocess.TimeoutExpired(['kiro-cli'], 60), 'kiro-cli: skipped, it did not run (TimeoutExpired)'),
    (PermissionError('not executable'), 'kiro-cli: skipped, it did not run (PermissionError)'),
    (None, 'kiro-cli: skipped, it says it is not logged in'),
])
def test_kiro_cli_that_does_not_run_or_is_not_logged_in_is_skipped(tmp_path: Path, failure: Exception | None,
                                                                   notice: str) -> None:
    def run(argv: list[str], **_options: object) -> subprocess.CompletedProcess[str]:
        if failure is not None:
            raise failure
        return subprocess.CompletedProcess(argv, 1, '', 'error: You are not logged in, please log in with kiro-cli login')

    assert validate.kiro_cli_problems(ROOT, which=lambda _name: '/opt/kiro/kiro-cli', run=run,
                                      home=_home(tmp_path)) == ([], notice)
