"""Every mutating API route is either admin-gated or open by a recorded decision (#242).

#242's acceptance asks for "a test per privileged route". This module is that test
as an inventory: it parses every `lambda/api/*_handler.py` with `ast`, lists every
`@app.post/put/patch/delete("<path>")` route, and holds each one against two
explicit tables kept below:

* ``ADMIN_ONLY``: the route must be gated STRUCTURALLY, which means one of these:
  - the handler body has an unconditional top-level statement calling a shared
    gate primitive: ``require_admin`` (``shared.api``, from the event) or
    ``require_admin_caller`` (``shared.project_gate``, an admin not acting through a
    delegated credential) or ``require_board_admin`` (``shared.engagement_identity``, an
    app-pool admin on the feedback boards);
  - that statement calls a module helper that does so itself (to any depth); a
    helper also counts when it is a check, i.e. a top-level ``if`` that tests
    ``.is_admin`` and raises ``AuthorizationError``, like `project_gate.require_admin_caller`;
  - the module installs such a function as an ``app.use(middlewares=[...])``
    middleware, like `shared.api.admins_only` in `data_explorer_handler`.

  A gate that only runs inside an ``if``/``try``/loop or a nested function does NOT
  count. Drop the gate and the route fails here.
* ``OPEN_BY_DECISION``: the route is deliberately open to every signed-in caller
  (or to the public). Each group carries a one-line reason, and a route listed
  here must NOT carry an admin gate. If it gains one, move it to ``ADMIN_ONLY`` so
  the tables stay true.

A new mutating route that is in neither table fails with a message telling its
author to classify it. A table entry naming a route that no longer exists fails
too, so the tables cannot rot.
"""
import ast
from collections import Counter
from dataclasses import dataclass
from functools import cache
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parent.parent
GATE_PRIMITIVE = 'require_admin'
# Shared gates by name. Each one outside this file is itself checked structurally below
# (test_every_shared_gate_primitive_is_an_admin_check), so a name here cannot hide a non-gate.
# `require_board_admin` (``shared.engagement_identity``): an app-pool admin on the feedback boards' routes.
GATE_PRIMITIVES = frozenset({GATE_PRIMITIVE, 'require_admin_caller', 'require_board_admin'})
# Shared resolver middlewares that gate a whole module (checked the same way, below).
GATE_MIDDLEWARES = frozenset({'admins_only'})
SHARED_DIR = API_DIR.parent / 'shared'
MUTATING_METHODS = frozenset({'post', 'put', 'patch', 'delete'})
# Top-level statements whose `.value` call runs unconditionally: `f()`, `x = f()`, `x: T = f()`, `return f()`.
_VALUE_STATEMENTS = (ast.Expr, ast.Assign, ast.AnnAssign, ast.Return)

# Handlers that are not Powertools resolvers, so they have no `@app.<method>` routes to inventory.
NON_RESOLVER_HANDLERS = {
    # POST /mcp/global is a raw JSON-RPC entry point authenticated by a global MCP token. Its tools
    # invoke the domain Lambdas AS the minting user (never admin), so those Lambdas' own gates apply.
    'mcp_global_handler.py': 'token-authenticated JSON-RPC; tools act as the minter through the gated domain APIs',
}

