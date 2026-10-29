#!/usr/bin/env python3
# audit-detector: run by scripts/audit/run-all.sh
"""py_reachability: production Python that no deployed entry point reaches (and code only tests reach).

PATTERN. A function, class, method or module constant under ``voc-datalake/lambda`` or ``plugins`` that
no Lambda can execute: not reachable from its template handler string through imports, calls, attribute
chains, route decorators or dynamic dispatch. Also whole modules no bundle ships or no entry imports.
The 5.28 dead-Python audit found eleven (``fetch_with_retry``, ``resolve_window_days``,
``cached_source_profile``, ``theme_label``, ``TERMINAL_STATUSES`` ...) plus six symbols only tests use.

HOW. ``py_assembly`` synthesizes the app (no Docker) and replays each function's bundling command, so
every Lambda's real file set and import root are known; ``py_graph`` runs a fixed-point AST
reachability per bundle from the handler; a def is alive if ANY bundle reaches it.

WHY THE REFERENCE TOOLS MISS IT. vulture matches bare names repo-wide (one ``.clear()`` anywhere keeps
every ``clear`` alive; a same-named constant in another module keeps ``TERMINAL_STATUSES`` alive) and
counts ``__all__`` entries as uses; it knows nothing of entry points. The ``__all__`` pytest gate only
asks whether another module imports a name, not whether that importer runs.

KINDS. ``dead`` (nothing reaches it, tests included), ``test-only`` (dead in production, named by a
test of its module: a seam to document or delete), ``unreached-module`` (bundled, never imported),
``unbundled-module`` (no bundle ships it).

FALSE POSITIVES and how to silence one: build-time generators (run by a lockstep test, not a Lambda),
seams kept on purpose, framework hooks called by name. Add ``{"key": "<path>::<qualname>", "reason": ...}``
to ``scripts/audit/allowlists/py_reachability.json``. A def reached only through a mechanism the graph
does not model (``getattr`` with a computed name) is also allowlisted, with that reason.

Run: ``voc-datalake/.venv/bin/python scripts/audit/py_reachability.py [--json] [--refresh]``.
Exit 0 clean, 1 findings, 2 scan error.
"""
from __future__ import annotations

import ast
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from audit_common import CDK_DIR, Finding, finish, guard, parse_cli, run_main, say, walk_py
from py_assembly import Assembly, Function, emulate_bundle, inline_source, load_assembly, python_modules
from py_graph import Graph, ParseCache, Reach, reexports, top_level_defs

TOOL = 'py_reachability'
SKIPPED_NAMES = frozenset({'__all__', '__version__', 'pytestmark'})


@dataclass
class FunctionReach:
    fn: Function
    modules: dict[str, Path]          # bundle module name -> repo-relative source file
    reach: Reach

    def source_files(self) -> set[Path]:
        return {self.modules[name] for name in self.reach.loaded if name in self.modules}


@dataclass
class Program:
    """Reachability of every analysed Python function of the app."""

    cdk_dir: Path
    functions: dict[str, FunctionReach] = field(default_factory=dict)
    skipped: list[str] = field(default_factory=list)   # CDK-provided inline handlers

    def used_bindings(self) -> set[tuple[Path, str]]:
        return {(fr.modules[mod], q) for fr in self.functions.values() for mod, q in fr.reach.bindings
                if mod in fr.modules}

    def alive(self) -> set[tuple[Path, str]]:
        return {(fr.modules[mod], q) for fr in self.functions.values() for mod, q in fr.reach.alive if mod in fr.modules}

    def loaded(self) -> set[Path]:
        return {path for fr in self.functions.values() for path in fr.source_files()}

    def bundled(self) -> set[Path]:
        return {path for fr in self.functions.values() for path in fr.modules.values()}


def _modules_of(cdk_dir: Path, fn: Function, production: list[Path]) -> dict[str, Path] | None:
    if fn.asset_source is not None:
        modules = python_modules(emulate_bundle(cdk_dir, fn))
        return {name: path.relative_to(cdk_dir) for name, path in modules.items()}
    source = inline_source(cdk_dir, fn, production)
    return {fn.handler.rsplit('.', 1)[0]: source} if source else None


def analyse(cdk_dir: Path = CDK_DIR, assembly: Assembly | None = None) -> Program:
    assembly = assembly or load_assembly(cdk_dir)
    production = walk_py(cdk_dir)
    program = Program(cdk_dir)
    cache = ParseCache()
    for fn in assembly.functions.values():
        if not fn.is_python or fn.external:
            continue
        modules = _modules_of(cdk_dir, fn, production)
        if modules is None:
            program.skipped.append(fn.fid)
            continue
        module, function = fn.handler.rsplit('.', 1)
        graph = Graph({name: cdk_dir / rel for name, rel in modules.items()}, cache)
        program.functions[fn.fid] = FunctionReach(fn, modules, graph.run([(module.replace('/', '.'), function)]))
    return program


