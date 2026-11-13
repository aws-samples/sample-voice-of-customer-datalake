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
# `require_request_admin` (``shared.workspace_request``): a two-path route's gate, `require_admin` without
# X-Workspace-Id and `require_workspace_admin` with it (both branches pinned below).
TWO_PATH_GATE = 'require_request_admin'
GATE_PRIMITIVES = frozenset({GATE_PRIMITIVE, 'require_admin_caller', 'require_board_admin', TWO_PATH_GATE})
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
    # The workspace's start theme (Administration → General): every person sees it until they pick their own.
    'appearance_routes.py': frozenset({'PUT /settings/appearance'}),
    'data_explorer_handler.py': frozenset({'PUT /data-explorer/s3', 'PUT /data-explorer/feedback'}),
    # Company personas (since 5.60.00): only admins write the shared library; promote copies into it.
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
    # Board insights (docs/feature-requests.md -> Enrichment): only admins start the enrichment backfill (Bedrock spend).
    'feature_requests_insights_routes.py': frozenset({'POST /feature-requests/insights/enrich'}),
    # Feedback boards (docs/feature-requests.md): only admins create, configure and delete.
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
    # #242: importing data is admin-only (module middleware).
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
    's3_import_handler.py': frozenset({  # #242, module middleware
        'POST /s3-import/sources', 'POST /s3-import/upload-url', 'DELETE /s3-import/file/<key>',
        'POST /s3-import/reprocess',  # re-runs a file through the ingestor (issue #144)
    }),
    'scrapers_handler.py': frozenset({
        'POST /scrapers', 'DELETE /scrapers/<scraper_id>', 'POST /scrapers/<scraper_id>/run',
        'POST /scrapers/analyze-url',
    }),
    'settings_handler.py': frozenset({
        'PUT /settings/model', 'POST /settings/model/test',
        'PUT /settings/brand',  # #242: shared deployment config
        'PUT /settings/categories',
        'POST /settings/categories/generate',  # #242 (Bedrock spend)
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
        # Platform-admin membership: an admin gate, then the platform-admin one (PLATFORM_ADMIN_ONLY below).
        'PUT /users/<username>/platform-admin',
    }),
    # The platform console (docs/multi-workspace.md → Control plane): an admin gate, then the platform-admin one.
    'workspaces_handler.py': frozenset({'POST /platform/workspaces'}),
}

# Routes for platform admins only (docs/multi-workspace.md → Control plane): each is also in ADMIN_ONLY (a write)
# or ADMIN_ONLY_READS (a read), and its handler body also calls `require_platform_admin` (shared/platform_admin.py)
# as an unconditional top-level statement, so a plain administrator gets 403 too; the live check follows it.
PLATFORM_GATE = 'require_platform_admin'
PLATFORM_ADMIN_ONLY: dict[str, frozenset[str]] = {
    'users_handler.py': frozenset({'PUT /users/<username>/platform-admin'}),
    'workspaces_handler.py': frozenset({'POST /platform/workspaces', 'GET /platform/workspaces'}),
}
#: The methods whose routes the platform-gate checks read: the writes and the reads.
PLATFORM_GATED_METHODS = MUTATING_METHODS | {'get'}

