"""One ``bedrock_usage`` log line per successful Converse or InvokeModel call, and the workspace it is counted to.

docs/multi-workspace.md, "Cost per workspace" (decision 9, slice A). shared/model_config.py ``scope_bedrock_client``
registers ``log_usage`` as a botocore ``after-call`` hook on the ``bedrock-runtime`` clients it scopes (shared/aws.py
``get_bedrock_client`` and the capacity probe's, shared/model_capacity.py), and its ``provide-client-params`` hook
calls ``remember_request`` with the model id and the tier as sent. The line has numbers and ids only
(``USAGE_FIELDS``), never a prompt, a response or anything a person typed:

    workspace_id         the workspace the call is counted to, ``DEPLOYMENT`` or ``UNATTRIBUTED``
    model_id             the model id as sent (after the inference scope: ``eu.…`` in an EU deployment)
    operation            Converse or InvokeModel
    service_tier         the tier Bedrock answered with, else the one asked for, else ``default``
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens

Converse reads the response's ``usage``; InvokeModel the ``x-amzn-bedrock-*-token-count`` headers. A response that
cannot be read logs ``bedrock_usage_unreadable`` with the operation and the reason; logging never raises into the
caller. Not metered here: ConverseStream (no Python code streams; the streaming assistant is the TypeScript stream
Lambda) and the image clients of shared/avatar.py and shared/image_model_status.py (an image is priced per image, a
follow-up).

ATTRIBUTION. The call's workspace is this context's ``attribute`` value, set only where a workspace resolves:
shared/workspace.py ``resolve_workspace``, shared/ws_repo.py ``message_scope`` and shared/request_workspace.py
``request_workspace`` (shared/test/test_usage_meter.py pins those call sites). ``reset`` runs at each invocation
(shared/invocation_cost.py ``measure_invocation_cost``), so a warm container never carries the last request's
workspace into the next one, and shared/concurrency.py runs each task in a copy of its caller's context. A raw thread
pool's tasks never attribute (pinned by the test above), so their calls stay ``UNATTRIBUTED``, never a wrong
workspace.
"""
from __future__ import annotations

from collections.abc import Mapping, MutableMapping
from contextvars import ContextVar
from typing import Any, Final

from shared.logging import logger
from shared.workspace_ids import is_workspace_id

#: A call made on the deployment's own behalf (a request or message that names no workspace).
DEPLOYMENT: Final = 'DEPLOYMENT'
#: A call no handler attributed (the default until each area's handler calls ``attribute``).
UNATTRIBUTED: Final = 'UNATTRIBUTED'
USAGE_LINE: Final = 'bedrock_usage'
UNREADABLE_LINE: Final = 'bedrock_usage_unreadable'
#: The line's fields, in order. The product-document extractor's stdlib mirror is pinned to them
#: (product_doc_extractor/test/test_usage_lockstep.py).
USAGE_FIELDS: Final = (
    'workspace_id', 'model_id', 'operation', 'service_tier',
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
)
DEFAULT_TIER: Final = 'default'

#: Where ``remember_request`` leaves the request's model id and tier in botocore's per-call request context.
_MODEL_KEY: Final = 'voc_usage_model_id'
_TIER_KEY: Final = 'voc_usage_service_tier'
_CONVERSE: Final = 'Converse'
_INVOKE_MODEL: Final = 'InvokeModel'
_METERED: Final = frozenset({_CONVERSE, _INVOKE_MODEL})
#: Converse's ``usage`` keys, by line field.
_USAGE_KEYS: Final = (('input_tokens', 'inputTokens'), ('output_tokens', 'outputTokens'),
                      ('cache_read_tokens', 'cacheReadInputTokens'),
                      ('cache_write_tokens', 'cacheWriteInputTokens'))
#: InvokeModel's token headers, by line field (botocore keeps header names lower-cased and case-insensitive).
_HEADER_KEYS: Final = (('input_tokens', 'x-amzn-bedrock-input-token-count'),
                       ('output_tokens', 'x-amzn-bedrock-output-token-count'),
                       ('cache_read_tokens', 'x-amzn-bedrock-cache-read-input-token-count'),
                       ('cache_write_tokens', 'x-amzn-bedrock-cache-write-input-token-count'))

_attribution: ContextVar[str] = ContextVar(
    'voc_usage_attribution',  # pragma: no mutate  the name only labels the variable in its repr
    default=UNATTRIBUTED,
)


class UnreadableUsage(ValueError):
    """A response whose usage cannot be read (its reason goes on the unreadable line)."""


def reset() -> None:
    """A new invocation: nothing is attributed yet."""
    _attribution.set(UNATTRIBUTED)


