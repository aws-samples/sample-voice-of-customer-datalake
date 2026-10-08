"""duplicate_document — copy a run document into another project (never move).

``params``: ``document`` ('prfaq'|'prd'|'prototype'|'research', default 'prfaq')
and ``target_project_id``. The route requires edit on both projects as the agent.
"""
from __future__ import annotations

from agents.nodes.base import NodeContext, NodeFailure, done

KINDS = ('prfaq', 'prd', 'prototype', 'research')


def start(ctx: NodeContext) -> dict:
    project_id = ctx.require_project()
    kind = ctx.param('document', 'prfaq')
    target = ctx.param('target_project_id')
    if kind not in KINDS:
        raise NodeFailure('duplicate_document: unknown document kind')
    if not isinstance(target, str) or not target or target == project_id:
        raise NodeFailure('duplicate_document needs a different target_project_id')
    document_id = ctx.document(kind)
    if not document_id:
        raise NodeFailure(f'there is no {kind} to duplicate yet')
    payload = ctx.projects('POST', f'/projects/{project_id}/documents/{document_id}/duplicate',
                           body={'target_project_id': target},
                           path_parameters={'project_id': project_id, 'document_id': document_id})
    copy = payload.get('document') if isinstance(payload, dict) else None
    copy_id = copy.get('document_id') if isinstance(copy, dict) else None
    if not isinstance(copy_id, str) or not copy_id:
        raise NodeFailure('the duplicate route returned no document')
    return done(ctx, f'{kind.upper()} copied into {target}',
                artifacts={'project_id': target, 'document_id': copy_id, 'document_type': kind})
