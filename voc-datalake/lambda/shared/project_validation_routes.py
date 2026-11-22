"""The Validate step's routes (7.68.00, docs/project-workspace.md → Validate) on the projects API's ``/projects/{proxy+}``
(no API Gateway resource of their own), included by ``api/projects_handler.py``. Its project-access middleware gates
the project in the path first, and every route here needs EDIT, the GET too (``shared.project_access``: its results
quote what testers typed, as a prototype's pins do):

    GET  /projects/{id}/validation              -> {validation, methodology, form, synthetic, real, criteria, tasks,
                                                    decision_prefill}
    POST /projects/{id}/validation/criteria     {prd_document_id?, replace?, response_language?} -> 202 job
    PUT  /projects/{id}/validation/criteria     {criteria, expected_revision?}                   -> {validation}
    POST /projects/{id}/validation/plan         {mode?: ai | blank, response_language?}          -> 202 job | 201
    POST /projects/{id}/validation/synthetic    {persona_ids?}                                   -> 202 job
    PUT  /projects/{id}/validation/form         {tasks, open, language?, prototype_document_id?,
                                                 expected_revision?}                             -> {validation, form}
    POST /projects/{id}/validation/report       {response_language?}                             -> 202 job

The three AI steps (criteria, plan, synthetic run, report summary: one model call each, a persona each for the run)
are assist jobs (shared/assist_jobs.py) run by the projects API's 15-minute twin (``ASSIST_WORK``), polled at
``GET /projects/{id}/jobs/{job_id}``. AI-backed by design, like research (TENETS.md tenet 3); a Human-driven person
writes the plan by hand (``mode: blank``) and the criteria and tasks always. A skipped upstream step (no prototype, no
PRD) is reported in the ``methodology`` block, never refused (owner decision, 7.68.00), except where the step has
nothing to work on (no criteria to plan from, no prototype to run on).

Real results are read as the caller (their category and source access: ``category_gate``), the report's as its
starter (their scope stored in the job's config). Projects are the deployment's (docs/multi-workspace.md, phase 3).
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from typing import Any, Final

from aws_lambda_powertools.event_handler import Response, content_types
from aws_lambda_powertools.event_handler.api_gateway import Router

from shared import assist_jobs, category_access, category_gate, methodology
from shared import forms_v2 as fv2
from shared import project_validation as pv
from shared import prototype_validation as proto
from shared import validation_ai as ai
from shared import validation_documents as docs
from shared.api import decimal_default
from shared.aws import get_s3_client
from shared.delete_audit import actor_from_event
from shared.dynamo_values import plain
from shared.exceptions import ConflictError, NotFoundError, ValidationError
from shared.logging import tracer
from shared.project_keys import project_pk
from shared.project_tables import iter_project_rows
from shared.prototype_outline import outline_of
from shared.prototype_pins import pin_form_id
from shared.prototype_versions import version_html
from shared.prototype_walkthrough import extract_steps
from shared.request_body import json_object_body
from shared.tables import configured_table, get_aggregates_table, get_feedback_table, get_projects_table

app = Router()

ASSIST_CRITERIA: Final = 'assist_validation_criteria'
ASSIST_PLAN: Final = 'assist_validation_plan'
ASSIST_SYNTHETIC: Final = 'assist_validation_synthetic'
ASSIST_REPORT: Final = 'assist_validation_report'
#: Personas one synthetic run asks (the persona review's bound).
MAX_RUN_PERSONAS: Final = 6
#: The real responses a report keeps as its lineage (``input_feedback_ids``).
MAX_REPORT_FEEDBACK_IDS: Final = 500
PLAN_MODES: Final = ('ai', 'blank')
#: What the view reads of the project's rows (never a document's content).
_ROW_FIELDS: Final = ('sk', 'document_id', 'document_type', 'persona_id', 'name', 'title', 'version', 'created_at')

NEEDS_CRITERIA: Final = 'Set the success criteria first'
NEEDS_TASKS: Final = 'Save the tasks testers try first (from the plan, or your own)'
NO_PROTOTYPE: Final = 'This project has no prototype to validate yet'
NO_PERSONAS: Final = 'This project has no personas to run the script with'
NO_PRD: Final = 'This project has no PRD to read the criteria from: write them yourself'
NO_VERDICT: Final = 'No persona answered. Please try again.'


def _projects() -> Any:
    return configured_table(get_projects_table(), 'Projects')


def _forms() -> Any:
    """voc-aggregates: the pin forms, and the category access rows ``category_gate`` reads."""
    return configured_table(get_aggregates_table(), 'Aggregates')


def _scope() -> category_access.CategoryScope:
    """The caller's category and source access (a restricted caller's row read once a request)."""
    return category_gate.scope_for_event(app.current_event.raw_event, _forms())


def _actor() -> dict[str, str]:
    return actor_from_event(app.current_event.raw_event)


def _rows(table: Any, project_id: str) -> list[dict[str, Any]]:
    names = {f'#f{i}': name for i, name in enumerate(_ROW_FIELDS)}
    return list(iter_project_rows(table, project_id, ProjectionExpression=', '.join(names),
                                  ExpressionAttributeNames=names, ConsistentRead=True))


def _newest(rows: Sequence[Mapping[str, Any]], prefix: str) -> str | None:
    found = [row for row in rows if str(row.get('sk', '')).startswith(prefix) and row.get('document_id')]
    newest = max(found, key=lambda row: str(row.get('created_at') or ''), default=None)
    return str(newest['document_id']) if newest else None


def _row(table: Any, project_id: str, sort_key: str, missing: str) -> dict[str, Any]:
    item = table.get_item(Key={'pk': project_pk(project_id), 'sk': sort_key}, ConsistentRead=True).get('Item')
    if not item:
        raise NotFoundError(missing)
    return item


def _personas(rows: Sequence[Mapping[str, Any]], wanted: object) -> list[str]:
    ids = [str(row['persona_id']) for row in rows if str(row.get('sk', '')).startswith('PERSONA#')
           and row.get('persona_id')]
    if wanted is None:
        return ids[:MAX_RUN_PERSONAS]
    if not isinstance(wanted, list) or not wanted or len(wanted) > MAX_RUN_PERSONAS or \
            not all(isinstance(one, str) for one in wanted):
        raise ValidationError(f'persona_ids must be a list of 1 to {MAX_RUN_PERSONAS} persona ids')
    return [one for one in dict.fromkeys(wanted) if one in ids]


def _language(body: Mapping[str, Any], key: str = 'response_language') -> str | None:
    value = body.get(key)
    if value is not None and value not in fv2.FORM_LOCALES:
        raise ValidationError(f'{key} must be one of: {", ".join(fv2.FORM_LOCALES)}')
    return value


def _accepted(project_id: str, job_type: str, config: dict[str, Any], **extra: Any) -> Response:
    """Record the assist and hand it to the worker: 202 ``{success, job_id, status, …extra}``."""
    started = assist_jobs.start(project_pk(project_id), job_type, {**config, 'project_id': project_id,
                                                                   'actor': _actor()},
                                worker_function=assist_jobs.worker_function(), initiated_by=_actor()['sub'],
                                project_id=project_id)
    return Response(status_code=202, content_type=content_types.APPLICATION_JSON,
                    body=json.dumps({**started, **extra}, default=decimal_default))


def _prototype_screens(table: Any, project_id: str, document_id: str) -> tuple[dict[str, Any], list[dict]]:
    """The prototype version's outline and walkthrough (what anyone who opens it sees, never its pins)."""
    row = _row(table, project_id, f'PROTOTYPE#{document_id}', 'Prototype not found')
    html = version_html(get_s3_client(), os.environ.get('RAW_DATA_BUCKET', ''), project_id, row)
    return outline_of(html), extract_steps(html)


