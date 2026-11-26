"""The cross-module scan of the cross-workspace suite (test_cross_workspace_routes.py).

The suite's structural detector reads one file at a time: a route resolves the workspace first when it calls the
resolver, or a function of its own module that does, before it can return or write. This scan is its complement over
the whole of lambda/: a function "reaches the resolver" when it calls shared/workspace.py ``resolve_workspace``, or a
function that does, in any module (shared/ included), followed through the module's own functions, ``from … import
… as …``, ``import … as …``, relative imports, dotted module attributes and bare decorators. A route is any
``@<router>.<verb>('/path')`` decorator, at any depth (async functions and methods too); every route of a module
reaches the resolver when the module's first ``app.use(middlewares=[…])`` middleware does (it runs first, for every
route). Every route it finds, and
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


#: The data path's resolver object (shared/workspace_request.py ``RequestWorkspace``) and the methods that resolve
#: first (test_cross_workspace_routes.py proves it): followed in the files the caller names (``instance_files``).
INSTANCE_RESOLVER: FunctionKey = ('shared.workspace_request', 'RequestWorkspace')
INSTANCE_RESOLVER_METHODS = frozenset({'context', 'scope'})
#: The two-path operator modules' resolver object (shared/workspace_request.py ``ResolvedRoutes``): its
#: ``middleware``, installed first (``app.use(middlewares=[_request.middleware])``), resolves before every route of
#: the module (test_cross_workspace_routes.py proves it); followed in the same files.
ROUTES_RESOLVER: FunctionKey = ('shared.workspace_request', 'ResolvedRoutes')
ROUTES_RESOLVER_MIDDLEWARE = 'middleware'


def _resolver_instances(module: _Module, cls: FunctionKey = INSTANCE_RESOLVER) -> set[str]:
    """Every module-level ``name = <cls>(...)`` of ``module`` (the class imported from shared/workspace_request.py,
    under any local name). Neither an alias nor whether the name is bound only there is checked here: a wrong
    instance can only make the scan find MORE routes, which the per-file detector (test_cross_workspace_routes.py
    ``_instance_resolvers``, which checks both) then fails on, both ways."""
    return {stmt.targets[0].id for stmt in module.tree.body
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name)
            and isinstance(stmt.value, ast.Call) and isinstance(stmt.value.func, ast.Name)
            and module.names.get(stmt.value.func.id) == cls}


def _callees(module_name: str, module: _Module, fn: _Function, instances: frozenset[str] = frozenset()) -> set[FunctionKey]:
    """Every function ``fn`` calls, or is wrapped by as a bare decorator (``@in_workspace``, which calls it), that
    the module's own names and imports resolve to; a resolving method of one of ``instances`` (the module's
    ``RequestWorkspace`` objects, in a file followed) as the resolver itself."""
    targets = [node.func for node in ast.walk(fn) if isinstance(node, ast.Call)]
    targets += [d for d in fn.decorator_list if isinstance(d, ast.Name | ast.Attribute)]
    found: set[FunctionKey] = set()
    for target in targets:
        if isinstance(target, ast.Name):
            name = target.id
            found.add((module_name, name) if name in module.functions else module.names.get(name, ('', name)))
        elif isinstance(target, ast.Attribute):
            base = ast.unparse(target.value)   # `workspace`, `shared.board_access` (other receivers match nothing)
            if base in instances and target.attr in INSTANCE_RESOLVER_METHODS:
                found.add(RESOLVER)
            else:
                found.add((module.modules.get(base, base), target.attr))
    return found


def _routes(fn: _Function) -> list[str]:
    """``"METHOD /path"`` of every ``@<router>.<verb>('/path')`` decorator of ``fn``."""
    return [f'{decorator.func.attr.upper()} {path}' for decorator in fn.decorator_list
            if isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute)
            and decorator.func.attr in VERBS and decorator.args and isinstance(decorator.args[0], ast.Constant)
            and isinstance(path := decorator.args[0].value, str) and path.startswith('/')]


def first_app_middleware(tree: ast.Module) -> str | None:
    """The name of the first middleware of the first module-level ``app.use(middlewares=[...])``: the one that runs
    first (``name.method`` for a module-level object's method, ``_request.middleware``)."""
    for stmt in tree.body:
        call = stmt.value if isinstance(stmt, ast.Expr) else None
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr == 'use'
                and isinstance(call.func.value, ast.Name) and call.func.value.id == 'app'):
            continue
        for keyword in call.keywords:
            if keyword.arg == 'middlewares' and isinstance(keyword.value, ast.List | ast.Tuple) and keyword.value.elts:
                first = keyword.value.elts[0]
                if isinstance(first, ast.Attribute) and isinstance(first.value, ast.Name):
                    return f'{first.value.id}.{first.attr}'
                return first.id if isinstance(first, ast.Name) else None
        return None
    return None


