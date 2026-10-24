"""generate_personas — new personas from the triggering reviews (existing job route)."""
from __future__ import annotations

from agents.fields import dict_field, list_field
from agents.nodes.base import (
    NodeContext,
    NodeFailure,
    done,
    scope_categories,
    started_job,
)

DEFAULT_COUNT = 3
DEFAULT_DAYS = 30


def _allowed(agent: dict) -> bool:
    personas = dict_field(agent, 'personas')
    return personas.get('allow_generate', True) is not False


def start(ctx: NodeContext) -> dict:
    if not _allowed(ctx.agent):
        return done(ctx, 'Persona generation is off for this agent; skipped.')
    project_id = ctx.require_project()
    count = ctx.param('count', DEFAULT_COUNT)
    days = ctx.param('days', DEFAULT_DAYS)
    payload = ctx.projects('POST', f'/projects/{project_id}/personas/generate', body={
        'categories': scope_categories(ctx.agent),
        'days': days if isinstance(days, int) else DEFAULT_DAYS,
        'persona_count': count if isinstance(count, int) else DEFAULT_COUNT,
        'custom_instructions': ctx.envelope[:2000],
        'generate_avatars': ctx.param('generate_avatars', False) is True,
    }, path_parameters={'project_id': project_id})
    return started_job(ctx, payload, project_id, 'Persona generation started')


def finish(ctx: NodeContext, job: dict) -> dict:
    result = dict_field(job, 'result')
    ids = [p.get('persona_id') for p in result.get('personas') or []
           if isinstance(p, dict) and isinstance(p.get('persona_id'), str)]
    if not ids:
        raise NodeFailure('persona generation finished without personas')
    known = list_field(ctx.context, 'persona_ids')
    return done(ctx, f'{len(ids)} persona(s) generated',
                artifacts={'project_id': ctx.require_project(), 'persona_ids': ids},
                updates={'persona_ids': [*known, *[i for i in ids if i not in known]]})
