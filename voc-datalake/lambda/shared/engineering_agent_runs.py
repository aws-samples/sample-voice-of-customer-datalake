"""An engineering run's start request, as the Agents API and the agents' heartbeat build it (7.47.00).

docs/autonomous-agents.md "Engineering agents", docs/autonomous-engineering.md "How a flow starts". Two callers start a
run through voc-engineering-start (lambda/engineering/runtime/handler.py ``start_handler``): the Agents API's
``POST /agents/engineering/runs`` and an engineering agent's Run now, and the heartbeat, for an engineering agent's
trigger. Both read the same things the same way, from here:

* the stored flow (``stored_flow``): its definition and revision, which the run copies and follows, and its monthly
  budget, from the stored workflow, never from a request; since 7.52.00 with its ``call_flow`` steps expanded
  (``shared/flow_expand.py``: each called flow read at the revision its call pins, through ``revision_reader``), so
  the run copies a flat flow and the calls it expanded (its start step's ``params.expansion``);
* the stored connection (``connection_row``, ``run_connection``): its repository and default branch, copied onto the
  run, read from its row in voc-agents (``CONNECTIONS#<ws>`` / ``CONNECTION#<id>``: the spelling of
  engineering/connectors/connections.py, held to it by ``shared/test/test_engineering_agent_runs.py``);
* the run caps the deployment sets (``run_cap``: ``-c engineeringRunCapUsd``, ``-c engineeringRunTokenCap``);
* the goal (``run_goal``): trusted text only, the agent's instructions (an administrator's words) and one sentence this
  module writes from numbers and names (an issue's number and repository, a count of reviews, the scope's categories,
  a PRD's ids), never an issue's or a review's text: the run's agents read the issue's thread through the broker;
* the start function's answer (``invoke_start``): started, refused before anything was written, known not written, or
  written (or not known not to be: the run is then opened, never started again).

Nothing here imports ``engineering.*`` (the heartbeat's bundle has only ``agents/`` and ``shared/``) or
``cryptography``.
"""
from __future__ import annotations

import json
import math
import os
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import cache
from typing import Any, Final, Literal

from botocore.exceptions import BotoCoreError, ClientError, ConnectTimeoutError, EndpointConnectionError

from shared import flow_expand, workflow_schema
from shared.dynamo_values import plain
from shared.exceptions import ConflictError, ServiceUnavailableError, ValidationError
from shared.logging import logger
from shared.workflow_engineering import budget_of

#: The engineering agents' fixed scope (engineering/connectors/identity.py WORKSPACE), until agents move per workspace.
ENGINEERING_WORKSPACE: Final = 'default'
#: The connections' rows in voc-agents (engineering/connectors/connections.py PARTITION and ROW_PREFIX).
CONNECTIONS_PARTITION: Final = f'CONNECTIONS#{ENGINEERING_WORKSPACE}'
CONNECTION_ROW_PREFIX: Final = 'CONNECTION#'
#: The task cap of every run started here (the board counts its tasks against it: runtime/runs.py RunCaps).
RUN_TASK_CAP: Final = 100
#: A run's cost and token caps when the deployment sets none (ENGINEERING_RUN_CAP_USD, ENGINEERING_RUN_TOKEN_CAP): every
#: run has both, so its cost cap bounds it (TENETS.md tenet 7); with the hard cap on, the runtime lowers the cost cap
#: to what is left of the flow's month.
DEFAULT_RUN_CAP_USD: Final = 50.0
DEFAULT_RUN_TOKEN_CAP: Final = 10_000_000
RUN_CAP_USD_ENV: Final = 'ENGINEERING_RUN_CAP_USD'
RUN_MODEL_USE_CAP_ENV: Final = 'ENGINEERING_RUN_TOKEN_CAP'
#: The function a start invokes (voc-engineering-start), by name.
START_FUNCTION_ENV: Final = 'ENGINEERING_START_FUNCTION'
#: The longest goal a run takes (runtime/runs.py MAX_TEXT): longer is refused, never cut.
MAX_RUN_GOAL: Final = 500
#: The most feedback ids a run started from reviews carries (ids, their top category and their count: never text).
MAX_FEEDBACK_IDS: Final = 50
#: How long a caller waits for the start (under API Gateway's 29 s); a start is never retried by itself.
START_READ_TIMEOUT_SECONDS: Final = 25
#: The start function's refusals a person can act on, all before anything is written (its error types).
START_REFUSALS: Final = frozenset({'RuntimeRefused', 'RunExists', 'RunNotActive'})
#: Its faults known to have written nothing (start it again).
START_NOT_WRITTEN: Final = frozenset({'StartReadFailed', 'StartNotWritten'})
#: Its faults once the run was written, or when it could not tell (open the run, never start another).
START_WRITTEN: Final = frozenset({'StartFailed', 'StartUncertain'})
_CROCKFORD: Final = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'


