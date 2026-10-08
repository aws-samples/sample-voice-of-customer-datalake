"""
Bedrock Converse API utilities for VoC Lambda functions.
Provides a unified interface for LLM interactions with optional tool use.
"""

import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, overload

from aws_lambda_powertools.metrics import MetricUnit, single_metric
from botocore.exceptions import ClientError, ReadTimeoutError

from shared.aws import get_bedrock_client
from shared.logging import logger, metrics
from shared.model_config import (
    DEFAULT_SURFACE,
    SERVICE_TIERS,
    fallback_chain,
    get_active_model_id,
    invocation_model_id,
    omits_temperature,
    supports_flex,
    surface_service_tier,
    uses_adaptive_thinking,
)
from shared.model_fallback import run_with_fallback

# Retry configuration
DEFAULT_MAX_RETRIES = 5
DEFAULT_BASE_DELAY = 1.0  # seconds
DEFAULT_MAX_DELAY = 30.0  # seconds
# converse()'s temperature when the caller passes none (dropped per model, see _build_request).
DEFAULT_TEMPERATURE = 0.1
_JITTER_RNG = secrets.SystemRandom()

# Auto-continuation: when the model stops because it hit the maxTokens ceiling,
# the output is truncated mid-document. We transparently resume the generation up
# to this many times, concatenating the chunks, so callers never persist a
# half-written PRD/PR-FAQ/report (the document-cutoff bug).
#
# Tuning note: keep per-call max_tokens MODEST (≈6-8K) rather than huge. A single
# huge maxTokens (e.g. 24K) makes one Bedrock call run many minutes for slow CJK
# output and can blow the Lambda timeout on its own; many small calls each finish
# in ~1-2 min and resume cleanly. This ceiling must therefore be generous enough
# to assemble a long document from those small chunks (8 x ~8K ≈ 64K tokens).
#
# STRICT-JSON DOCTRINE: auto-continuation is safe for prose but NOT for strict
# JSON output — the resume seam is lossy at token boundaries (live-caught: a
# dropped comma between continued chunks → JSONDecodeError). Callers that parse
# the response as JSON must size max_tokens so the answer fits in ONE call,
# with headroom for adaptive-thinking models (Sonnet 5), whose always-on
# thinking counts against maxTokens. See TestStrictJsonTokenHeadroom for the
# enforced per-site floors.
DEFAULT_MAX_CONTINUATIONS = 8
# When an adaptive-thinking model spends the whole maxTokens budget on thinking
# (zero visible text), retry the single-turn request with a doubled ceiling
# instead of continuing (an empty assistant replay is rejected by Converse).
_MAX_EMPTY_BUDGET_RAISES = 2
# Must sit ABOVE the largest caller budget or the retry is inert exactly where it
# is needed most: `build_prototype` asks for 32000 on the 'prototype' surface,
# whose default is Opus 5.5 — adaptive thinking, i.e. the likeliest caller to spend
# everything on thinking. At the previous 16384 that caller got zero retries (and
# before the upward-only clamp, a HALVED budget). 64000 lets 32000 double once,
# and is well inside Opus 5's 128K output limit (Opus 5.5's is not verified; a
# lower limit only hits the ValidationException degrade path in the raise
# helper); the binding constraint is wall-clock, hence the deadline below.
_EMPTY_RAISE_CEILING = 64000
# A raise doubles the budget, so the retry can run substantially longer than the
# call that just failed. Skip it once the invocation has already spent this long:
# being killed mid-retry returns NOTHING, which is strictly worse than returning
# the empty result and letting the caller decide.
#
# DEFAULT ONLY — calibrated for the long-budget job Lambdas, where this guard can
# actually bind: `DocumentGeneratorJob` runs 15 minutes and is the 32000-token
# caller. Short-timeout callers (API handlers, 1500-4096 tokens) can never reach
# 420s, but their doubled retry is correspondingly cheap, so an inert guard there
# is harmless rather than wrong. Any caller that needs the guard to bind sooner
# passes `empty_raise_deadline_seconds=` — ideally derived from its own
# `context.get_remaining_time_in_millis()`, which converse() does not receive.
# Same guard shape as repo-review's CONTINUATION_DEADLINE_SECONDS.
_EMPTY_RAISE_DEADLINE_SECONDS = 420

# Nudge sent as the user turn when resuming a truncated response. Kept terse and
# explicit so the model picks up exactly where it stopped without re-emitting text.
_CONTINUE_PROMPT = (
    "Continue the document exactly where you left off. "
    "Do not repeat any text you already wrote and do not add a preamble — "
    "resume from the next character."
)

# Retryable error codes
RETRYABLE_ERROR_CODES = frozenset({
    'ThrottlingException',
    'ServiceUnavailableException',
    'ModelStreamErrorException',
})


class BedrockThrottlingError(Exception):
    """Raised when Bedrock is throttled after max retries."""


# Name of the metric emitted when Bedrock refuses the Flex tier and the request
# is re-sent on the default tier. Dimension: Surface.
FLEX_FALLBACK_METRIC = 'FlexFallback'


@dataclass
class ConverseResult:
    """A converse() answer plus the service tier it actually ran on.

    ``requested_tier`` is what the caller (or the surface default) asked for;
    ``resolved_tier`` is what Bedrock reported serving (falling back to what was
    last SENT when the response carries no tier). ``flex_fallback`` is True when
    Flex was refused and the call was re-sent on the default tier — callers that
    record provenance (jobs, memory writes) store it rather than guess.

    ``model_id`` is the model this call actually ran on (the explicit override,
    else what the per-surface picker resolved at the START of the call). Callers
    stamping provenance read it here rather than re-resolving later: the picker
    caches per container, so a later lookup can name a model an admin switched
    to after this call had already been answered.
    """
    text: str
    requested_tier: str | None = None
    resolved_tier: str | None = None
    flex_fallback: bool = False
    model_id: str | None = None
    # The model the caller asked for (explicit override or picker resolution).
    # Differs from ``model_id`` exactly when a capacity fallback served the call.
    requested_model_id: str | None = None

    @property
    def model_fallback(self) -> bool:
        """True when a different model than requested answered this call."""
        return self.requested_model_id is not None and self.model_id != self.requested_model_id


