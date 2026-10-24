"""handoff — close the run on the project.

Ownership was decided when the project was created (first category owner,
other owners as editors, else the fallback owner — see
select_or_create_project); a reused project keeps its owner (never transferred).
Handoff refreshes the agent-maintained ``purpose`` with what this run
delivered, and the conductor records the links as the run's final artifacts
(in-app only, A10).
"""
from __future__ import annotations

from agents.event_text import project_ref, remember_project_name
from agents.failure_reason import document_label
from agents.fields import dict_field
from agents.nodes.base import NodeContext, done

MAX_PURPOSE_CHARS = 2000


def _run_label(ctx: NodeContext) -> str:
    """How the purpose names this run for people: the agent's name and the run's day, never the run id."""
    name = ' '.join(str(ctx.agent.get('name') or '').split())[:80]
    day = str(ctx.run.get('started_at') or '')[:10]
    head = f'Agent "{name}" run' if name else 'Agent run'
    return f'{head} of {day}' if day else head


def start(ctx: NodeContext) -> dict:
    project_id = ctx.require_project()
    project = ctx.projects('GET', f'/projects/{project_id}', path_parameters={'project_id': project_id})
    meta = project.get('project') if isinstance(project, dict) else {}
    purpose = str(meta.get('purpose') or '') if isinstance(meta, dict) else ''
    delivered = ', '.join(document_label(kind) for kind in ('prfaq', 'prd', 'prototype') if ctx.document(kind))
    aggregate = dict_field(ctx.context, 'aggregate')
    line = f"{_run_label(ctx)}: {aggregate.get('title') or 'research'}" + (f' ({delivered})' if delivered else '')
    if line not in purpose:
        ctx.projects('PUT', f'/projects/{project_id}',
                     body={'purpose': f'{purpose}\n{line}'.strip()[-MAX_PURPOSE_CHARS:]},
                     path_parameters={'project_id': project_id})
    name = meta.get('name') if isinstance(meta, dict) else None
    return done(ctx, f'Handed off {project_ref(name)}' + (f' with {delivered}' if delivered else ''),
                artifacts={'project_id': project_id},
                updates=remember_project_name(ctx.context, project_id, name))
