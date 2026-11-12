"""The cross-workspace suite (docs/multi-workspace.md, Phases: a guard kept green from phase 1 on).

Every workspace-scoped route, one registry of them (``WORKSPACE_SCOPED_ROUTES``), is called by a member of
workspace A naming workspace B and by callers in no workspace of the two, and answers the one 404 with the same body
as for an id that names no workspace and for a malformed one: nothing tells another team's workspace from no
workspace, Cognito is not called once, and nothing is written or audited. A member of A naming B's member on PUT or
DELETE, inside A, gets the members' 404, the same as for a sub that is no one's. A platform admin is the one caller
who may enter any workspace (decision 2, live-checked and audited: test_workspaces_members_routes.py).

The registry is checked against the code: every route in lambda/ (on any router) whose function resolves the
workspace (``resolve_workspace``, directly or through helpers in any module, followed through imports, aliases and
module attributes), and every route served under ``/me/workspaces/current``, must be in it, so a new route cannot
skip this suite. Phase 2 adds the data routes here.
"""
import ast
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

import workspaces_handler
from shared.test.cognito_doubles import live_cognito
from shared.workspace import NOT_FOUND, MembershipCache
from shared.workspace_members import MEMBER_NOT_FOUND

API_DIR = Path(__file__).resolve().parent.parent
SCOPED_PREFIX = '/me/workspaces/current'

ACME = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
JUNIPER = 'ws_01JC4R9ZM7W8X0Y3Z5B6C7D8E9'
NOWHERE = 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'
ADA = {'sub': 'sub-ada', 'cognito:username': 'ada', 'cognito:groups': 'users'}         # Acme's admin
VIC = {'sub': 'sub-vic', 'cognito:username': 'vic', 'cognito:groups': 'users'}         # Acme's viewer
SAM = {'sub': 'sub-sam', 'cognito:username': 'sam', 'cognito:groups': 'users'}         # in no workspace
NOR = {'sub': 'sub-nor', 'cognito:username': 'nor', 'cognito:groups': 'admins'}        # the deployment's admins only
BEA = 'sub-bea'   # Juniper's admin
WORKSPACE_404 = (404, {'success': False, 'error': NOT_FOUND})


@dataclass(frozen=True)
class ScopedRoute:
    """A route that acts in the workspace ``X-Workspace-Id`` names, with a body it accepts (so its 404 comes from
    the workspace, never from the body)."""

    handler: str
    method: str
    path: str
    body: dict[str, Any] | None = None

    @property
    def key(self) -> tuple[str, str, str]:
        return self.handler, self.method, self.path

    def url(self, sub: str) -> str:
        return self.path.replace('<sub>', sub)


#: Every workspace-scoped route. Phase 2 adds the data routes here (test_the_registry_covers_every_scoped_route).
WORKSPACE_SCOPED_ROUTES = (
    ScopedRoute('workspaces_handler.py', 'GET', '/me/workspaces/current'),
    ScopedRoute('workspaces_handler.py', 'GET', '/me/workspaces/current/members'),
    ScopedRoute('workspaces_handler.py', 'POST', '/me/workspaces/current/members',
                {'email': 'bea@example.com', 'role': 'viewer'}),
    ScopedRoute('workspaces_handler.py', 'PUT', '/me/workspaces/current/members/<sub>', {'role': 'viewer'}),
    ScopedRoute('workspaces_handler.py', 'DELETE', '/me/workspaces/current/members/<sub>'),
)
MEMBER_ROUTES = [route for route in WORKSPACE_SCOPED_ROUTES if '<sub>' in route.path]


@dataclass
class World:
    table: Any
    cognito: MagicMock


@pytest.fixture
def world() -> Iterator[World]:
    cognito = live_cognito()
    with mock_aws(), patch.object(workspaces_handler, 'memberships', MembershipCache()), \
            patch.object(workspaces_handler, 'USER_POOL_ID', 'us-east-1_pool'), \
            patch.object(workspaces_handler, 'get_cognito_idp_client', return_value=cognito):
        table = pk_sk_table('workspaces')
        for ws, name, slug, members in ((ACME, 'Acme Outfitters', 'acme', (('sub-ada', 'admin'), ('sub-vic', 'viewer'))),
                                        (JUNIPER, 'Juniper Trail Co.', 'juniper', ((BEA, 'admin'), ('sub-ben', 'editor')))):
            table.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'name': name, 'slug': slug, 'status': 'active'})
            for sub, role in members:
                table.put_item(Item={'pk': f'WS#{ws}', 'sk': f'MEMBER#{sub}', 'role': role})
                table.put_item(Item={'pk': f'USER#{sub}', 'sk': f'WS#{ws}', 'name': name, 'slug': slug, 'role': role})
        yield World(table, cognito)


