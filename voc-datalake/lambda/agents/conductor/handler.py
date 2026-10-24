"""Conductor Lambda — the Step Functions ``voc-agent-run`` brain (surface ``agent_orchestrator``).

KiroCrew's conductor, serverless: it owns the run, walks the workflow graph,
briefs each crewmate through an enveloped ``[sent by conductor]`` transcript
row, VERIFIES every claimed result independently (re-reading the project as
the agent) before it commits it to the run context, enforces loops / max
rounds / a step ceiling / the model-call budget, escalates to ``needs_human``
and writes the run's event journal. It never does the work itself.

Actions (``event.action``):

- ``init``    ``{agent_id, run_id}`` → queued → running, pin the workflow revision,
  dispatch the first node.
- ``advance`` ``{agent_id, run_id, node}`` → judge one node result and decide next.
- ``fail``    ``{agent_id, run_id, error}`` → the state machine's catch-all.
- ``plan_decide`` / ``plan_prepare`` / ``plan_record`` / ``plan_fail`` ``{plan_id, step_id?, …}`` →
  an approved assistant plan (``plan_decide.py``, ``plan_execution.py``; docs/assistant-plan-mode.md).

Every answer is a ``next`` directive for the state machine::

    {kind: 'execute', node_id, node_type, mate_seq}
    {kind: 'wait', node_id, node_type, pending, wait_seconds}
    {kind: 'finish', status}
"""
from __future__ import annotations

import json
from typing import Any

from agents import pins, principal, run_memory, store
from agents.conductor import plan_decide, plan_execution, planning, resume
from agents.failure_reason import VERIFICATION_FAILURE, document_label, failure_summary
from agents.fields import dict_field, list_field
from agents.graph import FAILING_OUTCOMES, Node, WorkflowError, WorkflowGraph
from agents.runtime import load_graph, resolve_workflow
from shared import agent_run_decisions as decisions
from shared.aws import get_dynamodb_resource
from shared.invocation_cost import instrumented_handler
from shared.logging import logger
from shared.warm_init import warm_at_init

ENVELOPE_PREFIX = '[sent by conductor]'
WAIT_SECONDS = 30
MAX_POLLS_PER_NODE = 120          # 120 x 30 s = one hour per async node
MAX_STEPS = decisions.MAX_STEPS_PER_RUN   # executed nodes per run, loops included (120)
MAX_CONTEXT_BYTES = 120_000       # the run row stays far below DynamoDB's 400 KB
REVISION_TYPES = frozenset({'revise_document', 'revise_prototype'})
# Cleared with the first dispatch after a resume (a redriven init before it still resumes).
RESUME_ATTRIBUTES = ('resume', 'needs_human')