def attribute(workspace: str | None) -> None:
    """Count this context's Bedrock calls to ``workspace``; ``None`` is the deployment (``DEPLOYMENT``).

    ``UNATTRIBUTED``, or any other value that is not a workspace id, counts as UNATTRIBUTED, never as a guessed
    workspace.
    """
    _attribution.set(DEPLOYMENT if workspace is None else workspace if is_workspace_id(workspace) else UNATTRIBUTED)


def current_attribution() -> str:
    """The workspace id, DEPLOYMENT or UNATTRIBUTED this context's calls are counted to now."""
    return _attribution.get()


def remember_request(params: Mapping[str, Any], context: object) -> None:
    """From the ``provide-client-params`` hook: the model id and tier as sent, kept in botocore's request context."""
    if not isinstance(context, MutableMapping):
        return
    model_id = params.get('modelId')
    if isinstance(model_id, str):
        context[_MODEL_KEY] = model_id
    tier = params.get('serviceTier')
    tier = tier.get('type') if isinstance(tier, Mapping) else tier
    if isinstance(tier, str):
        context[_TIER_KEY] = tier


def log_usage(http_response: Any = None, parsed: Any = None, model: Any = None, context: Any = None,
              **_kwargs: object) -> None:
    """botocore ``after-call.bedrock-runtime`` hook: the usage line of a successful metered call. Never raises."""
    operation = str(getattr(model, 'name', ''))
    if operation not in _METERED or not _succeeded(http_response):
        return
    try:
        base = _base_fields(operation, context)
        if operation == _CONVERSE:
            _emit(base, _tier_of(parsed), _converse_tokens(_mapping(parsed).get('usage')))
        else:
            _emit(base, _mapping(parsed).get('serviceTier'), _header_tokens(getattr(http_response, 'headers', None)))
    except Exception as error:  # noqa: BLE001 - counting a call must never fail the call
        _unreadable(operation, error)


def _succeeded(http_response: object) -> bool:
    status = getattr(http_response, 'status_code', None)
    return isinstance(status, int) and 200 <= status < 300


def _mapping(value: object) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise UnreadableUsage('response is not a mapping')
    return value


def _base_fields(operation: str, context: object) -> dict[str, Any]:
    request = context if isinstance(context, Mapping) else {}
    model_id = request.get(_MODEL_KEY)
    if not isinstance(model_id, str) or not model_id:
        raise UnreadableUsage('no model id was recorded for the call')
    requested = request.get(_TIER_KEY)
    return {'workspace_id': current_attribution(), 'model_id': model_id, 'operation': operation,
            'service_tier': requested if isinstance(requested, str) and requested else DEFAULT_TIER}


def _tier_of(parsed: object) -> object:
    tier = _mapping(parsed).get('serviceTier')
    return tier.get('type') if isinstance(tier, Mapping) else None


def _count(value: object) -> int:
    """A token count: a non-negative int (a header's digits included); anything else is unreadable."""
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    raise UnreadableUsage('a token count is not a non-negative integer')


def _converse_tokens(usage: object) -> dict[str, int]:
    """Converse's ``usage``: input and output required, the cache counts 0 when absent."""
    fields = _mapping(usage)
    if 'inputTokens' not in fields or 'outputTokens' not in fields:
        raise UnreadableUsage('usage has no input or output count')
    return {name: _count(fields.get(key, 0)) for name, key in _USAGE_KEYS}


def _header_tokens(headers: object) -> dict[str, int]:
    """InvokeModel's token headers: the input count required, the others 0 when absent (an embedding has none).

    ``headers`` is urllib3's case-insensitive dict (or botocore's ``HTTPHeaders``, not a ``Mapping``): read by ``get``.
    """
    fields: Any = headers
    if not callable(getattr(fields, 'get', None)) or fields.get(_HEADER_KEYS[0][1]) is None:
        raise UnreadableUsage('no input token count header')
    return {name: _count(fields.get(key, 0)) for name, key in _HEADER_KEYS}


def _emit(base: Mapping[str, Any], answered_tier: object, tokens: Mapping[str, int]) -> None:
    line = {**base, **tokens}
    if isinstance(answered_tier, str) and answered_tier:
        line['service_tier'] = answered_tier
    logger.info(USAGE_LINE, extra={field: line[field] for field in USAGE_FIELDS})


def _unreadable(operation: str, error: BaseException) -> None:
    """The operation and the error's kind only: a parse error's text could quote the response."""
    reason = str(error) if isinstance(error, UnreadableUsage) else type(error).__name__
    logger.warning(UNREADABLE_LINE, extra={'operation': operation, 'reason': reason})
