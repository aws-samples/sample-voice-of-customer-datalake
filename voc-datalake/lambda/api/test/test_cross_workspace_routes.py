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

Two checks come from 6.14.00's suite (test_cross_workspace.py, which this one replaces): a route anywhere in lambda/
that reaches the resolver through helpers in any module (cross_workspace_closure.py) must be workspace-scoped; and
check 1, with B's id, an unknown one and a malformed one, answers the one 404 with not one Cognito call, reads
included, for A's admin, A's viewer, a caller in no workspace and a member of the deployment's ``admins`` only.
A table entry naming a route that no longer exists fails, so the tables cannot rot. The suite proves that it can
fail (the last tests): a resolver that ignores the header, a route that reads B's rows, a table write and a Cognito
write made before the workspace is resolved, an answer that tells B's ids from unknown ones, B ids that name nothing,
a case that does not name every id its request carries, a route in a shape the inventory cannot read, and every
shape of route source in the detector's table, are each caught.
A platform admin entering B (decision 2, audited) is the one sanctioned way in; shared/test/test_workspace.py covers it.
"""
from __future__ import annotations

import ast
import importlib
import json
import re
from collections.abc import Callable, Iterable, Iterator
from dataclasses import replace
from functools import cache
from typing import Any
from unittest.mock import patch

import pytest
from cross_workspace_closure import (
    INSTANCE_RESOLVER,
    INSTANCE_RESOLVER_METHODS,
    ROUTES_RESOLVER,
    ROUTES_RESOLVER_MIDDLEWARE,
    first_app_middleware,
    routes_reaching_the_resolver,
)
from cross_workspace_pending import PHASE_2, PHASE_3
from cross_workspace_worlds import (
    _METRICS_ALIKE_EVERYWHERE,
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
    KnownGap,
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
#: The resolvers a route may call, by the module it imports each from: shared/workspace.py's, the domain APIs'
#: wiring of it (shared/request_workspace.py), and the MCP credentials' (shared/mcp_workspace_pin.py), each of which
#: resolves first itself: the tests below prove it.
RESOLVERS: dict[str, str] = {RESOLVER: RESOLVER_MODULE, 'request_workspace': 'shared.request_workspace',
                             'pinned_workspace': 'shared.mcp_workspace_pin'}
#: The data path's resolver object (cross_workspace_closure.py ``INSTANCE_RESOLVER``, shared/workspace_request.py
#: ``RequestWorkspace``): a module-level instance of it, bound once (``_workspace = RequestWorkspace(...)``), resolves
#: first through ``<instance>.context(event)`` and ``<instance>.scope(event)`` (``INSTANCE_RESOLVER_METHODS``;
#: test_the_data_path_resolver_resolves_first proves both). The two-path operator modules' object
#: (``ROUTES_RESOLVER``, ``ResolvedRoutes``): a module-level ``_request = ResolvedRoutes(app)``, bound once and
#: installed as the module's first middleware (``app.use(middlewares=[_request.middleware])``), resolves before every
#: route of the module (test_the_routes_resolver_resolves_first).
#: The files whose ``RequestWorkspace`` instance or ``ResolvedRoutes`` object the detector reads: a file joins in the change that writes its
#: routes' cases and takes them off cross_workspace_pending.py (one route family a slice). A file not named here
#: resolves through its instance unseen and stays pending, as before this list existed; the list only grows, until
#: every file using the instance is in it and it can go.
INSTANCE_RESOLVER_FILES = frozenset({'feedback_edit_handler.py', 'feedback_form_handler.py',
                                     'manual_import_handler.py', 'scrapers_handler.py',
                                     'integrations_handler.py', 'metrics_handler.py'})
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
#: A module function that resolves the workspace first for every caller but one, by file: a platform admin (the
#: token's ``platform-admins`` group) inside a well-formed workspace they are not a member of, whose READ it answers
#: with None, so the route answers nothing of the workspace (7.49.00, chat_handler.py ``_reading_caller``: the stream
#: Lambda's rule for the same rows, never elevated, nothing read or written). Its body is one ``try`` that resolves
#: first and whose every handler ends in ``raise`` (``_none_for_platform_admins``); every other caller gets the
#: generated checks, and lambda/api/test/test_chat_workspace.py the platform admin's.
NONE_FOR_PLATFORM_ADMINS: dict[str, frozenset[str]] = {'chat_handler.py': frozenset({'_reading_caller'})}

BY_DESIGN: dict[tuple[str, str], str] = {
    **dict.fromkeys(
        [('mcp_tokens_handler.py', route) for route in (
            'GET /connect/tokens', 'GET /connect/tokens/<token_id>', 'DELETE /connect/tokens/<token_id>')],
        "the caller's own MCP tokens, whichever workspace each was minted in (each names it): a person's credentials"),
    **dict.fromkeys(
        [('mcp_oauth_consent_routes.py', route) for route in (
            'GET /connect/oauth/grants', 'DELETE /connect/oauth/grants/<grant_id>')],
        "the caller's own OAuth sign-ins, whichever workspace each was approved in (each names it)"),
    ('mcp_oauth_consent_routes.py', 'GET /connect/oauth/consent'): (
        'what a sign-in request asks for (its client, redirect and scopes), read before the person approves it'),
    ('workspaces_handler.py', 'GET /me/workspaces'): (
        "the caller's own workspaces: one Query of their USER#{sub} partition, before any workspace is chosen"),
    **dict.fromkeys(
        [('workspaces_handler.py', 'POST /platform/workspaces'), ('workspaces_handler.py', 'GET /platform/workspaces')],
        'the platform console: platform admins create and list every workspace (decision 2, live-checked)'),
    ('workspaces_handler.py', 'GET /platform/costs'): (
        "the platform console: every workspace's cost estimate, by workspace id, for platform admins (decision 9, "
        'live-checked, each read logged)'),
    **dict.fromkeys(
        [('workspaces_handler.py', 'POST /platform/workspaces/<ws>/delete/cancel'),
         ('workspaces_handler.py', 'POST /platform/workspaces/<ws>/delete/resume')],
        "the platform console: a platform admin cancels or resumes a workspace's hard delete by its id, once the "
        "workspace answers its one 404 to everyone else (decision 17, live-checked, audited)"),
    **dict.fromkeys(
        [('workspaces_handler.py', 'POST /platform/workspaces/<ws>/trial/extend'),
         ('workspaces_handler.py', 'POST /platform/workspaces/<ws>/trial/convert')],
        "the platform console: a platform admin extends or converts a trial workspace by its id, whoever its members "
        "are (7.71.00, decision 2, live-checked, audited; a workspace that is no trial answers one 404)"),
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
        [('logs_handler.py', route) for route in (
            'GET /logs/system', 'GET /logs/system/request', 'GET /logs/system/queues', 'GET /logs/system/environment')],
        "the deployment's own diagnostics: its Lambdas' redacted log lines, its failure queues and environment, "
        "across every workspace (a failure queue's peeked bodies may hold a workspace's message): the deployment's "
        "administrators, as before workspaces (a known D8 gap, TENETS.md)"),
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
    """``f`` for an unconditional ``f(...)``, ``x = f(...)``, ``x: T = f(...)`` or ``return f(...)`` statement, and
    ``name.method`` for the same statements calling ``name.method(...)`` (a module-level instance's method)."""
    if not isinstance(stmt, ast.Expr | ast.Assign | ast.AnnAssign | ast.Return):
        return None
    value = stmt.value
    if isinstance(value, ast.Call) and isinstance(value.func, ast.Name):
        return value.func.id
    if (isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute)
            and isinstance(value.func.value, ast.Name)):
        return f'{value.func.value.id}.{value.func.attr}'
    return None


def _bindings(tree: ast.Module) -> dict[str, int]:
    """How many times the module binds each name, every way Python binds one: an assignment or other store target
    (``for``, ``with``, a walrus), a parameter, an import, a ``def`` or ``class`` at any depth, an ``except … as``, a
    ``match`` capture, a ``global`` or ``nonlocal`` (which lets a function rebind it)."""
    counts: dict[str, int] = {}
    for node in ast.walk(tree):
        for name in _bound_by(node):
            if name:
                counts[name] = counts.get(name, 0) + 1
    return counts


def _bound_by(node: ast.AST) -> list[str | None]:
    """The names one node binds (``_bindings``)."""
    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store | ast.Del):
        return [node.id]
    if isinstance(node, ast.arg):
        return [node.arg]
    if isinstance(node, ast.Import | ast.ImportFrom):
        return [alias.asname or alias.name.split('.')[0] for alias in node.names]
    if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef | ast.ExceptHandler | ast.MatchAs
                  | ast.MatchStar):
        return [node.name]
    if isinstance(node, ast.MatchMapping):
        return [node.rest]
    if isinstance(node, ast.Global | ast.Nonlocal):
        return list(node.names)
    return []


#: ``ResolvedRoutes``'s one attribute a module sets (its shared secret's clients, read by ``credentials``; never by
#: ``middleware``): any other set attribute of the object, or a ``workspace`` of the module's own passed in, and its
#: middleware may not be the resolver it looks like.
ROUTES_RESOLVER_SETTABLE = frozenset({'clients'})


def _instances(tree: ast.Module, cls_key: tuple[str, str], settable: frozenset[str] = frozenset(),
               only_args: tuple[str, ...] | None = None) -> set[str]:
    """Every module-level ``name = <cls>(...)`` (the class imported from its module under its own name) when the
    module binds the class's name only by that import and the instance's only by that assignment, and changes
    nothing of the instance but a direct ``name.<settable> = …`` (``_patched_names``); with ``only_args``, the call
    passes exactly those positional arguments (as written) and no keyword: a name bound twice, or an instance whose
    method or inner object is replaced, may not be the resolver it looks like."""
    module, cls = cls_key
    imported = any(isinstance(stmt, ast.ImportFrom) and stmt.module == module
                   and any(alias.name == cls and alias.asname is None for alias in stmt.names) for stmt in tree.body)
    bindings = _bindings(tree)
    if not imported or bindings.get(cls) != 1:
        return set()
    patched = _patched_names(tree, settable)
    return {stmt.targets[0].id for stmt in tree.body
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name)
            and isinstance(stmt.value, ast.Call) and isinstance(stmt.value.func, ast.Name)
            and stmt.value.func.id == cls and bindings.get(stmt.targets[0].id) == 1
            and stmt.targets[0].id not in patched
            and (only_args is None or (not stmt.value.keywords
                                       and [ast.unparse(a) for a in stmt.value.args] == list(only_args)))}


