"""Agents API Lambda - Handles /agents/* and /workflows/*.

Autonomous agents (crews that go from reviews to a prototype), their workflow
library, and their runs. The run itself is interpreted by the ``voc-agent-run``
state machine; this Lambda only queues a run (``POST /agents/{id}/run``) and
reads the journal the interpreter writes.

Permissions:
- every write (agents, workflows, run now, cancel, a needs_human decision) is admin-only — the one
  exception is ``run now`` from a global-MCP write token minted by an admin who
  is still an admin (``_require_run_permission``, docs/mcp.md);
- plans (``/agents/plans*``, docs/assistant-plan-mode.md) are NOT admin-only: any
  signed-in user approves their own plan, reads and cancels it (admins too), and
  only its approver resolves a paused step;
- any signed-in user reads the agents whose WHOLE scope their category access
  covers (``shared.category_gate``); any other agent, and its runs, answers 404;
- an engineering agent (7.47.00: its ``engineering`` settings; the seeded Bug fixer and Feature builder) is listed and
  read by administrators acting for themselves only, where the engineering agents are on (404 for anyone else); its
  Run now is theirs alone too (never a delegated credential), through voc-engineering-start, and its runs take only the
  deployment's feedback (D8, until agents move per workspace);
- workflows hold no customer data, so every signed-in user may read and
  validate them; the default engineering flows (``GET /workflows/templates``) are listed for
  administrators only, where the engineering agents are on (404 elsewhere), as the library offers them;
- an engineering run's monitor, board, conversation and reports (``/agents/engineering/<run_id>``
  and its ``/*``, lambda/engineering/views.py and monitor.py) are read by administrators only,
  acting for themselves (403 for anyone else, an MCP credential included), and so are its signals (since 7.51.02
  through the start function's ``signal_run``, below) and a person's answers in it (``POST …/signals``,
  ``…/messages``, like a decision) and a person's Stop of it
  (``POST …/stop``, 7.50.03: the start function's ``stop_run``, below, which ends it whatever its agents are doing;
  then its engineering agent's run is ended here too, its lock released) and a
  person's board actions (``POST …/board/tasks``, ``…/board/tasks/<task_id>/<action>``:
  engineering/board/api.py PersonBoard) and a person's go on a run (``POST …/go``, what an AI-assisted run's push
  waits for), and the runs' spend by month (``GET /agents/engineering/spend``,
  engineering/spend.py), and the hard cap's setting, read and written (``GET``/``PUT
  /agents/engineering/settings``, engineering/settings.py: one row in the agents table, written with
  its history row; the runtime reads it at a budgeted run's first start), and the repository connections
  (``GET /agents/engineering/connections``, ``PUT``/``DELETE …/connections/<id>``,
  engineering/connectors/connections.py: a row in the agents table with its audit rows, and the GitHub App
  credential in SSM, written and deleted here, never read), and each connection's CI attestation
  (``POST``/``DELETE …/connections/<id>/ci-attestation``, engineering/connectors/attestations.py: create-only
  version rows beside the connection's, each with its audit row), and the deployment's GitHub Apps made in two
  clicks (7.45.00: ``GET /agents/engineering/github-apps``, ``POST …/github-apps/manifest``, ``…/conversions``,
  ``…/installations``, ``…/github-apps/<app_id>/install``, ``…/<app_id>/check``, ``DELETE …/github-apps/<app_id>``;
  engineering/connectors/github_apps.py: an App's key and webhook secret in SSM, written here and never read, its row
  and single-use setup states in the agents table), and the deployment's GitHub Issues source configured from those
  connections (7.50.02: ``GET /agents/engineering/issues-source``, ``PUT …/connections/<id>/issues``, and the
  installation, check and removal steps; engineering/connectors/issues_sync.py: each connection's switch and label
  row with its audit rows, the source's settings through voc-engineering-issues-config), and a run's start
  (``POST /agents/engineering/runs``, a saved engineering flow on a stored connection's commit: the start
  function, below), and the agents' skills and scorecards, read only (``GET /agents/engineering/skills``,
  ``…/skills/<role>/versions[/<version>]``, ``GET /agents/engineering/scorecards/<role>``: engineering/skills/views.py)
  and an administrator's actions on a version (``POST …/skills/<role>/versions/<version>/accept``, ``…/reject``,
  ``…/rollback``, ``…/benchmark``: engineering/skills/actions.py, the store's own transactions; since 7.50.00 a role's
  bundled template against the scope, ``GET …/skills/<role>/template``, and its adoption as a person's proposal,
  ``POST …/skills/<role>/template/adopt``), and an ended run's
  reactions read asked for by hand (``POST /agents/engineering/<run_id>/reactions``, 7.10.00: the start function's
  ``ask_reactions``, below), and, since 7.52.00, the Registry (its cards, a card made from a skill), the quality
  gates and the assertions' vocabulary (``/agents/engineering/registry``, ``…/registry/<card>``, ``POST
  …/registry/cards``, ``…/gates``, ``…/assertions``: shared/agents_engineering_registry_routes.py); while the
  engineering agents are off every caller gets 404;
- a flow's expansion (``GET /workflows/<id>/expanded``) and an automation's pause and resume (``POST
  /agents/<id>/pause``, ``…/resume``) are administrators' too (7.52.00, the same router); a workflow's ``used_by``
  (the automations that run it, read as the agents are, and the flows that call it) is answered with it, and the
  save of a flow other automations run needs ``confirm_shared: true`` (409 ``shared_flow`` with them otherwise).
- MCP for runs (7.53.00, docs/mcp.md): the global MCP server's five engineering tools reach five operations, and only
  those, each admitted for itself (``_engineering_caller``, ``project_access.delegated_engineering_allowed``) for a
  write token whose minter is still an administrator, never as an admin: the runs list, a run's overview
  (``GET /agents/engineering/<run_id>``), its retrospective and its steering (shared/agents_engineering_run_routes.py),
  and a request for a Run now (``POST /agents/engineering/requests``, engineering/run_requests.py: a row that waits
  until an administrator confirms it here, ``POST …/requests/<id>/confirm``, which runs the Run now as that
  administrator, or declines it; ``GET …/requests`` lists them, and ``GET …/requests/automations`` the enabled
  automations a request may name). Signals, go, restart, Stop, answers, approvals, the registry, the connections, the
  dial and a request's confirm or decline stay an administrator's acting for themselves.

Own role (20 KB policy limit): the agents table (read/write), the aggregates table
(read: category access rows + categories config), ``states:StartExecution`` and
``states:StopExecution`` on ``voc-agent-run`` only; with the engineering agents on, their stack adds reads of
their table and workspace bucket (GetItem and Query), the skills' and, since 7.52.00, the Registry cards' writes
(PutItem, UpdateItem and ConditionCheckItem on the ``WS#*#SKILL#*`` and ``WS#*#AGENTCARD#*`` partitions only, what
the stores' transactions use; no delete) and ``lambda:InvokeFunction`` on the board's
function (``ENGINEERING_BOARD_FUNCTION``), which makes a person's board actions with its own role and hands the
events back for this role to publish as the person (engineering/board/api.py person_request), and
``lambda:InvokeFunction`` on the start function (``ENGINEERING_START_FUNCTION``, voc-engineering-start: the runtime's
code and role, which runs ``start_run``, since 7.10.00 ``ask_reactions``, since 7.50.03 ``stop_run`` and since
7.51.02 ``signal_run`` (the monitor's signals: checked, recorded and handed on to the runtime by that function), and
refuses every other action; never the runtime's own function), and, since 7.45.00, on the token function (``ENGINEERING_APP_TOKENS_FUNCTION``,
voc-engineering-app-tokens: the broker's code under its own role, which reads an App's key; this API asks it only
``inspect_installation`` and, since 7.50.02, ``ensure_label`` (the ``voc-agent`` label on one connected repository),
neither of which answers a token), and, since 7.50.02, on the GitHub Issues settings function
(``ENGINEERING_ISSUES_CONFIG_FUNCTION``, voc-engineering-issues-config: its own role reads and writes the source's
settings and turns its schedule on; this role holds no grant on the secret or the rule), where that plugin is deployed
(lib/stacks/api-engineering-issues-sync.ts), and
``dynamodb:PutItem`` and ``UpdateItem`` on the run requests' partitions only (``WS#*#RUNREQ#*``, 7.53.00), and
``ssm:PutParameter`` and ``ssm:DeleteParameter`` on the connections' parameters only, with ``kms:Encrypt`` and
``kms:GenerateDataKey`` on the stack's key through SSM for them (no ``ssm:GetParameter``), and, since 7.51.02,
``events:PutEvents`` on the engineering bus alone (``ENGINEERING_BUS_NAME``) held to the source
``voc.engineering/api`` and the detail types ``msg.steer`` and ``msg.answer`` (a person's steering and answers, the two
things this API says there: lib/stacks/api-engineering-voice.ts); the bus's resource policy holds it to that source
(lib/stacks/engineering-bus.ts: this role has a fixed name for it) and the router to those types
(engineering/bus/senders.py, router.py). Nothing while
the module is off. The supervisor's session rows (``WS#<ws>#RUN#<run>`` / ``AGENT#``)
are in the engineering table, read with the Query its stack already grants, and so are the spend ledger's month
partitions (``WS#<ws>#SPEND#<yyyy-mm>``).
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from functools import cache
from typing import Any, Final

from aws_lambda_powertools.event_handler import Response, content_types
from botocore.exceptions import BotoCoreError, ClientError

from shared import (
    agent_run_decisions,
    agent_run_resume,
    agent_seed,
    agents_engineering_knowledge_routes,
    agents_engineering_learn_routes,
    agents_engineering_registry_routes,
    agents_engineering_run_routes,
    agents_engineering_setup_routes,
    engineering_templates,
    flow_expand,
    plans_store,
    project_access,
    workflow_methodology,
    workflow_schema,
)
from shared import agents_store as store
from shared import engineering_agent_runs as eng_runs
from shared.api import api_handler, create_api_resolver, validate_int
from shared.aws import get_dynamodb_resource
from shared.category_access import CategoryScope
from shared.category_gate import read_categories_config, scope_for_caller
from shared.engineering_agents import engineering_agents_on
from shared.exceptions import (
    ApiError,
    AuthorizationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    TooManyRequestsError,
    ValidationError,
)
from shared.logging import logger, tracer
from shared.plan_canonical import FINGERPRINT_RE
from shared.plan_schema import ADMIN_ONLY_PACKS, PACKS, is_plan_id, validate_plan
from shared.project_access import Caller
from shared.project_gate import acts_as_admin, caller_from_event, require_admin_caller
from shared.request_body import json_object_body
from shared.request_workspace import request_workspace
from shared.row_ids import LONG_OPAQUE_ID_RE
from shared.tables import get_aggregates_table
from shared.warm_init import warm_at_init

AGENT_NOT_FOUND = 'Agent not found'
RUN_NOT_FOUND = 'Run not found'
RUN_ALREADY_DECIDED = 'This run is not waiting for a decision'
WORKFLOW_NOT_FOUND = 'Workflow not found'
PLAN_NOT_FOUND = 'Plan not found'
STEP_NOT_FOUND = 'Step not found'
KEEPS_ITS_KIND = ('a workflow keeps its kind: save an engineering flow as a new workflow, not over an agents one '
                  '(or the other way round)')
# sha256 hex of a paused write (``canonical_write_fingerprint``), as the plan view shows it.
DEFAULT_RUNS_PAGE = 20
MAX_RUNS_PAGE = 50
MAX_EVENTS_PAGE = 200

app = create_api_resolver()


# --------------------------------------------------------------------------
# Request plumbing.
# --------------------------------------------------------------------------

def _caller() -> Caller:
    return caller_from_event(app.current_event.raw_event)


def _require_run_permission(caller: Caller) -> None:
    """Run now: an admin, or a global-MCP write token its admin minter still backs.

    The second case is the only delegated path to an admin action. It is not a
    group claim — the credential is still not an admin anywhere else — and it is
    honoured only for an `mcp:` principal (never an `agent:` one), with the claim
    the MCP Lambda adds after re-checking the minter in Cognito
    (`project_access.delegated_agent_run_allowed`).
    """
    if caller.delegated and not caller.agent_id and project_access.delegated_agent_run_allowed(
        project_access.claims_from_event(app.current_event.raw_event),
    ):
        return
    require_admin_caller(caller)


def _agents_table() -> Any:
    table = store.get_agents_table()
    if table is None:
        raise ConfigurationError('Agents table not configured')
    return table


def _aggregates_table() -> Any:
    table = get_aggregates_table()
    if table is None:
        raise ConfigurationError('Aggregates table not configured')
    return table


def _json(status: int, body: Mapping[str, Any]) -> Response:
    return Response(status_code=status, content_type=content_types.APPLICATION_JSON, body=json.dumps(body))


def _query(name: str) -> str | None:
    params = app.current_event.query_string_parameters or {}
    value = params.get(name)
    return value if isinstance(value, str) else None


def _viewer_scope(caller: Caller) -> CategoryScope:
    return scope_for_caller(caller, _aggregates_table())


# --------------------------------------------------------------------------
# Agents.
# --------------------------------------------------------------------------

def _stored_agent(agent_id: str, *, include_archived: bool = False) -> dict:
    """The agent row, or 404 (also for a malformed id or, unless asked, an archived agent)."""
    if not store.is_agent_id(agent_id):
        raise NotFoundError(AGENT_NOT_FOUND)
    agent = store.get_agent(_agents_table(), agent_id)
    if agent is None or (not include_archived and agent.get('status') == store.AGENT_STATUS_ARCHIVED):
        raise NotFoundError(AGENT_NOT_FOUND)
    return agent


def _lists_engineering(agent: Mapping[str, Any], caller: Caller) -> bool:
    """An engineering agent is an administrator's alone (acting for themselves), and only where the module is on."""
    return not store.is_engineering_agent(agent) or (acts_as_admin(caller) and engineering_agents_on())


def _visible_agent(agent_id: str, caller: Caller) -> dict:
    """The agent if ``caller`` may read it; 404 otherwise (no existence leak)."""
    agent = _stored_agent(agent_id, include_archived=caller.is_admin and not caller.delegated)
    if not store.agent_visible(_viewer_scope(caller), agent) or not _lists_engineering(agent, caller):
        raise NotFoundError(AGENT_NOT_FOUND)
    return agent


def _find_workflow(workflow_id: object, *, include_archived: bool = False) -> dict | None:
    """The workflow's CURRENT row; None for a malformed or unknown id, or (unless asked) an archived one."""
    if not store.is_workflow_id(workflow_id):
        return None
    workflow = store.get_workflow(_agents_table(), str(workflow_id))
    if workflow is None or (not include_archived and store.is_archived_workflow(workflow)):
        return None
    return workflow


def _sees_archived(caller: Caller) -> bool:
    """Only a non-delegated admin reads an archived workflow (like an archived agent)."""
    return acts_as_admin(caller)


def _engineering_flow(workflow: Mapping[str, Any]) -> bool:
    """A stored workflow that is an engineering flow (voc-workflow/2), which no agent runs (by its decoded top level:
    a step's params may hold any key, so the stored text alone cannot tell)."""
    definition = workflow_schema.decode_definition(workflow.get('definition')) or {}
    return definition.get('schema') == workflow_schema.SCHEMA_V2


def _require_workflow(workflow_id: str, *, engineering: bool = False) -> None:
    """A workflow an agent body names must exist and be of the agent's kind (400, it is a field of the request): an
    engineering flow for an engineering agent (its ``engineering`` settings, 7.47.00), an agents workflow otherwise."""
    workflow = _find_workflow(workflow_id)
    if workflow is None:
        raise ValidationError('workflow_id does not name a workflow')
    if _engineering_flow(workflow) and not engineering:
        raise ValidationError('an engineering flow is not run by an agent without engineering settings: pick an '
                              'agents workflow, or give the agent its engineering settings')
    if engineering and not _engineering_flow(workflow):
        raise ValidationError('an engineering agent runs an engineering flow: pick one')


# --------------------------------------------------------------------------
# Engineering agents (7.47.00, docs/autonomous-agents.md "Engineering agents"): an agent with ``engineering``
# settings runs an engineering flow on a stored repository connection, as the administrator who enabled it. Its runs
# only take the deployment's own feedback (D8: the agents and their runs are the deployment's until 3g3).
# --------------------------------------------------------------------------

NOT_SET_UP = ('set the agent up first: its repository connection, its language and its flow\'s monthly budget '
              '(Agents → Connections adds a connection)')
RUNS_AS_ENABLER = 'an engineering agent runs as the administrator who enabled it: owner_sub is not set by hand'
STOP_FROM_MONITOR = "This is an engineering run: stop it from its run monitor"


def _engineering_connection(connection_id: str | None) -> dict[str, Any] | None:
    """The stored connection an engineering agent names (None for none named); 400 for one not stored."""
    if connection_id is None:
        return None
    row = eng_runs.connection_row(_agents_table(), connection_id)
    if row is None:
        raise ValidationError('engineering.connection names no stored repository connection: add it under Agents → '
                              'Connections')
    return row


