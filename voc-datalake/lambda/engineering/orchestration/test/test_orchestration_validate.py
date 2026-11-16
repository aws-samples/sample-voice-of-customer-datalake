"""``npm run orchestration:validate``: the shipped templates pass every check, and each check catches what it is for
(on a copy of the folder, one thing broken at a time)."""
from __future__ import annotations

import json
import re
import shutil
from collections.abc import Callable
from pathlib import Path

import pytest

from engineering.orchestration import validate
from engineering.orchestration.compile import compile_bundle, load, render, write
from engineering.orchestration.schema import ROOT


def test_the_shipped_templates_and_both_bundles_pass_every_check() -> None:
    assert validate.problems(ROOT) == []


@pytest.fixture
def copy(tmp_path: Path) -> Path:
    """A copy of the templates folder, its two bundles beside it compiled."""
    root = tmp_path / 'orchestration'
    shutil.copytree(ROOT, root)
    write(render(compile_bundle(load(root))), root)
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
