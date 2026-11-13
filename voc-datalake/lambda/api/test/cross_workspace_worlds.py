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
from datetime import UTC, datetime, timedelta
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
        # ``default=repr``: a binary attribute (a memory's embedding) as its bytes' repr, the same every time.
        snapshot[name] = sorted(json.dumps(item, sort_keys=True, default=repr) for page in pages for item in page['Items'])
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
        # The export routes (shared/export_jobs.py): each workspace's completed export in voc-aggregates, so a link
        # signed in A could only name A's; B's id carries B's mark.
        export_invoke = _export_world(stack, workspaces_handler)

        yield World(call=_caller(workspaces_handler, lambda_context, workspaces=table),
                    doubles={'cognito': cognito, 'export_invoke': export_invoke})


def _export_world(stack: ExitStack, workspaces_handler: Any) -> MagicMock:
    """voc-aggregates with a completed export in A and in B, the raw bucket's double and the job's invoke."""
    from shared.test.export_s3_double import ExportS3

    aggregates = pk_sk_table('aggregates')
    completed = datetime.now(UTC)
    for ws, export_id in ((WS_A, 'ex_01JCACME0000000000000000A1'), (WS_B, f'ex_{B_MARK}')):
        aggregates.put_item(Item={'pk': f'WS#{ws}#JOB#export', 'sk': export_id, 'export_id': export_id,
                                  'status': 'completed', 'created_at': completed.isoformat(),
                                  'completed_at': completed.isoformat(),
                                  'expires_at': (completed + timedelta(days=7)).isoformat(), 'size_bytes': 10})
    export_invoke = MagicMock()
    stack.enter_context(patch.object(workspaces_handler, 'get_dynamodb_resource',
                                     return_value=boto3.resource('dynamodb', region_name='us-east-1')))
    stack.enter_context(patch.object(workspaces_handler, 'get_s3_client', return_value=ExportS3('raw-bucket')))
    stack.enter_context(patch.object(workspaces_handler, 'AGGREGATES_TABLE', 'aggregates'))
    stack.enter_context(patch.object(workspaces_handler, 'RAW_DATA_BUCKET', 'raw-bucket'))
    stack.enter_context(patch.object(workspaces_handler, 'EXPORT_FUNCTION', 'voc-workspace-export'))
    stack.enter_context(patch.object(workspaces_handler, 'invoke_lambda_async', export_invoke))
    return export_invoke


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
        # The categories, dimensions and source profiles of the deployment and of each workspace (7.08.00).
        for key, mark in ((None, 'before_workspaces'), (WS_A, A_MARK), (WS_B, B_MARK)):
            for kind, deployment_key, row in _config_rows(settings_handler, mark):
                aggregates.put_item(Item={**(deployment_key if key is None else settings_key(key, kind)), **row})
        # A finished category reprocess of the deployment and of each workspace (7.13.00), each in its own job
        # partition; the deployment's has A's id, so a request without the header naming it reaches the deployment's.
        invoke = MagicMock(name='invoke_lambda_async')
        stack.enter_context(patch.object(settings_handler, 'CATEGORY_REPROCESS_FUNCTION', 'voc-category-reprocess'))
        stack.enter_context(patch.object(settings_handler, 'invoke_lambda_async', invoke))
        for row in _reprocess_jobs():
            aggregates.put_item(Item=row)

        yield World(call=_caller(settings_handler, lambda_context), doubles={'cognito': cognito, 'lambda': invoke})


#: A category reprocess job id of each workspace, and one in none (shared/reprocess_jobs.py ``rp_`` + 12 hex).
REPROCESS_JOB_A = 'rp_0000000000a1'
REPROCESS_JOB_B = 'rp_0000000000b1'
_REPROCESS_JOB_IDS = {'A': {'job_id': REPROCESS_JOB_A}, 'B': {'job_id': REPROCESS_JOB_B},
                      UNKNOWN: {'job_id': 'rp_0000000000ff'}}