ADMIN_ONLY: dict[str, frozenset[str]] = {
    'agents_handler.py': frozenset({
        'POST /agents', 'PUT /agents/<agent_id>', 'DELETE /agents/<agent_id>',
        'POST /agents/<agent_id>/enable', 'POST /agents/<agent_id>/disable',
        # Run and cancel also admit a global-MCP write token whose admin minter still backs it.
        'POST /agents/<agent_id>/run', 'POST /agents/<agent_id>/runs/<run_id>/cancel',
        # A human's decision on a needs_human run: admins only, never a delegated credential.
        'POST /agents/<agent_id>/runs/<run_id>/decision',
        'POST /workflows', 'PUT /workflows/<workflow_id>',
        'POST /workflows/<workflow_id>/duplicate', 'POST /workflows/<workflow_id>/rename',
        'DELETE /workflows/<workflow_id>',
    }),
    'data_explorer_handler.py': frozenset({'PUT /data-explorer/s3', 'PUT /data-explorer/feedback'}),
    # Company personas (owner decision, 5.60.00): only admins write the library; promote copies into it.
    'company_personas_routes.py': frozenset({
        'POST /company-personas/generate', 'POST /company-personas/import',
        'PUT /company-personas/<persona_id>', 'DELETE /company-personas/<persona_id>',
        'POST /company-personas/<persona_id>/notes', 'POST /company-personas/<persona_id>/regenerate-avatar',
    }),
    'persona_copy_routes.py': frozenset({'POST /projects/<project_id>/personas/<persona_id>/promote'}),
    # Feature-request board (docs/feature-requests.md): board admin = an app-pool admin, never a board-pool user.
    'feature_requests_routes.py': frozenset({
        'PUT /feature-requests/<request_id>/status', 'DELETE /feature-requests/<request_id>',
        'POST /feature-requests/<request_id>/promote',
    }),
    # Feedback boards (docs/feature-requests.md, owner decision 2026-10-26): only admins create, configure and delete.
    'feature_boards_routes.py': frozenset({
        'POST /feature-requests/boards', 'PUT /feature-requests/boards/<board_ref>',
        'DELETE /feature-requests/boards/<board_ref>',
    }),
    'integrations_handler.py': frozenset({
        'PUT /integrations/<source>/credentials', 'POST /integrations/<source>/apps',
        'DELETE /integrations/<source>/apps/<app_id>', 'POST /sources/<source>/run',
        'PUT /sources/<source>/enable', 'PUT /sources/<source>/disable', 'POST /sources/<source>/reset',
    }),
    'logs_handler.py': frozenset({
        'DELETE /logs/validation/<source>',
        # Alerting (Settings → Logs → Alerts): creates/deletes billed CloudWatch alarms and SNS recipients.
        'PUT /logs/alerts', 'POST /logs/alerts/recipients', 'POST /logs/alerts/recipients/remove',
    }),
    # Owner decision 2026-10-08 (#242 follow-up): importing data is admin-only (module middleware).
    'manual_import_handler.py': frozenset({
        'POST /scrapers/manual/parse', 'POST /scrapers/manual/confirm',
        'POST /scrapers/manual/csv-upload', 'POST /scrapers/manual/json-upload',
    }),
    # Participants (docs/participants.md): engagement settings, deleting a list, erasing a person.
    'participants_routes.py': frozenset({
        'PUT /participants/settings', 'DELETE /participants/lists/<list_id>', 'DELETE /participants/people/<person_id>',
    }),
    'projects_handler.py': frozenset({
        'DELETE /projects/prioritization/rows/<row_id>',
        # The workspace-wide scoring setup (docs/prioritization.md): every reviewer scores with it.
        'PUT /projects/prioritization/config',
    }),
    # Radar (docs/radar.md): the release-scan cost guards and "Scan now" (web search + Bedrock spend).
    'radar_handler.py': frozenset({'PUT /radar/settings', 'POST /radar/scan', 'PUT /radar/brands'}),
    # Radar's Exa key (docs/radar.md): a paid third-party search account's credential.
    'radar_exa_routes.py': frozenset({'PUT /radar/settings/exa-key', 'DELETE /radar/settings/exa-key'}),
    's3_import_handler.py': frozenset({  # owner decision 2026-10-08 (#242 follow-up), module middleware
        'POST /s3-import/sources', 'POST /s3-import/upload-url', 'DELETE /s3-import/file/<key>',
        'POST /s3-import/reprocess',  # re-runs a file through the ingestor (issue #144)
    }),
    'scrapers_handler.py': frozenset({
        'POST /scrapers', 'DELETE /scrapers/<scraper_id>', 'POST /scrapers/<scraper_id>/run',
        'POST /scrapers/analyze-url',
    }),
    'settings_handler.py': frozenset({
        'PUT /settings/model', 'POST /settings/model/test',
        'PUT /settings/brand',  # owner decision 2026-10-08, #242
        'PUT /settings/categories',
        'POST /settings/categories/generate',  # owner decision 2026-10-08, #242 (Bedrock spend)
        'POST /settings/categories/reprocess', 'POST /settings/categories/reprocess/<job_id>/cancel',
        'PUT /settings/company-context', 'PUT /settings/design-system/integrations',
        'POST /settings/design-system/logo', 'PUT /settings/design-system',
        'POST /settings/design-system/references', 'POST /settings/design-system/references/<ref_id>/refresh',
        # Wave 12: build an unsaved draft from a reference, and download its logo candidate (outbound fetch).
        'POST /settings/design-system/references/<ref_id>/apply', 'POST /settings/design-system/references/<ref_id>/logo',
        'DELETE /settings/design-system/references/<ref_id>', 'PUT /settings/dimensions',
        'PUT /settings/sources', 'POST /settings/erasure',
        'PUT /settings/email-inbox', 'POST /settings/email-inbox/feedback-type-dimension',
    }),
    'users_handler.py': frozenset({
        'POST /users', 'PUT /users/<username>', 'PUT /users/<username>/group',
        'POST /users/<username>/reset-password', 'PUT /users/<username>/enable',
        'PUT /users/<username>/disable', 'DELETE /users/<username>',
        'PUT /users/<username>/category-access', 'PUT /users/<username>/flags',
    }),
}


