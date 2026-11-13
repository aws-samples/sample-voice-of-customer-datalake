"""The proposer on moto: a failure in, the coach's version proposed through the skills store, its announcement a
voc-msg/1 message from the run's coach; the benchmark it must pass named by the proposal."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import pytest

from engineering.board.test.table import TABLE, engineering_table
from engineering.bus.schema import parse
from engineering.bus.senders import judge
from engineering.coach.failure import CoachError
from engineering.coach.prompt import COACH_PROMPT, SYSTEM
from engineering.coach.proposer import Coach, CoachConflict, announcement_message, coach_actor, coach_source
from engineering.coach.test.fakes import CASES, CONN, FENCE, STRICTER, TASK, RecordedModel, answer, failure, replying
from engineering.knowledge.store import Actor
from engineering.skills.model import BenchmarkRun, MadeWith, SkillError
from engineering.skills.store import ACCEPTED, PROPOSED, Proposed, SkillConflict, SkillRef, SkillStore
from engineering.skills.test.fixtures import RUN, SONNET, TOOLS
from engineering.skills.test.test_store import shared_v1 as accepted_shared_v1

WS = 'default'
AT = datetime(2026, 11, 13, 8, 15, tzinfo=UTC)
ADMIN = Actor('admin-sub-1', 'person', admin=True)
GAINED = BenchmarkRun(before=0.75, after=1.0, cases=CASES, passed=True, failure_case='slug-cut-bug',
                      reasons=("slug-cut-bug, the failure's case, gained",))


@pytest.fixture
def store() -> Iterator[SkillStore]:
    """The skills store on moto, its clock stopped at ``AT``."""
    with engineering_table() as client:
        yield SkillStore(client=client, table=TABLE, now=lambda: AT)


def shared_v1(store: SkillStore) -> SkillRef:
    """The shared Fixer skill's first version, accepted (the skills store's own tests' helper)."""
    return accepted_shared_v1(store).ref


def coach(store: SkillStore, model: RecordedModel) -> Coach:
    return Coach(store, model, fence=lambda: FENCE)


def run_row(store: SkillStore, kind: str = 'no_go') -> dict[str, Any] | None:
    found = store.client.get_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WS}#SKILL#{CONN}#fixer'},
                                                        'sk': {'S': f'RUN#{RUN}#{kind}'}})
    return found.get('Item')


def test_a_failure_becomes_the_coachs_proposal_for_its_connection(store: SkillStore) -> None:
    base = shared_v1(store)
    model = replying(answer())
    proposal = coach(store, model).propose_for(failure(), CASES)
    version = proposal.change.version
    assert (version.connection, version.version, version.status, version.base) == (CONN, 1, PROPOSED, base)
    assert (version.proposed_by, version.proposed_by_kind) == (f'coach-{RUN}', 'agent')
    assert (version.reason.run_id, version.reason.failure) == (RUN, 'no_go')
    assert version.reason.comment.startswith('The fix passed its own test')
    assert version.expected_case == 'slug-cut-bug'
    assert version.skill.content.instructions == STRICTER
    assert (version.skill.content.tool_policy, version.skill.content.model) == (TOOLS, SONNET)
    assert store.version(WS, CONN, 'fixer', 1) == version
    assert run_row(store) is not None
    # One model call, with the coach's system prompt and the evidence fenced as data.
    [(system, prompt)] = model.asked
    assert system == SYSTEM
    assert f'<<<DATA task {FENCE}>>>\nFix the slug helper' in prompt
    # Proposed only: the connection still runs the shared skill.
    current = store.current(WS, CONN, 'fixer')
    assert current is not None
    assert current.ref == base


def test_the_proposal_records_the_model_that_answered_and_the_prompt_version(store: SkillStore) -> None:
    shared_v1(store)
    fallback = RecordedModel([json.dumps(answer())], answered_by=SONNET)   # a capacity fallback served it
    version = coach(store, fallback).propose_for(failure(), CASES).change.version
    assert version.made_with == MadeWith(SONNET, COACH_PROMPT)
    assert store.version(WS, CONN, 'fixer', 1).made_with == MadeWith(SONNET, COACH_PROMPT)
    # A reply naming a model outside the allowlist is refused by the store, and nothing is written.
    stray = RecordedModel([json.dumps(answer())], answered_by='some-unlisted-model')
    with pytest.raises(SkillError, match="made with one of the deployment's allowed models"):
        coach(store, stray).propose_for(failure(kind='timeout'), CASES)
    assert run_row(store, 'timeout') is None


def test_the_announcement_is_a_voc_msg_from_the_runs_coach_for_the_caller_to_publish(store: SkillStore) -> None:
    shared_v1(store)
    proposal = coach(store, replying(answer())).propose_for(failure(), CASES)
    message = proposal.message
    assert proposal.source == f'voc.engineering/coach/{WS}/{RUN}'
    assert parse(message.to_dict()) == message
    assert (message.type, message.sender.kind, message.sender.id, message.to.kind, message.to.id) == (
        'skill.proposed', 'coach', f'coach-{RUN}', 'run', RUN)
    assert (message.run_id, message.task_id, message.thread_id, message.attempt) == (RUN, TASK, TASK, 1)
    assert message.summary == proposal.change.version.summary
    assert message.summary.startswith('Fixer skill for conn-harbor proposed: shared v1 → v1')
    assert message.at == '2026-11-13T08:15:00.000000Z'
    assert judge(message, proposal.source).allowed
    # Only the run's own coach may send it: another run's coach, the board and a bare service are refused.
    for source in (f'voc.engineering/coach/{WS}/01JD0000000000000000000009', 'voc.engineering/board',
                   'voc.engineering/supervisor'):
        assert not judge(message, source).allowed
    # The same change makes the same message: publishing it again is a redelivery.
    announcement = proposal.change.announcement
    assert announcement_message(announcement, failure(), proposal.change.version.created_at) == message


