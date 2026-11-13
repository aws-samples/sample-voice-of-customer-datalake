"""The coach's model port: the Bedrock adapter's one call through the sample's Converse path, an allowed model."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from engineering.coach.failure import CoachError
from engineering.coach.model import COACH_MODEL, MAX_ANSWER_TOKENS, BedrockCoachModel, CoachReply
from shared.model_config import ALLOWED_MODEL_IDS


def test_bedrock_goes_through_the_samples_converse_path_in_one_call(monkeypatch: pytest.MonkeyPatch) -> None:
    converse = pytest.importorskip('shared.converse')
    fake = MagicMock(return_value=converse.ConverseResult(text='{"answer": true}', model_id=COACH_MODEL,
                                                          requested_model_id=COACH_MODEL))
    monkeypatch.setattr(converse, 'converse_detailed', fake)
    model = BedrockCoachModel()
    assert model.model_id == COACH_MODEL in ALLOWED_MODEL_IDS
    assert model('rules', 'evidence') == CoachReply('{"answer": true}', COACH_MODEL)
    fake.assert_called_once_with(prompt='evidence', system_prompt='rules', model_id=COACH_MODEL,
                                 surface='agent_reviewer', max_tokens=converse.with_thinking_headroom(MAX_ANSWER_TOKENS),
                                 max_continuations=0, step_name='engineering.coach')
    # Room for an adaptive-thinking model's thinking on top of the answer.
    assert fake.call_args.kwargs['max_tokens'] > MAX_ANSWER_TOKENS


def test_the_reply_names_the_model_that_answered_after_a_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    converse = pytest.importorskip('shared.converse')
    fallback = 'global.anthropic.claude-sonnet-5-5'
    served = converse.ConverseResult(text='{}', model_id=fallback, requested_model_id=COACH_MODEL)
    monkeypatch.setattr(converse, 'converse_detailed', MagicMock(return_value=served))
    assert BedrockCoachModel()('rules', 'evidence') == CoachReply('{}', fallback)
    # A result that names no model: the one asked for.
    monkeypatch.setattr(converse, 'converse_detailed', MagicMock(return_value=converse.ConverseResult(text='{}')))
    assert BedrockCoachModel()('rules', 'evidence').model_id == COACH_MODEL


def test_only_an_allowed_model_is_used() -> None:
    with pytest.raises(CoachError, match="one of the deployment's allowed models"):
        BedrockCoachModel('some-unlisted-model')
    other = sorted(ALLOWED_MODEL_IDS)[0]
    assert BedrockCoachModel(other).model_id == other
