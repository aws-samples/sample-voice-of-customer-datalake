"""The learning loop on moto: an ended run's scorecards written once, each failure it chose taken to the coach (a
recorded model) at most once, and a lesson drafted in agent memory with its provenance."""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any

import pytest
from botocore.exceptions import ClientError, ReadTimeoutError

from engineering.agent_memory.model import AgentMemoryError, Scope
from engineering.agent_memory.store import DRAFT, PROPOSED, AgentMemoryStore
from engineering.board.model import Move
from engineering.board.test.table import TABLE
from engineering.coach.model import READ_TIMEOUT_SECONDS
from engineering.coach.proposer import Coach
from engineering.coach.test.fakes import CASES, FENCE, RecordedModel, answer, replying
from engineering.knowledge.store import Actor
from engineering.learning.loop import COACH_FAILED, COACH_TIMED_OUT, RULE_LESSONS, LearningLoop
from engineering.learning.records import RunRecordReader
from engineering.learning.retrospective import build_retrospective
from engineering.learning.scorecard import ScorecardStore, score_pk
from engineering.learning.test.fixtures import CONN, RUN, WS, ended_run, meta, task_item
from engineering.skills.store import SkillStore
from engineering.skills.test.test_store import shared_v1

AT = datetime(2026, 11, 13, 9, 30, tzinfo=UTC)
ADMIN = Actor('admin-sub-1', 'person', admin=True)
WHY = 'The fix passed its own test but broke the suite; the agent now runs the whole suite first.'


@dataclass
class World:
    client: Any
    loop: LearningLoop
    model: RecordedModel
    skills: SkillStore
    memory: AgentMemoryStore


def world(client: Any, workspace: Any, model: RecordedModel, cases: tuple[str, ...] = CASES) -> World:
    skills = SkillStore(client, TABLE, now=lambda: AT)
    memory = AgentMemoryStore(client, TABLE, is_user=lambda _user: False, now=lambda: AT)
    loop = LearningLoop(reader=RunRecordReader(client, TABLE, workspace),
                        scorecards=ScorecardStore(client, TABLE, now=lambda: AT), memory=memory,
                        coach=lambda: Coach(skills, model, fence=lambda: FENCE), cases=cases, now=lambda: AT)
    return World(client, loop, model, skills, memory)


@pytest.fixture
def ended() -> Iterator[World]:
    """The fictional ended run, the shared Fixer skill accepted, and a coach whose model has no reply yet."""
    with ended_run() as (client, workspace):
        found = world(client, workspace, RecordedModel([]))
        shared_v1(found.skills)
        yield found


def row(client: Any, sk: str) -> dict[str, Any] | None:
    return client.get_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WS}#RUN#{RUN}'}, 'sk': {'S': sk}}).get('Item')


def drafts(found: World, role: str) -> list[Any]:
    return found.memory.pending_agent_memories(WS, Scope('role', CONN, role), by=ADMIN)


def test_the_retrospective_writes_each_versions_scorecard_once_and_names_the_failures(ended: World) -> None:
    summary = ended.loop.retrospective(WS, RUN)
    assert (summary.scorecards_written, summary.scorecards_kept, summary.failure_count) == (5, 0, 4)
    assert summary.to_coach == ('t-slug#2#no_go', 't-units#1#failed', 't-feature#1#crashed')
    card = ended.loop.scorecards.version_card(WS, CONN, 'fixer', 'fixer@1')
    assert (card.runs, card.tasks_done, card.reposts, card.review_rounds) == (1, 1, 1, 3)
    again = ended.loop.retrospective(WS, RUN)
    assert (again.scorecards_written, again.scorecards_kept) == (0, 5)
    assert ended.model.asked == []   # no model call in the retrospective itself


def claimed_and_failed(task_id: str, agent: str) -> list[dict[str, Any]]:
    """A task's claim and failed move, as history rows."""
    return [Move(task_id, state, agent, f'2026-11-13T08:5{n}:00+00:00', 1, op).item(WS, RUN)
            for n, (state, op) in enumerate((('claimed', 'claim'), ('failed', 'move')))]


