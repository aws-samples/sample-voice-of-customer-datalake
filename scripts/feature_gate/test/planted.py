"""Planted repositories for the roadmap gate's tests (a temp tree, never the real one)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from feature_gate import registry, verdict

CHANGELOG = """# Changelog

## [Unreleased]

## [7.76.00] - 2026-11-26

Multi-workspace: the widget counts per workspace ([docs/widget.md](docs/widget.md)).

### Added

- The count.

## [7.75.01] - 2026-11-26

Tooling only: the widget's routes leave the pending list.

### Changed

- The list.

## [6.05.00] - 2026-11-11

Multi-workspace, phase 1: the first widget.

### Added

- A widget.

## [6.04.08] - 2026-11-11

Older than the gate's floor.

## [7.02.00] - 2026-11-15 (voc-wiki)

Another branch's own release.

## [7.00.01] - 2026-11-13

Main's release, after the first suffixed heading.
"""

PYTEST_FILE = '''import pytest


class TestWidget:
    def test_counts(self):
        assert 1 + 1 == 2

    @pytest.mark.skip(reason='later')
    def test_skipped(self):
        assert True


def test_module_level():
    assert [1][0] == 1
'''

VITEST_FILE = """import { describe, expect, it } from 'vitest'

// a comment with a brace { and a quote '
describe('Widget', () => {
  it('counts', () => {
    expect(/[}']/.test('}')).toBe(true)
  })
  it.skip('later', () => {
    expect(1).toBe(1)
  })
  it.each([[1, 2]])('adds %i', (a, b) => {
    expect(a + 1).toBe(b)
  })
  it(`uses ${'a'} template`, () => {
    expect(1).toBe(1)
  })
})
"""

SPEC_FILE = """import { expect, test } from '@playwright/test'

test.describe('Widget page', () => {
  test('shows the count', async ({ page }) => {
    await page.goto('/widget')
    await expect(page.getByText('3')).toBeVisible()
  })
  test.fixme('draws the chart', async ({ page }) => {
    await page.goto('/chart')
  })
  test('needs a deployment', async ({ page }) => {
    test.skip()
    await page.goto('/x')
  })
  test('mock only', async ({ page }) => {
    test.skip(process.env.X === '1', 'not on the mock')
    await page.goto('/y')
  })
})
"""

PRODUCT = 'def count(items):\n    return len(items)\n'

PYTEST_INI = """[pytest]
testpaths = lambda plugins
python_files = test_*.py *_test.py
python_classes = Test*
python_functions = test_*
addopts = -v --ignore=frontend --ignore=lambda/layers
norecursedirs = cdk.out .venv node_modules dist frontend .git layers _template
"""

ENV_TS = """export const MOCK_SPEC_NAMES: readonly string[] = [
  'error-states', 'widget',
  // a comment
  'memory',
]
export const OTHER = ['nope']
"""

HEAD = 'f' * 40
SHA = '8c345fb96'
TREE = 'e' * 40

PYTEST_ID = 'voc-datalake/lambda/api/test/test_widget.py::TestWidget::test_counts'
VITEST_ID = 'voc-datalake/frontend/src/widget.test.ts::Widget > counts'
SPEC_ID = 'voc-datalake/frontend/e2e/tests/widget.spec.ts::Widget page > shows the count'

BREAK = """diff --git a/voc-datalake/lambda/api/widget.py b/voc-datalake/lambda/api/widget.py
--- a/voc-datalake/lambda/api/widget.py
+++ b/voc-datalake/lambda/api/widget.py
@@ -1,2 +1,2 @@
 def count(items):
