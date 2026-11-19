"""shared/engineering_agent_runs.py (7.47.00): an engineering run's start request, as the Agents API and the heartbeat
build it, and an engineering agent's run started through voc-engineering-start."""
from __future__ import annotations

import io
import json
import re
from datetime import UTC, datetime
from typing import Any

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError, ReadTimeoutError

from agents.heartbeat import issues
from engineering.connectors import connections, reactions
from engineering.connectors.identity import WORKSPACE
from engineering.runtime import runs
from shared import agents_store as store
from shared import engineering_agent_runs as eng_runs
from shared import workflow_schema
from shared.agent_seed import seeded_flow
from shared.exceptions import ConflictError, ServiceUnavailableError, ValidationError
from shared.test.agents_fixtures import CATEGORIES, agents_env, stored_agent, stored_workflow

NOW = datetime(2026, 11, 16, 9, 0, tzinfo=UTC)
ULID = re.compile(r'[0-9A-HJKMNP-TV-Z]{26}')
ROW = {'connection_id': 'shop', 'host': 'github', 'repository': 'example-org/shop', 'default_branch': 'main'}


class Lambda:
    """voc-engineering-start as its client sees it: ``answer`` (a payload) or ``error`` (a function error's type)."""

    def __init__(self, *, error: str | None = None, message: str = '', raises: Exception | None = None,
                 payload: object = None) -> None:
        self.error, self.message, self.raises, self.payload, self.sent = error, message, raises, payload, []

    def invoke(self, **request: Any) -> dict[str, Any]:
        self.sent.append(request)
        if self.raises is not None:
            raise self.raises
        sent = json.loads(request['Payload'])
        if self.error:
            body = {'errorType': self.error, 'errorMessage': self.message}
            return {'FunctionError': 'Unhandled', 'Payload': io.BytesIO(json.dumps(body).encode())}
        payload = self.payload if self.payload is not None else {'run_id': sent['run_id'], 'status': 'active'}
        return {'Payload': io.BytesIO(json.dumps(payload).encode())}


def test_the_connection_rows_and_the_scope_are_the_engineering_modules_own() -> None:
    # (the heartbeat ships without engineering/: these must stay the connections module's and the broker's spelling)
    assert eng_runs.ENGINEERING_WORKSPACE == WORKSPACE
    assert (eng_runs.CONNECTIONS_PARTITION, eng_runs.CONNECTION_ROW_PREFIX) == (connections.PARTITION,
                                                                                 connections.ROW_PREFIX)
    assert eng_runs.connection_key('shop') == connections._key('shop')
    assert store.CONNECTION_ID_RE.pattern == connections.CONNECTION_ID.pattern
    assert f'ISSUE_RUN#{WORKSPACE}' == store.ISSUE_RUN_PK
    assert eng_runs.MAX_FEEDBACK_IDS == runs.MAX_FEEDBACK_IDS
    assert eng_runs.MAX_RUN_GOAL == runs.MAX_TEXT
    # (the github_issue trigger's trusted authors are the maintainers the reactions read trusts)
    assert frozenset(reactions.GITHUB_WRITERS) == issues.TRUSTED_ASSOCIATIONS
    assert ULID.fullmatch(eng_runs.new_run_id())


def test_a_connection_row_is_read_as_stored_and_a_removed_one_is_none() -> None:
    with agents_env() as env:
        assert eng_runs.connection_row(env.agents, 'shop') is None
        env.agents.put_item(Item={**eng_runs.connection_key('shop'), **ROW, 'version': 1})
        assert eng_runs.run_connection(eng_runs.connection_row(env.agents, 'shop'), 42) == {
            'repo': 'example-org/shop', 'default_branch': 'main', 'issue': 42, 'host': 'github'}
        env.agents.put_item(Item={**eng_runs.connection_key('shop'), **ROW, 'removed': True})
        assert eng_runs.connection_row(env.agents, 'shop') is None
    with pytest.raises(ValidationError, match='no stored repository connection'):
        eng_runs.run_connection(None)


def test_a_forks_issue_is_its_upstreams() -> None:
    # (7.57.00: the issue a fork's run starts from is the upstream's, which the start's issue link names)
    fork = {**ROW, 'connection_kind': 'fork', 'upstream': 'upstream-org/shop'}
    assert eng_runs.run_connection(fork, 42) == {'repo': 'example-org/shop', 'default_branch': 'main', 'issue': 42,
                                                 'host': 'github', 'issue_repo': 'upstream-org/shop'}
    assert 'issue_repo' not in eng_runs.run_connection(fork)