def new_run_id() -> str:
    """An engineering run's id: a ULID (48 bits of milliseconds, 80 random bits, Crockford base32), as the engineering
    bus mints its ids (engineering/bus/publish.py ``new_event_id``)."""
    value = ((time.time_ns() // 1_000_000) << 80) | int.from_bytes(os.urandom(10), 'big')
    return ''.join(_CROCKFORD[(value >> shift) & 31] for shift in range(125, -1, -5))


def run_cap(name: str, default: float, kind: type) -> Any:
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


def run_caps() -> dict[str, Any]:
    """The caps every run started here gets: its tasks, its cost (USD) and its model tokens."""
    return {'max_tasks': RUN_TASK_CAP, 'max_cost_usd': run_cap(RUN_CAP_USD_ENV, DEFAULT_RUN_CAP_USD, float),
            'max_tokens': run_cap(RUN_MODEL_USE_CAP_ENV, DEFAULT_RUN_TOKEN_CAP, int)}


@dataclass(frozen=True)
class StoredFlow:
    """A stored engineering flow as a run starts from it: its monthly budget (None for none), its definition as the
    JSON text the run copies, and its revision."""

    budget_usd: float | None
    definition: str
    revision: int
    #: The calls expanded into ``definition`` (7.52.00, ``shared/flow_expand.py``): ``[{step, flow, revision,
    #: inputs?}]``, which its copy's start step records too.
    expansion: tuple[dict[str, Any], ...] = ()
    #: The calls it still holds (read without a reader): such a flow is never started (``start_request``).
    calls: int = 0


#: Why a flow is never started with its calls in it (the runtime has no ``call_flow`` step to run).
UNEXPANDED: Final = 'a flow that calls other flows starts with its calls expanded: its start read none of them'


def revision_reader(table: Any) -> flow_expand.ReadRevision:
    """A saved revision's definition from voc-agents (``agents_store.get_revision``), None for none."""
    from shared import agents_store as store

    def read(workflow_id: str, revision: int) -> Mapping[str, Any] | None:
        found = store.get_revision(table, workflow_id, revision)
        definition = None if found is None else found.get('definition')
        return definition if isinstance(definition, Mapping) else None
    return read


def stored_flow(workflow: Mapping[str, Any] | None,
                read_revision: flow_expand.ReadRevision | None = None) -> StoredFlow:
    """The flow a workflow's CURRENT row holds (the caller reads it, archived ones left out): 400 for none or an agents
    workflow, 409 for a stored budget off its rule. With ``read_revision`` (a run's start: ``revision_reader``), its
    calls expanded, each called flow at the revision its call pins; 409 for a call that cannot be expanded."""
    if workflow is None:
        raise ValidationError('workflow_id does not name a saved workflow')
    definition = workflow_schema.decode_definition(workflow.get('definition')) or {}
    if definition.get('schema') != workflow_schema.SCHEMA_V2:
        raise ValidationError('workflow_id names an agents workflow: a run starts from an engineering flow')
    budget, broken = budget_of(definition.get('budget'))
    if broken:
        raise ConflictError(f'the flow\'s stored budget is off its rule ({broken}): save the flow again')
    revision = plain(workflow.get('revision')) or 1
    expansion: tuple[dict[str, Any], ...] = ()
    pending = len(flow_expand.calls(definition))
    if pending and read_revision is not None:
        root = workflow.get('workflow_id')
        try:
            expanded = flow_expand.expand(definition, read_revision, root=root if isinstance(root, str) else None)
        except flow_expand.ExpansionError as refused:
            raise ConflictError(f'the flow\'s calls cannot be expanded ({refused.message}): change the flow and save '
                                'it again') from None
        definition, expansion, pending = expanded.definition, expanded.expansion, 0
    return StoredFlow(None if budget is None else float(budget['monthly_usd']),
                      workflow_schema.encode_definition(definition), int(revision), expansion, pending)


def connection_key(connection_id: str) -> dict[str, str]:
    return {'pk': CONNECTIONS_PARTITION, 'sk': f'{CONNECTION_ROW_PREFIX}{connection_id}'}


def connection_row(table: Any, connection_id: str) -> dict[str, Any] | None:
    """The stored connection's row (voc-agents), None for none or a removed one; 503 when it cannot be read."""
    try:
        item = table.get_item(Key=connection_key(connection_id), ConsistentRead=True).get('Item')
    except (ClientError, BotoCoreError) as exc:
        raise ServiceUnavailableError('the connection could not be read: retry') from exc
    return None if not isinstance(item, dict) or item.get('removed') is True else plain(item)


def connection_host(row: Mapping[str, Any]) -> str:
    """The connection's host kind (a row with none is GitHub's)."""
    return str(row.get('host') or 'github')


def repository_private(row: Mapping[str, Any]) -> bool:
    """Whether the connection's repository is private, as its row says (7.45.00's ``repository_private``); a row
    that does not say is a public repository's, where an issue starts a run only with its label."""
    return row.get('repository_private') is True


def run_connection(row: Mapping[str, Any] | None, issue: int | None = None) -> dict[str, Any]:
    """The run's ``repo`` (as its reports and the spend ledger group it) and ``default_branch``: the stored
    connection's, copied onto the run (the broker serves the run on that branch once the host confirms it has it);
    with the ``issue`` the run starts from, it and the connection's ``host``. 400 for a connection not stored."""
    if row is None:
        raise ValidationError('connection names no stored repository connection: add it under Agents → Connections')
    run: dict[str, Any] = {'repo': str(row.get('repository', '')), 'default_branch': str(row.get('default_branch', ''))}
    if issue is not None:
        run.update(issue=issue, host=connection_host(row))
        # (7.57.00: a fork's issue is its upstream's, the one its public connection reads as feedback)
        if row.get('connection_kind') == 'fork' and isinstance(row.get('upstream'), str) and row['upstream']:
            run['issue_repo'] = row['upstream']
    return run


# --------------------------------------------------------------------------
# The goal: trusted text only.
# --------------------------------------------------------------------------

_WORK: Final[Mapping[str, tuple[str, str]]] = {
    # feedback type -> (from an issue, from reviews)
    'bug': ('Fix the bug reported in issue #{number} of {repository}.',
            'Hunt the defects behind {count} bug reports in {scope}.'),
    'feature_request': ('Build the feature asked for in issue #{number} of {repository}.',
                        'Build what {count} feature requests in {scope} ask for.'),
}


def scope_words(scope: Mapping[str, Any]) -> str:
    """The agent's scope in a few words: its categories' names (an administrator's configuration), at most three,
    else how many; "all reviews" for all."""
    if scope.get('all') is not False:
        names: list[str] = []
    else:
        names = [c for c in scope.get('categories') or [] if isinstance(c, str)]
        names += [f"{s.get('category')}/{s.get('name')}" for s in scope.get('subcategories') or []
                  if isinstance(s, Mapping)]
    if not names:
        return 'all reviews'
    return ', '.join(names) if len(names) <= 3 else f'{len(names)} categories'


def issue_sentence(feedback_type: str, repository: str, number: int, stage: str = 'act') -> str:
    """The goal sentence of a run of issue ``number``: its triage (7.50.00, a ``triage`` stage), else the work its
    agent's kind does."""
    if stage == 'triage':
        return triage_sentence(repository, number)
    return _WORK.get(feedback_type, _WORK['bug'])[0].format(number=number, repository=repository)


def triage_sentence(repository: str, number: int) -> str:
    return (f'Triage issue #{number} of {repository}: its kind, severity, priority, the code involved and its '
            'acceptance criteria, recorded with write_triage, commented and labelled on the issue.')


def reviews_sentence(feedback_type: str, count: int, scope: Mapping[str, Any]) -> str:
    return _WORK.get(feedback_type, _WORK['bug'])[1].format(count=count, scope=scope_words(scope))


def prd_sentence(project_id: str, document_id: str) -> str:
    return f'Build the feature the PRD {document_id} of project {project_id} describes.'


def hunt_sentence(repository: str) -> str:
    return f'Hunt for defects in {repository}.'


def run_goal(instructions: str, sentence: str) -> str:
    """The run's goal: the agent's instructions (its trusted start) and the sentence, on one line; 400 when longer
    than ``MAX_RUN_GOAL`` (refused, never cut)."""
    goal = ' '.join(f'{instructions} {sentence}'.split())
    if not goal or len(goal) > MAX_RUN_GOAL:
        raise ValidationError(f'the run\'s goal (the agent\'s instructions and what it is asked) is over '
                              f'{MAX_RUN_GOAL} characters: shorten the instructions')
    return goal


# --------------------------------------------------------------------------
# The request and the answer.
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Feedback:
    """What a run started from reviews carries of them: ids, their top category and how many (never text)."""

    ids: tuple[str, ...] = ()
    count: int = 0
    category: str | None = None

    def item(self) -> dict[str, Any]:
        return {'ids': list(self.ids[:MAX_FEEDBACK_IDS]), 'count': self.count, 'category': self.category}


@dataclass(frozen=True)
class StartPlan:
    """An engineering agent's run, as both callers start it: what it starts from and who asks."""

    run_id: str
    workflow_id: str
    flow: StoredFlow
    connection_id: str
    connection: Mapping[str, Any]
    language: str
    goal: str
    actor: str
    issue: int | None = None
    feedback: Feedback | None = None
    prd: Mapping[str, str] | None = None
    via: Mapping[str, str] | None = None


def start_request(plan: StartPlan) -> dict[str, Any]:
    """voc-engineering-start's ``start_run`` for an engineering agent's run: the flow as stored now, the stored
    connection's repository and branch, the deployment's caps and the flow's budget (required: an engineering agent's
    flow has one), the hard cap forced on (``hard_cap``: the run is capped at what is left of the flow's month even
    when the administrators' hard cap is off), the commit resolved by the start (the head of the connection's default
    branch, through the broker), and what the run started from (``issue``, ``feedback``, ``prd``) and by whom
    (``actor``, ``via``: the agent and its run, recorded on the run's first ``RUNLOG#`` row, D4). A flow read with its
    calls left in is refused (409): the runtime runs only a flat flow."""
    if plan.flow.calls:
        raise ConflictError(UNEXPANDED)
    request: dict[str, Any] = {
        'action': 'start_run', 'run_id': plan.run_id, 'flow': plan.workflow_id,
        'flow_definition': plan.flow.definition, 'flow_revision': plan.flow.revision,
        'connection': plan.connection_id, 'commit': '', 'resolve_commit': True, 'hard_cap': True,
        'language': plan.language, 'goal': plan.goal, 'actor': plan.actor,
        **run_connection(plan.connection, plan.issue), **run_caps(),
    }
    if plan.flow.budget_usd is not None:
        request['budget_usd'] = plan.flow.budget_usd
    if plan.feedback is not None:
        request['feedback'] = plan.feedback.item()
    if plan.prd is not None:
        request['prd'] = dict(plan.prd)
    if plan.via is not None:
        request['via'] = dict(plan.via)
    return request


Outcome = Literal['started', 'unreachable', 'refused', 'not_written', 'uncertain']


@dataclass(frozen=True)
class StartAnswer:
    """What came of a start: ``started`` (``payload``: ``{run_id, status}``), ``unreachable`` (the function never ran),
    ``refused`` (before anything was written, ``message`` in its words), ``not_written`` (known not written), or
    ``uncertain`` (written, or not known not to be: the run is opened, never started again)."""

    outcome: Outcome
    message: str = ''
    payload: Mapping[str, Any] | None = None


def _payload(response: Mapping[str, Any], run_id: str) -> dict[str, Any] | None:
    """The start's answer read off the connection; None when that read fails or it is not a JSON object (which says
    nothing of the write: the run may have been started)."""
    try:
        payload = json.loads(response['Payload'].read() or b'{}')
    except (ValueError, KeyError, OSError, BotoCoreError):
        logger.warning('engineering: the start\'s answer could not be read', extra={'run_id': run_id})
        return None
    return payload if isinstance(payload, dict) else None


@cache
def start_client() -> Any:
    """The Lambda client for the start function (built once per container): it waits ``START_READ_TIMEOUT_SECONDS``
    and never retries by itself."""
    import boto3
    from botocore.config import Config

    return boto3.client('lambda', config=Config(read_timeout=START_READ_TIMEOUT_SECONDS, connect_timeout=5,
                                                retries={'total_max_attempts': 1}))


def invoke_start(client: Any, function: str, request: Mapping[str, Any], *, run_id: str | None = None) -> StartAnswer:
    """``request`` sent to ``function`` (a synchronous invoke, never retried by the client) and what came of it.
    ``run_id``: the run the answer must name, when it is not the request's (7.51.00: a restart's child run)."""
    expected: str = run_id or request['run_id']
    try:
        response = client.invoke(FunctionName=function, InvocationType='RequestResponse',
                                 Payload=json.dumps(request).encode())
    except (EndpointConnectionError, ConnectTimeoutError, ClientError):
        # (never connected, or the service refused the call: the start function did not run)
        logger.exception('engineering: the start function could not be reached')
        return StartAnswer('unreachable')
    except BotoCoreError:
        # (a read timeout, a connection dropped mid-call: the start may have written the run)
        logger.warning('engineering: the run\'s start did not answer', extra={'run_id': expected})
        return StartAnswer('uncertain')
    payload = _payload(response, expected)
    if payload is None:
        return StartAnswer('uncertain')
    if response.get('FunctionError'):
        error_type, said = payload.get('errorType'), str(payload.get('errorMessage') or '')[:500]
        logger.warning('engineering: a start failed', extra={'run_id': expected, 'error_type': error_type})
        if error_type in START_REFUSALS:
            return StartAnswer('refused', said)
        if error_type in START_NOT_WRITTEN:
            return StartAnswer('not_written', said)
        return StartAnswer('uncertain', said if error_type in START_WRITTEN else '')
    if payload.get('run_id') != expected:
        return StartAnswer('uncertain')
    return StartAnswer('started', payload=payload)


def ask_start(client: Any, function: str, request: Mapping[str, Any], *, answers: frozenset[str], failed: str,
              again: str) -> dict[str, Any]:
    """A voc-engineering-start action other than a run's start (``invoke_start``), asked synchronously, and its answer:
    an ended run's reactions read (``ask_reactions``, 7.10.00, agents_handler.py) and the approved docs' pull request
    (``publish_docs``, 7.52.00, agents_engineering_knowledge_routes.py). Its refusal (``RuntimeRefused``) is
    ``ConflictError`` in its words; the function out of reach, any other failure, or an answer whose ``status`` is not
    one of ``answers``, is ``ServiceUnavailableError`` (``failed``, then ``again``: asking again is safe for both, each
    held by a create-only claim)."""
    try:
        response = client.invoke(FunctionName=function, InvocationType='RequestResponse',
                                 Payload=json.dumps(dict(request)).encode())
        payload = json.loads(response['Payload'].read() or b'{}')
    except (ClientError, BotoCoreError, ValueError, KeyError, OSError) as exc:
        logger.exception(f'engineering: {failed}')
        raise ServiceUnavailableError(f'the engineering runtime could not be reached: {again}') from exc
    answer: dict[str, Any] = payload if isinstance(payload, dict) else {}
    if response.get('FunctionError') and answer.get('errorType') == 'RuntimeRefused':
        raise ConflictError(str(answer.get('errorMessage') or 'the runtime refused it')[:500])
    if response.get('FunctionError') or answer.get('status') not in answers:
        raise ServiceUnavailableError(f'{failed}: {again}')
    return answer


@dataclass(frozen=True)
class IssueRef:
    """The GitHub issue a run starts from: its repository, number and the feedback item it was ingested as."""

    repository: str
    number: int
    feedback_id: str = ''


@dataclass(frozen=True)
class AgentStart:
    """What a trigger or an administrator's Run now asks of an engineering agent (``sentence``: the goal after its
    instructions). ``claim``: the issue's ``ISSUE_RUN#`` row must be free (a trigger: ``IssueClaimed`` otherwise); a Run
    now reruns an issue, taking the row only when it is free."""

    trigger: str
    requested_by: str
    actor: str
    sentence: str
    trigger_detail: Mapping[str, Any] | None = None
    issue: IssueRef | None = None
    feedback: Feedback | None = None
    prd: Mapping[str, str] | None = None
    claim: bool = True
    #: The issue's claim this run takes (7.50.00): ``act`` (the issue's run, 7.47.00's claim) or ``triage`` (the
    #: Issue triage automation's own claim beside it).
    stage: str = 'act'
    counts_against_daily_cap: bool = False
    daily_cap: int = 0
    extra_agent_sets: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class AgentRunStarted:
    """The agent's run (None: it already had one, or today's cap was used) and what its start answered."""

    run: dict[str, Any] | None
    answer: StartAnswer | None = None


_FAILED_START: Final[Mapping[str, str]] = {
    'unreachable': 'The engineering runtime could not be reached; nothing was started.',
    'not_written': 'The engineering run could not be started; nothing was written.',
}


def start_agent_run(table: Any, agent: Mapping[str, Any], workflow: Mapping[str, Any] | None,
                    connection: Mapping[str, Any], start: AgentStart, *, client: Any, function: str,
                    now: Any) -> AgentRunStarted:
    """Start an engineering agent's run: its run row (``kind: engineering``, the engineering run's id, the lock and,
    for an issue, its claim, in one transaction), then voc-engineering-start. A start refused or known not written
    fails the run (the claim stays: an issue starts one run, ever); one written, or that may have been, is ``running``
    until the heartbeat reads its engineering run's end. ``ValidationError`` / ``ConflictError`` before anything is
    written: a flow off its rule or without a monthly budget, a goal over its limit."""
    from shared import agents_store as store

    flow = stored_flow(workflow, revision_reader(table))
    if flow.budget_usd is None:
        raise ConflictError("the agent's flow has no monthly budget: set one in its Workflow tab before it runs")
    settings = agent.get('engineering') or {}
    goal = run_goal(str(agent.get('instructions') or ''), start.sentence)
    engineering_run_id, run_id = new_run_id(), store.new_run_id(now)
    fields: dict[str, Any] = {'kind': store.RUN_KIND_ENGINEERING, 'engineering_run_id': engineering_run_id}
    claim = None
    if start.issue is not None:
        fields['issue'] = {'repository': start.issue.repository, 'number': start.issue.number}
        claim = store.issue_claim_item(start.issue.repository, start.issue.number, agent_id=agent['agent_id'],
                                       run_id=run_id, engineering_run_id=engineering_run_id,
                                       feedback_id=start.issue.feedback_id, now=now, stage=start.stage)
    if start.prd is not None:
        fields['prd'] = dict(start.prd)
    if start.feedback is not None:
        fields['feedback_count'] = start.feedback.count
    if flow.expansion:   # (7.52.00: the calls its flow expanded, as the run's copy of it records them)
        fields['expansion'] = [dict(call) for call in flow.expansion]
    request = store.RunStart(
        trigger=start.trigger, requested_by=start.requested_by, workflow_revision=flow.revision,
        trigger_detail=start.trigger_detail, counts_against_daily_cap=start.counts_against_daily_cap,
        daily_cap=start.daily_cap, extra_agent_sets=start.extra_agent_sets, run_fields=fields, run_id=run_id,
        issue_claim=claim if start.claim else None)
    run = store.start_run(table, agent, request, now=now)
    if run is None:
        return AgentRunStarted(None)
    if claim is not None and not start.claim:
        store.claim_issue_if_free(table, claim)   # (a rerun keeps an earlier claim; a first run takes it)
    plan = StartPlan(run_id=engineering_run_id, workflow_id=str(agent.get('workflow_id')), flow=flow,
                     connection_id=str(settings.get('connection')), connection=connection,
                     language=str(settings.get('language')), goal=goal, actor=start.actor,
                     issue=None if start.issue is None else start.issue.number, feedback=start.feedback,
                     prd=start.prd, via={'agent_id': agent['agent_id'], 'agent_run_id': run_id, 'trigger': start.trigger})
    answer = invoke_start(client, function, start_request(plan))
    if answer.outcome in ('started', 'uncertain'):
        store.mark_engineering_running(table, agent['agent_id'], run_id)
        store.append_event(table, agent['agent_id'], run_id, 'decision',
                           f'Engineering run {engineering_run_id} started ({start.trigger})', now=now, role='system')
    else:
        reason = answer.message or _FAILED_START.get(answer.outcome, 'The engineering run was refused.')
        store.finish_run(table, agent['agent_id'], run_id, store.RUN_FAILED, now=now, error=reason)
        store.append_event(table, agent['agent_id'], run_id, 'decision', f'Engineering run not started: {reason}',
                           now=now, role='system')
    return AgentRunStarted(run, answer)


#: An engineering run's end (runtime/runs.py ``ENDED``), and its engineering agent's run's status for it
#: (agents_store's ``RUN_COMPLETED``, ``RUN_FAILED``, ``RUN_CANCELLED``; ``end_agent_run``, the heartbeat's heal).
AGENT_RUN_ENDS: Final[Mapping[str, str]] = {'done': 'completed', 'failed': 'failed', 'stopped': 'cancelled'}


def end_agent_run(table: Any, agent_id: str, run_id: str, status: str, *, now: Any) -> bool:
    """The engineering agent's run ``run_id`` of an engineering run that ended ``status`` (``done``, ``failed`` or
    ``stopped``): completed, failed or cancelled, the agent's lock released (``agents_store.finish_run``), with one
    ``decision`` event; False when it had ended already (idempotent). The heartbeat's lock heal ends it so when it reads
    the engineering run's end (agents/heartbeat/engineering.py ``heal``); since 7.50.03 the Agents API ends it so at
    once after a person's Stop, so the agent may run again without waiting for the next heartbeat."""
    from shared import agents_store as store
    if status not in AGENT_RUN_ENDS:
        raise ValueError(f'not an engineering run end: {status}')
    error = None if status == 'done' else f'The engineering run ended {status}'
    if store.finish_run(table, agent_id, run_id, AGENT_RUN_ENDS[status], now=now, error=error) is None:
        return False
    store.append_event(table, agent_id, run_id, 'decision', f'Engineering run {status}', now=now, role='system')
    return True


def feedback_of(items: Sequence[Mapping[str, Any]], count: int) -> Feedback:
    """The run's feedback from the items a trigger counted (at most ``MAX_FEEDBACK_IDS`` ids, their top category)."""
    ids = tuple(str(item['feedback_id']) for item in items if isinstance(item.get('feedback_id'), str))
    categories: dict[str, int] = {}
    for item in items:
        name = item.get('category')
        if isinstance(name, str) and name:
            categories[name] = categories.get(name, 0) + 1
    top = max(categories, key=lambda name: (categories[name], name)) if categories else None
    return Feedback(ids=ids[:MAX_FEEDBACK_IDS], count=count, category=top)
