"""What an administrator reads of the agents' skills and their scorecards (agents_handler.py's ``GET
/agents/engineering/skills…`` and ``GET /agents/engineering/scorecards/<role>``; docs/autonomous-engineering.md,
"Getting better").

Read only, and every read bounded: a GetItem, or one Query of one partition with a page cap, never a whole-table
read. The routes check the caller (an administrator acting for themselves); this module checks every input it is
handed (a role from the agent catalog, a connection id in the stored connections' shape or ``''`` for the shared
skill, a version number from 1 to ``MAX_VERSION``, a page token it made itself) and builds every key from those
checked parts alone.

- **The roles** of a scope (``roles``): each role with a version in it, its current version, the version numbers
  handed out and its newest version's summary line. A ``HEAD`` GetItem per role (13) and, for a role that has one,
  one Query of its newest version.
- **A role's history** (``history``): a page of ``PAGE`` versions, newest first, each read without its record and
  its diff; with each, its log events (accepted, rejected, rolled back, benchmarked: never a promoted version's
  source, which ``SkillStore.events`` leaves out before DynamoDB answers) and its benchmark: the rates the proposer
  claimed, apart from the benchmark an administrator recorded (measured: what readers trust). The next page's token
  is opaque to the caller and checked here: it names the scope it was made for and a checksum, so a token from
  another scope or a changed one is refused (400), and only its version number is used, formatted into the key.
- **A version** (``version``): its line, its whole record and its diff from its base (``skills/diff.py``).
- **The scorecards** (``scorecards``): ``version_card`` per version (``learning/scorecard.py``), at most
  ``MAX_COMPARED`` (``compare``); a connection's own, since a scorecard row is a connection's. Every card is
  labelled with where its number comes from (``SCORE_SOURCE``: the shipped skills', since a session's label names
  no scope and the harness runs only the shipped skills today); by default the shipped version and the shipped ones
  before it, at most ``DEFAULT_COMPARED``, never mixed with the store's numbers.

``promoted_from`` is never read here: the shared version names no connection, and its source stays in the log row
only ``SkillStore.promotion_source`` reads.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Final

from engineering.connectors.connections import CONNECTION_ID
from engineering.connectors.identity import AGENT_ROLES, WORKSPACE
from engineering.learning.scorecard import MAX_COMPARED, ScorecardStore, VersionCard
from engineering.runtime.harness.skills import SKILLS, skill_label
from engineering.skills.diff import to_json
from engineering.skills.model import SkillError
from engineering.skills.store import (
    MAX_PAGE,
    MAX_VERSION,
    SHARED,
    LogEvent,
    RecordedBenchmark,
    SkillStore,
    SkillVersion,
    VersionLine,
)
from engineering.skills.templates import bundled
from shared.workflow_engineering import ENGINEERING_ROLES

#: Versions a history page holds.
PAGE: Final = 20
#: The versions a comparison shows when none are asked for.
DEFAULT_COMPARED: Final = 5
#: A version number as a path or a list gives it: 1 to ``MAX_VERSION``, no leading zero.
VERSION_NUMBER: Final = re.compile(r'[1-9][0-9]{0,5}\Z')
_PAGE_SHAPE: Final = re.compile(r'[A-Za-z0-9_-]{1,400}\Z')
#: What a page's checksum is made for (a change of the page's shape is a new one).
_PAGE_SCHEMA: Final = 'voc-skill-page/1'
#: Where a scorecard's version number comes from. A session names its skill ``<role>@<n>`` with no scope (a shared
#: store version and a shipped one would read the same), and the harness runs only the shipped skills today, so
#: every scorecard number is a shipped skill's. Once the harness reads the store, its labels must carry the scope.
SCORE_SOURCE: Final = 'shipped'
#: A number asked for that no shipped skill of the role ever had (above its shipped version, or a role that ships
#: none): no session ran it, so its card is labelled so, never as shipped.
NOT_SHIPPED: Final = 'not_shipped'


def score_source(role: str, number: int) -> str:
    """Where the card of ``role``'s version ``number`` comes from: a shipped skill's (1 to the shipped version),
    else ``NOT_SHIPPED``."""
    shipped = SKILLS.get(role)
    return SCORE_SOURCE if shipped is not None and number <= shipped.version else NOT_SHIPPED


def check_connection(connection: str) -> str:
    """``''`` (the shared skill) or a stored connection's id shape; 400 otherwise."""
    if connection and not CONNECTION_ID.fullmatch(connection):
        raise SkillError('connection is a connection id (1 to 63 lower-case letters, digits or "-"), or empty for '
                         'the shared skills')
    return connection


def check_role(role: str) -> str:
    if role not in AGENT_ROLES:
        raise SkillError(f'role is one of the agent roles: {", ".join(ENGINEERING_ROLES)}')
    return role


def check_version(version: str) -> int:
    if not VERSION_NUMBER.match(version):
        raise SkillError(f'a version is a whole number from 1 to {MAX_VERSION}')
    return int(version)


