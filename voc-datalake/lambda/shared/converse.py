"""
Bedrock Converse API utilities for VoC Lambda functions.
Provides a unified interface for LLM interactions with optional tool use.
"""

import random
import time
from typing import Callable
from botocore.exceptions import ClientError
from shared.logging import logger
from shared.aws import get_bedrock_client
from shared.model_config import (
    get_active_model_id, omits_temperature, uses_adaptive_thinking, DEFAULT_SURFACE,
)


# Retry configuration
DEFAULT_MAX_RETRIES = 5
DEFAULT_BASE_DELAY = 1.0  # seconds
DEFAULT_MAX_DELAY = 30.0  # seconds

# Auto-continuation: when the model stops because it hit the maxTokens ceiling,
# the output is truncated mid-document. We transparently resume the generation up
# to this many times, concatenating the chunks, so callers never persist a
# half-written PRD/PR-FAQ/report (the document-cutoff bug).
#
# Tuning note: keep per-call max_tokens MODEST (≈6-8K) rather than huge. A single
# huge maxTokens (e.g. 24K) makes one Bedrock call run many minutes for slow CJK
# output and can blow the Lambda timeout on its own; many small calls each finish
# in ~1-2 min and resume cleanly. This ceiling must therefore be generous enough
# to assemble a long document from those small chunks (8 × ~8K ≈ 64K tokens).
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
# whose default is Opus 5 — adaptive thinking, i.e. the likeliest caller to spend
# everything on thinking. At the previous 16384 that caller got zero retries (and
# before the upward-only clamp, a HALVED budget). 64000 lets 32000 double once,
# and is well inside Opus 5's 128K output limit; the binding constraint is
# wall-clock, not the model, hence the deadline below rather than a lower cap.
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
    pass


def _temperature_note(
    sent: bool,
    temperature: float | None,
    model_id: str,
    explicit_thinking: bool,
) -> str:
    """Name the REAL reason `temperature` is or is not on the wire.

    Several suppression causes can hold at once — a caller passing None together
    with an explicit budget (reachable today), or a model that both rejects
    temperature and takes an explicit budget (reachable as soon as one is
    allowlisted). Attributing the drop to whichever cause is checked first would
    point an operator at the wrong one, which defeats the purpose of logging the
    reason at all. So the branches mirror the suppression condition in order,
    most caller-proximate first.
    """
    if sent:
        return str(temperature)
    if temperature is None:
        return 'omitted (caller passed None)'
    if omits_temperature(model_id):
        return 'omitted (model rejects it)'
    if explicit_thinking:
        return 'omitted (explicit thinking)'
    return 'omitted'  # pragma: no cover — no suppression cause left to name


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


