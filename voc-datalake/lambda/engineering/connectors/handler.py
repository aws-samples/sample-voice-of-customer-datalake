"""The broker's Lambda function URL (IAM authentication; docs/autonomous-engineering.md, "Repository connectors").

POST ``{"operation": ..., "args": {...}}``; the caller comes from the request's IAM identity (``identity``), never
from the body. Status codes: 200 with ``{"result": ...}``; 400 a body the broker cannot read; 403 a caller that is
not an agent, or a role that may not make the operation; 409 a refusal for the run's or the board's state; 422 a
refusal by the write rules; 503 no repository connection. Every refusal carries ``{"error": <plain reason>}``.

Nothing from the body is logged or echoed (it may hold a bundle, a comment, or a token pasted by mistake): the log
line has the operation, the caller's role, run and agent index, and the status.
"""
from __future__ import annotations

import base64
import binascii
import json
import os
from collections.abc import Callable, Mapping
from typing import Any, Final

from engineering.connectors.broker import (
    OPEN_OR_UPDATE_DRAFT_PR,
    POST_COMMENT,
    PUSH_BUNDLE,
    READ,
    Broker,
    NotNow,
    NotPermitted,
)
from engineering.connectors.hosts import NO_CONNECTION, CommentTarget, NoConnection, ReadKind
from engineering.connectors.identity import Caller, UnknownCaller, caller_from_event, own_account
from engineering.connectors.write_policy import WriteRefused
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


class BadRequest(Exception):
    """The body is not a request the broker reads; the message says what is wrong, without echoing it."""


def _response(status: int, payload: Mapping[str, object]) -> dict[str, Any]:
    return {'statusCode': status, 'headers': {'Content-Type': 'application/json'}, 'body': json.dumps(payload)}


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


def _read(broker: Broker, caller: Caller, args: Mapping[str, object]) -> dict[str, object]:
    _keys(args, {'kind', 'target'}, frozenset({'cursor'}))
    cursor = _text(args, 'cursor', MAX_NAME) if 'cursor' in args else None
    page = broker.read(caller, _choice(args, 'kind', _READ_KINDS), _text(args, 'target', MAX_NAME), cursor)
    return {'content': page.content, 'next_cursor': page.next_cursor}


def _post_comment(broker: Broker, caller: Caller, args: Mapping[str, object]) -> dict[str, object]:
    _keys(args, {'on', 'number', 'body'})
    number = args['number']
    if isinstance(number, bool) or not isinstance(number, int) or number < 1:
        raise BadRequest('number is a positive integer.')
    url = broker.post_comment(caller, _choice(args, 'on', _COMMENT_TARGETS), number, _text(args, 'body', MAX_TEXT))
    return {'url': url}


def _push_bundle(broker: Broker, caller: Caller, args: Mapping[str, object]) -> dict[str, object]:
    _keys(args, {'branch', 'bundle'})
    try:
        bundle = base64.b64decode(_text(args, 'bundle', MAX_BODY_CHARS), validate=True)
    except binascii.Error:
        raise BadRequest('bundle is a base64 git bundle.') from None
    branch = _text(args, 'branch', MAX_NAME)
    return {'branch': branch, 'tree_hash': broker.push_bundle(caller, branch, bundle)}


def _open_or_update_draft_pr(broker: Broker, caller: Caller, args: Mapping[str, object]) -> dict[str, object]:
    _keys(args, {'branch', 'title', 'body'})
    ref = broker.open_or_update_draft_pr(caller, _text(args, 'branch', MAX_NAME), _text(args, 'title', MAX_NAME),
                                         _text(args, 'body', MAX_TEXT))
    return {'number': ref.number, 'url': ref.url}


_OPERATIONS: Final[Mapping[str, Callable[[Broker, Caller, Mapping[str, object]], dict[str, object]]]] = {
    READ: _read,
    POST_COMMENT: _post_comment,
    PUSH_BUNDLE: _push_bundle,
    OPEN_OR_UPDATE_DRAFT_PR: _open_or_update_draft_pr,
}


def _answer(event: Mapping[str, object], caller: Caller, broker: Broker) -> tuple[str | None, dict[str, Any]]:
    operation: str | None = None
    try:
        operation, args = _request(event)
        return operation, _response(200, {'result': _OPERATIONS[operation](broker, caller, args)})
    except BadRequest as exc:
        return operation, _response(400, {'error': str(exc)})
    except NoConnection:
        return operation, _response(503, {'error': NO_CONNECTION})
    except NotPermitted as exc:
        return operation, _response(403, {'error': exc.reason})
    except NotNow as exc:
        return operation, _response(409, {'error': exc.reason})
    except WriteRefused as exc:
        return operation, _response(422, {'error': exc.reason})


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


@instrumented_handler
def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    # No repository connection exists yet (the GitHub and GitLab clients are planned): every permitted, well-formed
    # operation answers 503.
    account = own_account(getattr(context, 'invoked_function_arn', None))
    return handle(event, os.environ.get(ROLE_NAME_PATTERN_ENV, ''), account, Broker(None))
