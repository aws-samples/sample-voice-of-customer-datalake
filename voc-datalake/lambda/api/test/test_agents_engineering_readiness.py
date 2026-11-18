"""Readiness in the Agents API (7.50.00, engineering/readiness.py): ``GET /agents/engineering/readiness`` for an
engineering agent or a flow template, administrators acting for themselves only, and Engineering Enable's 409."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
import readiness_fakes
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call

from engineering.readiness import CHECK_IDS, REQUIRED

PATH = '/agents/engineering/readiness'
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Any, readiness_fakes.ReadyPorts]]:
    """The module on, one stored GitHub connection, and the readiness ports all ready (each test changes them)."""
    monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
    monkeypatch.setenv('ENGINEERING_TABLE', 'voc-engineering')
    with _api() as agents_env:
        agents_env.agents.put_item(Item={
            'pk': 'CONNECTIONS#default', 'sk': 'CONNECTION#shop', 'connection_id': 'shop', 'host': 'github',
            'repository': 'example-org/shop', 'default_branch': 'main', 'credential_set': True, 'version': 1})
        ports = readiness_fakes.ReadyPorts(agents=agents_env.agents)
        readiness_fakes.use(monkeypatch, ports)
        yield agents_env, ports


def _bug_fixer(lambda_context: Any) -> dict[str, Any]:
    status, body = _call(lambda_context, 'GET', '/agents')
    assert status == 200, body
    return next(agent for agent in body['items'] if agent['name'] == 'Bug fixer')


def _set_up(lambda_context: Any, agent: dict[str, Any]) -> None:
    settings = {**agent['engineering'], 'connection': 'shop', 'language': 'python'}
    status, body = _call(lambda_context, 'PUT', f"/agents/{agent['agent_id']}", body={'engineering': settings})
    assert status == 200, body


def test_an_agents_readiness_answers_every_check(lambda_context: Any) -> None:
    bug = _bug_fixer(lambda_context)
    _set_up(lambda_context, bug)
    status, body = _call(lambda_context, 'GET', PATH, query={'automation': bug['agent_id']})
    assert status == 200, body
    assert body['ready'] is True
    assert body['subject'] == {'kind': 'automation', 'id': bug['agent_id'], 'name': 'Bug fixer', 'connection': 'shop',
                               'language': 'python'}
    assert [check['id'] for check in body['checks']] == list(CHECK_IDS)
    assert {check['id'] for check in body['checks'] if check['required']} == REQUIRED


def test_an_agent_not_set_up_is_not_ready(lambda_context: Any) -> None:
    bug = _bug_fixer(lambda_context)
    status, body = _call(lambda_context, 'GET', PATH, query={'automation': bug['agent_id']})
    assert status == 200
    assert body['ready'] is False
    failing = {check['id'] for check in body['checks'] if check['required'] and check['status'] != 'pass'}
    assert {'connection', 'image'} <= failing


def test_a_flow_templates_readiness_on_a_connection(lambda_context: Any) -> None:
    status, body = _call(lambda_context, 'GET', PATH,
                         query={'flow': 'bug-hunt-and-fix', 'connection': 'shop', 'language': 'python'})
    assert status == 200, body
    assert body['subject']['kind'] == 'flow'
    # (a template's budget is its bundle entry's; one with none says a saved flow needs it)
    assert {check['id'] for check in body['checks'] if check['required'] and check['status'] != 'pass'} <= {'budget'}
    status, body = _call(lambda_context, 'GET', PATH, query={'flow': 'bug-hunt-and-fix'})
    assert (status, body['ready']) == (200, False)   # (no connection nor language named)
    failing = {check['id'] for check in body['checks'] if check['required'] and check['status'] != 'pass'}
    assert {'connection', 'image'} <= failing


@pytest.mark.parametrize('query', [None, {'automation': 'agent_x', 'flow': 'issue-triage'},
                                   {'flow': 'issue-triage', 'connection': 'not a connection'},
                                   {'flow': 'issue-triage', 'language': 'cobol'}])
def test_a_readiness_question_off_its_shape_is_a_400(lambda_context: Any, query: dict[str, str] | None) -> None:
    assert _call(lambda_context, 'GET', PATH, query=query)[0] == 400


def test_an_unknown_template_or_agent_is_a_404_and_an_agents_agent_a_400(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', PATH, query={'flow': 'no-such-flow'})[0] == 404
    assert _call(lambda_context, 'GET', PATH, query={'automation': 'agent_missing'})[0] == 404
    _, body = _call(lambda_context, 'GET', '/agents')
    product = next(agent for agent in body['items'] if agent['name'] == 'Autonomous Product')
    assert _call(lambda_context, 'GET', PATH, query={'automation': product['agent_id']})[0] == 400


def test_readiness_is_an_administrators_acting_for_themselves(lambda_context: Any,
                                                              monkeypatch: pytest.MonkeyPatch) -> None:
    query = {'flow': 'issue-triage'}
    assert _call(lambda_context, 'GET', PATH, claims=USER, query=query)[0] == 403
    assert _call(lambda_context, 'GET', PATH, claims=DELEGATED_ADMIN, query=query)[0] == 403
    assert _call(lambda_context, 'GET', PATH, claims=ADMIN, query=query)[0] == 200
    monkeypatch.delenv('ENGINEERING_AGENTS')
    assert _call(lambda_context, 'GET', PATH, query=query)[0] == 404


def test_enable_answers_409_with_the_failing_required_checks(lambda_context: Any,
                                                             env: tuple[Any, readiness_fakes.ReadyPorts]) -> None:
    _, ports = env
    bug = _bug_fixer(lambda_context)
    _set_up(lambda_context, bug)
    ports.modes['admin-sub'] = 'human_driven'   # (no stored AI-assisted or AI-driven way of working)
    ports.attestation = False
    status, body = _call(lambda_context, 'POST', f"/agents/{bug['agent_id']}/enable")
    assert status == 409, body
    assert 'not ready to run' in body['error']
    assert [check['id'] for check in body['checks']] == ['ci_attestation', 'dial']
    assert all(check['required'] and check['status'] == 'fail' for check in body['checks'])
    # The same for an update that turns it on; nothing was written.
    status, body = _call(lambda_context, 'PUT', f"/agents/{bug['agent_id']}", body={'enabled': True})
    assert status == 409
    assert _call(lambda_context, 'GET', f"/agents/{bug['agent_id']}")[1]['agent']['enabled'] is False
    ports.modes['admin-sub'] = 'ai_driven'
    ports.attestation = True
    status, body = _call(lambda_context, 'POST', f"/agents/{bug['agent_id']}/enable")
    assert status == 200, body
    assert body['agent']['enabled'] is True


def test_an_advisory_check_never_refuses_enable(lambda_context: Any,
                                                env: tuple[Any, readiness_fakes.ReadyPorts],
                                                monkeypatch: pytest.MonkeyPatch) -> None:
    _, ports = env
    bug = _bug_fixer(lambda_context)
    _set_up(lambda_context, bug)
    monkeypatch.setattr(ports, 'session_quota', lambda: 1.0)   # (the AgentCore quota: advice)
    monkeypatch.setattr(ports, 'issues_source_reads', lambda _repository: False)
    status, body = _call(lambda_context, 'POST', f"/agents/{bug['agent_id']}/enable")
    assert status == 200, body


# ── 7.50.01: the Set up dialog's preview (``connection`` and ``language`` on an automation) ──────────────────────


def _store_sandbox(agents: Any) -> None:
    agents.put_item(Item={
        'pk': 'CONNECTIONS#default', 'sk': 'CONNECTION#voc-agents-sandbox', 'connection_id': 'voc-agents-sandbox',
        'host': 'github', 'repository': 'example-org/voc-agents-sandbox', 'default_branch': 'main',
        'credential_set': True, 'version': 1})


def _attested_sandbox(env: tuple[Any, readiness_fakes.ReadyPorts]) -> None:
    """The sandbox's connection stored, and the one connection whose CI an administrator attested."""
    agents_env, ports = env
    _store_sandbox(agents_env.agents)
    ports.attested_connections = frozenset({'voc-agents-sandbox'})


