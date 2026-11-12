"""The cross-workspace suite: a member of workspace A is refused every id of workspace B, exactly as an id that
exists nowhere (the one 404 for B's workspace id), route by route (docs/multi-workspace.md, "Phases": a guard added in
phase 1 and kept green from then on).

It works over the route inventory of test_route_admin_gates.py (every ``@app.get/post/put/patch/delete`` route of
every ``lambda/api/*_handler.py`` and ``shared/*_routes.py``), now with the workspace dimension. Every route is
named, by file and route, in exactly one table:

* ``WORKSPACE_SCOPED`` (the keys of cross_workspace_worlds.py ``CASES``): the route acts in the workspace
  ``X-Workspace-Id`` names. It resolves the workspace FIRST, structurally (``routes_resolving_the_workspace``):
  ``resolve_workspace`` (imported from shared/workspace.py and never rebound), or a module function that resolves
  first itself, is called before the route (or the module's first ``app.use`` middleware) can return, write (a
  write call, directly or through a module function; a write inside a shared helper is the runtime checks' to catch)
  or reach the resolution only on some paths; a ``try`` counts only when every handler only re-raises. Each route
  has a two-workspace case that names every id its request carries (path, body, query) in A, in B and in neither,
  or says why it carries none, and the suite GENERATES these checks for it, 1 to 3 as an admin of A who is also in
  the deployment's ``admins`` group (the strongest caller who is not a platform admin) and as the same admin
  without that group:
    1. naming B in the header: the one 404 of shared/workspace.py, byte for byte the answer for a workspace that does
       not exist (so it confirms nothing about B), and no table row changed, no Cognito write made;
    2. a route that carries ids, naming A in the header and B's ids in the path, body or query: refused, byte for
       byte as for ids that exist nowhere, and nothing changed;
    3. without the header: the 400 of shared/workspace.py, nothing changed; or, for a route whose case says why it
       keeps the deployment's row for a request that names no workspace (``without_a_workspace``, the deployment as
       before, shared/request_workspace.py), its normal status with no row of A or B changed and nothing of A's
       or B's answered;
    4. the same request inside A, as its admin: its normal status, so the refusals above come from the isolation,
       not from a request that was broken anyway;
    5. a route that carries ids, with B's ids inside B as B's admin: its normal status, so check 2 refused B's real
       rows, not ids that name nothing.
  No answer to A's member, refused or not, holds anything of B's (a value seeded there carries ``B_MARK``; or B's id).
* ``BY_DESIGN``: outside any workspace, each with its reason: the caller's own list of workspaces, the platform
  console (platform admins, every workspace: decision 2), the public OAuth facade.
* ``PENDING`` (cross_workspace_pending.py): not yet keyed by workspace, by phase (2: the data path; 3: everything
  else). The change that makes a route resolve the workspace moves it out of there with its case; a pending route
  that resolves the workspace fails here, and so does a new route nobody classified, so the pending lists only
  shrink. The Lambdas that are not route resolvers (``POST /mcp/global``) are named there too.

A table entry naming a route that no longer exists fails, so the tables cannot rot. The suite proves that it can
fail (the last tests): a resolver that ignores the header, a route that reads B's rows, a table write and a Cognito
write made before the workspace is resolved, an answer that tells B's ids from unknown ones, B ids that name nothing,
a case that does not name every id its request carries, a route in a shape the inventory cannot read, and every
shape of route source in the detector's table, are each caught.
A platform admin entering B (decision 2, audited) is the one sanctioned way in; shared/test/test_workspace.py covers it.
"""
from __future__ import annotations

import ast
import json
import re
from collections.abc import Iterable, Iterator
from functools import cache
from typing import Any
from unittest.mock import patch

import pytest
from cross_workspace_pending import PHASE_2, PHASE_3
from cross_workspace_worlds import (
    A_MARK,
    ADA,
    ADA_MEMBER_ONLY,
    B_MARK,
    BEA,
    CASES,
    UNKNOWN,
    WORLDS,
    WS_A,
    WS_B,
    WS_UNKNOWN,
    RouteCase,
    World,
    table_snapshot,
)
from test_route_admin_gates import (
    API_DIR,
    PLATFORM_GATED_METHODS,
    _called_name,
    _handler_files,
    _module_functions,
    _route_keys,
    _router_files,
)

from shared.api import get_caller_groups
from shared.workspace import NOT_FOUND

RESOLVER = 'resolve_workspace'
RESOLVER_MODULE = 'shared.workspace'
#: The resolvers a route may call, by the module it imports each from: shared/workspace.py's, and the domain APIs'
#: wiring of it (shared/request_workspace.py, which resolves first itself: a test below proves it).
RESOLVERS: dict[str, str] = {RESOLVER: RESOLVER_MODULE, 'request_workspace': 'shared.request_workspace'}
MISSING_HEADER = 'The X-Workspace-Id header is required'
#: Calls that write: one of them before the resolution means the route may act before it knows the workspace.
WRITE_CALLS = frozenset({'put_item', 'update_item', 'delete_item', 'transact_write_items', 'batch_writer',
                         'batch_write_item', 'put_object', 'delete_object', 'send_message', 'start_execution',
                         'invoke', 'create_secret', 'put_secret_value', 'copy_object', 'upload_file',
                         'upload_fileobj', 'send_email', 'send_raw_email', 'send_templated_email', 'publish',
                         'put_events', 'put_record', 'put_records', 'put_parameter', 'execute_statement',
                         'batch_execute_statement', 'execute_transaction'})
#: Cognito's writes start ``admin_`` like its reads; these prefixes are its reads.
COGNITO_READ_PREFIXES = ('admin_get_', 'admin_list_')

WORKSPACE_SCOPED: frozenset[tuple[str, str]] = frozenset(CASES)

