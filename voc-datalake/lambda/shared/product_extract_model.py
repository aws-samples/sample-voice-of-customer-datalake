"""The product extract's model call (7.104.00, docs/project-workspace.md → Product tab; shared/product_extract.py).

ONE ConverseStream request per model tried, for three reasons: a max-effort answer can outlive the 840 s read timeout
of one non-streaming read (shared/aws.py ``BEDROCK_READ_TIMEOUT_SECONDS``), the job stops cleanly at its own deadline,
and ``usage_meter`` meters no Python stream, so the stream's own usage is logged here (``log_stream_usage``).

The request (``build_blocks_request``, so the scoped invocation id and no ``temperature``) carries, in
``additionalModelRequestFields``:

* ``thinking: {type: adaptive, display: summarized}`` for a model that takes an effort (every Claude 4.6 and later;
  Haiku 4.5 takes neither). Summarized, so the thinking streams as deltas and the deadline is read during it too;
* ``output_config.effort`` only where ``supports_effort`` allows that level (``[BEDROCK] Effective params`` says
  which); the engineering harness has sent ``output_config.effort`` through Converse since 7.58.01;
* ``output_config.format`` (``json_schema``, the proposal's schema). Whether Converse passes it to Claude is not
  documented (botocore's model has Converse's own ``outputConfig.textFormat`` and ``outputConfig.effort``, which the
  Lambda runtime's boto3 may not know yet): a ValidationException at the stream's start that names it, or (7.109.01)
  the grammar Bedrock compiles it into (``_FORMAT_WORDS``), before any token is billed, is answered by the same
  request without it once (``structured`` False); the prompt describes the same JSON either way and
  shared/product_extract.py validates every answer.

``additionalModelResponseFieldPaths`` asks for ``/stop_details``, so a refusal's category and explanation arrive in
``messageStop.additionalModelResponseFields`` where Bedrock forwards them. A refusal is a stop reason of
``REFUSAL_STOP_REASONS``: ``refusal`` (Claude's own, which botocore's ``StopReason`` enum does not list) or
``content_filtered``.

A model that cannot serve now (capacity, shared/model_fallback.py) hands the request to the next model of the
caller's chain before the stream starts. A heartbeat thread (``_Watch``) reports progress every ``HEARTBEAT_SECONDS``
and closes the stream at the deadline: the call then raises ``ModelTimedOut``. The thread is stopped and joined before
the call returns or raises, and a progress write never reopens a finished job (shared/jobs.py
``JobContext.update_progress``). A failure inside the stream
(Bedrock's stream exceptions) propagates as it is.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from botocore.exceptions import ClientError

from shared import usage_meter
from shared.converse import bedrock_call_with_retry, build_blocks_request
from shared.logging import logger
from shared.model_config import PRODUCT_EXTRACT_SURFACE as SURFACE
from shared.model_config import invocation_model_id, supports_effort
from shared.model_fallback import run_with_fallback

__all__ = [
    'FINISH_RESERVE_SECONDS', 'MODEL_BUDGET_SECONDS', 'ExtractCall', 'ModelAnswer', 'ModelTimedOut', 'stream_answer',
]

#: The answer's output cap, thinking included (the proposal is about 20 K characters; a max-effort think is long).
MAX_TOKENS: Final = 64_000
#: How often the job's progress moves while the model thinks: well inside the Background Jobs panel's 10-minute
#: ``STALE_THRESHOLD_MS``, so a live extract never reads as stale.
HEARTBEAT_SECONDS: Final = 30
#: The model's share of the document generator's 15 minutes: at most 12.5 minutes, and never less than this reserve
#: before the invocation ends (the proposal's validation, its write and the job's own record).
MODEL_BUDGET_SECONDS: Final = 750
FINISH_RESERVE_SECONDS: Final = 120
OPERATION: Final = 'ConverseStream'
#: The stop reasons that mean the model declined: Claude's own ``refusal``, and Bedrock's ``content_filtered``.
REFUSAL_STOP_REASONS: Final = frozenset({'refusal', 'content_filtered'})
#: Claude's refusal details (category, explanation), asked for from the model's own response.
STOP_DETAILS_PATH: Final = '/stop_details'
_THINKING: Final = {'type': 'adaptive', 'display': 'summarized'}
#: A ValidationException that names one of these refused the request's ``output_config.format``: the field itself,
#: or (7.109.01) the grammar Bedrock compiles a schema into, "The compiled grammar is too large, which would cause
#: performance issues. Simplify your tool schemas or reduce the number of strict tools.", which names neither.
_FORMAT_WORDS: Final = ('output_config', 'json_schema', 'format', 'grammar', 'tool schema')


class ModelTimedOut(Exception):
    """The deadline passed while the model was answering; the stream was closed."""


@dataclass(frozen=True)
class Refusal:
    """A declined request: Claude's category and explanation, each None when Bedrock did not forward it."""

    category: str | None
    explanation: str | None


