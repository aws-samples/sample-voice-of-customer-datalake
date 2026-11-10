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
  model's inference profile in Service Quotas (cached per container, stored in the
  aggregates table: shared/model_quota_store.py). A stored reading that is out of date
  answers at once, marked ``stale``, while the settings worker twin
  (``ASSIST_WORKER_FUNCTION``) re-reads Service Quotas (``REFRESH_ACTION``). A
  subscribed model can still have a quota of 0; then the only action is to wait,
  which is why a throttle on a zero quota is reported as ``no_capacity``.

Neither function ever logs the prompt or any credential, and neither returns
raw AWS error text to the caller beyond the error code.
"""
import os
import re
import time
from typing import Any, Final, NamedTuple, NotRequired, TypedDict

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError, ConnectTimeoutError, ReadTimeoutError

from shared import model_quota_store
from shared.aws import invoke_lambda_async
from shared.converse import build_single_turn_request
from shared.logging import logger
from shared.model_config import ALLOWED_MODELS, invocation_model_id, scope_bedrock_client
from shared.timestamps import now_iso

PROBE_PROMPT: Final = "Reply with OK"
PROBE_MAX_TOKENS: Final = 16

# Service Quotas listing cache (one listing serves every model).
QUOTA_CACHE_TTL_SECONDS: Final = 600
# A failed listing is retried sooner, so a transient error does not hide quotas for 10 minutes.
QUOTA_ERROR_CACHE_TTL_SECONDS: Final = 60
SERVICE_QUOTAS_SERVICE_CODE: Final = "bedrock"
# The async event the settings worker twin answers by re-reading Service Quotas into the stored row.
REFRESH_ACTION: Final = "model_quota_refresh"

_GLOBAL_QUOTA_PREFIX: Final = "Global cross-region model inference tokens per minute for Anthropic "
_GEO_QUOTA_PREFIX: Final = "Cross-region model inference tokens per minute for Anthropic "

# Service Quotas throttles per account (TooManyRequestsException under parallel load, 5.35
# live): adaptive retries add client-side rate limiting shared by the refresh threads. Three
# attempts keep a throttled listing well inside the settings Lambda's 30 s.
_SERVICE_QUOTAS_CLIENT_CONFIG: Final = Config(
    connect_timeout=5, read_timeout=10, retries={"max_attempts": 3, "mode": "adaptive"},
)

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
    # True when Service Quotas could not be read and this is the last stored reading.
    stale: NotRequired[bool]


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


class _QuotaCache:
    """The last Service Quotas listing (None = unreadable) and when it goes stale.

    ``values`` is written by every refresh and read only before ``expires``, so a
    fresh or cleared cache (``expires`` 0.0, always past) never reads it.
    """
    values: dict[str, float] | None
    stale: bool = False
    expires: float = 0.0


# Per-container caches. Module-level on purpose (survive warm invocations); tests reset them.
_quota_cache = _QuotaCache()
# boto3 clients are untyped at runtime (no stubs in the layer), hence Any.
_clients: dict[str, Any] = {}


def clear_quota_cache() -> None:
    """Forget the cached Service Quotas listing (tests; a fresh container starts empty)."""
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
        client = boto3.client("service-quotas", config=_SERVICE_QUOTAS_CLIENT_CONFIG)
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


#: ListServiceQuotas answers at most this many per page (the default pages a handful at a time).
LISTING_PAGE_SIZE: Final = 100


def _list_bedrock_quotas() -> tuple[dict[str, float], dict[str, str]]:
    """The Anthropic token quotas of this account and region: name -> applied value, name -> quota code."""
    values: dict[str, float] = {}
    codes: dict[str, str] = {}
    paginator = _service_quotas_client().get_paginator("list_service_quotas")
    pages = paginator.paginate(ServiceCode=SERVICE_QUOTAS_SERVICE_CODE, PaginationConfig={"PageSize": LISTING_PAGE_SIZE})
    for page in pages:
        for quota in page.get("Quotas", []):
            name, value, code = quota.get("QuotaName"), quota.get("Value"), quota.get("QuotaCode")
            if not isinstance(name, str) or not isinstance(value, int | float):
                continue
            if not name.startswith((_GLOBAL_QUOTA_PREFIX, _GEO_QUOTA_PREFIX)):
                continue
            values[name] = float(value)
            if isinstance(code, str):
                codes[name] = code
    return values, codes


def _expected_names() -> list[str]:
    """The quota name of every allowlisted model under the scope in force."""
    return [name for m in ALLOWED_MODELS if (name := quota_name(m["id"])) is not None]


class _Reading(NamedTuple):
    """Quota name -> applied value, and whether it is a stored reading served because Service Quotas failed."""
    values: dict[str, float]
    stale: bool = False


def _stale(stored: model_quota_store.StoredQuotas, error: ClientError | BotoCoreError) -> _Reading:
    logger.warning("Service Quotas unreadable; serving the stored quotas as stale",
                   extra={"error_code": model_quota_store.error_code(error), "fetched_at": stored.fetched_at})
    return _Reading(stored.values, stale=True)


def _refresh(stored: model_quota_store.StoredQuotas | None, expected: list[str]) -> _Reading:
    """Re-read Service Quotas into the row: by code when the row covers ``expected``, else the full listing.

    When Service Quotas fails (a throttle above all) and a row is stored, that row answers, stale."""
    if stored is not None and stored.answers(expected):
        try:
            refreshed = model_quota_store.refresh_by_code(_service_quotas_client(), stored.codes)
        except (ClientError, BotoCoreError) as error:  # only a throttle is re-raised
            return _stale(stored, error)
        if refreshed is not None:
            model_quota_store.save(model_quota_store.stored_now(refreshed, stored.codes, expected))
            return _Reading(refreshed)
    try:
        values, codes = _list_bedrock_quotas()
    except (ClientError, BotoCoreError) as error:
        if stored is None:
            raise
        return _stale(stored, error)
    model_quota_store.save(model_quota_store.stored_now(values, codes, expected))
    return _Reading(values)


def _refresh_in_background() -> bool:
    """Hand the refresh to the settings worker twin; False when there is none (then the caller reads inline).

    True also when another request started it moments ago, or the invoke failed: the request
    answers with the stored row either way, and the next one after REFRESH_CLAIM_SECONDS tries again."""
    worker = os.environ.get("ASSIST_WORKER_FUNCTION", "")
    if not worker:
        return False
    if not model_quota_store.claim_refresh(time.time()):
        return True
    try:
        invoke_lambda_async(worker, {"action": REFRESH_ACTION})
    except (ClientError, BotoCoreError) as error:
        logger.warning("Quota refresh not started; serving the stored quotas",
                       extra={"error_code": model_quota_store.error_code(error)})
    return True


def _quotas_from_store_or_service() -> _Reading:
    """The stored row: as is when fresh, else marked stale while a worker refreshes it.

    Service Quotas is read on the request path only when nothing is stored (a deployment's
    first reading) or no worker is configured (local runs)."""
    expected = _expected_names()
    stored = model_quota_store.load()
    if stored is not None and stored.answers(expected) and stored.is_fresh(time.time()):
        return _Reading(stored.values)
    if stored is not None and _refresh_in_background():
        return _Reading(stored.values, stale=True)
    return _refresh(stored, expected)


def run_refresh_event() -> dict[str, bool]:
    """The worker side of ``REFRESH_ACTION``: re-read the quotas into the stored row (best effort)."""
    try:
        reading = _refresh(model_quota_store.load(), _expected_names())
    except (ClientError, BotoCoreError) as error:
        logger.warning("Quota refresh failed", extra={"error_code": model_quota_store.error_code(error)})
        return {"refreshed": False}
    return {"refreshed": not reading.stale}


def _cached_quotas() -> _Reading | None:
    """The cached quotas (refreshed after the TTL), or None when they cannot be read.

    A stale reading is kept only for the short error TTL, so the next request tries again."""
    now = time.time()
    if now < _quota_cache.expires:
        return None if _quota_cache.values is None else _Reading(_quota_cache.values, _quota_cache.stale)
    reading: _Reading | None
    try:
        reading = _quotas_from_store_or_service()
        ttl = QUOTA_ERROR_CACHE_TTL_SECONDS if reading.stale else QUOTA_CACHE_TTL_SECONDS
    except (ClientError, BotoCoreError) as error:
        logger.warning("Service Quotas listing failed; quota unknown",
                       extra={"error_code": model_quota_store.error_code(error)})
        reading = None
        ttl = QUOTA_ERROR_CACHE_TTL_SECONDS
    _quota_cache.values = None if reading is None else reading.values
    _quota_cache.stale = reading is not None and reading.stale
    _quota_cache.expires = now + ttl
    return reading


def _matching_name(expected: str, quotas: dict[str, Any]) -> str | None:
    """The key of ``quotas`` named ``expected`` (case-insensitive; an AWS version suffix such as ' V1' allowed)."""
    pattern = re.compile(rf"^{re.escape(expected)}(?: v\d+(?:\.\d+)?)?\Z", re.IGNORECASE)
    return next((name for name in quotas if pattern.match(name)), None)


def _match_quota(expected: str, quotas: dict[str, float], *, stale: bool = False) -> Quota | None:
    """The quota named ``expected`` (see ``_matching_name``), or None; ``stale`` is set only when True."""
    name = _matching_name(expected, quotas)
    if name is None:
        return None
    quota: Quota = {"name": name, "tokens_per_minute": int(quotas[name])}
    if stale:
        quota["stale"] = True
    return quota


def lookup_quota(model_id: str) -> Quota | None:
    """The tokens-per-minute quota for ``model_id``'s profile, or None (unknown). Never raises."""
    expected = quota_name(model_id)
    if expected is None:
        return None
    try:
        reading = _cached_quotas()
    except Exception:  # a quota lookup must never fail the model test
        logger.exception("Unexpected Service Quotas failure; quota unknown")
        return None
    return _match_quota(expected, reading.values, stale=reading.stale) if reading is not None else None


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
        "checked_at": now_iso(),
    }


