"""Test support: a fictional failure of the Fixer, the answers a model could give, and a recorded model."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from engineering.coach.failure import Evidence, Failure
from engineering.coach.model import COACH_MODEL, CoachReply
from engineering.skills.test.fixtures import INSTRUCTIONS, RUN

CONN = 'conn-harbor'
TASK = 'T-0003'
CASES = ('slug-cut-bug', 'duration-hours-feature', 'pagination-review', 'monorepo-units-bug')
FENCE = 'f00dfeedcafe0001'
STRICTER = INSTRUCTIONS + "\nRun the package's whole test suite before you submit."


def evidence(**changes: Any) -> Evidence:
    fields: dict[str, Any] = {
        'task': 'Fix the slug helper: it cuts words in half at the length limit.',
        'conversation': ('I changed slugify to cut at the limit.', 'The unit tests pass for the helper.'),
        'outputs': ('FAIL test_slug_keeps_whole_words (expected "harbor-lantern", got "harbor-lan")',),
        'comments': ('The gate said NO-GO: the change was not tested with the whole suite.',)}
    return Evidence(**{**fields, **changes})


def failure(**changes: Any) -> Failure:
    fields: dict[str, Any] = {'run_id': RUN, 'connection': CONN, 'role': 'fixer', 'task_id': TASK, 'attempt': 1,
                              'kind': 'no_go', 'evidence': evidence()}
    return Failure(**{**fields, **changes})


def answer(**changes: Any) -> dict[str, Any]:
    """A well-formed answer: a stricter test rule, the examples kept, one more."""
    fields: dict[str, Any] = {
        'instructions': STRICTER,
        'examples': [{'situation': 'The failing test passes when run again.',
                      'action': 'Report it as flaky with both runs; do not change code.'},
                     {'situation': 'Your fix passes its own test.',
                      'action': "Run the package's whole suite before you submit, and say that you did."}],
        'why': 'The fix passed its own test but broke the suite; the agent now runs the whole suite first.',
        'expected_case': 'slug-cut-bug'}
    return {**fields, **changes}


@dataclass
class RecordedModel:
    """Answers with ``replies`` in order and keeps every (system, prompt) it was asked."""

    replies: list[str]
    asked: list[tuple[str, str]] = field(default_factory=list)
    #: The model each reply says answered.
    answered_by: str = COACH_MODEL

    def __call__(self, system: str, prompt: str) -> CoachReply:
        self.asked.append((system, prompt))
        if not self.replies:
            raise AssertionError(f'no recorded reply left (call {len(self.asked)})')
        return CoachReply(self.replies.pop(0), self.answered_by)


def replying(data: Any) -> RecordedModel:
    return RecordedModel([data if isinstance(data, str) else json.dumps(data)])
