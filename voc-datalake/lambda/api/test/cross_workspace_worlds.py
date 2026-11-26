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

#: Imported with the module, before conftest.py's autouse fixture replaces it for each test (``manual_import_world``).
from shared.import_runs import _put_rows as _write_run_rows
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
    #: Set only on a route that refuses a workspace's ids deployment-wide (it answers a workspace's id the unknown
    #: id's 404 there: feedback_form_handler.py ``_refuse_a_workspaces_id``, manual_import_handler.py
    #: ``_require_job``): the ids check 3 sends without the header, the deployment's own row's, named like ``ids``;
    #: check 3 then also proves A's ids are refused there exactly as unknown ones. Without the refusal A's ids must
    #: reach a row there (a deployment copy, or A's own row under a key shared by every place), or that proof is
    #: vacuous (test_cross_workspace_routes.py ``test_a_deployment_request_that_takes_a_workspaces_id_is_caught``).
    #: None: check 3 sends A's ids.
    deployment_ids: dict[str, str] | None = None
    #: A known gap, reported and open (with ``deployment_ids``): check 3 expects exactly these answers.
    known_gap: KnownGap | None = None
    #: The rows outside A a request inside A may add or change (check 4: every other row it touches names A), by the
    #: start of their ``pk`` and of their ``sk`` (so a row beside them that must name A still does: a plan's ``META``
    #: beside its ``STEP#`` rows), each with why it is no workspace's: a caller's own per-person row, a deployment
    #: counter.
    outside_a: dict[tuple[str, str], str] = field(default_factory=dict)
    #: A refusal that repeats the id it was sent (reported, open): why. Checks 2 and 3 then compare the answers with
    #: each sent id's value read as its ``{name}`` (only the caller's own input; anything else in the answer still
    #: counts), and expect the raw refusal to still hold an id it was sent, so the case fails, asking for this to go,
    #: the day it stops.
    echoes_its_ids: str = ''


@dataclass(frozen=True)
class KnownGap:
    """A route that, without the header, still answers a workspace's ids otherwise than unknown ones: why, and the
    two answers exactly (both still change nothing and answer nothing of A's or B's). Any other pair fails check 3: a
    worse answer, and the day the route answers both alike, when this is to go."""

    reason: str
    a_answer: tuple[int, Any]
    unknown_answer: tuple[int, Any]


def table_snapshot() -> dict[str, list[str]]:
    """Every item of every moto table, sorted: equal before and after a request that changed nothing."""
    client = boto3.client('dynamodb', region_name='us-east-1')
    snapshot = {}
    for name in client.list_tables()['TableNames']:
        pages = client.get_paginator('scan').paginate(TableName=name, ConsistentRead=True)
        # ``default=repr``: a binary attribute (a memory's embedding) as its bytes' repr, the same every time.
        snapshot[name] = sorted(json.dumps(item, sort_keys=True, default=repr) for page in pages for item in page['Items'])
    # And every object of every moto bucket (its key, ETag and time written: the same bytes written again count): a
    # refused request writes no raw copy either.
    s3 = boto3.client('s3', region_name='us-east-1')
    for bucket in s3.list_buckets().get('Buckets', []):
        name = bucket.get('Name', '')
        pages = s3.get_paginator('list_objects_v2').paginate(Bucket=name)
        snapshot[f's3://{name}'] = sorted(f"{obj.get('Key')} {obj.get('ETag')} {obj.get('LastModified')}"
                                          for page in pages for obj in page.get('Contents', []))
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
    # The platform console's listing row a creation writes (shared/platform_workspaces.py): a hard delete moves it.
    table.put_item(Item={'pk': 'WORKSPACES', 'sk': f'{name.lower()}#{ws}', 'workspace_id': ws, 'name': name,
                         'slug': slug, 'status': 'active'})
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
    # The hard delete (4d-2, shared/workspace_deletes.py) on, with its job's invoke (the same double).
    stack.enter_context(patch.dict('os.environ', {'WORKSPACE_HARD_DELETE': 'true'}))
    stack.enter_context(patch.object(workspaces_handler, 'DELETE_FUNCTION', 'voc-workspace-delete'))
    return export_invoke


# ── voc-settings-api (lambda/api/settings_handler.py): the routes that act in a workspace ──

#: Why the resolved-problems routes answer without a workspace: the web app with no workspace and a deployment from
#: before workspaces send no header (6.12.00 on the multi-workspace branch; decision 12), and get the deployment's row, as before.
_AS_BEFORE = 'the deployment as before: its own row, no workspace\'s (shared/request_workspace.py)'
#: A settings change in any place bumps the deployment's one configuration counter (a number the caches key on, no
#: content of A's).
_CONFIG_VERSION = {('METRIC#meta', 'config_version'): "the deployment's configuration counter (config_version), bumped by any place"}
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
        # A feedback form's AI draft (shared/forms_v2_draft_routes.py, on this Lambda since 7.55.00's AI review): an
        # assist job of the deployment and of each workspace, each in its starter's own partition of voc-jobs.
        jobs = pk_sk_table('jobs')
        stack.enter_context(patch('shared.assist_jobs.get_jobs_table', return_value=jobs))
        assist = stack.enter_context(patch('shared.assist_jobs.invoke_lambda_async'))
        stack.enter_context(patch.dict('os.environ', {'ASSIST_WORKER_FUNCTION': 'voc-settings-assist'}))
        for row in _draft_jobs():
            jobs.put_item(Item=row)
        # A form of the deployment (A's id) and of each workspace, for a report's AI summary (7.63.00).
        for row in _report_forms():
            aggregates.put_item(Item=row)
        # In-app micro-feedback (7.66.00): a form fit to receive it and the settings naming it, of the deployment (A's
        # id) and of each workspace.
        for row in _app_feedback_rows():
            aggregates.put_item(Item=row)
        # The leadership view's baselines (7.70.00), of the deployment and of each workspace, each note its scope's.
        for row in _adoption_rows():
            aggregates.put_item(Item=row)

        yield World(call=_caller(settings_handler, lambda_context),
                    doubles={'cognito': cognito, 'lambda': invoke, 'assist': assist})


#: A form draft's job id of each workspace, and one in none (shared/assist_jobs.py ``job_`` + 16 hex).
DRAFT_JOB_A = 'job_00000000000000a1'
DRAFT_JOB_B = 'job_00000000000000b1'
_DRAFT_JOB_IDS = {'A': {'job_id': DRAFT_JOB_A}, 'B': {'job_id': DRAFT_JOB_B},
                  UNKNOWN: {'job_id': 'job_00000000000000ff'}}


