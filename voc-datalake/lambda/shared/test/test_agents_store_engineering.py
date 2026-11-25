"""shared/agents_store.py (7.47.00): an engineering agent's settings, the source scope, the github_issue trigger and
the one run per GitHub issue."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from shared import agents_store as store
from shared.exceptions import ValidationError
from shared.test.agents_fixtures import CATEGORIES, agents_env, stored_agent

NOW = datetime(2026, 11, 16, 9, 0, tzinfo=UTC)
ENGINEERING = {'connection': 'shop', 'language': 'python', 'feedback_type': 'bug'}


def _normal(**body: Any) -> dict[str, Any]:
    return store.normalize_agent({'name': 'n', **body}, CATEGORIES)


def _refused(body: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        _normal(**body)


def test_an_engineering_agents_settings_default_to_a_bug_agent_not_set_up() -> None:
    assert _normal(engineering={})['engineering'] == {'connection': None, 'language': None, 'feedback_type': 'bug'}
    assert _normal(engineering={'connection': '', 'language': None, 'feedback_type': 'feature_request'})[
        'engineering'] == {'connection': None, 'language': None, 'feedback_type': 'feature_request'}
    assert _normal()['engineering'] is None
    assert store.is_engineering_agent({'engineering': ENGINEERING})
    assert not store.is_engineering_agent({})


@pytest.mark.parametrize(('engineering', 'message'), [
    ({'connection': 'Shop!'}, 'engineering.connection is not a valid name'),
    ({'language': 'Python 3'}, 'engineering.language is not a valid name'),
    ({'feedback_type': 'praise'}, 'engineering.feedback_type must be one of: bug, feature_request'),
    ({'model': 'x'}, 'engineering takes connection, language and feedback_type only'),
    ('shop', 'engineering must be an object'),
])
def test_engineering_settings_off_their_rule_are_refused(engineering: object, message: str) -> None:
    _refused({'engineering': engineering}, message)


def test_an_engineering_agent_keeps_its_instructions_short_and_its_runs_per_day_to_five() -> None:
    assert _normal(engineering=ENGINEERING, instructions='x' * 300)['instructions'] == 'x' * 300
    _refused({'engineering': ENGINEERING, 'instructions': 'x' * 301}, 'instructions must be at most 300 characters')
    assert _normal(instructions='x' * 301)['instructions'] == 'x' * 301   # (an agents workflow's: 8,000)
    assert _normal(engineering=ENGINEERING)['budget']['max_scheduled_runs_per_day'] == 1
    assert _normal(engineering=ENGINEERING, budget={'max_scheduled_runs_per_day': 5})['budget'][
        'max_scheduled_runs_per_day'] == 5
    _refused({'engineering': ENGINEERING, 'budget': {'max_scheduled_runs_per_day': 6}},
             'max_scheduled_runs_per_day must be a whole number from 0 to 5')
    _refused({'budget': {'max_scheduled_runs_per_day': 3}}, 'from 0 to 2')


def test_the_github_issue_trigger_takes_its_defaults_and_is_an_engineering_agents_alone() -> None:
    fields = _normal(engineering=ENGINEERING, triggers=[{'kind': 'github_issue'}])
    assert fields['triggers'] == [{'kind': 'github_issue', 'label': 'voc-agent', 'trusted_authors': False,
                                   'lookback_days': 7}]
    assert _normal(engineering=ENGINEERING, triggers=[{'kind': 'github_issue', 'label': ' ready ', 'trusted_authors': True,
                                                       'lookback_days': 30}])['triggers'][0] == {
        'kind': 'github_issue', 'label': 'ready', 'trusted_authors': True, 'lookback_days': 30}
    _refused({'triggers': [{'kind': 'github_issue'}]}, "a github_issue trigger is an engineering agent's")
    _refused({'engineering': ENGINEERING, 'triggers': [{'kind': 'github_issue'}, {'kind': 'github_issue'}]},
             'at most one github_issue trigger')
    _refused({'engineering': ENGINEERING, 'triggers': [{'kind': 'github_issue', 'lookback_days': 31}]},
             'lookback_days must be a whole number from 1 to 30')
    _refused({'engineering': ENGINEERING, 'triggers': [{'kind': 'github_issue', 'label': 'x' * 51}]},
             'label must be at most 50 characters')


def test_the_source_scope_is_kept_only_when_it_names_sources_and_never_with_a_threshold() -> None:
    assert _normal(scope={'all': True})['scope'] == {'all': True, 'categories': [], 'subcategories': []}
    assert _normal(scope={'sources': ['github_issues', 'github_issues', 'app_store']})['scope'] == {
        'all': True, 'categories': [], 'subcategories': [], 'sources': ['github_issues', 'app_store']}
    assert _normal(scope={'all': False, 'categories': ['shipping'], 'sources': ['web']})['scope']['sources'] == ['web']
    _refused({'scope': {'sources': ['Web Site']}}, 'scope.sources must name at most 20 sources by their id')
    _refused({'scope': {'sources': [f's{n}' for n in range(21)]}}, 'scope.sources must name at most 20 sources')
    _refused({'scope': {'sources': ['web']}, 'triggers': [{'kind': 'threshold'}]},
             'a threshold trigger counts every source')


def test_an_item_is_in_scope_only_from_the_scopes_sources() -> None:
    scope = {'all': True, 'sources': ['github_issues']}
    assert store.item_in_scope(scope, {'source_platform': 'github_issues', 'category': 'shipping'})
    assert not store.item_in_scope(scope, {'source_platform': 'web', 'category': 'shipping'})
    assert not store.item_in_scope({'all': False, 'categories': ['billing'], 'sources': ['github_issues']},
                                   {'source_platform': 'github_issues', 'category': 'shipping'})
    assert store.item_in_scope({'all': True}, {'category': 'shipping'})


def test_the_view_names_who_an_engineering_agent_runs_as() -> None:
    view = store.agent_view({'agent_id': 'ag_0123456789ab', 'engineering': ENGINEERING, 'owner_sub': 's',
                             'owner_username': 'alice'}, NOW)
    assert (view['engineering'], view['owner_username']) == (ENGINEERING, 'alice')


def _agent(env: Any) -> dict[str, Any]:
    fields = _normal(engineering=ENGINEERING)
    fields['workflow_id'] = 'wf_0123456789ab'
    return store.create_agent(env.agents, fields, created_by='admin-sub', now=NOW)


def test_a_run_and_its_issue_claim_are_one_transaction() -> None:
    with agents_env() as env:
        agent = _agent(env)
        claim = store.issue_claim_item('Example-Org/Shop', 7, agent_id=agent['agent_id'], run_id='ar_0123456789ab0001',
                                       engineering_run_id='01JDA7K3M9Q2R5T8V0W4X6Y1Z3', feedback_id='f', now=NOW)
        assert claim['sk'] == 'example-org/shop#7'
        request = store.RunStart(trigger='github_issue', requested_by='heartbeat', workflow_revision=1,
                                 run_fields={'kind': 'engineering'}, issue_claim=claim, run_id='ar_0123456789ab0001')
        run = store.start_run(env.agents, agent, request, now=NOW)
        assert run is not None
        assert run['run_id'] == 'ar_0123456789ab0001'
        assert run['kind'] == 'engineering'
        assert store.issue_claimed(env.agents, 'example-org/shop', 7)
        store.release_lock(env.agents, agent['agent_id'], run['run_id'], 'completed')
        # Claimed: refused before anything is written (no run, the lock free).
        with pytest.raises(store.IssueClaimed):
            store.start_run(env.agents, stored_agent(env.agents, agent['agent_id']), store.RunStart(
                trigger='github_issue', requested_by='heartbeat', workflow_revision=1, issue_claim=claim), now=NOW)
        assert len(store.list_runs(env.agents, agent['agent_id'], limit=10)[0]) == 1
        assert stored_agent(env.agents, agent['agent_id']).get('active_run_id') is None


def test_a_busy_agent_starts_no_run_and_takes_no_claim() -> None:
    with agents_env() as env:
        agent = _agent(env)
        assert store.start_run(env.agents, agent, store.RunStart(trigger='manual', requested_by='a',
                                                                 workflow_revision=1), now=NOW) is not None
        claim = store.issue_claim_item('o/r', 1, agent_id=agent['agent_id'], run_id='ar_0123456789ab0002',
                                       engineering_run_id='E', feedback_id='', now=NOW)
        busy = store.start_run(env.agents, agent, store.RunStart(trigger='github_issue', requested_by='heartbeat',
                                                                 workflow_revision=1, issue_claim=claim), now=NOW)
        assert busy is None
        assert not store.issue_claimed(env.agents, 'o/r', 1)


def test_a_rerun_claims_a_free_issue_and_keeps_a_taken_one() -> None:
    with agents_env() as env:
        first = store.issue_claim_item('o/r', 1, agent_id='ag_0123456789ab', run_id='ar_1', engineering_run_id='E1',
                                       feedback_id='', now=NOW)
        assert store.claim_issue_if_free(env.agents, first) is True
        assert store.claim_issue_if_free(env.agents, {**first, 'agent_run_id': 'ar_2'}) is False
        assert env.agents.get_item(Key=store.issue_claim_key('o/r', 1))['Item']['agent_run_id'] == 'ar_1'


def _queued(env: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """An engineering agent and its queued run."""
    agent = _agent(env)
    run = store.start_run(env.agents, agent, store.RunStart(trigger='manual', requested_by='a', workflow_revision=1),
                          now=NOW)
    assert run is not None
    return agent, run


def test_an_engineering_run_moves_from_queued_to_running_once() -> None:
    with agents_env() as env:
        agent, run = _queued(env)
        running = store.mark_engineering_running(env.agents, agent['agent_id'], run['run_id'])
        assert running is not None
        assert running['status'] == 'running'
        # (7.71.03) The agent's own row follows it: its stats read "running", never "queued", while the run works.
        agent_row = env.agents.get_item(Key=store.agent_key(agent['agent_id']))['Item']
        assert (agent_row['last_run_id'], agent_row['last_run_status']) == (run['run_id'], 'running')
        assert store.mark_engineering_running(env.agents, agent['agent_id'], run['run_id']) is None
        view = store.run_view({**run, 'kind': 'engineering', 'engineering_run_id': 'E', 'issue': {'number': 1},
                               'feedback_count': 3})
        assert (view['kind'], view['engineering_run_id'], view['issue'], view['feedback_count'], view['prd']) == (
            'engineering', 'E', {'number': 1}, 3, None)


def test_a_stats_write_that_fails_after_the_run_started_is_logged_and_never_raised(
        monkeypatch: pytest.MonkeyPatch) -> None:
    # (Q5, 7.71.04) The run's own move to running landed: the agent row's stats are best effort after it.
    from botocore.exceptions import ClientError
    with agents_env() as env:
        agent, run = _queued(env)

        def refused(*_args: Any, **_kwargs: Any) -> None:
            raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'UpdateItem')

        monkeypatch.setattr(store, 'update_unless_condition_fails', refused)
        running = store.mark_engineering_running(env.agents, agent['agent_id'], run['run_id'])
        assert running is not None
        assert running['status'] == 'running'