@dataclass(frozen=True)
class ExtractCall:
    """What every model of the chain is asked: the system prompt, the user turn's blocks, the effort, the schema."""

    system: str
    content: tuple[Mapping[str, Any], ...]
    effort: str
    schema: Mapping[str, Any]


@dataclass(frozen=True)
class ModelAnswer:
    """One model's answer: its text, why it stopped, a refusal's details, its usage and what the request carried."""

    model_id: str
    text: str
    stop_reason: str
    refusal: Refusal | None
    input_tokens: int
    output_tokens: int
    effort: str | None
    structured: bool


@dataclass(frozen=True)
class _Opened:
    model_id: str
    stream: Any
    effort: str | None
    structured: bool


def request_fields(model_id: str, effort: str, schema: Mapping[str, Any], *, structured: bool) -> dict[str, Any]:
    """The request's ``additionalModelRequestFields`` for ``model_id``: adaptive thinking for a model that takes an
    effort, the effort where the model takes that level, and the JSON schema when ``structured``."""
    output: dict[str, Any] = {}
    if supports_effort(model_id, effort):
        output['effort'] = effort
    if structured:
        output['format'] = {'type': 'json_schema', 'schema': dict(schema)}
    fields: dict[str, Any] = {}
    if supports_effort(model_id, 'high'):
        fields['thinking'] = dict(_THINKING)
    if output:
        fields['output_config'] = output
    return fields


def _format_refused(error: ClientError) -> bool:
    """A ValidationException naming the request's structured output: answered by the request without it."""
    body = error.response.get('Error', {})
    message = str(body.get('Message', '')).lower()
    return body.get('Code') == 'ValidationException' and any(word in message for word in _FORMAT_WORDS)


def _start(client: Any, call: ExtractCall, model_id: str, *, structured: bool) -> _Opened:
    """The stream on ``model_id`` (throttles retried; a refused schema raised as is, unlogged as an error)."""
    kwargs = build_blocks_request(model_id, messages=[{'role': 'user', 'content': list(call.content)}],
                                  system_prompt=call.system, max_tokens=MAX_TOKENS)
    fields = request_fields(model_id, call.effort, call.schema, structured=structured)
    if fields:
        kwargs['additionalModelRequestFields'] = fields
    kwargs['additionalModelResponseFieldPaths'] = [STOP_DETAILS_PATH]
    effort = fields.get('output_config', {}).get('effort')
    logger.info(f"[BEDROCK] Effective params: temperature=omitted (not asked), "
                f"thinking={'adaptive' if 'thinking' in fields else 'omitted'}, effort={effort or 'omitted'}, "
                f"format={'json_schema' if structured else 'prompt'}", extra={'model_id': model_id})
    response = bedrock_call_with_retry(lambda: client.converse_stream(**kwargs), step_name=SURFACE,
                                       call_label=OPERATION, is_expected_error=_format_refused)
    return _Opened(model_id, response['stream'], effort, structured)


def _open(client: Any, call: ExtractCall, model_id: str) -> _Opened:
    """The stream on ``model_id`` with the schema, else, when Bedrock refused the schema, without it."""
    try:
        return _start(client, call, model_id, structured=True)
    except ClientError as error:
        if not _format_refused(error):
            raise
        logger.warning('[BEDROCK] output_config.format refused; the extract asks for its JSON in the prompt',
                       extra={'model_id': model_id,
                              'reason': str(error.response.get('Error', {}).get('Message', ''))[:300]})
    return _start(client, call, model_id, structured=False)


