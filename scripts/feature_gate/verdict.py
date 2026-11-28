"""An evaluator's verdict file (docs/test-verdicts/TEMPLATE.md): its front matter, its sections and its evidence.

A verdict lives at docs/test-verdicts/<item>/<runner>-<hash>.md, ``<hash>`` the first 12 hex digits of sha256 of the
test id, so one test of one item has one verdict file (a later verdict replaces it; git keeps the earlier ones, and
the registry keeps every REJECT's evaluator, sha and reasons). The same folder holds the item's decision record
(decision.md) and exemption record (exemption.md), in the same format (records.py).

An ACCEPT holds its evidence: every check true; the exact pinned command; a ```diff block whose every file is product
code with at least one changed line that is not a comment (the break the evaluator applied in a scratch tree); a Red
block that names the test and shows a failure; three Green blocks, each showing 1 passed and 0 skipped; its sha (the
commit it was evaluated on) and tree (``git write-tree`` of the staged change); and its reasons. A REJECT holds its
command and reasons. These are checked as written: the run per build (report.py) is to replay the break and see it.
"""
from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from . import registry

VERDICT_DIR = 'docs/test-verdicts'
MAX_BYTES = 256_000
CHECKS = ('tests_item', 'real_path', 'fails_on_break', 'not_tautology', 'stable_3x', 'runs_in_gate')
FRONT_KEYS = ('item', 'test', 'digest', 'verdict', 'evaluator', 'author', 'sha', 'tree')
OUTCOMES = ('ACCEPT', 'REJECT')
FENCE_RE = re.compile(r'^```([\w-]*)[ \t]*\n(.*?)^```[ \t]*$', re.MULTILINE | re.DOTALL)
TEST_SEGMENTS = {'test', 'tests', '__tests__', 'test-support', 'e2e', 'fixtures', '__fixtures__', '__mocks__', 'mocks'}
TEST_FILE_RE = re.compile(r'(\Atest_.*\.py|_test\.py|\Aconftest\.py|\.(test|spec)\.[cm]?[jt]sx?)\Z')
PRODUCT_ROOTS = ('voc-datalake/lambda/', 'voc-datalake/frontend/src/', 'voc-datalake/lib/')
COMMENT_STARTS = ('#', '//', '/*', '*', '*/', '<!--')
FAILURE_RE = re.compile(r'\b(FAILED|FAIL|failed|AssertionError|Error)\b|[\N{BALLOT X}\N{MULTIPLICATION SIGN}]')   # vitest's marks
PASSED_RE = re.compile(r'(?<![\d.])\b1 passed\b')
SKIPPED_RE = re.compile(r'\b[1-9]\d* skipped\b')
PASSED_MORE_RE = re.compile(r'\b([2-9]|\d{2,}) passed\b')
BAD_COUNT_RE = re.compile(r'\b[1-9]\d* (failed|errors?|flaky|reruns?)\b')
HUNK_RE = re.compile(r'@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@')
PASS_MARK_RE = re.compile(r'[\N{CHECK MARK}\N{HEAVY CHECK MARK}\N{SQUARE ROOT}]|\b(PASS|PASSED|passed)\b')


@dataclass
class Verdict:
    front: dict[str, str] = field(default_factory=dict)
    checks: dict[str, bool] = field(default_factory=dict)
    sections: dict[str, str] = field(default_factory=dict)


def _under(path: str) -> str:
    normal = os.path.normpath(path)
    if not normal.startswith(VERDICT_DIR + '/'):
        raise ValueError(f'{path} is not under {VERDICT_DIR}')
    return normal


def verdict_path(item_id: str, runner: str, test_id: str) -> str:
    digest = hashlib.sha256(test_id.encode('utf-8')).hexdigest()[:12]
    return _under(f'{VERDICT_DIR}/{item_id}/{runner}-{digest}.md')


def reject_path(item_id: str, runner: str, test_id: str, n: int) -> str:
    """The n-th REJECT of a test (1-based): each REJECT keeps a file of its own."""
    return verdict_path(item_id, runner, test_id).removesuffix('.md') + f'.reject-{n}.md'


def reject_files(root: Path, item_id: str, runner: str, test_id: str) -> list[str]:
    stem = PurePosixPath(verdict_path(item_id, runner, test_id)).name.removesuffix('.md')
    folder = root / VERDICT_DIR / item_id
    return sorted(p.name for p in folder.glob(f'{stem}.reject-*.md')) if folder.is_dir() else []


def record_path(item_id: str, name: str) -> str:
    """An item's decision.md or exemption.md."""
    return _under(f'{VERDICT_DIR}/{item_id}/{name}')