def _draft_jobs() -> list[dict[str, Any]]:
    """A finished form draft of the deployment (``ASSIST#sub-ada``, A's id) and of each workspace
    (``WS#{ws}#ASSIST#{its admin's sub}``), each result carrying its own scope's words."""
    def row(pk: str, job_id: str, mark: str) -> dict[str, Any]:
        return {'pk': pk, 'sk': f'JOB#{job_id}', 'job_id': job_id, 'job_type': 'assist_form_draft', 'status': 'completed',
                'created_at': '2026-11-18T00:00:00+00:00', 'updated_at': '2026-11-18T00:01:00+00:00',
                'result': {'success': True, 'form': {'name': f'{mark} survey'}}}

    return [row('ASSIST#sub-ada', DRAFT_JOB_A, 'before_workspaces'),
            row(f'WS#{WS_A}#ASSIST#sub-ada', DRAFT_JOB_A, A_MARK),
            row(f'WS#{WS_B}#ASSIST#{BEA["sub"]}', DRAFT_JOB_B, B_MARK)]


#: A form of each workspace, and one in none, that an AI summary may be asked for (7.63.00).
REPORT_FORM_A = 'ff_000000000000000000000000000000a1'
REPORT_FORM_B = 'ff_000000000000000000000000000000b1'
_REPORT_FORM_IDS = {'A': {'form_id': REPORT_FORM_A}, 'B': {'form_id': REPORT_FORM_B},
                    UNKNOWN: {'form_id': 'ff_000000000000000000000000000000ff'}}


def _report_forms() -> list[dict[str, Any]]:
    """A form of the deployment (``FEEDBACK_FORM``, A's id) and of each workspace (``WS#{ws}#FEEDBACK_FORM``)."""
    def row(pk: str, form_id: str, mark: str) -> dict[str, Any]:
        return {'pk': pk, 'sk': f'FORM#{form_id}', 'form_id': form_id, 'name': f'{mark} workshop', 'schema_version': 2}

    return [row('FEEDBACK_FORM', REPORT_FORM_A, 'before_workspaces'),
            row(f'WS#{WS_A}#FEEDBACK_FORM', REPORT_FORM_A, A_MARK),
            row(f'WS#{WS_B}#FEEDBACK_FORM', REPORT_FORM_B, B_MARK)]


#: A micro-feedback form of each workspace, and one in none (7.66.00).
APP_FORM_A = 'ff_000000000000000000000000000000a2'
APP_FORM_B = 'ff_000000000000000000000000000000b2'
_APP_FORM_IDS = {'A': {'form_id': APP_FORM_A}, 'B': {'form_id': APP_FORM_B},
                 UNKNOWN: {'form_id': 'ff_000000000000000000000000000000fe'}}


def _app_feedback_rows() -> list[dict[str, Any]]:
    """A form made from the In-app micro-feedback template and the settings choosing it, of the deployment (A's id)
    and of each workspace, its name carrying the scope's mark."""
    def form(pk: str, form_id: str, mark: str) -> dict[str, Any]:
        return {'pk': pk, 'sk': f'FORM#{form_id}', 'form_id': form_id, 'name': f'{mark} app feedback',
                'schema_version': 2, 'enabled': True, 'language': 'en', 'languages': ['en'], 'tags': ['voc_app'],
                'questions': [{'id': 'q_verdict', 'type': 'single_select', 'options': [{'code': 'up'}, {'code': 'down'}]},
                              {'id': 'q_missing', 'type': 'open_text'}],
                'hidden_fields': [{'id': name} for name in ('action', 'page', 'app_version', 'workspace_role')]}

    def settings(pk: str, form_id: str) -> dict[str, Any]:
        return {'pk': pk, 'sk': 'config', 'form_id': form_id, 'enabled': True, 'actions': ['personas']}

    return [form('FEEDBACK_FORM', APP_FORM_A, 'before_workspaces'), settings('SETTINGS#app_feedback', APP_FORM_A),
            form(f'WS#{WS_A}#FEEDBACK_FORM', APP_FORM_A, A_MARK), settings(f'WS#{WS_A}#SETTINGS#app_feedback', APP_FORM_A),
            form(f'WS#{WS_B}#FEEDBACK_FORM', APP_FORM_B, B_MARK), settings(f'WS#{WS_B}#SETTINGS#app_feedback', APP_FORM_B)]


def _adoption_rows() -> list[dict[str, Any]]:
    """The leadership view's rollup item and baselines (7.70.00) of the deployment and of each workspace: counts, and
    a note carrying its scope's mark."""
    def rows(prefix: str, mark: str, started: int) -> list[dict[str, Any]]:
        return [{'pk': f'{prefix}ADOPTION#ROLLUP', 'sk': '2026-11-20', 'rolled_up_at': '2026-11-20T03:05:00+00:00',
                 'months': {'2026-11': {'projects_started': started}}},
                {'pk': f'{prefix}SETTINGS#adoption', 'sk': 'config', 'note': f'{mark} survey',
                 'baselines': {'prd': started}}]

    return [*rows('', 'before_workspaces', 1), *rows(f'WS#{WS_A}#', A_MARK, 2), *rows(f'WS#{WS_B}#', B_MARK, 3)]


@contextmanager
def metrics_world(lambda_context: Any) -> Generator[World]:
    """The metrics Lambda (lambda/api/metrics_handler.py) for the leadership view it includes (7.70.00): its own
    workspace resolution (shared/workspace_request.py) and the domain APIs' (shared/request_workspace.py) over the two
    seeded workspaces."""
    import metrics_handler
    from shared.workspace_request import RequestWorkspace

    with ExitStack() as stack:
        cognito = _domain_resolution(stack)
        workspaces = boto3.resource('dynamodb', region_name='us-east-1').Table('workspaces')
        stack.enter_context(patch.object(metrics_handler, '_workspace', RequestWorkspace(table=lambda: workspaces)))
        aggregates = pk_sk_table('aggregates')
        stack.enter_context(patch.object(metrics_handler, 'aggregates_table', aggregates))
        for row in _adoption_rows():
            aggregates.put_item(Item=row)
        yield World(call=_caller(metrics_handler, lambda_context), doubles={'cognito': cognito})


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
#: A hard delete's stated basis (shared/workspace_deletes.py: no personal data).
_DELETE_BASIS = 'Customer contract ended (ticket 4512)'

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


# ── voc-agents-api (lambda/api/agents_handler.py): a plan approved inside a workspace (7.29.00) ──

#: The smallest plan the approval takes: one write step, no id of any workspace.
_PLAN = {'schema': 'voc-plan/1', 'goal': 'Create a checkout project',
         'steps': [{'id': 's1', 'pack': 'core', 'kind': 'write', 'title': 'Create the project',
                    'write': {'tool': 'create_project', 'args': {'name': 'Checkout'}}, 'produces': ['project_id']}]}
