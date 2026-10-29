#!/usr/bin/env python3
# audit-detector: run by scripts/audit/run-all.sh
"""py_shared_constants: one module-level constant value kept in several modules that ship together.

PATTERN (hunt-python class 1, consolidated in 5.34): a writer and its reader each spell the same key prefix
(``METRIC#daily_tag#`` in the aggregator and in the metrics API), a module copies a constant it could import
from a module it ALREADY imports (``RUN_QUEUED`` in ``agents/store.py`` vs ``shared/agents_store.py``), a
validation regex is written five times. Copies drift: a change to one side silently breaks the contract.

HOW: every production module (``lambda/``, ``plugins/``) is parsed; a module-level ``NAME = <value>`` (an
UPPER_SNAKE name, ``Final`` allowed) is a constant when the value is a literal (``ast.literal_eval``) or
``re.compile`` / ``frozenset`` / ``tuple`` / ``set`` of one (flags included). Constants with the same value in
two or more modules form a group, reported when ONE copy could serve every site (py_bundles, from the
synthesized app): one site's file ships in every bundle of the others, or every site ships ``lambda/shared``.
A group whose names (leading ``_`` ignored) are all equal is always judged; a renamed group only when the
value is key-shaped (a regex or container, a string with ``#``, ``/``, ``:``, ``.`` or a space, or at least 12
characters), because single words under different names are separate status vocabularies. Trivial values
(``None``, booleans, numbers: equal limits of separate domains are a coincidence, strings under 4 characters,
empty containers) are never judged.

KINDS: ``imported-already`` (a site already imports the module that holds another copy: the strongest),
``same-name``, ``renamed``. KEY: ``<names>::<files>`` (names and files sorted, ``|`` / ``,`` separated).

WHY THE REFERENCE TOOLS MISS IT: jscpd and clones_struct compare code shapes; one assignment is far under
any size floor. ruff and pyright never compare values across modules.

FALSE POSITIVES: coincidental equal values under unrelated names; a copy kept on purpose in a module that
cannot import (no shared home: excluded automatically). Allowlist ``{"key": ..., "reason": ...}`` in
``scripts/audit/allowlists/py_shared_constants.json``.

Run: ``voc-datalake/.venv/bin/python scripts/audit/py_shared_constants.py [--json] [--refresh]``.
"""
from __future__ import annotations

import argparse
import ast
import re
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from audit_common import Finding, detector_main, guard, run_main, walk_py
from py_bundles import Bundles, load_bundles

TOOL = 'py_shared_constants'
MIN_STRING = 4
MIN_PLAIN_STRING = 12
KEY_SHAPED = re.compile(r'[#/:. ]')
WRAPPERS = frozenset({'re.compile', 'frozenset', 'tuple', 'set'})
_UPPER = re.compile(r'_?[A-Z][A-Z0-9_]*\Z')


@dataclass(frozen=True)
class Site:
    file: str        # voc-datalake-relative
    name: str
    line: int


_NOT_LITERAL = object()


def _literal(node: ast.expr) -> object:
    try:
        return ast.literal_eval(node)
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return _NOT_LITERAL


def literal_repr(node: ast.expr) -> str | None:
    """A canonical text for a literal value (or a wrapped literal), else None."""
    value = _literal(node)
    if value is not _NOT_LITERAL:
        return repr(value)
    if not (isinstance(node, ast.Call) and node.args and not node.keywords and ast.unparse(node.func) in WRAPPERS):
        return None
    inner = _literal(node.args[0])
    if inner is _NOT_LITERAL:
        return None
    func = ast.unparse(node.func)
    first = repr(inner)
    if func in ('frozenset', 'set') and isinstance(inner, tuple | list | set | frozenset):
        func, first = 'set', repr(sorted(map(repr, inner)))   # set(...) and frozenset(...) are the same value
    return f'{func}({first}{"".join("," + ast.unparse(a) for a in node.args[1:])})'


def trivial(text: str) -> bool:
    try:
        value = ast.literal_eval(text)
    except (ValueError, SyntaxError):
        return False                         # a wrapped literal (regex, set): never trivial
    if value is None or isinstance(value, bool):
        return True
    if isinstance(value, int | float):
        return True      # numbers are per-domain limits: equal ones are a coincidence, not a contract
    if isinstance(value, str | bytes):
        return len(value) < MIN_STRING
    return isinstance(value, tuple | list | dict | set | frozenset) and not value


