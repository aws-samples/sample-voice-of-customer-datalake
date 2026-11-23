"""
Workspaces API Lambda (voc-workspaces-api): the multi-workspace control plane (docs/multi-workspace.md).
Served under /me/{proxy+} (GET, POST, PUT and DELETE, every signed-in user, each route its own gate) and
/platform/{proxy+} (GET and POST, platform admins).

Routes:
    GET /me/workspaces          {workspaces: [{id, name, slug, role}]}: the caller's own workspaces, by name
                                (one Query of the caller's USER#{sub} partition, shared/workspace.py); each
                                role is the membership row's, while /current answers the effective one
    GET /me/workspaces/current  {workspace: {id, name, slug, role, platform_admin, trial, playbook}}: the workspace
                                the X-Workspace-Id header names, as the caller may act in it. 400 without the
                                header; 404 for a malformed id, a missing or deleting workspace, or a caller
                                who is not a member. A platform admin who is not a member admin enters as admin
                                when the live check confirms them, and the entry is audited (shared/workspace.py
                                resolve_workspace); an entry whose audit row cannot be written is refused.
                                `trial` (7.71.00): null, or {days, expires_at, paused_at, converted_at, paused:
                                {plugins, forms} | null} (shared/trial_state.py trial_summary), for every member;
                                `playbook`: the role playbook suggested to the caller when they were added, or null.
    PUT /me/workspaces/current  {name} -> {workspace: {id, name, slug, role, platform_admin}}: renames the workspace
                                X-Workspace-Id names (shared/workspace_rename.py), for its admins only (403 for an
                                editor or a viewer; the role read from the table): the audit row, then one
                                transaction of META and the listing row, then every member's "my workspaces" row.
                                400 for a bad name (the create's rules), 409 when it was renamed or marked deleting
                                meanwhile; the slug never changes. The same name repeats the members' sync only.
    POST /platform/workspaces   {name, slug, trial?: {days?, pack?}} -> 201 {workspace: {id, name, slug, role: 'admin',
                                secret_status, trial}}: a new workspace with the caller as its admin, in one
                                transaction (shared/platform_workspaces.py). 400 for a bad name, slug or trial, 409
                                for a slug that is taken; secret_status is always 'ready' (decision 19: nothing else
                                is made, a plugin's credentials parameters come with its first save). A trial
                                (7.71.00, shared/trials.py): 14, 30 or 60 days (30), in the same transaction with
                                the trial on META and the listing row and a trial_created audit row (the expiry's
                                hourly tick reads its end from the listing); `trial` answers its view (null for
                                none).
    GET /platform/workspaces    {workspaces: [{id, name, slug, status, created_at, secret_status, trial}], next_cursor}:
                                every workspace by name, ?limit= (1-100, default 25) and ?cursor= (one Query of the
                                listing partition, never a Scan); `trial` is the listing row's copy (or null).
    POST /platform/workspaces/{ws}/trial/extend   {days} -> {trial}: 14, 30 or 60 more days from its end (or from now
                                once it ended), audited first (trial_extended), a paused trial's plugins and forms
                                turned back on (shared/trial_pause.py; a form no longer publishable stays off and is
                                named in `trial.resumed.skipped`, {form_id, name, code}; `resumed` is null for a trial
                                that was not paused). 404 for no trial, 409 for a converted one or one changed
                                meanwhile.
    POST /platform/workspaces/{ws}/trial/convert  -> {trial}: a regular workspace from now on, audited first
                                (trial_converted), a paused trial resumed the same way (`trial.resumed`); a converted
                                one is answered as it is (`resumed` null). Neither route, nor the expiry, deletes
                                anything.
    GET /platform/costs         {estimate: true, label, currency, price_as_of, price_source, from, to, workspaces:
                                [{id, name, slug, status, days, total}], next_cursor, deployment?,
                                unattributed?}: the Bedrock cost estimate per workspace (shared/platform_costs.py,
                                the rows of lambda/jobs/cost_rollup/), ?from= and ?to= (UTC days, at most 92, `to`
                                not after today; 400 otherwise), ?limit= (1-25, default 20) and ?cursor= (the
                                listing's); one Query per workspace, the deployment's and unattributed rows on the
                                first page. Each read logs `platform_costs_read` with the caller's sub and the range.

The members of the workspace X-Workspace-Id names (shared/workspace_members.py), each resolved like /current (400
without the header, the one 404 for a non-member; a platform admin enters as admin, live-checked and audited):
    GET /me/workspaces/current/members          {members: [{sub, role, email, name, invited_by, joined_at}],
                                                next_cursor}: any member; ?limit= (1-100, default 25), ?cursor=
    POST /me/workspaces/current/members         {email, role, playbook?} -> 201 {member: {sub, role, email, name,
                                                invited_by, joined_at, playbook?, account: 'existing'|'created'}}
                                                (`playbook`: a role playbook to suggest, 7.71.00): workspace admins only
                                                (403 for an editor or a viewer; 403 for an email with no account
                                                unless the caller is in `admins`). 409 for a member already there,
                                                two accounts sharing the email, or the email spelt as another
                                                account's.
    PUT /me/workspaces/current/members/{sub}    {role} -> {member: {sub, role}}: workspace admins only; 409 for the
                                                last admin's demotion or a membership changed meanwhile.
    DELETE /me/workspaces/current/members/{sub} -> {removed: sub}: workspace admins, or the member themselves
                                                (leave); 409 for the last admin or a membership changed meanwhile.
The plugins of the workspace X-Workspace-Id names (shared/workspace_plugin_settings.py; the deployment's
plugins, ENABLED_SOURCES from cdk.context.json, are the ceiling), resolved the same way:
    GET /me/workspaces/current/plugins          {plugins: [{id, enabled, enabled_at?, enabled_by?}]}: any member,
                                                every plugin the deployment offers, in its order
    PUT /me/workspaces/current/plugins/{id}     {enabled} -> {plugin: {id, enabled, ...}}: workspace admins only
                                                (an enable writes PLUGIN#{id} / WS#{ws}, a disable deletes it);
                                                404 for a plugin the deployment does not offer; audited first; an
                                                enable in a paused trial is 409 trial_paused (shared/trial_state.py).
Each write resolves the caller's role from the table, never the 30 s cache (a demoted admin cannot undo it), commits
only while the acting admin is still admin (a check in its transaction: 403 when they were demoted meanwhile), writes
its AUDIT#WS#{ws} row first, and drops the changed member's cached membership in this container (other containers
serve it for up to 30 s, to reads only).

The export of the workspace X-Workspace-Id names (shared/export_jobs.py; the job: lambda/jobs/workspace_export/),
for its admins only (403 for an editor or a viewer, the one 404 for a non-member; a platform admin enters as admin,
live-checked and audited), the role read from the table on the start and the link (the status GET, a read, uses
the warm 30 s cache, as the other reads do: a platform admin's polling writes no entry row per poll):
    POST /me/workspaces/current/export   -> 202 {export: {id, status: 'queued', created_at}}: takes the workspace's
                                         one export lock (409 while another export is live), writes an
                                         export_requested audit row and the queued job row, then invokes
                                         voc-workspace-export asynchronously with the resolved workspace.
    GET /me/workspaces/current/export    {export: {id, status, created_at, started_at?, completed_at?, expires_at?,
                                         erased_at?, phase?, counts?, size_bytes?, error?} | null}: the newest
                                         export's status only (no link, no write). status is queued, running,
                                         completed, failed, cancelled or erased; `expired` past its 7 days; `failed`
                                         ("The export stopped before it finished") when it has not moved for an hour.
    POST /me/workspaces/current/export/link -> {link: {id, url, expires_in, expires_at}}: a fresh 15-minute
                                         presigned download of the newest export, only while it is completed and
                                         inside its 7 days (409 otherwise), recorded first in an export_link_issued
                                         audit row.

The hard delete of the workspace X-Workspace-Id names (shared/workspace_deletes.py; the job:
lambda/jobs/workspace_delete/), decision 17, for its admins (a member admin, or a platform admin who entered: live-checked
and audited), the role read from the table:
    POST /me/workspaces/current/delete   {confirm_slug, legal_basis} -> 202 {delete: {job_id, workspace_id,
                                         status: 'waiting', phase: 'fence', requested_at, deleting_at, fence_at,
                                         progress_at, counts}}: the slug
                                         typed exactly (400 otherwise) and a basis without personal data (400); 409
                                         while an export or an erasure runs; takes the workspace's export and erasure
                                         locks, then in one transaction sets META and the listing row `deleting`,
                                         writes the job row and an audit row in AUDIT#WS#{ws} and in
                                         AUDIT#workspace-deletes; then invokes voc-workspace-delete. A repeat that
                                         meets the same job answers it; once the workspace is `deleting`, every route
                                         (this one too) answers the workspace's one 404.
    POST /platform/workspaces/{ws}/delete/cancel   -> {delete}: a platform admin, until the job begins deleting
                                         (its 21-minute fence, or later for a job that never began; 409 once it
                                         has), moves it back to `active` (audited); the messages dropped
                                         meanwhile are lost and its counters are marked for a rebuild.
    POST /platform/workspaces/{ws}/delete/resume   -> {delete}: a platform admin invokes a failed or stalled delete
                                         again from its checkpoint (409 for one still moving or finished; audited).
The request and the resume answer 403 "not available in this deployment", writing nothing, unless the deployment
turns the hard delete on (``-c workspaceHardDelete=true``: WORKSPACE_HARD_DELETE ``true``; off by default). The cancel works whatever the flag: it only restores a workspace.

The /platform routes are for platform admins only: an administrator (``require_admin``), the token's
``platform-admins`` group (``require_platform_admin``), then the live check (shared/platform_admin_gate.py
``require_live_platform_admin``, in the pool ``USER_POOL_ID`` names: the live Cognito membership and an enabled
account), so a revoked or disabled platform admin is refused (403) at once. The same live check
(``confirm_live_platform_admin``) runs before a platform admin enters a workspace, as in every domain API.

A DynamoDB or Cognito fault answers a fixed 500, never the AWS error text, which is logged.
"""