def _check_issue_trigger(fields: Mapping[str, Any], row: Mapping[str, Any] | None) -> None:
    """A ``github_issue`` trigger needs a GitHub connection, and its label on a public repository (a repository whose
    connection does not say it is private is public: the label is then what a maintainer puts on an issue to let it
    start a run, docs/autonomous-engineering.md "How a flow starts")."""
    trigger = next((t for t in fields['triggers'] if t['kind'] == store.TRIGGER_GITHUB_ISSUE), None)
    if trigger is None:
        return
    if row is not None and eng_runs.connection_host(row) != 'github':
        raise ValidationError('a github_issue trigger needs a GitHub connection')
    if not trigger['label'] and (row is None or not eng_runs.repository_private(row)):
        raise ValidationError('a github_issue trigger needs its label on a public repository: a maintainer puts it on '
                              'an issue to let it start a run')
    # (7.50.00: an act trigger requires the triage of its own agent's kind: a bug agent's bug, a feature agent's feature)
    required = trigger.get('requires_triage')
    kind = str((fields.get('engineering') or {}).get('feedback_type') or 'bug')
    if required is not None and required != _TRIAGE_OF.get(kind):
        raise ValidationError(f'requires_triage is the triage of the agent\'s own kind: {_TRIAGE_OF.get(kind)} for '
                              f'engineering.feedback_type {kind}')


#: The triage kind each engineering agent's kind acts on (``requires_triage``, 7.50.00).
_TRIAGE_OF: Final = {'bug': 'bug', 'feature_request': 'feature'}


def _issue_stage(agent: Mapping[str, Any]) -> str:
    """The stage of the agent's ``github_issue`` trigger (``act`` without one): what a Run now of an issue claims."""
    trigger = next((t for t in agent.get('triggers') or [] if t.get('kind') == store.TRIGGER_GITHUB_ISSUE), None)
    return store.ISSUE_STAGE_ACT if trigger is None else store.issue_stage(trigger)


def _check_engineering(fields: dict[str, Any], *, enabling: bool) -> None:
    """An engineering agent's settings (400 for anything off): the module on, a stored connection (and, for a
    ``github_issue`` trigger, a GitHub one), a language with an agent image; enabled (or ``enabling``), all of them and
    its flow's monthly budget too."""
    settings = fields.get('engineering')
    if settings is None:
        return
    if not engineering_agents_on():
        raise ValidationError('an engineering agent needs the engineering agents module (-c engineeringAgents=true)')
    from engineering.runtime.egress import REGISTRY_HOSTS

    row = _engineering_connection(settings['connection'])
    _check_issue_trigger(fields, row)
    if settings['language'] is not None and settings['language'] not in REGISTRY_HOSTS:
        raise ValidationError(f'engineering.language is one of {", ".join(sorted(REGISTRY_HOSTS))}')
    if not (enabling or fields.get('enabled')):
        return
    if row is None or settings['language'] is None:
        raise ValidationError(NOT_SET_UP)
    workflow = _find_workflow(fields.get('workflow_id'))
    if workflow is None or eng_runs.stored_flow(workflow).budget_usd is None:
        raise ValidationError(NOT_SET_UP)


def _run_as(caller: Caller) -> dict[str, Any]:
    """Who an engineering agent runs as from now: the administrator enabling it (D4: the owner's way of working is
    the dial its runs' pushes follow, and the heartbeat re-checks in Cognito that they are still an admin)."""
    return {'owner_sub': caller.subject, 'owner_username': caller.username or caller.subject}


def _default_workflow_for(name: str, caller: Caller) -> str:
    """A fresh, editable copy of the built-in template for a new agent."""
    return agent_seed.default_workflow_copy(_agents_table(), name, caller)


@app.get('/agents')
@tracer.capture_method
def list_agents():
    """Agents the caller may see, by name, the engineering agents after the others with the seeded ones first in the
    loop's order (``agent_seed.list_order``). Admins may add ``?include_archived=true``."""
    caller = _caller()
    include_archived = _query('include_archived') == 'true'
    if include_archived:
        require_admin_caller(caller)
    scope = _viewer_scope(caller)
    table = _agents_table()
    if caller.is_admin and not caller.delegated:
        # Once per deployment: the default agents (shared/agent_seed.py; never fails the listing), the engineering
        # ones only where the engineering module is on.
        def categories() -> list[dict]:   # (read only when an agent is created)
            return read_categories_config(_aggregates_table())

        agent_seed.ensure_default_agent(table, caller, categories)
        if engineering_agents_on():
            agent_seed.ensure_engineering_agents(table, caller, categories)
    now = store.utc_now()
    agents = [
        store.agent_view(agent, now) for agent in store.list_agents(table)
        if (include_archived or agent.get('status') != store.AGENT_STATUS_ARCHIVED)
        and store.agent_visible(scope, agent) and _lists_engineering(agent, caller)
    ]
    agents.sort(key=agent_seed.list_order)
    return {'items': agents, 'count': len(agents)}


@app.post('/agents')
@tracer.capture_method
def create_agent():
    """Create an agent (admin). Without ``workflow_id`` it gets its own copy of the template."""
    caller = _caller()
    require_admin_caller(caller)
    fields = store.normalize_agent(json_object_body(app), read_categories_config(_aggregates_table()))
    engineering = fields['engineering'] is not None
    if fields['workflow_id'] is None:
        if engineering:
            raise ValidationError('an engineering agent names its engineering flow: workflow_id')
        fields['workflow_id'] = _default_workflow_for(fields['name'], caller)
    else:
        _require_workflow(fields['workflow_id'], engineering=engineering)
    _check_engineering(fields, enabling=False)
    if engineering and fields['owner_sub'] is not None:
        raise ValidationError(RUNS_AS_ENABLER)
    if engineering and fields['enabled']:
        refused = _not_ready({**fields, 'enabled': False}, caller)
        if refused is not None:
            return refused
        fields.update(_run_as(caller))
    agent = store.create_agent(_agents_table(), fields, created_by=caller.subject, now=store.utc_now())
    logger.info('Agent created', extra={'agent_id': agent['agent_id']})
    return _json(201, {'agent': store.agent_view(agent)})


@app.get('/agents/<agent_id>')
@tracer.capture_method
def get_agent(agent_id: str):
    return {'agent': store.agent_view(_visible_agent(agent_id, _caller()))}


@app.put('/agents/<agent_id>')
@tracer.capture_method
def update_agent(agent_id: str):
    """Update an agent (admin); omitted fields keep their stored values."""
    caller = _caller()
    require_admin_caller(caller)
    existing = _stored_agent(agent_id)
    body = json_object_body(app)
    fields = store.normalize_agent(body, read_categories_config(_aggregates_table()), base=existing)
    engineering = fields['engineering'] is not None
    if fields['workflow_id'] is None:
        fields['workflow_id'] = existing.get('workflow_id') or workflow_schema.DEFAULT_WORKFLOW_ID
    if fields['workflow_id'] != existing.get('workflow_id') or engineering != store.is_engineering_agent(existing):
        _require_workflow(fields['workflow_id'], engineering=engineering)
    _check_engineering(fields, enabling=False)
    if engineering and 'owner_sub' in body:
        raise ValidationError(RUNS_AS_ENABLER)
    if fields['owner_sub'] is None:
        fields['owner_sub'] = existing.get('owner_sub')
    if engineering and fields['enabled'] and existing.get('enabled') is not True:
        refused = _not_ready({**existing, **fields, 'enabled': False}, caller)
        if refused is not None:
            return refused
        fields.update(_run_as(caller))
    updated = store.update_agent(_agents_table(), agent_id, fields, updated_by=caller.subject, now=store.utc_now())
    return {'agent': store.agent_view(_pause_ended_if_off(updated, caller))}


@app.delete('/agents/<agent_id>')
@tracer.capture_method
def archive_agent(agent_id: str):
    """Archive (never delete) an agent (admin): disabled, hidden, its runs kept."""
    caller = _caller()
    require_admin_caller(caller)
    _stored_agent(agent_id, include_archived=True)
    updated = store.update_agent(
        _agents_table(), agent_id, {'status': store.AGENT_STATUS_ARCHIVED, 'enabled': False},
        updated_by=caller.subject, now=store.utc_now(), allow_archived=True,
    )
    logger.info('Agent archived', extra={'agent_id': agent_id})
    return {'agent': store.agent_view(updated)}


def _set_enabled(agent_id: str, enabled: bool) -> dict | Response:
    """Enable or disable (admin). An engineering agent is enabled only once it is set up (400 otherwise) and its
    required readiness checks pass (409 with the failing ones, 7.50.00: ``_not_ready``), and from then runs as the
    administrator who enabled it (``owner_sub``, ``owner_username``)."""
    caller = _caller()
    require_admin_caller(caller)
    agent = _stored_agent(agent_id)
    change: dict[str, Any] = {'enabled': enabled}
    if enabled and store.is_engineering_agent(agent):
        fields = store.normalize_agent({}, read_categories_config(_aggregates_table()), base=agent)
        _check_engineering(fields, enabling=True)
        if agent.get('enabled') is not True:
            refused = _not_ready({**agent, **fields}, caller)
            if refused is not None:
                return refused
            change.update(_run_as(caller))
    updated = store.update_agent(_agents_table(), agent_id, change, updated_by=caller.subject, now=store.utc_now())
    return {'agent': store.agent_view(_pause_ended_if_off(updated, caller))}


def _pause_ended_if_off(agent: dict, caller: Caller) -> dict:
    """An agent just turned off ends its pause (7.52.00: only an automation that is on is paused), logged as resumed
    ``via: disabled``; the agent as it is now."""
    if agent.get('enabled') is True or agent.get('paused') is not True:
        return agent
    try:
        return store.set_paused(_agents_table(), str(agent['agent_id']), False, by=caller.subject,
                                username=caller.username or caller.subject, now=store.utc_now(), via='disabled')
    except ConflictError:   # (someone resumed it meanwhile)
        return store.get_agent(_agents_table(), str(agent['agent_id'])) or agent


@app.post('/agents/<agent_id>/enable')
@tracer.capture_method
def enable_agent(agent_id: str):
    return _set_enabled(agent_id, True)


@app.post('/agents/<agent_id>/disable')
@tracer.capture_method
def disable_agent(agent_id: str):
    """Disabling stops new scheduled runs; an in-flight run finishes."""
    return _set_enabled(agent_id, False)


# --------------------------------------------------------------------------
# Runs.
# --------------------------------------------------------------------------

@app.post('/agents/<agent_id>/run')
@tracer.capture_method
def run_agent(agent_id: str):
    """Run now (admin): unlimited — not counted against the scheduled daily cap.

    409 while the agent already has a queued or running run.
    """
    caller = _caller()
    _require_run_permission(caller)
    if not store.state_machine_arn():
        raise ConfigurationError('Agent runtime not configured')
    table = _agents_table()
    agent = _stored_agent(agent_id)
    if store.is_engineering_agent(agent):
        return _run_engineering_agent(table, agent, caller)
    workflow = _find_workflow(agent.get('workflow_id') or workflow_schema.DEFAULT_WORKFLOW_ID)
    if workflow is None:
        raise ConflictError("The agent's workflow no longer exists; choose another workflow")
    now = store.utc_now()
    run = store.start_run(table, agent, store.RunStart(
        trigger=store.TRIGGER_MANUAL, requested_by=caller.subject,
        workflow_revision=store.plain(workflow.get('revision')) or 1,
    ), now=now)
    if run is None:
        raise ConflictError('This agent already has a run in progress')
    run = store.launch_run(table, run, now=now)
    logger.info('Agent run started', extra={'agent_id': agent_id, 'run_id': run['run_id'], 'trigger': 'manual'})
    return _json(202, {'run': store.run_view(run)})


def _run_prd(body: Mapping[str, Any]) -> dict[str, str] | None:
    """The optional ``prd`` a feature agent's run builds from: ``{project_id, document_id}`` (400 otherwise). Only its
    ids go to the run (its goal names them); the PRD's text is not handed to the run's agents."""
    raw = body.get('prd')
    if raw is None:
        return None
    if not isinstance(raw, Mapping) or set(raw) != {'project_id', 'document_id'}:
        raise ValidationError('prd is {project_id, document_id}')
    from shared.row_ids import validated_row_id

    return {'project_id': validated_row_id(raw['project_id'], field='project_id'),
            'document_id': validated_row_id(raw['document_id'], field='document_id')}


def _engineering_sentence(settings: Mapping[str, Any], repository: str, issue: int | None,
                          prd: Mapping[str, str] | None, stage: str = store.ISSUE_STAGE_ACT) -> str:
    """What a Run now asks of an engineering agent: the issue (its triage, for a triage agent), the PRD (a feature
    agent's), or a bug hunt."""
    feedback_type = str(settings.get('feedback_type'))
    if issue is not None:
        return eng_runs.issue_sentence(feedback_type, repository, issue, stage)
    if prd is not None:
        if feedback_type != 'feature_request':
            raise ValidationError('a PRD is built by a feature agent (engineering.feedback_type feature_request)')
        return eng_runs.prd_sentence(prd['project_id'], prd['document_id'])
    if feedback_type != 'bug':
        raise ValidationError('a feature agent runs on an issue or a PRD: give its issue number or the PRD')
    return eng_runs.hunt_sentence(repository)


def _run_engineering_agent(table: Any, agent: dict, caller: Caller, body: Mapping[str, Any] | None = None) -> Response:
    """Run now of an engineering agent (7.47.00): ``{issue?} | {prd?}`` → 202 ``{run}``. An administrator acting for
    themselves only (a delegated credential gets 403), as the person the run's pushes follow; 404 while the module is
    off; 409 until the agent is set up, or while it has a run in progress. A run of an issue reruns it (the one way to:
    a trigger starts an issue once, ever). The start's refusal is 409 in its words, a start known not written 503; one
    that may have been written is 503 naming its engineering run (open it, never start another). ``body``: a confirmed
    run request's (7.53.00), else the request's own."""
    require_admin_caller(caller)
    _engineering_on()
    function = os.environ.get(eng_runs.START_FUNCTION_ENV, '')
    if not function:
        raise ServiceUnavailableError('runs cannot be started from here: the deployment names no start function')
    body = json_object_body(app) if body is None else body
    if not set(body) <= {'issue', 'prd'} or {'issue', 'prd'} <= set(body):
        raise ValidationError('the body is {issue?: number} or {prd?: {project_id, document_id}}, or none')
    settings = agent['engineering']
    row = eng_runs.connection_row(table, settings['connection']) if settings.get('connection') else None
    if row is None or not settings.get('language'):
        raise ConflictError(NOT_SET_UP)
    issue, prd = _start_issue(body), _run_prd(body)
    repository, stage = str(row.get('repository', '')), _issue_stage(agent)
    started = eng_runs.start_agent_run(
        table, agent, _find_workflow(agent.get('workflow_id')), row,
        eng_runs.AgentStart(trigger=store.TRIGGER_MANUAL, requested_by=caller.subject, actor=caller.subject,
                            sentence=_engineering_sentence(settings, repository, issue, prd, stage), prd=prd,
                            claim=False, stage=stage,
                            issue=None if issue is None else eng_runs.IssueRef(repository, issue)),
        client=_start_client(), function=function, now=store.utc_now())
    if started.run is None or started.answer is None:
        raise ConflictError('This agent already has a run in progress')
    answer, run = started.answer, started.run
    logger.info('Engineering agent run', extra={'agent_id': agent['agent_id'], 'run_id': run['run_id'],
                                                'outcome': answer.outcome})
    if answer.outcome == 'uncertain':
        return _json(503, {'error': answer.message or f"run {run['engineering_run_id']} may have been started: open "
                           'the run monitor before you start another', 'run_id': run['engineering_run_id']})
    if answer.outcome != 'started':
        raise _start_failure(answer)
    current = store.get_run(table, agent['agent_id'], run['run_id']) or run
    return _json(202, {'run': store.run_view(current)})


def _visible_run(agent_id: str, run_id: str, caller: Caller) -> dict:
    _visible_agent(agent_id, caller)
    run = store.get_run(_agents_table(), agent_id, run_id) if store.is_run_id(run_id) else None
    if run is None:
        raise NotFoundError(RUN_NOT_FOUND)
    return run


@app.get('/agents/<agent_id>/runs')
@tracer.capture_method
def list_runs(agent_id: str):
    """Newest-first runs; ``?limit=&cursor=``."""
    _visible_agent(agent_id, _caller())
    limit = validate_int(_query('limit'), default=DEFAULT_RUNS_PAGE, min_val=1, max_val=MAX_RUNS_PAGE)
    items, next_cursor = store.list_runs(_agents_table(), agent_id, limit=limit, cursor=_query('cursor'))
    return {'items': [store.run_view(item) for item in items], 'next_cursor': next_cursor}


@app.get('/agents/<agent_id>/runs/<run_id>')
@tracer.capture_method
def get_run(agent_id: str, run_id: str):
    return {'run': store.run_view(_visible_run(agent_id, run_id, _caller()))}


@app.get('/agents/<agent_id>/runs/<run_id>/events')
@tracer.capture_method
def list_run_events(agent_id: str, run_id: str):
    """Journal events with ``seq > after`` (oldest first), for polling."""
    _visible_run(agent_id, run_id, _caller())
    after = validate_int(_query('after'), default=0, min_val=0, max_val=99_999_998)
    limit = validate_int(_query('limit'), default=MAX_EVENTS_PAGE, min_val=1, max_val=MAX_EVENTS_PAGE)
    items = store.list_events(_agents_table(), run_id, after=after, limit=limit)
    return {'items': items, 'next_after': items[-1]['seq'] if items else after}