@dataclass(frozen=True)
class OpenGroup:
    """Routes of one handler that are open for one recorded reason."""

    reason: str
    handler: str
    routes: frozenset[str]


def _open(reason: str, handler: str, *routes: str) -> OpenGroup:
    return OpenGroup(reason, handler, frozenset(routes))


OPEN_BY_DECISION: tuple[OpenGroup, ...] = (
    _open('stateless: validates a posted workflow definition, reads and writes nothing',
          'agents_handler.py', 'POST /workflows/validate'),
    _open("plans (docs/assistant-plan-mode.md): the caller's own plan — any signed-in user approves one; "
          'cancel and removing a finished one from the list are the approver or an admin, '
          'resolving a paused step the approver only (owner checks in the handler)',
          'agents_handler.py', 'POST /agents/plans', 'POST /agents/plans/<plan_id>/cancel',
          'DELETE /agents/plans/<plan_id>',
          'POST /agents/plans/<plan_id>/steps/<step_id>/approve',
          'POST /agents/plans/<plan_id>/steps/<step_id>/decline'),
    _open('voting sessions: any signed-in facilitator opens/closes one; submit is the public anonymous ballot',
          'ballots_handler.py', 'POST /voting-sessions', 'POST /voting-sessions/<session_id>/close',
          'POST /voting-sessions/<session_id>/submit'),
    _open("caller's own data: conversations live in the caller's USER#{sub} partition",
          'chat_handler.py', 'POST /chat/conversations/<conversation_id>',
          'PUT /chat/conversations/<conversation_id>/title',
          'DELETE /chat/conversations/<conversation_id>',
          'POST /chat/conversations/<conversation_id>/cancel'),
    _open("feedback edit: limited to the caller's category scope (shared/category_access.py)",
          'feedback_edit_handler.py', 'PUT /feedback/<feedback_id>/category',
          'PUT /feedback/<feedback_id>/dimensions'),
    _open('participants: every signed-in app user manages lists and people (engagement brief, 5.33)',
          'participants_routes.py', 'POST /participants/lists', 'PUT /participants/lists/<list_id>',
          'POST /participants/lists/<list_id>/members', 'DELETE /participants/lists/<list_id>/members/<person_id>',
          'POST /participants/people', 'PUT /participants/people/<person_id>'),
    _open('participant project links and project asks: edit on the project (shared/project_access.py)',
          'participants_ask_routes.py', 'POST /participants/projects/<project_id>',
          'DELETE /participants/projects/<project_id>/lists/<list_id>',
          'DELETE /participants/projects/<project_id>/people/<person_id>', 'POST /participants/asks'),
    _open('public one-click unsubscribe (RFC 8058): a token from the email, always 200 (throttled)',
          'participants_ask_routes.py', 'POST /unsubscribe'),
    _open('feedback boards: any user of a board files requests and +1s (no moderation, owner decision 2026-10-26); '
          'edits are the owner or an admin',
          'feature_requests_routes.py', 'POST /feature-requests', 'PUT /feature-requests/<request_id>',
          'POST /feature-requests/<request_id>/supports',
          'PUT /feature-requests/<request_id>/supports/<support_id>',
          'DELETE /feature-requests/<request_id>/supports/<support_id>'),
    _open('feedback forms: any signed-in user manages forms (owner decision 2026-10-04)',
          'feedback_form_handler.py', 'POST /feedback-forms', 'PUT /feedback-forms/<form_id>',
          'DELETE /feedback-forms/<form_id>'),
    _open('public widget route: the embeddable form posts from the customer site (throttled)',
          'feedback_form_handler.py', 'POST /feedback-forms/<form_id>/submit'),
    _open("caller's own data: a user mints and revokes only their own global MCP tokens",
          'mcp_tokens_handler.py', 'POST /connect/tokens', 'DELETE /connect/tokens/<token_id>'),
    _open("caller's own data: a person approves an MCP OAuth sign-in for themselves (grant keyed by their own "
          'Cognito sub, never admin, pin checked for view) and revokes only their own grants',
          'mcp_oauth_consent_routes.py', 'POST /connect/oauth/consent', 'DELETE /connect/oauth/grants/<grant_id>'),
    _open('public OAuth facade (docs/mcp.md "OAuth sign-in"): an MCP client has no credential yet; register stores '
          'nothing, token/revoke forward to Cognito and only record chains of consented grants (throttled)',
          'mcp_oauth_routes.py', 'POST /oauth/register', 'POST /oauth/token', 'POST /oauth/revoke'),
    _open('memory: personal = own, company = admin or memory reviewer, enforced by memory_policy',
          'memory_handler.py', 'POST /memory', 'PUT /memory/<memory_id>', 'POST /memory/<memory_id>/confirm',
          'POST /memory/<memory_id>/forget', 'POST /memory/<memory_id>/restore', 'POST /memory/merge',
          'POST /memory/review/<memory_id>/resolve', 'POST /memory/imports', 'POST /memory/retrieve'),
    _open('projects: per-project view/edit/manage access in shared/project_access.py (middleware); AI writing '
          "of PR/FAQs / PRDs also follows the person's way of working (shared/ai_writing.py)",
          'projects_handler.py',
          'POST /projects', 'PUT /projects/<project_id>', 'DELETE /projects/<project_id>',
          'POST /projects/<project_id>/chat-context', 'PUT /projects/<project_id>/visibility',
          'POST /projects/<project_id>/members', 'PUT /projects/<project_id>/members/<member_sub>',
          'DELETE /projects/<project_id>/members/<member_sub>', 'POST /projects/<project_id>/owner',
          'POST /projects/<project_id>/personas/import',
          'PUT /projects/<project_id>/personas/<persona_id>', 'DELETE /projects/<project_id>/personas/<persona_id>',
          'POST /projects/<project_id>/personas/<persona_id>/notes',
          'POST /projects/<project_id>/personas/<persona_id>/regenerate-avatar',
          'POST /projects/<project_id>/personas/generate', 'POST /projects/<project_id>/research',
          'POST /projects/<project_id>/feedback-preview',
          'POST /projects/<project_id>/document', 'POST /projects/<project_id>/documents',
          'POST /projects/<project_id>/documents/merge', 'PUT /projects/<project_id>/documents/<document_id>',
          'POST /projects/<project_id>/documents/<document_id>/versions/<version_id>/restore',
          'DELETE /projects/<project_id>/documents/<document_id>',
          'POST /projects/<project_id>/documents/<document_id>/duplicate',
          'DELETE /projects/<project_id>/jobs/<job_id>', 'PUT /projects/<project_id>/product-context',
          'POST /projects/<project_id>/product-docs/upload-url', 'DELETE /projects/<project_id>/product-docs/<doc_id>',
          'POST /projects/<project_id>/prfaq-autofill', 'POST /projects/<project_id>/research/suggest-questions',
          'POST /projects/<project_id>/documents/suggest-brief',
          'POST /projects/<project_id>/prototypes/<document_id>/pins/<pin_id>/replies',
          'POST /projects/<project_id>/prototypes/<document_id>/pins/<pin_id>/resolve',
          'POST /projects/<project_id>/prototypes/<document_id>/pins/<pin_id>/reopen',
          'POST /projects/<project_id>/prototypes/<document_id>/pins/addressed',
          'POST /projects/<project_id>/prototypes/<document_id>/pins/resolve',
          'POST /projects/<project_id>/build-prototype', 'POST /projects/<project_id>/product-report',
          'POST /projects/<project_id>/decisions', 'PUT /projects/<project_id>/decisions/<document_id>',
          'POST /projects/<project_id>/decisions/<document_id>/pursue',
          'POST /projects/<project_id>/documents/<document_id>/persona-review'),
    _open('document comments and review links: per-project access (view comments, edit links), docs/document-review.md',
          'document_review_routes.py',
          'POST /projects/<project_id>/documents/<document_id>/comments',
          'POST /projects/<project_id>/documents/<document_id>/comments/<comment_id>/replies',
          'POST /projects/<project_id>/documents/<document_id>/comments/<comment_id>/resolve',
          'POST /projects/<project_id>/documents/<document_id>/comments/<comment_id>/reopen',
          'DELETE /projects/<project_id>/documents/<document_id>/comments/<comment_id>',
          'POST /projects/<project_id>/documents/<document_id>/share',
          'DELETE /projects/<project_id>/documents/<document_id>/share'),
    _open('copy personas into a project: edit on the target project, and the source is the library or a '
          'project the caller owns or is a member of (owner decision, 5.60.00)',
          'persona_copy_routes.py', 'POST /projects/<project_id>/personas/copy'),
    _open("review link reviewers: the link's audience and the verified email decide, rate-limited per day",
          'document_review_routes.py', 'POST /review/<share_id>/comments',
          'POST /review/<share_id>/comments/<comment_id>/replies'),
    _open("prioritization: rows are shared team state over viewable projects; a ballot is the caller's own",
          'projects_handler.py', 'POST /projects/prioritization/rows', 'POST /projects/prioritization/rows/compose',
          'PATCH /projects/prioritization/rows/<row_id>',
          'PUT /projects/prioritization/rows/<row_id>/lineage-ack', 'PUT /projects/prioritization',
          'PATCH /projects/prioritization'),
    _open('resolved problems: shared team state, every signed-in user marks a problem resolved',
          'settings_handler.py', 'PUT /settings/resolved-problems'),
    _open("caller's own data: personal context and onboarding preference, self only",
          'settings_handler.py', 'PUT /settings/my-context', 'PUT /settings/my-onboarding'),
    _open("caller's own morning brief: preferences, refresh (no cap, owner decision) and card states, self only",
          'settings_handler.py', 'PUT /settings/my-briefing', 'POST /settings/my-briefing/refresh',
          'PUT /settings/my-briefing/cards'),
)


