"""Learn (7.50.00): the learning loop as every flow's built-in last step, configured by the run's flow, reading the
failed attempt's transcript, its coach's calls counted in the run's spend within its budget share."""
from __future__ import annotations

import json
from dataclasses import replace
from decimal import Decimal
from typing import Any

import boto3
import pytest

from engineering.board.test.table import TABLE
from engineering.coach.failure import MAX_EVIDENCE, Evidence
from engineering.coach.model import CoachReply
from engineering.coach.proposer import Coach
from engineering.coach.test.fakes import FENCE, RecordedModel, answer, replying
from engineering.flow.settings import LearnSettings, learn_settings, memory_settings
from engineering.learning.budget import LEARN_AGENT, LearnBudget, MeteredCoachModel
from engineering.learning.loop import with_transcript
from engineering.learning.test.fixtures import CONN, RUN, WS, ended_run, price
from engineering.learning.test.test_loop import WHY, row, world
from engineering.learning.transcripts import excerpts, render
from engineering.runtime.runs import RunStore, meta_key
from engineering.skills.test.test_store import shared_v1

COMMIT = 'c' * 40


def _flow(start: dict[str, Any]) -> dict[str, Any]:
    return {'schema': 'voc-workflow/2', 'nodes': [{'id': 'start', 'type': 'start', 'data': {'params': start}}]}


def test_a_flows_start_step_sets_learn_and_the_recall_and_the_defaults_hold_without_one() -> None:
    assert learn_settings(None) == LearnSettings()
    assert memory_settings(None).recall is False   # (no recall unless the flow asks: A's default)
    learn = learn_settings(_flow({'learn': {'enabled': False, 'budget_share': 0.2, 'roles': ['fixer', 3],
                                            'model': 'global.anthropic.claude-sonnet-5-5',
                                            'after_needs_human_hours': 24}}))
    assert learn == LearnSettings(enabled=False, model='global.anthropic.claude-sonnet-5-5', budget_share=0.2,
                                  roles=('fixer',), after_needs_human_hours=24)
    # A value off its shape is its default: a run never stops for a setting it cannot read.
    odd = learn_settings(_flow({'learn': {'budget_share': 7, 'after_needs_human_hours': 0, 'enabled': 'no'}}))
    assert (odd.budget_share, odd.after_needs_human_hours, odd.enabled) == (0.05, 72, True)
    memory = memory_settings(_flow({'memory': {'recall': True, 'scopes': ['repo', 'person'], 'limit': 4}}))
    assert (memory.recall, memory.scopes, memory.limit) == (True, ('repository',), 4)


def test_learn_off_writes_nothing_and_asks_nothing() -> None:
    with ended_run() as (client, workspace):
        found = world(client, workspace, RecordedModel([]))
        loop = replace(found.loop, settings=lambda _run: LearnSettings(enabled=False))
        summary = loop.retrospective(WS, RUN)
        assert (summary.skipped, summary.scorecards_written, summary.to_coach) == (
            "Learn is off for this run's flow", 0, ())
        assert loop.learn_from(WS, RUN, 't-units#1#failed').skipped == "Learn is off for this run's flow"
        assert row(client, 'RETRO#coach') is None


def test_learn_takes_to_the_coach_only_its_flows_roles() -> None:
    with ended_run() as (client, workspace):
        found = world(client, workspace, RecordedModel([]))
        loop = replace(found.loop, settings=lambda _run: LearnSettings(roles=('builder',)))
        summary = loop.retrospective(WS, RUN)
        assert summary.to_coach == ('t-feature#1#crashed',)


def test_a_run_left_at_a_person_learns_when_the_sweep_takes_it() -> None:
    with ended_run(status='needs_human') as (client, workspace):
        found = world(client, workspace, RecordedModel([]))
        assert found.loop.retrospective(WS, RUN).skipped == 'the run has not ended'
        swept = found.loop.retrospective(WS, RUN, at_a_person=True)
        assert (swept.skipped, swept.scorecards_written) == ('', 5)


def test_the_coach_reads_the_failed_attempts_transcript_as_excerpts_within_the_evidences_bounds() -> None:
    with ended_run() as (client, workspace):
        found = world(client, workspace, replying(answer(why=WHY)))
        shared_v1(found.skills)
        seen: list[tuple[str, int]] = []

        def transcripts(run: Any, failure: Any) -> tuple[str, ...]:
            assert run.run_id == RUN
            seen.append((failure.attempt.agent, failure.attempt.attempt))
            return ('call run: {"argv": ["pytest"]}', 'run answered: exit code 1 (1 failed)')

        loop = replace(found.loop, transcripts=transcripts)
        assert loop.learn_from(WS, RUN, 't-slug#2#no_go').coach == 'proposed'
        [(_system, prompt)] = found.model.asked
        assert 'run answered: exit code 1 (1 failed)' in prompt
        assert seen
        assert seen[0][1] == 2
    base = Evidence(task='Fix the slug', outputs=('x' * 1000,))
    grown = with_transcript(base, [f'line {n} ' + 'y' * 3000 for n in range(20)])
    assert len(grown.conversation) == 8
    assert all(len(text) <= 1_500 for text in grown.conversation)
    assert grown.conversation[-1].startswith('line 19')
    full = Evidence(task='t', outputs=tuple('z' * 4_000 for _ in range(8)))
    fitted = with_transcript(full, ['w' * 1_400] * 8).conversation
    assert (len(fitted), sum(map(len, fitted)) <= MAX_EVIDENCE - 32_001) == (5, True)