import json
import os
from collections.abc import Mapping
from datetime import UTC, date, datetime
from typing import Any, Final

from aws_lambda_powertools.event_handler import Response, content_types
from botocore.exceptions import BotoCoreError, ClientError

from shared.api import api_handler, create_api_resolver, get_caller_subject, is_admin, require_admin
from shared.aws import (
    get_cognito_idp_client,
    get_dynamodb_resource,
    get_s3_client,
    invoke_lambda_async,
)
from shared.enabled_sources import enabled_plugin_ids
from shared.exceptions import ConfigurationError, ConflictError, ServiceError, ValidationError
from shared.export_jobs import (
    ErasureHoldsExports,
    ExportRunning,
    LinkUnavailable,
    export_status,
    issue_link,
    start_export,
)
from shared.import_runs import parse_limit
from shared.ingest_tables import ingest_table
from shared.logging import logger
from shared.platform_admin import require_platform_admin
from shared.platform_admin_gate import confirm_live_platform_admin, require_live_platform_admin
from shared.platform_costs import cost_page, parse_cost_limit, parse_range
from shared.platform_workspaces import (
    CREDENTIALS_READY,
    create_workspace,
    list_workspaces,
    new_workspace_id,
    parse_new_workspace,
)
from shared.request_body import json_object_body
from shared.tables import cached_table
from shared.trial_pause import PauseTables, resume
from shared.trial_state import new_trial, parse_extension, stored_trial, trial_summary
from shared.trials import convert_trial, extend_trial, trial_view
from shared.warm_init import warm_at_init
from shared.workspace import (
    WORKSPACE_FAULT,
    MembershipCache,
    WorkspaceContext,
    list_my_workspaces,
    member_subject,
    require_workspace_admin,
    resolve_workspace,
)
from shared.workspace_deletes import (
    cancel_delete,
    parse_delete_request,
    request_delete,
    require_hard_delete,
    resume_delete,
)
from shared.workspace_members import (
    MemberAccountError,
    add_member,
    audit_account_creation,
    change_role,
    find_or_create_account,
    list_members,
    member_sub,
    parse_new_member,
    parse_role_change,
    remove_member,
    suggested_playbook,
)
from shared.workspace_plugin_settings import (
    offered_plugin,
    parse_plugin_change,
    set_plugin_enabled,
    workspace_plugins,
)
from shared.workspace_rename import parse_rename, rename_workspace
from shared.ws_repo import ExportObjects, WorkspaceScope, WorkspaceTable, scope_of

