"""Public web search for an agent step — on by default, capped per run.

A step searches the web unless its ``params.use_web_search`` is ``False`` (the
per-step switch in the workflow editor). Every search is taken from the run's
web budget first (``store.reserve_web_queries``, ``MAX_WEB_QUERIES_PER_RUN``),
so a whole run never executes more than that many, whatever its steps ask for.

PRIVACY: queries are planned from the step's question and the feedback
statistics only. Memory and company context never reach a planner or a query.
"""
from __future__ import annotations

from typing import NamedTuple

from agents import context_blocks, store
from agents.nodes.base import NodeContext
from shared.agentic_search import run_agentic_web_search
from shared.logging import logger
from shared.web_search import is_web_search_configured

#: Searches one custom step may take from the run's budget.
STEP_WEB_QUERIES = 3
MAX_WEB_RESULTS_CHARS = 8000
QUESTION_CHARS = 1000


class StepWeb(NamedTuple):
    """The ``<web_results>`` block ('' when none) and the searches that ran."""
    block: str = ''
    queries: tuple[str, ...] = ()


def web_enabled(ctx: NodeContext) -> bool:
    """The step's switch: on when ``params.use_web_search`` is absent or ``True``.

    Strict, as for every billed feature: anything else (``False``, ``"true"``) is off.
    """
    return ctx.param('use_web_search', True) is True


def granted_queries(ctx: NodeContext, wanted: int) -> int:
    """Searches this step may run: 0 when switched off or no gateway is deployed, else
    what the run's budget grants (nothing is reserved when nothing could run)."""
    if not (web_enabled(ctx) and is_web_search_configured()):
        return 0
    return store.reserve_web_queries(ctx.agent, ctx.run_id, wanted)


def step_web(ctx: NodeContext, question: str, feedback_stats: str) -> StepWeb:
    """Plan and run this step's searches (best effort: a failure costs the block, not the step)."""
    if not question.strip():
        return StepWeb()
    granted = granted_queries(ctx, STEP_WEB_QUERIES)
    if granted == 0:
        return StepWeb()
    try:
        outcome = run_agentic_web_search(question[:QUESTION_CHARS], context_hint=feedback_stats,
                                         max_queries=granted)
    except Exception:
        # Web grounding is an enrichment: a failure costs the block, never the step.
        logger.exception('Agent web search unavailable (continuing without)')
        return StepWeb()
    if not outcome.context:
        return StepWeb(queries=tuple(outcome.queries))
    return StepWeb(context_blocks.wrap('web_results', outcome.context, MAX_WEB_RESULTS_CHARS),
                   tuple(outcome.queries))
