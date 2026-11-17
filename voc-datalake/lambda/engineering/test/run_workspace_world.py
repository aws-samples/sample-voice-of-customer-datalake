"""Test support: one engineering run as the run workspace reads it (7.51.00), on moto (already active), every value fixed.

The dev mock's sample run (frontend/mock-engineering-runs.js, ``01JDA7K3M9Q2R5T8V0W4X6Y1Z3``): a flow of a fix board, a
quality gate and a stop at its pull request; the coordinator, a fixer on its second attempt (its first was re-posted),
a gate runner and the final go; the fixer's transcript (its brief with a recalled lesson, its reasoning and words, its
tool calls and their results, a checkpoint), its submitted patch and a checkpoint's; the gate runner's gate run and
record; the conversation (a person's steering, the orchestrator's relay, the fixer's question and its answer, a
signal); the gate's assertions; Learn's lesson; the pull request and the committer's push; a child run restarted
from an earlier run, in this month's runs list; and (7.51.04) a run at a person whose orchestrator never got past its
repository checkout (the owner's first run on b-): its coordinator restarted twice, then failed with its last exit
(128) and stderr, the run waiting at ``checkout_failed`` with its supervisor's plain reason (7.51.03), and the
supervisor's lines in its conversation. Used by the views' tests, the routes' tests and the shared fixture
(frontend/src/test/engineeringRunWorkspace.json).
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Final

import boto3
from boto3.dynamodb.types import TypeSerializer

from engineering.board.test.table import TABLE, create_table
from engineering.bus.schema import parse
from engineering.conversation.store import ConversationStore
from engineering.flow.record import flow_item
from engineering.runtime.checkpoints import artifact_prefix
from engineering.runtime.harness.transcript import Transcript
from engineering.runtime.runs import RunStore
from engineering.runtime.sessions import AgentSession, SessionStore
from shared.workflow_schema import SCHEMA_V2

BUCKET: Final = 'voc-engineering-workspace'
RUN: Final = '01JDA7K3M9Q2R5T8V0W4X6Y1Z3'
#: A run of the same flow that ended, and its child, restarted from it.
ENDED_RUN: Final = '01JDA0B1C2D3E4F5G6H7J8K9M0'
CHILD_RUN: Final = '01JDA9W8X7Y6Z5V4T3S2R1Q0P9'
#: (7.51.04) A run at a person: its orchestrator failed at its checkout, on a triage flow.
FAILED_RUN: Final = '01JDAF5Q0C8R2N7W4X6Y1Z3K9M'
TRIAGE_FLOW: Final = 'wf_3e8a1c5d7f90'
CHECKOUT_STDERR: Final = "fatal: detected dubious ownership in repository at '/mnt/voc-cache/storefront/0123456789ab'"
#: Its supervisor's plain reason (7.51.03's words), on META, in its coordinator's inspection data and in its
#: conversation, and the decision point the run waits at for it.
FAILED_REASON: Final = f'The repository checkout failed (git clone, exit 128): {CHECKOUT_STDERR}'
CHECKOUT_FAILED: Final = 'checkout_failed'
FLOW: Final = 'wf_7c2d9e41a0b3'
REPO: Final = 'example-org/storefront'
COMMIT: Final = '0123456789abcdef0123456789abcdef01234567'
MONTH: Final = '2026-11'
FIXER: Final = 'fixer-3'
GATE_RUNNER: Final = 'gate-runner-4'
FINAL_GO: Final = 'final-go-5'
COORDINATOR: Final = 'coordinator-1'
FIX_TASK: Final = 'task-fix-page-size'
CHECKS_TASK: Final = 'task-gate-checks'
GO_TASK: Final = 'task-gate-final-go'
BRANCH: Final = f'voc-agent/{RUN}/fix-page-size'
#: Every time in the world, from its start (2026-11-17 09:00 UTC).
START: Final = datetime(2026, 11, 17, 9, 0, tzinfo=UTC)
_SERIALIZE: Final = TypeSerializer()


def at(minutes: float) -> str:
    """The time ``minutes`` after the start, as the conversation and the transcript write it."""
    return datetime.fromtimestamp(START.timestamp() + minutes * 60, UTC).strftime('%Y-%m-%dT%H:%M:%S.%fZ')


def epoch(minutes: float) -> int:
    return int(START.timestamp() + minutes * 60)


def flow_definition() -> dict[str, Any]:
    """The run's flow (voc-workflow/2): the coordinator posts a fix per bug, fixers take them, the gate judges each
    change (two assertions on its record), then the pull request."""
    def node(node_id: str, kind: str, title: str, **params: Any) -> dict[str, Any]:
        return {'id': node_id, 'type': kind, 'position': {'x': 240, 'y': 0}, 'data': {'title': title, 'params': params}}

    return {'schema': SCHEMA_V2, 'name': 'Fix the reported bugs', 'nodes': [
        node('start', 'start', 'Start'),
        node('board', 'board', 'Fix board', posters=['hunter'], claimers=['fixer']),
        node('gate', 'quality_gate', 'Quality gate', max_rounds=3, packs='auto',
             **{'assert': [{'check': 'gate.passed'}, {'check': 'patch.touches_tests', 'on_fail': 'warn'},
                           {'check': 'patch.max_lines', 'args': {'max': 400}}]}),
        node('pr', 'stop_at_pr', 'Open the PR'),
        node('human', 'end', 'A person decides', status='needs_human'),
    ], 'edges': [
        {'id': 'e1', 'source': 'start', 'target': 'board'}, {'id': 'e2', 'source': 'board', 'target': 'gate'},
        {'id': 'e3', 'source': 'gate', 'target': 'pr', 'label': 'pass'},
        {'id': 'e4', 'source': 'gate', 'target': 'human', 'label': 'fail'},
    ], 'loops': []}


def triage_definition() -> dict[str, Any]:
    """The failed run's flow (voc-workflow/2, issue-triage's shape): understand and classify, then locate."""
    def node(node_id: str, kind: str, title: str, **params: Any) -> dict[str, Any]:
        return {'id': node_id, 'type': kind, 'position': {'x': 0, 'y': 0}, 'data': {'title': title, 'params': params}}

    return {'schema': SCHEMA_V2, 'name': 'Issue triage', 'nodes': [
        node('start', 'start', 'Start'),
        node('classify', 'agent', 'Understand and classify', role='understander'),
        node('locate', 'agent', 'Reproduce or locate', role='hunter'),
        node('end', 'end', 'The triage on the issue', status='completed'),
    ], 'edges': [
        {'id': 'e1', 'source': 'start', 'target': 'classify'}, {'id': 'e2', 'source': 'classify', 'target': 'locate'},
        {'id': 'e3', 'source': 'locate', 'target': 'end'},
    ], 'loops': []}


PATCH: Final = """diff --git a/src/paging.py b/src/paging.py
index 3b18e51..a9c4f02 100644
--- a/src/paging.py
+++ b/src/paging.py
@@ -10,7 +10,7 @@ def last_page(items, size):
     if not items:
         return []
     start = (len(items) - 1) // size * size
