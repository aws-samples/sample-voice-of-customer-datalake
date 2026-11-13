"""Versioned skills on moto: proposals, an administrator's acceptance, scopes and their fallback, rollbacks."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from engineering.board.test.table import TABLE, engineering_table
from engineering.bus.schema import TYPES, parse
from engineering.knowledge.store import Actor
from engineering.skills import store as skills_store
from engineering.skills.model import (
    MAX_BENCHMARK_BYTES,
    Benchmark,
    BenchmarkRun,
    Example,
    Reason,
    SkillContent,
    SkillError,
)
from engineering.skills.store import (
    ACCEPTED,
    MAX_ITEM_BYTES,
    PROPOSED,
    REJECTED,
    SHARED,
    RecordedBenchmark,
    SkillConflict,
    SkillForbidden,
    SkillNotFound,
    SkillRef,
    SkillStore,
    SkillVersion,
    item_bytes,
)
from engineering.skills.test.fixtures import HAIKU, RUN, TOOLS, content, stricter

WS = 'default'
CONN, OTHER = 'conn-harbor', 'conn-lantern'
AT = datetime(2026, 11, 12, 9, 30, tzinfo=UTC)
COACH, MEMBER = Actor('coach-0', 'agent', connection=CONN), Actor('member-sub-2', 'person')
ADMIN = Actor('admin-sub-1', 'person', admin=True)
WHY = Reason(comment='The first Fixer skill.')
NO_GO = Reason(RUN, 'no_go', 'The gate caught an untested change.')
CASES = ('slug-cut-bug', 'duration-hours-feature', 'pagination-review', 'monorepo-units-bug')
GAINED = BenchmarkRun(before=0.75, after=1.0, cases=CASES, passed=True, failure_case='slug-cut-bug', reasons=(
    'no regression: the 3 case(s) that passed in the baseline pass in the candidate',
    "slug-cut-bug, the failure's case, gained: it failed in the baseline and passes in the candidate"))
REGRESSED = replace(GAINED, after=0.75, passed=False, reasons=(
    'pagination-review regressed: it passed in the baseline and fails in the candidate',))
UNNAMED = replace(GAINED, failure_case='')


@pytest.fixture
def store() -> Iterator[SkillStore]:
    with engineering_table() as client:
        yield SkillStore(client, TABLE, now=lambda: AT)


def shared_v1(store: SkillStore) -> SkillVersion:
    """The shared Fixer skill's first version, accepted."""
    proposed = store.propose_version(WS, SHARED, 'fixer', content(), proposer=ADMIN, reason=WHY, base=None)
    return store.accept_version(WS, SHARED, 'fixer', proposed.version.version, ADMIN).version


def measured(store: SkillStore, connection: str, version: int, run: BenchmarkRun = GAINED) -> SkillVersion:
    """``run`` recorded on the version by an administrator (a passing gate with a gain unless given)."""
    return store.record_benchmark(WS, connection, 'fixer', version, run, ADMIN)


def current_number(store: SkillStore, connection: str = SHARED) -> int:
    found = store.current(WS, connection, 'fixer')
    assert found is not None
    return found.version


def history(store: SkillStore, connection: str) -> list[SkillVersion]:
    page = store.versions(WS, connection, 'fixer', limit=100)
    assert page.next_after is None
    return list(page.versions)


def _get(store: SkillStore, connection: str, sk: str) -> dict[str, Any]:
    return store.client.get_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WS}#SKILL#{connection}#fixer'},
                                                       'sk': {'S': sk}})


def row(store: SkillStore, connection: str, sk: str) -> dict[str, Any]:
    return _get(store, connection, sk)['Item']


def absent(store: SkillStore, connection: str, sk: str) -> bool:
    return 'Item' not in _get(store, connection, sk)


def test_a_proposal_is_a_new_version_and_is_not_used_until_accepted(store: SkillStore) -> None:
    proposed = store.propose_version(WS, SHARED, 'fixer', content(), proposer=MEMBER, reason=WHY, base=None,
                             benchmark=Benchmark(after=0.75)).version
    assert (proposed.version, proposed.status, proposed.proposed_by, proposed.proposed_by_kind) == (
        1, PROPOSED, 'member-sub-2', 'person')
    assert (proposed.reason, proposed.benchmark, proposed.created_at) == (WHY, Benchmark(None, 0.75), AT.isoformat())
    assert proposed.diff.first
    assert proposed.skill.content == content()
    assert store.current(WS, SHARED, 'fixer') is None
    stored = row(store, '', 'VER#000001')
    assert (stored['status']['S'], stored['benchmark_after']['N']) == (PROPOSED, '0.75')
    assert 'benchmark_before' not in stored
    assert history(store, SHARED) == [proposed]
    assert store.versions(WS, SHARED, 'hunter').versions == []   # another role's partition


def test_acceptance_records_who_and_when_moves_current_and_is_announced(store: SkillStore) -> None:
    v1 = shared_v1(store)
    assert (v1.status, v1.accepted_by, v1.accepted_at) == (ACCEPTED, 'admin-sub-1', AT.isoformat())
    assert store.current(WS, SHARED, 'fixer') == v1
    log = row(store, '', 'LOG#000001#accepted')
    assert (log['by']['S'], log['at']['S']) == ('admin-sub-1', AT.isoformat())
    proposed = store.propose_version(WS, SHARED, 'fixer', stricter(), proposer=MEMBER, reason=WHY, base=v1.ref)
    assert proposed.announcement is not None
    assert proposed.announcement.type == 'skill.proposed'
    assert proposed.announcement.summary == ('Fixer skill proposed: v1 → v2, one more example, '
                                             'one more instruction line')
    accepted = store.accept_version(WS, SHARED, 'fixer', 2, ADMIN)
    announced = accepted.announcement
    assert announced is not None
    assert (announced.type, announced.from_version, announced.to_version) == ('skill.accepted', v1.ref,
                                                                              SkillRef(SHARED, 2))
    assert announced.summary == 'Fixer rewrote its skill: v1 → v2, one more example, one more instruction line'
    assert announced.type in TYPES
    assert store.current(WS, SHARED, 'fixer') == accepted.version
    # Accepting the accepted version again answers it as it is, with nothing to announce.
    again = store.accept_version(WS, SHARED, 'fixer', 2, ADMIN)
    assert (again.version, again.announcement) == (accepted.version, None)