@dataclass
class _TierState:
    """Mutable tier bookkeeping shared by every Bedrock call of one converse().

    Once Flex has been refused, every later call of the same converse() (empty-
    budget raises, continuations) goes out on the default tier: asking again
    would cost a refused round trip per call for the same answer.
    """
    surface: str
    sending: str | None
    requested: str | None = None
    resolved: str | None = None
    fell_back: bool = False

    def apply(self, kwargs: dict) -> dict:
        """kwargs with the tier that should go on the wire now (or none)."""
        out = dict(kwargs)
        if self.sending:
            out['serviceTier'] = {'type': self.sending}
        return out

    def record_response(self, response: dict) -> None:
        reported = response.get('serviceTier')
        reported_type = reported.get('type') if isinstance(reported, dict) else None
        self.resolved = reported_type if isinstance(reported_type, str) else self.sending

    def fall_back(self, error: ClientError) -> None:
        """Switch to the default tier after Bedrock refused Flex. Never silent."""
        self.sending = 'default'
        self.fell_back = True
        message = str(error.response.get('Error', {}).get('Message'))
        logger.warning(
            "[BEDROCK] Flex service tier refused; retrying on the default tier",
            extra={'surface': self.surface, 'reason': message[:200]},
        )
        try:
            with single_metric(
                name=FLEX_FALLBACK_METRIC, unit=MetricUnit.Count, value=1,
                namespace=metrics.namespace or 'VoC',
            ) as metric:
                metric.add_dimension(name='Surface', value=self.surface)
        except Exception as metric_error:  # noqa: BLE001 - a metric must never fail inference
            logger.warning(f"[BEDROCK] Could not emit {FLEX_FALLBACK_METRIC}: {metric_error}")


def _is_tier_refusal(error: ClientError, tier_state: '_TierState') -> bool:
    """True when Bedrock rejected the request BECAUSE of the Flex tier.

    Only a ValidationException that names the service tier qualifies; any other
    validation failure is the caller's bug and must surface unchanged.
    """
    if tier_state.sending != 'flex':
        return False
    err = error.response.get('Error', {})
    if err.get('Code') != 'ValidationException':
        return False
    message = str(err.get('Message')).lower().replace('_', ' ')
    return 'service tier' in message or 'servicetier' in message or 'flex' in message


def _validated_tier(service_tier: str | None, surface: str) -> str | None:
    """The tier to request: the explicit one, else the surface default."""
    tier = service_tier if service_tier is not None else surface_service_tier(surface)
    if tier is not None and tier not in SERVICE_TIERS:
        raise ValueError(f"service_tier must be one of {SERVICE_TIERS} or None, got {tier!r}")
    return tier


def _wire_tier(requested_tier: str | None, model_id: str) -> str | None:
    """The tier to put on the wire for ``model_id``: Flex only where it runs.

    A model whose Bedrock model card does not list Flex refuses it with a
    ValidationException, so asking anyway buys a failed round trip per call
    for the same 'default' answer. Such a model is sent 'default' up front —
    the tier the refusal fallback would have landed on — which is a planned
    choice, not a fallback: no FlexFallback metric, ``flex_fallback`` stays
    False, and ``requested_tier`` still records that Flex was asked for.
    """
    if requested_tier != 'flex' or supports_flex(model_id):
        return requested_tier
    logger.info(f"[BEDROCK] Model {model_id} does not support the Flex service tier; sending 'default'")
    return 'default'


def _temperature_note(
    sent: bool,
    temperature: float | None,
    model_id: str,
) -> str:
    """Name the REAL reason `temperature` is or is not on the wire.

    Several suppression causes can hold at once — a caller passing None together
    with an explicit budget (reachable today), or a model that both rejects
    temperature and takes an explicit budget (reachable as soon as one is
    allowlisted). Attributing the drop to whichever cause is checked first would
    point an operator at the wrong one, which defeats the purpose of logging the
    reason at all. So the branches mirror the suppression condition in order,
    most caller-proximate first; with the first two causes ruled out, explicit
    thinking is the only one left (`_build_request` drops temperature for exactly
    these three).
    """
    if sent:
        return str(temperature)
    if temperature is None:
        return 'omitted (caller passed None)'
    if omits_temperature(model_id):
        return 'omitted (model rejects it)'
    return 'omitted (explicit thinking)'


def _raised_empty_budget(current_max: int) -> int | None:
    """Next maxTokens to try after a model returned zero visible text.

    Doubles the budget, capped at `_EMPTY_RAISE_CEILING`, and returns None when
    there is no headroom left to retry.

    The clamp is UPWARD ONLY. A bare `min(current * 2, CEILING)` LOWERS the budget
    for a caller already above the ceiling, which makes the empty-text outcome
    strictly MORE likely — the opposite of the retry's purpose. A caller sitting
    exactly at the ceiling would instead get a byte-identical retry: two Bedrock
    calls for one answer. Both cases return None so the caller stops rather than
    spending a call that cannot help.

    `_EMPTY_RAISE_CEILING` is kept above every in-repo caller budget so that
    returning None means "genuinely out of headroom", not "this caller was always
    excluded". See that constant for why 64000.
    """
    raised = min(current_max * 2, _EMPTY_RAISE_CEILING)
    return raised if raised > current_max else None


def _empty_raise_past_deadline(elapsed_seconds: float, deadline_seconds: float) -> bool:
    """Whether too much of the invocation is gone to risk a doubled-budget retry.

    The retry asks for twice the budget, so a slow first call leaves less time to
    do more work. Returning the empty result lets the caller fail cleanly; a
    Lambda timeout mid-retry returns nothing at all.
    """
    return elapsed_seconds > deadline_seconds