BY_DESIGN: dict[tuple[str, str], str] = {
    ('workspaces_handler.py', 'GET /me/workspaces'): (
        "the caller's own workspaces: one Query of their USER#{sub} partition, before any workspace is chosen"),
    **dict.fromkeys(
        [('workspaces_handler.py', 'POST /platform/workspaces'), ('workspaces_handler.py', 'GET /platform/workspaces')],
        'the platform console: platform admins create and list every workspace (decision 2, live-checked)'),
    ('users_handler.py', 'PUT /users/<username>/platform-admin'): (
        "platform-admin membership: the deployment's platform admins, not a workspace's (decision 2, live-checked)"),
    ('appearance_routes.py', 'GET /settings/appearance'): (
        "the deployment's one start theme (decision 7): every signed-in person reads it, whatever their workspace"),
    ('appearance_routes.py', 'PUT /settings/appearance'): (
        "the deployment's one start theme (decision 7): a platform admin's, live-checked, never a workspace admin's"),
    ('logs_handler.py', 'GET /logs/alerts'): (
        "the alarms on the deployment's own Lambdas: the deployment's administrators read their status"),
    **dict.fromkeys(
        [('logs_handler.py', route) for route in (
            'PUT /logs/alerts', 'POST /logs/alerts/recipients', 'POST /logs/alerts/recipients/remove')],
        "the alarms on the deployment's own Lambdas and their recipients: a platform admin's, live-checked"),
    **dict.fromkeys(
        [('mcp_oauth_routes.py', route) for route in (
            'GET /.well-known/oauth-protected-resource', 'GET /.well-known/oauth-protected-resource/mcp/global',
            'GET /.well-known/oauth-authorization-server', 'GET /.well-known/openid-configuration',
            'POST /oauth/register', 'GET /oauth/authorize', 'GET /oauth/callback', 'POST /oauth/token',
            'POST /oauth/revoke')],
        "the public OAuth facade: an MCP client has no credential and no workspace yet; the consent that follows "
        "is the person's own (mcp_oauth_consent_routes.py, phase 3)"),
}


def pending() -> frozenset[tuple[str, str]]:
    """Every pending route, phase 2 and 3."""
    return frozenset((file, route) for table in (PHASE_2, PHASE_3) for file, routes in table.items() for route in routes)


# ── The structural detector ──────────────────────────────────────────────────

def _own_nodes(node: ast.AST) -> Iterator[ast.AST]:
    """``node`` and every node under it, not counting the bodies of nested functions and classes (they do not run
    where they are written)."""
    stack = [node]
    while stack:
        current = stack.pop()
        yield current
        stack.extend(child for child in ast.iter_child_nodes(current)
                     if not isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda | ast.ClassDef))


def _exits(node: ast.AST) -> bool:
    """Whether ``node`` can leave the function: a ``return`` or ``yield`` of its own."""
    return any(isinstance(n, ast.Return | ast.Yield | ast.YieldFrom) for n in _own_nodes(node))


def _fixed_point(functions: dict[str, ast.FunctionDef], seeds: set[str], holds: Any) -> set[str]:
    """``seeds`` plus every name of ``functions`` for which ``holds(fn, names so far)`` is true, to a fixed point."""
    names = set(seeds)
    changed = True
    while changed:
        changed = False
        for name, fn in functions.items():
            if name not in names and holds(fn, names):
                names.add(name)
                changed = True
    return names


def _writes(node: ast.AST, writing: set[str]) -> bool:
    """Whether ``node`` calls a write (DynamoDB, S3, SQS, Step Functions, Lambda, Secrets Manager, Cognito) or a
    module function in ``writing`` (one that does, at any depth)."""
    # Nested functions and lambdas too (unlike exits): one that writes may be called before the resolution.
    names = (_called_name(n) or '' for n in ast.walk(node) if isinstance(n, ast.Call))
    return any(name in WRITE_CALLS or name in writing
               or (name.startswith('admin_') and not name.startswith(COGNITO_READ_PREFIXES)) for name in names)


def _bare_call(stmt: ast.stmt) -> str | None:
    """``f`` for an unconditional ``f(...)``, ``x = f(...)``, ``x: T = f(...)`` or ``return f(...)`` statement."""
    if not isinstance(stmt, ast.Expr | ast.Assign | ast.AnnAssign | ast.Return):
        return None
    value = stmt.value
    if isinstance(value, ast.Call) and isinstance(value.func, ast.Name):
        return value.func.id
    return None


def _reraises(handler: ast.ExceptHandler, writing: set[str]) -> bool:
    """An ``except`` that only refuses: it ends in ``raise`` and cannot return or write before it."""
    return (bool(handler.body) and isinstance(handler.body[-1], ast.Raise)
            and not any(_exits(stmt) or _writes(stmt, writing) for stmt in handler.body))


def _resolves_in(body: Iterable[ast.stmt], resolving: set[str], writing: set[str]) -> bool:
    """Whether ``body`` resolves the workspace before it can return, write, or skip the resolution."""
    for stmt in body:
        if _bare_call(stmt) in resolving:
            return True
        if (isinstance(stmt, ast.Try) and not stmt.finalbody and all(_reraises(h, writing) for h in stmt.handlers)
                and _resolves_in(stmt.body, resolving, writing)):
            return True
        if _exits(stmt) or _writes(stmt, writing):
            return False
    return False


