"""The skills library (7.56.00, templates/orchestration/skills/): compiled into both bundles with the roles that use
each skill, listed in each Kiro config's prompt, and held by ``npm run orchestration:validate`` to its front matter, its
files, references that resolve and no internal link (each check on a copy of the folder, one thing broken at a time)."""
from __future__ import annotations

import json
import re
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import yaml

from engineering.orchestration import validate
from engineering.orchestration.bundle import MAX_LEARN_SKILLS_CHARS
from engineering.orchestration.bundle import load as load_bundle
from engineering.orchestration.compile import compile_bundle, kiro_files, load, render, write, write_kiro_agents
from engineering.orchestration.schema import ROOT
from engineering.runtime.harness.library_tools import LISTING_HEAD, MAX_CHARS, READ_SKILL, listing

#: THIRD-PARTY-LICENSES.md at the repository's root (ROOT is voc-datalake/templates/orchestration).
LICENSES = ROOT.parents[2] / 'THIRD-PARTY-LICENSES.md'


def test_the_bundle_carries_the_library_by_name_with_the_roles_each_card_names() -> None:
    bundle = load_bundle()
    library = {item['name']: item for item in bundle['library']}
    assert list(library) == sorted(library)
    assert len(library) >= 25
    by_role = {agent['id']: agent['skills'] for agent in bundle['agents']}
    for name, item in library.items():
        assert item['roles'] == [role for role in by_role if name in by_role[role]], name
        assert item['path'] == f'skills/{name}/SKILL.md'
        assert item['text'].startswith(f'---\nname: {name}\n')
        assert item['bytes'] == len(item['text'].encode())
        assert item['license'] == 'MIT'
        assert all(re.fullmatch(r'references/[^/]+\.md', ref['path']) for ref in item['references'])
    assert by_role['coordinator'] == by_role['committer'] == []
    assert 'tdd' in by_role['fixer']
    assert 'code-review' in by_role['commit-reviewer']
    assert by_role['coach'] == ['retrospective', 'skill-builder', 'skill-audit']


def test_every_launchable_card_with_skills_reads_them_and_its_kiro_prompt_lists_them() -> None:
    sources = load()
    configs = kiro_files(sources)
    for role, card in sources.cards.items():
        if card['harness'] == 'learn':
            continue
        assert (READ_SKILL in card['tools']) == bool(card.get('skills')), role
        prompt = json.loads(configs[f'{role}.json'])['prompt']
        names = [f'\n- {name}: ' for name in card.get('skills', [])]
        assert (LISTING_HEAD in prompt) == bool(names), role
        assert all(name in prompt for name in names), role
    assert listing([{'name': 'tdd', 'description': 'Red,\n green.'}]).endswith('\n- tdd: Red, green.')


def test_the_vendored_library_names_its_upstream_in_third_party_licenses() -> None:
    licenses = LICENSES.read_text(encoding='utf-8')
    for item in load_bundle()['library']:
        upstream = item['source'].split(',', 1)[0].split(' (', 1)[0]   # 'ai-skill-factory 2.0.0'
        assert upstream in licenses, item['name']
    assert 'Copyright (c) 2026 AI Skill Factory Contributors' in licenses


@pytest.fixture
def copy(tmp_path: Path) -> Path:
    """A copy of the templates folder, its two bundles and its Kiro agent configs compiled beside it."""
    root = tmp_path / 'orchestration'
    shutil.copytree(ROOT, root, ignore=shutil.ignore_patterns('images'))   # (the agent images: not a template)
    sources = load(root)
    write(render(compile_bundle(sources)), root)
    write_kiro_agents(kiro_files(sources), root)
    return root


def _append(path: Path, text: str) -> None:
    path.write_text(path.read_text(encoding='utf-8') + text, encoding='utf-8')


def _card(root: Path, role: str, change: Callable[[dict[str, Any]], None]) -> None:
    path = root / 'agents' / role / 'agent.yaml'
    card = yaml.safe_load(path.read_text(encoding='utf-8'))
    change(card)
    path.write_text(yaml.safe_dump(card, sort_keys=False), encoding='utf-8')


