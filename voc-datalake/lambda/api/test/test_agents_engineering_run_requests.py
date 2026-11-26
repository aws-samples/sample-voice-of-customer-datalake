"""Run requests (7.53.00, "MCP for runs", D53-3; engineering/run_requests.py): the global MCP server's
engineering_run_request asks for a Run now of an enabled automation, and nothing starts until an administrator signed in
confirms it, which runs the automation's Run now as that administrator, or declines it.

* asked only through the MCP tool's claim (an administrator signed in uses Run now itself; anyone else 403), for an
  enabled engineering automation only (404 otherwise), its Run now checked as Run now checks it (400);
* the row records who asked (``via: mcp:<token>``) and for whom (the minter), waits ``pending`` and expires;
* the same Run now is asked once while it waits; a token's and the deployment's waiting requests are capped (429);
* listed, confirmed and declined by an administrator acting for themselves only (the MCP tool gets 403 there);
* a confirm decides the request first (once: a second decision is 409), then runs the Run now with the request's
  issue or PRD as the confirming administrator, and records what came of it; a refused start is recorded too.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
import readiness_fakes
from agents_handler_fixtures import ADMIN, USER, deployment_projects
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from test_agents_engineering_agents import START_FUNCTION, Start

import agents_handler
from engineering.board.test.table import TABLE, create_table
from engineering.run_requests import EXPIRES_HOURS, MAX_PENDING_PER_TOKEN, PK

REQUESTS = '/agents/engineering/requests'


def mcp(op: str = 'run_request', minted: str = 'tok_1') -> dict[str, str]:
    """The claims the global MCP server sends for engineering_run_request (an admin's write token, never an admin)."""
    return {'sub': f'mcp:{minted}', 'cognito:groups': '', 'email': f'mcp:{minted}', 'voc:acting_subject': 'admin-sub',
            'voc:mcp_op': op}


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Any, Start, Any]]:
    """The module on, voc-engineering and voc-agents on moto, a GitHub connection, the start function named; the
    Bug fixer set up and enabled, the Feature builder set up and enabled, Issue triage left off."""
    monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
    monkeypatch.setenv('ENGINEERING_TABLE', TABLE)
    monkeypatch.setenv('ENGINEERING_START_FUNCTION', START_FUNCTION)
    client = Start({})
    monkeypatch.setattr(agents_handler, '_start_client', lambda: client)
    with _api() as agents_env:
        engineering = create_table()
        readiness_fakes.use(monkeypatch, readiness_fakes.ReadyPorts(agents=agents_env.agents))
        agents_env.agents.put_item(Item={
            'pk': 'CONNECTIONS#default', 'sk': 'CONNECTION#shop', 'connection_id': 'shop', 'host': 'github',
            'repository': 'example-org/shop', 'default_branch': 'main', 'credential_set': True, 'version': 1})
        deployment_projects(agents_env, monkeypatch, 'proj_1')
        with patch('shared.aws.get_dynamodb_client', return_value=engineering):
            yield agents_env, client, engineering


def _agents(lambda_context: Any) -> dict[str, dict]:
    status, body = _call(lambda_context, 'GET', '/agents')
    assert status == 200, body
    return {agent['name']: agent for agent in body['items']}


@pytest.fixture
def automations(lambda_context: Any, env: tuple[Any, Start, Any]) -> dict[str, dict]:
    del env   # (the deployment they are set up in)
    agents = _agents(lambda_context)
    for name, language in (('Bug fixer', 'python'), ('Feature builder', 'node')):
        agent = agents[name]
        settings = {**agent['engineering'], 'connection': 'shop', 'language': language}
        assert _call(lambda_context, 'PUT', f"/agents/{agent['agent_id']}", body={'engineering': settings})[0] == 200
        assert _call(lambda_context, 'POST', f"/agents/{agent['agent_id']}/enable")[0] == 200
    return _agents(lambda_context)


def _ask(lambda_context: Any, body: dict, claims: dict | None = None) -> tuple[int, dict]:
    return _call(lambda_context, 'POST', REQUESTS, claims=claims or mcp(), body=body)