def _patched_names(tree: ast.Module, settable: frozenset[str]) -> set[str]:
    """Every name of which the module changes anything: an attribute stored or deleted on it at any depth
    (``x.a = …``, ``x.a.b = …``, ``x[k].a = …``; only a direct ``x.<settable> = …`` is allowed), an item of it
    stored, or the name handed to ``setattr``, ``delattr`` or ``vars``."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute | ast.Subscript) and isinstance(node.ctx, ast.Store | ast.Del):
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.attr in settable:
                continue
            root = node.value
            while isinstance(root, ast.Attribute | ast.Subscript | ast.Call):
                root = root.func if isinstance(root, ast.Call) else root.value
            if isinstance(root, ast.Name):
                names.add(root.id)
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
              and node.func.id in {'setattr', 'delattr', 'vars'} and node.args):
            root = node.args[0]
            while isinstance(root, ast.Attribute | ast.Subscript):
                root = root.value
            if isinstance(root, ast.Name):
                names.add(root.id)
    return names


def _instance_resolvers(tree: ast.Module) -> set[str]:
    """``name.context`` and ``name.scope`` for every module-level ``name = RequestWorkspace(...)``, and
    ``name.middleware`` for every ``name = ResolvedRoutes(app)`` (its own ``RequestWorkspace``; only ``clients`` set
    after), each bound as ``_instances`` says."""
    found = {f'{name}.{method}' for name in _instances(tree, INSTANCE_RESOLVER) for method in INSTANCE_RESOLVER_METHODS}
    return found | {f'{name}.{ROUTES_RESOLVER_MIDDLEWARE}'
                    for name in _instances(tree, ROUTES_RESOLVER, ROUTES_RESOLVER_SETTABLE, only_args=('app',))}


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


def _none_for_platform_admins(fn: ast.FunctionDef, resolving: set[str], writing: set[str]) -> bool:
    """``NONE_FOR_PLATFORM_ADMINS``' shape: the body (after its docstring) is one ``try`` that resolves first, with
    handlers that each end in ``raise`` and write nothing (one may return None before it, for the platform admin)."""
    body = fn.body[1:] if fn.body and isinstance(fn.body[0], ast.Expr) and isinstance(fn.body[0].value, ast.Constant) else fn.body
    [stmt] = body if len(body) == 1 else [None]
    return (isinstance(stmt, ast.Try) and not stmt.finalbody and _resolves_in(stmt.body, resolving, writing)
            and all(bool(h.body) and isinstance(h.body[-1], ast.Raise) and not any(_writes(b, writing) for b in h.body)
                    for h in stmt.handlers))


def resolving_functions(tree: ast.Module, none_for_platform_admins: frozenset[str] = frozenset(),
                        instance_resolvers: bool = False) -> tuple[set[str], set[str]]:
    """``(resolving, writing)``: the resolver (when imported from shared/workspace.py) plus every module function that
    resolves the workspace first, and every module function that writes. Both err towards "not resolving first": a
    name the module rebinds anywhere never resolves, while every function by that name that writes counts as one.
    A function named in ``none_for_platform_admins`` counts only in its shape (``_none_for_platform_admins``).
    With ``instance_resolvers`` (a file of ``INSTANCE_RESOLVER_FILES``) a module-level ``RequestWorkspace``'s
    ``context`` and ``scope`` count as the resolver too (``_instance_resolvers``)."""
    every = _module_functions(tree)
    writing = _fixed_point(every, set(), lambda fn, names: any(_writes(stmt, names) for stmt in fn.body))
    rebound = _rebound(tree)
    seeds = (_imported_resolvers(tree) - rebound) | (_instance_resolvers(tree) if instance_resolvers else set())
    if not seeds:
        return set(), writing
    functions = {name: fn for name, fn in every.items() if name not in rebound}
    resolving = _fixed_point(functions, seeds, lambda fn, names: _resolves_in(fn.body, names, writing)
                             or (fn.name in none_for_platform_admins and _none_for_platform_admins(fn, names, writing)))
    return resolving, writing


def routes_resolving_the_workspace(source: str, none_for_platform_admins: frozenset[str] = frozenset(),
                                   instance_resolvers: bool = False, pinned_middleware: str = '') -> dict[str, bool]:
    """Every route of ``source`` -> whether it resolves the workspace first: in its body, or in the module's first
    ``app.use`` middleware (a function that resolves first, or the ``pinned_middleware`` a proof test pins whole:
    ``PINNED_MIDDLEWARES``)."""
    tree = ast.parse(source)
    resolving, writing = resolving_functions(tree, none_for_platform_admins, instance_resolvers)
    first = first_app_middleware(tree)
    module_wide = first in resolving or (bool(pinned_middleware) and first == pinned_middleware)
    return {key: module_wide or _resolves_in(fn.body, resolving, writing)
            for fn in _module_functions(tree).values() for key in _route_keys(fn, PLATFORM_GATED_METHODS)}


#: A module whose first middleware resolves the workspace in a shape the detector cannot read (it stores the
#: resolution on the request's context): the middleware's name, and its every line and its helper's pinned by
#: test_the_pinned_middlewares_resolve_first, which fails on any change to them, so the detector may trust it.
PINNED_MIDDLEWARES: dict[str, str] = {'metrics_handler.py': '_workspace_first'}


@cache
def inventory() -> dict[tuple[str, str], bool]:
    """(handler or router file, "METHOD /path") -> resolves the workspace first, over every route of the API."""
    return {(path.name, key): resolves
            for path in [*_handler_files(), *_router_files()]
            for key, resolves in routes_resolving_the_workspace(
                path.read_text(encoding='utf-8'), NONE_FOR_PLATFORM_ADMINS.get(path.name, frozenset()),
                path.name in INSTANCE_RESOLVER_FILES, PINNED_MIDDLEWARES.get(path.name, '')).items()}


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


def test_a_reader_answering_none_for_platform_admins_counts_only_in_its_shape_and_where_named():
    source = '''
from shared.request_workspace import request_workspace

def _reading():
    try:
        return request_workspace()
    except NotFound:
        if platform_admin():
            return None
        raise

def _leaky():
    try:
        return request_workspace()
    except NotFound:
        return None

@app.get('/x')
def x():
    return _reading()

@app.get('/y')
def y():
    return _leaky()
'''
    assert routes_resolving_the_workspace(source) == {'GET /x': False, 'GET /y': False}
    assert routes_resolving_the_workspace(source, frozenset({'_reading', '_leaky'})) == {'GET /x': True, 'GET /y': False}
    every = {(file, name) for file, names in NONE_FOR_PLATFORM_ADMINS.items() for name in names}
    defined = {(path.name, fn.name) for path in _handler_files() for fn in _module_functions(ast.parse(path.read_text(encoding='utf-8'))).values()}
    assert sorted(every - defined) == []


def test_every_table_entry_names_a_route_that_exists():
    keys = inventory()
    # (A WORKSPACE_SCOPED entry naming no route already fails the test above.)
    assert sorted(key for key in [*BY_DESIGN, *pending()] if key not in keys) == []


def test_every_route_that_reaches_the_resolver_through_any_module_is_workspace_scoped():
    """The detector above reads one file at a time; cross_workspace_closure.py follows the resolver through every
    module of lambda/ (6.14.00's registry check), so a resolution behind a helper of another module cannot leave a
    route pending or unclassified."""
    reaching = routes_reaching_the_resolver(API_DIR.parent, INSTANCE_RESOLVER_FILES)
    assert sorted(reaching - WORKSPACE_SCOPED) == [], (
        'These routes reach resolve_workspace (through helpers in any module) but are not workspace-scoped')
    assert sorted(WORKSPACE_SCOPED - reaching) == [], 'These workspace-scoped routes reach no resolver'


def test_the_scan_follows_a_module_wide_middleware_that_resolves(tmp_path):
    files = {
        'shared/workspace.py': 'def resolve_workspace(table, event, cache):\n    return None\n',
        'api/notes_handler.py': ('from shared.workspace import resolve_workspace\n\n'
                                 'def in_workspace(app, next_middleware):\n    resolve_workspace(1, app, 2)\n'
                                 '    return next_middleware(app)\n\n'
                                 'app.use(middlewares=[in_workspace])\n\n'
                                 "@app.get('/notes')\ndef notes():\n    return {}\n"),
        'api/other_handler.py': ('def log(app, next_middleware):\n    return next_middleware(app)\n\n'
                                 'app.use(middlewares=[log])\n\n'
                                 "@app.get('/other')\ndef other():\n    return {}\n"),
    }
    for name, source in files.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(source, encoding='utf-8')
    assert routes_reaching_the_resolver(tmp_path) == {('notes_handler.py', 'GET /notes')}


def _write_tree(root: Any, files: dict[str, str]) -> None:
    """A source tree under ``root``, ``{relative path: text}``, for the scan."""
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding='utf-8')


def test_the_scan_follows_resolvers_across_modules_aliases_and_routers(tmp_path):
    files = {
        'shared/workspace.py': 'def resolve_workspace(table, event, cache):\n    return None\n',
        # A helper in another module, reaching the resolver through a module attribute.
        'shared/board_access.py': ('from shared import workspace\n\n'
                                   'def board_workspace(event):\n    return workspace.resolve_workspace(1, event, 2)\n'),
        # Its callers: an aliased import on a Router, a dotted module attribute, and a route that resolves nothing.
        'shared/boards_routes.py': ('from shared.board_access import board_workspace as ws\n\n'
                                    "@router.get('/boards')\ndef boards():\n    return ws(None)\n\n"
                                    "@router.get('/health')\ndef health():\n    return {}\n"),
        'api/votes_handler.py': ('import shared.board_access\n\n'
                                 "@app.post('/votes')\ndef votes():\n    return shared.board_access.board_workspace(None)\n"),
        # A bare decorator that resolves the workspace, by name and as a module attribute.
        'shared/scoped.py': ('from shared.workspace import resolve_workspace\n\n'
                             'def in_workspace(fn):\n    resolve_workspace(1, 2, 3)\n    return fn\n'),
        'api/polls_handler.py': ('from shared import scoped\nfrom shared.scoped import in_workspace\n\n'
                                 "@app.get('/polls')\n@in_workspace\ndef polls():\n    return {}\n\n"
                                 "@app.get('/surveys')\n@scoped.in_workspace\ndef surveys():\n    return {}\n"),
        'api/test/test_votes.py': "@app.get('/planted-in-a-test')\ndef t():\n    return resolve_workspace(1, 2, 3)\n",
        # An async route, and a route on a class method, each calling a resolver itself.
        'api/forms_handler.py': ('from shared.board_access import board_workspace\n\n'
                                 "@app.get('/forms')\nasync def forms():\n    return board_workspace(None)\n\n"
                                 "class Routes:\n    @app.get('/answers')\n    def answers(self):\n"
                                 '        return board_workspace(None)\n'),
        # Relative imports inside a package: `from .x import y` and `from . import x`.
        'shared/ballot_routes.py': ('from .board_access import board_workspace\nfrom . import scoped\n\n'
                                    "@router.get('/ballots')\ndef ballots():\n    return board_workspace(None)\n\n"
                                    "@router.get('/tallies')\n@scoped.in_workspace\ndef tallies():\n    return {}\n"),
        # Served under /me/workspaces/current: scoped whatever it calls.
        'api/teams_handler.py': "@app.get('/me/workspaces/current/notes')\ndef notes():\n    return {}\n",
    }
    _write_tree(tmp_path, files)
    assert routes_reaching_the_resolver(tmp_path) == {
        ('boards_routes.py', 'GET /boards'), ('votes_handler.py', 'POST /votes'), ('polls_handler.py', 'GET /polls'),
        ('polls_handler.py', 'GET /surveys'), ('forms_handler.py', 'GET /forms'), ('forms_handler.py', 'GET /answers'),
        ('ballot_routes.py', 'GET /ballots'), ('ballot_routes.py', 'GET /tallies'),
        ('teams_handler.py', 'GET /me/workspaces/current/notes')}


def test_the_scan_follows_the_data_path_resolver_in_the_files_named(tmp_path):
    """A route that resolves through a module-level ``RequestWorkspace`` (``context`` or ``scope``, directly or in a
    helper) reaches the resolver in a file the scan is told to follow, and only there; another method of it does not."""
    files = {
        'shared/workspace.py': 'def resolve_workspace(table, event, cache):\n    return None\n',
        'shared/workspace_request.py': 'class RequestWorkspace:\n    pass\n',
        'api/edits_handler.py': ('from shared.workspace_request import RequestWorkspace\n\n'
                                 '_workspace = RequestWorkspace()\n\n'
                                 'def _scope(event):\n    return _workspace.context(event)\n\n'
                                 "@app.put('/edits')\ndef edits():\n    return _scope(None)\n\n"
                                 "@app.get('/edits')\ndef read():\n    return _workspace.scope(None)\n\n"
                                 "@app.get('/cache')\ndef cache():\n    return _workspace.memberships(None)\n"),
        'api/forms_handler.py': ('from shared.workspace_request import RequestWorkspace\n\n'
                                 '_workspace = RequestWorkspace()\n\n'
                                 "@app.get('/forms')\ndef forms():\n    return _workspace.context(None)\n"),
    }
    _write_tree(tmp_path, files)
    assert routes_reaching_the_resolver(tmp_path, frozenset({'edits_handler.py'})) == {
        ('edits_handler.py', 'PUT /edits'), ('edits_handler.py', 'GET /edits')}
    assert routes_reaching_the_resolver(tmp_path) == set()


def test_the_scan_follows_the_routes_resolver_installed_first_in_the_files_named(tmp_path):
    """Every route of a module whose first middleware is its ``ResolvedRoutes``'s ``middleware`` reaches the resolver,
    in a file the scan is told to follow and only there; another object's method installed first does not."""
    resolved = 'from shared.workspace_request import ResolvedRoutes\n\n_request = ResolvedRoutes(app)\n\n'
    files = {
        'shared/workspace.py': 'def resolve_workspace(table, event, cache):\n    return None\n',
        'shared/workspace_request.py': 'class ResolvedRoutes:\n    pass\n',
        'api/imports_handler.py': (resolved + 'app.use(middlewares=[_request.middleware])\n\n'
                                   "@app.get('/imports')\ndef imports():\n    return {}\n\n"
                                   "@app.post('/imports')\ndef add():\n    return {}\n"),
        'api/logs_handler.py': (resolved + 'app.use(middlewares=[_request.require_request_admin])\n\n'
                                "@app.get('/logs')\ndef logs():\n    return {}\n"),
        'api/other_handler.py': ('from x import Other\n\n_request = Other(app)\n\n'
                                 'app.use(middlewares=[_request.middleware])\n\n'
                                 "@app.get('/other')\ndef other():\n    return {}\n"),
    }
    _write_tree(tmp_path, files)
    named = frozenset({'imports_handler.py', 'logs_handler.py', 'other_handler.py'})
    assert routes_reaching_the_resolver(tmp_path, named) == {
        ('imports_handler.py', 'GET /imports'), ('imports_handler.py', 'POST /imports')}
    assert routes_reaching_the_resolver(tmp_path) == set()


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
    if case.deployment_ids is not None and (set(case.deployment_ids) != named or not case.without_a_workspace):
        problems.append(f'deployment_ids must name {sorted(named)}, on a route kept without a workspace')
    if case.known_gap is not None and (case.deployment_ids is None or not case.known_gap.reason.strip()):
        problems.append('known_gap only on a route with deployment_ids, with its reason')
    if case.echoes_its_ids and (not named or not case.echoes_its_ids.strip()):
        problems.append('echoes_its_ids only on a request that carries ids, with its reason')
    problems += [f'outside_a {key!r} names no prefix or has no reason' for key, why in case.outside_a.items()
                 if len(key[0]) < 4 or (not key[1] and key[0].endswith('#')) or 'WS#' in key[0] or not why.strip()]
    if (case.ok_status >= 400) != bool(case.refusal) or (case.refusal and '.' not in case.refusal):
        problems.append('a refusing case (ok_status 400 or more) names its refusal (module.NAME), and only it')
    if case.refusal_code and not case.refusal:
        problems.append('refusal_code only beside the refusal it is the code of')
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
    (RouteCase(ids=_ROLE_IDS, without_a_workspace='as before', deployment_ids={'sub': 'd', 'other': 'e'}),
     'deployment_ids must name'),
    (RouteCase(ids=_ROLE_IDS, deployment_ids={'sub': 'd'}), 'deployment_ids must name'),
    (RouteCase(ids=_ROLE_IDS, without_a_workspace='as before', known_gap=KnownGap('open', (404, {}), (200, {}))),
     'known_gap only'),
    (RouteCase(ids=_ROLE_IDS, without_a_workspace='as before', deployment_ids={'sub': 'd'},
               known_gap=KnownGap(' ', (404, {}), (200, {}))), 'known_gap only'),
    (RouteCase(ids=_ROLE_IDS, echoes_its_ids=' '), 'echoes_its_ids only'),
    (RouteCase(ids=_ROLE_IDS, outside_a={('', 'META'): 'every row'}), 'outside_a'),
    (RouteCase(ids=_ROLE_IDS, outside_a={('PLAN#', ''): 'every row of a plan'}), 'outside_a'),
    (RouteCase(ids=_ROLE_IDS, outside_a={('WS#', 'META'): 'every workspace'}), 'outside_a'),
    (RouteCase(ids=_ROLE_IDS, outside_a={('USERCTX#', 'onboarding'): ' '}), 'outside_a'),
    (RouteCase(ids=_ROLE_IDS, ok_status=409), 'names its refusal'),
    (RouteCase(ids=_ROLE_IDS, refusal='shared.radar_exa_routes.NO_WORKSPACE_KEY'), 'names its refusal'),
    (RouteCase(ids=_ROLE_IDS, ok_status=400, refusal='NO_WORKSPACE_KEY'), 'names its refusal'),
    (RouteCase(ids=_ROLE_IDS, refusal_code='runs_not_in_workspace'), 'refusal_code only'),
], ids=['an-id-as-a-literal', 'a-number', 'a-placeholder-not-in-ids', 'ids-and-no-ids', 'path-ids-missing',
        'a-shared-name-that-is-no-path-parameter', 'a-shared-value-with-no-reason', 'deployment-ids-naming-more',
        'deployment-ids-on-a-route-not-kept', 'a-gap-without-deployment-ids', 'a-gap-without-a-reason',
        'an-echo-without-a-reason', 'outside-a-everything', 'outside-a-every-sort-key',
        'outside-a-every-workspace', 'outside-a-without-a-reason', 'a-refusal-unnamed', 'a-refusal-on-a-success',
        'a-refusal-with-no-module', 'a-code-with-no-refusal'])
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
    """Send the request, prove it changed nothing and answered nothing of B's; return its answer (for a case that
    ``echoes_its_ids``, with the ids this request sent read as their ``{name}``: ``_unechoed``)."""
    before = table_snapshot()
    since = {name: len(double.mock_calls) for name, double in world.doubles.items()}
    status, body = _send(world, case, route, ws=ws, ids=ids, caller=caller)
    assert table_snapshot() == before, f'{route} changed a table on a refused request'
    assert _external_writes(world, since) == [], f'{route} made a write on a refused request'
    if case.echoes_its_ids:
        body = _unechoed(body, ids)
    assert not _holds_b(body), f'{route} answered with B data: {body}'
    return status, body