def converse(
    prompt: str,
    system_prompt: str = "",
    max_tokens: int = 2048,
    temperature: float | None = 0.1,
    thinking_budget: int = 0,
    model_id: str | None = None,
    surface: str = DEFAULT_SURFACE,
    max_retries: int = DEFAULT_MAX_RETRIES,
    raise_on_throttle: bool = True,
    step_name: str = "unknown",
    max_continuations: int = DEFAULT_MAX_CONTINUATIONS,
    empty_raise_deadline_seconds: float = _EMPTY_RAISE_DEADLINE_SECONDS,
) -> str:
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

    Returns:
        Model response text (concatenated across any continuations)

    Raises:
        BedrockThrottlingError: If throttled after max retries and raise_on_throttle=True
        ClientError: For non-retryable AWS errors
    """
    used_model = model_id or get_active_model_id(surface)
    logger.info(f"[BEDROCK] Starting converse call for step '{step_name}' with model {used_model} (surface={surface})")
    logger.info(f"[BEDROCK] Requested params: max_tokens={max_tokens}, temperature={temperature}, thinking_budget={thinking_budget}")
    logger.info(f"[BEDROCK] Prompt length: {len(prompt)} chars, system_prompt length: {len(system_prompt)} chars")
    
    try:
        client = get_bedrock_client()
        logger.info("[BEDROCK] Got Bedrock client successfully")
    except Exception as e:
        logger.error(f"[BEDROCK] Failed to get Bedrock client: {e}")
        raise
    
    messages = [{'role': 'user', 'content': [{'text': prompt}]}]
    system = [{'text': system_prompt}] if system_prompt else None
    
    # Resolved BEFORE the inference config because enabling thinking also
    # constrains `temperature` (see below). Models with always-on adaptive
    # thinking (Sonnet 5, Opus 4.7+) reject an explicit budget, so the field is
    # skipped for them — their thinking runs automatically.
    explicit_thinking = thinking_budget > 0 and not uses_adaptive_thinking(used_model)

    inference_config = {'maxTokens': max_tokens}
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
    if temperature is not None and not explicit_thinking and not omits_temperature(used_model):
        inference_config['temperature'] = temperature
    kwargs = {
        'modelId': used_model,
        'messages': messages,
        'inferenceConfig': inference_config,
    }
    if system:
        kwargs['system'] = system
    
    # Add extended thinking if the resolved model takes an explicit budget
    # (decided above, alongside the temperature it constrains).
    if explicit_thinking:
        kwargs['additionalModelRequestFields'] = {
            'thinking': {
                'type': 'enabled',
                'budget_tokens': thinking_budget
            }
        }
    
    # What actually goes on the wire, which is NOT the requested params above:
    # both temperature and the thinking budget can be dropped per model. The
    # earlier line alone made a request look like it carried a temperature and a
    # budget that Bedrock never saw, which is exactly the wrong starting point
    # when triaging a ValidationException about those fields. The drop REASON is
    # spelled out so an operator reading only this line knows why it vanished
    # instead of inferring it from the thinking value.
    effective_temperature = _temperature_note(
        sent='temperature' in inference_config,
        temperature=temperature,
        model_id=used_model,
        explicit_thinking=explicit_thinking,
    )
    effective_thinking = thinking_budget if explicit_thinking else 'omitted'
    logger.info(f"[BEDROCK] Effective params: temperature={effective_temperature}, thinking={effective_thinking}")
    logger.info(f"[BEDROCK] Invoking Bedrock converse API for step '{step_name}'...")
    start_time = time.time()

    # Continuation is incompatible with EXPLICIT extended thinking: resuming a
    # truncated turn requires replaying the assistant message, and thinking
    # blocks have signing/ordering rules we don't handle here. Models where we
    # skip the explicit budget (always-on adaptive thinking) can still continue.
    allow_continuation = max_continuations > 0 and not explicit_thinking

    try:
        result, stop_reason = _invoke_with_retry(
            client=client,
            kwargs=kwargs,
            max_retries=max_retries,
            raise_on_throttle=raise_on_throttle,
            step_name=step_name,
        )

        # Auto-continue while the model is hitting the maxTokens ceiling. Each
        # turn appends the prior (truncated) assistant text plus a resume nudge,
        # so the model picks up exactly where it stopped. Without this, a long
        # PRD/PR-FAQ is saved half-written (the document-cutoff bug).
        continuations = 0
        empty_budget_raises = 0
        while allow_continuation and stop_reason == 'max_tokens' and continuations < max_continuations:
            if not result:
                # Adaptive-thinking models can burn the entire maxTokens budget on
                # thinking and return zero visible text. Replaying an empty
                # assistant turn is rejected by Converse ("text content blocks
                # must be non-empty"), so continuation can't help — instead,
                # re-run the original single-turn request with a raised ceiling
                # so the model has headroom for both thinking and output.
                if empty_budget_raises >= _MAX_EMPTY_BUDGET_RAISES:
                    logger.warning(
                        f"[BEDROCK] Step '{step_name}' still produced no visible text after "
                        f"{empty_budget_raises} maxTokens raise(s); giving up on continuation"
                    )
                    break
                current_max = kwargs['inferenceConfig']['maxTokens']
                raised = _raised_empty_budget(current_max)
                if raised is None:
                    logger.warning(
                        f"[BEDROCK] Step '{step_name}' produced no visible text at "
                        f"maxTokens={current_max}, which is already at/above the raise "
                        f"ceiling ({_EMPTY_RAISE_CEILING}); no headroom to retry"
                    )
                    break
                elapsed = time.time() - start_time
                if _empty_raise_past_deadline(elapsed, empty_raise_deadline_seconds):
                    # The retry would ask for double the budget with less time to
                    # spend it. Returning the empty result lets the caller fail
                    # cleanly; a Lambda timeout mid-retry returns nothing at all.
                    logger.warning(
                        f"[BEDROCK] Step '{step_name}' produced no visible text but "
                        f"{elapsed:.0f}s of the invocation is already spent "
                        f"(deadline {empty_raise_deadline_seconds}s); "
                        f"skipping the maxTokens raise to avoid a timeout"
                    )
                    break
                empty_budget_raises += 1
                kwargs = {**kwargs, 'inferenceConfig': {**kwargs['inferenceConfig'], 'maxTokens': raised}}
                logger.warning(
                    f"[BEDROCK] Step '{step_name}' hit maxTokens with no visible text "
                    f"(budget likely consumed by thinking); retrying with maxTokens={raised} "
                    f"({empty_budget_raises}/{_MAX_EMPTY_BUDGET_RAISES})"
                )
                try:
                    result, stop_reason = _invoke_with_retry(
                        client=client,
                        kwargs=kwargs,
                        max_retries=max_retries,
                        raise_on_throttle=raise_on_throttle,
                        step_name=f"{step_name}_raise{empty_budget_raises}",
                    )
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
                        f"(model {used_model} caps output below the raise ceiling): {e}; "
                        f"returning the empty result instead of raising"
                    )
                    break
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
            chunk, stop_reason = _invoke_with_retry(
                client=client,
                kwargs=cont_kwargs,
                max_retries=max_retries,
                raise_on_throttle=raise_on_throttle,
                step_name=f"{step_name}_cont{continuations}",
            )
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
        return result
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"[BEDROCK] Step '{step_name}' FAILED after {elapsed:.2f}s: {type(e).__name__}: {e}")
        raise


def _converse_with_retry(
    client,
    kwargs: dict,
    max_retries: int = DEFAULT_MAX_RETRIES,
    raise_on_throttle: bool = True,
    step_name: str = "unknown",
) -> dict:
    """
    Invoke Bedrock converse with exponential backoff retry, returning the raw response.

    Args:
        client: Bedrock runtime client
        kwargs: Arguments for client.converse()
        max_retries: Maximum retry attempts
        raise_on_throttle: If True, raise BedrockThrottlingError after max retries
        step_name: Name of the current step for logging

    Returns:
        Raw Bedrock converse response dict

    Raises:
        BedrockThrottlingError: If throttled after max retries and raise_on_throttle=True
        ClientError: For non-retryable AWS errors
    """
    last_exception = None

    for attempt in range(max_retries):
        logger.info(f"[BEDROCK] Attempt {attempt + 1}/{max_retries} for step '{step_name}'")
        attempt_start = time.time()

        try:
            logger.info(f"[BEDROCK] Calling client.converse() for step '{step_name}'...")
            response = client.converse(**kwargs)
            attempt_elapsed = time.time() - attempt_start

            # Log response metadata
            usage = response.get('usage', {})
            stop_reason = response.get('stopReason', 'unknown')
            input_tokens = usage.get('inputTokens', 0)
            output_tokens = usage.get('outputTokens', 0)

            logger.info(f"[BEDROCK] Response received for step '{step_name}' in {attempt_elapsed:.2f}s")
            logger.info(f"[BEDROCK] Usage: input_tokens={input_tokens}, output_tokens={output_tokens}, stop_reason={stop_reason}")

            if attempt > 0:
                logger.info(f"[BEDROCK] Bedrock succeeded after {attempt + 1} attempts for step '{step_name}'")

            return response

        except ClientError as e:
            attempt_elapsed = time.time() - attempt_start
            error_code = e.response.get('Error', {}).get('Code', '')
            error_message = e.response.get('Error', {}).get('Message', str(e))
            last_exception = e

            logger.error(f"[BEDROCK] ClientError for step '{step_name}' after {attempt_elapsed:.2f}s: {error_code} - {error_message}")

            if error_code in RETRYABLE_ERROR_CODES:
                if attempt < max_retries - 1:
                    delay = _calculate_backoff(attempt)
                    logger.warning(
                        f"[BEDROCK] Retryable error {error_code} for step '{step_name}' "
                        f"(attempt {attempt + 1}/{max_retries}), retrying in {delay:.2f}s"
                    )
                    time.sleep(delay)
                    continue
                else:
                    logger.error(f"[BEDROCK] Step '{step_name}' throttled after {max_retries} attempts")
                    if raise_on_throttle:
                        raise BedrockThrottlingError(
                            f"Bedrock throttled after {max_retries} retries for step '{step_name}'"
                        ) from e
            else:
                # Non-retryable error
                logger.error(f"[BEDROCK] Non-retryable error for step '{step_name}': {error_code} - {error_message}")
                raise

        except Exception as e:
            attempt_elapsed = time.time() - attempt_start
            last_exception = e
            logger.error(f"[BEDROCK] Unexpected error for step '{step_name}' after {attempt_elapsed:.2f}s: {type(e).__name__}: {e}")

            if attempt < max_retries - 1:
                delay = _calculate_backoff(attempt)
                logger.warning(
                    f"[BEDROCK] Retrying step '{step_name}' in {delay:.2f}s "
                    f"(attempt {attempt + 1}/{max_retries})"
                )
                time.sleep(delay)
            else:
                logger.error(f"[BEDROCK] Step '{step_name}' failed after {max_retries} attempts: {e}")
                raise

    # Should not reach here, but handle gracefully
    logger.error(f"[BEDROCK] Step '{step_name}' exhausted all retries without success")
    if raise_on_throttle and last_exception:  # pragma: no cover — defensive guard; retryable errors raise inside the loop
        raise BedrockThrottlingError(
            f"Bedrock failed after {max_retries} retries for step '{step_name}': {last_exception}"
        )
    return {}


def _invoke_with_retry(
    client,
    kwargs: dict,
    max_retries: int = DEFAULT_MAX_RETRIES,
    raise_on_throttle: bool = True,
    step_name: str = "unknown",
) -> tuple[str, str]:
    """
    Invoke Bedrock converse with exponential backoff retry, returning extracted
    text and the stop reason.

    Args:
        client: Bedrock runtime client
        kwargs: Arguments for client.converse()
        max_retries: Maximum retry attempts
        raise_on_throttle: If True, raise BedrockThrottlingError after max retries
        step_name: Name of the current step for logging

    Returns:
        (text, stop_reason). stop_reason is the raw Bedrock value
        (e.g. 'end_turn', 'max_tokens') or '' when no response was returned.

    Raises:
        BedrockThrottlingError: If throttled after max retries and raise_on_throttle=True
        ClientError: For non-retryable AWS errors
    """
    response = _converse_with_retry(
        client=client,
        kwargs=kwargs,
        max_retries=max_retries,
        raise_on_throttle=raise_on_throttle,
        step_name=step_name,
    )
    if not response:
        return "", ""
    content = response.get('output', {}).get('message', {}).get('content', [])
    result = _extract_text(content)
    stop_reason = response.get('stopReason', '')
    logger.info(f"[BEDROCK] Extracted {len(result)} chars from response for step '{step_name}' (stop_reason={stop_reason})")
    return result, stop_reason


def _calculate_backoff(attempt: int) -> float:
    """Calculate exponential backoff delay with jitter."""
    delay = min(
        DEFAULT_BASE_DELAY * (2 ** attempt) + random.uniform(0, 1),
        DEFAULT_MAX_DELAY
    )
    return delay


def converse_chain(
    steps: list[dict],
    progress_callback: Callable[[int, str], None] | None = None,
    max_retries: int = DEFAULT_MAX_RETRIES,
    surface: str = DEFAULT_SURFACE,
    model_id: str | None = None,
) -> list[str]:
    """
    Execute a chain of LLM calls, each building on the previous.

    Each step can have:
        - system: System prompt
        - user: User message (use {previous} to inject previous result)
        - max_tokens: Max output tokens (default 4096)
        - thinking_budget: Extended thinking budget (default 0 = disabled)
        - step_name: Optional name for progress reporting
        - model_id/model: Optional explicit model for this step. Used only
          when the chain itself is not pinned with `model_id`.
        - surface: Optional per-step AI surface override (defaults to the
          chain-level `surface`). Inert whenever the step's model ends up
          explicit, because converse() gives an explicit model precedence
          over surface resolution; that includes every step of a chain
          called with a pinned `model_id`. Give a step a model or a
          surface, never both.

    Args:
        steps: List of step configurations
        progress_callback: Optional callback(progress: int, step: str) to report progress
        max_retries: Maximum retry attempts for throttling (default: 5)
        surface: AI surface whose configured model the steps resolve to when
            they don't set their own model (default: the neutral fallback).
        model_id: Explicit model ID pinned across every step (forwarded to
            converse(), where it takes precedence over step-level model and
            surface resolution).
            Callers that stamp "which model ran" into stored metadata resolve
            once and pin it here, so what was invoked and what was recorded
            cannot drift. When None, each step resolves from ``surface`` as
            before.

    Returns:
        List of results from each step
    """
    results = []
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
            except Exception as e:
                logger.warning(f"[CHAIN] Progress callback failed for step '{step_name}': {e}")
        
        system = step.get('system', '')
        user = step.get('user', '').replace('{previous}', context)
        thinking_budget = step.get('thinking_budget', 0)
        max_tokens = step.get('max_tokens', 4096)
        step_explicit_model_id = step.get('model_id') or step.get('model')
        step_model_id = model_id or step_explicit_model_id
        # An explicit model beats surface resolution inside converse(),
        # whether that model comes from the chain pin or from the step
        # itself. Every way this step loses that argument collapses into ONE
        # warning naming everything dropped, so an operator greps once
        # instead of matching several near-duplicate lines.
        inert_overrides = []
        if step_model_id is not None and step.get('surface'):
            inert_overrides.append(f"surface='{step['surface']}'")
        if model_id is not None and step_explicit_model_id:
            inert_overrides.append('model_id/model')
        if inert_overrides:
            winner = ('the chain-pinned model_id' if model_id is not None
                      else 'the step model_id/model')
            logger.warning(
                f"[CHAIN] Step '{step_name}' drops inert overrides "
                f"({', '.join(inert_overrides)}): {winner} is explicit and wins"
            )
        
        logger.info(f"[CHAIN] Step '{step_name}' config: max_tokens={max_tokens}, thinking_budget={thinking_budget}")
        logger.info(f"[CHAIN] Step '{step_name}' system_prompt length: {len(system)} chars")
        logger.info(f"[CHAIN] Step '{step_name}' user_prompt length: {len(user)} chars")
        
        step_start = time.time()
        try:
            result = converse(
                prompt=user,
                system_prompt=system,
                max_tokens=max_tokens,
                thinking_budget=thinking_budget,
                surface=step.get('surface', surface),
                max_retries=max_retries,
                step_name=step_name,
                model_id=step_model_id,
            )
            step_elapsed = time.time() - step_start
            logger.info(f"[CHAIN] Step '{step_name}' completed in {step_elapsed:.2f}s, output length: {len(result)} chars")
            results.append(result)
            context = result
        except Exception as e:
            step_elapsed = time.time() - step_start
            logger.error(f"[CHAIN] Step '{step_name}' FAILED after {step_elapsed:.2f}s: {type(e).__name__}: {e}")
            raise
    
    chain_elapsed = time.time() - chain_start
    logger.info(f"[CHAIN] LLM chain completed: {total_steps} steps in {chain_elapsed:.2f}s")
    return results


def _extract_text(content_blocks: list) -> str:
    """Extract text from Converse API content blocks."""
    return ''.join(block.get('text', '') for block in content_blocks if 'text' in block)



