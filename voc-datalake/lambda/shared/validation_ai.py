"""The Validate step's model calls (7.68.00, docs/project-workspace.md → Validate), each ONE Converse call on the
``documents`` surface (``shared.converse``: the deployment's model and its allowlist), run by the projects API's
assist twin and paid per use:

* ``extract_criteria``: the success criteria from a PRD's Success Metrics (the PRD inside a ``<document>`` DATA
  block), each a statement a tester can rate; its business numbers stay in the text, no target is invented;
* ``draft_plan``: the interview guide (5 to 8 neutral questions per criterion, a probe per persona) and the
  task-based test script from the prototype's outline and walkthrough (``<prototype_outline>``);
* ``run_personas``: each persona trying the script on the outline, a verdict per task and a 1-5 rating per
  criterion: synthetic, never a tester's answer (the run is stored ``synthetic: true`` and counts towards nothing);
* ``report_summary``: a short reading of the results already computed (``<validation_results>``), which states no
  figure of its own.

Every block a person or a model wrote is DATA (shared/prompt_safety.py), and every answer is parsed and bounded here:
an unusable one is a 400 the page can act on (try again, or write it by hand), never stored as it came.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Final

from shared.converse import converse
from shared.document_review import guarded_reply
from shared.exceptions import ValidationError
from shared.forms_v2 import FORM_LOCALES
from shared.memory_store import parse_json_object
from shared.persona_context import persona_prompt_block
from shared.project_validation import MAX_CRITERIA, MAX_TASKS, MAX_TEXT_CHARS, validated_criteria
from shared.prompt_safety import DATA_NOTICE, data_block, injection_findings
from shared.prompts import get_response_language_instruction
from shared.prototype_walkthrough_draft import outline_text

SURFACE: Final = 'documents'
MAX_DOCUMENT_CHARS: Final = 40_000
CRITERIA_MAX_TOKENS: Final = 1_500
PLAN_MAX_TOKENS: Final = 6_000
PERSONA_MAX_TOKENS: Final = 2_000
SUMMARY_MAX_TOKENS: Final = 800
MIN_GUIDE_QUESTIONS: Final = 5
MAX_GUIDE_QUESTIONS: Final = 8
MAX_NOTE_CHARS: Final = 400
MAX_SUMMARY_CHARS: Final = 1_500
#: Personas asked at once in a synthetic run (the persona review's bound).
PERSONA_CONCURRENCY: Final = 3
OUTCOMES: Final = ('completed', 'struggled', 'failed')

NO_CRITERIA: Final = 'The AI found no success criteria in this PRD. Try again, or write them yourself.'
NO_PLAN: Final = 'The AI wrote no usable plan. Try again, or write the plan yourself.'

#: ``(prompt, system prompt, max tokens, step name) -> the reply's text``: the one seam the tests replace.
Invoke = Callable[[str, str, int, str], str]


def default_invoke(prompt: str, system: str, max_tokens: int, step_name: str) -> str:
    return converse(prompt=prompt, system_prompt=system, max_tokens=max_tokens, temperature=None, surface=SURFACE,
                    step_name=step_name)


def language_line(language: object) -> str:
    """Write in one of the app's nine locales when asked (nothing else from the request reaches the prompt)."""
    if language not in FORM_LOCALES:
        return 'Write in the language of the documents.'
    return 'Write in English.' if language == 'en' else get_response_language_instruction(str(language))


def _clean(value: object, limit: int = MAX_TEXT_CHARS) -> str:
    """A model string kept as plain text, at most ``limit``; '' for anything else or instruction-shaped text."""
    if not isinstance(value, str):
        return ''
    text = ' '.join(value.split())[:limit]
    return '' if injection_findings(text) else text


def _list(answer: Mapping[str, Any] | None, key: str) -> list[Any]:
    value = (answer or {}).get(key)
    return value if isinstance(value, list) else []


# ── Criteria ─────────────────────────────────────────────────────────────────────────────────────────────────────

_CRITERIA_SYSTEM: Final = (
    'You turn the Success Metrics of a product requirements document into success criteria a prototype test can '
    'check. Each criterion is one short statement a tester can rate from 1 to 5 after trying the prototype (for '
    'example "Finding last month\'s invoice is quick"). Keep any number the PRD states inside the statement; do not '
    'invent targets or metrics the PRD does not name. Answer with one JSON object only: '
    '{"criteria": [{"text": "..."}]}, at most ' + str(MAX_CRITERIA) + ' criteria of at most '
    + str(MAX_TEXT_CHARS) + ' characters. ' + DATA_NOTICE
)


