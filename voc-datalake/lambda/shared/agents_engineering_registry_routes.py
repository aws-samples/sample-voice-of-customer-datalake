"""The Registry, the quality gates, the assertions, a flow's expansion and an automation's pause (7.52.00; included by
``api/agents_handler.py``).

    GET  /agents/engineering/registry?connection=&month=        -> {month, connection, cards: [...], bedrock_enabled}
    GET  /agents/engineering/registry/<card>?connection=&month= -> {card, versions, events, bedrock_enabled}
    POST /agents/engineering/registry/cards                      -> 201 {card}
    PUT  /agents/engineering/registry/<role>/model               -> {role, model_choice, updated_at, updated_by}
    GET  /agents/engineering/gates?connection=                   -> {packs, aliases, own_gate, briefs, runners, ...}
    GET  /agents/engineering/gates/briefs/<id>                   -> {id, path, packs, digest, bytes, text}
    GET  /agents/engineering/assertions                          -> {checks, on_fail, default_on_fail, max, roles}
    GET  /agents/engineering/templates/<kind>/<id>/source        -> {kind, id, path, text, digest, template_version}
    GET  /agents/engineering/skill-library                       -> {skills: [...]} (7.56.00, without their text)
    GET  /agents/engineering/skill-library/<name>?reference=     -> {name, reference, path, text, digest, bytes}
    GET  /workflows/<workflow_id>/expanded?revision=             -> {workflow_id, revision, definition, expansion, ...}
    POST /agents/<agent_id>/pause, POST /agents/<agent_id>/resume -> {agent}

- **The Registry** (docs/autonomous-agents.md "Registry"): every role's card, composed here (engineering/registry/
  views.py: its template, the skill the scope runs, its model, tools, gates, inputs and outputs, caps, scorecard and
  the month's spend by role), then the cards administrators made from a skill (engineering/registry/cards.py).
  **The contract**: every role of the bundle has a card whose id is the role (``kind: role``), so a flow's step that
  names only a role resolves to it; ``?connection=<id>`` composes each for that connection's skill head (its own
  current version, else the shared one), and without it each answers the shared head plus ``heads_by_connection``
  (what every stored connection runs of the role). A card
  is made from a role's ACCEPTED skill version (``{from_skill: {role, connection?, version}, slug, purpose, title?,
  model?, caps?, expected_version?}``): its id ``<role>-<slug>``, its model and tools its skill version's (an allowed
  model, tools the role may have), its caps at most the template's; written with its log row in one transaction.
  Its ``node`` is the agent step the Flows palette drops: ``{role, skill_version, model, card}``.
- **A role's model** (7.58.00, engineering/model_choices.py): every card says its role's model choice in this
  deployment (``model_choice``, the Registry's; ``template_model_choice``, its template card's; who changed it and
  when) and the harness the role runs on (``runs_on``: ``native`` or ``kiro``), and the listing the Bedrock models the
  native harness may run here (``bedrock_enabled``: granted and priced). ``PUT …/registry/<role>/model`` sets it
  (``{model}``: ``auto``, ``opus``, ``sonnet``, ``haiku``, another model id, or null for the role's default), with its
  history row (engineering/settings.py ``ROLE_MODELS_KEY``).
- **The quality gates**: the gate packs' steps (each with its messages and its vacuous-pass rule in words), the
  tools whose versions a gate records, image pins and the owner's briefs, from the orchestration bundle (``gates``),
  with the gate's stop reasons (a code, a text key and the words) and who runs a gate that names nobody
  (``defaults``: ``gate-runner@latest``, ``final-go@latest``); read only. Quality gates are a filter of the Registry
  tab (the web app's). Since 7.52.00's integration a brief's text is read on its own (``…/gates/briefs/<id>``: the
  briefs are 45-156 KB each), and ``?connection=<id>`` adds each pack's tools' versions as that connection's newest
  gate record holds them (engineering/registry/gate_records.py: the runs list, the runs' ``META`` and gate runners'
  tasks, the record object; the role's 7.51.00 reads of the table and of ``…/_gate/*``, nothing more).
- **The assertions**: the closed vocabulary a step's ``params.assert`` takes, each check with its text keys, its
  arguments' JSON Schema, the steps it is checked on and the ``on_fail`` each takes, for the editor's assertions
  field (the rules a save holds them to, shared/workflow_engineering.py, mirrored by the editor).
- **A template's source** (7.52.00's integration): a role's SKILL.md or agent.yaml, a flow's YAML or a gate brief,
  as the repository holds it, from the bundle (its ``sources``, ``gates.briefs``): the app's read-only source view.
- **The skills library** (7.56.00): the skills the engineering agents read on demand (``read_skill``), from the bundle
  (``library``): the list without the texts, then one skill's SKILL.md or one of its reference files
  (engineering/registry/library.py), for Skills → Library; read only, the repository's as data.
- **A flow's expansion** (``shared/flow_expand.py``): the flat flow a run of that revision would follow, with its
  calls expanded and recorded; 409 with the refusal (and its step) when a call cannot be expanded.
- **Pause and resume** (``agents_store.set_paused``): an automation that is on, held: the heartbeat starts no run of
  it until it is resumed (Run now still does). Each change is audited (``AGENT#<id>`` / ``LOG#<at>#<n>``, who and
  when, D4). Pausing a paused automation, or resuming one that is not paused, answers it as it is.

Administrators only, acting for themselves (403 for anyone else, a delegated credential included). The
``/agents/engineering/*`` routes answer 404 while the engineering agents are off; a flow's expansion and the pause do
not need them. 503 when a table cannot be read or written. The deployment's, like the agents (phase 3 of
docs/multi-workspace.md). Registered by ``agents_handler.py`` before its ``/agents/engineering/<run_id>`` routes, which
would otherwise take ``registry``, ``gates`` and ``assertions`` for a run id.

Kept in ``shared/`` because an API bundle ships ``api/<handler>.py`` and ``shared/`` only
(api/test/test_api_bundle_imports.py); the engineering package is imported where a route needs it, so this module
loads in a bundle without it (the module off).
"""
from __future__ import annotations