def _build_request(
    *,
    prompt: str,
    system_prompt: str,
    max_tokens: int,
    temperature: float | None,
    thinking_budget: int,
    model_id: str,
) -> tuple[dict, bool]:
    """The Converse kwargs for one single-turn request, and whether EXPLICIT
    extended thinking is on (which also rules out continuation)."""
    messages = [{'role': 'user', 'content': [{'text': prompt}]}]

    # Resolved BEFORE the inference config because enabling thinking also
    # constrains `temperature` (see below). Models with always-on adaptive
    # thinking (Sonnet 5, Opus 4.7+) reject an explicit budget, so the field is
    # skipped for them — their thinking runs automatically.
    explicit_thinking = thinking_budget > 0 and not uses_adaptive_thinking(model_id)

    inference_config: dict[str, float] = {'maxTokens': max_tokens}
    # `temperature` is dropped in three cases:
    #   - the caller passed None explicitly;
    #   - the model rejects the parameter outright as deprecated;
    #   - EXPLICIT extended thinking is on: Anthropic permits only
    #     temperature=1 alongside thinking, and sending both is a hard 400.
    #     Omitting is equivalent to 1 and keeps one exit shape here.
    #
    # Keep the third condition even though it looks redundant next to the
    # capability flags: it is a COMBINATION, not a per-model property, so no
    # per-model flag can encode it. It binds exactly the models that accept
    # temperature AND take an explicit budget.
    if temperature is not None and not explicit_thinking and not omits_temperature(model_id):
        inference_config['temperature'] = temperature
    kwargs: dict = {
        # Capabilities above are looked up on the CANONICAL id; the wire gets the
        # scoped one (`eu.` on an EU deployment, docs/eu-deployment.md).
        'modelId': invocation_model_id(model_id),
        'messages': messages,
        'inferenceConfig': inference_config,
    }
    if system_prompt:
        kwargs['system'] = [{'text': system_prompt}]

    # Add extended thinking if the resolved model takes an explicit budget
    # (decided above, alongside the temperature it constrains).
    if explicit_thinking:
        kwargs['additionalModelRequestFields'] = {
            'thinking': {
                'type': 'enabled',
                'budget_tokens': thinking_budget
            }
        }

    # What actually goes on the wire, which is NOT the requested params:
    # both temperature and the thinking budget can be dropped per model. The
    # requested-params line alone made a request look like it carried a
    # temperature and a budget that Bedrock never saw, which is exactly the wrong
    # starting point when triaging a ValidationException about those fields. The
    # drop REASON is spelled out so an operator reading only this line knows why
    # it vanished instead of inferring it from the thinking value.
    effective_temperature = _temperature_note(
        sent='temperature' in inference_config,
        temperature=temperature,
        model_id=model_id,
    )
    effective_thinking = thinking_budget if explicit_thinking else 'omitted'
    logger.info(f"[BEDROCK] Effective params: temperature={effective_temperature}, thinking={effective_thinking}")
    return kwargs, explicit_thinking


def build_single_turn_request(
    model_id: str,
    *,
    prompt: str,
    max_tokens: int,
    system_prompt: str = "",
    temperature: float | None = DEFAULT_TEMPERATURE,
    thinking_budget: int = 0,
    service_tier: str | None = None,
) -> dict:
    """The Converse kwargs converse() would put on the wire FIRST for ``model_id``.

    Same per-model shaping (temperature dropped where the model rejects it, no
    explicit thinking budget on adaptive-thinking models, the scoped invocation
    id, Flex only where the model serves it) for a caller that must send exactly
    one request to exactly one model — the Settings model test
    (shared/model_capacity.py), which must never fall back or retry.
    """
    kwargs, _ = _build_request(
        prompt=prompt, system_prompt=system_prompt, max_tokens=max_tokens,
        temperature=temperature, thinking_budget=thinking_budget, model_id=model_id,
    )
    tier = _wire_tier(service_tier, model_id)
    if tier:
        kwargs['serviceTier'] = {'type': tier}
    return kwargs


@dataclass
class _Invoker:
    """One converse()'s Bedrock call settings, so each turn (first call, raised
    budget, continuation) differs only in its kwargs and step-name suffix."""
    client: object
    max_retries: int
    raise_on_throttle: bool
    step_name: str
    tier_state: _TierState

    def __call__(self, kwargs: dict, step_suffix: str = '') -> tuple[str, str]:
        return _invoke_with_retry(
            client=self.client,
            kwargs=kwargs,
            max_retries=self.max_retries,
            raise_on_throttle=self.raise_on_throttle,
            step_name=f"{self.step_name}{step_suffix}",
            tier_state=self.tier_state,
        )