# Routes for a workspace's admins (docs/multi-workspace.md → Roles and Request flow, the workspace dimension): the
# caller's role in the workspace X-Workspace-Id names, a member admin or an entered platform admin, never the
# deployment's `admins` group. Their handler body calls `require_workspace_admin` (shared/workspace.py) as an
# unconditional top-level statement, after resolving the workspace.
WORKSPACE_GATE = 'require_workspace_admin'
WORKSPACE_ADMIN_ONLY: dict[str, frozenset[str]] = {
    'workspaces_handler.py': frozenset({
        'POST /me/workspaces/current/members', 'PUT /me/workspaces/current/members/<sub>',
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
    _open("feedback edit: limited to the caller's category scope (shared/category_access.py); with X-Workspace-Id "
          "to the workspace's editors and admins (WORKSPACE_SCOPED below)",
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
    _open('feedback boards: any user of a board files requests and +1s (no moderation by design); '
          'edits are the owner or an admin',
          'feature_requests_routes.py', 'POST /feature-requests', 'PUT /feature-requests/<request_id>',
          'POST /feature-requests/<request_id>/supports',
          'PUT /feature-requests/<request_id>/supports/<support_id>',
          'DELETE /feature-requests/<request_id>/supports/<support_id>'),
    _open('feedback forms: any signed-in user manages forms (by design: forms carry no per-form owner); with '
          "X-Workspace-Id the workspace's editors and admins (WORKSPACE_SCOPED below)",
          'feedback_form_handler.py', 'POST /feedback-forms', 'PUT /feedback-forms/<form_id>',
          'DELETE /feedback-forms/<form_id>'),
    _open("public widget route: the embeddable form posts from the customer site (throttled); a workspace's form by "
          'its lookup row (PUBLIC_BY_LOOKUP below)',
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
          'PUT /projects/<project_id>/personas/<persona_id>/protection',
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
          'project the caller owns or is a member of (since 5.60.00)',
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
    _open("caller's own morning brief: preferences, refresh (deliberately uncapped) and card states, self only",
          'settings_handler.py', 'PUT /settings/my-briefing', 'POST /settings/my-briefing/refresh',
          'PUT /settings/my-briefing/cards'),
    _open('leaving a workspace (docs/multi-workspace.md → Invites): any member removes themselves; removing anyone '
          'else calls require_workspace_admin first, and the last admin is refused either way',
          'workspaces_handler.py', 'DELETE /me/workspaces/current/members/<sub>'),
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


def _workspace_admin_keys() -> set[tuple[str, str]]:
    return {(handler, route) for handler, routes in WORKSPACE_ADMIN_ONLY.items() for route in routes}


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
    classified = _admin_keys() | set(_open_keys()) | _workspace_admin_keys()
    unclassified = sorted(key for key in _inventory() if key not in classified)
    assert not unclassified, (
        'Unclassified mutating route(s): '
        + ', '.join(f'{handler} {route}' for handler, route in unclassified)
        + '. Classify each one in lambda/api/test/test_route_admin_gates.py: add it to ADMIN_ONLY and call '
        '`require_admin(app.current_event.raw_event)` first in its handler, or to WORKSPACE_ADMIN_ONLY with '
        '`require_workspace_admin(context)`, or add it to OPEN_BY_DECISION '
        'with a one-line reason recording who decided it may stay open.'
    )


def test_no_route_is_in_both_tables_or_listed_twice():
    open_keys = _open_keys()
    assert sorted(_admin_keys() & set(open_keys)) == []
    assert sorted(_workspace_admin_keys() & (_admin_keys() | set(open_keys))) == []
    assert sorted(key for key, count in open_keys.items() if count > 1) == []


def test_every_admin_only_route_carries_its_gate():
    inventory = _inventory()
    ungated = sorted(key for key in _admin_keys() if inventory.get(key) is False)
    assert not ungated, f'ADMIN_ONLY route(s) lost their admin gate: {ungated}'


def test_no_open_by_decision_route_carries_an_admin_gate():
    inventory = _inventory()
    gated = sorted(key for key in _open_keys() if inventory.get(key) is True)
    assert not gated, f'Gated route(s) listed as OPEN_BY_DECISION; move them to ADMIN_ONLY: {gated}'


def _platform_gated(source: str) -> dict[str, bool]:
    """Every mutating or read route in *source* -> whether its body calls `require_platform_admin` unconditionally."""
    functions = _module_functions(ast.parse(source))
    return {key: PLATFORM_GATE in _top_level_calls(fn)
            for fn in functions.values() for key in _route_keys(fn, PLATFORM_GATED_METHODS)}


@pytest.mark.parametrize(('handler', 'route'), sorted(
    (handler, route) for handler, routes in PLATFORM_ADMIN_ONLY.items() for route in routes))
def test_every_platform_admin_route_is_admin_only_and_carries_the_platform_gate(handler, route):
    assert route in ADMIN_ONLY.get(handler, frozenset()) | ADMIN_ONLY_READS.get(handler, frozenset())
    assert _platform_gated((API_DIR / handler).read_text(encoding='utf-8')).get(route) is True, (
        f'{handler} {route} is missing or lost its require_platform_admin gate')


def test_only_the_listed_routes_carry_the_platform_gate():
    gated = {(path.name, key) for path in _handler_files()
             for key, has in _platform_gated(path.read_text(encoding='utf-8')).items() if has}
    assert gated == {(handler, route) for handler, routes in PLATFORM_ADMIN_ONLY.items() for route in routes}


def test_the_platform_gate_raises_authorization_error():
    functions = _module_functions(ast.parse((SHARED_DIR / 'platform_admin.py').read_text(encoding='utf-8')))
    assert any(isinstance(stmt, ast.If) and _raises_authorization_error(stmt.body)
               for stmt in functions[PLATFORM_GATE].body)


@pytest.mark.parametrize(('handler', 'route'), [
    ('users_handler.py', 'PUT /users/<username>/platform-admin'),
    ('workspaces_handler.py', 'POST /platform/workspaces'),
    ('workspaces_handler.py', 'GET /platform/workspaces'),
])
def test_removing_the_platform_gate_is_detected(handler, route):
    tree = ast.parse((API_DIR / handler).read_text(encoding='utf-8'))
    for fn in _module_functions(tree).values():
        fn.body = [s for s in fn.body if not (isinstance(s, ast.Expr) and _called_name(s.value) == PLATFORM_GATE)]
    assert _platform_gated(ast.unparse(tree))[route] is False


# The live check follows the token gate on every platform route of the workspaces API (shared/platform_admin.py):
# the token alone would let a revoked or disabled platform admin through until it expires.
LIVE_PLATFORM_GATE = '_require_live_platform_admin'


@pytest.mark.parametrize('route', sorted(PLATFORM_ADMIN_ONLY['workspaces_handler.py']))
def test_every_workspaces_platform_route_runs_the_live_check(route):
    functions = _module_functions(ast.parse((API_DIR / 'workspaces_handler.py').read_text(encoding='utf-8')))
    [fn] = [fn for fn in functions.values() if route in _route_keys(fn, PLATFORM_GATED_METHODS)]
    assert LIVE_PLATFORM_GATE in _top_level_calls(fn)


def _workspace_gated(source: str) -> dict[str, bool]:
    """Every mutating or read route in *source* -> whether its body calls `require_workspace_admin` unconditionally."""
    functions = _module_functions(ast.parse(source))
    return {key: WORKSPACE_GATE in _top_level_calls(fn)
            for fn in functions.values() for key in _route_keys(fn, PLATFORM_GATED_METHODS)}


@pytest.mark.parametrize(('handler', 'route'), sorted(_workspace_admin_keys()))
def test_every_workspace_admin_route_carries_the_workspace_gate(handler, route):
    assert _workspace_gated((API_DIR / handler).read_text(encoding='utf-8')).get(route) is True, (
        f'{handler} {route} is missing or lost its require_workspace_admin gate')


def test_only_the_listed_routes_carry_the_workspace_gate_unconditionally():
    gated = {(path.name, key) for path in _handler_files()
             for key, has in _workspace_gated(path.read_text(encoding='utf-8')).items() if has}
    assert gated == _workspace_admin_keys()


def test_the_workspace_gate_raises_authorization_error():
    functions = _module_functions(ast.parse((SHARED_DIR / 'workspace.py').read_text(encoding='utf-8')))
    assert any(isinstance(stmt, ast.If) and _raises_authorization_error(stmt.body)
               for stmt in functions[WORKSPACE_GATE].body)


@pytest.mark.parametrize('route', sorted(WORKSPACE_ADMIN_ONLY['workspaces_handler.py']))
def test_removing_the_workspace_gate_is_detected(route):
    tree = ast.parse((API_DIR / 'workspaces_handler.py').read_text(encoding='utf-8'))
    for fn in _module_functions(tree).values():
        fn.body = [s for s in fn.body if not (isinstance(s, ast.Expr) and _called_name(s.value) == WORKSPACE_GATE)]
    assert _workspace_gated(ast.unparse(tree))[route] is False


# ── The data path's workspace dimension (docs/multi-workspace.md → Request flow, phase 2) ─────────────────────
# Routes that serve both paths: with X-Workspace-Id they act in that workspace (shared/workspace_request.py
# `RequestWorkspace`: the one 404 for a non-member, a platform admin's entry live-checked and audited) and read and
# write only its partitions; without it, deployment-wide as before. Every route of a module that resolves a request's
# workspace is listed (so a new route there is classified), and each resolves it before it reads: the metrics API in
# a resolver middleware that runs before every route, the feedback edits as an unconditional top-level call.
WORKSPACE_RESOLVER = 'RequestWorkspace'
WORKSPACE_SCOPED: dict[str, frozenset[str]] = {
    # Reads: any member (Roles: a viewer reads the workspace's feedback and dashboards).
    'metrics_handler.py': frozenset({
        'GET /feedback', 'GET /feedback/urgent', 'GET /feedback/entities', 'GET /feedback/search',
        'GET /feedback/problems', 'GET /feedback/access', 'GET /feedback/catalogue', 'GET /feedback/<feedback_id>',
        'GET /feedback/<feedback_id>/similar', 'GET /metrics/summary', 'GET /metrics/sentiment',
        'GET /metrics/categories', 'GET /metrics/sources', 'GET /metrics/personas', 'GET /metrics/dimensions',
        'GET /metrics/data-quality', 'GET /metrics/github', 'GET /metrics/release-watch',
    }),
    # Writes: the workspace's editors and admins (a viewer 403), the category scope as before.
    'feedback_edit_handler.py': frozenset({
        'PUT /feedback/<feedback_id>/category', 'PUT /feedback/<feedback_id>/dimensions',
    }),
    # The operator routes that start and watch ingestion: in a workspace the ADMIN_ONLY ones need the caller's admin
    # role there (`require_request_admin`, test below), the reads any member; credentials and app connectors in the
    # workspace's own secret, Run now with the resolved workspace on the payload, run rows and breaker rows its own.
    'integrations_handler.py': frozenset({
        'GET /integrations/status', 'GET /integrations/<source>/credentials', 'PUT /integrations/<source>/credentials',
        'GET /integrations/<source>/apps', 'POST /integrations/<source>/apps',
        'DELETE /integrations/<source>/apps/<app_id>', 'POST /sources/<source>/run', 'GET /sources/status',
        'POST /sources/<source>/reset',
        # Refused in a workspace (WORKSPACE_REFUSED): the schedule rule serves every workspace.
        'PUT /sources/<source>/enable', 'PUT /sources/<source>/disable',
    }),
    'scrapers_handler.py': frozenset({
        'GET /scrapers', 'POST /scrapers', 'DELETE /scrapers/<scraper_id>', 'GET /scrapers/connectors',
        'GET /scrapers/templates', 'POST /scrapers/<scraper_id>/run', 'GET /scrapers/<scraper_id>/status',
        'POST /scrapers/analyze-url', 'GET /scrapers/jobs/<job_id>',
    }),
    # The signed-in form routes: any member reads; create, update and delete are for the workspace's editors and
    # admins (`_request_scope(write=True)`, a viewer 403). The module's public routes are in PUBLIC_BY_LOOKUP.
    'feedback_form_handler.py': frozenset({
        'GET /feedback-forms', 'POST /feedback-forms', 'PUT /feedback-forms/<form_id>',
        'DELETE /feedback-forms/<form_id>', 'GET /feedback-forms/<form_id>/submissions',
        'GET /feedback-forms/<form_id>/stats',
    }),
}
#: How each module resolves the workspace before a route reads: a middleware (module-wide: its name and the call
#: its first statement makes, afresh for each request) or a per-route call.
WORKSPACE_FIRST_MIDDLEWARE = {'metrics_handler.py': ('_workspace_first', '_request_scope')}
WORKSPACE_FIRST_CALL = {'feedback_edit_handler.py': '_edit_scope', 'feedback_form_handler.py': '_request_scope'}
#: The public routes (no signed-in caller) of a two-path module (docs/multi-workspace.md, "Public and non-user entry
#: points"): each takes its workspace from a stored lookup row through the module's lookup call (an unconditional
#: top-level statement), never from the request: it never resolves X-Workspace-Id (the module's per-route resolver
#: is not called), and the lookup itself never reads a header.
PUBLIC_BY_LOOKUP: dict[str, tuple[str, frozenset[str]]] = {
    'feedback_form_handler.py': ('_public_form', frozenset({
        'GET /feedback-forms/<form_id>/config', 'GET /feedback-forms/<form_id>/iframe',
        'POST /feedback-forms/<form_id>/submit',
    })),
}
#: The writes of a per-route module, which resolve the role from the table and need an editor or admin there.
WORKSPACE_WRITE_CALL = {'feedback_form_handler.py': "_request_scope(write=True)"}
#: The operator modules: one shared implementation (shared/workspace_request.py `ResolvedRoutes`), installed as
#: `_request = ResolvedRoutes(app)` and `app.use(middlewares=[_request.middleware])`; its admin gate is
#: `_request.require_request_admin()`.
SHARED_RESOLVER = 'ResolvedRoutes'
TWO_PATH_MODULES = frozenset({'integrations_handler.py', 'scrapers_handler.py'})
#: Routes of a two-path module that a request in a workspace may not use: each calls the module's refusal as an
#: unconditional top-level statement, right after its admin gate.
WORKSPACE_REFUSAL = 'refuse_in_workspace'
WORKSPACE_REFUSED: dict[str, frozenset[str]] = {
    'integrations_handler.py': frozenset({'PUT /sources/<source>/enable', 'PUT /sources/<source>/disable'}),
}
#: Modules that do not act in a workspace yet: their first middleware refuses any request that sends
#: X-Workspace-Id (shared/workspace_request.py `deployment_only`: one 400 for everyone, nothing read).
DEPLOYMENT_ONLY_MODULES: dict[str, str] = {
    's3_import_handler.py': 'the import bucket is not keyed by workspace: a reprocess in a workspace would ingest '
                            "the deployment's staged files into it",
}
ALL_METHODS = PLATFORM_GATED_METHODS


def _source(handler: str) -> str:
    return (API_DIR / handler).read_text(encoding='utf-8')


def _resolves(source: str) -> bool:
    return f'{WORKSPACE_RESOLVER}(' in source or f'{SHARED_RESOLVER}(' in source


def test_only_the_listed_modules_resolve_a_requests_workspace_for_the_data_path():
    resolving = {path.name for path in _handler_files() if _resolves(path.read_text(encoding='utf-8'))}
    assert resolving == set(WORKSPACE_SCOPED)
    assert set(WORKSPACE_FIRST_MIDDLEWARE) | set(WORKSPACE_FIRST_CALL) | TWO_PATH_MODULES == set(WORKSPACE_SCOPED)


@pytest.mark.parametrize('handler', sorted(WORKSPACE_SCOPED))
def test_every_route_of_a_two_path_module_is_workspace_scoped(handler):
    routes = {key for fn in _module_functions(ast.parse(_source(handler))).values()
              for key in _route_keys(fn, ALL_METHODS)}
    public = PUBLIC_BY_LOOKUP.get(handler, ('', frozenset()))[1]
    assert not WORKSPACE_SCOPED[handler] & public
    assert routes == WORKSPACE_SCOPED[handler] | public, 'classify the new route in WORKSPACE_SCOPED or PUBLIC_BY_LOOKUP'


def _route_function(handler: str, route: str) -> ast.FunctionDef:
    [fn] = [fn for fn in _module_functions(ast.parse(_source(handler))).values() if route in _route_keys(fn, ALL_METHODS)]
    return fn


@pytest.mark.parametrize(('handler', 'route'), sorted(
    (handler, route) for handler, (_lookup, routes) in PUBLIC_BY_LOOKUP.items() for route in routes))
def test_every_public_route_takes_its_workspace_from_a_lookup_row(handler, route):
    """A public route looks its id up (an unconditional top-level call) and never resolves the request's header."""
    lookup = PUBLIC_BY_LOOKUP[handler][0]
    fn = _route_function(handler, route)
    assert lookup in _top_level_calls(fn)
    called = {_called_name(node) for node in ast.walk(fn)}
    assert WORKSPACE_FIRST_CALL[handler] not in called
    assert WORKSPACE_RESOLVER not in called


@pytest.mark.parametrize('handler', sorted(PUBLIC_BY_LOOKUP))
def test_the_public_lookup_never_reads_the_request(handler):
    """The lookup reads the id it is given and the stored rows only: no header, body or resolver (to any depth of
    the module's own functions)."""
    functions = _module_functions(ast.parse(_source(handler)))
    reached, frontier = set(), [PUBLIC_BY_LOOKUP[handler][0]]
    while frontier:
        name = frontier.pop()
        if name in reached or name not in functions:
            continue
        reached.add(name)
        frontier.extend(n for node in ast.walk(functions[name]) if (n := _called_name(node)))
    called = {n for name in reached for node in ast.walk(functions[name]) if (n := _called_name(node))}
    attributes = {node.attr for name in reached for node in ast.walk(functions[name]) if isinstance(node, ast.Attribute)}
    assert not called & {WORKSPACE_FIRST_CALL[handler], 'context', 'request_header', 'json_body_value',
                         'json_object_body'}
    assert not attributes & {'current_event', 'raw_event', 'headers'}


@pytest.mark.parametrize(('handler', 'route'), sorted(
    (handler, route) for handler in WORKSPACE_WRITE_CALL for route in WORKSPACE_SCOPED[handler]
    if route.split(' ')[0] in {'POST', 'PUT', 'PATCH', 'DELETE'}))
def test_every_workspace_write_resolves_the_role_from_the_table(handler, route):
    first = next(stmt for stmt in _route_function(handler, route).body
                 if not (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant)))
    assert isinstance(first, ast.Assign)
    assert ast.unparse(first.value) == WORKSPACE_WRITE_CALL[handler]


def test_a_workspace_form_write_needs_the_editor_role():
    functions = _module_functions(ast.parse(_source('feedback_form_handler.py')))
    assert any(isinstance(stmt, ast.If) and _raises_authorization_error(stmt.body)
               for stmt in functions[WORKSPACE_FIRST_CALL['feedback_form_handler.py']].body)


@pytest.mark.parametrize(('handler', 'middleware', 'resolver'), sorted(
    (handler, middleware, resolver) for handler, (middleware, resolver) in WORKSPACE_FIRST_MIDDLEWARE.items()))
def test_the_workspace_is_resolved_before_every_route(handler, middleware, resolver):
    tree = ast.parse(_source(handler))
    assert middleware in _middlewares(tree)
    body = [s for s in _module_functions(tree)[middleware].body if not (isinstance(s, ast.Expr)
                                                                       and isinstance(s.value, ast.Constant))]
    first = body[0]
    assert isinstance(first, ast.Expr | ast.Return), 'the middleware must resolve the workspace first'
    calls = {_called_name(node) for node in ast.walk(first)}
    assert resolver in calls, 'the middleware must resolve the workspace first, afresh for each request'


def _shared_routes_class() -> ast.ClassDef:
    tree = ast.parse((SHARED_DIR / 'workspace_request.py').read_text(encoding='utf-8'))
    return next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == SHARED_RESOLVER)


def _method(name: str) -> ast.FunctionDef:
    return next(node for node in _shared_routes_class().body if isinstance(node, ast.FunctionDef) and node.name == name)


@pytest.mark.parametrize('handler', sorted(TWO_PATH_MODULES))
def test_an_operator_module_installs_the_shared_resolver_before_every_route(handler):
    tree = ast.parse(_source(handler))
    assigned = [stmt for stmt in tree.body if isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Call)
                and _called_name(stmt.value) == SHARED_RESOLVER]
    assert [ast.unparse(stmt) for stmt in assigned] == [f'_request = {SHARED_RESOLVER}(app)']
    uses = [stmt.value for stmt in tree.body if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call)
            and _called_name(stmt.value) == 'use']
    assert [ast.unparse(use) for use in uses] == ['app.use(middlewares=[_request.middleware])']


def test_the_shared_middleware_resolves_before_it_hands_on():
    """`ResolvedRoutes.middleware` resolves and keeps the membership before it hands on to `next_middleware`."""
    names = [_called_name(node) for stmt in _method('middleware').body for node in ast.walk(stmt)
             if isinstance(node, ast.Call)]
    assert names.index('context') < names.index('append_context') < names.index('next_middleware')


#: The admin-only reads of the two-path operator modules (also in ADMIN_ONLY_READS below).
TWO_PATH_ADMIN_READS: dict[str, frozenset[str]] = {
    'integrations_handler.py': frozenset({'GET /integrations/status', 'GET /integrations/<source>/credentials'}),
}


def _two_path_admin_keys() -> set[tuple[str, str]]:
    """The admin-only routes of the two-path operator modules."""
    return {(handler, route) for table in (ADMIN_ONLY, TWO_PATH_ADMIN_READS) for handler, routes in table.items()
            if handler in TWO_PATH_MODULES for route in routes}


@pytest.mark.parametrize(('handler', 'route'), sorted(_two_path_admin_keys()))
def test_every_admin_route_of_a_two_path_module_gates_on_the_workspace_role(handler, route):
    """In a workspace the caller's role there decides (a workspace admin or an entered platform admin), never the
    deployment's `admins`: the route calls `_request.require_request_admin()` first, never `require_admin`."""
    [fn] = [fn for fn in _module_functions(ast.parse(_source(handler))).values()
            if route in _route_keys(fn, ALL_METHODS)]
    first = next(stmt for stmt in fn.body if not (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant))
                 and not isinstance(stmt, ast.Import | ast.ImportFrom))
    assert ast.unparse(first) == f'_request.{TWO_PATH_GATE}()'
    assert GATE_PRIMITIVE not in {_called_name(node) for node in ast.walk(fn)}


