#!/usr/bin/env python3
# audit-detector: run by scripts/audit/run-all.sh
"""py_dead_params: parameters no call uses, arguments every call spells the same, and dead config fallbacks.

PATTERN (hunt-python classes 2, 3 and 7, removed in 5.34): a defaulted parameter nobody ever passes
(``recent_quotes(limit=...)`` with every call taking the default), a parameter every production call passes
the same literal (``create_counted_project_child(count_attribute='document_count')`` six times), and a
``config.get('key', <default>)`` fallback for a key the bundled JSON always has (the avatar prompt's
``fallback_prompt_template``, written once in the JSON and once in Python). Each is a second source of truth
or a knob nobody turns.

HOW: every ``lambda/`` and ``plugins/`` module, tests included, is parsed. A function or method is judged when
its bare name is defined ONCE (so every call by that name is a call of it), it is not decorated, and its name
never escapes: no load of the name other than as a call's callee, and no string equal to it (``getattr`` and
dispatch tables). Every call's arguments are bound to parameters (positional, keyword; ``self`` / ``cls``
dropped for methods); a call with ``*args`` / ``**kwargs`` makes the function unjudgeable.

KINDS: ``dead-default``: a defaulted parameter no call, production or test, binds. ``constant-arg``: two or
more production calls, all binding the same literal, and no test binding another value. ``config-fallback``:
``cfg.get('<key>', <default>)`` where ``cfg`` comes from a loader that returns a bundled JSON file (a function
returning a call with a ``*.json`` name, literal or module constant) and the object at that level (top level, or
one ``cfg['block']`` / ``cfg.get('block')`` down) defines ``<key>``.

KEYS: ``<path>::<qualname>(<param>)`` and ``<path>::<qualname>::<file.json>:<key path>``.

WHY THE REFERENCE TOOLS MISS IT: ruff ``ARG`` reports a parameter the BODY never reads; vulture reports unused
names. Neither looks at the call sites.

FALSE POSITIVES: a library-style API kept for symmetry, a name that collides with a builtin method (binding by
position keeps ``list.count(x)`` on the first parameter). Allowlist ``{"key": ..., "reason": ...}`` in
``scripts/audit/allowlists/py_dead_params.json``.

Run: ``voc-datalake/.venv/bin/python scripts/audit/py_dead_params.py [--json]``.
"""
from __future__ import annotations

import argparse
import ast
import json
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from audit_common import Finding, detector_main, guard, iter_files, run_main, walk_py

TOOL = 'py_dead_params'
_ABSENT = '<absent>'
_EXPR = '<expr>'
_FUNCS = (ast.FunctionDef, ast.AsyncFunctionDef)


@dataclass(frozen=True)
class Def:
    file: str
    qualname: str
    node: ast.FunctionDef | ast.AsyncFunctionDef
    is_method: bool


@dataclass
class Corpus:
    trees: dict[str, ast.Module]
    production: set[str]
    calls: dict[str, list[tuple[str, ast.Call]]] = field(default_factory=lambda: defaultdict(list))
    escaped: set[str] = field(default_factory=set)
    defs: dict[str, list[Def]] = field(default_factory=lambda: defaultdict(list))

    @property
    def call_count(self) -> int:
        return sum(len(v) for v in self.calls.values())


def _callee_name(func: ast.expr) -> str | None:
    if isinstance(func, ast.Name):
        return func.id
    return func.attr if isinstance(func, ast.Attribute) else None


def _index_uses(corpus: Corpus, rel: str, tree: ast.Module) -> None:
    """Calls by callee name, and every name that escapes as a value (a load outside a callee, or a string)."""
    callees: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            callees.add(id(node.func))
            if (name := _callee_name(node.func)) is not None:
                corpus.calls[name].append((rel, node))
    for node in ast.walk(tree):
        if id(node) in callees:
            continue
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            corpus.escaped.add(node.id)
        elif isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load):
            corpus.escaped.add(node.attr)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.isidentifier():
            corpus.escaped.add(node.value)


def _members(stmt: ast.stmt) -> list[tuple[ast.FunctionDef | ast.AsyncFunctionDef, str, bool]]:
    """(def, qualname, is_method) of a top-level function or a class's methods."""
    if isinstance(stmt, _FUNCS):
        return [(stmt, stmt.name, False)]
    if isinstance(stmt, ast.ClassDef):
        return [(sub, f'{stmt.name}.{sub.name}', True) for sub in stmt.body if isinstance(sub, _FUNCS)]
    return []


