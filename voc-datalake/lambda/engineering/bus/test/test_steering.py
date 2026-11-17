"""Steering on the bus (7.51.00): a person steers the conductor; the conductor steers an agent or a role; nobody else."""
from __future__ import annotations

import pytest

from engineering.bus.routing import DELIVERY, Destination, route
from engineering.bus.schema import MessageError, parse
from engineering.bus.senders import judge
from engineering.bus.test.messages import AGENT_SOURCE, RUN, message

API = 'voc.engineering/api'
BOARD = 'voc.engineering/board'
CONDUCTOR = f'voc.engineering/conductor/default/{RUN}'
HUMAN = {'kind': 'human', 'id': 'user-1'}
RELAY = {'kind': 'conductor', 'id': 'coordinator-1'}


def steer(**changes):
    return parse(message(type='msg.steer', refs={'s3': []}, summary='Keep the fix to the parser.', **changes))


@pytest.mark.parametrize(('changes', 'source'), [
    ({'from': HUMAN, 'to': {'kind': 'conductor', 'id': RUN}}, API),
    ({'from': RELAY, 'to': {'kind': 'agent', 'id': 'fixer-2'}}, BOARD),
    ({'from': RELAY, 'to': {'kind': 'role', 'id': 'fixer'}}, BOARD),
    ({'from': RELAY, 'to': {'kind': 'agent', 'id': 'fixer-2'}}, CONDUCTOR),
])
def test_a_person_steers_the_conductor_and_the_conductor_an_agent_or_a_role(changes, source):
    assert judge(steer(**changes), source).allowed


@pytest.mark.parametrize(('changes', 'source', 'why'), [
    # A person never steers an agent directly, nor a role: only through the orchestrator.
    ({'from': HUMAN, 'to': {'kind': 'agent', 'id': 'fixer-2'}}, API, 'steering from human may not go to agent'),
    ({'from': HUMAN, 'to': {'kind': 'role', 'id': 'fixer'}}, API, 'steering from human may not go to role'),
    # The conductor never steers itself, nor the run.
    ({'from': RELAY, 'to': {'kind': 'conductor', 'id': RUN}}, BOARD, 'steering from conductor may not go to conductor'),
    ({'from': RELAY, 'to': {'kind': 'run', 'id': RUN}}, CONDUCTOR, 'steering from conductor may not go to run'),
    # An agent steers nobody.
    ({'from': {'kind': 'agent', 'id': 'fixer-1'}, 'to': {'kind': 'agent', 'id': 'hunter-2'}}, AGENT_SOURCE,
     'agent may not send msg.steer'),
    # The board says the conductor only for steering, and the API never claims to be the conductor.
    ({'from': {'kind': 'system', 'id': 'board'}, 'to': {'kind': 'agent', 'id': 'fixer-2'}}, BOARD,
     'steering from system may not go to agent'),
    ({'from': RELAY, 'to': {'kind': 'agent', 'id': 'fixer-2'}}, API, 'from.kind conductor is not what the source api'),
    ({'from': {'kind': 'supervisor', 'id': 'sup'}, 'to': {'kind': 'agent', 'id': 'fixer-2'}},
     'voc.engineering/supervisor', 'supervisor may not send msg.steer'),
])
def test_everyone_else_is_refused(changes, source, why):
    verdict = judge(steer(**changes), source)
    assert not verdict.allowed
    assert verdict.reason.startswith(why)


def test_the_board_relays_only_steering_as_the_conductor():
    relayed = parse(message(type='msg.handoff', refs={'s3': []}, **{'from': RELAY}))
    assert judge(relayed, BOARD).reason == 'board may not send msg.handoff'
    answer = parse(message(type='msg.answer', refs={'s3': []}, **{'from': RELAY}))
    assert not judge(answer, BOARD).allowed


def test_steering_to_a_role_is_a_message_the_schema_takes_and_the_router_delivers_to_the_role():
    relayed = steer(**{'from': RELAY, 'to': {'kind': 'role', 'id': 'fixer'}})
    assert route(relayed) == (Destination(DELIVERY, role='fixer'),)
    assert route(steer(**{'from': HUMAN, 'to': {'kind': 'conductor', 'id': RUN}})) == (Destination(DELIVERY),)


def test_only_a_posted_task_and_steering_go_to_a_role():
    with pytest.raises(MessageError, match='addressed to a role'):
        parse(message(type='msg.answer', to={'kind': 'role', 'id': 'fixer'}))
    with pytest.raises(MessageError, match='addressed to a role'):
        parse(message(type='task.posted', task_id='t-1', to={'kind': 'agent', 'id': 'fixer-1'}))
    with pytest.raises(MessageError, match='unknown role'):
        steer(**{'from': RELAY, 'to': {'kind': 'role', 'id': 'janitor'}})


def test_a_restart_signal_is_a_persons_alone():
    restart = parse(message(type='signal.restart', refs={'s3': []}, to={'kind': 'run', 'id': RUN}, **{'from': HUMAN}))
    assert judge(restart, API).allowed
    by_supervisor = parse(message(type='signal.restart', refs={'s3': []}, to={'kind': 'run', 'id': RUN},
                                  **{'from': {'kind': 'supervisor', 'id': 'sup'}}))
    assert judge(by_supervisor, 'voc.engineering/supervisor').reason == 'supervisor may not send signal.restart'
