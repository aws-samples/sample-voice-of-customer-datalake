# audit-detector: run by scripts/audit/run-all.sh
"""ws_raw_access: raw table access and raw S3 changes outside the workspace-scoped repository layer (a ratchet).

PATTERN (docs/multi-workspace.md, Request flow step 4): with workspaces, all data access goes through
``lambda/shared/ws_repository.py`` (``ws_table``, ``ws_key``, ``ws_s3_key``), which refuses a key outside the
caller's workspace before any AWS call. A table handle built any other way, or an S3 write, copy or delete with a
hand-built key, can reach another workspace's rows and objects. Phase 1 adds the layer; the data path moves onto it
in phases 2 and 3, so today every data route still uses raw access.

RATCHET. ``scripts/audit/allowlists/ws_raw_access.json`` pins the raw uses of today, file by file:
``{"entries": [{"group", "reason", "files": {"<path>": <count>}}]}``, one entry per group of files that move
together (the phase that moves them, or why they stay: the control plane, a deploy-time custom resource). Kinds,
key = the file (relative to ``voc-datalake/``):

- ``raw-access``: a file with raw uses that no entry lists (a new route, a new module: use the layer).
- ``count-grew``: a listed file with more raw uses than its entry.
- ``count-dropped``: a listed file with fewer (moved onto the layer, or deleted): lower its entry to the new count,
  or remove it at 0, so the list only ever shrinks.
A file listed twice, a count that is not a positive integer or an entry without a reason is exit 2.

WHAT COUNTS (one use per occurrence). Python (production ``lambda/`` and ``plugins/``, by AST):

- ``table``: a ``Table(...)`` call on any receiver (``resource.Table(name)``);
- ``dynamodb-client``: ``.client('dynamodb')`` / ``.resource('dynamodb')`` on any receiver (``boto3``, an alias
  such as ``import boto3 as b``, ``boto3.session.Session(...)``), and ``client`` / ``resource`` imported from
  ``boto3`` and called with ``'dynamodb'``; ``dynamodb-client`` / ``s3-client``: a botocore session's
  ``create_client('dynamodb')`` / ``create_client('s3')``;
- ``dynamodb-resource``: a call of ``shared/aws.py`` ``get_dynamodb_resource`` (by the name it was imported under,
  or as an attribute);
- ``meta-client``: any ``.meta.client`` (the low-level client behind a resource or a table);
- ``table-getter``: any reference to a table getter of ``lambda/shared/tables.py`` (a function there that builds a
  ``Table``, directly or through another getter): a call, or the getter bound to a name or passed on, by the name or
  alias it was imported under (``from shared.tables import …``), or through the module (``from shared import tables
  as t``, ``import shared.tables as t``, ``import shared.tables``: ``t.get_x``, ``shared.tables.get_x``);
- ``s3-change``: ``put_object``, ``upload_file``, ``upload_fileobj``, ``copy_object``, ``copy_from``,
  ``create_multipart_upload``, ``generate_presigned_post``, ``delete_object``, ``delete_objects``,
  ``put_object_tagging``, ``.copy(…)`` with a ``CopySource`` keyword or two or more arguments (``dict.copy()``,
  ``copy.copy(x)`` and ``shutil.copy(a, b)``, by any alias of those modules, are not), ``generate_presigned_url`` for
  ``put_object``, ``delete_object``, ``copy_object`` or ``upload_part``, ``put``/``delete``/``copy_from`` on
  ``….Object(…)`` / ``….Bucket(…)`` or on a name assigned one (``obj = s3.Object(…)``), and ``delete()`` on a
  resource collection (``bucket.objects.filter(…).delete()``, ``….object_versions….delete()``,
  ``….multipart_uploads….delete()``). The upload and put methods above count on any receiver, so
  ``Object(…).upload_file`` and ``Bucket(…).put_object`` are counted too;
- ``layer-private``: any use of the layer's ``_unscoped_table`` attribute outside the layer, the string
  ``'_unscoped_table'``, and, on a name assigned ``ws_table(…)`` / ``WorkspaceTable(…)``, any ``_`` attribute
  (``_prefix``, ``_schema``, ``__dict__``) or a ``vars``, ``getattr``, ``setattr``, ``__setattr__`` or
  ``__delattr__`` call that takes it.

TypeScript (the stream and plan-step Lambdas, ``lambda/stream/src``, by text, with ``/* */`` blocks and ``//``
comments removed, matched on the whole text so a use may span lines). The names a file takes from ``@aws-sdk/*``
(``import { A, B as C }``, ``import * as ns``, a default import alone or before named ones, ``const { A: C } =
require(…)``, ``const ns = require(…)``; a default import and a required module count as namespaces) are followed
by their local names, and ``new`` also matches a parenthesised name (``new (P)(``):

- ``dynamodb-command``: ``new <Get|Put|Update|Delete|Query|Scan|BatchGet|BatchWrite|TransactGet|TransactWrite>
  [Item]Command(``, and ``new <ExecuteStatement|BatchExecuteStatement|ExecuteTransaction>Command(`` (PartiQL);
- ``dynamodb-client``: ``new DynamoDBClient(``, ``new DynamoDB(``, ``DynamoDBDocumentClient.from(``,
  ``DynamoDBDocument.from(``;
- ``s3-client``: ``new S3Client(``, ``new S3(``;
- ``s3-change``: ``new <PutObject|CopyObject|DeleteObject|DeleteObjects|PutObjectTagging|CreateMultipartUpload>
  Command(``, ``new Upload(`` and ``createPresignedPost(``.

WHAT IT MISSES. A handle's use away from where it was built: a function handed a table (``def save(table, …)``) is
counted where the handle was made, and a layer handle's private state is watched only on a name assigned in the
same module (a handle passed in, held on ``self`` or in a container is not). ``getattr`` and other dynamic calls with
a computed name, a service name that is not a literal (``boto3.client(name)``), a getter reached through another
module's re-export, an ``Object`` or ``Bucket`` reached other than by a call or a plain name, a collection held in
a name before its ``delete()`` (``objs = bucket.objects; objs.delete()``), the objects a collection yields
(``for o in bucket.objects.all(): o.delete()``), ``ObjectSummary`` / ``ObjectVersion`` / ``MultipartUpload``
methods reached that way, and a string that looks like a comment marker inside a TypeScript string literal. A TypeScript SDK name that reaches a file other than
by an ``@aws-sdk`` import or require (a re-export from a local module, a dynamic ``import()``). S3 reads (a read of
another workspace's object needs its key, which ``ws_s3_key`` builds), and SQS, Step Functions or Lambda payloads
(phase 2 carries the workspace in them).

The layer itself (``lambda/shared/ws_repository.py``) is not scanned; tests, the plugin template and the dev mocks
are not production code.

Run: ``voc-datalake/.venv/bin/python scripts/audit/ws_raw_access.py [--json] [--counts]`` (no synth needed).
"""
from __future__ import annotations