def _checksum(connection: str, role: str, before: int) -> str:
    return hashlib.sha256(f'{_PAGE_SCHEMA}#{connection}#{role}#{before}'.encode()).hexdigest()[:16]


def page_token(connection: str, role: str, before: int) -> str:
    """The next page's token: opaque to the caller, readable only for the same scope (``read_page_token``)."""
    text = f'{connection}#{role}#{before}#{_checksum(connection, role, before)}'
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip('=')


def read_page_token(token: str, connection: str, role: str) -> int:
    """The version a page starts below, from a token ``page_token`` made for this scope; 400 for anything else."""
    refused = SkillError('page is not a page of this history: start again from its first page')
    if not _PAGE_SHAPE.match(token):
        raise refused
    try:
        text = base64.b64decode(token + '=' * (-len(token) % 4), altchars=b'-_', validate=True).decode('ascii')
    except (binascii.Error, UnicodeDecodeError):
        raise refused from None
    parts = text.split('#')
    if len(parts) != 4 or parts[:2] != [connection, role] or not VERSION_NUMBER.match(parts[2]):
        raise refused
    before = int(parts[2])
    # (the checksum is unkeyed: it catches a corrupted or hand-edited token only, never a forged one; the scope is
    # re-checked above and the number is only ever formatted into this scope's key, so a forged one reads no more)
    if parts[3] != _checksum(connection, role, before):
        raise refused
    return before


def _rates(before: float | None, after: float | None) -> dict[str, float | None] | None:
    return None if before is None and after is None else {'before': before, 'after': after}


def _measured(recorded: RecordedBenchmark | None) -> dict[str, Any] | None:
    if recorded is None:
        return None
    run = recorded.run
    return {'before': run.before, 'after': run.after, 'passed': run.passed, 'gained': run.gained,
            'failure_case': run.failure_case, 'cases': len(run.cases), 'reasons': list(run.reasons),
            'run_ref': run.run_ref, 'by': recorded.by, 'at': recorded.at}


def _event(event: LogEvent) -> dict[str, str]:
    return {'event': event.event, 'by': event.by, 'at': event.at, 'comment': event.comment}


def line_view(line: VersionLine, events: Sequence[LogEvent]) -> dict[str, Any]:
    """A version as the history answers it."""
    base = line.base
    return {
        'version': line.version, 'status': line.status, 'summary': line.summary,
        'why': {'run_id': line.reason_run, 'failure': line.reason_failure, 'comment': line.reason_comment},
        'proposed_by': line.proposed_by, 'proposed_by_kind': line.proposed_by_kind, 'proposed_at': line.created_at,
        'accepted_by': line.accepted_by, 'accepted_at': line.accepted_at, 'rejected_by': line.rejected_by,
        'rejected_at': line.rejected_at, 'restores': line.restores,
        # (a base is the scope's own version or the shared skill's: never another connection's)
        'base': None if base is None else {'shared': base.connection == SHARED, 'version': base.version},
        'benchmark': {'claimed': _rates(line.claimed.before, line.claimed.after), 'measured': _measured(line.measured)},
        'expected_case': line.expected_case,
        'events': [_event(event) for event in events if event.version == line.version],
    }


def _record_view(found: SkillVersion) -> dict[str, Any]:
    content = found.skill.content
    return {'instructions': content.instructions,
            'examples': [{'situation': example.situation, 'action': example.action} for example in content.examples],
            'tool_policy': list(content.tool_policy), 'model': content.model, 'harness': content.harness}


def event_spans(numbers: Sequence[int]) -> list[tuple[int, int]]:
    """A page's version numbers as ranges of at most ``MAX_PAGE`` numbers each, one events Query a range: a page
    whose versions sit far apart (numbers taken by refused proposals, another page's) is read in a few ranges
    instead of refused, at most one a version, so still bounded by the page."""
    spans: list[tuple[int, int]] = []
    for number in sorted(numbers):
        if spans and number - spans[-1][0] < MAX_PAGE:
            spans[-1] = (spans[-1][0], number)
        else:
            spans.append((number, number))
    return spans


def shipped_versions(role: str) -> list[int]:
    """The role's shipped version and the shipped ones before it, newest first, at most ``DEFAULT_COMPARED``
    (none for a role that ships no skill): one source only, the one the sessions' labels name today."""
    shipped = SKILLS.get(role)
    if shipped is None:
        return []
    return list(range(shipped.version, max(0, shipped.version - DEFAULT_COMPARED), -1))


def template_view(role: str, lines: Sequence[VersionLine]) -> dict[str, Any] | None:
    """The role's bundled template (7.50.00): its version and label, and ``newer`` when the scope has versions and
    none of the page's was seeded from a template this recent ("Template updated": a person adopts it as a proposal,
    which an administrator accepts; never automatic). None for a role with no template."""
    template = bundled().skill(role)
    if template is None:
        return None
    seeded = max((line.template_version for line in lines if line.provenance == 'template'), default=0)
    return {'version': template.version, 'label': template.label, 'newer': bool(lines) and template.version > seeded}