def test_an_announcement_is_publishable_on_the_bus_and_its_id_is_stable(store: SkillStore) -> None:
    v1 = shared_v1(store)
    first = store.propose_version(WS, SHARED, 'fixer', stricter(), proposer=MEMBER, reason=WHY, base=v1.ref).announcement
    assert first is not None
    message = parse({'schema': 'voc-msg/1', 'event_id': '01JD0000000000000000000001', 'ws': WS,
                     'run_id': 'skills', 'thread_id': first.id, 'attempt': 0,
                     'from': {'kind': 'human', 'id': 'admin-sub-1'}, 'to': {'kind': 'run', 'id': 'skills'},
                     'type': first.type, 'summary': first.summary, 'refs': {'s3': []},
                     'at': '2026-11-12T09:30:00Z'})
    assert message.summary == first.summary
    assert first.id == 'skill-proposed-02b756ae61c413d1a0de27c7'   # the same change, the same id: published once


@pytest.mark.parametrize('actor', [COACH, MEMBER])
def test_only_an_administrator_accepts_rejects_rolls_back_and_promotes(store: SkillStore, actor: Actor) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, SHARED, 'fixer', stricter(), proposer=MEMBER, reason=WHY, base=v1.ref)
    for attempt, what in ((lambda: store.accept_version(WS, SHARED, 'fixer', 2, actor), 'accepts'),
                          (lambda: store.reject_version(WS, SHARED, 'fixer', 2, actor), 'rejects'),
                          (lambda: store.roll_back_to(WS, SHARED, 'fixer', 1, actor), 'rolls back'),
                          (lambda: store.promote_version(WS, 'fixer', SkillRef(CONN, 1), content(), by=actor, reason=WHY,
                                                 base=v1.ref), 'promotes')):
        with pytest.raises(SkillForbidden, match=f'only an administrator {what}') as refused:
            attempt()
        assert refused.value.kind == 'forbidden'
    assert store.version(WS, SHARED, 'fixer', 2).status == PROPOSED
    assert store.current(WS, SHARED, 'fixer') == v1


@pytest.mark.parametrize('change', [{'tool_policy': (*TOOLS, 'install_dependencies')}, {'model': HAIKU},
                                    {'harness': 'cli'}, {'tool_policy': TOOLS[::-1]}])
def test_the_coach_cannot_change_a_person_only_field(store: SkillStore, change: dict[str, Any]) -> None:
    v1 = shared_v1(store)
    with pytest.raises(SkillForbidden, match='only a person changes') as refused:
        store.propose_version(WS, CONN, 'fixer', replace(stricter(), **change), proposer=COACH, reason=NO_GO, base=v1.ref)
    assert refused.value.kind == 'forbidden'
    assert history(store, CONN) == []
    # A person may change it.
    by_person = store.propose_version(WS, CONN, 'fixer', replace(stricter(), **change), proposer=MEMBER, reason=NO_GO,
                              base=v1.ref).version
    assert by_person.status == PROPOSED
    assert by_person.proposed_by_kind == 'person'


def test_the_coach_proposes_instructions_and_examples_for_a_connection_from_a_run(store: SkillStore) -> None:
    v1 = shared_v1(store)
    proposed = store.propose_version(WS, CONN, 'fixer', stricter(), proposer=COACH, reason=NO_GO, base=v1.ref).version
    assert (proposed.connection, proposed.base, proposed.proposed_by_kind) == (CONN, v1.ref, 'agent')
    assert proposed.summary == ('Fixer skill for conn-harbor proposed: shared v1 → v1, one more example, '
                                'one more instruction line')
    with pytest.raises(SkillForbidden, match="the coach writes a connection's version only"):
        store.propose_version(WS, SHARED, 'fixer', stricter(), proposer=COACH, reason=NO_GO, base=v1.ref)
    with pytest.raises(SkillError, match='names the run and the failure'):
        store.propose_version(WS, CONN, 'fixer', stricter(), proposer=COACH, reason=Reason(comment='Better.'), base=v1.ref)
    with pytest.raises(SkillForbidden, match='only a person changes tool_policy, model, harness'):
        store.propose_version(WS, OTHER, 'fixer', stricter(), proposer=Actor('coach-1', 'agent', connection=OTHER),
                              reason=NO_GO, base=None)


def test_the_shared_skill_is_never_written_from_a_run(store: SkillStore) -> None:
    with pytest.raises(SkillError, match="belong to a connection's version"):
        store.propose_version(WS, SHARED, 'fixer', content(), proposer=ADMIN, reason=NO_GO, base=None)
    assert history(store, SHARED) == []