def _rebound(tree: ast.Module) -> set[str]:
    """Every name the module binds other than by a module-level ``def`` or the resolver's own import: assignments,
    parameters, loop and ``with`` targets, other imports (a name bound twice may not be the function it looks like)."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            names.add(node.id)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, ast.Import | ast.ImportFrom) and not (
                isinstance(node, ast.ImportFrom) and node.module in RESOLVERS.values()):
            names.update(alias.asname or alias.name for alias in node.names)
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node not in tree.body:
            names.add(node.name)
    return names


def _imported_resolvers(tree: ast.Module) -> set[str]:
    """The resolvers the module imports, each from its own module and under its own name."""
    return {alias.name for stmt in tree.body if isinstance(stmt, ast.ImportFrom)
            for alias in stmt.names if alias.asname is None and RESOLVERS.get(alias.name) == stmt.module}


def resolving_functions(tree: ast.Module) -> tuple[set[str], set[str]]:
    """``(resolving, writing)``: the resolver (when imported from shared/workspace.py) plus every module function that
    resolves the workspace first, and every module function that writes. Both err towards "not resolving first": a
    name the module rebinds anywhere never resolves, while every function by that name that writes counts as one."""
    every = _module_functions(tree)
    writing = _fixed_point(every, set(), lambda fn, names: any(_writes(stmt, names) for stmt in fn.body))
    rebound = _rebound(tree)
    seeds = _imported_resolvers(tree) - rebound
    if not seeds:
        return set(), writing
    functions = {name: fn for name, fn in every.items() if name not in rebound}
    resolving = _fixed_point(functions, seeds, lambda fn, names: _resolves_in(fn.body, names, writing))
    return resolving, writing


def _first_app_middleware(tree: ast.Module) -> str | None:
    """The first middleware of the first module-level ``app.use(middlewares=[...])``: the one that runs first."""
    for stmt in tree.body:
        call = stmt.value if isinstance(stmt, ast.Expr) else None
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr == 'use'
                and isinstance(call.func.value, ast.Name) and call.func.value.id == 'app'):
            continue
        for keyword in call.keywords:
            if keyword.arg == 'middlewares' and isinstance(keyword.value, ast.List | ast.Tuple) and keyword.value.elts:
                first = keyword.value.elts[0]
                return first.id if isinstance(first, ast.Name) else None
        return None
    return None


def routes_resolving_the_workspace(source: str) -> dict[str, bool]:
    """Every route of ``source`` -> whether it resolves the workspace first: in its body, or in the module's first
    ``app.use`` middleware."""
    tree = ast.parse(source)
    resolving, writing = resolving_functions(tree)
    module_wide = _first_app_middleware(tree) in resolving
    return {key: module_wide or _resolves_in(fn.body, resolving, writing)
            for fn in _module_functions(tree).values() for key in _route_keys(fn, PLATFORM_GATED_METHODS)}


@cache
def inventory() -> dict[tuple[str, str], bool]:
    """(handler or router file, "METHOD /path") -> resolves the workspace first, over every route of the API."""
    return {(path.name, key): resolves
            for path in [*_handler_files(), *_router_files()]
            for key, resolves in routes_resolving_the_workspace(path.read_text(encoding='utf-8')).items()}


def classification() -> dict[tuple[str, str], list[str]]:
    """Every route of the inventory or of a table -> the tables that name it (exactly one when they are right)."""
    named: dict[tuple[str, str], list[str]] = {key: [] for key in inventory()}
    for table, keys in (('WORKSPACE_SCOPED', WORKSPACE_SCOPED), ('BY_DESIGN', BY_DESIGN), ('PENDING', pending())):
        for key in keys:
            named.setdefault(key, []).append(table)
    return named


# ── The tables are right ─────────────────────────────────────────────────────

def test_every_route_is_in_exactly_one_table():
    wrong = {key: tables for key, tables in classification().items() if len(tables) != 1}
    assert not wrong, (
        'Route(s) not in exactly one table: '
        + ', '.join(f'{file} {route} ({tables or "none"})' for (file, route), tables in sorted(wrong.items()))
        + '. Classify each: resolve the workspace first (shared/workspace.py resolve_workspace) and add its case to '
        'lambda/api/test/cross_workspace_worlds.py CASES, or add it to BY_DESIGN in test_cross_workspace_routes.py '
        'with its reason, or to cross_workspace_pending.py with the phase that moves it.')


def test_the_workspace_scoped_routes_are_exactly_the_ones_that_resolve_the_workspace_first():
    resolving = {key for key, resolves in inventory().items() if resolves}
    assert sorted(resolving - WORKSPACE_SCOPED) == [], (
        'These routes resolve the workspace: move them out of cross_workspace_pending.py and give each its case')
    assert sorted(WORKSPACE_SCOPED - resolving) == [], (
        'These routes have a case but do not resolve the workspace first (or no longer exist)')


def test_every_table_entry_names_a_route_that_exists():
    keys = inventory()
    # (A WORKSPACE_SCOPED entry naming no route already fails the test above.)
    assert sorted(key for key in [*BY_DESIGN, *pending()] if key not in keys) == []


#: Every route-registering method of a Powertools resolver or router.
_ROUTE_ATTRS = PLATFORM_GATED_METHODS | {'head', 'options', 'route'}


def _is_app_route(func: ast.expr) -> bool:
    """``<name>.get`` / ``.post`` / … / ``.route``: a route registration on any resolver or router name."""
    return isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.attr in _ROUTE_ATTRS


def _readable(decorator: ast.Call, fn: ast.AST) -> bool:
    """``@app.<get|post|put|patch|delete>("<literal path>")`` on a plain ``def``: the one shape the inventory
    reads."""
    func = decorator.func
    return (isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id == 'app'
            and func.attr in PLATFORM_GATED_METHODS and bool(decorator.args)
            and isinstance(decorator.args[0], ast.Constant) and isinstance(decorator.args[0].value, str)
            and isinstance(fn, ast.FunctionDef))


def _unreadable_routes(source: str) -> list[str]:
    """Every route registration the inventory cannot read, by line: ``@app.route``, ``@app.head``, a path that is not
    a literal, an ``async def``, a route on a resolver or router not named ``app``, a route not on a module-level
    function (nested, under an ``if``, or the call form ``app.get("/x")(fn)``), or a module-level route function
    whose name another module-level def or class reuses (the inventory keeps one function per name)."""
    tree = ast.parse(source)
    readable = {id(d) for node in tree.body if isinstance(node, ast.FunctionDef)
                for d in node.decorator_list if isinstance(d, ast.Call) and _readable(d, node)}
    decorators = [d for node in ast.walk(tree) if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef)
                  for d in node.decorator_list if isinstance(d, ast.Call) and _is_app_route(d.func)]
    decorator_ids = {id(d) for d in decorators}
    # Outside decorators only `app.<route method>(...)` itself is a registration (`params.get(...)` is not).
    plain = [call for call in ast.walk(tree) if isinstance(call, ast.Call) and id(call) not in decorator_ids
             and _is_app_route(call.func) and isinstance(call.func, ast.Attribute)
             and isinstance(call.func.value, ast.Name) and call.func.value.id == 'app']
    unreadable = [f'line {call.lineno}' for call in sorted([*decorators, *plain], key=lambda c: c.lineno)
                  if id(call) not in readable]
    names = [node.name for node in tree.body if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef)]
    routed = {node.name for node in tree.body if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
              and any(isinstance(d, ast.Call) and _is_app_route(d.func) for d in node.decorator_list)}
    unreadable += [f'{name} defined twice' for name in sorted(routed) if names.count(name) > 1]
    return unreadable


def test_every_route_is_in_a_shape_the_inventory_reads():
    unreadable = {path.name: found for path in [*_handler_files(), *_router_files()]
                  if (found := _unreadable_routes(path.read_text(encoding='utf-8')))}
    assert unreadable == {}, (
        'Write each route as @app.<method>("<literal path>") on its own module-level def, so the suite sees it')


@pytest.mark.parametrize(('source', 'found'), [
    ('@app.route("/x", method="GET")\ndef r():\n    return {}\n', ['line 1']),
    ('P = "/x"\n\n\n@app.get(P)\ndef r():\n    return {}\n', ['line 4']),
    ('@app.get("/x")\nasync def r():\n    return {}\n', ['line 1']),
    ('if flag:\n    @app.get("/x")\n    def r():\n        return {}\n', ['line 2']),
    ('def r():\n    return {}\n\n\napp.get("/x")(r)\n', ['line 5']),
    ('@app.get("/a")\ndef r():\n    return {}\n\n\n@app.get("/b")\ndef r():\n    return {}\n', ['r defined twice']),
    ('@app.get("/x")\ndef r():\n    return {}\n\n\ndef r():\n    return 1\n', ['r defined twice']),
    ('@app.get("/x")\ndef r():\n    return {}\n\n\nclass r:\n    pass\n', ['r defined twice']),
    ('router = Router()\n\n\n@router.get("/x")\ndef r():\n    return {}\n', ['line 4']),
    ('@app.head("/x")\ndef r():\n    return {}\n', ['line 1']),
    ('@app.get("/x")\ndef r():\n    limit = params.get("limit")\n    return {}\n', []),
], ids=['route', 'not-a-literal', 'async', 'under-an-if', 'call-form', 'a-name-reused', 'reused-by-a-plain-def',
        'reused-by-a-class', 'another-receiver', 'head', 'readable-with-a-dict-get'])
def test_a_route_the_inventory_cannot_read_is_caught(source, found):
    assert _unreadable_routes(source) == found


_PLACEHOLDER = re.compile(r'\{([a-z_]+)\}')


def _placeholder(value: Any) -> str | None:
    """``name`` for a whole value ``'{name}'``, else None."""
    found = _PLACEHOLDER.fullmatch(value) if isinstance(value, str) else None
    return found.group(1) if found else None


def _leaves(value: Any) -> list[str]:
    """Every value in a body or query that could be an id, at any depth: strings, and numbers as text."""
    if isinstance(value, dict):
        return [leaf for v in value.values() for leaf in _leaves(v)]
    if isinstance(value, list):
        return [leaf for v in value for leaf in _leaves(v)]
    if isinstance(value, int | float) and not isinstance(value, bool):
        return [str(value)]
    return [value] if isinstance(value, str) else []


def case_problems(route: str, case: RouteCase) -> list[str]:
    """Why ``case`` does not name every id ``route``'s request carries (empty when it does)."""
    params = {part[1:-1] for part in route.split()[1].split('/') if part.startswith('<')}
    leaves = [*_leaves(case.body), *_leaves(case.query), *case.shared.values()]
    # A shared path parameter names something of the deployment (same value in every workspace), not an id.
    named = (params - set(case.shared)) | {name for leaf in leaves if (name := _placeholder(leaf))}
    # Every other value of the body or query says why it is not an id: so an id cannot ride in as a literal.
    problems = [f'{leaf!r} is neither a placeholder nor in literals' for leaf in leaves
                if not _placeholder(leaf) and not case.literals.get(leaf, '').strip()]
    problems += [f'shared {name!r} is not a path parameter' for name in sorted(set(case.shared) - params)]
    if named:
        if set(case.ids) != {'A', 'B', UNKNOWN} or any(set(ids) != named for ids in case.ids.values()):
            problems.append(f'ids must name {sorted(named)} in A, B and {UNKNOWN}')
        if case.no_ids:
            problems.append('no_ids on a request that carries ids')
    elif case.ids or not case.no_ids.strip():
        problems.append('a request with no id but the header says why in no_ids, and has no ids')
    return problems