def test_the_two_path_gate_checks_each_path():
    """`ResolvedRoutes.require_request_admin`: `require_admin` when no workspace was resolved,
    `require_workspace_admin` otherwise (the classifier above trusts the name; this pins what it does)."""
    [branch] = [stmt for stmt in _method(TWO_PATH_GATE).body if isinstance(stmt, ast.If)]
    assert isinstance(branch.test, ast.Compare)
    assert isinstance(branch.test.ops[0], ast.Is)
    assert [_called_name(s.value) for s in branch.body if isinstance(s, ast.Expr)] == [GATE_PRIMITIVE]
    assert [_called_name(s.value) for s in branch.orelse if isinstance(s, ast.Expr)] == [WORKSPACE_GATE]


@pytest.mark.parametrize(('handler', 'route'), sorted(
    (handler, route) for handler, routes in WORKSPACE_REFUSED.items() for route in routes))
def test_every_refused_route_refuses_a_workspace_after_its_gate(handler, route):
    assert route in WORKSPACE_SCOPED[handler]
    [fn] = [fn for fn in _module_functions(ast.parse(_source(handler))).values() if route in _route_keys(fn, ALL_METHODS)]
    order = [name for stmt in fn.body if isinstance(stmt, ast.Expr) and (name := _called_name(stmt.value))]
    assert order[:2] == [TWO_PATH_GATE, WORKSPACE_REFUSAL], order