def _unechoed(body: Any, ids: dict[str, str]) -> Any:
    """``body`` with each value of ``ids`` (what the request itself sent) read as its ``{name}``, wherever it stands
    whole (not inside a longer id: ``job-a1`` stays in ``job-a10``; an id joined by ``_``, as in a run's
    ``run_{id}_{time}``, is read): an answer that only repeats its own request's ids then equals another's; anything
    else it says still counts."""
    text = json.dumps(body)
    for name, value in sorted(ids.items(), key=lambda item: -len(item[1])):
        text = re.sub(rf'(?<![A-Za-z0-9-]){re.escape(json.dumps(value)[1:-1])}(?![A-Za-z0-9-])', f'{{{name}}}', text)
    return json.loads(text)


def _check_still_echoes(world: World, case: RouteCase, route: str, *, ws: str | None, ids: dict[str, str],
                        caller: dict) -> None:
    """A case that ``echoes_its_ids``: its refusal still repeats an id it was sent (else the note is to go)."""
    if case.echoes_its_ids:
        _status, raw = _send(world, case, route, ws=ws, ids=ids, caller=caller)
        assert any(json.dumps(value)[1:-1] in json.dumps(raw) for value in ids.values()), (
            f'{route} no longer repeats the ids it was sent ({raw}): drop its echoes_its_ids')