WORKSPACES_TABLE = os.environ.get('WORKSPACES_TABLE', '')
USER_POOL_ID = os.environ.get('USER_POOL_ID', '')
# A workspace's export (shared/export_jobs.py): its job rows (voc-aggregates), its zip (the raw data bucket's
# ws/{ws}/exports/) and the job that writes it.
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')
RAW_DATA_BUCKET = os.environ.get('RAW_DATA_BUCKET', '')
EXPORT_FUNCTION = os.environ.get('EXPORT_FUNCTION', '')
# A workspace's hard delete (shared/workspace_deletes.py): the job that sweeps it.
DELETE_FUNCTION = os.environ.get('DELETE_FUNCTION', '')
# The fixed answers of a fault (#263: never the AWS text).
FAILED_LIST = 'Failed to list your workspaces'
FAILED_CURRENT = WORKSPACE_FAULT
FAILED_CREATE = 'Failed to create the workspace'
FAILED_RENAME = 'Failed to rename the workspace'
FAILED_PLATFORM_LIST = 'Failed to list the workspaces'
FAILED_MEMBERS = 'Failed to list the members'
FAILED_ADD_MEMBER = 'Failed to add the member'
FAILED_CHANGE_ROLE = "Failed to change the member's role"
FAILED_REMOVE_MEMBER = 'Failed to remove the member'
FAILED_PLUGINS = "Failed to list the workspace's plugins"
FAILED_CHANGE_PLUGIN = 'Failed to change the plugin'
FAILED_START_EXPORT = 'Failed to start the export'
FAILED_EXPORT_STATUS = 'Failed to read the export'
FAILED_EXPORT_LINK = 'Failed to sign the download link'
EXPORT_NOT_DOWNLOADABLE: Final = ('No export can be downloaded: the newest is not completed, or its 7 days are '
                                  'over. Start a new export')