def test_a_stale_base_is_refused_at_acceptance(store: SkillStore) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, SHARED, 'fixer', stricter(), proposer=MEMBER, reason=WHY, base=v1.ref)
    other = replace(content(), examples=(Example('A test needs a clock.', 'Inject one.'),))
    store.propose_version(WS, SHARED, 'fixer', other, proposer=MEMBER, reason=WHY, base=v1.ref)
    store.accept_version(WS, SHARED, 'fixer', 2, ADMIN)
    with pytest.raises(SkillConflict, match='was written on v1, and v2 is current now') as refused:
        store.accept_version(WS, SHARED, 'fixer', 3, ADMIN)
    assert refused.value.kind == 'conflict'
    assert store.version(WS, SHARED, 'fixer', 3).status == PROPOSED
    assert current_number(store) == 2


def test_a_stale_base_is_refused_inside_the_transaction_too(store: SkillStore,
                                                            monkeypatch: pytest.MonkeyPatch) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, SHARED, 'fixer', stricter(), proposer=MEMBER, reason=WHY, base=v1.ref)
    store.propose_version(WS, SHARED, 'fixer', content(instructions='Fix it.'), proposer=MEMBER, reason=WHY, base=v1.ref)
    store.accept_version(WS, SHARED, 'fixer', 2, ADMIN)
    # The pre-check read before version 2 was accepted (a race): the transaction's condition still refuses.
    monkeypatch.setattr(SkillStore, 'resolved', lambda *_: v1.ref)
    with pytest.raises(SkillConflict, match='changed meanwhile'):
        store.accept_version(WS, SHARED, 'fixer', 3, ADMIN)
    monkeypatch.undo()
    assert store.version(WS, SHARED, 'fixer', 3).status == PROPOSED
    assert current_number(store) == 2


def test_a_connection_falls_back_to_the_shared_skill_until_it_has_its_own(store: SkillStore) -> None:
    assert store.current(WS, CONN, 'fixer') is None
    v1 = shared_v1(store)
    assert store.current(WS, CONN, 'fixer') == v1
    store.propose_version(WS, CONN, 'fixer', stricter(), proposer=COACH, reason=NO_GO, base=v1.ref)
    assert store.current(WS, CONN, 'fixer') == v1   # proposed only
    measured(store, CONN, 1)
    own = store.accept_version(WS, CONN, 'fixer', 1, ADMIN)
    assert own.announcement is not None
    assert own.announcement.summary.startswith('Fixer rewrote its skill for conn-harbor: shared v1 → v1')
    assert store.current(WS, CONN, 'fixer') == own.version
    assert own.version.label == 'fixer@conn-harbor/1'
    assert v1.label == 'fixer@1'
    # The version stays in its connection: the shared skill and another connection still read the shared one.
    assert store.current(WS, SHARED, 'fixer') == v1
    assert store.current(WS, OTHER, 'fixer') == v1
    assert store.resolved(WS, OTHER, 'fixer') == v1.ref


def test_a_connection_version_written_on_the_shared_skill_is_stale_when_either_moved(
        store: SkillStore, monkeypatch: pytest.MonkeyPatch) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, CONN, 'fixer', stricter(), proposer=COACH, reason=NO_GO, base=v1.ref)
    store.propose_version(WS, CONN, 'fixer', content(instructions='Fix it.'), proposer=MEMBER, reason=NO_GO, base=v1.ref)
    store.propose_version(WS, SHARED, 'fixer', content(instructions='Fix it well.'), proposer=MEMBER, reason=WHY,
                  base=v1.ref)
    store.accept_version(WS, SHARED, 'fixer', 2, ADMIN)   # the shared skill moved
    measured(store, CONN, 1)
    with pytest.raises(SkillConflict, match='was written on shared v1, and shared v2 is current now'):
        store.accept_version(WS, CONN, 'fixer', 1, ADMIN)
    monkeypatch.setattr(SkillStore, 'resolved', lambda *_: v1.ref)   # a pre-check that read before it moved
    with pytest.raises(SkillConflict, match='changed meanwhile'):
        store.accept_version(WS, CONN, 'fixer', 1, ADMIN)
    monkeypatch.undo()
    assert store.current(WS, CONN, 'fixer') == store.version(WS, SHARED, 'fixer', 2)


def test_a_first_connection_version_is_stale_once_the_shared_skill_exists(
        store: SkillStore, monkeypatch: pytest.MonkeyPatch) -> None:
    store.propose_version(WS, CONN, 'fixer', content(), proposer=MEMBER, reason=NO_GO, base=None)
    v1 = shared_v1(store)
    with pytest.raises(SkillConflict, match='was written on no version, and shared v1 is current now'):
        store.accept_version(WS, CONN, 'fixer', 1, ADMIN)
    monkeypatch.setattr(SkillStore, 'resolved', lambda *_: None)
    with pytest.raises(SkillConflict, match='changed meanwhile'):
        store.accept_version(WS, CONN, 'fixer', 1, ADMIN)
    monkeypatch.undo()
    assert store.current(WS, CONN, 'fixer') == v1


def test_a_connection_with_its_own_version_no_longer_takes_one_written_on_the_shared_skill(
        store: SkillStore) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, CONN, 'fixer', stricter(), proposer=COACH, reason=NO_GO, base=v1.ref)
    store.propose_version(WS, CONN, 'fixer', content(instructions='Fix it.'), proposer=MEMBER, reason=NO_GO, base=v1.ref)
    measured(store, CONN, 1)
    store.accept_version(WS, CONN, 'fixer', 1, ADMIN)
    with pytest.raises(SkillConflict, match='was written on shared v1, and v1 is current now'):
        store.accept_version(WS, CONN, 'fixer', 2, ADMIN)


