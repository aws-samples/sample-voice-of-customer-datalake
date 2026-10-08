"""End-to-end runs of the default workflow through conductor → nodes → panel."""
from __future__ import annotations

import pytest

from agents import store
from agents.test.conftest import (
    AGENT_ID,
    OWNER,
    RUN_ID,
    drive,
    partition,
    run_row,
    seed_agent,
    seed_run,
)
from shared import project_access
from shared.workflow_schema import encode_definition


def _agent_row() -> dict:
    """The seeded agent's row, which must exist."""
    agent = store.get_agent(AGENT_ID)
    assert agent is not None
    return agent


def _events(table) -> list[dict]:
    return partition(table, 'EVT#')


def _kinds(table) -> list[str]:
    return [e['kind'] for e in _events(table)]


def _start_then_fail(error: dict) -> None:
    """Init the run, then deliver the state machine's catch-all ``fail``."""
    from agents.conductor import handler as conductor
    ids = {'agent_id': AGENT_ID, 'run_id': RUN_ID}
    conductor.handle({'action': 'init', **ids})
    conductor.handle({'action': 'fail', **ids, 'error': error})


@pytest.fixture
def seeded(runtime_env):
    agents_table, aggregates = runtime_env
    seed_agent(agents_table)
    seed_run(agents_table)
    aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': [
        {'name': 'checkout', 'owners': [{'sub': 'po-sub', 'username': 'paula', 'email': 'p@x'},
                                        {'sub': 'po2-sub', 'username': 'pete', 'email': 'q@x'}]},
    ]})
    return agents_table


class TestHappyPath:
    def test_reviews_to_prototype_with_one_revision_round(self, seeded, world, model):
        model.persona_scores = [2, 5, 5]  # PR/FAQ round 1 disagrees, round 2 agrees; prototype agrees

        assert drive(model) == {'kind': 'finish', 'status': 'completed'}

        run = run_row(seeded)
        assert run['status'] == 'completed'
        assert 'gsi1pk' not in run
        context = run['context']
        assert set(context['documents']) == {'research', 'prfaq', 'prototype'}
        assert run['project_id'] == context['project_id']
        # The PR/FAQ was revised once: two PRFAQ documents in the project.
        project = world.projects[context['project_id']]
        assert sum(d['document_type'] == 'prfaq' for d in project['documents']) == 2
        assert {'node_started', 'node_finished', 'verdict', 'artifact', 'decision'} <= set(_kinds(seeded))
        assert int(run['model_calls']) == len(model.calls)

    @pytest.mark.usefixtures('seeded')
    def test_project_is_created_for_the_first_category_owner_as_the_agent(self, world, model):
        drive(model)

        project = next(iter(world.projects.values()))
        claims = project['claims']
        assert claims['sub'] == f'agent:{AGENT_ID}'
        assert claims['cognito:groups'] == ''
        assert claims[project_access.ACTING_SUBJECT_CLAIM] == OWNER
        assert claims[project_access.AGENT_OWNER_CLAIM] == 'po-sub'
        assert claims[project_access.AGENT_EDITORS_CLAIM] == 'po2-sub'
        assert project['meta']['visibility'] == 'private'

    @pytest.mark.usefixtures('seeded')
    def test_every_call_is_the_agent_principal_and_never_admin(self, world, model):
        drive(model)

        assert world.calls
        for _function, _method, _path, claims in world.calls:
            assert claims['sub'] == f'agent:{AGENT_ID}'
            assert claims['cognito:groups'] == ''
            assert claims[project_access.ACTING_SUBJECT_CLAIM] == OWNER

    def test_crewmates_only_hear_from_the_conductor(self, seeded, model):
        model.persona_scores = [2, 5, 5]
        drive(model)

        mates = partition(seeded, 'MATE#')
        to_mates = [m for m in mates if m['direction'] == 'to_mate']
        assert to_mates
        assert all(m['text'].startswith('[sent by conductor]') for m in to_mates)
        revise = next(m for m in to_mates if m['node_id'] == 'prfaq_revise')
        assert 'Revision brief' in revise['text']
        assert 'Remove a step' in revise['text']
        assert any(m['direction'] == 'from_mate' for m in mates)

    @pytest.mark.usefixtures('seeded')
    def test_role_surfaces_are_used(self, model):
        drive(model)

        surfaces = {c['step']: c['surface'] for c in model.calls}
        assert surfaces['agent_aggregate_reviews'] == 'agent_worker'
        assert surfaces['agent_decide_project'] == 'agent_orchestrator'
        assert surfaces['agent_persona_review'] == 'agent_persona'
        assert surfaces['agent_final_review'] == 'agent_reviewer'
        assert all(c['model_id'] is None for c in model.calls)

    @pytest.mark.usefixtures('seeded')
    def test_reviews_memories_and_artifacts_are_data_not_system(self, model):
        drive(model)

        aggregate = next(c for c in model.calls if c['step'] == 'agent_aggregate_reviews')
        assert '<reviews>' in aggregate['prompt']
        assert 'Checkout took forever' in aggregate['prompt']
        assert '<memory>' in aggregate['prompt']
        assert 'Checkout took forever' not in aggregate['system']
        persona = next(c for c in model.calls if c['step'] == 'agent_persona_review')
        assert '<artifact>' in persona['prompt']
        assert '# prfaq content' not in persona['system']

    @pytest.mark.usefixtures('seeded')
    def test_the_prototype_review_sees_visible_text_not_scripts(self, model):
        drive(model)

        prototype_review = [c for c in model.calls
                            if c['step'] == 'agent_persona_review' and 'PROTOTYPE:' in c['prompt']]
        assert prototype_review
        assert 'One-tap checkout' in prototype_review[0]['prompt']
        assert 'secret()' not in prototype_review[0]['prompt']