def _first_middleware(module_name: str, module: _Module,
                      routes_instances: frozenset[str] = frozenset()) -> FunctionKey | None:
    """The function of the module's first middleware (``first_app_middleware``), resolved through its imports; the
    resolver itself for the ``middleware`` of one of ``routes_instances`` (its ``ResolvedRoutes``, in a file
    followed). Another object's method is no function the scan follows."""
    name = first_app_middleware(module.tree)
    if name is None:
        return None
    if '.' in name:
        base, attr = name.split('.', 1)
        return RESOLVER if base in routes_instances and attr == ROUTES_RESOLVER_MIDDLEWARE else None
    return (module_name, name) if name in module.functions else module.names.get(name)


def routes_reaching_the_resolver(lambda_dir: Path,
                                 instance_files: frozenset[str] = frozenset()) -> set[tuple[str, str]]:
    """(file name, ``"METHOD /path"``) of every route in ``lambda_dir`` whose function reaches the resolver through
    any module, or that is served under /me/workspaces/current. In a file of ``instance_files`` a module-level
    ``RequestWorkspace``'s resolving methods count as the resolver (``INSTANCE_RESOLVER``), and so does a module-level
    ``ResolvedRoutes``'s ``middleware`` installed first (``ROUTES_RESOLVER``)."""
    modules: dict[str, _Module] = {}
    for file in sorted(lambda_dir.rglob('*.py')):
        if NOT_PRODUCTION.isdisjoint(file.relative_to(lambda_dir).parts[:-1]) and not file.name.startswith('test_'):
            module = _read_module(file, '.'.join(file.relative_to(lambda_dir).parts[:-1]))
            for name in _module_names(lambda_dir, file):
                modules[name] = module
    instances = {name: frozenset(_resolver_instances(module)) if module.file.name in instance_files else frozenset()
                 for name, module in modules.items()}
    calls = {(name, fn_name): _callees(name, module, fn, instances[name])
             for name, module in modules.items() for fn_name, fn in module.functions.items()}
    resolvers = {RESOLVER}
    while more := {key for key, callees in calls.items() if callees & resolvers} - resolvers:
        resolvers |= more
    # Routes are read from every function at any depth (async ones and methods too); one that is not a module
    # function reaches the resolver when it calls one itself.
    routes_instances = {name: frozenset(_resolver_instances(module, ROUTES_RESOLVER))
                        if module.file.name in instance_files else frozenset() for name, module in modules.items()}
    module_wide = {name for name, module in modules.items()
                   if _first_middleware(name, module, routes_instances[name]) in resolvers}
    return {(module.file.name, route)
            for name, module in modules.items()
            for fn in ast.walk(module.tree) if isinstance(fn, _Function)
            for route in _routes(fn)
            if name in module_wide or (name, fn.name) in resolvers or _callees(name, module, fn, instances[name]) & resolvers
            or route.split(maxsplit=1)[1].startswith(SCOPED_PREFIX)}