_PLAN_LITERALS = {
    'voc-plan/1': 'the plan schema, the same everywhere',
    'Create a checkout project': "the plan's goal, the approver's words",
    's1': "a step id, the plan's own name for its step",
    'core': 'a tool pack, the same in every workspace',
    'write': 'a step kind',
    'Create the project': "a step's title",
    'create_project': 'a tool name, the same in every workspace',
    'Checkout': "the new project's name, the approver's words",
    'project_id': "the name of an output the step records, not a value",
}


@contextmanager
def agents_world(lambda_context: Any) -> Generator[World]:
    import agents_handler
    from shared import agent_seed, agents_store
    from shared.test.agents_fixtures import CATEGORIES, STATE_MACHINE_ARN

    with ExitStack() as stack:
        cognito = _domain_resolution(stack)
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        pk_sk_table('agents', gsi1_index=agents_store.AGENTS_INDEX)
        aggregates = pk_sk_table('aggregates')
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': CATEGORIES})
        sfn = MagicMock(name='stepfunctions')
        sfn.start_execution.side_effect = lambda **kw: {'executionArn': f"{STATE_MACHINE_ARN}:{kw['name']}"}
        stack.enter_context(patch.dict('os.environ', {agents_store.AGENTS_TABLE_ENV: 'agents',
                                                      agents_store.STATE_MACHINE_ENV: STATE_MACHINE_ARN}))
        stack.enter_context(patch.object(agents_store, 'get_dynamodb_resource', return_value=resource))
        stack.enter_context(patch.object(agents_store, 'stepfunctions_client', return_value=sfn))
        stack.enter_context(patch.object(agents_handler, 'get_aggregates_table', return_value=aggregates))
        agents_store._table_cache.clear()
        agent_seed._settled.clear()
        stack.callback(agents_store._table_cache.clear)
        yield World(call=_caller(agents_handler, lambda_context), doubles={'cognito': cognito, 'stepfunctions': sfn})


_A_STATEMENT = 'Buyers want clearer refund timelines'


# ── voc-projects-api's Documents Library (shared/library_routes.py, 7.62.00): a workspace's own library ──

#: The items each route acts on, in A, in B and in neither, by the state it needs (``lib_`` + a 14-digit stamp + 8
#: hex: shared/library_keys.py); the deployment's library holds A's ids too (check 3 reads them there).
_LIBRARY_STATES = {'item_id': 'ready', 'pending_id': 'pending', 'failed_id': 'failed'}
_LIBRARY_IDS = {
    side: {name: f'lib_2026111{n}000000_{digit * 8}' for n, name in enumerate(_LIBRARY_STATES)}
    for side, digit in (('A', 'a'), ('B', 'b'), (UNKNOWN, 'f'))
}
_LIBRARY_TEXT = b'Buyers ask about refunds and delivery times.'


def _seed_library(table: Any, s3: Any, scope: Any, ids: dict[str, str], mark: str, owner: str) -> None:
    from boto3.dynamodb.types import Binary

    from shared.library_keys import chunks_pk, extracted_key, item_key, original_key, slug_key
    from shared.memory_store import encode_embedding
    from shared.test.memory_fixtures import fake_vector

    for name, item_id in ids.items():
        slug = f'{mark.replace(" ", "-")}-{name.replace("_", "-")}'
        table.put_item(Item={**item_key(item_id, workspace=scope), 'item_id': item_id, 'title': f'{mark} report',
                             'slug': slug, 'tags': [], 'filename': 'report.txt', 'content_type': 'text/plain',
                             'format': 'txt', 'bytes': len(_LIBRARY_TEXT), 'status': _LIBRARY_STATES[name],
                             'native': False, 'chunks': 1, 'extracted_chars': len(_LIBRARY_TEXT), 'version': 1,
                             'created_by': {'sub': owner, 'name': owner}, 'created_at': '2026-11-01T00:00:00+00:00'})
        table.put_item(Item={**slug_key(slug, workspace=scope), 'item_id': item_id})
        s3.put_object(Bucket='raw', Key=original_key(item_id, workspace=scope), Body=_LIBRARY_TEXT,
                      ContentType='text/plain')
        if _LIBRARY_STATES[name] == 'ready':
            s3.put_object(Bucket='raw', Key=extracted_key(item_id, workspace=scope), Body=f'{mark} refunds'.encode())
            table.put_item(Item={'pk': chunks_pk(item_id, workspace=scope), 'sk': 'C#00001', 'text': f'{mark} refunds',
                                 'chars': 20, 'embedding': Binary(encode_embedding(fake_vector('refunds')))})


@contextmanager
def library_world(lambda_context: Any) -> Generator[World]:
    import projects_handler
    from shared import library_index, library_objects, library_routes
    from shared.test.memory_fixtures import fake_vector
    from shared.ws_repo import WorkspaceScope

    with ExitStack() as stack:
        cognito = _domain_resolution(stack)
        projects = pk_sk_table('projects')
        workspaces = boto3.resource('dynamodb', region_name='us-east-1').Table('workspaces')
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='raw')
        library_objects._client.clear()
        stack.callback(library_objects._client.clear)
        invoke_async = MagicMock(name='invoke_lambda_async')
        stack.enter_context(patch.dict('os.environ', {'RAW_DATA_BUCKET': 'raw', 'AWS_REGION': 'us-east-1',
                                                      'ASSIST_WORKER_FUNCTION': 'voc-projects-assist'}))
        stack.enter_context(patch.object(library_routes, 'get_projects_table', return_value=projects))
        stack.enter_context(patch.object(library_routes, 'get_workspaces_table', return_value=workspaces))
        stack.enter_context(patch.object(library_routes, 'invoke_lambda_async', invoke_async))
        stack.enter_context(patch.object(library_index, 'embed_text', side_effect=fake_vector))
        for scope, ids, mark, owner in ((None, _LIBRARY_IDS['A'], 'before workspaces', 'sub-ada'),
                                        (WorkspaceScope(WS_A), _LIBRARY_IDS['A'], A_MARK, 'sub-ada'),
                                        (WorkspaceScope(WS_B), _LIBRARY_IDS['B'], B_MARK, f'sub-{B_MARK}-bea')):
            _seed_library(projects, s3, scope, ids, mark, owner)
        yield World(call=_caller(projects_handler, lambda_context, projects=projects),
                    doubles={'cognito': cognito, 'extraction': invoke_async})


# ── voc-feedback-edit-api (lambda/api/feedback_edit_handler.py): a review's category and dimensions ──

#: A review of each workspace, and the deployment's copy under A's id (a request that names no workspace edits it).
FEEDBACK_A = 'fa1'
FEEDBACK_B = f'{B_MARK}-fb1'
_FEEDBACK_IDS = {'A': {'feedback_id': FEEDBACK_A}, 'B': {'feedback_id': FEEDBACK_B},
                 UNKNOWN: {'feedback_id': 'f-nowhere'}}
