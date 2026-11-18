"""What the run workspace's overview adds to the run monitor's (7.51.00; engineering/monitor.py ``overview``).

- Per agent, from its session row (``AGENT#<agent>``): its cost so far (``cost_usd``: its session time and, since
  7.50.00, its tokens at their prices, with the brokers' metering), the attempt and commit it works on, its skill's
  label and its model, since 7.52.00 the Registry card its step was made from (``card``, ``card_version``: None for a
  role's own step), and ``transcript_cursor``: the cursor that opens its thread at its transcript's end
  (views_thread.TAIL; None for an agent with no transcript to read); and (7.51.04) why it last failed, as the
  supervisor's inspection data holds it: ``last_exit`` (its failed command's exit code, whether it timed out, how long
  it ran and its stderr's tail; never its stdout) and ``last_failure`` (the supervisor's own words: "the boot took too
  long"), each shown as the thread shows text (redacted, no control character: views_thread.display) and bounded,
  None for none.
- (7.51.04) A run at a person: ``waiting_detail``, the plain reason its supervisor gave for it (META's
  ``needs_human_detail``, written since 7.51.03 beside the decision point, as at ``checkout_failed``: "The repository
  checkout failed (git clone, exit 128): …"), shown the same way; None for none, and for a run that is not at a person
  (a reason kept from an earlier wait says nothing of the run now).
- The calls the run's flow expanded (7.52.00, ``expansion``: its copy's record, shared/flow_expand.py), so the canvas
  regroups a call's ``<call>.<step>`` steps under it.
- The lanes: each flow step's tasks (``flow_step``) with the agent on each (its holder, else the agent launched for its
  attempt) and that agent's status, the canvas's sibling nodes of a stage.
- The run's cost: its agents' and Learn's (``LEARN#spend``, learning/budget.py), against its cost cap.
- Its parent (META's ``parent {run_id, mode, by, at}``: a run restarted from an ended one, written by the start's
  ``restart_run``) and its children (``CHILD#<child>`` rows of its partition).
- An ended run's manifest (``ws/default/runs/<run>/_manifest/v<nnnn>.json``, runtime/manifest.py): its newest version's
  key, cost and tokens, the run's record once it stopped moving. The role lists nothing under ``_manifest/``, so the
  versions are read in turn until one is not there (S3 answers it 403, read here as missing and counted nowhere).
"""
from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from decimal import Decimal, InvalidOperation
from typing import Any, Final

from boto3.dynamodb.types import TypeDeserializer

from engineering.board.model import PERSON_PREFIX, Task
from engineering.rows import amount_attr, string_attr
from engineering.run_objects import RunObjects
from engineering.runtime.manifest import MAX_VERSIONS, manifest_key
from engineering.runtime.sessions import AgentSession
from engineering.views_thread import TAIL, Subject, display

MAX_CHILDREN: Final = 50
_DESERIALIZE: Final = TypeDeserializer()
#: (7.51.04) The longest stderr tail and reason the overview shows (the supervisor keeps 500 characters of a tail).
MAX_STDERR: Final = 500
MAX_REASON: Final = 500
#: META's plain reason for a run at a person (7.51.03, and its ``RUNLOG#`` row's ``detail``), beside ``needs_human``
#: (the decision point it waits at).
NEEDS_HUMAN_DETAIL: Final = 'needs_human_detail'


def usd(value: Decimal) -> float:
    return float(round(value, 6))


def agent_extras(run_id: str, session: AgentSession, row: Mapping[str, Any] | None) -> dict[str, Any]:
    """The run workspace's fields of an agent, from its session and its row (a low-level item)."""
    row = row or {}
    subject = Subject(run_id=run_id, agent=session.agent_id, role=session.role, task_id=session.task_id,
                      attempt=session.task_attempt, commit=session.commit, status=session.status)
    version = string_attr(row, 'card_version')
    return {'cost_usd': usd(amount_attr(row, 'cost_usd')), 'attempt': session.task_attempt,
            'commit': session.commit or None, 'skill_label': string_attr(row, 'skill_version') or None,
            'model': string_attr(row, 'model') or None,
            # (7.52.00) The Registry card its step was made from, as its launch recorded it (None: a role's own step).
            'card': string_attr(row, 'card') or None,
            'card_version': int(version) if version.isdigit() and version[0] != '0' else None,
            'transcript_cursor': TAIL if subject.transcripts else None,
            'last_exit': last_exit(session.inspect),
            'last_failure': shown(session.inspect.get('last_failure'), MAX_REASON)}


def shown(value: Any, limit: int) -> str | None:
    """A stored text as a person reads it (views_thread.display: redacted, no control character), cut to ``limit``;
    None for none."""
    if not isinstance(value, str):
        return None
    text = display(value).strip()
    if not text:
        return None
    return text if len(text) <= limit else f'{text[:limit - 1]}…'


def _whole(value: Any) -> int | None:
    return int(value) if isinstance(value, int | float | Decimal) and not isinstance(value, bool) else None