# ── The structural classifier ────────────────────────────────────────────────

def _called_name(node: ast.AST | None) -> str | None:
    """`f` for `f(...)` or `x.f(...)`, else None."""
    if not isinstance(node, ast.Call):
        return None
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return None


def _top_level_calls(fn: ast.FunctionDef) -> set[str]:
    """Names called by an unconditional top-level statement of *fn* (`f(...)`, `x = f(...)`, `return f(...)`)."""
    names = set()
    for stmt in fn.body:
        name = _called_name(stmt.value) if isinstance(stmt, _VALUE_STATEMENTS) else None
        if name:
            names.add(name)
    return names


def _tests_is_admin(test: ast.expr) -> bool:
    return any(isinstance(n, ast.Attribute) and n.attr == 'is_admin' for n in ast.walk(test))


def _raises_authorization_error(body: list[ast.stmt]) -> bool:
    return any(isinstance(s, ast.Raise) and _called_name(s.exc) == 'AuthorizationError' for s in body)


def _is_admin_check(fn: ast.FunctionDef) -> bool:
    """A top-level `if <...is_admin...>: raise AuthorizationError(...)` in *fn*."""
    return any(isinstance(s, ast.If) and _tests_is_admin(s.test) and _raises_authorization_error(s.body)
               for s in fn.body)


