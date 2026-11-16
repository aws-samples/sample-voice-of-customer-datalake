"""Engineering agents in the Agents API (7.47.00): the seeded Bug fixer and Feature builder, their settings and their
set-up, who they run as, and Run now through voc-engineering-start (docs/autonomous-agents.md "Engineering agents")."""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest
import readiness_fakes
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call

import agents_handler
from engineering.test.run_fixture import LambdaClient
from shared import agents_store as store

START_FUNCTION = 'voc-engineering-start'
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}


class Start(LambdaClient):
    """voc-engineering-start: it answers each start for the run it names, unless told to fail."""

    def invoke(self, **request: Any) -> dict[str, Any]:
        if not self.function_error:
            self.payload = {'run_id': json.loads(request['Payload'])['run_id'], 'status': 'active'}
        return super().invoke(**request)


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Any, Start]]:
    """The module on, the start function named, a GitHub, a private GitHub and a GitLab connection (every test's)."""
    monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
    monkeypatch.setenv('ENGINEERING_TABLE', 'voc-engineering')
    monkeypatch.setenv('ENGINEERING_START_FUNCTION', START_FUNCTION)
    client = Start({})
    monkeypatch.setattr(agents_handler, '_start_client', lambda: client)
    with _api() as agents_env:
        # Every readiness check ready (7.50.00: Enable runs the required ones; test_agents_engineering_readiness.py)
        readiness_fakes.use(monkeypatch, readiness_fakes.ReadyPorts(agents=agents_env.agents))
        for connection, repository, host, private in (('shop', 'example-org/shop', 'github', False),
                                                      ('inside', 'example-org/inside', 'github', True),
                                                      ('lab', 'example-org/payments/shop', 'gitlab', False)):
            agents_env.agents.put_item(Item={
                'pk': 'CONNECTIONS#default', 'sk': f'CONNECTION#{connection}', 'connection_id': connection,
                'host': host, 'repository': repository, 'default_branch': 'main', 'credential_set': True,
                'version': 1, **({'repository_private': True} if private else {})})
        yield agents_env, client


def _seeded(lambda_context: Any, claims: dict = ADMIN, **kwargs: Any) -> dict[str, dict]:
    status, body = _call(lambda_context, 'GET', '/agents', claims=claims, **kwargs)
    assert status == 200, body
    return {agent['name']: agent for agent in body['items']}


def _set_up(lambda_context: Any, agent: dict, **engineering: Any) -> tuple[int, dict]:
    settings = {'connection': 'shop', 'language': 'python', **engineering}
    return _call(lambda_context, 'PUT', f"/agents/{agent['agent_id']}",
                 body={'engineering': {**agent['engineering'], **settings}})


def test_an_admin_listing_seeds_the_engineering_agents_beside_autonomous_product(
        lambda_context: Any) -> None:
    agents = _seeded(lambda_context)
    assert sorted(agents) == ['Autonomous Product', 'Bug fixer', 'Feature builder', 'Issue triage']
    assert (agents['Bug fixer']['enabled'], agents['Bug fixer']['engineering']['feedback_type']) == (False, 'bug')
    # Inside a workspace the page lists them too: agents are the deployment's until phase 3g3.
    in_workspace = _seeded(lambda_context, headers={'X-Workspace-Id': 'ws_0123456789abcdef'})
    assert sorted(in_workspace) == sorted(agents)


def test_engineering_agents_are_an_administrators_alone(lambda_context: Any) -> None:
    bug = _seeded(lambda_context)['Bug fixer']
    assert 'Bug fixer' not in _seeded(lambda_context, claims=USER)
    assert _call(lambda_context, 'GET', f"/agents/{bug['agent_id']}", claims=USER)[0] == 404
    assert _call(lambda_context, 'GET', f"/agents/{bug['agent_id']}/runs", claims=USER)[0] == 404