import argparse
import ast
import json
import re
from collections import Counter
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path

from audit_common import (
    ALLOWLIST_DIR,
    AuditError,
    Finding,
    guard,
    iter_files,
    parse_cli,
    print_report,
    read_allowlist,
    run_main,
    walk_py,
)

TOOL = 'ws_raw_access'
#: The repository layer: the one module allowed to build table handles and object keys for workspace data.
LAYER = 'lambda/shared/ws_repository.py'
#: The layer's private handle: any use of it elsewhere is raw access.
LAYER_PRIVATE = '_unscoped_table'
#: The calls that make a layer handle: a name bound to one is a handle whose private state is off limits.
LAYER_HANDLE_FACTORIES = frozenset({'ws_table', 'WorkspaceTable'})
TABLES_MODULE = 'lambda/shared/tables.py'
TS_ROOT = 'lambda/stream/src'
S3_CHANGES = frozenset({'put_object', 'upload_file', 'upload_fileobj', 'copy_object', 'copy_from',
                        'create_multipart_upload', 'generate_presigned_post', 'delete_object', 'delete_objects',
                        'put_object_tagging'})
PRESIGNED_CHANGES = frozenset({'put_object', 'delete_object', 'copy_object', 'upload_part'})
OBJECT_CHANGES = frozenset({'put', 'delete', 'copy_from'})
#: S3 resources whose change methods are counted on a call or a name assigned one (``s3.Object(…)``,
#: ``s3.Bucket(…)``), and the resource collections whose ``delete()`` is a batch delete.
S3_RESOURCES = frozenset({'Object', 'Bucket'})
S3_COLLECTIONS = frozenset({'objects', 'object_versions', 'multipart_uploads'})
#: Modules whose ``copy`` is not S3's (``shutil.copy(a, b)``, ``copy.copy(x)``).
NOT_S3_COPY_MODULES = frozenset({'shutil', 'copy'})
#: The SDK names counted in TypeScript, by how a use is written: ``new X(``, ``X.from(`` or ``X(``.
_TS_DYNAMO_COMMANDS = frozenset(
    {f'{verb}{item}Command' for verb in ('Get', 'Put', 'Update', 'Delete', 'Query', 'Scan', 'BatchGet', 'BatchWrite',
                                          'TransactGet', 'TransactWrite') for item in ('', 'Item')}
    | {'ExecuteStatementCommand', 'BatchExecuteStatementCommand', 'ExecuteTransactionCommand'})