def test_a_request_waits_for_an_administrator_who_confirms_it_and_the_run_starts_as_them(
        lambda_context: Any, env: tuple[Any, Start, Any], automations: dict[str, dict]) -> None:
    _, client, engineering = env
    bug = automations['Bug fixer']
    with patch.object(agents_handler, 'logger') as logged:
        status, body = _ask(lambda_context, {'agent_id': bug['agent_id'], 'issue': 7, 'note': ' the paging one '})
    assert status == 202, body
    request = body['request']
    assert (request['status'], request['agent_id'], request['agent_name'], request['issue'], request['note'],
            request['via'], request['requested_for']) == (
        'pending', bug['agent_id'], 'Bug fixer', 7, 'the paging one', 'mcp:tok_1', 'admin-sub')
    logged.info.assert_any_call('engineering: a Run now was asked over MCP', extra={
        'request_id': request['request_id'], 'agent_id': bug['agent_id'], 'via': 'mcp:tok_1', 'for': 'admin-sub'})
    assert client.requests == []   # (nothing has started)
    (row,) = engineering.query(TableName=TABLE, KeyConditionExpression='pk = :pk',
                               ExpressionAttributeValues={':pk': {'S': PK}})['Items']
    assert row['sk']['S'] == f"REQ#{request['request_id']}"
    status, listed = _call(lambda_context, 'GET', REQUESTS)
    assert (status, [item['request_id'] for item in listed['requests']]) == (200, [request['request_id']])

    status, body = _call(lambda_context, 'POST', f"{REQUESTS}/{request['request_id']}/confirm", body={})
    assert status == 202, body
    (start,) = client.requests
    sent = json.loads(start['Payload'])
    assert (sent['actor'], sent['issue'], sent['goal']) == (
        'admin-sub', 7, 'Fix the bug reported in issue #7 of example-org/shop.')
    assert (body['request']['status'], body['request']['decided_by'], body['request']['outcome']) == (
        'confirmed', 'admin-sub', 'started')
    assert body['run']['engineering_run_id'] == sent['run_id'] == body['request']['engineering_run_id']
    status, listed = _call(lambda_context, 'GET', REQUESTS)
    (stored,) = listed['requests']
    assert (stored['status'], stored['outcome'], stored['run_id']) == ('confirmed', 'started', body['run']['run_id'])
    # Once: a second confirm or a decline is 409, and no second run starts.
    for decision in ('confirm', 'decline'):
        status, refused = _call(lambda_context, 'POST', f"{REQUESTS}/{request['request_id']}/{decision}", body={})
        assert (status, refused['error']) == (409, 'this request is confirmed: it can no longer be decided')
    assert len(client.requests) == 1


def test_a_declined_request_starts_nothing(lambda_context: Any, env: tuple[Any, Start, Any],
                                           automations: dict[str, dict]) -> None:
    _, client, _ = env
    status, body = _ask(lambda_context, {'agent_id': automations['Feature builder']['agent_id'],
                                         'prd': {'project_id': 'proj_1', 'document_id': 'prd_1'}})
    assert status == 202, body
    request_id = body['request']['request_id']
    status, declined = _call(lambda_context, 'POST', f'{REQUESTS}/{request_id}/decline', body={})
    assert (status, declined['request']['status'], declined['request']['prd']) == (
        200, 'declined', {'project_id': 'proj_1', 'document_id': 'prd_1'})
    assert _call(lambda_context, 'POST', f'{REQUESTS}/{request_id}/confirm', body={})[0] == 409
    assert client.requests == []


@pytest.mark.usefixtures('automations')
@pytest.mark.parametrize(('method', 'suffix'), [('GET', ''), ('POST', '/REQ1/confirm'), ('POST', '/REQ1/decline')])
def test_the_list_and_the_decisions_are_an_administrators_acting_for_themselves(lambda_context: Any, method: str,
                                                                               suffix: str) -> None:
    for claims in (mcp(), mcp('run_get'), USER):
        assert _call(lambda_context, method, f'{REQUESTS}{suffix}', claims=claims, body={})[0] == 403, claims


def test_only_the_mcp_tool_asks(lambda_context: Any, automations: dict[str, dict]) -> None:
    body = {'agent_id': automations['Bug fixer']['agent_id']}
    status, refused = _ask(lambda_context, body, claims=ADMIN)
    assert (status, 'start it with Run now' in refused['error']) == (400, True)
    for claims in (USER, mcp('run_steer'), {**mcp(), 'voc:acting_subject': ''}):
        assert _ask(lambda_context, body, claims=claims)[0] == 403, claims