-    return items[start:start + size + 1]
+    return items[start:start + size]


 def pages(items, size):
diff --git a/tests/test_paging.py b/tests/test_paging.py
new file mode 100644
index 0000000..5f1d2c3
--- /dev/null
+++ b/tests/test_paging.py
@@ -0,0 +1,6 @@
+from src.paging import last_page
+
+
+def test_the_last_page_holds_at_most_a_page() -> None:
+    assert last_page(list(range(11)), 5) == [10]
+    assert last_page(list(range(10)), 5) == [5, 6, 7, 8, 9]
diff --git a/docs/old-paging.md b/docs/paging.md
similarity index 90%
rename from docs/old-paging.md
rename to docs/paging.md
index 1111111..2222222 100644
--- a/docs/old-paging.md
+++ b/docs/paging.md
@@ -1,3 +1,3 @@
 # Paging
-The last page shows one item too many.
+The last page shows at most a page of items.
 \\ No newline at end of file
diff --git a/assets/logo.png b/assets/logo.png
index 3333333..4444444 100644
GIT binary patch
literal 12
TcmZ?wbhEHbWMp7q00cmTc>n+a

literal 10
RcmZ?wbhEHbWMp7q00cmT

"""

CHECKPOINT_PATCH: Final = """diff --git a/src/paging.py b/src/paging.py
index 3b18e51..7d2e9a1 100644
--- a/src/paging.py
+++ b/src/paging.py
@@ -10,7 +10,8 @@ def last_page(items, size):
     if not items:
         return []
     start = (len(items) - 1) // size * size
-    return items[start:start + size + 1]
+    # (work in progress)
+    return items[start:start + size]


 def pages(items, size):
