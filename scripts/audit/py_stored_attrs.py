#!/usr/bin/env python3
# audit-detector: run by scripts/audit/run-all.sh
"""py_stored_attrs: DynamoDB attributes a store module writes that nothing ever reads back.

PATTERN (the 5.28 dead-Python audit: ``last_run_finished_at`` on an agent, ``approved_at`` on a plan step):
a writer stores an attribute in a DynamoDB item and no reader anywhere names it: not another Python
module, the assistant stream, the SPA, the static widget or a JSON contract. Storage and write cost for
nothing, and a field a reader may wrongly assume is maintained.

WHAT COUNTS AS STORED: a key of a dict literal inside a function that calls ``put_item`` /
``update_item`` / ``transact_write_items`` (minus dicts handed to ``json.dumps``, ``put_object``,
``invoke``, ``send_message``, loggers, ``Payload=`` / ``Body=`` / ``extra=``, and returned responses); a
dict returned by a function whose result is passed as ``Item=``; a dict argument of any function that
itself writes to DynamoDB (``store.set_fields(table, item, {...})``); a ``SET`` / ``ADD`` target of an
update expression.

HOW. Writes are collected per writer module. A READ is any occurrence of the name outside the writer
(identifier token in Python / TS / TSX / JS / JSON product code, tests excluded), or, inside the
writer, any use other than being written: ``item.get('x')``, ``item['x']`` loads, ``'x' in item``, a
member of a list / tuple / set literal (projection and view field lists), a keyword argument, or a
``ProjectionExpression`` / ``ConditionExpression`` token. Logging ``extra={...}`` dicts are not writes.

WHY THE REFERENCE TOOLS MISS IT: an attribute is a string, not a symbol; vulture, knip and tsc see none.

FALSE POSITIVES: audit-only fields kept on purpose for a human reading the table (``*_by`` subject
ids), keys read by an operator query, and dict keys of a non-item dict that happens to live in a store
module. Silence with ``{"key": "<module path>::<attribute>", "reason": ...}`` in
``scripts/audit/allowlists/py_stored_attrs.json``.

Run: ``voc-datalake/.venv/bin/python scripts/audit/py_stored_attrs.py [--json]`` (no synth needed).
"""
from __future__ import annotations

import argparse
import ast
import re
from collections.abc import Iterator
from pathlib import Path

from audit_common import Finding, detector_main, guard, run_main, walk_py

TOOL = 'py_stored_attrs'
ATTR = re.compile(r'^[a-z][a-z0-9]*(_[a-z0-9]+)+$|^[a-z]{3,}$')   # snake_case item attribute names
_UPDATE_TARGET = re.compile(r'(?:SET|ADD|,)\s*#?([a-z][a-z0-9_]+)\s*(?:=|\s+:)')
_TOKEN = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')
READER_GLOBS = ('lambda/**/*.py', 'plugins/**/*.py', 'lambda/stream/src/**/*.ts', 'frontend/src/**/*.ts',
                'frontend/src/**/*.tsx', 'frontend/public/**/*.js', 'lambda/api/static/**/*.js',
                'lambda/api/static/**/*.html', 'lambda/**/*.json', 'schemas/*.json')
NON_PRODUCT = re.compile(r'(\.test\.|\.spec\.|/test/|/tests/|/__tests__/|/test_|conftest|/e2e/|/mocks?/|'
                         r'/layers/|node_modules|__pycache__|\.d\.ts$|/locales/)')
# Item key attributes every table reads through its key schema, never by name in code.
KEY_NAMES = frozenset({'pk', 'sk', 'ttl'})


DDB_WRITES = frozenset({'put_item', 'update_item', 'transact_write_items', 'batch_write_item'})
# Calls whose dict arguments are NOT item attributes (archives, payloads, model bodies, log fields).
NOT_ITEM_CALLS = frozenset({'dumps', 'put_object', 'invoke', 'send_message', 'send_message_batch', 'publish',
                            'start_execution', 'info', 'warning', 'error', 'exception', 'debug',
                            'add_metadata', 'invoke_model', 'converse', 'emit_audit_event', 'response'})
NOT_ITEM_KWARGS = frozenset({'extra', 'Payload', 'Body', 'Metadata', 'Key', 'ExpressionAttributeNames',
                             'ExpressionAttributeValues', 'ExclusiveStartKey'})


def _callee(node: ast.Call) -> str | None:
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return node.func.id if isinstance(node.func, ast.Name) else None


