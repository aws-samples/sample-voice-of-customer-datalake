"""``voc-resume-seed/1`` (7.51.00): what an agent of a child run starts from, when a person resumes or restarts an ended run.

An ended run (done, failed, stopped, past its 30 days or out of budget) is never reopened: a person's Resume or Restart
starts a child run (``runtime/restart.py``), and the runtime's ``seed_restart`` writes, for each task the parent left
unfinished, one seed under the CHILD's own run keys, create-only::

    ws/<ws>/runs/<child>/_seed/<parent task>/seed.json     this record (at most ``MAX_SEED_BYTES``)
    ws/<ws>/runs/<child>/_seed/<parent task>/patch.diff    the parent's newest working tree (or its submitted patch)

The child's task for it names the record in its spec (``seed_key``). The agent's role reads its run's keys only
(lib/stacks/engineering-runtime.ts ``RUN_KEYS``), and the harness takes a seed key only under its own run's
``_seed/`` (``check_seed_key``): a seed never reaches another run's agent. The record holds no token, no credential and
no customer text: the parent's checkpoint fields (``position``, ``plan``, ``notes``, as checkpoints.py takes them), a
history of the parent's attempt (``excerpts``: its transcript's last events as short lines, learning/transcripts.py;
or, past ``SUMMARY_EVENTS`` events or ``SUMMARY_BYTES`` of transcript, a ``summary`` by Learn's model, charged to the
child), the steering people gave the parent (each relayed instruction, its time and who), and the approved memories
it recalled (their ids). Every text in it is data from a repository, a model or a person: the harness fences it as data
(the steering in its own steering block), never as an instruction of the platform.

Shipped in the agents' images with the harness (standard library only, Python 3.11).
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Final

from engineering.connectors.identity import WORKSPACE
from engineering.runtime.checkpoints import SHA, assert_storable
from engineering.runtime.interface import RuntimeRefused, check_id
from engineering.runtime.tokens import TokenNotStorable

SCHEMA: Final = 'voc-resume-seed/1'
MAX_SEED_BYTES: Final = 256 * 1024
SEED_FILE: Final = 'seed.json'
PATCH_FILE: Final = 'patch.diff'
#: Past these, the parent attempt's history is a summary by Learn's model rather than its excerpts.
SUMMARY_EVENTS: Final = 40
SUMMARY_BYTES: Final = 200 * 1024
HISTORY_KINDS: Final = frozenset({'excerpts', 'summary'})
#: The bounds of the record's texts (a person's steering is at most 1 KB on the bus).
MAX_LINES: Final = 40
MAX_LINE: Final = 1_500
MAX_SUMMARY: Final = 8_000
MAX_STEERING: Final = 50
MAX_STEER_TEXT: Final = 1_024
MAX_MEMORY_IDS: Final = 50
MAX_NOTES: Final = 16_000
MAX_PLAN: Final = 50
#: How the child's base was chosen: the parent's commit, or the default branch's head when the child started.
BASES: Final = frozenset({'same', 'head'})
#: A memory's id as a seed lists it, at most.
MAX_MEMORY_ID: Final = 128


class SeedError(ValueError):
    """A record that is not a seed this harness takes (the session then starts afresh, said on its status)."""


def _is_id(value: object) -> bool:
    """A run, agent or task id as the runtime takes one (``interface.check_id``)."""
    try:
        return isinstance(value, str) and bool(check_id('id', value))
    except RuntimeRefused:
        return False


def seed_prefix(run_id: str) -> str:
    """The run's seeds: ``ws/<ws>/runs/<run>/_seed/`` (``_`` never begins an agent id, so no agent's own keys)."""
    if not _is_id(run_id):
        raise SeedError('a run id is an id')
    return f'ws/{WORKSPACE}/runs/{run_id}/_seed/'


def seed_key(run_id: str, parent_task: str) -> str:
    if not _is_id(parent_task):
        raise SeedError('a task id is an id')
    return f'{seed_prefix(run_id)}{parent_task}/{SEED_FILE}'


def patch_key(run_id: str, parent_task: str) -> str:
    if not _is_id(parent_task):
        raise SeedError('a task id is an id')
    return f'{seed_prefix(run_id)}{parent_task}/{PATCH_FILE}'


def check_seed_key(key: object, run_id: str) -> str:
    """``key`` when it is a seed record of run ``run_id`` (its own ``_seed/``, one task's ``seed.json``), else
    ``SeedError``: a seed key outside the agent's own run is refused."""
    prefix = seed_prefix(run_id)
    if not isinstance(key, str) or not key.startswith(prefix) or '..' in key.split('/'):
        raise SeedError('a seed key is under the run\'s own _seed/')
    task, _, name = key.removeprefix(prefix).partition('/')
    if not _is_id(task) or name != SEED_FILE:
        raise SeedError('a seed key names one task\'s seed.json')
    return key


def _text(value: object, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ''


def _no_secret(value: object) -> bool:
    """No key in ``value`` names a secret (checkpoints.py's rule)."""
    try:
        assert_storable(value)
    except TokenNotStorable:
        return False
    return True


def _parent(raw: object) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise SeedError('parent is {run_id, agent_id, task_id, attempt, commit}')
    attempt = raw.get('attempt')
    ids = [raw.get(name) for name in ('run_id', 'task_id')]
    agent = raw.get('agent_id')
    if not all(_is_id(value) for value in ids) or not (agent == '' or _is_id(agent)) or not (
            isinstance(attempt, int) and not isinstance(attempt, bool) and attempt >= 0) or not (
            isinstance(raw.get('commit'), str) and SHA.fullmatch(raw['commit'])):
        raise SeedError('parent is {run_id, agent_id, task_id, attempt, commit}')
    return {'run_id': raw['run_id'], 'agent_id': agent, 'task_id': raw['task_id'], 'attempt': attempt,
            'commit': raw['commit']}


def _task(raw: object) -> dict[str, str]:
    if not isinstance(raw, Mapping) or not all(isinstance(raw.get(name, ''), str) for name in
                                               ('role', 'title', 'instructions', 'flow_step', 'shard')):
        raise SeedError('task is {role, title, instructions, flow_step, shard}')
    return {'role': raw.get('role', ''), 'title': raw.get('title', '')[:500],
            'instructions': raw.get('instructions', '')[:16_384], 'flow_step': raw.get('flow_step', '')[:64],
            'shard': raw.get('shard', '')[:512]}


def _checkpoint(raw: object) -> dict[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, Mapping) or not _no_secret(raw):
        raise SeedError('checkpoint is {position, plan, notes} or null, naming no secret')
    plan = raw.get('plan')
    position = raw.get('position')
    return {'position': dict(position) if isinstance(position, Mapping) else {},
            'plan': [str(item)[:500] for item in plan[:MAX_PLAN]] if isinstance(plan, list) else [],
            'notes': _text(raw.get('notes'), MAX_NOTES)}


def _history(raw: object) -> dict[str, Any]:
    if not isinstance(raw, Mapping) or raw.get('kind') not in HISTORY_KINDS:
        raise SeedError('history is {kind: excerpts, lines} or {kind: summary, text, model, tokens}')
    if raw['kind'] == 'excerpts':
        lines = raw.get('lines')
        if not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
            raise SeedError('excerpts are lines of text')
        return {'kind': 'excerpts', 'lines': [line[:MAX_LINE] for line in lines[-MAX_LINES:]]}
    tokens = raw.get('tokens', 0)
    if not isinstance(raw.get('text'), str) or not isinstance(raw.get('model', ''), str) or not (
            isinstance(tokens, int) and not isinstance(tokens, bool) and tokens >= 0):
        raise SeedError('a summary is {text, model, tokens}')
    return {'kind': 'summary', 'text': raw['text'][:MAX_SUMMARY], 'model': raw.get('model', '')[:200],
            'tokens': tokens}


def _steering(raw: object) -> list[dict[str, str]]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_STEERING or not all(
            isinstance(item, Mapping) and all(isinstance(item.get(name), str) for name in ('at', 'by', 'text'))
            for item in raw):
        raise SeedError(f'steering is at most {MAX_STEERING} {{at, by, text}}')
    return [{'at': item['at'][:40], 'by': item['by'][:200], 'text': item['text'][:MAX_STEER_TEXT]} for item in raw]


def checked(record: object, run_id: str) -> dict[str, Any]:
    """``record`` as a seed of run ``run_id`` (its fields bounded as the schema says), else ``SeedError``. The patch
    it names is under the same run's ``_seed/`` (``''``: none)."""
    if not isinstance(record, Mapping) or record.get('schema') != SCHEMA:
        raise SeedError(f'not a {SCHEMA} record')
    patch = record.get('patch_key') or ''
    if patch and (not isinstance(patch, str) or not patch.startswith(seed_prefix(run_id))
                  or '..' in patch.split('/') or not patch.endswith(f'/{PATCH_FILE}')):
        raise SeedError('the patch is under the run\'s own _seed/')
    base = record.get('base', 'same')
    if base not in BASES:
        raise SeedError(f'base is one of {sorted(BASES)}')
    memory = record.get('memory_ids', [])
    if not isinstance(memory, list) or not all(isinstance(item, str) and 0 < len(item) <= MAX_MEMORY_ID
                                               for item in memory):
        raise SeedError('memory_ids are ids')
    return {'schema': SCHEMA, 'parent': _parent(record.get('parent')), 'task': _task(record.get('task')),
            'checkpoint': _checkpoint(record.get('checkpoint')), 'patch_key': patch, 'base': base,
            'history': _history(record.get('history')), 'steering': _steering(record.get('steering')),
            'memory_ids': list(memory[:MAX_MEMORY_IDS])}


def encode(record: Mapping[str, Any], run_id: str) -> bytes:
    """The record checked and written as compact JSON; ``SeedError`` over ``MAX_SEED_BYTES`` (the writer cuts the
    history first: ``runtime/restart.py``)."""
    body = json.dumps(checked(record, run_id), separators=(',', ':'), sort_keys=True).encode()
    if len(body) > MAX_SEED_BYTES:
        raise SeedError(f'a seed is at most {MAX_SEED_BYTES} bytes')
    return body


def parse(body: bytes, run_id: str) -> dict[str, Any] | None:
    """The seed in ``body`` (checked), None for one that is not."""
    if len(body) > MAX_SEED_BYTES:
        return None
    try:
        return checked(json.loads(body), run_id)
    except (ValueError, SeedError):
        return None
