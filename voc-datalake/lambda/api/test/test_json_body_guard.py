"""No Lambda code reads Powertools' `json_body` itself; `shared/request_body.py` does.

A direct `app.current_event.json_body` read is how a malformed REQUEST became a
500/502 on every API write route (e2e security probes, 2026-10-06): unparseable
JSON raises `JSONDecodeError` at the read, a JSON array or string dies on the
`.get` after it, and `or {}` quietly accepts `[]`/`false`/`0`/`""` as no body.
`json_object_body(app)` answers all of those with a 400 (`json_body_value(app)`
for the few routes that keep their own non-object wording), so this scan holds
every handler under `lambda/` to it. Tests and the helper itself are exempt.
"""
from __future__ import annotations

import ast
from pathlib import Path

LAMBDA_DIR = Path(__file__).resolve().parents[2]
# The one module allowed to read the attribute: the helper every handler uses.
_ALLOWED = frozenset({Path('shared/request_body.py')})
# Never scanned: test code, vendored/bundled dependencies, and the TypeScript stream Lambda.
_SKIPPED_DIRS = frozenset({'test', 'tests', 'layers', 'node_modules', 'stream', '__pycache__', '.venv'})


def _is_test_module(path: Path) -> bool:
    return path.name == 'conftest.py' or path.name.startswith('test_') or path.stem.endswith('_test')


def _scanned_modules(root: Path) -> list[Path]:
    return sorted(
        path for path in root.rglob('*.py')
        if not _SKIPPED_DIRS.intersection(path.relative_to(root).parts[:-1])
        and not _is_test_module(path)
        and path.relative_to(root) not in _ALLOWED
    )


def _reads_json_body(node: ast.AST) -> bool:
    """An `x.json_body` attribute read, or `getattr(x, 'json_body')`."""
    if isinstance(node, ast.Attribute):
        return node.attr == 'json_body'
    # `getattr(event, 'json_body')` is the same read spelled to dodge the attribute check.
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == 'getattr'
        and len(node.args) >= 2
        and isinstance(node.args[1], ast.Constant)
        and node.args[1].value == 'json_body'
    )


def direct_json_body_reads(root: Path) -> list[str]:
    """`<path>:<line>` for every direct `json_body` read outside the helper and tests."""
    return [
        f'{path.relative_to(root).as_posix()}:{line}'
        for path in _scanned_modules(root)
        # ast.walk is breadth-first, so sort to report reads in source order.
        for line in sorted(
            node.lineno for node in ast.walk(ast.parse(path.read_text(encoding='utf-8')))
            if isinstance(node, (ast.Attribute, ast.Call)) and _reads_json_body(node)
        )
    ]


def test_no_lambda_module_reads_json_body_directly():
    assert direct_json_body_reads(LAMBDA_DIR) == [], (
        'read the request body through shared.request_body.json_object_body(app) '
        '(or json_body_value(app) when the route keeps its own non-object message)'
    )


def test_the_scan_covers_the_api_handlers():
    """Control: the scan is not vacuous — the real handlers are in it."""
    scanned = {path.relative_to(LAMBDA_DIR).as_posix() for path in _scanned_modules(LAMBDA_DIR)}
    assert {'api/projects_handler.py', 'api/settings_handler.py', 'api/feedback_form_handler.py'} <= scanned
    assert 'shared/request_body.py' not in scanned


def test_the_scan_reports_a_direct_read_and_ignores_tests_and_the_helper(tmp_path):
    (tmp_path / 'api').mkdir()
    (tmp_path / 'api' / 'x_handler.py').write_text(
        '# a comment naming json_body is fine\n'
        'body = app.current_event.json_body or {}\n'
        "other = getattr(app.current_event, 'json_body')\n",
        encoding='utf-8',
    )
    (tmp_path / 'api' / 'test').mkdir()
    (tmp_path / 'api' / 'test' / 'test_x.py').write_text('app.current_event.json_body\n', encoding='utf-8')
    (tmp_path / 'shared').mkdir()
    (tmp_path / 'shared' / 'request_body.py').write_text('app.current_event.json_body\n', encoding='utf-8')

    assert direct_json_body_reads(tmp_path) == ['api/x_handler.py:2', 'api/x_handler.py:3']
