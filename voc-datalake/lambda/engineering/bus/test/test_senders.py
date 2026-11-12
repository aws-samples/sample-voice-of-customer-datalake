"""The router's sender allowlist: nobody speaks for someone else."""
from __future__ import annotations

import pytest

from engineering.bus.schema import parse
from engineering.bus.senders import Source, judge, parse_source
from engineering.bus.test.messages import AGENT_SOURCE, RUN, message

TASK = {'type': 'task.posted', 'task_id': 'task-1', 'to': {'kind': 'role', 'id': 'fixer'}}
CONDUCTOR = f'voc.engineering/conductor/default/{RUN}'
BOARD = 'voc.engineering/board'


@pytest.mark.parametrize(('source', 'expected'), [
    ('voc.engineering/api', Source('api')),
    ('voc.engineering/board', Source('board')),
    (CONDUCTOR, Source('conductor', ws='default', run_id=RUN)),
    (AGENT_SOURCE, Source('agent', role='fixer', ws='default', run_id=RUN, agent_id='fixer-1')),
    ('voc.engineering/agent/janitor/default/run-1/x', None),
    (f'voc.engineering/agent/fixer/{RUN}/fixer-1', None),
    ('voc.engineering/conductor/default/', None),
    ('voc.engineering/root', None),
    ('aws.events', None),
])
def test_sources(source, expected):
    assert parse_source(source) == expected


@pytest.mark.parametrize(('changes', 'source'), [
    ({}, AGENT_SOURCE),
    ({**TASK, 'from': {'kind': 'system', 'id': 'board'}}, 'voc.engineering/board'),
    ({**TASK, 'from': {'kind': 'human', 'id': 'user-1'}}, 'voc.engineering/board'),   # a person's move, relayed
    ({'type': 'signal.stop_now', 'from': {'kind': 'human', 'id': 'user-1'}, 'to': {'kind': 'run', 'id': RUN}},
     'voc.engineering/api'),
    ({'type': 'msg.answer', 'from': {'kind': 'human', 'id': 'user-1'}}, 'voc.engineering/api'),
    ({'type': 'gate.go', 'from': {'kind': 'agent', 'id': 'go-1'}, 'to': {'kind': 'run', 'id': RUN}},
     f'voc.engineering/agent/final-go/default/{RUN}/go-1'),
    ({'type': 'run.health', 'from': {'kind': 'supervisor', 'id': 'sup'}, 'to': {'kind': 'run', 'id': RUN}},
     'voc.engineering/supervisor'),
    ({'type': 'signal.pause', 'from': {'kind': 'supervisor', 'id': 'sup'}}, 'voc.engineering/supervisor'),
    ({'type': 'run.ended', 'from': {'kind': 'system', 'id': 'board'}, 'to': {'kind': 'run', 'id': RUN}}, BOARD),
    ({'type': 'msg.handoff', 'from': {'kind': 'conductor', 'id': 'c'}}, CONDUCTOR),
    ({'type': 'skill.proposed', 'from': {'kind': 'system', 'id': 'coach'}}, 'voc.engineering/coach'),
    ({'type': 'outcome.merged', 'from': {'kind': 'system', 'id': 'gh'}, 'to': {'kind': 'run', 'id': RUN}},
     'voc.engineering/webhook'),
])
def test_allowed(changes, source):
    assert judge(parse(message(**changes)), source).allowed


@pytest.mark.parametrize(('changes', 'source', 'reason'), [
    (TASK, AGENT_SOURCE, 'agent may not send task.posted'),
    ({'type': 'signal.pause', 'to': {'kind': 'run', 'id': RUN}}, AGENT_SOURCE, 'agent may not send signal.pause'),
    ({'type': 'gate.go', 'to': {'kind': 'run', 'id': RUN}}, AGENT_SOURCE,
     'only the final-go agent gives the verdict, not fixer'),
    ({'from': {'kind': 'human', 'id': 'user-1'}}, AGENT_SOURCE, 'from.kind human is not what the source agent'),
    ({'from': {'kind': 'agent', 'id': 'reviewer-1'}}, AGENT_SOURCE, 'agent fixer-1 may not speak as another'),
    ({'run_id': 'run-2'}, AGENT_SOURCE, f'agent of run default/{RUN} may not speak in another run'),
    ({'ws': 'other', 'refs': None}, AGENT_SOURCE, f'agent of run default/{RUN} may not speak in another run'),
    ({'type': 'msg.handoff', 'from': {'kind': 'conductor', 'id': 'c'}, 'run_id': 'run-2'}, CONDUCTOR,
     'may not speak in another run'),
    ({'from': {'kind': 'human', 'id': 'u'}}, 'voc.engineering/api', 'api may not send msg.question'),
    ({'type': 'review.result', 'from': {'kind': 'human', 'id': 'u'}}, 'voc.engineering/api',
     'api may not send review.result'),
    ({'type': 'run.health', 'from': {'kind': 'system', 'id': 'b'}, 'to': {'kind': 'run', 'id': RUN}}, BOARD,
     'board may not send run.health'),
    ({'refs': {'s3': ['ws/default/runs/run-2/x.jsonl']}}, AGENT_SOURCE, "may refer only to its own run's objects"),
    ({'type': 'msg.answer'}, 'voc.engineering/api', 'from.kind agent is not what the source api proves'),
    ({'type': 'skill.accepted'}, 'voc.engineering/coach', 'coach may not send skill.accepted'),
    ({}, 'someone.else', 'unknown source'),
])
def test_refused(changes, source, reason):
    verdict = judge(parse(message(**changes)), source)
    assert not verdict.allowed
    assert reason in verdict.reason