def _functions(tree: ast.Module) -> list[ast.FunctionDef | ast.AsyncFunctionDef]:
    return [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)]


def _writes_ddb(fn: ast.AST) -> bool:
    return any(isinstance(n, ast.Call) and _callee(n) in DDB_WRITES for n in ast.walk(fn))


def write_helpers(trees: dict[Path, ast.Module], depth: int = 2) -> set[str]:
    """Names of functions (any module) that write to DynamoDB directly or through ``depth`` levels of other
    such helpers (``update_step`` -> ``_conditional_update`` -> ``update_item``): their dict arguments
    are item fields."""
    functions = [fn for tree in trees.values() for fn in _functions(tree) if not fn.name.startswith('test')]
    helpers = {fn.name for fn in functions if _writes_ddb(fn)}
    for _ in range(depth):
        helpers |= {fn.name for fn in functions if any(
            isinstance(n, ast.Call) and _callee(n) in helpers for n in ast.walk(fn))}
    return helpers


def _excluded_dicts(scope: ast.AST) -> set[int]:
    """Dicts under ``scope`` that are payloads, responses or log fields, never stored attributes."""
    out: set[int] = set()
    for node in ast.walk(scope):
        roots: list[ast.AST] = []
        if isinstance(node, ast.Call) and _callee(node) in NOT_ITEM_CALLS:
            roots = [*node.args, *(kw.value for kw in node.keywords)]
        elif isinstance(node, ast.Call):
            roots = [kw.value for kw in node.keywords if kw.arg in NOT_ITEM_KWARGS]
        elif isinstance(node, ast.Return) and node.value is not None:
            roots = [node.value]
        out |= {id(d) for root in roots for d in ast.walk(root) if isinstance(d, ast.Dict)}
    return out


def _item_builders(tree: ast.Module) -> set[str]:
    """Functions whose result is stored: their name appears inside an ``Item=`` argument."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            for kw in node.keywords:
                if kw.arg == 'Item':
                    names |= {_callee(c) or '' for c in ast.walk(kw.value) if isinstance(c, ast.Call)}
    return names


def _dict_keys(node: ast.Dict, found: dict[str, int]) -> None:
    for key in node.keys:
        if isinstance(key, ast.Constant) and isinstance(key.value, str) and ATTR.match(key.value):
            found.setdefault(key.value, key.lineno)


def _function_writes(tree: ast.Module, found: dict[str, int]) -> None:
    """Dicts inside DynamoDB-writing functions (minus payloads / responses) and dicts item builders return."""
    builders = _item_builders(tree)
    for fn in _functions(tree):
        if _writes_ddb(fn):
            excluded = _excluded_dicts(fn)
            for node in ast.walk(fn):
                if isinstance(node, ast.Dict) and id(node) not in excluded:
                    _dict_keys(node, found)
        if fn.name in builders:
            for node in ast.walk(fn):
                if isinstance(node, ast.Return) and isinstance(node.value, ast.Dict):
                    _dict_keys(node.value, found)


def _helper_call_writes(node: ast.Call, found: dict[str, int]) -> None:
    """Every dict in a write helper's arguments, nested ones too (``update_step(t, id, Change({...}))``)."""
    for arg in [*node.args, *(kw.value for kw in node.keywords if kw.arg not in NOT_ITEM_KWARGS)]:
        for sub in ast.walk(arg):
            if isinstance(sub, ast.Dict):
                _dict_keys(sub, found)


def writes_in(tree: ast.Module, helpers: set[str]) -> dict[str, int]:
    """attribute -> first line it is written on: dicts in DynamoDB-writing functions (minus payloads and
    responses), dicts returned by item builders, dict arguments of write helpers, and update-expression
    ``SET`` / ``ADD`` targets."""
    found: dict[str, int] = {}
    _function_writes(tree, found)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _callee(node) in helpers:
            _helper_call_writes(node, found)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and re.search(r'\b(SET|ADD)\b', node.value):
            for match in _UPDATE_TARGET.finditer(node.value):
                found.setdefault(match.group(1), node.lineno)
    return {name: line for name, line in found.items() if name not in KEY_NAMES}


