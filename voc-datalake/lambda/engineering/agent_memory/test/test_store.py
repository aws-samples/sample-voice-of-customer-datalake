"""The agents' memory store on moto: scopes kept apart, an agent held to its run, drafts until approved, versions,
forget and restore, confirmations and the pack proposal, bounded reads, recall for a task, a person's erasure."""
from __future__ import annotations

import hashlib
import inspect
from collections.abc import Callable, Iterator
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from itertools import count
from typing import Any

import pytest

from engineering.agent_memory import store as memory_store
from engineering.agent_memory.model import (
    PACK_CONFIRMATIONS,
    AgentMemoryError,
    MemoryInput,
    Provenance,
    RunContext,
    Scope,
)
from engineering.agent_memory.store import (
    ACTIVE,
    APPROVED,
    ARCHIVED,
    DRAFT,
    PROPOSED,
    TOMBSTONE_PK,
    AgentMemoryConflict,
    AgentMemoryForbidden,
    AgentMemoryNotFound,
    AgentMemoryStore,
    Learned,
)
from engineering.board.test.table import TABLE, engineering_table
from engineering.knowledge.notes import CitationRules
from engineering.knowledge.store import Actor
from shared.delete_audit import AUDIT_PK

WS = 'default'
CONN, OTHER = 'conn-harbor', 'conn-lantern'
RUN_A, RUN_B, RUN_C, RUN_D, RUN_E = (f'01JD000000000000000000000{i}' for i in range(5))
FIXER = Actor('fixer-0', 'agent', connection=CONN)
HUNTER = Actor('hunter-0', 'agent', connection=CONN)
STRANGER = Actor('fixer-0', 'agent', connection=OTHER)
ADMIN = Actor('admin-sub-1', 'person', admin=True)
MEMBER = Actor('member-sub-2', 'person')
DANA = Actor('dana-sub-3', 'person')
USERS = frozenset({ADMIN.id, MEMBER.id, DANA.id})
RULES = CitationRules('github', 'https://github.com/example-org/harbor')
COMMENT = 'https://github.com/example-org/harbor/pull/12#discussion_r345'
REPO = Scope('repository', CONN)
ROLE = Scope('role', CONN, 'fixer')
DANA_HERE = Scope('person', CONN, person=DANA.id)    # what agents learn of Dana in CONN
DANA_OWN = Scope('person', person=DANA.id)           # what Dana writes herself
START = datetime(2026, 11, 12, 9, 30, tzinfo=UTC)


def run(run_id: str = RUN_A, *, agent: Actor = FIXER, role: str = 'fixer',
        people: tuple[str, ...] = (DANA.id,)) -> RunContext:
    """A run's context as the trusted caller builds it from the run's record."""
    return RunContext(agent, run_id, role, people)


FIX = run()


@dataclass
class Clock:
    at: datetime = START

    def __call__(self) -> datetime:
        return self.at


@dataclass
class World:
    store: AgentMemoryStore
    clock: Clock
    client: Any


@pytest.fixture
def world() -> Iterator[World]:
    clock = Clock()
    ids = count(1)
    with engineering_table() as client:
        yield World(AgentMemoryStore(client, TABLE, is_user=USERS.__contains__, now=clock,
                                     new_id=lambda: f'amem_{next(ids):04d}'), clock, client)


def lesson(statement: str = 'Squash merges only; the default branch keeps one commit per pull request.', *,
           subject: str = 'merge style', kind: str = 'convention', run_id: str = RUN_A, confidence: float = 0.9,
           provenance: Provenance | None = None, review_by: date | None = None) -> MemoryInput:
    return MemoryInput(subject, kind, statement, provenance or Provenance(run_id=run_id), confidence, review_by,
                       ('fb_0012',))


def mine(person: Actor, statement: str = 'Keep my pull requests under 300 changed lines.') -> MemoryInput:
    return MemoryInput('pull request size', 'preference', statement, Provenance(person=person.id))


def learn(world: World, scope: Scope = REPO, memory: MemoryInput | None = None, *,
          ctx: RunContext = FIX) -> Learned:
    return world.store.learn_agent_memory(WS, scope, memory or lesson(run_id=ctx.run_id), run=ctx, review_texts=(),
                                          rules=RULES)


def write(world: World, scope: Scope, memory: MemoryInput, by: Actor) -> Learned:
    return world.store.write_agent_memory(WS, scope, memory, by=by, review_texts=())


def recalled(world: World, ctx: RunContext = FIX) -> list[str]:
    return [m.candidate.statement for m in world.store.recall_for_task(WS, ctx).memories]


def learned_and_approved(world: World, scope: Scope = REPO, memory: MemoryInput | None = None) -> str:
    made = learn(world, scope, memory)
    approver = DANA if scope.kind == 'person' else ADMIN
    world.store.approve_agent_memory(WS, scope, made.memory.memory_id, 1, by=approver)
    return made.memory.memory_id