@app.post('/agents/<agent_id>/runs/<run_id>/cancel')
@tracer.capture_method
def cancel_run(agent_id: str, run_id: str):
    """Cancel a queued or running run (admin); 409 once it has finished."""
    caller = _caller()
    require_admin_caller(caller)
    run = _visible_run(agent_id, run_id, caller)
    if run.get('kind') == store.RUN_KIND_ENGINEERING:
        # (its run monitor's Stop ends the engineering run; the heartbeat then ends this one)
        raise ConflictError(STOP_FROM_MONITOR)
    table, now = _agents_table(), store.utc_now()
    cancelled = store.finish_run(table, agent_id, run_id, store.RUN_CANCELLED, now=now)
    if cancelled is None:
        raise ConflictError('This run has already finished')
    execution_arn = store.execution_arn_for(run)
    if execution_arn:
        store.stop_execution(execution_arn)
    store.append_event(table, agent_id, run_id, 'decision', 'Run cancelled by an admin', now=now, role='system')
    logger.info('Agent run cancelled', extra={'agent_id': agent_id, 'run_id': run_id})
    return {'run': store.run_view(cancelled)}


def _resume(table: Any, agent: dict, run: dict, record: dict) -> dict:
    if not store.state_machine_arn():
        raise ConfigurationError('Agent runtime not configured')
    try:
        return agent_run_resume.resume_run(table, agent, run, record, now=store.utc_now())
    except agent_run_resume.ResumeRefused as refused:
        if refused.reason == agent_run_resume.AGENT_BUSY:
            raise ConflictError('This agent already has a run in progress') from refused
        raise ConflictError(RUN_ALREADY_DECIDED) from refused


@app.post('/agents/<agent_id>/runs/<run_id>/decision')
@tracer.capture_method
def decide_run(agent_id: str, run_id: str):
    """A human's decision on a needs_human run (admin): ``{decision, note?}`` → ``{run}``.

    ``stop`` closes it; ``accept`` / ``another_round`` resume it in a new execution
    (shared/agent_run_resume.py, docs/autonomous-agents.md "When a run needs a human").
    """
    caller = _caller()
    require_admin_caller(caller)
    run = _visible_run(agent_id, run_id, caller)
    decision, note = agent_run_decisions.parse_decision(json_object_body(app))
    view = store.run_view(run)
    if run.get('status') != store.RUN_NEEDS_HUMAN or view['decision'] is not None:
        raise ConflictError(RUN_ALREADY_DECIDED)
    if decision not in view['actions']:
        raise ValidationError(f"decision must be one of {', '.join(view['actions'])} for this run")
    table, now = _agents_table(), store.utc_now()
    record = agent_run_resume.decision_record(decision, note, username=caller.username, sub=caller.subject, now=now)
    if decision == agent_run_decisions.DECISION_STOP:
        updated = agent_run_resume.close_run(table, agent_id, run_id, record)
        if updated is None:
            raise ConflictError(RUN_ALREADY_DECIDED)
    else:
        updated = _resume(table, _stored_agent(agent_id, include_archived=True), run, record)
    store.append_event(table, agent_id, run_id, 'decision', agent_run_resume.decided_summary(record),
                       now=now, role='system')
    logger.info('Agent run decided', extra={'agent_id': agent_id, 'run_id': run_id, 'decision': decision})
    return {'run': store.run_view(updated)}


# --------------------------------------------------------------------------
# Workflows.
# --------------------------------------------------------------------------

def _workflow(workflow_id: str, *, include_archived: bool = False) -> dict:
    """The workflow a path names, or 404."""
    workflow = _find_workflow(workflow_id, include_archived=include_archived)
    if workflow is None:
        raise NotFoundError(WORKFLOW_NOT_FOUND)
    return workflow


def _valid_definition(raw: object) -> dict[str, Any] | Response:
    """The normalised definition, or the 400 response that lists every error."""
    result = workflow_schema.validate_definition(raw)
    if result.definition is None:
        return _json(400, {'success': False, 'error': 'The workflow is not valid', **result.to_dict()})
    return result.definition


def _save_issues(definition: Mapping[str, Any], workflow_id: str | None) -> list[dict[str, str]]:
    """What a save of an engineering flow is refused for beyond its own rules (7.52.00): a call that cannot be
    expanded (the expansion a run's start makes, simulated on the stored flows: shared/flow_expand.py), a step id with
    the expansion's ``.``, a recorded ``expansion``, or a step from a Registry card that does not carry the card's
    role, skill version and model. 503 when the stored flows or cards cannot be read."""
    try:
        found = flow_expand.save_issues(definition, eng_runs.revision_reader(_agents_table()), root=workflow_id)
        found += agents_engineering_registry_routes.card_issues(definition)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Workflow: the flows it calls or its cards could not be read')
        raise ServiceUnavailableError('the flows it calls could not be read: retry') from exc
    return [{'message': message, **({'node_id': node_id} if node_id else {})} for message, node_id in found]


def _refused_save(definition: Mapping[str, Any], workflow_id: str | None) -> Response | None:
    """The 400 a save of ``definition`` gets from ``_save_issues``, None when it gets none."""
    issues = _save_issues(definition, workflow_id)
    if not issues:
        return None
    return _json(400, {'success': False, 'error': 'The workflow is not valid', 'valid': False, 'errors': issues})


SHARED_FLOW = ('other automations run this flow: saving changes each of them from its next run. Save again with '
               'confirm_shared: true to change them all')


def _automation(agent: Mapping[str, Any]) -> dict[str, Any]:
    settings = agent.get('engineering') if isinstance(agent.get('engineering'), Mapping) else {}
    return {'agent_id': str(agent.get('agent_id')), 'name': str(agent.get('name') or agent.get('agent_id')),
            'kind': 'engineering' if store.is_engineering_agent(agent) else 'agents',
            'connection': settings.get('connection'), 'language': settings.get('language')}


def _used_by(caller: Caller, workflows: list[dict] | None = None) -> dict[str, dict[str, list[dict[str, Any]]]]:
    """Each workflow's users (7.52.00, "Used by"): ``{workflow_id: {automations: [{agent_id, name, kind, connection,
    language}], flows: [{workflow_id, name, revision}]}}``. The automations that run it, as ``caller`` may see them
    (archived ones left out, by name); the saved flows whose current revision calls it (``call_flow``), each with the
    revision of it that it pins (archived ones left out). ``workflows``: the library's rows, when already read."""
    scope: CategoryScope | None = None
    found: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for agent in store.list_agents(_agents_table()):
        workflow_id = agent.get('workflow_id')
        if (agent.get('status') == store.AGENT_STATUS_ARCHIVED or not isinstance(workflow_id, str)
                or not _lists_engineering(agent, caller)):
            continue
        if not acts_as_admin(caller):
            scope = scope or _viewer_scope(caller)
            if not store.agent_visible(scope, agent):
                continue
        found.setdefault(workflow_id, {'automations': [], 'flows': []})['automations'].append(_automation(agent))
    rows = workflows if workflows is not None else store.list_workflows(_agents_table())
    for row in rows:
        if store.is_archived_workflow(row):
            continue
        definition = workflow_schema.decode_definition(row.get('definition'))
        pins = {ref for call in flow_expand.calls(definition)
                if (ref := flow_expand.flow_ref(call.get('data', {}).get('params', {}).get('flow'))) is not None}
        for called, revision in sorted(pins):
            found.setdefault(called, {'automations': [], 'flows': []})['flows'].append({
                'workflow_id': str(row.get('workflow_id')), 'name': str(row.get('name') or row.get('workflow_id')),
                'revision': revision})
    return {workflow_id: {'automations': sorted(users['automations'],
                                                key=lambda user: (user['name'].lower(), user['agent_id'])),
                          'flows': sorted(users['flows'], key=lambda user: (user['name'].lower(),
                                                                            user['workflow_id'], user['revision']))}
            for workflow_id, users in found.items()}


def _uses(caller: Caller, workflow_id: str) -> dict[str, list[dict[str, Any]]]:
    """One workflow's users (``_used_by``), nobody's when it has none."""
    return _used_by(caller).get(workflow_id) or {'automations': [], 'flows': []}


def _create_from(raw: object, derived_from: str | None) -> Response:
    caller = _caller()
    require_admin_caller(caller)
    definition = _valid_definition(raw)
    if isinstance(definition, Response):
        return definition
    if definition['schema'] == workflow_schema.SCHEMA_V2 and not engineering_agents_on():
        # Every way to a new workflow comes here (POST /workflows: New, the editor's Save as, an imported draft saved
        # as new, the assistant's create card; and the assistant's …/duplicate): a NEW engineering flow only where the
        # module is deployed (owner decision 28, held on the server too); one already saved keeps working.
        raise ConflictError('engineering flows are created only where the engineering agents module is deployed: '
                            'an engineering flow already saved still opens and saves')
    refused = _refused_save(definition, None)
    if refused is not None:
        return refused
    created = store.create_workflow(_agents_table(), definition, created_by=caller.subject,
                                    username=caller.username, now=store.utc_now(), derived_from=derived_from)
    logger.info('Workflow created', extra={'workflow_id': created['workflow_id']})
    return _json(201, {'workflow': store.workflow_view(created)})


@app.get('/workflows')
@tracer.capture_method
def list_workflows():
    """The library: the built-in template first, then by name (no definitions).

    Archived workflows are hidden; an admin may add ``?include_archived=true``.
    """
    caller = _caller()
    include_archived = _query('include_archived') == 'true'
    if include_archived:
        require_admin_caller(caller)
    # Both kinds are listed, each with its `kind`: the editor opens either; an agent's picker offers only `agents`.
    every = store.list_workflows(_agents_table())
    rows = [row for row in every if include_archived or not store.is_archived_workflow(row)]
    builtin, stored = rows[:1], sorted(rows[1:], key=lambda row: str(row.get('gsi1sk') or ''))
    # (7.52.00: each with the automations that run it, as the caller may see them, and the flows that call it)
    users = _used_by(caller, every)
    items = [{**store.workflow_view(row, include_definition=False),
              'used_by': users.get(str(row.get('workflow_id'))) or {'automations': [], 'flows': []}}
             for row in builtin + stored]
    return {'items': items, 'count': len(items)}


@app.post('/workflows')
@tracer.capture_method
def create_workflow():
    """Create a library workflow (admin): ``{definition}``."""
    return _create_from(json_object_body(app).get('definition'), None)


@app.post('/workflows/validate')
@tracer.capture_method
def validate_workflow():
    """``{definition, workflow_id?}`` → ``{valid, errors, diff?}``; the diff is against that workflow's current revision.
    For an administrator (who saves), an engineering flow's errors include what its save would be refused for (its
    calls expanded, its Registry cards: ``_save_issues``)."""
    caller = _caller()
    body = json_object_body(app)
    result = workflow_schema.validate_definition(body.get('definition'))
    response: dict[str, Any] = result.to_dict()
    # Methodology gaps (a PRD with no PR/FAQ before it, ...): warnings, never errors (tenet 2).
    # The methodology rules are the agents' (research, PR/FAQ, PRD, prototype); an engineering flow has none of them.
    definition = result.definition
    agents_flow = definition is not None and definition['schema'] == workflow_schema.SCHEMA
    response['warnings'] = workflow_methodology.methodology_warnings(definition) if definition and agents_flow else []
    workflow_id = body.get('workflow_id')
    if definition is not None and not agents_flow and acts_as_admin(caller):
        # (7.52.00: what its save would be refused for beyond its rules: its calls expanded, its Registry cards)
        issues = _save_issues(definition, workflow_id if store.is_workflow_id(workflow_id) else None)
        if issues:
            response['valid'], response['errors'] = False, issues
    if workflow_id is not None and isinstance(body.get('definition'), Mapping):
        current = workflow_schema.decode_definition(_workflow(str(workflow_id)).get('definition'))
        response['diff'] = workflow_schema.diff_definitions(current, result.definition or body['definition'])
        stored_kind = (current or {}).get('schema', workflow_schema.SCHEMA)   # as the save reads it
        if result.definition is not None and result.definition['schema'] != stored_kind:
            # The save over that workflow would be refused (it keeps its kind): say so here too.
            response['valid'] = False
            response['errors'] = [{'message': KEEPS_ITS_KIND}]
    return response


ENGINEERING_TEMPLATES_NOT_FOUND = 'Engineering flow templates not found'


@app.get('/workflows/templates')
@tracer.capture_method
def list_workflow_templates():
    """The default engineering flows (``shared.engineering_templates``), each with its definition, for an
    administrator where the engineering module is deployed (404 elsewhere, like the engineering runs' routes; 403 for
    anyone else). Read only: "create from template" is ``POST /workflows`` with the template's definition, so a copy
    gets the create's own validation, 409 and, from the assistant, its approval card. Registered before
    ``/workflows/<workflow_id>``, which would otherwise take the path."""
    if not engineering_agents_on():
        raise NotFoundError(ENGINEERING_TEMPLATES_NOT_FOUND)
    require_admin_caller(_caller())
    items = engineering_templates.list_templates()
    return {'items': items, 'count': len(items)}


@app.get('/workflows/<workflow_id>')
@tracer.capture_method
def get_workflow(workflow_id: str):
    """The current revision (with its definition and, 7.52.00, the automations that run it: ``used_by``) and the
    revision list."""
    caller = _caller()
    workflow = _workflow(workflow_id, include_archived=_sees_archived(caller))
    return {'workflow': {**store.workflow_view(workflow), 'used_by': _uses(caller, workflow_id)},
            'revisions': store.list_revisions(_agents_table(), workflow_id)}


_ASCII_DIGITS = re.compile(r'[0-9]+')


def _revision_number(raw: str) -> int:
    """The path's revision as an int in 1..MAX_REVISION (the stored sort key's range), else 400."""
    # The width check comes first: a very long digit string never reaches int() (its digit limit raises).
    fits = len(raw) <= len(str(store.MAX_REVISION)) and _ASCII_DIGITS.fullmatch(raw) is not None
    number = int(raw) if fits else 0
    if not 1 <= number <= store.MAX_REVISION:
        raise ValidationError(f'revision must be a whole number from 1 to {store.MAX_REVISION}')
    return number


@app.get('/workflows/<workflow_id>/revisions/<revision>')
@tracer.capture_method
def get_workflow_revision(workflow_id: str, revision: str):
    """One saved revision with its definition (read-only history); the same read rule as ``GET /workflows/{id}``."""
    caller = _caller()
    number = _revision_number(revision)
    _workflow(workflow_id, include_archived=_sees_archived(caller))
    found = store.get_revision(_agents_table(), workflow_id, number)
    if found is None:
        raise NotFoundError('Workflow revision not found')
    return found


@app.put('/workflows/<workflow_id>')
@tracer.capture_method
def save_workflow(workflow_id: str):
    """Save a new revision (admin): ``{definition, expected_revision, confirm_shared?, agent_id?}``; 409 when stale.

    A flow other automations run (7.52.00, "Used by": any but ``agent_id``, the automation whose page the edit comes
    from) changes each of them from its next run, so its save needs ``confirm_shared: true``: without it, 409
    ``{code: shared_flow, used_by}`` and nothing is saved. An engineering flow's calls are expanded first, as a run's
    start will (400 for one that cannot be)."""
    caller = _caller()
    require_admin_caller(caller)
    body = json_object_body(app)
    expected = body.get('expected_revision')
    if isinstance(expected, bool) or not isinstance(expected, int) or expected < 1:
        raise ValidationError('expected_revision must be the revision you edited (a whole number ≥ 1)')
    confirmed, from_agent = body.get('confirm_shared', False), body.get('agent_id')
    if not isinstance(confirmed, bool) or (from_agent is not None and not store.is_agent_id(from_agent)):
        raise ValidationError('confirm_shared is true or false, and agent_id the automation the edit comes from')
    current = workflow_schema.decode_definition(_workflow(workflow_id).get('definition')) or {}
    definition = _valid_definition(body.get('definition'))
    if isinstance(definition, Response):
        return definition
    if definition['schema'] != current.get('schema', workflow_schema.SCHEMA):
        # An agent may run this workflow: it stays an agents workflow (or an engineering flow) for good.
        raise ValidationError(KEEPS_ITS_KIND)
    refused = _refused_save(definition, workflow_id)
    if refused is not None:
        return refused
    # (the flows that call it pin a revision of it: a save changes none of them, so only automations hold it)
    users = _uses(caller, workflow_id)
    if not confirmed and any(user['agent_id'] != from_agent for user in users['automations']):
        return _json(409, {'success': False, 'error': SHARED_FLOW, 'code': 'shared_flow', 'used_by': users})
    saved = store.save_revision(_agents_table(), workflow_id, definition, expected_revision=expected,
                                saved_by=caller.subject, username=caller.username, now=store.utc_now())
    return {'workflow': {**store.workflow_view(saved), 'used_by': users}}


@app.post('/workflows/<workflow_id>/duplicate')
@tracer.capture_method
def duplicate_workflow(workflow_id: str):
    """Save as (admin): a new workflow from the current revision; ``{name?}``."""
    require_admin_caller(_caller())
    definition = workflow_schema.decode_definition(_workflow(workflow_id).get('definition')) or {}
    name = json_object_body(app).get('name')
    if name is not None:
        definition['name'] = name
    else:
        definition['name'] = f"{definition.get('name', 'Workflow')} (copy)"[:workflow_schema.MAX_NAME_CHARS]
    return _create_from(definition, workflow_id)