def _module_functions(tree: ast.Module) -> dict[str, ast.FunctionDef]:
    return {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}


def gate_functions(tree: ast.Module) -> set[str]:
    """`require_admin` plus every module function that unconditionally reaches it or is an admin check."""
    functions = _module_functions(tree)
    gates = set(GATE_PRIMITIVES) | {name for name, fn in functions.items() if _is_admin_check(fn)}
    changed = True
    while changed:
        changed = False
        for name, fn in functions.items():
            if name not in gates and _top_level_calls(fn) & gates:
                gates.add(name)
                changed = True
    return gates


def _middlewares(tree: ast.Module) -> set[str]:
    """Names passed to a module-level `app.use(middlewares=[...])`."""
    names = set()
    for stmt in tree.body:
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call) and _called_name(stmt.value) == 'use':
            for keyword in stmt.value.keywords:
                if keyword.arg == 'middlewares' and isinstance(keyword.value, ast.List | ast.Tuple):
                    names |= {e.id for e in keyword.value.elts if isinstance(e, ast.Name)}
    return names


def _route_keys(fn: ast.FunctionDef, methods: frozenset[str]) -> list[str]:
    """`"METHOD /path"` for every `@app.<method in *methods*>("<path>")` decorator on *fn*."""
    keys = []
    for decorator in fn.decorator_list:
        if not (isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute)):
            continue
        receiver, method = decorator.func.value, decorator.func.attr
        if not (isinstance(receiver, ast.Name) and receiver.id == 'app' and method in methods):
            continue
        if decorator.args and isinstance(decorator.args[0], ast.Constant) and isinstance(decorator.args[0].value, str):
            keys.append(f'{method.upper()} {decorator.args[0].value}')
    return keys


