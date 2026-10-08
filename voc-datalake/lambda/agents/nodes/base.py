"""What a node executor receives and returns.

A node result (returned to Step Functions, then to the conductor's
``advance``)::

    {node_id, status: 'done'|'pending'|'failed', summary, outcome?,
     artifacts?: {project_id?, document_id?, document_type?, persona_ids?, job_id?},
     updates?: {<run context keys>}, pending?: {project_id, job_id}, halt?, error?}

``artifacts`` are CLAIMS the conductor verifies independently before it
commits ``updates`` to the run's context — a node never writes run state.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agents import llm, principal
from agents.fields import dict_field
from agents.graph import Node

MAX_SUMMARY_CHARS = 500


@dataclass
class NodeContext:
    agent: dict
    run: dict
    node: Node
    envelope: str
    claims: dict[str, str] = field(default_factory=dict)

    @property
    def agent_id(self) -> str:
        return self.agent['agent_id']

    @property
    def run_id(self) -> str:
        return self.run['run_id']

    @property
    def context(self) -> dict:
        value = self.run.get('context')
        return value if isinstance(value, dict) else {}

    @property
    def project_id(self) -> str | None:
        value = self.context.get('project_id')
        return value if isinstance(value, str) and value else None

    def require_project(self) -> str:
        project_id = self.project_id
        if not project_id:
            raise NodeFailure('no project has been chosen for this run yet')
        return project_id

    def document(self, kind: str) -> str | None:
        documents = self.context.get('documents')
        value = documents.get(kind) if isinstance(documents, dict) else None
        return value if isinstance(value, str) and value else None

    def param(self, key: str, default: Any = None) -> Any:
        return self.node.params.get(key, default)

    def ask(self, prompt: str, *, system_prompt: str = '', max_tokens: int = 2000,
            role: str | None = None) -> str:
        return llm.ask(self.agent, self.run_id, role or self.node.role, prompt,
                       system_prompt=system_prompt, max_tokens=max_tokens,
                       step_name=f'agent_{self.node.type}')

    def projects(self, method: str, path: str, **kwargs: Any) -> Any:
        return principal.projects(method, path, self.claims, **kwargs)

    def aggregate_text(self, limit: int = 4000) -> str:
        aggregate = self.context.get('aggregate')
        if not isinstance(aggregate, dict):
            return ''
        lines = [str(aggregate.get('title') or ''), str(aggregate.get('problem_summary') or '')]
        lines.extend(
            f"- {problem.get('title', '')} ({problem.get('category', '')}): "
            f"{problem.get('evidence_count', 0)} reviews"
            for problem in aggregate.get('top_problems') or []
            if isinstance(problem, dict)
        )
        return '\n'.join(line for line in lines if line)[:limit]


class NodeFailure(Exception):
    """A node cannot complete; the message is recorded on the run (no content)."""


def scope_categories(agent: dict) -> list[str]:
    """The agent's category scope as a list ([] = all categories)."""
    scope = dict_field(agent, 'scope')
    if scope.get('all') is True:
        return []
    names: list[str] = []
    for name in scope.get('categories') or []:
        if isinstance(name, str) and name and name not in names:
            names.append(name)
    for sub in scope.get('subcategories') or []:
        category = sub.get('category') if isinstance(sub, dict) else None
        if isinstance(category, str) and category and category not in names:
            names.append(category)
    return names[:10]


def _summary(text: str) -> str:
    return (text or '').strip()[:MAX_SUMMARY_CHARS]


def done(ctx: NodeContext, summary: str, *, outcome: str | None = None,
         artifacts: dict | None = None, updates: dict | None = None, halt: bool = False) -> dict:
    result: dict[str, Any] = {'node_id': ctx.node.id, 'status': 'done', 'summary': _summary(summary)}
    if outcome:
        result['outcome'] = outcome
    if artifacts:
        result['artifacts'] = artifacts
    if updates:
        result['updates'] = updates
    if halt:
        result['halt'] = True
    return result


def pending(ctx: NodeContext, project_id: str, job_id: str, summary: str) -> dict:
    return {
        'node_id': ctx.node.id, 'status': 'pending', 'summary': _summary(summary),
        'pending': {'project_id': project_id, 'job_id': job_id},
    }


def failed(node_id: str, error: str) -> dict:
    return {'node_id': node_id, 'status': 'failed', 'summary': _summary(error), 'error': _summary(error)}


def started_job(ctx: NodeContext, payload: Any, project_id: str, summary: str) -> dict:
    """The pending result for a route that answered ``{job_id}``."""
    job_id = payload.get('job_id') if isinstance(payload, dict) else None
    if not isinstance(job_id, str) or not job_id:
        raise NodeFailure('the route did not start a job')
    return pending(ctx, project_id, job_id, summary)


def document_updates(ctx: NodeContext, kind: str, document_id: str) -> dict:
    """The run-context update recording ``document_id`` as the latest ``kind``."""
    documents = dict_field(ctx.context, 'documents')
    return {'documents': {**documents, kind: document_id}}


def job_document_id(job: dict) -> str:
    result = dict_field(job, 'result')
    document_id = result.get('document_id')
    if not isinstance(document_id, str) or not document_id:
        raise NodeFailure('the job finished without a document')
    return document_id