def rows(world: World, pk: str, prefix: str = '') -> list[dict[str, Any]]:
    if not prefix:
        return world.client.query(TableName=TABLE, KeyConditionExpression='pk = :pk',
                                  ExpressionAttributeValues={':pk': {'S': pk}})['Items']
    return world.client.query(TableName=TABLE, KeyConditionExpression='pk = :pk AND begins_with(sk, :p)',
                              ExpressionAttributeValues={':pk': {'S': pk}, ':p': {'S': prefix}})['Items']


def scope_rows(world: World, scope: Scope, prefix: str) -> list[dict[str, Any]]:
    return rows(world, scope.partition(WS), prefix)


def edit(world: World, scope: Scope, memory_id: str, base: int, by: Actor, statement: str | None = None,
         review_by: date | None = None) -> Any:
    return world.store.edit_agent_memory(WS, scope, memory_id, base_version=base, by=by, review_texts=(),
                                         statement=statement, review_by=review_by)


# ── drafts and approval ────────────────────────────────────────────────────────

def test_a_learned_memory_is_a_draft_and_is_not_recalled_until_an_administrator_approves_it(world: World) -> None:
    made = learn(world)
    assert (made.confirmed, made.memory.status, made.memory.approved_version, made.memory.statement) == (
        False, PROPOSED, 0, '')
    assert recalled(world) == []
    for not_allowed in (MEMBER, FIXER):
        with pytest.raises(AgentMemoryForbidden):
            world.store.approve_agent_memory(WS, REPO, made.memory.memory_id, 1, by=not_allowed)
    approved = world.store.approve_agent_memory(WS, REPO, made.memory.memory_id, 1, by=ADMIN)
    assert (approved.status, approved.approved_version) == (ACTIVE, 1)
    assert recalled(world) == [lesson().statement]
    [version] = world.store.agent_memory_history(WS, REPO, made.memory.memory_id, by=ADMIN)
    assert (version.status, version.author, version.author_kind, version.approved_by, version.approved_at,
            version.provenance.run_id, version.feedback_ids) == (
        APPROVED, FIXER.id, 'agent', ADMIN.id, START.isoformat(), RUN_A, ('fb_0012',))
    assert [r['event']['S'] for r in scope_rows(world, REPO, 'LOG#')] == [APPROVED]
    again = world.store.approve_agent_memory(WS, REPO, made.memory.memory_id, 1, by=ADMIN)
    assert again.revision == approved.revision


def test_pending_lists_the_drafts_for_their_approver_only(world: World) -> None:
    made = learn(world, ROLE, lesson(kind='lesson'))
    [(head, version)] = world.store.pending_agent_memories(WS, ROLE, by=ADMIN)
    assert (head.memory_id, version.version, version.status) == (made.memory.memory_id, 1, DRAFT)
    with pytest.raises(AgentMemoryForbidden):
        world.store.pending_agent_memories(WS, ROLE, by=MEMBER)
    world.store.approve_agent_memory(WS, ROLE, made.memory.memory_id, 1, by=ADMIN)
    assert world.store.pending_agent_memories(WS, ROLE, by=ADMIN) == []


def test_an_administrators_own_memory_is_approved_at_once_a_members_is_a_draft(world: World) -> None:
    by_admin = write(world, REPO, lesson(provenance=Provenance(person=ADMIN.id)), ADMIN)
    by_member = write(world, REPO, lesson('Flaky: the upload test fails when the clock passes midnight.',
                                          subject='upload test', kind='flaky_test',
                                          provenance=Provenance(person=MEMBER.id)), MEMBER)
    assert (by_admin.memory.status, by_member.memory.status) == (ACTIVE, PROPOSED)
    assert by_admin.memory.confidence == 1.0
    assert recalled(world) == [lesson().statement]
    with pytest.raises(AgentMemoryError, match='never a run'):
        write(world, REPO, lesson('A person claiming a run.', subject='claims'), MEMBER)


def test_a_learned_memory_needs_the_layers_confidence(world: World) -> None:
    with pytest.raises(AgentMemoryError, match='confidence'):
        learn(world, memory=lesson(confidence=0.79))
    assert scope_rows(world, REPO, 'MEM#') == []
    assert learn(world, memory=lesson(confidence=0.8)).memory.status == PROPOSED


def test_the_review_quote_check_cannot_be_skipped() -> None:
    for method in ('learn_agent_memory', 'write_agent_memory', 'edit_agent_memory'):
        parameter = inspect.signature(getattr(AgentMemoryStore, method)).parameters['review_texts']
        assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
        assert parameter.default is inspect.Parameter.empty
    with engineering_table() as client:
        learn_call = AgentMemoryStore(client, TABLE, is_user=USERS.__contains__).learn_agent_memory
        without_reviews: dict[str, Any] = {'run': FIX}
        with pytest.raises(TypeError, match='review_texts'):
            learn_call(WS, REPO, lesson(), **without_reviews)
        assert scope_rows_of(client, REPO) == []


