"""handoff — close the run on the project.

Ownership was decided when the project was created (first category owner,
other owners as editors, else the fallback owner — see
select_or_create_project); a reused project keeps its owner (never transferred).
Handoff refreshes the agent-maintained ``purpose`` with what this run
delivered, and the conductor records the links as the run's final artifacts
(in-app only, A10).
"""
from __future__ import annotations

from agents.fields import dict_field
from agents.nodes.base import NodeContext, done

MAX_PURPOSE_CHARS = 2000


def start(ctx: NodeContext) -> dict:
    project_id = ctx.require_project()
    project = ctx.projects('GET', f'/projects/{project_id}', path_parameters={'project_id': project_id})
    meta = project.get('project') if isinstance(project, dict) else {}
    purpose = str(meta.get('purpose') or '') if isinstance(meta, dict) else ''
    delivered = ', '.join(kind.upper() for kind in ('prfaq', 'prd', 'prototype') if ctx.document(kind))
    aggregate = dict_field(ctx.context, 'aggregate')
    line = f"Agent run {ctx.run_id}: {aggregate.get('title') or 'research'}" + (f' ({delivered})' if delivered else '')
    if line not in purpose:
        ctx.projects('PUT', f'/projects/{project_id}',
                     body={'purpose': f'{purpose}\n{line}'.strip()[-MAX_PURPOSE_CHARS:]},
                     path_parameters={'project_id': project_id})
    return done(ctx, f'Handed off project {project_id}' + (f' with {delivered}' if delivered else ''),
                artifacts={'project_id': project_id})