def _retry_with_raised_budget(
    invoke: _Invoker,
    kwargs: dict,
    *,
    raises_done: int,
    start_time: float,
    deadline_seconds: float,
    model_id: str,
) -> tuple[dict, str, str] | None:
    """Re-run the single-turn request with a raised maxTokens after a zero-text answer.

    Adaptive-thinking models can burn the entire maxTokens budget on thinking and
    return zero visible text. Replaying an empty assistant turn is rejected by
    Converse ("text content blocks must be non-empty"), so continuation can't
    help — instead, re-run the original request with a raised ceiling so the
    model has headroom for both thinking and output.

    Returns (raised kwargs, text, stop_reason), or None when the caller should
    stop and keep the empty result (raise cap, no headroom, past the deadline,
    or the model rejected the raised budget).
    """
    step_name = invoke.step_name
    if raises_done >= _MAX_EMPTY_BUDGET_RAISES:
        logger.warning(
            f"[BEDROCK] Step '{step_name}' still produced no visible text after "
            f"{raises_done} maxTokens raise(s); giving up on continuation"
        )
        return None
    current_max = kwargs['inferenceConfig']['maxTokens']
    raised = _raised_empty_budget(current_max)
    if raised is None:
        logger.warning(
            f"[BEDROCK] Step '{step_name}' produced no visible text at "
            f"maxTokens={current_max}, which is already at/above the raise "
            f"ceiling ({_EMPTY_RAISE_CEILING}); no headroom to retry"
        )
        return None
    elapsed = time.time() - start_time
    if _empty_raise_past_deadline(elapsed, deadline_seconds):
        # The retry would ask for double the budget with less time to
        # spend it. Returning the empty result lets the caller fail
        # cleanly; a Lambda timeout mid-retry returns nothing at all.
        logger.warning(
            f"[BEDROCK] Step '{step_name}' produced no visible text but "
            f"{elapsed:.0f}s of the invocation is already spent "
            f"(deadline {deadline_seconds}s); "
            f"skipping the maxTokens raise to avoid a timeout"
        )
        return None
    attempt = raises_done + 1
    raised_kwargs = {**kwargs, 'inferenceConfig': {**kwargs['inferenceConfig'], 'maxTokens': raised}}
    logger.warning(
        f"[BEDROCK] Step '{step_name}' hit maxTokens with no visible text "
        f"(budget likely consumed by thinking); retrying with maxTokens={raised} "
        f"({attempt}/{_MAX_EMPTY_BUDGET_RAISES})"
    )
    try:
        text, stop_reason = invoke(raised_kwargs, f"_raise{attempt}")
    except ClientError as e:
        if e.response.get('Error', {}).get('Code') != 'ValidationException':
            raise
        # The raised budget exceeds the RESOLVED model's own
        # max-output limit. `_EMPTY_RAISE_CEILING` is sized against
        # Opus 5 (128K), but this branch is reachable for any model
        # the picker resolves — and for an arbitrary `model_id=`
        # override or a legacy BEDROCK_MODEL_ID outside the
        # allowlist, so no per-model cap table could cover it.
        #
        # Degrade to the pre-retry outcome instead of propagating:
        # this path exists to recover an empty result, and turning
        # that harmless empty into a crash is strictly worse than
        # the failure it was trying to fix.
        logger.warning(
            f"[BEDROCK] Step '{step_name}' rejected maxTokens={raised} "
            f"(model {model_id} caps output below the raise ceiling): {e}; "
            f"returning the empty result instead of raising"
        )
        return None
    return raised_kwargs, text, stop_reason


# jscpd:ignore-start — converse() restates converse_detailed()'s keyword
# signature on purpose: both are the typed public API every caller uses (and
# mutation tests pin), and a **kwargs pass-through would erase those types.
def converse(
    prompt: str,
    system_prompt: str = "",
    max_tokens: int = 2048,
    temperature: float | None = DEFAULT_TEMPERATURE,
    thinking_budget: int = 0,
    model_id: str | None = None,
    surface: str = DEFAULT_SURFACE,
    max_retries: int = DEFAULT_MAX_RETRIES,
    raise_on_throttle: bool = True,
    step_name: str = "unknown",
    max_continuations: int = DEFAULT_MAX_CONTINUATIONS,
    empty_raise_deadline_seconds: float = _EMPTY_RAISE_DEADLINE_SECONDS,
    service_tier: str | None = None,
) -> str:
    """Text completion — the text of :func:`converse_detailed` (same arguments).

    Use ``converse_detailed`` when the caller must record which Bedrock service
    tier actually served the request (e.g. the memory extractor on Flex).
    """
    return converse_detailed(
        prompt=prompt, system_prompt=system_prompt, max_tokens=max_tokens,
        temperature=temperature, thinking_budget=thinking_budget, model_id=model_id,
        surface=surface, max_retries=max_retries, raise_on_throttle=raise_on_throttle,
        step_name=step_name, max_continuations=max_continuations,
        empty_raise_deadline_seconds=empty_raise_deadline_seconds,
        service_tier=service_tier,
    ).text


def converse_detailed(
    prompt: str,
    system_prompt: str = "",
    max_tokens: int = 2048,
    temperature: float | None = DEFAULT_TEMPERATURE,
    thinking_budget: int = 0,
    model_id: str | None = None,
    surface: str = DEFAULT_SURFACE,
    max_retries: int = DEFAULT_MAX_RETRIES,
    raise_on_throttle: bool = True,
    step_name: str = "unknown",
    max_continuations: int = DEFAULT_MAX_CONTINUATIONS,
    empty_raise_deadline_seconds: float = _EMPTY_RAISE_DEADLINE_SECONDS,
    service_tier: str | None = None,
) -> ConverseResult:
    # jscpd:ignore-end of the accepted pair
    """
    Simple text completion using Bedrock Converse API with retry support.

    Args:
        prompt: User message/prompt
        system_prompt: Optional system prompt
        max_tokens: Maximum tokens in response (default: 2048)
        temperature: Model temperature (default: 0.1). Pass None to omit it
            entirely — required for models like Opus 5 that reject/deprecate
            the `temperature` inference parameter.
        thinking_budget: If > 0, enables extended thinking with this token budget
        model_id: Explicit model ID override. When None, the model is resolved
            from the per-surface AI-model picker via ``surface``.
        surface: AI surface whose configured model to use when ``model_id`` is
            None (e.g. "chat", "documents", "prototype", "enrichment",
            "utility"). See shared.model_config for the resolution order and
            defaults. Ignored when ``model_id`` is passed explicitly.
        max_retries: Maximum retry attempts for throttling (default: 5)
        raise_on_throttle: If True, raise BedrockThrottlingError after max retries
        step_name: Name of the current step for logging
        max_continuations: When the model stops at the maxTokens ceiling, resume
            and concatenate up to this many times so long documents aren't
            silently truncated. Set to 0 to disable. Ignored when extended
            thinking is enabled (multi-turn replay of thinking blocks is
            unsupported here).
        empty_raise_deadline_seconds: Stop retrying an all-thinking (zero visible
            text) response once this much of the invocation is spent. The default
            suits the 15-minute job Lambdas; pass a smaller value on a
            short-timeout function, ideally derived from that handler's own
            `context.get_remaining_time_in_millis()`.
        service_tier: Bedrock service tier to request: 'flex', 'default', or
            None for the surface default (``SURFACE_SERVICE_TIERS``; most
            surfaces send no tier at all, which is Bedrock's Standard). Flex
            goes on the wire only for a model with ``supports_flex`` (see
            shared.model_config); any other model is sent 'default'. When
            Flex is refused with a ValidationException naming the tier, the call
            is re-sent ONCE on 'default' (one WARNING log, no ERROR), a
            ``FlexFallback`` metric (dimension Surface) is emitted, and the
            result says so.

    Returns:
        ConverseResult — the text (concatenated across any continuations) plus
        the requested/resolved tier, whether Flex fell back, the model that
        actually answered (``model_id``) and the one that was asked for
        (``requested_model_id``; they differ after a capacity fallback).

    Model fallback: when the requested model cannot serve right now (granted
    but throttled to zero after the retry budget, unavailable, not enabled —
    see shared.model_fallback.is_model_unavailable), the WHOLE request is re-run
    on the next model of ``fallback_chain`` and that model is skipped in this
    container for a few minutes. Input errors never fall back.

    Raises:
        BedrockThrottlingError: If throttled after max retries on every model
            of the chain and raise_on_throttle=True (the first model's error)
        ClientError: For non-retryable AWS errors
    """
    primary = model_id or get_active_model_id(surface)
    requested_tier = _validated_tier(service_tier, surface)
    start_time = time.time()

    def attempt(used_model: str) -> ConverseResult:
        return _converse_on_model(
            used_model,
            prompt=prompt, system_prompt=system_prompt, max_tokens=max_tokens,
            temperature=temperature, thinking_budget=thinking_budget, surface=surface,
            max_retries=max_retries, raise_on_throttle=raise_on_throttle,
            step_name=step_name, max_continuations=max_continuations,
            empty_raise_deadline_seconds=empty_raise_deadline_seconds,
            requested_tier=requested_tier, start_time=start_time,
        )

    _, result = run_with_fallback(fallback_chain(primary, surface), surface, attempt)
    result.requested_model_id = primary
    return result