def _front(lines: list[str]) -> tuple[dict[str, str], dict[str, bool]]:
    front: dict[str, str] = {}
    checks: dict[str, bool] = {}
    in_checks = False
    for line in lines:
        if not line.strip():
            continue
        key, sep, value = line.strip().partition(':')
        if not sep:
            raise ValueError(f'front matter line without a colon: {line!r}')
        if line.startswith((' ', '\t')):
            if not in_checks:
                raise ValueError(f'an indented front matter line belongs only under checks: ({line.strip()!r})')
            checks[key.strip()] = value.strip().lower() == 'true'
            continue
        in_checks = key.strip() == 'checks'
        if not in_checks:
            front[key.strip()] = value.strip()
    return front, checks


def _sections(lines: list[str]) -> dict[str, str]:
    sections: dict[str, str] = {}
    name: str | None = None
    fenced = False
    for line in lines:
        if line.startswith('```'):
            fenced = not fenced
        if line.startswith('## ') and not fenced:
            name = line[3:].strip()
            sections[name] = ''
        elif name is not None:
            sections[name] += line + '\n'
    return {k: v.strip() for k, v in sections.items()}


def parse(text: str) -> Verdict:
    if len(text.encode('utf-8')) > MAX_BYTES:
        raise ValueError(f'a verdict is at most {MAX_BYTES} bytes; this one is over (keep the output to the lines that matter)')
    lines = text.split('\n')
    stripped = [ln.strip() for ln in lines]
    if not lines or stripped[0] != '---' or '---' not in stripped[1:]:
        raise ValueError('a verdict starts with its front matter between two --- lines')
    end = 1 + stripped[1:].index('---')
    front, checks = _front(lines[1:end])
    return Verdict(front, checks, _sections(lines[end + 1:]))


def read_file(root: Path, rel: str, what: str = 'verdict file') -> tuple[Verdict | None, str | None]:
    """A verdict or record file, parsed; never through a link (the file or a folder above it under the root)."""
    path = root / rel
    if registry.link_on_path(path, root) is not None:
        return None, f'{rel} is a link: the gate never reads a verdict or a record through one'
    if not path.is_file():
        return None, f'no {what} {rel}'
    try:
        return parse(path.read_text(encoding='utf-8')), None
    except ValueError as err:
        return None, f'{rel}: {err}'


def is_product_path(path: str) -> bool:
    """Product code a break may touch: lambda/** (stream/src too), frontend/src/**, lib/**, never a test, its support
    or a fixture."""
    if not path.startswith(PRODUCT_ROOTS):
        return False
    parts = path.split('/')
    return not (TEST_SEGMENTS & set(parts[:-1]) or TEST_FILE_RE.search(parts[-1]) or 'fixtures' in parts[-1])


@dataclass
class DiffFile:
    path: str
    changed: list[str] = field(default_factory=list)   # the changed lines, without their +/-


def _header_path(line: str) -> str | None:
    """The path of a ``--- `` / ``+++ `` header: git's ``a/`` / ``b/`` prefix, or a plain ``diff -u``'s path with its
    tab and date after it; None for /dev/null."""
    path = line[4:].split('\t', 1)[0].strip()
    if path == '/dev/null' or not path:
        return None
    for prefix in ('a/', 'b/'):
        if line.startswith(('--- ' if prefix == 'a/' else '+++ ') + prefix):
            return path[len(prefix):]
    return path


@dataclass
class _Hunk:
    old: int = 0   # the lines of the old side still to come
    new: int = 0

    def open(self) -> bool:
        return self.old > 0 or self.new > 0

    def take(self, line: str, into: DiffFile) -> bool:
        """Counts one hunk line (False: not a hunk line, the hunk is over)."""
        tag = line[:1]
        if tag in ('-', '+'):
            into.changed.append(line[1:])
            self.old -= tag == '-'
            self.new -= tag == '+'
        elif tag in (' ', ''):   # context (a fence may have dropped an empty context line's space)
            self.old -= 1
            self.new -= 1
        elif tag != '\\':        # "\ No newline at end of file" counts for nothing
            self.old = self.new = 0
            return False
        return True


def diff_files(diff: str) -> list[DiffFile]:
    """The files a unified diff changes, each with its changed lines. A file starts at ``diff --git`` or at a ``--- ``
    line followed by a ``+++ `` line, read only outside a hunk (a hunk's length is counted from its ``@@`` line), so a
    plain ``diff -u`` of several files is several files and a removed line that reads ``--- x`` stays in its hunk."""
    files: list[DiffFile] = []
    current: DiffFile | None = None
    hunk = _Hunk()
    lines = diff.split('\n')
    for k, line in enumerate(lines):
        if current is not None and hunk.open() and hunk.take(line, current):
            continue
        if line.startswith('diff --git '):
            current = None
        elif line.startswith('--- ') and k + 1 < len(lines) and lines[k + 1].startswith('+++ '):
            current = DiffFile(_header_path(line) or '')
            files.append(current)
        elif line.startswith('+++ ') and current is not None:
            current.path = _header_path(line) or current.path
        elif (m := HUNK_RE.match(line)) and current is not None:
            hunk = _Hunk(int(m.group(1) or 1), int(m.group(2) or 1))
    return files