EXPORT_ALREADY_RUNNING: Final = 'An export of this workspace is already running: wait for it to finish, then start another'
EXPORT_ERASURE_RUNNING: Final = 'An erasure is running in this workspace: start the export when it ends'
FAILED_START_DELETE = 'Failed to start the delete'
FAILED_CANCEL_DELETE = 'Failed to cancel the delete'
FAILED_RESUME_DELETE = 'Failed to resume the delete'
FAILED_PLATFORM_COSTS = 'Failed to read the costs'
FAILED_EXTEND_TRIAL = 'Failed to extend the trial'
FAILED_CONVERT_TRIAL = 'Failed to convert the trial'

app = create_api_resolver()
# The warm container's resolved memberships (30 s, shared/workspace.py).
memberships = MembershipCache()


def get_workspaces_table() -> Any:
    """The voc-workspaces table resource, or 500 when the deployment did not configure it."""
    if not WORKSPACES_TABLE:
        raise ConfigurationError('Workspaces table not configured')
    return cached_table(get_dynamodb_resource(), WORKSPACES_TABLE)


def _user_pool() -> str:
    """The user pool id, or 500 when the deployment did not configure it."""
    if not USER_POOL_ID:
        raise ConfigurationError('User pool not configured')
    return USER_POOL_ID


@app.get('/me/workspaces')
def my_workspaces() -> dict:
    sub = get_caller_subject(app.current_event.raw_event)
    try:
        workspaces = list_my_workspaces(get_workspaces_table(), sub)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error listing my workspaces')
        raise ServiceError(FAILED_LIST) from exc
    return {'workspaces': workspaces}


def _workspace(event: dict, public_error: str, *, fresh: bool = False) -> WorkspaceContext:
    """The workspace X-Workspace-Id names and the caller's role there (shared/workspace.py); a fault answers
    ``public_error`` (500). ``fresh`` (the members writes): resolved from the table, never from the warm cache, so an
    admin demoted or removed a moment ago in another container cannot undo it (a platform admin's write is then
    audited as an entry each time)."""
    try:
        return resolve_workspace(get_workspaces_table(), event, MembershipCache() if fresh else memberships,
                                 confirm_platform_admin=confirm_live_platform_admin)
    except (ClientError, BotoCoreError) as exc:
        # A failed read, a failed live platform-admin check, or an entry audit row that could not be written: the
        # entry is refused, the AWS error (table, key, account) stays in the log.
        logger.exception('Error resolving the workspace')
        raise ServiceError(public_error) from exc


