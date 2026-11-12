"""Model calls behind one interface: the Bedrock client for real runs (the tests use a recorded fake).

Every call is a fresh single-turn request: no agent sees another's conversation, which is what makes the final
go independent of the reviewers and the reviewers independent of each other. The caps on tokens and cost are the
run's (the supervisor's), not the gate's.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from shared.model_config import SURFACE_DEFAULTS

#: The models come from the one table of built-in defaults (shared/model_config.py), by the agents' surfaces: the
#: reviewers work as the agents' crewmates do, the final go decides as their final reviewer does.
REVIEW_MODEL = SURFACE_DEFAULTS['agent_worker']
FINAL_GO_MODEL = SURFACE_DEFAULTS['agent_reviewer']


@dataclass(frozen=True)
class ModelRequest:
    agent: str
    model_id: str
    system: str
    prompt: str
    max_tokens: int = 4096


class ModelClient(Protocol):
    def complete(self, request: ModelRequest) -> str: ...


@dataclass
class CountingModel:
    """Counts the calls made through ``inner``, for the gate record."""

    inner: ModelClient
    calls: int = 0

    def complete(self, request: ModelRequest) -> str:
        self.calls += 1
        return self.inner.complete(request)


class BedrockModel:
    """Amazon Bedrock through the sample's one Converse path (shared.converse: retries, the model profile)."""

    def __init__(self) -> None:
        # Imported here, before any check runs: nothing a repository's dependency step installs is imported later.
        from shared import converse

        self._converse = converse.converse
        self._headroom = converse.with_thinking_headroom

    def complete(self, request: ModelRequest) -> str:
        # The answer is strict JSON: it must fit one call (no continuation seam), with room for adaptive thinking.
        return self._converse(prompt=request.prompt, system_prompt=request.system, model_id=request.model_id,
                              max_tokens=self._headroom(request.max_tokens), max_continuations=0,
                              step_name=f'quality_gate.{request.agent}')
