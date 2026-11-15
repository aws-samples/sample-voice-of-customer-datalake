"""The coach's model, behind one port: one Amazon Bedrock Converse call, bounded in time (the tests use a fake).

One single-turn call per failure, made inside an invocation of voc-engineering-runtime (the run's retrospective,
``learning/loop.py``), whose limit is 5 minutes. So the call is bounded to end well before it, always:

- its own Bedrock client, with a read timeout of ``READ_TIMEOUT_SECONDS`` (200 s: Converse answers once the whole
  reply is written, so the read bounds the call), a connect timeout of ``CONNECT_TIMEOUT_SECONDS`` and no botocore
  retry (``total_max_attempts`` 1), never the shared client, whose read timeout is sized for the longest document
  writers; through ``shared.converse.bedrock_call_with_retry`` with one attempt (``ATTEMPTS``): nothing is tried
  again, a throttle and a dropped connection included, since a second attempt of up to 210 s would not fit the
  invocation's limit (a throttle is the learning loop's ``failed``, as any other error);
- one model, no capacity fallback chain and no continuation (a strict JSON answer must fit one call: its seam is
  lossy mid-JSON, shared/converse.py's "STRICT-JSON DOCTRINE");
- an output cap of ``MAX_ANSWER_TOKENS`` (thinking included), which a model writes well inside the read timeout.
  A reply cut at the cap is refused (``CoachError``), never read as an answer.

A call that runs past the read timeout raises botocore's ``ReadTimeoutError``; the learning loop records it as
``timed_out`` and never makes it again. The model is one of the deployment's allowed models (shared/model_config.py),
by default the agents' reviewer surface's, sent as the deployment's inference scope names it (``eu.`` in an EU
deployment: ``scope_bedrock_client``). The reply names the model that answered (the one asked: there is no
fallback), which the proposal records (D4).
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import cache
from typing import Any, Final

from engineering.coach.failure import CoachError
from shared.model_config import ALLOWED_MODEL_IDS, SURFACE_DEFAULTS

COACH_SURFACE: Final = 'agent_reviewer'
COACH_MODEL: Final = SURFACE_DEFAULTS[COACH_SURFACE]
#: The answer's tokens, thinking included: the role's instructions and examples rewritten whole, at a size a model
#: writes well inside the read timeout.
MAX_ANSWER_TOKENS: Final = 8_000
#: The call's bound: well under voc-engineering-runtime's 5-minute limit, with room for the invocation's reads and
#: writes before and after it.
READ_TIMEOUT_SECONDS: Final = 200
CONNECT_TIMEOUT_SECONDS: Final = 10
#: The call's attempts in all (``bedrock_call_with_retry``): one, so the call never outlives the invocation.
ATTEMPTS: Final = 1
#: Bedrock's stop reason for a reply cut at the cap.
CUT_AT_CAP: Final = 'max_tokens'


@dataclass(frozen=True)
class CoachReply:
    """A model's answer, and the model that gave it."""

    text: str
    model_id: str


#: What the coach asks a model: ``(system, prompt)`` in, the reply out (one call, nothing else kept).
type CoachModel = Callable[[str, str], CoachReply]


@cache
def bounded_client() -> Any:
    """A Bedrock Runtime client of the coach's own, built once per container: the read timeout, no botocore retry,
    the deployment's inference scope."""
    # Imported here: the coach's other modules stay importable where the Lambda layers are not installed.
    import boto3
    from botocore.config import Config

    from shared.model_config import scope_bedrock_client
    config = Config(read_timeout=READ_TIMEOUT_SECONDS, connect_timeout=CONNECT_TIMEOUT_SECONDS,
                    # One attempt in all (botocore's ``max_attempts`` counts retries, ``total_max_attempts`` the call).
                    retries={'total_max_attempts': 1, 'mode': 'standard'})
    return scope_bedrock_client(boto3.client('bedrock-runtime', config=config))


def _text(answer: dict[str, Any]) -> str:
    content = answer.get('output', {}).get('message', {}).get('content', [])
    return ''.join(block['text'] for block in content if isinstance(block, dict) and isinstance(block.get('text'), str))


class BedrockCoachModel:
    """Amazon Bedrock's Converse, one call on one allowed model, bounded in time and tokens."""

    def __init__(self, model_id: str = COACH_MODEL, client: Callable[[], Any] = bounded_client) -> None:
        if model_id not in ALLOWED_MODEL_IDS:
            raise CoachError("the coach's model is one of the deployment's allowed models")
        self.model_id = model_id
        self._client = client

    def __call__(self, system: str, prompt: str) -> CoachReply:
        from shared.converse import bedrock_call_with_retry
        client = self._client()
        # One attempt: a second one, whatever the first's error, could run past the invocation's limit.
        answer = bedrock_call_with_retry(
            lambda: client.converse(
                modelId=self.model_id, system=[{'text': system}],
                messages=[{'role': 'user', 'content': [{'text': prompt}]}],
                inferenceConfig={'maxTokens': MAX_ANSWER_TOKENS}),
            max_retries=ATTEMPTS, step_name='engineering.coach',
            call_label='the coach\'s Converse call') or {}   # (None only with raise_on_throttle off, never here)
        if answer.get('stopReason') == CUT_AT_CAP:
            raise CoachError(f"the coach's answer ran past its {MAX_ANSWER_TOKENS} tokens: nothing is proposed")
        return CoachReply(_text(answer), self.model_id)
