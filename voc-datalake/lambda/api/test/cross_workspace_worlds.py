"""Two-workspace worlds for the cross-workspace suite (test_cross_workspace_routes.py).

Each world seeds TWO workspaces in moto: ``A`` (the caller's) and ``B`` (another team's), with the same kinds of
rows in each, and calls one handler as a member of A. A route case (``RouteCase``) names every id the request
carries, in its path, body or query, in A, in B and in neither (``ids['A']``, ``ids['B']``, ``ids[UNKNOWN]``), the
valid request, and the status it answers inside A: the suite proves that the request A's member makes with B's
header answers the one 404, and with B's ids under A's header the case's ``refused_status``, each exactly the
answer for a workspace or ids that exist nowhere, changing nothing; that the same request inside A works, so the
refusal comes from the isolation, not from a broken request; and that B's ids work inside B for B's admin, so they
name real rows.

Every value seeded in B carries ``B_MARK`` (``bramblewood``), so the suite can also check that no answer to A's
member ever holds B's data. Fictional names only (public-sample rules).

A new workspace-scoped route adds its case to ``CASES`` (and, for a new handler, its world to ``WORLDS``), in the
change that moves it out of cross_workspace_pending.py.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Generator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import MagicMock, patch
from urllib.parse import urlencode

import boto3
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

from shared.test.cognito_doubles import live_cognito
from shared.test.mcp_oauth_fixtures import CLIENTS, WEB_CALLBACK, oauth_env

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
#: Well formed, in no table: the answer for it is the one 404 every refusal shares.
WS_UNKNOWN = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DA'
#: In every value seeded in workspace B (names, emails, subs), never in A's.
B_MARK = 'bramblewood'
#: In a value seeded in A that a request naming no workspace must not answer (check 3, ``without_a_workspace``).
A_MARK = 'alderbrook'
#: The key of a case's ids (path, body or query) that exist in no workspace.
UNKNOWN = 'unknown'

#: A's admin, also in the deployment's ``admins`` group: the strongest caller short of a platform admin (``admins``
#: may create accounts when adding a member, and grants nothing inside a workspace). Not in ``platform-admins``.
ADA = {'sub': 'sub-ada', 'cognito:username': 'ada', 'cognito:groups': '[admins, users]'}
#: The same admin of A without the deployment group.
ADA_MEMBER_ONLY = {**ADA, 'cognito:groups': 'users'}
#: B's admin: the caller of the check that B's ids name B's real rows (they work inside B).
BEA = {'sub': f'sub-{B_MARK}-bea', 'cognito:username': f'{B_MARK}-bea', 'cognito:groups': 'users'}


@dataclass
class World:
    """One handler over two seeded workspaces. ``call(method, path, *, ws, body, query, caller)`` runs one request.

    A refused request must change nothing, and the suite sees only DynamoDB (``table_snapshot``) and ``doubles``:
    a world whose handler writes S3, SQS or Secrets Manager under moto widens ``table_snapshot`` to cover them."""

    call: Callable[..., tuple[int, Any]]
    #: The handler's doubles (Cognito here): any call that is not a read, on a refused request, fails the suite.
    doubles: dict[str, MagicMock] = field(default_factory=dict)


@dataclass(frozen=True)
class RouteCase:
    """How to call one workspace-scoped route.

    ``ids`` names every id the request carries, in ``A``, in ``B`` and in neither (``UNKNOWN``): the route's path
    parameters, and every id its body or query string carries, written in ``body`` and ``query`` as a whole value
    ``'{name}'`` (filled in per workspace); every other value of the body or query is in ``literals``, with why it
    is not an id. A route whose request carries no id but the header says why in ``no_ids``. A path parameter that
    names something of the deployment, the same in every workspace (a plugin of the catalogue), is in ``shared``
    with its value, and that value in ``literals`` with why it is not a workspace's id.

    Check 2 sends B's ids under A's header and expects ``refused_status`` with exactly the answer for the unknown
    ids, so a refusal must not repeat the ids it was sent. ``ok_status`` is the answer inside A (check 4) and, with
    B's ids, inside B as B's admin (check 5: B's ids name real rows). ``without_a_workspace`` says why the route
    keeps the deployment's row for a request that names no workspace (check 3 then expects ``ok_status`` and no row
    of A or B touched, instead of the 400)."""

    ids: dict[str, dict[str, str]] = field(default_factory=dict)
    no_ids: str = ''
    body: dict | None = None
    query: dict[str, str] | None = None
    literals: dict[str, str] = field(default_factory=dict)
    shared: dict[str, str] = field(default_factory=dict)
    ok_status: int = 200
    refused_status: int = 404
    without_a_workspace: str = ''
    #: Without a workspace the route is the deployment's ``admins`` group's (as before): check 3 expects 403 for a
    #: caller outside it.
    deployment_admins_without_a_workspace: bool = False


def table_snapshot() -> dict[str, list[str]]:
    """Every item of every moto table, sorted: equal before and after a request that changed nothing."""
    client = boto3.client('dynamodb', region_name='us-east-1')
    snapshot = {}
    for name in client.list_tables()['TableNames']:
        pages = client.get_paginator('scan').paginate(TableName=name, ConsistentRead=True)
        snapshot[name] = sorted(json.dumps(item, sort_keys=True) for page in pages for item in page['Items'])
    return snapshot


def _caller(handler: Any, lambda_context: Any, **tables: Any) -> Callable[..., tuple[int, Any]]:
    """A world's ``call``: one request to ``handler`` (its ``get_<name>_table`` patched with ``tables``)."""

    def call(method: str, path: str, *, ws: str | None, body: dict | None = None,
             query: dict[str, str] | None = None, caller: dict = ADA) -> tuple[int, Any]:
        """``method path?query`` as ``caller`` with ``X-Workspace-Id: ws`` (none when ``ws`` is None)."""
        event = rest_event(method, path, claims=caller, body=body)
        event['queryStringParameters'] = query
        if ws is not None:
            event['headers']['X-Workspace-Id'] = ws
        return invoke(handler, event, lambda_context, **tables)

    return call


