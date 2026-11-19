"""A run's manifest and its entry in the transcripts' index (7.50.00): what the run was, where its transcripts are.

Written by voc-engineering-runtime when the run's record stops moving (its end, every agent ended; a run left at a
person past its flow's ``learn.after_needs_human_hours``), create-only, in voc-eng-workspace::

    ws/<ws>/runs/<run>/_manifest/v<nnnn>.json                   voc-run-manifest/1: the flow and its revision, the
                                                                day, the run's status, its agents and their sessions
                                                                (role, flow step, skill, model, tokens, cost,
                                                                session time), its models' tokens, the run's
                                                                tokens and cost, and every agent's transcript
                                                                prefix and outputs
    ws/<ws>/transcripts-index/<flow>/<yyyy-mm-dd>/<run>.json    voc-transcripts-index/1: the run by its flow and the
                                                                day it started (the owner's browsing), and its
                                                                manifest's key

A run seen again (a resumed run that ends after its sweep) gets the next manifest version; its index entry is written
once. ``_manifest`` cannot be an agent's prefix (an agent id starts with a letter or digit), so the runtime's grant on
it reaches no agent's keys, and no agent's on it (each writes only its own prefix). No text of the run's (a task's
title, a model's words) is in either: ids, numbers, labels and keys only. Kept forever, as the transcripts.
"""
from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final, Protocol

from engineering.runtime.checkpoints import artifact_prefix
from engineering.runtime.interface import check_id
from engineering.runtime.runs import Run
from engineering.spend import keyable
from shared.dynamo_values import as_text as _text

MANIFEST_SCHEMA: Final = 'voc-run-manifest/1'
INDEX_SCHEMA: Final = 'voc-transcripts-index/1'
#: A run without a flow, in the index.
NO_FLOW: Final = 'no-flow'
MAX_VERSIONS: Final = 50
MAX_AGENTS: Final = 200


class Writer(Protocol):
    def put_once(self, key: str, body: str, content_type: str) -> bool: ...


def manifest_key(run_id: str, version: int) -> str:
    return f'ws/default/runs/{check_id("run_id", run_id)}/_manifest/v{version:04d}.json'


def index_key(flow: str, day: str, run_id: str) -> str:
    return f'ws/default/transcripts-index/{flow if keyable(flow) else NO_FLOW}/{day}/{check_id("run_id", run_id)}.json'


def _number(item: Mapping[str, Any], name: str) -> int:
    value = item.get(name)
    return int(value) if isinstance(value, int | Decimal) and not isinstance(value, bool) else 0


def _tokens(item: Mapping[str, Any]) -> dict[str, dict[str, int]]:
    raw = item.get('tokens')
    if not isinstance(raw, Mapping):
        return {}
    return {str(model): {'in': _number(counts, 'in'), 'out': _number(counts, 'out')}
            for model, counts in raw.items() if isinstance(counts, Mapping)}


@dataclass(frozen=True)
class Manifest:
    body: dict[str, Any]

    @property
    def day(self) -> str:
        return str(self.body['day'])


def build(run: Run, agents: Sequence[Mapping[str, Any]], tasks: Sequence[Any], *, revision: int,
          learn_spend: Mapping[str, Any] | None = None, at: datetime | None = None) -> Manifest:
    """The run's manifest from its META (``run``), its agents' session rows (plain values, as the resource table
    reads them) and its board's tasks (their recorded outputs)."""
    models: dict[str, dict[str, int]] = {}
    rows = []
    # (each agent's flow step, from its task: the cross-run Learn pass's step figures, 7.53.00; '' for none)
    steps = {str(getattr(task, 'task_id', '')): str(getattr(task, 'flow_step', '') or '') for task in tasks}
    for item in sorted(agents, key=lambda row: _text(row, 'sk'))[:MAX_AGENTS]:
        agent = _text(item, 'sk').removeprefix('AGENT#')
        if 'seq' not in item or not agent:
            continue   # (a launch hold: no session)
        tokens = _tokens(item)
        for model, counts in tokens.items():
            summed = models.setdefault(model, {'in': 0, 'out': 0})
            summed['in'] += counts['in']
            summed['out'] += counts['out']
        commit, attempt = _text(item, 'commit'), _number(item, 'task_attempt') or 1
        try:
            transcripts = artifact_prefix(run.run_id, agent, commit, attempt, 'transcripts')
        except Exception:  # noqa: BLE001 - a row off its shape names no transcript, and the manifest still stands
            transcripts = ''
        rows.append({'agent': agent, 'role': _text(item, 'role'), 'task': _text(item, 'task_id'),
                     'step': steps.get(_text(item, 'task_id'), ''), 'attempt': attempt, 'status': _text(item, 'status'), 'model': _text(item, 'model'),
                     'skill': _text(item, 'skill_version'), 'tokens': tokens,
                     'cost_usd': str(item.get('cost_usd', 0)),
                     'session_seconds': _number(item, 'microvm_seconds'), 'continuations': _number(item, 'continuation'),
                     'transcripts': transcripts})
    learn = dict(learn_spend or {})
    cost = sum((Decimal(row['cost_usd']) for row in rows), Decimal(0)) + Decimal(str(learn.get('cost_usd', 0)))
    started = datetime.fromtimestamp(run.started_at, UTC)
    outputs = sorted({key for task in tasks for key in getattr(task, 'result_keys', ())})
    body = {'schema': MANIFEST_SCHEMA, 'run_id': run.run_id, 'status': run.status,
            'flow': {'id': run.flow, 'revision': revision}, 'repo': run.repo, 'connection': run.connection,
            'commit': run.commit, 'started_at': started.isoformat(), 'day': started.strftime('%Y-%m-%d'),
            'written_at': (at or datetime.now(UTC)).isoformat(), 'agents': rows, 'models': models,
            'tokens': sum(counts['in'] + counts['out'] for counts in models.values()),
            'cost_usd': str(cost), 'learn': learn,
            'keys': {'transcripts': [row['transcripts'] for row in rows if row['transcripts']],
                     'outputs': outputs[:500]}}
    return Manifest(body)


def write(store: Writer, manifest: Manifest) -> tuple[str, bool]:
    """The manifest as its run's next version, and the run's index entry (once); the manifest's key, and whether
    the index entry was written now."""
    run_id = str(manifest.body['run_id'])
    text = json.dumps(manifest.body, sort_keys=True)
    for version in range(1, MAX_VERSIONS + 1):
        key = manifest_key(run_id, version)
        if store.put_once(key, text, 'application/json'):
            break
    else:
        raise RuntimeError(f'run {run_id} has {MAX_VERSIONS} manifests already')
    flow = str(manifest.body['flow']['id'])
    entry = {'schema': INDEX_SCHEMA, 'run_id': run_id, 'flow': flow, 'day': manifest.day,
             'status': manifest.body['status'], 'started_at': manifest.body['started_at'], 'manifest': key}
    indexed = store.put_once(index_key(flow, manifest.day, run_id), json.dumps(entry, sort_keys=True),
                             'application/json')
    return key, indexed
