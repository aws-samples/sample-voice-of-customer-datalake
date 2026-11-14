"""The broker's Lambda function URL (IAM authentication; docs/autonomous-engineering.md, "Repository connectors").

POST ``{"operation": ..., "args": {...}}``; the caller comes from the request's IAM identity (``identity``), never
from the body. Status codes: 200 with ``{"result": ...}``; 400 a body the broker cannot read; 403 a caller that is
not an agent, or a role that may not make the operation; 404 a read of what the repository does not have; 409 a
refusal for the run's, the dial's or the board's state, or a host state other than the checked one (the branch
moved, another tree); 422 a refusal by the write rules or of the submitted patch; 502 a host error; 503 no
repository connection, the run's records or the way of working unreadable for now, or the host rate limiting (with
``Retry-After``). Every refusal carries ``{"error": <plain reason>}``.

The broker's connector: the GitHub client (``github.GitHubHost``) over the connections' SSM credentials, once the
stack names their prefix; with the engineering table, the workspace bucket and the aggregates table named too, the
run's record and the board's GO ledger (``records.RunRecords``), the submitted patch's reader
(``patches.WorkspacePatches``) and the dial (``dial.WaysOfWorking``). Without them, ``hosts.UNCONNECTED`` stands in
and every permitted operation answers 503.

Nothing from the body is logged or echoed (it may hold a bundle, a comment, or a token pasted by mistake): the log
line has the operation, the caller's role, run and agent index, and the status.
"""
from __future__ import annotations

import base64
import binascii
import json
import os
from collections.abc import Callable, Mapping
from functools import lru_cache
from typing import Any, Final

from engineering.connectors.broker import Broker, NotNow, NotPermitted
from engineering.connectors.connections import PARAMETER_PREFIX_ENV
from engineering.connectors.credentials import ParameterStoreCredentials
from engineering.connectors.dial import WaysOfWorking
from engineering.connectors.github import GitHubHost
from engineering.connectors.hosts import (
    NO_CONNECTION,
    OBJECT_ID,
    UNCONNECTED,
    CommentTarget,
    Conflict,
    Connector,
    HostBusy,
    HostError,
    InvalidTarget,
    NoConnection,
    NotFound,
    ReadKind,
    Unavailable,
)
from engineering.connectors.identity import (
    OPEN_OR_UPDATE_DRAFT_PR,
    POST_COMMENT,
    PUSH_BUNDLE,
    READ,
    Caller,
    UnknownCaller,
    caller_from_event,
    own_account,
)
from engineering.connectors.patches import WorkspacePatches
from engineering.connectors.records import RunRecords, WriteClaims
from engineering.connectors.write_policy import WriteRefused
from engineering.runtime.interface import MAX_ATTEMPT
from engineering.workspace.store import WorkspaceStore
from shared.invocation_cost import instrumented_handler
from shared.logging import logger

#: The agent roles' IAM role names, ``{role}`` standing for the role (set by lib/stacks/engineering-broker.ts).
ROLE_NAME_PATTERN_ENV: Final = 'AGENT_ROLE_NAME_PATTERN'
#: A Lambda function URL takes at most 6 MB of request; a body over that is not one the broker reads.
MAX_BODY_CHARS: Final = 6 * 1024 * 1024
MAX_TEXT: Final = 65_536
MAX_NAME: Final = 1024
_READ_KINDS: Final[Mapping[str, ReadKind]] = {
    'file': 'file', 'history': 'history', 'issue': 'issue', 'pull_request': 'pull_request'}
_COMMENT_TARGETS: Final[Mapping[str, CommentTarget]] = {'issue': 'issue', 'pull_request': 'pull_request'}
#: The stores the run's record, the GO ledger, the patches and the dial live in (set by engineering-broker.ts).
TABLE_ENV: Final = 'ENGINEERING_TABLE'
BUCKET_ENV: Final = 'ENGINEERING_WORKSPACE_BUCKET'
AGGREGATES_ENV: Final = 'AGGREGATES_TABLE'


class BadRequest(Exception):
    """The body is not a request the broker reads; the message says what is wrong, without echoing it."""


#: Under the function URL's 6 MB response limit, with room for the headers: JSON escaping and a pull request's
#: combined thread pages can make an answer larger than the client's per-response cap.
MAX_ANSWER_BYTES: Final = 5_500_000