# ── voc-workspaces-api (lambda/api/workspaces_handler.py) ────────────────────

def _seed_workspace(table: Any, ws: str, name: str, slug: str, members: dict[str, str]) -> None:
    table.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'name': name, 'slug': slug, 'status': 'active'})
    for sub, role in members.items():
        table.put_item(Item={'pk': f'WS#{ws}', 'sk': f'MEMBER#{sub}', 'role': role,
                             'email': f'{sub.removeprefix("sub-")}@example.com', 'name': sub})
        table.put_item(Item={'pk': f'USER#{sub}', 'sk': f'WS#{ws}', 'name': name, 'slug': slug, 'role': role})


_NO_ACCOUNT = 'nia@example.com'
#: A plugin the deployment offers.
PLUGIN = 'webscraper'


def _list_users(**params: Any) -> dict:
    """Cognito ListUsers for the two filters the members code sends (an email, a sub): one account per seeded sub,
    none for ``nia@example.com`` (so adding her creates one, the path that writes to Cognito)."""
    field_name, _, value = params['Filter'].partition(' = ')
    value = value.strip('"')
    if value == _NO_ACCOUNT:
        return {'Users': []}
    sub = value if field_name == 'sub' else f'sub-{value.removesuffix("@example.com")}'
    email = f'{sub.removeprefix("sub-")}@example.com'
    return {'Users': [{'Username': f'u-{sub}', 'Attributes': [
        {'Name': 'sub', 'Value': sub}, {'Name': 'email', 'Value': email}, {'Name': 'name', 'Value': sub}]}]}