def scope_rows_of(client: Any, scope: Scope) -> list[dict[str, Any]]:
    return client.query(TableName=TABLE, KeyConditionExpression='pk = :pk',
                        ExpressionAttributeValues={':pk': {'S': scope.partition(WS)}})['Items']


# ── scopes, and an agent held to its run ──────────────────────────────────────

def test_one_connections_memories_never_reach_another_connections_agents(world: World) -> None:
    learned_and_approved(world, REPO)
    learned_and_approved(world, ROLE, lesson('Run the package tests before submitting a fix.', subject='tests',
                                             kind='lesson'))
    assert len(recalled(world)) == 2
    stranger = run(agent=STRANGER)
    assert recalled(world, stranger) == []
    with pytest.raises(AgentMemoryForbidden):
        learn(world, REPO, ctx=stranger)
    [memory_id] = [r['memory_id']['S'] for r in scope_rows(world, REPO, 'MEM#')]
    with pytest.raises(AgentMemoryNotFound):
        world.store.approve_agent_memory(WS, Scope('repository', OTHER), memory_id, 1, by=ADMIN)
    with pytest.raises(AgentMemoryForbidden):
        world.store.confirm_agent_memory(WS, REPO, memory_id, by=run(RUN_B, agent=STRANGER))


def test_a_roles_lessons_reach_and_are_written_by_that_role_only(world: World) -> None:
    learned_and_approved(world, ROLE, lesson('Run the package tests before submitting a fix.', subject='tests',
                                             kind='lesson'))
    hunter = run(agent=HUNTER, role='hunter')
    assert recalled(world) == ['Run the package tests before submitting a fix.']
    assert recalled(world, hunter) == []
    with pytest.raises(AgentMemoryForbidden, match='own role'):
        learn(world, ROLE, lesson('A hunter writing the fixer a lesson.', subject='x', kind='lesson'), ctx=hunter)
    [memory_id] = [r['memory_id']['S'] for r in scope_rows(world, ROLE, 'MEM#')]
    with pytest.raises(AgentMemoryForbidden, match='own role'):
        world.store.confirm_agent_memory(WS, ROLE, memory_id, by=run(RUN_B, agent=HUNTER, role='hunter'))


def test_an_agent_reads_and_learns_only_the_people_on_its_task(world: World) -> None:
    write(world, DANA_OWN, mine(DANA), DANA)
    assert recalled(world) == [mine(DANA).statement]
    assert recalled(world, run(people=())) == []                    # not on the task: not read
    nobody = run(people=(MEMBER.id,))
    assert recalled(world, nobody) == []
    with pytest.raises(AgentMemoryForbidden, match='people on its task'):
        learn(world, DANA_HERE, lesson('Dana wants the migration called out first.', subject='migrations',
                                       kind='preference'), ctx=nobody)


def test_an_agents_provenance_is_its_own_run(world: World) -> None:
    with pytest.raises(AgentMemoryForbidden, match='own run'):
        learn(world, memory=lesson(run_id=RUN_E))                  # an invented run id
    with pytest.raises(AgentMemoryError, match='never a person'):
        learn(world, memory=lesson(provenance=Provenance(person=DANA.id)))
    assert scope_rows(world, REPO, '') == []


def test_a_person_memory_is_kept_only_for_a_user_of_this_deployment(world: World) -> None:
    host_only = Scope('person', CONN, person='octo-reviewer')
    with pytest.raises(AgentMemoryForbidden, match='signed-in user'):
        learn(world, host_only, lesson(subject='pull request size', kind='preference'),
              ctx=run(people=('octo-reviewer',)))
    assert scope_rows(world, host_only, '') == []
    with pytest.raises(AgentMemoryForbidden):   # a learned person memory applies to the run's connection only
        learn(world, DANA_OWN, lesson(subject='pull request size', kind='preference'))


def test_a_persons_memory_is_approved_and_forgotten_by_that_person_only(world: World) -> None:
    made = learn(world, DANA_HERE, lesson('Dana asks for a test plan in every description.', subject='description',
                                          kind='preference', provenance=Provenance(comment_url=COMMENT)))
    memory_id = made.memory.memory_id
    for not_allowed in (ADMIN, MEMBER, FIXER):
        with pytest.raises(AgentMemoryForbidden):
            world.store.approve_agent_memory(WS, DANA_HERE, memory_id, 1, by=not_allowed)
    with pytest.raises(AgentMemoryForbidden):
        world.store.agent_memory_history(WS, DANA_HERE, memory_id, by=ADMIN)
    with pytest.raises(AgentMemoryForbidden):
        world.store.pending_agent_memories(WS, DANA_HERE, by=ADMIN)
    assert world.store.approve_agent_memory(WS, DANA_HERE, memory_id, 1, by=DANA).status == ACTIVE
    assert recalled(world) == ['Dana asks for a test plan in every description.']
    with pytest.raises(AgentMemoryForbidden):
        world.store.forget_agent_memory(WS, DANA_HERE, memory_id, by=ADMIN)
    assert world.store.forget_agent_memory(WS, DANA_HERE, memory_id, by=DANA).status == ARCHIVED
    assert recalled(world) == []


