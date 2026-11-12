"""The cross-module scan of the cross-workspace suite (test_cross_workspace_routes.py).

The suite's structural detector reads one file at a time: a route resolves the workspace first when it calls the
resolver, or a function of its own module that does, before it can return or write. This scan is its complement over
the whole of lambda/: a function "reaches the resolver" when it calls shared/workspace.py ``resolve_workspace``, or a
function that does, in any module (shared/ included), followed through the module's own functions, ``from … import
… as …``, ``import … as …``, relative imports, dotted module attributes and bare decorators. A route is any
``@<router>.<verb>('/path')`` decorator, at any depth (async functions and methods too). Every route it finds, and
every route served under ``/me/workspaces/current``, must be workspace-scoped, so a helper in another module cannot
hide a resolution from the suite's tables.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

SCOPED_PREFIX = '/me/workspaces/current'
FunctionKey = tuple[str, str]   # (module, function)
RESOLVER: FunctionKey = ('shared.workspace', 'resolve_workspace')
VERBS = frozenset({'get', 'post', 'put', 'delete', 'patch', 'route'})
NOT_PRODUCTION = frozenset({'test', 'tests', 'layers', 'stream', '__pycache__', '_template'})

_Function = ast.FunctionDef | ast.AsyncFunctionDef


@dataclass
class _Module:
    file: Path
    tree: ast.Module
    functions: dict[str, _Function]
    names: dict[str, FunctionKey]   # local name -> the function it is bound to by an import
    modules: dict[str, str]         # local (dotted) name -> the module it is bound to


def _module_names(lambda_dir: Path, file: Path) -> list[str]:
    """``shared.workspace`` for lambda/shared/workspace.py; an API module is also importable by its bare name."""
    dotted = '.'.join(file.relative_to(lambda_dir).with_suffix('').parts)
    return [dotted, dotted.removeprefix('api.')] if dotted.startswith('api.') else [dotted]


def _import_source(node: ast.ImportFrom, package: str) -> str | None:
    """The module an ``ImportFrom`` reads: its own name, or a relative one (``from .x``, ``from ..``) resolved
    against ``package``, the importing file's package (``shared`` for lambda/shared/x.py)."""
    if not node.level:
        return node.module
    parts = package.split('.') if package else []
    if node.level - 1 > len(parts):
        return None
    base = parts[:len(parts) - (node.level - 1)]
    return '.'.join([*base, *([node.module] if node.module else [])]) or None


def _read_module(file: Path, package: str) -> _Module:
    tree = ast.parse(file.read_text(encoding='utf-8'))
    module = _Module(file, tree, {n.name: n for n in tree.body if isinstance(n, _Function)}, {}, {})
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (source := _import_source(node, package)):
            for alias in node.names:
                local = alias.asname or alias.name
                module.names[local] = (source, alias.name)
                module.modules[local] = f'{source}.{alias.name}'   # `from shared import workspace`, `from . import x`
        elif isinstance(node, ast.Import):
            for alias in node.names:
                module.modules[alias.asname or alias.name] = alias.name
    return module


def _callees(module_name: str, module: _Module, fn: _Function) -> set[FunctionKey]:
    """Every function ``fn`` calls, or is wrapped by as a bare decorator (``@in_workspace``, which calls it), that
    the module's own names and imports resolve to."""
    targets = [node.func for node in ast.walk(fn) if isinstance(node, ast.Call)]
    targets += [d for d in fn.decorator_list if isinstance(d, ast.Name | ast.Attribute)]
    found: set[FunctionKey] = set()
    for target in targets:
        if isinstance(target, ast.Name):
            name = target.id
            found.add((module_name, name) if name in module.functions else module.names.get(name, ('', name)))
        elif isinstance(target, ast.Attribute):
            base = ast.unparse(target.value)   # `workspace`, `shared.board_access` (other receivers match nothing)
            found.add((module.modules.get(base, base), target.attr))
    return found


def _routes(fn: _Function) -> list[str]:
    """``"METHOD /path"`` of every ``@<router>.<verb>('/path')`` decorator of ``fn``."""
    return [f'{decorator.func.attr.upper()} {path}' for decorator in fn.decorator_list
            if isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute)
            and decorator.func.attr in VERBS and decorator.args and isinstance(decorator.args[0], ast.Constant)
            and isinstance(path := decorator.args[0].value, str) and path.startswith('/')]


def routes_reaching_the_resolver(lambda_dir: Path) -> set[tuple[str, str]]:
    """(file name, ``"METHOD /path"``) of every route in ``lambda_dir`` whose function reaches the resolver through
    any module, or that is served under /me/workspaces/current."""
    modules: dict[str, _Module] = {}
    for file in sorted(lambda_dir.rglob('*.py')):
        if NOT_PRODUCTION.isdisjoint(file.relative_to(lambda_dir).parts[:-1]) and not file.name.startswith('test_'):
            module = _read_module(file, '.'.join(file.relative_to(lambda_dir).parts[:-1]))
            for name in _module_names(lambda_dir, file):
                modules[name] = module
    calls = {(name, fn_name): _callees(name, module, fn)
             for name, module in modules.items() for fn_name, fn in module.functions.items()}
    resolvers = {RESOLVER}
    while more := {key for key, callees in calls.items() if callees & resolvers} - resolvers:
        resolvers |= more
    # Routes are read from every function at any depth (async ones and methods too); one that is not a module
    # function reaches the resolver when it calls one itself.
    return {(module.file.name, route)
            for name, module in modules.items()
            for fn in ast.walk(module.tree) if isinstance(fn, _Function)
            for route in _routes(fn)
            if (name, fn.name) in resolvers or _callees(name, module, fn) & resolvers
            or route.split(maxsplit=1)[1].startswith(SCOPED_PREFIX)}
