"""A step's assertions, evaluated and recorded on the board side (7.51.00).

A flow template's step carries ``assert`` (orchestration/assertions.py: a closed vocabulary of checks on what the step
RECORDED). The local runner evaluates them on its fake run; a deployed run's are evaluated here, by the board, each time
the run coordinator reads its flow (``FlowGuard.view``), for every step the conductor says is done and that has no
record yet at its attempt: one create-only row ``WS#<ws>#RUN#<run>`` / ``ASSERT#<step>#<attempt>`` (``{kind:
step_assertions, step, attempt, results: [{check, status, detail, on_fail}], by, at}``, D1, D4). The step's attempt
is one more than the people's decisions on it (a person's Resume at its decision point gives it another try).

What a check reads is what the board reads back, never what a model said: the step's tasks and the tasks its agents
posted, the outputs its tasks recorded (their result keys, read through ``read``: the findings' and notes' lines, the
submitted patches, the gate records, a triage, a tenets draft (7.52.00), a reviewer's verdict (7.54.00); never a
transcript or a checkpoint), the broker's done writes of the run
(its pushes, pull requests and labels: ``WS#<ws>#WRITES#<run>``), the run's issue and the flow's ``pr``. A check whose
input the board does not keep (a pull request's body and draft state, a comment, a coach proposal) is recorded
``unread``, never guessed. A record is the record only: the conductor does not block on it yet; the run workspace's
Assertions tab shows it.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.board.model import Task
from engineering.flow.conductor import DONE, Plan
from engineering.orchestration.assertions import Recorded, evaluate, problems
from engineering.rows import run_pk, string_attr
from engineering.run_links import writes_pk
from engineering.runtime.outputs import REVIEW_FILE
from shared.aws import is_conditional_check_failure
from shared.dynamo_paging import query_all
from shared.logging import logger
from shared.workflow_engineering import flow_settings

PREFIX: Final = 'ASSERT#'
PASS, FAIL, UNREAD = 'pass', 'fail', 'unread'
#: The checks whose inputs the board does not keep: recorded unread.
UNREAD_CHECKS: Final = frozenset({'pr.state_as_flow', 'pr.links_issue', 'review.commented', 'triage.commented',
                                  'learn.proposals_name_case'})
MAX_OBJECT_BYTES: Final = 6 * 1024 * 1024
MAX_DETAIL: Final = 300
Read = Callable[[str, int], bytes | None]


def assert_sk(step: str, attempt: int) -> str:
    return f'{PREFIX}{step}#{attempt}'


def _lines(body: bytes) -> list[dict[str, Any]]:
    found = []
    for raw in body.decode('utf-8', 'replace').splitlines():
        try:
            line = json.loads(raw)
        except ValueError:
            continue
        if isinstance(line, dict):
            found.append(line)
    return found


def _object(body: bytes) -> dict[str, Any]:
    """A record's JSON object; an empty one for a body that is not (a reviewer's unreadable verdict is no pass)."""
    try:
        found = json.loads(body)
    except ValueError:
        return {}
    return found if isinstance(found, dict) else {}


def _writes(client: Any, table: str, ws: str, run_id: str) -> list[dict[str, Any]]:
    """The broker's done writes of the run (its claim rows): their operation and result."""
    rows = query_all(client, {'TableName': table, 'ConsistentRead': True,
                              'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :prefix)',
                              'ExpressionAttributeValues': {':pk': {'S': writes_pk(ws, run_id)},
                                                            ':prefix': {'S': 'WRITE#'}}}, max_items=1000)
    done = []
    for row in rows:
        if string_attr(row, 'state') != 'done':
            continue
        try:
            result = json.loads(string_attr(row, 'result') or '{}')
        except ValueError:
            continue
        if isinstance(result, dict):
            done.append({'op': string_attr(row, 'op'), **result})
    return done