#: The deployment edits as before without the header: its own review under A's id, no workspace's.
_DEPLOYMENT_REVIEW = "the deployment as before: its own review under that id, no workspace's (shared/workspace_request.py)"


def _review(prefix: str, feedback_id: str, text: str) -> dict[str, Any]:
    return {'pk': f'{prefix}SOURCE#web', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
            'gsi4pk': f'{prefix}FEEDBACK#{feedback_id}', 'gsi2pk': f'{prefix}CATEGORY#delivery',
            'gsi2sk': '-0.5#2026-01-01T00:00:00Z', 'category': 'delivery', 'subcategory': 'late', 'text': text}


@contextmanager
def feedback_edit_world(lambda_context: Any) -> Generator[World]:
    """The feedback edit Lambda over two seeded workspaces, each with one review, and the deployment's review under
    A's id; its resolver (shared/workspace_request.py ``RequestWorkspace``) reads the seeded workspaces afresh."""
    from category_access_fixtures import CATEGORIES_CONFIG
    from moto_helpers import feedback_by_id_table

    import feedback_edit_handler
    from shared.workspace_request import RequestWorkspace

    with ExitStack() as stack:
        cognito = _domain_resolution(stack)
        workspaces = boto3.resource('dynamodb', region_name='us-east-1').Table('workspaces')
        stack.enter_context(patch.object(feedback_edit_handler, '_workspace', RequestWorkspace(table=lambda: workspaces)))
        feedback, aggregates = feedback_by_id_table(), pk_sk_table('aggregates')
        aggregates.put_item(Item=CATEGORIES_CONFIG)
        feedback.put_item(Item=_review('', FEEDBACK_A, 'the deployment review'))
        feedback.put_item(Item=_review(f'WS#{WS_A}#', FEEDBACK_A, f'{A_MARK} parcel came late'))
        feedback.put_item(Item=_review(f'WS#{WS_B}#', FEEDBACK_B, f'{B_MARK} chain slipped'))
        yield World(call=_caller(feedback_edit_handler, lambda_context, feedback=feedback, aggregates=aggregates),
                    doubles={'cognito': cognito})


# ── voc-feedback-forms-api (lambda/api/feedback_form_handler.py): the signed-in routes of a workspace's forms ──

#: Two forms of each workspace (the second for a comparison), one in none; the deployment's copies of A's two ids (a
#: read without the header reads them; a write there refuses them, ``_refuse_a_workspaces_id``, and only a copy
#: makes that refusal observable) and two forms of the deployment only (a write without the header names them).
#: Every id here has the workspace shape (``_ROUTABLE_FORM_ID``), so the deployment's are looked up and missed; a
#: deployment form of the older shape skips the lookup (test_feedback_form_workspace.py covers that path).
FORM_A, FORM_A2 = 'ff_' + 'a1' * 16, 'ff_' + 'a2' * 16
FORM_B, FORM_B2 = 'ff_' + 'b1' * 16, 'ff_' + 'b2' * 16
FORM_DEPLOYMENT, FORM_DEPLOYMENT2 = 'ff_' + 'd1' * 16, 'ff_' + 'd2' * 16
_DEPLOYMENT_COPIES = (FORM_A, FORM_A2)
_FORM_IDS = {'A': {'form_id': FORM_A}, 'B': {'form_id': FORM_B}, UNKNOWN: {'form_id': 'ff_' + 'f' * 32}}
#: The second forms (and the deployment's second) were made by the import wizard: the import takes their rows.
_IMPORTED_FORMS = frozenset({FORM_A2, FORM_B2, FORM_DEPLOYMENT2})
#: Without the header, a delete of A's id is the 404 (``_refuse_a_workspaces_id``), of an unknown one the
#: deployment's idempotent success.
_DELETE_GAP = KnownGap(
    reason="reported to voc-lead 2026-11-26 (~/reports/mut-voc-mp2.md, item 6): it tells a workspace's form ids from "
           'unknown ones; nothing read or changed',
    a_answer=(404, {'success': False, 'error': 'Form not found'}), unknown_answer=(200, {'success': True}))
_IMPORTED_IDS = {'A': {'form_id': FORM_A2}, 'B': {'form_id': FORM_B2}, UNKNOWN: {'form_id': 'ff_' + 'e' * 32}}
_COMPARED_IDS = {'A': {'form_id': FORM_A, 'other': FORM_A2}, 'B': {'form_id': FORM_B, 'other': FORM_B2},
                 UNKNOWN: {'form_id': 'ff_' + 'f' * 32, 'other': 'ff_' + 'e' * 32}}
_DEPLOYMENT_FORM = {'form_id': FORM_DEPLOYMENT}
#: Without the header the forms are the deployment's, as before (shared/workspace_request.py).
_DEPLOYMENT_FORMS = "the deployment as before: its own forms, no workspace's (shared/workspace_request.py)"


#: An import's dry run (it checks the rows and writes nothing): one row of the form's rating question.
_IMPORT_BODY = {'rows': [{'Rating': '4'}], 'mapping': {'Rating': 'q_rating'}, 'dry_run': True,
                'file': {'name': 'export.csv', 'format': 'csv', 'content': 'Rating\n4\n'}}
_IMPORT_LITERALS = {'Rating': 'a column of the uploaded file', '4': 'an answer in the file',
                    'q_rating': "the form's own question id, the same in every form made from the default",
                    'export.csv': 'the file name the admin chose', 'csv': 'the file format',
                    'Rating\n4\n': "the file's text"}


def _seeded_form(pk: str, form_id: str, name: str) -> dict[str, Any]:
    form = {'pk': pk, 'sk': f'FORM#{form_id}', 'form_id': form_id, 'name': name, 'title': name, 'enabled': True,
            'brand_name': 'Acme', 'created_at': '2026-11-01T00:00:00+00:00', 'updated_at': '2026-11-01T00:00:00+00:00'}
    if form_id in _IMPORTED_FORMS:
        # Made by the import wizard (``imported``): the import route takes its rows (and it has no test link).
        form['imported'] = {'from': 'csv', 'at': '2026-11-01T00:00:00+00:00', 'filename': 'export.csv'}
    return form


