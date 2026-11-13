"""Scorecards: how each skill version does, run by run (docs/autonomous-engineering.md, "The learning loop").

One row per skill version per run, written once by the run's retrospective and never updated (D1: there is no
counter to update in place; a version's history is its rows), in the ``voc-engineering`` table::

    WS#<ws>#SCORE#<connection>#<role>#<version> / RUN#<run>   voc-scorecard/1: tasks done, failed and needing a
                                                              person, re-posts, review rounds, attempts, cost,
                                                              session seconds; who wrote it and when (D4)

``<version>`` is the session rows' label (``<role>@<n>``; ``none`` for a role with no skill yet, ``unlabelled`` for a
label off that shape). One connection's rows are its own partition, so its scorecards are read only as the
connection is (the routes, planned, check that access; this store does not). A retried retrospective finds its row
written and leaves it (``written`` False).

``version_card`` aggregates one version's latest runs with ONE bounded Query of its partition (newest run first, at
most ``MAX_RUNS``), never a whole-table read; ``compare`` reads a few versions, one Query each.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.bus.schema import ULID, WS
from engineering.connectors.identity import AGENT_ROLES
from engineering.learning.retrospective import NO_VERSION, OFF_SHAPE_VERSION, VERSION_LABEL, RunRecord, ScoreLine
from engineering.rows import amount_attr, string_attr, text_value
from engineering.workspace.layout import CONNECTION
from shared.aws import is_conditional_check_failure

SCHEMA: Final = 'voc-scorecard/1'
#: A version's runs one card reads, at most (one Query page: each row is well under 1 KB).
MAX_RUNS: Final = 200
DEFAULT_RUNS: Final = 50
#: The versions one comparison reads (one Query each).
MAX_COMPARED: Final = 10
#: Who writes a scorecard row (D4): the run's retrospective, trusted code.
WRITER: Final = 'retrospective'
_COUNTS: Final = ('tasks_done', 'tasks_failed', 'needs_human', 'reposts', 'review_rounds', 'attempts', 'seconds')
_RUN_KEY: Final = re.compile(r'RUN#(?P<run>[0-9A-HJKMNP-TV-Z]{26})\Z')


class ScorecardError(ValueError):
    """A scorecard read or write refused (a key part off its shape, a bound)."""


def _label(version: str) -> str:
    if version in (NO_VERSION, OFF_SHAPE_VERSION) or VERSION_LABEL.fullmatch(version):
        return version
    raise ScorecardError('a version is <role>@<n>, none or unlabelled')


def score_pk(ws: str, connection: str, role: str, version: str) -> str:
    """A version's partition: every run it took part in, one row each."""
    if not WS.fullmatch(ws) or not CONNECTION.fullmatch(connection):
        raise ScorecardError('a scorecard belongs to a workspace and a connection')
    if role not in AGENT_ROLES:
        raise ScorecardError('a scorecard is an agent role\'s')
    return f'WS#{ws}#SCORE#{connection}#{role}#{_label(version)}'


