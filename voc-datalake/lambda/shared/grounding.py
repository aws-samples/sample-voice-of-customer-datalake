"""Company knowledge for model prompts — one helper, two policies.

Every generator that writes something people will read gets its company
knowledge from here, so the line between "what the company knows" and "what
one person told the assistant" is drawn in exactly one place.

SHARED   outputs other people read (research, PR/FAQ, PRD, personas,
         prototypes, agent artefacts, the org layer of the morning brief).
         Company context (vision + company objectives, never anyone's own)
         and COMPANY memories only.
PRIVATE  surfaces one person reads (their assistant, their MCP client, their
         personal brief). Adds that person's own objectives and their
         personal memories.

Both blocks are DATA (``prompt_safety.data_block``) and go in the USER prompt;
``GROUNDING_GUIDANCE`` is the matching system-prompt sentence. Every lookup is
best-effort: a failed read costs the prompt a block, never the generation.

The returned ``memory_ids`` are COMPANY memory ids only — personal ids are
never written into a shared record (derivation, audit) by accident.
"""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from shared import memory_policy, memory_store
from shared.category_access import CategoryScope
from shared.company_context import company_context_block
from shared.exceptions import ServiceError
from shared.logging import logger
from shared.prompt_safety import data_block
from shared.scope_names import HIDE_ALL, HiddenNames, hidden_names_for

POLICY_SHARED = 'shared'
POLICY_PRIVATE = 'private'
POLICIES = (POLICY_SHARED, POLICY_PRIVATE)

DEFAULT_MEMORY_K = 8
MAX_MEMORY_BLOCK_CHARS = 4_000
# Query text sent to the embedder; longer questions add cost, not recall.
MAX_QUERY_CHARS = 2_000

#: The system-prompt sentence that goes with the blocks.
GROUNDING_GUIDANCE = (
    'Customer feedback is the evidence; <company_context> and <memory> are background '
    'about the company. Use them to frame and prioritise, never as evidence of what '
    'customers said. When they disagree with the feedback, say so explicitly.'
)


@dataclass(frozen=True)
class Grounding:
    """What reached the prompt: the text and the bookkeeping a derivation records."""

    text: str = ''
    memory_ids: list[str] = field(default_factory=list)
    company_context_included: bool = False
    #: The category names the job's scope may not see (None = every category), so the
    #: design-system block a generator adds beside this text is scoped by the same read.
    hidden: HiddenNames | None = None


def _supporters(value: object) -> int:
    """A stored supporter count (DynamoDB answers ``Decimal``) as an int ≥ 1."""
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal, str)):
        return 1
    try:
        return max(1, int(value))
    except (TypeError, ValueError, ArithmeticError):
        return 1


def _is_personal(item: dict) -> bool:
    return item.get('scope') == memory_policy.SCOPE_PERSONAL


def _memory_line(item: dict) -> str | None:
    statement = item.get('statement')
    if not isinstance(statement, str) or not statement.strip():
        return None
    label = 'personal' if _is_personal(item) else 'company'
    count = _supporters(item.get('supporters'))
    return f'- ({label}, {count} supporter(s), {item.get("kind") or "other"}) {statement.strip()}'


def memory_block(items: Iterable[object]) -> str:
    """``<memory>`` DATA block from memory rows / summaries, or '' when none."""
    lines = [line for line in (_memory_line(i) for i in items if isinstance(i, dict)) if line]
    return data_block('memory', '\n'.join(lines)[:MAX_MEMORY_BLOCK_CHARS])


def _recall(memory_table: Any, query: str, *, policy: str, caller_sub: str | None,
            scope: CategoryScope | None, hidden: HiddenNames | None, kinds: Iterable[str] | None,
            k: int) -> list[dict]:
    if memory_table is None or not query.strip() or k <= 0:
        return []
    try:
        return memory_store.retrieve(
            memory_table, query[:MAX_QUERY_CHARS],
            caller_sub=caller_sub if policy == POLICY_PRIVATE else None,
            include_personal=policy == POLICY_PRIVATE and bool(caller_sub),
            k=k, scope=scope, kinds=kinds, hidden=hidden,
        )
    except Exception as exc:  # noqa: BLE001 - recall is optional prompt context
        logger.warning('Memory recall unavailable for prompt', extra={'error_type': type(exc).__name__})
        return []


def _hidden_for(scope: CategoryScope | None, aggregates_table: Any) -> HiddenNames | None:
    """The category names a restricted ``scope`` may not read (None when it sees every category).

    Fails closed: when the categories config cannot be read, every statement counts as
    naming a hidden category, so a restricted reader gets no memory or company context.
    """
    if aggregates_table is None:
        return None if scope is None or scope.categories_all else HIDE_ALL
    try:
        return hidden_names_for(scope, aggregates_table)
    except ServiceError:
        return HIDE_ALL


def build_grounding(*, query: str, policy: str, aggregates_table: Any = None,
                    memory_table: Any = None, caller_sub: str | None = None,
                    scope: CategoryScope | None = None, kinds: Iterable[str] | None = None,
                    k: int = DEFAULT_MEMORY_K) -> Grounding:
    """Company context + memories for ``query`` under ``policy``.

    Args:
        query: what the output is about (the question, the document title…) —
            used only to rank memories.
        policy: POLICY_SHARED or POLICY_PRIVATE.
        caller_sub: the reader's Cognito sub; used ONLY under POLICY_PRIVATE.
        scope: the category scope of whoever started the job; memories learned
            from categories outside it, and memories or company-context lines
            that NAME such a category, are left out.
        kinds: restrict memories to these kinds (personas: product, customer).

    Raises:
        ValueError: for an unknown policy (a literal at every call site).
    """
    if policy not in POLICIES:
        raise ValueError(f'Unknown grounding policy: {policy!r}')
    personal_sub = caller_sub if policy == POLICY_PRIVATE else None
    hidden = _hidden_for(scope, aggregates_table)
    context = company_context_block(aggregates_table, personal_sub, hidden)
    recalled = _recall(memory_table, query, policy=policy, caller_sub=personal_sub,
                       scope=scope, hidden=hidden, kinds=kinds, k=k)
    memories = memory_block(recalled)
    company_ids = [r['memory_id'] for r in recalled
                   if not _is_personal(r) and isinstance(r.get('memory_id'), str)]
    return Grounding(
        text='\n\n'.join(b for b in (context, memories) if b),
        memory_ids=company_ids if memories else [],
        company_context_included=bool(context),
        hidden=hidden,
    )