def test_every_workspace_scoped_route_has_a_world_and_names_every_id_it_carries():
    assert sorted({file for file, _ in CASES} - set(WORLDS)) == []
    assert {route: problems for (_, route), case in CASES.items() if (problems := case_problems(route, case))} == {}


_ROLE_ROUTE = 'PUT /me/workspaces/current/members/<sub>'
_ROLE_IDS = {'A': {'sub': 'a'}, 'B': {'sub': f'{B_MARK}-b'}, UNKNOWN: {'sub': 'u'}}


@pytest.mark.parametrize(('case', 'problem'), [
    (RouteCase(ids=_ROLE_IDS, body={'role': 'editor', 'member': f'sub-{B_MARK}-bo'}, literals={'editor': 'a role'}),
     f"'sub-{B_MARK}-bo' is neither"),
    (RouteCase(ids=_ROLE_IDS, body={'role': 'editor', 'version': 3}, literals={'editor': 'a role'}), "'3' is neither"),
    (RouteCase(ids=_ROLE_IDS, body={'role': '{role}'}), 'ids must name'),
    (RouteCase(ids=_ROLE_IDS, no_ids='none', body={'role': 'editor'}, literals={'editor': 'a role'}),
     'no_ids on a request'),
    (RouteCase(body={'role': 'editor'}, literals={'editor': 'a role'}), 'ids must name'),
    (RouteCase(ids=_ROLE_IDS, shared={'plugin_id': 'webscraper'}, literals={'webscraper': 'a plugin'},
               body={'role': 'editor'}), 'shared'),
    (RouteCase(no_ids='none', shared={'sub': 'sub-vic'}, body={'role': 'editor'}, literals={'editor': 'a role'}),
     "'sub-vic' is neither"),
], ids=['an-id-as-a-literal', 'a-number', 'a-placeholder-not-in-ids', 'ids-and-no-ids', 'path-ids-missing',
        'a-shared-name-that-is-no-path-parameter', 'a-shared-value-with-no-reason'])