-    return len(items)
+    return 0
"""

CHECKS = ('tests_item', 'real_path', 'fails_on_break', 'not_tautology', 'stable_3x', 'runs_in_gate')


def write(root: Path, rel: str, text: str) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    return path


def item(version: str, kind: str, **extra: Any) -> dict[str, Any]:
    """One registry item as the seed writes it."""
    base: dict[str, Any] = {
        'id': version, 'aliases': [], 'title': f'Release {version}',
        'source': {'changelog': version, 'doc': None}, 'kind': kind, 'status': 'done',
        'unit': [], 'e2e': [], 'exemption': None,
    }
    base.update(extra)
    return base


def default_items() -> dict[str, list[dict[str, Any]]]:
    return {
        'phase1-2': [item('6.05.00', 'feature')],
        'phase3a-4': [],
        'product-7.5x-7.7x': [item('7.75.01', 'no-behaviour')],
        'phase3-switch': [item('7.76.00', 'feature')],
    }


def write_registry(root: Path, slices: dict[str, list[dict[str, Any]]]) -> None:
    for sl in registry.SLICES:
        registry.save_slice(root, sl, slices.get(sl.name, []))


def plant(root: Path, slices: dict[str, list[dict[str, Any]]] | None = None) -> Path:
    """The CHANGELOG above, one product module, a test of each runner, the suites' configs and a registry."""
    write(root, 'CHANGELOG.md', CHANGELOG)
    write(root, 'package.json', '{\n  "name": "planted",\n  "version": "7.76.0"\n}\n')
    write(root, 'voc-datalake/pytest.ini', PYTEST_INI)
    write(root, 'voc-datalake/lambda/conftest.py', 'import pytest\n')
    write(root, 'voc-datalake/lambda/api/widget.py', PRODUCT)
    write(root, 'voc-datalake/lambda/api/test/test_widget.py', PYTEST_FILE)
    write(root, 'voc-datalake/frontend/src/widget.test.ts', VITEST_FILE)
    write(root, 'voc-datalake/frontend/e2e/lib/env.ts', ENV_TS)
    write(root, 'voc-datalake/frontend/e2e/tests/widget.spec.ts', SPEC_FILE)
    write_registry(root, default_items() if slices is None else slices)
    return root


BASE_SHA = 'b' * 40
REF = 'origin/voc-multiplayer'


class FakeGit:
    """The git calls the program makes, answered from memory. ``chain`` is the history, oldest first (each commit
    the parent of the next; the last is HEAD), ``ref`` the commit the base ref names (None: it does not exist here),
    ``files`` each commit's files (the base branch's at ``ref`` by default)."""

    def __init__(self, base: dict[str, str] | None = None, *, chain: tuple[str, ...] = (BASE_SHA, SHA, HEAD),
                 ref: str | None = BASE_SHA, files: dict[str, dict[str, str]] | None = None,
                 missing: tuple[str, ...] = (), forks: dict[str, str] | None = None,
                 head2: str | None = None, history: tuple[str, ...] = ()) -> None:
        self.head2 = head2            # HEAD's second parent (a PR's merge ref: the PR's own head), None: no merge
        self.history = history        # the versions package.json held on the first-parent line, newest first
        self.boots: dict[str, str] = {}   # tip -> its bootstrap commit (empty: the oldest history commit, any tip)
        self.missing = set(missing)   # the paths no commit holds (every other path is in every commit)
        self.forks = forks or {}      # a commit off the chain -> the chain commit it shares with HEAD (its merge-base)
        self.chain = list(chain)
        self.ref = None if base is None else ref
        if base is not None and 'package.json' not in base:
            base = {**base, 'package.json': '{"version": "7.103.0"}\n'}   # a base from before the gate
        self.files = files if files is not None else ({ref: base} if base is not None and ref else {})
        self.calls: list[list[str]] = []

    def _resolve(self, name: str) -> str | None:
        name = name.removesuffix('^{commit}')
        if name == 'HEAD^2':
            return self.head2
        parent = name.endswith('^1')
        name = name.removesuffix('^1')
        sha = {'HEAD': self.chain[-1], REF: self.ref}.get(name, name)
        if sha in self.forks and not parent:
            return sha
        if sha not in self.chain:
            return None
        k = self.chain.index(sha) - (1 if parent else 0)
        return self.chain[k] if k >= 0 else None

    def _on_chain(self, name: str) -> str | None:
        sha = self._resolve(name)
        return self.forks.get(sha, sha) if sha else None

    def _history_shas(self) -> list[str]:
        return [f'{k + 1:040x}' for k in range(len(self.history))]

    def _log(self, args: list[str]) -> str:
        """The bumps since the gate came: every one of ``history``, the oldest being the bootstrap commit."""
        shas = self._history_shas()
        if '--diff-filter=A' in args:
            if self.boots:   # a bootstrap commit per tip (the tip is the word before `--`)
                return self.boots.get(args[args.index('--') - 1], '') + '\n'
            return shas[-1] + '\n' if shas else ''
        return ''.join(f'{s}\n' for s in shas)

    def _show(self, args: list[str]) -> str | None:
        commit, _, path = args[-1].partition(':')
        if path == 'package.json' and commit in self._history_shas():
            return json.dumps({'version': self.history[int(commit, 16) - 1]})
        return self.files.get(self._resolve(commit) or '', {}).get(path)

    def _cat_file(self, args: list[str]) -> str | None:
        commit, _, path = args[-1].partition(':')
        return '' if self._resolve(commit) and path not in self.missing else None

    def _rev_parse(self, args: list[str]) -> str | None:
        sha = self._resolve(args[-1])
        return None if sha is None else sha + '\n'

    def _ls_tree(self, args: list[str]) -> str | None:
        sha, prefix = self._resolve(args[-2]), args[-1]
        return ''.join(f'{p}\n' for p in self.files.get(sha or '', {}) if p.startswith(prefix)) if sha else None

    def _merge_base(self, args: list[str]) -> str | None:
        if args[1] == '--is-ancestor':
            older, newer = self._on_chain(args[2]), self._on_chain(args[3])
            ok = older is not None and newer is not None and self.chain.index(older) <= self.chain.index(newer)
            return '' if ok and args[2] not in self.forks else None
        a, b = self._on_chain(args[-2]), self._on_chain(args[-1])
        return None if a is None or b is None else min(a, b, key=self.chain.index) + '\n'

    def __call__(self, args: list[str]) -> str | None:
        self.calls.append(args)
        if 'log' in args:
            return self._log(args)
        handlers = {'show': self._show, 'cat-file': self._cat_file, 'rev-parse': self._rev_parse,
                    'ls-tree': self._ls_tree, 'merge-base': self._merge_base}
        if args[0] not in handlers:
            raise AssertionError(f'unexpected git call {args}')
        return handlers[args[0]](args)


