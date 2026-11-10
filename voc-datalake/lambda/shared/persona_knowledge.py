"""Company knowledge for persona GENERATION (never for the persona panel or persona chat).

Personas are project records other members read, so the grounding is
``POLICY_SHARED`` (company context + COMPANY memories) and memories are limited
to the kinds that describe the product and its customers
(``job_knowledge.PERSONA_MEMORY_KINDS``): strategy, objectives, working style
and agent notes never shape a customer archetype.

The knowledge goes into the ANALYSIS step only — the step that reads the
feedback and decides what segments exist — as context, never evidence: a
persona's traits must still be traceable to the feedback. Role-play surfaces
(agent ``persona_review``, persona chat) get none of this, so a "customer"
critique never becomes an insider's critique.
"""
from __future__ import annotations

from typing import Any

from shared import category_access
from shared.derivation import build_derivation
from shared.grounding import Grounding
from shared.job_knowledge import PERSONA_MEMORY_KINDS, derivation_knowledge, shared_grounding, with_guidance

#: The persona chain step that receives the knowledge (shared/prompts.py names it).
PERSONA_KNOWLEDGE_STEP = 'research_analysis'
PERSONA_KNOWLEDGE_HEADING = (
    '## COMPANY KNOWLEDGE (background about the company and its product, NOT customer evidence; '
    'every persona trait must still come from the feedback)'
)
PERSONA_QUERY_FALLBACK = 'customer segments, needs and how they use the product'


def persona_grounding(filters: dict) -> Grounding:
    """Company knowledge for one persona generation, under the starter's category scope.

    Ranked by the generation's custom instructions and category filter, or a
    generic customer-segment query when it has neither.
    """
    parts = [str(filters.get('custom_instructions') or '').strip()]
    categories = filters.get('categories')
    if isinstance(categories, list):
        parts.extend(c for c in categories if isinstance(c, str))
    query = ' '.join(p for p in parts if p) or PERSONA_QUERY_FALLBACK
    return shared_grounding(query, filters.get(category_access.SCOPE_CONFIG_KEY), kinds=PERSONA_MEMORY_KINDS)


def with_persona_knowledge(chain_steps: list[dict], knowledge: Grounding | None) -> list[dict]:
    """The chain with the knowledge (and GROUNDING_GUIDANCE) on the analysis step only."""
    if knowledge is None or not knowledge.text:
        return chain_steps
    section = f'\n\n{PERSONA_KNOWLEDGE_HEADING}\n\n{knowledge.text}'
    return [
        {**step, 'user': str(step.get('user') or '') + section,
         'system': with_guidance(str(step.get('system') or ''), knowledge)}
        if step.get('step_name') == PERSONA_KNOWLEDGE_STEP else step
        for step in chain_steps
    ]


def persona_knowledge_fields(knowledge: Grounding | None, feedback_count: int) -> dict[str, Any]:
    """``{'derivation': …}`` for a persona item when knowledge reached the prompt, else ``{}``."""
    extra = derivation_knowledge(knowledge) if knowledge is not None else {}
    if not extra:
        return {}
    return {'derivation': build_derivation(feedback_count=feedback_count, **extra)}