"""

#: The patches' keys under the fixer's own prefix, and when S3 wrote each (moto's own times are now).
SUBMITTED_KEY: Final = f'{artifact_prefix(RUN, FIXER, COMMIT, 2, "patches")}{FIX_TASK}-1a2b3c4d.diff'
CHECKPOINT_KEY: Final = f'{artifact_prefix(RUN, FIXER, COMMIT, 2, "patches")}checkpoint-000002-5e6f7a8b.diff'
GATE_RECORD_KEY: Final = f'{artifact_prefix(RUN, GATE_RUNNER, COMMIT, 1, "gate")}record.json'
WRITTEN: Final = {SUBMITTED_KEY: START.replace(minute=24), CHECKPOINT_KEY: START.replace(minute=18)}


class FixedTimes:
    """The S3 client the readers get: moto's, with each listed object's LastModified the world's (``WRITTEN``)."""

    def __init__(self, s3: Any) -> None:
        self.s3 = s3

    def list_objects_v2(self, **request: Any) -> dict[str, Any]:
        page = self.s3.list_objects_v2(**request)
        for item in page.get('Contents', []):
            item['LastModified'] = WRITTEN.get(item['Key'], START)
        return page

    def __getattr__(self, name: str) -> Any:
        return getattr(self.s3, name)


@dataclass
class World:
    client: Any
    s3: Any


class _Store:
    def __init__(self, s3: Any) -> None:
        self.s3 = s3

    def put(self, key: str, body: bytes) -> None:
        self.s3.put_object(Bucket=BUCKET, Key=key, Body=body, IfNoneMatch='*')


def _clock(minutes: Iterator[float]) -> Any:
    return lambda: START.timestamp() + next(minutes) * 60


def _transcript(s3: Any, agent: str, attempt: int, events: list[tuple[float, str, dict[str, Any]]],
                flush_after: frozenset[int] = frozenset()) -> None:
    """The agent's transcript, written as its harness writes it (a chunk flushed after each event index named)."""
    times = iter([minutes for minutes, _, _ in events])
    transcript = Transcript(_Store(s3), artifact_prefix(RUN, agent, COMMIT, attempt, 'transcripts'), clock=_clock(times))
    for index, (_, kind, fields) in enumerate(events):
        transcript.record(kind, **fields)
        if index in flush_after:
            transcript.flush()
    transcript.flush()


FENCE: Final = 'f3nc3f3nc3f3nc3e'


def _data(name: str, text: str) -> str:
    return f'<<<DATA {name} {FENCE}>>>\n{text}\n<<<END DATA {name} {FENCE}>>>'


def _fixer_events() -> list[tuple[float, str, dict[str, Any]]]:
    brief = ('Your task: The last page shows one item too many.\n'
             + _data('task', 'Issue #7: the last page of the order list shows 11 items with a page size of 10.') + '\n'
             + _data('memory:1', 'In storefront, paging helpers live in src/paging.py and are tested in tests/.'))
    return [
        (11, 'session', {'run': RUN, 'agent': FIXER, 'role': 'fixer', 'task': FIX_TASK, 'attempt': 2, 'commit': COMMIT,
                         'model': 'model-medium', 'adapter': 'converse', 'skill': 'fixer@v3', 'continuation': False,
                         'tools': ['read_file', 'write_file', 'run', 'submit_work']}),
        (11.1, 'message', {'role': 'user', 'content': [{'text': brief}]}),
        (12, 'model_call', {'model': 'model-medium', 'turn': 1, 'tokens_in': 4100, 'tokens_out': 220,
                            'stop_reason': 'tool_use', 'ms': 2100}),
        (12, 'message', {'role': 'assistant', 'content': [
            {'reasoningContent': {'reasoningText': {'text': 'The slice end adds one: that is the extra item.'}}},
            {'text': 'I will read the paging helper first.'},
            {'toolUse': {'toolUseId': 't1', 'name': 'read_file', 'input': {'path': 'src/paging.py'}}}]}),
        (12.1, 'tool_call', {'tool': 'read_file', 'input': {'path': 'src/paging.py'}}),
        (12.2, 'tool_result', {'tool': 'read_file', 'text': _data('src/paging.py', 'def last_page(items, size):\n    ...'),
                               'error': False, 'ms': 40}),
        (14, 'tool_call', {'tool': 'write_file', 'input': {'path': 'src/paging.py', 'text': 'def last_page(items, size):'}}),
        (14.1, 'tool_result', {'tool': 'write_file', 'text': 'wrote src/paging.py (412 bytes)', 'error': False, 'ms': 12}),
        (16, 'tool_call', {'tool': 'run', 'input': {'argv': ['python', '-m', 'pytest', '-q', 'tests/test_paging.py']}}),
        (17, 'checkpoint', {'key': f'{artifact_prefix(RUN, FIXER, COMMIT, 2, "checkpoints")}000002-9a8b7c6d.json',
                            'turn': 4}),
        (18, 'tool_result', {'tool': 'run', 'text': 'exit 1\nFAILED tests/test_paging.py::test_the_last_page - assert',
                             'error': True, 'ms': 61000}),
        (20, 'message', {'role': 'user', 'content': [{'text': _data('message:steer', 'About fixer-3: keep the public '
                                                                    'signature of last_page as it is.')}]}),
        (22, 'tool_call', {'tool': 'list_files', 'input': {'path': 'tests'}}),
        (22.1, 'tool_result', {'tool': 'list_files', 'text': 'tests/test_paging.py', 'error': False, 'ms': 5}),
        (24, 'tool_call', {'tool': 'submit_work', 'input': {'summary': 'The last page now holds at most a page.'}}),
    ]