def key_shaped(text: str) -> bool:
    try:
        value = ast.literal_eval(text)
    except (ValueError, SyntaxError):
        return True                          # re.compile / set(...)
    if isinstance(value, str):
        return bool(KEY_SHAPED.search(value)) or len(value) >= MIN_PLAIN_STRING
    return isinstance(value, tuple | list | dict | set | frozenset)


def _assignments(tree: ast.Module) -> Iterator[tuple[str, ast.expr, int]]:
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name):
                    yield target.id, stmt.value, stmt.lineno
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
            yield stmt.target.id, stmt.value, stmt.lineno


def imported_modules(tree: ast.Module) -> set[str]:
    """Absolute module names a module imports (``from x import y`` adds ``x`` and ``x.y``)."""
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            out.add(node.module)
            out.update(f'{node.module}.{alias.name}' for alias in node.names)
    return out


@dataclass
class Census:
    by_value: dict[str, list[Site]]
    imports: dict[str, set[str]]       # file -> imported module names
    constants: int
    modules: int


def census(cdk_dir: Path) -> Census:
    by_value: dict[str, list[Site]] = defaultdict(list)
    imports: dict[str, set[str]] = {}
    constants = modules = 0
    for rel in walk_py(cdk_dir):
        tree = ast.parse((cdk_dir / rel).read_text(encoding='utf-8'), filename=str(rel))
        modules += 1
        imports[rel.as_posix()] = imported_modules(tree)
        for name, value, line in _assignments(tree):
            if not _UPPER.match(name):
                continue
            constants += 1
            text = literal_repr(value)
            if text is not None and not trivial(text):
                by_value[text].append(Site(rel.as_posix(), name, line))
    return Census(by_value, imports, constants, modules)


def _kind(same_name: bool, files: list[str], census_: Census, bundles: Bundles) -> str:
    for owner in files:
        names = bundles.file_modules.get(owner, frozenset())
        if any(census_.imports.get(other, set()) & names for other in files if other != owner):
            return 'imported-already'
    return 'same-name' if same_name else 'renamed'


def _groups(text: str, sites: list[Site]) -> Iterator[list[Site]]:
    """A key-shaped value: all its sites, renamed or not. Any other value: one group per (normalized) name."""
    if key_shaped(text):
        yield sites
        return
    by_name: dict[str, list[Site]] = defaultdict(list)
    for site in sites:
        by_name[site.name.lstrip('_')].append(site)
    yield from by_name.values()


def findings(census_: Census, bundles: Bundles) -> list[Finding]:
    out: list[Finding] = []
    for text, all_sites in census_.by_value.items():
        for sites in _groups(text, all_sites):
            finding = _finding(text, sites, census_, bundles)
            if finding is not None:
                out.append(finding)
    return out


def _finding(text: str, sites: list[Site], census_: Census, bundles: Bundles) -> Finding | None:
    home = bundles.home({s.file for s in sites})
    if home is None:   # a copy that cannot import (a stdlib-only bundle) stays; the others can still share one
        sites = [s for s in sites if bundles.ships_shared(s.file)]
        home = bundles.home({s.file for s in sites})
    files = sorted({s.file for s in sites})
    if home is None or len(files) < 2:
        return None
    same_name = len({s.name.lstrip('_') for s in sites}) == 1
    names = '|'.join(sorted({s.name for s in sites}))
    where = ', '.join(f'{s.file}:{s.line} {s.name}' for s in sorted(sites, key=lambda s: (s.file, s.line)))
    return Finding(_kind(same_name, files, census_, bundles), f'{names}::{",".join(files)}',
                   f'{text[:70]} -> one home: {home}; sites: {where}')


def scan(args: argparse.Namespace) -> tuple[list[Finding], str]:
    found = census(args.cdk_dir)
    guard(found.modules >= 300, f'only {found.modules} production modules parsed')
    guard(found.constants >= 1500, f'only {found.constants} module-level constants seen')
    return findings(found, load_bundles(args.cdk_dir, refresh=args.refresh)), \
        f'{found.constants} constants in {found.modules} modules'


main = detector_main(TOOL, __doc__, scan)


if __name__ == '__main__':
    run_main(main)
