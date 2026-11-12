"""
Workspaces API Lambda (voc-workspaces-api): the first routes of the multi-workspace control plane
(docs/multi-workspace.md). Served under /me/{proxy+}, GET only, for every signed-in user.

Routes:
    GET /me/workspaces          {workspaces: [{id, name, slug, role}]}: the caller's own workspaces, by name
                                (one Query of the caller's USER#{sub} partition, shared/workspace.py); each
                                role is the membership row's, while /current answers the effective one
    GET /me/workspaces/current  {workspace: {id, name, slug, role, platform_admin}}: the workspace the
                                X-Workspace-Id header names, as the caller may act in it. 400 without the
                                header; 404 for a malformed id, a missing or deleting workspace, or a caller
                                who is not a member. A platform admin who is not a member admin enters as admin
                                and the entry is audited (shared/workspace.py resolve_workspace); an entry
                                whose audit row cannot be written is refused.

A DynamoDB fault answers a fixed 500 (``Failed to list your workspaces`` / ``Failed to open the workspace``),
never the AWS error text, which is logged.

Reads the voc-workspaces table (WORKSPACES_TABLE); its one write is the platform-admin entry's audit row.
"""

import os
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from shared.api import api_handler, create_api_resolver, get_caller_subject
from shared.aws import get_dynamodb_resource
from shared.exceptions import ConfigurationError, ServiceError
from shared.logging import logger
from shared.tables import cached_table
from shared.warm_init import warm_at_init
from shared.workspace import MembershipCache, list_my_workspaces, resolve_workspace

WORKSPACES_TABLE = os.environ.get('WORKSPACES_TABLE', '')
# The fixed answers of a DynamoDB fault (#263: never the AWS text).
FAILED_LIST = 'Failed to list your workspaces'
FAILED_CURRENT = 'Failed to open the workspace'

app = create_api_resolver()
# The warm container's resolved memberships (30 s, shared/workspace.py).
memberships = MembershipCache()


def get_workspaces_table() -> Any:
    """The voc-workspaces table resource, or 500 when the deployment did not configure it."""
    if not WORKSPACES_TABLE:
        raise ConfigurationError('Workspaces table not configured')
    return cached_table(get_dynamodb_resource(), WORKSPACES_TABLE)


@app.get('/me/workspaces')
def my_workspaces() -> dict:
    sub = get_caller_subject(app.current_event.raw_event)
    try:
        workspaces = list_my_workspaces(get_workspaces_table(), sub)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error listing my workspaces')
        raise ServiceError(FAILED_LIST) from exc
    return {'workspaces': workspaces}


@app.get('/me/workspaces/current')
def current_workspace() -> dict:
    try:
        context = resolve_workspace(get_workspaces_table(), app.current_event.raw_event, memberships)
    except (ClientError, BotoCoreError) as exc:
        # A failed read, or an entry audit row that could not be written: the entry is refused, the AWS error
        # (table, key, account) stays in the log.
        logger.exception('Error resolving the workspace')
        raise ServiceError(FAILED_CURRENT) from exc
    return {'workspace': {
        'id': context.ws, 'name': context.name, 'slug': context.slug, 'role': context.role,
        'platform_admin': context.platform_admin,
    }}


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource)


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