def _gate_run() -> dict[str, Any]:
    return {'packs': ['python'], 'passed': True, 'own_gate': False, 'tool_versions': {'python': 'Python 3.14.0'},
            'skipped': [],
            'checks': [
                {'key': 'py.test@.', 'name': 'pytest', 'kind': 'test', 'root': '', 'status': 'pass', 'reason': '',
                 'exit_code': 0, 'duration_s': 4.2, 'output': '..........\n10 passed in 4.1s'},
                {'key': 'py.ruff@.', 'name': 'ruff', 'kind': 'lint', 'root': '', 'status': 'pass', 'reason': '',
                 'exit_code': 0, 'duration_s': 0.4, 'output': 'All checks passed!'}]}


def gate_record() -> dict[str, Any]:
    """The gate runner's record (voc-gate-record/1, as quality_gate/record.py's ``to_dict`` writes it)."""
    return {'schema': 'voc-gate-record/1', 'verdict': 'GO', 'stop_reason': '', 'tree_hash': 'b' * 40,
            'packs': ['python'], 'own_gate': False, 'tool_versions': {'python': 'Python 3.14.0'}, 'max_rounds': 3,
            'reviewers': ['security', 'quality'], 'model_calls': 2, 'accepted_by': '',
            'rounds': [{'number': 1, 'checks': [{'name': 'py.test@.: pytest', 'status': 'pass'},
                                                {'name': 'py.ruff@.: ruff', 'status': 'pass'}],
                        'reviewed': True, 'complete': True, 'finding_ids': ['R1-quality-1']}],
            'findings': [{'id': 'R1-quality-1', 'round': 1, 'reviewer': 'quality', 'severity': 'nit',
                          'title': 'Name the page size constant', 'file': 'src/paging.py', 'line': 12, 'quote': '',
                          'trigger': '', 'fix': '', 'note': '', 'outcome': 'deferred', 'outcome_note': 'a later change'}],
            'final_go': None}


def _gate_events() -> list[tuple[float, str, dict[str, Any]]]:
    return [
        (25, 'session', {'run': RUN, 'agent': GATE_RUNNER, 'role': 'gate-runner', 'task': CHECKS_TASK, 'attempt': 1,
                         'commit': COMMIT, 'model': 'model-small', 'adapter': 'converse', 'skill': '',
                         'continuation': False, 'tools': ['run_gate', 'write_gate_record']}),
        (26, 'tool_call', {'tool': 'run_gate', 'input': {}}),
        (28, 'tool_result', {'tool': 'run_gate', 'text': _data('gate', json.dumps(_gate_run(), sort_keys=True)),
                             'error': False, 'ms': 120000}),
        (29, 'tool_call', {'tool': 'write_gate_record', 'input': {'verdict': 'GO'}}),
        (29.1, 'tool_result', {'tool': 'write_gate_record', 'text': json.dumps({'key': GATE_RECORD_KEY}), 'error': False,
                               'ms': 30}),
        (30, 'end', {'ending': 'done', 'tokens': {'model-small': {'in': 900, 'out': 80}}, 'results': [GATE_RECORD_KEY]}),
    ]


