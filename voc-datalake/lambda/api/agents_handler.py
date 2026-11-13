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
- workflows hold no customer data, so every signed-in user may read and
  validate them; the default engineering flows (``GET /workflows/templates``) are listed for
  administrators only, where the engineering agents are on (404 elsewhere), as the library offers them;
- an engineering run's monitor, board, conversation and reports (``/agents/engineering/<run_id>``
  and its ``/*``, lambda/engineering/views.py and monitor.py) are read by administrators only,
  acting for themselves (403 for anyone else, an MCP credential included), and so are its signals
  and a person's answers in it (``POST …/signals``, ``…/messages``, like a decision) and a
  person's board actions (``POST …/board/tasks``, ``…/board/tasks/<task_id>/<action>``:
  engineering/board/api.py PersonBoard) and a person's go on a run (``POST …/go``, what an AI-assisted run's push
  waits for), and the runs' spend by month (``GET /agents/engineering/spend``,
  engineering/spend.py), and the hard cap's setting, read and written (``GET``/``PUT
  /agents/engineering/settings``, engineering/settings.py: one row in the agents table, written with
  its history row; the runtime reads it at a budgeted run's first start), and a run's start
  (``POST /agents/engineering/runs``, a saved engineering flow on a repository's commit: the start
  function, below); while the engineering agents are off every caller gets 404.

Own role (20 KB policy limit): the agents table (read/write), the aggregates table
(read: category access rows + categories config), ``states:StartExecution`` and
``states:StopExecution`` on ``voc-agent-run`` only; with the engineering agents on, their stack adds reads of
their table and workspace bucket (never a write: GetItem and Query) and ``lambda:InvokeFunction`` on the board's
function (``ENGINEERING_BOARD_FUNCTION``), which makes a person's board actions with its own role and hands the
events back for this role to publish as the person (engineering/board/api.py person_request), and
``lambda:InvokeFunction`` on the start function (``ENGINEERING_START_FUNCTION``, voc-engineering-start: the runtime's
code and role, which runs ``start_run`` and refuses every other action; never the runtime's own function); it is to add
``lambda:InvokeFunction`` on ``voc-engineering-runtime`` (the run
monitor's signals) and ``events:PutEvents`` on the engineering bus with the source ``voc.engineering/api``, with
their names, and the bus's resource policy is to let this role put that source (until then the monitor's actions
answer 503). Nothing while the module is off. The supervisor's session rows (``WS#<ws>#RUN#<run>`` / ``AGENT#``)
are in the engineering table, read with the Query its stack already grants, and so are the spend ledger's month
partitions (``WS#<ws>#SPEND#<yyyy-mm>``).
"""

from __future__ import annotations

import json
import math
import os
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from functools import cache
from typing import Any

from aws_lambda_powertools.event_handler import Response, content_types
from botocore.exceptions import BotoCoreError, ClientError

from shared import (
    agent_run_decisions,
    agent_run_resume,
    agent_seed,
    engineering_templates,
    plans_store,
    project_access,
    workflow_methodology,
    workflow_schema,
)
from shared import agents_store as store
from shared.api import api_handler, create_api_resolver, validate_int
from shared.aws import get_dynamodb_resource
from shared.category_access import CategoryScope
from shared.category_gate import read_categories_config, scope_for_caller
from shared.engineering_agents import engineering_agents_on
from shared.exceptions import (
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


def _visible_agent(agent_id: str, caller: Caller) -> dict:
    """The agent if ``caller`` may read it; 404 otherwise (no existence leak)."""
    agent = _stored_agent(agent_id, include_archived=caller.is_admin and not caller.delegated)
    if not store.agent_visible(_viewer_scope(caller), agent):
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


def _require_workflow(workflow_id: str) -> None:
    """A workflow an agent body names must exist and be an agents workflow (400, it is a field of the request)."""
    workflow = _find_workflow(workflow_id)
    if workflow is None:
        raise ValidationError('workflow_id does not name a workflow')
    if _engineering_flow(workflow):
        raise ValidationError('an engineering flow is not run by an agent: pick an agents workflow')


def _default_workflow_for(name: str, caller: Caller) -> str:
    """A fresh, editable copy of the built-in template for a new agent."""
    return agent_seed.default_workflow_copy(_agents_table(), name, caller)


@app.get('/agents')
@tracer.capture_method
def list_agents():
    """Agents the caller may see, by name. Admins may add ``?include_archived=true``."""
    caller = _caller()
    include_archived = _query('include_archived') == 'true'
    if include_archived:
        require_admin_caller(caller)
    scope = _viewer_scope(caller)
    table = _agents_table()
    if caller.is_admin and not caller.delegated:
        # Once per deployment: the default agent (shared/agent_seed.py; never fails the listing).
        agent_seed.ensure_default_agent(table, caller, lambda: read_categories_config(_aggregates_table()))
    now = store.utc_now()
    agents = [
        store.agent_view(agent, now) for agent in store.list_agents(table)
        if (include_archived or agent.get('status') != store.AGENT_STATUS_ARCHIVED)
        and store.agent_visible(scope, agent)
    ]
    agents.sort(key=lambda agent: (str(agent.get('name') or '').lower(), str(agent.get('agent_id'))))
    return {'items': agents, 'count': len(agents)}


@app.post('/agents')
@tracer.capture_method
def create_agent():
    """Create an agent (admin). Without ``workflow_id`` it gets its own copy of the template."""
    caller = _caller()
    require_admin_caller(caller)
    fields = store.normalize_agent(json_object_body(app), read_categories_config(_aggregates_table()))
    if fields['workflow_id'] is None:
        fields['workflow_id'] = _default_workflow_for(fields['name'], caller)
    else:
        _require_workflow(fields['workflow_id'])
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
    fields = store.normalize_agent(json_object_body(app), read_categories_config(_aggregates_table()), base=existing)
    if fields['workflow_id'] is None:
        fields['workflow_id'] = existing.get('workflow_id') or workflow_schema.DEFAULT_WORKFLOW_ID
    if fields['workflow_id'] != existing.get('workflow_id'):
        _require_workflow(fields['workflow_id'])
    if fields['owner_sub'] is None:
        fields['owner_sub'] = existing.get('owner_sub')
    updated = store.update_agent(_agents_table(), agent_id, fields, updated_by=caller.subject, now=store.utc_now())
    return {'agent': store.agent_view(updated)}


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


def _set_enabled(agent_id: str, enabled: bool) -> dict:
    caller = _caller()
    require_admin_caller(caller)
    _stored_agent(agent_id)
    updated = store.update_agent(_agents_table(), agent_id, {'enabled': enabled},
                                 updated_by=caller.subject, now=store.utc_now())
    return {'agent': store.agent_view(updated)}


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
    rows = [row for row in store.list_workflows(_agents_table())
            if include_archived or not store.is_archived_workflow(row)]
    builtin, stored = rows[:1], sorted(rows[1:], key=lambda row: str(row.get('gsi1sk') or ''))
    items = [store.workflow_view(row, include_definition=False) for row in builtin + stored]
    return {'items': items, 'count': len(items)}


@app.post('/workflows')
@tracer.capture_method
def create_workflow():
    """Create a library workflow (admin): ``{definition}``."""
    return _create_from(json_object_body(app).get('definition'), None)


@app.post('/workflows/validate')
@tracer.capture_method
def validate_workflow():
    """``{definition, workflow_id?}`` → ``{valid, errors, diff?}``; the diff is against that workflow's current revision."""
    _caller()
    body = json_object_body(app)
    result = workflow_schema.validate_definition(body.get('definition'))
    response: dict[str, Any] = result.to_dict()
    # Methodology gaps (a PRD with no PR/FAQ before it, ...): warnings, never errors (tenet 2).
    # The methodology rules are the agents' (research, PR/FAQ, PRD, prototype); an engineering flow has none of them.
    definition = result.definition
    agents_flow = definition is not None and definition['schema'] == workflow_schema.SCHEMA
    response['warnings'] = workflow_methodology.methodology_warnings(definition) if definition and agents_flow else []
    workflow_id = body.get('workflow_id')
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
    """The current revision (with its definition) and the revision list."""
    workflow = _workflow(workflow_id, include_archived=_sees_archived(_caller()))
    return {'workflow': store.workflow_view(workflow),
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
    """Save a new revision (admin): ``{definition, expected_revision}``; 409 when stale."""
    caller = _caller()
    require_admin_caller(caller)
    body = json_object_body(app)
    expected = body.get('expected_revision')
    if isinstance(expected, bool) or not isinstance(expected, int) or expected < 1:
        raise ValidationError('expected_revision must be the revision you edited (a whole number ≥ 1)')
    current = workflow_schema.decode_definition(_workflow(workflow_id).get('definition')) or {}
    definition = _valid_definition(body.get('definition'))
    if isinstance(definition, Response):
        return definition
    if definition['schema'] != current.get('schema', workflow_schema.SCHEMA):
        # An agent may run this workflow: it stays an agents workflow (or an engineering flow) for good.
        raise ValidationError(KEEPS_ITS_KIND)
    saved = store.save_revision(_agents_table(), workflow_id, definition, expected_revision=expected,
                                saved_by=caller.subject, username=caller.username, now=store.utc_now())
    return {'workflow': store.workflow_view(saved)}


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
        meta = plans_store.create_plan(table, plan, approver=approver, conversation_id=conversation_id, now=now)
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

ENGINEERING_RUN_NOT_FOUND = 'Engineering run not found'
_VERSION = re.compile(r'[0-9]{1,4}\Z')


def _engineering_tables(run_id: str) -> tuple[str, str]:
    """The engineering table and bucket, for an administrator (403 for anyone else; 404 for a bad run id and while
    the module is off)."""
    table, bucket = os.environ.get('ENGINEERING_TABLE', ''), os.environ.get('ENGINEERING_WORKSPACE_BUCKET', '')
    if not (engineering_agents_on() and table and bucket):
        raise NotFoundError(ENGINEERING_RUN_NOT_FOUND)
    require_admin_caller(_caller())
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


def _monitor(run_id: str) -> Any:
    """The run monitor, for an administrator (as the views): the agents from the supervisor's session rows (the
    run's partition of the engineering table, read only); its actions need the runtime (ENGINEERING_RUNTIME_FUNCTION)
    and the bus (ENGINEERING_BUS_NAME)."""
    table, _ = _engineering_tables(run_id)
    from engineering.bus.publish import EventBridgePublisher
    from engineering.monitor import API_SOURCE, LambdaRuntime, RunMonitor
    from engineering.runtime.runs import RunStore
    from engineering.runtime.sessions import SessionStore
    from shared.aws import get_dynamodb_client, get_dynamodb_resource, get_eventbridge_client, get_lambda_client

    bus, runtime = os.environ.get('ENGINEERING_BUS_NAME', ''), os.environ.get('ENGINEERING_RUNTIME_FUNCTION', '')
    engineering = get_dynamodb_resource().Table(table)
    return RunMonitor(get_dynamodb_client(), table, SessionStore(engineering, RunStore(engineering)),
                      runtime=LambdaRuntime(get_lambda_client(), runtime) if runtime else None,
                      publisher=EventBridgePublisher(get_eventbridge_client(), bus, API_SOURCE) if bus else None)


_MONITOR_ERRORS = {'invalid': ValidationError, 'not_found': NotFoundError, 'conflict': ConflictError,
                   'unavailable': ServiceUnavailableError}


def _acting_monitor(run_id: str) -> tuple[Any, Caller]:
    """The monitor and its caller for an action, checked before the body is read: while the module is off every
    caller gets 404, then anyone but an administrator 403, then a bad or unknown run id 404."""
    monitor = _monitor(run_id)
    if not monitor.run_exists(run_id):
        raise NotFoundError(ENGINEERING_RUN_NOT_FOUND)
    caller = _caller()
    require_admin_caller(caller)
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


# A run's start (``POST /agents/engineering/runs``): an administrator acting for themselves starts a saved engineering
# flow on a repository's commit. The API mints the run's id and invokes the start function (voc-engineering-start, the
# runtime's code: it runs ``start_run`` and refuses every other action; this role may invoke it and never the runtime
# itself), with the flow's budget from the stored workflow, never from the request, and the person as its actor.
#: The task cap of a run started here (the board counts its tasks against it: runs.py RunCaps), the server's own.
RUN_TASK_CAP = 100
#: A run's cost and token caps when the deployment sets none (`-c engineeringRunCapUsd`, `-c engineeringRunTokenCap`:
#: ENGINEERING_RUN_CAP_USD, ENGINEERING_RUN_TOKEN_CAP): every run started here has both, so its cost cap bounds it
#: (TENETS.md tenet 7); with the hard cap on, the runtime lowers the cost cap to what is left of the flow's month.
DEFAULT_RUN_CAP_USD = 50.0
DEFAULT_RUN_TOKEN_CAP = 10_000_000
#: The longest goal a run takes (runs.py MAX_TEXT): longer is refused, never cut.
MAX_RUN_GOAL = 500
#: How long the API waits for the start (under API Gateway's 29 s); a start is never retried by the client.
START_READ_TIMEOUT_SECONDS = 25
_START_FIELDS = frozenset({'workflow_id', 'connection', 'commit', 'language', 'goal'})
_RUN_COMMIT = re.compile(r'[0-9a-f]{40}\Z')
#: The runtime's refusals a person can act on, all before anything is written (its error types): 409 with its own
#: words (no image for the language, the hard cap with nothing left of the flow's month).
_START_REFUSALS = frozenset({'RuntimeRefused', 'RunExists', 'RunNotActive'})
#: The start function's faults known to have written nothing, said in its words as 503 (start it again): a read the
#: start needed failed, or the write itself failed.
_START_NOT_WRITTEN = frozenset({'StartReadFailed', 'StartNotWritten'})
#: Its faults once the run was written, or when it could not tell, said in its words as 503 naming the run (open it,
#: never start another).
_START_WRITTEN = frozenset({'StartFailed', 'StartUncertain'})


def _run_cap(name: str, default: float, kind: type) -> Any:
    """A run cap from the deployment (``name``, set by the stack from its context), ``default`` when it sets none; one
    that is not a positive number is a deployment fault, logged, and the default holds (a run is never uncapped)."""
    raw = os.environ.get(name, '')
    try:
        value = kind(raw) if raw else default
    except ValueError:
        value = 0
    if not (value > 0 and math.isfinite(value)):
        logger.error('engineering: a run cap of the deployment is not a positive number', extra={'variable': name})
        return kind(default)
    return value


def _run_repo(connection: str) -> str:
    """The run's ``repo``, as its reports and the spend ledger group it: the connection's repository once connections
    are stored (the connection page is planned, so there is no record to read yet); until then the connection's id."""
    return connection


def _start_body(body: Mapping[str, Any]) -> dict[str, str]:
    """The request's fields, each checked (400 for anything off): a workflow id, a connection's short id, a commit of
    40 hexadecimal characters (lower-cased), a language with a MicroVM image, and a goal on one line, at most
    ``MAX_RUN_GOAL`` characters, credential-shaped text redacted."""
    from engineering.quality_gate.text import redact
    from engineering.runtime.egress import REGISTRY_HOSTS
    from engineering.runtime.interface import RuntimeRefused, check_id

    if not set(body) <= _START_FIELDS or not all(isinstance(body.get(name), str) for name in _START_FIELDS):
        raise ValidationError('the body is {workflow_id, connection, commit, language, goal}, each a string')
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


def _engineering_flow_budget(workflow_id: str) -> float | None:
    """The stored engineering flow's monthly budget (None for none): 400 for an id that names no saved workflow or an
    agents workflow, 409 for a stored budget off its rule."""
    from shared.workflow_engineering import budget_of

    workflow = _find_workflow(workflow_id)
    if workflow is None:
        raise ValidationError('workflow_id does not name a saved workflow')
    definition = workflow_schema.decode_definition(workflow.get('definition')) or {}
    if definition.get('schema') != workflow_schema.SCHEMA_V2:
        raise ValidationError('workflow_id names an agents workflow: a run starts from an engineering flow')
    budget, broken = budget_of(definition.get('budget'))
    if broken:
        raise ConflictError(f'the flow\'s stored budget is off its rule ({broken}): save the flow again')
    return None if budget is None else float(budget['monthly_usd'])


@cache
def _start_client() -> Any:
    """The Lambda client for the start (built once per container): it waits ``START_READ_TIMEOUT_SECONDS`` and never
    retries by itself."""
    import boto3
    from botocore.config import Config

    return boto3.client('lambda', config=Config(read_timeout=START_READ_TIMEOUT_SECONDS, connect_timeout=5,
                                                retries={'total_max_attempts': 1}))


class _MayHaveStarted(ServiceUnavailableError):
    """503 naming a run that was written, or may have been (nobody can tell): open its monitor, never start another.
    Answered with the run's id beside the message (``run_id``), and the message names it too."""

    def __init__(self, run_id: str, message: str = '') -> None:
        super().__init__(message or f'run {run_id} may have been started: open the run monitor before you start '
                                    'another')
        self.run_id = run_id


def _invoke_start(function: str, request: dict[str, Any]) -> dict[str, Any]:
    """The start function's answer (``{run_id, status}``). Its refusals (all before the write) are 409 in its words; a
    failure known to have written nothing is 503 "start it again"; anything else (written, or not known not to be: a
    dropped connection, a timeout, a failure of an unknown kind) is a 503 naming the run, ``_MayHaveStarted``."""
    from botocore.exceptions import ConnectTimeoutError, EndpointConnectionError

    run_id = request['run_id']
    try:
        response = _start_client().invoke(FunctionName=function, InvocationType='RequestResponse',
                                          Payload=json.dumps(request).encode())
    except (EndpointConnectionError, ConnectTimeoutError, ClientError) as exc:
        # (never connected, or the service refused the call: the start function did not run)
        logger.exception('engineering: the start function could not be reached')
        raise ServiceUnavailableError('the engineering runtime could not be reached: start the run again') from exc
    except BotoCoreError as exc:
        # (a read timeout, a connection dropped mid-call: the start may have written the run)
        logger.warning('engineering: the run\'s start did not answer', extra={'run_id': run_id})
        raise _MayHaveStarted(run_id) from exc
    try:
        # (the answer is read off the connection here: a read that fails, or a payload that is not a JSON object, says
        # nothing of the write, so the run may have been started)
        payload = json.loads(response['Payload'].read() or b'{}')
    except (ValueError, KeyError, OSError, BotoCoreError) as exc:
        logger.warning('engineering: the start\'s answer could not be read', extra={'run_id': run_id})
        raise _MayHaveStarted(run_id) from exc
    if not isinstance(payload, dict):
        raise _MayHaveStarted(run_id)
    answer: dict[str, Any] = payload
    if response.get('FunctionError'):
        error_type, said = answer.get('errorType'), str(answer.get('errorMessage') or '')[:500]
        logger.warning('engineering: a start failed', extra={'run_id': run_id, 'error_type': error_type})
        if error_type in _START_REFUSALS:
            raise ConflictError(said or 'the runtime refused the start')
        if error_type in _START_NOT_WRITTEN:
            raise ServiceUnavailableError(said or 'the run could not be started: start it again')
        if error_type in _START_WRITTEN:
            raise _MayHaveStarted(run_id, said)
        raise _MayHaveStarted(run_id)   # (a timeout, a crash: the function's own kind, which says nothing of the write)
    if answer.get('run_id') != run_id:
        raise _MayHaveStarted(run_id)
    return answer


@app.post('/agents/engineering/runs')
@tracer.capture_method
def start_engineering_run():
    """``{workflow_id, connection, commit, language, goal}`` → 202 ``{run: {run_id, status, workflow_id, started_by}}``:
    an administrator acting for themselves (a delegated credential gets 403) starts a saved engineering flow (404 while
    the module is off). The run's id is minted here; its flow's budget is the stored workflow's, its caps the
    deployment's; the runtime records who started it and when (META's ``started_by``, its ``RUNLOG#`` row: D4). 202:
    the run is written when this answers, and its coordinator's launch is under way (the start function hands it on)."""
    _engineering_on()
    caller = _caller()
    require_admin_caller(caller)
    function = os.environ.get('ENGINEERING_START_FUNCTION', '')
    if not function:
        raise ServiceUnavailableError('runs cannot be started from here: the deployment names no start function')
    fields = _start_body(json_object_body(app))
    budget_usd = _engineering_flow_budget(fields['workflow_id'])
    from engineering.bus.publish import new_event_id

    request: dict[str, Any] = {
        'action': 'start_run', 'run_id': new_event_id(), 'max_tasks': RUN_TASK_CAP, 'flow': fields['workflow_id'],
        'connection': fields['connection'], 'commit': fields['commit'], 'language': fields['language'],
        'goal': fields['goal'], 'actor': caller.subject, 'repo': _run_repo(fields['connection']),
        'max_cost_usd': _run_cap('ENGINEERING_RUN_CAP_USD', DEFAULT_RUN_CAP_USD, float),
        'max_tokens': _run_cap('ENGINEERING_RUN_TOKEN_CAP', DEFAULT_RUN_TOKEN_CAP, int),
    }
    if budget_usd is not None:
        request['budget_usd'] = budget_usd
    try:
        answer = _invoke_start(function, request)
    except _MayHaveStarted as unsure:
        # (the run's id beside the message: the web app offers its monitor, and no second start)
        return _json(503, {'error': unsure.message, 'run_id': unsure.run_id})
    logger.info('Engineering run started', extra={'run_id': request['run_id'], 'workflow_id': fields['workflow_id'],
                                                  'started_by': caller.subject})
    return _json(202, {'run': {'run_id': request['run_id'], 'status': str(answer.get('status', 'active')),
                               'workflow_id': fields['workflow_id'], 'started_by': caller.subject}})


@app.get('/agents/engineering/<run_id>')
@tracer.capture_method
def get_engineering_run(run_id: str):
    """The run monitor's view of a run: the run, its agents and their metering, the totals (cost and budget come with the run control)."""
    return _found(_monitor(run_id).overview(run_id))


@app.post('/agents/engineering/<run_id>/signals')
@tracer.capture_method
def signal_engineering_run(run_id: str):
    """``{signal, task_id?, attempt?, note?, confirm?}`` → ``{signal}``: an admin acting for themselves (never a
    delegated credential), like a run's decision; the supervisor applies it (engineering/monitor.py)."""
    monitor, caller = _acting_monitor(run_id)
    from engineering.monitor import parse_signal  # (the package ships only with the module)

    sent = _monitor_action(monitor, caller, lambda m, body, actor: m.signal(run_id, parse_signal(body), actor))
    logger.info('Engineering run signalled', extra={'run_id': run_id, 'signal': sent['signal']})
    return {'signal': sent}


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
# actions (admins acting for themselves; 404 while the module is off or for an unknown run), the bus needed (503
# without it, like a signal), each change written by the board store with the person as its actor.
_BOARD_ERRORS = {**_MONITOR_ERRORS, 'forbidden': AuthorizationError, 'cap': TooManyRequestsError}


def _person_board_action(run_id: str, request: dict[str, str], *, publishes: bool = True) -> dict:
    """A person's board action (``request``: ``{op: post}``, ``{op: act, task_id, action}`` or ``{op: go}``) through
    the board function, whose own role writes the change (this role writes no board row: engineering/board/api.py
    person_request); the events it hands back are published here, from the API's source, as the person. An action
    that ``publishes`` nothing (a go: its row is the record) needs no bus."""
    monitor, caller = _acting_monitor(run_id)
    from engineering.bus.publish import PublishError
    from engineering.bus.schema import parse
    from engineering.rows import Refused

    board = os.environ.get('ENGINEERING_BOARD_FUNCTION', '')
    try:
        monitor.open_run(run_id)   # (an ended run takes no more work, as with a signal)
        publisher = monitor.bus() if publishes else None  # (no bus, no change: its event could not be sent)
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
    """``{role, title, spec, priority?, parent_task?}`` → ``{task, duplicate}``: a person posts a task (admin)."""
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


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource)


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