def test_a_failure_goes_to_the_coach_once_and_leaves_one_lesson_made_by_rule(ended: World) -> None:
    ended.model.replies.append(replying(answer(why=WHY)).replies[0])
    learned = ended.loop.learn_from(WS, RUN, 't-slug#2#no_go')
    assert (learned.coach, learned.proposed_version, learned.lesson) == ('proposed', 1, 'drafted')
    assert learned.announcement is not None
    assert learned.announcement['source'].endswith(f'/coach/{WS}/{RUN}')
    [(system, prompt)] = ended.model.asked
    assert 'The suite was not run on the whole package.' in prompt
    assert system
    # The coach's why is the version's reason, never a memory of its own.
    version = ended.skills.version(WS, CONN, 'fixer', 1)
    assert (version.reason.run_id, version.reason.failure, version.proposed_by) == (RUN, 'no_go', f'coach-{RUN}')
    assert version.reason.comment == WHY
    [(memory, draft)] = drafts(ended, 'fixer')
    assert (memory.status, memory.subject, memory.kind, draft.status) == (PROPOSED, 'fixer no go', 'lesson', DRAFT)
    assert draft.statement == RULE_LESSONS['no_go'].format(role='fixer')
    assert (draft.provenance.run_id, draft.provenance.task_id, draft.author) == (RUN, 't-slug', f'coach-{RUN}')
    claim, outcome = row(ended.client, 'LEARN#t-slug#2#no_go'), row(ended.client, 'LEARNED#t-slug#2#no_go')
    assert claim is not None
    assert (claim['by']['S'], claim['at']['S']) == ('retrospective', AT.isoformat())
    assert outcome is not None
    assert (outcome['proposed_version']['N'], outcome['memory_id']['S']) == ('1', memory.memory_id)


def test_a_duplicate_delivery_writes_nothing_and_asks_nothing(ended: World, monkeypatch: pytest.MonkeyPatch) -> None:
    ended.model.replies.append(replying(answer(why=WHY)).replies[0])
    ended.loop.learn_from(WS, RUN, 't-slug#2#no_go')
    learns: list[str] = []
    monkeypatch.setattr(AgentMemoryStore, 'learn_agent_memory', lambda *_a, **_k: learns.append('learn'))
    again = ended.loop.learn_from(WS, RUN, 't-slug#2#no_go')
    assert (again.skipped, again.memory_id, again.lesson) == ('this failure was taken to the coach already', '', '')
    assert (learns, len(ended.model.asked)) == ([], 1)


def test_the_failures_to_coach_are_chosen_once_per_run(ended: World) -> None:
    first = ended.loop.retrospective(WS, RUN).to_coach
    stored = row(ended.client, 'RETRO#coach')
    assert stored is not None
    assert [value['S'] for value in stored['keys']['L']] == list(first)
    # The board read differently later (here: a newer, more severe failure): the run keeps its first choice.
    ended.client.put_item(TableName=TABLE, Item=task_item('t-new', 'pr-author', 'failed', priority=99))
    for item in claimed_and_failed('t-new', 'pr-author-9'):
        ended.client.put_item(TableName=TABLE, Item=item)
    record = ended.loop.reader.read(WS, RUN)
    assert record is not None
    assert 't-new#1#failed' in [failure.key for failure in build_retrospective(record).to_coach]
    assert ended.loop.retrospective(WS, RUN).to_coach == first
    assert ended.loop.learn_from(WS, RUN, 't-new#1#failed').skipped.startswith('not a failure')


def test_a_role_with_no_skill_still_gets_a_lesson_made_by_rule(ended: World) -> None:
    learned = ended.loop.learn_from(WS, RUN, 't-feature#1#crashed')
    assert 'no skill yet' in learned.coach
    assert learned.proposed_version == 0
    assert ended.model.asked == []
    [(_memory, draft)] = drafts(ended, 'builder')
    assert draft.statement == RULE_LESSONS['crashed'].format(role='builder')
    assert draft.provenance.task_id == 't-feature'


def test_the_same_rule_lesson_from_another_run_confirms_it() -> None:
    other = '01JD0000000000000000000001'
    with ended_run() as (client, workspace):
        found = world(client, workspace, RecordedModel([]), cases=())
        found.loop.learn_from(WS, RUN, 't-feature#1#crashed')
        # The same board under another run id (its rows copied).
        for item in client.scan(TableName=TABLE)['Items']:
            if item['pk']['S'] == f'WS#{WS}#RUN#{RUN}' and not item['sk']['S'].startswith('LEARN'):
                client.put_item(TableName=TABLE, Item={**item, 'pk': {'S': f'WS#{WS}#RUN#{other}'}})
        client.put_item(TableName=TABLE, Item=meta(run_id=other))
        learned = found.loop.learn_from(WS, other, 't-feature#1#crashed')
        [(memory, _draft)] = drafts(found, 'builder')
    assert (learned.lesson, memory.confirmations) == ('confirmed', 1)


def test_with_no_benchmark_cases_the_coach_is_not_asked(ended: World) -> None:
    loop = replace(ended.loop, cases=())
    learned = loop.learn_from(WS, RUN, 't-units#1#failed')
    assert learned.coach.startswith('no benchmark cases')
    assert learned.lesson == 'drafted'
    assert ended.model.asked == []


def test_a_coach_that_fails_still_leaves_the_rule_lesson_and_its_claim(ended: World) -> None:
    def broken() -> Coach:
        raise RuntimeError('the model could not be reached')

    learned = replace(ended.loop, coach=broken).learn_from(WS, RUN, 't-units#1#failed')
    assert learned.coach.startswith(f'{COACH_FAILED}: ')
    assert learned.lesson == 'drafted'
    assert row(ended.client, 'LEARN#t-units#1#failed') is not None
    outcome = row(ended.client, 'LEARNED#t-units#1#failed')
    assert outcome is not None
    assert outcome['coach']['S'].startswith(f'{COACH_FAILED}: ')


