"""The one library of the Python audit detectors in ``scripts/audit/`` (not a detector: it carries no marker).

Its Node twin is ``audit_common.mjs``; the two keep the same rules (test paths, globs, allowlists, report and CLI
contract), so the detectors of both languages read and report alike.

- Paths are repo-relative POSIX strings. Path globs use ``**`` for any number of directories and ``*`` / ``?``
  within one segment (:func:`glob_regex`). Finding-key globs use ``*`` for any run of characters (:func:`key_regex`).
- Allowlists live in ``scripts/audit/allowlists/<tool>.json`` as ``{"entries": [...]}``. :func:`read_allowlist` is
  the one loader: every entry needs a non-empty ``reason`` (else exit 2) plus the keys its tool's SHAPE needs
  (``key`` for the ``py_*`` / ``ts_*`` detectors, ``files`` for the clone detectors, ``rule`` + ``path`` for
  patterns). :func:`split_allowlisted` applies any shape and returns the STALE entries (they match nothing), which a
  full run reports as findings of their own, so a list cannot outlive the code it excuses.
- Key-shaped entries (:class:`AllowEntry`): ``key`` is an exact finding key, a glob, or ``kind:<kind>`` (a whole
  documented pattern); an optional ``"kind"`` narrows the entry to one kind.
- The CLI contract (:func:`add_json_flag`, :func:`print_report`): ``--help`` exits 0; ``--json`` alone prints the
  JSON report INSTEAD of the text one, ``--json PATH`` writes it there AS WELL (``run-all.sh`` passes
  ``--json .cache/audit/<name>.json``); the first text line is ``<tool>: N finding(s); <summary>``; exit 0 clean,
  1 findings, 2 the scan cannot be trusted (:class:`AuditError`: bad allowlist, unknown bundling step, vacuous scan).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CDK_DIR = REPO / 'voc-datalake'
ALLOWLIST_DIR = HERE / 'allowlists'
EXIT_CLEAN, EXIT_FINDINGS, EXIT_ERROR = 0, 1, 2

#: Never scanned: dependencies, build output, vendored layers, caches.
SKIP_DIRS = frozenset({
    'node_modules', '.venv', 'cdk.out', 'dist', 'build', 'coverage', '__pycache__', '.git', '.cache',
    '.stryker-tmp', '.mutmut-cache', 'layers', 'coverage_html',
})
#: Never production Python: the TypeScript stream Lambda and the plugin template (copied by hand, never deployed).
NON_PRODUCTION_PARTS = frozenset({'stream', '_template'})
#: Tests, specs, test support, fixtures and dev mocks (the same rule as audit_common.mjs ``TEST_PATH``).
_TEST_PATH = re.compile(
    r'(^|/)(test|tests|__tests__|__fixtures__|test-support|e2e)/|(^|/)test_[^/]*\.py$|_test\.py$|(^|/)conftest\.py$'
    r'|\.(test|spec)\.[cm]?[jt]sx?$|-fixtures\.[jt]sx?$|(^|/)mock[^/]*\.[cm]?js$'
)


class AuditError(Exception):
    """The scan cannot run or cannot be trusted: exit 2."""


# ---- paths and globs ------------------------------------------------------------------------------------------

def is_test_path(rel: str | Path) -> bool:
    """True for test modules, specs, test-support folders, fixtures and dev mocks."""
    return bool(_TEST_PATH.search(Path(rel).as_posix()))


@lru_cache(maxsize=512)
def glob_regex(glob: str) -> re.Pattern[str]:
    """Path glob: ``**`` = any directories (also none), ``*`` / ``?`` = within one segment."""
    out, i = [], 0
    while i < len(glob):
        if glob.startswith('**/', i):
            out.append('(?:.*/)?')
            i += 3
        elif glob.startswith('**', i):
            out.append('.*')
            i += 2
        else:
            out.append({'*': '[^/]*', '?': '[^/]'}.get(glob[i], re.escape(glob[i])))
            i += 1
    return re.compile(''.join(out) + r'\Z')


def matches_any(rel: str, globs: Iterable[str]) -> bool:
    return any(glob_regex(g).match(rel) for g in globs)


@lru_cache(maxsize=512)
def key_regex(pattern: str) -> re.Pattern[str]:
    """Finding-key glob: ``*`` = any run of characters (``/`` included), ``?`` = one character."""
    return re.compile(''.join({'*': '.*', '?': '.'}.get(c, re.escape(c)) for c in pattern) + r'\Z')


def iter_files(root: Path, scan_paths: Iterable[str], suffixes: tuple[str, ...], *,
               include_tests: bool, exclude: Iterable[str] = ()) -> Iterator[tuple[str, Path]]:
    """(``root``-relative path, absolute path) of every file under ``scan_paths`` ending in ``suffixes``, sorted."""
    excluded = list(exclude)
    for scan in scan_paths:
        base = root / scan
        candidates = [base] if base.is_file() else sorted(base.rglob('*')) if base.is_dir() else []
        for file in candidates:
            if not file.is_file() or not file.name.endswith(suffixes):
                continue
            rel = file.relative_to(root).as_posix()
            if SKIP_DIRS.intersection(rel.split('/')[:-1]):
                continue
            if (not include_tests and is_test_path(rel)) or matches_any(rel, excluded):
                continue
            yield rel, file


def is_production_py(relative: Path) -> bool:
    """``relative`` is relative to ``voc-datalake`` (``lambda/...`` / ``plugins/...``)."""
    return (relative.suffix == '.py' and not is_test_path(relative)
            and not NON_PRODUCTION_PARTS & set(relative.parts[:-1]))


def walk_py(root: Path, subdirs: Sequence[str] = ('lambda', 'plugins'), *, tests: bool = False) -> list[Path]:
    """``root``-relative ``.py`` files under ``root/<subdir>``: production ones, or (``tests=True``) test ones."""
    found = (Path(rel) for rel, _ in iter_files(root, subdirs, ('.py',), include_tests=True))
    return sorted(rel for rel in found if (is_test_path(rel) if tests else is_production_py(rel)))


# ---- allowlists -----------------------------------------------------------------------------------------------

def read_allowlist(file: Path, required: tuple[str, ...]) -> list[dict[str, Any]]:
    """The entries of an allowlist file (missing file = none); each needs a non-empty ``reason`` and ``required``."""
    if not file.exists():
        return []
    try:
        data = json.loads(file.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise AuditError(f'{file}: unreadable allowlist ({error})') from error
    entries = data.get('entries') if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise AuditError(f'{file}: expected {{"entries": [...]}}')
    for number, entry in enumerate(entries, 1):
        if not isinstance(entry, dict) or not isinstance(entry.get('reason'), str) or not entry['reason'].strip():
            raise AuditError(f'{file}: entry {number} has no reason')
        missing = [key for key in required if not isinstance(entry.get(key), str | list)]
        if missing:
            raise AuditError(f'{file}: entry {number} lacks {", ".join(missing)}')
    return entries


def split_allowlisted[T](items: Iterable[T], entries: Sequence[Any],
                      matches: Callable[[Any, T], bool]) -> tuple[list[T], list[T], list[Any]]:
    """(items no entry excuses, excused items, STALE entries: those that excuse nothing)."""
    kept: list[T] = []
    excused: list[T] = []
    used: set[int] = set()
    for item in items:
        hits = {i for i, entry in enumerate(entries) if matches(entry, item)}
        used |= hits
        (excused if hits else kept).append(item)
    return kept, excused, [entry for i, entry in enumerate(entries) if i not in used]


@dataclass(frozen=True)
class Finding:
    kind: str
    key: str
    detail: str = ''
    extra: dict[str, object] = field(default_factory=dict, compare=False, hash=False)

    def line(self) -> str:
        return f'{self.kind:<22} {self.key}' + (f'  -- {self.detail}' if self.detail else '')

    def as_json(self) -> dict[str, object]:
        return {'kind': self.kind, 'key': self.key, 'detail': self.detail, **self.extra}


@dataclass(frozen=True)
class AllowEntry:
    key: str             # exact finding key, a key glob, or ``kind:<kind>``
    reason: str
    kind: str | None = None   # optional: only findings of this kind

    def matches(self, finding: Finding) -> bool:
        if self.kind is not None and finding.kind != self.kind:
            return False
        return self.key == f'kind:{finding.kind}' or bool(key_regex(self.key).match(finding.key))


def load_allowlist(tool: str, directory: Path = ALLOWLIST_DIR) -> list[AllowEntry]:
    """The key-shaped allowlist of a ``py_*`` detector."""
    file = directory / f'{tool}.json'
    entries = read_allowlist(file, ('key',))
    if any(not isinstance(e['key'], str) or not isinstance(e.get('kind', ''), str) for e in entries):
        raise AuditError(f'{file}: "key" and "kind" must be strings')
    return [AllowEntry(e['key'], e['reason'], e.get('kind')) for e in entries]


def stale_finding(key: str) -> Finding:
    return Finding('stale-allowlist', key, 'allowlist entry matches no finding; delete it')


def apply_allowlist(findings: Iterable[Finding], allowed: Sequence[AllowEntry]) -> list[Finding]:
    """Findings no entry excuses, plus one ``stale-allowlist`` finding per entry that excused nothing."""
    kept, _, stale = split_allowlisted(findings, allowed, lambda entry, f: entry.matches(f))
    return sorted(kept, key=lambda f: (f.kind, f.key)) + [stale_finding(entry.key) for entry in stale]


# ---- report and CLI -------------------------------------------------------------------------------------------

def say(text: str, *, err: bool = False) -> None:
    """One line to the terminal (the repo's ruff config bans ``print`` outside voc-datalake/scripts)."""
    (sys.stderr if err else sys.stdout).write(text + '\n')


def write_json(target: str | Path | None, payload: dict[str, Any]) -> None:
    if not target:
        return
    out = Path(target)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str) + '\n', encoding='utf-8')


