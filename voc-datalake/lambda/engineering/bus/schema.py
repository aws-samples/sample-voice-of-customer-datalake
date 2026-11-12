"""``voc-msg/1``: the one schema of every message on the engineering bus, checked in code.

EventBridge does not validate what it carries, so every producer (``publish``) and the router (``router``) parse each
message here and refuse anything else. A message is a notification, never the record (the board and the
conversation are): it carries ids, a short summary and the S3 keys of its payload (the claim-check pattern), never
findings, diffs, logs, tokens or customer text, and it stays far under EventBridge's 256 KB (billed per 64 KB).
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from engineering.quality_gate.text import redact

SCHEMA = 'voc-msg/1'
#: One event, serialized: a quarter of a 64 KB billing unit (the payload lives in S3).
MAX_EVENT_BYTES = 16 * 1024
MAX_SUMMARY_BYTES = 1024
#: The roles that claim tasks (plan v3, 4.2: a posted task is addressed to one), and so the agent roles that may
#: speak on the bus. There are no queues: a posted task's notice is recorded by the delivery function for the
#: role's agents to read (it wakes nobody). The IAM catalog (connectors.identity AGENT_ROLES) has three more, none
#: of which claims tasks: the coordinator, which plans the run on the board and speaks on the bus as the run's
#: conductor (its own source); the coach; and the gate-runner. Adding one here lets tasks be posted for it and gives
#: it a voice.
ROLES = frozenset({'understander', 'hunter', 'fixer', 'committer', 'commit-reviewer', 'pr-author', 'pr-reviewer',
                   'builder', 'final-go', 'mapper'})
FROM_KINDS = frozenset({'agent', 'conductor', 'supervisor', 'human', 'system'})
TO_KINDS = frozenset({'role', 'agent', 'conductor', 'run'})
TYPES = frozenset({
    'task.posted', 'task.claimed', 'task.progress', 'task.review', 'task.done', 'task.failed', 'task.needs_human',
    'msg.question', 'msg.answer', 'msg.finding', 'msg.handoff',
    'review.requested', 'review.result',
    'gate.go', 'gate.no_go',
    'run.started', 'run.health', 'run.paused', 'run.resumed', 'run.ended',
    'signal.save', 'signal.pause', 'signal.resume', 'signal.shutdown', 'signal.stop_now',
    'skill.proposed', 'skill.accepted', 'skill.rolled_back',
    'outcome.pr_opened', 'outcome.accepted', 'outcome.merged', 'outcome.closed', 'outcome.reverted',
    'outcome.review_posted',
})
FIELDS = frozenset({'schema', 'event_id', 'ws', 'run_id', 'thread_id', 'task_id', 'attempt', 'from', 'to', 'type',
                    'summary', 'refs', 'at'})
REF_KEYS = frozenset({'s3', 'commit', 'pr', 'files'})
#: A run, thread, task or party id; and a workspace (the workspace's key layout, workspace/layout.py, takes both).
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z')
#: A ULID (an event id; a run id, which the skills store's reasons name too).
ULID = re.compile(r'[0-9A-HJKMNP-TV-Z]{26}\Z')
WS = re.compile(r'[a-z0-9][a-z0-9-]{0,62}\Z')
_SHA = re.compile(r'[0-9a-f]{7,64}\Z')
_AT = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\Z')


class MessageError(ValueError):
    """A message that does not follow voc-msg/1 (the router drops it and journals why)."""


@dataclass(frozen=True)
class Party:
    kind: str
    id: str


@dataclass(frozen=True)
class Refs:
    s3: tuple[str, ...] = ()
    commit: str = ''
    pr: int = 0
    files: tuple[str, ...] = ()


@dataclass(frozen=True)
class Message:
    event_id: str
    ws: str
    run_id: str
    thread_id: str
    attempt: int
    sender: Party
    to: Party
    type: str
    summary: str
    at: str
    task_id: str = ''
    refs: Refs = field(default_factory=Refs)

    def to_dict(self) -> dict[str, Any]:
        refs: dict[str, Any] = {'s3': list(self.refs.s3)}
        if self.refs.commit:
            refs['commit'] = self.refs.commit
        if self.refs.pr:
            refs['pr'] = self.refs.pr
        if self.refs.files:
            refs['files'] = list(self.refs.files)
        out: dict[str, Any] = {
            'schema': SCHEMA, 'event_id': self.event_id, 'ws': self.ws, 'run_id': self.run_id,
            'thread_id': self.thread_id, 'attempt': self.attempt,
            'from': {'kind': self.sender.kind, 'id': self.sender.id}, 'to': {'kind': self.to.kind, 'id': self.to.id},
            'type': self.type, 'summary': self.summary, 'refs': refs, 'at': self.at}
        if self.task_id:
            out['task_id'] = self.task_id
        return out

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), separators=(',', ':'), sort_keys=True)


def _text(data: Mapping[str, Any], key: str, pattern: re.Pattern[str], *, required: bool = True) -> str:
    value = data.get(key, None if required else '')
    if not isinstance(value, str) or ((value or required) and not pattern.match(value)):
        raise MessageError(f'"{key}" is missing or malformed')
    return value


def _party(raw: Any, key: str, kinds: frozenset[str]) -> Party:
    if not isinstance(raw, Mapping) or set(raw) != {'kind', 'id'}:
        raise MessageError(f'"{key}" must be {{kind, id}}')
    if not isinstance(raw['kind'], str) or raw['kind'] not in kinds:
        raise MessageError(f'"{key}.kind" must be one of {sorted(kinds)}')
    return Party(kind=raw['kind'], id=_text(raw, 'id', ID))


def _s3_key(key: Any, prefix: str) -> str:
    if not isinstance(key, str) or not key.startswith(prefix) or '..' in key.split('/') or len(key) > 1024:
        raise MessageError(f'an S3 ref must be a key under {prefix}')
    return key


def _refs(raw: Any, ws: str) -> Refs:
    if raw is None:
        return Refs()
    if not isinstance(raw, Mapping) or not set(raw) <= REF_KEYS:
        raise MessageError(f'"refs" holds only {sorted(REF_KEYS)}')
    s3 = raw.get('s3', [])
    files = raw.get('files', [])
    if not isinstance(s3, list) or not isinstance(files, list):
        raise MessageError('"refs.s3" and "refs.files" are lists')
    if not all(isinstance(path, str) and path and not path.startswith('/') and '..' not in path.split('/')
               for path in files):
        raise MessageError('"refs.files" are repository paths')
    commit = raw.get('commit', '')
    if not isinstance(commit, str) or (commit and not _SHA.match(commit)):
        raise MessageError('"refs.commit" is a commit sha')
    pr = raw.get('pr', 0)
    if not isinstance(pr, int) or isinstance(pr, bool) or pr < 0:
        raise MessageError('"refs.pr" is a pull request number')
    return Refs(s3=tuple(_s3_key(key, f'ws/{ws}/') for key in s3), commit=commit, pr=pr, files=tuple(files))


def fit_summary(text: str) -> str:
    """``text`` cut to a summary's bytes, on a character boundary."""
    return text.encode('utf-8')[:MAX_SUMMARY_BYTES].decode('utf-8', 'ignore')