def test_without_the_module_they_are_neither_seeded_nor_listed(lambda_context: Any,
                                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    bug = _seeded(lambda_context)['Bug fixer']
    monkeypatch.setenv('ENGINEERING_AGENTS', 'off')
    assert sorted(_seeded(lambda_context)) == ['Autonomous Product']
    assert _call(lambda_context, 'GET', f"/agents/{bug['agent_id']}")[0] == 404
    status, body = _call(lambda_context, 'PUT', f"/agents/{bug['agent_id']}", body={'description': 'x'})
    assert (status, 'engineering agents module' in body['error']) == (400, True)


@pytest.mark.parametrize(('change', 'message'), [
    ({'connection': 'gone'}, 'names no stored repository connection'),
    ({'language': 'cobol'}, 'engineering.language is one of'),
    ({'connection': 'lab'}, 'a github_issue trigger needs a GitHub connection'),
])
def test_settings_off_their_rule_are_refused(lambda_context: Any, change: dict,
                                             message: str) -> None:
    status, body = _set_up(lambda_context, _seeded(lambda_context)['Bug fixer'], **change)
    assert status == 400
    assert message in body['error']


def test_an_issue_label_is_mandatory_on_a_public_repository(lambda_context: Any) -> None:
    bug = _seeded(lambda_context)['Bug fixer']
    unlabelled = [{**bug['triggers'][0], 'label': ''}, bug['triggers'][1]]
    path = f"/agents/{bug['agent_id']}"
    public = {'triggers': unlabelled, 'engineering': {**bug['engineering'], 'connection': 'shop'}}
    status, body = _call(lambda_context, 'PUT', path, body=public)
    assert status == 400
    assert 'needs its label on a public repository' in body['error']
    private = {'triggers': unlabelled, 'engineering': {**bug['engineering'], 'connection': 'inside'}}
    assert _call(lambda_context, 'PUT', path, body=private)[0] == 200


def test_enabling_needs_the_set_up_and_records_who_the_agent_runs_as(lambda_context: Any) -> None:
    bug = _seeded(lambda_context)['Bug fixer']
    status, body = _call(lambda_context, 'POST', f"/agents/{bug['agent_id']}/enable")
    assert status == 400
    assert 'set the agent up first' in body['error']
    assert _set_up(lambda_context, bug)[0] == 200
    status, body = _call(lambda_context, 'POST', f"/agents/{bug['agent_id']}/enable")
    assert status == 200, body
    assert (body['agent']['enabled'], body['agent']['owner_sub'], body['agent']['owner_username']) == (
        True, 'admin-sub', 'alice')
    status, body = _call(lambda_context, 'PUT', f"/agents/{bug['agent_id']}", body={'owner_sub': 'someone-else'})
    assert status == 400
    assert 'runs as the administrator who enabled it' in body['error']
    status, body = _call(lambda_context, 'PUT', f"/agents/{bug['agent_id']}", body={'workflow_id': 'wf_default'})
    assert status == 400
    assert 'an engineering agent runs an engineering flow' in body['error']


def test_run_now_of_an_issue_starts_an_engineering_run_as_the_admin_and_claims_the_issue(
        lambda_context: Any, env: tuple[Any, Start]) -> None:
    agents_env, client = env
    bug = _seeded(lambda_context)['Bug fixer']
    assert _set_up(lambda_context, bug)[0] == 200
    status, body = _call(lambda_context, 'POST', f"/agents/{bug['agent_id']}/run", body={'issue': 7})
    assert status == 202, body
    run = body['run']
    assert (run['kind'], run['status'], run['trigger'], run['issue']) == (
        'engineering', 'running', 'manual', {'repository': 'example-org/shop', 'number': 7})
    (request,) = client.requests
    sent = json.loads(request['Payload'])
    assert (sent['run_id'], sent['actor'], sent['goal'], sent['resolve_commit'], sent['hard_cap'], sent['commit']) == (
        run['engineering_run_id'], 'admin-sub', 'Fix the bug reported in issue #7 of example-org/shop.', True, True, '')
    assert (sent['budget_usd'], sent['issue'], sent['host'], sent['repo']) == (50.0, 7, 'github', 'example-org/shop')
    assert sent['via'] == {'agent_id': bug['agent_id'], 'agent_run_id': run['run_id'], 'trigger': 'manual'}
    assert store.issue_claimed(agents_env.agents, 'example-org/shop', 7)
    # Its run is stopped from its run monitor, not here.
    status, body = _call(lambda_context, 'POST', f"/agents/{bug['agent_id']}/runs/{run['run_id']}/cancel")
    assert status == 409
    assert 'stop it from its run monitor' in body['error']


def test_run_now_needs_an_admin_acting_for_themselves_and_the_set_up(lambda_context: Any) -> None:
    bug = _seeded(lambda_context)['Bug fixer']
    path = f"/agents/{bug['agent_id']}/run"
    assert _call(lambda_context, 'POST', path, body={'issue': 7})[0] == 409   # (not set up)
    assert _set_up(lambda_context, bug)[0] == 200
    assert _call(lambda_context, 'POST', path, claims=DELEGATED_ADMIN, body={'issue': 7})[0] == 403
    assert _call(lambda_context, 'POST', path, claims=USER, body={'issue': 7})[0] == 403
    assert _call(lambda_context, 'POST', path, body={'issue': 7, 'prd': {}})[0] == 400
    status, body = _call(lambda_context, 'POST', path, body={'prd': {'project_id': 'p1', 'document_id': 'd1'}})
    assert status == 400
    assert 'a PRD is built by a feature agent' in body['error']


def test_a_feature_agent_builds_from_an_issue_or_a_prd(lambda_context: Any, env: tuple[Any, Start]) -> None:
    _, client = env
    feature = _seeded(lambda_context)['Feature builder']
    assert _set_up(lambda_context, feature, language='node')[0] == 200
    path = f"/agents/{feature['agent_id']}/run"
    status, body = _call(lambda_context, 'POST', path)
    assert status == 400
    assert 'runs on an issue or a PRD' in body['error']
    status, body = _call(lambda_context, 'POST', path, body={'prd': {'project_id': 'proj_1', 'document_id': 'prd_1'}})
    assert status == 202, body
    assert body['run']['prd'] == {'project_id': 'proj_1', 'document_id': 'prd_1'}
    sent = json.loads(client.requests[-1]['Payload'])
    assert (sent['goal'], sent['prd'], 'issue' in sent) == (
        'Build the feature the PRD prd_1 of project proj_1 describes.', {'project_id': 'proj_1',
                                                                         'document_id': 'prd_1'}, False)


def test_a_refused_start_is_409_and_fails_the_agents_run(lambda_context: Any, env: tuple[Any, Start]) -> None:
    agents_env, client = env
    bug = _seeded(lambda_context)['Bug fixer']
    assert _set_up(lambda_context, bug)[0] == 200
    client.function_error = 'Unhandled'
    client.payload = {'errorType': 'RuntimeRefused', 'errorMessage': 'issue #7 of example-org/shop is closed'}
    status, body = _call(lambda_context, 'POST', f"/agents/{bug['agent_id']}/run", body={'issue': 7})
    assert (status, body['error']) == (409, 'issue #7 of example-org/shop is closed')
    (run,) = store.list_runs(agents_env.agents, bug['agent_id'], limit=5)[0]
    assert (run['status'], run['error']) == ('failed', 'issue #7 of example-org/shop is closed')


def test_a_start_that_may_have_written_names_the_engineering_run(lambda_context: Any, env: tuple[Any, Start]) -> None:
    agents_env, client = env
    bug = _seeded(lambda_context)['Bug fixer']
    assert _set_up(lambda_context, bug)[0] == 200
    client.function_error = 'Unhandled'
    client.payload = {'errorType': 'StartFailed', 'errorMessage': 'run X was started: open its run monitor'}
    status, body = _call(lambda_context, 'POST', f"/agents/{bug['agent_id']}/run")
    (run,) = store.list_runs(agents_env.agents, bug['agent_id'], limit=5)[0]
    assert (status, body['run_id'], run['status']) == (503, run['engineering_run_id'], 'running')


@pytest.mark.parametrize(('feedback_type', 'required', 'ok'), [
    ('bug', 'bug', True), ('bug', 'feature', False), ('feature_request', 'feature', True),
    ('feature_request', 'bug', False)])
def test_an_act_trigger_requires_the_triage_of_its_own_agents_kind(lambda_context: Any, feedback_type: str,
                                                                    required: str, ok: bool) -> None:
    # (7.50.00: a Bug fixer waits for an issue triaged as a bug, a Feature builder for one triaged as a feature)
    bug = _seeded(lambda_context)['Bug fixer']
    triggers = [{**bug['triggers'][0], 'requires_triage': required}, bug['triggers'][1]]
    body = {'triggers': triggers, 'engineering': {**bug['engineering'], 'connection': 'shop',
                                                  'feedback_type': feedback_type}}
    status, answer = _call(lambda_context, 'PUT', f"/agents/{bug['agent_id']}", body=body)
    assert status == (200 if ok else 400), answer
    if ok:
        assert answer['agent']['triggers'][0]['requires_triage'] == required
    else:
        assert "requires_triage is the triage of the agent's own kind" in answer['error']


def test_run_now_of_a_triage_agent_triages_the_issue_under_its_own_claim(lambda_context: Any,
                                                                          env: tuple[Any, Start]) -> None:
    agents_env, client = env
    triage = _seeded(lambda_context)['Issue triage']
    assert triage['triggers'][0]['stage'] == 'triage'   # (its seed's issue trigger)
    path = f"/agents/{triage['agent_id']}"
    status, body = _call(lambda_context, 'PUT', path, body={
        'engineering': {**triage['engineering'], 'connection': 'shop', 'language': 'python'}})
    assert status == 200, body
    status, body = _call(lambda_context, 'POST', f'{path}/run', body={'issue': 7})
    assert status == 202, body
    (request,) = client.requests
    assert json.loads(request['Payload'])['goal'].startswith('Triage issue #7 of example-org/shop')
    assert store.issue_claimed(agents_env.agents, 'example-org/shop', 7, 'triage')
    assert not store.issue_claimed(agents_env.agents, 'example-org/shop', 7)