import os
import re
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router
from botocore.exceptions import BotoCoreError, ClientError

from shared import agents_store as store
from shared import engineering_templates, flow_expand
from shared.agents_store import require_agents_table as _agents_table
from shared.engineering_agent_runs import CONNECTION_ROW_PREFIX, CONNECTIONS_PARTITION, revision_reader
from shared.engineering_agents import ENGINEERING_TABLE_ENV, engineering_agents_on
from shared.engineering_agents import engineering_client_and_table as _engineering_client
from shared.engineering_agents import require_engineering_on as _engineering_on
from shared.exceptions import (
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationError,
)
from shared.logging import logger, tracer
from shared.project_gate import caller_from_event, require_admin_caller
from shared.request_body import json_object_body
from shared.route_answers import json_response as _json
from shared.route_answers import query_text
from shared.workflow_engineering import AGENT_REF, CARD_REF, GATE_AGENTS, SCHEMA_V2

__all__ = ['app', 'card_issues']

CARDS_OFF: Final = 'a step from a Registry card is saved where the engineering agents are on (its card is checked)'
_DIGITS: Final = re.compile(r'[0-9]{1,6}')
#: A card's error kind, as the route answers it.
_STATUS: Final = {'invalid': ValidationError, 'not_found': NotFoundError, 'conflict': ConflictError}

app = Router()


def _answered[T](read: Callable[[], T], failed: str) -> T:
    """``read()``, a card's or a skill's refusal answered with its status, a failed call with 503 (``failed``)."""
    from engineering.registry.cards import CardError
    from engineering.skills.model import SkillError

    try:
        return read()
    except (CardError, SkillError) as refused:
        raise _STATUS.get(getattr(refused, 'kind', 'invalid'), ValidationError)(str(refused)) from None
    except (ClientError, BotoCoreError) as exc:
        logger.exception('engineering: a Registry call failed')
        raise ServiceUnavailableError(failed) from exc


