"""
Model access and capacity checks for the Settings model picker.

Two read-mostly helpers behind ``POST /settings/model/test`` and
``GET /settings/model/capacity`` (settings_handler.py):

- ``probe_model(model_id)`` sends ONE minimal Converse request to exactly that
  allowlisted model — shaped by shared.converse.build_single_turn_request, the
  same per-model rules converse() applies, under the deployment's inference
  scope — and classifies the outcome. There is deliberately NO fallback chain
  and no retry: testing model X must never be answered by model Y, and a
  throttle is a result to report, not something to wait out.
- ``lookup_quota(model_id)`` finds the account's tokens-per-minute quota for the
  model's inference profile in Service Quotas (cached per container). A
  subscribed model can still have a quota of 0; then the only action is to wait,
  which is why a throttle on a zero quota is reported as ``no_capacity``.

Neither function ever logs the prompt or any credential, and neither returns
raw AWS error text to the caller beyond the error code.
"""
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final, TypedDict

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError, ConnectTimeoutError, ReadTimeoutError

from shared.converse import build_single_turn_request
from shared.logging import logger
from shared.model_config import ALLOWED_MODELS, invocation_model_id, scope_bedrock_client

PROBE_PROMPT: Final = "Reply with OK"
PROBE_MAX_TOKENS: Final = 16

# Service Quotas listing cache (one listing serves every model).
QUOTA_CACHE_TTL_SECONDS: Final = 600
# A failed listing is retried sooner, so a transient error does not hide quotas for 10 minutes.
QUOTA_ERROR_CACHE_TTL_SECONDS: Final = 60
SERVICE_QUOTAS_SERVICE_CODE: Final = "bedrock"

_GLOBAL_QUOTA_PREFIX: Final = "Global cross-region model inference tokens per minute for Anthropic "
_GEO_QUOTA_PREFIX: Final = "Cross-region model inference tokens per minute for Anthropic "

# The probe must answer well inside the settings Lambda's 30 s timeout, and a
# botocore retry would turn a throttle into a slow "available".
_PROBE_CLIENT_CONFIG: Final = Config(
    connect_timeout=5, read_timeout=20, retries={"max_attempts": 1, "mode": "standard"},
)

# Client-safe text per status. The SPA translates by status; this is for API callers.
STATUS_MESSAGES: Final = {
    "available": "The model answered.",
    "no_access": "This account has no access to the model (model access, use case or agreement).",
    "not_in_region": "The model or its inference profile is not offered in this region.",
    "no_capacity": "The token quota for this model is 0 in this account; nothing to do but wait.",
    "throttled": "The model is throttling requests right now; retry later.",
    "not_ready": "The model is not ready yet; retry in a few minutes.",
    "unavailable": "The model is temporarily unavailable; retry later.",
    "error": "The test request failed.",
}

_THROTTLE_CODES: Final = frozenset({
    "ThrottlingException", "ServiceQuotaExceededException", "TooManyRequestsException",
})
_UNAVAILABLE_CODES: Final = frozenset({"ServiceUnavailableException", "ModelTimeoutException"})
# A ValidationException naming model access / use case / agreement means no access.
_NO_ACCESS_RE: Final = re.compile(
    r"access to (?:the )?model|use case|agreement|not (?:enabled|authorized|subscribed)|subscription",
)
# A ValidationException naming an unknown model id or inference profile means not offered here.
_UNKNOWN_MODEL_RE: Final = re.compile(
    r"model identifier is invalid|inference profile|not (?:supported|available) in (?:this|the) region",
)


class Quota(TypedDict):
    name: str
    tokens_per_minute: int


class ProbeResult(TypedDict):
    model_id: str
    invoked_id: str
    status: str
    ok: bool
    latency_ms: int | None
    message: str
    quota: Quota | None
    checked_at: str


class ModelCapacity(TypedDict):
    model_id: str
    label: str
    quota: Quota | None


@dataclass
class _QuotaCache:
    """The last Service Quotas listing (None = unreadable) and when it goes stale."""
    values: dict[str, float] | None = None
    expires: float = 0.0


# Per-container caches. Module-level on purpose (survive warm invocations); tests reset them.
_quota_cache = _QuotaCache()
# boto3 clients are untyped at runtime (no stubs in the layer), hence Any.
_clients: dict[str, Any] = {}


def clear_quota_cache() -> None:
    """Forget the cached Service Quotas listing (tests; a fresh container starts empty)."""
    _quota_cache.values = None
    _quota_cache.expires = 0.0


def _bedrock_probe_client():
    client = _clients.get("bedrock-runtime")
    if client is None:
        client = scope_bedrock_client(boto3.client("bedrock-runtime", config=_PROBE_CLIENT_CONFIG))
        _clients["bedrock-runtime"] = client
    return client


def _service_quotas_client():
    client = _clients.get("service-quotas")
    if client is None:
        client = boto3.client("service-quotas")
        _clients["service-quotas"] = client
    return client


def _model_label(model_id: str) -> str | None:
    return next((m["label"] for m in ALLOWED_MODELS if m["id"] == model_id), None)


def quota_name(model_id: str) -> str | None:
    """The Service Quotas name of ``model_id``'s tokens-per-minute quota under the scope in force.

    ``global.`` profiles use the global cross-region quota; a geo profile
    (``eu.``, ``us.``) the cross-region one. None for a model outside the allowlist.
    """
    label = _model_label(model_id)
    if label is None:
        return None
    prefix = _GLOBAL_QUOTA_PREFIX if invocation_model_id(model_id).startswith("global.") else _GEO_QUOTA_PREFIX
    return prefix + label


