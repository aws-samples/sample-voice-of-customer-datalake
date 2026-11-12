"""What the agents remember: a memory's scope, its statement and provenance, and a pack proposal. Pure, no I/O.

Three scopes (docs/autonomous-engineering.md, "Agent memory"):

- **repository**: one connection's conventions, reviewer preferences, recurring bugs, flaky tests and what the gates
  usually catch;
- **role**: one agent role's lessons, within one connection (one connection's lessons never reach another's agents);
- **person**: how one person likes their pull requests. Only for a signed-in user of this deployment (the store
  asks the deployment's user directory), never for someone who exists only on the host. A person's own memory
  applies to every connection (``connection`` ``''``); one an agent learned applies only to the connection of the
  run it was learned in.

A statement follows the memory layer's hygiene (``shared.memory_policy.clean_statement``: an instruction-shaped,
profane or judging statement is refused, personal data is redacted, quotations of six words or more are dropped),
after credential-shaped strings are replaced (``quality_gate.text.redact``) and the patterns of
``shared.pii_redaction`` are applied, and is refused outright when it holds, verbatim, a sentence of a review the
run cited (``connectors.write_policy.text_refusals``): a memory holds feedback ids, never review text.
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Final, Literal

from engineering.bus.schema import ID, ULID
from engineering.connectors.identity import AGENT_ROLES
from engineering.connectors.write_policy import text_refusals
from engineering.knowledge.notes import MAX_CLAIM, SUBJECT
from engineering.knowledge.store import Actor
from engineering.quality_gate.text import redact
from engineering.workspace.layout import CONNECTION
from shared import memory_policy as policy
from shared.pii_redaction import redact_text

ScopeKind = Literal['repository', 'role', 'person']
SCOPE_KINDS: Final[tuple[ScopeKind, ...]] = ('repository', 'role', 'person')
#: What a memory is about, by scope.
KINDS_BY_SCOPE: Final[Mapping[ScopeKind, tuple[str, ...]]] = {
    'repository': ('convention', 'reviewer_preference', 'recurring_bug', 'flaky_test', 'gate_catch'),
    'role': ('lesson',),
    'person': ('preference',),
}
#: The knowledge pack's document a confirmed memory of this kind is proposed for (``knowledge.notes.KINDS``).
PACK_DOCUMENT: Final[Mapping[str, str]] = {
    'convention': 'convention', 'reviewer_preference': 'review-guide', 'recurring_bug': 'how-we-work',
    'flaky_test': 'test-strategy', 'gate_catch': 'ci', 'lesson': 'how-we-work',
}
#: A statement's length: the pack's claim bound, so a lesson proposed for the pack fits it as a claim.
MAX_STATEMENT: Final = MAX_CLAIM
MAX_FEEDBACK_IDS: Final = 20
#: A learned memory needs the memory layer's confidence for an automated write; below it, it is not kept.
LEARNED_CONFIDENCE_MIN: Final = policy.AUTO_CONFIDENCE_MIN
#: A memory's review date: 90 days ahead unless given (the memory layer's decay), at most a year ahead.
DEFAULT_REVIEW_DAYS: Final = policy.DECAY_RETENTION_DAYS
MAX_REVIEW_DAYS: Final = 365
#: Distinct confirmations (runs, comments, people) after which an approved repository or role memory is proposed
#: for the knowledge pack.
PACK_CONFIRMATIONS: Final = 3
#: The people on one task whose memories are read.
MAX_PEOPLE: Final = 10
_HTTPS: Final = re.compile(r'https://[^\s?]{1,500}\Z')


class AgentMemoryError(ValueError):
    """An agent memory operation refused: ``kind`` is invalid here, and not_found, forbidden or conflict in the
    store's subclasses (what a REST route answers 400, 404, 403 or 409)."""

    kind = 'invalid'


@dataclass(frozen=True)
class Scope:
    """Where a memory lives. ``connection``: the repository's or the role's connection; for a person, the
    connection a learned memory applies to (``''``: the person's own, for every connection)."""

    kind: ScopeKind
    connection: str = ''
    role: str = ''
    person: str = ''

    def __post_init__(self) -> None:
        if self.kind not in SCOPE_KINDS:
            raise AgentMemoryError(f'a scope is one of {list(SCOPE_KINDS)}')
        if self.connection and not CONNECTION.fullmatch(self.connection):
            raise AgentMemoryError('not a connection id')
        if self.kind != 'person' and not self.connection:
            raise AgentMemoryError(f'a {self.kind} memory belongs to a connection')
        if (self.kind == 'role') != bool(self.role) or (self.role and self.role not in AGENT_ROLES):
            raise AgentMemoryError('a role memory names an agent role, and only a role memory does')
        if (self.kind == 'person') != bool(self.person) or (self.person and not ID.fullmatch(self.person)):
            raise AgentMemoryError("a person memory names the person's user id, and only a person memory does")

    def partition(self, ws: str) -> str:
        """The scope's partition in ``voc-engineering`` (a person's holds every connection's memories of them)."""
        if self.kind == 'repository':
            return f'WS#{ws}#AMEM#REPO#{self.connection}'
        if self.kind == 'role':
            return f'WS#{ws}#AMEM#ROLE#{self.connection}#{self.role}'
        return f'WS#{ws}#AMEM#PERSON#{self.person}'

    @property
    def label(self) -> str:
        """How recall names the scope (never the person's id: the people on the task are the prompt's)."""
        return f'role:{self.role}' if self.kind == 'role' else self.kind