def _converse_on_model(
    used_model: str,
    *,
    prompt: str,
    system_prompt: str,
    max_tokens: int,
    temperature: float | None,
    thinking_budget: int,
    surface: str,
    max_retries: int,
    raise_on_throttle: bool,
    step_name: str,
    max_continuations: int,
    empty_raise_deadline_seconds: float,
    requested_tier: str | None,
    start_time: float,
) -> ConverseResult:
    """converse_detailed() on ONE model: request build, continuations, raises.

    ``start_time`` is the start of the whole converse_detailed() call, so the
    empty-budget deadline counts time already spent on a model that fell back.
    """
    tier_state = _TierState(
        surface=surface, sending=_wire_tier(requested_tier, used_model), requested=requested_tier,
    )
    logger.info(f"[BEDROCK] Starting converse call for step '{step_name}' with model {used_model} (surface={surface}, service_tier={requested_tier})")
    logger.info(f"[BEDROCK] Requested params: max_tokens={max_tokens}, temperature={temperature}, thinking_budget={thinking_budget}")
    logger.info(f"[BEDROCK] Prompt length: {len(prompt)} chars, system_prompt length: {len(system_prompt)} chars")

    try:
        client = get_bedrock_client()
        logger.info("[BEDROCK] Got Bedrock client successfully")
    except Exception:
        logger.exception("[BEDROCK] Failed to get Bedrock client")
        raise

    kwargs, explicit_thinking = _build_request(
        prompt=prompt, system_prompt=system_prompt, max_tokens=max_tokens,
        temperature=temperature, thinking_budget=thinking_budget, model_id=used_model,
    )
    logger.info(f"[BEDROCK] Invoking Bedrock converse API for step '{step_name}'...")

    # Continuation is incompatible with EXPLICIT extended thinking: resuming a
    # truncated turn requires replaying the assistant message, and thinking
    # blocks have signing/ordering rules we don't handle here. Models where we
    # skip the explicit budget (always-on adaptive thinking) can still continue.
    # (max_continuations <= 0 needs no check: the loop's own bound stops it.)
    allow_continuation = not explicit_thinking

    invoke = _Invoker(
        client=client, max_retries=max_retries, raise_on_throttle=raise_on_throttle,
        step_name=step_name, tier_state=tier_state,
    )
    try:
        result, stop_reason = invoke(kwargs)

        # Auto-continue while the model is hitting the maxTokens ceiling. Each
        # turn appends the prior (truncated) assistant text plus a resume nudge,
        # so the model picks up exactly where it stopped. Without this, a long
        # PRD/PR-FAQ is saved half-written (the document-cutoff bug).
        continuations = 0
        empty_budget_raises = 0
        while allow_continuation and stop_reason == 'max_tokens' and continuations < max_continuations:
            if not result:
                retried = _retry_with_raised_budget(
                    invoke, kwargs,
                    raises_done=empty_budget_raises,
                    start_time=start_time,
                    deadline_seconds=empty_raise_deadline_seconds,
                    model_id=used_model,
                )
                if retried is None:
                    break
                empty_budget_raises += 1
                kwargs, result, stop_reason = retried
                continue
            continuations += 1
            logger.warning(
                f"[BEDROCK] Step '{step_name}' hit maxTokens — auto-continuing "
                f"({continuations}/{max_continuations}), {len(result)} chars so far"
            )
            cont_messages = [
                {'role': 'user', 'content': [{'text': prompt}]},
                {'role': 'assistant', 'content': [{'text': result}]},
                {'role': 'user', 'content': [{'text': _CONTINUE_PROMPT}]},
            ]
            cont_kwargs = {**kwargs, 'messages': cont_messages}
            chunk, stop_reason = invoke(cont_kwargs, f"_cont{continuations}")
            if not chunk:
                logger.warning(f"[BEDROCK] Step '{step_name}' continuation returned no text; stopping")
                break
            result += chunk

        if stop_reason == 'max_tokens':
            logger.warning(
                f"[BEDROCK] Step '{step_name}' still truncated after {continuations} "
                f"continuation(s); output may be incomplete ({len(result)} chars)"
            )

        elapsed = time.time() - start_time
        logger.info(f"[BEDROCK] Step '{step_name}' completed in {elapsed:.2f}s, response length: {len(result)} chars")
        return ConverseResult(
            text=result,
            requested_tier=tier_state.requested,
            resolved_tier=tier_state.resolved,
            flex_fallback=tier_state.fell_back,
            model_id=used_model,
        )
    except Exception as e:
        elapsed = time.time() - start_time
        logger.exception(f"[BEDROCK] Step '{step_name}' FAILED after {elapsed:.2f}s: {type(e).__name__}: {e}")
        raise