def test_a_persons_own_memory_applies_everywhere_a_learned_one_only_in_its_connection(world: World) -> None:
    own = write(world, DANA_OWN, mine(DANA), DANA)
    assert own.memory.status == ACTIVE
    learned_and_approved(world, DANA_HERE, lesson('Dana wants the migration called out first.', subject='migrations',
                                                  kind='preference'))
    assert sorted(recalled(world)) == sorted([mine(DANA).statement, 'Dana wants the migration called out first.'])
    assert recalled(world, run(agent=STRANGER)) == [mine(DANA).statement]
    with pytest.raises(AgentMemoryForbidden):
        write(world, DANA_OWN, mine(MEMBER), MEMBER)
    with pytest.raises(AgentMemoryForbidden):   # a person speaks only for themselves
        write(world, Scope('person', person=MEMBER.id), mine(DANA), MEMBER)
    host = Actor('host-only', 'person')
    with pytest.raises(AgentMemoryForbidden):
        write(world, Scope('person', person='host-only'), mine(host), host)


# ── provenance and hygiene ─────────────────────────────────────────────────────

def test_a_comments_provenance_is_the_connections_own_host(world: World) -> None:
    elsewhere = 'https://github.com/example-org/lantern/pull/12#discussion_r345'
    for url, rules in ((elsewhere, RULES), (COMMENT, None)):
        with pytest.raises(AgentMemoryError, match='own host'):
            world.store.learn_agent_memory(WS, REPO, lesson(provenance=Provenance(comment_url=url)), run=FIX,
                                           review_texts=(), rules=rules)
    made = learn(world, memory=lesson(provenance=Provenance(comment_url=COMMENT)))
    [version] = world.store.agent_memory_history(WS, REPO, made.memory.memory_id, by=ADMIN)
    assert version.provenance.comment_url == COMMENT


def test_a_stored_statement_is_redacted_and_never_a_reviews_text(world: World) -> None:
    review = 'The export button crashes the whole app every single time I press it.'
    with pytest.raises(AgentMemoryError, match='feedback id'):
        world.store.learn_agent_memory(WS, REPO, lesson(f'Bug: {review}', subject='export'), run=FIX,
                                       review_texts=[review])
    with pytest.raises(AgentMemoryError, match='feedback id'):
        world.store.write_agent_memory(WS, REPO, lesson(f'Bug: {review}', subject='export',
                                                        provenance=Provenance(person=ADMIN.id)), by=ADMIN,
                                       review_texts=[review])
    made = world.store.learn_agent_memory(
        WS, REPO, lesson('The export crash came back twice; the token ghp_' + 'b' * 36 + ' was in the log.',
                         subject='export', kind='recurring_bug'), run=FIX, review_texts=[review])
    stored = scope_rows(world, REPO, 'VER#')[0]['statement']['S']
    assert 'ghp_' not in stored
    assert stored == made.memory.latest_statement
    world.store.approve_agent_memory(WS, REPO, made.memory.memory_id, 1, by=ADMIN)
    with pytest.raises(AgentMemoryError, match='feedback id'):
        world.store.edit_agent_memory(WS, REPO, made.memory.memory_id, base_version=1, by=ADMIN,
                                      review_texts=[review], statement=f'Still: {review}')


# ── versions ───────────────────────────────────────────────────────────────────

def test_an_edit_is_a_new_version_with_its_author_and_the_old_one_stays(world: World) -> None:
    memory_id = learned_and_approved(world)
    world.clock.at = START + timedelta(days=1)
    edited = edit(world, REPO, memory_id, 1, MEMBER, 'Squash merges, except release branches.')
    assert (edited.latest_version, edited.approved_version, edited.status) == (2, 1, ACTIVE)
    assert recalled(world) == [lesson().statement]           # a member's edit waits for an administrator
    approved = world.store.approve_agent_memory(WS, REPO, memory_id, 2, by=ADMIN)
    assert approved.statement == 'Squash merges, except release branches.'
    assert recalled(world) == ['Squash merges, except release branches.']
    history = world.store.agent_memory_history(WS, REPO, memory_id, by=ADMIN)
    assert [(v.version, v.status, v.author, v.base_version, v.statement) for v in history] == [
        (1, APPROVED, FIXER.id, 0, lesson().statement),
        (2, APPROVED, MEMBER.id, 1, 'Squash merges, except release branches.')]
    assert history[1].provenance == Provenance(person=MEMBER.id)
    assert history[1].created_at == (START + timedelta(days=1)).isoformat()
    with pytest.raises(AgentMemoryForbidden):
        edit(world, REPO, memory_id, 2, FIXER, 'An agent edit.')


def test_an_edit_on_a_version_that_moved_is_refused(world: World) -> None:
    memory_id = learned_and_approved(world)
    edit(world, REPO, memory_id, 1, MEMBER, 'First edit, a member.')
    with pytest.raises(AgentMemoryConflict, match='latest'):
        edit(world, REPO, memory_id, 1, DANA, 'Second, also on 1.')
    assert [v.version for v in world.store.agent_memory_history(WS, REPO, memory_id, by=ADMIN)] == [1, 2]


