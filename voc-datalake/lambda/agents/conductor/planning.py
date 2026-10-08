"""The conductor's own judgement calls (surface ``agent_orchestrator``).

The conductor never does the work; it decides and it briefs:

- ``decide_project`` — reuse an existing project or create a new one, from the
  run's aggregated problems and each candidate's name/description/purpose
  (todofeatures A2/A6);
- ``revision_brief`` — turn the personas' objections into one brief for the
  crewmate that revises (crewmates never talk to each other).

Both validate the model's answer and fall back deterministically, so a bad
answer degrades the decision rather than failing the run.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from agents import context_blocks, llm
from agents.fields import dict_field

MAX_CANDIDATES = 30

_PROJECT_SYSTEM = (
    'You are the conductor of an autonomous product-research crew. Decide whether the problems '
    'belong to one of the existing projects (reuse) or need a new project (create). Reuse only when '
    "the project's purpose clearly covers these problems. Answer with ONE JSON object: "
    '{"action": "reuse"|"create", "project_id": str|null, "name": str, "description": str, '
    '"purpose": str, "reason": str}. "purpose" states what the project is about and which '
    'categories/problems it covers (for a reused project: its updated purpose). '
    + context_blocks.DATA_NOTICE
)

_BRIEF_SYSTEM = (
    'You are the conductor of a product crew. Synthesise the persona panel objections into a short, '
    'actionable revision brief for the writer: what must change, what must stay, ranked by how many '
    'personas raised it and whether it was blocking. Plain text, at most 12 bullet points. '
    + context_blocks.DATA_NOTICE
)


def _candidate_line(project: dict) -> str:
    return (f"- id={project.get('project_id')} | name={str(project.get('name') or '')[:120]} | "
            f"description={str(project.get('description') or '')[:300]} | "
            f"purpose={str(project.get('purpose') or '')[:500]}")


def reusable(project: object, agent: dict) -> bool:
    """A project the agent may reuse: one it can edit that is ITS OWN business.

    Public visibility grants edit to everyone, so "editable" alone would let
    review text steer a run into any public project. Reuse is limited to
    projects this agent created, projects its owner owns, and private projects
    the agent was explicitly shared into.
    """
    if not isinstance(project, dict) or not (project.get('access') or {}).get('can_edit'):
        return False
    if project.get('created_by_agent') == agent.get('agent_id'):
        return True
    owner = dict_field(project, 'owner')
    if owner.get('sub') and owner.get('sub') == agent.get('owner_sub'):
        return True
    return project.get('visibility') == 'private'


def decide_project(agent: dict, run_id: str, aggregate_text: str, candidates: list[dict],
                   instructions: str) -> dict[str, Any]:
    """``{action, project_id?, name, description, purpose, reason}`` — always well formed."""
    editable = [p for p in candidates if reusable(p, agent)]
    editable = editable[:MAX_CANDIDATES]
    fallback_name = (aggregate_text.splitlines() or ['Agent research'])[0][:120] or 'Agent research'
    fallback = {'action': 'create', 'project_id': None, 'name': fallback_name,
                'description': aggregate_text[:500], 'purpose': aggregate_text[:1000],
                'reason': 'default: new project'}
    prompt = context_blocks.join_blocks(
        context_blocks.wrap('conductor_message', instructions, 4000),
        context_blocks.wrap('reviews', aggregate_text, 6000),
        context_blocks.wrap('artifact', '\n'.join(_candidate_line(p) for p in editable) or '(no projects)', 20000),
        'Return the JSON object now.',
    )
    answer = llm.parse_json_object(llm.ask(agent, run_id, 'orchestrator', prompt,
                                           system_prompt=_PROJECT_SYSTEM, max_tokens=800,
                                           step_name='agent_decide_project'))
    if not answer:
        return fallback
    ids = {p.get('project_id') for p in editable}
    action = answer.get('action')
    if action == 'reuse' and answer.get('project_id') not in ids:
        action = 'create'  # a hallucinated or non-editable id never reaches a write
    if action not in ('reuse', 'create'):
        return fallback
    return {
        'action': action,
        'project_id': answer.get('project_id') if action == 'reuse' else None,
        'name': str(answer.get('name') or fallback['name'])[:120],
        'description': str(answer.get('description') or fallback['description'])[:1000],
        'purpose': str(answer.get('purpose') or fallback['purpose'])[:2000],
        'reason': str(answer.get('reason') or '')[:300],
    }


def objections_text(verdicts: Sequence[object]) -> str:
    """The deterministic objection list (also the fallback brief)."""
    lines = []
    for verdict in verdicts:
        if not isinstance(verdict, dict):
            continue
        tag = 'BLOCKING ' if verdict.get('blocking') else ''
        who = verdict.get('name') or verdict.get('persona_id')
        lines.extend(
            f"- {tag}[{who}, score {verdict.get('score')}] {objection.strip()[:400]}"
            for objection in verdict.get('objections') or []
            if isinstance(objection, str) and objection.strip()
        )
    return '\n'.join(lines)[:6000]


def revision_brief(agent: dict, run_id: str, target: str, verdicts: list[dict]) -> str:
    objections = objections_text(verdicts)
    if not objections:
        return ''
    prompt = context_blocks.join_blocks(
        f'The persona panel reviewed the {target}. Their objections:',
        context_blocks.wrap('artifact', objections, 6000),
        'Write the revision brief now.',
    )
    brief = llm.ask(agent, run_id, 'orchestrator', prompt, system_prompt=_BRIEF_SYSTEM,
                    max_tokens=900, step_name='agent_revision_brief')
    return (brief or '').strip()[:4000] or objections
