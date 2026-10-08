"""select_or_create_project — the conductor decides reuse vs new (A2/A6, Q2).

Reuse: the project's ``purpose`` is updated (agent-maintained). Create: the
project is owned by the FIRST owner of the run's dominant category, the other
owners become editors (A5); with no owner, the admin flagged ``fallback_owner``
(pointer row ``SETTINGS#fallback_owner``), else the agent's own owner.
Visibility follows the agent's ``output.visibility``. Never merges, moves or
deletes a project.
"""
from __future__ import annotations

from collections import Counter

from agents import principal
from agents.conductor import planning
from agents.fields import dict_field
from agents.nodes.base import NodeContext, NodeFailure, done
from shared.category_gate import read_categories_config
from shared.tables import get_aggregates_table

FALLBACK_OWNER_KEY = {'pk': 'SETTINGS#fallback_owner', 'sk': 'config'}


def dominant_category(aggregate: dict) -> str | None:
    counts: Counter[str] = Counter()
    for problem in aggregate.get('top_problems') or []:
        if isinstance(problem, dict) and isinstance(problem.get('category'), str) and problem['category']:
            counts[problem['category']] += max(1, int(problem.get('evidence_count') or 1))
    # ``max`` keeps the first-seen category on a tie, as ``most_common(1)`` does.
    return max(counts, key=counts.__getitem__) if counts else None


def _fallback_owner(table) -> str:
    item = table.get_item(Key=FALLBACK_OWNER_KEY).get('Item') if table else None
    sub = item.get('sub') if isinstance(item, dict) else None
    return sub if isinstance(sub, str) else ''


def _category_owners(table, category: str) -> list[str]:
    """The well-formed owner subs of the FIRST config entry named ``category``."""
    for entry in read_categories_config(table):
        if entry.get('name') == category:
            return [o['sub'] for o in entry.get('owners') or []
                    if isinstance(o, dict) and isinstance(o.get('sub'), str) and o['sub']]
    return []


def resolve_handoff(category: str | None) -> tuple[str, tuple[str, ...]]:
    """``(owner_sub, editor_subs)``; ``('', ())`` means "the agent's own owner"."""
    table = get_aggregates_table()
    owners = _category_owners(table, category) if category and table is not None else []
    if owners:
        return owners[0], tuple(owners[1:])
    return _fallback_owner(table), ()


def _visibility(agent: dict) -> str:
    output = dict_field(agent, 'output')
    return 'public' if output.get('visibility') == 'public' else 'private'


def start(ctx: NodeContext) -> dict:
    aggregate = dict_field(ctx.context, 'aggregate')
    listing = ctx.projects('GET', '/projects')
    candidates = listing.get('projects') if isinstance(listing, dict) else None
    decision = planning.decide_project(
        ctx.agent, ctx.run_id, ctx.aggregate_text(), candidates if isinstance(candidates, list) else [],
        ctx.envelope,
    )
    if decision['action'] == 'reuse':
        project_id = decision['project_id']
        reused = next((p for p in candidates or [] if isinstance(p, dict) and p.get('project_id') == project_id), {})
        if not str(reused.get('purpose') or '').strip():
            # Fill in a missing purpose only — never overwrite what a person wrote.
            ctx.projects('PUT', f'/projects/{project_id}', body={'purpose': decision['purpose']},
                         path_parameters={'project_id': project_id})
        return done(ctx, f"Reusing project {project_id}: {decision['reason']}",
                    artifacts={'project_id': project_id},
                    updates={'project_id': project_id, 'project_created': False})

    category = dominant_category(aggregate)
    owner_sub, editors = resolve_handoff(category)
    claims = principal.agent_claims(ctx.agent, owner_sub=owner_sub, editor_subs=editors)
    payload = principal.projects('POST', '/projects', claims, body={
        'name': decision['name'], 'description': decision['description'],
        'purpose': decision['purpose'], 'visibility': _visibility(ctx.agent),
    })
    project = payload.get('project') if isinstance(payload, dict) else None
    project_id = project.get('project_id') if isinstance(project, dict) else None
    if not isinstance(project_id, str) or not project_id:
        raise NodeFailure('the project could not be created')
    return done(ctx, f"Created project {project_id} for category {category or 'all'}",
                artifacts={'project_id': project_id},
                updates={'project_id': project_id, 'project_created': True,
                         'dominant_category': category or ''})