@contextmanager
def workspaces_world(lambda_context: Any) -> Generator[World]:
    import workspaces_handler
    from shared import platform_admin_gate
    from shared.workspace import MembershipCache

    # The live groups say `users` only, and the token carries no `platform-admins`: nobody is elevated here.
    cognito = live_cognito(groups=('users',), sub='sub-ada')
    cognito.list_users.side_effect = _list_users
    cognito.admin_create_user.return_value = {'User': {'Username': 'u-sub-nia', 'Attributes': [
        {'Name': 'sub', 'Value': 'sub-nia'}, {'Name': 'email', 'Value': _NO_ACCOUNT}]}}
    with ExitStack() as stack:
        stack.enter_context(mock_aws())
        stack.enter_context(patch.object(workspaces_handler, 'memberships', MembershipCache()))
        stack.enter_context(patch.object(workspaces_handler, 'USER_POOL_ID', 'us-east-1_pool'))
        stack.enter_context(patch.object(workspaces_handler, 'get_cognito_idp_client', return_value=cognito))
        stack.enter_context(patch.object(platform_admin_gate, 'get_cognito_idp_client', return_value=cognito))
        # The deployment's plugins (cdk.context.json): the ceiling a workspace picks from.
        stack.enter_context(patch.dict('os.environ', {'ENABLED_SOURCES': f'["{PLUGIN}"]',
                                                      'USER_POOL_ID': 'us-east-1_pool'}))
        table = pk_sk_table('workspaces')
        _seed_workspace(table, WS_A, 'Acme Outfitters', 'acme',
                        {'sub-ada': 'admin', 'sub-edi': 'editor', 'sub-vic': 'viewer'})
        _seed_workspace(table, WS_B, f'{B_MARK.title()} Bikes', B_MARK,
                        {f'sub-{B_MARK}-bea': 'admin', f'sub-{B_MARK}-bo': 'viewer'})
        # B enabled the plugin (shared/workspace_plugin_settings.py): A's member must not see or change it.
        table.put_item(Item={'pk': f'PLUGIN#{PLUGIN}', 'sk': f'WS#{WS_B}', 'enabled_by': f'sub-{B_MARK}-bea',
                             'enabled_at': '2026-11-12T00:00:00Z'})

        yield World(call=_caller(workspaces_handler, lambda_context, workspaces=table), doubles={'cognito': cognito})


# ── voc-settings-api (lambda/api/settings_handler.py): the routes that act in a workspace ──

#: Why the resolved-problems routes answer without a workspace: the web app with no workspace and a deployment from
#: before workspaces send no header (6.12.00 on the multi-workspace branch; decision 12), and get the deployment's row, as before.
_AS_BEFORE = 'the deployment as before: its own row, no workspace\'s (shared/request_workspace.py)'
#: A resolved problem's key: a category, subcategory and problem text the user wrote, not a row of a workspace.
PROBLEM_KEY = 'technical_support:response_time:slow replies'


def _domain_resolution(stack: ExitStack) -> MagicMock:
    """Moto and the domain APIs' shared resolution (shared/request_workspace.py) over the two seeded workspaces, for a
    world entered in ``stack``; the Cognito double of the live check (nobody is elevated)."""
    from shared import platform_admin_gate, request_workspace
    from shared.workspace import MembershipCache

    cognito = live_cognito(groups=('users',), sub='sub-ada')
    stack.enter_context(mock_aws())
    stack.enter_context(patch.dict('os.environ', {'WORKSPACES_TABLE': 'workspaces', 'USER_POOL_ID': 'us-east-1_pool'}))
    stack.enter_context(patch.object(request_workspace, '_MEMBERSHIPS', MembershipCache()))
    stack.enter_context(patch.object(platform_admin_gate, 'get_cognito_idp_client', return_value=cognito))
    workspaces = pk_sk_table('workspaces')
    stack.enter_context(patch.object(request_workspace, 'cached_table', return_value=workspaces))
    _seed_workspace(workspaces, WS_A, 'Acme Outfitters', 'acme', {'sub-ada': 'admin', 'sub-vic': 'viewer'})
    _seed_workspace(workspaces, WS_B, f'{B_MARK.title()} Bikes', B_MARK, {f'sub-{B_MARK}-bea': 'admin'})
    return cognito


