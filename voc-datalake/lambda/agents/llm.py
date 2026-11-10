"""Model calls for a crew role, budgeted per run.

Role → surface: orchestrator → ``agent_orchestrator`` (Opus 5.5), worker →
``agent_worker`` (Sonnet 5.5), reviewer → ``agent_reviewer`` (Opus 5.5), persona
→ ``agent_persona`` (Sonnet 5.5). An agent's ``models`` override wins when it
names an allowlisted model; anything else falls back to the surface, which the
Settings picker controls. Model ids never appear in this package.

Every call first reserves one call from the run's budget
(``store.reserve_model_call``) — a refused reservation raises
``store.BudgetExhausted`` before Bedrock is touched.
"""
from __future__ import annotations

import json
from typing import Any

from agents import store
from agents.fields import dict_field
from shared.converse import converse, with_thinking_headroom
from shared.llm_json import first_json_object
from shared.model_config import ALLOWED_MODEL_IDS

ROLE_SURFACES = {
    'orchestrator': 'agent_orchestrator',
    'worker': 'agent_worker',
    'reviewer': 'agent_reviewer',
    'persona': 'agent_persona',
}
#: Thinking room added to every agent call. Agent steps reason over up to ~30,000 characters of
#: reviews and think far more than a one-review enrichment: live-caught, the aggregate step thought
#: for 40 s and stopped at maxTokens=4548 with 75 characters written. The nodes Lambda runs 900 s.
AGENT_THINKING_HEADROOM = 8192


def model_override(agent: dict, role: str) -> str | None:
    models = dict_field(agent, 'models')
    candidate = models.get(role)
    return candidate if isinstance(candidate, str) and candidate in ALLOWED_MODEL_IDS else None


def reserve(agent: dict, run_id: str) -> None:
    """Take one call from the run's budget (raises ``store.BudgetExhausted``)."""
    store.reserve_model_call(agent, run_id, store.max_calls_for(agent))


def invoke(agent: dict, role: str, prompt: str, *, system_prompt: str = '',
           max_tokens: int = 2000, step_name: str = 'agent') -> str:
    """The model call itself, WITHOUT a reservation — callers must ``reserve`` first.

    *max_tokens* is the ANSWER size: the call adds thinking headroom
    (``shared.converse.with_thinking_headroom``). Every role defaults to an
    adaptive-thinking model (Opus / Sonnet 5.5), whose thinking counts against
    maxTokens, and most nodes parse strict JSON from one call — live-caught: the
    aggregate step returned 0 characters and the run failed "not valid JSON".

    Split out so the persona panel can reserve on its main thread (boto3
    resources are not thread-safe) and then call concurrently.
    """
    if role not in ROLE_SURFACES:
        raise ValueError(f'unknown role {role}')
    return converse(
        prompt=prompt,
        system_prompt=system_prompt,
        max_tokens=with_thinking_headroom(max_tokens, AGENT_THINKING_HEADROOM),
        temperature=None,
        model_id=model_override(agent, role),
        surface=ROLE_SURFACES[role],
        step_name=step_name,
        max_continuations=0,
    )


def ask(agent: dict, run_id: str, role: str, prompt: str, *, system_prompt: str = '',
        max_tokens: int = 2000, step_name: str = 'agent') -> str:
    """One budgeted model call for ``role``; returns the text."""
    if role not in ROLE_SURFACES:
        raise ValueError(f'unknown role {role}')
    reserve(agent, run_id)
    return invoke(agent, role, prompt, system_prompt=system_prompt,
                  max_tokens=max_tokens, step_name=step_name)


def parse_json_object(text: str) -> dict[str, Any] | None:
    """The first JSON object in a model answer (tolerating fences / prose), else None."""
    if not text:
        return None
    # Decoded from the first '{' to where that object ends (trailing prose or a second
    # object ignored; raw control characters inside strings accepted).
    if '{' not in text:
        return None
    try:
        value = first_json_object(text)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None