def _list_bedrock_quotas() -> dict[str, float]:
    """Every Bedrock quota of this account and region, name -> applied value."""
    values: dict[str, float] = {}
    paginator = _service_quotas_client().get_paginator("list_service_quotas")
    for page in paginator.paginate(ServiceCode=SERVICE_QUOTAS_SERVICE_CODE):
        for quota in page.get("Quotas", []):
            name, value = quota.get("QuotaName"), quota.get("Value")
            if isinstance(name, str) and isinstance(value, int | float):
                values[name] = float(value)
    return values


def _cached_quotas() -> dict[str, float] | None:
    """The cached listing (refreshed after the TTL), or None when it cannot be read."""
    now = time.time()
    if now < _quota_cache.expires:
        return _quota_cache.values
    values: dict[str, float] | None
    try:
        values = _list_bedrock_quotas()
        ttl = QUOTA_CACHE_TTL_SECONDS
    except (ClientError, BotoCoreError) as error:
        code = error.response.get("Error", {}).get("Code") if isinstance(error, ClientError) else type(error).__name__
        logger.warning("Service Quotas listing failed; quota unknown", extra={"error_code": code})
        values = None
        ttl = QUOTA_ERROR_CACHE_TTL_SECONDS
    _quota_cache.values = values
    _quota_cache.expires = now + ttl
    return values


def _match_quota(expected: str, quotas: dict[str, float]) -> Quota | None:
    """The quota named ``expected`` (case-insensitive; an AWS version suffix such as ' V1' allowed)."""
    pattern = re.compile(rf"^{re.escape(expected)}(?: v\d+(?:\.\d+)?)?$", re.IGNORECASE)
    for name, value in quotas.items():
        if pattern.match(name):
            return {"name": name, "tokens_per_minute": int(value)}
    return None


def lookup_quota(model_id: str) -> Quota | None:
    """The tokens-per-minute quota for ``model_id``'s profile, or None (unknown). Never raises."""
    expected = quota_name(model_id)
    if expected is None:
        return None
    try:
        quotas = _cached_quotas()
    except Exception:  # a quota lookup must never fail the model test
        logger.exception("Unexpected Service Quotas failure; quota unknown")
        return None
    return _match_quota(expected, quotas) if quotas else None


def capacity_overview() -> list[ModelCapacity]:
    """Every allowlisted model with its quota (no invocation)."""
    return [
        {"model_id": m["id"], "label": m["label"], "quota": lookup_quota(m["id"])}
        for m in ALLOWED_MODELS
    ]


def classify_client_error(code: str, message: str, quota: Quota | None) -> str:
    """The probe status for a Bedrock ClientError ``code`` (message only read for the gated codes)."""
    lowered = message.lower()
    if code == "AccessDeniedException":
        return "no_access"
    if code == "ResourceNotFoundException":
        return "not_in_region"
    if code in _THROTTLE_CODES:
        return "no_capacity" if quota is not None and quota["tokens_per_minute"] == 0 else "throttled"
    if code == "ModelNotReadyException":
        return "not_ready"
    if code in _UNAVAILABLE_CODES:
        return "unavailable"
    if code == "ValidationException" and _NO_ACCESS_RE.search(lowered):
        return "no_access"
    if code == "ValidationException" and _UNKNOWN_MODEL_RE.search(lowered):
        return "not_in_region"
    return "error"


def _result(model_id: str, invoked_id: str, status: str, *, latency_ms: int | None,
            code: str | None, quota: Quota | None) -> ProbeResult:
    message = STATUS_MESSAGES[status]
    return {
        "model_id": model_id,
        "invoked_id": invoked_id,
        "status": status,
        "ok": status == "available",
        "latency_ms": latency_ms,
        "message": f"{message} ({code})" if code else message,
        "quota": quota,
        "checked_at": datetime.now(UTC).isoformat(),
    }


@dataclass(frozen=True)
class _Outcome:
    """What one probe request came back with: a final status, or a ClientError to classify."""
    status: str | None
    code: str | None = None
    message: str = ""


def _invoke_once(kwargs: dict) -> _Outcome:
    """Send the probe request once. A ClientError is returned (status None) for classification."""
    try:
        _bedrock_probe_client().converse(**kwargs)
    except ClientError as error:
        err = error.response.get("Error", {})
        return _Outcome(None, str(err.get("Code", "")) or "ClientError", str(err.get("Message", "")))
    except (ReadTimeoutError, ConnectTimeoutError) as error:
        return _Outcome("unavailable", type(error).__name__)
    except BotoCoreError as error:
        return _Outcome("error", type(error).__name__)
    return _Outcome("available")


def probe_model(model_id: str) -> ProbeResult:
    """Send ONE minimal request to exactly ``model_id`` (allowlisted) and classify the outcome.

    No fallback, no retry. The quota is looked up for every result (cached), and
    decides between ``no_capacity`` (quota 0: wait) and ``throttled`` (retry later).
    """
    kwargs = build_single_turn_request(model_id, prompt=PROBE_PROMPT, max_tokens=PROBE_MAX_TOKENS)
    invoked_id = str(kwargs["modelId"])
    started = time.monotonic()
    outcome = _invoke_once(kwargs)
    latency_ms = round((time.monotonic() - started) * 1000)
    quota = lookup_quota(model_id)
    status = outcome.status or classify_client_error(outcome.code or "", outcome.message, quota)
    logger.info(
        "Model test finished",
        extra={"model_id": model_id, "invoked_id": invoked_id, "status": status,
               "error_code": outcome.code, "latency_ms": latency_ms},
    )
    return _result(
        model_id, invoked_id, status,
        latency_ms=latency_ms if status == "available" else None,
        code=outcome.code, quota=quota,
    )