def base_from(root: Path) -> dict[str, str]:
    """The planted tree's registry and allowed gaps as the base branch's files."""
    out = {sl.file: (root / sl.file).read_text(encoding='utf-8') for sl in registry.SLICES}
    out['package.json'] = (root / 'package.json').read_text(encoding='utf-8')
    allowed = root / 'docs/feature-tests/allowed-gaps.json'
    if allowed.exists():
        out['docs/feature-tests/allowed-gaps.json'] = allowed.read_text(encoding='utf-8')
    return out


def red_block(test: str) -> str:
    return f'```\nFAILED {test} - AssertionError: assert 0 == 2\n1 failed\n```'


def verdict_text(*, item_id: str, test: str, digest: str, command: str, outcome: str = 'ACCEPT',
                 evaluator: str = 'eval-1/a', author: str = 'h2/a', sha: str = SHA,
                 checks: dict[str, bool] | None = None, sections: dict[str, str] | None = None) -> str:
    """A verdict file; `sections` replaces a section's body (an empty string drops its content)."""
    marks = dict.fromkeys(CHECKS, True) | (checks or {})
    body = {
        'Item': f'{item_id}: what the user gets.',
        'Command': f'```bash\n{command}\n```',
        'Break': f'```diff\n{BREAK}```',
        'Red': red_block(test),
        'Green': '\n'.join(f'Run {n}:\n```\n1 passed in 0.1s\n```' for n in (1, 2, 3)),
        'Reasons': 'It asserts the count the user sees.',
    } | (sections or {})
    front = [f'item: {item_id}', f'test: {test}', f'digest: {digest}', f'verdict: {outcome}',
             f'evaluator: {evaluator}', f'author: {author}', f'sha: {sha}', f'tree: {TREE}', 'checks:']
    front += [f'  {name}: {"true" if value else "false"}' for name, value in marks.items()]
    return document(front, body)


def document(front: list[str], body: dict[str, str]) -> str:
    parts = ['---', *front, '---', '']
    for name, text in body.items():
        parts += [f'## {name}', '', text, '']
    return '\n'.join(parts)


def record_text(*, item_id: str, change: str, proposed_by: str = 'h2/a', reviewer: str = 'eval-1/a',
                sha: str = SHA, reasons: str = 'The release adds no route: plumbing.') -> str:
    """A decision or exemption record (docs/test-verdicts/<item>/decision.md, exemption.md)."""
    front = [f'item: {item_id}', f'change: {change}', f'proposed_by: {proposed_by}', f'reviewer: {reviewer}',
             f'sha: {sha}', f'tree: {TREE}']
    return document(front, {'Reasons': reasons})


def verdict_file(root: Path, item_id: str, runner: str, test: str, text: str) -> str:
    rel = verdict.verdict_path(item_id, runner, test)
    write(root, rel, text)
    return rel


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding='utf-8'))