def _reprocess_jobs() -> list[dict[str, Any]]:
    """A completed job of the deployment (``JOB#category_reprocess``, A's id) and of each workspace
    (``WS#{ws}#JOB#category_reprocess``, naming it), each started by someone of its own scope."""
    def row(pk: str, job_id: str, started_by: str, ws: str | None) -> dict[str, Any]:
        stored = {'pk': pk, 'sk': job_id, 'status': 'completed', 'mode': 'processed', 'days': 0,
                  'include_manual': False, 'scanned': 3, 'updated': 2, 'unchanged': 1, 'skipped_manual': 0,
                  'failed': 0, 'started_by': started_by, 'created_at': '2026-11-12T00:00:00+00:00',
                  'updated_at': '2026-11-12T00:05:00+00:00', 'date_basis': 'processed'}
        return stored if ws is None else {**stored, 'workspace_id': ws}

    return [row('JOB#category_reprocess', REPROCESS_JOB_A, 'before-workspaces-admin', None),
            row(f'WS#{WS_A}#JOB#category_reprocess', REPROCESS_JOB_A, 'ada', WS_A),
            row(f'WS#{WS_B}#JOB#category_reprocess', REPROCESS_JOB_B, f'{B_MARK}-bea', WS_B)]


def _config_rows(settings_handler: Any, mark: str) -> list[tuple[str, dict[str, str], dict[str, Any]]]:
    """``(kind, the deployment's key, the row's fields)`` of the categories, dimensions and source profiles, each
    value carrying ``mark`` (the scope's own words, so an answer that holds another scope's shows it)."""
    return [
        (settings_handler.CATEGORIES_KIND, settings_handler.CATEGORIES_SETTINGS_KEY,
         {'categories': [{'id': f'cat_{mark}', 'name': f'{mark}_parcels', 'subcategories': []}]}),
        (settings_handler.DIMENSIONS_KIND, settings_handler.DIMENSIONS_SETTINGS_KEY,
         {'dimensions': [{'key': 'region', 'label': 'Region', 'infer': True, 'values': [{'name': f'{mark}_north'}]}]}),
        (settings_handler.SOURCES_KIND, settings_handler.SOURCES_SETTINGS_KEY,
         {'sources': [{'id': 'webscraper', 'label': f'{mark} reviews', 'pii': 'allow', 'restricted': False}]}),
    ]


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


# ── voc-memory-api (lambda/api/memory_handler.py): a workspace's memories ──

#: The memories each route acts on, in A, in B and in neither, by the state the route needs; the deployment's
#: partitions hold the same ids (check 3 reads them there), with nothing of A's in them.
_MEMORY_STATES = {'memory_id': 'active', 'other_id': 'active', 'archived_id': 'archived', 'review_id': 'proposed'}
_MEMORY_IDS = {
    'A': {name: f'mem_a{n}' for n, name in enumerate(_MEMORY_STATES)},
    'B': {name: f'mem_b{n}' for n, name in enumerate(_MEMORY_STATES)},
    UNKNOWN: {name: f'mem_u{n}' for n, name in enumerate(_MEMORY_STATES)},
}
_IMPORT_IDS = {'A': {'import_id': 'imp_a'}, 'B': {'import_id': 'imp_b'}, UNKNOWN: {'import_id': 'imp_unknown'}}


@contextmanager
def memory_world(lambda_context: Any) -> Generator[World]:
    import memory_handler
    from shared import memory_categories
    from shared import memory_store as store
    from shared.indexes import MEMORY_BY_STATUS_INDEX
    from shared.test.memory_fixtures import _as_detailed, fake_vector, relations_reply
    from shared.ws_repo import WorkspaceScope

    with ExitStack() as stack:
        cognito = _domain_resolution(stack)
        memory = pk_sk_table('memory', gsi1_index=MEMORY_BY_STATUS_INDEX)
        pk_sk_table('aggregates')
        stack.enter_context(patch.dict('os.environ', {store.MEMORY_TABLE_ENV: 'memory'}))
        stack.enter_context(patch.object(memory_handler, 'AGGREGATES_TABLE', 'aggregates'))
        bucket = boto3.client('s3', region_name='us-east-1')
        bucket.create_bucket(Bucket='raw')
        queue = boto3.client('sqs', region_name='us-east-1').create_queue(QueueName='memory-extract')['QueueUrl']
        stack.enter_context(patch.object(memory_handler, 'RAW_DATA_BUCKET', 'raw'))
        stack.enter_context(patch.object(memory_handler, 'MEMORY_QUEUE_URL', queue))
        stack.enter_context(patch.object(store, 'embed_text', side_effect=fake_vector))
        stack.enter_context(patch.object(store, 'converse_detailed',
                                         side_effect=_as_detailed(MagicMock(return_value=relations_reply([])))))
        stack.enter_context(patch.object(memory_categories, 'converse_detailed', side_effect=_as_detailed(
            MagicMock(return_value=json.dumps({'categories': []})))))
        store._table_cache.clear()
        store.clear_pool_cache()
        stack.callback(store._table_cache.clear)
        stack.callback(store.clear_pool_cache)
        now = datetime(2026, 11, 13, tzinfo=UTC)
        for workspace, ids, mark in ((None, _MEMORY_IDS['A'], 'before workspaces'),
                                     (WorkspaceScope(WS_A), _MEMORY_IDS['A'], A_MARK),
                                     (WorkspaceScope(WS_B), _MEMORY_IDS['B'], B_MARK)):
            for name, memory_id in ids.items():
                statement = f'{mark} buyers ask about {name.replace("_", " ")} refunds'
                found = store.Candidate(statement=statement, kind='product', scope='company', confidence=1.0,
                                        source_kind='user_explicit', source={'type': 'session', 'ref': 'manual'},
                                        supporter='h-seed', workspace=workspace)
                memory.put_item(Item=store.build_item(found, memory_id=memory_id, status=_MEMORY_STATES[name],
                                                      vector=fake_vector(statement), aligned_ids=[], now=now))
        for workspace, import_id, mark in ((None, 'imp_a', 'before workspaces'), (WorkspaceScope(WS_A), 'imp_a', A_MARK),
                                           (WorkspaceScope(WS_B), 'imp_b', B_MARK)):
            memory.put_item(Item={**store.import_key(import_id, workspace), 'import_id': import_id, 'title': mark,
                                  'status': 'done'})
        yield World(call=_caller(memory_handler, lambda_context), doubles={'cognito': cognito})