def _call(world: World, lambda_context, route: ScopedRoute, claims: dict, ws: str, sub: str = BEA):
    event = rest_event(route.method, route.url(sub), claims=claims, body=route.body)
    event['headers']['X-Workspace-Id'] = ws
    return invoke(workspaces_handler, event, lambda_context, workspaces=world.table)


def _rows(world: World) -> list[dict]:
    return sorted(world.table.scan()['Items'], key=lambda item: (item['pk'], item['sk']))


def _route_id(route: ScopedRoute) -> str:
    return f'{route.method} {route.path}'


# ── Another workspace's id: the one 404, revealing nothing ───────────────────

@pytest.mark.parametrize('route', WORKSPACE_SCOPED_ROUTES, ids=_route_id)
@pytest.mark.parametrize('claims', [ADA, VIC, SAM, NOR], ids=['acme-admin', 'acme-viewer', 'no-member', 'deployment-admin'])
def test_naming_another_workspace_answers_the_one_404(world, lambda_context, route, claims):
    before = _rows(world)
    answers = {ws: _call(world, lambda_context, route, claims, ws) for ws in (JUNIPER, NOWHERE, 'juniper')}
    # Juniper's id answers exactly as an id that names no workspace and as a malformed one.
    assert answers == {JUNIPER: WORKSPACE_404, NOWHERE: WORKSPACE_404, 'juniper': WORKSPACE_404}
    assert _rows(world) == before   # nothing written, no audit row
    assert world.cognito.mock_calls == []   # not one Cognito call


@pytest.mark.parametrize('route', MEMBER_ROUTES, ids=_route_id)
def test_naming_another_workspaces_member_inside_your_own_answers_the_members_404(world, lambda_context, route):
    before = _rows(world)
    # Acme's admin names Juniper's admin, in Acme: the same 404 as for a sub that is no one's.
    assert _call(world, lambda_context, route, ADA, ACME, sub=BEA) == (404, {'success': False, 'error': MEMBER_NOT_FOUND})
    assert _call(world, lambda_context, route, ADA, ACME, sub='sub-nobody') == (
        404, {'success': False, 'error': MEMBER_NOT_FOUND})
    assert _rows(world) == before


# ── The registry is the code's list ──────────────────────────────────────────
#
# A function "resolves the workspace" when it calls shared/workspace.py resolve_workspace, or a function that does,
# in any module of lambda/ (shared/ included): calls are resolved through the module's own functions, `from … import
# … as …`, `import … as …` and dotted module attributes. A route is any `@<router>.<verb>('/path')` decorator.

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


def _routes(fn: _Function) -> list[tuple[str, str]]:
    """(METHOD, path) of every ``@<router>.<verb>('/path')`` decorator of ``fn``."""
    return [(decorator.func.attr.upper(), path) for decorator in fn.decorator_list
            if isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute)
            and decorator.func.attr in VERBS and decorator.args and isinstance(decorator.args[0], ast.Constant)
            and isinstance(path := decorator.args[0].value, str) and path.startswith('/')]


def scoped_routes(lambda_dir: Path) -> set[tuple[str, str, str]]:
    """(file name, METHOD, path) of every route in ``lambda_dir`` whose function resolves the workspace, or that is
    served under /me/workspaces/current."""
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
    # function resolves the workspace when it calls a resolver itself.
    return {(module.file.name, method, path)
            for name, module in modules.items()
            for fn in ast.walk(module.tree) if isinstance(fn, _Function)
            for method, path in _routes(fn)
            if (name, fn.name) in resolvers or _callees(name, module, fn) & resolvers
            or path.startswith(SCOPED_PREFIX)}


def test_the_registry_covers_every_scoped_route():
    found = scoped_routes(API_DIR.parent)
    registry = {route.key for route in WORKSPACE_SCOPED_ROUTES}
    assert sorted(found - registry) == [], 'a workspace-scoped route is missing from WORKSPACE_SCOPED_ROUTES'
    assert sorted(registry - found) == [], 'WORKSPACE_SCOPED_ROUTES lists a route the code does not serve'


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
    }
    for rel, text in files.items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(text, encoding='utf-8')
    assert scoped_routes(tmp_path) == {('boards_routes.py', 'GET', '/boards'), ('votes_handler.py', 'POST', '/votes'),
                                       ('polls_handler.py', 'GET', '/polls'), ('polls_handler.py', 'GET', '/surveys'),
                                       ('forms_handler.py', 'GET', '/forms'), ('forms_handler.py', 'GET', '/answers'),
                                       ('ballot_routes.py', 'GET', '/ballots'), ('ballot_routes.py', 'GET', '/tallies')}
