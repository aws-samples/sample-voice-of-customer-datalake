"""shared/agent_seed.py: the once-per-deployment default agent, against moto `voc-agents`."""
from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from shared import agent_seed
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