def test_a_base_is_an_accepted_version_of_the_scope_or_the_shared_skill(store: SkillStore) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, OTHER, 'fixer', stricter(), proposer=MEMBER, reason=NO_GO, base=v1.ref)
    with pytest.raises(SkillError, match="own scope's version, or the shared skill's"):
        store.propose_version(WS, CONN, 'fixer', content(), proposer=MEMBER, reason=NO_GO, base=SkillRef(OTHER, 1))
    with pytest.raises(SkillConflict, match='written on an accepted version'):
        store.propose_version(WS, OTHER, 'fixer', content(), proposer=MEMBER, reason=NO_GO, base=SkillRef(OTHER, 1))
    with pytest.raises(SkillNotFound, match='no such skill version') as missing:
        store.propose_version(WS, CONN, 'fixer', content(), proposer=MEMBER, reason=NO_GO, base=SkillRef(SHARED, 9))
    assert missing.value.kind == 'not_found'


def test_a_rejected_version_stays_and_is_never_accepted(store: SkillStore) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, SHARED, 'fixer', stricter(), proposer=MEMBER, reason=WHY, base=v1.ref)
    rejected = store.reject_version(WS, SHARED, 'fixer', 2, ADMIN, 'Too broad.')
    assert (rejected.status, rejected.rejected_by, rejected.rejected_at) == (REJECTED, 'admin-sub-1', AT.isoformat())
    assert row(store, '', 'LOG#000002#rejected')['comment']['S'] == 'Too broad.'
    assert store.reject_version(WS, SHARED, 'fixer', 2, ADMIN) == rejected
    with pytest.raises(SkillConflict, match='version 2 is rejected'):
        store.accept_version(WS, SHARED, 'fixer', 2, ADMIN)
    with pytest.raises(SkillConflict, match='version 1 is accepted'):
        store.reject_version(WS, SHARED, 'fixer', 1, ADMIN)
    with pytest.raises(SkillError, match='a comment'):
        store.reject_version(WS, SHARED, 'fixer', 2, ADMIN, 'c' * 2001)
    assert [v.status for v in history(store, SHARED)] == [ACCEPTED, REJECTED]
    assert store.current(WS, SHARED, 'fixer') == v1


def test_a_rollback_is_a_new_version_and_the_history_stays_whole(store: SkillStore) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, SHARED, 'fixer', stricter(), proposer=MEMBER, reason=WHY, base=v1.ref)
    v2 = store.accept_version(WS, SHARED, 'fixer', 2, ADMIN).version
    rolled = store.roll_back_to(WS, SHARED, 'fixer', 1, ADMIN, 'The stricter rule doubled the run time.')
    v3 = rolled.version
    assert (v3.version, v3.status, v3.restores, v3.base) == (3, ACCEPTED, 1, v2.ref)
    assert (v3.proposed_by, v3.accepted_by, v3.accepted_at) == ('admin-sub-1', 'admin-sub-1', AT.isoformat())
    assert v3.skill.content == v1.skill.content
    assert v3.skill.version == 3
    assert v3.reason.comment == 'The stricter rule doubled the run time.'
    assert store.current(WS, SHARED, 'fixer') == v3
    assert rolled.announcement is not None
    assert (rolled.announcement.type, rolled.announcement.from_version) == ('skill.rolled_back', v2.ref)
    assert rolled.announcement.summary == ('Fixer rolled its skill back to v1: v2 → v3, one example fewer, '
                                           'one instruction line fewer')
    # D1: every version is still there as it was.
    assert history(store, SHARED) == [v1, v2, v3]
    assert row(store, '', 'LOG#000003#rolled_back')['by']['S'] == 'admin-sub-1'
    assert absent(store, '', 'LOG#000003#accepted')
    assert store.roll_back_to(WS, SHARED, 'fixer', 2, ADMIN).version.reason.comment == 'rolled back to v2'


def test_a_rollback_stays_in_its_scope_and_restores_only_an_accepted_version(store: SkillStore) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, CONN, 'fixer', stricter(), proposer=COACH, reason=NO_GO, base=v1.ref)
    with pytest.raises(SkillConflict, match='never accepted'):
        store.roll_back_to(WS, CONN, 'fixer', 1, ADMIN)
    measured(store, CONN, 1)
    store.accept_version(WS, CONN, 'fixer', 1, ADMIN)
    with pytest.raises(SkillConflict, match='current already'):
        store.roll_back_to(WS, CONN, 'fixer', 1, ADMIN)
    store.propose_version(WS, CONN, 'fixer', content(instructions='Fix it.'), proposer=MEMBER, reason=NO_GO,
                  base=SkillRef(CONN, 1))
    store.accept_version(WS, CONN, 'fixer', 2, ADMIN)
    rolled = store.roll_back_to(WS, CONN, 'fixer', 1, ADMIN).version
    assert (rolled.connection, rolled.version, rolled.restores) == (CONN, 3, 1)
    assert store.current(WS, SHARED, 'fixer') == v1   # the shared skill is untouched
    assert len(history(store, SHARED)) == 1
    with pytest.raises(SkillNotFound):
        store.roll_back_to(WS, OTHER, 'fixer', 1, ADMIN)


def test_a_rollback_needs_a_current_version_of_its_own_scope(store: SkillStore) -> None:
    v1 = shared_v1(store)
    store.client.update_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WS}#SKILL##fixer'}, 'sk': {'S': 'HEAD'}},
                             UpdateExpression='REMOVE current_version')
    with pytest.raises(SkillConflict, match='no current version of its own'):
        store.roll_back_to(WS, SHARED, 'fixer', v1.version, ADMIN)