@pytest.mark.parametrize(('body', 'status', 'message'), [
    ({'agent_id': 'ag_nope'}, 404, 'No such enabled engineering automation'),
    ({'agent_id': '{issue}'}, 404, 'No such enabled engineering automation'),
    ({}, 400, 'the body is {agent_id, issue? | prd?, note?}'),
    ({'agent_id': 'x', 'issue': 7, 'prd': {}}, 400, 'the body is'),
    ({'agent_id': 'x', 'extra': 1}, 400, 'the body is'),
])
@pytest.mark.usefixtures('automations')
def test_a_request_off_its_shape_or_for_no_automation_is_refused(lambda_context: Any, body: dict, status: int,
                                                                message: str) -> None:
    found, refused = _ask(lambda_context, body)
    assert (found, message in refused['error']) == (status, True)


def test_a_request_is_checked_as_its_run_now_would_be(lambda_context: Any, automations: dict[str, dict]) -> None:
    feature, bug = automations['Feature builder']['agent_id'], automations['Bug fixer']['agent_id']
    status, refused = _ask(lambda_context, {'agent_id': feature})
    assert (status, 'runs on an issue or a PRD' in refused['error']) == (400, True)
    status, refused = _ask(lambda_context, {'agent_id': bug, 'prd': {'project_id': 'p1', 'document_id': 'd1'}})
    assert (status, 'a PRD is built by a feature agent' in refused['error']) == (400, True)
    assert _ask(lambda_context, {'agent_id': bug, 'issue': 0})[0] == 400
    assert _ask(lambda_context, {'agent_id': bug, 'note': 7})[0] == 400


def test_an_automation_that_is_off_or_not_engineering_cannot_be_asked(lambda_context: Any,
                                                                      automations: dict[str, dict]) -> None:
    for name in ('Issue triage', 'Autonomous Product'):
        assert _ask(lambda_context, {'agent_id': automations[name]['agent_id']})[0] == 404, name
    bug = automations['Bug fixer']['agent_id']
    assert _call(lambda_context, 'POST', f'/agents/{bug}/disable')[0] == 200
    assert _ask(lambda_context, {'agent_id': bug})[0] == 404


def test_the_same_run_now_is_asked_once_and_a_token_waits_for_a_few(lambda_context: Any,
                                                                    automations: dict[str, dict]) -> None:
    bug = automations['Bug fixer']['agent_id']
    first = _ask(lambda_context, {'agent_id': bug, 'issue': 1})[1]['request']['request_id']
    status, refused = _ask(lambda_context, {'agent_id': bug, 'issue': 1})
    assert (status, refused['error']) == (409, (f'this Run now is already asked: request {first} waits for an '
                                                 'administrator'))
    for issue in range(2, MAX_PENDING_PER_TOKEN + 1):
        assert _ask(lambda_context, {'agent_id': bug, 'issue': issue})[0] == 202
    status, refused = _ask(lambda_context, {'agent_id': bug, 'issue': 99})
    assert (status, 'already has 3 run requests waiting' in refused['error']) == (429, True)
    # Another token of the same administrator's has its own room.
    assert _ask(lambda_context, {'agent_id': bug, 'issue': 99}, claims=mcp(minted='tok_2'))[0] == 202


def test_an_expired_request_reads_expired_and_cannot_be_confirmed(lambda_context: Any, env: tuple[Any, Start, Any],
                                                                  automations: dict[str, dict]) -> None:
    _, client, engineering = env
    request_id = _ask(lambda_context, {'agent_id': automations['Bug fixer']['agent_id']})[1]['request']['request_id']
    engineering.update_item(TableName=TABLE, Key={'pk': {'S': PK}, 'sk': {'S': f'REQ#{request_id}'}},
                            UpdateExpression='SET expires_at = :past',
                            ExpressionAttributeValues={':past': {'S': '2020-01-01T00:00:00Z'}})
    assert _call(lambda_context, 'GET', REQUESTS)[1]['requests'][0]['status'] == 'expired'
    status, refused = _call(lambda_context, 'POST', f'{REQUESTS}/{request_id}/confirm', body={})
    assert (status, refused['error']) == (409, 'this request is expired: it can no longer be decided')
    assert client.requests == []
    assert EXPIRES_HOURS == 24


def test_a_refused_start_is_recorded_on_the_request(lambda_context: Any, env: tuple[Any, Start, Any],
                                                   automations: dict[str, dict]) -> None:
    _, client, _ = env
    request_id = _ask(lambda_context, {'agent_id': automations['Bug fixer']['agent_id'],
                                       'issue': 7})[1]['request']['request_id']
    client.function_error = 'Unhandled'
    client.payload = {'errorType': 'RuntimeRefused', 'errorMessage': 'issue #7 of example-org/shop is closed'}
    status, refused = _call(lambda_context, 'POST', f'{REQUESTS}/{request_id}/confirm', body={})
    assert (status, refused['error']) == (409, 'issue #7 of example-org/shop is closed')
    (stored,) = _call(lambda_context, 'GET', REQUESTS)[1]['requests']
    assert (stored['status'], stored['outcome']) == ('confirmed', 'refused: issue #7 of example-org/shop is closed')


