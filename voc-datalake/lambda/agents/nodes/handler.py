"""Node executor Lambda (Step Functions task ``ExecuteNode`` / ``PollNode``).

Event: ``{action: 'start'|'poll', agent_id, run_id, node_id, mate_seq?, pending?}``.
Returns a node result (``agents.nodes.base``). A node's own failure never
raises — it becomes ``status: 'failed'`` so the conductor records it — and
nothing here writes run state (the conductor verifies and commits).

``poll`` checks the job a ``start`` returned via ``GET /projects/{id}/jobs/{job}``
as the agent, and hands the finished job to the module's ``finish``.
"""
from __future__ import annotations

from importlib import import_module
from types import ModuleType
from typing import Any

from agents import principal, runtime
from agents.nodes.base import NodeContext, NodeFailure, pending

# Node types executed by this Lambda (persona_review runs in the panel Lambda;
# start/end are the conductor's own).
EXECUTABLE_TYPES = frozenset({
    'aggregate_reviews', 'select_or_create_project', 'select_personas', 'generate_personas',
    'deep_research', 'write_prfaq', 'write_prd', 'revise_document', 'build_prototype',
    'collect_prototype_feedback', 'revise_prototype', 'final_review', 'duplicate_document', 'handoff', 'custom_llm',
})
JOB_DONE = 'completed'
JOB_FAILED = frozenset({'failed', 'error', 'cancelled'})


def _module(node_type: str) -> ModuleType:
    if node_type not in EXECUTABLE_TYPES:
        raise NodeFailure(f'{node_type} is not executed by the node Lambda')
    return import_module(f'agents.nodes.{node_type}')


def _poll(ctx: NodeContext, waiting: Any) -> dict:
    project_id = waiting.get('project_id') if isinstance(waiting, dict) else None
    job_id = waiting.get('job_id') if isinstance(waiting, dict) else None
    if not isinstance(project_id, str) or not isinstance(job_id, str):
        raise NodeFailure('poll without a pending job')
    job = principal.get_job(project_id, job_id, ctx.claims)
    status = job.get('status')
    if status == JOB_DONE:
        return _module(ctx.node.type).finish(ctx, job)
    if status in JOB_FAILED:
        raise NodeFailure(f'the {ctx.node.type} job failed')
    return pending(ctx, project_id, job_id, f"{ctx.node.title}: {job.get('current_step') or status or 'running'}")


def execute(event: dict) -> dict:
    if event.get('action') == 'poll':
        return runtime.run_step(event, lambda ctx: _poll(ctx, event.get('pending')))
    return runtime.run_step(event, lambda ctx: _module(ctx.node.type).start(ctx))


lambda_handler = runtime.step_lambda_handler(execute, 'Node step finished')
