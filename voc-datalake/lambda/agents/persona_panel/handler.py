"""Persona panel Lambda (Step Functions task ``PersonaPanel``; surface ``agent_persona``).

A Python port of the stream assistant's ``consult_personas``
(``lambda/stream/src/assistant/tools/server/consult-personas.ts``): at most
``MAX_PANEL_PERSONAS`` personas, ``PERSONA_CONCURRENCY`` at a time, one
non-streaming call each, no tools, bounded tokens — but instead of free text
each persona returns a VERDICT::

    {persona_id, name, score: 1-5, objections: [str], blocking: bool, would_use: bool}

Agreement (todofeatures A3) = mean score ≥ 4 and no blocking objection; the
loop's max_rounds and the needs_human escalation are the conductor's.

Panel = the agent's verified fixed personas (any project) + the run project's
own personas (incl. generated), in that order. The artifact is read through
the projects route as the agent (``agents.artifacts``) and reaches the model as
an ``<artifact>`` DATA block in the user prompt; the persona's own description
is its system prompt, as in the stream tool.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from agents import artifacts, context_blocks, llm, runtime
from agents.fields import list_field
from agents.nodes.base import NodeContext, NodeFailure, done
from shared.logging import logger
from shared.persona_context import persona_prompt_block

MAX_PANEL_PERSONAS = 6
PERSONA_CONCURRENCY = 3
PERSONA_MAX_TOKENS = 1200
AGREEMENT_MEAN = 4.0
MAX_OBJECTIONS = 5
TARGETS = ('prfaq', 'prd', 'prototype')

_VERDICT_INSTRUCTIONS = (
    'Review the artifact as yourself — your goals, frustrations and context — and say honestly '
    'whether you would use it. Answer with ONE JSON object only: {"score": 1-5, "objections": '
    '[short strings], "blocking": true|false, "would_use": true|false}. "blocking" means you would '
    'not adopt it unless that objection is fixed. ' + context_blocks.DATA_NOTICE
)


def persona_system_prompt(project_name: str, persona: dict) -> str:
    return (f'You are a synthetic customer persona from the "{project_name}" research project. '
            f'Stay in character.\n\n{persona_prompt_block(persona)}\n\n{_VERDICT_INSTRUCTIONS}')


def parse_verdict(text: str, persona: dict) -> dict | None:
    answer = llm.parse_json_object(text)
    if not answer:
        return None
    score = answer.get('score')
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not 1 <= score <= 5:
        return None
    objections = [o.strip()[:400] for o in answer.get('objections') or [] if isinstance(o, str) and o.strip()]
    return {
        'persona_id': persona['persona_id'],
        'name': str(persona.get('name') or 'Persona')[:120],
        'score': round(float(score), 1),
        'objections': objections[:MAX_OBJECTIONS],
        'blocking': answer.get('blocking') is True,
        'would_use': answer.get('would_use') is True,
    }


def agreement(verdicts: list[dict]) -> bool:
    if not verdicts:
        return False
    mean = sum(v['score'] for v in verdicts) / len(verdicts)
    return mean >= AGREEMENT_MEAN and not any(v['blocking'] for v in verdicts)


def _panel(ctx: NodeContext, project_id: str) -> list[tuple[str, dict]]:
    """``[(project_name, persona)]``, fixed first, deduplicated, capped."""
    panel: list[tuple[str, dict]] = []
    seen: set[str] = set()
    fixed = list_field(ctx.context, 'fixed_personas')
    sources: dict[str, tuple[str, list[dict]]] = {}
    for ref in [*fixed, {'project_id': project_id}]:
        source = ref.get('project_id') if isinstance(ref, dict) else None
        if not isinstance(source, str):
            continue
        if source not in sources:
            try:
                sources[source] = artifacts.personas_of(source, ctx.claims)
            except Exception:  # noqa: BLE001 - an unreadable source drops its personas only
                sources[source] = ('', [])  # pragma: no mutate  the name is never read: an unreadable source has no personas
        project_name, personas = sources[source]
        wanted = ref.get('persona_id')
        for persona in personas:
            pid = persona['persona_id']
            if (wanted is None or pid == wanted) and pid not in seen:
                seen.add(pid)
                panel.append((project_name, persona))
    return panel[:MAX_PANEL_PERSONAS]


def _consult(agent: dict, artifact_prompt: str, entry: tuple[str, dict]) -> dict | None:
    project_name, persona = entry
    try:
        text = llm.invoke(agent, 'persona', artifact_prompt,
                          system_prompt=persona_system_prompt(project_name, persona),
                          max_tokens=PERSONA_MAX_TOKENS, step_name='agent_persona_review')
    except Exception as exc:  # noqa: BLE001 - one persona failing must not sink the panel
        logger.warning('Persona consultation failed', extra={'error_type': type(exc).__name__})
        return None
    return parse_verdict(text, persona)


def review(ctx: NodeContext) -> dict:
    target = ctx.param('target', 'prfaq')
    if target not in TARGETS:
        raise NodeFailure('persona_review target must be prfaq, prd or prototype')
    project_id = ctx.require_project()
    document_id = ctx.document(target)
    if not document_id:
        raise NodeFailure(f'there is no {target} to review yet')
    try:
        _, text = artifacts.load_text(project_id, document_id, ctx.claims)
    except artifacts.ArtifactUnavailable as exc:
        raise NodeFailure(str(exc)) from exc
    panel = _panel(ctx, project_id)
    if not panel:
        raise NodeFailure('no personas are available for the review')
    artifact_prompt = context_blocks.join_blocks(
        context_blocks.wrap('conductor_message', ctx.envelope, 3000),
        context_blocks.wrap('artifact', f'{target.upper()}:\n{text}', artifacts.MAX_ARTIFACT_CHARS),
        'Give your verdict as the JSON object now.',
    )
    for _ in panel:  # reserve on this thread: the budget write is not thread-safe
        llm.reserve(ctx.agent, ctx.run_id)
    with ThreadPoolExecutor(max_workers=PERSONA_CONCURRENCY) as pool:
        answers = list(pool.map(lambda entry: _consult(ctx.agent, artifact_prompt, entry), panel))
    verdicts = [v for v in answers if v]
    if not verdicts:
        raise NodeFailure('no persona returned a usable verdict')
    agreed = agreement(verdicts)
    mean = sum(v['score'] for v in verdicts) / len(verdicts)
    blocking = sum(1 for v in verdicts if v['blocking'])
    summary = (f"{'Agreed' if agreed else 'Not agreed'} on the {target}: mean {mean:.1f} from "
               f"{len(verdicts)} persona(s), {blocking} blocking")
    return done(ctx, summary, outcome='agreed' if agreed else 'not_agreed',
                artifacts={'project_id': project_id, 'document_id': document_id, 'document_type': target},
                updates={'last_verdicts': verdicts, 'last_review_target': target})


def execute(event: dict) -> dict:
    return runtime.run_step(event, review)


lambda_handler = runtime.step_lambda_handler(execute, 'Persona panel finished')