def test_a_case_that_does_not_name_its_ids_is_caught(case, problem):
    assert [p for p in case_problems(_ROLE_ROUTE, case) if problem in p] != []


# ── The generated checks ─────────────────────────────────────────────────────

def _path(route: str, ids: dict[str, str]) -> str:
    path = route.split()[1]
    for name, value in ids.items():
        path = path.replace(f'<{name}>', value)
    return path


def _filled(value: Any, ids: dict[str, str]) -> Any:
    """``value`` with every ``'{name}'`` replaced by ``ids[name]``."""
    if isinstance(value, dict):
        return {key: _filled(v, ids) for key, v in value.items()}
    if isinstance(value, list):
        return [_filled(v, ids) for v in value]
    name = _placeholder(value)
    return ids[name] if name else value


def _send(world: World, case: RouteCase, route: str, *, ws: str | None, ids: dict[str, str],
          caller: dict) -> tuple[int, Any]:
    """The case's request with ``ids`` in its path, body and query."""
    return world.call(route.split(maxsplit=1)[0], _path(route, {**case.shared, **ids}), ws=ws,
                      body=_filled(case.body, ids), query=_filled(case.query, ids), caller=caller)


def _external_writes(world: World, since: dict[str, int]) -> list[str]:
    """The calls to a double since ``since`` that are not reads (Cognito's ``list_*``, ``get_*``, ``admin_get_*``…)."""
    writes = []
    for name, double in world.doubles.items():
        for call in double.mock_calls[since[name]:]:
            method = call[0].split('.', 1)[0]
            if not method.startswith(('list_', 'get_', 'describe_', *COGNITO_READ_PREFIXES)):
                writes.append(f'{name}.{method}')
    return writes


def _holds_a(body: Any) -> bool:
    """Whether an answer holds anything of A's that only A's members may see: a value seeded with ``A_MARK``, or A's id
    (check 3, for a request that names no workspace)."""
    text = json.dumps(body).casefold()
    return A_MARK in text or WS_A.casefold() in text


def _holds_b(body: Any) -> bool:
    """Whether an answer holds anything of B's: a value seeded there, or B's id."""
    text = json.dumps(body).casefold()
    return B_MARK in text or WS_B.casefold() in text


def _refused(world: World, case: RouteCase, route: str, *, ws: str | None, ids: dict[str, str],
             caller: dict) -> tuple[int, Any]:
    """Send the request, prove it changed nothing and answered nothing of B's; return its answer."""
    before = table_snapshot()
    since = {name: len(double.mock_calls) for name, double in world.doubles.items()}
    status, body = _send(world, case, route, ws=ws, ids=ids, caller=caller)
    assert table_snapshot() == before, f'{route} changed a table on a refused request'
    assert _external_writes(world, since) == [], f'{route} made a write on a refused request'
    assert not _holds_b(body), f'{route} answered with B data: {body}'
    return status, body


def check_other_workspace_header(world: World, case: RouteCase, route: str, caller: dict = ADA) -> None:
    """Check 1: B in the header -> the one 404, the same as for an unknown workspace, nothing changed."""
    ids = case.ids.get('B', {})
    answer = _refused(world, case, route, ws=WS_B, ids=ids, caller=caller)
    assert answer == (404, {'success': False, 'error': NOT_FOUND}), f'{route}: {answer}'
    assert _refused(world, case, route, ws=WS_UNKNOWN, ids=ids, caller=caller) == answer


def check_other_workspace_ids(world: World, case: RouteCase, route: str, caller: dict = ADA) -> None:
    """Check 2: A in the header, B's ids in the path, body or query -> refused, exactly as for unknown ids."""
    answer = _refused(world, case, route, ws=WS_A, ids=case.ids['B'], caller=caller)
    assert answer[0] == case.refused_status, f'{route}: {answer}'
    assert _refused(world, case, route, ws=WS_A, ids=case.ids[UNKNOWN], caller=caller) == answer, (
        f'{route} tells the ids of B from unknown ones')


def _workspace_rows() -> dict[str, list[str]]:
    """Every row of every table that names workspace A or B (its key or a value): what a request outside any workspace
    must leave as it was."""
    return {name: [row for row in rows if WS_A in row or WS_B in row] for name, rows in table_snapshot().items()}