def test_only_the_listed_routes_refuse_a_workspace():
    refusing = {(handler, key) for handler in WORKSPACE_SCOPED
                for fn in _module_functions(ast.parse(_source(handler))).values()
                if WORKSPACE_REFUSAL in _top_level_calls(fn) for key in _route_keys(fn, ALL_METHODS)}
    assert refusing == {(handler, route) for handler, routes in WORKSPACE_REFUSED.items() for route in routes}


@pytest.mark.parametrize('handler', sorted(DEPLOYMENT_ONLY_MODULES))
def test_a_deployment_only_module_refuses_the_header_first(handler):
    tree = ast.parse(_source(handler))
    [use] = [stmt.value for stmt in tree.body if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call)
             and _called_name(stmt.value) == 'use']
    [middlewares] = [keyword.value for keyword in use.keywords if keyword.arg == 'middlewares']
    assert isinstance(middlewares, ast.List)
    first = middlewares.elts[0]
    assert isinstance(first, ast.Name)
    assert first.id == 'deployment_only'
    assert not _resolves(_source(handler))


@pytest.mark.parametrize(('handler', 'route'), sorted(
    (handler, route) for handler in WORKSPACE_FIRST_CALL for route in WORKSPACE_SCOPED[handler]))
def test_every_edit_resolves_its_workspace_unconditionally(handler, route):
    [fn] = [fn for fn in _module_functions(ast.parse(_source(handler))).values() if route in _route_keys(fn, ALL_METHODS)]
    assert WORKSPACE_FIRST_CALL[handler] in _top_level_calls(fn)
    # Before the body is read, so a non-member's malformed body still gets the one 404.
    order = [name for stmt in fn.body if isinstance(stmt, _VALUE_STATEMENTS)
             for name in [_called_name(stmt.value)] if name in (WORKSPACE_FIRST_CALL[handler], 'json_body_value',
                                                                 'json_object_body', '_dimensions_body')]
    assert order[0] == WORKSPACE_FIRST_CALL[handler], order


