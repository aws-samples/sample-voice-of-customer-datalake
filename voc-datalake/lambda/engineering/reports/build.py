"""Building a report (``voc-report/1``) from what the run recorded (plan v3, CHANGE 2 G; E2: cost on every report).

The three levels share one shape and differ in what they cover:

- ``commit`` (subject: the commit's sha): the findings the agents recorded for that commit;
- ``pr`` (subject: the pull request's number, with its head commit): every finding of the run, the task tree, and
  the quality gate's record for the head commit (an ended final-go task's ``_gate/…/record.json`` under that
  commit), whose Markdown goes into the pull request's description;
- ``goal`` (subject: the run id): the whole run.

A report reads only the keys the board recorded on the run's tasks (never a listing of the workspace), names the
agents and skill versions that made it, and carries the run's metering (events, MicroVM-seconds, tokens, the cost the
brokers priced) and time. It holds code findings, not customer text: the finding reader has already redacted them.
"""
from __future__ import annotations

import dataclasses
import json
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from engineering.board.model import DONE, NEEDS_HUMAN, Move, Task
from engineering.quality_gate.record import GateRecord
from engineering.reports.facts import RunFacts
from engineering.workspace.findings import Finding, parse_shard
from engineering.workspace.layout import AgentKey, parse_agent_key

SCHEMA = 'voc-report/1'
#: The findings a report lists (the most severe first); its counts cover all of them.
TOP_FINDINGS = 20
GATE_RECORD = 'record.json'
#: A final-go task's record counts once the task has ended with a verdict: ``done``, or ``needs_human`` (the gate
#: stopped at a person's decision; who decided comes from the run's decision, not from the record).
GATE_STATES = frozenset({DONE, NEEDS_HUMAN})


@dataclass(frozen=True)
class Located:
    """A finding with the shard it came from."""

    key: AgentKey
    finding: Finding


@dataclass(frozen=True)
class Inputs:
    facts: RunFacts
    tasks: tuple[Task, ...]
    findings: tuple[Located, ...]
    #: Per shard, the lines off the schema it had.
    skipped: tuple[tuple[AgentKey, int], ...]
    gate: GateRecord | None
    #: Per task, its moves (the board's history rows), oldest first.
    history: Mapping[str, Sequence[Move]] = dataclasses.field(default_factory=dict)
    #: The winning gate record (the last final-go task to end, then its latest attempt) was recorded but could not be
    #: read (a denial, or an object never written) or is off the schema: a PR report is refused then (handler.py), so
    #: its description never drops it nor shows an older one in its place. A later attempt's good record wins over it.
    unread_gate: bool = False


def _gate_key(task: Task, key: AgentKey, head: str) -> bool:
    """The gate record of an ended final-go task, for the pull request's head commit."""
    return (key.kind == 'gate' and key.name == GATE_RECORD and key.sha == head and task.role == 'final-go'
            and task.state in GATE_STATES)


def gather(facts: RunFacts, tasks: Iterable[Task], read: Callable[[str], str | None], *, head: str = '',
           history: Mapping[str, Sequence[Move]] | None = None) -> Inputs:
    """The run's findings, and for a pull request (``head``: its head commit) the gate record that vouches for it.

    Only the objects a report uses are read (``read``: key -> text or None): the finding shards, and the gate records
    of ended final-go tasks under ``head``, of which the last task to end (then its latest attempt) wins.
    """
    tasks = tuple(tasks)
    located: list[Located] = []
    skipped: list[tuple[AgentKey, int]] = []
    # The winning gate record so far, None when it could not be read or is off the schema.
    gate: tuple[tuple[str, int], GateRecord | None] | None = None
    seen: set[str] = set()
    for task in tasks:
        # A key recorded on two tasks (one agent's attempt holds both) is one object: read and counted once (marked
        # seen when read, so a task that does not want it does not hide it from one that does).
        for raw in sorted(set(task.result_keys) - seen):
            key = parse_agent_key(raw)
            if key is None or not (key.package or _gate_key(task, key, head)):
                continue
            seen.add(raw)
            text = read(raw)
            if key.package:
                if text is not None:
                    found, bad = parse_shard(text)
                    located += [Located(key, finding) for finding in found]
                    skipped.append((key, bad))
                continue
            order = (task.updated_at, key.attempt)
            if gate is None or order >= gate[0]:
                gate = (order, None if text is None else _gate_record(text))
    return Inputs(facts=facts, tasks=tasks, findings=tuple(located), skipped=tuple(skipped),
                  gate=None if gate is None else gate[1], history=dict(history or {}),
                  unread_gate=gate is not None and gate[1] is None)


