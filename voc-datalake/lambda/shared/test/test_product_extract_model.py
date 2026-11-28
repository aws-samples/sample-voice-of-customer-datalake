"""The product extract's model call (7.104.00, shared/product_extract_model.py): one ConverseStream per model tried.

Pinned: what the request carries per model (adaptive thinking and the effort only where the model takes them, the
JSON schema, no temperature, the refusal details asked for); the schema dropped once when Bedrock refuses it; the
answer's text, stop reason, refusal and usage read from the stream, the usage logged as ConverseStream; the heartbeat;
the deadline closing the stream (``ModelTimedOut``); a model without capacity handing over before the stream starts.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError

from shared import model_fallback
from shared.product_extract_model import (
    MAX_TOKENS,
    ExtractCall,
    ModelTimedOut,
    Refusal,
    request_fields,
    stream_answer,
)

SONNET55 = 'global.anthropic.claude-sonnet-5-5'
SONNET5 = 'global.anthropic.claude-sonnet-5'
SONNET46 = 'global.anthropic.claude-sonnet-4-6'
HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
SCHEMA = {'type': 'object', 'properties': {}, 'additionalProperties': False}
CALL = ExtractCall(system='Rules', content=({'text': 'Sources'},), effort='max', schema=SCHEMA)


@pytest.fixture(autouse=True)
def _no_cooldowns():
    model_fallback.cooldown_until.clear()
    yield
    model_fallback.cooldown_until.clear()


def _events(text: str = '{"fields": {}}', stop: str = 'end_turn', response_fields: dict | None = None,
            usage: dict | None = None) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = [{'messageStart': {'role': 'assistant'}},
                                    {'contentBlockDelta': {'delta': {'reasoningContent': {'text': 'thinking'}}}}]
    events += [{'contentBlockDelta': {'delta': {'text': part}}} for part in (text[:5], text[5:])]
    events.append({'messageStop': {'stopReason': stop, 'additionalModelResponseFields': response_fields or {}}})
    events.append({'metadata': {'usage': usage or {'inputTokens': 1200, 'outputTokens': 340}}})
    return events


class FakeStream:
    """An event stream; ``hold`` blocks it after its first event until it is closed (a model still thinking)."""

    def __init__(self, events: list[dict[str, Any]], hold: bool = False) -> None:
        self.events, self.hold, self.closed = events, hold, threading.Event()

    def __iter__(self) -> Iterator[dict[str, Any]]:
        for index, event in enumerate(self.events):
            if self.hold and index == 1:
                self.closed.wait(5)
                raise ConnectionError('the stream was closed')
            yield event

    def close(self) -> None:
        self.closed.set()


class FakeBedrock:
    """``converse_stream`` answering each call in turn: a stream, or an error to raise."""

    def __init__(self, *answers: Any) -> None:
        self.answers, self.calls = list(answers), []

    def converse_stream(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return {'stream': answer}


def _error(code: str, message: str) -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': message}}, 'ConverseStream')


def _ticks(*values: float):
    """A clock answering ``values`` in turn, then the last one."""
    remaining = list(values)

    def clock() -> float:
        return remaining.pop(0) if len(remaining) > 1 else remaining[0]
    return clock


def _ask(client: FakeBedrock, models=(SONNET55,), **kwargs: Any):
    kwargs.setdefault('deadline', 1_000.0)
    kwargs.setdefault('on_beat', lambda _fraction: None)
    kwargs.setdefault('clock', _ticks(0.0))
    with patch('shared.product_extract_model.usage_meter.log_stream_usage') as usage:
        answer = stream_answer(client, CALL, models, **kwargs)
    return answer, usage


class TestTheRequestFields:
    def test_sonnet_55_thinks_adaptively_at_max_with_the_schema(self):
        assert request_fields(SONNET55, 'max', SCHEMA, structured=True) == {
            'thinking': {'type': 'adaptive', 'display': 'summarized'},
            'output_config': {'effort': 'max', 'format': {'type': 'json_schema', 'schema': SCHEMA}}}

    def test_haiku_45_gets_no_thinking_and_no_effort(self):
        assert request_fields(HAIKU45, 'max', SCHEMA, structured=True) == {
            'output_config': {'format': {'type': 'json_schema', 'schema': SCHEMA}}}

    def test_sonnet_46_gets_no_xhigh(self):
        assert request_fields(SONNET46, 'xhigh', SCHEMA, structured=False) == {
            'thinking': {'type': 'adaptive', 'display': 'summarized'}}

    def test_without_the_schema_only_the_effort_is_asked(self):
        assert request_fields(SONNET55, 'xhigh', SCHEMA, structured=False)['output_config'] == {'effort': 'xhigh'}


class TestTheRequest:
    def test_it_streams_with_no_temperature_its_cap_and_the_refusal_details(self):
        client = FakeBedrock(FakeStream(_events()))
        _ask(client)
        [request] = client.calls
        assert request['modelId'] == SONNET55
        assert request['inferenceConfig'] == {'maxTokens': MAX_TOKENS}
        assert request['system'] == [{'text': 'Rules'}]
        assert request['messages'] == [{'role': 'user', 'content': [{'text': 'Sources'}]}]
        assert request['additionalModelResponseFieldPaths'] == ['/stop_details']
        assert request['additionalModelRequestFields']['output_config']['effort'] == 'max'

    @staticmethod
    def _asked_without_the_schema_after(message: str):
        """The answer to a call whose first request Bedrock refused with ``message``: the requests' output configs
        (with the schema, then without it) and the answer."""
        client = FakeBedrock(_error('ValidationException', message), FakeStream(_events()))
        answer, _usage = _ask(client)
        return [call['additionalModelRequestFields']['output_config'] for call in client.calls], answer

    def test_a_refused_schema_is_asked_again_without_it_once(self):
        configs, answer = self._asked_without_the_schema_after('output_config.format: Extra inputs are not permitted')
        assert configs == [{'effort': 'max', 'format': {'type': 'json_schema', 'schema': SCHEMA}}, {'effort': 'max'}]
        assert (answer.structured, answer.text) == (False, '{"fields": {}}')

    def test_a_schema_bedrock_compiled_into_a_grammar_too_large_is_asked_again_without_it_once(self):
        # The first live extract on a deployment (7.104.00): Bedrock refused the schema with this message, which named
        # none of the format words, so the job failed instead of asking without the schema.
        configs, answer = self._asked_without_the_schema_after(
            'The model returned the following errors: The compiled grammar is too large, which would cause performance '
            'issues. Simplify your tool schemas or reduce the number of strict tools.')
        assert configs == [{'effort': 'max', 'format': {'type': 'json_schema', 'schema': SCHEMA}}, {'effort': 'max'}]
        assert answer.structured is False

    def test_another_validation_error_is_not_retried(self):
        client = FakeBedrock(_error('ValidationException', 'Input is too long for requested model'))
        with pytest.raises(ClientError):
            _ask(client)
        assert len(client.calls) == 1

    def test_a_model_without_capacity_hands_over_before_the_stream(self):
        client = FakeBedrock(_error('AccessDeniedException', "You don't have access to the model"),
                             FakeStream(_events()))
        with patch('shared.model_fallback.record_fallback'):
            answer, _usage = _ask(client, models=(SONNET55, SONNET5))
        assert (answer.model_id, client.calls[-1]['modelId']) == (SONNET5, SONNET5)


class TestTheAnswer:
    def test_it_joins_the_text_and_reads_its_stop_and_usage(self):
        answer, usage = _ask(FakeBedrock(FakeStream(_events('{"fields": {"a": 1}}'))))
        assert (answer.text, answer.stop_reason, answer.refusal) == ('{"fields": {"a": 1}}', 'end_turn', None)
        assert (answer.input_tokens, answer.output_tokens, answer.effort, answer.structured) == (1200, 340, 'max', True)
        usage.assert_called_once_with(SONNET55, 'ConverseStream', input_tokens=1200, output_tokens=340)

    def test_a_refusal_carries_its_category_and_explanation(self):
        details = {'stop_details': {'type': 'refusal', 'category': 'cyber', 'explanation': 'x' * 400}}
        answer, _usage = _ask(FakeBedrock(FakeStream(_events('', 'refusal', details))))
        assert answer.refusal == Refusal('cyber', 'x' * 300)

    def test_content_filtered_is_a_refusal_without_details(self):
        answer, _usage = _ask(FakeBedrock(FakeStream(_events('', 'content_filtered'))))
        assert answer.refusal == Refusal(None, None)

    def test_a_cut_answer_says_so(self):
        answer, _usage = _ask(FakeBedrock(FakeStream(_events('{"fie', 'max_tokens'))))
        assert (answer.stop_reason, answer.refusal) == ('max_tokens', None)


class TestTheDeadline:
    def test_the_watch_closes_a_stream_still_thinking_at_the_deadline(self):
        stream = FakeStream(_events(), hold=True)
        with pytest.raises(ModelTimedOut):
            _ask(FakeBedrock(stream), deadline=10.0, clock=_ticks(0.0, 0.0, 11.0))
        assert stream.closed.is_set()

    def test_an_event_after_the_deadline_ends_the_read(self):
        stream = FakeStream(_events())
        with pytest.raises(ModelTimedOut), patch('shared.product_extract_model._Watch.run'):
            _ask(FakeBedrock(stream), deadline=10.0, clock=_ticks(0.0, 0.0, 11.0))
        assert stream.closed.is_set()

    def test_no_heartbeat_lands_after_the_call_returns(self):
        # Review Q3 (7.104.00 round 1): the watch was stopped but not joined, so a beat under way could write the job's
        # progress after the call returned, and after the job's own end (completed or failed).
        order: list[str] = []
        beating = threading.Event()

        class Gated(FakeStream):
            def __iter__(self) -> Iterator[dict[str, Any]]:
                yield self.events[0]
                beating.wait(5)
                yield from self.events[1:]

        def slow_beat(_fraction: float) -> None:
            if order:
                return
            order.append('beat')
            beating.set()
            time.sleep(0.2)
            order.append('beat done')
        _ask(FakeBedrock(Gated(_events())), deadline=time.monotonic() + 100, on_beat=slow_beat, clock=time.monotonic,
             beat_seconds=0.001)
        order.append('returned')
        assert order == ['beat', 'beat done', 'returned']
        assert [thread for thread in threading.enumerate() if thread.name == 'product-extract-watch'] == []

    def test_the_heartbeat_reports_the_share_of_the_budget_used(self):
        beats: list[float] = []
        released = threading.Event()

        class Gated(FakeStream):
            def __iter__(self) -> Iterator[dict[str, Any]]:
                yield self.events[0]
                released.wait(5)
                yield from self.events[1:]

        def beat(fraction: float) -> None:
            beats.append(fraction)
            if len(beats) == 2:
                released.set()
        answer, _usage = _ask(FakeBedrock(Gated(_events())), deadline=100.0, on_beat=beat,
                              clock=_ticks(0.0, 0.0, 25.0, 25.0, 50.0, 50.0, 60.0), beat_seconds=0.001)
        assert beats[:2] == [0.25, 0.5]
        assert answer.text == '{"fields": {}}'