def extract_criteria(prd_text: str, *, language: object = None, invoke: Invoke = default_invoke) -> list[dict]:
    """The PRD's success criteria, validated (ids minted), or a 400 when the reply holds none."""
    prompt = '\n\n'.join((f'Read the Success Metrics of this PRD. {language_line(language)}',
                          data_block('document', prd_text[:MAX_DOCUMENT_CHARS])))
    answer = parse_json_object(invoke(prompt, _CRITERIA_SYSTEM, CRITERIA_MAX_TOKENS, 'validation_criteria'))
    texts = [text for entry in _list(answer, 'criteria')
             if isinstance(entry, Mapping) and (text := _clean(entry.get('text')))]
    if not texts:
        raise ValidationError(NO_CRITERIA)
    return validated_criteria([{'text': text} for text in dict.fromkeys(texts)][:MAX_CRITERIA])


# ── The plan ─────────────────────────────────────────────────────────────────────────────────────────────────────

def script_block(criteria: Sequence[Mapping[str, Any]], tasks: Sequence[Mapping[str, Any]] = ()) -> str:
    """The criteria (and tasks) by id, as the DATA block every Validate prompt reads them from."""
    lines = [f"Criterion {criterion['id']}: {criterion['text']}" for criterion in criteria]
    lines += [f"Task {task['id']}: {task['text']}" for task in tasks]
    return data_block('validation_script', '\n'.join(lines))


def _personas_block(personas: Sequence[Mapping[str, Any]]) -> str:
    return '\n\n'.join(data_block('reference', f"Persona {persona['persona_id']}\n{persona_prompt_block(dict(persona))}")
                       for persona in personas)


_PLAN_SYSTEM: Final = (
    'You plan the validation of a product prototype against its success criteria. Write (1) an interview guide: for '
    f'each criterion {MIN_GUIDE_QUESTIONS} to {MAX_GUIDE_QUESTIONS} neutral, open questions (never leading, never '
    'naming the answer you hope for), and for each persona one probe that fits who they are; (2) a task-based test '
    f'script: 1 to {MAX_TASKS} tasks a tester tries on the prototype, each doable on its screens, with what success '
    'looks like. Answer with one JSON object only: {"guide": [{"criterion_id": "...", "questions": ["..."], '
    '"probes": [{"persona_id": "...", "probe": "..."}]}], "tasks": [{"text": "...", "success": "..."}]}. Every text '
    f'at most {MAX_TEXT_CHARS} characters. ' + DATA_NOTICE
)


def _guide(answer: Mapping[str, Any] | None, criteria_ids: set[str], persona_ids: set[str]) -> list[dict[str, Any]]:
    guide = []
    seen: set[str] = set()
    for entry in _list(answer, 'guide'):
        criterion_id = entry.get('criterion_id') if isinstance(entry, Mapping) else None
        if criterion_id not in criteria_ids or criterion_id in seen:
            continue
        questions = [text for raw in _list(entry, 'questions') if (text := _clean(raw))][:MAX_GUIDE_QUESTIONS]
        probes = [{'persona_id': probe['persona_id'], 'probe': text} for probe in _list(entry, 'probes')
                  if isinstance(probe, Mapping) and probe.get('persona_id') in persona_ids
                  and (text := _clean(probe.get('probe')))]
        if questions:
            seen.add(str(criterion_id))
            guide.append({'criterion_id': criterion_id, 'questions': questions, 'probes': probes})
    return guide


def draft_plan(*, criteria: Sequence[Mapping[str, Any]], personas: Sequence[Mapping[str, Any]],
               outline: Mapping[str, Any] | None, walkthrough: Sequence[Mapping[str, Any]], language: object = None,
               invoke: Invoke = default_invoke) -> dict[str, Any]:
    """``{guide: [{criterion_id, questions, probes}], tasks: [{text, success}]}``, or a 400 when unusable."""
    steps = '\n'.join(f"Step: {step.get('title')}: {step.get('body')}" for step in walkthrough)
    prompt = '\n\n'.join(part for part in (
        f'Plan the validation. {language_line(language)}', script_block(criteria),
        _personas_block(personas),
        data_block('prototype_outline', f"{outline_text(outline)}\n{steps}".strip() if outline else ''),
    ) if part)
    answer = parse_json_object(invoke(prompt, _PLAN_SYSTEM, PLAN_MAX_TOKENS, 'validation_plan'))
    guide = _guide(answer, {c['id'] for c in criteria}, {str(p['persona_id']) for p in personas})
    tasks = [{'text': text, 'success': _clean(entry.get('success'))} for entry in _list(answer, 'tasks')
             if isinstance(entry, Mapping) and (text := _clean(entry.get('text')))][:MAX_TASKS]
    if not guide or not tasks:
        raise ValidationError(NO_PLAN)
    return {'guide': guide, 'tasks': tasks}


# ── A synthetic run: one persona ─────────────────────────────────────────────────────────────────────────────

_PERSONA_INSTRUCTIONS: Final = (
    'You are trying a product prototype from its screens (the outline) as yourself: your goals, frustrations and '
    'context. For each task, say honestly whether you could do it on these screens ("completed", "struggled" or '
    '"failed") and why in one sentence; then rate each criterion from 1 (not at all) to 5 (completely) with one '
    'sentence. Answer with one JSON object only: {"tasks": [{"id": "...", "outcome": "...", "note": "..."}], '
    '"criteria": [{"id": "...", "rating": 1-5, "note": "..."}], "summary": "two sentences at most"}. '
    + DATA_NOTICE
)


