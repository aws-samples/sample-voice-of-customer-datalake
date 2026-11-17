"""The board's steering ops (7.51.00): the coordinator relays a person's steering (``steer``) and sets the run's
direction (``set_direction``, create-only versions); every agent reads the direction (``direction``), and each inbox
page names its version so a harness re-reads it only when it moved."""
from __future__ import annotations

import json
from collections.abc import Iterator

import pytest

from engineering.board.directions import direction_sk
from engineering.board.test.table import RUN, TABLE, engineering_table
from engineering.board.test.test_board_ops import COORDINATOR, FIXER, Board, _board, call
from engineering.board.test.test_progress_repost import Bus
from engineering.bus.publish import EventBridgePublisher
from engineering.bus.senders import judge
from engineering.connectors.identity import Caller
from engineering.rows import run_pk

WS = 'default'


@pytest.fixture
def board() -> Iterator[tuple[Board, Bus]]:
    with engineering_table() as client:
        made = _board(client, None)
        bus = Bus()
        made.api.publisher = EventBridgePublisher(bus, 'voc-engineering', 'voc.engineering/board')
        yield made, bus


def _agent(board: Board, agent: str) -> None:
    board.client.put_item(TableName=TABLE, Item={'pk': {'S': run_pk(WS, RUN)}, 'sk': {'S': f'AGENT#{agent}'},
                                                 'role': {'S': agent.rsplit('-', 1)[0]}})


def test_the_coordinator_relays_steering_to_an_agent_as_the_conductor(board) -> None:
    made, bus = board
    _agent(made, 'fixer-2')
    status, body = call(made, COORDINATOR, op='steer', to={'kind': 'agent', 'id': 'fixer-2'},
                        text='Keep the public divide signature.')
    assert status == 200
    [message] = bus.messages()
    assert (message.type, message.sender.kind, message.sender.id, message.to.kind, message.to.id, message.summary) == (
        'msg.steer', 'conductor', 'coordinator-1', 'agent', 'fixer-2', 'Keep the public divide signature.')
    assert body['event_id'] == message.event_id
    # (the router takes it: the board's source relays steering as the conductor, and only steering)
    assert judge(message, 'voc.engineering/board').allowed
    assert bus.entries[0]['Source'] == 'voc.engineering/board'


def test_steering_to_a_role_reaches_every_agent_of_it(board) -> None:
    made, bus = board
    assert call(made, COORDINATOR, op='steer', to={'kind': 'role', 'id': 'hunter'}, text='Look at parsing only.')[0] \
        == 200
    assert (bus.messages()[0].to.kind, bus.messages()[0].to.id) == ('role', 'hunter')


@pytest.mark.parametrize(('caller', 'body', 'status'), [
    (FIXER, {'to': {'kind': 'agent', 'id': 'fixer-2'}, 'text': 'x'}, 403),   # only the coordinator relays
    (COORDINATOR, {'to': {'kind': 'agent', 'id': 'fixer-9'}, 'text': 'x'}, 400),   # not an agent of the run
    (COORDINATOR, {'to': {'kind': 'agent', 'id': 'coordinator-1'}, 'text': 'x'}, 400),   # never itself
    (COORDINATOR, {'to': {'kind': 'role', 'id': 'coordinator'}, 'text': 'x'}, 400),
    (COORDINATOR, {'to': {'kind': 'run', 'id': RUN}, 'text': 'x'}, 400),
    (COORDINATOR, {'to': {'kind': 'agent', 'id': 'fixer-2'}, 'text': 'é' * 1000}, 400),   # over 1 KB
])
def test_anyone_else_or_anything_else_is_refused(board, caller: Caller, body: dict, status: int) -> None:
    made, bus = board
    _agent(made, 'fixer-2')
    assert call(made, caller, op='steer', **body)[0] == status
    assert bus.entries == []


def test_the_direction_is_versioned_create_only_and_read_by_every_agent(board) -> None:
    made, _ = board
    assert call(made, FIXER, op='direction') == (200, {'version': 0, 'text': ''})
    assert call(made, COORDINATOR, op='set_direction', text='Fix only the parser.') == (200, {'version': 1})
    # A retry of the same direction is the same version; a new one is the next.
    assert call(made, COORDINATOR, op='set_direction', text='Fix only the parser.') == (200, {'version': 1})
    assert call(made, COORDINATOR, op='set_direction', text='Fix the parser and its tests.') == (200, {'version': 2})
    assert call(made, FIXER, op='direction') == (200, {'version': 2, 'text': 'Fix the parser and its tests.'})
    first = made.client.get_item(TableName=TABLE, Key={'pk': {'S': run_pk(WS, RUN)},
                                                       'sk': {'S': direction_sk(1)}})['Item']
    assert (first['text']['S'], first['by']['S']) == ('Fix only the parser.', 'coordinator-1')   # (kept: D1)
    assert call(made, FIXER, op='set_direction', text='Skip the gate.')[0] == 403


def test_every_inbox_page_names_the_directions_version(board) -> None:
    made, _ = board
    assert call(made, FIXER, op='inbox', after=0)[1]['direction'] == 0
    call(made, COORDINATOR, op='set_direction', text='Keep it small.')
    page = call(made, FIXER, op='inbox', after=0)[1]
    assert (page['direction'], page['messages']) == (1, [])


def test_a_set_direction_redacts_and_bounds_its_text(board) -> None:
    made, _ = board
    assert call(made, COORDINATOR, op='set_direction', text='x' * 2001)[0] == 400
    assert call(made, COORDINATOR, op='set_direction', text='use AKIA' + 'B' * 16)[0] == 200
    assert 'AKIA' not in json.dumps(call(made, FIXER, op='direction')[1])
