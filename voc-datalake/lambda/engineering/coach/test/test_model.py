"""The coach's model port: one Bedrock Converse call on an allowed model, bounded in time and tokens."""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError, ReadTimeoutError

from engineering.coach.failure import CoachError
from engineering.coach.model import (
    ATTEMPTS,
    COACH_MODEL,
    CONNECT_TIMEOUT_SECONDS,
    MAX_ANSWER_TOKENS,
    READ_TIMEOUT_SECONDS,
    BedrockCoachModel,
    CoachReply,
    bounded_client,
)
from shared.model_config import ALLOWED_MODEL_IDS


def replying(answer: dict[str, Any]) -> MagicMock:
    client = MagicMock()
    client.converse.return_value = answer
    return client


def test_one_converse_call_on_the_allowed_model_capped_in_tokens() -> None:
    client = replying({'output': {'message': {'content': [{'text': '{"answer": '}, {'reasoningContent': {}},
                                                          {'text': 'true}'}]}}, 'stopReason': 'end_turn'})
    model = BedrockCoachModel(client=lambda: client)
    assert model.model_id == COACH_MODEL in ALLOWED_MODEL_IDS
    assert model('rules', 'evidence') == CoachReply('{"answer": true}', COACH_MODEL)
    client.converse.assert_called_once_with(
        modelId=COACH_MODEL, system=[{'text': 'rules'}], messages=[{'role': 'user', 'content': [{'text': 'evidence'}]}],
        inferenceConfig={'maxTokens': MAX_ANSWER_TOKENS})


@pytest.mark.parametrize('error', [
    ReadTimeoutError(endpoint_url='https://bedrock-runtime.us-east-1.amazonaws.com'),
    ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'slow down'}}, 'Converse'),
    ClientError({'Error': {'Code': 'ServiceUnavailableException', 'Message': 'try later'}}, 'Converse'),
    ConnectionResetError('the connection dropped'),
])
def test_the_call_is_made_once_whatever_fails(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    """A second attempt of up to 210 s would not fit the invocation's 5 minutes: nothing is tried again."""
    converse = pytest.importorskip('shared.converse')
    monkeypatch.setattr(converse.time, 'sleep', lambda _seconds: None)
    failing = MagicMock()
    failing.converse.side_effect = [error, {'output': {'message': {'content': [{'text': '{}'}]}}}]
    with pytest.raises(Exception):  # noqa: B017, PT011 (the error itself, or the sample's throttling error)
        BedrockCoachModel(client=lambda: failing)('rules', 'evidence')
    assert failing.converse.call_count == ATTEMPTS == 1


def test_a_reply_cut_at_the_cap_is_refused() -> None:
    client = replying({'output': {'message': {'content': [{'text': '{"instructions": "half'}]}},
                       'stopReason': 'max_tokens'})
    with pytest.raises(CoachError, match='ran past'):
        BedrockCoachModel(client=lambda: client)('rules', 'evidence')


def test_the_client_ends_the_call_well_inside_the_runtimes_limit_and_never_retries(
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    config = bounded_client().meta.config
    assert (config.read_timeout, config.connect_timeout, config.retries['total_max_attempts']) == (
        READ_TIMEOUT_SECONDS, CONNECT_TIMEOUT_SECONDS, 1)
    # voc-engineering-runtime's limit is 5 minutes: the call, connect included, ends well before it.
    assert READ_TIMEOUT_SECONDS + CONNECT_TIMEOUT_SECONDS <= 5 * 60 - 60


def test_only_an_allowed_model_is_used() -> None:
    with pytest.raises(CoachError, match="one of the deployment's allowed models"):
        BedrockCoachModel('some-unlisted-model')
    other = sorted(ALLOWED_MODEL_IDS)[0]
    assert BedrockCoachModel(other).model_id == other