def test_a_connection_is_public_unless_its_row_says_private() -> None:
    # (7.45.00 writes repository_private; a row from before it is a public repository's)
    assert eng_runs.repository_private({}) is False
    assert eng_runs.repository_private({'repository_private': False}) is False
    assert eng_runs.repository_private({'repository_private': True}) is True


def test_the_goal_is_trusted_text_of_numbers_and_names_and_never_cut() -> None:
    assert eng_runs.issue_sentence('bug', 'example-org/shop', 7) == 'Fix the bug reported in issue #7 of example-org/shop.'
    assert eng_runs.issue_sentence('feature_request', 'o/r', 3) == 'Build the feature asked for in issue #3 of o/r.'
    scope = {'all': False, 'categories': ['shipping'], 'subcategories': [{'category': 'billing', 'name': 'refunds'}]}
    assert eng_runs.reviews_sentence('bug', 12, scope) == ('Hunt the defects behind 12 bug reports in shipping, '
                                                           'billing/refunds.')
    assert eng_runs.scope_words({'all': True}) == 'all reviews'
    assert eng_runs.scope_words({'all': False, 'categories': ['a', 'b', 'c', 'd']}) == '4 categories'
    assert eng_runs.prd_sentence('p1', 'd1') == 'Build the feature the PRD d1 of project p1 describes.'
    assert eng_runs.run_goal('  Keep it\nsmall. ', 'Fix it.') == 'Keep it small. Fix it.'
    with pytest.raises(ValidationError, match='over 500 characters'):
        eng_runs.run_goal('x' * 300, 'y' * 201)


def test_the_run_caps_are_the_deployments_or_the_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    assert eng_runs.run_caps() == {'max_tasks': 100, 'max_cost_usd': 50.0, 'max_tokens': 10_000_000}
    monkeypatch.setenv(eng_runs.RUN_CAP_USD_ENV, '12.5')
    monkeypatch.setenv(eng_runs.RUN_MODEL_USE_CAP_ENV, '-3')   # (off its rule: the default holds, never no cap)
    assert eng_runs.run_caps() == {'max_tasks': 100, 'max_cost_usd': 12.5, 'max_tokens': 10_000_000}


def test_a_stored_flow_is_an_engineering_flow_with_its_budget() -> None:
    with pytest.raises(ValidationError, match='does not name a saved workflow'):
        eng_runs.stored_flow(None)
    agents_flow = {'definition': workflow_schema.encode_definition(workflow_schema.default_template())}
    with pytest.raises(ValidationError, match='agents workflow'):
        eng_runs.stored_flow(agents_flow)
    broken = {'definition': workflow_schema.encode_definition({**seeded_flow('bug-fixer'), 'budget': {'monthly_usd': -1}})}
    with pytest.raises(ConflictError, match='off its rule'):
        eng_runs.stored_flow(broken)
    flow = eng_runs.stored_flow({'revision': 3, 'definition': workflow_schema.encode_definition(
        {**seeded_flow('bug-fixer'), 'budget': {'monthly_usd': 80}})})
    assert (flow.budget_usd, flow.revision, json.loads(flow.definition)['schema']) == (80.0, 3, 'voc-workflow/2')


def test_the_start_request_resolves_its_commit_forces_the_hard_cap_and_says_where_it_came_from() -> None:
    flow = eng_runs.StoredFlow(80.0, '{"schema":"voc-workflow/2"}', 2)
    plan = eng_runs.StartPlan(
        run_id='01JDA7K3M9Q2R5T8V0W4X6Y1Z3', workflow_id='wf_0123456789ab', flow=flow, connection_id='shop',
        connection=ROW, language='python', goal='Fix the bug reported in issue #7 of example-org/shop.',
        actor='owner-sub', issue=7, feedback=eng_runs.Feedback(('fb-1',), 1, 'shipping'),
        via={'agent_id': 'ag_0123456789ab', 'agent_run_id': 'ar_0123456789ab01234567', 'trigger': 'github_issue'})
    assert eng_runs.start_request(plan) == {
        'action': 'start_run', 'run_id': plan.run_id, 'flow': 'wf_0123456789ab', 'flow_definition': flow.definition,
        'flow_revision': 2, 'connection': 'shop', 'commit': '', 'resolve_commit': True, 'hard_cap': True,
        'language': 'python', 'goal': plan.goal, 'actor': 'owner-sub', 'repo': 'example-org/shop',
        'default_branch': 'main', 'issue': 7, 'host': 'github', 'max_tasks': 100, 'max_cost_usd': 50.0,
        'max_tokens': 10_000_000, 'budget_usd': 80.0,
        'feedback': {'ids': ['fb-1'], 'count': 1, 'category': 'shipping'}, 'via': plan.via}


