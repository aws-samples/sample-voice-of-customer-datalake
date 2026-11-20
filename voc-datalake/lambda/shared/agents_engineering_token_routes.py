"""A repository connected with a fine-grained token, this repository only (7.60.00; included by
``api/agents_handler.py``; docs/autonomous-engineering.md, "A fine-grained token (7.60.00)").

    POST /agents/engineering/token-connections {repository, token, only_this_repository: true, default_branch?,
                                                connection_id?, reason?}                    -> 201 {connection, created}
    PUT  /agents/engineering/connections/<id>/token {token, only_this_repository: true, reason?} -> {connection}

The token is checked against GitHub (engineering/connectors/fine_grained.py ``check_token``), then stored in SSM under
its own path (``ENGINEERING_TOKEN_PARAMETER_PREFIX``, ``/[<prefix>-]voc/engineering-token/<id>``: this role puts and
deletes it, never reads it; only the broker reads it), and the connection's row, with its audit row, in voc-agents
(engineering/connectors/token_connections.py). 400 names the field, never its value; 409 for another kind, the
connections' limit, a repository connected already, no App installation to read with, or another person replacing a
token a live run waits for; 422 ``{error, code}`` for a token GitHub's answers refuse (``fine_grained.CODES``); 503 when
GitHub, SSM or the table cannot be reached. The token is never answered, logged or put in an error.

Administrators only, acting for themselves (403 for anyone else, a delegated credential included: a token is saved
only as oneself); 404 while the engineering agents are off, as every ``/agents/engineering/*`` route. Behind Cognito
(``/agents/{proxy+}``): no new API Gateway resource. Deployment-wide, like every connection (D8).

Kept in ``shared/`` because an API bundle ships ``api/<handler>.py`` and ``shared/`` only
(api/test/test_api_bundle_imports.py); the engineering package ships with the agents Lambda and is imported lazily.
"""
from __future__ import annotations

import os
from typing import Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared.agents_store import require_agents_table as _agents_table
from shared.aws import get_dynamodb_resource, get_ssm_client
from shared.engineering_agents import require_engineering_on as _engineering_on
from shared.exceptions import ConflictError, NotFoundError, ServiceUnavailableError, ValidationError
from shared.logging import logger, tracer
from shared.project_gate import caller_from_event, require_admin_caller
from shared.request_body import json_object_body
from shared.route_answers import json_response as _json

__all__ = ['app']

app = Router()

_ERRORS: Final = {'invalid': ValidationError, 'not_found': NotFoundError, 'conflict': ConflictError,
                  'unavailable': ServiceUnavailableError}


def _store() -> tuple[Any, Any, Any]:
    """The token connections, the connections' live runs and the caller: 404 while the module is off, then 403 for
    anyone but an administrator acting for themselves."""
    _engineering_on()
    caller = caller_from_event(app.current_event.raw_event)
    require_admin_caller(caller)
    from engineering.connectors.connections import (
        PARAMETER_KEY_ENV,
        PARAMETER_PREFIX_ENV,
        WRITE_TOKENS_PREFIX_ENV,
        Actor,
        ConnectionStore,
        live_runs_of,
    )
    from engineering.connectors.token_connections import TokenConnections
    from engineering.runtime.runs import RunStore

    live = live_runs_of(RunStore(get_dynamodb_resource().Table(os.environ['ENGINEERING_TABLE'])))
    store = ConnectionStore(_agents_table(), get_ssm_client, os.environ.get(PARAMETER_PREFIX_ENV, ''),
                            os.environ.get(PARAMETER_KEY_ENV, ''), live,
                            token_prefix=os.environ.get(WRITE_TOKENS_PREFIX_ENV, ''))
    return TokenConnections(store), live, Actor(subject=caller.subject, name=caller.username or caller.subject)


def _answered(act: Any) -> Any:
    """``act()``, a refusal answered with its status: the token's (422 with its code, or 503) or the connection's."""
    from engineering.connectors.connections import ConnectionRefused
    from engineering.connectors.fine_grained import CODES, TokenRefused

    try:
        return act()
    except TokenRefused as refused:
        if refused.code not in CODES:   # ('unavailable': GitHub could not be asked)
            raise ServiceUnavailableError(str(refused)) from None
        logger.info('engineering token refused', extra={'code': refused.code})
        return _json(422, {'success': False, 'error': str(refused), 'code': refused.code})
    except ConnectionRefused as refused:
        raise _ERRORS[refused.kind](str(refused)) from None


@app.post('/agents/engineering/token-connections')
@tracer.capture_method(capture_response=False)
def connect_engineering_token_repository():
    """``{repository, token, only_this_repository: true, default_branch?, connection_id?, reason?}`` → 201
    ``{connection, created}``: a public repository connected with a fine-grained token limited to it (the module's
    header)."""
    tokens, _, actor = _store()

    def connect() -> Any:
        connection, created = tokens.create(json_object_body(app), actor)
        return _json(201, {'connection': connection, 'created': created})

    return _answered(connect)


@app.put('/agents/engineering/connections/<connection_id>/token')
@tracer.capture_method(capture_response=False)
def replace_engineering_connection_token(connection_id: str):
    """``{token, only_this_repository: true, reason?}`` → ``{connection}``: the connection's token replaced (a renewal),
    checked as at the save, for the connection's own repository. 404 for a connection not stored; 409 for one that is
    not a token's, or while a live run waits for another person's go."""
    tokens, live, actor = _store()
    from engineering.connectors.connections import check_connection_id

    def replace() -> Any:
        check_connection_id(connection_id)
        return {'connection': tokens.renew(connection_id, json_object_body(app), actor, live)}

    return _answered(replace)