# ── GET: status and results ─────────────────────────────────────────────────────────────────────────────────

def _run_figures(table: Any, project_id: str, run_id: object) -> dict[str, Any] | None:
    """The latest synthetic run's figures (labelled ``synthetic``), None without one."""
    if not isinstance(run_id, str) or not run_id:
        return None
    item = table.get_item(Key={'pk': project_pk(project_id), 'sk': f'DOC#{run_id}'}, ConsistentRead=True).get('Item')
    run = plain(item.get('run')) if item and isinstance(item.get('run'), Mapping) else None
    if not run:
        return None
    return {'document_id': run_id, 'created_at': item.get('created_at'), 'synthetic': True,
            'personas': len(run.get('verdicts') or []), 'tasks': run.get('tasks') or {},
            'criteria': run.get('criteria') or {}}


def _real(form: Mapping[str, Any] | None, block: Mapping[str, Any], scope: category_access.CategoryScope
          ) -> dict[str, Any] | None:
    """The real testers' results on the card (None before its questions were saved)."""
    if not form or not fv2.is_v2(form):
        return None
    form_id = str(form['form_id'])
    rows = proto.real_rows(configured_table(get_feedback_table(), 'Feedback'), form_id, scope)
    return proto.real_summary(fv2.definition_of(form), rows, proto.revisions_of(_forms(), form_id),
                              block.get('tasks') or [], block.get('criteria') or [])