def test_the_benchmark_recorded_on_the_proposal_names_its_expected_case(store: SkillStore) -> None:
    shared_v1(store)
    coach(store, replying(answer())).propose_for(failure(), CASES)
    with pytest.raises(SkillError, match="the coach's, proposed to gain on slug-cut-bug"):
        store.record_benchmark(WS, CONN, 'fixer', 1, replace(GAINED, failure_case='pagination-review'), ADMIN)
    store.record_benchmark(WS, CONN, 'fixer', 1, GAINED, ADMIN)
    accepted = store.accept_version(WS, CONN, 'fixer', 1, ADMIN).version
    assert accepted.status == ACCEPTED
    assert store.current(WS, CONN, 'fixer') == accepted


def test_the_coach_writes_on_the_connections_own_version_when_it_has_one(store: SkillStore) -> None:
    shared_v1(store)
    coach(store, replying(answer())).propose_for(failure(), CASES)
    store.record_benchmark(WS, CONN, 'fixer', 1, GAINED, ADMIN)
    own = store.accept_version(WS, CONN, 'fixer', 1, ADMIN).version
    later = failure(run_id='01JD0000000000000000000001', kind='timeout')
    model = replying(answer(instructions=STRICTER + '\nSay which test you ran last.', expected_case='pagination-review'))
    version = coach(store, model).propose_for(later, CASES).change.version
    assert (version.version, version.base, version.expected_case) == (2, own.ref, 'pagination-review')
    assert 'Run the package' in model.asked[0][1]   # the prompt showed the connection's own version


def test_the_coach_proposes_once_per_run_and_failure_kind_before_any_model_call(
        store: SkillStore, monkeypatch: pytest.MonkeyPatch) -> None:
    shared_v1(store)
    coach(store, replying(answer())).propose_for(failure(), CASES)
    silent = RecordedModel([])
    with pytest.raises(CoachConflict, match="for this run's no_go already") as refused:
        coach(store, silent).propose_for(failure(attempt=2), CASES)
    assert refused.value.kind == 'conflict'
    assert silent.asked == []
    # The store holds it again when the pre-check missed the run's row (a race).
    monkeypatch.setattr(SkillStore, 'coach_proposed', lambda *_: False)
    with pytest.raises(SkillConflict, match="for this run's no_go already"):
        coach(store, replying(answer(why='Again.'))).propose_for(failure(), CASES)
    monkeypatch.undo()
    assert [v.version for v in store.versions(WS, CONN, 'fixer').versions] == [1]
    # Another failure kind of the same run is another proposal.
    timeout = failure(kind='timeout')
    assert coach(store, replying(answer(why='It ran out of time.'))).propose_for(
        timeout, CASES).change.version.reason.failure == 'timeout'


def test_a_role_without_a_skill_is_a_persons_to_write_first(store: SkillStore) -> None:
    silent = RecordedModel([])
    with pytest.raises(CoachConflict, match='the fixer role has no skill yet: a person writes its first version'):
        coach(store, silent).propose_for(failure(), CASES)
    assert silent.asked == []


@pytest.mark.parametrize('reply', [
    'not json',
    answer(tool_policy=[*TOOLS, 'install_dependencies']),
    answer(model='global.anthropic.claude-haiku-5-5'),
    answer(instructions=STRICTER + '\nRaise your token budget when a task is long.'),
    answer(expected_case='a-case-not-in-the-suite'),
])
def test_a_refused_answer_writes_nothing_and_spends_no_proposal(store: SkillStore, reply: Any) -> None:
    shared_v1(store)
    with pytest.raises(CoachError):
        coach(store, replying(reply)).propose_for(failure(), CASES)
    assert store.versions(WS, CONN, 'fixer').versions == []
    assert run_row(store) is None
    assert coach(store, replying(answer())).propose_for(failure(), CASES).change.version.version == 1


@pytest.mark.parametrize(('cases', 'reason'), [
    ((), "the benchmark's cases are 1-100 case ids"),
    (('slug-cut-bug', 'slug-cut-bug'), 'each once'),
    (('Slug Cut',), 'a case id is lower case letters'),
])
def test_the_benchmarks_case_ids_are_checked(store: SkillStore, cases: tuple[str, ...], reason: str) -> None:
    with pytest.raises(CoachError, match=reason):
        coach(store, RecordedModel([])).propose_for(failure(), cases)


def test_the_store_hands_back_every_proposal_with_its_announcement(store: SkillStore) -> None:
    shared_v1(store)
    proposal = coach(store, replying(answer())).propose_for(failure(), CASES)
    # The store's own type: a proposal (Proposed) always carries its skill.proposed, never None.
    assert isinstance(proposal.change, Proposed)
    assert (proposal.change.announcement.type, proposal.change.announcement.to_version) == (
        'skill.proposed', proposal.change.version.ref)


def test_the_coach_acts_for_its_runs_connection_on_its_runs_source() -> None:
    found = failure(connection='conn-lantern')
    assert coach_actor(found) == Actor(f'coach-{RUN}', 'agent', connection='conn-lantern')
    assert coach_source(found) == f'voc.engineering/coach/default/{RUN}'