def test_a_rollback_that_lost_a_race_is_refused(store: SkillStore, monkeypatch: pytest.MonkeyPatch) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, SHARED, 'fixer', stricter(), proposer=MEMBER, reason=WHY, base=v1.ref)
    store.accept_version(WS, SHARED, 'fixer', 2, ADMIN)
    monkeypatch.setattr(SkillStore, '_current', lambda *_: 1)   # read before version 2 became current
    with pytest.raises(SkillConflict, match='current version changed meanwhile'):
        store.roll_back_to(WS, SHARED, 'fixer', 2, ADMIN)
    monkeypatch.undo()
    assert current_number(store) == 2


def test_promotion_writes_the_shared_skill_without_the_connection_text(store: SkillStore) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, CONN, 'fixer', stricter(), proposer=COACH, reason=NO_GO, base=v1.ref)
    measured(store, CONN, 1)
    source = store.accept_version(WS, CONN, 'fixer', 1, ADMIN).version
    copied = replace(stricter(), examples=content().examples)   # the connection's instruction line, word for word
    with pytest.raises(SkillError, match="written without conn-harbor's text: 1 line"):
        store.promote_version(WS, 'fixer', source.ref, copied, by=ADMIN, reason=Reason(comment='Promote.'), base=v1.ref)
    reworded = replace(content(), instructions=content().instructions + '\nRun every test the change can reach.')
    promoted = store.promote_version(WS, 'fixer', source.ref, reworded, by=ADMIN, reason=Reason(comment='Promote.'),
                             base=v1.ref).version
    assert (promoted.connection, promoted.status, promoted.base) == (SHARED, PROPOSED, v1.ref)
    accepted = store.accept_version(WS, SHARED, 'fixer', 2, ADMIN).version
    # The source is the administrators' to read: the shared version every connection reads names no connection.
    assert store.promotion_source(WS, 'fixer', 2, ADMIN) == source.ref
    assert store.promotion_source(WS, 'fixer', 1, ADMIN) is None
    with pytest.raises(SkillForbidden, match='only an administrator reads the source of'):
        store.promotion_source(WS, 'fixer', 2, MEMBER)
    shared_row = row(store, '', 'VER#000002')
    assert CONN not in str(shared_row)
    assert store.current(WS, OTHER, 'fixer') == accepted
    assert CONN not in repr(accepted)
    with pytest.raises(SkillError, match="from a connection's version"):
        store.promote_version(WS, 'fixer', v1.ref, reworded, by=ADMIN, reason=WHY, base=v1.ref)
    with pytest.raises(SkillError, match="on the shared skill's version"):
        store.promote_version(WS, 'fixer', source.ref, reworded, by=ADMIN, reason=WHY, base=source.ref)
    with pytest.raises(SkillError, match="belong to a connection's version"):
        store.promote_version(WS, 'fixer', source.ref, reworded, by=ADMIN, reason=NO_GO, base=SkillRef(SHARED, 2))


def test_only_an_accepted_version_is_promoted(store: SkillStore) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, CONN, 'fixer', stricter(), proposer=COACH, reason=NO_GO, base=v1.ref)
    with pytest.raises(SkillConflict, match='only an accepted version is promoted'):
        store.promote_version(WS, 'fixer', SkillRef(CONN, 1), content(), by=ADMIN, reason=WHY, base=v1.ref)


@pytest.mark.parametrize(('ws', 'connection', 'role', 'message'), [
    ('Not A Workspace', CONN, 'fixer', 'workspace'), (WS, 'conn#1', 'fixer', 'connection'),
    (WS, CONN, 'janitor', 'agent role')])
def test_scopes_are_checked(store: SkillStore, ws: str, connection: str, role: str, message: str) -> None:
    with pytest.raises(SkillError, match=message):
        store.propose_version(ws, connection, role, content(), proposer=MEMBER, reason=NO_GO, base=None)
    with pytest.raises(SkillError, match=message):
        store.current(ws, connection, role)


def test_a_counter_behind_its_rows_stops_the_proposal(store: SkillStore) -> None:
    shared_v1(store)
    store.client.update_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WS}#SKILL##fixer'}, 'sk': {'S': 'HEAD'}},
                             UpdateExpression='SET versions = :zero', ExpressionAttributeValues={':zero': {'N': '0'}})
    with pytest.raises(SkillConflict, match='already has a row'):
        store.propose_version(WS, SHARED, 'fixer', stricter(), proposer=MEMBER, reason=WHY, base=SkillRef(SHARED, 1))
    assert store.version(WS, SHARED, 'fixer', 1).skill.content == content()


def test_a_content_too_large_spends_no_version_number(store: SkillStore) -> None:
    big = Example('s' * 2000, 'é' * 2000)
    with pytest.raises(SkillError, match='bytes'):
        store.propose_version(WS, SHARED, 'fixer', content(instructions='é' * 20_000, examples=(big,) * 20),
                      proposer=MEMBER, reason=WHY, base=None)
    assert absent(store, '', 'HEAD')   # no version number spent


def test_a_current_version_not_marked_accepted_and_an_unreadable_row_are_refused(store: SkillStore) -> None:
    store.propose_version(WS, SHARED, 'fixer', content(), proposer=MEMBER, reason=WHY, base=None)
    store.client.update_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WS}#SKILL##fixer'}, 'sk': {'S': 'HEAD'}},
                             UpdateExpression='SET current_version = :one', ExpressionAttributeValues={
                                 ':one': {'N': '1'}})
    with pytest.raises(SkillConflict, match='not marked accepted'):
        store.current(WS, SHARED, 'fixer')
    store.client.update_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WS}#SKILL##fixer'}, 'sk': {'S': 'VER#000001'}},
                             UpdateExpression='SET #r = :bad', ExpressionAttributeNames={'#r': 'record'},
                             ExpressionAttributeValues={':bad': {'S': '{"schema": "voc-skill/1", "budget": 5}'}})
    with pytest.raises(SkillError, match='not a readable skill: budget is never in a skill'):
        store.version(WS, SHARED, 'fixer', 1)