def check_missing_header(world: World, case: RouteCase, route: str, caller: dict = ADA) -> None:
    """Check 3: no header -> the 400 of shared/workspace.py, nothing changed; for a route that keeps the deployment's
    row without a workspace, its normal status (403 for a caller outside the deployment's ``admins`` when the case
    says the route is theirs without a workspace), no row of A or B changed, nothing of A's or B's answered."""
    if not case.without_a_workspace:
        answer = _refused(world, case, route, ws=None, ids=case.ids.get('A', {}), caller=caller)
        assert answer == (400, {'success': False, 'error': MISSING_HEADER}), f'{route}: {answer}'
        return
    before = _workspace_rows()
    status, body = _send(world, case, route, ws=None, ids=case.ids.get('A', {}), caller=caller)
    in_admins = 'admins' in get_caller_groups({'requestContext': {'authorizer': {'claims': caller}}})
    expected = 403 if case.deployment_admins_without_a_workspace and not in_admins else case.ok_status
    assert status == expected, f'{route} without a workspace: {status} {body}'
    assert _workspace_rows() == before, f'{route} without a workspace changed a workspace row'
    assert not _holds_b(body), f'{route} answered with B data without a workspace: {body}'
    assert not _holds_a(body), f'{route} answered with A data without a workspace: {body}'


def check_inside_a(world: World, case: RouteCase, route: str) -> None:
    """Check 4: the same request inside A works, and holds nothing of B's."""
    status, body = _send(world, case, route, ws=WS_A, ids=case.ids.get('A', {}), caller=ADA)
    assert status == case.ok_status, f'{route} inside A: {status} {body}'
    assert not _holds_b(body), f'{route} answered A with B data: {body}'


def check_b_ids_inside_b(world: World, case: RouteCase, route: str) -> None:
    """Check 5: B's ids work inside B, for B's admin: they name B's real rows, so check 2 refused real ones."""
    status, body = _send(world, case, route, ws=WS_B, ids=case.ids['B'], caller=BEA)
    assert status == case.ok_status, f'{route} inside B: {status} {body}'


_SCOPED = sorted(CASES)
_WITH_IDS = sorted(key for key, case in CASES.items() if case.ids)
_CALLERS = pytest.mark.parametrize('caller', [ADA, ADA_MEMBER_ONLY], ids=['deployment-admin', 'member'])


@_CALLERS
@pytest.mark.parametrize(('file', 'route'), _SCOPED)
def test_a_member_of_a_naming_b_gets_the_one_404_and_changes_nothing(file, route, caller, lambda_context):
    with WORLDS[file](lambda_context) as world:
        check_other_workspace_header(world, CASES[(file, route)], route, caller)


@_CALLERS
@pytest.mark.parametrize(('file', 'route'), _WITH_IDS)
def test_a_member_of_a_is_refused_the_ids_of_b_exactly_as_unknown_ones(file, route, caller, lambda_context):
    with WORLDS[file](lambda_context) as world:
        check_other_workspace_ids(world, CASES[(file, route)], route, caller)


@_CALLERS
@pytest.mark.parametrize(('file', 'route'), _SCOPED)
def test_a_request_without_the_header_is_refused_or_reaches_no_workspace(file, route, caller, lambda_context):
    with WORLDS[file](lambda_context) as world:
        check_missing_header(world, CASES[(file, route)], route, caller)


@pytest.mark.parametrize(('file', 'route'), _SCOPED)
def test_the_same_request_inside_a_works_and_holds_nothing_of_b(file, route, lambda_context):
    with WORLDS[file](lambda_context) as world:
        check_inside_a(world, CASES[(file, route)], route)


@pytest.mark.parametrize(('file', 'route'), _WITH_IDS)
def test_the_ids_of_b_work_inside_b(file, route, lambda_context):
    with WORLDS[file](lambda_context) as world:
        check_b_ids_inside_b(world, CASES[(file, route)], route)


# ── The suite can fail ───────────────────────────────────────────────────────

_MEMBERS = ('workspaces_handler.py', 'GET /me/workspaces/current/members')
#: The members list's first page (no cursor): it answers 200 with the members of the workspace it acts in.
_FIRST_PAGE = RouteCase(no_ids='the first page')
_ADD = ('workspaces_handler.py', 'POST /me/workspaces/current/members')
_ROLE = ('workspaces_handler.py', 'PUT /me/workspaces/current/members/<sub>')


def test_the_add_case_reaches_the_cognito_write(lambda_context):
    """The add's positive control creates an account: so on a refused add the Cognito-write check has a write to
    catch (if the seeding gave the email an account, check 1's guard would watch a path that never writes)."""
    with WORLDS[_ADD[0]](lambda_context) as world:
        status, body = _send(world, CASES[_ADD], _ADD[1], ws=WS_A, ids={}, caller=ADA)
        assert (status, body['member']['account']) == (201, 'created')
        assert world.doubles['cognito'].admin_create_user.called


def test_b_ids_that_name_nothing_are_caught(lambda_context):
    """A case whose B ids were never seeded would make check 2 compare two unknown ids: check 5 fails on it."""
    from dataclasses import replace

    case = CASES[_ROLE]
    unseeded = replace(case, ids={**case.ids, 'B': {'sub': f'sub-{B_MARK}-nobody'}})
    with WORLDS[_ROLE[0]](lambda_context) as world, pytest.raises(AssertionError, match='inside B: 404'):
        check_b_ids_inside_b(world, unseeded, _ROLE[1])


def test_a_resolver_that_ignores_the_header_is_caught(lambda_context):
    """A handler that acts in A whatever the header says: check 1 fails on it."""
    import workspaces_handler
    from shared import workspace

    real = workspace.resolve_workspace

    def ignore_the_header(table, event, cache, **kwargs):
        event = {**event, 'headers': {**event['headers'], 'X-Workspace-Id': WS_A}}
        return real(table, event, cache, **kwargs)

    with WORLDS[_MEMBERS[0]](lambda_context) as world, \
            patch.object(workspaces_handler, RESOLVER, ignore_the_header), \
            pytest.raises(AssertionError, match='members: \\(200'):
        check_other_workspace_header(world, _FIRST_PAGE, _MEMBERS[1])


