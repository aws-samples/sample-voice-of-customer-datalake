"""The consent API and "my sign-ins" of MCP OAuth (behind Cognito, included by ``voc-mcp-tokens-api``).

Served through the existing ``/connect/{proxy+}`` (Cognito authorizer), so no new gateway route:

* ``GET  /connect/oauth/consent?authorize_query=<the client's query>`` — what the consent page shows: the
  client, whether it may get write, the Deny redirect. Never writes.
* ``POST /connect/oauth/consent {authorize_query, scope: read|write, project_id?}`` — the person approves:
  the grant is stored (replacing any earlier one of this person and client, which kills its tokens), a
  loopback request gets a single-use relay row, and the answer is ``{redirect_to}``: Cognito's
  ``/oauth2/authorize`` with PKCE and the client's state preserved and exactly the consented scopes.
* ``GET  /connect/oauth/grants`` — the caller's grants (one per MCP client), never anyone else's.
* ``DELETE /connect/oauth/grants/{grant_id}`` — revoke at once: the next request of every token is a 401.

The grant gets the SAME identity as a token the person mints: never admin, ≤ editor, ``minted_by_admin``
from the caller's groups (``run_agent`` is still re-checked in Cognito per call), the pin checked for
view access. A delegated credential (an MCP token or grant) can do none of this.

Cognito signs the person in AGAIN after consent (the SPA signs in with SRP, so there is no hosted-UI
session). If a different person signs in there, their token finds no grant of theirs and is refused.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared import mcp_global_tokens as gt
from shared import mcp_oauth_grants as grants
from shared import mcp_oauth_relay as relay
from shared import mcp_oauth_store as store
from shared import project_gate
from shared.exceptions import NotFoundError, ValidationError
from shared.logging import logger, tracer
from shared.mcp_oauth_authorize import (
    AuthorizeRefused,
    AuthorizeRequest,
    UntrustedRedirect,
    cognito_authorize_url,
    parse_authorize_query,
)
from shared.mcp_oauth_config import CLIENT_DISPLAY_NAMES, OAuthConfig, oauth_config
from shared.project_access import Caller
from shared.request_body import json_object_body
from shared.tables import configured_table, get_jobs_table, get_projects_table

app = Router()

GRANT_NOT_FOUND: Final = 'Sign-in not found'
OAUTH_OFF: Final = 'OAuth sign-in is not configured on this deployment'


def _now() -> datetime:
    return datetime.now(UTC)


def _person() -> Caller:
    return project_gate.require_person(app.current_event.raw_event, 'Only a signed-in user can approve MCP sign-ins')


def _config() -> OAuthConfig:
    config = oauth_config()
    if config is None:
        raise NotFoundError(OAUTH_OFF)
    return config


def _projects() -> Any:
    return configured_table(get_projects_table(), 'Projects')


def oauth_summary() -> dict[str, Any]:
    """The Connect page's OAuth block (the list route carries it): which clients can sign in."""
    config = oauth_config()
    if config is None:
        return {'enabled': False, 'clients': []}
    return {'enabled': True,
            'clients': [{'kind': kind, 'name': CLIENT_DISPLAY_NAMES[kind]} for kind in config.clients]}


def _request(config: OAuthConfig, raw: object) -> AuthorizeRequest:
    try:
        return parse_authorize_query(raw, config)
    except UntrustedRedirect as exc:
        raise ValidationError(f'This sign-in request cannot be approved: {exc}') from exc


@app.get('/connect/oauth/consent')
@tracer.capture_method
def describe_consent():
    caller = _person()
    config = _config()
    raw = (app.current_event.query_string_parameters or {}).get('authorize_query')
    try:
        request = _request(config, raw)
    except AuthorizeRefused as refused:
        return {'refused': True, 'error': refused.error, 'error_description': refused.description,
                'redirect_to': refused.error_redirect()}
    return {
        'refused': False,
        'client_kind': request.kind,
        'client_name': request.client_name,
        'can_write': request.wants_write,
        'can_run_agents': caller.is_admin,
        'loopback': request.uses_relay,
        'deny_redirect': request.deny_redirect(),
    }


def _consented_scope(body: dict, request: AuthorizeRequest) -> str:
    scope = body.get('scope')
    if not gt.scope_is_valid(scope):
        raise ValidationError(f'scope is required and must be one of: {", ".join(gt.VALID_SCOPES)}')
    if scope == gt.SCOPE_WRITE and not request.wants_write:
        raise ValidationError('The assistant asked for read access only')
    return str(scope)


@app.post('/connect/oauth/consent')
@tracer.capture_method
def approve_consent():
    caller = _person()
    config = _config()
    body = json_object_body(app)
    try:
        request = _request(config, body.get('authorize_query'))
    except AuthorizeRefused as refused:
        raise ValidationError(refused.description) from refused
    scope = _consented_scope(body, request)
    project_id = project_gate.require_viewable_pin(_projects(), body.get('project_id'), caller)
    now = _now()
    store.put_grant(_projects(), grants.grant_item(
        subject=caller.subject, username=caller.username, is_admin=caller.is_admin, client_id=request.client_id,
        client_kind=request.kind, scope=scope, project_id=project_id, code_challenge=request.code_challenge,
        now=now))
    relay_id = None
    if request.uses_relay:
        relay_id = relay.new_relay_id()
        relay.store_relay(configured_table(get_jobs_table(), 'Jobs'), relay_id,
                          relay.Delivery(request.client_id, request.redirect_uri, request.state), now)
    logger.info('MCP OAuth consent recorded', extra={'client_kind': request.kind, 'scope': scope,
                                                      'pinned': bool(project_id)})
    return {'redirect_to': cognito_authorize_url(request, config, consented_scope=scope, relay_id=relay_id)}


@app.get('/connect/oauth/grants')
@tracer.capture_method
def list_grants():
    caller = _person()
    config = oauth_config()
    if config is None:
        return {'grants': []}
    now = _now()
    rows = store.grants_of(_projects(), caller.subject, list(config.clients.values()))
    views = [grants.grant_view(row, now) for row in rows]
    views.sort(key=lambda view: str(view.get('created_at') or ''), reverse=True)
    return {'grants': views}


@app.delete('/connect/oauth/grants/<grant_id>')
@tracer.capture_method
def revoke_grant(grant_id: str):
    caller = _person()
    config = _config()
    mine = {grants.grant_id(caller.subject, client_id) for client_id in config.clients.values()}
    if grant_id not in mine:
        raise NotFoundError(GRANT_NOT_FOUND)
    if store.revoke_grant(_projects(), grant_id, caller.subject, _now()):
        logger.info('MCP OAuth grant revoked', extra={'grant_id': grant_id})
    # Revoked now or already (a concurrent revoke won): either way, answer the stored row.
    row = store.load_grant(_projects(), grant_id)
    if row is None or not grants.is_grant(row) or row.get('created_by') != caller.subject:
        raise NotFoundError(GRANT_NOT_FOUND)
    return {'grant': grants.grant_view(row, _now())}
