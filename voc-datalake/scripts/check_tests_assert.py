#!/usr/bin/env python3
"""Every pytest test asserts something: a bare ``assert``, ``pytest.raises``/``warns``/``fail``, a mock's
``assert_*`` method, or a local helper that does one of those (followed through the module's own functions).
A test that asserts nothing passes whatever the code does. Exit 1 listing each one."""
from __future__ import annotations

import ast
import subprocess
import sys
from collections.abc import Mapping

ASSERTING_CALLS = {'raises', 'warns', 'fail', 'deprecated_call'}
ASSERTING_PREFIXES = ('assert', 'expect')


def _call_name(call: ast.Call) -> str:
    func = call.func
    if isinstance(func, ast.Attribute):
        return func.attr
    return func.id if isinstance(func, ast.Name) else ''


def _asserts(node: ast.AST, helpers: Mapping[str, ast.AST], seen: set[str]) -> bool:
    for sub in ast.walk(node):
        if isinstance(sub, ast.Assert):
            return True
        if not isinstance(sub, ast.Call):
            continue
        name = _call_name(sub)
        if name in ASSERTING_CALLS or name.startswith(ASSERTING_PREFIXES):
            return True
        if name in helpers and name not in seen:
            seen.add(name)
            if _asserts(helpers[name], helpers, seen):
                return True
    return False


def _test_files() -> list[str]:
    listed = subprocess.run(['git', 'ls-files', '*.py'], capture_output=True, text=True, check=True).stdout.split()  # noqa: S607 — git from PATH
    return [f for f in listed if f.rsplit('/', 1)[-1].startswith('test_') or f.endswith('_test.py')]


def main() -> int:
    silent: list[str] = []
    for path in _test_files():
        with open(path, encoding='utf-8') as handle:
            tree = ast.parse(handle.read(), filename=path)
        functions = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)]
        helpers = {f.name: f for f in functions if not f.name.startswith('test_')}
        silent.extend(
            f'{path}:{f.lineno} {f.name}' for f in functions if f.name.startswith('test_') and not _asserts(f, helpers, set())
        )
    for line in silent:
        print(f'test asserts nothing: {line}')
    return 1 if silent else 0


if __name__ == '__main__':
    sys.exit(main())