def summary_text(raw: Any) -> str:
    """A message's summary (or a text bound for one): short, and nothing shaped like a credential."""
    if not isinstance(raw, str) or len(raw.encode('utf-8')) > MAX_SUMMARY_BYTES:
        raise MessageError(f'"summary" is a string of at most {MAX_SUMMARY_BYTES} bytes (the payload goes to S3)')
    if redact(raw) != raw:
        raise MessageError('"summary" holds something shaped like a credential')
    return raw


def parse(data: Any) -> Message:
    """The message in ``data`` (a decoded event detail), or ``MessageError`` naming what is wrong."""
    if not isinstance(data, Mapping):
        raise MessageError('a message is a JSON object')
    if data.get('schema') != SCHEMA:
        raise MessageError(f'"schema" must be "{SCHEMA}"')
    # Never echo what the sender wrote into a reason: the router logs reasons, and a sender may hold repository text.
    unknown = set(data) - FIELDS
    if unknown:
        raise MessageError(f'{len(unknown)} unknown field(s)')
    if not isinstance(data.get('type'), str) or data['type'] not in TYPES:
        raise MessageError('unknown type')
    attempt = data.get('attempt')
    if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 0:
        raise MessageError('"attempt" is a whole number')
    ws = _text(data, 'ws', WS)
    message = Message(
        event_id=_text(data, 'event_id', ULID), ws=ws, run_id=_text(data, 'run_id', ID),
        thread_id=_text(data, 'thread_id', ID), task_id=_text(data, 'task_id', ID, required=False),
        attempt=attempt, sender=_party(data.get('from'), 'from', FROM_KINDS), to=_party(data.get('to'), 'to', TO_KINDS),
        type=data['type'], summary=summary_text(data.get('summary')), refs=_refs(data.get('refs'), ws),
        at=_text(data, 'at', _AT))
    if message.to.kind == 'role' and message.to.id not in ROLES:
        raise MessageError('unknown role')
    if (message.type == 'task.posted') != (message.to.kind == 'role') or (
            message.type == 'task.posted' and not message.task_id):
        raise MessageError('only a posted task is addressed to a role, and it names its task')
    if len(message.to_json().encode('utf-8')) > MAX_EVENT_BYTES:
        raise MessageError(f'the message is over {MAX_EVENT_BYTES} bytes: put its payload in S3')
    return message