@contextmanager
def settings_world(lambda_context: Any) -> Generator[World]:
    import settings_handler
    from shared.workspace_settings import settings_key

    with ExitStack() as stack:
        cognito = _domain_resolution(stack)
        aggregates = pk_sk_table('aggregates')
        stack.enter_context(patch.object(settings_handler, 'aggregates_table', aggregates))
        # Each workspace's brand, and the deployment's (for a request that names no workspace).
        aggregates.put_item(Item={**settings_handler.BRAND_KEY, 'brand_name': 'Before Workspaces'})
        aggregates.put_item(Item={**settings_key(WS_A, settings_handler.BRAND_KIND), 'brand_name': f'{A_MARK} Outfitters'})
        aggregates.put_item(Item={**settings_key(WS_B, settings_handler.BRAND_KIND), 'brand_name': f'{B_MARK} Bikes'})
        # The deployment (before workspaces) and each workspace marked one of its problems resolved (moto cannot
        # evaluate the resolve write's size() condition on a missing map, which DynamoDB answers as a failed
        # condition): A's member must not see B's, nor change B's row.
        aggregates.put_item(Item={**settings_handler.DEPLOYMENT_RESOLVED_PROBLEMS_KEY, 'resolved': {
            'technical_support:response_time:before workspaces': {'resolved_at': '2099-01-01T00:00:00+00:00'}}})
        aggregates.put_item(Item={**settings_key(WS_A, settings_handler.RESOLVED_PROBLEMS_KIND), 'resolved': {
            f'technical_support:response_time:{A_MARK} parcels late': {'resolved_at': '2099-01-01T00:00:00+00:00'}}})
        aggregates.put_item(Item={**settings_key(WS_B, settings_handler.RESOLVED_PROBLEMS_KIND), 'resolved': {
            f'technical_support:response_time:{B_MARK} chain slips': {'resolved_at': '2099-01-01T00:00:00+00:00'}}})

        yield World(call=_caller(settings_handler, lambda_context), doubles={'cognito': cognito})


# ── voc-mcp-tokens-api (lambda/api/mcp_tokens_handler.py): a token minted inside a workspace ──

@contextmanager
def tokens_world(lambda_context: Any) -> Generator[World]:
    import mcp_tokens_handler
    from shared import mcp_oauth_consent_routes, mcp_oauth_routes
    from shared.indexes import PROJECTS_BY_TYPE_INDEX

    with ExitStack() as stack:
        cognito = _domain_resolution(stack)
        projects = pk_sk_table('projects', gsi1_index=PROJECTS_BY_TYPE_INDEX)
        jobs = pk_sk_table('jobs')
        stack.enter_context(patch.object(mcp_tokens_handler, 'get_projects_table', return_value=projects))
        stack.enter_context(patch.object(mcp_tokens_handler, 'get_jobs_table', return_value=jobs))
        stack.enter_context(patch.dict(mcp_tokens_handler._index_state, {'complete': False}))
        # The OAuth consent routes (the same Lambda): the deployment's OAuth configuration and the same tables.
        stack.enter_context(oauth_env())
        for module in (mcp_oauth_consent_routes, mcp_oauth_routes):
            stack.enter_context(patch.object(module, 'get_projects_table', return_value=projects))
            stack.enter_context(patch.object(module, 'get_jobs_table', return_value=jobs))
        yield World(call=_caller(mcp_tokens_handler, lambda_context), doubles={'cognito': cognito})


#: A sign-in request of the deployment's web client (shared/test/mcp_oauth_fixtures.py): the same in every workspace.
_AUTHORIZE_QUERY = urlencode({'response_type': 'code', 'client_id': CLIENTS['web'], 'redirect_uri': WEB_CALLBACK,
                              'state': 'client-state', 'code_challenge': 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
                              'code_challenge_method': 'S256'})


_MEMBER_IDS = {'A': {'sub': 'sub-vic'}, 'B': {'sub': f'sub-{B_MARK}-bo'}, UNKNOWN: {'sub': 'sub-nobody'}}


def _members_cursor(ws: str, sub: str) -> str:
    """The members list's next-page cursor after ``sub`` (shared/workspace_members.py ``list_members``)."""
    from shared.feedback_cursor import encode_key_cursor

    return encode_key_cursor({'pk': f'WS#{ws}', 'sk': f'MEMBER#{sub}'})


#: A page cursor is an id of the workspace it came from: B's under A's header is refused like one from nowhere.
_CURSOR_IDS = {'A': {'cursor': _members_cursor(WS_A, 'sub-ada')},
               'B': {'cursor': _members_cursor(WS_B, f'sub-{B_MARK}-bea')},
               UNKNOWN: {'cursor': _members_cursor(WS_UNKNOWN, 'sub-nobody')}}

