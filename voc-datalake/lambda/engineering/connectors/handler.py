"""The broker's Lambda function URL (IAM authentication; docs/autonomous-engineering.md, "Repository connectors").

POST ``{"operation": ..., "args": {...}}``; the caller comes from the request's IAM identity (``identity``), never
from the body. Status codes: 200 with ``{"result": ...}``; 400 a body the broker cannot read; 403 a caller that is
not an agent, or a role that may not make the operation; 404 a read of what the repository does not have; 409 a
refusal for the run's, the dial's or the board's state, or a host state other than the checked one (the branch
moved, another tree); 422 a refusal by the write rules or of the submitted patch; 502 a host error; 503 no
repository connection, the run's records or the way of working unreadable for now, or the host rate limiting (with
``Retry-After``). Every refusal carries ``{"error": <plain reason>}``.

The broker's connector: the GitHub and GitLab clients (``github.GitHubHost``, ``gitlab.GitLabHost``, each connection on
its own host's: ``router.HostRouter``) over the connections' SSM credentials, once the stack names their prefix; with the engineering table, the workspace bucket and the aggregates table named too, the
run's record and the board's GO ledger (``records.RunRecords``), the submitted patch's reader
(``patches.WorkspacePatches``) and the dial (``dial.WaysOfWorking``), and, with voc-agents named
(``ENGINEERING_CONNECTIONS_TABLE``), the connections' CI attestations (``records.RunRecords.attested``; without it no
run is attested, so every push and pull request is refused). Without them, ``hosts.UNCONNECTED`` stands in and every permitted operation answers 503.

Nothing from the body is logged or echoed (it may hold a bundle, a comment, or a token pasted by mistake): the log
line has the operation, the caller's role, run and agent index, and the status.

``reactions`` (7.10.00, ``{"run_id"}``) is voc-engineering-runtime's alone: its execution role in the session named
after its function (``ENGINEERING_RUNTIME_ROLE_NAME``, ``ENGINEERING_RUNTIME_FUNCTION_NAME``), checked as an agent's
identity is; an agent asking for it is refused 403, and the runtime asking for any other operation is too. ``head``
(7.47.00, ``{"connection", "repository", "branch", "issue"?}``) is voc-engineering-start's alone, admitted the same
way (``ENGINEERING_START_ROLE_NAME``, ``ENGINEERING_START_FUNCTION_NAME``).
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import re
import time
from collections.abc import Callable, Mapping
from functools import lru_cache
from typing import Any, Final

from engineering.connectors.broker import Broker, NotNow, NotPermitted
from engineering.connectors.connections import CONNECTION_ID, PARAMETER_PREFIX_ENV
from engineering.connectors.credentials import ParameterStoreCredentials
from engineering.connectors.dial import WaysOfWorking
from engineering.connectors.github import GitHubHost
from engineering.connectors.gitlab import GitLabHost
from engineering.connectors.hosts import (
    NO_CONNECTION,
    OBJECT_ID,
    UNCONNECTED,
    WRITE_READY_BY,
    WRITE_RESERVE_SECONDS,
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
    remaining_until,
)
from engineering.connectors.identity import (
    HEAD,
    OPEN_OR_UPDATE_DRAFT_PR,
    POST_COMMENT,
    PUSH_BUNDLE,
    REACTIONS,
    READ,
    START_ROLE,
    Caller,
    UnknownCaller,
    caller_from_event,
    own_account,
    runtime_caller_from_event,
)
from engineering.connectors.patches import WorkspacePatches
from engineering.connectors.records import RunRecords, WriteClaims
from engineering.connectors.router import HostRouter
from engineering.connectors.write_policy import WriteRefused
from engineering.runtime.interface import MAX_ATTEMPT
from engineering.workspace.store import WorkspaceStore
from shared.engineering_agents import ENGINEERING_TABLE_ENV
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
TABLE_ENV: Final = ENGINEERING_TABLE_ENV
BUCKET_ENV: Final = 'ENGINEERING_WORKSPACE_BUCKET'
AGGREGATES_ENV: Final = 'AGGREGATES_TABLE'
#: voc-agents, where the connections' CI attestations are (records.py ``attested``; unnamed: never attested). The
#: broker's own name for it: the Agents API's ``AGENTS_TABLE`` (shared/agents_store.py) is the table the broker reads of
#: only the attestations' partitions.
CONNECTIONS_TABLE_ENV: Final = 'ENGINEERING_CONNECTIONS_TABLE'
#: voc-engineering-runtime's execution role and function names (engineering-reactions.ts): the one caller besides the
#: agents, for the reactions read alone (identity.py ``runtime_caller_from_event``). Unset: no runtime is admitted.
RUNTIME_ROLE_NAME_ENV: Final = 'ENGINEERING_RUNTIME_ROLE_NAME'
RUNTIME_FUNCTION_ENV: Final = 'ENGINEERING_RUNTIME_FUNCTION_NAME'
#: voc-engineering-start's execution role and function names (engineering-start.ts, 7.47.00): the ``head`` read alone.
#: Unset: no start is admitted.
START_ROLE_NAME_ENV: Final = 'ENGINEERING_START_ROLE_NAME'
START_FUNCTION_ENV: Final = 'ENGINEERING_START_FUNCTION_NAME'


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


#: A run id (a ULID), as the runtime's reactions read names the run it asks about.
_RUN_ID: Final = re.compile(r'[0-9A-HJKMNP-TV-Z]{26}')


def _reactions(broker: Broker, caller: Caller, args: Mapping[str, object]) -> dict[str, object]:
    """``{run_id}`` (the runtime's alone): ``{"reactions": <voc-reactions/1> | null}``, null when the run has no
    recorded pull request."""
    _keys(args, {'run_id'})
    run_id = _text(args, 'run_id', MAX_NAME)
    if not _RUN_ID.fullmatch(run_id):
        raise BadRequest('run_id is a run id (a ULID).')
    found = broker.reactions(caller, run_id)
    return {'reactions': None if found is None else found.view()}



def _head(broker: Broker, caller: Caller, args: Mapping[str, object]) -> dict[str, object]:
    """``{connection, repository, branch, issue?}`` (voc-engineering-start's alone): ``{"commit", "issue": {number,
    state} | null}``, the state null when the repository has no such issue."""
    _keys(args, {'connection', 'repository', 'branch'}, frozenset({'issue'}))
    connection = _text(args, 'connection', MAX_NAME)
    if not CONNECTION_ID.fullmatch(connection):
        raise BadRequest('connection is a connection id.')
    issue = args.get('issue')
    if issue is not None and (isinstance(issue, bool) or not isinstance(issue, int) or not 0 < issue < 2 ** 31):
        raise BadRequest('issue is a positive integer.')
    return broker.head(caller, connection, _text(args, 'repository', MAX_NAME), _text(args, 'branch', MAX_NAME),
                       issue if isinstance(issue, int) else None)


_OPERATIONS: Final[Mapping[str, Callable[[Broker, Caller, Mapping[str, object]], dict[str, object]]]] = {
    READ: _read,
    POST_COMMENT: _post_comment,
    PUSH_BUNDLE: _push_bundle,
    OPEN_OR_UPDATE_DRAFT_PR: _open_or_update_draft_pr,
    REACTIONS: _reactions,
    HEAD: _head,
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


def _caller(event: Mapping[str, object], role_name_pattern: str, account: str,
            runtime: tuple[str, str], start: tuple[str, str] = ('', '')) -> Caller | None:
    """An agent of a run, else voc-engineering-runtime (``runtime``: its role's and its function's names), else
    voc-engineering-start (``start``, the same), else None."""
    try:
        return caller_from_event(event, role_name_pattern, account)
    except UnknownCaller:
        pass
    try:
        return runtime_caller_from_event(event, runtime[0], runtime[1], account)
    except UnknownCaller:
        pass
    try:
        return runtime_caller_from_event(event, start[0], start[1], account, role=START_ROLE)
    except UnknownCaller:
        return None


def handle(event: Mapping[str, object], role_name_pattern: str, account: str, broker: Broker,
           runtime: tuple[str, str] = ('', ''), start: tuple[str, str] = ('', '')) -> dict[str, Any]:
    """The function URL's response to ``event``, for callers of ``account`` (the broker's own): an agent of a run,
    or voc-engineering-runtime (``runtime``: its execution role's name and its function's, which Lambda names its
    session after; ``('', '')``: none admitted), or voc-engineering-start (``start``, the same, 7.47.00)."""
    caller = _caller(event, role_name_pattern, account, runtime, start)
    if caller is None:
        logger.warning('broker call refused', extra={'status': 403})
        return _response(403, {'error': 'The caller is not an engineering agent.'})
    operation, response = _answer(event, caller, broker)
    logger.info('broker call', extra={'operation': operation, 'role': caller.role, 'run_id': caller.run_id,
                                      'agent': caller.agent_index, 'status': response['statusCode']})
    return response


def host_router(parameter_prefix: str) -> HostRouter:
    """Both host clients over the connections' SSM credentials under ``parameter_prefix``, each connection served by
    its own host's (the broker's, and the checkout cache's writer's)."""
    store = ParameterStoreCredentials(parameter_prefix)
    return HostRouter(store.stored, GitHubHost(store.get), GitLabHost(store.gitlab))


@lru_cache(maxsize=1)
def broker_for(parameter_prefix: str, table: str = '', bucket: str = '', aggregates: str = '',
               agents: str = '') -> Broker:
    """The container's broker (one, so its credentials and tokens stay warm): the GitHub client over the
    connections under ``parameter_prefix``, and the run's records, the patches and the dial in ``table``, ``bucket``
    and ``aggregates`` (``UNCONNECTED`` while any is unnamed), the CI attestations in ``agents`` (none attested while
    it is unnamed); no connector without a prefix."""
    if not parameter_prefix:
        return Broker(None)
    host = host_router(parameter_prefix)
    if not (table and bucket and aggregates):
        return Broker(Connector(host=host, bundles=UNCONNECTED, runs=UNCONNECTED, ledger=UNCONNECTED,
                                dial=UNCONNECTED, writes=UNCONNECTED))
    from shared.aws import get_dynamodb_client, get_dynamodb_resource, get_s3_client

    # No ListBucket on the broker's role: an object never written answers 403, read as missing (and counted).
    workspace = WorkspaceStore(get_s3_client(), bucket, denied_is_missing=True)
    records = RunRecords(get_dynamodb_client(), table, workspace, agents)
    return Broker(Connector(host=host, bundles=WorkspacePatches(workspace, host.file_at), runs=records,
                            ledger=records, dial=WaysOfWorking(get_dynamodb_resource().Table(aggregates)),
                            writes=WriteClaims(get_dynamodb_client(), table)))


@instrumented_handler   # (its metrics flush: the workspace store's count of denied reads taken as missing)
def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    account = own_account(getattr(context, 'invoked_function_arn', None))
    environ = os.environ
    # (the reads before a write end by Lambda's remaining time less what the write and its read-back need)
    ready = WRITE_READY_BY.set(remaining_until(context, time.time(), WRITE_RESERVE_SECONDS))
    try:
        return handle(event, environ.get(ROLE_NAME_PATTERN_ENV, ''), account,
                      broker_for(environ.get(PARAMETER_PREFIX_ENV, ''), environ.get(TABLE_ENV, ''),
                                 environ.get(BUCKET_ENV, ''), environ.get(AGGREGATES_ENV, ''),
                                 environ.get(CONNECTIONS_TABLE_ENV, '')),
                      (environ.get(RUNTIME_ROLE_NAME_ENV, ''), environ.get(RUNTIME_FUNCTION_ENV, '')),
                      (environ.get(START_ROLE_NAME_ENV, ''), environ.get(START_FUNCTION_ENV, '')))
    finally:
        WRITE_READY_BY.reset(ready)
