"""The agent docs rendered (7.52.00, knowledge/render_docs.py): deterministic bytes and digest, the paths each package
takes, the text kept literal, and TENETS.md."""
from __future__ import annotations

import hashlib
import json
from typing import Any

import pytest

from engineering.knowledge import reduce, render_docs
from engineering.knowledge.notes import Note
from engineering.knowledge.reduce import reduce_package, to_json
from engineering.knowledge.render_docs import (
    INDEX_PATH,
    REPOSITORY_PATH,
    TENETS_PATH,
    RenderError,
    doc_path,
    patch,
    render_knowledge,
    render_tenets,
    rendering_digest,
)
from engineering.knowledge.workspaces import ROOT, Package
from engineering.runtime.outputs import tenets_record

SHA = 'a' * 40


def _packs() -> tuple[dict[str, Any], dict[str, int]]:
    web = reduce_package('packages/web', [
        Note('convention', 'packages/web', 'Two spaces, never tabs.', ('packages/web/src/app.ts:3',), 'indent'),
        Note('test-strategy', 'packages/web', 'Vitest covers every route.', (SHA,), 'tests')])
    root = reduce_package(ROOT, [Note('architecture', ROOT, 'An npm workspace of two packages.', ('package.json:1',),
                                      'layout')],
                          packages=[Package('packages/web', '@harbor/web', ('npm',), '.', ('@harbor/frontend',)),
                                    Package('packages/api', '@harbor/api', ('npm',), '.', ())])
    return {ROOT: to_json(root), 'packages/web': to_json(web)}, {ROOT: 3, 'packages/web': 2}


def test_the_same_packs_render_the_same_bytes_and_digest() -> None:
    packs, versions = _packs()
    first, again = render_knowledge(packs, versions), render_knowledge(json.loads(json.dumps(packs)), dict(versions))
    assert first.paths() == (INDEX_PATH, REPOSITORY_PATH, 'docs/agents/packages/web.md')
    assert [f.content for f in first.files] == [f.content for f in again.files]
    assert first.digest == again.digest
    canonical = json.dumps(sorted([f.path, hashlib.sha256(f.content).hexdigest()] for f in first.files),
                           separators=(',', ':'))
    assert first.digest == hashlib.sha256(canonical.encode()).hexdigest()
    assert first.digest == rendering_digest(reversed(first.files))   # (the list is sorted: order does not count)


def test_a_change_of_one_claim_changes_the_digest() -> None:
    packs, versions = _packs()
    packs['packages/web']['documents']['convention'][0]['claim'] = 'Four spaces.'
    assert render_knowledge(packs, versions).digest != render_knowledge(*_packs()).digest


def test_the_index_lists_every_package_and_links_the_approved_ones() -> None:
    packs, versions = _packs()
    index = render_knowledge(packs, versions).files[0].content.decode()
    assert '| the repository | [repository.md](repository.md) | 3 |' in index
    assert '| `packages/web` | [packages/web.md](packages/web.md) | 2 |' in index
    assert '| `packages/api` | not approved yet | |' in index


def test_a_package_doc_has_every_document_with_footnotes_numbered_across_the_file() -> None:
    packs, versions = _packs()
    web = render_knowledge(packs, versions).files[2].content.decode()
    assert web.startswith('# Agent knowledge: `packages/web`\n')
    assert [line for line in web.splitlines() if line.startswith('## ')] == [
        f'## {title}' for title in render_docs.TITLES.values()]
    assert '- **indent**: Two spaces, never tabs.[^1]' in web
    assert '- **tests**: Vitest covers every route.[^2]' in web
    assert web.endswith(f'[^1]: `packages/web/src/app.ts:3`\n[^2]: commit `{SHA}`\n')
    overview = render_knowledge(packs, versions).files[1].content.decode()
    assert '| `packages/web` | @harbor/web | npm | @harbor/frontend |' in overview


@pytest.mark.parametrize(('package', 'path'), [
    (ROOT, 'docs/agents/repository.md'),
    ('index', 'docs/agents/index-package.md'),
    ('Index', 'docs/agents/Index-package.md'),
    ('repository', 'docs/agents/repository-package.md'),
    ('crates/core', 'docs/agents/crates/core.md'),
    ('apps/my app', 'docs/agents/apps/my-app.md'),
    ('index/sub', 'docs/agents/index/sub.md'),
])
def test_each_package_has_its_place(package: str, path: str) -> None:
    assert doc_path(package) == path