def _workflow_name(raw: object) -> str:
    """A workflow name from a request body: trimmed, 1 to MAX_NAME_CHARS characters, or 400."""
    name = raw.strip() if isinstance(raw, str) else ''
    if not name or len(name) > workflow_schema.MAX_NAME_CHARS:
        raise ValidationError(f'name must be 1-{workflow_schema.MAX_NAME_CHARS} characters')
    return name


@app.post('/workflows/<workflow_id>/rename')
@tracer.capture_method
def rename_workflow(workflow_id: str):
    """Rename (admin): ``{name}`` → a new revision of the CURRENT definition with only the name changed.

    The graph is not re-validated: a workflow saved before a newer rule can still be
    renamed (``save_revision`` keeps the definition as stored). 409 for the built-in
    template and when someone saved meanwhile; renaming to the same name is a no-op.
    """
    caller = _caller()
    require_admin_caller(caller)
    name = _workflow_name(json_object_body(app).get('name'))
    workflow = _workflow(workflow_id)
    if workflow.get('builtin'):
        raise ConflictError('The built-in workflow cannot be renamed; duplicate it to get your own copy')
    definition = workflow_schema.decode_definition(workflow.get('definition'))
    if definition is None:
        raise ConflictError('This workflow cannot be read; open it in the editor and save it again')
    if definition.get('name') == name:
        return {'workflow': store.workflow_view(workflow)}
    definition['name'] = name
    saved = store.save_revision(_agents_table(), workflow_id, definition,
                                expected_revision=store.plain(workflow.get('revision')) or 1,
                                saved_by=caller.subject, username=caller.username, now=store.utc_now())
    logger.info('Workflow renamed', extra={'workflow_id': workflow_id})
    return {'workflow': store.workflow_view(saved)}


@app.delete('/workflows/<workflow_id>')
@tracer.capture_method
def archive_workflow(workflow_id: str):
    """Archive (never delete) a workflow (admin): hidden from the library and read-only.

    Refused (409) while an active agent still runs it — archive or repoint that
    agent first — and for the built-in template. Archiving twice is a no-op.
    """
    caller = _caller()
    require_admin_caller(caller)
    if _workflow(workflow_id, include_archived=True).get('builtin'):
        raise ConflictError('The built-in workflow cannot be archived')
    users = sorted(
        str(agent.get('name') or agent.get('agent_id'))
        for agent in store.list_agents(_agents_table())
        if agent.get('workflow_id') == workflow_id and agent.get('status') != store.AGENT_STATUS_ARCHIVED
    )
    if users:
        raise ConflictError(f"The workflow is used by {', '.join(users)}; archive those agents or change their workflow first")
    archived = store.archive_workflow(_agents_table(), workflow_id, archived_by=caller.subject,
                                      username=caller.username, now=store.utc_now())
    logger.info('Workflow archived', extra={'workflow_id': workflow_id})
    return {'workflow': store.workflow_view(archived, include_definition=False)}


@app.get('/workflows/<workflow_id>/export')
@tracer.capture_method
def export_workflow(workflow_id: str):
    """The current revision as an importable file."""
    workflow = _workflow(workflow_id, include_archived=_sees_archived(_caller()))
    definition = workflow_schema.decode_definition(workflow.get('definition')) or {}
    return workflow_schema.export_document(
        definition, workflow_id=workflow_id, revision=store.plain(workflow.get('revision')) or 1,
        slug=str(workflow.get('slug') or workflow_schema.slugify(str(definition.get('name') or ''))),
    )


# --------------------------------------------------------------------------
# Plans (docs/assistant-plan-mode.md). NOT admin-only: any signed-in user approves
# their own plan; reads and cancel are the approver's (or an admin's); resolving a
# paused step is the approver's alone. Unknown or foreign plans answer 404.
# --------------------------------------------------------------------------

def _plan_approver(caller: Caller) -> plans_store.Approver:
    """The signed-in human approving a plan. A delegated credential (MCP token, agent) never approves one."""
    if caller.delegated or not caller.subject or not caller.username:
        raise AuthorizationError('A plan must be approved by a signed-in user')
    return plans_store.Approver(sub=caller.subject, username=caller.username)


def _packs_for(is_admin: bool) -> tuple[str, ...]:
    return PACKS if is_admin else tuple(pack for pack in PACKS if pack not in ADMIN_ONLY_PACKS)


