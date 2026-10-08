"""final_review — the reviewer (Opus) checks the run's outputs against a checklist.

Pass → the ``pass`` edge (handoff); fail → the ``fail`` edge, or ``needs_human``
when the workflow has none. The checklist is fixed plus the node's own
instructions; company objectives come in as the ``<company_context>`` block.
"""
from __future__ import annotations

from agents import artifacts, context_blocks, llm
from agents.conductor.planning import objections_text
from agents.nodes.base import NodeContext, NodeFailure, done

CHECKLIST = (
    'The PR/FAQ addresses the aggregated customer problems and cites evidence.',
    'The personas agreed (or their remaining objections are minor and non-blocking).',
    'The prototype implements the PR/FAQ\u2019s core customer experience.',
    'The prototype follows the company design system (tokens and guidelines), when one is provided.',
    'The work serves at least one company objective and contradicts none.',
    'No customer personal data or raw review quotes from restricted categories are exposed.',
)
SYSTEM = (
    'You are the final reviewer of an autonomous product crew. Judge the outputs strictly against '
    'the checklist. Answer with ONE JSON object: {"pass": bool, "summary": str, "checklist": '
    '[{"item": str, "ok": bool, "note": str}]}. ' + context_blocks.DATA_NOTICE
)


def _artifact_block(ctx: NodeContext, kind: str, limit: int) -> str:
    document_id = ctx.document(kind)
    if not document_id:
        return ''
    try:
        _, text = artifacts.load_text(ctx.require_project(), document_id, ctx.claims)
    except artifacts.ArtifactUnavailable:
        return f'({kind} unavailable)'
    return context_blocks.wrap('artifact', f'{kind.upper()}:\n{text}', limit)


def start(ctx: NodeContext) -> dict:
    project_id = ctx.require_project()
    last_verdicts = ctx.context.get('last_verdicts')
    verdicts = last_verdicts if isinstance(last_verdicts, list) else []
    checklist = '\n'.join(f'- {item}' for item in CHECKLIST)
    if ctx.node.instructions:
        checklist += f'\n- {ctx.node.instructions[:2000]}'
    prompt = context_blocks.join_blocks(
        context_blocks.company_context(),
        context_blocks.design_system(),
        context_blocks.wrap('reviews', ctx.aggregate_text(),
                            4000),  # pragma: no mutate  aggregate_text() is already clipped to 4000 in base.py
        _artifact_block(ctx, 'prfaq', 20000),
        _artifact_block(ctx, 'prototype', 12000),
        context_blocks.wrap('artifact', 'Remaining persona objections:\n' + (objections_text(verdicts) or 'none'), 4000),
        f'Checklist:\n{checklist}',
        'Return the JSON object now.',
    )
    answer = llm.parse_json_object(ctx.ask(prompt, system_prompt=SYSTEM, max_tokens=1500))
    if not answer or not isinstance(answer.get('pass'), bool):
        raise NodeFailure('the final review was not valid JSON')
    passed = answer['pass']
    summary = str(answer.get('summary') or ('Passed' if passed else 'Failed'))[:400]
    return done(ctx, summary, outcome='pass' if passed else 'fail',
                artifacts={'project_id': project_id},
                updates={'final_review': {'pass': passed, 'summary': summary}})