def _response(status: int, payload: Mapping[str, object], retry_after: int | None = None) -> dict[str, Any]:
    headers = {'Content-Type': 'application/json'}
    if retry_after is not None:
        headers['Retry-After'] = str(retry_after)
    body = json.dumps(payload)
    if len(body.encode()) > MAX_ANSWER_BYTES:
        return {'statusCode': 502, 'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'The answer is larger than the broker returns; read a smaller page.'})}
    return {'statusCode': status, 'headers': headers, 'body': body}


def _request(event: Mapping[str, object]) -> tuple[str, dict[str, object]]:
    raw = event.get('body')
    if not isinstance(raw, str) or not raw or len(raw) > MAX_BODY_CHARS:
        raise BadRequest('The request needs a JSON body of at most 6 MB.')
    try:
        if event.get('isBase64Encoded') is True:
            raw = base64.b64decode(raw, validate=True).decode('utf-8')
        parsed = json.loads(raw)
    except (binascii.Error, UnicodeDecodeError, ValueError):
        raise BadRequest('The body is not JSON.') from None
    if not isinstance(parsed, dict) or set(parsed) != {'operation', 'args'}:
        raise BadRequest('The body is {"operation": ..., "args": {...}} and nothing else.')
    operation, args = parsed['operation'], parsed['args']
    if not isinstance(operation, str) or operation not in _OPERATIONS:
        raise BadRequest(f'The operation is one of {", ".join(sorted(_OPERATIONS))}.')
    if not isinstance(args, dict):
        raise BadRequest('The args are a JSON object.')
    return operation, args


def _keys(args: Mapping[str, object], required: set[str], optional: frozenset[str] = frozenset()) -> None:
    keys = set(args)
    if not required <= keys or not keys <= required | optional:
        expected = ', '.join(sorted(required)) + (f' (and optionally {", ".join(sorted(optional))})' if optional else '')
        raise BadRequest(f'The args are exactly: {expected}.')


def _text(args: Mapping[str, object], key: str, limit: int) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value or len(value) > limit:
        raise BadRequest(f'{key} is a non-empty string of at most {limit} characters.')
    return value


def _choice[T](args: Mapping[str, object], key: str, choices: Mapping[str, T]) -> T:
    value = args.get(key)
    if not isinstance(value, str) or value not in choices:
        raise BadRequest(f'{key} is one of {", ".join(choices)}.')
    return choices[value]


#: A write's optional ``attempt`` (the caller's task attempt, 1 by default): with the caller's run and agent and the
#: operation, the key a write is made once for (broker.py ``_once``). Its bound is the runtime's own (a task's attempts,
#: ``runtime/interface.py`` ``MAX_ATTEMPT``), so every attempt an agent can work at can write.
_ATTEMPT: Final = frozenset({'attempt'})


def _attempt(args: Mapping[str, object]) -> int:
    attempt = args.get('attempt', 1)
    if isinstance(attempt, bool) or not isinstance(attempt, int) or not 0 < attempt <= MAX_ATTEMPT:
        raise BadRequest(f'attempt is a whole number from 1 to {MAX_ATTEMPT}.')
    return attempt


def _read(broker: Broker, caller: Caller, args: Mapping[str, object]) -> dict[str, object]:
    _keys(args, {'kind', 'target'}, frozenset({'cursor'}))
    cursor = _text(args, 'cursor', MAX_NAME) if 'cursor' in args else None
    page = broker.read(caller, _choice(args, 'kind', _READ_KINDS), _text(args, 'target', MAX_NAME), cursor)
    return {'content': page.content, 'next_cursor': page.next_cursor}


def _post_comment(broker: Broker, caller: Caller, args: Mapping[str, object]) -> dict[str, object]:
    _keys(args, {'on', 'number', 'body'}, _ATTEMPT)
    number = args['number']
    if isinstance(number, bool) or not isinstance(number, int) or number < 1:
        raise BadRequest('number is a positive integer.')
    url = broker.post_comment(caller, _choice(args, 'on', _COMMENT_TARGETS), number, _text(args, 'body', MAX_TEXT),
                              _attempt(args))
    return {'url': url}


def _push_bundle(broker: Broker, caller: Caller, args: Mapping[str, object]) -> dict[str, object]:
    """``{branch, patch, tree_hash, message, attempt?}``: the caller's submitted patch (its workspace key) as one
    commit."""
    _keys(args, {'branch', 'patch', 'tree_hash', 'message'}, _ATTEMPT)
    tree_hash = _text(args, 'tree_hash', MAX_NAME)
    if not OBJECT_ID.fullmatch(tree_hash):
        raise BadRequest('tree_hash is a full git tree id (the one the board\'s GO names).')
    branch = _text(args, 'branch', MAX_NAME)
    pushed = broker.push_bundle(caller, branch, _text(args, 'patch', MAX_NAME), tree_hash,
                                _text(args, 'message', MAX_TEXT), _attempt(args))
    return {'branch': branch, 'tree_hash': pushed}


def _open_or_update_draft_pr(broker: Broker, caller: Caller, args: Mapping[str, object]) -> dict[str, object]:
    _keys(args, {'branch', 'title', 'body'}, _ATTEMPT)
    ref = broker.open_or_update_draft_pr(caller, _text(args, 'branch', MAX_NAME), _text(args, 'title', MAX_NAME),
                                         _text(args, 'body', MAX_TEXT), _attempt(args))
    return {'number': ref.number, 'url': ref.url}


_OPERATIONS: Final[Mapping[str, Callable[[Broker, Caller, Mapping[str, object]], dict[str, object]]]] = {
    READ: _read,
    POST_COMMENT: _post_comment,
    PUSH_BUNDLE: _push_bundle,
    OPEN_OR_UPDATE_DRAFT_PR: _open_or_update_draft_pr,
}


#: Each refusal the broker or the host client raises, and its status: the nearest class in the refusal's MRO.
_REFUSAL_STATUSES: Final[Mapping[type, int]] = {
    NotPermitted: 403, NotNow: 409, Conflict: 409, WriteRefused: 422,
    InvalidTarget: 400, NotFound: 404, HostBusy: 503, Unavailable: 503, HostError: 502,
}


def _refusal(exc: WriteRefused | HostError) -> dict[str, Any]:
    status = next(_REFUSAL_STATUSES[kind] for kind in type(exc).__mro__ if kind in _REFUSAL_STATUSES)
    return _response(status, {'error': exc.reason}, retry_after=exc.retry_after if isinstance(exc, HostBusy) else None)


def _answer(event: Mapping[str, object], caller: Caller, broker: Broker) -> tuple[str | None, dict[str, Any]]:
    operation: str | None = None
    try:
        operation, args = _request(event)
        return operation, _response(200, {'result': _OPERATIONS[operation](broker, caller, args)})
    except BadRequest as exc:
        return operation, _response(400, {'error': str(exc)})
    except NoConnection:
        return operation, _response(503, {'error': NO_CONNECTION})
    except (WriteRefused, HostError) as exc:
        return operation, _refusal(exc)


def handle(event: Mapping[str, object], role_name_pattern: str, account: str, broker: Broker) -> dict[str, Any]:
    """The function URL's response to ``event``, for callers of ``account`` (the broker's own)."""
    try:
        caller = caller_from_event(event, role_name_pattern, account)
    except UnknownCaller:
        logger.warning('broker call refused', extra={'status': 403})
        return _response(403, {'error': 'The caller is not an engineering agent.'})
    operation, response = _answer(event, caller, broker)
    logger.info('broker call', extra={'operation': operation, 'role': caller.role, 'run_id': caller.run_id,
                                      'agent': caller.agent_index, 'status': response['statusCode']})
    return response


@lru_cache(maxsize=1)
def broker_for(parameter_prefix: str, table: str = '', bucket: str = '', aggregates: str = '') -> Broker:
    """The container's broker (one, so its credentials and tokens stay warm): the GitHub client over the
    connections under ``parameter_prefix``, and the run's records, the patches and the dial in ``table``, ``bucket``
    and ``aggregates`` (``UNCONNECTED`` while any is unnamed); no connector without a prefix."""
    if not parameter_prefix:
        return Broker(None)
    host = GitHubHost(ParameterStoreCredentials(parameter_prefix).get)
    if not (table and bucket and aggregates):
        return Broker(Connector(host=host, bundles=UNCONNECTED, runs=UNCONNECTED, ledger=UNCONNECTED,
                                dial=UNCONNECTED, writes=UNCONNECTED))
    from shared.aws import get_dynamodb_client, get_dynamodb_resource, get_s3_client

    # No ListBucket on the broker's role: an object never written answers 403, read as missing (and counted).
    workspace = WorkspaceStore(get_s3_client(), bucket, denied_is_missing=True)
    records = RunRecords(get_dynamodb_client(), table, workspace)
    return Broker(Connector(host=host, bundles=WorkspacePatches(workspace, host.file_at), runs=records,
                            ledger=records, dial=WaysOfWorking(get_dynamodb_resource().Table(aggregates)),
                            writes=WriteClaims(get_dynamodb_client(), table)))


@instrumented_handler   # (its metrics flush: the workspace store's count of denied reads taken as missing)
def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    account = own_account(getattr(context, 'invoked_function_arn', None))
    environ = os.environ
    return handle(event, environ.get(ROLE_NAME_PATTERN_ENV, ''), account,
                  broker_for(environ.get(PARAMETER_PREFIX_ENV, ''), environ.get(TABLE_ENV, ''),
                             environ.get(BUCKET_ENV, ''), environ.get(AGGREGATES_ENV, '')))
