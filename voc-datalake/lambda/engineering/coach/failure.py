"""A failure the coach learns from: which run, connection, role, task and attempt failed, how, and its evidence.

The caller (the run's retrospective, ``learning/loop.py``) builds the record from the run's own
rows, never from what an agent says about itself: the connection is the run's, so the coach's proposal can be held
to it. The evidence is what the coach reads: the task an agent was given, excerpts of its conversation, its
outputs (a check's log, a gate's findings) and people's comments (a review, a rejection). All of it is text anyone
with access to the repository or the run could have written, so it is bounded here, every credential-shaped string
in it replaced (``quality_gate.text.redact``, the gate's and the bus's helper), and the prompt fences it as data.
A record over a bound is refused, never cut: the caller chooses what to keep.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final

from engineering.bus.schema import ID, ULID, WS
from engineering.connectors.identity import AGENT_ROLES, WORKSPACE
from engineering.quality_gate.text import redact
from engineering.skills.model import FAILURE_KINDS
from engineering.workspace.layout import CONNECTION

MAX_TASK: Final = 4_000
MAX_EXCERPTS: Final = 12
MAX_EXCERPT: Final = 2_000
MAX_OUTPUTS: Final = 8
MAX_OUTPUT: Final = 4_000
MAX_COMMENTS: Final = 12
MAX_COMMENT: Final = 1_000
#: All of a failure's evidence together, so the prompt stays a fraction of a model's context.
MAX_EVIDENCE: Final = 40_000
MAX_ATTEMPT: Final = 1_000


class CoachError(ValueError):
    """What the coach refuses (a malformed failure, a model's answer it will not propose), with a plain reason;
    ``kind`` is what a route would answer it as (invalid: 400, conflict: 409)."""

    kind = 'invalid'


def _text(value: object, what: str, limit: int) -> str:
    """``value`` as redacted text of 1-``limit`` characters, or CoachError naming ``what``."""
    if not isinstance(value, str) or not value.strip() or '\x00' in value:
        raise CoachError(f'{what} is non-empty text without NUL characters')
    clean = redact(value)
    if len(clean) > limit:
        raise CoachError(f'{what} is at most {limit} characters (it has {len(clean)}): keep the part that matters')
    return clean


def _texts(values: object, what: str, most: int, limit: int) -> tuple[str, ...]:
    if not isinstance(values, tuple):
        raise CoachError(f'{what} are a tuple of texts')
    if len(values) > most:
        raise CoachError(f'a failure carries at most {most} {what}')
    return tuple(_text(value, f'one of the {what}', limit) for value in values)


@dataclass(frozen=True)
class Evidence:
    """What the coach reads about a failure, redacted on the way in."""

    task: str
    conversation: tuple[str, ...] = ()
    outputs: tuple[str, ...] = ()
    comments: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, 'task', _text(self.task, "the task's text", MAX_TASK))
        object.__setattr__(self, 'conversation',
                           _texts(self.conversation, 'conversation excerpts', MAX_EXCERPTS, MAX_EXCERPT))
        object.__setattr__(self, 'outputs', _texts(self.outputs, 'outputs', MAX_OUTPUTS, MAX_OUTPUT))
        object.__setattr__(self, 'comments', _texts(self.comments, "people's comments", MAX_COMMENTS, MAX_COMMENT))
        total = sum(map(len, (self.task, *self.conversation, *self.outputs, *self.comments)))
        if total > MAX_EVIDENCE:
            raise CoachError(f"a failure's evidence is at most {MAX_EVIDENCE} characters in all (it has {total})")


@dataclass(frozen=True)
class Failure:
    """One agent's failure on one attempt of one task, in a run for a connection."""

    run_id: str
    connection: str
    role: str
    task_id: str
    attempt: int
    kind: str
    evidence: Evidence
    ws: str = WORKSPACE

    def __post_init__(self) -> None:
        self._check_ids()
        if self.role not in AGENT_ROLES:
            raise CoachError('the role is an agent role')
        if self.role == 'coach':
            raise CoachError("the coach never proposes its own skill: a person writes it")
        if not _whole(self.attempt, MAX_ATTEMPT):
            raise CoachError(f"the attempt is a whole number from 0 to {MAX_ATTEMPT}")
        if self.kind not in FAILURE_KINDS:
            raise CoachError(f'a failure is one of {sorted(FAILURE_KINDS)}')
        if not _is(self.evidence, Evidence):
            raise CoachError("a failure carries its evidence")

    def _check_ids(self) -> None:
        for value, pattern, what in ((self.run_id, ULID, 'the run id is a ULID'),
                                     (self.connection, CONNECTION, 'the connection is a connection id'),
                                     (self.task_id, ID, 'the task id is a board task id'),
                                     (self.ws, WS, 'the workspace is a workspace id')):
            if not _matches(value, pattern):
                raise CoachError(what)


# A record is built from rows and model-adjacent text, so its fields are checked as they are at run time, whatever
# their annotations say (these take ``object`` for that).
def _whole(value: object, most: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= most


def _matches(value: object, pattern: re.Pattern[str]) -> bool:
    return isinstance(value, str) and pattern.match(value) is not None


def _is(value: object, kind: type) -> bool:
    return isinstance(value, kind)