def _message(seq_at: float, **fields: Any) -> dict[str, Any]:
    base: dict[str, Any] = {'schema': 'voc-msg/1', 'event_id': f'01JDA7M{int(seq_at * 10):019d}', 'ws': 'default',
                            'run_id': RUN, 'thread_id': 'run', 'attempt': 0, 'refs': {'s3': []}, 'at': at(seq_at)}
    return {**base, **fields}


def _conversation() -> list[dict[str, Any]]:
    human, conductor = {'kind': 'human', 'id': 'admin-sub'}, {'kind': 'conductor', 'id': RUN}
    return [
        _message(1, **{'from': {'kind': 'supervisor', 'id': 'supervisor'}}, to={'kind': 'run', 'id': RUN},
                 type='run.started', summary='The run started.'),
        _message(10.5, **{'from': {'kind': 'system', 'id': 'board'}}, to={'kind': 'role', 'id': 'fixer'},
                 type='task.posted', task_id=FIX_TASK, attempt=2, summary='The last page shows one item too many'),
        _message(19, **{'from': human}, to=conductor, type='msg.steer', thread_id='steer-1',
                 summary='About fixer-3: keep the public signature of last_page as it is.'),
        _message(19.5, **{'from': {'kind': 'conductor', 'id': COORDINATOR}}, to={'kind': 'agent', 'id': FIXER},
                 type='msg.steer', thread_id='steer-1', summary='Keep the public signature of last_page as it is.'),
        _message(21, **{'from': {'kind': 'agent', 'id': FIXER}}, to={'kind': 'run', 'id': RUN}, type='msg.question',
                 thread_id='q-fixer-3-1', task_id=FIX_TASK, attempt=2,
                 summary='Is a page size of 0 an error, or an empty page?'),
        _message(21.5, **{'from': human}, to={'kind': 'agent', 'id': FIXER}, type='msg.answer', thread_id='q-fixer-3-1',
                 summary='An error: raise ValueError.'),
        _message(23, **{'from': human}, to={'kind': 'run', 'id': RUN}, type='signal.save', thread_id='signals',
                 task_id=FIX_TASK, attempt=2, summary='save requested from the run monitor by ada for agent fixer-3.'),
        _message(30, **{'from': {'kind': 'agent', 'id': FINAL_GO}}, to={'kind': 'run', 'id': RUN}, type='gate.go',
                 task_id=GO_TASK, attempt=1, summary='GO: the gate passed and its findings are deferred nits.'),
    ]


def _failed_conversation() -> list[dict[str, Any]]:
    """The failed run's conversation: the supervisor's lines about its coordinator, as board_bus.message words them
    (a tick's health, each crash's continuation, the third crash, 7.51.03's "could not start" with its reason), in its
    first minutes (the evening before START)."""
    lines = [
        (-700, 'run.health', '1 booting (tokens 0, cost_usd 0.00)'),
        (-699, 'run.health', '1 booting (tokens 0, cost_usd 0.00)'),
        (-698, 'run.health', '1 booting (tokens 0, cost_usd 0.00)'),
        (-697, 'run.agent_continued',
         f'{COORDINATOR} continued in a new session (1). (continuation 1, after crash, checkpoint none)'),
        (-696, 'run.health', '1 booting (tokens 0, cost_usd 0.01)'),
        (-695, 'run.agent_continued',
         f'{COORDINATOR} continued in a new session (2). (continuation 2, after crash, checkpoint none)'),
        (-694, 'run.agent_failed', f'{COORDINATOR} crashed 3 times.'),
        (-693.9, 'run.agent_failed', f'{COORDINATOR} could not start. {FAILED_REASON}'),
        (-693, 'run.health', '1 failed (tokens 0, cost_usd 0.03)'),
    ]
    return [_message(minutes, event_id=f'01JDAF5{index:019d}', run_id=FAILED_RUN, thread_id=FAILED_RUN, attempt=1,
                     task_id='coordinate', type=kind, summary=summary, to={'kind': 'run', 'id': FAILED_RUN},
                     **{'from': {'kind': 'supervisor', 'id': 'supervisor'}})
            for index, (minutes, kind, summary) in enumerate(lines, start=1)]