def _connection() -> str:
    connection = query_text(app.current_event, 'connection') or ''
    from engineering.connectors.connections import CONNECTION_ID

    if connection and not CONNECTION_ID.fullmatch(connection):
        raise ValidationError('connection is a connection id, or empty for the shared skills')
    return connection


def _month() -> str:
    from engineering.spend import check_query, month_of

    month = query_text(app.current_event, 'month') or month_of(datetime.now(UTC))
    try:
        check_query(month, 'agent')
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    return month


def _spend(month: str) -> dict[str, dict[str, Any]]:
    from engineering.registry.views import spend_by_role
    from engineering.spend import month_spend
    from shared.aws import get_dynamodb_resource

    table = get_dynamodb_resource().Table(os.environ[ENGINEERING_TABLE_ENV])
    return spend_by_role(month_spend(table, month, 'agent').view()['groups'])


def _connections() -> list[str]:
    """The stored repository connections' ids (not the removed ones), by id: one Query of their partition."""
    from shared.dynamo_paging import query_all

    rows = query_all(_agents_table(), {
        'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :row)', 'ConsistentRead': True,
        'ExpressionAttributeValues': {':pk': CONNECTIONS_PARTITION, ':row': CONNECTION_ROW_PREFIX}})
    return sorted(str(row['connection_id']) for row in rows
                  if row.get('removed') is not True and isinstance(row.get('connection_id'), str))