def test_a_route_that_answers_b_rows_is_caught(lambda_context):
    """A members list that reads B's partition: check 4 fails on it."""
    import workspaces_handler

    real = workspaces_handler.list_members

    def list_b(table, _ws, **kwargs):
        return real(table, WS_B, **kwargs)

    with WORLDS[_MEMBERS[0]](lambda_context) as world, \
            patch.object(workspaces_handler, 'list_members', list_b), \
            pytest.raises(AssertionError, match='answered A with B data'):
        check_inside_a(world, _FIRST_PAGE, _MEMBERS[1])


_RESOLVED = 'settings_handler.py'


@pytest.mark.parametrize(('route', 'ws', 'match'), [
    ('PUT /settings/resolved-problems', WS_A, 'changed a workspace row'),
    ('PUT /settings/resolved-problems', WS_B, 'changed a workspace row'),
    ('GET /settings/resolved-problems', WS_A, 'answered with A data'),
    ('GET /settings/resolved-problems', WS_B, 'answered with B data'),
], ids=['put-a-s-row', 'put-b-s-row', 'get-a-s-row', 'get-b-s-row'])
def test_a_route_that_reaches_a_workspace_without_one_is_caught(lambda_context, route, ws, match):
    """Without the header the resolved-problems routes keep the deployment's row: one that reads or writes a
    workspace's row instead (A's or B's) fails check 3."""
    import settings_handler
    from shared.workspace import WorkspaceContext

    def some_workspace(_event, _public_error, **_options):
        return WorkspaceContext(ws=ws, role='admin', name='', slug='', platform_admin=False)

    with WORLDS[_RESOLVED](lambda_context) as world, \
            patch.object(settings_handler, 'request_workspace', some_workspace), \
            pytest.raises(AssertionError, match=match):
        check_missing_header(world, CASES[(_RESOLVED, route)], route)


def test_a_table_write_before_the_resolution_is_caught(lambda_context):
    import workspaces_handler

    real = workspaces_handler._workspace

    def write_first(event, public_error, **kwargs):
        workspaces_handler.get_workspaces_table().put_item(Item={'pk': 'LEAK', 'sk': 'LEAK'})
        return real(event, public_error, **kwargs)

    with WORLDS[_ROLE[0]](lambda_context) as world, \
            patch.object(workspaces_handler, '_workspace', write_first), \
            pytest.raises(AssertionError, match='changed a table'):
        check_other_workspace_ids(world, CASES[_ROLE], _ROLE[1])


def test_a_cognito_write_before_the_resolution_is_caught(lambda_context):
    """An account created before the workspace is resolved (the deployment admin may create one)."""
    import workspaces_handler

    real = workspaces_handler._workspace

    def create_first(event, public_error, **kwargs):
        workspaces_handler.get_cognito_idp_client().admin_create_user(UserPoolId='p', Username='x')
        return real(event, public_error, **kwargs)

    with WORLDS[_ADD[0]](lambda_context) as world, \
            patch.object(workspaces_handler, '_workspace', create_first), \
            pytest.raises(AssertionError, match='made a write'):
        check_other_workspace_header(world, CASES[_ADD], _ADD[1])


def test_an_answer_that_tells_b_ids_from_unknown_ones_is_caught(lambda_context):
    """A role change that says "not in this workspace" for B's member and "not found" for nobody: check 2 fails."""
    import workspaces_handler
    from shared.exceptions import NotFoundError

    real = workspaces_handler.change_role

    def tell_apart(table, context, target, role, actor):
        if B_MARK in target:
            raise NotFoundError('Member of another workspace')
        return real(table, context, target, role, actor)

    with WORLDS[_ROLE[0]](lambda_context) as world, \
            patch.object(workspaces_handler, 'change_role', tell_apart), \
            pytest.raises(AssertionError, match='tells the ids of B from unknown ones'):
        check_other_workspace_ids(world, CASES[_ROLE], _ROLE[1])


_IMPORT = 'from shared.workspace import resolve_workspace\n\n\n'


