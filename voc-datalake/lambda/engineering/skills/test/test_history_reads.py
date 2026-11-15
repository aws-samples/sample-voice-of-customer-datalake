"""The skills store's history reads on moto: a scope's head, its lines newest first, a page's log events."""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import pytest

from engineering.board.test.table import TABLE, engineering_table
from engineering.knowledge.store import Actor
from engineering.skills.model import Reason, SkillError
from engineering.skills.store import MAX_PAGE, SHARED, SkillRef, SkillStore
from engineering.skills.test.fixtures import INSTRUCTIONS, content

WS = 'default'
ADMIN = Actor('admin-sub-1', 'person', admin=True)


@dataclass
class Paging:
    """A low-level client whose first Query answers one item at a time, as DynamoDB does past 1 MB."""

    client: Any
    queries: list[dict[str, Any]] = field(default_factory=list)

    def query(self, **request: Any) -> dict[str, Any]:
        self.queries.append(request)
        return self.client.query(**{**request, 'Limit': 1})

    def __getattr__(self, name: str) -> Any:
        return getattr(self.client, name)


@pytest.fixture
def store() -> Iterator[SkillStore]:
    with engineering_table() as client:
        skills = SkillStore(client, TABLE)
        first = skills.propose_version(WS, SHARED, 'fixer', content(), proposer=ADMIN, base=None,
                                       reason=Reason(comment='The first Fixer skill.'))
        skills.accept_version(WS, SHARED, 'fixer', first.version.version, ADMIN)
        for n in range(2):
            proposed = skills.propose_version(WS, SHARED, 'fixer', content(INSTRUCTIONS + f'\nRule {n}.'),
                                              proposer=ADMIN, base=SkillRef(SHARED, 1),
                                              reason=Reason(comment=f'Rule {n}.'))
            skills.reject_version(WS, SHARED, 'fixer', proposed.version.version, ADMIN, f'Not rule {n}.')
        yield skills


def test_a_scope_with_no_version_has_no_head(store: SkillStore) -> None:
    assert store.head(WS, 'conn-harbor', 'fixer') is None
    head = store.head(WS, SHARED, 'fixer')
    assert head is not None
    assert (head.current_version, head.versions) == (1, 3)


def test_nothing_is_below_the_first_version(store: SkillStore) -> None:
    page = store.lines(WS, SHARED, 'fixer', before=1)
    assert (list(page.lines), page.next_before) == ([], None)


@pytest.mark.parametrize(('before', 'limit'), [(0, 0), (0, MAX_PAGE + 1), (-1, 5), (1_000_000, 5), (0, True)])
def test_a_page_off_its_bounds_is_refused(store: SkillStore, before: int, limit: int) -> None:
    with pytest.raises(SkillError, match='a page holds'):
        store.lines(WS, SHARED, 'fixer', before=before, limit=limit)


@pytest.mark.parametrize(('low', 'high'), [(0, 1), (2, 1), (1, 1_000_000), (1, MAX_PAGE + 1)])
def test_the_events_of_a_range_off_its_bounds_are_refused(store: SkillStore, low: int, high: int) -> None:
    with pytest.raises(SkillError, match='events of'):
        store.events(WS, SHARED, 'fixer', low, high)


@dataclass
class Unfiltered:
    """A table that ignores the FilterExpression and answers every log row, a promoted version's source included."""

    def query(self, **_: Any) -> dict[str, Any]:
        row = {'version': {'N': '2'}, 'by': {'S': 'admin-sub-1'}, 'at': {'S': '2026-11-12T09:30:00+00:00'}}
        return {'Items': [{**row, 'event': {'S': 'accepted'}},
                          {**row, 'event': {'S': 'promoted_from'}, 'source_connection': {'S': 'conn-harbor'}},
                          {**row, 'event': {'S': 'anything-else'}}]}


def test_a_promoted_versions_source_past_the_filter_is_still_never_answered() -> None:
    events = SkillStore(Unfiltered(), TABLE).events(WS, SHARED, 'fixer', 2, 2)
    assert [event.event for event in events] == ['accepted']


def test_a_pages_events_are_followed_past_a_short_answer(store: SkillStore) -> None:
    paging = Paging(store.client)
    events = SkillStore(paging, TABLE).events(WS, SHARED, 'fixer', 1, 3)
    assert [(e.version, e.event, e.comment) for e in events] == [
        (1, 'accepted', ''), (2, 'rejected', 'Not rule 0.'), (3, 'rejected', 'Not rule 1.')]
    # (one row a page, each next page asked from where the last one stopped, until DynamoDB has no more)
    assert [len(paging.queries), 'ExclusiveStartKey' in paging.queries[1]] == [4, True]