class _Watch(threading.Thread):
    """Every ``HEARTBEAT_SECONDS``, ``on_beat(fraction of the budget used)``; at the deadline, the stream closed."""

    def __init__(self, stream: Any, start: float, deadline: float, on_beat: Callable[[float], None],
                 clock: Callable[[], float], beat_seconds: float) -> None:
        super().__init__(daemon=True, name='product-extract-watch')
        self._stream, self._start, self._deadline = stream, start, deadline
        self._on_beat, self._clock, self._beat_seconds = on_beat, clock, beat_seconds
        self._stopped = threading.Event()
        self.timed_out = False

    def run(self) -> None:
        while not self._stopped.wait(min(self._beat_seconds, max(0.0, self._deadline - self._clock()))):
            now = self._clock()
            if now >= self._deadline:
                self.timed_out = True
                _close(self._stream)
                return
            span = self._deadline - self._start
            try:
                self._on_beat((now - self._start) / span if span > 0 else 1.0)
            except Exception:  # noqa: BLE001 - a missed heartbeat must never end the extract
                logger.warning('The product extract could not record its progress')

    def stop(self) -> None:
        self._stopped.set()


def _close(stream: Any) -> None:
    close = getattr(stream, 'close', None)
    if callable(close):
        try:
            close()
        except Exception:  # noqa: BLE001 - the stream is abandoned either way
            logger.warning('The product extract stream did not close cleanly')


@dataclass
class _Reading:
    text: list[str]
    stop_reason: str = ''
    response_fields: Mapping[str, Any] | None = None
    usage: Mapping[str, Any] | None = None


def _read(events: Iterable[Mapping[str, Any]], reading: _Reading, clock: Callable[[], float],
          deadline: float, watch: _Watch) -> None:
    for event in events:
        if watch.timed_out or clock() >= deadline:
            watch.timed_out = True
            return
        delta = event.get('contentBlockDelta', {}).get('delta', {})
        if isinstance(delta.get('text'), str):
            reading.text.append(delta['text'])
        stop = event.get('messageStop')
        if isinstance(stop, Mapping):
            reading.stop_reason = str(stop.get('stopReason') or '')
            reading.response_fields = stop.get('additionalModelResponseFields')
        metadata = event.get('metadata')
        if isinstance(metadata, Mapping):
            reading.usage = metadata.get('usage')


def _refusal(reading: _Reading) -> Refusal | None:
    if reading.stop_reason not in REFUSAL_STOP_REASONS:
        return None
    details = (reading.response_fields or {}).get('stop_details')
    details = details if isinstance(details, Mapping) else {}
    category, explanation = details.get('category'), details.get('explanation')
    return Refusal(category if isinstance(category, str) and category else None,
                   explanation[:300] if isinstance(explanation, str) and explanation else None)


def _count(usage: Mapping[str, Any] | None, key: str) -> int:
    value = (usage or {}).get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def stream_answer(client: Any, call: ExtractCall, models: Sequence[str], *, deadline: float,
                  on_beat: Callable[[float], None], clock: Callable[[], float] = time.monotonic,
                  beat_seconds: float = HEARTBEAT_SECONDS) -> ModelAnswer:
    """``call`` on the first of ``models`` that can serve now (shared/model_fallback.py), read to its end or to
    ``deadline`` (``clock``'s time): its answer, or ``ModelTimedOut`` once the deadline closed the stream."""
    _model, opened = run_with_fallback(tuple(models), SURFACE, lambda model: _open(client, call, model))
    start = clock()
    watch = _Watch(opened.stream, start, deadline, on_beat, clock, beat_seconds)
    reading = _Reading(text=[])
    watch.start()
    try:
        _read(opened.stream, reading, clock, deadline, watch)
    except Exception as error:
        if watch.timed_out:
            raise ModelTimedOut from error
        raise
    finally:
        # Joined, so no heartbeat lands after the call: the job's own end (completed or failed) is its last write.
        watch.stop()
        watch.join()
    if watch.timed_out:
        _close(opened.stream)
        raise ModelTimedOut
    answer = ModelAnswer(opened.model_id, ''.join(reading.text), reading.stop_reason, _refusal(reading),
                         _count(reading.usage, 'inputTokens'), _count(reading.usage, 'outputTokens'), opened.effort,
                         opened.structured)
    if reading.usage is not None:
        usage_meter.log_stream_usage(invocation_model_id(opened.model_id), OPERATION,
                                     input_tokens=answer.input_tokens, output_tokens=answer.output_tokens)
    return answer