def card_view(number: int, card: VersionCard) -> dict[str, Any]:
    return {'version': number, 'source': score_source(card.role, number), 'label': card.version, 'runs': card.runs,
            'pass_rate': card.pass_rate,
            'tasks_done': card.tasks_done, 'tasks_failed': card.tasks_failed, 'needs_human': card.needs_human,
            'reposts': card.reposts, 'review_rounds': card.review_rounds, 'attempts': card.attempts,
            'cost_usd': float(card.cost_usd), 'seconds': card.seconds, 'more': card.more, 'since': card.since,
            'until': card.until,
            # (7.10.00: what people's reactions on the host say a person had to do, learning/scorecard.py)
            'human_edits': {'runs': card.runs_with_human_edits, 'changes_requested': card.changes_requested,
                            'people_commits_after_merge': card.people_commits_after_merge, 'reverts': card.reverts,
                            'more': card.human_more}}


def check_versions(raw: str | None) -> list[int] | None:
    """``versions=<n,n,…>``: 1 to ``MAX_COMPARED`` version numbers, each once (None: the default)."""
    if raw is None or raw == '':
        return None
    parts = raw.split(',')
    if len(parts) > MAX_COMPARED or len(set(parts)) != len(parts):
        raise SkillError(f'versions names 1 to {MAX_COMPARED} versions, each once, separated by commas')
    return [check_version(part) for part in parts]


@dataclass(frozen=True)
class SkillViews:
    #: A low-level DynamoDB client on ``voc-engineering``.
    client: Any
    table: str

    @property
    def _skills(self) -> SkillStore:
        return SkillStore(self.client, self.table)

    def roles(self, connection: str) -> dict[str, Any]:
        """The scope's roles that have a version, in the catalog's order."""
        scope = check_connection(connection)
        skills = self._skills
        roles: list[dict[str, Any]] = []
        for role in ENGINEERING_ROLES:   # (the catalog's order of work, the coach last)
            head = skills.head(WORKSPACE, scope, role)
            if head is None:
                continue
            newest = skills.lines(WORKSPACE, scope, role, limit=1).lines
            latest = newest[0] if newest else None
            roles.append({'role': role, 'current_version': head.current_version, 'versions': head.versions,
                          'latest': None if latest is None else {
                              'version': latest.version, 'status': latest.status, 'summary': latest.summary,
                              'proposed_at': latest.created_at}})
        return {'connection': scope, 'roles': roles}

    def history(self, connection: str, role: str, token: str) -> dict[str, Any]:
        """A page of the role's history in the scope, newest first, with each version's events."""
        scope, role = check_connection(connection), check_role(role)
        before = read_page_token(token, scope, role) if token else 0
        skills = self._skills
        page = skills.lines(WORKSPACE, scope, role, before=before, limit=PAGE)
        events = [event for low, high in event_spans([line.version for line in page.lines])
                  for event in skills.events(WORKSPACE, scope, role, low, high)]
        head = skills.head(WORKSPACE, scope, role)
        return {'connection': scope, 'role': role, 'current_version': head.current_version if head else 0,
                'versions': [line_view(line, events) for line in page.lines],
                'next_page': None if page.next_before is None else page_token(scope, role, page.next_before),
                'template': template_view(role, page.lines)}

    def version(self, connection: str, role: str, version: str) -> dict[str, Any]:
        """One version: its line, its record and its diff from its base."""
        scope, role, number = check_connection(connection), check_role(role), check_version(version)
        skills = self._skills
        found, line = skills.detail(WORKSPACE, scope, role, number)
        made = found.made_with
        return {'connection': scope, 'role': role, 'version': {
            **line_view(line, skills.events(WORKSPACE, scope, role, number, number)),
            'record': _record_view(found), 'diff': to_json(found.diff),
            'made_with': None if made is None else {'model': made.model, 'prompt': made.prompt}}}

    def scorecards(self, connection: str, role: str, versions: str | None) -> dict[str, Any]:
        """``version_card`` per version of the role, on the connection's own scorecards. Every card's number is
        the shipped skill's (``SCORE_SOURCE``): a session names its version ``<role>@<n>`` without its scope, and
        until the harness reads the skills store every session runs the shipped skill, so a number here is never
        a shared or a connection's store version. By default the shipped version and the shipped ones before it."""
        scope, role = check_connection(connection), check_role(role)
        if not scope:
            raise SkillError("scorecards are a connection's: name the connection whose runs to compare")
        numbers = check_versions(versions) or shipped_versions(role)
        answer: dict[str, Any] = {'connection': scope, 'role': role, 'source': SCORE_SOURCE, 'scope_known': False,
                                  'versions': numbers, 'cards': []}
        if numbers:
            labels = [skill_label(role, number) for number in numbers]
            cards = ScorecardStore(self.client, self.table).compare(WORKSPACE, scope, role, labels)
            answer['cards'] = [card_view(number, card) for number, card in zip(numbers, cards, strict=True)]
        return answer