def test_a_transcripts_events_become_short_lines_and_a_missing_one_none() -> None:
    prefix = f'ws/default/runs/{RUN}/fixer-1/commits/{COMMIT}/_transcripts/attempt-2/'
    events = [{'kind': 'tool_call', 'tool': 'run', 'input': {'argv': ['pytest', '-q']}},
              {'kind': 'tool_result', 'tool': 'run', 'text': 'exit code 1\x00 api_key = "sk12345678"', 'error': True},
              {'kind': 'model_call', 'tokens_in': 1}, {'kind': 'checkpoint', 'key': 'k'},
              {'kind': 'message', 'role': 'assistant', 'content': [{'text': 'I will fix it'},
                                                                   {'toolUse': {'name': 'write_file'}}]},
              {'kind': 'end', 'ending': 'done', 'schema': 'voc-transcript/1', 'at': 'x'}]
    objects = {f'{prefix}0001.jsonl': ''.join(json.dumps(event) + '\n' for event in events).encode() + b'not json\n'}
    lines = excerpts(lambda wanted: [key for key in objects if key.startswith(wanted)],
                     lambda key, _limit: objects.get(key), RUN, 'fixer-1', COMMIT, 2)
    assert lines[0] == 'call run: {"argv": ["pytest", "-q"]}'
    assert lines[1].startswith('run refused: exit code 1')
    assert 'sk12345678' not in lines[1]
    assert '\x00' not in lines[1]
    assert lines[2] == 'the agent said: I will fix it [asks for write_file]'
    assert lines[3] == 'end: {"ending": "done", "kind": "end"}'
    assert len(lines) == 4
    assert excerpts(lambda _p: [], lambda _k, _l: None, RUN, 'fixer-1', '', 2) == ()
    assert render({'kind': 'message', 'role': 'user', 'content': []}) == ''


def test_learns_calls_count_in_the_runs_spend_within_its_share_of_the_cost_cap() -> None:
    with ended_run() as (client, _workspace):
        table = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)
        runs = RunStore(table)
        table.update_item(Key=meta_key(RUN), UpdateExpression='SET max_cost_usd = :cap, started_epoch = :at, '
                          'max_tasks = :tasks, flow = :flow',
                          ExpressionAttributeValues={':cap': Decimal('10'), ':at': 1_763_300_000, ':tasks': 10,
                                                     ':flow': '01JD3R4NZXQ7Y2W8K4M6P9FLOW'})
        budget = LearnBudget(table, runs, price)
        # The worst case: 40,000 in and 8,000 out = $0.16, within 5% of $10.
        assert budget.allows(RUN, 0.05, 'model-a') == ''
        assert budget.record(RUN, 'model-a', 10_000, 2_000) == Decimal('0.04')
        assert budget.spent(RUN) == Decimal('0.04')
        assert runs.spend(RUN)[1] == pytest.approx(0.04 + _agents_cost(runs))
        # $0.04 spent and $0.16 more at worst: past 1% of $10.
        assert 'learn budget' in budget.allows(RUN, 0.01, 'model-a')
        # The ledger has the dollars, under the agent "learn".
        month = client.query(TableName=TABLE, KeyConditionExpression='pk = :pk',
                             ExpressionAttributeValues={':pk': {'S': 'WS#default#SPEND#2026-11'}}).get('Items', [])
        learn_rows = [item for item in month if item.get('agent_id', {}).get('S') == LEARN_AGENT]
        assert len(learn_rows) <= 1   # (booked to the clock's month: 2026-11 here, or the real one)
        recorded: list[CoachReply] = []
        metered = MeteredCoachModel(lambda _s, _p: CoachReply('{}', 'model-a', 5, 6), recorded.append)
        assert metered('system', 'prompt').tokens_out == 6
        assert [reply.tokens_in for reply in recorded] == [5]


def _agents_cost(runs: RunStore) -> float:
    query = {'KeyConditionExpression': 'pk = :run AND begins_with(sk, :agent)', 'ConsistentRead': True,
             'ExpressionAttributeValues': {':run': f'WS#default#RUN#{RUN}', ':agent': 'AGENT#'}}
    return sum(float(item.get('cost_usd', 0)) for item in runs.table.query(**query).get('Items', []))


def test_a_coach_held_by_learns_budget_is_an_outcome_and_asks_nothing() -> None:
    with ended_run() as (client, workspace):
        found = world(client, workspace, RecordedModel([]))
        shared_v1(found.skills)

        class Spent:
            def allows(self, run_id: str, share: float, model: str) -> str:
                del run_id, share, model
                return 'learn budget: nothing left'

        made: list[str] = []

        def coach_for(run_id: str, settings: LearnSettings) -> Coach:
            del settings
            made.append(run_id)
            return Coach(found.skills, found.model, fence=lambda: FENCE)

        loop = replace(found.loop, budget=Spent(), coach_for=coach_for)
        learned = loop.learn_from(WS, RUN, 't-slug#2#no_go')
        assert (learned.coach, learned.lesson, made, found.model.asked) == (
            'learn budget: nothing left', 'drafted', [], [])
        assert CONN