_TS_S3_CHANGES = frozenset({'PutObjectCommand', 'CopyObjectCommand', 'DeleteObjectCommand', 'DeleteObjectsCommand',
                            'PutObjectTaggingCommand', 'CreateMultipartUploadCommand', 'Upload'})
TS_NEW: dict[str, str] = {**dict.fromkeys(_TS_DYNAMO_COMMANDS, 'dynamodb-command'),
                          **dict.fromkeys(_TS_S3_CHANGES, 's3-change'),
                          'DynamoDBClient': 'dynamodb-client', 'DynamoDB': 'dynamodb-client',
                          'S3Client': 's3-client', 'S3': 's3-client'}
TS_FROM = {'DynamoDBDocumentClient': 'dynamodb-client', 'DynamoDBDocument': 'dynamodb-client'}
TS_CALL = {'createPresignedPost': 's3-change'}
_SDK = r"""['"]@aws-sdk/[\w-]+['"]"""
_TS_NAMED_IMPORT = re.compile(rf'import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{{([^}}]*)\}}\s*from\s*{_SDK}')
#: ``import * as ns``, a default import alone (``import ns from``) or before named ones (``import ns, { A } from``):
#: each is treated as a namespace (``ns.PutCommand``).
_TS_NAMESPACE_IMPORT = re.compile(
    rf'import\s+(?:type\s+)?(?:\*\s+as\s+([\w$]+)|([\w$]+)(?:\s*,\s*\{{[^}}]*\}})?)\s+from\s*{_SDK}')
_TS_NAMED_REQUIRE = re.compile(rf'\{{([^}}]*)\}}\s*=\s*require\(\s*{_SDK}\s*\)')
_TS_NAMESPACE_REQUIRE = re.compile(rf'(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*{_SDK}\s*\)')
_TS_BLOCK_COMMENT = re.compile(r'/\*.*?\*/', re.DOTALL)
_TS_LINE_COMMENT = re.compile(r'(?:^|(?<=\s))//.*$')


@dataclass(frozen=True)
class Use:
    """One raw access: where and what kind."""

    line: int
    kind: str


# ---- Python ---------------------------------------------------------------------------------------------------