def test_the_feedback_a_run_carries_is_ids_their_top_category_and_the_count() -> None:
    items = [{'feedback_id': f'fb-{n}', 'category': 'shipping' if n % 3 else 'billing'} for n in range(60)]
    feedback = eng_runs.feedback_of(items, 75)
    assert (len(feedback.ids), feedback.ids[0], feedback.count, feedback.category) == (50, 'fb-0', 75, 'shipping')
    assert eng_runs.feedback_of([], 0) == eng_runs.Feedback((), 0, None)


@pytest.mark.parametrize(('client', 'outcome', 'message'), [
    (Lambda(), 'started', ''),
    (Lambda(error='RuntimeRefused', message='no python image'), 'refused', 'no python image'),
    (Lambda(error='StartNotWritten', message='start it again'), 'not_written', 'start it again'),
    (Lambda(error='StartFailed', message='open its run monitor'), 'uncertain', 'open its run monitor'),
    (Lambda(error='Sandbox.Timedout', message='timed out'), 'uncertain', ''),
    (Lambda(payload={'run_id': 'another'}), 'uncertain', ''),
    (Lambda(payload=[1]), 'uncertain', ''),
    (Lambda(raises=EndpointConnectionError(endpoint_url='https://lambda')), 'unreachable', ''),
    (Lambda(raises=ClientError({'Error': {'Code': 'TooManyRequestsException'}}, 'Invoke')), 'unreachable', ''),
    (Lambda(raises=ReadTimeoutError(endpoint_url='https://lambda')), 'uncertain', ''),
])
def test_what_came_of_a_start(client: Lambda, outcome: str, message: str) -> None:
    answer = eng_runs.invoke_start(client, 'voc-engineering-start', {'run_id': 'RUN'})
    assert (answer.outcome, answer.message) == (outcome, message)
    assert client.sent[0]['InvocationType'] == 'RequestResponse'


def _engineering_agent(env: Any, **settings: Any) -> tuple[dict, dict]:
    """A disabled bug agent on ``shop`` with its flow saved with a budget; the agent and the connection row."""
    flow = store.create_workflow(env.agents, {**seeded_flow('bug-fixer'), 'budget': {'monthly_usd': 80}}, created_by='admin',
                                 username='alice', now=NOW)
    fields = store.normalize_agent({
        'name': 'Bug fixer', 'scope': {'all': True}, 'instructions': 'Keep fixes small.',
        'engineering': {'connection': 'shop', 'language': 'python', **settings}}, CATEGORIES)
    fields['workflow_id'] = flow['workflow_id']
    return store.create_agent(env.agents, fields, created_by='admin-sub', now=NOW), ROW


def _start(**overrides: Any) -> eng_runs.AgentStart:
    base: dict[str, Any] = {'trigger': 'github_issue', 'requested_by': 'heartbeat', 'actor': 'owner-sub',
                            'sentence': 'Fix the bug reported in issue #7 of example-org/shop.',
                            'issue': eng_runs.IssueRef('example-org/shop', 7, 'example-org/shop#7')}
    return eng_runs.AgentStart(**{**base, **overrides})


@pytest.mark.parametrize(('status', 'ended'), [('stopped', 'cancelled'), ('done', 'completed'), ('failed', 'failed')])
def test_an_engineering_runs_end_ends_its_agents_run_once_and_frees_the_lock_but_keeps_the_issue_claim(
        status: str, ended: str) -> None:
    """7.50.03: a person's Stop ends the agent's run at once (the API); the heartbeat's heal does the same later."""
    with agents_env() as env:
        agent, row = _engineering_agent(env)
        started = eng_runs.start_agent_run(env.agents, agent, store.get_workflow(env.agents, agent['workflow_id']),
                                           row, _start(), client=Lambda(), function='voc-engineering-start', now=NOW)
        assert started.run is not None
        run_id = started.run['run_id']
        assert eng_runs.end_agent_run(env.agents, agent['agent_id'], run_id, status, now=NOW) is True
        assert eng_runs.end_agent_run(env.agents, agent['agent_id'], run_id, status, now=NOW) is False   # (once)
        run = store.get_run(env.agents, agent['agent_id'], run_id)
        assert run is not None
        assert (run['status'], stored_agent(env.agents, agent['agent_id']).get('active_run_id')) == (ended, None)
        # (one run per issue, ever: the issue's claim stays; only Run now {issue} reruns it)
        assert 'Item' in env.agents.get_item(Key=store.issue_claim_key('example-org/shop', 7))
        with pytest.raises(ValueError, match='not an engineering run end'):
            eng_runs.end_agent_run(env.agents, agent['agent_id'], run_id, 'stopping', now=NOW)
    # (its map is the runtime's ends to the agents store's own statuses, never a third spelling)
    assert (eng_runs.AGENT_RUN_ENDS, frozenset(eng_runs.AGENT_RUN_ENDS)) == (
        {'done': store.RUN_COMPLETED, 'failed': store.RUN_FAILED, 'stopped': store.RUN_CANCELLED}, runs.ENDED)


