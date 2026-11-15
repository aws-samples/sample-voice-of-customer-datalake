"""The model interface: the recorded fake, the call counter, and the Bedrock adapter's one call."""
from __future__ import annotations

from typing import Any

import pytest

from engineering.quality_gate.models import BedrockModel, CountingModel, ModelRequest
from engineering.quality_gate.test.gate_fakes import RecordedModel

REQUEST = ModelRequest(agent='reviewer:quality', model_id='m-1', system='rules', prompt='diff', max_tokens=100)


def test_the_recorded_model_answers_in_order_and_records_every_request():
    model = RecordedModel({'reviewer:quality': ['first', 'second']})
    assert [model.complete(REQUEST), model.complete(REQUEST)] == ['first', 'second']
    assert model.requests == [REQUEST, REQUEST]
    with pytest.raises(AssertionError, match=r"no recorded reply left for 'reviewer:quality' \(call 3\)"):
        model.complete(REQUEST)


def test_the_counter_counts_every_call():
    counting = CountingModel(RecordedModel({'reviewer:quality': ['a', 'b']}))
    assert [counting.complete(REQUEST), counting.complete(REQUEST)] == ['a', 'b']
    assert counting.calls == 2


def test_bedrock_goes_through_the_samples_converse_path(monkeypatch):
    converse = pytest.importorskip('shared.converse')
    calls: list[dict[str, Any]] = []

    def fake(**kwargs: Any) -> str:
        calls.append(kwargs)
        return 'answer'

    monkeypatch.setattr(converse, 'converse', fake)
    assert BedrockModel().complete(REQUEST) == 'answer'
    assert calls == [{'prompt': 'diff', 'system_prompt': 'rules', 'model_id': 'm-1',
                      'max_tokens': converse.with_thinking_headroom(100), 'max_continuations': 0,
                      'step_name': 'quality_gate.reviewer:quality'}]
    assert calls[0]['max_tokens'] > 100