def test_a_workspace_edit_needs_the_editor_role():
    functions = _module_functions(ast.parse(_source('feedback_edit_handler.py')))
    assert any(isinstance(stmt, ast.If) and _raises_authorization_error(stmt.body)
               for stmt in functions[WORKSPACE_FIRST_CALL['feedback_edit_handler.py']].body)


def test_removing_the_workspace_middleware_is_detected():
    tree = ast.parse(_source('metrics_handler.py'))
    tree.body = [s for s in tree.body if not (isinstance(s, ast.Expr) and _called_name(s.value) == 'use')]
    assert WORKSPACE_FIRST_MIDDLEWARE['metrics_handler.py'][0] in _middlewares(ast.parse(_source('metrics_handler.py')))
    assert WORKSPACE_FIRST_MIDDLEWARE['metrics_handler.py'][0] not in _middlewares(tree)


def test_every_table_entry_names_a_route_that_exists():
    inventory = _inventory()
    stale = sorted(key for key in _admin_keys() | set(_open_keys()) | _workspace_admin_keys() if key not in inventory)
    assert not stale, f'Table entries for routes that no longer exist: {stale}'


def test_every_open_reason_is_one_non_empty_line():
    assert [g.reason for g in OPEN_BY_DECISION if not g.reason.strip() or '\n' in g.reason] == []


