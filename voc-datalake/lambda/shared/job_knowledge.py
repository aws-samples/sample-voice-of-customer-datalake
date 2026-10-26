"""Company knowledge for the SHARED generators (research, PR/FAQ, PRD, personas, prototypes).

A thin layer over ``shared.grounding``: it resolves the two tables from the
Lambda's own environment (``AGGREGATES_TABLE``, ``MEMORY_TABLE``), reads the job
starter's category scope from the job config, and always asks for
``POLICY_SHARED`` — so a generator cannot pass a caller sub by accident and pull
someone's personal objectives or memories into a document other people read.

The memory table is read DIRECTLY (Query/GetItem/UpdateItem on voc-memory, KMS,
Titan embed), never through the memory Lambda: a delegated call without a human
subject resolves to the NOTHING scope and would recall nothing.

Every lookup is best-effort (``build_grounding`` never raises for a missing or
failing table), so a deployment without memory still generates.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from shared import category_access, memory_store
from shared.grounding import GROUNDING_GUIDANCE, POLICY_SHARED, Grounding, build_grounding
from shared.tables import get_aggregates_table

#: Memory kinds a persona may draw on: product facts and customer segments only.
PERSONA_MEMORY_KINDS = ('product', 'customer')


def shared_grounding(query: str, scope_config: object, *, kinds: Iterable[str] | None = None) -> Grounding:
    """Company context + company memories for ``query``, limited to the starter's scope.

    ``scope_config`` is the job config's ``category_access.SCOPE_CONFIG_KEY``
    value (None for a legacy job, which reads unrestricted like its feedback).
    """
    return build_grounding(
        query=query,
        policy=POLICY_SHARED,
        aggregates_table=get_aggregates_table(),
        memory_table=memory_store.get_memory_table(),
        scope=category_access.scope_from_config(scope_config),
        kinds=kinds,
    )


def with_guidance(system_prompt: str, grounding: Grounding) -> str:
    """``system_prompt`` plus ``GROUNDING_GUIDANCE`` when the grounding carried anything.

    Unchanged when nothing was grounded, so an unconfigured deployment's
    prompts stay byte-identical to what they were.
    """
    if not grounding.text:
        return system_prompt
    return f'{system_prompt}\n\n{GROUNDING_GUIDANCE}' if system_prompt else GROUNDING_GUIDANCE


def derivation_knowledge(grounding: Grounding, *, web_search_count: int = 0) -> dict[str, Any]:
    """The ``build_derivation`` keyword arguments for what reached the prompt.

    Only the non-empty ones, mirroring ``build_derivation`` (which omits empty
    knowledge keys), so a generation without company knowledge calls it exactly
    as it did before these keys existed.
    """
    knowledge: dict[str, Any] = {
        'memory_ids': list(grounding.memory_ids),
        'company_context_included': grounding.company_context_included,
        'web_search_count': web_search_count,
    }
    return {key: value for key, value in knowledge.items() if value}