def test_an_agents_run_claims_its_issue_with_the_run_and_invokes_the_start_as_its_owner() -> None:
    with agents_env() as env:
        agent, row = _engineering_agent(env)
        client = Lambda()
        started = eng_runs.start_agent_run(env.agents, agent, store.get_workflow(env.agents, agent['workflow_id']),
                                           row, _start(), client=client, function='voc-engineering-start', now=NOW)
        assert started.answer is not None
        assert started.answer.outcome == 'started'
        assert started.run is not None
        run = store.get_run(env.agents, agent['agent_id'], started.run['run_id'])
        assert run is not None
        assert (run['status'], run['kind'], run['issue']) == ('running', 'engineering',
                                                              {'repository': 'example-org/shop', 'number': 7})
        sent = json.loads(client.sent[0]['Payload'])
        goal = 'Keep fixes small. Fix the bug reported in issue #7 of example-org/shop.'
        assert (sent['run_id'], sent['actor'], sent['goal'], sent['issue']) == (run['engineering_run_id'], 'owner-sub',
                                                                                goal, 7)
        assert sent['via'] == {'agent_id': agent['agent_id'], 'agent_run_id': run['run_id'], 'trigger': 'github_issue'}
        claim = env.agents.get_item(Key=store.issue_claim_key('example-org/shop', 7))['Item']
        assert (claim['agent_run_id'], claim['engineering_run_id'], claim['feedback_id']) == (
            run['run_id'], run['engineering_run_id'], 'example-org/shop#7')
        # One run per issue, ever: the next start of it is refused before anything is written.
        store.release_lock(env.agents, agent['agent_id'], run['run_id'], 'completed')
        with pytest.raises(store.IssueClaimed):
            eng_runs.start_agent_run(env.agents, agent, store.get_workflow(env.agents, agent['workflow_id']), row,
                                     _start(), client=client, function='voc-engineering-start', now=NOW)
        assert len(client.sent) == 1


def test_a_run_now_reruns_a_claimed_issue_and_keeps_the_first_claim() -> None:
    with agents_env() as env:
        agent, row = _engineering_agent(env)
        workflow = store.get_workflow(env.agents, agent['workflow_id'])
        first = eng_runs.start_agent_run(env.agents, agent, workflow, row, _start(), client=Lambda(),
                                         function='f', now=NOW)
        assert first.run is not None
        store.release_lock(env.agents, agent['agent_id'], first.run['run_id'], 'completed')
        again = eng_runs.start_agent_run(env.agents, agent, workflow, row, _start(trigger='manual', claim=False),
                                         client=Lambda(), function='f', now=NOW)
        assert again.run is not None
        assert again.run['run_id'] != first.run['run_id']
        claim = env.agents.get_item(Key=store.issue_claim_key('example-org/shop', 7))['Item']
        assert claim['agent_run_id'] == first.run['run_id']


def test_a_refused_start_fails_the_agents_run_and_keeps_the_claim() -> None:
    with agents_env() as env:
        agent, row = _engineering_agent(env)
        started = eng_runs.start_agent_run(
            env.agents, agent, store.get_workflow(env.agents, agent['workflow_id']), row, _start(),
            client=Lambda(error='RuntimeRefused', message='issue #7 of example-org/shop is closed'), function='f',
            now=NOW)
        assert started.run is not None
        run = store.get_run(env.agents, agent['agent_id'], started.run['run_id'])
        assert run is not None
        assert (run['status'], run['error']) == ('failed', 'issue #7 of example-org/shop is closed')
        assert stored_agent(env.agents, agent['agent_id']).get('active_run_id') is None
        assert store.issue_claimed(env.agents, 'Example-Org/Shop', 7)   # (never retried: case-insensitive too)


