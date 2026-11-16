"""shared/agent_seed.py: the once-per-deployment default agent, against moto `voc-agents`."""
from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from shared import agent_seed, workflow_schema
from shared import agents_store as store
from shared.project_access import Caller
from shared.test.agents_fixtures import CATEGORIES, agents_env

ADMIN = Caller(subject='admin-sub', is_admin=True, username='alice')


@pytest.fixture(autouse=True)
def _fresh_container():
    agent_seed._settled.clear()
    yield
    agent_seed._settled.clear()


def _categories() -> list[dict]:
    return CATEGORIES


def _marker(env) -> dict:
    """The marker row; {} when there is none."""
    return env.agents.get_item(Key=agent_seed.SEED_KEY).get('Item') or {}


def _claimed(env, age: timedelta) -> None:
    env.agents.put_item(Item={**agent_seed.SEED_KEY, 'state': 'seeding',
                              'claimed_at': store.iso(store.utc_now() - age)})


def test_seeds_once_and_returns_the_agent_id():
    with agents_env() as env:
        agent_id = agent_seed.ensure_default_agent(env.agents, ADMIN, _categories)
        assert store.is_agent_id(agent_id)
        assert _marker(env).get('state') == 'done'
        agent_seed._settled.clear()
        assert agent_seed.ensure_default_agent(env.agents, ADMIN, _categories) is None
        assert len(store.list_agents(env.agents)) == 1


def test_a_settled_marker_never_reads_the_categories():
    with agents_env() as env:
        env.agents.put_item(Item={**agent_seed.SEED_KEY, 'state': 'skipped'})
        categories = MagicMock(return_value=CATEGORIES)
        assert agent_seed.ensure_default_agent(env.agents, ADMIN, categories) is None
        categories.assert_not_called()


def test_a_live_claim_is_left_alone_and_not_memoised():
    with agents_env() as env:
        _claimed(env, timedelta(seconds=5))
        assert agent_seed.ensure_default_agent(env.agents, ADMIN, _categories) is None
        assert store.list_agents(env.agents) == []
        # The other request failed meanwhile: this container still retries.
        env.agents.put_item(Item={**agent_seed.SEED_KEY, 'state': 'failed'})
        assert agent_seed.ensure_default_agent(env.agents, ADMIN, _categories) is not None


def test_a_stale_claim_is_taken_over():
    with agents_env() as env:
        _claimed(env, agent_seed.STALE_CLAIM + timedelta(minutes=1))
        assert agent_seed.ensure_default_agent(env.agents, ADMIN, _categories) is not None
        assert _marker(env).get('state') == 'done'


def test_a_failed_listing_releases_the_claim_without_a_workflow():
    with agents_env() as env, patch.object(store, 'list_agents', side_effect=RuntimeError('boom')):
        assert agent_seed.ensure_default_agent(env.agents, ADMIN, _categories) is None
        assert _marker(env).get('state') == 'failed'
        assert [w for w in store.list_workflows(env.agents) if w.get('derived_from')] == []


def test_an_unexpected_claim_error_never_raises_and_writes_nothing():
    error = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'x'}}, 'PutItem')
    with agents_env() as env:
        with patch.object(env.agents, 'put_item', side_effect=error):
            assert agent_seed.ensure_default_agent(env.agents, ADMIN, _categories) is None
        assert _marker(env) == {}
        assert store.list_agents(env.agents) == []


def test_a_release_that_fails_is_logged_not_raised():
    with agents_env() as env, patch.object(store, 'create_agent', side_effect=RuntimeError('boom')), \
            patch.object(agent_seed, '_settle', side_effect=ClientError({'Error': {'Code': 'X'}}, 'PutItem')), \
            patch.object(agent_seed.logger, 'exception') as logged:
        assert agent_seed.ensure_default_agent(env.agents, ADMIN, _categories) is None
        messages = [c.args[0] for c in logged.call_args_list]
        assert 'Default agent seeding could not release its marker' in messages
        assert _marker(env).get('state') == 'seeding'


# --- The engineering agents (7.47.00): each with its own marker, seeded once per deployment ---------------------------

def _seeded(env) -> dict[str, dict]:
    return {agent['name']: agent for agent in store.list_agents(env.agents)}


def _marker_of(env, slug: str) -> dict:
    return env.agents.get_item(Key={'pk': f'AGENTSEED#{slug}', 'sk': 'META'}).get('Item') or {}