def _dotted(node: ast.AST) -> str | None:
    """``a.b.c`` for a Name / Attribute chain, else None."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value)
        return None if base is None else f'{base}.{node.attr}'
    return None


def _called_name(node: ast.Call) -> str | None:
    if isinstance(node.func, ast.Name):
        return node.func.id
    return node.func.attr if isinstance(node.func, ast.Attribute) else None


def _argument(node: ast.Call, keyword: str) -> object:
    """The first positional argument, else the keyword ``keyword``: its constant value, or None."""
    value = node.args[0] if node.args else next((k.value for k in node.keywords if k.arg == keyword), None)
    return value.value if isinstance(value, ast.Constant) else None


def table_getters(cdk_dir: Path) -> frozenset[str]:
    """The functions of shared/tables.py that build a ``Table``, directly or through another of them."""
    source = cdk_dir / TABLES_MODULE
    if not source.is_file():
        return frozenset()
    functions = {node.name: node for node in ast.parse(source.read_text(encoding='utf-8')).body
                 if isinstance(node, ast.FunctionDef)}
    calls = {name: {_called_name(call) for call in ast.walk(fn) if isinstance(call, ast.Call)}
             for name, fn in functions.items()}
    getters = {name for name, called in calls.items() if 'Table' in called}
    changed = True
    while changed:
        changed = False
        for name, called in calls.items():
            if name not in getters and called & getters:
                getters.add(name)
                changed = True
    return frozenset(getters)


@dataclass
class _Bindings:
    """What a module's imports bind: getters, the tables module, the resource getter, boto3's factories."""

    getters: set[str] = field(default_factory=set)
    tables_modules: set[str] = field(default_factory=set)
    resource_getters: set[str] = field(default_factory=set)
    factories: set[str] = field(default_factory=set)
    not_s3_modules: set[str] = field(default_factory=set)
    handles: set[str] = field(default_factory=set)   # names bound to ws_table(...) / WorkspaceTable(...)
    objects: set[str] = field(default_factory=set)   # names bound to an S3 resource's .Object(...)


def _bind_assignment(node: ast.AST, bound: _Bindings) -> None:
    """``x = ws_table(…)`` / ``x = s3.Object(…)``: remember ``x``."""
    if not (isinstance(node, ast.Assign | ast.AnnAssign) and isinstance(node.value, ast.Call)):
        return
    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
    names = {target.id for target in targets if isinstance(target, ast.Name)}
    called = _called_name(node.value)
    if called in LAYER_HANDLE_FACTORIES:
        bound.handles |= names
    elif called in S3_RESOURCES and isinstance(node.value.func, ast.Attribute):
        bound.objects |= names


def _bindings(tree: ast.Module, getters: frozenset[str]) -> _Bindings:
    bound = _Bindings(not_s3_modules=set(NOT_S3_COPY_MODULES))
    for node in ast.walk(tree):
        _bind_assignment(node, bound)
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                local = alias.asname or alias.name
                if node.module == 'shared.tables' and alias.name in getters:
                    bound.getters.add(local)
                elif node.module == 'shared' and alias.name == 'tables':
                    bound.tables_modules.add(local)
                elif node.module == 'shared.aws' and alias.name == 'get_dynamodb_resource':
                    bound.resource_getters.add(local)
                elif node.module == 'boto3' and alias.name in {'client', 'resource'}:
                    bound.factories.add(local)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == 'shared.tables':
                    bound.tables_modules.add(alias.asname or alias.name)
                elif alias.name in NOT_S3_COPY_MODULES:
                    bound.not_s3_modules.add(alias.asname or alias.name)
    return bound


def _is_dynamodb_client(node: ast.Call, bound: _Bindings) -> bool:
    if _argument(node, 'service_name') != 'dynamodb':
        return False
    func = node.func
    return ((isinstance(func, ast.Attribute) and func.attr in {'client', 'resource'})
            or (isinstance(func, ast.Name) and func.id in bound.factories))


def _is_s3_change(node: ast.Call, bound: _Bindings) -> bool:
    func = node.func
    if not isinstance(func, ast.Attribute):
        return False
    if func.attr in S3_CHANGES:
        return True
    if func.attr == 'copy':
        if isinstance(func.value, ast.Name) and func.value.id in bound.not_s3_modules:
            return False
        return len(node.args) >= 2 or any(k.arg == 'CopySource' for k in node.keywords)
    if func.attr == 'generate_presigned_url':
        return _argument(node, 'ClientMethod') in PRESIGNED_CHANGES
    if func.attr == 'delete' and any(isinstance(node, ast.Attribute) and node.attr in S3_COLLECTIONS
                                     for node in ast.walk(func.value)):
        return True   # a batch delete of a resource collection: bucket.objects.filter(…).delete()
    if func.attr not in OBJECT_CHANGES:
        return False
    inner = func.value   # resource-style: s3.Object(bucket, key).put(Body=...), or obj = s3.Object(…); obj.put(…)
    return ((isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute) and inner.func.attr in S3_RESOURCES)
            or (isinstance(inner, ast.Name) and inner.id in bound.objects))


def _is_handle(node: ast.AST, bound: _Bindings) -> bool:
    return isinstance(node, ast.Name) and node.id in bound.handles


def _call_kind(node: ast.Call, bound: _Bindings) -> str | None:
    name = _called_name(node)
    if name == 'Table':
        return 'table'
    if name == 'create_client':   # a botocore session's client factory
        service = _argument(node, 'service_name')
        if service in {'dynamodb', 's3'}:
            return f'{service}-client'
    if name in {'vars', '__setattr__', '__delattr__', 'getattr', 'setattr'} and any(
            _is_handle(arg, bound) for arg in node.args):
        return 'layer-private'
    if _is_dynamodb_client(node, bound):
        return 'dynamodb-client'
    if (isinstance(node.func, ast.Name) and node.func.id in bound.resource_getters) or (
            isinstance(node.func, ast.Attribute) and name == 'get_dynamodb_resource'):
        return 'dynamodb-resource'
    return 's3-change' if _is_s3_change(node, bound) else None


def _reference_kind(node: ast.AST, bound: _Bindings, getters: frozenset[str]) -> str | None:
    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in bound.getters:
        return 'table-getter'
    if isinstance(node, ast.Constant) and node.value == LAYER_PRIVATE:
        return 'layer-private'
    if not isinstance(node, ast.Attribute):
        return None
    if node.attr in getters and _dotted(node.value) in bound.tables_modules:
        return 'table-getter'
    if node.attr == 'client' and isinstance(node.value, ast.Attribute) and node.value.attr == 'meta':
        return 'meta-client'
    if node.attr == LAYER_PRIVATE or (node.attr.startswith('_') and _is_handle(node.value, bound)):
        return 'layer-private'   # `_prefix`, `_schema`, `__dict__`, … of a layer handle
    return None


def python_uses(source: str, getters: frozenset[str]) -> list[Use]:
    """Every raw access in one Python module (see the module docstring)."""
    tree = ast.parse(source)
    bound = _bindings(tree, getters)
    uses: list[Use] = []
    for node in ast.walk(tree):
        kind = _call_kind(node, bound) if isinstance(node, ast.Call) else _reference_kind(node, bound, getters)
        if kind is not None:
            uses.append(Use(getattr(node, 'lineno', 0), kind))
    return sorted(uses, key=lambda use: (use.line, use.kind))


# ---- TypeScript -----------------------------------------------------------------------------------------------

def _without_comments(source: str) -> list[str]:
    """``source``'s lines with ``/* */`` blocks (their line breaks kept) and ``//`` comments removed."""
    blanked = _TS_BLOCK_COMMENT.sub(lambda m: '\n' * m.group(0).count('\n'), source)
    return [_TS_LINE_COMMENT.sub('', line) for line in blanked.split('\n')]