def test_a_draft_written_before_a_later_approval_is_not_approved_over_it(world: World) -> None:
    memory_id = learned_and_approved(world)
    edit(world, REPO, memory_id, 1, MEMBER, 'Edit two, a draft.')
    edit(world, REPO, memory_id, 2, ADMIN, 'Edit three, approved.')
    with pytest.raises(AgentMemoryConflict, match='approved since'):
        world.store.approve_agent_memory(WS, REPO, memory_id, 2, by=ADMIN)
    assert recalled(world) == ['Edit three, approved.']


def test_an_unchanged_edit_moves_the_review_date(world: World) -> None:
    memory_id = learned_and_approved(world, memory=lesson(review_by=date(2026, 12, 1)))
    world.clock.at = datetime(2026, 12, 5, tzinfo=UTC)
    [stale] = world.store.recall_for_task(WS, FIX).memories
    assert stale.stale
    edit(world, REPO, memory_id, 1, ADMIN, review_by=date(2027, 3, 1))
    [fresh] = world.store.recall_for_task(WS, FIX).memories
    assert (fresh.stale, fresh.candidate.review_by, fresh.candidate.statement, fresh.candidate.version) == (
        False, '2027-03-01', lesson().statement, 2)


# ── forget and restore ─────────────────────────────────────────────────────────

def test_forget_archives_and_restore_brings_it_back_nothing_is_deleted(world: World) -> None:
    memory_id = learned_and_approved(world)
    with pytest.raises(AgentMemoryForbidden):
        world.store.forget_agent_memory(WS, REPO, memory_id, by=MEMBER)
    forgotten = world.store.forget_agent_memory(WS, REPO, memory_id, by=ADMIN)
    assert forgotten.status == ARCHIVED
    assert recalled(world) == []
    assert len(scope_rows(world, REPO, 'VER#')) == 1
    assert len(scope_rows(world, REPO, 'MEM#')) == 1
    with pytest.raises(AgentMemoryConflict, match='forgotten'):
        learn(world, ctx=run(RUN_B))
    with pytest.raises(AgentMemoryConflict):
        edit(world, REPO, memory_id, 1, ADMIN, 'Edited.')
    with pytest.raises(AgentMemoryConflict):
        world.store.confirm_agent_memory(WS, REPO, memory_id, by=run(RUN_B))
    assert world.store.forget_agent_memory(WS, REPO, memory_id, by=ADMIN).revision == forgotten.revision
    restored = world.store.restore_agent_memory(WS, REPO, memory_id, by=ADMIN)
    assert (restored.status, restored.statement) == (ACTIVE, lesson().statement)
    assert recalled(world) == [lesson().statement]
    assert [r['event']['S'] for r in scope_rows(world, REPO, 'LOG#')] == [APPROVED, 'forgotten', 'restored']


def test_a_restored_draft_is_a_draft_again_and_a_person_may_write_a_forgotten_one_anew(world: World) -> None:
    made = learn(world)
    world.store.forget_agent_memory(WS, REPO, made.memory.memory_id, by=ADMIN)
    assert world.store.restore_agent_memory(WS, REPO, made.memory.memory_id, by=ADMIN).status == PROPOSED
    world.store.forget_agent_memory(WS, REPO, made.memory.memory_id, by=ADMIN)
    anew = write(world, REPO, lesson(provenance=Provenance(person=ADMIN.id)), ADMIN)
    assert (anew.confirmed, anew.memory.status) == (False, ACTIVE)
    assert anew.memory.memory_id != made.memory.memory_id


# ── confirmations and the pack ────────────────────────────────────────────────

def test_the_same_lesson_again_confirms_once_per_source(world: World) -> None:
    memory_id = learned_and_approved(world)
    again = learn(world, memory=lesson('squash merges only;  the default branch keeps one commit per pull request',
                                       run_id=RUN_B), ctx=run(RUN_B))
    assert (again.confirmed, again.memory.memory_id, again.memory.confirmations) == (True, memory_id, 1)
    twice = world.store.confirm_agent_memory(WS, REPO, memory_id, by=run(RUN_B))
    assert (twice.counted, twice.memory.confirmations, twice.proposal) == (False, 1, None)
    learned_from = world.store.confirm_agent_memory(WS, REPO, memory_id, by=FIX)
    assert (learned_from.counted, learned_from.memory.confirmations) == (False, 1)   # its own source
    assert len(scope_rows(world, REPO, 'MEM#')) == 1