def routes_with_gates(source: str, methods: frozenset[str]) -> dict[str, bool]:
    """Every `@app.<method in *methods*>` route in *source* -> whether it is structurally admin-gated."""
    tree = ast.parse(source)
    gates = gate_functions(tree)
    module_gated = bool(_middlewares(tree) & (gates | GATE_MIDDLEWARES))
    routes: dict[str, bool] = {}
    for fn in _module_functions(tree).values():
        gated = module_gated or bool(_top_level_calls(fn) & gates)
        for key in _route_keys(fn, methods):
            routes[key] = gated
    return routes


def mutating_routes(source: str) -> dict[str, bool]:
    """Every mutating route in *source* -> whether it is structurally admin-gated."""
    return routes_with_gates(source, MUTATING_METHODS)


def _handler_files() -> list[Path]:
    return sorted(API_DIR.glob('*_handler.py'))


def _router_files() -> list[Path]:
    """Powertools routers a handler includes (``app = Router()``), kept in ``shared/`` because an
    API bundle ships ``api/<handler>.py`` + ``shared/`` only (test_api_bundle_imports.py)."""
    return sorted(SHARED_DIR.glob('*_routes.py'))


@cache
def _inventory() -> dict[tuple[str, str], bool]:
    """(handler or router file, "METHOD /path") -> gated, over every handler and router in the repo."""
    return {
        (path.name, key): gated
        for path in [*_handler_files(), *_router_files()]
        for key, gated in mutating_routes(path.read_text(encoding='utf-8')).items()
    }


def _admin_keys() -> set[tuple[str, str]]:
    return {(handler, route) for handler, routes in ADMIN_ONLY.items() for route in routes}


def _open_keys() -> Counter[tuple[str, str]]:
    return Counter((group.handler, route) for group in OPEN_BY_DECISION for route in group.routes)


# ── The inventory ────────────────────────────────────────────────────────────

def test_the_inventory_finds_the_routes_it_is_about():
    inventory = _inventory()
    assert ('settings_handler.py', 'PUT /settings/brand') in inventory
    assert ('settings_handler.py', 'POST /settings/categories/generate') in inventory
    # Routers included by a handler are read too (shared/*_routes.py).
    assert ('participants_routes.py', 'PUT /participants/settings') in inventory
    assert ('feature_requests_routes.py', 'POST /feature-requests/<request_id>/promote') in inventory
    assert len(inventory) > 100


def test_every_mutating_route_is_classified():
    classified = _admin_keys() | set(_open_keys())
    unclassified = sorted(key for key in _inventory() if key not in classified)
    assert not unclassified, (
        'Unclassified mutating route(s): '
        + ', '.join(f'{handler} {route}' for handler, route in unclassified)
        + '. Classify each one in lambda/api/test/test_route_admin_gates.py: add it to ADMIN_ONLY and call '
        '`require_admin(app.current_event.raw_event)` first in its handler, or add it to OPEN_BY_DECISION '
        'with a one-line reason recording who decided it may stay open.'
    )


