"""A run that needs a human: the payload it stops with, and how a decision resumes it.

The whole loop runs for real: conductor → nodes → panel on the moto table, the
human's decision through ``shared.agent_run_resume`` (the code the API route
calls), then a second ``drive`` plays the new execution.
"""
from __future__ import annotations

from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest

from agents import store
from agents.conductor import handler as conductor
from agents.test.conftest import AGENT_ID, RUN_ID, drive, partition, run_row, seed_agent, seed_run
from shared import agent_run_resume, agents_store
from shared.workflow_schema import default_template, encode_definition, validate_definition


@pytest.fixture
def seeded(runtime_env):
    agents_table, _ = runtime_env
    seed_agent(agents_table)
    seed_run(agents_table)
    return agents_table


@pytest.fixture
def budget_stopped(runtime_env, model):
    """A run that stopped for a human after its two-call budget; the agents table."""
    agents_table, _ = runtime_env
    seed_agent(agents_table, budget={'max_model_calls_per_run': 2})
    seed_run(agents_table)
    assert drive(model)['status'] == 'needs_human'
    return agents_table


@pytest.fixture
def executions() -> Iterator[MagicMock]:
    with patch.object(agents_store, 'start_execution', return_value='arn:aws:states:x:execution:m:r') as start:
        yield start


def _decide(table, decision: str, note: str | None = None) -> dict:
    """What POST …/decision does for accept / another_round."""
    agent = agents_store.get_agent(table, AGENT_ID)
    run = agents_store.get_run(table, AGENT_ID, RUN_ID)
    assert agent is not None
    assert run is not None
    now = agents_store.utc_now()
    record = agent_run_resume.decision_record(decision, note, username='alice', sub='admin-sub', now=now)
    return agent_run_resume.resume_run(table, agent, run, record, now=now)


def _started(table, after_seq: int = 0) -> list[str]:
    return [e['node_id'] for e in partition(table, 'EVT#') if e['kind'] == 'node_started' and e['seq'] > after_seq]


def _last_seq(table) -> int:
    return int(partition(table, 'EVT#')[-1]['seq'])


class TestThePayload:
    def test_an_exhausted_loop_names_the_gate_its_loop_and_the_verdicts(self, seeded, model):
        model.persona_scores = [2]

        assert drive(model)['status'] == 'needs_human'

        needs = store.plain(run_row(seeded)['needs_human'])
        assert {k: needs[k] for k in ('reason', 'node_id', 'node_title', 'loop_index', 'max_rounds')} == {
            'reason': 'loop_exhausted', 'node_id': 'prfaq_review', 'node_title': 'Persona review of the PR/FAQ',
            'loop_index': 0, 'max_rounds': 3}
        assert needs['verdicts']
        assert needs['verdicts'][0]['objections'] == ['Too many steps']
        assert needs['verdicts'][0]['blocking'] is False
        view = agents_store.run_view(run_row(seeded))
        assert view['actions'] == ['accept', 'another_round', 'stop']
        assert view['decision'] is None

    def test_a_needs_human_end_step_can_only_be_closed(self, seeded, model):
        model.final_pass = False

        assert drive(model)['status'] == 'needs_human'

        assert store.plain(run_row(seeded)['needs_human']) == {
            'reason': 'end_node', 'node_id': 'needs_human', 'node_title': 'Needs a human'}
        assert agents_store.run_view(run_row(seeded))['actions'] == ['stop']

    def test_a_spent_budget_names_the_step(self, budget_stopped):
        needs = store.plain(run_row(budget_stopped)['needs_human'])
        assert isinstance(needs, dict)
        assert needs['reason'] == 'budget'
        assert 'verdicts' not in needs
        assert agents_store.run_view(run_row(budget_stopped))['actions'] == ['stop']

    def test_a_failed_verification_says_so(self, seeded, world, model):
        world.lie_about_document = True

        assert drive(model)['status'] == 'needs_human'
        assert run_row(seeded)['needs_human']['reason'] == 'verification'


class TestAccept:
    @pytest.mark.usefixtures('executions')
    def test_the_run_continues_after_the_agreed_arrow_without_counting_a_round(self, seeded, model):
        model.persona_scores = [2, 2, 2, 5]  # the PR/FAQ loop exhausts; the prototype review then agrees
        assert drive(model)['status'] == 'needs_human'
        before = _last_seq(seeded)

        _decide(seeded, 'accept')
        assert drive(model) == {'kind': 'finish', 'status': 'completed'}

        assert _started(seeded, before)[0] == 'prototype'
        run = run_row(seeded)
        assert 'resume' not in run
        assert 'needs_human' not in run
        assert run['decision']['decision'] == 'accept'
        # Unchanged by the resume: the exhausting round stopped the run before it was stored.
        assert store.plain(run['loop_rounds'])['0'] == 2
        summaries = [e['summary'] for e in partition(seeded, 'EVT#')]
        assert 'Run resumed (accept), workflow revision 1.' in summaries
        assert agents_store.run_view(run)['actions'] == []

    def test_the_execution_is_named_after_the_resume(self, seeded, model, executions):
        model.persona_scores = [2]
        drive(model)

        resumed = _decide(seeded, 'accept')

        assert executions.call_args.kwargs['name'] == f'{RUN_ID}-r1'
        assert resumed['execution_arn'] == 'arn:aws:states:x:execution:m:r'
        assert resumed['status'] == 'queued'
        assert int(resumed['resume_count']) == 1
        agent = agents_store.get_agent(seeded, AGENT_ID)
        assert agent is not None
        assert agent['active_run_id'] == RUN_ID