def check_other_workspace_header(world: World, case: RouteCase, route: str, caller: dict = ADA) -> None:
    """Check 1: B in the header -> the one 404, the same as for an unknown workspace, nothing changed."""
    ids = case.ids.get('B', {})
    answer = _refused(world, case, route, ws=WS_B, ids=ids, caller=caller)
    assert answer == (404, {'success': False, 'error': NOT_FOUND}), f'{route}: {answer}'
    assert _refused(world, case, route, ws=WS_UNKNOWN, ids=ids, caller=caller) == answer


def check_other_workspace_ids(world: World, case: RouteCase, route: str, caller: dict = ADA) -> None:
    """Check 2: A in the header, B's ids in the path, body or query -> refused, exactly as for unknown ids; so are
    the deployment's own (``deployment_ids``: a row a request without the header names), never A's to read. A route
    that ``accepts_any_id``: B's ids and unknown ones each work inside A, as in A, landing only in A."""
    if case.accepts_any_id:
        for ids in (case.ids['B'], case.ids[UNKNOWN]):
            status, body = _lands_in_a(world, case, route, ids=ids, caller=caller)
            assert status == case.ok_status, f'{route} inside A with {ids}: {status} {body}'
        return
    answer = _refused(world, case, route, ws=WS_A, ids=case.ids['B'], caller=caller)
    assert answer[0] == case.refused_status, f'{route}: {answer}'
    assert _refused(world, case, route, ws=WS_A, ids=case.ids[UNKNOWN], caller=caller) == answer, (
        f'{route} tells the ids of B from unknown ones')
    if case.deployment_ids is not None:
        assert _refused(world, case, route, ws=WS_A, ids=case.deployment_ids, caller=caller) == answer, (
            f"{route} tells the deployment's ids from unknown ones inside A")
    _check_still_echoes(world, case, route, ws=WS_A, ids=case.ids['B'], caller=caller)


def _workspace_rows() -> dict[str, list[str]]:
    """Every row of every table that names workspace A or B (its key or a value): what a request outside any workspace
    must leave as it was."""
    return {name: [row for row in rows if WS_A in row or WS_B in row] for name, rows in table_snapshot().items()}


def check_missing_header(world: World, case: RouteCase, route: str, caller: dict = ADA) -> None:
    """Check 3: no header -> the 400 of shared/workspace.py, nothing changed; for a route that keeps the deployment's
    row without a workspace, its normal status (403 for a caller outside the deployment's ``admins`` when the case
    says the route is theirs without a workspace), no row of A or B changed, nothing of A's or B's answered; for one
    that refuses a workspace's ids there (``deployment_ids``), that request names the deployment's own row, and A's
    ids are refused exactly as unknown ones, nothing changed."""
    if not case.without_a_workspace:
        answer = _refused(world, case, route, ws=None, ids=case.ids.get('A', {}), caller=caller)
        assert answer == (400, {'success': False, 'error': MISSING_HEADER}), f'{route}: {answer}'
        return
    before = _workspace_rows()
    ids = case.deployment_ids if case.deployment_ids is not None else case.ids.get('A', {})
    status, body = _send(world, case, route, ws=None, ids=ids, caller=caller)
    in_admins = 'admins' in get_caller_groups({'requestContext': {'authorizer': {'claims': caller}}})
    normal = case.ok_status if case.status_without_a_workspace is None else case.status_without_a_workspace
    expected = 403 if case.deployment_admins_without_a_workspace and not in_admins else normal
    assert status == expected, f'{route} without a workspace: {status} {body}'
    assert _workspace_rows() == before, f'{route} without a workspace changed a workspace row'
    assert not _holds_b(body), f'{route} answered with B data without a workspace: {body}'
    assert not _holds_a(body), f'{route} answered with A data without a workspace: {body}'
    if case.deployment_ids is not None:
        # A route that refuses a workspace's ids deployment-wide: A's are refused there exactly as unknown ones.
        answer = _refused(world, case, route, ws=None, ids=case.ids['A'], caller=caller)
        assert not _holds_a(answer[1]), f"{route} answered A's ids with A data without a workspace: {answer}"
        unknown = _refused(world, case, route, ws=None, ids=case.ids[UNKNOWN], caller=caller)
        if case.known_gap is not None:
            gap = case.known_gap
            assert (answer, unknown) == (gap.a_answer, gap.unknown_answer), (
                f"{route} without a workspace answers A's ids {answer} and unknown ones {unknown}, not its known gap"
                + (': it is closed, drop known_gap' if answer == unknown else ''))
        else:
            assert answer == unknown, f"{route} without a workspace tells A's ids from unknown ones: {answer}"
            if answer[0] == 404:
                _check_still_echoes(world, case, route, ws=None, ids=case.ids['A'], caller=caller)


def check_inside_a(world: World, case: RouteCase, route: str) -> None:
    """Check 4: the same request inside A works, holds nothing of B's (nor of the deployment's, in a world that marks
    its rows: ``World.deployment_mark``), every row or object it adds, changes or removes is A's (``_names_a``) or
    one the case says is no workspace's (``outside_a``), no call to a double names B, and a payload the case names
    (``payload_names_a``) carries A on. A route that refuses inside a workspace what it does for the deployment
    (``ok_status`` 400 or more) must also refuse it as a refusal does: nothing changed, no external write."""
    if case.ok_status >= 400:
        status, body = _refused(world, case, route, ws=WS_A, ids=case.ids.get('A', {}), caller=ADA)
        refusal = {'success': False, 'error': _refusal_text(case.refusal),
                   **({'code': case.refusal_code} if case.refusal_code else {})}
        assert (status, body) == (case.ok_status, refusal), f'{route} inside A is not its refusal: {status} {body}'
        return
    since = {name: len(double.mock_calls) for name, double in world.doubles.items()}
    status, body = _lands_in_a(world, case, route, ids=case.ids.get('A', {}))
    assert status == case.ok_status, f'{route} inside A: {status} {body}'
    if world.deployment_mark:
        assert world.deployment_mark not in json.dumps(body), f"{route} answered A with the deployment's data: {body}"
    if case.differs_from_the_deployment:
        deployment_status, deployment = _send(world, case, route, ws=None, ids=case.ids.get('A', {}), caller=ADA)
        expected = case.ok_status if case.status_without_a_workspace is None else case.status_without_a_workspace
        assert deployment_status == expected, f'{route} without a workspace: {deployment_status} {deployment}'
        assert body != deployment, f"{route} answered A with the deployment's data (its answer without the header)"
    if case.payload_names_a:
        double = world.doubles[case.payload_names_a]
        assert len(double.mock_calls) > since[case.payload_names_a], f'{route} inside A never called it'
        assert _payload(double.mock_calls[-1]).get('workspace_id') == WS_A, (
            f'{route} inside A carried another place on: {double.mock_calls[-1]}')


def _refusal_text(refusal: str) -> str:
    """The message a case's ``refusal`` names (``module.NAME``)."""
    module, _, name = refusal.rpartition('.')
    return getattr(importlib.import_module(module), name)


def _lands_in_a(world: World, case: RouteCase, route: str, *, ids: dict[str, str],
                caller: dict = ADA) -> tuple[int, Any]:
    """Send ``ids`` inside A as ``caller`` (A's admin); prove the answer holds nothing of B's (but the request's own
    ids, for a case that ``echoes_its_ids`` or ``accepts_any_id``), every change is A's or ``outside_a``'s, and no
    call to a double holds anything of B's."""
    before = table_snapshot()
    since = {name: len(double.mock_calls) for name, double in world.doubles.items()}
    status, body = _send(world, case, route, ws=WS_A, ids=ids, caller=caller)
    shown = _unechoed(body, ids) if case.echoes_its_ids or case.accepts_any_id else body
    assert not _holds_b(shown), f'{route} answered A with B data: {body}'
    after = table_snapshot()
    outside = {name: sorted(row for row in set(before.get(name, [])) ^ set(after.get(name, []))
                            if not _names_a(row) and not _excepted(row, case.outside_a))
               for name in set(before) | set(after)}
    assert {name: rows for name, rows in outside.items() if rows} == {}, (
        f"{route} inside A changed rows that are not A's (name each that is no workspace's in outside_a)")
    calls = [_unechoed(str(call), ids) for name, double in world.doubles.items()
             for call in double.mock_calls[since[name]:]]
    assert not any(_holds_b(call) for call in calls), f'{route} inside A called a double naming B: {calls}'
    return status, body


def _payload(call: Any) -> dict:
    """The JSON payload of a double's call (``Payload=`` of an invoke, or its second argument), {} when none."""
    _name, args, kwargs = call
    raw = kwargs.get('Payload', args[1] if len(args) > 1 else None)
    if isinstance(raw, bytes | str):
        try:
            loaded = json.loads(raw)
        except ValueError:
            return {}
        return loaded if isinstance(loaded, dict) else {}
    return raw if isinstance(raw, dict) else {}


def _key(row: str) -> tuple[str, str, Any]:
    """``(pk, sk, the item)`` of a ``table_snapshot`` row (an S3 object's line: its key, '', None)."""
    try:
        item = json.loads(row)
    except ValueError:
        return row.split(' ', 1)[0], '', None
    if not isinstance(item, dict):
        return '', '', None
    return item.get('pk', {}).get('S', ''), item.get('sk', {}).get('S', ''), item