def _task(task_id: str, role: str, title: str, *, state: str, attempt: int, agent: str, step: str,
          results: tuple[str, ...] = ()) -> dict[str, Any]:
    item: dict[str, Any] = {
        'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': f'TASK#{task_id}'}, 'task_id': {'S': task_id},
        'role': {'S': role}, 'state': {'S': state}, 'title': {'S': title}, 'spec': {'S': '{}'},
        'spec_hash': {'S': 'h'}, 'depth': {'N': '1'}, 'priority': {'N': '1'}, 'attempt': {'N': str(attempt)},
        'posted_by': {'S': COORDINATOR}, 'updated_by': {'S': agent}, 'updated_at': {'S': at(24)},
        'flow_step': {'S': step}, 'launched_agent': {'S': agent}, 'launched_attempt': {'N': str(attempt)}}
    if state not in ('done', 'failed', 'needs_human'):
        item.update(lease_agent={'S': agent}, lease_epoch={'N': str(attempt)}, lease_expires={'N': str(epoch(60))})
    if results:
        item['result_keys'] = {'SS': list(results)}
    return item


def _session(agent: str, role: str, task: str, attempt: int, status: str, started: float, seconds: int,
             tokens: dict[str, dict[str, int]], step: str, *, run_id: str = RUN,
             inspect: dict[str, Any] | None = None) -> AgentSession:
    return AgentSession(run_id=run_id, agent_id=agent, role=role, task_id=task, language='python',
                        egress=('pypi.org',), connection='conn-storefront', commit=COMMIT, paths=('',),
                        harness=('python3', '-m', 'harness'), vm_id=f'vm-{agent}', endpoint=f'https://{agent}.example.org',
                        started_at=epoch(started), status=status, task_attempt=attempt, microvm_seconds=seconds,
                        tokens=tokens, inspect={'step': step, 'recent_tools': [], 'heartbeat_age': 20, **(inspect or {})})


def _meta(run_id: str, *, status: str, started: str, ended: str = '', goal: str,
          parent: dict[str, str] | None = None, flow: str = FLOW) -> dict[str, Any]:
    item: dict[str, Any] = {
        'pk': {'S': f'WS#default#RUN#{run_id}'}, 'sk': {'S': 'META'}, 'run_id': {'S': run_id}, 'status': {'S': status},
        'started_at': {'S': started}, 'goal': {'S': goal}, 'repo': {'S': REPO}, 'flow': {'S': flow},
        'connection': {'S': 'conn-storefront'}, 'commit': {'S': COMMIT}, 'default_branch': {'S': 'main'},
        'max_tasks': {'N': '20'}, 'task_count': {'N': '4'}, 'msg_seq': {'N': '0'}, 'max_cost_usd': {'S': '50.0'},
        'budget_usd': {'S': '50.0'}, 'budget_alert': {'N': '0'}}
    if ended:
        item['ended_at'] = {'S': ended}
    if parent:
        item['parent'] = {'M': {name: {'S': value} for name, value in parent.items()}}
    return item


def _listed(run_id: str, *, started: str, status: str, goal: str, ended: str = '',
            parent: dict[str, str] | None = None, flow: str = FLOW) -> dict[str, Any]:
    item: dict[str, Any] = {'pk': {'S': f'WS#default#RUNLIST#{MONTH}'}, 'sk': {'S': f'RUN#{started}#{run_id}'},
                            'run_id': {'S': run_id}, 'flow': {'S': flow}, 'goal': {'S': goal}, 'status': {'S': status},
                            'started_at': {'S': started}}
    if ended:
        item['ended_at'] = {'S': ended}
    if parent:
        item['parent'] = {'M': {name: {'S': value} for name, value in parent.items()}}
    return item


def _failed_run(client: Any, sessions: SessionStore, put: Any) -> None:
    """The run at a person (7.51.04): its triage flow's copy, its coordinator failed with its checkout's last exit
    after two restarts and the supervisor's reason (its session written while the run was active), then META at
    ``checkout_failed`` (7.51.03's decision point) with the reason."""
    goal = 'Triage issue #12: the cart total ignores the discount'
    put(_meta(FAILED_RUN, status='active', started=at(-700), goal=goal, flow=TRIAGE_FLOW))
    copy = flow_item(f'WS#default#RUN#{FAILED_RUN}', workflow_id=TRIAGE_FLOW, revision=1,
                     definition=json.dumps(triage_definition(), sort_keys=True), at=at(-700))
    put({name: _SERIALIZE.serialize(value) for name, value in copy.items()})
    failed = _session(COORDINATOR, 'coordinator', 'coordinate', 1, 'failed', -695, 40, {}, '', run_id=FAILED_RUN,
                      inspect={'last_failure': FAILED_REASON,
                               'last_exit': {'exit_code': 128, 'timed_out': False, 'duration_seconds': 2,
                                             'stdout_tail': '', 'stderr_tail': CHECKOUT_STDERR}})
    sessions.create(replace(failed, continuation=2, crashes=2), labels={'model': 'model-large', 'skill_version': ''})
    row = {'pk': {'S': f'WS#default#RUN#{FAILED_RUN}'}, 'sk': {'S': f'AGENT#{COORDINATOR}'}}
    client.update_item(TableName=TABLE, Key=row, UpdateExpression='SET cost_usd = :c',
                       ExpressionAttributeValues={':c': {'N': '0.03'}})
    meta = _meta(FAILED_RUN, status='needs_human', started=at(-700), goal=goal, flow=TRIAGE_FLOW)
    put({**meta, 'needs_human': {'S': CHECKOUT_FAILED}, 'needs_human_at': {'N': str(epoch(-694))},
         'needs_human_detail': {'S': FAILED_REASON}})
    put(_listed(FAILED_RUN, started=at(-700), status='needs_human', goal=goal, flow=TRIAGE_FLOW))