def test_only_the_recorded_handlers_are_not_resolvers():
    no_routes = {path.name for path in _handler_files() if 'create_api_resolver(' not in path.read_text(encoding='utf-8')}
    assert no_routes == set(NON_RESOLVER_HANDLERS)


# ── Reads gated by decision ──────────────────────────────────────────────────
# The inventory above covers writes only. These reads are deliberately admin-only and are
# pinned so they cannot silently reopen. The reads in OPEN_BY_DESIGN_READS are pinned the other
# way: open to every signed-in user, each with its reason, so gating one is a visible decision.
ADMIN_ONLY_READS: dict[str, frozenset[str]] = {
    # #242: the import bucket and parse jobs are admin-only.
    's3_import_handler.py': frozenset({
        'GET /s3-import/sources', 'GET /s3-import/files', 'GET /s3-import/reprocess/<run_id>',
    }),
    'manual_import_handler.py': frozenset({
        'GET /scrapers/manual/parse/<job_id>',
        # Import history (#237): who imported what, from which file — admin data like the imports themselves.
        'GET /scrapers/manual/history', 'GET /scrapers/manual/history/<run_id>',
    }),
    # Every workspace of the deployment (the platform console, docs/multi-workspace.md): platform admins only.
    'workspaces_handler.py': frozenset({'GET /platform/workspaces'}),
    # Which credentials are set, and their non-secret values: administrators (in a workspace, its admins).
    **TWO_PATH_ADMIN_READS,
}