class TestEscalations:
    def test_no_agreement_after_max_rounds_needs_a_human(self, seeded, model):
        model.persona_scores = [2]

        assert drive(model)['status'] == 'needs_human'

        run = run_row(seeded)
        assert 'no agreement after 3' in run['error']
        assert sum(1 for e in _events(seeded) if e['kind'] == 'decision' and 'failed; revising' in e['summary']) == 2

    @pytest.mark.usefixtures('seeded')
    def test_a_blocking_objection_prevents_agreement(self, model):
        model.persona_scores, model.persona_blocking = [5], True

        assert drive(model)['status'] == 'needs_human'

    def test_a_failed_final_review_takes_the_needs_human_end(self, seeded, model):
        model.final_pass = False

        assert drive(model)['status'] == 'needs_human'
        assert 'asks for a human' in run_row(seeded)['error']

    def test_the_budget_stops_the_run(self, runtime_env, model):
        agents_table, _ = runtime_env
        seed_agent(agents_table, budget={'max_model_calls_per_run': 2})
        seed_run(agents_table)

        assert drive(model)['status'] == 'needs_human'
        run = run_row(agents_table)
        assert int(run['model_calls']) == 2
        assert 'budget' in run['error']
        # The month counter the heartbeat's cap and the agents list read.
        assert int(_agent_row()['month_calls']) == 2

    def test_an_unverifiable_claim_needs_a_human(self, seeded, world, model):
        world.lie_about_document = True

        assert drive(model)['status'] == 'needs_human'
        failures = [e for e in _events(seeded) if e['kind'] == 'node_failed']
        assert failures
        assert failures[0]['summary'].startswith('Verification failed')

    @pytest.mark.usefixtures('seeded')
    def test_no_reviews_completes_without_work(self, world, model):
        world.feedback = []

        assert drive(model)['status'] == 'completed'
        assert world.projects == {}
        assert model.calls == []