def _sdk_names(code: str) -> tuple[dict[str, str], set[str]]:
    """(local name -> SDK name, namespace names) a module takes from ``@aws-sdk/*`` by import or require."""
    names: dict[str, str] = {}
    for pattern, separator in ((_TS_NAMED_IMPORT, ' as '), (_TS_NAMED_REQUIRE, ':')):
        for match in pattern.finditer(code):
            for part in match.group(1).split(','):
                imported, _, local = part.strip().removeprefix('type ').partition(separator)
                if imported.strip():
                    names[(local or imported).strip()] = imported.strip()
    namespaces = {name for pattern in (_TS_NAMESPACE_IMPORT, _TS_NAMESPACE_REQUIRE) for m in pattern.finditer(code)
                  for name in m.groups() if name}
    return names, namespaces


def _ts_rules(code: str) -> list[tuple[re.Pattern[str], str]]:
    """One pattern per SDK name the module takes, in each local spelling (``P``, ``d.PutCommand``)."""
    names, namespaces = _sdk_names(code)
    rules: list[tuple[re.Pattern[str], str]] = []
    # `new X(`, also wrapped in parentheses (`new (X)(`) and across lines (the text is matched whole).
    forms = ((TS_NEW, r'(?<![\w$.])new\s*(?:\(\s*)?{}(?:\s*\))?\s*\('), (TS_FROM, r'(?<![\w$.]){}\s*\.\s*from\s*\('),
             (TS_CALL, r'(?<![\w$.]){}\s*\('))
    for table, form in forms:
        for sdk, kind in table.items():
            spellings = [re.escape(local) for local, imported in names.items() if imported == sdk]
            spellings += [rf'{re.escape(namespace)}\s*\.\s*{sdk}' for namespace in sorted(namespaces)]
            if spellings:
                rules.append((re.compile(form.format(f'(?:{"|".join(spellings)})')), kind))
    return rules


def ts_uses(source: str) -> list[Use]:
    """Every raw access in one TypeScript module of the stream Lambda (see the module docstring)."""
    code = '\n'.join(_without_comments(source))   # matched whole: `new` and the name may sit on separate lines
    uses = [Use(code.count('\n', 0, match.start()) + 1, kind)
            for pattern, kind in _ts_rules(code) for match in pattern.finditer(code)]
    return sorted(uses, key=lambda use: (use.line, use.kind))