def test_a_person_confirms_only_as_themselves(world: World) -> None:
    memory_id = learned_and_approved(world)
    confirmed = world.store.confirm_agent_memory(WS, REPO, memory_id, by=MEMBER)
    assert (confirmed.counted, confirmed.memory.confirmations) == (True, 1)
    [source] = [r['source']['S'] for r in scope_rows(world, REPO, 'CONF#') if r['source']['S'].startswith('person')]
    assert source == f'person:{MEMBER.id}'
    with pytest.raises(AgentMemoryForbidden):
        world.store.confirm_agent_memory(WS, REPO, memory_id, by=Actor('host-only', 'person'))
    with pytest.raises(AgentMemoryForbidden):
        world.store.confirm_agent_memory(WS, REPO, memory_id, by=FIXER)   # an agent without its run's context


def test_a_lesson_confirmed_often_enough_is_proposed_for_the_pack_and_nothing_is_written_to_it(world: World) -> None:
    memory_id = learned_and_approved(world, memory=lesson(provenance=Provenance(comment_url=COMMENT)))
    other_comment = 'https://github.com/example-org/harbor/pull/14#issuecomment-77'
    first = learn(world, memory=lesson(provenance=Provenance(comment_url=other_comment)), ctx=run(RUN_B))
    second = world.store.confirm_agent_memory(WS, REPO, memory_id, by=MEMBER)
    third = world.store.confirm_agent_memory(WS, REPO, memory_id, by=run(RUN_C))
    assert (first.proposal, second.proposal) == (None, None)
    proposal = third.proposal
    assert proposal is not None
    assert (proposal.connection, proposal.memory_id, proposal.version, proposal.document, proposal.subject,
            proposal.claim, proposal.confirmations, proposal.feedback_ids) == (
        CONN, memory_id, 1, 'convention', 'merge style', lesson().statement, PACK_CONFIRMATIONS, ('fb_0012',))
    assert proposal.citations == (COMMENT, other_comment)
    pack_rows = world.client.scan(TableName=TABLE, FilterExpression='begins_with(sk, :k)',
                                  ExpressionAttributeValues={':k': {'S': 'KPACK'}})['Items']
    assert pack_rows == []


def test_a_draft_or_a_persons_memory_is_never_proposed_for_the_pack(world: World) -> None:
    draft = learn(world, ROLE, lesson(kind='lesson')).memory.memory_id
    own = write(world, DANA_OWN, mine(DANA), DANA).memory.memory_id
    for i, run_id in enumerate((RUN_B, RUN_C, RUN_D, RUN_E)):
        assert world.store.confirm_agent_memory(WS, ROLE, draft, by=run(run_id)).proposal is None
        mined = world.store.confirm_agent_memory(WS, DANA_OWN, own, by=run(run_id))
        assert (mined.counted, mined.memory.confirmations, mined.proposal) == (True, i + 1, None)


def test_a_role_lesson_is_proposed_for_how_we_work(world: World) -> None:
    memory_id = learned_and_approved(world, ROLE, lesson(kind='lesson'))
    proposal = None
    for run_id in (RUN_B, RUN_C, RUN_D):
        proposal = world.store.confirm_agent_memory(WS, ROLE, memory_id, by=run(run_id)).proposal
    assert proposal is not None
    assert proposal.document == 'how-we-work'