def _front(root: Path, name: str, old: str, new: str) -> None:
    path = root / 'skills' / name / 'SKILL.md'
    text = path.read_text(encoding='utf-8')
    assert old in text
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


def test_a_copy_of_the_library_passes(copy: Path) -> None:
    assert validate.problems(copy) == []


@pytest.mark.parametrize(('change', 'problem'), [
    (lambda r: _append(r / 'skills/tdd/SKILL.md', '\nSee references/missing.md.\n'),
     r'skills/tdd/SKILL.md: names references/missing.md, which the skill does not have'),
    (lambda r: _append(r / 'skills/tdd/SKILL.md', '\nThen read the `no-such-skill` skill.\n'),
     r'names the `no-such-skill` skill, which the library does not have'),
    (lambda r: _append(r / 'skills/tdd/SKILL.md', '\n[the guide](../code-review/SKILL.md)\n'),
     r'links \.\./code-review/SKILL\.md: a skill names a file of its own'),
    (lambda r: _append(r / 'skills/tdd/SKILL.md', '\nSee https://w.amazon.com/bin/view/Testing.\n'),
     r'skills/tdd/SKILL\.md:\d+: names an internal host or system \(w\.amazon\.com\)'),
    (lambda r: _append(r / 'skills/tdd/SKILL.md', '\nGet credentials from Isengard first.\n'),
     r'names an internal host or system \(Isengard\)'),
    (lambda r: _append(r / 'skills/tdd/SKILL.md', '\n' + 'x' * MAX_CHARS + '\n'),
     rf'skills/tdd/SKILL\.md: \d+ characters, over the {MAX_CHARS} read_skill answers'),
    (lambda r: (r / 'skills/tdd/run.sh').write_text('echo hi\n'),
     r'skills/tdd/run\.sh: a library skill holds its SKILL\.md and references/<file>\.md only'),
    (lambda r: _front(r, 'tdd', 'license: MIT', 'license: GPL-3.0'), r'skills/tdd/SKILL\.md front matter: license'),
    (lambda r: _front(r, 'tdd', 'name: tdd', 'name: tdd-two'), r"its name is its directory's, tdd"),
    (lambda r: _card(r, 'pr-author', lambda c: c['skills'].append('nope')),
     r'agents/pr-author/agent\.yaml: no library skill nope'),
    (lambda r: _card(r, 'pr-author', lambda c: c.update(tools=[t for t in c['tools'] if t != READ_SKILL])),
     r'pr-author/agent\.yaml: a role with skills has read_skill among its tools'),
    (lambda r: _card(r, 'pr-author', lambda c: c.pop('skills')),
     r'pr-author/agent\.yaml: read_skill reads the library skills its card names, and it names none'),
    (lambda r: _card(r, 'pr-author', lambda c: c['skills'].remove('technical-writing'))
     or _card(r, 'mapper', lambda c: c['skills'].remove('technical-writing'))
     or _card(r, 'understander', lambda c: c['skills'].remove('technical-writing')),
     r'skills/technical-writing: no card names it'),
    (lambda r: _append(r / 'skills/retrospective/SKILL.md', '\n' + 'y ' * MAX_LEARN_SKILLS_CHARS + '\n'),
     rf"agents/coach/agent\.yaml: its skills' SKILL\.md bodies are \d+ characters, over the {MAX_LEARN_SKILLS_CHARS}"),
])
def test_each_library_check_catches_what_it_is_for(copy: Path, change: Callable[[Path], Any], problem: str) -> None:
    change(copy)
    found = validate.problems(copy, drift=False)
    assert any(re.search(problem, line) for line in found), found


def test_a_public_aws_link_is_fine_and_an_internal_one_is_named_with_its_line() -> None:
    assert validate.internal_mentions('See https://docs.aws.amazon.com/lambda/ and https://aws.amazon.com/cdk/.') == []
    assert validate.internal_mentions('one\nhttps://code.amazon.com/packages/x and amzn tools') == [
        (2, 'code.amazon.com'), (2, 'amzn')]
    assert validate.internal_mentions('the s3.amazonaws.com endpoint, an amzn2 AMI') == []