_A_ROLE = 'a workspace role (admin, editor or viewer), the same words in every workspace'

#: handler file -> the world its routes run in.
# ── voc-chat-api (lambda/api/chat_handler.py): the caller's conversations inside a workspace ──

#: Each caller's conversation in each partition: the deployment's (no workspace), A's and B's. A conversation id is
#: the caller's own name for it, so the deployment's partition holds one under A's id too (check 3 reads it).
_CONVERSATION_IDS = {'A': {'conversation_id': 'conv_a'}, 'B': {'conversation_id': 'conv_b'},
                     UNKNOWN: {'conversation_id': 'conv_unknown'}}


def _conversation(pk: str, conversation_id: str, title: str) -> dict:
    return {'pk': pk, 'sk': f'CONV#{conversation_id}', 'conversation_id': conversation_id, 'kind': 'assistant',
            'title': title, 'messages_json': '[]', 'page_json': '{}', 'pending_json': '[]', 'message_count': 0,
            'created_at': '2026-11-01T00:00:00+00:00', 'updated_at': '2026-11-01T00:00:00+00:00', 'revision': 1}


@contextmanager
def chat_world(lambda_context: Any) -> Generator[World]:
    import chat_handler

    with ExitStack() as stack:
        cognito = _domain_resolution(stack)
        conversations = pk_sk_table('conversations')
        stack.enter_context(patch.object(chat_handler, 'conversations_table', conversations))
        conversations.put_item(Item=_conversation('USER#sub-ada', 'conv_a', 'Before workspaces'))
        conversations.put_item(Item=_conversation(f'WS#{WS_A}#USER#sub-ada', 'conv_a', f'{A_MARK} returns'))
        conversations.put_item(Item=_conversation(f'WS#{WS_B}#USER#sub-{B_MARK}-bea', 'conv_b', f'{B_MARK} chains'))
        yield World(call=_caller(chat_handler, lambda_context), doubles={'cognito': cognito})


WORLDS: dict[str, Callable[[Any], Any]] = {
    'workspaces_handler.py': workspaces_world,
    'settings_handler.py': settings_world,
    'mcp_tokens_handler.py': tokens_world,
    'chat_handler.py': chat_world,
    'mcp_oauth_consent_routes.py': tokens_world,
}