class TestIndex:
    """Which test files name an identifier, to tell a test seam (named by its module's tests) from dead code."""

    def __init__(self, cdk_dir: Path) -> None:
        self.files: list[set[str]] = []
        self.by_word: dict[str, list[int]] = {}
        for rel in walk_py(cdk_dir, tests=True):
            words = set(re.findall(r'[A-Za-z_][A-Za-z0-9_]*', (cdk_dir / rel).read_text(encoding='utf-8')))
            for word in words:
                self.by_word.setdefault(word, []).append(len(self.files))
            self.files.append(words)

    def names_with_module(self, name: str, module_stem: str) -> bool:
        """A test file mentions both ``name`` and the module it lives in."""
        return any(module_stem in self.files[i] for i in self.by_word.get(name, ()))


def _dead_defs(program: Program, path: Path, alive: set[tuple[Path, str]]) -> Iterator[tuple[str, ast.stmt, str]]:
    tree = ast.parse((program.cdk_dir / path).read_text(encoding='utf-8'))
    for qualname, node, kind in top_level_defs(tree):
        name = qualname.rsplit('.', 1)[-1]
        if name in SKIPPED_NAMES or (name.startswith('__') and name.endswith('__')) or (path, qualname) in alive:
            continue
        if '.' in qualname and (path, qualname.split('.')[0]) not in alive:
            continue   # reported with its class
        yield qualname, node, kind


def has_code(path: Path) -> bool:
    body = ast.parse(path.read_text(encoding='utf-8')).body
    is_docstring = bool(body) and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant)
    return len(body) > (1 if is_docstring else 0)


def findings(program: Program) -> list[Finding]:
    production = walk_py(program.cdk_dir)
    alive, loaded, bundled = program.alive(), program.loaded(), program.bundled()
    used = program.used_bindings()
    tests = TestIndex(program.cdk_dir)
    out: list[Finding] = []
    for path in production:
        if not has_code(program.cdk_dir / path):
            continue   # an empty / comment-only package marker
        if path not in bundled:
            out.append(Finding('unbundled-module', path.as_posix(), 'no Lambda bundle ships this file'))
            continue
        if path not in loaded:
            out.append(Finding('unreached-module', path.as_posix(), 'bundled, but no entry point imports it'))
            continue
        tree = ast.parse((program.cdk_dir / path).read_text(encoding='utf-8'))
        for name, node in reexports(tree, path.name == '__init__.py'):
            if (path, name) not in used:
                out.append(Finding('unused-reexport', f'{path.as_posix()}::{name}',
                                   f'import on line {node.lineno} offered to other modules, none reads it'))
        for qualname, node, kind in _dead_defs(program, path, alive):
            name = qualname.rsplit('.', 1)[-1]
            test_only = tests.names_with_module(name, path.stem)
            lines = (node.end_lineno or node.lineno) - node.lineno + 1
            out.append(Finding('test-only' if test_only else 'dead', f'{path.as_posix()}::{qualname}',
                               f'{kind}, line {node.lineno}, {lines} line(s)',
                               {'line': node.lineno, 'lines': lines}))
    return out


def explain(program: Program, target: str) -> int:
    """``--why lambda/shared/avatar.py::get_avatar_cdn_url``: one reach chain per function."""
    path, _, qualname = target.partition('::')
    for fid, fr in sorted(program.functions.items()):
        for name, rel in fr.modules.items():
            key = (name, qualname or '<module>')
            if rel.as_posix() == path and (key in fr.reach.alive or (not qualname and name in fr.reach.loaded)):
                say(f'{fid}: ' + ' -> '.join(f'{m}::{q}' for m, q in fr.reach.chain(key)))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_cli(__doc__, argv, extra=lambda p: p.add_argument(
        '--why', metavar='PATH::QUALNAME', help='print how each function reaches a symbol, then exit'))
    cdk_dir = args.cdk_dir
    program = analyse(cdk_dir, load_assembly(cdk_dir, refresh=args.refresh))
    if args.why:
        return explain(program, args.why)
    alive = program.alive()
    guard(len(program.functions) >= 40, f'only {len(program.functions)} Python functions analysed')
    guard(len(program.loaded()) >= 200, f'only {len(program.loaded())} source modules reached')
    guard(len(alive) >= 2000, f'only {len(alive)} live symbols')
    summary = f'{len(program.functions)} functions, {len(program.loaded())} modules reached, {len(alive)} live symbols'
    return finish(TOOL, args, findings(program), summary)


if __name__ == '__main__':
    run_main(main)