def _names_a(row: str) -> bool:
    """Whether a row is A's by its key or its workspace stamp, not by any value that merely mentions A: A's id in its
    ``pk`` (``WS#{A}#…``, ``AUDIT#WS#{A}``…) or ``sk`` (an index row: ``USER#{sub}`` / ``WS#{A}``), or as its
    ``workspace_id`` or ``workspace`` (a row whose key every place shares: a parse job, a token, an audit row); an S3
    object under A's own prefix (``ws/{A}/…``); an SSM parameter under A's own path (``/…/{A}/…``, its credentials
    and settings). Never a row that also names B, by its key or a stamp."""
    pk, sk, item = _key(row)
    if item is None:
        if WS_B in pk:
            return False
        return pk.startswith(f'ws/{WS_A}/') or (pk.startswith('/') and f'/{WS_A}/' in pk)
    stamps = {item.get(name, {}).get('S') for name in _WORKSPACE_STAMPS}
    if WS_B in pk or WS_B in sk or WS_B in stamps:
        return False
    return WS_A in pk or WS_A in sk or WS_A in stamps


#: The attributes a row names its workspace by, when its key does not.
_WORKSPACE_STAMPS = ('workspace_id', 'workspace')


def _excepted(row: str, outside_a: dict[tuple[str, str], str]) -> bool:
    """Whether a row is one the case names as no workspace's: its ``pk`` and ``sk`` start with a pair of
    ``outside_a``; a pair with no ``sk`` prefix names one whole ``pk`` (every row of it, that ``pk`` only)."""
    pk, sk, _item = _key(row)
    return any((pk == pk_prefix if not sk_prefix else pk.startswith(pk_prefix) and sk.startswith(sk_prefix))
               for pk_prefix, sk_prefix in outside_a)


def _row(pk: str, sk: str, **values: str) -> str:
    """A ``table_snapshot`` row with these keys and string values."""
    return json.dumps({'pk': {'S': pk}, 'sk': {'S': sk}, **{k: {'S': v} for k, v in values.items()}}, sort_keys=True)


@pytest.mark.parametrize(('row', 'names_a'), [
    (_row(f'WS#{WS_A}#IMPORT_RUN', 'x'), True),
    (_row('USER#sub-ada', f'WS#{WS_A}'), True),
    (_row('MANUAL_IMPORT#job', 'JOB', workspace_id=WS_A), True),
    (_row('MCPGTOKEN', 'TOKEN#t', workspace=WS_A), True),
    (f'ws/{WS_A}/raw/x.json "etag" 2026', True),
    (_row('AUDIT#delete', 't', target=f'{{"workspace": "{WS_A}"}}'), False),
    (_row('PLAN#p', 'META', note=f'about {WS_A}'), False),
    (_row(f'WS#{WS_B}#X', f'REF#{WS_A}'), False),
    (_row(f'WS#{WS_A}#X', 'y', workspace=WS_B), False),
    (_row('MANUAL_IMPORT#job', 'JOB'), False),
    (f'raw/ws/{WS_A}/x.json "etag" 2026', False),
    (f'ws/{WS_B}/raw/{WS_A}.json "etag" 2026', False),
    (f'/voc/ws/{WS_A}/credentials/webscraper 1 2026', True),
    (f'/voc/ws/{WS_B}/credentials/{WS_A} 1 2026', False),
    ('/voc/shared/credentials 1 2026', False),
    (f'shared-api-credentials-{WS_A} v1', False),
], ids=['its-pk', 'its-sk', 'its-workspace-id', 'its-workspace', 'an-object-under-a', 'a-only-in-a-value',
        'a-only-in-a-note', 'b-key-with-a-sort-key', 'a-key-stamped-b', 'no-place', 'an-object-not-at-a',
        'an-object-under-b', 'a-parameter-of-a', 'a-parameter-of-b', 'a-parameter-of-no-place',
        'a-secret-named-after-a'])
def test_a_row_is_as_by_its_key_or_stamp_only(row, names_a):
    assert _names_a(row) is names_a


@pytest.mark.parametrize(('row', 'excepted'), [
    (_row('PLAN#p', 'STEP#1'), True),
    (_row('PLAN#p', 'META'), False),
    (_row('MCPGTOKEN', 'CREATOR#sub#TOKEN#t'), True),
    (_row('MCPGTOKEN', 'TOKEN#t'), False),
    (_row('AUDIT#delete', '2026-11-26#x'), True),
    (_row('AUDIT#deleted', '2026-11-26#x'), False),
    (_row('PLANCAP#sub', 'META'), False),
], ids=['a-plans-step', 'a-plans-own-row', 'a-creator-index-row', 'a-token-row', 'the-whole-pk',
        'a-longer-pk', 'another-pk-with-that-start'])
def test_an_exception_names_only_its_rows(row, excepted):
    outside_a = {('PLAN#', 'STEP#'): 'steps', ('MCPGTOKEN', 'CREATOR#'): 'index', ('AUDIT#delete', ''): 'audit',
                 ('PLAN', ''): 'a whole pk named PLAN only'}
    assert _excepted(row, outside_a) is excepted


def check_b_ids_inside_b(world: World, case: RouteCase, route: str) -> None:
    """Check 5: B's ids work inside B, for B's admin: they name B's real rows, so check 2 refused real ones. When a
    refusal answers as a success does (``refused_status == ok_status``), the status proves nothing, so B's ids must
    also be seen to name a row: the request changes something, or answers otherwise than an unknown id."""
    before = table_snapshot()
    status, body = _send(world, case, route, ws=WS_B, ids=case.ids['B'], caller=BEA)
    assert status == case.ok_status, f'{route} inside B: {status} {body}'
    if case.refused_status != case.ok_status or case.accepts_any_id or table_snapshot() != before:
        return
    _status, unknown = _send(world, case, route, ws=WS_B, ids=case.ids[UNKNOWN], caller=BEA)
    if case.echoes_its_ids:
        body, unknown = _unechoed(body, case.ids['B']), _unechoed(unknown, case.ids[UNKNOWN])
    assert body != unknown, (
        f"{route} inside B changed nothing and answers B's ids as unknown ones: check 2 proves nothing")


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


#: Check 1's other callers (6.14.00's suite): A's viewer (seeded in every world), a caller in no workspace, and a
#: member of the deployment's ``admins`` group only.
_OTHER_CALLERS = pytest.mark.parametrize('caller', [
    {'sub': 'sub-vic', 'cognito:username': 'vic', 'cognito:groups': 'users'},
    {'sub': 'sub-sam', 'cognito:username': 'sam', 'cognito:groups': 'users'},
    {'sub': 'sub-nor', 'cognito:username': 'nor', 'cognito:groups': 'admins'},
], ids=['a-viewer', 'no-member', 'deployment-admins-only'])


def check_no_cognito_call(world: World, case: RouteCase, route: str, caller: dict) -> None:
    """B's id, an unknown one and a malformed one (B's slug in place of its id) in the header: the one 404 for each,
    nothing changed, and not one call to Cognito, reads included (the refusal comes before any account lookup)."""
    since = {name: len(double.mock_calls) for name, double in world.doubles.items()}
    for ws in (WS_B, WS_UNKNOWN, B_MARK):
        answer = _refused(world, case, route, ws=ws, ids=case.ids.get('B', {}), caller=caller)
        assert answer == (404, {'success': False, 'error': NOT_FOUND}), f'{route} with {ws}: {answer}'
    assert {name: len(double.mock_calls) for name, double in world.doubles.items()} == since, (
        f'{route} called Cognito on a refused request')


@pytest.mark.parametrize('caller', [ADA, ADA_MEMBER_ONLY], ids=['deployment-admin', 'member'])
@pytest.mark.parametrize(('file', 'route'), _SCOPED)
def test_naming_b_or_a_malformed_id_calls_no_cognito(file, route, caller, lambda_context):
    with WORLDS[file](lambda_context) as world:
        check_no_cognito_call(world, CASES[(file, route)], route, caller)


@_OTHER_CALLERS
@pytest.mark.parametrize(('file', 'route'), _SCOPED)
def test_any_other_caller_naming_b_gets_the_one_404_and_calls_no_cognito(file, route, caller, lambda_context):
    with WORLDS[file](lambda_context) as world:
        check_no_cognito_call(world, CASES[(file, route)], route, caller)


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


_REFUSING = sorted(key for key, case in CASES.items() if case.deployment_ids is not None)


def _stored_job(job_id: str) -> dict | None:
    """The manual import's job row for ``job_id`` (its world's table), wherever it started."""
    import manual_import_handler

    table = manual_import_handler.aggregates_table
    assert table is not None
    return table.get_item(Key=manual_import_handler._job_key(job_id)).get('Item')


def _job_anywhere(job_id: str, not_found_message: str, context: Any = None) -> dict:
    """manual_import_handler.py ``_require_job`` without its check of where the job started."""
    from shared.exceptions import NotFoundError

    item = _stored_job(job_id)
    if not item:
        raise NotFoundError(not_found_message)
    return item


#: (module, the function that refuses a workspace's id deployment-wide, a stand-in without that refusal), by file.
_REFUSALS: dict[str, tuple[str, str, Callable[..., Any]]] = {
    'feedback_form_handler.py': ('feedback_form_handler', '_refuse_a_workspaces_id', lambda *_args: None),
    'manual_import_handler.py': ('manual_import_handler', '_require_job', _job_anywhere),
}


def test_every_route_that_refuses_a_workspaces_id_has_its_refusal_named():
    """The proof below takes each file's refusal out: a route of another file with ``deployment_ids`` needs its own."""
    assert _REFUSING
    assert {file for file, _ in _REFUSING} == set(_REFUSALS)