@pytest.mark.parametrize(('source', 'resolves'), [
    (_IMPORT + '@app.get("/x")\ndef r():\n    context = resolve_workspace(t, e, c)\n    return {}\n', True),
    (_IMPORT + 'def _ws(e):\n    try:\n        return resolve_workspace(t, e, c)\n    except E as exc:\n'
     '        raise S() from exc\n\n\n@app.get("/x")\ndef r():\n    context = _ws(e)\n    return {}\n', True),
    (_IMPORT + 'def _ws(app, nxt):\n    resolve_workspace(t, e, c)\n    return nxt(app)\n\n\n'
     'app.use(middlewares=[_ws])\n\n\n@app.get("/x")\ndef r():\n    return {}\n', True),
    (_IMPORT + '@app.get("/x")\ndef r():\n    body = parse(app)\n    if bad(body):\n        raise V()\n'
     '    context = resolve_workspace(t, e, c)\n', True),
    (_IMPORT + '@app.get("/x")\ndef r():\n    if flag:\n        resolve_workspace(t, e, c)\n    return {}\n', False),
    (_IMPORT + '@app.get("/x")\ndef r():\n    if q.get("all"):\n        return scan()\n'
     '    resolve_workspace(t, e, c)\n', False),
    (_IMPORT + '@app.get("/x")\ndef r():\n    try:\n        resolve_workspace(t, e, c)\n    except E:\n'
     '        pass\n', False),
    (_IMPORT + '@app.get("/x")\ndef r():\n    with suppress(E):\n        resolve_workspace(t, e, c)\n', False),
    (_IMPORT + 'def _ws(e, skip=False):\n    if skip:\n        return None\n    return resolve_workspace(t, e, c)\n\n\n'
     '@app.get("/x")\ndef r():\n    context = _ws(e)\n', False),
    (_IMPORT + '@app.get("/x")\ndef r():\n    fake.resolve_workspace(t, e, c)\n', False),
    (_IMPORT + '@app.get("/x")\ndef r():\n    table.put_item(Item=i)\n    resolve_workspace(t, e, c)\n', False),
    (_IMPORT + '@app.get("/x")\ndef r():\n    def inner():\n        resolve_workspace(t, e, c)\n    return {}\n', False),
    ('@app.get("/x")\ndef r():\n    resolve_workspace(t, e, c)\n', False),
    (_IMPORT + '@app.get("/x")\ndef r():\n    return {}\n', False),
    (_IMPORT + '@app.get("/x")\ndef r():\n    try:\n        resolve_workspace(t, e, c)\n    except E:\n'
     '        if q:\n            return scan()\n        raise\n', False),
    (_IMPORT + 'resolve_workspace = noop\n\n\n@app.get("/x")\ndef r():\n    resolve_workspace(t, e, c)\n', False),
    (_IMPORT + '@app.get("/x")\ndef r(resolve_workspace=noop):\n    resolve_workspace(t, e, c)\n', False),
    (_IMPORT + 'def _ws(app, nxt):\n    resolve_workspace(t, e, c)\n    return nxt(app)\n\n\n'
     'other.use(middlewares=[_ws])\n\n\n@app.get("/x")\ndef r():\n    return {}\n', False),
    (_IMPORT + 'def _ws(app, nxt):\n    resolve_workspace(t, e, c)\n    return nxt(app)\n\n\n'
     'def _early(app, nxt):\n    return nxt(app)\n\n\n'
     'app.use(middlewares=[_early, _ws])\n\n\n@app.get("/x")\ndef r():\n    return {}\n', False),
    (_IMPORT + 'def _audit(t):\n    t.put_item(Item=i)\n\n\n'
     '@app.get("/x")\ndef r():\n    _audit(t)\n    resolve_workspace(t, e, c)\n', False),
    (_IMPORT + '@app.get("/x")\ndef r():\n    ses.send_email(Message=m)\n    resolve_workspace(t, e, c)\n', False),
    (_IMPORT + '@app.get("/x")\ndef r():\n    def note():\n        t.put_item(Item=i)\n    note()\n'
     '    resolve_workspace(t, e, c)\n', False),
    (_IMPORT + 'def _audit(t):\n    t.put_item(Item=i)\n\n\ndef other(_audit):\n    return _audit\n\n\n'
     '@app.get("/x")\ndef r():\n    _audit(t)\n    resolve_workspace(t, e, c)\n', False),
], ids=['direct', 'helper-in-try-that-reraises', 'middleware', 'a-refusal-before', 'conditional',
        'early-return-before', 'try-that-swallows', 'with', 'helper-that-may-skip', 'not-the-resolver',
        'write-before', 'nested-function', 'not-imported', 'none', 'except-that-returns-first', 'rebound',
        'shadowed-by-a-parameter', 'not-app-use', 'a-middleware-before', 'a-helper-that-writes-before',
        'an-email-before', 'a-nested-writer-before', 'a-writer-whose-name-is-also-a-parameter'])
def test_the_detector_counts_only_a_resolution_that_comes_first(source, resolves):
    assert routes_resolving_the_workspace(source) == {'GET /x': resolves}


def test_the_shared_request_resolver_resolves_first():
    """shared/request_workspace.py ``request_workspace`` counts as a resolver: it resolves first on every path but one,
    its first statement, which answers ``None`` for a request that names no workspace before any read or write (the
    deployment as before; check 3 runs that path for every route whose case allows it, and expects the 400 for
    every other)."""
    tree = ast.parse((API_DIR.parent / 'shared' / 'request_workspace.py').read_text(encoding='utf-8'))
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'request_workspace')
    docstring, guard, *rest = function.body
    assert isinstance(docstring, ast.Expr)
    assert ast.unparse(guard) == 'if not _names_a_workspace(event):\n    return None'
    function.body = [docstring, *rest]
    assert 'request_workspace' in resolving_functions(tree)[0]


def test_a_route_calling_the_shared_resolver_resolves_the_workspace():
    source = ('from shared.request_workspace import request_workspace\n\n\n'
              '@app.get("/x")\ndef r():\n    context = request_workspace(e, "Failed")\n    return {}\n')
    assert routes_resolving_the_workspace(source) == {'GET /x': True}
    assert routes_resolving_the_workspace(source.replace('shared.request_workspace', 'shared.other')) == {'GET /x': False}


def test_dropping_the_resolution_of_a_real_route_is_detected():
    tree = ast.parse((API_DIR / 'workspaces_handler.py').read_text(encoding='utf-8'))
    for fn in _module_functions(tree).values():
        if fn.name == '_workspace':
            fn.body = [ast.Return(value=ast.Constant(value=None))]
    resolved = routes_resolving_the_workspace(ast.unparse(tree))
    scoped = [route for file, route in WORKSPACE_SCOPED if file == 'workspaces_handler.py']
    assert scoped
    assert not any(resolved[route] for route in scoped)


def test_inside_a_the_brand_is_a_s(lambda_context):
    """The moto world's read: A's admin gets A's own brand row, not the deployment's nor B's."""
    with WORLDS['settings_handler.py'](lambda_context) as world:
        assert world.call('GET', '/settings/brand', ws=WS_A)[1]['brand_name'] == f'{A_MARK} Outfitters'
        assert world.call('GET', '/settings/brand', ws=None)[1]['brand_name'] == 'Before Workspaces'