@pytest.mark.parametrize('package', ['', '../escape', 'a//b', 'a/./b', 'a/..'])
def test_a_path_that_is_no_package_is_refused(package: str) -> None:
    with pytest.raises(RenderError):
        doc_path(package)


def test_two_packages_on_one_file_are_refused_never_merged() -> None:
    packs, versions = _packs()
    one = {**packs['packages/web'], 'package': 'Apps/Web'}
    other = {**packs['packages/web'], 'package': 'apps/web'}
    with pytest.raises(RenderError, match='two packages render to'):
        render_knowledge({**packs, 'Apps/Web': one, 'apps/web': other}, {**versions, 'Apps/Web': 1, 'apps/web': 1})


def test_a_stored_pack_off_its_schema_or_of_another_package_is_refused() -> None:
    packs, versions = _packs()
    with pytest.raises(RenderError):
        render_knowledge({**packs, 'packages/web': {**packs['packages/web'], 'schema': 'voc-kpack/0'}}, versions)
    with pytest.raises(RenderError):
        render_knowledge({**packs, 'packages/web': {**packs['packages/web'], 'package': 'packages/api'}}, versions)


def test_repository_text_stays_literal_markdown() -> None:
    packs, versions = _packs()
    packs['packages/web']['documents']['convention'][0].update(
        claim='Click [here](https://evil.example)\n# Heading <img src=x> | cell', subject='a `b`')
    web = render_knowledge(packs, versions).files[2].content.decode()
    line = next(line for line in web.splitlines() if 'Click' in line)
    assert line == ('- **a \\`b\\`**: Click \\[here\\](https://evil.example) \\# Heading \\<img src=x\\> \\| cell[^1]')
    assert '\n# Heading' not in web


def test_a_flagged_claim_is_not_rendered_it_was_never_applied() -> None:
    packs, versions = _packs()
    packs['packages/web']['flagged'] = [{'kind': 'convention', 'claim': {'claim': 'Tabs.', 'citations': [SHA],
                                                                        'subject': 'indent', 'author': ''},
                                         'edit': 'x'}]
    assert 'Tabs.' not in render_knowledge(packs, versions).files[2].content.decode()


def test_the_patch_adds_each_file() -> None:
    packs, versions = _packs()
    rendering = render_knowledge(packs, versions)
    text = patch(rendering)
    assert text.count('new file mode 100644') == 3
    assert f'diff --git a/{INDEX_PATH} b/{INDEX_PATH}\nnew file mode 100644\n--- /dev/null\n+++ b/{INDEX_PATH}\n' in text
    assert '+# Agent knowledge: `packages/web`\n' in text


TENETS = tenets_record({'summary': 'What the code holds to.', 'tenets': [
    {'id': 'T1', 'title': 'Fail closed', 'statement': 'An unknown state refuses, never passes.',
     'rationale': 'A guessed pass ships a bug.', 'citations': ['src/gate.py:12']},
    {'id': 'T2', 'title': 'Tests first', 'statement': 'Every public function has a test.'}]})


def test_tenets_md_lists_each_tenet_under_its_id() -> None:
    rendering = render_tenets(TENETS, 2)
    assert rendering.paths() == (TENETS_PATH,)
    text = rendering.files[0].content.decode()
    assert text.startswith('# Tenets\n\n> The tenets an administrator accepted (version 2)')
    assert ('## T1: Fail closed\n\nAn unknown state refuses, never passes.\n\nWhy: A guessed pass ships a bug.\n\n'
            'Sources: `src/gate.py:12`.\n') in text
    assert '## T2: Tests first\n\nEvery public function has a test.\n' in text
    assert rendering.digest == render_tenets(json.loads(json.dumps(TENETS)), 2).digest
    assert rendering.digest != render_tenets(TENETS, 3).digest   # (the version is in the file)


def test_a_record_off_its_schema_renders_no_tenets() -> None:
    with pytest.raises(RenderError):
        render_tenets({**TENETS, 'schema': 'voc-tenets/0'}, 1)
    with pytest.raises(RenderError):
        render_tenets({**TENETS, 'tenets': []}, 1)


def test_the_constants_are_the_stores_own() -> None:
    assert render_docs.TITLES == reduce.TITLES
    assert render_docs.PACK_SCHEMA == reduce.PACK_SCHEMA
    assert render_docs.ROOT == ROOT
