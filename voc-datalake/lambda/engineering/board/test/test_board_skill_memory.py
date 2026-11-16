"""The board's ``skill`` and ``memory`` ops (7.50.00): a session's skill by the label its launch recorded (never one
it names), and its task's approved lessons, as its run's flow sets the recall."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import pytest

from engineering.agent_memory.recall import Recall
from engineering.board.test.table import RUN, TABLE, engineering_table
from engineering.board.test.test_board_ops import COORDINATOR, FIXER, Board, _board, call, fixer_task
from engineering.connectors.identity import Caller
from engineering.knowledge.store import Actor
from engineering.rows import run_pk
from engineering.runtime.harness.skills import SKILLS
from engineering.skills.model import Reason
from engineering.skills.store import SHARED, SkillStore
from engineering.skills.templates import BundleTemplates
from engineering.skills.test.fixtures import content

WS = 'default'
ADMIN = Actor('admin-sub-1', 'person', admin=True)


@dataclass
class Memories:
    """The agent memory's recall: what it was asked, and the text it answers."""

    text: str = '<<<DATA agent-memory f00d>>>\n- [mem-1 v1] repository · convention · tests: run pytest -q\n'
    asked: list[dict[str, Any]] = field(default_factory=list)

    def recall_for_task(self, ws: str, run: Any, *, max_memories: int = 12, max_chars: int = 4_000,
                        kinds: frozenset[str] = frozenset({'repository', 'role'})) -> Recall:
        self.asked.append({'ws': ws, 'connection': run.connection, 'run': run.run_id, 'role': run.role,
                           'people': run.people, 'max': max_memories, 'chars': max_chars, 'kinds': kinds})
        return Recall(self.text, (), 0)


@pytest.fixture
def board() -> Iterator[Board]:
    with engineering_table() as client:
        made = _board(client, None)
        made.api.skills = SkillStore(client, TABLE)
        made.api.templates = BundleTemplates.shipped()
        made.api.memories = Memories()
        yield made


def _session(board: Board, agent: str, label: str) -> None:
    """The agent's session row as a launch writes it, with the skill label it resolved."""
    board.client.put_item(TableName=TABLE, Item={'pk': {'S': run_pk(WS, RUN)}, 'sk': {'S': f'AGENT#{agent}'},
                                                 'role': {'S': agent.rsplit('-', 1)[0]},
                                                 'skill_version': {'S': label}})


def test_a_session_gets_the_skill_its_launch_recorded_with_the_platforms_rules(board: Board) -> None:
    _session(board, 'fixer-1', f'fixer@template-{SKILLS["fixer"].version}')
    status, body = call(board, FIXER, op='skill', label='fixer@1')   # (a label in the body is never read)
    assert status == 200
    assert body['label'] == f'fixer@template-{SKILLS["fixer"].version}'
    assert body['record'] == SKILLS['fixer'].to_record()
    assert body['platform_rules'] == ''   # (the shipped templates: the harness's own rules)


def test_a_store_label_is_served_only_while_it_is_an_accepted_version_of_the_runs_connection(board: Board) -> None:
    store = board.api.skills
    assert isinstance(store, SkillStore)
    proposed = store.propose_version(WS, SHARED, 'fixer', content(), proposer=ADMIN, reason=Reason(comment='x'),
                                     base=None)
    _session(board, 'fixer-1', 'fixer@1')
    status, body = call(board, FIXER, op='skill')
    assert (status, 'not accepted' in body['error']) == (409, True)
    store.accept_version(WS, SHARED, 'fixer', proposed.version.version, ADMIN)
    status, body = call(board, FIXER, op='skill')
    assert (status, body['label'], body['record']['instructions']) == (200, 'fixer@1', content().instructions)
    # Another connection's version: never this run's (its connection is repo-1).
    _session(board, 'fixer-1', 'fixer@repo-2/1')
    assert call(board, FIXER, op='skill')[0] == 403


@pytest.mark.parametrize(('label', 'status'), [('', 404), ('fixer@template-99', 409), ('hunter@1', 403),
                                               ('fixer@7', 404), ('nonsense', 404)])
def test_a_label_the_board_cannot_serve_is_refused_never_another_skill(board: Board, label: str,
                                                                        status: int) -> None:
    if label:
        _session(board, 'fixer-1', label)
    assert call(board, FIXER, op='skill')[0] == status


def test_without_a_session_row_or_a_store_nothing_is_served(board: Board) -> None:
    assert call(board, Caller('fixer', RUN, 5), op='skill')[0] == 404
    board.api.skills = None
    _session(board, 'fixer-1', 'fixer@1')
    assert call(board, FIXER, op='skill')[0] == 503


def _flow(board: Board, memory: dict[str, Any] | None) -> None:
    """The run's own copy of a flow whose start step sets the recall (or none)."""
    params = {} if memory is None else {'memory': memory}
    definition = {'schema': 'voc-workflow/2', 'nodes': [{'id': 'start', 'type': 'start',
                                                         'data': {'params': params}}], 'edges': []}
    board.client.put_item(TableName=TABLE, Item={'pk': {'S': run_pk(WS, RUN)}, 'sk': {'S': 'FLOW'},
                                                 'definition': {'S': json.dumps(definition)}})


def _claimed(board: Board) -> str:
    task = fixer_task(board)
    status, _ = call(board, FIXER, op='claim', task_id=task)
    assert status == 200
    return task


def test_a_task_recalls_the_approved_lessons_its_flow_asks_for(board: Board) -> None:
    task = _claimed(board)
    memories = board.api.memories
    assert isinstance(memories, Memories)
    # No flow (or a flow that sets no recall): nothing recalled, and nothing asked of memory.
    assert call(board, FIXER, op='memory', task_id=task) == (200, {'memories': []})
    _flow(board, {'recall': True, 'scopes': ['repo'], 'limit': 4})
    status, body = call(board, FIXER, op='memory', task_id=task)
    assert (status, body) == (200, {'memories': [memories.text]})
    assert memories.asked == [{'ws': WS, 'connection': 'repo-1', 'run': RUN, 'role': 'fixer', 'people': (),
                               'max': 4, 'chars': 4_000, 'kinds': frozenset({'repository'})}]
    memories.text = ''
    assert call(board, FIXER, op='memory', task_id=task) == (200, {'memories': []})


def test_memory_is_read_only_for_the_task_whose_lease_the_caller_holds(board: Board) -> None:
    task = fixer_task(board)   # (posted before the run's flow copy: a flow's posts name its steps)
    _flow(board, {'recall': True})
    assert call(board, FIXER, op='memory', task_id=task)[0] == 403
    assert call(board, COORDINATOR, op='memory', task_id=task)[0] == 403
    board.api.memories = None
    assert call(board, FIXER, op='memory', task_id=task)[0] == 503