@pytest.mark.parametrize(('file', 'route'), _REFUSING)
def test_a_deployment_request_that_takes_a_workspaces_id_is_caught(file, route, lambda_context):
    """Without its refusal a deployment-wide request takes A's id (the deployment's copy there, or A's own row under a
    key every place shares): check 3 fails, so its proof that A's ids are refused as unknown ones is not vacuous."""
    module, name, stand_in = _REFUSALS[file]
    with WORLDS[file](lambda_context) as world, patch.object(importlib.import_module(module), name, stand_in), \
            pytest.raises(AssertionError,
                          match=r"changed a table|tells A's ids from unknown ones|not its known gap|with A data"):
        check_missing_header(world, CASES[(file, route)], route, ADA)


@pytest.mark.parametrize('route', ['POST /scrapers/manual/csv-upload', 'POST /scrapers/manual/json-upload'])
def test_an_import_inside_a_that_lands_in_the_deployment_is_caught(route, lambda_context):
    """An upload inside A whose rows are written as the deployment's (its scope dropped: the run in IMPORT_RUN, the
    raw copy under raw/): check 4 fails, though the answer is a 200 that holds nothing of B's."""
    import manual_import_handler

    with WORLDS['manual_import_handler.py'](lambda_context) as world, \
            patch.object(manual_import_handler, 'scope_of', lambda _context: None), \
            pytest.raises(AssertionError, match="changed rows that are not A's"):
        check_inside_a(world, CASES[('manual_import_handler.py', route)], route)


@pytest.mark.parametrize(('file', 'route', 'found'), [
    ('scrapers_handler.py', 'POST /scrapers', "changed rows that are not A's"),
    ('scrapers_handler.py', 'DELETE /scrapers/<scraper_id>', "changed rows that are not A's"),
    ('scrapers_handler.py', 'GET /scrapers', "the deployment's data"),
    ('integrations_handler.py', 'PUT /integrations/<source>/credentials', "changed rows that are not A's"),
    ('integrations_handler.py', 'GET /integrations/<source>/credentials', "the deployment's data"),
    ('integrations_handler.py', 'POST /integrations/<source>/apps', "changed rows that are not A's"),
    ('integrations_handler.py', 'GET /integrations/<source>/apps', "the deployment's data"),
    ('integrations_handler.py', 'GET /integrations/status', "the deployment's data"),
], ids=['a-scraper-save', 'a-scraper-delete', 'a-scraper-read', 'a-credentials-save', 'a-credentials-read',
        'a-connector-save', 'a-connector-read', 'the-credentials-status'])
def test_a_settings_store_opened_deployment_wide_inside_a_is_caught(file, route, found, lambda_context):
    """The request's settings store opened as the deployment's inside A (the shared secret, not A's parameters and
    rows): a save lands outside A, a delete of A's id removes the deployment's copy under it, and a read answers the
    deployment's settings (nothing of B's, but the world's deployment mark): check 4 fails for each."""
    from shared import workspace_request

    real = workspace_request.credentials_store

    def deployment_wide(_context: Any, clients: Any, plugins: Any = (), *, actor: Any) -> Any:
        return real(None, clients, plugins, actor=actor)

    with WORLDS[file](lambda_context) as world, \
            patch.object(workspace_request, 'credentials_store', deployment_wide), \
            pytest.raises(AssertionError, match=found):
        check_inside_a(world, CASES[(file, route)], route)


#: The metrics routes check 4 cannot tell from the deployment's in this world (cross_workspace_worlds.py
#: ``_METRICS_ALIKE_EVERYWHERE``): the static catalogue, and the caller's category scope (a recorded follow-up).
_METRICS_UNSEEN = {f'GET {path}' for path in _METRICS_ALIKE_EVERYWHERE}


@pytest.mark.parametrize('route', sorted(route for file, route in CASES
                                         if file == 'metrics_handler.py' and route not in _METRICS_UNSEEN))
def test_a_metrics_read_inside_a_without_its_scope_is_caught(route, lambda_context):
    """The metrics middleware keeping no scope (deployment-wide) inside A answers the deployment's reviews and
    counters, nothing of B's: check 4 fails, on the world's deployment mark or on the deployment's own answer."""
    import metrics_handler

    with WORLDS['metrics_handler.py'](lambda_context) as world, \
            patch.object(metrics_handler, '_request_scope', lambda: None), \
            pytest.raises(AssertionError, match="the deployment's data"):
        check_inside_a(world, CASES[('metrics_handler.py', route)], route)


def test_a_methods_clear_inside_a_without_its_scope_is_caught(lambda_context):
    """The learned methods' clear inside A acting deployment-wide removes the deployment's record of A's site (and
    writes no audit of A's): check 4 fails."""
    import integrations_handler

    route = 'DELETE /integrations/<source>/methods/<domain>'
    with WORLDS['integrations_handler.py'](lambda_context) as world, \
            patch.object(integrations_handler._request, 'scope', lambda: None), \
            pytest.raises(AssertionError, match="changed rows that are not A's"):
        check_inside_a(world, CASES[('integrations_handler.py', route)], route)


@pytest.mark.parametrize('verb', ['enable', 'disable'])
def test_a_schedule_switched_inside_a_is_caught(verb, lambda_context):
    """The schedule routes without their refusal in a workspace switch the one rule (and enable clears A's
    breaker): check 4 fails, as for a refusal that changed something or made a write."""
    import integrations_handler

    route = f'PUT /sources/<source>/{verb}'
    with WORLDS['integrations_handler.py'](lambda_context) as world, \
            patch.object(integrations_handler, 'refuse_in_workspace', lambda: None), \
            pytest.raises(AssertionError, match=r'changed a table|made a write|inside A: 200'):
        check_inside_a(world, CASES[('integrations_handler.py', route)], route)


def test_a_source_run_inside_a_whose_payload_names_no_place_is_caught(lambda_context):
    """Run now inside A whose ingestor payload carries no place on (the run would be the deployment's): check 4 fails;
    the run row is still A's, so only the payload shows it."""
    import integrations_handler

    route = 'POST /sources/<source>/run'
    with WORLDS['integrations_handler.py'](lambda_context) as world, \
            patch.object(integrations_handler, 'workspace_payload', lambda payload, _context: payload), \
            pytest.raises(AssertionError, match='carried another place on'):
        check_inside_a(world, CASES[('integrations_handler.py', route)], route)


def test_a_status_read_inside_a_of_the_deployments_run_is_caught(lambda_context):
    """The scraper's status read with no place inside A answers the deployment's run (its execution id holds the
    world's deployment mark): check 4 fails."""
    import scrapers_handler

    route = 'GET /scrapers/<scraper_id>/status'
    with WORLDS['scrapers_handler.py'](lambda_context) as world, \
            patch.object(scrapers_handler._request, 'scope', lambda: None), \
            pytest.raises(AssertionError, match="the deployment's data"):
        check_inside_a(world, CASES[('scrapers_handler.py', route)], route)


def test_the_mask_hides_only_the_requests_own_id():
    """``_unechoed`` reads the request's own id as ``{name}``, joined by ``_`` too (a run's ``run_{id}_{time}``),
    but never another value that only contains it, so B's data that merely holds that id still shows."""
    ids = {'scraper_id': f'{B_MARK}-reviews'}
    assert _unechoed({'id': f'run_{B_MARK}-reviews_1'}, ids) == {'id': 'run_{scraper_id}_1'}
    assert _holds_b(_unechoed({'id': f'{B_MARK}-reviews-2', 'name': f'{B_MARK} trail'}, ids))


_RUN = 'POST /scrapers/<scraper_id>/run'


@pytest.mark.parametrize('stand_in', [lambda payload, _context: payload,
                                      lambda payload, _context: {**payload, 'workspace_id': WS_B}],
                         ids=['a-payload-without-a', 'a-payload-naming-b'])
def test_a_run_inside_a_whose_payload_leaves_a_is_caught(stand_in, lambda_context):
    """A run inside A whose invoke payload carries no place on, or B: check 4 fails (the run row is still A's: the
    workspace layer itself refuses one written elsewhere, so only the payload can go wrong unseen)."""
    import scrapers_handler

    case = CASES[('scrapers_handler.py', _RUN)]
    with WORLDS['scrapers_handler.py'](lambda_context) as world, \
            patch.object(scrapers_handler, 'workspace_payload', stand_in), \
            pytest.raises(AssertionError, match=r'carried another place on|a double naming B'):
        check_inside_a(world, case, _RUN)


def test_b_ids_that_name_nothing_in_b_fail_check_5_when_a_refusal_looks_like_success(lambda_context):
    """The scraper's status answers 200 for any id: with B's id naming no run in B, check 5 fails (check 2 would
    otherwise have refused nothing real)."""
    route = 'GET /scrapers/<scraper_id>/status'
    case = CASES[('scrapers_handler.py', route)]
    hollow = replace(case, ids={**case.ids, 'B': {'scraper_id': f'{B_MARK}-never-ran'}})
    with WORLDS['scrapers_handler.py'](lambda_context) as world, pytest.raises(AssertionError, match='proves nothing'):
        check_b_ids_inside_b(world, hollow, route)


@pytest.mark.parametrize('route', ['GET /scrapers/manual/parse/<job_id>', 'POST /scrapers/manual/confirm'])
def test_a_deployment_job_taken_inside_a_workspace_is_caught(route, lambda_context):
    """``_require_job`` letting a job of no workspace through inside one (A's admin reads or confirms the
    deployment's): check 2 fails."""
    import manual_import_handler
    from shared.exceptions import NotFoundError

    def deployment_jobs_too(job_id: str, not_found_message: str, context: Any = None) -> dict:
        item = _stored_job(job_id)
        if not item or item.get('workspace_id') not in (context.ws if context is not None else None, None):
            raise NotFoundError(not_found_message)
        return item

    with WORLDS['manual_import_handler.py'](lambda_context) as world, \
            patch.object(manual_import_handler, '_require_job', deployment_jobs_too), \
            pytest.raises(AssertionError, match=r"changed a table|made a write|tells the deployment's ids"):
        check_other_workspace_ids(world, CASES[('manual_import_handler.py', route)], route, ADA)