def last_exit(inspect: Mapping[str, Any]) -> dict[str, Any] | None:
    """The agent's last failed command (the supervisor's ``last_exit``: ``{exit_code, timed_out, duration_seconds,
    stderr_tail}``, its stderr shown and bounded), None for none."""
    raw = inspect.get('last_exit')
    if not isinstance(raw, Mapping):
        return None
    return {'exit_code': _whole(raw.get('exit_code')), 'timed_out': raw.get('timed_out') is True,
            'duration_seconds': _whole(raw.get('duration_seconds')),
            'stderr_tail': shown(raw.get('stderr_tail'), MAX_STDERR) or ''}


def waiting_detail(meta: Mapping[str, Any]) -> str | None:
    """Why a run at a person is there, in the plain words its supervisor gave (7.51.03); None for none, and for a run
    that is not at a person."""
    if string_attr(meta, 'status') != 'needs_human':
        return None
    return shown(string_attr(meta, NEEDS_HUMAN_DETAIL), MAX_REASON)


def _agent_of(task: Task) -> str:
    """The agent on a task: its holder when that is an agent, else the one launched for its attempt ('' for none)."""
    if task.lease_agent and not task.lease_agent.startswith(PERSON_PREFIX):
        return task.lease_agent
    return task.launched_agent if task.launched_attempt == task.attempt else ''


def lanes(tasks: Sequence[Task], agents: Sequence[Mapping[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Each flow step's tasks, in the order they were posted (their ids are ULIDs: ``{step: [{agent, role, status,
    state, task_id, attempt, shard}]}``); a task posted for no step is in none."""
    status = {str(agent['agent']): agent['status'] for agent in agents}
    found: dict[str, list[dict[str, Any]]] = {}
    for task in sorted(tasks, key=lambda task: task.task_id):
        if not task.flow_step:
            continue
        agent = _agent_of(task)
        found.setdefault(task.flow_step, []).append({
            'agent': agent or None, 'role': task.role, 'status': status.get(agent), 'state': task.state,
            'task_id': task.task_id, 'attempt': task.attempt, 'shard': task.shard or None})
    return found


def run_cost(meta: Mapping[str, Any], agents: Sequence[Mapping[str, Any]],
             learn: Mapping[str, Any] | None) -> dict[str, Any]:
    """The run's cost so far (its agents' and Learn's) and its cost cap (None: uncapped)."""
    learned = amount_attr(learn or {}, 'cost_usd')
    total = sum((Decimal(str(agent['cost_usd'])) for agent in agents), Decimal(0)) + learned
    try:
        cap = Decimal(string_attr(meta, 'max_cost_usd')) if string_attr(meta, 'max_cost_usd') else None
    except InvalidOperation:
        cap = None
    return {'cost_usd': usd(total), 'learn_cost_usd': usd(learned),
            'cost_cap_usd': usd(cap) if cap is not None and cap.is_finite() and cap > 0 else None}


def _plain(value: Any) -> Any:
    """A typed attribute value (``{'M': {...}}``, as the low-level client reads it) as plain data."""
    try:
        return _DESERIALIZE.deserialize(value)
    except (TypeError, ValueError, InvalidOperation):
        return None


def _text(raw: Mapping[str, Any], name: str) -> str | None:
    value = raw.get(name)
    return value[:200] if isinstance(value, str) and value else None


def parent(meta: Mapping[str, Any]) -> dict[str, Any] | None:
    """The run it was restarted from (``{run_id, mode, by, at}``), None for a run of its own."""
    raw = _plain(meta['parent']) if isinstance(meta.get('parent'), Mapping) else None
    if not isinstance(raw, Mapping) or not _text(raw, 'run_id'):
        return None
    return {name: _text(raw, name) for name in ('run_id', 'mode', 'by', 'at')}


def children(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The runs restarted from it (its ``CHILD#<child>`` rows), oldest first."""
    found = [{'run_id': string_attr(row, 'sk').removeprefix('CHILD#'), 'mode': string_attr(row, 'mode') or None,
              'by': string_attr(row, 'by') or None, 'at': string_attr(row, 'at') or None} for row in rows]
    return sorted(found, key=lambda child: (child['at'] or '', child['run_id']))[:MAX_CHILDREN]


def manifest(objects: RunObjects | None, run_id: str) -> dict[str, Any] | None:
    """An ended run's newest manifest (``{key, version, cost_usd, tokens, written_at}``), None for none (yet)."""
    if objects is None:
        return None
    found: tuple[int, str, bytes] | None = None
    for version in range(1, MAX_VERSIONS + 1):
        key = manifest_key(run_id, version)
        read = objects.read(key, 0, 1024 * 1024, quiet=True)
        if read is None:
            break
        found = (version, key, read.body)
    if found is None:
        return None
    try:
        body = json.loads(found[2])
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    try:
        cost = usd(Decimal(str(body.get('cost_usd', '0'))))
    except InvalidOperation:
        cost = None
    tokens = body.get('tokens')
    return {'key': found[1], 'version': found[0], 'cost_usd': cost,
            'tokens': tokens if isinstance(tokens, int) and not isinstance(tokens, bool) else None,
            'written_at': _text(body, 'written_at')}