def _index_defs(corpus: Corpus, rel: str, tree: ast.Module) -> None:
    seen: set[int] = set()
    for node, qualname, is_method in (member for stmt in tree.body for member in _members(stmt)):
        seen.add(id(node))
        corpus.defs[node.name].append(Def(rel, qualname, node, is_method=is_method))
    # nested defs still claim their name, so a same-named top-level def is not judged as unique
    for node in ast.walk(tree):
        if isinstance(node, _FUNCS) and id(node) not in seen:
            corpus.defs[node.name].append(Def(rel, node.name, node, is_method=False))


def load_corpus(cdk_dir: Path) -> Corpus:
    production = [p.as_posix() for p in walk_py(cdk_dir)]
    tests = [p.as_posix() for p in walk_py(cdk_dir, tests=True)]
    corpus = Corpus({}, set(production))
    for rel in production + tests:
        tree = ast.parse((cdk_dir / rel).read_text(encoding='utf-8'), filename=rel)
        corpus.trees[rel] = tree
        _index_uses(corpus, rel, tree)
        _index_defs(corpus, rel, tree)
    return corpus


def bind(fn: Def, call: ast.Call) -> dict[str, ast.expr] | None:
    """Parameter name -> argument for one call; None when ``*args`` / ``**kwargs`` make it unknowable."""
    if any(isinstance(a, ast.Starred) for a in call.args) or any(k.arg is None for k in call.keywords):
        return None
    params = [p.arg for p in fn.node.args.posonlyargs + fn.node.args.args]
    if fn.is_method and params and params[0] in ('self', 'cls'):
        params = params[1:]
    bound = {params[i]: arg for i, arg in enumerate(call.args) if i < len(params)}
    bound.update({k.arg: k.value for k in call.keywords if k.arg is not None})
    return bound


def _defaulted(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    args = node.args
    positional = args.posonlyargs + args.args
    out = [p.arg for p in positional[len(positional) - len(args.defaults):]] if args.defaults else []
    return out + [p.arg for p, d in zip(args.kwonlyargs, args.kw_defaults, strict=True) if d is not None]


def _literal_text(node: ast.expr | None) -> str:
    if node is None:
        return _ABSENT
    try:
        return repr(ast.literal_eval(node))
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return _EXPR


def judged_defs(corpus: Corpus) -> Iterator[Def]:
    for name, defs in corpus.defs.items():
        if len(defs) != 1 or name.startswith('__') or name in corpus.escaped:
            continue
        fn = defs[0]
        if fn.file in corpus.production and not fn.node.decorator_list:
            yield fn


def param_findings(corpus: Corpus) -> tuple[list[Finding], int]:
    out: list[Finding] = []
    judged = 0
    for fn in judged_defs(corpus):
        sites = corpus.calls.get(fn.node.name, [])
        prod_sites = [rel for rel, _ in sites if rel in corpus.production]
        if not prod_sites:
            continue
        bound = [(rel, bind(fn, call)) for rel, call in sites]
        if any(b is None for _, b in bound):
            continue
        judged += 1
        calls = [(rel, b) for rel, b in bound if b is not None]
        where = f'{fn.file}::{fn.qualname}'
        out.extend(Finding('dead-default', f'{where}({p})', f'no call of {len(calls)} binds it; inline the default')
                   for p in _defaulted(fn.node) if not any(p in b for _, b in calls))
        out.extend(_constant_args(fn, where, calls, corpus.production))
    return out, judged


def _constant_args(fn: Def, where: str, calls: list[tuple[str, dict[str, ast.expr]]],
                   production: set[str]) -> Iterator[Finding]:
    prod_calls = [b for rel, b in calls if rel in production]
    if len(prod_calls) < 2:
        return
    args = fn.node.args
    for param in [p.arg for p in args.posonlyargs + args.args + args.kwonlyargs if p.arg not in ('self', 'cls')]:
        values = {_literal_text(b.get(param)) for b in prod_calls}
        if len(values) != 1 or values & {_ABSENT, _EXPR}:
            continue
        value = next(iter(values))
        if any(_literal_text(b.get(param)) not in (value, _ABSENT) for rel, b in calls if rel not in production):
            continue
        yield Finding('constant-arg', f'{where}({param})',
                      f'all {len(prod_calls)} production calls pass {value[:60]}; make it a constant')


# ---- config fallbacks ----------------------------------------------------------------------------------------

def bundled_json(cdk_dir: Path) -> dict[str, object]:
    """Basename -> parsed content of every production JSON file under lambda/ and plugins/ (unique names only)."""
    found: dict[str, list[object]] = defaultdict(list)
    for rel, file in iter_files(cdk_dir, ('lambda', 'plugins'), ('.json',), include_tests=False,
                                exclude=('lambda/stream/**',)):
        try:
            found[Path(rel).name].append(json.loads(file.read_text(encoding='utf-8')))
        except ValueError:
            continue
    return {name: docs[0] for name, docs in found.items() if len(docs) == 1}


def _str_constants(tree: ast.Module) -> dict[str, str]:
    out: dict[str, str] = {}
    for stmt in tree.body:
        targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target] if isinstance(stmt, ast.AnnAssign) else []
        value = getattr(stmt, 'value', None)
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            out.update({t.id: value.value for t in targets if isinstance(t, ast.Name)})
    return out