#: (handler file, "METHOD /path") -> how to call it: exactly the workspace-scoped routes.
CASES: dict[tuple[str, str], RouteCase] = {
    ('workspaces_handler.py', 'GET /me/workspaces/current'): RouteCase(
        no_ids='the header is its only id: check 1'),
    ('workspaces_handler.py', 'GET /me/workspaces/current/members'): RouteCase(
        ids=_CURSOR_IDS, query={'cursor': '{cursor}'}, refused_status=400),
    # A new email from a deployment admin: the path that creates a Cognito account.
    ('workspaces_handler.py', 'POST /me/workspaces/current/members'): RouteCase(
        no_ids='the email names an account of the deployment, not a row of B: adding an account that is also in B '
               'is the design (decision 4, an invitee may already have an account)',
        body={'email': _NO_ACCOUNT, 'role': 'viewer'}, ok_status=201,
        literals={_NO_ACCOUNT: 'an email, not a row of a workspace (no_ids)', 'viewer': _A_ROLE}),
    ('workspaces_handler.py', 'PUT /me/workspaces/current/members/<sub>'): RouteCase(
        ids=_MEMBER_IDS, body={'role': 'editor'}, literals={'editor': _A_ROLE}),
    ('workspaces_handler.py', 'DELETE /me/workspaces/current/members/<sub>'): RouteCase(ids=_MEMBER_IDS),
    ('workspaces_handler.py', 'GET /me/workspaces/current/plugins'): RouteCase(
        no_ids='the header is its only id: check 1 (B enabled the plugin; A lists it as not enabled)'),
    ('workspaces_handler.py', 'PUT /me/workspaces/current/plugins/<plugin_id>'): RouteCase(
        no_ids='the plugin is the deployment\'s, the workspace is the header: check 1',
        shared={'plugin_id': PLUGIN}, literals={PLUGIN: 'a plugin of the deployment, the same in every workspace'},
        # Disabling: the write a workspace may make until per-workspace ingestion is in (enabling is refused, 409,
        # shared/workspace_plugin_settings.py); B's enabled row must stay B's.
        body={'enabled': False}),
    ('settings_handler.py', 'GET /settings/resolved-problems'): RouteCase(
        no_ids='the header is its only id: check 1 (B resolved a problem; A lists only its own)',
        without_a_workspace=_AS_BEFORE),
    ('settings_handler.py', 'PUT /settings/resolved-problems'): RouteCase(
        no_ids='the problem key is text the user wrote, the workspace is the header: check 1',
        body={'key': PROBLEM_KEY, 'resolved': True},
        literals={PROBLEM_KEY: 'a problem key (category:subcategory:problem text), not a row of a workspace'},
        without_a_workspace=_AS_BEFORE),
    ('mcp_tokens_handler.py', 'POST /connect/tokens'): RouteCase(
        no_ids='the token is new, the workspace is the header: check 1 (minted inside it, the token acts there)',
        body={'name': 'laptop', 'scope': 'read'}, ok_status=200,
        literals={'laptop': 'a name the person typed for their token', 'read': 'a token scope, the same everywhere'},
        without_a_workspace=_AS_BEFORE),
    ('mcp_oauth_consent_routes.py', 'POST /connect/oauth/consent'): RouteCase(
        no_ids='the sign-in request is a client of the deployment, the workspace is the header: check 1 (approved '
               'inside it, the sign-in acts there)',
        body={'authorize_query': _AUTHORIZE_QUERY, 'scope': 'read'},
        literals={_AUTHORIZE_QUERY: "a sign-in request of the deployment's web client, the same in every workspace",
                  'read': 'a token scope, the same everywhere'},
        without_a_workspace=_AS_BEFORE),
    ('chat_handler.py', 'GET /chat/conversations/<conversation_id>'): RouteCase(
        ids=_CONVERSATION_IDS, without_a_workspace=_AS_BEFORE),
    ('chat_handler.py', 'DELETE /chat/conversations/<conversation_id>'): RouteCase(
        # A delete of a conversation the caller has none of deletes nothing and answers success, as before.
        ids=_CONVERSATION_IDS, refused_status=200, without_a_workspace=_AS_BEFORE),
    ('chat_handler.py', 'PUT /chat/conversations/<conversation_id>/title'): RouteCase(
        ids=_CONVERSATION_IDS, body={'title': 'Renamed'},
        literals={'Renamed': 'a title the person typed, not a row of a workspace'}, without_a_workspace=_AS_BEFORE),
    ('chat_handler.py', 'POST /chat/conversations/<conversation_id>'): RouteCase(
        no_ids="a conversation id is the caller's own name for it in their own partition (the save creates it), "
               'the workspace is the header: check 1',
        shared={'conversation_id': 'conv_new'}, body={'title': 'Trip notes', 'messages': []},
        literals={'conv_new': "the caller's own name for a new conversation, in their own partition",
                  'Trip notes': 'a title the person typed, not a row of a workspace'},
        without_a_workspace=_AS_BEFORE),
    ('chat_handler.py', 'POST /chat/conversations/<conversation_id>/cancel'): RouteCase(
        no_ids="the Stop marker lands in the caller's own partition under the id they name, the workspace is the "
               'header: check 1',
        shared={'conversation_id': 'conv_a'}, body={'runId': 'run_1'},
        literals={'conv_a': "the caller's own conversation, in their own partition",
                  'run_1': 'the id of a run the stream Lambda started for the caller'},
        without_a_workspace=_AS_BEFORE),
    ('settings_handler.py', 'GET /settings/brand'): RouteCase(
        no_ids='the header is its only id: check 1 (each workspace has its own brand)',
        without_a_workspace=_AS_BEFORE),
    ('settings_handler.py', 'PUT /settings/brand'): RouteCase(
        no_ids='the brand is text the admin wrote, the workspace is the header: check 1',
        body={'brand_name': 'Trailhead'}, literals={'Trailhead': 'a brand name the admin typed, not a row of a workspace'},
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True),
}
