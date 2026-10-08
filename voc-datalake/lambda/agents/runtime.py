"""Plumbing shared by the three runtime Lambdas (conductor, nodes, persona panel)."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from agents import principal, store
from agents.graph import WorkflowError, WorkflowGraph
from agents.nodes.base import NodeContext, NodeFailure, failed
from shared.agents_store import BUILTIN_REVISION
from shared.invocation_cost import measure_invocation_cost
from shared.logging import logger, metrics, tracer
from shared.mcp_delegate import DelegationUnavailable
from shared.workflow_schema import DEFAULT_WORKFLOW_ID, default_template


def resolve_workflow(agent: dict, revision: int | None) -> tuple[WorkflowGraph, int]:
    """``(graph, revision)`` for the agent's workflow — ``revision`` pinned, or CURRENT.

    The built-in ``wf_default`` is never stored: it is the shared template
    (``shared.workflow_schema.default_template``) the agents API serves, at
    ``BUILTIN_REVISION``.
    """
    workflow_id = agent.get('workflow_id') or DEFAULT_WORKFLOW_ID
    if workflow_id == DEFAULT_WORKFLOW_ID:
        return WorkflowGraph(default_template()), BUILTIN_REVISION
    loaded = store.load_workflow(workflow_id, revision if isinstance(revision, int) and revision > 0 else None)
    if loaded is None:
        raise WorkflowError('the agent workflow could not be loaded')
    definition, resolved = loaded
    return WorkflowGraph(definition), resolved


def load_graph(agent: dict, run: dict) -> WorkflowGraph:
    """The run's pinned workflow revision."""
    revision = run.get('workflow_revision')
    if not isinstance(revision, int) or revision < 0:
        raise WorkflowError('the run has no pinned workflow revision')
    return resolve_workflow(agent, revision)[0]


def build_context(event: dict) -> NodeContext:
    """Agent + running run + node + the conductor's envelope for this step."""
    agent_id, run_id = str(event.get('agent_id') or ''), str(event.get('run_id') or '')
    agent = store.get_agent(agent_id)
    run = store.get_run(agent_id, run_id)
    if not agent or not run:
        raise NodeFailure('agent or run not found')
    if run.get('status') != store.RUN_RUNNING:
        raise NodeFailure('run is not running')
    node = load_graph(agent, run).node(str(event.get('node_id') or ''))
    envelope = ''
    seq = event.get('mate_seq')
    if isinstance(seq, int):
        mate = store.get_mate(run_id, node.role, seq)
        if mate and mate.get('node_id') == node.id:
            envelope = str(mate.get('text') or '')
    return NodeContext(agent=agent, run=run, node=node, envelope=envelope,
                       claims=principal.agent_claims(agent))


def step_lambda_handler(execute: Callable[[dict], dict], finished_message: str) -> Callable[[dict, Any], dict]:
    """The Powertools-wrapped Lambda entry point for a node-result-returning step."""
    @logger.inject_lambda_context
    @tracer.capture_lambda_handler
    @metrics.log_metrics(capture_cold_start_metric=True)
    @measure_invocation_cost
    def handler(event: object, context: Any) -> dict:
        result = execute(event if isinstance(event, dict) else {})
        logger.info(finished_message, extra={'node_status': result.get('status')})
        return result
    return handler


def run_step(event: dict, step: Callable[[NodeContext], dict]) -> dict:
    """Build the context, run ``step``, and map every expected failure to a node result."""
    node_id = str(event.get('node_id') or '')
    try:
        return store.plain(step(build_context(event)))
    except store.BudgetExhausted:
        return {**failed(node_id, 'The run has spent its model-call budget.'), 'error': 'budget_exhausted'}
    except (NodeFailure, WorkflowError) as exc:
        return failed(node_id, str(exc))
    except principal.RouteError as exc:
        return failed(node_id, f'A project route refused the step (HTTP {exc.status_code}): {exc}')
    except DelegationUnavailable:
        logger.exception('Domain call unavailable')
        return failed(node_id, 'A project service was unavailable.')