def test_no_route_is_in_both_tables_or_listed_twice():
    open_keys = _open_keys()
    assert sorted(_admin_keys() & set(open_keys)) == []
    assert sorted(key for key, count in open_keys.items() if count > 1) == []


def test_every_admin_only_route_carries_its_gate():
    inventory = _inventory()
    ungated = sorted(key for key in _admin_keys() if inventory.get(key) is False)
    assert not ungated, f'ADMIN_ONLY route(s) lost their admin gate: {ungated}'


def test_no_open_by_decision_route_carries_an_admin_gate():
    inventory = _inventory()
    gated = sorted(key for key in _open_keys() if inventory.get(key) is True)
    assert not gated, f'Gated route(s) listed as OPEN_BY_DECISION; move them to ADMIN_ONLY: {gated}'


def test_every_table_entry_names_a_route_that_exists():
    inventory = _inventory()
    stale = sorted(key for key in _admin_keys() | set(_open_keys()) if key not in inventory)
    assert not stale, f'Table entries for routes that no longer exist: {stale}'


def test_every_open_reason_is_one_non_empty_line():
    assert [g.reason for g in OPEN_BY_DECISION if not g.reason.strip() or '\n' in g.reason] == []


def test_only_the_recorded_handlers_are_not_resolvers():
    no_routes = {path.name for path in _handler_files() if 'create_api_resolver(' not in path.read_text(encoding='utf-8')}
    assert no_routes == set(NON_RESOLVER_HANDLERS)


# ── Reads gated by decision ──────────────────────────────────────────────────
# The inventory above covers writes only. These reads were closed by an owner decision and are
# pinned so they cannot silently reopen. `GET /settings/model` is deliberately NOT here: the
# agent detail page's Models tab (open to every signed-in user, read-only for non-admins) reads
# its allowlist through that route, so gating it is pending an owner decision on that caller.
ADMIN_ONLY_READS: dict[str, frozenset[str]] = {
    # Owner decision 2026-10-08 (#242 follow-up): the import bucket and parse jobs are admin-only.
    's3_import_handler.py': frozenset({
        'GET /s3-import/sources', 'GET /s3-import/files', 'GET /s3-import/reprocess/<run_id>',
    }),
    'manual_import_handler.py': frozenset({
        'GET /scrapers/manual/parse/<job_id>',
        # Import history (#237): who imported what, from which file — admin data like the imports themselves.
        'GET /scrapers/manual/history', 'GET /scrapers/manual/history/<run_id>',
    }),
}


@pytest.mark.parametrize(('handler', 'route'), sorted(
    (handler, route) for handler, routes in ADMIN_ONLY_READS.items() for route in routes))
def test_every_admin_only_read_exists_and_carries_its_gate(handler, route):
    reads = routes_with_gates((API_DIR / handler).read_text(encoding='utf-8'), frozenset({'get'}))
    assert reads.get(route) is True, f'{handler} {route} is missing or lost its admin gate'


# ── The classifier itself ────────────────────────────────────────────────────

_PRELUDE = 'from shared.api import require_admin\n\n'


@pytest.mark.parametrize(('body', 'gated'), [
    ('    require_admin(app.current_event.raw_event)\n    return {}\n', True),
    ('    caller = _caller()\n    _check(caller)\n    return {}\n', True),
    ('    return _check(_caller())\n', True),
    ('    if flag:\n        require_admin(event)\n    return {}\n', False),
    ('    try:\n        require_admin(event)\n    except Exception:\n        pass\n', False),
    ('    def inner():\n        require_admin(event)\n    return {}\n', False),
    ('    log(require_admin)\n    return {}\n', False),
    ('    return {}\n', False),
], ids=['direct', 'via-helper', 'returned-helper', 'conditional', 'in-try', 'nested-function', 'not-a-call', 'none'])
def test_a_gate_counts_only_as_an_unconditional_top_level_call(body, gated):
    source = (_PRELUDE + 'def _check(caller):\n    require_admin(caller)\n\n\n'
              + '@app.put("/x")\ndef route():\n' + body)
    assert mutating_routes(source) == {'PUT /x': gated}


