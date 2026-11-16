"""The Test button of the web search surface (Administration -> AI models, ``web_reviews_search``).

``POST /settings/model/test`` with one of the surface's OpenAI GPT models (shared/model_config.py
``WEB_SEARCH_MODELS``) sends ONE tiny Responses request to exactly that model on the ``bedrock-mantle``
endpoint of the app's region (shared/mantle_responses.py): ``"Reply with OK"``, at most 16 output tokens,
NO tool (so no web search is billed and none is granted), SigV4-signed with the settings Lambda's role
(``bedrock-mantle:CreateInference`` on the account's default project, lib/stacks/api-marketplace.ts
``grantWebSearchModelProbe``). Like the Claude test (shared/model_capacity.py ``probe_model``): no fallback,
no retry, an answer in the same shape and status vocabulary, and never the prompt or a credential in a log.

The status is read from the HTTP answer, since no Service Quotas reading is kept for these models:

* 200: ``available``;
* 401 / 403: ``no_access`` (the role, an SCP, or the model's agreement / Marketplace subscription);
* 429: ``no_capacity`` when the answer names capacity or a quota, else ``throttled``;
* 404, or an answer naming an unknown model or region: ``not_in_region``;
* 503 naming capacity or a quota: ``no_capacity``; another 5xx, or no answer within the budget: ``unavailable``;
* another 4xx naming model access, a use case, an agreement or a subscription: ``no_access``;
* anything else: ``error``.
"""
import re
import time
from http import HTTPStatus
from typing import Final

import boto3
from botocore.exceptions import BotoCoreError

from shared.logging import logger
from shared.mantle_responses import (
    CAPACITY_STATUSES,
    Post,
    ResponsesError,
    failure_reason,
    responses_url,
    signed_post,
    urlopen_post,
)
from shared.model_agreements import app_region
from shared.model_capacity import NO_ACCESS_RE, PROBE_PROMPT, ProbeResult, probe_result

#: The Responses API's smallest `max_output_tokens`.
PROBE_MAX_OUTPUT_TOKENS: Final = 16
#: Seconds the request may take: well inside the settings Lambda's 30 s.
PROBE_TIMEOUT_SECONDS: Final = 20
_CAPACITY_RE: Final = re.compile(r'capacity|quota')
_UNKNOWN_MODEL_RE: Final = re.compile(
    r'model (?:\S+ )?(?:not found|does not exist)|unknown model|not (?:supported|available) in (?:this|the) region',
)


def classify(error: ResponsesError) -> str:
    """The test status of a refused or unanswered request (the module docstring's table)."""
    status, text = error.status, str(error).lower()
    if status is None:
        return 'unavailable'
    if status in (HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN):
        return 'no_access'
    if status in CAPACITY_STATUSES and _CAPACITY_RE.search(text):
        return 'no_capacity'
    if status == HTTPStatus.TOO_MANY_REQUESTS:
        return 'throttled'
    if status == HTTPStatus.NOT_FOUND or _UNKNOWN_MODEL_RE.search(text):
        return 'not_in_region'
    if status >= HTTPStatus.INTERNAL_SERVER_ERROR:
        return 'unavailable'
    return 'no_access' if NO_ACCESS_RE.search(text) else 'error'


def probe_web_search_model(model_id: str, *, post: Post = urlopen_post) -> ProbeResult:
    """Send ONE minimal Responses request to exactly ``model_id`` and classify the outcome (no fallback, no retry)."""
    region = app_region()
    body = {'model': model_id, 'input': PROBE_PROMPT, 'max_output_tokens': PROBE_MAX_OUTPUT_TOKENS}
    started = time.monotonic()
    status, code = 'available', None
    try:
        signed_post(responses_url(region), body, region, boto3.Session().get_credentials(), post,
                    PROBE_TIMEOUT_SECONDS)
    except ResponsesError as error:
        status, code = classify(error), failure_reason(error)
    except BotoCoreError as error:  # no credentials to sign with
        status, code = 'error', type(error).__name__
    latency_ms = round((time.monotonic() - started) * 1000)
    logger.info('Web search model test finished', extra={'model_id': model_id, 'status': status,
                                                         'error_code': code, 'latency_ms': latency_ms})
    return probe_result(model_id, model_id, status, latency_ms=latency_ms if status == 'available' else None,
                        code=code, quota=None)