def _conversation_id(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or LONG_OPAQUE_ID_RE.fullmatch(value) is None:
        raise ValidationError('conversation_id must be a conversation id')
    return value


PLAN_SIGNED_IN_ONLY = 'Plans are read and managed by the signed-in user who approved them'


def _approval_workspace(event: dict) -> str | None:
    """The workspace the approval's own request named (``X-Workspace-Id``, docs/multi-workspace.md "Request flow"),
    resolved as every other route resolves it (shared/request_workspace.py ``request_workspace``): the approver must be
    a member of that active workspace now (from the table, not the warm cache), and a malformed id, an unknown or
    deleting workspace or a non-member is the one 404, before anything is written (since 7.29.00). Membership is the
    bar, no role: a platform admin approves there only as a member (no entry: a plan's steps carry no group to enter
    with). It is kept on the plan, so each step names it to the domain Lambdas it calls (agents/plan_identity.py),
    which resolve the approver's membership there again, and the conductor re-checks it before every step and every
    wait. ``None`` when it names none (no header, or a blank one): the deployment as before."""
    context = request_workspace(event, 'Failed to approve the plan', fresh=True, elevate=False)
    return None if context is None else context.ws


def _refuse_delegated(caller: Caller) -> None:
    """A delegated credential (MCP token, agent) never reads, lists, cancels or resolves a plan: 403."""
    if caller.delegated:
        raise AuthorizationError(PLAN_SIGNED_IN_ONLY)


def _visible_plan(plan_id: str, caller: Caller) -> dict:
    """The plan's META if ``caller`` approved it or is an admin; 403 for a delegated caller, 404 otherwise."""
    _refuse_delegated(caller)
    meta = plans_store.get_meta(_agents_table(), plan_id) if is_plan_id(plan_id) else None
    if meta is None or (meta.get('approver_sub') != caller.subject and not caller.is_admin):
        raise NotFoundError(PLAN_NOT_FOUND)
    return plans_store.expire_if_stale(_agents_table(), meta, now=store.utc_now())


def _plan_response(plan_id: str) -> dict:
    table = _agents_table()
    meta = plans_store.get_meta(table, plan_id)
    if meta is None:
        raise NotFoundError(PLAN_NOT_FOUND)
    return {'plan': plans_store.plan_view(meta, plans_store.get_steps(table, plan_id))}


@app.post('/agents/plans')
@tracer.capture_method
def approve_plan():
    """Approve and start a ``voc-plan/1`` plan: ``{plan, conversation_id?}`` → 202 ``{plan_id, status}``."""
    # First: the workspace it is approved in (the one 404 for a non-member), before any answer or write.
    workspace = _approval_workspace(app.current_event.raw_event)
    caller = _caller()
    approver = _plan_approver(caller)
    body = json_object_body(app)
    conversation_id = _conversation_id(body.get('conversation_id'))
    is_admin = caller.is_admin and not caller.delegated
    plan, errors = validate_plan(body.get('plan'), is_admin=is_admin, packs_allowed=_packs_for(is_admin))
    if plan is None:
        return _json(400, {'success': False, 'message': 'The plan is not valid', 'errors': errors})
    if not store.state_machine_arn():
        raise ConfigurationError('Agent runtime not configured')
    table, now = _agents_table(), store.utc_now()
    try:
        # Atomic: the create transaction takes one of plans_store.MAX_ACTIVE_PLANS slots or fails.
        meta = plans_store.create_plan(table, plan, approver=approver, conversation_id=conversation_id, now=now,
                                       workspace=workspace)
    except plans_store.PlanCapReached as full:
        raise ConflictError(str(full)) from full
    plans_store.launch_plan(table, meta, now=now)
    logger.info('Plan approved', extra={'plan_id': meta['plan_id'], 'steps': meta['step_count']})
    return _json(202, {'plan_id': meta['plan_id'], 'status': plans_store.PLAN_APPROVED})


@app.get('/agents/plans')
@tracer.capture_method
def list_plans():
    """The caller's newest plans (summaries); ``?limit=``. 403 for a delegated caller."""
    caller = _caller()
    _refuse_delegated(caller)
    limit = validate_int(_query('limit'), default=plans_store.DEFAULT_LIST_LIMIT, min_val=1,
                         max_val=plans_store.MAX_LIST_LIMIT)
    table, now = _agents_table(), store.utc_now()
    rows = [plans_store.expire_if_stale(table, row, now=now)
            for row in plans_store.list_plans(table, caller.subject, limit=limit)] if caller.subject else []
    return {'plans': [plans_store.plan_summary_view(row) for row in rows]}


@app.get('/agents/plans/<plan_id>')
@tracer.capture_method
def get_plan(plan_id: str):
    _visible_plan(plan_id, _caller())
    return _plan_response(plan_id)


@app.post('/agents/plans/<plan_id>/cancel')
@tracer.capture_method
def cancel_plan(plan_id: str):
    """Cancel (approver or admin): no new step starts; a running write finishes. 409 once finished."""
    caller = _caller()
    _visible_plan(plan_id, caller)
    table, now = _agents_table(), store.utc_now()
    if plans_store.cancel_plan(table, plan_id, now=now) is None:
        raise ConflictError('This plan has already finished')
    plans_store.append_event(table, plan_id, 'plan_cancelled', 'Plan cancelled', now=now)
    logger.info('Plan cancelled', extra={'plan_id': plan_id})
    return _plan_response(plan_id)


@app.delete('/agents/plans/<plan_id>')
@tracer.capture_method
def hide_plan(plan_id: str):
    """Remove a finished plan from its approver's list (approver or admin) → ``{plan}``.

    Never a delete: the plan and its steps are kept and still answer by id. 409 while
    the plan is active (cancel it first); removing it twice is a no-op.
    """
    caller = _caller()
    _visible_plan(plan_id, caller)
    if plans_store.hide_plan(_agents_table(), plan_id, hidden_by=caller.subject, now=store.utc_now()) is None:
        raise ConflictError('This plan is still running; cancel it first')
    logger.info('Plan removed from the list', extra={'plan_id': plan_id})
    return _plan_response(plan_id)


def _reviewed_fingerprint() -> str:
    """``{fingerprint}``: the paused write the approver's card showed (64 lowercase hex), or 400."""
    fingerprint = json_object_body(app).get('fingerprint')
    if not isinstance(fingerprint, str) or FINGERPRINT_RE.fullmatch(fingerprint) is None:
        raise ValidationError('fingerprint is required: the fingerprint of the step you reviewed')
    return fingerprint


def _resolve(table: Any, plan_id: str, step_id: str, fingerprint: str | None, *, now: Any) -> dict | None:
    if fingerprint is None:
        return plans_store.decline_step(table, plan_id, step_id, now=now)
    try:
        return plans_store.approve_step(table, plan_id, step_id, fingerprint=fingerprint, now=now)
    except plans_store.StepChanged as changed:
        raise ConflictError(str(changed)) from changed


def _resolve_paused_step(plan_id: str, step_id: str, approve: bool) -> dict:
    """Approve or decline a ``needs_approval`` step — the approver only (an admin may watch, not decide).

    Approve REQUIRES ``{fingerprint}`` of the write the approver reviewed; a different paused write is 409.
    """
    caller = _caller()
    meta = _visible_plan(plan_id, caller)
    if caller.delegated or meta.get('approver_sub') != caller.subject:
        raise AuthorizationError('Only the person who approved this plan can resolve its steps')
    if meta.get('status') != plans_store.PLAN_RUNNING:
        raise ConflictError('This plan is not running')
    table, now = _agents_table(), store.utc_now()
    if step_id not in plans_store.plan_steps_by_id(meta):
        raise NotFoundError(STEP_NOT_FOUND)
    fingerprint = _reviewed_fingerprint() if approve else None
    if _resolve(table, plan_id, step_id, fingerprint, now=now) is None:
        raise ConflictError('This step is not waiting for your approval')
    verb = 'approved' if approve else 'declined'
    plans_store.append_event(table, plan_id, f'step_{verb}', f'Step {verb} by the approver', now=now, step_id=step_id)
    return _plan_response(plan_id)


@app.post('/agents/plans/<plan_id>/steps/<step_id>/approve')
@tracer.capture_method
def approve_plan_step(plan_id: str, step_id: str):
    return _resolve_paused_step(plan_id, step_id, approve=True)


@app.post('/agents/plans/<plan_id>/steps/<step_id>/decline')
@tracer.capture_method
def decline_plan_step(plan_id: str, step_id: str):
    return _resolve_paused_step(plan_id, step_id, approve=False)


# --------------------------------------------------------------------------
# Engineering runs (lambda/engineering/views.py): the board, the conversation, the reports. On only when the
# deployment turned the engineering agents on (shared.engineering_agents, with their table and bucket); otherwise 404.
# Administrators only, acting for themselves, until a repository connection can be shared (docs/autonomous-engineering.md,
# "Who can read and use"): anyone else, a delegated (MCP) credential included, gets 403. An administrator sees every
# category, so the run's feedback ids hide nothing from them.
# --------------------------------------------------------------------------

ENGINEERING_RUN_NOT_FOUND = agents_engineering_run_routes.RUN_NOT_FOUND
_VERSION = re.compile(r'[0-9]{1,4}\Z')


# The agents' skills and their scorecards (engineering/skills/views.py; docs/autonomous-engineering.md, "Getting
# better"): read only, by administrators acting for themselves (a delegated credential gets 403), 404 while the module
# is off. Registered before the run's routes, whose ``<run_id>`` would read ``skills`` and ``scorecards`` as a run id.
_SKILL_ERRORS = {'invalid': ValidationError, 'not_found': NotFoundError, 'forbidden': AuthorizationError,
                 'conflict': ConflictError}


def _skill_views() -> Any:
    """The skills' reads: 404 while the module is off, then 403 for anyone but an administrator."""
    _engineering_on()
    require_admin_caller(_caller())
    from engineering.skills.views import SkillViews
    from shared.aws import get_dynamodb_client

    return SkillViews(get_dynamodb_client(), os.environ['ENGINEERING_TABLE'])


def _skill_read(read: Any, failed: str = 'the skills could not be read: retry') -> Any:
    """``read()``, its refusals answered with their status and a failed call with 503 (``failed``: what it says)."""
    from engineering.learning.scorecard import ScorecardError
    from engineering.skills.model import SkillError

    try:
        return read()
    except SkillError as refused:
        raise _SKILL_ERRORS[refused.kind](str(refused)) from None
    except ScorecardError as refused:
        raise ValidationError(str(refused)) from None
    except (ClientError, BotoCoreError) as exc:
        logger.exception('engineering: a skills call failed')
        raise ServiceUnavailableError(failed) from exc


@app.get('/agents/engineering/skills')
@tracer.capture_method(capture_response=False)
def list_engineering_skills():
    """``?connection=<id>`` (empty or left out: the shared skills) → ``{connection, roles: [{role, current_version,
    versions, latest}]}``: each role with a version in the scope, its newest version's summary line."""
    views = _skill_views()
    return _skill_read(lambda: views.roles(_query('connection') or ''))


@app.get('/agents/engineering/skills/<role>/versions')
@tracer.capture_method(capture_response=False)
def list_engineering_skill_versions(role: str):
    """``?connection=&page=<token>`` → ``{connection, role, current_version, versions: [...], next_page}``: a page of
    the role's history, newest first, each version with its events and its benchmark (claimed and measured)."""
    views = _skill_views()
    connection = _query('connection') or ''
    if not connection and not _query('page'):
        _seed_from_template(role)
    return _skill_read(lambda: views.history(connection, role, _query('page') or ''))


def _seed_from_template(role: str) -> None:
    """At an administrator's Skills visit (7.50.00): the role's shared skill seeded from its bundled template while
    it has no history (``SkillActions.seed_template``), so the coach has a version to propose on. Best effort: the
    visit's read is answered whatever happens here (logged)."""
    from engineering.skills.model import SkillError
    try:
        seeded = _skill_actions().seed_template(role)
    except (SkillError, ClientError, BotoCoreError):
        logger.exception('engineering: the shared skill was not seeded from its template', extra={'role': role[:40]})
        return
    if seeded is not None:
        logger.info('engineering: a shared skill seeded from its template', extra=seeded)


@app.get('/agents/engineering/skills/<role>/versions/<version>')
@tracer.capture_method(capture_response=False)
def get_engineering_skill_version(role: str, version: str):
    """``?connection=`` → ``{connection, role, version: {..., record, diff, made_with}}``: one version, its whole
    record and its diff from its base; 404 when the scope has no such version."""
    views = _skill_views()
    return _skill_read(lambda: views.version(_query('connection') or '', role, version))


def _skill_actions() -> Any:
    """The skills' actions for the administrator calling: 404 while the module is off, then 403 for anyone but an
    administrator acting for themselves (a delegated credential included)."""
    _engineering_on()
    caller = _caller()
    require_admin_caller(caller)
    from engineering.knowledge.store import Actor
    from engineering.skills.actions import SkillActions
    from engineering.skills.store import SkillStore
    from shared.aws import get_dynamodb_client

    return SkillActions(SkillStore(get_dynamodb_client(), os.environ['ENGINEERING_TABLE']),
                        Actor(caller.subject, 'person', admin=True))


_SKILL_NOT_SAVED = 'the skill version could not be saved: read it again and retry'


@app.post('/agents/engineering/skills/<role>/versions')
@tracer.capture_method(capture_response=False)
def propose_engineering_skill_version(role: str):
    """``?connection=`` ``{base_version, instructions, examples, summary, reason?}`` → 201 ``{connection, role,
    version, event, announcement}`` (7.52.00): an administrator's own version of the role's skill, PROPOSED on the
    version the scope runs and never applied here (it is accepted as any other proposal); 409 when the scope runs
    another version than ``base_version`` now."""
    actions = _skill_actions()
    answer = _skill_read(lambda: actions.propose(_query('connection') or '', role, json_object_body(app)),
                         _SKILL_NOT_SAVED)
    logger.info('engineering: a skill version proposed by a person',
                extra={'role': role, 'version': answer['version'].get('version')})
    return _json(201, answer)


@app.post('/agents/engineering/skills/<role>/versions/<version>/accept')
@tracer.capture_method(capture_response=False)
def accept_engineering_skill_version(role: str, version: str):
    """``?connection=`` ``{expected_status, expected_current, reason?}`` → ``{connection, role, version, event,
    announcement}``: the proposed version becomes the scope's current one (the store's transaction: its base still
    current, and a coach's version only once its recorded benchmark passed with a gain on its expected case); 409
    when the version or the current one changed since the screen read them."""
    actions = _skill_actions()
    return _skill_read(lambda: actions.accept(_query('connection') or '', role, version, json_object_body(app)),
                       _SKILL_NOT_SAVED)


@app.post('/agents/engineering/skills/<role>/versions/<version>/reject')
@tracer.capture_method(capture_response=False)
def reject_engineering_skill_version(role: str, version: str):
    """``?connection=`` ``{expected_status, reason?}`` → the version, marked rejected (it stays), and its event."""
    actions = _skill_actions()
    return _skill_read(lambda: actions.reject(_query('connection') or '', role, version, json_object_body(app)),
                       _SKILL_NOT_SAVED)


@app.post('/agents/engineering/skills/<role>/versions/<version>/rollback')
@tracer.capture_method(capture_response=False)
def roll_back_engineering_skill(role: str, version: str):
    """``?connection=`` ``{expected_current, reason?}`` → the new version restoring ``version`` (an earlier accepted
    one of the same scope), current at once, its event and its announcement."""
    actions = _skill_actions()
    return _skill_read(lambda: actions.roll_back(_query('connection') or '', role, version, json_object_body(app)),
                       _SKILL_NOT_SAVED)


@app.post('/agents/engineering/skills/<role>/versions/<version>/benchmark')
@tracer.capture_method(capture_response=False)
def record_engineering_skill_benchmark(role: str, version: str):
    """``?connection=`` ``{expected_status, before, after, cases, passed, reasons, failure_case, reason?}`` → the
    version with its benchmark recorded, once (a coach's version names the case it expected to gain on)."""
    actions = _skill_actions()
    return _skill_read(lambda: actions.benchmark(_query('connection') or '', role, version, json_object_body(app)),
                       _SKILL_NOT_SAVED)


@app.get('/agents/engineering/skills/<role>/template')
@tracer.capture_method(capture_response=False)
def get_engineering_skill_template(role: str):
    """``?connection=`` → ``{connection, role, template: {version, label, newer}, current_version, record, diff}``
    (7.50.00, "Template updated"): the role's bundled template, its record and its diff from the version the scope
    runs; 404 for a role with no template."""
    views = _skill_views()
    return _skill_read(lambda: views.template(_query('connection') or '', role))


@app.post('/agents/engineering/skills/<role>/template/adopt')
@tracer.capture_method(capture_response=False)
def adopt_engineering_skill_template(role: str):
    """``?connection=`` ``{expected_current, template_version, reason?}`` → ``{connection, role, version, event,
    announcement}``: the role's bundled template as the scope's next version, PROPOSED by the administrator calling
    (provenance ``template``) and never applied by this route: an administrator accepts it as any other proposal.
    409 when the scope's current version or the template changed since the screen read them, or when no newer
    template is waiting."""
    actions = _skill_actions()
    return _skill_read(lambda: actions.adopt_template(_query('connection') or '', role, json_object_body(app)),
                       _SKILL_NOT_SAVED)


@app.get('/agents/engineering/scorecards/<role>')
@tracer.capture_method(capture_response=False)
def get_engineering_scorecards(role: str):
    """``?connection=<id>&versions=<n,n,…>`` → ``{connection, role, versions, cards}``: each version's scorecard over
    its latest runs on the connection (at most 10 versions; by default the shipped one and the newest few)."""
    views = _skill_views()
    return _skill_read(lambda: views.scorecards(_query('connection') or '', role, _query('versions')))


# The knowledge flows' routes (7.52.00, shared/agents_engineering_knowledge_routes.py), before the run's routes.
app.include_router(agents_engineering_knowledge_routes.app)


def _engineering_caller(op: str | None = None) -> Caller:
    """An administrator acting for themselves, or, for ``op``, the global MCP server's engineering tool of that one
    operation (7.53.00: never an admin, ``project_access.delegated_engineering_allowed``); 403 for anyone else."""
    caller = _caller()
    if op is not None and caller.delegated and not caller.agent_id and project_access.delegated_engineering_allowed(
            project_access.claims_from_event(app.current_event.raw_event), op):
        return caller
    require_admin_caller(caller)
    return caller


def _engineering_tables(run_id: str, op: str | None = None) -> tuple[str, str]:
    """The engineering table and bucket, for an administrator (or ``op``'s MCP tool; 403 for anyone else; 404 for a
    bad run id and while the module is off)."""
    table, bucket = os.environ.get('ENGINEERING_TABLE', ''), os.environ.get('ENGINEERING_WORKSPACE_BUCKET', '')
    if not (engineering_agents_on() and table and bucket):
        raise NotFoundError(ENGINEERING_RUN_NOT_FOUND)
    _engineering_caller(op)
    # Imported here: the package ships only in a deployment with the engineering agents on.
    from engineering.workspace.layout import ID

    if not ID.fullmatch(run_id):
        raise NotFoundError(ENGINEERING_RUN_NOT_FOUND)
    return table, bucket


def _engineering(run_id: str) -> Any:
    """The views, for an administrator."""
    table, bucket = _engineering_tables(run_id)
    from engineering.views import EngineeringViews
    from engineering.workspace.store import WorkspaceStore
    from shared.aws import get_dynamodb_client, get_s3_client

    # No ListBucket on its role (lib/stacks/api-assistant-lambdas.ts): a report never written reads as denied.
    return EngineeringViews(get_dynamodb_client(), table, WorkspaceStore(get_s3_client(), bucket, denied_is_missing=True))


def _monitor(run_id: str, op: str | None = None) -> Any:
    """The run monitor, for an administrator (as the views; or ``op``'s MCP tool): the agents from the supervisor's
    session rows (the run's partition of the engineering table, read only); its signals (7.51.02, ``signal_run``) and
    its Stop (7.50.03, ``stop_run``) need the start function (ENGINEERING_START_FUNCTION: this role invokes no other
    runtime function), its answers and steering the bus (ENGINEERING_BUS_NAME, where this role may put only those two
    types)."""
    table, bucket = _engineering_tables(run_id, op)
    from engineering.bus.publish import EventBridgePublisher
    from engineering.monitor import API_SOURCE, LambdaSignaller, LambdaStopper, RunMonitor
    from engineering.run_objects import RunObjects
    from engineering.runtime.runs import RunStore
    from engineering.runtime.sessions import SessionStore
    from shared.aws import get_dynamodb_client, get_dynamodb_resource, get_eventbridge_client, get_s3_client

    bus, start = os.environ.get('ENGINEERING_BUS_NAME', ''), os.environ.get(eng_runs.START_FUNCTION_ENV, '')
    engineering = get_dynamodb_resource().Table(table)
    # (7.51.00: the workspace bucket's run objects, for an ended run's manifest)
    return RunMonitor(get_dynamodb_client(), table, SessionStore(engineering, RunStore(engineering)),
                      signaller=LambdaSignaller(_start_client(), start) if start else None,
                      publisher=EventBridgePublisher(get_eventbridge_client(), bus, API_SOURCE) if bus else None,
                      stopper=LambdaStopper(_start_client(), start) if start else None,
                      objects=RunObjects(get_s3_client(), bucket))


_MONITOR_ERRORS = {'invalid': ValidationError, 'not_found': NotFoundError, 'conflict': ConflictError,
                   'unavailable': ServiceUnavailableError}


def _acting_monitor(run_id: str) -> tuple[Any, Caller]:
    """The monitor and its caller for an action, checked before the body is read: while the module is off every
    caller gets 404, then anyone but an administrator 403, then a bad or unknown run id 404."""
    monitor = _monitor(run_id)
    caller = _caller()
    require_admin_caller(caller)
    if not monitor.run_exists(run_id):
        raise NotFoundError(ENGINEERING_RUN_NOT_FOUND)
    return monitor, caller


def _monitor_action(monitor: Any, caller: Caller, act: Any) -> dict:
    """``act(monitor, body, actor)``, its refusal answered with its status (the route gated the caller)."""
    from engineering.monitor import Actor, MonitorError

    try:
        return act(monitor, json_object_body(app), Actor(caller.subject, caller.username or caller.subject))
    except MonitorError as refused:
        raise _MONITOR_ERRORS[refused.kind](str(refused)) from refused


def _found(value: Any) -> Any:
    if value is None:
        raise NotFoundError(ENGINEERING_RUN_NOT_FOUND)
    return value


@app.get('/agents/engineering/<run_id>/board')
@tracer.capture_method
def get_engineering_board(run_id: str):
    return _found(_engineering(run_id).board(run_id))


@app.get('/agents/engineering/<run_id>/conversation')
@tracer.capture_method
def get_engineering_conversation(run_id: str):
    views = _engineering(run_id)
    after = validate_int(_query('after'), default=0, min_val=0, max_val=99_999_998)
    limit = validate_int(_query('limit'), default=MAX_EVENTS_PAGE, min_val=1, max_val=MAX_EVENTS_PAGE)
    return _found(views.conversation(run_id, after=after, limit=limit))


@app.get('/agents/engineering/<run_id>/reports')
@tracer.capture_method
def list_engineering_reports(run_id: str):
    return _found(_engineering(run_id).reports(run_id))


@app.get('/agents/engineering/<run_id>/reports/<level>/<subject>')
@tracer.capture_method
def get_engineering_report(run_id: str, level: str, subject: str):
    views = _engineering(run_id)
    version = _query('version')
    if version is not None and not (_VERSION.fullmatch(version) and int(version) >= 1):
        raise ValidationError('version is a whole number from 1 to 9999 (leave it out for the latest)')
    wanted = None if version is None else int(version)
    report = _found(views.report(run_id, level, subject, wanted))
    return {'report': report.document, 'markdown': report.markdown}


@app.get('/agents/engineering/spend')
@tracer.capture_method
def get_engineering_spend():
    """``?month=YYYY-MM&by=workflow|repo|run|agent|model|day&workflow=`` → the month's spend, grouped
    (engineering/spend.py, the spend ledger): one Query of the month's ledger partition, never a whole-table read;
    administrators only, 404 while the module is off. ``month`` defaults to this one (UTC)."""
    table = os.environ.get('ENGINEERING_TABLE', '')
    if not (engineering_agents_on() and table):
        raise NotFoundError('The engineering agents are not on in this deployment')
    require_admin_caller(_caller())
    from engineering.spend import check_query, month_of, month_spend

    flow = _query('workflow') or ''
    if len(flow) > 500 or '#' in flow:   # (a run's flow is recorded up to 500 characters)
        raise ValidationError('workflow is a workflow id')
    month, by = _query('month') or month_of(datetime.now(UTC)), _query('by') or 'workflow'
    try:   # (the caller's month and grouping, checked before the read: only these are a 400)
        check_query(month, by)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    try:
        spend = month_spend(get_dynamodb_resource().Table(table), month, by, flow=flow)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('engineering: the spend ledger could not be read')
        raise ServiceUnavailableError('the spend could not be read: retry') from exc
    return spend.view()


def _engineering_on() -> None:
    """404 while the engineering agents are off (the caller is checked after)."""
    if not (engineering_agents_on() and os.environ.get('ENGINEERING_TABLE')):
        raise NotFoundError('The engineering agents are not on in this deployment')


@app.get('/agents/engineering/settings')
@tracer.capture_method
def get_engineering_settings():
    """The administrators' hard cap on engineering runs (engineering/settings.py, its one row in voc-agents):
    ``{hard_cap, updated_at, updated_by}``; administrators only, 404 while the module is off, 503 when the read
    fails."""
    _engineering_on()
    require_admin_caller(_caller())
    from engineering.settings import read_hard_cap
    try:
        return read_hard_cap(_agents_table()).view()
    except (ClientError, BotoCoreError) as exc:
        logger.exception('engineering: the hard cap could not be read')
        raise ServiceUnavailableError('the hard cap could not be read: retry') from exc


@app.put('/agents/engineering/settings')
@tracer.capture_method
def put_engineering_settings():
    """``{hard_cap: bool}``: an administrator (signed in, acting for themselves: a delegated credential gets 403) turns
    the hard cap on or off, saved with its history row (voc-agents, beside the workflows; the runtime reads it at a
    start). 503 when the write fails."""
    _engineering_on()
    caller = _caller()
    require_admin_caller(caller)
    body = json_object_body(app)
    hard_cap = body.get('hard_cap')
    if set(body) != {'hard_cap'} or not isinstance(hard_cap, bool):
        raise ValidationError('the body is {hard_cap: true | false}')
    from engineering.settings import save_hard_cap
    try:
        saved = save_hard_cap(_agents_table(), on=hard_cap, by=caller.username or caller.subject,
                              at=datetime.now(UTC))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('engineering: the hard cap could not be saved')
        raise ServiceUnavailableError('the hard cap could not be saved: retry') from exc
    return saved.view()


# Readiness (7.50.00, engineering/readiness.py; docs/autonomous-engineering.md, "Readiness"): whether an engineering
# agent or a flow template can run here, check by check, for an administrator acting for themselves (404 while the
# module is off). REST only, like every engineering route (an MCP credential never acts as an administrator). Enable
# runs the required checks too, and answers 409 with the failing ones.
NOT_READY = 'the agent is not ready to run: fix the failing checks first (GET /agents/engineering/readiness)'


@cache
def _service_quotas_client() -> Any:
    import boto3
    from botocore.config import Config

    return boto3.client('service-quotas', config=Config(connect_timeout=3, read_timeout=5,
                                                        retries={'total_max_attempts': 2}))


@cache
def _bedrock_control_client() -> Any:
    """Bedrock's control plane for the models' access (short waits: the reads share a 10-second budget)."""
    import boto3
    from botocore.config import Config

    return boto3.client('bedrock', config=Config(connect_timeout=2, read_timeout=3, retries={'total_max_attempts': 1}))


def _readiness_ports() -> Any:
    """The checks' ports on this role's clients (engineering/readiness_aws.py)."""
    from engineering.readiness_aws import WATERMARKS_TABLE_ENV, AwsReadinessPorts
    from shared.aws import get_dynamodb_client, get_s3_client

    resource, table = get_dynamodb_resource(), os.environ['ENGINEERING_TABLE']
    watermarks = os.environ.get(WATERMARKS_TABLE_ENV, '')
    return AwsReadinessPorts(
        agents=_agents_table(), aggregates=_aggregates_table(), engineering=resource.Table(table),
        engineering_client=get_dynamodb_client(), engineering_table=table, s3=get_s3_client(),
        workspace_bucket=os.environ.get('ENGINEERING_WORKSPACE_BUCKET', ''), quotas=_service_quotas_client,
        bedrock=_bedrock_control_client, inspect=_invoke_app_tokens,
        watermarks=resource.Table(watermarks) if watermarks else None, issues=_issues_follow(), ssm=_ssm_client)


@cache
def _ssm_client() -> Any:
    """SSM for readiness's ``kiro`` check (7.53.00: the Kiro key parameter's metadata only, never its value)."""
    import boto3
    from botocore.config import Config

    return boto3.client('ssm', config=Config(connect_timeout=2, read_timeout=3, retries={'total_max_attempts': 1}))


def _readiness_settings() -> Any:
    """The deployment's settings the checks read: its environment, and each role's card model (the templates)."""
    from engineering.readiness_aws import settings_from_environment
    from engineering.skills.templates import bundled

    return settings_from_environment(bundled().card_models(), os.environ.get('AWS_REGION', ''))


def _readiness(subject: Any, *, required_only: bool = False, ports: Any = None) -> Any:
    from engineering.readiness import REQUIRED, evaluate

    return evaluate(subject, ports or _readiness_ports(), _readiness_settings(), REQUIRED if required_only else None)


def _readiness_subject(caller: Caller, ports: Any) -> Any:
    """``?automation=<agent id>`` (an engineering agent) or ``?flow=<template id>`` (a default flow): exactly one of
    them, either with ``connection`` and ``language`` to ask about, optionally (7.50.01 for an agent: as if it were set
    up with them, read-only). The connection must be stored and not removed, the language one with an agent image
    (``readiness.preview``): 400 otherwise."""
    from engineering.readiness import PreviewRefused, ReadFailed, preview
    from engineering.readiness_aws import agent_subject, template_subject
    from engineering.runtime.egress import REGISTRY_HOSTS
    from engineering.workspace.layout import CONNECTION

    automation, flow = _query('automation'), _query('flow')
    if (automation is None) == (flow is None):
        raise ValidationError('name exactly one of automation=<agent id> or flow=<template id>')
    connection, language = _query('connection') or '', _query('language') or ''
    if connection and not CONNECTION.fullmatch(connection):
        raise ValidationError('connection is a connection id')
    if automation is not None:
        agent = _stored_agent(automation)
        if not store.is_engineering_agent(agent):
            raise ValidationError('automation names an engineering agent')
        subject = agent_subject(agent, _find_workflow(agent.get('workflow_id')), caller.subject, caller.username)
    else:
        template = next((item for item in engineering_templates.list_templates()
                         if item.get('template_id') == flow), None)
        if template is None:
            raise NotFoundError('no such flow template')
        subject = template_subject(template, caller.subject, caller.username)
    try:
        return preview(subject, ports, REGISTRY_HOSTS, connection=connection, language=language)
    except PreviewRefused as refused:
        raise ValidationError(str(refused)) from refused
    except ReadFailed as failed:
        raise ServiceUnavailableError('the connection could not be read: retry') from failed


@app.get('/agents/engineering/readiness')
@tracer.capture_method(capture_response=False)
def get_engineering_readiness():
    """``?automation=<agent id>|flow=<template id>[&connection=&language=]`` → ``{subject, ready, checks: [{id,
    status, detail, fix, docs, required}]}``: every check of engineering/readiness.py; ``ready`` when no required
    check fails. Administrators acting for themselves only (403 otherwise), 404 while the module is off."""
    _engineering_on()
    caller = _caller()
    require_admin_caller(caller)
    ports = _readiness_ports()
    return _readiness(_readiness_subject(caller, ports), ports=ports).view()


def _not_ready(agent: Mapping[str, Any], caller: Caller) -> Response | None:
    """Enable's gate (owner decision): 409 ``{error, checks}`` naming the required checks that fail, else None."""
    from engineering.readiness_aws import agent_subject

    report = _readiness(agent_subject(agent, _find_workflow(agent.get('workflow_id')), caller.subject,
                                      caller.username), required_only=True)
    if report.ready:
        return None
    return _json(409, {'error': NOT_READY, 'checks': [check.view() for check in report.failing]})


# --------------------------------------------------------------------------
# Run requests (7.53.00, "MCP for runs", D53-3; engineering/run_requests.py): a local assistant's request for a Run now
# of an enabled engineering automation, made with the global MCP server's engineering_run_request tool, waits until an
# administrator signed in confirms it (the Run now above, as that administrator) or declines it, because a run pushes
# code. Registered before /agents/engineering/<run_id>, which would read `requests` as a run id.
# --------------------------------------------------------------------------

_REQUEST_ERRORS = {'invalid': ValidationError, 'not_found': NotFoundError, 'conflict': ConflictError,
                   'cap': TooManyRequestsError}
REQUEST_FIELDS = frozenset({'agent_id', 'issue', 'prd', 'note'})
REQUEST_NOT_FOUND = 'Run request not found'
NOT_AN_AUTOMATION = 'No such enabled engineering automation'
#: What each kind of automation's Run now takes ('none': a bug hunt of the whole repository).
_TAKES: Final = {'bug': ['issue', 'none'], 'feature_request': ['issue', 'prd']}


def _run_requests(op: str | None = None) -> tuple[Any, Caller]:
    """The run requests and their caller: 404 while the module is off, then 403 for anyone but an administrator acting
    for themselves (or, for ``op``, the MCP tool engineering_run_request)."""
    table = os.environ.get('ENGINEERING_TABLE', '')
    if not (engineering_agents_on() and table):
        raise NotFoundError(REQUEST_NOT_FOUND)
    caller = _engineering_caller(op)
    from engineering.run_requests import RunRequests  # (the package ships only with the module)
    from shared.aws import get_dynamodb_client

    return RunRequests(get_dynamodb_client(), table, lambda: datetime.now(UTC)), caller


def _requested(act: Any) -> Any:
    """``act()``, a refusal answered with its status, a failed read or write 503."""
    from engineering.run_requests import RequestError

    try:
        return act()
    except RequestError as refused:
        raise _REQUEST_ERRORS[refused.kind](str(refused)) from refused
    except (ClientError, BotoCoreError) as exc:
        logger.exception('engineering: the run requests could not be read or written')
        raise ServiceUnavailableError('the run requests could not be reached: retry') from exc


def _automation(agent_id: object) -> dict:
    """An enabled, set-up engineering automation (404 for anything else: what a request may name)."""
    agent = store.get_agent(_agents_table(), str(agent_id)) if store.is_agent_id(agent_id) else None
    if (agent is None or agent.get('status') == store.AGENT_STATUS_ARCHIVED or not store.is_engineering_agent(agent)
            or not agent.get('enabled')):
        raise NotFoundError(NOT_AN_AUTOMATION)
    return agent


def _automation_view(table: Any, agent: Mapping[str, Any]) -> dict[str, Any]:
    settings = agent.get('engineering') or {}
    row = eng_runs.connection_row(table, settings['connection']) if settings.get('connection') else None
    kind = str(settings.get('feedback_type') or 'bug')
    return {'agent_id': agent['agent_id'], 'name': str(agent.get('name', '')), 'kind': kind,
            'repository': str((row or {}).get('repository', '')) or None, 'takes': _TAKES.get(kind, ['issue'])}


def _request_body(body: Mapping[str, Any]) -> tuple[dict, dict[str, Any], str]:
    """``{agent_id, issue? | prd?, note?}``: the automation, its Run now's body (checked as Run now checks it) and the
    note; 400 for anything off, 404 for an agent that is not an enabled automation."""
    if not set(body) <= REQUEST_FIELDS or 'agent_id' not in body or {'issue', 'prd'} <= set(body):
        raise ValidationError('the body is {agent_id, issue? | prd?, note?}')
    agent = _automation(body['agent_id'])
    note = body.get('note', '')
    if not isinstance(note, str):
        raise ValidationError('note is text')
    run_now = {name: body[name] for name in ('issue', 'prd') if name in body}
    issue, prd = _start_issue(run_now), _run_prd(run_now)
    _engineering_sentence(agent.get('engineering') or {}, '', issue, prd, _issue_stage(agent))   # (its own 400s)
    return agent, {**({'issue': issue} if issue is not None else {}), **({'prd': prd} if prd else {})}, note.strip()


@app.get('/agents/engineering/requests')
@tracer.capture_method
def list_engineering_run_requests():
    """The run requests, newest first (``{requests}``: the pending ones, those decided and those expired): an
    administrator acting for themselves."""
    requests, _ = _run_requests()
    return {'requests': _requested(requests.listed)}


@app.get('/agents/engineering/requests/automations')
@tracer.capture_method
def list_engineering_requestable_automations():
    """``{automations: [{agent_id, name, kind, repository, takes}]}``: the enabled engineering automations a run request
    may name (the MCP tool engineering_run_request without an agent, or an administrator)."""
    _run_requests('run_request')
    table = _agents_table()
    agents = [agent for agent in store.list_agents(table)
              if store.is_engineering_agent(agent) and agent.get('enabled')
              and agent.get('status') != store.AGENT_STATUS_ARCHIVED]
    agents.sort(key=agent_seed.list_order)
    return {'automations': [_automation_view(table, agent) for agent in agents]}


@app.post('/agents/engineering/requests')
@tracer.capture_method
def request_engineering_run():
    """``{agent_id, issue? | prd?, note?}`` → 202 ``{request}``: the MCP tool engineering_run_request asks for a Run now
    of an enabled automation, which waits until an administrator confirms it. Only that tool's (an administrator signed
    in uses Run now itself: 400); 409 for the same Run now already waiting, 429 past a cap, 404 for an agent that is not
    an enabled automation."""
    requests, caller = _run_requests('run_request')
    via = project_access.mcp_via(caller, project_access.claims_from_event(app.current_event.raw_event))
    if via is None:
        raise ValidationError('a run request is how a local assistant asks for a Run now: start it with Run now')
    agent, run_now, note = _request_body(json_object_body(app))
    from engineering.run_requests import NewRequest

    made = _requested(lambda: requests.create(NewRequest(
        request_id=eng_runs.new_run_id(), agent_id=agent['agent_id'], agent_name=str(agent.get('name', '')), via=via,
        requested_for=caller.subject, issue=run_now.get('issue'), prd=run_now.get('prd'), note=note)))
    logger.info('engineering: a Run now was asked over MCP', extra={
        'request_id': made['request_id'], 'agent_id': agent['agent_id'], 'via': via, 'for': caller.subject})
    return _json(202, {'request': made})


@app.post('/agents/engineering/requests/<request_id>/decline')
@tracer.capture_method
def decline_engineering_run_request(request_id: str):
    """``{}`` → ``{request}``: an administrator acting for themselves declines a waiting request (409 once decided or
    expired)."""
    requests, caller = _run_requests()
    if not LONG_OPAQUE_ID_RE.fullmatch(request_id):
        raise NotFoundError(REQUEST_NOT_FOUND)
    declined = _requested(lambda: requests.decide(request_id, 'decline', caller.subject))
    logger.info('engineering: a run request declined', extra={'request_id': request_id, 'by': caller.subject})
    return {'request': declined}


@app.post('/agents/engineering/requests/<request_id>/confirm')
@tracer.capture_method
def confirm_engineering_run_request(request_id: str):
    """``{}`` → 202 ``{request, run}``: an administrator acting for themselves confirms a waiting request, which runs the
    automation's Run now as them (the same checks, answers and 409s as ``POST /agents/<agent_id>/run``). The request is
    decided first, so it starts at most one run; what came of it is recorded on it (``outcome``)."""
    requests, caller = _run_requests()
    if not LONG_OPAQUE_ID_RE.fullmatch(request_id):
        raise NotFoundError(REQUEST_NOT_FOUND)
    wanted = _requested(lambda: requests.get(request_id))
    if wanted is None:
        raise NotFoundError(REQUEST_NOT_FOUND)
    agent = _automation(wanted['agent_id'])   # (still an enabled automation: else 404, and the request stays)
    decided = _requested(lambda: requests.decide(request_id, 'confirm', caller.subject))
    body = {**({'issue': decided['issue']} if decided['issue'] is not None else {}),
            **({'prd': decided['prd']} if decided['prd'] else {})}
    try:
        answer = _run_engineering_agent(_agents_table(), agent, caller, body)
    except ApiError as refused:
        said = f'refused: {refused}'
        _requested(lambda: requests.record(request_id, said))
        raise
    started = json.loads(answer.body) if isinstance(answer.body, str) else {}
    run = started.get('run') if isinstance(started.get('run'), dict) else {}
    outcome = 'started' if answer.status_code == 202 else 'uncertain'
    _requested(lambda: requests.record(request_id, outcome, run_id=str(run.get('run_id') or ''),
                                       engineering_run_id=str(run.get('engineering_run_id') or started.get('run_id')
                                                              or '')))
    logger.info('engineering: a run request confirmed', extra={'request_id': request_id, 'by': caller.subject,
                                                               'via': wanted['via'], 'outcome': outcome})
    if answer.status_code != 202:
        return answer
    return _json(202, {'request': {**decided, 'outcome': outcome, 'run_id': run.get('run_id'),
                                   'engineering_run_id': run.get('engineering_run_id')}, 'run': run})


# The setup guide's progress (7.50.00, GET/PUT /agents/engineering/setup: shared/agents_engineering_setup_routes.py).
app.include_router(agents_engineering_setup_routes.app)
# The run workspace (7.51.00: the runs list, an agent's thread and tabs, the assertions, steering, a child run's restart;
# shared/agents_engineering_run_routes.py), before /agents/engineering/<run_id>.
app.include_router(agents_engineering_run_routes.app)
# The Registry, gates, assertions, a flow's expansion, pause/resume (7.52.00: shared/agents_engineering_registry_routes.py).
app.include_router(agents_engineering_registry_routes.app)
# The scheduled cross-run Learn pass's weekly record (7.53.00, GET /agents/engineering/learn:
# shared/agents_engineering_learn_routes.py), before /agents/engineering/<run_id>.
app.include_router(agents_engineering_learn_routes.app)


# The repository connections (engineering/connectors/connections.py; docs/autonomous-engineering.md, "Repository
# connectors"): administrators acting for themselves (a delegated credential gets 403), 404 while the module is off.
# A connection is a row in voc-agents and its GitHub App credential an SSM SecureString under the name the broker
# reads; this role writes and deletes that parameter and never reads it, and no answer or log line carries the secret.
_CONNECTION_ERRORS = {'invalid': ValidationError, 'not_found': NotFoundError, 'conflict': ConflictError,
                      'unavailable': ServiceUnavailableError}


def _connection_store() -> tuple[Any, Caller]:
    """The connections' store and its caller: 404 while the module is off, then 403 for anyone but an administrator."""
    _engineering_on()
    caller = _caller()
    require_admin_caller(caller)
    from engineering.connectors.connections import (
        PARAMETER_KEY_ENV,
        PARAMETER_PREFIX_ENV,
        ConnectionStore,
        live_runs_of,
    )
    from engineering.runtime.runs import RunStore

    runs = RunStore(get_dynamodb_resource().Table(os.environ['ENGINEERING_TABLE']))
    return ConnectionStore(_agents_table(), _ssm_client, os.environ.get(PARAMETER_PREFIX_ENV, ''),
                           os.environ.get(PARAMETER_KEY_ENV, ''), live_runs_of(runs)), caller


@cache
def _ssm_client() -> Any:
    import boto3

    return boto3.client('ssm')


def _connection_actor(caller: Caller) -> Any:
    from engineering.connectors.connections import Actor

    return Actor(subject=caller.subject, name=caller.username or caller.subject)


def _connection_call(act: Any) -> Any:
    from engineering.connectors.connections import ConnectionRefused

    try:
        return act()
    except ConnectionRefused as refused:
        raise _CONNECTION_ERRORS[refused.kind](str(refused)) from None


@app.get('/agents/engineering/connections')
@tracer.capture_method(capture_response=False)
def list_engineering_connections():
    """``{connections: [...], limit}``: the stored connections, each with whether its credential is set (never the
    credential), one Query of their partition."""
    connections, _ = _connection_store()
    from engineering.connectors.connections import MAX_CONNECTIONS

    return {'connections': _connection_call(connections.list), 'limit': MAX_CONNECTIONS}


@app.put('/agents/engineering/connections/<connection_id>')
@tracer.capture_method(capture_response=False)
def put_engineering_connection(connection_id: str):
    """``{host: github, repository: owner/name, default_branch, credential?: {app_id, installation_id, private_key},
    reason?}`` → ``{connection, created}``: stores the connection (its credential in SSM first, the row with its
    create-only audit row after, the reason on it). The credential is needed to add one and to change its repository; 409 for a repository change
    while a run of the connection is live, past the connection limit, or a change made meanwhile."""
    connections, caller = _connection_store()
    from engineering.connectors.connections import check_connection_id, parse_request

    def save() -> tuple[dict, bool]:
        check_connection_id(connection_id)
        return connections.save(connection_id, parse_request(json_object_body(app)), _connection_actor(caller))

    connection, created = _connection_call(save)
    return {'connection': connection, 'created': created}


@app.delete('/agents/engineering/connections/<connection_id>')
@tracer.capture_method(capture_response=False)
def delete_engineering_connection(connection_id: str):
    """``{reason?}`` (the body optional) → ``{removed: true}``: removes the connection's credential (its runs' broker
    calls are refused once a warm broker's five-minute copy goes) and marks its row removed, with its audit row (the
    reason on it). 404 for a connection that is not stored. Then its repository leaves the GitHub Issues source when
    the connection's automation added it (7.50.02, best effort: issues_sync.py ``connection_removed``)."""
    connections, caller = _connection_store()
    from engineering.connectors.connections import parse_reason

    def remove() -> dict | None:
        body = json_object_body(app)
        if not set(body) <= {'reason'}:
            raise ValidationError('the body is {reason?}, or none')
        stored = next((c for c in connections.list() if c['connection_id'] == connection_id), None)
        connections.remove(connection_id, _connection_actor(caller), parse_reason(body.get('reason')))
        return stored

    removed = _connection_call(remove)
    if removed is not None:
        _issues_follow().connection_removed(removed, _connection_actor(caller))
    return {'removed': True}


# The deployment's GitHub Issues source, configured from the connections (7.50.02, engineering/connectors/issues_sync.py;
# docs/github-issues.md): the connections' gate (404 while the module is off, then administrators acting for
# themselves). Deployment-wide like the connections: the source is the deployment's (D8), never a workspace's.
@app.get('/agents/engineering/issues-source')
@tracer.capture_method(capture_response=False)
def get_engineering_issues_source():
    """``{deployed, signs_in, app_id, repositories, managed, schedule, label, connections: [{connection_id, repository,
    read, reading, reason, label}]}``: whether the deployment's GitHub Issues source reads each connection's
    repository, and why not (never a token or a secret)."""
    connections, _ = _connection_store()
    return _connection_call(lambda: _issues_follow().view(connections.list()))


@app.put('/agents/engineering/connections/<connection_id>/issues')
@tracer.capture_method(capture_response=False)
def put_engineering_connection_issues(connection_id: str):
    """``{read: boolean}`` → the issues source's view (as ``GET …/issues-source``): the connection's "Read this
    repository's issues" switch, its repository added to the source or taken out (only when its automation added it),
    with an audit row. 404 for a connection that is not stored; 409 for a connection not made through the deployment's
    GitHub App turned on, or where the source is not deployed."""
    connections, caller = _connection_store()
    from engineering.connectors.connections import check_connection_id

    def switch() -> dict:
        check_connection_id(connection_id)
        body = json_object_body(app)
        if set(body) != {'read'} or not isinstance(body['read'], bool):
            raise ValidationError('the body is {read: true or false}')
        stored = connections.list()
        connection = next((c for c in stored if c['connection_id'] == connection_id), None)
        if connection is None:
            raise NotFoundError('Connection not found')
        follow = _issues_follow()
        follow.set_read(connection, body['read'], _connection_actor(caller))
        return follow.view(stored)

    return _connection_call(switch)


# A connection's CI attestation (engineering/connectors/attestations.py; docs/autonomous-engineering.md, "The target's
# CI"): an administrator acting for themselves confirms every point of the setup guide for the connection's repository,
# or withdraws the confirmation. Each is a create-only version row with the connection's own audit row; the broker
# refuses every push and pull request on the connection while none holds.
@app.post('/agents/engineering/connections/<connection_id>/ci-attestation')
@tracer.capture_method(capture_response=False)
def attest_engineering_connection_ci(connection_id: str):
    """``{points: [...every point of the setup guide], repository, version, reason?}`` → ``{attestation, created,
    connection_version}``: records the administrator's attestation that the repository's CI meets the guide, for the
    repository and the connection version they reviewed (an attestation that already holds is answered as it stands,
    ``created: false``). 404 for a connection that is not stored; 409 when the connection no longer holds that
    repository at that version (another administrator changed it meanwhile: the check is in the write's own
    condition too)."""
    connections, caller = _connection_store()
    from engineering.connectors.connections import check_connection_id, parse_attestation

    def attest() -> tuple[dict, bool, int]:
        check_connection_id(connection_id)
        request = parse_attestation(json_object_body(app))
        attestation, created = connections.attest(connection_id, request, _connection_actor(caller))
        # (a recorded attestation bumps the connection's version once, in its transaction)
        return attestation, created, request.version + 1 if created else request.version

    attestation, created, version = _connection_call(attest)
    return {'attestation': attestation, 'created': created, 'connection_version': version}


@app.delete('/agents/engineering/connections/<connection_id>/ci-attestation')
@tracer.capture_method(capture_response=False)
def withdraw_engineering_connection_ci(connection_id: str):
    """``{reason?}`` (the body optional) → ``{withdrawn: true}``: withdraws the connection's CI attestation (a new
    version, with its audit row), so the broker refuses every push and pull request on it from the next one. 404 when
    none holds."""
    connections, caller = _connection_store()
    from engineering.connectors.connections import check_connection_id, parse_reason

    def withdraw() -> None:
        check_connection_id(connection_id)
        body = json_object_body(app)
        if not set(body) <= {'reason'}:
            raise ValidationError('the body is {reason?}, or none')
        connections.withdraw(connection_id, _connection_actor(caller), parse_reason(body.get('reason')))

    _connection_call(withdraw)
    return {'withdrawn': True}


# The deployment's GitHub Apps (7.45.00, engineering/connectors/github_apps.py; docs/autonomous-engineering.md, "A GitHub
# App in two clicks"): the same gate as the connections (404 while the module is off, then administrators acting for
# themselves), every route behind Cognito (/agents/{proxy+}). The App's key and webhook secret go from GitHub's answer
# straight to SSM; this role never reads them back, and no answer, log line or error carries them, nor a token: the
# token function (voc-engineering-app-tokens, invoked by name) reads an installation for it and answers no token here.
#: The token function's errors (its exception types) and the answer each is: its words for a refusal a person can act
#: on, a plain "try again" for the rest.
_APP_TOKENS_REFUSALS = {'InstallationRefused': 'conflict', 'AppKeyUnavailable': 'conflict', 'HostBusy': 'unavailable',
                        'HostError': 'unavailable'}


#: The GitHub Issues settings function's errors (7.50.02, engineering/connectors/issues_config.py): a request off its
#: shape is this API's 400, settings too large a 409, a failed read or write "try again".
_ISSUES_CONFIG_REFUSALS = {'IssuesConfigRefused': 'invalid', 'IssuesSettingsFull': 'conflict',
                           'IssuesSettingsUnavailable': 'unavailable'}


def _issues_follow() -> Any:
    """The GitHub Issues source's follow of the connections (engineering/connectors/issues_sync.py) over the settings
    function this environment names (none: not deployed here, the follow answers so)."""
    from engineering.connectors.issues_sync import IssuesFollow
    from shared.engineering_agents import ISSUES_CONFIG_FUNCTION_ENV

    config = _invoke_issues_config if os.environ.get(ISSUES_CONFIG_FUNCTION_ENV) else None
    return IssuesFollow(config, _agents_table(), _invoke_app_tokens)


def _github_apps() -> tuple[Any, Caller]:
    """The Apps' store and its caller (``_connection_store``'s gate)."""
    connections, caller = _connection_store()
    from engineering.connectors.connections import PARAMETER_KEY_ENV, PARAMETER_PREFIX_ENV
    from engineering.connectors.github_apps import FRONTEND_URL_ENV, WEBHOOK_URL_ENV, GitHubApps

    return GitHubApps(_agents_table(), _ssm_client, os.environ.get(PARAMETER_PREFIX_ENV, ''),
                      os.environ.get(PARAMETER_KEY_ENV, ''), connections, _invoke_app_tokens,
                      frontend_url=os.environ.get(FRONTEND_URL_ENV, ''),
                      webhook_url=os.environ.get(WEBHOOK_URL_ENV, ''), issues=_issues_follow()), caller


def _invoke_peer(env: str, refusals: Mapping[str, str], request: dict[str, Any], *, what: str, unnamed: str,
                 unreadable: str, refused: str) -> dict[str, Any]:
    """``request``'s answer from the function ``env`` names, by a direct invoke, or a ``ConnectionRefused``: its
    errors in ``refusals`` in its words (``invalid`` 400, ``conflict`` 409, ``unavailable`` 503), anything else
    ``unreadable`` (503); ``unnamed`` (503) where no function is named."""
    from engineering.connectors.connections import ConnectionRefused

    function = os.environ.get(env, '')
    if not function:
        raise ConnectionRefused('unavailable', unnamed)
    failed = ConnectionRefused('unavailable', unreadable)
    try:
        response = _start_client().invoke(FunctionName=function, InvocationType='RequestResponse',
                                          Payload=json.dumps(request).encode())
        payload = json.loads(response['Payload'].read() or b'{}')
    except (BotoCoreError, ClientError, ValueError, KeyError, OSError) as exc:
        logger.warning(f'engineering: the {what} function did not answer', extra={'error_type': type(exc).__name__})
        raise failed from None
    if not isinstance(payload, dict):
        raise failed
    if response.get('FunctionError'):
        error_type = payload.get('errorType')
        logger.warning(f'engineering: the {what} function refused', extra={'error_type': str(error_type)[:60]})
        kind = refusals.get(str(error_type))
        if kind is None:
            raise failed
        raise ConnectionRefused(kind, str(payload.get('errorMessage') or refused)[:300])
    return payload


def _invoke_app_tokens(request: dict[str, Any]) -> dict[str, Any]:
    """The token function's answer to ``request`` (``inspect_installation`` or ``ensure_label``, from here): its
    refusals in its words (409), anything else "try again" (503). Both are safe to ask again: a read, and a label
    created only when it is missing."""
    from shared.engineering_agents import APP_TOKENS_FUNCTION_ENV

    return _invoke_peer(APP_TOKENS_FUNCTION_ENV, _APP_TOKENS_REFUSALS, request, what='app tokens',
                        unnamed='GitHub Apps cannot be read here: the deployment names no token function',
                        unreadable='GitHub could not be read for the App: try again',
                        refused='GitHub refused the App: try again')


def _invoke_issues_config(request: dict[str, Any]) -> dict[str, Any]:
    """The GitHub Issues settings function's answer to ``request`` (``follow``, ``unfollow`` or ``status``,
    voc-engineering-issues-config: the one function that reads and writes the source's settings; this role holds no
    grant on the secret or the schedule): ``{repos, repos_managed, github_app_id, sign_in, token_set,
    schedule_enabled}``, never a secret. Each is safe to ask again: a follow adds a repository once."""
    from shared.engineering_agents import ISSUES_CONFIG_FUNCTION_ENV

    return _invoke_peer(ISSUES_CONFIG_FUNCTION_ENV, _ISSUES_CONFIG_REFUSALS, request, what='issues config',
                        unnamed='the GitHub Issues source cannot be configured here: the deployment names no function',
                        unreadable='the GitHub Issues source could not be read: try again',
                        refused='the GitHub Issues source refused the change: try again')


def _empty_body() -> None:
    if json_object_body(app):
        raise ValidationError('the body is {}, or none')


@app.get('/agents/engineering/github-apps')
@tracer.capture_method(capture_response=False)
def list_engineering_github_apps():
    """``{apps: [{app_id, slug, owner, owner_type, html_url, webhook, connections, created_at, created_by, version}],
    limit}``: the deployment's GitHub Apps, each with the connections that use it (never a key or a secret)."""
    apps, _ = _github_apps()
    from engineering.connectors.github_apps import MAX_APPS

    return {'apps': _connection_call(apps.list), 'limit': MAX_APPS}


@app.post('/agents/engineering/github-apps/manifest')
@tracer.capture_method(capture_response=False)
def engineering_github_app_manifest():
    """``{account: user | organization, org?, workspace?}`` → ``{action_url, manifest, expires_at}``: the form's target
    on github.com (with a single-use state, 30 minutes) and the App's manifest, which the browser posts there; its
    return comes back into ``workspace`` (a slug) when the flow started in one. 409 at the Apps' limit."""
    apps, caller = _github_apps()
    return _connection_call(lambda: apps.manifest(json_object_body(app), _connection_actor(caller)))


@app.post('/agents/engineering/github-apps/conversions')
@tracer.capture_method(capture_response=False)
def convert_engineering_github_app():
    """``{code, state}`` (as GitHub handed them back) → 201 ``{app, install_url, expires_at}``: the code exchanged at
    once, the App's key and webhook secret stored in SSM, the App recorded, and its install link (a new state). 400 for
    a state not this step's; 409 when GitHub no longer takes the code (the App may exist there without its key)."""
    apps, caller = _github_apps()
    return _json(201, _connection_call(lambda: apps.convert(json_object_body(app), _connection_actor(caller))))


@app.post('/agents/engineering/github-apps/installations')
@tracer.capture_method(capture_response=False)
def engineering_github_app_installed():
    """``{installation_id, setup_action, state}`` → ``{app, account, connections: [{connection, created}], skipped:
    [{repository, reason}]}``: a connection saved for every repository the installation lists, up to the connections'
    limit. 409 for an installation of another App, or a suspended one."""
    apps, caller = _github_apps()
    return _connection_call(lambda: apps.installed(json_object_body(app), _connection_actor(caller)))


@app.post('/agents/engineering/github-apps/<app_id>/install')
@tracer.capture_method(capture_response=False)
def engineering_github_app_install(app_id: str):
    """``{}`` → ``{install_url, expires_at}``: the App's install link again (a new state)."""
    apps, caller = _github_apps()

    def install() -> dict:
        _empty_body()
        return apps.install(app_id, _connection_actor(caller))

    return _connection_call(install)


@app.post('/agents/engineering/github-apps/<app_id>/check')
@tracer.capture_method(capture_response=False)
def check_engineering_github_app(app_id: str):
    """``{}`` → ``{repositories, missing}``: what the App's installations cover now, and its connections whose
    repository they no longer do. The slug the installation reports is recorded when the App was renamed on GitHub."""
    apps, caller = _github_apps()

    def check() -> dict:
        _empty_body()
        return apps.check(app_id, _connection_actor(caller))

    return _connection_call(check)


@app.delete('/agents/engineering/github-apps/<app_id>')
@tracer.capture_method(capture_response=False)
def delete_engineering_github_app(app_id: str):
    """``{reason?}`` (the body optional) → ``{removed: true}``: its key and webhook secret removed, its row marked
    removed with its audit row. 409 while a connection uses it. Deleting it on GitHub stays the administrator's."""
    apps, caller = _github_apps()

    def remove() -> None:
        body = json_object_body(app)
        if not set(body) <= {'reason'}:
            raise ValidationError('the body is {reason?}, or none')
        apps.remove(app_id, _connection_actor(caller), body.get('reason'))

    _connection_call(remove)
    return {'removed': True}


# A run's start (``POST /agents/engineering/runs``): an administrator acting for themselves starts a saved engineering
# flow on a repository's commit. The API mints the run's id and invokes the start function (voc-engineering-start, the
# runtime's code: it runs ``start_run`` and refuses every other action; this role may invoke it and never the runtime
# itself), with the flow's budget from the stored workflow, never from the request, and the person as its actor.
#: The run's longest goal: the shared request builder's (shared/engineering_agent_runs.py, with the run's caps and the
#: start's wait, which an engineering agent's runs use too).
MAX_RUN_GOAL = eng_runs.MAX_RUN_GOAL
_START_FIELDS = frozenset({'workflow_id', 'connection', 'commit', 'language', 'goal'})
#: The start's optional fields: the issue the run starts from (a number, ``_start_issue``).
_START_OPTIONAL = frozenset({'issue'})
_RUN_COMMIT = re.compile(r'[0-9a-f]{40}\Z')


def _run_connection(connection: str, issue: int | None = None) -> dict[str, Any]:
    """The run's ``repo`` and ``default_branch`` (and, with an ``issue``, it and the connection's ``host``): the stored
    connection's (``eng_runs.run_connection``); 400 for a connection that is not stored: its broker would refuse every
    operation."""
    return eng_runs.run_connection(eng_runs.connection_row(_agents_table(), connection), issue)


def _start_issue(body: Mapping[str, Any]) -> int | None:
    """The optional ``issue`` the run starts from: a whole number from 1 to ``run_links.MAX_NUMBER`` (400 otherwise),
    None when left out. Recorded as given (the API holds no credential to read the host with: run_links.py)."""
    from engineering.run_links import MAX_NUMBER, valid_number

    issue = body.get('issue')
    if issue is not None and not valid_number(issue):
        raise ValidationError('issue is the number of an issue of the repository: a whole number from 1 to '
                              f'{MAX_NUMBER}')
    return issue if isinstance(issue, int) else None


def _start_body(body: Mapping[str, Any]) -> dict[str, str]:
    """The request's fields, each checked (400 for anything off): a workflow id, a connection's short id, a commit of
    40 hexadecimal characters (lower-cased), a language with an agent image, and a goal on one line, at most
    ``MAX_RUN_GOAL`` characters, credential-shaped text redacted (the optional ``issue``: ``_start_issue``)."""
    from engineering.quality_gate.text import redact
    from engineering.runtime.egress import REGISTRY_HOSTS
    from engineering.runtime.interface import RuntimeRefused, check_id

    strings = all(isinstance(body.get(name), str) for name in _START_FIELDS)
    if not set(body) <= _START_FIELDS | _START_OPTIONAL or not strings:
        raise ValidationError('the body is {workflow_id, connection, commit, language, goal}, each a string, and '
                              'an optional issue number')
    fields = {name: str(body[name]).strip() for name in _START_FIELDS}
    try:
        check_id('connection', fields['connection'])
    except RuntimeRefused as refused:
        raise ValidationError(f'{refused} (a connection id)') from refused
    commit = fields['commit'].lower()
    if not _RUN_COMMIT.fullmatch(commit):
        raise ValidationError('commit is a full commit id: 40 hexadecimal characters')
    if fields['language'] not in REGISTRY_HOSTS:
        raise ValidationError(f'language is one of {", ".join(sorted(REGISTRY_HOSTS))}')
    goal = ' '.join(fields['goal'].split())
    if not goal or len(goal) > MAX_RUN_GOAL:
        raise ValidationError(f'goal says what the run is for, in 1 to {MAX_RUN_GOAL} characters')
    return {**fields, 'commit': commit, 'goal': redact(goal)}


def _stored_flow(workflow_id: str) -> eng_runs.StoredFlow:
    """The stored engineering flow (its budget, definition and revision: ``eng_runs.stored_flow``), its calls expanded
    (7.52.00, shared/flow_expand.py): 400 for an id that names no saved workflow or an agents workflow, 409 for a
    stored budget off its rule or a call that cannot be expanded."""
    return eng_runs.stored_flow(_find_workflow(workflow_id), eng_runs.revision_reader(_agents_table()))


@cache
def _start_client() -> Any:
    """The Lambda client for the start (built once per container): it waits ``START_READ_TIMEOUT_SECONDS`` and never
    retries by itself."""
    import boto3
    from botocore.config import Config

    return boto3.client('lambda', config=Config(read_timeout=eng_runs.START_READ_TIMEOUT_SECONDS, connect_timeout=5,
                                                retries={'total_max_attempts': 1}))


class _MayHaveStarted(ServiceUnavailableError):
    """503 naming a run that was written, or may have been (nobody can tell): open its monitor, never start another.
    Answered with the run's id beside the message (``run_id``), and the message names it too."""

    def __init__(self, run_id: str, message: str = '') -> None:
        super().__init__(message or f'run {run_id} may have been started: open the run monitor before you start '
                                    'another')
        self.run_id = run_id


def _start_failure(answer: eng_runs.StartAnswer) -> Exception:
    """A start that wrote nothing, as its answer: the runtime's refusal (all before the write) 409 in its words, the
    runtime out of reach or a start known not written 503 "start it again"."""
    if answer.outcome == 'refused':
        return ConflictError(answer.message or 'the runtime refused the start')
    if answer.outcome == 'not_written':
        return ServiceUnavailableError(answer.message or 'the run could not be started: start it again')
    return ServiceUnavailableError('the engineering runtime could not be reached: start the run again')


def _invoke_start(function: str, request: dict[str, Any]) -> dict[str, Any]:
    """The start function's answer (``{run_id, status}``, ``eng_runs.invoke_start``). A start that wrote nothing is
    ``_start_failure``; anything else (written, or not known not to be: a dropped connection, a timeout, a failure of
    an unknown kind) is a 503 naming the run, ``_MayHaveStarted``."""
    answer = eng_runs.invoke_start(_start_client(), function, request)
    if answer.outcome == 'started' and answer.payload is not None:
        return dict(answer.payload)
    if answer.outcome == 'uncertain':
        raise _MayHaveStarted(request['run_id'], answer.message)
    raise _start_failure(answer)


@app.post('/agents/engineering/runs')
@tracer.capture_method
def start_engineering_run():
    """``{workflow_id, connection, commit, language, goal, issue?}`` → 202 ``{run: {run_id, status, workflow_id,
    started_by}}`` (``issue``, 7.09.00: the number of the issue the run starts from, recorded as given):
    an administrator acting for themselves (a delegated credential gets 403) starts a saved engineering flow (404 while
    the module is off). The run's id is minted here; its flow's budget is the stored workflow's, its caps the
    deployment's; the runtime records who started it and when (META's ``started_by``, its ``RUNLOG#`` row: D4). 202:
    the run is written when this answers, and its coordinator's launch is under way (the start function hands it on)."""
    _engineering_on()
    caller = _caller()
    require_admin_caller(caller)
    function = os.environ.get(eng_runs.START_FUNCTION_ENV, '')
    if not function:
        raise ServiceUnavailableError('runs cannot be started from here: the deployment names no start function')
    raw = json_object_body(app)
    fields, issue = _start_body(raw), _start_issue(raw)
    flow = _stored_flow(fields['workflow_id'])
    request: dict[str, Any] = {
        'action': 'start_run', 'run_id': eng_runs.new_run_id(), 'flow': fields['workflow_id'],
        # The flow as stored now: the run copies it and follows its copy (a later edit is the next run's).
        'flow_definition': flow.definition, 'flow_revision': flow.revision,
        'connection': fields['connection'], 'commit': fields['commit'], 'language': fields['language'],
        # (with an issue, it and the stored connection's host: the start records it with its address)
        'goal': fields['goal'], 'actor': caller.subject, **_run_connection(fields['connection'], issue),
        **eng_runs.run_caps(),
    }
    if flow.budget_usd is not None:
        request['budget_usd'] = flow.budget_usd
    try:
        answer = _invoke_start(function, request)
    except _MayHaveStarted as unsure:
        # (the run's id beside the message: the web app offers its monitor, and no second start)
        return _json(503, {'error': unsure.message, 'run_id': unsure.run_id})
    logger.info('Engineering run started', extra={'run_id': request['run_id'], 'workflow_id': fields['workflow_id'],
                                                  'started_by': caller.subject})
    return _json(202, {'run': {'run_id': request['run_id'], 'status': str(answer.get('status', 'active')),
                               'workflow_id': fields['workflow_id'], 'started_by': caller.subject,
                               'expansion': list(flow.expansion)}})


@app.get('/agents/engineering/<run_id>')
@tracer.capture_method
def get_engineering_run(run_id: str):
    """The run monitor's view of a run: the run, its agents and their metering, the totals (cost and budget come with the run control).
    Also the MCP tool ``engineering_run_get``'s (7.53.00), which keeps its status, steps, agents, cost and links."""
    monitor = _monitor(run_id, 'run_get')
    return _found(monitor.overview(run_id))


@app.post('/agents/engineering/<run_id>/signals')
@tracer.capture_method
def signal_engineering_run(run_id: str):
    """``{signal, task_id?, attempt?, note?, confirm?}`` → ``{signal}``: an admin acting for themselves (never a
    delegated credential), like a run's decision; voc-engineering-start checks, records and hands it on to the
    supervisor, which applies it (7.51.02, engineering/monitor.py): ``{signal: {status: sent}}``; a whole run's Shut
    down or Stop now is its Stop. 409 for a run that ended, is being stopped or whose task moved on; 503 without the
    start function, or when it cannot be reached (send it again)."""
    monitor, caller = _acting_monitor(run_id)
    from engineering.monitor import parse_signal  # (the package ships only with the module)

    sent = _monitor_action(monitor, caller, lambda m, body, actor: m.signal(run_id, parse_signal(body), actor))
    logger.info('Engineering run signalled', extra={'run_id': run_id, 'signal': sent['signal']})
    stopped = sent.get('run')
    if isinstance(stopped, dict):   # (a whole run's Shut down or Stop now: its Stop, 7.50.03)
        stopped['agent_run'] = _end_agent_run_of(monitor, run_id, stopped)
    return {'signal': sent}


def _end_agent_run_of(monitor: Any, run_id: str, stopped: dict[str, Any]) -> dict[str, Any] | None:
    """After a Stop that ended the run, its engineering agent's run ended at once (cancelled, its lock released:
    ``eng_runs.end_agent_run``), so the agent may run again now rather than at the heartbeat's next heal, which would
    do the same; None for a run no agent started, or a Stop still waiting for its agents. Best effort: a failure is
    logged and left to the heartbeat."""
    if stopped.get('status') not in eng_runs.AGENT_RUN_ENDS:
        return None
    try:
        via = monitor.origin(run_id)
        if via is None:
            return None
        table = store.get_agents_table()
        if table is None:
            return None
        ended = eng_runs.end_agent_run(table, via['agent_id'], via['agent_run_id'], str(stopped['status']),
                                       now=datetime.now(UTC))
    except (ApiError, ClientError, BotoCoreError, KeyError, ValueError):
        logger.exception('engineering: the stopped run\'s agent run was not ended here; the heartbeat ends it',
                         extra={'run_id': run_id})
        return None
    return {'agent_id': via['agent_id'], 'run_id': via['agent_run_id'], 'ended': ended}


@app.post('/agents/engineering/<run_id>/stop')
@tracer.capture_method
def stop_engineering_run(run_id: str):
    """``{now?, confirm?, note?}`` → ``{stop}`` (7.50.03): an administrator acting for themselves (a delegated
    credential gets 403; 404 while the module is off or for an unknown run) stops the whole run through
    voc-engineering-start's ``stop_run``, whatever its agents are doing, a run with no session included: a Stop has
    its agents save first (``status: stopping`` until they have, ``stopped`` at once when none has a session), ``now:
    true`` with ``confirm: true`` stops it at once. Once ended, its engineering agent's run is ended too
    (``agent_run``). 409 for a run that has ended; 503 when the start function cannot be reached (send it again)."""
    monitor, caller = _acting_monitor(run_id)
    from engineering.monitor import parse_stop  # (the package ships only with the module)

    stopped = _monitor_action(monitor, caller, lambda m, body, actor: m.stop(run_id, parse_stop(body), actor))
    stopped['agent_run'] = _end_agent_run_of(monitor, run_id, stopped)
    logger.info('Engineering run stopped', extra={'run_id': run_id, 'mode': stopped['mode'],
                                                  'status': stopped['status']})
    return {'stop': stopped}


@app.post('/agents/engineering/<run_id>/messages')
@tracer.capture_method
def message_engineering_run(run_id: str):
    """``{to: conductor | agent, agent?, text, thread_id?}`` → ``{message}``: an admin's answer in the run."""
    monitor, caller = _acting_monitor(run_id)
    from engineering.monitor import parse_message  # (the package ships only with the module)

    sent = _monitor_action(monitor, caller,
                           lambda m, body, actor: m.message(run_id, parse_message(body, run_id), actor))
    return {'message': sent}


# A person's board actions (engineering/board/api.py PersonBoard, plan v3 4.3): the same gate as the monitor's
# actions (admins acting for themselves; 404 while the module is off or for an unknown run), the bus needed for their
# events (503 without it; since 7.51.02 for every action that publishes, the API's source saying only steering and
# answers: RunMonitor.board_available), each change written by the board store with the person as its actor.
_BOARD_ERRORS = {**_MONITOR_ERRORS, 'forbidden': AuthorizationError, 'cap': TooManyRequestsError}


def _person_board_action(run_id: str, request: dict[str, str], *, publishes: bool = True) -> dict:
    """A person's board action (``request``: ``{op: post}``, ``{op: act, task_id, action}`` or ``{op: go}``) through
    the board function, whose own role writes the change (this role writes no board row: engineering/board/api.py
    person_request); the events it hands back are published here, from the API's source, as the person. An action
    that ``publishes`` nothing (a go: its row is the record) needs no bus; one that does is refused before the board
    is asked while the bus takes no ``task.*`` from the API (``RunMonitor.board_bus``, 7.51.02)."""
    monitor, caller = _acting_monitor(run_id)
    from engineering.bus.publish import PublishError
    from engineering.bus.schema import parse
    from engineering.rows import Refused

    board = os.environ.get('ENGINEERING_BOARD_FUNCTION', '')
    try:
        monitor.open_run(run_id)   # (an ended run takes no more work, as with a signal)
        # (no change its event could not be sent for: since 7.51.02 the bus takes no task.* from the API's source,
        # monitor.board_available, so every board action that publishes is refused here, before the board writes)
        publisher = monitor.board_bus() if publishes else None
        if not board:
            raise ServiceUnavailableError('the board cannot be reached from here: the deployment names no board function')
        person = {**request, 'run_id': run_id, 'subject': caller.subject, 'body': json_object_body(app)}
        answer = _invoke_board(board, {'person': person})
        if answer.get('status') != 'ok':
            kind = str(answer.get('kind'))
            raise _BOARD_ERRORS.get(kind, ServiceUnavailableError)(str(answer.get('message') or 'the board refused it'))
        result = answer.get('answer')
        if not isinstance(result, dict):   # (the board's fault, as an event that is not the person's: nothing sent)
            logger.error('engineering: the board answered ok with no answer')
            raise ServiceUnavailableError('the board could not be reached: retry')
        messages = _persons_events(answer.get('events'), parse, run_id, caller.subject, request)
        if messages:
            if publisher is None:   # (an action that publishes nothing handed an event back: the board's fault)
                logger.error('engineering: the board handed back an event for an action that has none')
                raise ServiceUnavailableError('the board could not be reached: retry')
            for message in messages:
                publisher.publish(message)
    except Refused as refused:   # (the monitor's refusals: the same kinds)
        raise _BOARD_ERRORS[refused.kind](str(refused)) from refused
    except (ClientError, BotoCoreError) as exc:
        logger.exception('engineering: the board could not be reached')
        raise ServiceUnavailableError('the board could not be reached: retry') from exc
    except PublishError as exc:
        raise ServiceUnavailableError('the board changed but its event was not published: retry') from exc
    return result


def _persons_events(raw: Any, parse: Any, run_id: str, subject: str, request: dict[str, str]) -> list[Any]:
    """The events the board handed back, each checked to be this person's board action before it goes out under the
    API's source (which the bus lets send more than ``task.*``): at most one, a ``task.*`` of this run (and of this
    task, for an action on one) from ``human:<subject>``. Anything else, an event that is not voc-msg/1 too, is the
    board's fault (docs/autonomous-agents.md): 503, nothing sent."""
    from engineering.bus.schema import MessageError, Party

    events = raw if isinstance(raw, list) else []
    expected = Party('human', subject)
    try:
        messages = [parse(event) for event in events]
        persons = len(messages) <= 1 and all(
            message.type.startswith('task.') and message.sender == expected and message.run_id == run_id
            and ('task_id' not in request or message.task_id == request['task_id']) for message in messages)
    except MessageError:
        messages, persons = [], False
    if not persons:
        logger.error('engineering: the board handed back an event that is not the person\'s action',
                     extra={'events': len(events), 'types': [message.type for message in messages]})
        raise ServiceUnavailableError('the board could not be reached: retry')
    return messages


def _invoke_board(function: str, payload: dict) -> dict:
    """The board function's answer to a direct invoke (``ClientError`` when the call fails; a function error is a
    503: the board's own fault, retried by the person)."""
    from shared.aws import get_lambda_client

    response = get_lambda_client().invoke(FunctionName=function, Payload=json.dumps(payload).encode())
    raw = response['Payload'].read()
    if response.get('FunctionError'):
        logger.error('engineering: the board function failed', extra={'error': raw[:500]})
        raise ServiceUnavailableError('the board could not be reached: retry')
    try:
        answer = json.loads(raw)
    except ValueError as exc:   # (not JSON: the board's own fault, as a function error is)
        raise ServiceUnavailableError('the board could not be reached: retry') from exc
    if not isinstance(answer, dict):
        raise ServiceUnavailableError('the board could not be reached: retry')
    return answer


@app.post('/agents/engineering/<run_id>/board/tasks')
@tracer.capture_method
def post_engineering_task(run_id: str):
    """``{role, title, spec, priority?, parent_task?, flow_step?, shard?}`` → ``{task, duplicate}``: a person posts a
    task (admin); in a run that follows its flow, for a live step it names or as their own task with none."""
    return _person_board_action(run_id, {'op': 'post'})


@app.post('/agents/engineering/<run_id>/board/tasks/<task_id>/<action>')
@tracer.capture_method
def act_on_engineering_task(run_id: str, task_id: str, action: str):
    """``priority {priority}`` | ``block {reason, over?}`` | ``take {over?}`` | ``move {to}`` | ``release {}`` →
    ``{task}`` (admin)."""
    return _person_board_action(run_id, {'op': 'act', 'task_id': task_id, 'action': action})


@app.post('/agents/engineering/<run_id>/go')
@tracer.capture_method
def give_engineering_go(run_id: str):
    """``{}`` → ``{go: {by, at, created}}``: an administrator's go on the run (admin acting for themselves), which an
    AI-assisted run's push and pull request wait for (TENETS.md tenet 3; engineering/connectors/broker.py). Written
    once, create-only, by the board function (``GO#person``, board/store.py person_go); a go already given is
    answered as it is. No bus needed: the row is the record (who and when, D4)."""
    answer = _person_board_action(run_id, {'op': 'go'}, publishes=False)
    logger.info('Engineering run given a go', extra={'run_id': run_id, 'go_written': answer.get('go', {}).get('created')})
    return answer


@app.post('/agents/engineering/<run_id>/reactions')
@tracer.capture_method
def ask_engineering_reactions(run_id: str):
    """``{}`` → 202 ``{reactions: {status: asked}}``: an administrator acting for themselves (a delegated credential
    gets 403; 404 while the module is off or for an unknown run) asks for an ended run's pull request's reactions to be
    read now (7.10.00), through voc-engineering-start's ``ask_reactions`` (this role invokes no other runtime
    function), which hands the read on: the run monitor shows it once it is recorded. 409 while the run has not ended;
    429 when this run's read was asked for in this clock hour already (at most once an hour per run, a create-only
    row), with ``retry_after`` seconds."""
    monitor, caller = _acting_monitor(run_id)
    if json_object_body(app):
        raise ValidationError('the body is {}')
    try:
        ended = monitor.ended(run_id)
    except (ClientError, BotoCoreError) as exc:
        raise ServiceUnavailableError('the run could not be read: retry') from exc
    if not ended:
        raise ConflictError("The run has not ended: its pull request's reactions are read once it has.")
    function = os.environ.get('ENGINEERING_START_FUNCTION', '')
    if not function:
        raise ServiceUnavailableError('reactions cannot be asked for from here: the deployment names no start function')
    # (its refusal, an unknown run or one not ended, 409 in its words; asking again is safe: the hour's claim is
    # create-only)
    answer = eng_runs.ask_start(_start_client(), function,
                                {'action': 'ask_reactions', 'run_id': run_id, 'actor': caller.subject},
                                answers=frozenset({'asked', 'too_soon'}),
                                failed='the reactions read could not be asked for', again='ask again')
    if answer['status'] == 'too_soon':
        wait = answer.get('retry_after')
        seconds = wait if isinstance(wait, int) and not isinstance(wait, bool) and wait > 0 else 3600
        return _json(429, {'error': "This run's reactions were asked for in this hour already: ask again later.",
                           'retry_after': seconds})
    logger.info('Engineering reactions asked for', extra={'run_id': run_id})
    return _json(202, {'reactions': {'status': 'asked'}})


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource)


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