@app.get('/me/workspaces/current')
def current_workspace() -> dict:
    event = app.current_event.raw_event
    context = _workspace(event, FAILED_CURRENT)
    table = get_workspaces_table()
    try:
        # Every member reads the trial (7.71.00): when it ends, whether it is paused; and the playbook suggested to them.
        trial = trial_summary(stored_trial(table, context.ws))
        playbook = suggested_playbook(table, context.ws, member_subject(event))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error reading the workspace trial')
        raise ServiceError(FAILED_CURRENT) from exc
    return {'workspace': {
        'id': context.ws, 'name': context.name, 'slug': context.slug, 'role': context.role,
        'platform_admin': context.platform_admin, 'trial': trial, 'playbook': playbook,
    }}


@app.put('/me/workspaces/current')
def rename_current_workspace() -> dict:
    event = app.current_event.raw_event
    # The body first: a bad one is refused before a platform admin's entry writes its audit row.
    name = parse_rename(json_object_body(app))
    context = _workspace(event, FAILED_RENAME, fresh=True)
    require_workspace_admin(context)
    try:
        workspace = rename_workspace(get_workspaces_table(), context, name, get_caller_subject(event))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error renaming a workspace')
        raise ServiceError(FAILED_RENAME) from exc
    memberships.invalidate_workspace(context.ws)
    return {'workspace': workspace}


@app.get('/me/workspaces/current/members')
def workspace_members() -> dict:
    context = _workspace(app.current_event.raw_event, FAILED_MEMBERS)
    params = app.current_event.query_string_parameters or {}
    try:
        members, next_cursor = list_members(
            get_workspaces_table(), context.ws, limit=parse_limit(params.get('limit')),
            cursor=params.get('cursor') or None, cognito=get_cognito_idp_client(), user_pool_id=_user_pool())
    except ValueError as exc:
        raise ValidationError('limit or cursor is not valid') from exc
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error listing the workspace members')
        raise ServiceError(FAILED_MEMBERS) from exc
    return {'members': members, 'next_cursor': next_cursor}


@app.post('/me/workspaces/current/members')
def add_workspace_member():  # a Response: the resolver validates a return annotation, so none here
    event = app.current_event.raw_event
    # The body first: a bad one is refused before a platform admin's entry writes its audit row (the 400 says
    # nothing about the workspace).
    new = parse_new_member(json_object_body(app))
    context = _workspace(event, FAILED_ADD_MEMBER, fresh=True)
    require_workspace_admin(context)
    table = get_workspaces_table()
    try:
        # A new account only for a deployment administrator (platform admins are ones): until the data path is keyed
        # by workspace, every account reads the whole deployment (shared/workspace_members.py).
        actor = get_caller_subject(event)
        account = find_or_create_account(
            get_cognito_idp_client(), _user_pool(), new.email, may_create=is_admin(event),
            # A new account is recorded before it exists, so a failed add never leaves one unrecorded (D4).
            before_create=lambda: audit_account_creation(table, context, actor, new.email))
        member = add_member(table, context, account, new.role, actor, new.playbook)
    except (ClientError, BotoCoreError, MemberAccountError) as exc:
        # A Cognito fault, a failed audit row (nothing added) or a failed transaction.
        logger.exception('Error adding a workspace member')
        raise ServiceError(FAILED_ADD_MEMBER) from exc
    memberships.invalidate(context.ws, account.sub)
    body = {'member': {**member, 'account': 'created' if account.created else 'existing'}}
    return Response(status_code=201, content_type=content_types.APPLICATION_JSON, body=json.dumps(body))


@app.put('/me/workspaces/current/members/<sub>')
def change_workspace_member_role(sub: str) -> dict:
    event = app.current_event.raw_event
    target = member_sub(sub)
    role = parse_role_change(json_object_body(app))
    context = _workspace(event, FAILED_CHANGE_ROLE, fresh=True)
    require_workspace_admin(context)
    try:
        member = change_role(get_workspaces_table(), context, target, role, get_caller_subject(event))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error changing a workspace member role')
        raise ServiceError(FAILED_CHANGE_ROLE) from exc
    memberships.invalidate(context.ws, target)
    return {'member': member}


