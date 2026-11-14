"""Property of the GO ledger (records.py ``has_go``, the rule of flow/ledger.py ``go_tree``): the run is GO for a tree
exactly when its newest ended final-go task is done with a clean GO record for that tree, and the newest ended gate
runner task is done with a passing GO record on that same tree.

The model is the sentence the docs give: the latest final-go task that ended decides, whatever its state; an older
task's passing record never stands in for a newer one; an unfinished task counts for nothing; a final go's GO after a
gate runner's NO-GO, STOPPED, failure, failed check or other tree is no GO. Each case builds its own moto table and
bucket, so the examples are fewer than the usual 256 (the cost is the fixture, not the logic).
"""
from __future__ import annotations

from dataclasses import dataclass

import boto3
from hypothesis import example, given, settings
from hypothesis import strategies as st
from moto import mock_aws

from engineering.board.model import DONE, FAILED, IN_PROGRESS, NEEDS_HUMAN
from engineering.board.test.table import create_table
from engineering.connectors.test.fakes import RUN, TREE
from engineering.connectors.test.test_records import BUCKET, OTHER_TREE, checked_record, final_go, gate_record, ledger
from shared.test.properties import PROPERTY

CASES = settings(PROPERTY, max_examples=80)
FINAL_GO = 'final-go'
GATE_RUNNER = 'gate-runner'
BUILDER = 'builder'
#: A task's state as the board leaves it: an ended one (done, failed, needs a person) or one still in progress.
STATES = st.sampled_from([DONE, FAILED, NEEDS_HUMAN, IN_PROGRESS])
#: The gate record the task's agent wrote: a GO, a NO-GO, or a run the gate stopped.
VERDICTS = st.sampled_from(['GO', 'NO-GO', 'STOPPED'])
TREES = st.sampled_from([TREE, TREE, OTHER_TREE, ''])
STOPS = st.sampled_from(['', '', 'budget cap reached'])   # a clean GO has no stop; most generated ones are clean
CHECKS = st.sampled_from(['pass', 'pass', 'fail'])         # a gate runner's one check
ROLES = st.sampled_from([FINAL_GO, FINAL_GO, GATE_RUNNER, GATE_RUNNER, BUILDER])


@dataclass(frozen=True)
class Task:
    state: str
    verdict: str
    tree: str
    stop: str
    check: str
    role: str


ANY_TASK = st.builds(Task, STATES, VERDICTS, TREES, STOPS, CHECKS, ROLES)
#: A gate runner's passing GO and then a final go's clean GO on one tree: the one way a run gets a GO. Random tasks
#: alone make one about once in a thousand cases, so pairs are drawn on purpose; the tasks after a pair decide whether
#: it still stands.
GO_PAIR = st.sampled_from([TREE, OTHER_TREE]).map(lambda tree: [Task(DONE, 'GO', tree, '', 'pass', GATE_RUNNER),
                                                                 Task(DONE, 'GO', tree, '', 'pass', FINAL_GO)])
TASKS = st.lists(st.one_of(ANY_TASK.map(lambda task: [task]), GO_PAIR), max_size=4).map(
    lambda groups: [task for group in groups for task in group])


def newest_ended(tasks: list[Task], role: str) -> Task | None:
    """The ``role`` task that ended last (the list's order is the order the board stamped them in)."""
    ended = [task for task in tasks if task.role == role and task.state != IN_PROGRESS]
    return ended[-1] if ended else None


def model_go_tree(tasks: list[Task]) -> str:
    """The rule in words: the newest ended final go is done with a GO (its own GO, no stop) on a tree; the newest ended
    gate runner is done with a GO (no stop, its check passed) on that same tree. The tree, or '' for no GO."""
    final = newest_ended(tasks, FINAL_GO)
    if final is None or final.state != DONE or final.verdict != 'GO' or final.stop or not final.tree:
        return ''
    gate = newest_ended(tasks, GATE_RUNNER)
    if gate is None or gate.state != DONE or gate.verdict != 'GO' or gate.stop or gate.check != 'pass':
        return ''
    return final.tree if gate.tree == final.tree else ''


def store(client: object, s3: object, attempt: int, task: Task) -> None:
    """The task as the board leaves it, with its own holder's record under its own attempt's key."""
    stamp = f'2026-11-13T{attempt:02d}:00:00+00:00'
    if task.role == GATE_RUNNER:
        final_go(client, s3, f't{attempt}', checked_record(task.verdict, task.tree, stop=task.stop, status=task.check),
                 state=task.state, attempt=attempt, role=GATE_RUNNER, holder='gate-runner-3', writer='gate-runner-3',
                 updated_at=stamp)
    else:
        final_go(client, s3, f't{attempt}', gate_record(task.verdict, task.tree, task.stop), state=task.state,
                 attempt=attempt, role=task.role, updated_at=stamp)


PAIR = [Task(DONE, 'GO', TREE, '', 'pass', GATE_RUNNER), Task(DONE, 'GO', TREE, '', 'pass', FINAL_GO)]


@CASES
@given(tasks=TASKS)
@example(tasks=PAIR)                                                              # a GO for TREE
@example(tasks=[*PAIR, Task(DONE, 'NO-GO', TREE, '', 'pass', FINAL_GO)])           # a newer final go's NO-GO
@example(tasks=[*PAIR, Task(FAILED, 'GO', TREE, '', 'pass', GATE_RUNNER)])         # a newer gate runner failed
@example(tasks=[*PAIR, Task(DONE, 'GO', OTHER_TREE, '', 'pass', GATE_RUNNER)])     # a newer gate runner, another tree
@example(tasks=[*PAIR, Task(IN_PROGRESS, 'NO-GO', TREE, '', 'fail', FINAL_GO)])    # unfinished: the GO stands
def test_the_newest_ended_final_go_and_gate_runner_decide_and_nothing_else_stands_in(tasks: list[Task]) -> None:
    """The run is GO for a tree only when the newest ended final go is a clean GO for exactly that tree and the newest
    ended gate runner passed on that same tree; an older GO, an unfinished task or a builder's task never stands in."""
    with mock_aws():
        client = create_table()
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        for attempt, task in enumerate(tasks, start=1):
            store(client, s3, attempt, task)
        decided = model_go_tree(tasks)
        records = ledger(client, s3)
        assert records.has_go(RUN, TREE) == (decided == TREE)
        assert records.has_go(RUN, OTHER_TREE) == (decided == OTHER_TREE)
        assert not records.has_go(RUN, '')