@dataclass(frozen=True)
class VersionCard:
    """One version's latest runs, summed: ``pass_rate`` is tasks done over the tasks it ended (done, failed or
    needing a person), None when it ended none."""

    connection: str
    role: str
    version: str
    runs: int
    tasks_done: int
    tasks_failed: int
    needs_human: int
    reposts: int
    review_rounds: int
    attempts: int
    cost_usd: Decimal
    seconds: int
    #: The newest run read, and whether the bound was reached (older runs may have been left out).
    latest_run: str
    more: bool
    #: The time the runs read span: the oldest one's start, the newest one's end.
    since: str = ''
    until: str = ''
    #: Who wrote the newest row, and when (D4).
    latest_written_by: str = ''
    latest_written_at: str = ''

    @property
    def pass_rate(self) -> float | None:
        ended = self.tasks_done + self.tasks_failed + self.needs_human
        return None if ended == 0 else self.tasks_done / ended


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class ScorecardStore:
    #: A low-level DynamoDB client on ``voc-engineering``.
    client: Any
    table: str
    now: Callable[[], datetime] = _utc_now

    def write(self, run: RunRecord, line: ScoreLine) -> bool:
        """The version's row for the run, created once (``attribute_not_exists``); False when it was written already
        (a retried retrospective), never written over."""
        if not ULID.fullmatch(run.run_id):
            raise ScorecardError('a run id is a ULID')
        item: dict[str, Any] = {
            'pk': {'S': score_pk(run.ws, run.connection, line.role, line.version)}, 'sk': {'S': f'RUN#{run.run_id}'},
            'schema': {'S': SCHEMA}, 'connection': {'S': run.connection}, 'role': {'S': line.role},
            'version': {'S': line.version}, 'run_id': {'S': run.run_id}, 'run_status': {'S': run.status[:40]},
            'run_started_at': {'S': run.started_at[:40]}, 'run_ended_at': {'S': run.ended_at[:40]},
            'cost_usd': {'N': str(line.cost_usd)}, 'written_by': {'S': WRITER},
            'written_at': {'S': self.now().isoformat()},
            **{name: {'N': str(getattr(line, name))} for name in _COUNTS}}
        try:
            self.client.put_item(TableName=self.table, Item=item, ConditionExpression='attribute_not_exists(pk)')
        except ClientError as exc:
            if is_conditional_check_failure(exc):
                return False
            raise
        return True

    def version_card(self, ws: str, connection: str, role: str, version: str, *,
                     runs: int = DEFAULT_RUNS) -> VersionCard:
        """The version's latest ``runs`` runs (1 to ``MAX_RUNS``), summed, from one Query of its partition."""
        if isinstance(runs, bool) or not 0 < runs <= MAX_RUNS:
            raise ScorecardError(f'a card reads 1-{MAX_RUNS} runs')
        answer = self.client.query(
            TableName=self.table, ConsistentRead=True, Limit=runs, ScanIndexForward=False,
            KeyConditionExpression='pk = :pk AND begins_with(sk, :run)',
            ExpressionAttributeValues={':pk': {'S': score_pk(ws, connection, role, version)}, ':run': {'S': 'RUN#'}})
        items = [item for item in answer.get('Items', []) if _RUN_KEY.fullmatch(string_attr(item, 'sk'))]

        def total(name: str) -> int:
            return sum(int(amount_attr(item, name)) for item in items)

        latest = _RUN_KEY.fullmatch(string_attr(items[0], 'sk')) if items else None
        newest, oldest = (items[0], items[-1]) if items else ({}, {})
        return VersionCard(connection=connection, role=role, version=version, runs=len(items),
                           tasks_done=total('tasks_done'), tasks_failed=total('tasks_failed'),
                           needs_human=total('needs_human'), reposts=total('reposts'),
                           review_rounds=total('review_rounds'), attempts=total('attempts'), seconds=total('seconds'),
                           cost_usd=sum((amount_attr(item, 'cost_usd') for item in items), Decimal(0)),
                           latest_run=latest.group('run') if latest else '', more=len(answer.get('Items', [])) == runs,
                           since=text_value(oldest.get('run_started_at')),
                           until=text_value(newest.get('run_ended_at')),
                           latest_written_by=text_value(newest.get('written_by')),
                           latest_written_at=text_value(newest.get('written_at')))

    def compare(self, ws: str, connection: str, role: str, versions: Sequence[str]) -> list[VersionCard]:
        """A few versions of one role side by side, each over its latest ``DEFAULT_RUNS`` runs (at most
        ``MAX_COMPARED`` versions, one Query each)."""
        if not 0 < len(versions) <= MAX_COMPARED or len(set(versions)) != len(versions):
            raise ScorecardError(f'a comparison reads 1-{MAX_COMPARED} versions, each once')
        return [self.version_card(ws, connection, role, version) for version in versions]