def _statuses(body: dict[str, Any]) -> dict[str, str]:
    return {check['id']: check['status'] for check in body['checks']}


def test_a_preview_answers_for_the_selected_connection_and_language(
        lambda_context: Any, env: tuple[Any, readiness_fakes.ReadyPorts]) -> None:
    _attested_sandbox(env)
    bug = _bug_fixer(lambda_context)   # (not set up: no connection, no language)
    status, body = _call(lambda_context, 'GET', PATH, query={'automation': bug['agent_id']})
    assert status == 200, body
    assert (_statuses(body)['connection'], _statuses(body)['ci_attestation']) == ('fail', 'fail')
    status, body = _call(lambda_context, 'GET', PATH, query={
        'automation': bug['agent_id'], 'connection': 'voc-agents-sandbox', 'language': 'python'})
    assert status == 200, body
    assert body['subject'] == {'kind': 'automation', 'id': bug['agent_id'], 'name': 'Bug fixer',
                               'connection': 'voc-agents-sandbox', 'language': 'python'}
    found = _statuses(body)
    assert (found['connection'], found['ci_attestation'], found['image'], found['app_installation']) == (
        'pass', 'pass', 'pass', 'pass')
    attestation = next(check for check in body['checks'] if check['id'] == 'ci_attestation')
    assert 'example-org/voc-agents-sandbox' in attestation['detail']
    assert body['ready'] is True
    # Read-only: the agent is as it was, and Enable reads what is stored.
    agent = _call(lambda_context, 'GET', f"/agents/{bug['agent_id']}")[1]['agent']
    assert (agent['engineering']['connection'], agent['engineering']['language']) == (None, None)


