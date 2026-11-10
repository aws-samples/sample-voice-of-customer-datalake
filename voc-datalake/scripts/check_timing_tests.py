#!/usr/bin/env python3
"""Every pytest test that bounds its own running time carries ``@pytest.mark.timing``.

Why: a test that asserts ``elapsed < N`` measures the machine as much as the code. In the gate it ran beside four
other lanes and under coverage tracing, and on CI's shared 4-vCPU runner such tests went over their bounds with no
code change (the Problem Analysis capacity test, the Service Quotas store; 5.55.00 and 5.56.00). Marked tests are
run apart: ``scripts/validate.sh`` deselects them from the covered, parallel run and runs them afterwards in one
process, untraced (``conftest.py`` adds ``no_cover`` to them; docs/coverage-gate.md).

What counts as timed: the test calls ``time.perf_counter``, ``time.monotonic`` or ``time.process_time`` (directly,
or through a function defined in its own module) and asserts an ordering comparison (``<``, ``<=``, ``>``, ``>=``).
The marker may sit on the test, its class, or the module's ``pytestmark``, written out (``pytest.mark.timing``):
an alias such as ``TIMED = pytest.mark.timing`` is not followed.

Limits: a heuristic over the syntax tree. A timed test that only reaches a clock through another module, or that
compares with something other than an ``assert`` comparison, is not seen; and a test that calls a clock and also
compares sizes is flagged (mark it: running it untraced costs nothing but its share of coverage).
Exit 1 listing each unmarked test.
"""
from __future__ import annotations

import ast
import subprocess
import sys
from collections.abc import Iterable

CLOCKS = {'perf_counter', 'monotonic', 'process_time', 'perf_counter_ns', 'monotonic_ns', 'process_time_ns'}
ORDERINGS = (ast.Lt, ast.LtE, ast.Gt, ast.GtE)
MARKER = 'timing'


def _calls(node: ast.AST) -> Iterable[str]:
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            func = sub.func
            if isinstance(func, ast.Attribute):
                yield func.attr
            elif isinstance(func, ast.Name):
                yield func.id


def _reads_a_clock(node: ast.AST, clocked_helpers: set[str]) -> bool:
    return any(name in CLOCKS or name in clocked_helpers for name in _calls(node))


def _asserts_an_ordering(node: ast.AST) -> bool:
    return any(isinstance(sub, ast.Assert) and isinstance(sub.test, ast.Compare)
               and any(isinstance(op, ORDERINGS) for op in sub.test.ops) for sub in ast.walk(node))


def _is_timing_marker(expr: ast.expr) -> bool:
    """`pytest.mark.timing`, its call form `pytest.mark.timing(...)`, or a list/tuple holding one."""
    if isinstance(expr, (ast.List, ast.Tuple)):
        return any(_is_timing_marker(e) for e in expr.elts)
    if isinstance(expr, ast.Call):
        expr = expr.func
    return (isinstance(expr, ast.Attribute) and expr.attr == MARKER
            and isinstance(expr.value, ast.Attribute) and expr.value.attr == 'mark')


def _marks(decorators: list[ast.expr]) -> bool:
    return any(_is_timing_marker(d) for d in decorators)


def _module_marked(tree: ast.Module) -> bool:
    return any(isinstance(node, ast.Assign) and _is_timing_marker(node.value)
               and any(isinstance(t, ast.Name) and t.id == 'pytestmark' for t in node.targets)
               for node in tree.body)


def _clocked_helpers(tree: ast.Module) -> set[str]:
    """Module-level functions that read a clock, followed through each other until nothing new is found."""
    functions = {n.name: n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    found: set[str] = set()
    while True:
        new = {name for name, fn in functions.items() if name not in found and _reads_a_clock(fn, found)}
        if not new:
            return found
        found |= new


def unmarked_timing_tests(path: str, source: str) -> list[str]:
    tree = ast.parse(source, filename=path)
    if _module_marked(tree):
        return []
    helpers = _clocked_helpers(tree)
    found: list[str] = []

    def visit(body: list[ast.stmt], class_marked: bool) -> None:
        for node in body:
            if isinstance(node, ast.ClassDef):
                visit(node.body, class_marked or _marks(node.decorator_list))
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith('test_'):
                if class_marked or _marks(node.decorator_list):
                    continue
                if _reads_a_clock(node, helpers) and _asserts_an_ordering(node):
                    found.append(f'{path}:{node.lineno} {node.name}')

    visit(tree.body, False)
    return found


def main() -> int:
    files = subprocess.run(['git', 'ls-files', '--', 'lambda/*test_*.py', 'plugins/*test_*.py'],  # noqa: S607 — git from PATH
                           check=True, capture_output=True, text=True).stdout.split()
    problems: list[str] = []
    for path in files:
        with open(path, encoding='utf-8') as handle:
            problems += unmarked_timing_tests(path, handle.read())
    for line in problems:
        print(f'{line}: bounds its own running time; mark it @pytest.mark.timing (docs/coverage-gate.md)')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