class TestAnotherRound:
    @pytest.mark.usefixtures('executions')
    def test_exactly_one_more_round_runs_then_it_needs_a_human_again(self, seeded, model):
        model.persona_scores = [2]
        assert drive(model)['status'] == 'needs_human'
        before = _last_seq(seeded)

        _decide(seeded, 'another_round', 'Cut the checkout to one screen.')
        assert drive(model)['status'] == 'needs_human'

        assert _started(seeded, before) == ['prfaq_revise', 'prfaq_review']
        run = run_row(seeded)
        assert run['needs_human']['reason'] == 'loop_exhausted'
        assert 'decision' not in run  # a new stop: the human decides again
        assert agents_store.run_view(run)['actions'] == ['accept', 'another_round', 'stop']
        assert 'human_note' not in run['context']

    @pytest.mark.usefixtures('executions')
    def test_the_note_reaches_the_next_revision_brief_once(self, seeded, model):
        model.persona_scores = [2]
        drive(model)

        _decide(seeded, 'another_round', 'Cut the checkout to one screen.')
        drive(model)

        briefs = [m['text'] for m in partition(seeded, 'MATE#')
                  if m['direction'] == 'to_mate' and m['node_id'] == 'prfaq_revise']
        assert [('Note from a human: Cut the checkout to one screen.' in text) for text in briefs] == [
            False, False, True]


class TestCeilings:
    def test_a_resumed_run_gets_a_fresh_budget(self, budget_stopped):
        budget_stopped.update_item(  # the budget stop offers only stop; the ceiling is what a resume sets
            Key={'pk': f'AGENT#{AGENT_ID}', 'sk': f'RUN#{RUN_ID}'},
            UpdateExpression='SET #s = :r, call_ceiling = :c', ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':r': 'running', ':c': 4})

        agent = store.get_agent(AGENT_ID)
        assert agent is not None
        assert store.reserve_model_call(agent, RUN_ID, 2) == 3
        assert store.reserve_model_call(agent, RUN_ID, 2) == 4
        with pytest.raises(store.BudgetExhausted):
            store.reserve_model_call(agent, RUN_ID, 2)

    def test_without_a_ceiling_the_agent_budget_applies(self, seeded):
        seeded.update_item(Key={'pk': f'AGENT#{AGENT_ID}', 'sk': f'RUN#{RUN_ID}'},
                           UpdateExpression='SET #s = :r, model_calls = :m', ExpressionAttributeNames={'#s': 'status'},
                           ExpressionAttributeValues={':r': 'running', ':m': 1})
        agent = store.get_agent(AGENT_ID)
        assert agent is not None
        assert store.reserve_model_call(agent, RUN_ID, 2) == 2
        with pytest.raises(store.BudgetExhausted):
            store.reserve_model_call(agent, RUN_ID, 2)

    def test_the_step_ceiling_replaces_max_steps(self):
        agent = {'agent_id': AGENT_ID}
        node = conductor.WorkflowGraph(default_template()).node('aggregate')
        with patch.object(store, 'append_mate', return_value=1), patch.object(store, 'update_running'), \
                patch.object(store, 'append_event'):
            run = {'run_id': RUN_ID, 'steps': 130, 'step_ceiling': 240}
            assert conductor._dispatch(agent, run, node, {}, {})['kind'] == 'execute'
            with pytest.raises(conductor._Finish, match=r'^Stopped after 240 steps\.$'):
                conductor._dispatch(agent, {**run, 'steps': 240}, node, {}, {})


class TestStoredWorkflowsKeepRunning:
    def test_a_stored_loop_the_new_rules_refuse_still_runs(self, runtime_env, model):
        definition = default_template()
        for edge in definition['edges']:
            if (edge['source'], edge['target']) == ('prfaq_review', 'prfaq_revise'):
                del edge['label']  # an unlabelled arrow back: refused on save since 3.x, never at run time
        assert not validate_definition(definition).valid
        agents_table, _ = runtime_env
        agents_table.put_item(Item={'pk': 'WORKFLOW#wf_legacy', 'sk': 'CURRENT', 'revision': 2})
        agents_table.put_item(Item={'pk': 'WORKFLOW#wf_legacy', 'sk': 'REV#000002',
                                    'definition': encode_definition(definition)})
        seed_agent(agents_table, workflow_id='wf_legacy')
        seed_run(agents_table)
        model.persona_scores = [2, 5, 5]

        assert drive(model)['status'] == 'completed'
        # The unlabelled arrow back is the default path on 'not_agreed': the revision ran.
        assert 'prfaq_revise' in _started(agents_table)