def test_a_flow_without_a_budget_or_a_goal_over_its_limit_writes_nothing() -> None:
    with agents_env() as env:
        agent, row = _engineering_agent(env)
        definition = {key: value for key, value in seeded_flow('bug-fixer').items() if key != 'budget'}
        unbudgeted = store.create_workflow(env.agents, definition, created_by='a', username='a', now=NOW)
        with pytest.raises(ConflictError, match='no monthly budget'):
            eng_runs.start_agent_run(env.agents, agent, unbudgeted, row, _start(), client=Lambda(), function='f',
                                     now=NOW)
        with pytest.raises(ValidationError, match='over 500'):
            eng_runs.start_agent_run(env.agents, agent, store.get_workflow(env.agents, agent['workflow_id']), row,
                                     _start(sentence='x' * 490), client=Lambda(), function='f', now=NOW)
        assert store.list_runs(env.agents, agent['agent_id'], limit=5)[0] == []


def test_an_unreadable_connection_is_503() -> None:
    class Broken:
        def get_item(self, **_kwargs: Any) -> dict:
            raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'GetItem')

    with pytest.raises(ServiceUnavailableError):
        eng_runs.connection_row(Broken(), 'shop')


def _calling_flow(env: Any, called: str) -> dict:
    """A budgeted flow whose one step calls ``called`` (``wf_…@<revision>``), saved: start → call → end."""
    definition = {'schema': 'voc-workflow/2', 'name': 'Calls the bug fix', 'loops': [],
                  'budget': {'monthly_usd': 80},
                  'nodes': [{'id': 'start', 'type': 'start', 'position': {'x': 0, 'y': 0},
                             'data': {'title': 'Start', 'params': {}}},
                            {'id': 'fix', 'type': 'call_flow', 'position': {'x': 0, 'y': 120},
                             'data': {'title': 'Fix', 'params': {'flow': called, 'budget_share': 0.5}}},
                            {'id': 'end', 'type': 'end', 'position': {'x': 0, 'y': 240},
                             'data': {'title': 'End', 'params': {}}}],
                  'edges': [{'id': 'a', 'source': 'start', 'target': 'fix'},
                            {'id': 'b', 'source': 'fix', 'target': 'end'}]}
    return store.create_workflow(env.agents, definition, created_by='admin', username='alice', now=NOW)


def test_a_run_starts_from_its_flow_with_the_calls_expanded_and_records_them() -> None:
    """7.52.00: the start reads each called flow at the revision its call pins; the runtime gets a flat flow, and both
    the run's copy (its start step) and the agent's run row record the calls."""
    with agents_env() as env:
        agent, row = _engineering_agent(env)
        called = stored_workflow(env.agents, agent['workflow_id'])
        caller = _calling_flow(env, f'{called["workflow_id"]}@1')
        agent = store.update_agent(env.agents, agent['agent_id'], {'workflow_id': caller['workflow_id']},
                                   updated_by='admin-sub', now=NOW)
        client = Lambda()
        started = eng_runs.start_agent_run(env.agents, agent, caller, row, _start(), client=client, function='f',
                                           now=NOW)
        assert started.run is not None
        sent = json.loads(json.loads(client.sent[0]['Payload'])['flow_definition'])
        types = {node['id']: node['type'] for node in sent['nodes']}
        assert 'call_flow' not in types.values()
        assert types['fix.hunt'] == 'agent'
        assert types['fix.pr'] == 'stop_at_pr'
        recorded = [{'step': 'fix', 'flow': called['workflow_id'], 'revision': 1}]
        assert sent['nodes'][0]['data']['params']['expansion'] == recorded
        run = store.get_run(env.agents, agent['agent_id'], started.run['run_id'])
        assert run is not None
        assert store.run_view(run)['expansion'] == recorded


def test_a_flow_whose_call_cannot_be_expanded_never_starts() -> None:
    with agents_env() as env:
        agent, row = _engineering_agent(env)
        caller = _calling_flow(env, 'wf_0123456789ab@4')
        client = Lambda()
        with pytest.raises(ConflictError, match='not a saved revision'):
            eng_runs.start_agent_run(env.agents, agent, caller, row, _start(), client=client, function='f', now=NOW)
        assert client.sent == []
        assert store.list_runs(env.agents, agent['agent_id'], limit=5)[0] == []
        # (read without a reader, its calls stay in: such a flow is refused before the start is asked)
        unexpanded = eng_runs.stored_flow(caller)
        assert (unexpanded.calls, unexpanded.expansion) == (1, ())
        plan = eng_runs.StartPlan(run_id='RUN', workflow_id=caller['workflow_id'], flow=unexpanded,
                                  connection_id='shop', connection=ROW, language='python', goal='g', actor='a')
        with pytest.raises(ConflictError, match='expanded'):
            eng_runs.start_request(plan)