def _role_cards(connection: str, month: str, roles: set[str] | None = None,
                stored: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    """Every role's card (a template card whose id is its role, for each role of the bundle: ``roles`` only, when
    given) for ``connection``'s scope; for the shared scope, with what each stored connection runs of it. Since
    7.58.00 each says its role's model choice and the harness it runs on (``_with_model``)."""
    from engineering.registry.views import RegistryViews

    bundle = engineering_templates.bundle()
    packs = [pack['id'] for pack in bundle['gates']['packs']]
    spend = _spend(month)
    views = RegistryViews(*_engineering_client())
    connections = [] if connection else _connections()
    stored = _role_models() if stored is None else stored
    return [_with_model(views.role_card(template, connection=connection, gate_packs=packs, spend=spend, month=month,
                                        connections=connections), stored)
            for template in bundle['agents'] if roles is None or template['id'] in roles]


def _role_models() -> Mapping[str, Any]:
    """Each role's model choice as the Registry holds it (7.58.00: voc-agents' settings row, engineering/settings.py)."""
    from engineering.settings import read_role_models

    return read_role_models(_agents_table())


def _template_choices() -> dict[str, str]:
    """Each role's template card's model choice (the bundle's ``model_choice``), only the cards that name one."""
    return {str(template['id']): str(template['model_choice']) for template in engineering_templates.bundle()['agents']
            if isinstance(template.get('model_choice'), str) and template['model_choice']}


def _with_model(card: dict[str, Any], stored: Mapping[str, Any]) -> dict[str, Any]:
    """A card with its role's model choice (7.58.00, engineering/model_choices.py ``card_fields``: a made card shows its
    base role's)."""
    from engineering.model_choices import card_fields

    role = str(card.get('base_role') or card.get('id', ''))
    return {**card, **card_fields(role, stored, _template_choices().get(role, ''), os.environ)}


def _enabled_models() -> list[str]:
    from engineering.model_choices import enabled_models

    return enabled_models(os.environ)


@app.get('/agents/engineering/registry')
@tracer.capture_method(capture_response=False)
def get_engineering_registry():
    """``?connection=<id>&month=YYYY-MM`` → ``{month, connection, cards}``: every role's card for the scope (the
    shared skills by default; the scorecards are a connection's), then the cards made from a skill."""
    _engineering_on()
    require_admin_caller(caller_from_event(app.current_event.raw_event))
    from engineering.registry.library import with_skills
    from engineering.registry.views import RegistryViews

    connection, month = _connection(), _month()

    def read() -> dict[str, Any]:
        bundle = engineering_templates.bundle()
        stored = _role_models()
        made = [_with_model(with_skills(card, bundle), stored) for card in RegistryViews(*_engineering_client()).cards()]
        return {'month': month, 'connection': connection, 'cards': _role_cards(connection, month, stored=stored) + made,
                'bedrock_enabled': _enabled_models()}
    return _answered(read, 'the Registry could not be read: retry')


@app.get('/agents/engineering/registry/<card>')
@tracer.capture_method(capture_response=False)
def get_engineering_registry_card(card: str):
    """A role's card (``{card, versions: [], events: []}``) or a card made from a skill with its versions, newest
    first, and who made each; 404 for neither."""
    _engineering_on()
    require_admin_caller(caller_from_event(app.current_event.raw_event))
    from engineering.registry.cards import CARD_ID
    from engineering.registry.library import with_skills
    from engineering.registry.views import RegistryViews

    roles = {template['id'] for template in engineering_templates.bundle()['agents']}
    if card in roles:
        connection, month = _connection(), _month()
        return _answered(lambda: {'card': _role_cards(connection, month, {card})[0], 'versions': [], 'events': [],
                                  'bedrock_enabled': _enabled_models()},
                         'the Registry could not be read: retry')
    if not CARD_ID.fullmatch(card):
        raise NotFoundError(f'the Registry has no card {card[:64]}')

    def read() -> dict[str, Any]:
        found, bundle = RegistryViews(*_engineering_client()).card(card), engineering_templates.bundle()
        return {**found, 'card': _with_model(with_skills(found['card'], bundle), _role_models()),
                'versions': [with_skills(version, bundle) for version in found['versions']],
                'bedrock_enabled': _enabled_models()}
    return _answered(read, 'the Registry could not be read: retry')


@app.put('/agents/engineering/registry/<role>/model')
@tracer.capture_method(capture_response=False)
def put_engineering_role_model(role: str):
    """``{model: <choice> | null}`` → ``{role, model_choice, updated_at, updated_by}`` (7.58.00): an administrator sets
    the model a launchable role runs on in this deployment (``auto``, ``opus``, ``sonnet``, ``haiku`` or another model
    id; null: its default again), saved with its history row; a run's start records it and its launches apply it.
    404 for no launchable role; 400 for a choice off its shape, or (the role on the native harness) a Bedrock model
    this deployment does not grant and price (engineering/model_choices.py)."""
    _engineering_on()
    caller = caller_from_event(app.current_event.raw_event)
    require_admin_caller(caller)
    from engineering.model_choices import check
    from engineering.runtime.harness.model_choice import ModelChoiceError
    from engineering.settings import save_role_model

    launchable = {template['id'] for template in engineering_templates.bundle()['agents']
                  if template.get('skill') is not None}
    if role not in launchable:
        raise NotFoundError(f'the Registry has no launchable role {role[:64]}')
    body = json_object_body(app)
    if set(body) != {'model'}:
        raise ValidationError('the body is {model: auto | opus | sonnet | haiku | <a model id> | null}')
    try:
        choice = check(body['model'], [role], os.environ)
    except ModelChoiceError as refused:
        raise ValidationError(str(refused)) from None
    try:
        saved = save_role_model(_agents_table(), role=role, choice=choice, by=caller.username or caller.subject,
                                at=datetime.now(UTC))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('engineering: a role\'s model could not be saved')
        raise ServiceUnavailableError('the role\'s model could not be saved: retry') from exc
    logger.info('engineering: a role\'s model chosen', extra={'role': role, 'model_choice': choice or None})
    return {'role': role, **saved.view()}


@app.post('/agents/engineering/registry/cards')
@tracer.capture_method(capture_response=False)
def create_engineering_registry_card():
    """``{from_skill: {role, connection?, version}, slug, purpose, title?, model?, caps?, expected_version?}`` → 201
    ``{card}``: a card made from the role's accepted skill version (a new card, or with ``expected_version`` the
    card's next version; 409 when that moved)."""
    _engineering_on()
    caller = caller_from_event(app.current_event.raw_event)
    require_admin_caller(caller)
    from engineering.connectors.identity import WORKSPACE
    from engineering.registry.cards import (
        CHANGED,
        EXISTS,
        AgentCardStore,
        CardError,
        card_view,
        check_request,
        compose,
    )
    from engineering.registry.library import with_skills
    from engineering.skills.store import SkillStore
    from shared.model_config import ALLOWED_MODEL_IDS

    templates = {template['id']: template for template in engineering_templates.bundle()['agents']
                 if template.get('skill') is not None}
    body = json_object_body(app)
    request = _answered(lambda: check_request(body, list(templates)), 'the card could not be made: retry')
    client, table = _engineering_client()
    cards = AgentCardStore(client, table)

    def make() -> dict[str, Any]:
        current = cards.current_version(request.card_id)
        if current != request.expected_version:
            raise CardError(EXISTS if request.expected_version == 0 else CHANGED, 'conflict')
        skill = SkillStore(client, table).version(WORKSPACE, request.connection, request.role, request.skill_version)
        name = caller.username or caller.subject
        record = compose(request, skill, templates[request.role], allowed_models=frozenset(ALLOWED_MODEL_IDS),
                         role_tools=frozenset(templates[request.role]['allowed_tools']),
                         version=current + 1, by=name, at=datetime.now(UTC).isoformat(timespec='seconds'))
        cards.save(record, expected_version=current, by=caller.subject, username=name)
        return record

    record = _answered(make, 'the card could not be made: retry')
    logger.info('engineering: a Registry card made', extra={'card': record['id'], 'version': record['version']})
    made = with_skills(card_view(record), engineering_templates.bundle())
    return _json(201, {'card': _answered(lambda: _with_model(made, _role_models()),
                                         'the card was made, but could not be read back: read the Registry')})


def _newest_gate_record(connection: str) -> dict[str, Any] | None:
    """The connection's newest gate record that names a tool version (``GateRecords.newest``)."""
    from engineering.registry.gate_records import GateRecords
    from engineering.run_objects import RunObjects
    from shared.aws import get_s3_client

    bucket = os.environ.get('ENGINEERING_WORKSPACE_BUCKET', '')
    if not bucket:
        raise ServiceUnavailableError("the gate records cannot be read here: the deployment names no workspace bucket")
    client, table = _engineering_client()
    return _answered(lambda: GateRecords(client, table, RunObjects(get_s3_client(), bucket)).newest(
        connection, datetime.now(UTC)), 'the gate records could not be read: retry')


@app.get('/agents/engineering/gates')
@tracer.capture_method(capture_response=False)
def get_engineering_gates():
    """``?connection=<id>`` → the gate packs (steps with their messages, tools, image pins, registries, briefs), the
    owner's briefs without their text (``GET …/gates/briefs/<id>``), and with a connection each pack's tools'
    versions as the connection's newest gate record holds them, and when (``recorded``; None without one)."""
    _engineering_on()
    require_admin_caller(caller_from_event(app.current_event.raw_event))
    from engineering.registry.views import gates_view

    connection = _connection()
    recorded = _newest_gate_record(connection) if connection else None
    return {**gates_view(engineering_templates.bundle()['gates'], recorded), 'connection': connection or None}


@app.get('/agents/engineering/gates/briefs/<brief_id>')
@tracer.capture_method(capture_response=False)
def get_engineering_gate_brief(brief_id: str):
    """One owner's brief with its text (``{id, path, packs, digest, bytes, text}``); 404 for no such brief."""
    _engineering_on()
    require_admin_caller(caller_from_event(app.current_event.raw_event))
    from engineering.registry.views import brief_view

    found = brief_view(engineering_templates.bundle()['gates'], brief_id)
    if found is None:
        raise NotFoundError(f'no gate brief {brief_id[:64]}')
    return found


@app.get('/agents/engineering/templates/<kind>/<template_id>/source')
@tracer.capture_method(capture_response=False)
def get_engineering_template_source(kind: str, template_id: str):
    """A template's source text from the bundle, read only: ``{kind, id, path, text, digest, template_version}`` for a
    role's SKILL.md (``skill``) or agent.yaml (``card``), a flow's YAML (``flow``) or an owner's gate brief (``brief``,
    no template version); 400 for another kind, 404 for no such template."""
    _engineering_on()
    require_admin_caller(caller_from_event(app.current_event.raw_event))
    from engineering.registry.views import SOURCE_KINDS, template_source

    if kind not in SOURCE_KINDS:
        raise ValidationError(f'kind is one of {", ".join(SOURCE_KINDS)}')
    found = template_source(engineering_templates.bundle(), kind, template_id)
    if found is None:
        raise NotFoundError(f'no {kind} template {template_id[:64]}')
    return found


@app.get('/agents/engineering/skill-library')
@tracer.capture_method(capture_response=False)
def get_engineering_library_tools():
    """The skills library without its text (7.56.00, Skills → Library): ``{skills: [{name, description, source,
    license, adapted, path, digest, bytes, roles, references: [{path, digest, bytes}]}]}``."""
    _engineering_on()
    require_admin_caller(caller_from_event(app.current_event.raw_event))
    from engineering.registry.library import library_view

    return library_view(engineering_templates.bundle())


@app.get('/agents/engineering/skill-library/<name>')
@tracer.capture_method(capture_response=False)
def get_engineering_library_skill(name: str):
    """One library skill's SKILL.md, or with ``?reference=references/<file>.md`` one of its reference files:
    ``{name, reference, path, text, digest, bytes}``; 400 for a malformed name or reference, 404 for none."""
    _engineering_on()
    require_admin_caller(caller_from_event(app.current_event.raw_event))
    from engineering.orchestration.bundle import REFERENCE_PATH
    from engineering.registry.library import SKILL_NAME, library_file

    reference = query_text(app.current_event, 'reference') or ''
    if not SKILL_NAME.fullmatch(name):
        raise ValidationError('name is a library skill\'s name (lowercase letters, digits and dashes)')
    if reference and not REFERENCE_PATH.fullmatch(reference):
        raise ValidationError('reference is one of the skill\'s reference files, references/<file>.md')
    found = library_file(engineering_templates.bundle(), name, reference)
    if found is None:
        raise NotFoundError(f'no library skill {name}' + (f' reference {reference}' if reference else ''))
    return found


@app.get('/agents/engineering/assertions')
@tracer.capture_method(capture_response=False)
def get_engineering_assertions():
    """The closed vocabulary of step assertions, for the editor's assertions field."""
    _engineering_on()
    require_admin_caller(caller_from_event(app.current_event.raw_event))
    from engineering.registry.views import assertions_view

    return assertions_view()


@app.get('/workflows/<workflow_id>/expanded')
@tracer.capture_method(capture_response=False)
def get_expanded_workflow(workflow_id: str):
    """``?revision=<n>`` (the current one by default) → the flat flow a run of that revision would follow:
    ``{workflow_id, revision, definition, expansion, calls, steps}``; 409 ``{error, node_id}`` when a call cannot be
    expanded, 400 for an agents workflow."""
    require_admin_caller(caller_from_event(app.current_event.raw_event))
    table = _agents_table()
    workflow = store.get_workflow(table, workflow_id) if store.is_workflow_id(workflow_id) else None
    if workflow is None:
        raise NotFoundError('Workflow not found')
    raw = query_text(app.current_event, 'revision')
    if raw is not None and not (_DIGITS.fullmatch(raw) and int(raw) >= 1):
        raise ValidationError(f'revision is a whole number from 1 to {store.MAX_REVISION}')
    revision = int(raw) if raw is not None else int(store.plain(workflow.get('revision')) or 1)
    found = store.get_revision(table, workflow_id, revision)
    if found is None:
        raise NotFoundError('Workflow revision not found')
    definition = found.get('definition') or {}
    if definition.get('schema') != SCHEMA_V2:
        raise ValidationError('an agents workflow calls no flow: only an engineering flow is expanded')
    try:
        expanded = flow_expand.expand(definition, revision_reader(table), root=workflow_id)
    except flow_expand.ExpansionError as refused:
        return _json(409, {'success': False, 'error': refused.message, 'node_id': refused.node_id})
    return {'workflow_id': workflow_id, 'revision': revision, 'definition': expanded.definition,
            'expansion': list(expanded.expansion), 'calls': len(expanded.expansion),
            'steps': len(expanded.definition['nodes'])}


def _pause(agent_id: str, paused: bool) -> dict[str, Any]:
    caller = caller_from_event(app.current_event.raw_event)
    table = _agents_table()
    agent = store.get_agent(table, agent_id) if store.is_agent_id(agent_id) else None
    if agent is None or agent.get('status') == store.AGENT_STATUS_ARCHIVED:
        raise NotFoundError('Agent not found')
    if (agent.get('paused') is True) == paused:   # (already as asked: answered as it is, nothing written)
        return {'agent': store.agent_view(agent)}
    if paused and agent.get('enabled') is not True:
        raise ConflictError(store.NOT_ON)
    updated = store.set_paused(table, agent_id, paused, by=caller.subject, username=caller.username or caller.subject,
                               now=store.utc_now())
    logger.info('Agent paused' if paused else 'Agent resumed', extra={'agent_id': agent_id})
    return {'agent': store.agent_view(updated)}


@app.post('/agents/<agent_id>/pause')
@tracer.capture_method
def pause_agent(agent_id: str):
    """Pause an automation that is on (409 for one that is off): no run starts by itself until it is resumed."""
    require_admin_caller(caller_from_event(app.current_event.raw_event))
    return _pause(agent_id, True)


@app.post('/agents/<agent_id>/resume')
@tracer.capture_method
def resume_agent(agent_id: str):
    """Resume a paused automation: its triggers start runs again from the next tick."""
    require_admin_caller(caller_from_event(app.current_event.raw_event))
    return _pause(agent_id, False)


def _named_cards(definition: Mapping[str, Any]) -> list[tuple[Mapping[str, Any], str, str, int, str]]:
    """Each Registry card a step names: ``(step, the reference, the card, its version, the role it must be of)``: an
    agent's ``params.card``, a quality gate's ``runner`` / ``final_go`` naming a card (not the role itself)."""
    named = []
    for node in definition['nodes']:
        params = node['data']['params']
        if node['type'] == 'agent' and isinstance(params.get('card'), str):
            match = CARD_REF.fullmatch(params['card'])
            if match is not None:   # (else the rules refuse it already)
                named.append((node, params['card'], match['card'], int(match['version']), str(params.get('role'))))
        for key, role in GATE_AGENTS.items() if node['type'] == 'quality_gate' else ():
            match = AGENT_REF.fullmatch(str(params.get(key, '')))
            if match is not None and match['id'] != role and match['version'] != 'latest':
                named.append((node, params[key], match['id'], int(match['version'][1:]), role))
    return named


def card_issues(definition: Mapping[str, Any]) -> list[tuple[str, str | None]]:
    """What a save of ``definition`` is refused for in the Registry cards its steps name (an agent's ``params.card``,
    a gate's ``runner`` / ``final_go``): a card or a version the Registry does not have, a card of another role, or
    an agent step that does not carry its card's role, skill version and model. ``ClientError`` / ``BotoCoreError``
    as they are (the caller answers 503)."""
    if definition.get('schema') != SCHEMA_V2:
        return []
    named = _named_cards(definition)
    if not named:
        return []
    if not (engineering_agents_on() and os.environ.get(ENGINEERING_TABLE_ENV)):
        return [(CARDS_OFF, node['id']) for node, *_rest in named]
    from engineering.registry.cards import AgentCardStore, CardError

    cards = AgentCardStore(*_engineering_client())
    issues: list[tuple[str, str | None]] = []
    for node, reference, card, version, role in named:
        try:
            record = cards.version(card, version)
        except CardError:
            issues.append((f'the step names the card {reference}, which the Registry does not have', node['id']))
            continue
        params, pinned = node['data']['params'], f'v{record["skill"]["version"]}'
        if record['base_role'] != role:
            issues.append((f'the card {reference} is a {record["base_role"]}: this step takes a {role}', node['id']))
        elif node['type'] == 'agent' and (params.get('skill_version') != pinned
                                          or params.get('model', record['model']) != record['model']):
            issues.append(((f'a step from the card {reference} carries its role ({record["base_role"]}), skill '
                            f'version ({pinned}) and model ({record["model"]})'), node['id']))
    return issues
