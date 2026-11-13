"""The failure record: every field checked, the evidence bounded and redacted on the way in."""
from __future__ import annotations

from typing import Any

import pytest

from engineering.coach.failure import (
    MAX_COMMENTS,
    MAX_EXCERPT,
    MAX_OUTPUT,
    MAX_TASK,
    CoachError,
)
from engineering.coach.test.fakes import CONN, TASK, evidence, failure
from engineering.quality_gate.text import REDACTED
from engineering.skills.model import FAILURE_KINDS
from engineering.skills.test.fixtures import RUN

KEY = 'AKIA' + 'Q' * 16


def test_a_failure_holds_its_run_connection_role_task_attempt_kind_and_evidence() -> None:
    found = failure()
    assert (found.run_id, found.connection, found.role, found.task_id, found.attempt, found.kind, found.ws) == (
        RUN, CONN, 'fixer', TASK, 1, 'no_go', 'default')
    assert found.evidence.outputs[0].startswith('FAIL test_slug_keeps_whole_words')


@pytest.mark.parametrize(('change', 'reason'), [
    ({'run_id': 'run-1'}, 'the run id is a ULID'),
    ({'connection': 'conn/harbor'}, 'the connection is a connection id'),
    ({'connection': 7}, 'the connection is a connection id'),
    ({'task_id': ''}, 'the task id is a board task id'),
    ({'ws': 'Default'}, 'the workspace is a workspace id'),
    ({'role': 'janitor'}, 'the role is an agent role'),
    ({'role': 'coach'}, 'the coach never proposes its own skill'),
    ({'attempt': -1}, 'the attempt is a whole number'),
    ({'attempt': True}, 'the attempt is a whole number'),
    ({'attempt': 1001}, 'the attempt is a whole number'),
    ({'kind': 'flaky'}, 'a failure is one of'),
    ({'evidence': 'the task failed'}, 'a failure carries its evidence'),
])
def test_every_field_is_checked(change: dict[str, Any], reason: str) -> None:
    with pytest.raises(CoachError, match=reason) as refused:
        failure(**change)
    assert refused.value.kind == 'invalid'


@pytest.mark.parametrize('kind', sorted(FAILURE_KINDS))
def test_every_failure_kind_is_a_failure(kind: str) -> None:
    assert failure(kind=kind).kind == kind


def test_the_evidence_is_redacted_on_the_way_in() -> None:
    found = evidence(task=f'Fix it; the key is {KEY}.', conversation=(f'export API_KEY={"x" * 12}',),
                     outputs=(f'token: Bearer {"a" * 24}',), comments=(f'aws key {KEY}',))
    texts = (found.task, *found.conversation, *found.outputs, *found.comments)
    assert all(REDACTED in text for text in texts)
    assert not any(KEY in text or 'x' * 12 in text for text in texts)


@pytest.mark.parametrize(('change', 'reason'), [
    ({'task': ''}, "the task's text is non-empty text"),
    ({'task': '   '}, "the task's text is non-empty text"),
    ({'task': 'a\x00b'}, 'without NUL'),
    ({'task': 7}, "the task's text is non-empty text"),
    ({'task': 'x' * (MAX_TASK + 1)}, f'at most {MAX_TASK} characters'),
    ({'conversation': ['a list']}, 'conversation excerpts are a tuple of texts'),
    ({'conversation': ('',)}, 'one of the conversation excerpts is non-empty text'),
    ({'conversation': ('x' * (MAX_EXCERPT + 1),)}, f'at most {MAX_EXCERPT} characters'),
    ({'outputs': ('x' * (MAX_OUTPUT + 1),)}, f'at most {MAX_OUTPUT} characters'),
    ({'comments': ('ok',) * (MAX_COMMENTS + 1)}, f"at most {MAX_COMMENTS} people's comments"),
    ({'outputs': ('x' * MAX_OUTPUT,) * 8, 'conversation': ('x' * MAX_EXCERPT,) * 5},
     'evidence is at most 40000 characters in all'),
])
def test_the_evidence_is_bounded_and_refused_never_cut(change: dict[str, Any], reason: str) -> None:
    with pytest.raises(CoachError, match=reason):
        evidence(**change)


def test_a_text_is_measured_as_it_is_kept_after_redaction() -> None:
    long = 'x' * (MAX_EXCERPT - 20) + ' Bearer ' + 'a' * 40
    assert len(long) > MAX_EXCERPT
    found = evidence(conversation=(long,))
    assert found.conversation == ('x' * (MAX_EXCERPT - 20) + ' ' + REDACTED,)
