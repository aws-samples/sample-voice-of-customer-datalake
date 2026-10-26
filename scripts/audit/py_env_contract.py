#!/usr/bin/env python3
# audit-detector: run by scripts/audit/run-all.sh
"""py_env_contract: CDK environment variables vs what each Python Lambda's LIVE code reads.

PATTERN (deadpy.md section 3, the 5.28 clean-up removed 15 such keys):

* ``set-never-read``: the template sets ``X`` on a function and no string ``'X'`` occurs in the code that
  function can execute (its reachable defs and module bodies, docstrings excluded). A vestigial key,
  and often a sign of a vestigial grant (see py_iam_contract).
* ``read-never-set`` / ``read-never-set-fatal``: live code reads ``X`` (``os.environ.get``/``getenv``/
  ``in os.environ`` / ``os.environ[...]``) and the function is never given it in ANY synth (the
  default one, nor the one with every context-gated feature on). ``-fatal`` = a subscript read, which
  raises ``KeyError`` at run time; the plain kind is a knob that always returns its default.
* ``dead-fallback``: ``os.environ.get(X, default)`` with a NON-EMPTY default, where EVERY function that
  runs this read has ``X`` set both by the default synth and with every optional feature flipped: the
  default never applies in production, and it is a second source of truth (a fail-open ``'*'``, an
  ``'en'`` or a model id that can drift from the CDK's own value).
* ``dead-fallback-empty``: the same with default ``''``. The precise rule: ``''`` is how this repo spells
  "unset" (callers test it for falsiness), so the fallback is the deliberate import-under-test / lazy
  getter pattern (a test imports the module with no env) and adds no second value that can drift. The
  allowlist excuses the whole kind with ONE ``"kind:dead-fallback-empty"`` entry carrying that reason;
  drop the entry to list every site.

WHY THE REFERENCE TOOLS MISS IT: the env map lives in the CDK (TypeScript) and the read in Python; no
linter sees both, and ``cdk synth`` is happy with an unused key. The CDK tests pin that keys EXIST.

HOW: py_assembly gives each function's template env and bundle; py_reachability gives its live defs.
Read sites are found by walking the live nodes only, so a read inside a dead helper does not count.
Runtime-provided names (``AWS_REGION``, ``AWS_LAMBDA_*``, ...) and library-read ones (``POWERTOOLS_*``,
``LOG_LEVEL``) are never findings.

FALSE POSITIVES: a var read through a helper that takes the name as a variable (``_int_env(name)``) is
seen for ``set-never-read`` (the literal is live) but not as a read site. A var read by a third-party
library is listed in ``LIBRARY_READ``. Silence one finding with ``{"key": ..., "reason": ...}`` in
``scripts/audit/allowlists/py_env_contract.json``.

Run: ``voc-datalake/.venv/bin/python scripts/audit/py_env_contract.py [--json] [--refresh]``.
"""
from __future__ import annotations

import argparse
import ast
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from audit_common import Finding, detector_main, guard, run_main
from py_assembly import load_assembly
from py_graph import ModuleInfo, ParseCache
from py_reachability import FunctionReach, Program, analyse

TOOL = 'py_env_contract'
RUNTIME_PROVIDED = re.compile(
    r'^(AWS_REGION|AWS_DEFAULT_REGION|AWS_LAMBDA_\w+|AWS_EXECUTION_ENV|AWS_XRAY_\w+|AWS_ACCESS_KEY_ID|'
    r'AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|_HANDLER|_X_AMZN_TRACE_ID|LAMBDA_TASK_ROOT|LAMBDA_RUNTIME_DIR|'
    r'TZ|PATH|LANG|HOME|LD_LIBRARY_PATH|PYTHONPATH)$')
LIBRARY_READ = re.compile(r'^(POWERTOOLS_\w+|LOG_LEVEL|AWS_STS_REGIONAL_ENDPOINTS|AWS_NODEJS_\w+)$')


@dataclass(frozen=True)
class Read:
    file: Path          # repo-relative source
    scope: str          # enclosing top-level def, or '<module>'
    var: str
    line: int
    default: str | None  # source of the default (None: no default)
    fatal: bool         # os.environ[...]: KeyError when unset


def _key(node: ast.expr | None, consts: dict[str, str]) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return consts.get(node.id)
    return None


def _is_environ(node: ast.expr) -> bool:
    return ast.unparse(node).endswith('environ')