@pytest.mark.parametrize(('handler', 'route'), sorted(
    (handler, route) for handler, routes in ADMIN_ONLY_READS.items() for route in routes))
def test_every_admin_only_read_exists_and_carries_its_gate(handler, route):
    reads = routes_with_gates((API_DIR / handler).read_text(encoding='utf-8'), frozenset({'get'}))
    assert reads.get(route) is True, f'{handler} {route} is missing or lost its admin gate'


OPEN_BY_DESIGN_READS: dict[tuple[str, str], str] = {
    ('settings_handler.py', 'GET /settings/model'): (
        'The agent detail page\'s Models tab (every signed-in user, read-only for non-admins) reads '
        'the allowlist here; the answer is the per-surface model ids, the allowlist and the image '
        'model\'s status: no secret, no user data. Writes and the model test stay admin-only.'
    ),
    ('workspaces_handler.py', 'GET /me/workspaces'): (
        "Every signed-in person's own workspace list (docs/multi-workspace.md): one Query of the caller's "
        'USER#{sub} partition, so it names only workspaces the caller is a member of.'
    ),
    ('workspaces_handler.py', 'GET /me/workspaces/current'): (
        'The workspace the X-Workspace-Id header names, for its members (any role) and audited platform-admin '
        'entries; everyone else gets the same 404 (shared/workspace.py), so it confirms no other workspace.'
    ),
    ('workspaces_handler.py', 'GET /me/workspaces/current/members'): (
        "The members of the workspace X-Workspace-Id names, for any of its members (Roles: a viewer reads the "
        "workspace); a non-member gets the workspace's one 404 (shared/workspace.py)."
    ),
}


@pytest.mark.parametrize(('handler', 'route'), sorted(OPEN_BY_DESIGN_READS))
def test_every_open_by_design_read_exists_without_an_admin_gate(handler, route):
    assert OPEN_BY_DESIGN_READS[(handler, route)].strip(), 'an open read needs its reason'
    reads = routes_with_gates((API_DIR / handler).read_text(encoding='utf-8'), frozenset({'get'}))
    assert reads.get(route) is False, (
        f'{handler} {route} is missing or now admin-gated: update OPEN_BY_DESIGN_READS deliberately')


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