@app.delete('/me/workspaces/current/members/<sub>')
def remove_workspace_member(sub: str) -> dict:
    event = app.current_event.raw_event
    target = member_sub(sub)
    context = _workspace(event, FAILED_REMOVE_MEMBER, fresh=True)
    caller = get_caller_subject(event)
    # A member may leave (remove themselves); removing anyone else is for the workspace's admins.
    if target != caller:
        require_workspace_admin(context)
    try:
        remove_member(get_workspaces_table(), context, target, caller)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error removing a workspace member')
        raise ServiceError(FAILED_REMOVE_MEMBER) from exc
    memberships.invalidate(context.ws, target)
    return {'removed': target}


@app.get('/me/workspaces/current/plugins')
def workspace_plugin_list() -> dict:
    context = _workspace(app.current_event.raw_event, FAILED_PLUGINS)
    try:
        plugins = workspace_plugins(get_workspaces_table(), context.ws, enabled_plugin_ids())
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error listing the workspace plugins')
        raise ServiceError(FAILED_PLUGINS) from exc
    return {'plugins': plugins}


@app.put('/me/workspaces/current/plugins/<plugin_id>')
def change_workspace_plugin(plugin_id: str) -> dict:
    event = app.current_event.raw_event
    # The plugin and the body first: refused before a platform admin's entry writes its audit row.
    plugin = offered_plugin(plugin_id, enabled_plugin_ids())
    enabled = parse_plugin_change(json_object_body(app))
    context = _workspace(event, FAILED_CHANGE_PLUGIN, fresh=True)
    require_workspace_admin(context)
    try:
        entry = set_plugin_enabled(get_workspaces_table(), context, plugin, enabled, get_caller_subject(event))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error changing a workspace plugin')
        raise ServiceError(FAILED_CHANGE_PLUGIN) from exc
    return {'plugin': entry}


def _export_jobs(context: WorkspaceContext) -> WorkspaceTable:
    """The workspace's view of voc-aggregates (its export jobs and lock), or 500 when it is not configured."""
    if not AGGREGATES_TABLE:
        raise ConfigurationError('Aggregates table not configured')
    return ingest_table(scope_of(context), get_dynamodb_resource(), AGGREGATES_TABLE)


def _start_export_job(payload: dict) -> None:
    """The export job's async invoke (``payload`` built by shared/export_jobs.py ``start_export``)."""
    invoke_lambda_async(EXPORT_FUNCTION, payload)


@app.post('/me/workspaces/current/export')
def start_workspace_export():  # a Response: the resolver validates a return annotation, so none here
    event = app.current_event.raw_event
    context = _workspace(event, FAILED_START_EXPORT, fresh=True)
    require_workspace_admin(context)
    if not EXPORT_FUNCTION:
        # Before the lock: a deployment that cannot start the job never holds a workspace's export for an hour.
        raise ConfigurationError('Export function not configured')
    try:
        export = start_export(_export_jobs(context), get_workspaces_table(), context, get_caller_subject(event),
                              _start_export_job, datetime.now(UTC))
    except ErasureHoldsExports as exc:
        raise ConflictError(EXPORT_ERASURE_RUNNING) from exc
    except ExportRunning as exc:
        raise ConflictError(EXPORT_ALREADY_RUNNING) from exc
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error starting a workspace export')
        raise ServiceError(FAILED_START_EXPORT) from exc
    return Response(status_code=202, content_type=content_types.APPLICATION_JSON, body=json.dumps({'export': export}))


@app.get('/me/workspaces/current/export')
def workspace_export_status() -> dict:
    event = app.current_event.raw_event
    context = _workspace(event, FAILED_EXPORT_STATUS)
    require_workspace_admin(context)
    try:
        export = export_status(_export_jobs(context), datetime.now(UTC))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error reading a workspace export')
        raise ServiceError(FAILED_EXPORT_STATUS) from exc
    return {'export': export}