def _on_client_error(
    error: ClientError,
    *,
    attempt: int,
    max_retries: int,
    raise_on_throttle: bool,
    step_name: str,
    attempt_elapsed: float,
    is_expected_error: Callable[[ClientError], bool],
) -> None:
    """bedrock_call_with_retry's handling of one ClientError attempt.

    Returns normally when the loop should move on (a throttle with attempts
    left, after its backoff sleep; or throttling exhausted with
    raise_on_throttle=False); raises otherwise. An error the caller declared
    expected is re-raised first, unretried and with no ERROR log.
    """
    if is_expected_error(error):
        raise error
    error_code = error.response.get('Error', {}).get('Code', '')
    error_message = error.response.get('Error', {}).get('Message', str(error))

    logger.exception(f"[BEDROCK] ClientError for step '{step_name}' after {attempt_elapsed:.2f}s: {error_code} - {error_message}")

    if error_code not in RETRYABLE_ERROR_CODES:
        logger.exception(f"[BEDROCK] Non-retryable error for step '{step_name}': {error_code} - {error_message}")
        raise error
    if attempt < max_retries - 1:
        delay = _calculate_backoff(attempt)
        logger.warning(
            f"[BEDROCK] Retryable error {error_code} for step '{step_name}' "
            f"(attempt {attempt + 1}/{max_retries}), retrying in {delay:.2f}s"
        )
        time.sleep(delay)
        return
    logger.exception(f"[BEDROCK] Step '{step_name}' throttled after {max_retries} attempts")
    if raise_on_throttle:
        raise BedrockThrottlingError(
            f"Bedrock throttled after {max_retries} retries for step '{step_name}'"
        ) from error


def _no_expected_error(_error: ClientError) -> bool:
    """Default for ``is_expected_error``: every ClientError is the retry loop's."""
    return False


# The result type is whatever the wrapped Bedrock call returns, so the helper
# does not flatten it to `object`: callers read the response directly
# (`.get('output')`, `['body'].read()`). The overloads encode the total contract
# below — with raise_on_throttle=True (the default) None is impossible, so the
# type says so and callers carry no dead None guards.
@overload  # pragma: no mutate  typing-only stub: the runtime always calls the implementation below
def bedrock_call_with_retry[CallResult](
    call: Callable[[], CallResult],
    max_retries: int = ...,
    raise_on_throttle: Literal[True] = ...,
    step_name: str = ...,
    call_label: str = ...,
    is_expected_error: Callable[[ClientError], bool] = ...,
) -> CallResult: ...


@overload  # pragma: no mutate  typing-only stub: the runtime always calls the implementation below
def bedrock_call_with_retry[CallResult](
    call: Callable[[], CallResult],
    max_retries: int = ...,
    raise_on_throttle: bool = ...,
    step_name: str = ...,
    call_label: str = ...,
    is_expected_error: Callable[[ClientError], bool] = ...,
) -> CallResult | None: ...