def test_a_local_is_admin_check_is_a_gate():
    source = ('def _require_admin(caller):\n    if not caller.is_admin or caller.delegated:\n'
              "        raise AuthorizationError('Admin access required')\n\n\n"
              '@app.post("/x")\ndef route():\n    caller = _caller()\n    _require_admin(caller)\n')
    assert mutating_routes(source) == {'POST /x': True}


def test_a_check_that_does_not_raise_is_not_a_gate():
    source = ('def _maybe(caller):\n    if not caller.is_admin:\n        return False\n    return True\n\n\n'
              '@app.post("/x")\ndef route():\n    _maybe(_caller())\n')
    assert mutating_routes(source) == {'POST /x': False}


def test_an_admin_middleware_gates_every_route_of_its_module():
    source = (_PRELUDE + 'def _admins_only(app, next_middleware):\n    require_admin(app.current_event.raw_event)\n'
              '    return next_middleware(app)\n\n\napp.use(middlewares=[_admins_only])\n\n\n'
              '@app.put("/a")\ndef a():\n    return {}\n\n\n@app.delete("/b")\ndef b():\n    return {}\n')
    assert mutating_routes(source) == {'PUT /a': True, 'DELETE /b': True}


def test_a_middleware_that_is_not_an_admin_gate_gates_nothing():
    source = ('def _access(app, next_middleware):\n    return next_middleware(app)\n\n\n'
              'app.use(middlewares=[_access])\n\n\n@app.put("/a")\ndef a():\n    return {}\n')
    assert mutating_routes(source) == {'PUT /a': False}


def test_reads_and_non_app_decorators_are_not_inventoried():
    source = ('@app.get("/r")\ndef r():\n    return {}\n\n\n'
              '@router.post("/other")\n@tracer.capture_method\ndef other():\n    return {}\n')
    assert mutating_routes(source) == {}


class _DropAdminGate(ast.NodeTransformer):
    """Delete the top-level `require_admin(...)` statement from one function."""

    def __init__(self, function: str):
        self.function = function

    def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.FunctionDef:
        if node.name == self.function:
            node.body = [s for s in node.body
                         if not (isinstance(s, ast.Expr) and _called_name(s.value) in GATE_PRIMITIVES)]
        return node


@pytest.mark.parametrize(('handler', 'function', 'route'), [
    ('settings_handler.py', 'save_brand_settings', 'PUT /settings/brand'),
    ('settings_handler.py', 'generate_categories', 'POST /settings/categories/generate'),
    # The shared caller gate (project_gate.require_admin_caller).
    ('agents_handler.py', 'create_agent', 'POST /agents'),
])
def test_removing_a_real_gate_is_detected(handler, function, route):
    tree = ast.parse((API_DIR / handler).read_text(encoding='utf-8'))
    assert mutating_routes(ast.unparse(tree))[route] is True
    stripped = ast.unparse(_DropAdminGate(function).visit(tree))
    assert mutating_routes(stripped)[route] is False


def test_every_shared_gate_primitive_is_an_admin_check():
    functions = _module_functions(ast.parse((SHARED_DIR / 'project_gate.py').read_text(encoding='utf-8')))
    assert _is_admin_check(functions['require_admin_caller'])
    board = _module_functions(ast.parse((SHARED_DIR / 'engagement_identity.py').read_text(encoding='utf-8')))
    assert _is_admin_check(board['require_board_admin'])
    api_functions = _module_functions(ast.parse((SHARED_DIR / 'api.py').read_text(encoding='utf-8')))
    require_admin = api_functions[GATE_PRIMITIVE]
    assert any(isinstance(stmt, ast.If) and _raises_authorization_error(stmt.body) for stmt in require_admin.body)
    for name in GATE_MIDDLEWARES:   # a shared middleware gates only if its first statement is the gate
        first = api_functions[name].body[1] if ast.get_docstring(api_functions[name]) else api_functions[name].body[0]
        assert isinstance(first, ast.Expr)
        assert _called_name(first.value) == GATE_PRIMITIVE


def test_the_shared_admin_middleware_gates_every_route_of_its_module():
    source = (_PRELUDE + 'app.use(middlewares=[admins_only])\n\n\n@app.put("/a")\ndef a():\n    return {}\n')
    assert mutating_routes(source) == {'PUT /a': True}
