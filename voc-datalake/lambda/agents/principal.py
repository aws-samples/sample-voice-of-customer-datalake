"""The agent principal and its calls into the EXISTING domain routes.

A run never touches project data directly. It invokes the projects, metrics
and memory Lambdas with a synthetic API Gateway event — the same transport the
MCP adapter uses (``shared.mcp_delegate``) — so every route's validation,
per-project gate and category scope apply to the agent exactly as they would to
its owner:

- ``sub = agent:{agent_id}``, ``cognito:groups`` always empty (never admin);
- ``voc:acting_subject`` = the agent's owner (``project_access`` caps it at editor);
- ``voc:agent_owner_sub`` / ``voc:agent_editor_subs`` only on project creation.

Claims derive ONLY from the stored agent row — nothing a model produced can
reach them (``agent_claims`` takes the agent and nothing else).
"""
from __future__ import annotations

import os
from typing import Any

from shared import project_access
from shared.mcp_delegate import DelegationUnavailable, DomainCall, DomainResult, call_domain


class RouteError(Exception):
    """A route answered with a non-2xx status (message is safe to record)."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


def agent_claims(agent: dict, *, owner_sub: str = '', editor_subs: tuple[str, ...] = ()) -> dict[str, str]:
    agent_id = agent.get('agent_id')
    if not isinstance(agent_id, str) or not agent_id:
        raise DelegationUnavailable('agent record has no agent_id')
    sub = f'{project_access.AGENT_SUBJECT_PREFIX}{agent_id}'
    claims = {'sub': sub, 'cognito:groups': '', 'email': sub}
    acting = agent.get('owner_sub') if isinstance(agent.get('owner_sub'), str) else ''
    if acting and not project_access.is_synthetic_subject(acting):
        claims[project_access.ACTING_SUBJECT_CLAIM] = acting
    if owner_sub and not project_access.is_synthetic_subject(owner_sub):
        claims[project_access.AGENT_OWNER_CLAIM] = owner_sub
    editors = [s for s in editor_subs if s and ',' not in s and not project_access.is_synthetic_subject(s)]
    if editors:
        claims[project_access.AGENT_EDITORS_CLAIM] = ','.join(editors[:project_access.MAX_AGENT_EDITORS])
    return claims


def _message(result: DomainResult) -> str:
    payload = result.payload
    if isinstance(payload, dict):
        for key in ('message', 'error'):
            if isinstance(payload.get(key), str):
                return payload[key][:300]
    return f'HTTP {result.status_code}'


def call(function_env: str, method: str, path: str, claims: dict[str, str], *,
         body: dict | None = None, query: dict[str, Any] | None = None,
         path_parameters: dict[str, str] | None = None) -> Any:
    """Invoke one route; its JSON body on 2xx, else RouteError."""
    result = call_domain(DomainCall(
        function_name=os.environ.get(function_env, ''),
        method=method, path=path, body=body, query=query or {},
        path_parameters=path_parameters or {},
    ), claims=claims)
    if not result.ok:
        raise RouteError(result.status_code, _message(result))
    return result.payload


def projects(method: str, path: str, claims: dict[str, str], **kwargs: Any) -> Any:
    return call('PROJECTS_FUNCTION', method, path, claims, **kwargs)


def metrics(method: str, path: str, claims: dict[str, str], **kwargs: Any) -> Any:
    return call('METRICS_FUNCTION', method, path, claims, **kwargs)


def memory(method: str, path: str, claims: dict[str, str], **kwargs: Any) -> Any:
    return call('MEMORY_FUNCTION', method, path, claims, **kwargs)


def get_project(project_id: str, claims: dict[str, str]) -> dict:
    payload = projects('GET', f'/projects/{project_id}', claims,
                       path_parameters={'project_id': project_id})
    if not isinstance(payload, dict) or not isinstance(payload.get('project'), dict):
        raise RouteError(502, 'project response was malformed')
    return payload


def get_job(project_id: str, job_id: str, claims: dict[str, str]) -> dict:
    payload = projects('GET', f'/projects/{project_id}/jobs/{job_id}', claims,
                       path_parameters={'project_id': project_id, 'job_id': job_id})
    if not isinstance(payload, dict):
        raise RouteError(502, 'job response was malformed')
    return payload


def chat_context(project_id: str, claims: dict[str, str], document_ids: list[str]) -> dict:
    """Personas + document summaries (+ content of the selected non-prototype docs)."""
    payload = projects('POST', f'/projects/{project_id}/chat-context', claims,
                       body={'selected_document_ids': document_ids[:20]},
                       path_parameters={'project_id': project_id})
    if not isinstance(payload, dict):
        raise RouteError(502, 'chat-context response was malformed')
    return payload