def build(region: str = 'us-east-1') -> World:
    """Inside a moto context: the table, the bucket and the world in them."""
    client = create_table(region)
    s3 = boto3.client('s3', region_name=region)
    s3.create_bucket(Bucket=BUCKET)
    put = lambda item: client.put_item(TableName=TABLE, Item=item)  # noqa: E731 - a short local writer
    # The run, active while its sessions are written (SessionStore checks it), then as it stands.
    put(_meta(RUN, status='active', started=at(0), goal='Fix the paging bugs reported this week'))
    copy = flow_item(f'WS#default#RUN#{RUN}', workflow_id=FLOW, revision=3,
                     definition=json.dumps(flow_definition(), sort_keys=True), at=at(0))
    put({name: _SERIALIZE.serialize(value) for name, value in copy.items()})
    table = boto3.resource('dynamodb', region_name=region).Table(TABLE)
    sessions = SessionStore(table, RunStore(table))
    for session, labels, cost in (
            (_session(COORDINATOR, 'coordinator', 'coordinate', 1, 'waiting', 0.5, 310,
                      {'model-large': {'in': 42000, 'out': 6100}}, 'board'), {'model': 'model-large', 'skill_version': ''},
             '0.412'),
            (_session(FIXER, 'fixer', FIX_TASK, 2, 'working', 11, 1420, {'model-medium': {'in': 61500, 'out': 9800}},
                      'board'), {'model': 'model-medium', 'skill_version': 'fixer@v3', 'card': 'fixer-careful',
                                 'card_version': '2'}, '0.9375'),
            (_session(GATE_RUNNER, 'gate-runner', CHECKS_TASK, 1, 'done', 25, 300, {'model-small': {'in': 900, 'out': 80}},
                      'gate'), {'model': 'model-small', 'skill_version': ''}, '0.05'),
            (_session(FINAL_GO, 'final-go', GO_TASK, 1, 'done', 29.5, 120, {'model-large': {'in': 12000, 'out': 900}},
                      'gate'), {'model': 'model-large', 'skill_version': 'final-go@v1'}, '0.21')):
        sessions.create(session, labels=labels)
        client.update_item(TableName=TABLE, Key={'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': f'AGENT#{session.agent_id}'}},
                           UpdateExpression='SET cost_usd = :c', ExpressionAttributeValues={':c': {'N': cost}})
    for item in (_task(FIX_TASK, 'fixer', 'The last page shows one item too many', state='in_progress', attempt=2,
                       agent=FIXER, step='board', results=(SUBMITTED_KEY,)),
                 _task(CHECKS_TASK, 'gate-runner', 'Run the gate on the paging fix', state='done', attempt=1,
                       agent=GATE_RUNNER, step='gate', results=(GATE_RECORD_KEY,)),
                 _task(GO_TASK, 'final-go', 'Decide on the paging fix', state='done', attempt=1, agent=FINAL_GO,
                       step='gate')):
        put(item)
    put({'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': f'STEP#gate#verdict#{GO_TASK}'}, 'kind': {'S': 'step_record'},
         'step': {'S': 'gate'}, 'record': {'S': 'verdict'}, 'by': {'S': 'board'}, 'at': {'S': at(30)},
         'task_id': {'S': GO_TASK}, 'verdict': {'S': 'GO'}})
    put({'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': 'ASSERT#gate#1'}, 'step': {'S': 'gate'},
         'attempt': {'N': '1'}, 'at': {'S': at(30)}, 'results': {'L': [
             {'M': {'check': {'S': 'gate.passed'}, 'status': {'S': 'pass'}, 'detail': {'S': 'the final go said GO'},
                    'on_fail': {'S': 'block'}}},
             {'M': {'check': {'S': 'patch.touches_tests'}, 'status': {'S': 'pass'},
                    'detail': {'S': 'tests/test_paging.py'}, 'on_fail': {'S': 'warn'}}},
             {'M': {'check': {'S': 'patch.max_lines'}, 'status': {'S': 'pass'},
                    'detail': {'S': '11 lines changed of 400'}, 'on_fail': {'S': 'block'}}}]}})
    put({'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': f'LEARNED#{FIX_TASK}#1#stalled'}, 'kind': {'S': 'learning'},
         'by': {'S': 'retrospective'}, 'at': {'S': at(40)}, 'memory_id': {'S': 'mem-paging-1'},
         'lesson': {'S': 'A fixer that stalls on paging: read the helper before the tests.'},
         'coach': {'S': 'proposed'}, 'proposed_version': {'N': '4'}})
    # The pull request (the broker's row) and the committer's push (its done claim).
    writes = f'WS#default#WRITES#{RUN}'
    put({'pk': {'S': writes}, 'sk': {'S': 'PULL_REQUEST'}, 'op': {'S': 'pull_request'}, 'at': {'N': str(epoch(32))},
         'closed_at': {'N': str(epoch(32))}, 'result': {'S': json.dumps({
             'host': 'github', 'number': 42, 'url': f'https://github.com/{REPO}/pull/42', 'head': BRANCH, 'base': 'main',
             'superseded': []})}})
    put({'pk': {'S': writes}, 'sk': {'S': 'WRITE#committer-6#1#push_bundle#0123abcd'}, 'op': {'S': 'push_bundle'},
         'state': {'S': 'done'}, 'at': {'N': str(epoch(31))}, 'closed_at': {'N': str(epoch(31))},
         'result': {'S': json.dumps({'branch': BRANCH, 'tree_hash': 'b' * 40, 'ci': 'none'})}})
    # The ended run and its child, with the run itself, in this month's list.
    parent = {'run_id': ENDED_RUN, 'mode': 'resume', 'by': 'admin-sub', 'at': at(-60)}
    put(_meta(ENDED_RUN, status='stopped', started=at(-600), ended=at(-120), goal='Fix the export bug'))
    put({'pk': {'S': f'WS#default#RUN#{ENDED_RUN}'}, 'sk': {'S': f'CHILD#{CHILD_RUN}'}, 'mode': {'S': 'resume'},
         'by': {'S': 'admin-sub'}, 'at': {'S': at(-60)}})
    put(_meta(CHILD_RUN, status='active', started=at(-60), goal='Fix the export bug', parent=parent))
    for item in (_listed(ENDED_RUN, started=at(-600), ended=at(-120), status='stopped', goal='Fix the export bug'),
                 _listed(CHILD_RUN, started=at(-60), status='active', goal='Fix the export bug', parent=parent),
                 _listed(RUN, started=at(0), status='active', goal='Fix the paging bugs reported this week')):
        put(item)
    _failed_run(client, sessions, put)
    conversation = ConversationStore(client, TABLE)
    for message in _conversation() + _failed_conversation():
        conversation.append_to_conversation(parse(message))
    # The workspace: the fixer's transcript (two chunks: its checkpoint flushed the first), its patches, the gate's.
    _transcript(s3, FIXER, 2, _fixer_events(), flush_after=frozenset({9}))
    _transcript(s3, GATE_RUNNER, 1, _gate_events())
    store = _Store(s3)
    store.put(SUBMITTED_KEY, PATCH.encode())
    store.put(CHECKPOINT_KEY, CHECKPOINT_PATCH.encode())
    store.put(GATE_RECORD_KEY, json.dumps(gate_record(), sort_keys=True).encode())
    # The ended run's manifest (runtime/manifest.py), its one version.
    store.put(f'ws/default/runs/{ENDED_RUN}/_manifest/v0001.json', json.dumps({
        'schema': 'voc-run-manifest/1', 'run_id': ENDED_RUN, 'status': 'stopped', 'cost_usd': '3.1415',
        'tokens': 182000, 'written_at': '2026-11-17T07:05:00+00:00', 'agents': []}, sort_keys=True).encode())
    return World(client, FixedTimes(s3))