def reads_in(node: ast.AST, consts: dict[str, str]) -> Iterator[tuple[str, int, str | None, bool]]:
    """``(var, line, default source, fatal)`` for every env read under ``node``."""
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute) and sub.args:
            name = sub.func.attr
            is_get = name == 'get' and _is_environ(sub.func.value)
            if is_get or (name == 'getenv' and ast.unparse(sub.func.value) == 'os'):
                var = _key(sub.args[0], consts)
                default = sub.args[1] if len(sub.args) > 1 else None
                if var:
                    yield var, sub.lineno, ast.unparse(default) if default else None, False
        elif isinstance(sub, ast.Subscript) and _is_environ(sub.value) and isinstance(sub.ctx, ast.Load):
            var = _key(sub.slice, consts)
            if var:
                yield var, sub.lineno, None, True
        elif isinstance(sub, ast.Compare) and len(sub.ops) == 1 and isinstance(sub.ops[0], ast.In | ast.NotIn) \
                and _is_environ(sub.comparators[0]):
            var = _key(sub.left, consts)
            if var:
                yield var, sub.lineno, 'presence check', False


def _consts(info: ModuleInfo) -> dict[str, str]:
    return {name: node.value.value for name, node in info.defs.items()
            if isinstance(node, ast.Assign | ast.AnnAssign) and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)}


def live_reads(fr: FunctionReach, cdk_dir: Path, cache: ParseCache) -> set[Read]:
    found: set[Read] = set()
    for name in fr.reach.loaded:
        rel = fr.modules.get(name)
        info = cache.get(cdk_dir / rel, name) if rel else None
        if info is None or rel is None:
            continue
        consts = _consts(info)
        scopes: list[tuple[str, ast.AST]] = [('<module>', root) for root in info.roots]
        scopes += [(q.split('.')[0], info.defs[q]) for m, q in fr.reach.alive if m == name and q in info.defs]
        for scope, node in scopes:
            # a module constant runs at import, whoever reached it
            where = '<module>' if isinstance(node, ast.Assign | ast.AnnAssign) else scope
            for var, line, default, fatal in reads_in(node, consts):
                found.add(Read(rel, where, var, line, default, fatal))
    return found


def _set_never_read(fr: FunctionReach) -> Iterator[Finding]:
    for var in sorted(fr.fn.env):
        if RUNTIME_PROVIDED.match(var) or LIBRARY_READ.match(var) or var in fr.reach.strings:
            continue
        yield Finding('set-never-read', f'{fr.fn.fid}::{var}',
                      f'{fr.fn.handler}: no live string {var!r} in its {len(fr.reach.loaded)} reachable modules')


def _never_set(fr: FunctionReach, reads: set[Read]) -> Iterator[Finding]:
    for var in sorted({r.var for r in reads}):
        if var in fr.fn.env or RUNTIME_PROVIDED.match(var) or LIBRARY_READ.match(var):
            continue
        sites = sorted((r for r in reads if r.var == var), key=lambda r: (r.file, r.line))
        fatal = any(r.fatal for r in sites)
        where = ', '.join(f'{r.file.as_posix()}:{r.line}' for r in sites[:3])
        yield Finding('read-never-set-fatal' if fatal else 'read-never-set', f'{fr.fn.fid}::{var}',
                      f'{fr.fn.handler} reads it ({where}) but no synth sets it')


def findings(program: Program) -> list[Finding]:
    cache = ParseCache()
    out: list[Finding] = []
    sites: dict[tuple[Path, str, str, int, str], list[bool]] = {}
    for fr in program.functions.values():
        reads = live_reads(fr, program.cdk_dir, cache)
        out += _set_never_read(fr)
        out += _never_set(fr, reads)
        for r in reads:
            if r.default is not None and r.default != 'presence check':
                sites.setdefault((r.file, r.scope, r.var, r.line, r.default), []).append(fr.fn.always_sets(r.var))
    for (file, scope, var, line, default), always in sorted(sites.items()):
        if not all(always):
            continue
        kind = 'dead-fallback-empty' if default in ("''", '""') else 'dead-fallback'
        out.append(Finding(kind, f'{file.as_posix()}::{scope}::{var}',
                           f'line {line}: default {default} never used, every one of the {len(always)} '
                           'function(s) running it has the var set'))
    return out


def scan(args: argparse.Namespace) -> tuple[list[Finding], str]:
    program = analyse(args.cdk_dir, load_assembly(args.cdk_dir, refresh=args.refresh))
    env_count = sum(len(fr.fn.env) for fr in program.functions.values())
    guard(len(program.functions) >= 40, f'only {len(program.functions)} Python functions analysed')
    guard(env_count >= 300, f'only {env_count} env entries across all functions')
    return findings(program), f'{len(program.functions)} functions, {env_count} env entries'


main = detector_main(TOOL, __doc__, scan)


if __name__ == '__main__':
    run_main(main)