def test_confirmations_stop_counting_at_their_cap(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(memory_store, 'MAX_CONFIRMATIONS', 2)
    memory_id = learned_and_approved(world)
    counted = [world.store.confirm_agent_memory(WS, REPO, memory_id, by=run(r)).counted for r in (RUN_B, RUN_C,
                                                                                                   RUN_D)]
    assert counted == [True, True, False]
    assert world.store.confirm_agent_memory(WS, REPO, memory_id, by=MEMBER).memory.confirmations == 2
    assert len(scope_rows(world, REPO, 'CONF#')) == 3     # its own source and the two it counts


# ── recall ─────────────────────────────────────────────────────────────────────

def test_recall_flags_a_conflict_across_scopes_and_is_fenced(world: World) -> None:
    learned_and_approved(world)
    write(world, DANA_OWN, MemoryInput('merge style', 'preference', 'Rebase my pull requests, never squash.',
                                       Provenance(person=DANA.id)), DANA)
    recall = world.store.recall_for_task(WS, FIX)
    assert {m.candidate.memory_id: m.conflicts_with for m in recall.memories} == {
        'amem_0001': ('amem_0002',), 'amem_0002': ('amem_0001',)}
    assert '<<<DATA agent-memory ' in recall.text
    assert '[conflict: amem_0001]' in recall.text
    assert DANA.id not in recall.text


def test_recall_is_bounded_by_count_and_characters(world: World) -> None:
    for i in range(6):
        write(world, REPO, lesson(f'Convention number {i}: keep it.', subject=f'rule {i}',
                                  provenance=Provenance(person=ADMIN.id)), ADMIN)
    recall = world.store.recall_for_task(WS, FIX, max_memories=4)
    assert (len(recall.memories), recall.left_out) == (4, 2)
    tight = world.store.recall_for_task(WS, FIX, max_chars=300)
    assert 0 < len(tight.memories) < 4
    with pytest.raises(AgentMemoryError):
        world.store.recall_for_task(WS, FIX, max_memories=0)


def test_a_run_context_is_checked() -> None:
    for bad in (lambda: RunContext(ADMIN, RUN_A, 'fixer'), lambda: RunContext(FIXER, 'run-1', 'fixer'),
                lambda: RunContext(FIXER, RUN_A, 'wizard'),
                lambda: RunContext(FIXER, RUN_A, 'fixer', tuple(f'p-{i}' for i in range(11))),
                lambda: RunContext(Actor('a-0', 'agent'), RUN_A, 'fixer')):
        with pytest.raises(AgentMemoryError):
            bad()


# ── bounded scopes ─────────────────────────────────────────────────────────────

def test_a_scope_holds_a_bounded_number_of_live_memories(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(memory_store, 'MAX_PER_SCOPE', 2)
    first = learn(world, memory=lesson('First lesson of the repo.', subject='one'))
    learn(world, memory=lesson('Second lesson of the repo.', subject='two'))
    with pytest.raises(AgentMemoryConflict, match='forget some'):
        learn(world, memory=lesson('Third lesson of the repo.', subject='three'))
    world.store.forget_agent_memory(WS, REPO, first.memory.memory_id, by=ADMIN)
    assert learn(world, memory=lesson('Third lesson of the repo.', subject='three')).memory.status == PROPOSED


def test_forgotten_memories_count_towards_the_stored_cap(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(memory_store, 'MAX_STORED_PER_SCOPE', 2)
    for text, subject in (('First lesson of the repo.', 'one'), ('Second lesson of the repo.', 'two')):
        made = learn(world, memory=lesson(text, subject=subject))
        world.store.forget_agent_memory(WS, REPO, made.memory.memory_id, by=ADMIN)
    with pytest.raises(AgentMemoryConflict, match='forgotten ones included'):
        learn(world, memory=lesson('Third lesson of the repo.', subject='three'))


def test_a_persons_quota_is_per_connection(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(memory_store, 'MAX_PER_SCOPE', 1)
    learn(world, DANA_HERE, lesson('Dana wants the migration called out first.', subject='migrations',
                                   kind='preference'))
    with pytest.raises(AgentMemoryConflict, match='forget some'):
        learn(world, DANA_HERE, lesson('Dana wants screenshots for UI changes.', subject='screenshots',
                                       kind='preference'))
    there = learn(world, Scope('person', OTHER, person=DANA.id),
                  lesson('Dana wants screenshots for UI changes.', subject='screenshots', kind='preference'),
                  ctx=run(agent=STRANGER))
    assert there.memory.status == PROPOSED                      # another connection's quota
    own = write(world, DANA_OWN, mine(DANA), DANA)
    assert own.memory.status == ACTIVE   # and her own


# ── a racing write ─────────────────────────────────────────────────────────────

@dataclass
class Racing:
    """The table's client, with another writer's change landing between a store's read and its write."""

    client: Any
    race: Callable[[Any], None] | None = None

    def transact_write_items(self, **kwargs: Any) -> Any:
        if self.race is not None:
            race, self.race = self.race, None
            race(self.client)
        return self.client.transact_write_items(**kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.client, name)


def test_a_change_racing_another_is_refused_by_the_revision(world: World) -> None:
    memory_id = learned_and_approved(world)
    racing = Racing(world.client)
    store = replace(world.store, client=racing)
    key = {'pk': {'S': REPO.partition(WS)}, 'sk': {'S': f'MEM#{CONN}#{memory_id}'}}
    racing.race = lambda client: client.update_item(TableName=TABLE, Key=key, UpdateExpression='ADD revision :one',
                                                    ExpressionAttributeValues={':one': {'N': '1'}})
    with pytest.raises(AgentMemoryConflict, match='meanwhile'):
        store.forget_agent_memory(WS, REPO, memory_id, by=ADMIN)
    assert store.agent_memory_history(WS, REPO, memory_id, by=ADMIN)[0].status == APPROVED
    assert recalled(world) == [lesson().statement]
    assert [r['event']['S'] for r in scope_rows(world, REPO, 'LOG#')] == [APPROVED]
    assert store.forget_agent_memory(WS, REPO, memory_id, by=ADMIN).status == ARCHIVED   # read again, it lands


# ── erasure (D5) ───────────────────────────────────────────────────────────────

def _everything(world: World) -> list[dict[str, Any]]:
    return world.client.scan(TableName=TABLE)['Items']


def test_erasing_a_person_deletes_their_partition_and_deidentifies_them_elsewhere(world: World) -> None:
    write(world, DANA_OWN, mine(DANA), DANA)
    learned_and_approved(world, DANA_HERE, lesson('Dana wants the migration called out first.', subject='migrations',
                                                  kind='preference'))
    repo_id = learned_and_approved(world)
    world.store.confirm_agent_memory(WS, REPO, repo_id, by=DANA)                 # a CONF row naming her
    edit(world, REPO, repo_id, 1, DANA, 'Squash merges; Dana says release branches too.')   # VER author, prov
    role_draft = write(world, ROLE, lesson('Write the failing test first.', subject='tdd', kind='lesson',
                                           provenance=Provenance(person=DANA.id)), DANA).memory
    assert role_draft.status == PROPOSED
    with pytest.raises(AgentMemoryForbidden):
        world.store.erase_person_memories(WS, DANA.id, by=MEMBER, legal_basis='GDPR art. 17 request 42')
    with pytest.raises(AgentMemoryError, match='legal_basis'):
        world.store.erase_person_memories(WS, DANA.id, by=ADMIN, legal_basis=' ')
    erased = world.store.erase_person_memories(WS, DANA.id, by=ADMIN, legal_basis='GDPR art. 17 request 42')
    assert rows(world, DANA_OWN.partition(WS)) == []
    assert erased.partitions == 2                                   # the repository's and the role's
    assert erased.deidentified >= 3
    assert DANA.id not in repr(_everything(world))
    assert hashlib.sha256(f'person:{DANA.id}'.encode()).hexdigest()[:24] not in repr(_everything(world))
    [tombstone] = rows(world, TOMBSTONE_PK)
    assert (tombstone['sk']['S'], tombstone['legal_basis']['S'], tombstone['actor']['M']['sub']['S']) == (
        hashlib.sha256(DANA.id.encode()).hexdigest(), 'GDPR art. 17 request 42', ADMIN.id)
    [record] = rows(world, AUDIT_PK)
    assert (record['kind']['S'], record['reason']['S'], record['deleted_at']['S'],
            record['target']['M']['partitions']['S']) == (
        'agent_memory_person', 'GDPR art. 17 request 42', START.isoformat(), '2')
    history = world.store.agent_memory_history(WS, REPO, repo_id, by=ADMIN)
    alias = history[1].author
    assert alias.startswith('erased-')
    assert history[1].provenance.person == alias
    assert history[1].statement == 'Squash merges; Dana says release branches too.'   # the text is the memory's
    [role_version] = world.store.agent_memory_history(WS, ROLE, role_draft.memory_id, by=ADMIN)
    assert (role_version.author, role_version.provenance.person) == (alias, alias)   # one alias per erasure
    assert world.store.confirm_agent_memory(WS, REPO, repo_id, by=MEMBER).memory.confirmations == 2
    assert recalled(world) == [lesson().statement]     # her own and her learned memories are gone


def test_an_erased_person_is_never_remembered_again(world: World) -> None:
    write(world, DANA_OWN, mine(DANA), DANA)
    world.store.erase_person_memories(WS, DANA.id, by=ADMIN, legal_basis='GDPR art. 17 request 42')
    with pytest.raises(AgentMemoryForbidden, match='signed-in user'):
        learn(world, DANA_HERE, lesson('Dana wants the migration called out first.', subject='migrations',
                                       kind='preference'))
    with pytest.raises(AgentMemoryForbidden):
        write(world, DANA_OWN, mine(DANA), DANA)
    again = world.store.erase_person_memories(WS, DANA.id, by=ADMIN, legal_basis='GDPR art. 17 request 42')
    assert (again.deleted, again.partitions) == (0, 0)
    assert len(rows(world, TOMBSTONE_PK)) == 1
    assert len(rows(world, AUDIT_PK)) == 2


def test_an_erased_person_is_refused_in_every_scope_and_no_reference_comes_back(world: World) -> None:
    repo_id = learned_and_approved(world)
    role_id = learned_and_approved(world, ROLE, lesson('Run the package tests first.', subject='tests',
                                                       kind='lesson'))
    erased_admin = Actor(DANA.id, 'person', admin=True)   # still signed in (the directory is slow to follow)
    world.store.erase_person_memories(WS, DANA.id, by=ADMIN, legal_basis='GDPR art. 17 request 42')
    attempts: list[Callable[[], Any]] = [
        lambda: write(world, REPO, lesson('Dana adds a repository rule.', subject='rule',
                                          provenance=Provenance(person=DANA.id)), DANA),
        lambda: write(world, ROLE, lesson('Dana adds a fixer lesson.', subject='lesson', kind='lesson',
                                          provenance=Provenance(person=DANA.id)), DANA),
        lambda: world.store.confirm_agent_memory(WS, REPO, repo_id, by=DANA),
        lambda: world.store.confirm_agent_memory(WS, ROLE, role_id, by=DANA),
        lambda: edit(world, REPO, repo_id, 1, DANA, 'Dana edits the rule.'),
        lambda: world.store.forget_agent_memory(WS, ROLE, role_id, by=erased_admin),
    ]
    for attempt in attempts:
        with pytest.raises(AgentMemoryForbidden):
            attempt()
    assert rows(world, DANA_OWN.partition(WS)) == []
    assert [v.version for v in world.store.agent_memory_history(WS, REPO, repo_id, by=ADMIN)] == [1]
    assert world.store.confirm_agent_memory(WS, REPO, repo_id, by=MEMBER).counted   # everyone else carries on