def _call_reads(node: ast.Call) -> Iterator[str]:
    if isinstance(node.func, ast.Attribute) and node.func.attr in ('get', 'pop', 'setdefault') and node.args:
        yield from _constants(node.args[0])
    if _callee(node) in ('Attr', 'Key') and node.args:   # boto3 condition builders
        yield from _constants(node.args[0])
    for kw in node.keywords:
        if kw.arg == 'ProjectionExpression':
            yield from (t for s in _constants(kw.value) for t in _TOKEN.findall(s))


def _read_strings(node: ast.AST) -> Iterator[str]:
    """String constants under ``node`` used as a read (not as a dict key being written)."""
    if isinstance(node, ast.Call):
        yield from _call_reads(node)
    elif isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Load):
        yield from _constants(node.slice)
    elif isinstance(node, ast.Compare) and any(isinstance(op, ast.In | ast.NotIn) for op in node.ops):
        yield from _constants(node.left)
    elif isinstance(node, ast.List | ast.Tuple | ast.Set):
        for element in node.elts:
            yield from _constants(element)
    elif isinstance(node, ast.Dict):
        for key, value in zip(node.keys, node.values, strict=True):
            is_name_map = isinstance(key, ast.Constant) and isinstance(key.value, str) and key.value.startswith('#')
            if not is_name_map:
                yield from _constants(value)


def _constants(node: ast.AST | None) -> Iterator[str]:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        yield node.value


_CONDITION = re.compile(r'attribute_(not_)?exists|begins_with\(|contains\(|\s(AND|OR)\s|<>|[<>=]\s*:\w')
_EXPRESSION_WORDS = frozenset({'SET', 'ADD', 'REMOVE', 'DELETE', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'if_not_exists',
                               'list_append', 'attribute_exists', 'attribute_not_exists', 'begins_with', 'contains',
                               'size', 'attribute_type'})


def expression_reads(text: str) -> set[str]:
    """Attribute names an expression string READS: every name of a condition / filter / projection, and
    the right-hand side of a ``SET a = b + :x`` other than the attribute being set itself."""
    if re.search(r'\b(SET|ADD|REMOVE)\b', text):
        names: set[str] = set()
        for clause in text.split(','):
            target, _, value = clause.partition('=')
            own = {t.lstrip('#') for t in _TOKEN.findall(target)}
            names |= {t for t in _TOKEN.findall(value.replace('#', ' ')) if t not in own}
        return names - _EXPRESSION_WORDS
    if _CONDITION.search(text):
        return set(_TOKEN.findall(text.replace('#', ' '))) - _EXPRESSION_WORDS
    return set()


def reads_in(tree: ast.Module) -> set[str]:
    reads = {s for node in ast.walk(tree) for s in _read_strings(node)}
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            reads |= expression_reads(node.value)
    return reads


def reader_tokens(cdk_dir: Path) -> dict[str, set[str]]:
    """token -> product files mentioning it."""
    index: dict[str, set[str]] = {}
    for pattern in READER_GLOBS:
        for path in cdk_dir.glob(pattern):
            rel = path.relative_to(cdk_dir).as_posix()
            if not path.is_file() or NON_PRODUCT.search('/' + rel):
                continue
            for token in set(_TOKEN.findall(path.read_text(encoding='utf-8', errors='ignore'))):
                index.setdefault(token, set()).add(rel)
    return index


def findings(cdk_dir: Path) -> tuple[list[Finding], int, int]:
    tokens = reader_tokens(cdk_dir)
    trees = {rel: ast.parse((cdk_dir / rel).read_text(encoding='utf-8')) for rel in walk_py(cdk_dir)}
    helpers = write_helpers(trees)
    out: list[Finding] = []
    writers = written = 0
    for rel, tree in trees.items():
        writes = writes_in(tree, helpers)
        if not writes:
            continue
        writers += 1
        own_reads = reads_in(tree)
        for name, line in sorted(writes.items()):
            written += 1
            elsewhere = tokens.get(name, set()) - {rel.as_posix()}
            if not elsewhere and name not in own_reads:
                out.append(Finding('written-never-read', f'{rel.as_posix()}::{name}',
                                   f'line {line}: stored here, read nowhere (Python, stream, SPA, widget, JSON)'))
    return out, writers, written


def scan(args: argparse.Namespace) -> tuple[list[Finding], str]:
    found, writers, written = findings(args.cdk_dir)
    guard(writers >= 30 and written >= 300, f'only {writers} writer modules / {written} written attributes')
    return found, f'{written} written attributes in {writers} writer modules'


main = detector_main(TOOL, __doc__, scan)


if __name__ == '__main__':
    run_main(main)
