"""`GET /agents` seeds the default agent once per deployment (shared/agent_seed.py).

moto tables in the real `voc-agents` shape (pk/sk + `gsi1-by-agents-listing`), driven
through the handler as an admin and as a plain user.
"""
from unittest.mock import patch

from agents_handler_fixtures import USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from agents_handler_fixtures import create as _create
from boto3.dynamodb.conditions import Key

from shared import agent_seed
from shared import agents_store as store


def _agent_rows(env) -> list[dict]:
    return env.agents.query(IndexName=store.AGENTS_INDEX,
                            KeyConditionExpression=Key('gsi1pk').eq(store.AGENTS_GSI_PK))['Items']


def _marker(env) -> dict:
    """The marker row; {} when there is none."""
    return env.agents.get_item(Key=agent_seed.SEED_KEY).get('Item') or {}


def _forget_container() -> None:
    """A different warm container: it has not seen the marker yet."""
    agent_seed._settled.clear()


class TestFirstAdminListing:
    def test_seeds_exactly_one_disabled_agent_and_lists_it(self, lambda_context):
        with _api() as env:
            status, body = _call(lambda_context, 'GET', '/agents')
            assert status == 200
            assert body['count'] == 1
            listed = body['items'][0]
            assert listed['name'] == 'Autonomous Product'
            rows = _agent_rows(env)
            assert len(rows) == 1
            agent = rows[0]
            assert agent['agent_id'] == listed['agent_id']
            assert agent['enabled'] is False
            assert agent['description'] == 'Turns recurring review problems into a PR/FAQ, PRD and prototype'
            assert agent['triggers'] == [{'kind': 'threshold', 'count': 10, 'per': 'category', 'window_days': 7}]
            assert agent['scope'] == {'all': True, 'categories': [], 'subcategories': []}
            assert agent['budget'] == {'max_scheduled_runs_per_day': 2, 'max_model_calls_per_run': 150,
                                       'monthly_call_cap': 5000}
            assert set(agent['models'].values()) == {None}
            assert agent['personas'] == {'fixed': [], 'allow_generate': True}
            assert agent['output'] == {'visibility': 'private'}
            assert agent['instructions'] == ''
            assert agent['owner_sub'] == 'admin-sub'
            workflow = store.get_workflow(env.agents, agent['workflow_id'])
            assert workflow is not None
            assert workflow['derived_from'] == 'wf_default'
            assert workflow['name'] == 'Autonomous Product workflow'
            assert _marker(env).get('state') == 'done'
            assert _marker(env).get('agent_id') == agent['agent_id']

    def test_a_second_listing_does_not_seed_again(self, lambda_context):
        with _api() as env:
            _call(lambda_context, 'GET', '/agents')
            assert _call(lambda_context, 'GET', '/agents')[1]['count'] == 1
            _forget_container()
            assert _call(lambda_context, 'GET', '/agents')[1]['count'] == 1
            assert len(_agent_rows(env)) == 1

    def test_a_warm_container_does_not_read_the_marker_again(self, lambda_context):
        with _api() as env:
            _call(lambda_context, 'GET', '/agents')
            with patch.object(agent_seed, '_settled_marker', wraps=agent_seed._settled_marker) as read:
                _call(lambda_context, 'GET', '/agents')
            assert read.call_count == 0
            assert len(_agent_rows(env)) == 1


class TestSeedingIsDecidedOnce:
    def test_a_marker_already_claimed_creates_nothing(self, lambda_context):
        with _api() as env:
            env.agents.put_item(Item={**agent_seed.SEED_KEY, 'state': 'seeding',
                                      'claimed_at': store.iso(store.utc_now())})
            status, body = _call(lambda_context, 'GET', '/agents')
            assert (status, body['count']) == (200, 0)
            assert _agent_rows(env) == []

    def test_a_deployment_with_only_an_archived_agent_is_skipped(self, lambda_context):
        with _api() as env:
            agent_id = _create(lambda_context)['agent_id']
            _call(lambda_context, 'DELETE', f'/agents/{agent_id}')
            status, body = _call(lambda_context, 'GET', '/agents')
            assert (status, body['count']) == (200, 0)
            assert [row['agent_id'] for row in _agent_rows(env)] == [agent_id]
            assert _marker(env).get('state') == 'skipped'

    def test_a_non_admin_listing_writes_nothing(self, lambda_context):
        with _api() as env:
            status, body = _call(lambda_context, 'GET', '/agents', claims=USER)
            assert (status, body['count']) == (200, 0)
            assert _marker(env) == {}
            assert _agent_rows(env) == []

    def test_the_archived_seed_is_never_recreated(self, lambda_context):
        with _api() as env:
            agent_id = _call(lambda_context, 'GET', '/agents')[1]['items'][0]['agent_id']
            assert _call(lambda_context, 'DELETE', f'/agents/{agent_id}')[0] == 200
            _forget_container()
            status, body = _call(lambda_context, 'GET', '/agents')
            assert (status, body['count']) == (200, 0)
            assert len(_agent_rows(env)) == 1


class TestAFailedSeed:
    def test_releases_the_marker_and_still_lists(self, lambda_context):
        with _api() as env:
            with patch.object(store, 'create_agent', side_effect=RuntimeError('boom')):
                status, body = _call(lambda_context, 'GET', '/agents')
            assert (status, body['count']) == (200, 0)
            assert _marker(env).get('state') == 'failed'
            assert _agent_rows(env) == []
            # The workflow copy of the agent that was never created left the library.
            orphans = [w for w in store.list_workflows(env.agents) if w.get('derived_from') == 'wf_default']
            assert [w.get('status') for w in orphans] == ['archived']
            # The next admin listing retries and succeeds.
            assert _call(lambda_context, 'GET', '/agents')[1]['count'] == 1
            assert _marker(env).get('state') == 'done'