def test_the_engineering_agents_are_seeded_disabled_with_their_flows_and_a_starting_budget():
    with agents_env() as env:
        created = agent_seed.ensure_engineering_agents(env.agents, ADMIN, _categories)
        agents = _seeded(env)
        assert sorted(agents) == ['Bug fixer', 'Feature builder']
        assert len(created) == 2
        bug, feature = agents['Bug fixer'], agents['Feature builder']
        assert (bug['enabled'], feature['enabled']) == (False, False)
        assert bug['engineering'] == {'connection': None, 'language': None, 'feedback_type': 'bug'}
        assert feature['engineering'] == {'connection': None, 'language': None, 'feedback_type': 'feature_request'}
        assert bug['triggers'] == [
            {'kind': 'github_issue', 'label': 'voc-agent', 'trusted_authors': False, 'lookback_days': 7},
            {'kind': 'new_reviews', 'min_new': 5, 'cooldown_hours': 24}]
        assert feature['triggers'][1] == {'kind': 'new_reviews', 'min_new': 10, 'cooldown_hours': 24}
        assert (bug['budget']['max_scheduled_runs_per_day'], bug['scope']) == (
            1, {'all': True, 'categories': [], 'subcategories': []})
        flows = {name: workflow_schema.decode_definition(store.get_workflow(env.agents, agent['workflow_id'])['definition'])
                 for name, agent in agents.items()}
        # Issue triage then Bug hunt and fix; Feature from an issue or a PRD: both engineering flows, both to a draft PR.
        assert [node['id'] for node in flows['Bug fixer']['nodes']] == [
            'start', 'memory', 'classify', 'locate', 'hunt', 'board', 'gate', 'commit', 'pr_author', 'pr', 'human']
        assert {flow['schema'] for flow in flows.values()} == {'voc-workflow/2'}
        assert all(any(node['type'] == 'stop_at_pr' for node in flow['nodes']) for flow in flows.values())
        # The owner's starting budget (2026-11-16): $50 a month each, which Set up shows and an admin may change.
        assert {flow['budget']['monthly_usd'] for flow in flows.values()} == {agent_seed.SEEDED_MONTHLY_BUDGET_USD} == {50}
        assert all(workflow_schema.validate_definition(flow).definition is not None for flow in flows.values())
        assert (_marker_of(env, 'bug-fixer')['state'], _marker_of(env, 'feature-builder')['state']) == ('done', 'done')


def test_an_existing_deployment_gets_them_once_beside_autonomous_product_and_never_again_once_archived():
    with agents_env() as env:
        # A deployment from before 7.47.00: its default agent seeded long ago, its marker done.
        assert agent_seed.ensure_default_agent(env.agents, ADMIN, _categories) is not None
        agent_seed._settled.clear()
        assert len(agent_seed.ensure_engineering_agents(env.agents, ADMIN, _categories)) == 2
        assert sorted(_seeded(env)) == ['Autonomous Product', 'Bug fixer', 'Feature builder']
        bug = _seeded(env)['Bug fixer']
        store.update_agent(env.agents, bug['agent_id'], {'status': 'archived', 'enabled': False},
                           updated_by='admin-sub', now=store.utc_now(), allow_archived=True)
        agent_seed._settled.clear()
        assert agent_seed.ensure_engineering_agents(env.agents, ADMIN, _categories) == []
        assert [a['name'] for a in store.list_agents(env.agents)].count('Bug fixer') == 1


def test_an_engineering_agent_an_admin_already_made_is_not_doubled():
    with agents_env() as env:
        fields = store.normalize_agent({'name': 'Bug fixer', 'scope': {'all': True}}, CATEGORIES)
        fields['workflow_id'] = 'wf_default'
        store.create_agent(env.agents, fields, created_by='admin-sub', now=store.utc_now())
        assert len(agent_seed.ensure_engineering_agents(env.agents, ADMIN, _categories)) == 1
        assert _marker_of(env, 'bug-fixer')['state'] == 'skipped'
        assert [a['name'] for a in store.list_agents(env.agents)].count('Bug fixer') == 1


def test_a_failed_engineering_seed_releases_its_own_marker_and_leaves_no_flow():
    with agents_env() as env, patch.object(store, 'create_agent', side_effect=RuntimeError('boom')):
        assert agent_seed.ensure_engineering_agents(env.agents, ADMIN, _categories) == []
        assert (_marker_of(env, 'bug-fixer')['state'], _marker_of(env, 'feature-builder')['state']) == (
            'failed', 'failed')
        assert _marker(env) == {}
        assert [w for w in store.list_workflows(env.agents)[1:] if not store.is_archived_workflow(w)] == []