def loaders(corpus: Corpus, documents: dict[str, object]) -> dict[str, str]:
    """Function name -> the bundled JSON file it returns (``return load(...'x.json'...)``)."""
    out: dict[str, str] = {}
    for rel in corpus.production:
        tree = corpus.trees[rel]
        constants = _str_constants(tree)
        for node in tree.body:
            if not isinstance(node, _FUNCS):
                continue
            returned = [n.value for n in ast.walk(node) if isinstance(n, ast.Return) and isinstance(n.value, ast.Call)]
            for name in (_json_name(arg, constants) for call in returned for arg in call.args):
                if name in documents:
                    out[node.name] = name
    return out


def _json_name(arg: ast.expr, constants: dict[str, str]) -> str | None:
    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
        return arg.value
    return constants.get(arg.id) if isinstance(arg, ast.Name) else None


Origin = tuple[str, tuple[str, ...]]   # (bundled json file, key path below its top level)


def _origin(value: ast.expr, scope: dict[str, Origin], loader_of: dict[str, str]) -> Origin | None:
    """Where a value comes from: a loader call, a tracked name, or one ``[k]`` / ``.get(k)`` below the top level."""
    if isinstance(value, ast.Name):
        return scope.get(value.id)
    if isinstance(value, ast.BoolOp):          # ``cfg.get('block') or {}``
        return _origin(value.values[0], scope, loader_of)
    if isinstance(value, ast.Call) and not value.args and _callee_name(value.func) in loader_of:
        return loader_of[_callee_name(value.func) or ''], ()
    base, key = _subscript_or_get(value)
    origin = _origin(base, scope, loader_of) if base is not None and key is not None else None
    if origin is None or origin[1]:            # one level down at most
        return None
    return origin[0], (str(key),)


def _subscript_or_get(value: ast.expr) -> tuple[ast.expr | None, str | None]:
    if isinstance(value, ast.Subscript) and isinstance(value.slice, ast.Constant) and isinstance(value.slice.value, str):
        return value.value, value.slice.value
    if isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute) and value.func.attr == 'get' \
            and value.args and isinstance(value.args[0], ast.Constant) and isinstance(value.args[0].value, str):
        return value.func.value, value.args[0].value
    return None, None


def _at(document: object, keys: tuple[str, ...]) -> object:
    for key in keys:
        document = document.get(key) if isinstance(document, dict) else None
    return document


def config_findings(corpus: Corpus, documents: dict[str, object]) -> list[Finding]:
    loader_of = loaders(corpus, documents)
    out: list[Finding] = []
    for rel in sorted(corpus.production):
        for fn in (n for n in ast.walk(corpus.trees[rel]) if isinstance(n, _FUNCS)):
            scope: dict[str, Origin] = {}
            for node in ast.walk(fn):
                if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                    origin = _origin(node.value, scope, loader_of)
                    if origin is not None:
                        scope[node.targets[0].id] = origin
            out.extend(_fallbacks(rel, fn, scope, loader_of, documents))
    return out


def _fallbacks(rel: str, fn: ast.FunctionDef | ast.AsyncFunctionDef, scope: dict[str, Origin],
               loader_of: dict[str, str], documents: dict[str, object]) -> Iterator[Finding]:
    for node in ast.walk(fn):
        if not (isinstance(node, ast.Call) and len(node.args) == 2):
            continue
        base, key = _subscript_or_get(node)
        if base is None or key is None or (origin := _origin(base, scope, loader_of)) is None:
            continue
        file, keys = origin
        level = _at(documents[file], keys)
        if isinstance(level, dict) and key in level:
            path = '.'.join((*keys, key))
            yield Finding('config-fallback', f'{rel}::{fn.name}::{file}:{path}',
                          f'{file} always defines {path}; the Python default is a dead second copy')


def scan(args: argparse.Namespace) -> tuple[list[Finding], str]:
    corpus = load_corpus(args.cdk_dir)
    defs = sum(len(v) for v in corpus.defs.values())
    guard(defs >= 2000, f'only {defs} function definitions parsed')
    guard(corpus.call_count >= 5000, f'only {corpus.call_count} call sites seen')
    found, judged = param_findings(corpus)
    found += config_findings(corpus, bundled_json(args.cdk_dir))
    return found, f'{judged} functions judged ({defs} defs, {corpus.call_count} call sites)'


main = detector_main(TOOL, __doc__, scan)


if __name__ == '__main__':
    run_main(main)
