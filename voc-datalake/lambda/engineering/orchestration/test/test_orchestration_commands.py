"""The orchestration command line: validate, compile, promote-pending, run (a dry run, the stubs), calibrate."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
import yaml

from engineering.orchestration import __main__ as cli
from engineering.orchestration import calibrate, promote, runner
from engineering.orchestration.compile import compile_bundle, load, render, write
from engineering.orchestration.schema import ROOT, read_yaml
from engineering.runtime.harness import tools

DIVIDE = ROOT / 'evals' / 'bug-hunt-and-fix' / 'cases' / 'divide-floor-bug' / 'repo'


def _main(*argv: str) -> tuple[int, list[str]]:
    lines: list[str] = []
    return cli.main(list(argv), lines.append), lines


def test_validate_and_compile_check_say_the_shipped_templates_are_valid_and_compiled() -> None:
    assert _main('validate') == (0, ['orchestration: the templates and both bundles are valid'])
    assert _main('compile', '--check') == (0, [])


def test_compile_writes_only_what_changed_and_refuses_templates_with_problems(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / 'orchestration'
    shutil.copytree(ROOT, root)
    monkeypatch.setattr(cli, 'ROOT', root)
    code, lines = _main('compile')
    assert (code, lines[0].startswith('wrote ')) == (0, True)
    assert _main('compile') == (0, ['both bundles are up to date'])
    assert _main('compile', '--check') == (0, [])
    (root / 'bundle.json').write_text('{}\n', encoding='utf-8')
    assert _main('compile', '--check')[0] == 1
    assert _main('validate')[0] == 1
    (root / 'flows' / 'feature.yaml').write_text('schema: voc-flow-template/1\n', encoding='utf-8')
    code, lines = _main('compile')
    assert code == 1
    assert lines
    assert all(line.startswith('flows/feature.yaml') for line in lines)


def test_promote_pending_moves_what_the_platform_now_offers_bumps_the_version_and_compiles(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / 'orchestration'
    shutil.copytree(ROOT, root)
    write(render(compile_bundle(load(root))), root)
    assert promote.promote(root) == ()   # (nothing is offered yet)
    offered = tools.ToolSpec('read_issue', 'Read the run\'s issue.', {})
    monkeypatch.setattr(promote, 'role_specs', lambda role: (*tools.role_specs(role), offered) if role == 'fixer'
                        else tools.role_specs(role))
    monkeypatch.setattr(promote, 'permitted', lambda role, op: (role, op) == ('understander', 'label_issue'))
    moved = promote.promote(root)
    assert [str(item) for item in moved] == [
        'fixer: tool read_issue (template version 2 -> 3)',
        'understander: broker op label_issue (template version 2 -> 3)']
    fixer = read_yaml(root / 'agents' / 'fixer' / 'agent.yaml', root)
    assert (fixer['version'], fixer['tools'][-4:], 'pending_tools' in fixer) == (
        3, ['read_issue', 'report_progress', 'save_checkpoint', 'finish'], False)
    assert 'voc-template-version: 3' in (root / 'agents' / 'fixer' / 'SKILL.md').read_text(encoding='utf-8')
    understander = read_yaml(root / 'agents' / 'understander' / 'agent.yaml', root)
    assert (understander['broker_ops'], 'pending_broker_ops' in understander) == (
        ['read', 'post_comment', 'label_issue'], False)
    assert understander['pending_tools'] == ['read_issue', 'write_triage', 'post_comment', 'label_issue']
    bundle = json.loads((root / 'bundle.json').read_text(encoding='utf-8'))
    assert next(agent for agent in bundle['agents'] if agent['id'] == 'fixer')['skill']['tool_policy'] == fixer['tools']
    assert (root / 'orchestration_bundle.json').read_text(encoding='utf-8') == (root / 'bundle.json').read_text(
        encoding='utf-8')


def test_a_flow_list_wraps_under_its_first_value_and_a_key_can_go() -> None:
    text = 'id: x\ntools: [a,\n        b]\npending_tools: [c]\nversion: 1\n'
    long = [f'tool_number_{n}' for n in range(12)]
    wrapped = promote.set_key(text, 'tools', long)
    assert all(len(line) <= promote.WIDTH for line in wrapped.splitlines())
    assert yaml.safe_load(wrapped)['tools'] == long
    assert promote.set_key(text, 'pending_tools', None) == 'id: x\ntools: [a,\n        b]\nversion: 1\n'
    assert promote.set_key(text, 'tools', []).splitlines()[1] == 'tools: []'


def test_promote_pending_says_when_nothing_moved() -> None:
    assert _main('promote-pending') == (0, [('nothing to promote: every pending tool and broker operation is still not '
                                            'offered')])


def test_a_dry_run_prints_the_flow_its_resolved_skills_and_the_gate_plan() -> None:
    code, lines = _main('run', '--flow', 'bug-hunt-and-fix', '--repo', str(DIVIDE), '--dry-run')
    text = '\n'.join(lines)
    assert code == 0
    assert lines[0] == 'flow bug-hunt-and-fix v3: Bug hunt and fix'
    assert json.loads(lines[1])['schema'] == 'voc-workflow/2'
    assert ('  board.fixer: fixer@latest -> fixer@template-2 (the template), global.anthropic.claude-sonnet-5-5, '
            'converse; tools read_file') in text
    assert 'pending read_issue' in text
    assert 'pending run_gate' in text
    assert f'gate plan on {DIVIDE}: packs python' in text
    assert '  [setup] py.install@.: ' in text
    assert ' -r requirements-dev.txt' in text
    assert '  [test] py.test@.: ' in text
    assert '-m pytest -q -p no:cacheprovider' in text
    assert '  (skipped) py.ruff@.: the repository does not use this tool' in text


def test_a_run_names_a_flow_and_a_directory_and_bedrock_is_a_stub_for_now(tmp_path: Path) -> None:
    assert _main('run', '--flow', 'nope', '--repo', str(DIVIDE), '--dry-run') == (2, [
        'no flow nope (the flows: understand-repository, issue-triage, bug-hunt-and-fix, feature, pr-review)'])
    assert _main('run', '--flow', 'feature', '--repo', str(tmp_path / 'none'), '--dry-run')[0] == 2
    assert _main('run', '--flow', 'bug-hunt-and-fix', '--repo', str(DIVIDE), '--models', 'bedrock') == (
        2, [runner.BEDROCK_STUB])
    assert _main('run', '--flow', 'feature', '--repo', str(DIVIDE)) == (
        2, ['--models fake scripts bug-hunt-and-fix; for feature, use --dry-run'])
    code, lines = _main('run', '--flow', 'bug-hunt-and-fix', '--repo', str(tmp_path))
    assert code == 2
    assert 'is not an eval case\'s fixture with a known fix' in lines[-1]


def test_calibrate_proposes_caps_and_budgets_from_the_manifests(tmp_path: Path) -> None:
    manifest = {'schema': 'voc-run-manifest/1', 'run_id': 'RUN1', 'flow': {'id': 'bug-hunt-and-fix', 'revision': 1},
                'tokens': 400_000, 'cost_usd': 3.2,
                'sessions': [{'agent': 'hunter-2', 'role': 'hunter', 'turns': 30, 'input_tokens_max': 40_000,
                              'minutes': 12},
                             {'agent': 'fixer-3', 'role': 'fixer', 'turns': 120, 'input_tokens_max': 100_000,
                              'minutes': 20}]}
    path = tmp_path / 'v0001.json'
    path.write_text(json.dumps(manifest), encoding='utf-8')
    code, lines = _main('calibrate', '--run', 'RUN1', '--manifest', str(path))
    assert code == 0
    assert lines == [
        'agents/fixer/agent.yaml: caps.max_turns = 150   (p95 observed 120 x 1.5)',
        'agents/fixer/agent.yaml: caps.max_input_tokens = 120000   (p95 observed 100000 x 1.5)',
        'agents/hunter/agent.yaml: caps.max_turns = 45   (p95 observed 30 x 1.5)',
        'agents/hunter/agent.yaml: caps.max_input_tokens = 60000   (p95 observed 40000 x 1.5)',
        'flows/bug-hunt-and-fix.yaml: budget.run_token_cap = 600000   (p95 observed 400000 x 1.5)',
        'flows/bug-hunt-and-fix.yaml: budget.max_tasks = 3   (p95 observed 2 x 1.5)']
    assert calibrate.p95([5, 1, 3, 2, 4]) == 5
    assert _main('calibrate', '--run', 'RUN2', '--manifest', str(path)) == (
        2, [f'no manifest of run RUN2 among {path}'])
    assert _main('calibrate', '--run', 'RUN1')[0] == 2
    path.write_text('{"schema": "other"}', encoding='utf-8')
    assert _main('calibrate', '--run', 'RUN1', '--manifest', str(path))[1][0].endswith(
        'not a voc-run-manifest/1 manifest with its flow and sessions')
    assert _main('calibrate', '--run', 'RUN1', '--manifest', str(tmp_path / 'none.json'))[0] == 2
