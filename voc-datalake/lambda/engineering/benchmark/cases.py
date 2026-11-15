"""The benchmark's cases: the ``voc-bench/1`` record, read from its directory and checked before anything runs.

A case is a directory named for its id, holding ``case.json`` and its fixture (a small repository, the record's
``fixture``: a directory beside ``case.json``)::

    {"schema": "voc-bench/1", "id": "slug-cut-bug", "kind": "bug", "title": "...", "task": "...",
     "fixture": "repo", "check": {...}}

The ``kind`` decides the check:

- ``bug`` and ``feature``: ``{"argv": [...], "cwd": "", "timeout_seconds": 60, "protected": [...]}``, a command
  run in the repository (``cwd`` is a directory of it, ``''`` its root) after the candidate's patch, which must
  exit 0. ``argv[0]`` is one of ``TOOLS``: the runner gives it by absolute path, with nothing but those tools'
  directories on its PATH (a Python check runs isolated, ``-I -P``: the repository is not on ``sys.path`` before
  the check's own code puts it there). ``protected`` names the files and directories a patch may not touch (the
  check's own tests, the packages a case does not touch); the optional ``allows`` the only ones it may change
  (anything else is refused, so a patch cannot add a test that runs first or a module that shadows the check's).
  Both compare case aside.
- ``review``: ``{"findings": [{"file": ..., "lines": [first, last], "rule": ...}], "max_false_positives": n}``:
  every finding the candidate must report (a file of the fixture, a line in that range, the rule id), and how many
  findings matching none of them it may report besides.

Everything is bounded (the record's bytes, every text, the fixture's files and bytes); every path is a plain
relative one (no ``..``, no absolute path, no ``.git``) that stays inside the fixture; and nothing in a case is a
link, so a case cannot point the runner at a file outside it.
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from engineering.runtime.checkout import check_sparse_path
from engineering.runtime.interface import RuntimeRefused
from engineering.skills.model import CASE_ID, MAX_BENCHMARK_CASES

CASE_SCHEMA: Final = 'voc-bench/1'
CASE_FILE: Final = 'case.json'
KINDS: Final = frozenset({'bug', 'review', 'feature'})
#: What a check runs: the runner resolves each to an absolute path and puts only their directories on PATH.
TOOLS: Final = ('python3', 'node')
RECORD_FIELDS: Final = frozenset({'schema', 'id', 'kind', 'title', 'task', 'fixture', 'check'})
COMMAND_FIELDS: Final = frozenset({'argv', 'cwd', 'timeout_seconds', 'protected'})
OPTIONAL_COMMAND_FIELDS: Final = frozenset({'allows'})
REVIEW_FIELDS: Final = frozenset({'findings', 'max_false_positives'})
FINDING_FIELDS: Final = frozenset({'file', 'lines', 'rule'})
MAX_CASE_BYTES: Final = 64 * 1024
MAX_TITLE: Final = 200
MAX_TASK: Final = 8_000
MAX_ARGV: Final = 32
MAX_ARG: Final = 512
MAX_TIMEOUT_SECONDS: Final = 600
MAX_PROTECTED: Final = 50
MAX_FINDINGS: Final = 50
MAX_FALSE_POSITIVES: Final = 20
MAX_RULE: Final = 40
#: A fixture is small: its files, its bytes in all, and one file's.
MAX_FIXTURE_FILES: Final = 400
MAX_FIXTURE_BYTES: Final = 2 * 1024 * 1024
MAX_FILE_BYTES: Final = 256 * 1024
GIT_NAME: Final = '.git'


class BenchmarkError(ValueError):
    """A case, a suite, an attempt or a scorecard the benchmark refuses."""


@dataclass(frozen=True)
class CommandCheck:
    """A bug's or a feature's check: ``argv`` must exit 0 in ``cwd`` once the patch is applied."""

    argv: tuple[str, ...]
    cwd: str
    timeout_seconds: int
    protected: tuple[str, ...]
    #: The paths a patch may change (each a file or a directory); empty: any path not protected.
    allows: tuple[str, ...] = ()

    def protects(self, path: str) -> bool:
        """``path`` (a repository path) is one of ``protected`` or inside one, case aside."""
        return _within(path, self.protected)

    def permits(self, path: str) -> bool:
        """A patch may change ``path``: it is not protected, and inside one of ``allows`` when the case names any."""
        return not self.protects(path) and (not self.allows or _within(path, self.allows))


def _within(path: str, roots: tuple[str, ...]) -> bool:
    """``path`` is one of ``roots`` or inside one, compared case aside (a case-insensitive file system's view)."""
    folded = path.casefold()
    return any(folded == root.casefold() or folded.startswith(f'{root.casefold()}/') for root in roots)


@dataclass(frozen=True)
class ExpectedFinding:
    """A finding a review must report: in ``file``, on a line from ``first_line`` to ``last_line``, as ``rule``."""

    file: str
    first_line: int
    last_line: int
    rule: str

    def matches(self, file: str, line: int, rule: str) -> bool:
        return file == self.file and self.first_line <= line <= self.last_line and rule == self.rule

    @property
    def label(self) -> str:
        return f'{self.rule} in {self.file}:{self.first_line}-{self.last_line}'


@dataclass(frozen=True)
class ReviewCheck:
    """A review's check: every one of ``findings`` reported, and at most ``max_false_positives`` others."""

    findings: tuple[ExpectedFinding, ...]
    max_false_positives: int


@dataclass(frozen=True)
class Case:
    id: str
    kind: str
    title: str
    task: str
    #: The case's directory, and its fixture's (an absolute path inside it).
    directory: Path
    fixture: Path
    check: CommandCheck | ReviewCheck


def plain_path(path: object, what: str) -> str:
    """``path`` when it is a plain relative path (no ``..``, not absolute, no ``.git``, no glob), else refused."""
    if not isinstance(path, str) or not path:
        raise BenchmarkError(f'{what} is a relative path')
    try:
        plain = check_sparse_path(path)
    except RuntimeRefused as exc:
        raise BenchmarkError(f'{what} {path!r} is not a plain relative path inside the fixture') from exc
    parts = plain.split('/')
    if any(part in {'', '.'} for part in parts):
        raise BenchmarkError(f'{what} {path!r} is not a plain relative path inside the fixture')
    if any(part.casefold() == GIT_NAME for part in parts):
        raise BenchmarkError(f'{what} {path!r} names a .git directory')
    return plain


def _no_link(base: Path, relative: str, what: str) -> Path:
    """``base / relative``, refused when it or any directory on the way is a link, or it is not there."""
    target = base
    for part in relative.split('/'):
        target = target / part
        if target.is_symlink():
            raise BenchmarkError(f'{what} {relative!r} goes through a link')
    if not target.exists():
        raise BenchmarkError(f'{what} {relative!r} is not in the case')
    return target


def walk_fixture(fixture: Path) -> None:
    """Refuse a fixture holding a link, a ``.git`` entry or anything but files and directories, or over its bounds
    (the runner walks the repository again once a patch is applied)."""
    files = size = 0
    for directory, names, file_names in os.walk(fixture):
        for name in (*names, *file_names):
            entry = Path(directory) / name
            relative = entry.relative_to(fixture).as_posix()
            if entry.is_symlink():
                raise BenchmarkError(f'the fixture holds a link: {relative}')
            if name.casefold() == GIT_NAME:
                raise BenchmarkError(f'the fixture holds a .git entry: {relative}')
            if not (entry.is_dir() or entry.is_file()):
                raise BenchmarkError(f'the fixture holds something that is not a file: {relative}')
        for name in file_names:
            files += 1
            one = (Path(directory) / name).stat().st_size
            if one > MAX_FILE_BYTES:
                raise BenchmarkError(f'a fixture file is at most {MAX_FILE_BYTES} bytes')
            size += one
    if files > MAX_FIXTURE_FILES or size > MAX_FIXTURE_BYTES:
        raise BenchmarkError(f'a fixture holds at most {MAX_FIXTURE_FILES} files and {MAX_FIXTURE_BYTES} bytes')


def _title_and_task(record: Mapping[str, Any]) -> tuple[str, str]:
    """The record's title and task, each text of at most its bound (no NUL)."""
    texts: list[str] = []
    for name, limit in (('title', MAX_TITLE), ('task', MAX_TASK)):
        value = record[name]
        if isinstance(value, str) and value.strip() and len(value) <= limit and '\x00' not in value:
            texts.append(value)
        else:
            raise BenchmarkError(f"a case's {name} is text of 1-{limit} characters")
    return texts[0], texts[1]


def _whole(value: object, low: int, high: int, what: str) -> int:
    """``value`` when it is an int (never a bool) from ``low`` to ``high``."""
    if type(value) is int and low <= value <= high:
        return value
    raise BenchmarkError(f'{what} is a whole number from {low} to {high}')


def _fields(data: object, fields: frozenset[str], what: str,
            optional: frozenset[str] = frozenset()) -> Mapping[str, Any]:
    if not isinstance(data, Mapping):
        raise BenchmarkError(f'{what} is an object')
    unknown, missing = sorted(set(data) - fields - optional), sorted(fields - set(data))
    if unknown or missing:
        raise BenchmarkError(f'{what} has exactly its fields (unknown: {unknown}, missing: {missing})')
    return data


def _strings(value: object, limit: int, what: str) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > limit or not all(isinstance(item, str) for item in value):
        raise BenchmarkError(f'{what} is a list of at most {limit} texts')
    return tuple(value)


def _command_check(data: object, fixture: Path) -> CommandCheck:
    check = _fields(data, COMMAND_FIELDS, "a bug's or a feature's check", OPTIONAL_COMMAND_FIELDS)
    argv = _strings(check['argv'], MAX_ARGV, "the check's argv")
    if not argv or argv[0] not in TOOLS:
        raise BenchmarkError(f"the check's argv starts with one of {', '.join(TOOLS)}")
    if any(not arg or len(arg) > MAX_ARG or '\x00' in arg for arg in argv):
        raise BenchmarkError(f"each of the check's arguments is 1-{MAX_ARG} characters")
    cwd = check['cwd']
    if cwd != '' and not _no_link(fixture, plain_path(cwd, "the check's cwd"), "the check's cwd").is_dir():
        raise BenchmarkError(f"the check's cwd {cwd!r} is a directory of the fixture")
    protected = tuple(plain_path(path, 'a protected path')
                      for path in _strings(check['protected'], MAX_PROTECTED, 'protected'))
    for path in protected:
        _no_link(fixture, path, 'a protected path')
    # A path a patch may change need not exist yet (a new file), but it is plain and protected by nothing.
    allows = tuple(plain_path(path, 'an allowed path')
                   for path in _strings(check.get('allows', []), MAX_PROTECTED, 'allows'))
    command = CommandCheck(argv=argv, cwd=cwd, protected=protected, allows=allows,
                           timeout_seconds=_whole(check['timeout_seconds'], 1, MAX_TIMEOUT_SECONDS,
                                                  "the check's timeout"))
    clash = next((path for path in allows if command.protects(path)), None)
    if clash is not None:
        raise BenchmarkError(f'{clash!r} is both allowed and protected')
    return command


def _expected(data: object, fixture: Path) -> ExpectedFinding:
    finding = _fields(data, FINDING_FIELDS, 'an expected finding')
    file = plain_path(finding['file'], "a finding's file")
    target = _no_link(fixture, file, "a finding's file")
    if not target.is_file():
        raise BenchmarkError(f"a finding's file {file!r} is a file of the fixture")
    lines = finding['lines']
    if not isinstance(lines, list) or len(lines) != 2:
        raise BenchmarkError("a finding's lines are [first, last]")
    count = len(target.read_bytes().splitlines())
    first = _whole(lines[0], 1, count, f"a finding's first line in {file}")
    last = _whole(lines[1], first, count, f"a finding's last line in {file}")
    rule = finding['rule']
    if not isinstance(rule, str) or not CASE_ID.match(rule) or len(rule) > MAX_RULE:
        raise BenchmarkError(f"a finding's rule is a short id: lower case letters, digits and hyphens, at most "
                             f'{MAX_RULE}')
    return ExpectedFinding(file, first, last, rule)


def _review_check(data: object, fixture: Path) -> ReviewCheck:
    check = _fields(data, REVIEW_FIELDS, "a review's check")
    findings = check['findings']
    if not isinstance(findings, list) or not 0 < len(findings) <= MAX_FINDINGS:
        raise BenchmarkError(f'a review expects 1-{MAX_FINDINGS} findings')
    return ReviewCheck(findings=tuple(_expected(finding, fixture) for finding in findings),
                       max_false_positives=_whole(check['max_false_positives'], 0, MAX_FALSE_POSITIVES,
                                                  'max_false_positives'))


def _record(directory: Path) -> Mapping[str, Any]:
    file = directory / CASE_FILE
    if directory.is_symlink() or file.is_symlink() or not file.is_file():
        raise BenchmarkError(f'a case is a directory with its {CASE_FILE}, neither of them a link: {directory.name}')
    if file.stat().st_size > MAX_CASE_BYTES:
        raise BenchmarkError(f'{CASE_FILE} is at most {MAX_CASE_BYTES} bytes')
    try:
        data = json.loads(file.read_text(encoding='utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BenchmarkError(f'{CASE_FILE} is not readable JSON: {exc}') from exc
    return _fields(data, RECORD_FIELDS, f'a {CASE_SCHEMA} record')


def load_case(directory: Path) -> Case:
    """The case in ``directory``, every field checked and its fixture walked."""
    record = _record(directory)
    if record['schema'] != CASE_SCHEMA:
        raise BenchmarkError(f'not a {CASE_SCHEMA} record')
    case_id, kind = record['id'], record['kind']
    if not isinstance(case_id, str) or not CASE_ID.match(case_id) or case_id != directory.name:
        raise BenchmarkError("a case's id is lower case letters, digits and hyphens, and its directory's name")
    if kind not in KINDS:
        raise BenchmarkError(f"a case's kind is one of {', '.join(sorted(KINDS))}")
    fixture = _no_link(directory, plain_path(record['fixture'], 'the fixture'), 'the fixture')
    if not fixture.is_dir():
        raise BenchmarkError('the fixture is a directory of the case')
    walk_fixture(fixture)
    check = _review_check(record['check'], fixture) if kind == 'review' else _command_check(record['check'], fixture)
    title, task = _title_and_task(record)
    return Case(id=case_id, kind=kind, title=title, task=task, directory=directory.resolve(),
                fixture=fixture.resolve(), check=check)


def load_suite(root: Path) -> tuple[Case, ...]:
    """Every case under ``root`` (each directory of it is one), by id; at most ``MAX_BENCHMARK_CASES``."""
    directories = sorted(entry for entry in root.iterdir() if entry.is_dir() or entry.is_symlink())
    if not 0 < len(directories) <= MAX_BENCHMARK_CASES:
        raise BenchmarkError(f'a suite holds 1-{MAX_BENCHMARK_CASES} cases')
    return tuple(load_case(directory) for directory in directories)