@app.post('/me/workspaces/current/export/link')
def workspace_export_link() -> dict:
    event = app.current_event.raw_event
    # Fresh: a link is issued only to a caller who is an admin now, never from a 30 s old role.
    context = _workspace(event, FAILED_EXPORT_LINK, fresh=True)
    require_workspace_admin(context)
    if not RAW_DATA_BUCKET:
        raise ConfigurationError('Raw data bucket not configured')
    try:
        link = issue_link(_export_jobs(context), get_workspaces_table(),
                          ExportObjects(scope_of(context), get_s3_client(), RAW_DATA_BUCKET), context,
                          get_caller_subject(event), datetime.now(UTC))
    except LinkUnavailable as exc:
        raise ConflictError(EXPORT_NOT_DOWNLOADABLE) from exc
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error signing a workspace export link')
        raise ServiceError(FAILED_EXPORT_LINK) from exc
    return {'link': link}


def _start_delete_job(payload: dict) -> None:
    """The delete job's async invoke (``payload`` built by shared/workspace_deletes.py)."""
    invoke_lambda_async(DELETE_FUNCTION, payload)


def _workspace_aggregates(scope: WorkspaceScope) -> WorkspaceTable:
    """A workspace's view of voc-aggregates (its export and erasure locks), or 500 when it is not configured."""
    if not AGGREGATES_TABLE:
        raise ConfigurationError('Aggregates table not configured')
    return ingest_table(scope, get_dynamodb_resource(), AGGREGATES_TABLE)


@app.post('/me/workspaces/current/delete')
def delete_workspace():  # a Response: the resolver validates a return annotation, so none here
    event = app.current_event.raw_event
    # The deployment flag first: off, nothing is read or written (not even a platform admin's entry row).
    require_hard_delete()
    # The body next: a bad one is refused before a platform admin's entry writes its audit row.
    request = parse_delete_request(json_object_body(app))
    context = _workspace(event, FAILED_START_DELETE, fresh=True)
    require_workspace_admin(context)
    if not DELETE_FUNCTION:
        # Before the locks: a deployment that cannot start the job never holds a workspace's export or erasure.
        raise ConfigurationError('Delete function not configured')
    try:
        job = request_delete(get_workspaces_table(), _export_jobs(context), context, get_caller_subject(event),
                             request, _start_delete_job, datetime.now(UTC))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error starting a workspace delete')
        raise ServiceError(FAILED_START_DELETE) from exc
    return Response(status_code=202, content_type=content_types.APPLICATION_JSON, body=json.dumps({'delete': job}))


@app.post('/platform/workspaces/<ws>/delete/cancel')
def cancel_workspace_delete(ws: str) -> dict:
    # Whatever the deployment flag: a cancel only restores a workspace (one left waiting in its fence when the flag
    # was turned off would otherwise stay `deleting` for good).
    event = app.current_event.raw_event
    require_admin(event)
    require_platform_admin(event)
    require_live_platform_admin(event, FAILED_CANCEL_DELETE)
    try:
        job = cancel_delete(get_workspaces_table(), _workspace_aggregates, ws, get_caller_subject(event),
                            datetime.now(UTC))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error cancelling a workspace delete')
        raise ServiceError(FAILED_CANCEL_DELETE) from exc
    return {'delete': job}


@app.post('/platform/workspaces/<ws>/delete/resume')
def resume_workspace_delete(ws: str) -> dict:
    event = app.current_event.raw_event
    require_hard_delete()
    require_admin(event)
    require_platform_admin(event)
    require_live_platform_admin(event, FAILED_RESUME_DELETE)
    if not DELETE_FUNCTION:
        raise ConfigurationError('Delete function not configured')
    try:
        job = resume_delete(get_workspaces_table(), ws, get_caller_subject(event), _start_delete_job,
                            datetime.now(UTC))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error resuming a workspace delete')
        raise ServiceError(FAILED_RESUME_DELETE) from exc
    return {'delete': job}


@app.post('/platform/workspaces')
def create_platform_workspace():  # a Response: the resolver validates a return annotation, so none here
    event = app.current_event.raw_event
    require_admin(event)
    require_platform_admin(event)
    require_live_platform_admin(event, FAILED_CREATE)
    new = parse_new_workspace(json_object_body(app))
    creator = get_caller_subject(event)
    ws = new_workspace_id()
    trial = None if new.trial is None else new_trial(new.trial, creator, datetime.now(UTC))
    try:
        # Every plugin the deployment offers starts on (7.40.00); Workspace settings turns one off.
        create_workspace(get_workspaces_table(), new, creator, enabled_plugin_ids(), ws=ws, trial=trial)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error creating a workspace')
        raise ServiceError(FAILED_CREATE) from exc
    # Nothing else to make (decision 19: a plugin's parameters are created by its first save in the workspace);
    # `secret_status` stays in the answer for the platform API's callers, always `ready`.
    workspace = {'id': ws, 'name': new.name, 'slug': new.slug, 'role': 'admin', 'secret_status': CREDENTIALS_READY,
                 'trial': trial_view(trial)}
    return Response(status_code=201, content_type=content_types.APPLICATION_JSON,
                    body=json.dumps({'workspace': workspace}))


