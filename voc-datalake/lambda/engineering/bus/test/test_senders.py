"""The router's sender allowlist: nobody speaks for someone else."""
from __future__ import annotations

import pytest

from engineering.bus.schema import parse
from engineering.bus.senders import Source, judge, parse_source
from engineering.bus.test.messages import AGENT_SOURCE, RUN, message

TASK = {'type': 'task.posted', 'task_id': 'task-1', 'to': {'kind': 'role', 'id': 'fixer'}}
CONDUCTOR = f'voc.engineering/conductor/default/{RUN}'
BOARD = 'voc.engineering/board'
COACH = f'voc.engineering/coach/default/{RUN}'
SUPERVISOR = 'voc.engineering/supervisor'
GATE_RUNNER = f'voc.engineering/agent/gate-runner/default/{RUN}/gate-runner-1'


@pytest.mark.parametrize(('source', 'expected'), [
    ('voc.engineering/api', Source('api')),
    ('voc.engineering/board', Source('board')),
    (CONDUCTOR, Source('conductor', ws='default', run_id=RUN)),
    (COACH, Source('coach', ws='default', run_id=RUN)),
    (GATE_RUNNER, Source('agent', role='gate-runner', ws='default', run_id=RUN, agent_id='gate-runner-1')),
    ('voc.engineering/coach', None),   # (no service coach: a coach is a run's)
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
    ({'type': 'skill.proposed', 'from': {'kind': 'coach', 'id': 'coach'}, 'refs': {'s3': []}}, COACH),
    # A person's board actions (board.api.PersonBoard), published by the API as its user.
    ({**TASK, 'from': {'kind': 'human', 'id': 'user-1'}}, 'voc.engineering/api'),
    ({**TASK, 'type': 'task.needs_human', 'to': {'kind': 'run', 'id': RUN}, 'from': {'kind': 'human', 'id': 'user-1'}},
     'voc.engineering/api'),
    # An administrator's proposal, acceptance (or promotion) and rollback, published by the API as its user.
    *(({'type': kind, 'from': {'kind': 'human', 'id': 'user-1'}, 'refs': {'s3': []}}, 'voc.engineering/api')
      for kind in ('skill.proposed', 'skill.accepted', 'skill.rolled_back')),
    ({'type': 'msg.finding', 'from': {'kind': 'agent', 'id': 'gate-runner-1'}, 'refs': {'s3': []}}, GATE_RUNNER),
    ({'type': 'review.result', 'from': {'kind': 'agent', 'id': 'gate-runner-1'}, 'refs': {'s3': []}}, GATE_RUNNER),
    ({'type': 'signal.check_in', 'from': {'kind': 'supervisor', 'id': 'supervisor'}}, SUPERVISOR),
    ({'type': 'run.agent_continued', 'from': {'kind': 'supervisor', 'id': 'supervisor'},
      'to': {'kind': 'run', 'id': RUN}}, SUPERVISOR),
    ({'type': 'run.agent_timed_out', 'from': {'kind': 'supervisor', 'id': 'supervisor'},
      'to': {'kind': 'run', 'id': RUN}}, SUPERVISOR),
    ({'type': 'run.agent_failed', 'from': {'kind': 'supervisor', 'id': 'supervisor'},
      'to': {'kind': 'run', 'id': RUN}}, SUPERVISOR),
    ({**TASK, 'from': {'kind': 'supervisor', 'id': 'supervisor'}}, SUPERVISOR),
    ({'type': 'outcome.merged', 'from': {'kind': 'system', 'id': 'gh'}, 'to': {'kind': 'run', 'id': RUN}},
     'voc.engineering/webhook'),
])
def test_allowed(changes, source):
    assert judge(parse(message(**changes)), source).allowed


@pytest.mark.parametrize(('changes', 'source', 'reason'), [
    (TASK, AGENT_SOURCE, 'agent may not send task.posted'),
    # The API's task.* is a person's only: never the board's or an agent's voice (the drop the bus pins).
    ({**TASK, 'from': {'kind': 'system', 'id': 'board'}}, 'voc.engineering/api',
     'from.kind system is not what the source api proves'),
    ({**TASK, 'type': 'task.claimed', 'to': {'kind': 'run', 'id': RUN}, 'from': {'kind': 'agent', 'id': 'fixer-1'}},
     'voc.engineering/api', 'from.kind agent is not what the source api proves'),
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
    ({'type': 'skill.accepted', 'from': {'kind': 'coach', 'id': 'coach'}, 'refs': {'s3': []}}, COACH,
     'coach may not send skill.accepted'),
    ({'type': 'skill.rolled_back', 'from': {'kind': 'coach', 'id': 'coach'}, 'refs': {'s3': []}}, COACH,
     'coach may not send skill.rolled_back'),
    *(({'type': kind, 'refs': {'s3': []}}, AGENT_SOURCE, f'agent may not send {kind}')
      for kind in ('skill.proposed', 'skill.accepted', 'skill.rolled_back')),
    *(({'type': kind, 'from': {'kind': 'system', 'id': 'b'}, 'refs': {'s3': []}}, BOARD, f'board may not send {kind}')
      for kind in ('skill.proposed', 'skill.rolled_back')),
    ({'type': 'skill.accepted', 'from': {'kind': 'system', 'id': 'b'}, 'refs': {'s3': []}}, BOARD,
     'board may not send skill.accepted'),
    ({'type': 'skill.proposed', 'from': {'kind': 'coach', 'id': 'coach'}, 'refs': {'s3': []}}, 'voc.engineering/api',
     'from.kind coach is not what the source api proves'),
    ({'type': 'skill.proposed', 'from': {'kind': 'system', 'id': 'coach'}, 'refs': {'s3': []}}, COACH,
     'from.kind system is not what the source coach proves'),
    ({'type': 'skill.proposed', 'from': {'kind': 'coach', 'id': 'coach'}, 'run_id': 'other-run',
      'refs': {'s3': []}}, COACH, 'coach of run default/'),
    ({'type': 'msg.question', 'from': {'kind': 'agent', 'id': 'gate-runner-1'}, 'refs': {'s3': []}}, GATE_RUNNER,
     'the gate runner sends only its gate results'),
    ({'type': 'gate.go', 'from': {'kind': 'agent', 'id': 'gate-runner-1'}, 'refs': {'s3': []}}, GATE_RUNNER,
     'only the final-go agent gives the verdict'),
    ({'type': 'signal.check_in'}, 'voc.engineering/api', 'api may not send signal.check_in'),
    ({'type': 'run.agent_failed', 'from': {'kind': 'system', 'id': 'board'}, 'to': {'kind': 'run', 'id': RUN}},
     BOARD, 'board may not send run.agent_failed'),
    ({**TASK, 'type': 'task.claimed', 'to': {'kind': 'run', 'id': RUN},
      'from': {'kind': 'supervisor', 'id': 'supervisor'}}, SUPERVISOR, 'supervisor may not send task.claimed'),
    ({}, 'someone.else', 'unknown source'),
])
def test_refused(changes, source, reason):
    verdict = judge(parse(message(**changes)), source)
    assert not verdict.allowed
    assert reason in verdict.reason