_A_STATEMENT = 'Buyers want clearer refund timelines'


WORLDS: dict[str, Callable[[Any], Any]] = {
    'workspaces_handler.py': workspaces_world,
    'settings_handler.py': settings_world,
    'mcp_tokens_handler.py': tokens_world,
    'chat_handler.py': chat_world,
    'memory_handler.py': memory_world,
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
        # Enabling (since 7.14.00, shared/workspace_plugin_settings.py): A's enable writes A's row only; B's enabled
        # row must stay B's.
        body={'enabled': True}),
    # The export (shared/export_jobs.py): A and B each hold a completed export; A's routes reach A's job rows only.
    ('workspaces_handler.py', 'POST /me/workspaces/current/export'): RouteCase(
        no_ids='the export is new, the workspace is the header: check 1', ok_status=202),
    ('workspaces_handler.py', 'GET /me/workspaces/current/export'): RouteCase(
        no_ids="the header is its only id: check 1 (B's completed export; A reads only its own)"),
    ('workspaces_handler.py', 'POST /me/workspaces/current/export/link'): RouteCase(
        no_ids="the header is its only id: check 1 (a link signed in A names A's export, never B's)"),
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
    **{('memory_handler.py', route): RouteCase(
        no_ids="the header is its only id: check 1 (each workspace's memories are its own)",
        query=query, literals=literals, without_a_workspace=_AS_BEFORE)
       for route, query, literals in (
           ('GET /memory', None, {}),
           ('GET /memory/review', None, {}),
           ('GET /memory/conflict-check', {'statement': _A_STATEMENT},
            {_A_STATEMENT: 'a statement the person typed, not a row of a workspace'}))},
    ('memory_handler.py', 'POST /memory/retrieve'): RouteCase(
        no_ids="the query is text, the header is its only id: check 1 (each workspace's memories are its own)",
        body={'query': 'refunds'}, literals={'refunds': 'a question the person asked'},
        without_a_workspace=_AS_BEFORE),
    ('memory_handler.py', 'POST /memory'): RouteCase(
        no_ids='the memory is new, the workspace is the header: check 1',
        body={'scope': 'company', 'statement': _A_STATEMENT},
        literals={'company': 'a memory scope, the same everywhere',
                  _A_STATEMENT: 'a statement the person typed, not a row of a workspace'},
        without_a_workspace=_AS_BEFORE),
    ('memory_handler.py', 'POST /memory/<memory_id>/confirm'): RouteCase(
        ids={side: {'memory_id': ids['memory_id']} for side, ids in _MEMORY_IDS.items()},
        without_a_workspace=_AS_BEFORE),
    **{('memory_handler.py', route): RouteCase(
        ids={side: {'memory_id': ids[name]} for side, ids in _MEMORY_IDS.items()}, body=body, literals=literals,
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True)
       for route, name, body, literals in (
           ('PUT /memory/<memory_id>', 'memory_id', {'kind': 'product'}, {'product': 'a memory kind, the same everywhere'}),
           ('POST /memory/<memory_id>/forget', 'memory_id', None, {}),
           ('POST /memory/<memory_id>/restore', 'archived_id', None, {}),
           ('POST /memory/review/<memory_id>/resolve', 'review_id', {'action': 'keep_both'},
            {'keep_both': 'a review action, the same everywhere'}))},
    ('memory_handler.py', 'POST /memory/merge'): RouteCase(
        ids={side: {'memory_id': ids['memory_id'], 'other_id': ids['other_id']} for side, ids in _MEMORY_IDS.items()},
        body={'ids': ['{memory_id}', '{other_id}'], 'statement': _A_STATEMENT},
        literals={_A_STATEMENT: 'a statement the person typed, not a row of a workspace'},
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True),
    ('memory_handler.py', 'POST /memory/imports'): RouteCase(
        no_ids='the page is new, the workspace is the header: check 1 (its record, page and queue message are the '
               "workspace's)",
        body={'title': 'Returns policy', 'content': 'Buyers may return within thirty days.'},
        literals={'Returns policy': 'a page title the curator typed',
                  'Buyers may return within thirty days.': 'a page the curator pasted'},
        ok_status=202, without_a_workspace=_AS_BEFORE,
        deployment_admins_without_a_workspace=True),
    ('memory_handler.py', 'GET /memory/imports/<import_id>'): RouteCase(
        ids=_IMPORT_IDS, without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True),
    ('settings_handler.py', 'GET /settings/brand'): RouteCase(
        no_ids='the header is its only id: check 1 (each workspace has its own brand)',
        without_a_workspace=_AS_BEFORE),
    ('settings_handler.py', 'PUT /settings/brand'): RouteCase(
        no_ids='the brand is text the admin wrote, the workspace is the header: check 1',
        body={'brand_name': 'Trailhead'}, literals={'Trailhead': 'a brand name the admin typed, not a row of a workspace'},
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True),
    # The categories, dimensions and source profiles (7.08.00): each workspace's own rows, the deployment's without
    # the header; any member reads, the workspace's admins write.
    ('settings_handler.py', 'GET /settings/categories'): RouteCase(
        no_ids='the header is its only id: check 1 (each workspace has its own categories)',
        without_a_workspace=_AS_BEFORE),
    ('settings_handler.py', 'PUT /settings/categories'): RouteCase(
        no_ids='the categories are names the admin typed, the workspace is the header: check 1',
        body={'categories': [{'name': 'trail_gear'}]},
        literals={'trail_gear': 'a category name the admin typed, not a row of a workspace'},
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True),
    ('settings_handler.py', 'GET /settings/dimensions'): RouteCase(
        no_ids='the header is its only id: check 1 (each workspace has its own dimensions)',
        without_a_workspace=_AS_BEFORE),
    ('settings_handler.py', 'PUT /settings/dimensions'): RouteCase(
        no_ids='the dimensions are keys and values the admin typed, the workspace is the header: check 1',
        body={'dimensions': [{'key': 'terrain', 'values': [{'name': 'gravel'}]}]},
        literals={'terrain': 'a dimension key the admin typed, not a row of a workspace',
                  'gravel': 'a dimension value the admin typed, not a row of a workspace'},
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True),
    # The category reprocess (7.13.00): each workspace's own job, its admins start, read and cancel it; without the
    # header the deployment's job, for the deployment's admins, as before.
    ('settings_handler.py', 'POST /settings/categories/reprocess'): RouteCase(
        no_ids='the job is new and replays the workspace the header names: check 1 (B finished a job; A starts its own)',
        body={'mode': 'processed', 'days': 0}, ok_status=202,
        literals={'processed': 'a reprocess mode, the same words in every workspace',
                  '0': 'a window in days (0 = all time), not a row of a workspace'},
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True),
    ('settings_handler.py', 'GET /settings/categories/reprocess'): RouteCase(
        no_ids="the header is its only id: check 1 (each workspace sees its own latest job, never B's)",
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True),
    ('settings_handler.py', 'POST /settings/categories/reprocess/<job_id>/cancel'): RouteCase(
        ids=_REPROCESS_JOB_IDS, without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True),
    ('settings_handler.py', 'GET /settings/sources'): RouteCase(
        no_ids='the header is its only id: check 1 (each workspace has its own source profiles)',
        without_a_workspace=_AS_BEFORE),
    ('settings_handler.py', 'PUT /settings/sources'): RouteCase(
        no_ids="the profile names a source of the deployment's catalogue, the workspace is the header: check 1",
        body={'sources': [{'id': PLUGIN, 'pii': 'redact'}]},
        literals={PLUGIN: 'a plugin of the deployment, the same source id in every workspace',
                  'redact': 'a PII policy, the same words in every workspace'},
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True),
}