def test_a_preview_on_a_connection_not_attested_fails_its_ci_attestation(
        lambda_context: Any, env: tuple[Any, readiness_fakes.ReadyPorts]) -> None:
    _attested_sandbox(env)
    bug = _bug_fixer(lambda_context)
    _set_up(lambda_context, bug)   # (stored on shop, which is not attested)
    query = {'automation': bug['agent_id']}
    assert _statuses(_call(lambda_context, 'GET', PATH, query=query)[1])['ci_attestation'] == 'fail'
    previewed = _call(lambda_context, 'GET', PATH, query={**query, 'connection': 'voc-agents-sandbox'})[1]
    assert (_statuses(previewed)['ci_attestation'], previewed['subject']['language']) == ('pass', 'python')


@pytest.mark.parametrize('query', [{'connection': 'gone'}, {'connection': 'removed'}, {'connection': 'not a connection'},
                                   {'language': 'cobol'}, {'connection': 'voc-agents-sandbox', 'language': 'cobol'}])
def test_a_preview_names_a_stored_connection_and_a_language_with_an_image(
        lambda_context: Any, env: tuple[Any, readiness_fakes.ReadyPorts], query: dict[str, str]) -> None:
    agents_env, _ = env
    _store_sandbox(agents_env.agents)
    agents_env.agents.put_item(Item={
        'pk': 'CONNECTIONS#default', 'sk': 'CONNECTION#removed', 'connection_id': 'removed', 'host': 'github',
        'repository': 'example-org/removed', 'default_branch': 'main', 'removed': True, 'version': 2})
    bug = _bug_fixer(lambda_context)
    status, body = _call(lambda_context, 'GET', PATH, query={'automation': bug['agent_id'], **query})
    assert status == 400, body
    # (the same for a flow template)
    assert _call(lambda_context, 'GET', PATH, query={'flow': 'bug-hunt-and-fix', **query})[0] == 400


def test_a_preview_whose_connection_cannot_be_read_is_a_503(
        lambda_context: Any, env: tuple[Any, readiness_fakes.ReadyPorts], monkeypatch: pytest.MonkeyPatch) -> None:
    from engineering.readiness import ReadFailed

    _, ports = env
    bug = _bug_fixer(lambda_context)

    def unreadable(connection_id: str) -> None:
        raise ReadFailed(f'the connection {connection_id} could not be read')

    monkeypatch.setattr(ports, 'connection', unreadable)
    assert _call(lambda_context, 'GET', PATH, query={'automation': bug['agent_id'], 'connection': 'shop'})[0] == 503


def test_a_preview_is_an_administrators_acting_for_themselves(lambda_context: Any) -> None:
    bug = _bug_fixer(lambda_context)
    query = {'automation': bug['agent_id'], 'connection': 'shop', 'language': 'python'}
    assert _call(lambda_context, 'GET', PATH, claims=USER, query=query)[0] == 403
    assert _call(lambda_context, 'GET', PATH, claims=DELEGATED_ADMIN, query=query)[0] == 403
    assert _call(lambda_context, 'GET', PATH, claims=ADMIN, query=query)[0] == 200


def test_the_dial_check_names_the_person_and_the_ways_of_working(
        lambda_context: Any, env: tuple[Any, readiness_fakes.ReadyPorts]) -> None:
    _, ports = env
    bug = _bug_fixer(lambda_context)
    ports.modes['admin-sub'] = 'human_driven'
    _, body = _call(lambda_context, 'GET', PATH, claims=ADMIN, query={'automation': bug['agent_id']})
    dial = next(check for check in body['checks'] if check['id'] == 'dial')
    username = ADMIN['cognito:username']
    assert dial['detail'] == (f'The runs follow {username}, whose way of working is Human-driven, so a run would push '
                              'nothing. This flow needs AI-assisted or AI-driven.')
    assert f'the way of working of {username} to AI-assisted or AI-driven' in dial['fix']