def test_a_coachs_call_past_its_read_timeout_is_recorded_as_timed_out_and_not_made_again(ended: World) -> None:
    calls: list[str] = []

    def slow(_system: str, prompt: str) -> Any:
        calls.append(prompt)
        raise ReadTimeoutError(endpoint_url='https://bedrock-runtime.us-east-1.amazonaws.com')

    loop = replace(ended.loop, coach=lambda: Coach(ended.skills, slow, fence=lambda: FENCE))
    learned = loop.learn_from(WS, RUN, 't-slug#2#no_go')
    assert learned.coach.startswith(f'{COACH_TIMED_OUT}: the call ran past {READ_TIMEOUT_SECONDS} s')
    assert (learned.proposed_version, learned.lesson) == (0, 'drafted')   # the rule's lesson stays
    outcome = row(ended.client, 'LEARNED#t-slug#2#no_go')
    assert outcome is not None
    assert outcome['coach']['S'].startswith(f'{COACH_TIMED_OUT}: ')
    assert loop.learn_from(WS, RUN, 't-slug#2#no_go').skipped == 'this failure was taken to the coach already'
    assert len(calls) == 1


def test_an_invocation_cut_off_in_the_coachs_call_has_left_the_rules_lesson(ended: World) -> None:
    """A time-out kills the invocation mid-call (here: an error no handler catches, as a kill would)."""
    class CutOff(BaseException):
        pass

    def killed() -> Coach:
        raise CutOff

    with pytest.raises(CutOff):
        replace(ended.loop, coach=killed).learn_from(WS, RUN, 't-units#1#failed')
    assert [draft.statement for _, draft in drafts(ended, 'fixer')] == [RULE_LESSONS['failed'].format(role='fixer')]
    assert row(ended.client, 'LEARN#t-units#1#failed') is not None
    assert ended.loop.learn_from(WS, RUN, 't-units#1#failed').skipped == 'this failure was taken to the coach already'


def test_a_memory_store_that_fails_is_an_outcome_not_an_error(ended: World, monkeypatch: pytest.MonkeyPatch) -> None:
    def throttled(*_args: Any, **_kwargs: Any) -> Any:
        raise ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'slow down'}}, 'TransactWriteItems')

    monkeypatch.setattr(AgentMemoryStore, 'learn_agent_memory', throttled)
    learned = replace(ended.loop, cases=()).learn_from(WS, RUN, 't-units#1#failed')
    assert learned.lesson == 'not kept: the memory store failed (see the log)'
    assert row(ended.client, 'LEARNED#t-units#1#failed') is not None


def test_no_lesson_when_every_statement_is_refused(ended: World, monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise AgentMemoryError('this scope holds 200 memories already')

    monkeypatch.setattr(AgentMemoryStore, 'learn_agent_memory', refuse)
    learned = replace(ended.loop, cases=()).learn_from(WS, RUN, 't-units#1#failed')
    assert learned.lesson == 'not kept: this scope holds 200 memories already'
    outcome = row(ended.client, 'LEARNED#t-units#1#failed')
    assert outcome is not None
    assert outcome['memory_id']['S'] == ''


def test_only_a_failure_the_retrospective_chose_is_learned_from(ended: World) -> None:
    # The fixer's time-out was past the bound; a made-up key is nothing.
    for key in ('t-slug#1#timed_out', 'anything'):
        assert ended.loop.learn_from(WS, RUN, key).skipped.startswith('not a failure')
        assert row(ended.client, f'LEARN#{key}') is None


@pytest.mark.parametrize(('status', 'connection', 'skipped'), [
    ('active', CONN, 'the run has not ended'),
    ('done', '', 'the run has no connection (it launched no agent)'),
])
def test_a_run_still_live_or_with_no_connection_is_left_alone(status: str, connection: str, skipped: str) -> None:
    with ended_run(status=status, connection=connection) as (client, workspace):
        found = world(client, workspace, RecordedModel([]))
        summary = found.loop.retrospective(WS, RUN)
        assert (summary.skipped, summary.scorecards_written, summary.to_coach) == (skipped, 0, ())
        assert found.loop.learn_from(WS, RUN, 't-units#1#failed').skipped == skipped
        assert client.get_item(TableName=TABLE, Key={'pk': {'S': score_pk(WS, CONN, 'fixer', 'fixer@1')},
                                                     'sk': {'S': f'RUN#{RUN}'}}).get('Item') is None


def test_an_unknown_run(ended: World) -> None:
    missing = '01JD0000000000000000000099'
    assert ended.loop.retrospective(WS, missing).skipped == 'no such run'
    assert ended.loop.learn_from(WS, missing, 't-units#1#failed').skipped == 'no such run'