def test_a_prd_that_is_not_one_of_the_deployments_projects_is_neither_asked_nor_run(
        lambda_context: Any, env: tuple[Any, Start, Any], automations: dict[str, dict]) -> None:
    """7.80.00 (3g3-a): a request names a PRD of the deployment's own projects only, as Run now does: a workspace's
    project (its rows and its id's claim) or no project is 404 and nothing is asked; a project deleted after the ask is
    refused at the confirm, recorded on the request, and nothing starts."""
    _, client, engineering = env
    feature = automations['Feature builder']['agent_id']
    projects = agents_handler.get_projects_table()
    projects.put_item(Item={'pk': 'WS#ws_0123456789abcdef#PROJECT#proj_ws', 'sk': 'META'})
    projects.put_item(Item={'pk': 'PROJECT_ID#proj_ws', 'sk': 'CLAIM', 'workspace_id': 'ws_0123456789abcdef'})
    for project_id in ('proj_ws', 'proj_none'):
        status, refused = _ask(lambda_context, {'agent_id': feature,
                                                'prd': {'project_id': project_id, 'document_id': 'prd_1'}})
        assert (status, refused['error']) == (404, agents_handler.PRD_PROJECT_NOT_FOUND)
    assert engineering.query(TableName=TABLE, KeyConditionExpression='pk = :pk',
                             ExpressionAttributeValues={':pk': {'S': PK}})['Items'] == []
    status, body = _ask(lambda_context, {'agent_id': feature, 'prd': {'project_id': 'proj_1', 'document_id': 'prd_1'}})
    assert status == 202, body
    projects.update_item(Key={'pk': 'PROJECT#proj_1', 'sk': 'META'}, UpdateExpression='SET deletion_started_at = :at',
                         ExpressionAttributeValues={':at': '2026-11-01T00:00:00Z'})
    status, refused = _call(lambda_context, 'POST', f"{REQUESTS}/{body['request']['request_id']}/confirm", body={})
    assert (status, refused['error'], client.requests) == (404, agents_handler.PRD_PROJECT_NOT_FOUND, [])
    (stored,) = _call(lambda_context, 'GET', REQUESTS)[1]['requests']
    assert stored['outcome'] == f'refused: {agents_handler.PRD_PROJECT_NOT_FOUND}'


@pytest.mark.usefixtures('automations')
def test_an_unknown_request_is_404(lambda_context: Any) -> None:
    for decision in ('confirm', 'decline'):
        assert _call(lambda_context, 'POST', f'{REQUESTS}/01JDZZZZZZZZZZZZZZZZZZZZZZ/{decision}', body={})[0] == 404
        assert _call(lambda_context, 'POST', f'{REQUESTS}/a.b/{decision}', body={})[0] == 404


def test_the_automations_a_request_may_name(lambda_context: Any, automations: dict[str, dict]) -> None:
    status, body = _call(lambda_context, 'GET', f'{REQUESTS}/automations', claims=mcp())
    assert status == 200, body
    assert body['automations'] == [
        {'agent_id': automations['Bug fixer']['agent_id'], 'name': 'Bug fixer', 'kind': 'bug',
         'repository': 'example-org/shop', 'takes': ['issue', 'none']},
        {'agent_id': automations['Feature builder']['agent_id'], 'name': 'Feature builder', 'kind': 'feature_request',
         'repository': 'example-org/shop', 'takes': ['issue', 'prd']}]
    assert _call(lambda_context, 'GET', f'{REQUESTS}/automations')[0] == 200
    assert _call(lambda_context, 'GET', f'{REQUESTS}/automations', claims=mcp('run_get'))[0] == 403


@pytest.mark.usefixtures('automations')
def test_while_the_module_is_off_every_request_route_is_404(lambda_context: Any,
                                                            monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('ENGINEERING_AGENTS', 'off')
    assert _call(lambda_context, 'GET', REQUESTS)[0] == 404
    assert _call(lambda_context, 'GET', f'{REQUESTS}/automations', claims=mcp())[0] == 404
    assert _ask(lambda_context, {'agent_id': 'x'})[0] == 404
    assert _call(lambda_context, 'POST', f'{REQUESTS}/REQ1/confirm', body={})[0] == 404
