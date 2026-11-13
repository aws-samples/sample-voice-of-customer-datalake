"""The harness's inbox reader (harness/board_client.InboxHttp) against the board API's real ``inbox`` op and its
paging (board/api.py, board/inbox.py, rows.TAIL_WINDOW): every notice taken once, a late delivery below the cursor
taken on the next read, and a continuation's cursor reading again only what was not done."""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from engineering import rows
from engineering.board.api import BoardApi
from engineering.board.inbox import Inbox
from engineering.board.store import BoardStore
from engineering.board.test.table import RUN, TABLE, engineering_table
from engineering.board.test.test_inbox import notice
from engineering.bus.publish import EventBridgePublisher
from engineering.connectors.identity import Caller
from engineering.runtime.harness import board_client
from engineering.runtime.harness.board_client import BoardRefused, InboxHttp
from engineering.runtime.test.test_engineering_board_bus import Events

FIXER = Caller('fixer', RUN, 1)
#: Every seq the delivery function numbered for this agent's inboxes but one (115, delivered late).
DELIVERED = [seq for seq in range(1, 121) if seq != 115]


class ApiTransport:
    """The board API in process, as the harness's signed transport sees it: the answer's body, or ``BoardRefused``."""

    def __init__(self, api: BoardApi, caller: Caller) -> None:
        self.api, self.caller = api, caller
        self.calls = 0

    def post(self, body: dict[str, Any]) -> dict[str, Any]:
        self.calls += 1
        answer = self.api.handle_request(self.caller, json.dumps(body))
        payload = json.loads(answer['body'])
        if answer['statusCode'] != 200:
            raise BoardRefused(answer['statusCode'], str(payload.get('error', '')))
        return payload


@pytest.fixture
def board() -> Iterator[tuple[Any, ApiTransport]]:
    with engineering_table() as client:
        api = BoardApi(BoardStore(client, TABLE, new_id=lambda: 'task-1'),
                       EventBridgePublisher(Events(), 'voc-engineering', 'voc.engineering/board'), Inbox(client, TABLE))
        yield client, ApiTransport(api, FIXER)


def _deliver(client: Any, seqs: list[int]) -> None:
    for seq in seqs:   # the agent's own inbox and its role's, interleaved; another agent's never read
        notice(client, 'agent:fixer-1' if seq % 2 else 'role:fixer', seq)
        notice(client, 'agent:fixer-2', 1000 + seq)


def _seqs(reader: InboxHttp) -> list[int]:
    return [int(message.summary.removeprefix('notice ')) for message in reader.take(run_id=RUN, agent_id='fixer-1')]


def test_the_harness_keeps_the_boards_re_read_window():
    # The harness ships alone in the agents' images, so it keeps its own copy of the board's number.
    assert board_client.TAIL_WINDOW == rows.TAIL_WINDOW


def test_every_notice_is_taken_once_across_the_boards_pages_and_a_late_one_on_the_next_read(board):
    client, transport = board
    _deliver(client, DELIVERED)
    reader = InboxHttp(transport, RUN, 'fixer-1')
    assert _seqs(reader) == DELIVERED   # three pages of 50, each re-reading the window below its cursor
    assert transport.calls == 3
    notice(client, 'agent:fixer-1', 115)   # a delivery that committed after the cursor passed its number
    assert _seqs(reader) == [115]
    assert _seqs(reader) == []


def test_a_continuation_reads_again_only_what_its_checkpoint_had_not_done(board):
    client, transport = board
    _deliver(client, DELIVERED)
    first = InboxHttp(transport, RUN, 'fixer-1')
    taken = first.take(run_id=RUN, agent_id='fixer-1')
    first.done([message.event_id for message in taken[:100]])   # the model saved its notes after these
    notice(client, 'agent:fixer-1', 115)
    cursor = first.cursor()
    continuation = InboxHttp(transport, RUN, 'fixer-1')
    continuation.resume(json.loads(json.dumps(cursor)))   # as a checkpoint stores it
    assert sorted(_seqs(continuation)) == [*range(101, 121)]   # the open ones, the late 115 among them