class _Finish(Exception):
    def __init__(self, status: str, message: str, needs_human: dict | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.needs_human = needs_human


# ---------------------------------------------------------------------------
# Directives and finishing
# ---------------------------------------------------------------------------

def _finish(agent_id: str, run_id: str, status: str, message: str, needs_human: dict | None = None) -> dict:
    payload = needs_human if status == store.RUN_NEEDS_HUMAN else None
    extra = {'needs_human': payload} if payload is not None else {}
    if store.finish_run(agent_id, run_id, status, None if status == store.RUN_COMPLETED else message, **extra):
        kind = 'message' if status == store.RUN_COMPLETED else 'decision'
        store.append_event(agent_id, run_id, kind, message)
        run_memory.enqueue_finished_run(agent_id, run_id, status)
    else:
        _settle_left_running(agent_id, run_id)
    return {'kind': 'finish', 'status': status}


def _settle_left_running(agent_id: str, run_id: str) -> dict:
    """The run left RUNNING elsewhere (a cancel): stop without writing over it."""
    run = store.get_run(agent_id, run_id) or {}
    if run.get('status') == store.RUN_CANCELLED:
        store.mark_cancelled_finished(agent_id, run_id)
    return {'kind': 'finish', 'status': run.get('status') or store.RUN_CANCELLED}


def _envelope(run: dict, agent: dict, node: Node, steps: int, brief: str) -> str:
    context = dict_field(run, 'context')
    documents = dict_field(context, 'documents')
    lines = [
        ENVELOPE_PREFIX,
        f"Run {run['run_id']} · step {steps}: {node.title} ({node.type})",
    ]
    if isinstance(agent.get('instructions'), str) and agent['instructions'].strip():
        lines += ['', 'Agent instructions:', agent['instructions'].strip()[:8000]]
    if node.instructions:
        lines += ['', 'Step instructions:', node.instructions]
    so_far = [f"project {context['project_id']}"] if context.get('project_id') else []
    so_far += [f'{kind}={doc}' for kind, doc in sorted(documents.items())]
    if so_far:
        lines += ['', 'Run so far: ' + ', '.join(so_far)]
    if brief:
        lines += ['', 'Revision brief (from the persona panel, via the conductor):', brief]
    return '\n'.join(lines)


def _revision_brief(agent: dict, run: dict, node: Node, context: dict) -> str:
    target = 'prototype' if node.type == 'revise_prototype' else str(
        node.params.get('target') or context.get('last_review_target') or 'prfaq')
    try:
        brief = planning.revision_brief(agent, run['run_id'], target, list_field(context, 'last_verdicts'))
    except store.BudgetExhausted as exc:
        raise _Finish(store.RUN_NEEDS_HUMAN, 'The run spent its model-call budget.',
                      resume.payload(decisions.REASON_BUDGET, node)) from exc
    return resume.with_human_note(brief, context)


def _dispatch(agent: dict, run: dict, node: Node, loop_rounds: dict, fan_out: dict[str, list[str]]) -> dict:
    """Brief ``node``'s crewmate and tell the state machine to run it.

    ``fan_out`` carries the branches still queued and the nodes already run
    (``pending_nodes`` / ``done_nodes``), persisted with the dispatch, which also
    clears a resume's bookkeeping and hands a waiting human note to a revision.
    """
    agent_id, run_id = agent['agent_id'], run['run_id']
    if node.type == 'end':
        if node.params.get('status') == store.RUN_NEEDS_HUMAN:
            return _finish(agent_id, run_id, store.RUN_NEEDS_HUMAN, f'{node.title}: the workflow asks for a human.',
                           resume.payload(decisions.REASON_END_NODE, node))
        return _finish(agent_id, run_id, store.RUN_COMPLETED, 'Workflow completed.')
    if node.type == 'start':
        raise _Finish(store.RUN_FAILED, 'The workflow loops back to its start node.')
    steps = int(run.get('steps') or 0) + 1
    limit = int(run.get('step_ceiling') or MAX_STEPS)
    if steps > limit:
        raise _Finish(store.RUN_FAILED, f'Stopped after {limit} steps.')
    brief = ''  # pragma: no mutate  None is as falsy as '' in `_envelope`'s `if brief:`
    sets: dict[str, Any] = {}
    if node.type in REVISION_TYPES:
        context = dict_field(run, 'context')
        brief = _revision_brief(agent, run, node, context)
        if resume.HUMAN_NOTE_KEY in context:
            sets['context'] = {k: v for k, v in context.items() if k != resume.HUMAN_NOTE_KEY}
    envelope = _envelope(run, agent, node, steps, brief)
    mate_seq = store.append_mate(agent_id, run_id, node.role, node.id, 'to_mate', envelope)
    stale = tuple(a for a in RESUME_ATTRIBUTES if a in run)
    store.update_running(agent_id, run_id, {
        'current_node_id': node.id, 'poll_attempts': 0, 'steps': steps, 'loop_rounds': loop_rounds,
        **fan_out, **sets,
    }, **({'remove': stale} if stale else {}))
    store.append_event(agent_id, run_id, 'node_started', node.title, node_id=node.id, role=node.role)
    return {'kind': 'execute', 'node_id': node.id, 'node_type': node.type, 'mate_seq': mate_seq}


# ---------------------------------------------------------------------------
# Verification — never trust a crewmate's claim
# ---------------------------------------------------------------------------

def verify(result: dict, claims: dict[str, str]) -> str | None:
    """None when every claimed artifact exists and is visible to the agent; else why not."""
    claimed = dict_field(result, 'artifacts')
    project_id = claimed.get('project_id')
    if not project_id:
        return None
    try:
        project = principal.get_project(project_id, claims)
    except principal.RouteError as exc:
        return f'project {project_id} is not readable by the agent (HTTP {exc.status_code})'
    document_id = claimed.get('document_id')
    if document_id:
        documents = {d.get('document_id'): d for d in project.get('documents') or [] if isinstance(d, dict)}
        document = documents.get(document_id)
        if document is None:
            return f'document {document_id} is not in project {project_id}'
        expected = claimed.get('document_type')
        if expected and document.get('document_type') not in (expected, None):
            return f'document {document_id} is not a {expected}'
    persona_ids = claimed.get('persona_ids')
    if isinstance(persona_ids, list) and persona_ids:
        known = {p.get('persona_id') for p in project.get('personas') or [] if isinstance(p, dict)}
        missing = [pid for pid in persona_ids if pid not in known]
        if missing:
            return f'{len(missing)} claimed persona(s) are not in project {project_id}'
    return None


# ---------------------------------------------------------------------------
# Committing a verified result
# ---------------------------------------------------------------------------

def _merged_context(run: dict, updates: Any) -> dict:
    context = dict(run.get('context') or {})
    if isinstance(updates, dict):
        context.update(updates)
    if len(json.dumps(context, default=str).encode()) > MAX_CONTEXT_BYTES:
        raise _Finish(store.RUN_FAILED, 'The run context grew beyond its size limit.')
    return context


def _capitalised(text: str) -> str:
    return text[:1].upper() + text[1:]


def _record_result(agent_id: str, run_id: str, node: Node, result: dict) -> None:
    summary = str(result.get('summary') or node.title)
    claimed = dict_field(result, 'artifacts')
    ref = {k: claimed.get(k) for k in ('project_id', 'document_id') if isinstance(claimed.get(k), str)}
    store.append_mate(agent_id, run_id, node.role, node.id, 'from_mate', summary)
    store.append_event(agent_id, run_id, 'node_finished', summary, node_id=node.id, role=node.role, ref=ref)
    if claimed.get('document_id'):
        store.append_event(agent_id, run_id, 'artifact',
                           f"{_capitalised(document_label(claimed.get('document_type') or 'document'))} ready",
                           node_id=node.id, ref=ref)
    updates = dict_field(result, 'updates')
    if node.type == 'persona_review':
        for verdict in updates.get('last_verdicts') or []:
            store.append_event(
                agent_id, run_id, 'verdict',
                f"{verdict.get('name')}: {verdict.get('score')}/5"
                f"{', blocking' if verdict.get('blocking') else ''}"
                f"{', would use' if verdict.get('would_use') else ''}",
                node_id=node.id, role='persona', ref={'persona_id': verdict.get('persona_id')},
            )


def _ordered_ids(value: Any) -> list[str]:
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def _pick_next(graph: WorkflowGraph, queue: list[str], done: set[str]) -> Node | None:
    """The next queued node to run: one whose forward predecessors all ran.

    End nodes go last, so a fan-out finishes every branch before the run ends.
    A join whose missing predecessor can never run (its branch was not taken)
    would otherwise wait forever, so with nothing ready the oldest entry runs.
    """
    nodes = [graph.node(node_id) for node_id in queue]
    ready = [n for n in nodes if graph.forward_predecessors(n.id) <= done]
    for pool in (ready, nodes):
        chosen = next((n for n in pool if n.type != 'end'), None) or (pool[0] if pool else None)
        if chosen is not None:
            return chosen
    return None


def _count_round(agent: dict, run: dict, graph: WorkflowGraph, node: Node, loop_rounds: dict) -> None:
    """A gate failed: advance its loop's round counter, or stop for a human at the last round."""
    loop = graph.gating_loop(node)
    if loop is None:
        return
    key = str(loop.index)
    loop_rounds[key] = int(loop_rounds.get(key) or 0) + 1
    if loop_rounds[key] >= loop.max_rounds:
        raise _Finish(store.RUN_NEEDS_HUMAN, f'{node.title}: no agreement after {loop.max_rounds} round(s).',
                      resume.payload(decisions.REASON_LOOP_EXHAUSTED, node, loop=loop,
                                     context=dict_field(run, 'context')))
    store.append_event(agent['agent_id'], run['run_id'], 'decision',
                       f'{node.title}: round {loop_rounds[key]} of {loop.max_rounds} failed; revising.',
                       node_id=node.id)


def _next_after(agent: dict, run: dict, graph: WorkflowGraph, node: Node, outcome: str | None, *,
                count_round: bool = True) -> dict:
    loop_rounds = dict(run.get('loop_rounds') or {})
    if outcome in FAILING_OUTCOMES and count_round:
        _count_round(agent, run, graph, node, loop_rounds)
    done = {*_ordered_ids(run.get('done_nodes')), node.id}
    queue = [n for n in _ordered_ids(run.get('pending_nodes')) if n != node.id]
    successors = graph.next_nodes(node.id, outcome)
    if not successors and outcome in FAILING_OUTCOMES:
        # No fail path, so "another round" could not run: the payload names no loop.
        raise _Finish(store.RUN_NEEDS_HUMAN, f'{node.title} did not pass and the workflow has no fail path.',
                      resume.payload(decisions.REASON_NO_FAIL_PATH, node, context=dict_field(run, 'context')))
    queue += [s.id for s in successors if s.id not in queue]
    chosen = _pick_next(graph, queue, done)
    if chosen is None:
        raise _Finish(store.RUN_FAILED, f'{node.title} has no next step.')
    queue.remove(chosen.id)
    return _dispatch(agent, run, chosen, loop_rounds,
                     fan_out={'pending_nodes': queue, 'done_nodes': sorted(done)})


def _resolve_reviewed_pins(agent: dict, run_id: str, node: Node, outcome: Any, context: dict) -> dict:
    """After a passing prototype review, resolve the tester pins earlier revisions addressed.

    Never before: a revision only ADDRESSES pins (agents/pins.py). A group whose
    resolve call failed stays pending for the next passing review.
    """
    if not pins.addressed_groups(context) or not pins.passed_prototype_review(node.type, outcome, context):
        return context
    remaining, resolved = pins.resolve_addressed(principal.agent_claims(agent), context)
    if resolved:
        store.append_event(agent['agent_id'], run_id, 'decision',
                           f'{node.title} passed: {resolved} tester pin(s) resolved.', node_id=node.id)
    return {**context, pins.ADDRESSED_KEY: remaining}


def _advance(agent: dict, run: dict, graph: WorkflowGraph, result: dict) -> dict:
    agent_id, run_id = agent['agent_id'], run['run_id']
    node = graph.node(str(result.get('node_id') or ''))
    if node.id != run.get('current_node_id'):
        raise _Finish(store.RUN_FAILED, 'A step reported for a node that is not running.')
    status = result.get('status')
    if status == 'pending':
        polls = int(run.get('poll_attempts') or 0) + 1
        if polls > MAX_POLLS_PER_NODE:
            raise _Finish(store.RUN_FAILED, f'{node.title} timed out.')
        store.update_running(agent_id, run_id, {'poll_attempts': polls})
        return {'kind': 'wait', 'node_id': node.id, 'node_type': node.type,
                'pending': result.get('pending'), 'wait_seconds': WAIT_SECONDS}
    if status != 'done':
        message = str(result.get('summary') or 'The step failed.')
        store.append_event(agent_id, run_id, 'node_failed', message, node_id=node.id, role=node.role,
                           detail=result.get('detail'))
        if result.get('error') == 'budget_exhausted':
            raise _Finish(store.RUN_NEEDS_HUMAN, 'The run spent its model-call budget.',
                          resume.payload(decisions.REASON_BUDGET, node))
        raise _Finish(store.RUN_FAILED, failure_summary(node.title, result.get('summary')))
    problem = verify(result, principal.agent_claims(agent))
    if problem:
        store.append_event(agent_id, run_id, 'node_failed', VERIFICATION_FAILURE,
                           node_id=node.id, role=node.role, detail=f'Verification failed: {problem}')
        raise _Finish(store.RUN_NEEDS_HUMAN, f'{node.title}: the claimed result could not be verified.',
                      resume.payload(decisions.REASON_VERIFICATION, node))
    context = _merged_context(run, result.get('updates'))
    context = _resolve_reviewed_pins(agent, run_id, node, result.get('outcome'), context)
    sets: dict[str, Any] = {'context': context}
    if isinstance(context.get('project_id'), str):
        sets['project_id'] = context['project_id']
    store.update_running(agent_id, run_id, sets)
    _record_result(agent_id, run_id, node, result)
    if result.get('halt'):
        return _finish(agent_id, run_id, store.RUN_COMPLETED, str(result.get('summary') or 'Nothing to do.'))
    run = {**run, 'context': context}
    return _next_after(agent, run, graph, node, result.get('outcome'))


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

def _load(event: dict) -> tuple[dict, dict]:
    agent_id, run_id = str(event.get('agent_id') or ''), str(event.get('run_id') or '')
    agent = store.get_agent(agent_id)
    run = store.get_run(agent_id, run_id)
    if not agent or not run:
        raise LookupError('agent or run not found')
    return agent, run


def _resume(agent: dict, run: dict, graph: WorkflowGraph, revision: int) -> dict:
    """Continue a resumed run from the gate its ``needs_human`` payload names (agents/conductor/resume.py)."""
    agent_id, run_id = agent['agent_id'], run['run_id']
    order = dict_field(run, 'resume')
    decision = order.get('decision')
    gate = graph.node(str(dict_field(run, 'needs_human').get('node_id') or ''))
    context = dict_field(run, 'context')
    note = order.get('note')
    if isinstance(note, str) and note.strip():
        context = {**context, resume.HUMAN_NOTE_KEY: note.strip()}
    loop_rounds = dict(run.get('loop_rounds') or {})
    if decision == decisions.DECISION_ANOTHER_ROUND:
        loop = graph.gating_loop(gate)
        if loop is None:
            raise _Finish(store.RUN_FAILED, f'{gate.title} is not inside a loop; another round cannot run.')
        loop_rounds[str(loop.index)] = loop.max_rounds - 1
        outcome = resume.failing_outcome(gate)
    elif decision == decisions.DECISION_ACCEPT:
        outcome = resume.passing_outcome(gate)
    else:
        raise _Finish(store.RUN_FAILED, 'The run was resumed with an unknown decision.')
    store.update_running(agent_id, run_id, {'context': context, 'loop_rounds': loop_rounds})
    store.append_event(agent_id, run_id, 'message', f'Run resumed ({decision}), workflow revision {revision}.')
    run = {**run, 'context': context, 'loop_rounds': loop_rounds}
    return _next_after(agent, run, graph, gate, outcome, count_round=False)


def init(event: dict) -> dict:
    agent, run = _load(event)
    agent_id, run_id = agent['agent_id'], run['run_id']
    if run.get('status') not in (store.RUN_QUEUED, store.RUN_RUNNING):
        return _settle_left_running(agent_id, run_id)
    pinned = run.get('workflow_revision')  # a redriven execution keeps its revision
    graph, revision = resolve_workflow(agent, pinned if isinstance(pinned, int) else None)
    try:
        run = store.start_run(agent_id, run_id, revision)
    except store.RunNotRunning:
        return _settle_left_running(agent_id, run_id)
    if isinstance(run.get('resume'), dict):
        return _resume(agent, run, graph, revision)
    store.append_event(agent_id, run_id, 'message',
                       f"Run started ({run.get('trigger') or 'manual'}), workflow revision {revision}.")
    if not graph.next_nodes(graph.start.id, None):
        raise _Finish(store.RUN_FAILED, 'The workflow has no step after start.')
    return _next_after(agent, run, graph, graph.start, None)


def advance(event: dict) -> dict:
    agent, run = _load(event)
    if run.get('status') != store.RUN_RUNNING:
        return _settle_left_running(agent['agent_id'], run['run_id'])
    result = dict_field(event, 'node')
    return _advance(agent, run, load_graph(agent, run), result)


def fail(event: dict) -> dict:
    """The state machine's catch-all. Records the error NAME only (a Cause may hold content)."""
    error = dict_field(event, 'error')
    name = str(error.get('Error') or 'Error')[:100]
    return _finish(str(event.get('agent_id') or ''), str(event.get('run_id') or ''),
                   store.RUN_FAILED, f'The run stopped on an internal error ({name}).')


def _plan_fail(event: dict) -> dict:
    """The plan branch's catch-all. Records the error NAME only (a Cause may hold content)."""
    name = str(dict_field(event, 'error').get('Error') or 'Error')[:100]
    return plan_decide.stop(str(event.get('plan_id') or ''), f'The plan stopped on an internal error ({name}).')


# Plan runs (``{run_kind: 'plan', plan_id}``, docs/assistant-plan-mode.md): the state machine's plan branch.
_PLAN_ACTIONS = {
    'plan_decide': lambda event: plan_decide.decide(str(event.get('plan_id') or '')),
    'plan_prepare': lambda event: plan_execution.prepare(str(event.get('plan_id') or ''),
                                                         str(event.get('step_id') or '')),
    'plan_record': lambda event: plan_execution.record(str(event.get('plan_id') or ''),
                                                       str(event.get('step_id') or ''),
                                                       event.get('result'), event.get('error')),
    'plan_fail': _plan_fail,
}
_ACTIONS = {'init': init, 'advance': advance, 'fail': fail}


def handle(event: dict) -> dict:
    plan_action = _PLAN_ACTIONS.get(str(event.get('action') or ''))
    if plan_action is not None:
        return store.plain(plan_action(event))
    action = _ACTIONS.get(str(event.get('action') or ''))  # pragma: no mutate  any non-action key misses alike
    if action is None:
        raise ValueError('unknown conductor action')
    agent_id, run_id = str(event.get('agent_id') or ''), str(event.get('run_id') or '')
    try:
        return store.plain(action(event))
    except _Finish as stop:
        return _finish(agent_id, run_id, stop.status, stop.message, stop.needs_human)
    except store.RunNotRunning:
        return _settle_left_running(agent_id, run_id)
    except store.BudgetExhausted:
        node_id = str((store.get_run(agent_id, run_id) or {}).get('current_node_id') or '')
        return _finish(agent_id, run_id, store.RUN_NEEDS_HUMAN, 'The run spent its model-call budget.',
                       resume.bare_payload(decisions.REASON_BUDGET, node_id))
    except WorkflowError as exc:
        return _finish(agent_id, run_id, store.RUN_FAILED, f'Workflow error: {exc}')


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource)


@instrumented_handler
def lambda_handler(event: object, context: Any) -> dict:
    directive = handle(event if isinstance(event, dict) else {})
    logger.info('Conductor directive', extra={'kind': directive.get('kind'), 'status': directive.get('status')})
    return directive