class TestLifecycle:
    def test_cancel_mid_run_stops_without_overwriting(self, seeded, world):
        from agents.conductor import handler as conductor
        from agents.nodes import handler as nodes

        ids = {'agent_id': AGENT_ID, 'run_id': RUN_ID}
        step = conductor.handle({'action': 'init', **ids})
        result = nodes.execute({'action': 'start', **ids, 'node_id': step['node_id'], 'mate_seq': step['mate_seq']})
        seeded.update_item(Key={'pk': f'AGENT#{AGENT_ID}', 'sk': f'RUN#{RUN_ID}'},
                           UpdateExpression='SET #s = :c', ExpressionAttributeNames={'#s': 'status'},
                           ExpressionAttributeValues={':c': 'cancelled'})

        assert conductor.handle({'action': 'advance', **ids, 'node': result}) == {
            'kind': 'finish', 'status': 'cancelled'}
        run = run_row(seeded)
        assert run['status'] == 'cancelled'
        assert 'finished_at' in run
        assert 'gsi1pk' not in run
        assert world.projects == {}

    def test_an_unknown_custom_workflow_fails_cleanly(self, runtime_env):
        agents_table, _ = runtime_env
        seed_agent(agents_table, workflow_id='wf_missing')
        seed_run(agents_table)
        from agents.conductor import handler as conductor

        assert conductor.handle({'action': 'init', 'agent_id': AGENT_ID, 'run_id': RUN_ID})['status'] == 'failed'

    def test_a_stored_workflow_revision_is_pinned(self, runtime_env, model):
        from shared.workflow_schema import default_template as default_workflow
        agents_table, _ = runtime_env
        definition = default_workflow()
        definition['nodes'] = [n for n in definition['nodes'] if n['id'] in ('start', 'aggregate', 'end')]
        definition['edges'] = [{'id': 'a', 'source': 'start', 'target': 'aggregate'},
                               {'id': 'b', 'source': 'aggregate', 'target': 'end'}]
        definition['loops'] = []
        agents_table.put_item(Item={'pk': 'WORKFLOW#wf_short', 'sk': 'CURRENT', 'revision': 3})
        agents_table.put_item(Item={'pk': 'WORKFLOW#wf_short', 'sk': 'REV#000003',
                                    'definition': encode_definition(definition)})
        seed_agent(agents_table, workflow_id='wf_short')
        seed_run(agents_table)

        assert drive(model)['status'] == 'completed'
        run = run_row(agents_table)
        assert int(run['workflow_revision']) == 3
        assert int(run['steps']) == 1
        assert _agent_row()['last_run_status'] == 'completed'


class TestHandOffToTheApiStore:
    """The runtime finishes runs the agents API started — both sides must agree."""

    def test_finishing_a_run_releases_the_agent_run_lock(self, runtime_env, model):
        agents_table, _ = runtime_env
        seed_agent(agents_table, active_run_id=RUN_ID)
        seed_run(agents_table)

        assert drive(model)['status'] == 'completed'

        agent = _agent_row()
        # Without the release, "Run now" and every scheduled run would be refused forever.
        assert 'active_run_id' not in agent
        assert agent['last_run_status'] == 'completed'
        assert int(agent['runs_completed']) == 1

    def test_a_lock_held_by_another_run_is_left_alone(self, runtime_env, model):
        agents_table, _ = runtime_env
        seed_agent(agents_table, active_run_id='ar_ffffffffffff')
        seed_run(agents_table)

        drive(model)

        assert _agent_row()['active_run_id'] == 'ar_ffffffffffff'


class TestRunMemory:
    @pytest.fixture
    def queue_url(self, runtime_env, monkeypatch):  # noqa: ARG002 - runtime_env puts this inside mock_aws
        import boto3

        import shared.aws
        monkeypatch.setattr(shared.aws, '_sqs_client', None)
        url = boto3.client('sqs', region_name='us-east-1').create_queue(QueueName='voc-memory-extract')['QueueUrl']
        monkeypatch.setenv('MEMORY_EXTRACT_QUEUE_URL', url)
        return url

    @staticmethod
    def _messages(url: str) -> list[dict]:
        import json

        import boto3
        response = boto3.client('sqs', region_name='us-east-1').receive_message(
            QueueUrl=url, MaxNumberOfMessages=10)
        messages = response.get('Messages', [])
        assert all('Body' in m for m in messages)
        return [json.loads(m.get('Body', '')) for m in messages]

    @pytest.mark.usefixtures('seeded')
    def test_a_completed_run_is_queued_as_an_agent_run_memory_source(self, queue_url, model):
        assert drive(model)['status'] == 'completed'

        [message] = self._messages(queue_url)
        assert message['kind'] == 'agent_run'
        assert message['ref'] == RUN_ID
        assert message['agent_id'] == AGENT_ID
        assert 'owner_sub' not in message
        assert message['text'].startswith('Autonomous agent "Checkout agent" run')
        assert '[node_finished]' in message['text']

    def test_a_failed_run_is_not_a_memory_source(self, queue_url, seeded):
        _start_then_fail({'Error': 'Lambda.Unknown'})

        assert run_row(seeded)['status'] == 'failed'
        assert self._messages(queue_url) == []

    @pytest.mark.usefixtures('seeded')
    def test_a_queue_failure_never_fails_the_run(self, monkeypatch, model):
        monkeypatch.setenv('MEMORY_EXTRACT_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/0/missing')

        assert drive(model)['status'] == 'completed'
