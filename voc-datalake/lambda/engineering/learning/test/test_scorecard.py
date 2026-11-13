"""Scorecards on moto: one create-only row per version per run, and a version's card from one bounded Query."""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from moto import mock_aws

from engineering.board.test.table import TABLE, create_table
from engineering.learning.retrospective import RunRecord, ScoreLine
from engineering.learning.scorecard import MAX_COMPARED, MAX_RUNS, SCHEMA, ScorecardError, ScorecardStore, score_pk
from engineering.learning.test.fixtures import CONN, RUN, WS

AT = datetime(2026, 11, 13, 9, 30, tzinfo=UTC)
LINE = ScoreLine('fixer', 'fixer@1', tasks_done=2, tasks_failed=1, needs_human=1, reposts=1, review_rounds=3,
                 attempts=5, cost_usd=Decimal('1.25'), seconds=300)
#: Fictional run ids, oldest first (a ULID sorts by time).
RUNS = tuple(f'01JD00000000000000000000{n:02d}' for n in range(10, 16))


def run(run_id: str = RUN, connection: str = CONN) -> RunRecord:
    return RunRecord(ws=WS, run_id=run_id, connection=connection, status='done', started_at='2026-11-13T08:00:00Z',
                     ended_at='2026-11-13T09:00:00Z', tasks=(), history={}, agents=())


@dataclass
class Counting:
    """A low-level client that counts its calls by operation."""

    client: Any
    calls: list[str] = field(default_factory=list)

    def __getattr__(self, name: str) -> Any:
        self.calls.append(name)
        return getattr(self.client, name)


@pytest.fixture
def store() -> Iterator[ScorecardStore]:
    with mock_aws():
        yield ScorecardStore(Counting(create_table()), TABLE, now=lambda: AT)


def test_a_versions_row_for_a_run_is_written_once_and_never_over(store: ScorecardStore) -> None:
    first = store.write(run(), LINE)
    again = store.write(run(), ScoreLine('fixer', 'fixer@1', tasks_done=99))
    assert (first, again) == (True, False)
    item = store.client.get_item(TableName=TABLE, Key={'pk': {'S': score_pk(WS, CONN, 'fixer', 'fixer@1')},
                                                       'sk': {'S': f'RUN#{RUN}'}})['Item']
    assert (item['schema']['S'], item['tasks_done']['N'], item['cost_usd']['N']) == (SCHEMA, '2', '1.25')
    assert (item['written_by']['S'], item['written_at']['S']) == ('retrospective', AT.isoformat())
    assert (item['run_status']['S'], item['run_ended_at']['S']) == ('done', '2026-11-13T09:00:00Z')


def test_a_card_sums_a_versions_latest_runs_with_one_query(store: ScorecardStore) -> None:
    for run_id in RUNS:
        store.write(run(run_id), LINE)
    store.write(run(RUNS[0]), ScoreLine('fixer', 'fixer@2', tasks_failed=4))   # another version: its own partition
    store.write(run(RUNS[0], 'conn-other'), LINE)                              # another connection: its own
    store.client.calls.clear()
    card = store.version_card(WS, CONN, 'fixer', 'fixer@1', runs=4)
    assert store.client.calls == ['query']
    assert (card.runs, card.tasks_done, card.tasks_failed, card.needs_human, card.reposts) == (4, 8, 4, 4, 4)
    assert (card.review_rounds, card.attempts, card.seconds, card.cost_usd) == (12, 20, 1200, Decimal('5.00'))
    assert (card.latest_run, card.more) == (RUNS[-1], True)
    assert (card.since, card.until) == ('2026-11-13T08:00:00Z', '2026-11-13T09:00:00Z')
    assert (card.latest_written_by, card.latest_written_at) == ('retrospective', AT.isoformat())
    assert card.pass_rate == pytest.approx(0.5)
    whole = store.version_card(WS, CONN, 'fixer', 'fixer@1')
    assert (whole.runs, whole.more) == (len(RUNS), False)


def test_a_card_of_a_version_with_no_runs(store: ScorecardStore) -> None:
    card = store.version_card(WS, CONN, 'builder', 'none')
    assert (card.runs, card.latest_run, card.pass_rate, card.cost_usd) == (0, '', None, Decimal(0))


def test_compare_reads_one_query_per_version(store: ScorecardStore) -> None:
    store.write(run(), LINE)
    store.write(run(), ScoreLine('fixer', 'fixer@2', tasks_done=1))
    store.client.calls.clear()
    cards = store.compare(WS, CONN, 'fixer', ['fixer@1', 'fixer@2'])
    assert [card.tasks_done for card in cards] == [2, 1]
    assert store.client.calls == ['query', 'query']


@pytest.mark.parametrize('call', [
    lambda s: s.version_card(WS, CONN, 'fixer', 'fixer@1', runs=0),
    lambda s: s.version_card(WS, CONN, 'fixer', 'fixer@1', runs=MAX_RUNS + 1),
    lambda s: s.version_card(WS, CONN, 'fixer', 'fixer@1', runs=True),
    lambda s: s.version_card(WS, CONN, 'fixer', 'Fixer 1'),
    lambda s: s.version_card(WS, CONN, 'janitor', 'none'),
    lambda s: s.version_card(WS, 'conn/other', 'fixer', 'none'),
    lambda s: s.compare(WS, CONN, 'fixer', []),
    lambda s: s.compare(WS, CONN, 'fixer', ['none', 'none']),
    lambda s: s.compare(WS, CONN, 'fixer', [f'fixer@{n}' for n in range(MAX_COMPARED + 1)]),
    lambda s: s.write(run('not-a-run'), LINE),
])
def test_reads_and_writes_off_their_shapes_are_refused(store: ScorecardStore, call: Any) -> None:
    with pytest.raises(ScorecardError):
        call(store)
