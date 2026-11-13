"""The coach's model, behind one port: Amazon Bedrock through the sample's Converse path (the tests use a fake).

One single-turn call per failure. The answer is strict JSON, so it must fit one call: no continuation (its seam is
lossy mid-JSON, shared/converse.py's "STRICT-JSON DOCTRINE"), and room for an adaptive-thinking model's thinking on
top of the answer's own tokens. The model is one of the deployment's allowed models (shared/model_config.py), by
default the agents' reviewer's surface's, and the call names that surface, so a capacity fallback stays on its
chain. The reply says which model actually answered (``converse_detailed``), which the proposal records (D4).
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

from engineering.coach.failure import CoachError
from shared.model_config import ALLOWED_MODEL_IDS, SURFACE_DEFAULTS

COACH_SURFACE: Final = 'agent_reviewer'
COACH_MODEL: Final = SURFACE_DEFAULTS[COACH_SURFACE]
#: The answer's own tokens: the largest skill's instructions and examples, rewritten whole.
MAX_ANSWER_TOKENS: Final = 16_000


@dataclass(frozen=True)
class CoachReply:
    """A model's answer, and the model that gave it (another than asked when a capacity fallback served it)."""

    text: str
    model_id: str


#: What the coach asks a model: ``(system, prompt)`` in, the reply out (one call, nothing else kept).
type CoachModel = Callable[[str, str], CoachReply]


class BedrockCoachModel:
    """Amazon Bedrock through shared.converse (its retries, the model profile, the surface's capacity fallback)."""

    def __init__(self, model_id: str = COACH_MODEL) -> None:
        if model_id not in ALLOWED_MODEL_IDS:
            raise CoachError("the coach's model is one of the deployment's allowed models")
        # Imported here: the coach's other modules stay importable where the Lambda layers are not installed.
        from shared import converse

        self.model_id = model_id
        self._converse = converse.converse_detailed
        self._headroom = converse.with_thinking_headroom

    def __call__(self, system: str, prompt: str) -> CoachReply:
        result = self._converse(prompt=prompt, system_prompt=system, model_id=self.model_id,
                                surface=COACH_SURFACE, max_tokens=self._headroom(MAX_ANSWER_TOKENS),
                                max_continuations=0, step_name='engineering.coach')
        return CoachReply(result.text, result.model_id or self.model_id)