def bedrock_call_with_retry[CallResult](
    call: Callable[[], CallResult],
    max_retries: int = DEFAULT_MAX_RETRIES,
    raise_on_throttle: bool = True,
    step_name: str = "unknown",
    call_label: str = "the Bedrock call",
    is_expected_error: Callable[[ClientError], bool] = _no_expected_error,
) -> CallResult | None:
    """Run *call*, retrying only the failures a second attempt can actually fix.

    THE POLICY LIVES HERE because botocore cannot express it: **retry a throttle,
    never retry a read timeout.** A 429 costs a round trip and no generation, so
    retrying it with backoff is nearly free. A read timeout means the generation
    itself outran the client's patience, and an identical request cannot go faster
    with less time left — see BEDROCK_READ_TIMEOUT_SECONDS in shared/aws.py, whose
    retry budget is 1 for exactly this reason. botocore's own retries could not
    tell those two apart, and retried both.

    Exposed (not underscore-private) for the RAW client callers: the product
    interview turn, persona import and manual-import classification each build
    their own Converse/InvokeModel request because they carry a tool config, an
    image block or an Anthropic-native body that the text-only `converse()` helper
    does not take. They previously leaned on botocore's attempts, which is not a
    policy anyone chose — dropping those to 1 would otherwise have left them
    surfacing the first 429 with no backoff anywhere.

    Args:
        call: Zero-argument callable performing ONE Bedrock request. Called again
            per retry, so it must be safe to re-run (build the request outside).
        max_retries: Maximum attempts, including the first. Every caller passes a
            literal or takes the default — nothing derives it from configuration or
            the environment (the research prompt templates carry `max_tokens`, not
            this), so the 0 case below is a programming error rather than something
            a settings row can produce.
        raise_on_throttle: If True, raise BedrockThrottlingError once throttling
            has exhausted the attempts. If False, return None instead.
        step_name: Name of the current step, for logging.
        call_label: What is being called, for logging.
        is_expected_error: Optional predicate naming a ClientError the CALLER
            handles itself (today: a Flex service-tier refusal, which converse()
            re-sends on the default tier). A match is re-raised at once, unretried
            and WITHOUT the ERROR logs below — the caller logs it at the level it
            deserves. An ERROR line for a refusal that is planned for and
            recovered from reads as an outage and buries the real ones.

    Returns:
        Whatever *call* returns. **None ONLY when raise_on_throttle=False** — with
        the default this either returns a result or raises, so callers do not need
        to guard against None. That is a total contract on purpose: three call
        sites each inventing their own None check is how one of them ends up
        without it, and the failure there is a TypeError on the next line instead
        of a diagnosis.

    Raises:
        BedrockThrottlingError: If throttling exhausted the attempts and
            raise_on_throttle=True — including the degenerate max_retries=0, where
            no attempt was made at all. A caller error must fail loudly rather
            than return an empty result that reads like a Bedrock answer.
        ReadTimeoutError: Immediately, on the first read timeout, unretried
        ClientError: For non-retryable AWS errors
    """
    for attempt in range(max_retries):
        logger.info(f"[BEDROCK] Attempt {attempt + 1}/{max_retries} for step '{step_name}'")
        attempt_start = time.time()

        try:
            logger.info(f"[BEDROCK] Calling {call_label} for step '{step_name}'...")
            result = call()
        except ClientError as e:
            _on_client_error(
                e,
                attempt=attempt,
                max_retries=max_retries,
                raise_on_throttle=raise_on_throttle,
                step_name=step_name,
                attempt_elapsed=time.time() - attempt_start,
                is_expected_error=is_expected_error,
            )

        except ReadTimeoutError:
            # NOT retried, deliberately — and this branch is what keeps the
            # one-attempt budget in shared/aws.py from being undone here.
            #
            # `converse` is non-streaming, so a read timeout means the generation
            # needed longer than the client was willing to wait. The identical
            # request will not run faster on a second try, and each retry
            # re-submits the prompt and re-pays for a full abandoned generation
            # while spending time this invocation no longer has. Retrying would
            # simply move the old 3 x 300 = 900 collision up one layer and make it
            # 5 x 840, i.e. the same bug with a bigger multiplier.
            #
            # Raised rather than swallowed so the caller's own failure path runs
            # (shared/jobs.py records the job `failed`), and logged HERE because
            # the read timeout is the one attempt outcome the application would
            # otherwise never name — it is not a ClientError and carries no error
            # code to triage from.
            attempt_elapsed = time.time() - attempt_start
            logger.exception(
                f"[BEDROCK] Read timeout for step '{step_name}' after "
                f"{attempt_elapsed:.2f}s — not retried: a non-streaming generation "
                f"that exceeded the read budget will exceed it again. Reduce "
                f"max_tokens for this step or split it."
            )
            raise

        except Exception as e:
            attempt_elapsed = time.time() - attempt_start
            logger.exception(f"[BEDROCK] Unexpected error for step '{step_name}' after {attempt_elapsed:.2f}s: {type(e).__name__}: {e}")

            if attempt < max_retries - 1:
                delay = _calculate_backoff(attempt)
                logger.warning(
                    f"[BEDROCK] Retrying step '{step_name}' in {delay:.2f}s "
                    f"(attempt {attempt + 1}/{max_retries})"
                )
                time.sleep(delay)
            else:
                logger.exception(f"[BEDROCK] Step '{step_name}' failed after {max_retries} attempts: {e}")
                raise

        else:
            attempt_elapsed = time.time() - attempt_start
            logger.info(f"[BEDROCK] Response received for step '{step_name}' in {attempt_elapsed:.2f}s")

            if attempt > 0:
                logger.info(f"[BEDROCK] Bedrock succeeded after {attempt + 1} attempts for step '{step_name}'")

            return result

    # Reached when the attempts ran out without a result: throttling with
    # raise_on_throttle=False, or the degenerate max_retries=0 where the loop never
    # ran. With raise_on_throttle=True it is ONLY the latter: exhausted throttling
    # and a last-attempt failure both raise inside the loop.
    logger.error(f"[BEDROCK] Step '{step_name}' exhausted all retries without success")
    if raise_on_throttle:
        # Returning None here would hand a caller who cannot expect it (see the
        # contract above) something that reads like an empty Bedrock answer.
        raise BedrockThrottlingError(
            f"Bedrock failed after {max_retries} retries for step '{step_name}' (no attempt was made)"
        )
    return None


def _converse_with_retry(
    client,
    kwargs: dict,
    *,
    max_retries: int,
    raise_on_throttle: bool,
    step_name: str,
    is_expected_error: Callable[[ClientError], bool],
) -> dict:
    """
    Invoke Bedrock converse with exponential backoff retry, returning the raw response.

    The retry POLICY is bedrock_call_with_retry's; this adds the response logging
    that only a Converse reply has, and keeps the `{}` empty return the callers
    below are written against.

    Args:
        client: Bedrock runtime client
        kwargs: Arguments for client.converse()
        max_retries: Maximum retry attempts
        raise_on_throttle: If True, raise BedrockThrottlingError after max retries
        step_name: Name of the current step for logging
        is_expected_error: Passed through to bedrock_call_with_retry (a
            ClientError the caller handles, re-raised without ERROR logs).

    Returns:
        Raw Bedrock converse response dict, or {} when retries were exhausted
        with raise_on_throttle=False.

    Raises:
        BedrockThrottlingError: If throttled after max retries and raise_on_throttle=True
        ClientError: For non-retryable AWS errors
    """
    response = bedrock_call_with_retry(
        lambda: client.converse(**kwargs),
        max_retries=max_retries,
        raise_on_throttle=raise_on_throttle,
        step_name=step_name,
        call_label='client.converse()',
        is_expected_error=is_expected_error,
    )
    if not isinstance(response, dict):
        return {}

    usage = response.get('usage', {})
    stop_reason = response.get('stopReason', 'unknown')
    input_tokens = usage.get('inputTokens', 0)
    output_tokens = usage.get('outputTokens', 0)
    logger.info(
        f"[BEDROCK] Usage: input_tokens={input_tokens}, output_tokens={output_tokens}, "
        f"stop_reason={stop_reason}"
    )
    return response