def _form(block: Mapping[str, Any]) -> dict[str, Any] | None:
    """The card's pin form, None before it was saved or once the form is gone (deleted on the Feedback forms page)."""
    form_id = block.get('form_id')
    if not isinstance(form_id, str) or not form_id:
        return None
    try:
        return proto.read_pin_form(_forms(), form_id)
    except NotFoundError:
        return None


def _form_view(form: Mapping[str, Any] | None, block: Mapping[str, Any],
               rows: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """The card's state, whether it lags the criteria and tasks saved since (``stale``: save the card again), and the
    newest prototype version when the card is on an older one (``newer_version``: its testers see no card)."""
    if not form:
        return None
    state = proto.form_state(form)
    newest = _newest(rows, 'PROTOTYPE#')
    state['newer_version'] = newest if newest and newest != block.get('prototype_document_id') else None
    language = str(block.get('form_language') or fv2.DEFAULT_LOCALE)
    wanted = proto.definition_for(block.get('tasks') or [], block.get('criteria') or [], language)
    try:
        expected = fv2.validate_definition(wanted)
    except ValidationError:
        expected = wanted
    current = fv2.definition_of(form)
    state['stale'] = json.dumps(plain(current), sort_keys=True) != json.dumps(plain(expected), sort_keys=True)
    return state


def results(table: Any, project_id: str, meta: Mapping[str, Any], scope: category_access.CategoryScope,
            rows: Sequence[Mapping[str, Any]]) -> tuple[dict[str, Any], list[str]]:
    """The Validation tab's whole view (and the report's figures), and the real responses' feedback ids. ``rows``: the
    project's rows (``_rows``)."""
    block = pv.block_of(meta)
    form = _form(block)
    synthetic = _run_figures(table, project_id, block.get('run_document_id'))
    real = _real(form, block, scope)
    feedback_ids = list((real or {}).get('feedback_ids') or [])
    criteria = pv.criteria_results(block.get('criteria') or [], real, synthetic)
    prefill = pv.decision_prefill(str(meta.get('name') or 'the prototype'), criteria,
                                  report_document_id=block.get('report_document_id'), feedback_ids=feedback_ids,
                                  responses=int((real or {}).get('responses') or 0)) if criteria else None
    return {'validation': block, 'form': _form_view(form, block, rows), 'synthetic': synthetic,
            'real': {key: value for key, value in real.items() if key != 'feedback_ids'} if real else None,
            'criteria': criteria, 'tasks': pv.task_results(block.get('tasks') or [], real, synthetic),
            'decision_prefill': prefill}, feedback_ids


@app.get("/projects/<project_id>/validation")
@tracer.capture_method
def get_validation(project_id: str) -> dict[str, Any]:
    table = _projects()
    meta = pv.read_meta(table, project_id)
    scope = _scope()
    rows = _rows(table, project_id)
    view, _feedback_ids = results(table, project_id, meta, scope, rows)
    return {'success': True, **view, 'methodology': methodology.assess('validation', rows)}


# ── Criteria ─────────────────────────────────────────────────────────────────────────────────────────────────

@app.post("/projects/<project_id>/validation/criteria")
@tracer.capture_method
def extract_validation_criteria(project_id: str):
    """Parse the PRD's Success Metrics into criteria (an assist job that saves them): once, unless ``replace``."""
    body = json_object_body(app)
    table = _projects()
    block = pv.block_of(pv.read_meta(table, project_id))
    if block.get('criteria') and body.get('replace') is not True:
        raise ConflictError('This project already has success criteria: edit them, or ask again with replace',
                            code='criteria_exist')
    prd_id = body.get('prd_document_id')
    if prd_id is not None:
        if not isinstance(prd_id, str):
            raise ValidationError('prd_document_id must be a document id')
        _row(table, project_id, f'PRD#{prd_id}', 'PRD not found')
    else:
        prd_id = _newest(_rows(table, project_id), 'PRD#')
    if not prd_id:
        raise ValidationError(NO_PRD)
    return _accepted(project_id, ASSIST_CRITERIA, {'prd_document_id': prd_id, 'response_language': _language(body)})


def _criteria_work(config: dict[str, Any]) -> dict[str, Any]:
    table = _projects()
    project_id, prd_id = config['project_id'], config['prd_document_id']
    prd = _row(table, project_id, f'PRD#{prd_id}', 'PRD not found')
    criteria = ai.extract_criteria(str(prd.get('content') or ''), language=config.get('response_language'))
    block = pv.update_block(table, project_id, lambda _stored: {'criteria': criteria, 'prd_document_id': prd_id},
                            actor=config['actor'], reason=pv.REASON_CRITERIA_EXTRACTED)
    return {'validation': block}


@app.put("/projects/<project_id>/validation/criteria")
@tracer.capture_method
def save_validation_criteria(project_id: str) -> dict[str, Any]:
    body = json_object_body(app)
    criteria = pv.validated_criteria(body.get('criteria'))
    block = pv.update_block(_projects(), project_id, lambda _stored: {'criteria': criteria}, actor=_actor(),
                            reason=pv.REASON_CRITERIA_EDITED,
                            expected_revision=pv.validated_expected_revision(body.get('expected_revision')))
    return {'success': True, 'validation': block}


# ── The plan ─────────────────────────────────────────────────────────────────────────────────────────────────

def _criteria_or_400(block: Mapping[str, Any]) -> list[dict[str, Any]]:
    criteria = block.get('criteria') or []
    if not criteria:
        raise ValidationError(NEEDS_CRITERIA)
    return criteria


@app.post("/projects/<project_id>/validation/plan")
@tracer.capture_method
def write_validation_plan(project_id: str):
    """The plan from the criteria, the personas and the prototype (``ai``, a job), or a hand-written one from the blank
    template (``blank``, 201 now); the methodology block says what upstream step it was made without."""
    body = json_object_body(app)
    mode = body.get('mode', 'ai')
    if mode not in PLAN_MODES:
        raise ValidationError(f'mode must be one of: {", ".join(PLAN_MODES)}')
    table = _projects()
    meta = pv.read_meta(table, project_id)
    criteria = _criteria_or_400(pv.block_of(meta))
    rows = _rows(table, project_id)
    assessment = methodology.assess('validation', rows)
    if mode == 'ai':
        return _accepted(project_id, ASSIST_PLAN, {
            'prototype_document_id': _newest(rows, 'PROTOTYPE#'), 'persona_ids': _personas(rows, None),
            'response_language': _language(body), 'methodology': assessment,
        }, methodology=assessment)
    name = str(meta.get('name') or 'Project')
    item = docs.create_document(table, project_id, pv.PLAN_TYPE, f'Validation plan: {name}',
                                docs.blank_plan(name, criteria),
                                {'origin': 'human', 'methodology': {**assessment, 'evidence': 0},
                                 'plan': {'guide': [], 'tasks': [], 'persona_ids': []}},
                                creator_sub=_actor()['sub'])
    pv.update_block(table, project_id, lambda _stored: {'plan_document_id': item['document_id']},
                    actor=_actor(), reason=pv.REASON_PLAN_WRITTEN)
    return Response(status_code=201, content_type=content_types.APPLICATION_JSON,
                    body=json.dumps({'success': True, 'document': item, 'methodology': assessment},
                                    default=decimal_default))


def _persona_rows(table: Any, project_id: str, persona_ids: Sequence[str]) -> list[dict[str, Any]]:
    wanted = set(persona_ids)
    rows = iter_project_rows(table, project_id, sort_prefix='PERSONA#', ConsistentRead=True)
    return [row for row in rows if row.get('persona_id') in wanted]


def _plan_work(config: dict[str, Any]) -> dict[str, Any]:
    table = _projects()
    project_id = config['project_id']
    meta = pv.read_meta(table, project_id)
    criteria = _criteria_or_400(pv.block_of(meta))
    prototype_id = config.get('prototype_document_id')
    outline, steps = _prototype_screens(table, project_id, prototype_id) if prototype_id else (None, [])
    personas = _persona_rows(table, project_id, config.get('persona_ids') or [])
    plan = ai.draft_plan(criteria=criteria, personas=personas, outline=outline, walkthrough=steps,
                         language=config.get('response_language'))
    name = str(meta.get('name') or 'Project')
    item = docs.create_document(
        table, project_id, pv.PLAN_TYPE, f'Validation plan: {name}',
        docs.render_plan(name, criteria, plan, {str(p['persona_id']): str(p.get('name') or 'Persona') for p in personas}),
        {'origin': 'ai', 'methodology': config.get('methodology') or {},
         'plan': {**plan, 'prototype_document_id': prototype_id, 'persona_ids': [p['persona_id'] for p in personas]}},
        creator_sub=str(config['actor'].get('sub') or ''))

    def changes(stored: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {'plan_document_id': item['document_id']}
        if prototype_id and not stored.get('prototype_document_id'):
            out['prototype_document_id'] = prototype_id
        if not stored.get('tasks'):
            out['tasks'] = pv.validated_tasks([{'text': task['text']} for task in plan['tasks']])
        return out

    block = pv.update_block(table, project_id, changes, actor=config['actor'], reason=pv.REASON_PLAN_WRITTEN)
    return {'document_id': item['document_id'], 'validation': block, 'methodology': config.get('methodology')}


# ── A synthetic run ──────────────────────────────────────────────────────────────────────────────────────────

def _prototype_of(block: Mapping[str, Any], rows: Sequence[Mapping[str, Any]]) -> str:
    """The prototype a run or the card is for: the newest version (a new one made since moves them on), else the one
    the step last used."""
    prototype_id = _newest(rows, 'PROTOTYPE#') or block.get('prototype_document_id')
    if not prototype_id:
        raise ValidationError(NO_PROTOTYPE)
    return str(prototype_id)


#: What the widget that draws the card says of itself (static/prototype-pin-widget.js): in a version's HTML only when
#: the version was made with that widget (7.68.00 on).
CARD_WIDGET_MARKER: Final = 'validationCard: true'


def _shows_card(table: Any, project_id: str, prototype_id: str) -> bool:
    """Whether that version's widget can draw the card (an older version's asks for none: make a new one)."""
    row = _row(table, project_id, f'PROTOTYPE#{prototype_id}', 'Prototype not found')
    try:
        html = version_html(get_s3_client(), os.environ.get('RAW_DATA_BUCKET', ''), project_id, row)
    except (NotFoundError, ValidationError):
        return False
    return CARD_WIDGET_MARKER in html


def _synthetic_config(table: Any, project_id: str, wanted: object) -> dict[str, Any]:
    """What a synthetic run needs before its job starts (criteria, tasks, a prototype, personas), as its config."""
    block = pv.block_of(pv.read_meta(table, project_id))
    if _criteria_or_400(block) and not block.get('tasks'):
        raise ValidationError(NEEDS_TASKS)
    rows = _rows(table, project_id)
    config = {'prototype_document_id': _prototype_of(block, rows), 'persona_ids': _personas(rows, wanted)}
    if not config['persona_ids']:
        raise ValidationError(NO_PERSONAS)
    return config


@app.post("/projects/<project_id>/validation/synthetic")
@tracer.capture_method
def run_synthetic_validation(project_id: str):
    """The personas try the test script on the prototype's screens (a job): synthetic, never "met"."""
    return _accepted(project_id, ASSIST_SYNTHETIC,
                     _synthetic_config(_projects(), project_id, json_object_body(app).get('persona_ids')))


def _synthetic_work(config: dict[str, Any]) -> dict[str, Any]:
    table = _projects()
    project_id = config['project_id']
    block = pv.block_of(pv.read_meta(table, project_id))
    criteria, tasks = _criteria_or_400(block), block.get('tasks') or []
    if not tasks:
        raise ValidationError(NEEDS_TASKS)
    outline, steps = _prototype_screens(table, project_id, config['prototype_document_id'])
    personas = _persona_rows(table, project_id, config.get('persona_ids') or [])
    verdicts = ai.run_personas(personas, tasks, criteria, outline, steps)
    if not verdicts:
        raise ValidationError(NO_VERDICT)
    tallies = docs.run_tallies(verdicts, tasks, criteria)
    item = docs.create_document(
        table, project_id, pv.RUN_TYPE, 'Synthetic validation run', docs.render_run(verdicts, tallies, tasks, criteria),
        {'run': {**tallies, 'verdicts': verdicts, 'prototype_document_id': config['prototype_document_id'],
                 'persona_ids': [p['persona_id'] for p in personas]}},
        creator_sub=str(config['actor'].get('sub') or ''))
    block = pv.update_block(table, project_id, lambda _stored: {'run_document_id': item['document_id']},
                            actor=config['actor'], reason=pv.REASON_SYNTHETIC_RUN)
    return {'document_id': item['document_id'], 'synthetic': True, 'personas': len(verdicts), 'validation': block}


# ── The card for real testers ────────────────────────────────────────────────────────────────────────────────

@app.put("/projects/<project_id>/validation/form")
@tracer.capture_method
def save_validation_form(project_id: str) -> dict[str, Any]:
    """The tasks, and the card on the prototype's own pin form (its next revision), offered or not (``open``).

    The project's block is written first, conditional on the revision it read (``expected_revision``: a 409 for any
    write in between), with the card's definition built from the criteria it holds and checked against the pin form
    (a 400 or 409 before any write); the pin form second. A write that fails in between leaves the card ``stale`` in
    the view, never a block and a card that disagree unseen. Moving the card to a newer prototype version turns it off
    on the version it leaves."""
    body = json_object_body(app)
    tasks = pv.validated_tasks(body.get('tasks'))
    if not isinstance(body.get('open'), bool):
        raise ValidationError('open must be true or false')
    language = _language(body, 'language') or fv2.DEFAULT_LOCALE
    expected = pv.validated_expected_revision(body.get('expected_revision'))
    table = _projects()
    block = pv.block_of(pv.read_meta(table, project_id))
    _criteria_or_400(block)
    if expected is not None and int(block.get('revision') or 0) != expected:
        raise ConflictError(pv.STALE_MESSAGE, code=pv.CHANGED_CODE, details={'revision': block.get('revision') or 0})
    rows = _rows(table, project_id)
    prototype_id = body.get('prototype_document_id')
    if prototype_id is not None:
        if not isinstance(prototype_id, str):
            raise ValidationError('prototype_document_id must be a document id')
        _row(table, project_id, f'PROTOTYPE#{prototype_id}', 'Prototype not found')
    else:
        prototype_id = _prototype_of(block, rows)
    form_id, shows_card, forms = pin_form_id(prototype_id), _shows_card(table, project_id, prototype_id), _forms()
    card: dict[str, Any] = {}

    def changes(stored: dict[str, Any]) -> dict[str, Any]:
        card['definition'] = proto.check_questions(
            forms, form_id, proto.definition_for(tasks, _criteria_or_400(stored), language))
        card['previous'] = stored.get('form_id')
        return {'tasks': tasks, 'prototype_document_id': prototype_id, 'form_id': form_id, 'form_open': body['open'],
                'form_language': language, 'card_in_prototype': shows_card}

    saved = pv.update_block(table, project_id, changes, actor=_actor(), reason=pv.REASON_FORM_SAVED,
                            expected_revision=expected)
    form = proto.save_questions(forms, form_id, card['definition'], open_card=body['open'], actor_sub=_actor()['sub'])
    if isinstance(card['previous'], str) and card['previous'] and card['previous'] != form_id:
        proto.close_card(forms, card['previous'], actor_sub=_actor()['sub'])
    return {'success': True, 'validation': saved, 'form': _form_view(form, saved, rows)}


# ── The report ───────────────────────────────────────────────────────────────────────────────────────────────

@app.post("/projects/<project_id>/validation/report")
@tracer.capture_method
def write_validation_report(project_id: str):
    """The report (a job), read with the caller's category and source access, which the job carries."""
    body = json_object_body(app)
    table = _projects()
    _criteria_or_400(pv.block_of(pv.read_meta(table, project_id)))
    scope = _scope()
    assessment = methodology.assess('validation', _rows(table, project_id))
    return _accepted(project_id, ASSIST_REPORT, {
        'response_language': _language(body), category_access.SCOPE_CONFIG_KEY: category_access.scope_to_config(scope),
        'methodology': assessment,
    }, methodology=assessment)


def results_text(view: Mapping[str, Any]) -> str:
    """The computed results as the summary's DATA: figures, statuses, the synthetic readings (labelled) and how many
    testers said what was missing, never what they wrote (the report quotes no tester: its readers have VIEW)."""
    real = view.get('real') or {}
    lines = [f"Real tester responses: {real.get('responses', 0)}"]
    for result in view.get('criteria') or []:
        synthetic = result.get('synthetic') or {}
        lines.append(f"Criterion: {result['text']} | target {result['target']:g} of 5 | real average "
                     f"{result['real'].get('average')} from {result['real'].get('n', 0)} | outcome {result['outcome']} | "
                     f"synthetic personas' average {synthetic.get('average')} (synthetic, not evidence)")
    lines.extend(f"Task: {task['text']} | real success rate {task['real'].get('rate')} from "
                     f"{task['real'].get('n', 0)}" for task in view.get('tasks') or [])
    lines.append(f"Testers who said what was missing: {len(real.get('missing') or [])}")
    return '\n'.join(lines)


def _report_work(config: dict[str, Any]) -> dict[str, Any]:
    table = _projects()
    project_id = config['project_id']
    meta = pv.read_meta(table, project_id)
    _criteria_or_400(pv.block_of(meta))
    scope = category_access.scope_from_config(config.get(category_access.SCOPE_CONFIG_KEY)) or category_access.NOTHING
    view, feedback_ids = results(table, project_id, meta, scope, _rows(table, project_id))
    summary = ai.report_summary(results_text(view), language=config.get('response_language'))
    real = view.get('real') or {}
    report = {'tasks': view['tasks'], 'ces': real.get('ces') or {},
              'responses': int(real.get('responses') or 0), 'missing_count': len(real.get('missing') or []),
              'synthetic_run_id': (view.get('synthetic') or {}).get('document_id'),
              'form_id': (view.get('form') or {}).get('form_id'), 'form_revision': (view.get('form') or {}).get(
                  'revision'), 'summary': summary}
    name = str(meta.get('name') or 'Project')
    item = docs.create_document(table, project_id, pv.REPORT_TYPE, f'Validation report: {name}',
                                docs.render_report(name, view['criteria'], report, summary),
                                {'results': view['criteria'], 'report': report,
                                 'methodology': config.get('methodology') or {},
                                 'feedback_ids': feedback_ids[:MAX_REPORT_FEEDBACK_IDS]},
                                creator_sub=str(config['actor'].get('sub') or ''))
    block = pv.update_block(table, project_id, lambda _stored: {'report_document_id': item['document_id']},
                            actor=config['actor'], reason=pv.REASON_REPORT_WRITTEN)
    prefill = pv.decision_prefill(name, view['criteria'], report_document_id=item['document_id'],
                                  feedback_ids=feedback_ids, responses=report['responses'])
    return {'document_id': item['document_id'], 'validation': block, 'decision_prefill': prefill}


#: The assist kinds the projects API's twin runs for these routes (``api/projects_handler.py`` ``ASSIST_WORK``).
ASSIST_WORK: Final = {
    ASSIST_CRITERIA: assist_jobs.Work(_criteria_work, 'Could not read the criteria from the PRD. Please try again.'),
    ASSIST_PLAN: assist_jobs.Work(_plan_work, 'Could not write the validation plan. Please try again.'),
    ASSIST_SYNTHETIC: assist_jobs.Work(_synthetic_work, 'The synthetic run failed. Please try again.'),
    ASSIST_REPORT: assist_jobs.Work(_report_work, 'Could not write the validation report. Please try again.'),
}