def recorded(step: str, tasks: Sequence[Task], read: Read, writes: Iterable[Mapping[str, Any]], *,
             issue: int | None, pr_setting: str) -> Recorded:
    """What ``step`` recorded, as the assertions read it (the local runner's ``LocalRun.recorded``, from the board)."""
    mine = [task for task in tasks if task.flow_step == step]
    agents = {task.launched_agent for task in mine if task.launched_agent}
    posted = tuple((task.role, task.posted_by.rsplit('-', 1)[0]) for task in tasks if task.posted_by in agents)
    findings: list[Mapping[str, Any]] = []
    notes: list[Mapping[str, Any]] = []
    patches: list[str] = []
    gates: list[Mapping[str, Any]] = []
    triage: Mapping[str, Any] | None = None
    tenets: Mapping[str, Any] | None = None
    reviews: list[Mapping[str, Any]] = []
    for task in mine:
        for key in task.result_keys:
            if '/_transcripts/' in key or '/_checkpoints/' in key:
                continue   # (never read here: the board's role has no grant on them either)
            body = read(key, MAX_OBJECT_BYTES)
            if body is None:
                continue
            if '/_patches/' in key:
                patches.append(body.decode('utf-8', 'replace'))
            elif key.endswith('/record.json'):
                gates.append({**json.loads(body), 'by': task.role})
            elif '/_triage/' in key:
                triage = json.loads(body)
            elif '/_tenets/' in key:
                tenets = json.loads(body)
            elif '/_review/' in key and key.endswith(f'/{REVIEW_FILE}'):
                reviews.append({**_object(body), 'by': task.role})
            elif key.endswith('.jsonl'):
                for line in _lines(body):
                    (notes if str(line.get('schema', '')).startswith('voc-note/') else findings).append(
                        {**line, 'by': task.role})
    done = list(writes)
    pushes = tuple({'branch': w.get('branch'), 'tree': w.get('tree_hash')} for w in done if w['op'] == 'push_bundle')
    pulls = tuple({'number': w.get('number'), 'head': w.get('head')} for w in done
                  if w['op'] == 'open_or_update_draft_pr')
    labels = tuple(str(label) for w in done if w['op'] == 'label_issue' for label in w.get('labels', ()))
    return Recorded(findings=tuple(findings), notes=tuple(notes), posted=posted, patches=tuple(patches),
                    gate_records=tuple(gates), pushes=pushes, pull_requests=pulls, labels=labels, triage=triage,
                    tenets=tenets, reviews=tuple(reviews), issue=issue, pr_setting=pr_setting)


def results(assertions: Sequence[Mapping[str, Any]], seen: Recorded) -> list[dict[str, str]]:
    """Each assertion's result: ``pass``, ``fail`` or ``unread`` (its inputs not kept by the board), with its detail."""
    out = []
    for assertion in assertions:
        check, on_fail = str(assertion.get('check')), str(assertion.get('on_fail', 'block'))
        if problems(assertion):
            out.append({'check': check, 'status': UNREAD, 'detail': 'not an assertion of the vocabulary',
                        'on_fail': on_fail})
        elif check in UNREAD_CHECKS:
            out.append({'check': check, 'status': UNREAD, 'detail': 'the board does not keep what this check reads',
                        'on_fail': on_fail})
        else:
            result = evaluate(assertion, seen)
            out.append({'check': check, 'status': PASS if result.passed else FAIL, 'detail': result.detail[:MAX_DETAIL],
                        'on_fail': result.on_fail})
    return out


def record_assertions(client: Any, table: str, ws: str, run_id: str, plan: Plan, tasks: Sequence[Task],
                      rows: Iterable[Mapping[str, Any]], meta: Mapping[str, Any] | None, definition: object,
                      read: Read, *, actor: str, at: str) -> int:
    """Record the assertions of each done step that has none at its attempt (create-only); how many were written.
    Best effort: a step whose record fails is logged, and the next read of the flow tries again."""
    decisions: dict[str, int] = {}
    for row in rows:
        if string_attr(row, 'record') == 'decision':
            decisions[string_attr(row, 'step')] = decisions.get(string_attr(row, 'step'), 0) + 1
    due = [(step, 1 + decisions.get(step, 0)) for step, state in plan.steps.items()
           if state.status == DONE and plan.flow.steps[step].params.get('assert')]
    if not due:
        return 0
    issue = (meta or {}).get('issue', {}).get('M', {}).get('number', {}).get('N')
    pr_setting = str(flow_settings(definition)['pr'])
    writes: list[dict[str, Any]] | None = None
    written = 0
    for step, attempt in due:
        key = {'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': assert_sk(step, attempt)}}
        if client.get_item(TableName=table, Key=key, ConsistentRead=True).get('Item') is not None:
            continue
        try:
            if writes is None:
                writes = _writes(client, table, ws, run_id)
            seen = recorded(step, tasks, read, writes, issue=int(issue) if issue else None, pr_setting=pr_setting)
            listed = results(list(plan.flow.steps[step].params.get('assert') or ()), seen)
            client.put_item(TableName=table, ConditionExpression='attribute_not_exists(sk)', Item={
                **key, 'kind': {'S': 'step_assertions'}, 'step': {'S': step}, 'attempt': {'N': str(attempt)},
                'results': {'S': json.dumps(listed, sort_keys=True)}, 'by': {'S': actor}, 'at': {'S': at}})
            written += 1
        except ClientError as error:
            if not is_conditional_check_failure(error):
                logger.exception('board: a step\'s assertions were not recorded', extra={'step': step})
        except Exception:   # (a record that cannot be made never fails the coordinator's read of its flow)
            logger.exception('board: a step\'s assertions could not be evaluated', extra={'step': step})
    return written

