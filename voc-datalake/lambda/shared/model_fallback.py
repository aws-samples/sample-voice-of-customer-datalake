"""
Model capacity fallback for Bedrock text inference.

Bedrock can grant an account access to a model and still give it zero capacity
for that model, and a young account cannot ask for a quota increase yet. So a
model that is allowlisted, granted and agreed can still fail on every call. This
module decides when a failure means "this model cannot serve right now" (try the
next model of ``model_config.fallback_chain``) rather than "this request is
wrong" (fail: every model would reject it), remembers failed models for a short
per-container cooldown, and records each fallback (log + ``ModelFallback``
metric with Surface/From/To dimensions).

The streaming assistant mirrors this in lambda/stream/src/bedrock/model-fallback.ts;
test_model_fallback_lockstep.py pins the two to each other.
"""
import re
import time
from collections.abc import Callable, Iterable, Sequence

from aws_lambda_powertools.metrics import MetricUnit, single_metric
from botocore.exceptions import ClientError

from shared.logging import logger, metrics

MODEL_FALLBACK_METRIC = 'ModelFallback'

# How long a model that failed for capacity is skipped in this container. Long
# enough that a burst of requests pays the failed attempt (and its retry budget)
# once, short enough that recovered capacity is used again within minutes.
COOLDOWN_SECONDS = 300

# Codes that always mean the MODEL cannot serve now, whatever the message.
# ThrottlingException / ServiceUnavailableException only reach this check after
# the retry budget in shared.converse is spent (they arrive as the cause of a
# BedrockThrottlingError), and are listed for raw callers that raise them as-is.
CAPACITY_ERROR_CODES = frozenset({
    'ThrottlingException',
    'ServiceUnavailableException',
    'ModelNotReadyException',
    'ServiceQuotaExceededException',
    'ResourceNotFoundException',
})

# Codes that mean the model cannot serve ONLY when the message says so. Without a
# match an AccessDenied/Validation is the caller's problem (bad request shape,
# input too long) and must surface unchanged.
MESSAGE_GATED_CODES = frozenset({'AccessDeniedException', 'ValidationException'})

# Lower-cased message fragments that name model availability, not the input.
# Mirrored by MODEL_UNAVAILABLE_PATTERNS in the stream Lambda (lockstep).
MODEL_UNAVAILABLE_PATTERNS = (
    r'access to (?:the )?model',
    r'model (?:is )?not (?:available|enabled|accessible|ready)',
    r'not (?:available|enabled|accessible) for (?:this|your) account',
    r'on-demand throughput (?:is not|isn.t) supported',
    r'model identifier is invalid',
    r'end of (?:its )?life',
    r'not authorized to perform: bedrock:invoke',
)
_UNAVAILABLE_RE = re.compile('|'.join(MODEL_UNAVAILABLE_PATTERNS))

# Per-container cooldowns: model id -> epoch seconds until which it is tried
# last. Module-level on purpose (survives warm invocations); tests reset it.
cooldown_until: dict[str, float] = {}


def _client_error_of(error: BaseException) -> ClientError | None:
    """The ClientError behind *error*: itself, or its explicit cause (the
    BedrockThrottlingError raised once the retry budget is spent)."""
    if isinstance(error, ClientError):
        return error
    cause = error.__cause__
    return cause if isinstance(cause, ClientError) else None


def _code_of(client_error: ClientError) -> str:
    """The Bedrock error code of *client_error*, '' when the response has none."""
    return str(client_error.response.get('Error', {}).get('Code', ''))


def is_model_unavailable(error: BaseException) -> bool:
    """True when *error* means this model cannot serve now (try another model).

    False for anything the request itself caused — those fail on every model.
    """
    client_error = _client_error_of(error)
    if client_error is None:
        return False
    code = _code_of(client_error)
    if code in CAPACITY_ERROR_CODES:
        return True
    if code not in MESSAGE_GATED_CODES:
        return False
    message = str(client_error.response.get('Error', {}).get('Message')).lower()
    return _UNAVAILABLE_RE.search(message) is not None


def mark_unavailable(model_id: str, now: float | None = None) -> None:
    """Skip *model_id* in this container for COOLDOWN_SECONDS."""
    cooldown_until[model_id] = (time.time() if now is None else now) + COOLDOWN_SECONDS


def is_cooling_down(model_id: str, now: float | None = None) -> bool:
    """True while *model_id* is inside its cooldown window."""
    until = cooldown_until.get(model_id)
    return until is not None and (time.time() if now is None else now) < until


def order_for_attempt(chain: Iterable[str], now: float | None = None) -> list[str]:
    """*chain* with cooling-down models moved to the end (order otherwise kept).

    Cooling models are tried last rather than dropped, so a request never fails
    without attempting every model — capacity may have come back.
    """
    models = list(chain)
    ready = [m for m in models if not is_cooling_down(m, now)]
    cooling = [m for m in models if is_cooling_down(m, now)]
    return ready + cooling


def error_code(error: BaseException) -> str:
    """The Bedrock error code behind *error*, or its class name."""
    client_error = _client_error_of(error)
    if client_error is None:
        return type(error).__name__
    return _code_of(client_error) or type(error).__name__


def record_fallback(surface: str, from_model: str, to_model: str, reason: str) -> None:
    """Log and count one fallback. A metric failure never fails inference.

    *reason* is the Bedrock error code that failed ``from_model``, or 'cooldown'
    when it was skipped untried because it failed for capacity recently.
    """
    logger.warning(
        "[BEDROCK] Model cannot serve now; falling back",
        extra={'surface': surface, 'from_model': from_model, 'to_model': to_model,
               'reason': reason},
    )
    try:
        with single_metric(
            name=MODEL_FALLBACK_METRIC, unit=MetricUnit.Count, value=1,
            namespace=metrics.namespace or 'VoC',
        ) as metric:
            metric.add_dimension(name='Surface', value=surface)
            metric.add_dimension(name='From', value=from_model)
            metric.add_dimension(name='To', value=to_model)
    except Exception as metric_error:  # noqa: BLE001 - a metric must never fail inference
        logger.warning(f"[BEDROCK] Could not emit {MODEL_FALLBACK_METRIC}: {metric_error}")


def run_with_fallback[Result](
    chain: Sequence[str],
    surface: str,
    attempt: Callable[[str], Result],
) -> tuple[str, Result]:
    """Run ``attempt(model)`` down *chain* until one model serves.

    Cooling-down models go last (``order_for_attempt``). A model-unavailable
    failure puts that model in cooldown and moves on; any other failure is the
    request's own and propagates at once. When every model fails, the FIRST
    model's error is raised — it names the model the caller expected.

    Returns (the model that served, its result).
    """
    ordered = order_for_attempt(chain)
    if ordered and ordered[0] != chain[0]:
        record_fallback(surface, chain[0], ordered[0], 'cooldown')
    first_error = None
    for index, model in enumerate(ordered):
        try:
            return model, attempt(model)
        except Exception as error:
            if not is_model_unavailable(error):
                raise
            mark_unavailable(model)
            first_error = first_error or error
            if index + 1 < len(ordered):
                record_fallback(surface, model, ordered[index + 1], error_code(error))
    if first_error is None:
        raise ValueError('run_with_fallback needs at least one model')
    raise first_error