@contextmanager
def feedback_forms_world(lambda_context: Any) -> Generator[World]:
    """The forms Lambda over two seeded workspaces, each with two forms and their lookup rows (``FORM#{id}``), and the
    deployment's forms (copies under A's two ids, and two of its own); its resolver reads the seeded workspaces."""
    from test_feedback_form_workspace import wire_form_handler

    import feedback_form_handler
    from shared.test.source_profile_fixtures import seeded_source_profiles

    with ExitStack() as stack:
        cognito = _domain_resolution(stack)
        # No source profiles configured (the import reads them for its redaction policy).
        stack.enter_context(seeded_source_profiles())
        workspaces = boto3.resource('dynamodb', region_name='us-east-1').Table('workspaces')
        aggregates, feedback = pk_sk_table('aggregates'), pk_sk_table('feedback')
        for ws, mark, forms in ((WS_A, A_MARK, (FORM_A, FORM_A2)), (WS_B, B_MARK, (FORM_B, FORM_B2))):
            for form_id in forms:
                aggregates.put_item(Item=_seeded_form(f'WS#{ws}#FEEDBACK_FORM', form_id, f'{mark} survey'))
                workspaces.put_item(Item={'pk': f'FORM#{form_id}', 'sk': 'META', 'workspace_id': ws,
                                          'created_at': '2026-11-01T00:00:00+00:00'})
        for form_id in (*_DEPLOYMENT_COPIES, FORM_DEPLOYMENT, FORM_DEPLOYMENT2):
            aggregates.put_item(Item=_seeded_form('FEEDBACK_FORM', form_id, 'the deployment survey'))
        wired = wire_form_handler(stack, {'aggregates': aggregates, 'feedback': feedback, 'workspaces': workspaces})
        yield World(call=_caller(feedback_form_handler, lambda_context),
                    doubles={'cognito': cognito, 'sqs': wired['sqs']})


# ── voc-manual-import-api (lambda/api/manual_import_handler.py): the import wizard and its history ──

#: A parse job and an import run of each workspace and of the deployment. A job's key is its id alone
#: (``MANUAL_IMPORT#{id}``), so only the job's ``workspace_id`` keeps it where it started (``_require_job``): without
#: the header A's job is refused as an unknown one, and the deployment's own is read. A run lives in its place's
#: partitions (shared/import_runs.py), so the deployment has its own run under A's run id, which a request without
#: the header reads. Run ids are UUIDs (``get_import_run`` reads no other).
JOB_A, JOB_B, JOB_DEPLOYMENT = 'job-a1', f'job-{B_MARK}1', 'job-d1'
RUN_A = '00000000-0000-4000-8000-0000000000a1'
RUN_B = '00000000-0000-4000-8000-0000000000b1'
_JOB_IDS = {'A': {'job_id': JOB_A}, 'B': {'job_id': JOB_B}, UNKNOWN: {'job_id': 'job-nowhere'}}
_RUN_IDS = {'A': {'run_id': RUN_A}, 'B': {'run_id': RUN_B},
            UNKNOWN: {'run_id': '00000000-0000-4000-8000-0000000000ff'}}
#: Without the header the imports are the deployment's, as before, and its ``admins``' (shared/workspace_request.py
#: ``ResolvedRoutes.require_request_admin``).
_DEPLOYMENT_IMPORTS = "the deployment as before: its own jobs, runs and queue, no workspace's (ResolvedRoutes)"
_IMPORT_CSV = 'id,text,rating\n1,Login fails on iOS,2\n'
_REVIEWED = {'text': 'Nice', 'date': '2026-03-01'}
_REVIEW_LITERALS = {'Nice': 'a review the admin confirmed', '2026-03-01': 'its date'}


def _import_profile(_table: object, source_id: object = None, scope: Any = None) -> dict:
    """Every place keeps the whole file (allow), so each import writes its raw copy where it is made."""
    from shared import source_profiles
    return source_profiles.profile_for([{'id': 'manual_import', 'label': 'Manual', 'pii': 'allow'}],
                                       str(source_id or 'manual_import'), workspace=scope is not None)


def _seed_imports(aggregates: Any) -> None:
    """The three places' parse jobs (completed) and import runs (summary and detail rows)."""
    from shared.import_runs import ImportCounts, ImportRun, _rows
    from shared.ws_repo import WorkspaceScope

    for ws, job, run, mark in ((WS_A, JOB_A, RUN_A, A_MARK), (WS_B, JOB_B, RUN_B, B_MARK),
                               (None, JOB_DEPLOYMENT, RUN_A, 'before_workspaces')):
        job_row = {'pk': f'MANUAL_IMPORT#{job}', 'sk': 'JOB', 'status': 'completed', 'source_origin': 'example',
                   'source_url': f'https://reviews.example.com/{mark}', 'raw_text': f'{mark} reviews', 'reviews': []}
        aggregates.put_item(Item=job_row if ws is None else {**job_row, 'workspace_id': ws})
        scope = WorkspaceScope(ws) if ws is not None else None
        for row in _rows(ImportRun(method='csv', source=f'{mark} file', actor='sub-ada', started_at='2026-11-01T00:00:00+00:00',
                                   counts=ImportCounts(received=1, imported=1), run_id=run),
                         datetime(2026, 11, 1, tzinfo=UTC), scope):
            aggregates.put_item(Item=row)


@contextmanager
def manual_import_world(lambda_context: Any) -> Generator[World]:
    """The manual-import Lambda over two seeded workspaces (their admins only, ``require_request_admin``), each with a
    parse job and an import run, and the deployment's own; raw copies to a moto bucket (in ``table_snapshot``), its
    queue and the parse worker's start as doubles."""
    import manual_import_handler as h
    from shared.workspace_request import RequestWorkspace

    with ExitStack() as stack:
        cognito = _domain_resolution(stack)
        workspaces = boto3.resource('dynamodb', region_name='us-east-1').Table('workspaces')
        aggregates, feedback = pk_sk_table('aggregates'), pk_sk_table('feedback')
        _seed_imports(aggregates)
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='raw')
        sqs = MagicMock(name='sqs')
        sqs.send_message_batch.side_effect = lambda Entries, **_k: {'Successful': [{'Id': e['Id']} for e in Entries]}
        parse_worker = MagicMock(name='invoke_lambda_async')
        resolver = RequestWorkspace(table=lambda: workspaces, confirm_platform_admin=lambda _event: False)
        for target, value in (('aggregates_table', aggregates), ('feedback_table', feedback), ('s3', s3),
                              ('sqs', sqs), ('RAW_DATA_BUCKET', 'raw'), ('PROCESSING_QUEUE_URL', 'q'),
                              ('MANUAL_IMPORT_PROCESSOR_FUNCTION', 'parser'), ('invoke_lambda_async', parse_worker)):
            stack.enter_context(patch.object(h, target, value))
        stack.enter_context(patch.object(h._request, 'workspace', resolver))
        stack.enter_context(patch.object(h, 'upload_profile', side_effect=_import_profile))
        # The real writer (conftest.py's autouse ``import_run_rows`` captures the rows): a run a refused request
        # recorded would then be in ``table_snapshot``.
        stack.enter_context(patch('shared.import_runs._put_rows', side_effect=_write_run_rows))
        yield World(call=_caller(h, lambda_context), doubles={'cognito': cognito, 'sqs': sqs, 'parse': parse_worker})