def persona_system_prompt(persona: Mapping[str, Any]) -> str:
    return (f'You are a synthetic customer persona. Stay in character.\n\n'
            f'{data_block("reference", persona_prompt_block(dict(persona)))}\n\n{_PERSONA_INSTRUCTIONS}')


def _by_id(entries: list[Any], ids: set[str]) -> dict[str, Mapping[str, Any]]:
    return {str(entry['id']): entry for entry in entries if isinstance(entry, Mapping) and entry.get('id') in ids}


def parse_persona_verdict(reply: str, persona: Mapping[str, Any], task_ids: set[str],
                          criteria_ids: set[str]) -> dict[str, Any] | None:
    """``{persona_id, name, tasks: {id: {outcome, note}}, criteria: {id: {rating, note}}, summary}``; None when the
    reply names no task and no criterion."""
    answer = parse_json_object(reply)
    tasks = {tid: {'outcome': entry['outcome'], 'note': _clean(entry.get('note'), MAX_NOTE_CHARS)}
             for tid, entry in _by_id(_list(answer, 'tasks'), task_ids).items() if entry.get('outcome') in OUTCOMES}
    criteria = {}
    for cid, entry in _by_id(_list(answer, 'criteria'), criteria_ids).items():
        rating = entry.get('rating')
        if isinstance(rating, int | float) and not isinstance(rating, bool) and 1 <= rating <= 5:
            criteria[cid] = {'rating': round(float(rating), 1), 'note': _clean(entry.get('note'), MAX_NOTE_CHARS)}
    if not tasks and not criteria:
        return None
    return {'persona_id': str(persona['persona_id']), 'name': str(persona.get('name') or 'Persona')[:120],
            'tasks': tasks, 'criteria': criteria, 'summary': _clean((answer or {}).get('summary'), MAX_NOTE_CHARS)}


def persona_prompt(tasks: Sequence[Mapping[str, Any]], criteria: Sequence[Mapping[str, Any]],
                   outline: Mapping[str, Any], walkthrough: Sequence[Mapping[str, Any]]) -> str:
    steps = '\n'.join(f"Step: {step.get('title')}: {step.get('body')}" for step in walkthrough)
    return '\n\n'.join(part for part in (
        'Try the prototype and answer for each task and criterion.', script_block(criteria, tasks),
        data_block('prototype_outline', f'{outline_text(outline)}\n{steps}'.strip()),
    ) if part)


def run_personas(personas: Sequence[Mapping[str, Any]], tasks: Sequence[Mapping[str, Any]],
                 criteria: Sequence[Mapping[str, Any]], outline: Mapping[str, Any],
                 walkthrough: Sequence[Mapping[str, Any]], *, invoke: Invoke = default_invoke) -> list[dict[str, Any]]:
    """Each persona's verdict, ``PERSONA_CONCURRENCY`` at a time; one whose call failed or answered nothing usable is
    left out (one never sinks the run)."""
    prompt = persona_prompt(tasks, criteria, outline, walkthrough)
    task_ids, criteria_ids = {task['id'] for task in tasks}, {criterion['id'] for criterion in criteria}
    with ThreadPoolExecutor(max_workers=PERSONA_CONCURRENCY) as pool:
        replies = list(pool.map(lambda persona: guarded_reply(
            lambda: invoke(prompt, persona_system_prompt(persona), PERSONA_MAX_TOKENS, 'validation_synthetic'),
            'Synthetic validation call failed'), personas))
    verdicts = (parse_persona_verdict(reply, persona, task_ids, criteria_ids)
                for persona, reply in zip(personas, replies, strict=True) if reply is not None)
    return [verdict for verdict in verdicts if verdict is not None]


# ── The report's summary ─────────────────────────────────────────────────────────────────────────────────────

_SUMMARY_SYSTEM: Final = (
    'You write the summary of a prototype validation report for a product team, from results already computed. '
    'Say which success criteria real testers met, which they did not and which lack data, and what testers said '
    'was missing. Synthetic persona results are labelled synthetic: mention them only as such, never as evidence '
    'that a criterion is met. State no number the results do not hold. Plain text, at most '
    + str(MAX_SUMMARY_CHARS) + ' characters, no headings. ' + DATA_NOTICE
)


def report_summary(results_text: str, *, language: object = None, invoke: Invoke = default_invoke) -> str:
    """The summary paragraph ('' when the reply is unusable: the report keeps its computed tables either way)."""
    prompt = '\n\n'.join((f'Summarise these results. {language_line(language)}',
                          data_block('validation_results', results_text)))
    # The computed report stands without its summary.
    reply = guarded_reply(lambda: invoke(prompt, _SUMMARY_SYSTEM, SUMMARY_MAX_TOKENS, 'validation_report'),
                          'Validation report summary failed')
    text = (reply or '').strip()[:MAX_SUMMARY_CHARS]
    return '' if injection_findings(text) else text