def _resume(ws: str, trial: Mapping[str, Any], actor: str, reason: str) -> dict[str, Any]:
    """A paused trial's plugins and forms turned back on (shared/trial_pause.py), as the platform admin."""
    if not AGGREGATES_TABLE:
        raise ConfigurationError('Aggregates table not configured')
    resource = get_dynamodb_resource()
    tables = PauseTables(workspaces=get_workspaces_table(),
                         forms=lambda scope: ingest_table(scope, resource, AGGREGATES_TABLE),
                         ceiling=enabled_plugin_ids())
    return resume(tables, ws, trial, actor, reason)


@app.post('/platform/workspaces/<ws>/trial/extend')
def extend_workspace_trial(ws: str) -> dict:
    event = app.current_event.raw_event
    require_admin(event)
    require_platform_admin(event)
    require_live_platform_admin(event, FAILED_EXTEND_TRIAL)
    days = parse_extension(json_object_body(app))
    try:
        trial = extend_trial(get_workspaces_table(), ws, days, get_caller_subject(event), resume=_resume,
                             now=datetime.now(UTC))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error extending a trial')
        raise ServiceError(FAILED_EXTEND_TRIAL) from exc
    return {'trial': trial}


@app.post('/platform/workspaces/<ws>/trial/convert')
def convert_workspace_trial(ws: str) -> dict:
    event = app.current_event.raw_event
    require_admin(event)
    require_platform_admin(event)
    require_live_platform_admin(event, FAILED_CONVERT_TRIAL)
    try:
        trial = convert_trial(get_workspaces_table(), ws, get_caller_subject(event), resume=_resume,
                              now=datetime.now(UTC))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error converting a trial')
        raise ServiceError(FAILED_CONVERT_TRIAL) from exc
    return {'trial': trial}


def _utc_today() -> date:
    return datetime.now(UTC).date()


def get_cost_table() -> Any:
    """voc-aggregates, for the cost rows (shared/platform_costs.py), or 500 when it is not configured."""
    if not AGGREGATES_TABLE:
        raise ConfigurationError('Aggregates table not configured')
    return cached_table(get_dynamodb_resource(), AGGREGATES_TABLE)


@app.get('/platform/costs')
def platform_costs() -> dict:
    event = app.current_event.raw_event
    require_admin(event)
    require_platform_admin(event)
    require_live_platform_admin(event, FAILED_PLATFORM_COSTS)
    params = app.current_event.query_string_parameters or {}
    chosen = parse_range(params, _utc_today())
    limit = parse_cost_limit(params.get('limit'))
    logger.info('platform_costs_read', extra={'caller_sub': get_caller_subject(event),
                                              'from': chosen.start.isoformat(), 'to': chosen.end.isoformat()})
    try:
        return cost_page(get_workspaces_table(), get_cost_table(), chosen, limit=limit,
                         cursor=params.get('cursor') or None)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error reading the costs')
        raise ServiceError(FAILED_PLATFORM_COSTS) from exc


@app.get('/platform/workspaces')
def list_platform_workspaces() -> dict:
    event = app.current_event.raw_event
    require_admin(event)
    require_platform_admin(event)
    require_live_platform_admin(event, FAILED_PLATFORM_LIST)
    params = app.current_event.query_string_parameters or {}
    try:
        workspaces, next_cursor = list_workspaces(get_workspaces_table(), limit=parse_limit(params.get('limit')),
                                                  cursor=params.get('cursor') or None)
    except ValueError as exc:
        raise ValidationError('limit or cursor is not valid') from exc
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error listing the workspaces')
        raise ServiceError(FAILED_PLATFORM_LIST) from exc
    return {'workspaces': workspaces, 'next_cursor': next_cursor}


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource)


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