class _Outcome(NamedTuple):
    """A probe's final status and the error code behind it (None when the model answered)."""
    status: str
    code: str | None


def _invoke_once(kwargs: dict) -> _Outcome | ClientError:
    """Send the probe request once. A ClientError is returned as is, for _classify."""
    try:
        _bedrock_probe_client().converse(**kwargs)
    except ClientError as error:
        return error
    except (ReadTimeoutError, ConnectTimeoutError) as error:
        return _Outcome("unavailable", type(error).__name__)
    except BotoCoreError as error:
        return _Outcome("error", type(error).__name__)
    return _Outcome("available", None)


def _classify(outcome: _Outcome | ClientError, quota: Quota | None) -> _Outcome:
    """The final outcome: a ClientError classified by its code (and, for the gated codes, message)."""
    if isinstance(outcome, _Outcome):
        return outcome
    err = outcome.response.get("Error", {})
    code = str(err.get("Code", "")) or "ClientError"
    message = str(err.get("Message", ""))  # pragma: no mutate  a missing Message read as "XXXX" matches no pattern either
    return _Outcome(classify_client_error(code, message, quota), code)


def probe_model(model_id: str) -> ProbeResult:
    """Send ONE minimal request to exactly ``model_id`` (allowlisted) and classify the outcome.

    No fallback, no retry. The quota is looked up for every result (cached), and
    decides between ``no_capacity`` (quota 0: wait) and ``throttled`` (retry later).
    """
    kwargs = build_single_turn_request(model_id, prompt=PROBE_PROMPT, max_tokens=PROBE_MAX_TOKENS)
    invoked_id = str(kwargs["modelId"])
    started = time.monotonic()
    response = _invoke_once(kwargs)
    latency_ms = round((time.monotonic() - started) * 1000)
    quota = lookup_quota(model_id)
    status, code = _classify(response, quota)
    logger.info(
        "Model test finished",
        extra={"model_id": model_id, "invoked_id": invoked_id, "status": status,
               "error_code": code, "latency_ms": latency_ms},
    )
    return _result(
        model_id, invoked_id, status,
        latency_ms=latency_ms if status == "available" else None,
        code=code, quota=quota,
    )