def test_other_write_errors_are_raised_as_they_are(store: SkillStore, monkeypatch: pytest.MonkeyPatch) -> None:
    store.propose_version(WS, SHARED, 'fixer', content(), proposer=MEMBER, reason=WHY, base=None)

    def unavailable(**_: object) -> None:
        raise ClientError({'Error': {'Code': 'InternalServerError'}}, 'TransactWriteItems')

    monkeypatch.setattr(store.client, 'transact_write_items', unavailable)
    with pytest.raises(ClientError, match='InternalServerError'):
        store.accept_version(WS, SHARED, 'fixer', 1, ADMIN)
    client = MagicMock()
    client.update_item.return_value = {'Attributes': {'versions': {'N': '1'}}}
    client.transact_write_items.side_effect = ClientError(
        {'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'TransactWriteItems')
    with pytest.raises(ClientError, match='ProvisionedThroughput'):
        SkillStore(client, TABLE, now=lambda: AT).propose_version(WS, SHARED, 'fixer', content(), proposer=MEMBER,
                                                                  reason=WHY, base=None)


def test_the_coach_writes_only_the_skill_of_its_runs_connection(store: SkillStore) -> None:
    v1 = shared_v1(store)
    with pytest.raises(SkillForbidden, match='the connection its run is for') as refused:
        store.propose_version(WS, OTHER, 'fixer', stricter(), proposer=COACH, reason=NO_GO, base=v1.ref)
    assert refused.value.kind == 'forbidden'
    with pytest.raises(SkillForbidden, match='the connection its run is for'):
        store.propose_version(WS, CONN, 'fixer', stricter(), proposer=Actor('coach-2', 'agent'), reason=NO_GO,
                              base=v1.ref)
    assert history(store, OTHER) == []
    assert history(store, CONN) == []
    with pytest.raises(ValueError, match="only an agent acts for its run's connection"):
        Actor('member-sub-2', 'person', connection=CONN)


def test_the_coach_proposes_once_per_run_and_failure_kind(store: SkillStore,
                                                          monkeypatch: pytest.MonkeyPatch) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, CONN, 'fixer', stricter(), proposer=COACH, reason=NO_GO, base=v1.ref)
    assert row(store, CONN, f'RUN#{RUN}#no_go')['version']['N'] == '1'
    again = content(instructions='Fix it, then run the whole suite.')
    with pytest.raises(SkillConflict, match="for this run's no_go already") as refused:
        store.propose_version(WS, CONN, 'fixer', again, proposer=COACH, reason=NO_GO, base=v1.ref)
    assert refused.value.kind == 'conflict'
    # Inside the transaction too: a pre-check that missed the run's row (a race) still writes nothing.
    real = skills_store.get_row

    def missing_run_rows(client: Any, table: str, key: dict[str, Any]) -> dict[str, Any] | None:
        return None if key['sk']['S'].startswith('RUN#') else real(client, table, key)

    monkeypatch.setattr(skills_store, 'get_row', missing_run_rows)
    with pytest.raises(SkillConflict, match="for this run's no_go already"):
        store.propose_version(WS, CONN, 'fixer', again, proposer=COACH, reason=NO_GO, base=v1.ref)
    monkeypatch.undo()
    assert [v.version for v in history(store, CONN)] == [1]
    # Another failure kind of the same run, and a person, are not held by it.
    timeout = Reason(RUN, 'timeout', 'The run timed out.')
    assert store.propose_version(WS, CONN, 'fixer', again, proposer=COACH, reason=timeout,
                                 base=v1.ref).version.version == 3
    assert store.propose_version(WS, CONN, 'fixer', again, proposer=MEMBER, reason=NO_GO,
                                 base=v1.ref).version.version == 4


def test_versions_are_read_a_page_at_a_time(store: SkillStore) -> None:
    v1 = shared_v1(store)
    for n in range(4):
        store.propose_version(WS, SHARED, 'fixer', content(instructions=f'Fix it, way {n}.'), proposer=MEMBER,
                              reason=WHY, base=v1.ref)
    first = store.versions(WS, SHARED, 'fixer', limit=2)
    assert ([v.version for v in first.versions], first.next_after) == ([1, 2], 2)
    second = store.versions(WS, SHARED, 'fixer', after=2, limit=2)
    assert ([v.version for v in second.versions], second.next_after) == ([3, 4], 4)
    last = store.versions(WS, SHARED, 'fixer', after=4, limit=2)
    assert ([v.version for v in last.versions], last.next_after) == ([5], None)
    assert store.versions(WS, SHARED, 'fixer', after=5).versions == []


@pytest.mark.parametrize(('after', 'limit'), [(0, 0), (0, 101), (-1, 10)])
def test_a_page_is_bounded(store: SkillStore, after: int, limit: int) -> None:
    with pytest.raises(SkillError, match='a page holds 1-100 versions'):
        store.versions(WS, SHARED, 'fixer', after=after, limit=limit)


def largest(letter: str, word: str) -> SkillContent:
    """A skill as large as a record may be: 500 instruction lines and 20 full examples."""
    return content(instructions='\n'.join([letter * 13] * 500), examples=(Example(word * 600, word * 600),) * 20)


def worst_version(store: SkillStore) -> SkillVersion:
    """The largest row a version can need: everything removed and everything added, with the longest comment."""
    proposed = store.propose_version(WS, SHARED, 'fixer', largest('é', 'x'), proposer=MEMBER, reason=WHY, base=None)
    v1 = store.accept_version(WS, SHARED, 'fixer', proposed.version.version, ADMIN).version
    return store.propose_version(WS, SHARED, 'fixer', largest('è', 'y'), proposer=MEMBER,
                                 reason=Reason(comment='ü' * 2000), base=v1.ref).version


def test_the_worst_case_version_row_stays_under_its_cap(store: SkillStore) -> None:
    worst = worst_version(store)
    stored = row(store, '', f'VER#{worst.version:06d}')
    assert len(stored['record']['S'].encode()) > 60_000
    assert worst.diff.count('instructions', '-') == 500
    assert worst.diff.count('instructions', '+') == 500
    assert 180_000 < item_bytes(stored) <= MAX_ITEM_BYTES < 400 * 1024


def test_a_version_row_over_its_cap_is_refused_before_a_number_is_spent(
        store: SkillStore, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(skills_store, 'MAX_ITEM_BYTES', 500)
    with pytest.raises(SkillError, match='over its 500-byte cap'):
        store.propose_version(WS, SHARED, 'fixer', content(), proposer=MEMBER, reason=WHY, base=None)
    assert absent(store, '', 'HEAD')   # no version number spent


def coach_version(store: SkillStore) -> SkillVersion:
    """The coach's version 1 of conn-harbor, written on the shared v1 after a NO-GO."""
    v1 = shared_v1(store)
    return store.propose_version(WS, CONN, 'fixer', stricter(), proposer=COACH, reason=NO_GO, base=v1.ref).version


def test_a_benchmark_is_recorded_once_on_its_version_with_who_and_when(store: SkillStore) -> None:
    v1 = shared_v1(store)
    claimed = store.propose_version(WS, CONN, 'fixer', stricter(), proposer=COACH, reason=NO_GO, base=v1.ref,
                                    benchmark=Benchmark(0.5, 0.99)).version
    assert claimed.trusted_rates == Benchmark(0.5, 0.99)   # the proposer's claim, until a benchmark is recorded
    recorded = measured(store, CONN, 1)
    assert (recorded.benchmark, recorded.trusted_rates) == (Benchmark(0.5, 0.99), Benchmark(0.75, 1.0))
    assert recorded.benchmark_run == RecordedBenchmark(GAINED, at=AT.isoformat(), by='admin-sub-1', by_kind='person')
    assert recorded.benchmark_passed
    assert recorded.status == PROPOSED   # recording it accepts nothing
    stored = row(store, CONN, 'VER#000001')
    assert stored['benchmark_gate'] == {'BOOL': True}
    assert '"failure_case": "slug-cut-bug"' in stored['benchmark_run']['S']
    log = row(store, CONN, 'LOG#000001#benchmarked')
    assert (log['by']['S'], log['at']['S'], log['event']['S']) == ('admin-sub-1', AT.isoformat(), 'benchmarked')
    assert store.version(WS, CONN, 'fixer', 1) == recorded
    # Create-only: a second record, even a better one, is refused and changes nothing.
    with pytest.raises(SkillConflict, match="version 1's benchmark is recorded already") as refused:
        store.record_benchmark(WS, CONN, 'fixer', 1, REGRESSED, ADMIN)
    assert refused.value.kind == 'conflict'
    assert store.version(WS, CONN, 'fixer', 1).benchmark_run == recorded.benchmark_run


def test_a_second_record_is_refused_inside_the_transaction_too(store: SkillStore,
                                                               monkeypatch: pytest.MonkeyPatch) -> None:
    coach_version(store)
    measured(store, CONN, 1)
    monkeypatch.setattr(skills_store, '_recorded', lambda _: None)   # a pre-check that read before the first record
    with pytest.raises(SkillConflict, match='recorded, or the version changed, meanwhile'):
        store.record_benchmark(WS, CONN, 'fixer', 1, REGRESSED, ADMIN)
    monkeypatch.undo()
    assert store.version(WS, CONN, 'fixer', 1).benchmark_run is not None
    assert row(store, CONN, 'VER#000001')['benchmark_gate'] == {'BOOL': True}


@pytest.mark.parametrize('actor', [COACH, MEMBER])
def test_only_an_administrator_records_a_benchmark(store: SkillStore, actor: Actor) -> None:
    coach_version(store)
    with pytest.raises(SkillForbidden, match='only an administrator records the benchmark of') as refused:
        store.record_benchmark(WS, CONN, 'fixer', 1, GAINED, actor)
    assert refused.value.kind == 'forbidden'
    assert store.version(WS, CONN, 'fixer', 1).benchmark_run is None
    assert absent(store, CONN, 'LOG#000001#benchmarked')


def test_only_a_proposed_version_is_benchmarked(store: SkillStore) -> None:
    shared_v1(store)
    with pytest.raises(SkillConflict, match='version 1 is accepted: only a proposed version is benchmarked'):
        measured(store, SHARED, 1)
    with pytest.raises(SkillNotFound):
        measured(store, SHARED, 7)


def test_the_coach_version_is_accepted_only_once_its_benchmark_passed_with_a_gain(store: SkillStore) -> None:
    coach_version(store)
    with pytest.raises(SkillConflict, match="version 1 is the coach's and has no recorded benchmark") as refused:
        store.accept_version(WS, CONN, 'fixer', 1, ADMIN)
    assert refused.value.kind == 'conflict'
    measured(store, CONN, 1, REGRESSED)
    with pytest.raises(SkillConflict, match="the coach's and failed its benchmark: it is accepted only once"):
        store.accept_version(WS, CONN, 'fixer', 1, ADMIN)
    assert store.version(WS, CONN, 'fixer', 1).status == PROPOSED
    assert store.current(WS, CONN, 'fixer') == store.version(WS, SHARED, 'fixer', 1)   # still the shared skill
    # A version measured once stays as measured: the coach writes a new one, which passes this time.
    again = store.propose_version(WS, CONN, 'fixer', content(instructions='Fix it, then run the suite.'),
                                  proposer=COACH, reason=Reason(RUN, 'timeout'), base=SkillRef(SHARED, 1)).version
    measured(store, CONN, again.version, UNNAMED)
    with pytest.raises(SkillConflict, match='names no failure case'):
        store.accept_version(WS, CONN, 'fixer', again.version, ADMIN)
    third = store.propose_version(WS, CONN, 'fixer', content(instructions='Fix it, then run every test.'),
                                  proposer=COACH, reason=Reason(RUN, 'error'), base=SkillRef(SHARED, 1)).version
    measured(store, CONN, third.version)
    accepted = store.accept_version(WS, CONN, 'fixer', third.version, ADMIN)
    assert accepted.version.status == ACCEPTED
    assert accepted.announcement is not None
    assert (accepted.announcement.type, accepted.announcement.to_version) == ('skill.accepted', SkillRef(CONN, 3))
    assert store.current(WS, CONN, 'fixer') == accepted.version
    assert accepted.version.benchmark_run == RecordedBenchmark(GAINED, AT.isoformat(), 'admin-sub-1', 'person')


@pytest.mark.parametrize('run', [None, REGRESSED, UNNAMED])
def test_the_benchmark_condition_holds_inside_the_transaction(store: SkillStore, monkeypatch: pytest.MonkeyPatch,
                                                              run: BenchmarkRun | None) -> None:
    coach_version(store)
    if run is not None:
        measured(store, CONN, 1, run)
    expected = {'BOOL': False} if run is not None else None
    assert row(store, CONN, 'VER#000001').get('benchmark_gate') == expected
    # A pre-check that saw a gain the row does not hold (none recorded, a failed gate, a pass naming no failure
    # case): the transaction's condition, the stored gate, still refuses.
    monkeypatch.setattr(SkillVersion, 'benchmark_passed', property(lambda _: True))
    with pytest.raises(SkillConflict, match='changed meanwhile'):
        store.accept_version(WS, CONN, 'fixer', 1, ADMIN)
    monkeypatch.undo()
    assert store.version(WS, CONN, 'fixer', 1).status == PROPOSED


def test_a_version_a_person_wrote_is_accepted_as_before_measured_or_not(store: SkillStore) -> None:
    v1 = shared_v1(store)
    store.propose_version(WS, CONN, 'fixer', stricter(), proposer=MEMBER, reason=NO_GO, base=v1.ref)
    measured(store, CONN, 1, REGRESSED)   # an administrator may still take a person's version that regressed
    assert store.accept_version(WS, CONN, 'fixer', 1, ADMIN).version.status == ACCEPTED
    store.propose_version(WS, SHARED, 'fixer', stricter(), proposer=MEMBER, reason=WHY, base=v1.ref)
    assert store.accept_version(WS, SHARED, 'fixer', 2, ADMIN).version.benchmark_run is None


def test_a_benchmark_that_would_take_the_row_over_its_cap_is_refused(store: SkillStore,
                                                                     monkeypatch: pytest.MonkeyPatch) -> None:
    coach_version(store)
    size = item_bytes(row(store, CONN, 'VER#000001'))
    monkeypatch.setattr(skills_store, 'MAX_ITEM_BYTES', size + 100)
    with pytest.raises(SkillError, match=f'with its benchmark would be [0-9]+ bytes, over its {size + 100}-byte cap'):
        measured(store, CONN, 1)
    monkeypatch.undo()
    assert store.version(WS, CONN, 'fixer', 1).benchmark_run is None
    assert absent(store, CONN, 'LOG#000001#benchmarked')


def largest_benchmark() -> BenchmarkRun:
    """A recorded benchmark as large as one may be: 100 cases of the longest ids, and reasons up to the byte bound."""
    cases = tuple(f'{n:02d}' + 'c' * 61 for n in range(100))
    reasons = ['r' * 400] * 102
    while True:
        try:
            return BenchmarkRun(before=0.5, after=0.5, cases=cases, passed=True, reasons=tuple(reasons))
        except SkillError:
            reasons.pop()


def test_the_worst_case_version_row_with_its_benchmark_stays_under_its_cap(store: SkillStore) -> None:
    worst = worst_version(store)
    run = largest_benchmark()
    assert len(run.stored_json().encode('utf-8')) > MAX_BENCHMARK_BYTES - 500
    longest = Actor('p' * 200, 'person', admin=True)
    store.record_benchmark(WS, SHARED, 'fixer', worst.version, run, longest)
    stored = row(store, '', f'VER#{worst.version:06d}')
    assert 240_000 < item_bytes(stored) <= MAX_ITEM_BYTES


def test_an_unreadable_recorded_benchmark_is_refused(store: SkillStore) -> None:
    coach_version(store)
    for bad in ('[]', '{"at": "now"}', json.dumps({**GAINED.to_json(), 'at': 'now', 'by': 'x', 'by_kind': 'person',
                                                    'extra': 1})):
        store.client.update_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WS}#SKILL#{CONN}#fixer'},
                                                       'sk': {'S': 'VER#000001'}},
                                 UpdateExpression='SET benchmark_run = :bad',
                                 ExpressionAttributeValues={':bad': {'S': bad}})
        with pytest.raises(SkillError, match='not a readable skill: a recorded benchmark'):
            store.version(WS, CONN, 'fixer', 1)
