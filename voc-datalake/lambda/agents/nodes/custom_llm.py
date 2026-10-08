"""custom_llm — free instructions for any role; the answer is saved as a custom document."""
from __future__ import annotations

from agents import context_blocks
from agents.nodes.base import NodeContext, NodeFailure, done

SYSTEM = ('You are a member of an autonomous product crew. Do exactly the task in the conductor '
          'message, using the context provided. Answer in Markdown. ' + context_blocks.DATA_NOTICE)


def start(ctx: NodeContext) -> dict:
    project_id = ctx.project_id
    prompt = context_blocks.join_blocks(
        context_blocks.company_context(),
        context_blocks.memories(ctx.claims, ctx.node.instructions or ctx.aggregate_text(800), project_id),
        context_blocks.wrap('reviews', ctx.aggregate_text(), 4000),
        context_blocks.wrap('conductor_message', ctx.envelope, 8000),
    )
    answer = (ctx.ask(prompt, system_prompt=SYSTEM, max_tokens=4000) or '').strip()
    if not answer:
        raise NodeFailure('the model returned nothing')
    if not project_id:
        return done(ctx, answer[:400], updates={'custom_outputs': {ctx.node.id: answer[:4000]}})
    payload = ctx.projects('POST', f'/projects/{project_id}/documents', body={
        'title': ctx.node.title[:120], 'content': answer, 'document_type': 'custom',
    }, path_parameters={'project_id': project_id})
    document = payload.get('document') if isinstance(payload, dict) else None
    document_id = document.get('document_id') if isinstance(document, dict) else None
    if not isinstance(document_id, str):
        raise NodeFailure('the document could not be saved')
    return done(ctx, f'{ctx.node.title} saved as a document',
                artifacts={'project_id': project_id, 'document_id': document_id, 'document_type': 'custom'})