# ---- the tree -------------------------------------------------------------------------------------------------

def scan_tree(cdk_dir: Path) -> tuple[dict[str, list[Use]], int]:
    """(file -> its raw uses, for every file with one; how many files were read)."""
    getters = table_getters(cdk_dir)
    found: dict[str, list[Use]] = {}
    scanned = 0
    for rel in walk_py(cdk_dir):
        path = rel.as_posix()
        if path == LAYER:
            continue
        scanned += 1
        uses = python_uses((cdk_dir / rel).read_text(encoding='utf-8'), getters)
        if uses:
            found[path] = uses
    for path, file in iter_files(cdk_dir, [TS_ROOT], ('.ts',), include_tests=False):
        if path.endswith('.d.ts'):
            continue
        scanned += 1
        uses = ts_uses(file.read_text(encoding='utf-8'))
        if uses:
            found[path] = uses
    return found, scanned


def read_ratchet(file: Path) -> dict[str, int]:
    """file -> allowed count, over every entry of the ratchet allowlist (exit 2 on a malformed one)."""
    allowed: dict[str, int] = {}
    for number, entry in enumerate(read_allowlist(file, ('group',)), 1):
        files = entry.get('files')
        if not isinstance(files, dict) or not files:
            raise AuditError(f'{file}: entry {number} needs "files": {{"<path>": <count>}}')
        for path, count in files.items():
            if not isinstance(count, int) or isinstance(count, bool) or count < 1:
                raise AuditError(f'{file}: entry {number}: {path} needs a positive count (remove it at 0)')
            if path in allowed:
                raise AuditError(f'{file}: {path} is listed twice')
            allowed[path] = count
    return allowed


def _where(uses: list[Use]) -> str:
    kinds = Counter(use.kind for use in uses)
    lines = ', '.join(str(use.line) for use in uses[:8]) + (', …' if len(uses) > 8 else '')
    return f'{", ".join(f"{n} {kind}" for kind, n in sorted(kinds.items()))} (line {lines})'


def compare(found: Mapping[str, list[Use]], allowed: Mapping[str, int]) -> Iterator[Finding]:
    """The ratchet: a new file, a count that grew, and a count that dropped (lower the entry)."""
    for path in sorted(set(found) | set(allowed)):
        uses = found.get(path, [])
        count, limit = len(uses), allowed.get(path, 0)
        if limit == 0:
            yield Finding('raw-access', path, f'{count} raw access(es) outside {LAYER}: {_where(uses)}; '
                          'use ws_table / ws_s3_key', {'count': count})
        elif count > limit:
            yield Finding('count-grew', path, f'{count} raw access(es), the allowlist says {limit}: {_where(uses)}',
                          {'count': count, 'allowed': limit})
        elif count < limit:
            yield Finding('count-dropped', path, f'{count} raw access(es), the allowlist says {limit}: lower its '
                          'entry to the new count (remove it at 0)', {'count': count, 'allowed': limit})


def _extra(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('--allowlist', type=Path, default=ALLOWLIST_DIR / f'{TOOL}.json',
                        help='the ratchet allowlist (default: scripts/audit/allowlists/ws_raw_access.json)')
    parser.add_argument('--counts', action='store_true',
                        help='print the current counts as allowlist "files" JSON (to seed or lower the list)')


def main(argv: list[str] | None = None) -> int:
    args = parse_cli(__doc__, argv, _extra)
    found, scanned = scan_tree(args.cdk_dir)
    guard(scanned >= 300, f'only {scanned} files read')
    guard(sum(map(len, found.values())) >= 50, f'only {sum(map(len, found.values()))} raw uses found')
    if args.counts:
        print_report(TOOL, [], [json.dumps({path: len(uses) for path, uses in sorted(found.items())}, indent=2)],
                     as_json=None, summary='current counts')
        return 0
    allowed = {} if args.no_allowlist else read_ratchet(args.allowlist)
    left = list(compare(found, allowed))
    total = sum(map(len, found.values()))
    return print_report(TOOL, [f.as_json() for f in left], (f.line() for f in left), as_json=args.json,
                        summary=f'{total} raw uses in {len(found)} of {scanned} files; {len(allowed)} files allowlisted')


if __name__ == '__main__':
    run_main(main)
