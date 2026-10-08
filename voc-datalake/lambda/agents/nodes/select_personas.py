"""select_personas — the panel's fixed members, verified readable.

The agent's ``personas.fixed`` refs may live in other projects. They are not
copied: each is checked through ``GET /projects/{id}`` as the agent (so a
persona the owner cannot see is dropped) and kept as a ref the persona panel
reads at review time. Personas already in the run's project join the panel
automatically at review time, as do the ones ``generate_personas`` adds.
"""
from __future__ import annotations

from agents import principal
from agents.fields import dict_field
from agents.nodes.base import NodeContext, done

MAX_FIXED = 6


def _fixed_refs(agent: dict) -> list[dict[str, str]]:
    personas = dict_field(agent, 'personas')
    refs = [
        {'project_id': ref['project_id'], 'persona_id': ref['persona_id']}
        for ref in personas.get('fixed') or []
        if isinstance(ref, dict) and isinstance(ref.get('project_id'), str) and isinstance(ref.get('persona_id'), str)
    ]
    return refs[:MAX_FIXED]


def start(ctx: NodeContext) -> dict:
    refs = _fixed_refs(ctx.agent)
    kept: list[dict[str, str]] = []
    by_project: dict[str, set[str]] = {}
    for ref in refs:
        project_id = ref['project_id']
        if project_id not in by_project:
            try:
                personas = principal.get_project(project_id, ctx.claims).get('personas') or []
            except principal.RouteError:
                personas = []
            by_project[project_id] = {
                p['persona_id'] for p in personas if isinstance(p, dict) and isinstance(p.get('persona_id'), str)
            }
        if ref['persona_id'] in by_project[project_id]:
            kept.append(ref)
    dropped = len(refs) - len(kept)
    summary = f'{len(kept)} fixed persona(s) on the panel'
    if dropped:
        summary += f'; {dropped} not readable and dropped'
    return done(ctx, summary, updates={'fixed_personas': kept})