def add_json_flag(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('--json', nargs='?', const='-', default=None, metavar='PATH',
                        help='JSON report to stdout instead of the text report; with PATH, also write it there')


def print_report(tool: str, findings: Sequence[dict[str, Any]], lines: Iterable[str], *, as_json: str | None,
                 summary: str = '', extra: dict[str, Any] | None = None) -> int:
    """The report contract every detector shares; returns 0 (clean) or 1 (findings).

    ``as_json``: ``'-'`` prints the JSON report INSTEAD of the text one; a path writes it there AS WELL; None = text.
    The first text line is the one-line summary ``<tool>: N finding(s); <summary>``.
    """
    headline = f'{tool}: {len(findings)} finding(s){"; " + summary if summary else ""}'
    payload = {'tool': tool, 'summary': headline, 'findings': list(findings), **(extra or {})}
    if as_json == '-':
        say(json.dumps(payload, indent=1, sort_keys=True, default=str))
    else:
        write_json(as_json, payload)
        say(headline)
        for line in lines:
            say(line)
    return EXIT_FINDINGS if findings else EXIT_CLEAN


def report(tool: str, findings: Iterable[Finding], *, as_json: str | None = None, summary: str = '',
           use_allowlist: bool = True, allowlist_dir: Path = ALLOWLIST_DIR) -> int:
    """Print the key-shaped findings left after the allowlist (stale entries included)."""
    left = apply_allowlist(findings, load_allowlist(tool, allowlist_dir) if use_allowlist else [])
    return print_report(tool, [f.as_json() for f in left], (f.line() for f in left), as_json=as_json, summary=summary)


def finish(tool: str, args: argparse.Namespace, found: Iterable[Finding], summary: str) -> int:
    """A ``py_*`` detector's last step: report what is left with the flags every one of them takes."""
    return report(tool, found, as_json=args.json, use_allowlist=not args.no_allowlist, summary=summary)


#: A detector's scan: the parsed flags in; its findings and a one-line summary out (it runs its own guards).
Scan = Callable[[argparse.Namespace], tuple[Iterable[Finding], str]]


class DetectorMain(Protocol):
    """``main(argv=None) -> exit code``: what ``run_main`` and the tests call."""

    def __call__(self, argv: list[str] | None = None) -> int: ...


def detector_main(tool: str, doc: str | None, scan: Scan) -> DetectorMain:
    """The ``main(argv)`` of a ``py_*`` detector that takes only the common flags: parse, scan, report."""
    def main(argv: list[str] | None = None) -> int:
        args = parse_cli(doc, argv)
        found, summary = scan(args)
        return finish(tool, args, found, summary)
    return main


def guard(condition: bool, message: str) -> None:
    """Vacuity guard: a scan that saw implausibly little proves nothing."""
    if not condition:
        raise AuditError(f'vacuity guard: {message}')


def parse_cli(doc: str | None, argv: list[str] | None,
              extra: Callable[[argparse.ArgumentParser], object] | None = None) -> argparse.Namespace:
    """The flags every ``py_*`` detector takes (``extra`` adds a detector's own)."""
    parser = argparse.ArgumentParser(description=(doc or '').split('\n\n')[0])
    if extra:
        extra(parser)
    parser.add_argument('--cdk-dir', type=Path, default=CDK_DIR, help='voc-datalake dir to scan (e.g. an old worktree)')
    parser.add_argument('--refresh', action='store_true', help='re-synthesize even if the cache is fresh')
    add_json_flag(parser)
    parser.add_argument('--no-allowlist', action='store_true', help='report everything (e.g. on an old tree)')
    args = parser.parse_args(argv)
    args.cdk_dir = args.cdk_dir.resolve()
    return args


def run_main(main_fn: Callable[[], int]) -> None:
    """Run a detector's ``main``; an :class:`AuditError` becomes exit 2 with its message."""
    try:
        code = main_fn()
    except AuditError as error:
        say(f'error: {error}', err=True)
        code = EXIT_ERROR
    sys.exit(code)