WORLDS: dict[str, Callable[[Any], Any]] = {
    'feedback_edit_handler.py': feedback_edit_world,
    'feedback_form_handler.py': feedback_forms_world,
    'manual_import_handler.py': manual_import_world,
    'workspaces_handler.py': workspaces_world,
    'settings_handler.py': settings_world,
    'mcp_tokens_handler.py': tokens_world,
    'chat_handler.py': chat_world,
    'memory_handler.py': memory_world,
    'mcp_oauth_consent_routes.py': tokens_world,
    'agents_handler.py': agents_world,
    # Included by the settings handler (a feedback form's AI draft, 7.55.00; a form report's AI summary, 7.63.00).
    'forms_v2_draft_routes.py': settings_world,
    'forms_report_routes.py': settings_world,
    # Included by the settings handler (in-app micro-feedback's settings, 7.66.00).
    'app_feedback_routes.py': settings_world,
    # Included by the settings handler (the leadership view's baselines, 7.70.00) and by the metrics handler (its read).
    'adoption_routes.py': settings_world,
    'adoption_metrics_routes.py': metrics_world,
    # Included by the projects handler (the Documents Library, 7.62.00).
    'library_routes.py': library_world,
}

#: (handler file, "METHOD /path") -> how to call it: exactly the workspace-scoped routes.
CASES: dict[tuple[str, str], RouteCase] = {
    ('workspaces_handler.py', 'GET /me/workspaces/current'): RouteCase(
        no_ids='the header is its only id: check 1'),
    # The rename (7.40.00, shared/workspace_rename.py): A's META, A's listing row and A's members' rows only.
    ('workspaces_handler.py', 'PUT /me/workspaces/current'): RouteCase(
        no_ids='the workspace is the header: check 1 (the new name is text the admin typed)',
        body={'name': 'Acme Renamed'}, literals={'Acme Renamed': 'the new name the admin typed, not an id'}),
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
    # The hard delete (4d-2, shared/workspace_deletes.py): A's request moves A's META and listing row only.
    ('workspaces_handler.py', 'POST /me/workspaces/current/delete'): RouteCase(
        no_ids="the workspace is the header: check 1 (the slug typed is compared with the header's workspace's)",
        body={'confirm_slug': 'acme', 'legal_basis': _DELETE_BASIS}, ok_status=202,
        literals={'acme': "A's own slug typed as the approval, compared with the header's workspace, never looked up",
                  _DELETE_BASIS: 'the basis the admin typed, kept in the audit rows'}),
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
        without_a_workspace=_AS_BEFORE,
        outside_a={('MCPGTOKEN', 'CREATOR#'): "the person's own index of the tokens they made (CREATOR#{sub}#TOKEN#{id}), per "
                                'person; the token itself names A'}),
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
        ids=_CONVERSATION_IDS, refused_status=200, without_a_workspace=_AS_BEFORE,
        # Reported to voc-lead 2026-11-26 (~/reports/mut-voc-mp2.md): a forms delete is audited in AUDIT#WS#{ws}.
        outside_a={('AUDIT#delete', ''): "the deletes' audit partition, one for every place (shared/delete_audit.py): "
                                         'its row names A only in its target (target.workspace)'}),
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
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True, outside_a=_CONFIG_VERSION),
    # The categories, dimensions and source profiles (7.08.00): each workspace's own rows, the deployment's without
    # the header; any member reads, the workspace's admins write.
    ('settings_handler.py', 'GET /settings/categories'): RouteCase(
        no_ids='the header is its only id: check 1 (each workspace has its own categories)',
        without_a_workspace=_AS_BEFORE),
    ('settings_handler.py', 'PUT /settings/categories'): RouteCase(
        no_ids='the categories are names the admin typed, the workspace is the header: check 1',
        body={'categories': [{'name': 'trail_gear'}]},
        literals={'trail_gear': 'a category name the admin typed, not a row of a workspace'},
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True, outside_a=_CONFIG_VERSION),
    ('settings_handler.py', 'GET /settings/dimensions'): RouteCase(
        no_ids='the header is its only id: check 1 (each workspace has its own dimensions)',
        without_a_workspace=_AS_BEFORE),
    ('settings_handler.py', 'PUT /settings/dimensions'): RouteCase(
        no_ids='the dimensions are keys and values the admin typed, the workspace is the header: check 1',
        body={'dimensions': [{'key': 'terrain', 'values': [{'name': 'gravel'}]}]},
        literals={'terrain': 'a dimension key the admin typed, not a row of a workspace',
                  'gravel': 'a dimension value the admin typed, not a row of a workspace'},
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True, outside_a=_CONFIG_VERSION),
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
    # A feedback form's AI draft (7.55.00's AI review, round 1: served by the settings API): the workspace's own job,
    # started and polled by its editors and admins; without the header the deployment's, for any signed-in user.
    ('forms_v2_draft_routes.py', 'POST /settings/form-drafts'): RouteCase(
        no_ids='the job is new, the workspace is the header: check 1 (B finished a draft; A starts its own)',
        body={'description': 'Ask riders why they return', 'language': 'en', 'channel': 'link'}, ok_status=202,
        literals={'Ask riders why they return': 'a description the person typed, not a row of a workspace',
                  'en': 'a form language, the same in every workspace',
                  'link': 'a channel, the same words in every workspace'},
        without_a_workspace=_AS_BEFORE),
    ('forms_v2_draft_routes.py', 'GET /settings/form-drafts/<job_id>'): RouteCase(
        ids=_DRAFT_JOB_IDS, without_a_workspace=_AS_BEFORE),
    # A form report's AI summary (7.63.00): only a form of the request's own scope, by its editors and admins; the
    # job and its hourly counter are that scope's; without the header the deployment's form, for any signed-in user.
    ('forms_report_routes.py', 'POST /settings/form-reports'): RouteCase(
        ids=_REPORT_FORM_IDS, ok_status=202, without_a_workspace=_AS_BEFORE,
        body={'form_id': '{form_id}', 'answers': [{'response_id': 'fb_ride_1', 'text': 'The trail map came late'}]},
        literals={'fb_ride_1': "a response id the browser read with the person's own access: the route reads no "
                               'feedback row, it only labels what it was sent',
                  'The trail map came late': 'an answer to summarize, text the browser sent'}),
    # (its poll answers the caller's own assist job of the request's scope, as the drafts' poll does)
    ('forms_report_routes.py', 'GET /settings/form-reports/<job_id>'): RouteCase(
        ids=_DRAFT_JOB_IDS, without_a_workspace=_AS_BEFORE),
    # In-app micro-feedback's settings (7.66.00): each workspace's own row and one of its own forms; any member reads,
    # its admins choose; without the header the deployment's, for the deployment's admins.
    ('app_feedback_routes.py', 'GET /settings/app-feedback'): RouteCase(
        no_ids="the header is its only id: check 1 (B chose its own form; A reads only its own)",
        without_a_workspace=_AS_BEFORE),
    ('app_feedback_routes.py', 'PUT /settings/app-feedback'): RouteCase(
        ids=_APP_FORM_IDS, body={'form_id': '{form_id}', 'enabled': True}, without_a_workspace=_AS_BEFORE,
        deployment_admins_without_a_workspace=True),
    # The leadership view (7.70.00): each workspace's own rollup and baselines, for its admins only; without the header
    # the deployment's, for the deployment's admins.
    ('adoption_metrics_routes.py', 'GET /metrics/adoption'): RouteCase(
        no_ids="the header is its only id: check 1 (B's rollup and note; A reads only its own)",
        query={'from': '2026-11', 'to': '2026-11'},
        literals={'2026-11': 'a month of the calendar, the same in every workspace'},
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True),
    ('adoption_routes.py', 'GET /settings/adoption'): RouteCase(
        no_ids="the header is its only id: check 1 (B's own baselines and note)",
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True),
    ('adoption_routes.py', 'PUT /settings/adoption'): RouteCase(
        no_ids='the baselines are numbers and words of the admin, the workspace is the header: check 1',
        body={'note': 'From our own survey'}, literals={'From our own survey': 'a note the admin typed'},
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True),
    # The onboarding buddy and its role playbook (7.66.00): the caller's own row, every workspace; the signals are the
    # request's workspace's (the deployment's without the header).
    ('settings_handler.py', 'GET /settings/my-onboarding'): RouteCase(
        no_ids="the header is its only id: check 1 (the caller's own row; the signals are A's)",
        without_a_workspace=_AS_BEFORE),
    ('settings_handler.py', 'PUT /settings/my-onboarding'): RouteCase(
        no_ids="the choice is a word of the app, the row the caller's own, the workspace is the header: check 1",
        body={'playbook': 'qa'}, literals={'qa': 'a playbook role, the same in every workspace'},
        without_a_workspace=_AS_BEFORE,
        outside_a={('USERCTX#', 'onboarding'): "the caller's own onboarding row (USERCTX#{sub}), the same in every workspace"}),
    ('settings_handler.py', 'GET /settings/sources'): RouteCase(
        no_ids='the header is its only id: check 1 (each workspace has its own source profiles)',
        without_a_workspace=_AS_BEFORE),
    ('settings_handler.py', 'PUT /settings/sources'): RouteCase(
        no_ids="the profile names a source of the deployment's catalogue, the workspace is the header: check 1",
        body={'sources': [{'id': PLUGIN, 'pii': 'redact'}]},
        literals={PLUGIN: 'a plugin of the deployment, the same source id in every workspace',
                  'redact': 'a PII policy, the same words in every workspace'},
        without_a_workspace=_AS_BEFORE, deployment_admins_without_a_workspace=True, outside_a=_CONFIG_VERSION),
    # 7.29.00: the approval resolves the workspace the plan will run in; a member approves there, nobody else.
    **{('library_routes.py', route): RouteCase(
        no_ids="the header is its only id: check 1 (each workspace's library is its own)", query=query,
        literals=literals, without_a_workspace=_AS_BEFORE)
       for route, query, literals in (
           ('GET /projects/library', None, {}),
           ('GET /projects/library/suggest', {'q': 'report'}, {'report': 'what the person typed after #'}))},
    ('library_routes.py', 'POST /projects/library'): RouteCase(
        no_ids='the item is new, the workspace is the header: check 1',
        body={'filename': 'notes.txt', 'content_type': 'text/plain', 'bytes': 12},
        literals={'notes.txt': 'a file name the person chose', 'text/plain': 'a content type',
                  '12': "the file's size in bytes"},
        ok_status=201, without_a_workspace=_AS_BEFORE),
    **{('library_routes.py', route): RouteCase(
        ids={side: {'item_id': ids[name]} for side, ids in _LIBRARY_IDS.items()}, body=body, literals=literals,
        ok_status=ok, without_a_workspace=_AS_BEFORE)
       for route, name, body, literals, ok in (
           ('GET /projects/library/<item_id>', 'item_id', None, {}, 200),
           ('GET /projects/library/<item_id>/text', 'item_id', None, {}, 200),
           ('PUT /projects/library/<item_id>', 'item_id', {'expected_version': 1, 'title': 'Renamed'},
            {'Renamed': 'a title the person typed', '1': 'the version the person read'}, 200),
           ('DELETE /projects/library/<item_id>', 'item_id', None, {}, 200),
           ('POST /projects/library/<item_id>/uploaded', 'pending_id', None, {}, 202),
           ('POST /projects/library/<item_id>/retry', 'failed_id', None, {}, 202))},
    ('library_routes.py', 'POST /projects/library/context'): RouteCase(
        ids={side: {'item_id': ids['item_id']} for side, ids in _LIBRARY_IDS.items()},
        body={'item_ids': ['{item_id}'], 'query': 'refunds'}, literals={'refunds': 'a question the person asked'},
        # An id the workspace does not hold is counted in `missing`, never echoed: B's and an unknown one alike.
        refused_status=200, without_a_workspace=_AS_BEFORE),
    ('agents_handler.py', 'POST /agents/plans'): RouteCase(
        no_ids='the header is its only id: check 1 (the plan is kept with the workspace its approver is a member of)',
        body={'plan': _PLAN}, literals=_PLAN_LITERALS, ok_status=202,
        without_a_workspace='a plan approved without a workspace is the deployment\'s, as before',
        outside_a={('PLANCAP#', 'META'): "the approver's own count of live plans (PLANCAP#{sub}), per person",
                   ('PLAN#', 'STEP#'): "the new plan's step rows, under its own new id (its own row names A)",
                   ('PLAN#', 'EVT#'): "the new plan's event rows, under its own new id (its own row names A)"}),
    # A review's category and dimensions (shared/workspace_request.py RequestWorkspace, read afresh: an edit is a
    # write): A's member edits A's review only; B's review id is not found in A, as an id of no review.
    ('feedback_edit_handler.py', 'PUT /feedback/<feedback_id>/category'): RouteCase(
        ids=_FEEDBACK_IDS, body={'category': 'billing'},
        literals={'billing': 'a category of the configuration, the same name in every workspace'},
        without_a_workspace=_DEPLOYMENT_REVIEW),
    ('feedback_edit_handler.py', 'PUT /feedback/<feedback_id>/dimensions'): RouteCase(
        ids=_FEEDBACK_IDS, body={'tags': ['checked']},
        literals={'checked': 'a tag the editor typed, not a row of a workspace'},
        without_a_workspace=_DEPLOYMENT_REVIEW),
    # A workspace's forms (``_request_scope``, shared/workspace_request.py RequestWorkspace; a write reads the role
    # afresh): A's member reads and changes A's forms only; B's form id is not found in A, as an id of no form.
    ('feedback_form_handler.py', 'GET /feedback-forms'): RouteCase(
        no_ids="the header is its only id: check 1 (B's forms; A lists its own)",
        without_a_workspace=_DEPLOYMENT_FORMS),
    ('feedback_form_handler.py', 'POST /feedback-forms'): RouteCase(
        no_ids='the form is new, the workspace is the header: check 1', body={'name': 'Spring survey'},
        literals={'Spring survey': 'the name the editor typed'}, without_a_workspace=_DEPLOYMENT_FORMS),
    **{('feedback_form_handler.py', f'GET /feedback-forms/<form_id>{tail}'): RouteCase(
        ids=_FORM_IDS, without_a_workspace=_DEPLOYMENT_FORMS)
       for tail in ('', '/stats', '/submissions', '/results', '/report', '/responses')},
    # Without the header the comparison reads the deployment's copies of A's two ids, and nothing of A's.
    ('feedback_form_handler.py', 'GET /feedback-forms/<form_id>/compare'): RouteCase(
        ids=_COMPARED_IDS, query={'with': '{other}'}, without_a_workspace=_DEPLOYMENT_FORMS),
    ('feedback_form_handler.py', 'PUT /feedback-forms/<form_id>'): RouteCase(
        ids=_FORM_IDS, body={'title': 'Spring survey'}, literals={'Spring survey': 'the title the editor typed'},
        without_a_workspace=_DEPLOYMENT_FORMS, deployment_ids=_DEPLOYMENT_FORM),
    ('feedback_form_handler.py', 'DELETE /feedback-forms/<form_id>'): RouteCase(
        ids=_FORM_IDS, without_a_workspace=_DEPLOYMENT_FORMS, deployment_ids=_DEPLOYMENT_FORM, known_gap=_DELETE_GAP),
    # The admin-only writes (``_require_test_link_admin``, ``_require_import_admin``; deleting test responses, an admin
    # or the form's creator): without the header only a deployment admin may make them.
    ('feedback_form_handler.py', 'POST /feedback-forms/<form_id>/test-link'): RouteCase(
        ids=_FORM_IDS, body={}, without_a_workspace=_DEPLOYMENT_FORMS, deployment_ids=_DEPLOYMENT_FORM,
        deployment_admins_without_a_workspace=True),
    ('feedback_form_handler.py', 'DELETE /feedback-forms/<form_id>/responses'): RouteCase(
        ids=_FORM_IDS, query={'test': 'true'}, literals={'true': 'the test-responses switch, the same everywhere'},
        without_a_workspace=_DEPLOYMENT_FORMS, deployment_ids=_DEPLOYMENT_FORM,
        deployment_admins_without_a_workspace=True),
    # A dry run only (it checks the rows and writes nothing): the refusals and reads are proven here, the import's
    # writes in one workspace (its ``ws/{ws}/raw/`` archive, its queue messages) by test_feedback_form_import.py.
    ('feedback_form_handler.py', 'POST /feedback-forms/<form_id>/import'): RouteCase(
        ids=_IMPORTED_IDS, body=_IMPORT_BODY, literals=_IMPORT_LITERALS, without_a_workspace=_DEPLOYMENT_FORMS,
        deployment_ids={'form_id': FORM_DEPLOYMENT2}, deployment_admins_without_a_workspace=True),
    # The manual import (``ResolvedRoutes.middleware`` before every route; its admins only, the deployment's
    # ``admins`` without the header): A's admin imports into A and reads A's jobs and runs only.
    ('manual_import_handler.py', 'POST /scrapers/manual/parse'): RouteCase(
        no_ids='the job is new, the workspace is the header: check 1',
        body={'source_url': 'https://reviews.example.com/acme', 'raw_text': 'Great product'},
        literals={'https://reviews.example.com/acme': 'the page the admin pasted from', 'Great product': 'its text'},
        without_a_workspace=_DEPLOYMENT_IMPORTS, deployment_admins_without_a_workspace=True),
    ('manual_import_handler.py', 'GET /scrapers/manual/parse/<job_id>'): RouteCase(
        ids=_JOB_IDS, without_a_workspace=_DEPLOYMENT_IMPORTS, deployment_ids={'job_id': JOB_DEPLOYMENT},
        deployment_admins_without_a_workspace=True,
        echoes_its_ids="reported to voc-lead 2026-11-26 (~/reports/mut-voc-mp2.md, item 6): the 404 is "
                       "f'Job {job_id} not found' (get_parse_status), the confirm's the fixed 'Job not found'"),
    ('manual_import_handler.py', 'POST /scrapers/manual/confirm'): RouteCase(
        ids=_JOB_IDS, body={'job_id': '{job_id}', 'reviews': [_REVIEWED]}, literals=_REVIEW_LITERALS,
        without_a_workspace=_DEPLOYMENT_IMPORTS, deployment_ids={'job_id': JOB_DEPLOYMENT},
        deployment_admins_without_a_workspace=True),
    ('manual_import_handler.py', 'POST /scrapers/manual/csv-upload'): RouteCase(
        no_ids='the rows are new, the workspace is the header: check 1', body={'csv_text': _IMPORT_CSV},
        literals={_IMPORT_CSV: 'the file the admin chose'}, without_a_workspace=_DEPLOYMENT_IMPORTS,
        deployment_admins_without_a_workspace=True),
    ('manual_import_handler.py', 'POST /scrapers/manual/json-upload'): RouteCase(
        no_ids='the items are new, the workspace is the header: check 1',
        body={'items': [{'id': 'r1', 'text': 'Nice', 'source': 'example', 'timestamp': '2026-03-01T00:00:00Z'}]},
        literals={'r1': "the review's own id in the file", 'Nice': 'its text', 'example': 'its source',
                  '2026-03-01T00:00:00Z': 'its time'},
        without_a_workspace=_DEPLOYMENT_IMPORTS, deployment_admins_without_a_workspace=True),
    ('manual_import_handler.py', 'GET /scrapers/manual/history'): RouteCase(
        no_ids="the header is its only id: check 1 (B's runs; A lists its own)",
        without_a_workspace=_DEPLOYMENT_IMPORTS, deployment_admins_without_a_workspace=True),
    ('manual_import_handler.py', 'GET /scrapers/manual/history/<run_id>'): RouteCase(
        ids=_RUN_IDS, without_a_workspace=_DEPLOYMENT_IMPORTS, deployment_admins_without_a_workspace=True),
    ('manual_import_handler.py', 'POST /scrapers/manual/detect'): RouteCase(
        no_ids='the sample is new and nothing is stored: check 1', body={'format': 'csv', 'sample': _IMPORT_CSV},
        literals={'csv': 'the file format', _IMPORT_CSV: 'the file the admin chose'},
        without_a_workspace=_DEPLOYMENT_IMPORTS, deployment_admins_without_a_workspace=True),
}