@pytest.mark.parametrize('check', [check_other_workspace_ids, check_missing_header], ids=['check-2', 'check-3'])
def test_a_refusal_that_stops_repeating_its_ids_asks_for_its_note_to_go(check, lambda_context):
    """The job's status route with a fixed 404 (as the confirm's): checks 2 and 3 fail, naming ``echoes_its_ids``."""
    import manual_import_handler
    from shared.exceptions import NotFoundError

    real = manual_import_handler._require_job

    def fixed_text(job_id: str, not_found_message: str, context: Any = None) -> dict:
        try:
            return real(job_id, not_found_message, context)
        except NotFoundError:
            raise NotFoundError('Job not found') from None

    route = 'GET /scrapers/manual/parse/<job_id>'
    with WORLDS['manual_import_handler.py'](lambda_context) as world, \
            patch.object(manual_import_handler, '_require_job', fixed_text), \
            pytest.raises(AssertionError, match='drop its echoes_its_ids'):
        check(world, CASES[('manual_import_handler.py', route)], route, ADA)


@pytest.mark.parametrize(('refusal', 'found'), [
    (f'Form of {WS_A}', 'with A data'),
    ('Gone', 'not its known gap'),
], ids=['naming-a', 'another-answer'])
def test_a_known_gap_answering_otherwise_is_caught(refusal, found, lambda_context):
    """The form's delete without the header: any other refusal of A's id than its known gap's fails check 3 (a
    pinned pair, not "any two answers that differ"); one that names A fails as A data."""
    import feedback_form_handler
    from shared.exceptions import NotFoundError

    route = 'DELETE /feedback-forms/<form_id>'
    case = CASES[('feedback_form_handler.py', route)]
    real = feedback_form_handler._refuse_a_workspaces_id

    def answering_otherwise(form_id: str, failure_message: str) -> None:
        if form_id == case.ids['A']['form_id']:
            raise NotFoundError(refusal)
        real(form_id, failure_message)

    with WORLDS['feedback_form_handler.py'](lambda_context) as world, \
            patch.object(feedback_form_handler, '_refuse_a_workspaces_id', answering_otherwise), \
            pytest.raises(AssertionError, match=found):
        check_missing_header(world, case, route, ADA)


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
    every other). The one statement before that ``return`` counts the request's Bedrock calls to the deployment
    (shared/usage_meter.py ``attribute``: a context variable, no read or write)."""
    tree = ast.parse((API_DIR.parent / 'shared' / 'request_workspace.py').read_text(encoding='utf-8'))
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'request_workspace')
    docstring, guard, *rest = function.body
    assert isinstance(docstring, ast.Expr)
    assert ast.unparse(guard) == 'if not _names_a_workspace(event):\n    usage_meter.attribute(None)\n    return None'
    function.body = [docstring, *rest]
    assert 'request_workspace' in resolving_functions(tree)[0]


def test_the_mcp_credentials_resolver_resolves_first():
    """shared/mcp_workspace_pin.py ``pinned_workspace`` counts as a resolver: its first statement calls
    ``request_workspace`` (imported from its own module), so the detector finds it resolving first, and would not if
    that call went."""
    tree = ast.parse((API_DIR.parent / 'shared' / 'mcp_workspace_pin.py').read_text(encoding='utf-8'))
    assert 'pinned_workspace' in resolving_functions(tree)[0]
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'pinned_workspace')
    function.body = [function.body[0], ast.Return(value=ast.Constant(value=None))]
    assert 'pinned_workspace' not in resolving_functions(tree)[0]


def _method(tree: ast.Module, cls: str, name: str) -> ast.FunctionDef:
    klass = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == cls)
    return next(node for node in klass.body if isinstance(node, ast.FunctionDef) and node.name == name)


def test_the_data_path_resolver_resolves_first():
    """shared/workspace_request.py ``RequestWorkspace.context`` counts as a resolver: after its docstring, its one
    guard answers ``None`` for a request that names no workspace before any read or write (the deployment as before;
    check 3 runs that path), and every other path resolves first (``resolve_workspace``, in a ``try`` whose handler
    only logs and re-raises); ``scope``'s first statement is ``context``. Either change would fail here."""
    tree = ast.parse((API_DIR.parent / 'shared' / 'workspace_request.py').read_text(encoding='utf-8'))
    context = _method(tree, 'RequestWorkspace', 'context')
    docstring, guard, *rest = context.body
    assert isinstance(docstring, ast.Expr)
    assert ast.unparse(guard) == 'if not names_a_workspace(event):\n    return None'
    # The guard's own test: a header that is there, empty or not, is never read as "no header".
    names = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'names_a_workspace')
    assert ast.unparse(names.body[-1]) == 'return request_header(event, WORKSPACE_HEADER) is not None'
    # The real module, with the method's body after its guard lifted to a module function: it resolves first through
    # the module's own import of the resolver (from shared/workspace.py, never rebound there).
    tree.body.append(ast.FunctionDef(name='lifted_context', args=context.args, body=[docstring, *rest],
                                     decorator_list=[], returns=None, type_params=[]))
    ast.fix_missing_locations(tree)
    assert 'lifted_context' in resolving_functions(tree)[0]
    scope = _method(tree, 'RequestWorkspace', 'scope')
    assert ast.unparse(scope.body[1]) == 'context = self.context(event)'


_INSTANCE = 'from shared.workspace_request import RequestWorkspace\n\n_workspace = RequestWorkspace()\n\n\n'


@pytest.mark.parametrize(('source', 'resolves'), [
    (_INSTANCE + '@app.put("/x")\ndef r():\n    context = _workspace.context(e, fresh=True)\n    return {}\n', True),
    (_INSTANCE + '@app.get("/x")\ndef r():\n    scope = _workspace.scope(e)\n    return {}\n', True),
    (_INSTANCE + 'def _scope(e):\n    context = _workspace.context(e)\n    if context is None:\n        return None\n'
     '    return context\n\n\n@app.get("/x")\ndef r():\n    s = _scope(e)\n    return {}\n', True),
    (_INSTANCE + '@app.get("/x")\ndef r():\n    t.put_item(Item=i)\n    _workspace.context(e)\n', False),
    (_INSTANCE + '@app.get("/x")\ndef r():\n    _workspace.memberships(e)\n    return {}\n', False),
    (_INSTANCE + '_workspace = other\n\n\n@app.get("/x")\ndef r():\n    _workspace.context(e)\n', False),
    (_INSTANCE + '@app.get("/x")\ndef r(_workspace=noop):\n    _workspace.context(e)\n', False),
    (_INSTANCE.replace('import RequestWorkspace', 'import RequestWorkspace as R').replace('= RequestWorkspace', '= R')
     + '@app.get("/x")\ndef r():\n    _workspace.context(e)\n', False),
    (_INSTANCE.replace('shared.workspace_request', 'shared.other')
     + '@app.get("/x")\ndef r():\n    _workspace.context(e)\n', False),
    (_INSTANCE + '@app.get("/x")\ndef r():\n    if q:\n        _workspace.context(e)\n    return {}\n', False),
    (_INSTANCE + 'from x import y as _workspace\n\n\n@app.get("/x")\ndef r():\n    _workspace.context(e)\n', False),
    (_INSTANCE + 'def _workspace():\n    return 1\n\n\n@app.get("/x")\ndef r():\n    _workspace.context(e)\n', False),
    (_INSTANCE + 'try:\n    pass\nexcept E as _workspace:\n    pass\n\n\n'
     '@app.get("/x")\ndef r():\n    _workspace.context(e)\n', False),
    (_INSTANCE + '_workspace.context = noop\n\n\n@app.get("/x")\ndef r():\n    _workspace.context(e)\n', False),
    (_INSTANCE + '_workspace._table.get_item = noop\n\n\n@app.get("/x")\ndef r():\n    _workspace.context(e)\n', False),
    (_INSTANCE + "setattr(_workspace, 'context', noop)\n\n\n@app.get(\"/x\")\ndef r():\n    _workspace.context(e)\n",
     False),
    (_INSTANCE.replace('_workspace = RequestWorkspace()', 'RequestWorkspace = Fake\n_workspace = RequestWorkspace()')
     + '@app.get("/x")\ndef r():\n    _workspace.context(e)\n', False),
    (_INSTANCE + 'def f():\n    global _workspace\n    _workspace = other\n\n\n'
     '@app.get("/x")\ndef r():\n    _workspace.context(e)\n', False),
], ids=['context', 'scope', 'a-helper-whose-none-is-the-deployment', 'write-before', 'not-a-resolving-method',
        'rebound', 'shadowed-by-a-parameter', 'aliased-class', 'another-module', 'conditional', 'rebound-by-an-import',
        'rebound-by-a-def', 'rebound-by-an-except', 'a-method-replaced', 'an-inner-object-replaced',
        'a-method-replaced-by-setattr', 'the-class-rebound', 'rebound-by-a-global'])
def test_the_detector_reads_the_data_path_resolver_only_where_listed(source, resolves):
    assert routes_resolving_the_workspace(source, instance_resolvers=True) == {f'{source.split("@app.")[1][:3].upper()} /x': resolves}
    # A file not in INSTANCE_RESOLVER_FILES: its instance is not read (the route stays pending).
    assert routes_resolving_the_workspace(source) == {f'{source.split("@app.")[1][:3].upper()} /x': False}


def test_the_routes_resolver_resolves_first():
    """shared/workspace_request.py ``ResolvedRoutes.middleware`` counts as the resolver before every route of a module
    that installs it first: after its docstring it reads the event and then the request's membership through its
    ``RequestWorkspace`` (``context``, which resolves first: the test above), before the route runs; its
    ``workspace`` is set only in ``__init__``, to a new ``RequestWorkspace`` when none is passed in (the detector
    reads only ``ResolvedRoutes(app)``, passing none), and nothing else of the class sets it."""
    tree = ast.parse((API_DIR.parent / 'shared' / 'workspace_request.py').read_text(encoding='utf-8'))
    middleware = _method(tree, ROUTES_RESOLVER[1], ROUTES_RESOLVER_MIDDLEWARE)
    docstring, *rest = middleware.body
    assert isinstance(docstring, ast.Expr)
    assert [ast.unparse(stmt) for stmt in rest] == [
        'event = resolver.current_event',
        "context = self.workspace.context(event.raw_event, fresh=event.http_method != 'GET')",
        'resolver.append_context(**{WORKSPACE_CONTEXT_KEY: context})',
        'return next_middleware(resolver)']
    klass = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == ROUTES_RESOLVER[1])
    sets = [(fn.name, ast.unparse(node)) for fn in klass.body if isinstance(fn, ast.FunctionDef)
            for node in ast.walk(fn) if isinstance(node, ast.Assign | ast.AnnAssign | ast.AugAssign)
            and any(isinstance(t, ast.Attribute) and t.attr == 'workspace'
                    for t in (node.targets if isinstance(node, ast.Assign) else [node.target]))]
    assert sets == [('__init__', 'self.workspace = workspace if workspace is not None else RequestWorkspace()')]