def _invoke_with_retry(
    client,
    kwargs: dict,
    *,
    max_retries: int,
    raise_on_throttle: bool,
    step_name: str,
    tier_state: _TierState,
) -> tuple[str, str]:
    """
    Invoke Bedrock converse with exponential backoff retry, returning extracted
    text and the stop reason.

    Takes the same arguments as `_converse_with_retry` and raises the same
    errors; see there. The request carries ``tier_state``'s service tier, a
    Flex refusal is retried ONCE on the default tier (one WARNING log, no ERROR;
    recorded on the state, metric emitted), and the tier Bedrock reports is
    recorded.

    Returns:
        (text, stop_reason). stop_reason is the raw Bedrock value
        (e.g. 'end_turn', 'max_tokens') or '' when no response was returned.
    """
    def _call(tiered_kwargs: dict) -> dict:
        return _converse_with_retry(
            client=client,
            kwargs=tiered_kwargs,
            max_retries=max_retries,
            raise_on_throttle=raise_on_throttle,
            step_name=step_name,
            # A Flex refusal is planned for: fall_back() logs it ONCE at
            # WARNING, so the generic retry loop must not log it at ERROR.
            is_expected_error=lambda error: _is_tier_refusal(error, tier_state),
        )

    try:
        response = _call(tier_state.apply(kwargs))
    except ClientError as e:
        if not _is_tier_refusal(e, tier_state):
            raise
        tier_state.fall_back(e)
        response = _call(tier_state.apply(kwargs))
    tier_state.record_response(response)
    if not response:
        return "", ""
    content = response.get('output', {}).get('message', {}).get('content', [])
    result = _extract_text(content)
    stop_reason = response.get('stopReason', '')
    logger.info(f"[BEDROCK] Extracted {len(result)} chars from response for step '{step_name}' (stop_reason={stop_reason})")
    return result, stop_reason


def _calculate_backoff(attempt: int) -> float:
    """Calculate exponential backoff delay with full-second jitter.

    The jitter comes from the OS CSPRNG (``secrets.SystemRandom``): it needs no
    reproducibility, and using one generator kind everywhere keeps the module
    free of the non-cryptographic ``random`` functions.
    """
    return min(
        DEFAULT_BASE_DELAY * (2 ** attempt) + _JITTER_RNG.uniform(0, 1),
        DEFAULT_MAX_DELAY,
    )


def converse_chain_detailed(
    steps: list[dict],
    progress_callback: Callable[[int, str], None] | None = None,
    max_retries: int = DEFAULT_MAX_RETRIES,
    surface: str = DEFAULT_SURFACE,
) -> list[ConverseResult]:
    """
    Execute a chain of LLM calls, each building on the previous.

    Each step can have:
        - system: System prompt
        - user: User message (use {previous} to inject previous result)
        - max_tokens: Max output tokens (default 4096)
        - thinking_budget: Extended thinking budget (default 0 = disabled)
        - step_name: Optional name for progress reporting
        - surface: Optional per-step AI surface override (defaults to the
          chain-level `surface`)

    Args:
        steps: List of step configurations
        progress_callback: Optional callback(progress: int, step: str) to report progress
        max_retries: Maximum retry attempts for throttling (default: 5)
        surface: AI surface whose configured model the steps resolve to when
            they don't set their own model (default: the neutral fallback).

    Returns:
        One ConverseResult per step, in step order — each carrying the model
        that step actually ran on (``model_id``), so provenance can name the
        step's own model rather than re-resolve the picker after the chain.
    """
    results: list[ConverseResult] = []
    context = ""
    total_steps = len(steps)

    logger.info(f"[CHAIN] Starting LLM chain with {total_steps} steps")
    chain_start = time.time()

    for i, step in enumerate(steps, 1):
        step_name = step.get('step_name', f'llm_step_{i}')
        logger.info(f"[CHAIN] ========== STEP {i}/{total_steps}: {step_name} ==========")

        # Report progress (distribute 15-75% across LLM steps)
        if progress_callback:
            progress = 15 + int((i - 1) / total_steps * 60)
            logger.info(f"[CHAIN] Reporting progress: {progress}% for step '{step_name}'")
            try:
                progress_callback(progress, step_name)
                logger.info(f"[CHAIN] Progress callback succeeded for step '{step_name}'")
            except Exception:
                # A progress write must never fail the chain (it continues
                # below); the traceback keeps a broken callback diagnosable.
                logger.exception(f"[CHAIN] Progress callback failed for step '{step_name}' (non-fatal)")

        system = step.get('system', '')
        user = step.get('user', '').replace('{previous}', context)
        thinking_budget = step.get('thinking_budget', 0)
        max_tokens = step.get('max_tokens', 4096)

        logger.info(f"[CHAIN] Step '{step_name}' config: max_tokens={max_tokens}, thinking_budget={thinking_budget}")
        logger.info(f"[CHAIN] Step '{step_name}' system_prompt length: {len(system)} chars")
        logger.info(f"[CHAIN] Step '{step_name}' user_prompt length: {len(user)} chars")

        step_start = time.time()
        try:
            result = converse_detailed(
                prompt=user,
                system_prompt=system,
                max_tokens=max_tokens,
                thinking_budget=thinking_budget,
                surface=step.get('surface', surface),
                max_retries=max_retries,
                step_name=step_name,
            )
            step_elapsed = time.time() - step_start
            logger.info(
                f"[CHAIN] Step '{step_name}' completed in {step_elapsed:.2f}s on {result.model_id}"
                f"{f' (fallback from {result.requested_model_id})' if result.model_fallback else ''}, "
                f"output length: {len(result.text)} chars"
            )
            results.append(result)
            context = result.text
        except Exception as e:
            step_elapsed = time.time() - step_start
            logger.exception(f"[CHAIN] Step '{step_name}' FAILED after {step_elapsed:.2f}s: {type(e).__name__}: {e}")
            raise

    chain_elapsed = time.time() - chain_start
    logger.info(f"[CHAIN] LLM chain completed: {total_steps} steps in {chain_elapsed:.2f}s")
    return results


def _texts_of[**ChainParams](
    chain: Callable[ChainParams, list[ConverseResult]],
) -> Callable[ChainParams, list[str]]:
    """*chain* with the same parameters, answering each step's text only."""
    def texts(*args: ChainParams.args, **kwargs: ChainParams.kwargs) -> list[str]:
        return [result.text for result in chain(*args, **kwargs)]

    return texts


# Execute a chain of LLM calls, returning each step's text: converse_chain_detailed
# (same parameters, same logging/progress/context behaviour) for the callers that
# need only the texts. Derived rather than re-declared so the signature lives once.
converse_chain = _texts_of(converse_chain_detailed)


def _extract_text(content_blocks: list) -> str:
    """Extract text from Converse API content blocks."""
    return ''.join(block['text'] for block in content_blocks if 'text' in block)