def _gate_record(text: str) -> GateRecord | None:
    """The record as the gate wrote it, but who accepted the change: the run's decision says that (D4), not an agent."""
    try:
        return dataclasses.replace(GateRecord.from_dict(json.loads(text)), accepted_by='')
    except ValueError:   # json.JSONDecodeError is one too
        return None


def _seconds(start: str, end: str) -> int | None:
    try:
        return max(0, int((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds()))
    except (ValueError, TypeError):   # not a time, or one with an offset and one without
        return None


def _findings(located: Iterable[Located], skipped: int) -> dict[str, Any]:
    ordered = sorted(located, key=lambda item: item.finding.rank)
    return {
        'total': len(ordered), 'skipped_lines': skipped,
        'by_severity': dict(Counter(item.finding.severity for item in ordered)),
        'top': [{'file': item.finding.file, 'line': item.finding.line, 'severity': item.finding.severity,
                 'rule': item.finding.rule, 'title': item.finding.title, 'evidence': item.finding.evidence,
                 'package': item.key.package, 'commit': item.key.sha, 'agent': item.key.agent}
                for item in ordered[:TOP_FINDINGS]],
    }


def _gate(record: GateRecord | None) -> dict[str, Any] | None:
    if record is None:
        return None
    final = record.final_go
    return {'verdict': record.verdict, 'tree_hash': record.tree_hash, 'rounds': len(record.rounds),
            'max_rounds': record.max_rounds, 'final_go': None if final is None else ('GO' if final.go else 'NO-GO'),
            'open_blocking': sum(f.blocking and record.outcome(f)[0] == 'open' for f in record.findings)}


def build_report(level: str, subject: str, inputs: Inputs, *, version: int, built_at: str,
                 head: str = '') -> dict[str, Any]:
    """``head``: a pull request's head commit (its report's gate record is the one for that commit)."""
    facts = inputs.facts
    located = [item for item in inputs.findings if level != 'commit' or item.key.sha == subject]
    skipped = sum(count for key, count in inputs.skipped if level != 'commit' or key.sha == subject)
    agents = facts.agents
    report: dict[str, Any] = {
        'schema': SCHEMA, 'level': level, 'ws': facts.ws, 'run_id': facts.run_id, 'subject': subject,
        'version': version, 'built_at': built_at, 'head': head or None,
        'run': {'goal': facts.goal, 'repo': facts.repo, 'flow': facts.flow, 'status': facts.status},
        'agents': [{'agent': a.agent, 'role': a.role, 'skill_version': a.skill_version, 'model': a.model}
                   for a in agents],
        'cost': {'events': facts.events, 'microvm_seconds': sum(a.microvm_seconds for a in agents),
                 'input_tokens': sum(a.input_tokens for a in agents),
                 'output_tokens': sum(a.output_tokens for a in agents),
                 'usd': str(sum((a.cost_usd for a in agents), Decimal(0))),
                 # The run's flow budget and its flag (None: no budget): measured, never a stop.
                 'budget': facts.budget},
        'time': {'started_at': facts.started_at, 'ended_at': facts.ended_at,
                 'seconds': _seconds(facts.started_at, facts.ended_at)},
        'tasks': {'by_state': dict(Counter(task.state for task in inputs.tasks))},
        'findings': _findings(located, skipped),
        'gate': _gate(inputs.gate) if level == 'pr' else None,
    }
    if level != 'commit':
        report['tasks']['tree'] = [{
            'task_id': t.task_id, 'parent_task': t.parent_task or None, 'role': t.role, 'title': t.title,
            'state': t.state, 'attempt': t.attempt,
            'history': [move.view() for move in inputs.history.get(t.task_id, ())]}
            for t in inputs.tasks]
    return report