def _is_code(line: str) -> bool:
    text = line.strip()
    return bool(text) and not text.startswith(COMMENT_STARTS)


def _normal_path(path: str) -> bool:
    return not path.startswith('/') and '..' not in path.split('/') and os.path.normpath(path) == path


def _abnormal(path: str) -> str:
    return f'Break: {path} is not a normal repository path (no .., ./, // or leading /)'


def _reject_break_problems(body: str) -> list[str]:
    """A REJECT's break, when it has one, names normal repository paths too (nothing reads it, nothing may abuse it)."""
    return [_abnormal(f.path) for d in fences(body, 'diff') for f in diff_files(d) if not _normal_path(f.path)]


def _break_problems(body: str) -> list[str]:
    diffs = fences(body, 'diff')
    files = [f for d in diffs for f in diff_files(d)]
    if not files:
        return ['Break: no ```diff block (the break the evaluator applied)']
    out = []
    for f in files:
        if not _normal_path(f.path):
            out.append(_abnormal(f.path))
        elif not is_product_path(f.path):
            out.append(f'Break: {f.path} is not product code (voc-datalake/lambda, frontend/src, lib; tests, test '
                       'support and fixtures excluded)')
        elif not any(_is_code(line) for line in f.changed):
            out.append(f'Break: {f.path} changes no code line (comments only)')
    return out


def fences(body: str, lang: str | None = None) -> list[str]:
    """The non-empty fenced blocks of a section (only those of ``lang`` when given)."""
    return [m.group(2) for m in FENCE_RE.finditer(body + '\n')
            if m.group(2).strip() and (lang is None or m.group(1) == lang)]


def _normal(text: str) -> str:
    return ' '.join(text.split())


def _red_problems(body: str, name: str) -> list[str]:
    reds = fences(body)
    if not reds:
        return ['Red: no output of the test failing on the break']
    if not any(name in r for r in reds):
        return [f'Red: the output does not name the test ({name})']
    if not any(FAILURE_RE.search(r) for r in reds):
        return ['Red: the output shows no failure']
    return []


def _passing_line(run: str, name: str) -> bool:
    return any(name in line and PASS_MARK_RE.search(line) and not FAILURE_RE.search(line) for line in run.split('\n'))


def _green_ok(run: str, name: str, runner: str) -> bool:
    """1 passed and 0 skipped; for vitest, whose -t reports the file's other tests as skipped, exactly 1 passed,
    0 failed and the test's own title on a passing line."""
    if not PASSED_RE.search(run) or PASSED_MORE_RE.search(run) or BAD_COUNT_RE.search(run):
        return False
    if runner == 'vitest':
        return _passing_line(run, name)
    return not SKIPPED_RE.search(run)


def _green_problems(body: str, name: str, runner: str) -> list[str]:
    greens = fences(body)
    if len(greens) < 3:
        return ['Green: fewer than 3 passing runs']
    want = (f'exactly 1 passed, 0 failed and {name!r} on a passing line' if runner == 'vitest'
            else '1 passed and 0 skipped')
    return [f'Green: run {n} does not show {want}' for n, g in enumerate(greens, 1) if not _green_ok(g, name, runner)]


def _front_format(v: Verdict) -> list[str]:
    out = []
    if 'sha' in v.front and not registry.is_sha(v.front['sha']):
        out.append(f"sha: {v.front['sha']!r} is not a commit sha (7 to 40 hex digits)")
    if 'tree' in v.front and not registry.TREE_RE.fullmatch(v.front['tree']):
        out.append(f"tree: {v.front['tree']!r} is not a tree id (`git write-tree`, 40 hex digits)")
    return out


def evidence_problems(v: Verdict, expected_command: str, name: str, runner: str = 'pytest') -> list[str]:
    """What the verdict lacks for its outcome (an ACCEPT's full evidence, a REJECT's reasons)."""
    out = [f'front matter: missing {key}' for key in FRONT_KEYS if not v.front.get(key)]
    out += _front_format(v)
    outcome = v.front.get('verdict')
    if outcome not in OUTCOMES:
        out.append(f'verdict must be ACCEPT or REJECT, not {outcome!r}')
    out += [f'checks: missing {check}' for check in CHECKS if check not in v.checks]
    if _normal(expected_command) not in _normal(v.sections.get('Command', '')):
        out.append(f'Command: does not hold the pinned command ({expected_command})')
    if not v.sections.get('Reasons'):
        out.append('Reasons: empty')
    if outcome != 'ACCEPT':
        return out + _reject_break_problems(v.sections.get('Break', ''))
    out += [f'checks: {check} is not true (an ACCEPT needs every check)' for check in CHECKS
            if check in v.checks and not v.checks[check]]
    out += _break_problems(v.sections.get('Break', ''))
    out += _red_problems(v.sections.get('Red', ''), name)
    return out + _green_problems(v.sections.get('Green', ''), name, runner)