#: Every line (after its docstring) of each function a ``PINNED_MIDDLEWARES`` entry stands on, by file and function.
_PINNED_BODIES: dict[str, dict[str, list[str]]] = {
    'metrics_handler.py': {
        # The middleware: the request's scope, resolved afresh, kept for this request only.
        '_workspace_first': ['resolver.append_context(**{WORKSPACE_CONTEXT_KEY: _request_scope()})',
                             'return next_middleware(resolver)'],
        # The resolution: the module's RequestWorkspace (``scope`` resolves first: test above) on the current
        # event; outside a request (no event) None, which a request never is.
        '_request_scope': ["event = getattr(app, 'current_event', None)",
                           "raw = getattr(event, 'raw_event', None) if event is not None else None",
                           'return _workspace.scope(raw) if isinstance(raw, dict) else None'],
        # What every route reads: the value the middleware kept, or a 500, never a fresh or a deployment-wide one.
        '_ws_scope': ['if WORKSPACE_CONTEXT_KEY not in app.context:\n    raise WorkspaceNotResolved(WORKSPACE_NOT_RESOLVED)',
                      'return app.context[WORKSPACE_CONTEXT_KEY]'],
    },
}


#: The module-level names a pinned middleware's lines read, beside its functions: each must be bound once.
_PINNED_NAMES = ('app', '_workspace', 'WORKSPACE_CONTEXT_KEY', 'WORKSPACE_NOT_RESOLVED', 'WorkspaceNotResolved')
#: Names the pinned lines read that the module must never bind at all (builtins: a module-level one would shadow it).
_PINNED_BUILTINS = ('getattr', 'isinstance')
#: Each pinned function's parameters, as written.
_PINNED_PARAMETERS: dict[str, dict[str, str]] = {
    'metrics_handler.py': {'_workspace_first': 'resolver: Any, next_middleware: Any', '_request_scope': '',
                           '_ws_scope': ''},
}


@pytest.mark.parametrize('file', sorted(PINNED_MIDDLEWARES))
def test_the_pinned_middlewares_resolve_first(file):
    """A ``PINNED_MIDDLEWARES`` module: its first middleware is the one named, its functions read exactly as pinned
    (any change fails here, to be read again before the pin is), and its ``_workspace`` is a ``RequestWorkspace``
    bound once, never changed (``_instances``)."""
    tree = ast.parse((API_DIR / file).read_text(encoding='utf-8'))
    assert first_app_middleware(tree) == PINNED_MIDDLEWARES[file]
    functions = _module_functions(tree)
    for name, lines in _PINNED_BODIES[file].items():
        fn = functions[name]
        docstring, *rest = fn.body
        assert isinstance(docstring, ast.Expr)
        assert isinstance(docstring.value, ast.Constant)
        assert [ast.unparse(stmt) for stmt in rest] == lines, name
        # The whole function, not its body alone: no decorator (an `@cache` would keep the first request's scope for
        # every later one) and the parameters as pinned.
        assert (fn.decorator_list, ast.unparse(fn.args)) == ([], _PINNED_PARAMETERS[file][name]), name
    assert _instances(tree, INSTANCE_RESOLVER) == {'_workspace'}
    assert set(_PINNED_BODIES) == set(PINNED_MIDDLEWARES)
    # Each name the pinned lines stand on is bound once, so no later binding replaces it at run time.
    names = [*_PINNED_BODIES[file], *_PINNED_NAMES]
    bindings = _bindings(tree)
    assert {name: bindings.get(name) for name in names} == dict.fromkeys(names, 1)
    assert [name for name in _PINNED_BUILTINS if name in bindings] == []
    # No write into a context by a method or an operator either (``app.context.update(…)``, ``|=``).
    assert not [ast.unparse(node) for node in ast.walk(tree)
                if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and ast.unparse(node.func.value).endswith('.context')
                    and node.func.attr in {'update', 'setdefault', '__setitem__', 'pop', 'clear'})
                or (isinstance(node, ast.AugAssign) and ast.unparse(node.target).endswith('context'))]
    # Only the middleware keeps the request's scope on the context: no other append_context names its key (by the
    # constant or the key's text), no item is stored into a context, and the key's text is written once, where it is
    # named.
    key = next(node.value.value for node in tree.body if isinstance(node, ast.Assign)
               and isinstance(node.value, ast.Constant) and [ast.unparse(t) for t in node.targets] == [
                   'WORKSPACE_CONTEXT_KEY'])
    stores = [ast.unparse(node) for node in ast.walk(tree) if isinstance(node, ast.Call)
              and isinstance(node.func, ast.Attribute) and node.func.attr == 'append_context'
              and ('WORKSPACE_CONTEXT_KEY' in ast.unparse(node) or any(kw.arg == key for kw in node.keywords)
                   or any(kw.arg is None for kw in node.keywords))]
    assert stores == ['resolver.append_context(**{WORKSPACE_CONTEXT_KEY: _request_scope()})']
    assert not [node for node in ast.walk(tree) if isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Store)
                and ast.unparse(node.value).endswith('context')]
    assert len([node for node in ast.walk(tree) if isinstance(node, ast.Constant) and node.value == key]) == 1


def test_a_pinned_middleware_counts_only_where_named_and_installed_first():
    source = ('def _first(resolver, nxt):\n    """."""\n    return nxt(resolver)\n\n\n'
              'app.use(middlewares=[_first])\n\n\n@app.get("/x")\ndef r():\n    return {}\n')
    assert routes_resolving_the_workspace(source, pinned_middleware='_first') == {'GET /x': True}
    assert routes_resolving_the_workspace(source) == {'GET /x': False}
    assert routes_resolving_the_workspace(source, pinned_middleware='_other') == {'GET /x': False}
    later = source.replace('middlewares=[_first]', 'middlewares=[log, _first]')
    assert routes_resolving_the_workspace(later, pinned_middleware='_first') == {'GET /x': False}


_ROUTES = 'from shared.workspace_request import ResolvedRoutes\n\n_request = ResolvedRoutes(app)\n'
_FIRST = 'app.use(middlewares=[_request.middleware])\n\n\n'
_ROUTE = '@app.get("/x")\ndef r():\n    return {}\n'


@pytest.mark.parametrize(('source', 'resolves'), [
    (_ROUTES + _FIRST + _ROUTE, True),
    (_ROUTES + "_request.clients = lambda: 'clients'\n" + _FIRST + _ROUTE, True),
    (_ROUTES + 'app.use(middlewares=[log, _request.middleware])\n\n\n' + _ROUTE, False),
    (_ROUTES + 'app.use(middlewares=[_request.require_request_admin])\n\n\n' + _ROUTE, False),
    (_ROUTES + '_request.middleware = noop\n' + _FIRST + _ROUTE, False),
    (_ROUTES + '_request.workspace = other\n' + _FIRST + _ROUTE, False),
    (_ROUTES.replace('ResolvedRoutes(app)', 'ResolvedRoutes(app, fake)') + _FIRST + _ROUTE, False),
    (_ROUTES.replace('ResolvedRoutes(app)', 'ResolvedRoutes(app, workspace=fake)') + _FIRST + _ROUTE, False),
    (_ROUTES.replace('ResolvedRoutes(app)', 'ResolvedRoutes(*args)') + _FIRST + _ROUTE, False),
    (_ROUTES + '_request = other\n' + _FIRST + _ROUTE, False),
    (_ROUTES.replace('import ResolvedRoutes', 'import ResolvedRoutes as R').replace('= ResolvedRoutes', '= R')
     + _FIRST + _ROUTE, False),
    (_ROUTES.replace('shared.workspace_request', 'shared.other') + _FIRST + _ROUTE, False),
    (_ROUTES + 'other.use(middlewares=[_request.middleware])\n\n\n' + _ROUTE, False),
    (_ROUTES + '_request.workspace.context = noop\n' + _FIRST + _ROUTE, False),
    (_ROUTES + '_request.workspace._table = other\n' + _FIRST + _ROUTE, False),
    (_ROUTES + "setattr(_request, 'workspace', other)\n" + _FIRST + _ROUTE, False),
    (_ROUTES + "vars(_request)['workspace'] = other\n" + _FIRST + _ROUTE, False),
    (_ROUTES + "delattr(_request.workspace, 'context')\n" + _FIRST + _ROUTE, False),
    (_ROUTES + '_request.clients.x = other\n' + _FIRST + _ROUTE, False),
    (_ROUTES.replace('ResolvedRoutes(app)', 'ResolvedRoutes(other)') + _FIRST + _ROUTE, False),
    (_ROUTES.replace('ResolvedRoutes(app)', 'ResolvedRoutes()') + _FIRST + _ROUTE, False),
], ids=['installed-first', 'its-clients-set', 'not-first', 'another-method-first', 'its-middleware-replaced',
        'its-workspace-replaced', 'a-workspace-passed', 'a-workspace-passed-by-name', 'unpacked-arguments', 'rebound',
        'aliased-class', 'another-module', 'another-resolver', 'its-workspace-method-replaced',
        'its-workspace-table-replaced', 'set-by-setattr', 'set-through-vars', 'deleted-by-delattr',
        'inside-its-clients', 'another-resolver-passed', 'no-resolver-passed'])
def test_the_detector_reads_the_routes_resolver_only_where_listed(source, resolves):
    assert routes_resolving_the_workspace(source, instance_resolvers=True) == {'GET /x': resolves}
    # A file not in INSTANCE_RESOLVER_FILES: its object is not read (its routes stay pending).
    assert routes_resolving_the_workspace(source) == {'GET /x': False}


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