@dataclass(frozen=True)
class Provenance:
    """Where a memory or a confirmation came from: exactly one of a run (its ULID), a review comment on the
    connection's own host (checked against its ``CitationRules`` by the store), or a person (their user id)."""

    run_id: str = ''
    comment_url: str = ''
    person: str = ''

    def __post_init__(self) -> None:
        if sum(map(bool, (self.run_id, self.comment_url, self.person))) != 1:
            raise AgentMemoryError('a provenance is one run, one review comment or one person')
        if self.run_id and not ULID.fullmatch(self.run_id):
            raise AgentMemoryError('a run id is a ULID')
        if self.comment_url and not _HTTPS.fullmatch(self.comment_url):
            raise AgentMemoryError("a comment's provenance is its https URL, with no query string")
        if self.person and not ID.fullmatch(self.person):
            raise AgentMemoryError('not a user id')

    @property
    def source(self) -> str:
        """One source, as a confirmation counts it once."""
        if self.run_id:
            return f'run:{self.run_id}'
        return f'comment:{self.comment_url}' if self.comment_url else f'person:{self.person}'


@dataclass(frozen=True)
class RunContext:
    """An agent as its run's record says it is: built by the trusted caller (the supervisor, the harness's
    launcher) from the run's record, never from what the agent asks. ``agent``: its Actor (its connection is the
    run's); ``run_id``: the run; ``role``: the agent's role in it; ``people``: the signed-in users on its task."""

    agent: Actor
    run_id: str
    role: str
    people: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.agent.kind != 'agent' or not self.agent.connection:
            raise AgentMemoryError("a run's agent acts for the run's connection")
        if not ULID.fullmatch(self.run_id):
            raise AgentMemoryError('a run id is a ULID')
        if self.role not in AGENT_ROLES:
            raise AgentMemoryError('not an agent role')
        if len(self.people) > MAX_PEOPLE or not all(ID.fullmatch(p) for p in self.people):
            raise AgentMemoryError(f'a task names at most {MAX_PEOPLE} people, by their user ids')

    @property
    def connection(self) -> str:
        return self.agent.connection


def check_confidence(value: object) -> float:
    # NaN fails both comparisons; a bool is an int, and never a confidence.
    if isinstance(value, int | float) and not isinstance(value, bool) and 0 <= value <= 1:
        return float(value)
    raise AgentMemoryError('a confidence is a number from 0 to 1')


def check_subject(subject: object) -> str:
    """A few lower-case words naming what the memory is about: two memories of one scope on one subject say the
    same thing (a confirmation) or disagree (a conflict)."""
    if not isinstance(subject, str) or not SUBJECT.fullmatch(subject):
        raise AgentMemoryError('a subject is 1-80 lower-case letters, digits, spaces, dots, dashes or underscores')
    return subject


def check_kind(scope: Scope, kind: object) -> str:
    allowed = KINDS_BY_SCOPE[scope.kind]
    if kind not in allowed:
        raise AgentMemoryError(f'a {scope.kind} memory is one of {list(allowed)}')
    return str(kind)


def check_feedback_ids(ids: Iterable[object]) -> tuple[str, ...]:
    found = tuple(ids)
    if len(found) > MAX_FEEDBACK_IDS or not all(isinstance(i, str) and ID.fullmatch(i) for i in found):
        raise AgentMemoryError(f'a memory cites at most {MAX_FEEDBACK_IDS} feedback ids')
    return tuple(str(i) for i in found)


def review_date(today: date, wanted: date | None) -> date:
    """The review date: ``wanted`` (after today, at most ``MAX_REVIEW_DAYS`` ahead), else ``DEFAULT_REVIEW_DAYS``
    ahead."""
    if wanted is None:
        return today + timedelta(days=DEFAULT_REVIEW_DAYS)
    if not today < wanted <= today + timedelta(days=MAX_REVIEW_DAYS):
        raise AgentMemoryError(f'a review date is after today and at most {MAX_REVIEW_DAYS} days ahead')
    return wanted


def clean_statement(raw: object, review_texts: Iterable[str]) -> str:
    """The statement as it is stored, or ``AgentMemoryError``: never a review's sentence (``review_texts``: the
    reviews the run cited), no credential, no personal data, no instruction aimed at a model."""
    if not isinstance(raw, str) or not raw.strip() or len(raw) > MAX_STATEMENT:
        raise AgentMemoryError(f'a statement is text of 1-{MAX_STATEMENT} characters')
    if text_refusals(raw, review_texts, prose=False):
        raise AgentMemoryError('a memory never quotes a customer review: cite its feedback id instead')
    cleaned = policy.clean_statement(redact_text(redact(raw)).text, restricted_source=True)
    if cleaned.statement is None:
        raise AgentMemoryError(f'the statement is refused ({cleaned.reason})')
    return cleaned.statement


def statement_key(text: str) -> str:
    """What two statements that say the same share: case, spacing and a final full stop aside."""
    return ' '.join(text.casefold().split()).rstrip('.')


def same_statement(a: str, b: str) -> bool:
    return statement_key(a) == statement_key(b)


@dataclass(frozen=True)
class MemoryInput:
    """What is to be remembered (a learned memory, or a person's)."""

    subject: str
    kind: str
    statement: str
    provenance: Provenance
    confidence: float = 1.0
    review_by: date | None = None
    feedback_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class PackProposal:
    """A lesson confirmed often enough, proposed for the connection's knowledge pack: the store writes nothing to
    the pack; an administrator turns it into an edit (``knowledge.reduce.Edit``) or leaves it."""

    connection: str
    memory_id: str
    version: int
    document: str
    subject: str
    claim: str
    confirmations: int
    #: The review comments on the connection's host the memory and its confirmations came from.
    citations: tuple[str, ...]
    feedback_ids: tuple[str, ...]
