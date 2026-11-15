"""Engineering flows (voc-workflow/2) in the workflow library: saved and validated like any workflow, but never run by
an agent (the agents' interpreter runs voc-workflow/1), a workflow never changes kind, and a NEW one is created only
where the engineering agents module is deployed (one already saved keeps working without it)."""
from __future__ import annotations

from typing import Any

import pytest
from agents_handler_fixtures import USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from agents_handler_fixtures import create as _create

from shared import workflow_schema
from shared.test.agents_fixtures import agent_body
from shared.test.test_workflow_engineering import bug_fix

#: An MCP credential an administrator minted: delegated (``voc:acting_subject``), so never an administrator.
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}


@pytest.fixture(autouse=True)
def _module_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """The deployment has the engineering agents module (``shared.engineering_agents``)."""
    monkeypatch.setenv('ENGINEERING_AGENTS', 'on')


def _save_engineering_flow(lambda_context: Any) -> str:
    status, body = _call(lambda_context, 'POST', '/workflows', body={'definition': bug_fix()})
    assert status == 201, body
    return body['workflow']['workflow_id']


def _rename(lambda_context: Any, workflow_id: str) -> int:
    """Save the engineering flow's first revision again with a new name: the status."""
    renamed = {**bug_fix(), 'name': 'Renamed flow'}
    return _call(lambda_context, 'PUT', f'/workflows/{workflow_id}', body={'definition': renamed, 'expected_revision': 1})[0]


def test_an_engineering_flow_is_validated_and_kept_in_the_library(lambda_context: Any) -> None:
    with _api():
        status, body = _call(lambda_context, 'POST', '/workflows/validate', body={'definition': bug_fix()})
        assert (status, body['valid'], body['warnings']) == (200, True, [])   # the agents' methodology is not its own
        workflow_id = _save_engineering_flow(lambda_context)
        status, body = _call(lambda_context, 'GET', f'/workflows/{workflow_id}')
        assert (status, body['workflow']['definition']['schema']) == (200, workflow_schema.SCHEMA_V2)
        # In the library, with its kind (the editor opens it; an agent's picker leaves it out).
        kinds = {w['workflow_id']: w['kind'] for w in _call(lambda_context, 'GET', '/workflows')[1]['items']}
        assert (kinds[workflow_id], kinds['wf_default']) == ('engineering', 'agents')


def test_an_agent_cannot_run_an_engineering_flow(lambda_context: Any) -> None:
    with _api():
        workflow_id = _save_engineering_flow(lambda_context)
        status, body = _call(lambda_context, 'POST', '/agents', body=agent_body(workflow_id=workflow_id))
        assert status == 400
        assert 'an engineering flow is not run by an agent' in body['error']
        agent = _create(lambda_context)
        status, body = _call(lambda_context, 'PUT', f"/agents/{agent['agent_id']}",
                             body=agent_body(workflow_id=workflow_id))
        assert status == 400


def test_an_agents_workflow_whose_step_settings_name_the_other_schema_is_still_an_agents_workflow(
        lambda_context: Any) -> None:
    definition = workflow_schema.default_template()
    definition['nodes'][1]['data']['params'] = {'schema': workflow_schema.SCHEMA_V2}
    with _api():
        status, body = _call(lambda_context, 'POST', '/workflows', body={'definition': definition})
        assert status == 201, body
        workflow_id = body['workflow']['workflow_id']
        kinds = {w['workflow_id']: w['kind'] for w in _call(lambda_context, 'GET', '/workflows')[1]['items']}
        assert kinds[workflow_id] == 'agents'
        assert _call(lambda_context, 'POST', '/agents', body=agent_body(workflow_id=workflow_id))[0] == 201


def test_a_workflow_keeps_its_kind(lambda_context: Any) -> None:
    with _api():
        engineering_id = _save_engineering_flow(lambda_context)
        status, body = _call(lambda_context, 'PUT', f'/workflows/{engineering_id}',
                             body={'definition': workflow_schema.default_template(), 'expected_revision': 1})
        assert (status, 'a workflow keeps its kind' in body['error']) == (400, True)
        status, body = _call(lambda_context, 'POST', '/workflows',
                             body={'definition': workflow_schema.default_template()})
        assert status == 201, body
        agents_id = body['workflow']['workflow_id']
        status, body = _call(lambda_context, 'PUT', f'/workflows/{agents_id}',
                             body={'definition': bug_fix(), 'expected_revision': 1})
        assert status == 400
        status, body = _call(lambda_context, 'POST', '/workflows/validate',
                             body={'definition': bug_fix(), 'workflow_id': agents_id})
        assert (status, body['valid'], 'a workflow keeps its kind' in body['errors'][0]['message']) == (200, False, True)
        assert _rename(lambda_context, engineering_id) == 200


def test_a_new_engineering_flow_needs_the_module_and_a_saved_one_keeps_working(lambda_context: Any,
                                                                               monkeypatch: pytest.MonkeyPatch) -> None:
    with _api():
        engineering_id = _save_engineering_flow(lambda_context)
        monkeypatch.setenv('ENGINEERING_AGENTS', 'off')
        created = _call(lambda_context, 'POST', '/workflows', body={'definition': bug_fix()})
        copied = _call(lambda_context, 'POST', f'/workflows/{engineering_id}/duplicate', body={})
        assert [(status, 'only where the engineering agents module is deployed' in body['error'])
                for status, body in (created, copied)] == [(409, True), (409, True)]
        # The saved one still saves, and opens.
        assert (_rename(lambda_context, engineering_id), _call(lambda_context, 'GET', f'/workflows/{engineering_id}')[0]) \
            == (200, 200)
        # An agents workflow is created as before.
        assert _call(lambda_context, 'POST', '/workflows',
                     body={'definition': workflow_schema.default_template()})[0] == 201


def test_the_default_flows_are_listed_for_an_administrator_where_the_module_is(lambda_context: Any,
                                                                                monkeypatch: pytest.MonkeyPatch) -> None:
    with _api():
        status, body = _call(lambda_context, 'GET', '/workflows/templates')
        assert (status, body['count']) == (200, 6), body
        assert [item['template_id'] for item in body['items']][:2] == ['understand-repository', 'issue-triage']
        assert all(item['definition']['schema'] == workflow_schema.SCHEMA_V2 for item in body['items'])
        assert _call(lambda_context, 'GET', '/workflows/templates', claims=USER)[0] == 403
        # A delegated (MCP) credential an administrator minted is never an administrator here.
        assert _call(lambda_context, 'GET', '/workflows/templates', claims=DELEGATED_ADMIN)[0] == 403
        monkeypatch.setenv('ENGINEERING_AGENTS', 'off')
        assert _call(lambda_context, 'GET', '/workflows/templates')[0] == 404


def test_create_from_a_template_is_the_librarys_own_create(lambda_context: Any,
                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    """No write path of its own: the template's definition goes to POST /workflows, validated, 409 where it is off."""
    with _api():
        definition = _call(lambda_context, 'GET', '/workflows/templates')[1]['items'][2]['definition']
        status, body = _call(lambda_context, 'POST', '/workflows', body={'definition': definition})
        assert (status, body['workflow']['name'], body['workflow']['kind']) == (201, 'Bug hunt and fix', 'engineering')
        broken = {**definition, 'nodes': definition['nodes'][:-1]}
        assert _call(lambda_context, 'POST', '/workflows', body={'definition': broken})[0] == 400
        monkeypatch.setenv('ENGINEERING_AGENTS', 'off')
        assert _call(lambda_context, 'POST', '/workflows', body={'definition': definition})[0] == 409


def test_a_flow_keeps_its_monthly_budget_and_only_a_signed_in_admin_changes_it(lambda_context: Any) -> None:
    with _api():
        workflow_id = _save_engineering_flow(lambda_context)
        budgeted = {**bug_fix(), 'budget': {'monthly_usd': 49.99}}
        status, body = _call(lambda_context, 'POST', '/workflows/validate',
                             body={'definition': budgeted, 'workflow_id': workflow_id})
        assert (status, body['valid'], body['diff']['meta_changed']) == (200, True, ['budget'])
        status, body = _call(lambda_context, 'PUT', f'/workflows/{workflow_id}', claims=DELEGATED_ADMIN,
                             body={'definition': budgeted, 'expected_revision': 1})
        assert status == 403
        status, body = _call(lambda_context, 'PUT', f'/workflows/{workflow_id}',
                             body={'definition': budgeted, 'expected_revision': 1})
        assert status == 200, body
        assert _call(lambda_context, 'GET', f'/workflows/{workflow_id}')[1]['workflow']['definition']['budget'] \
            == {'monthly_usd': 49.99}
        # The library lists it (the Spend tab's budget column); a flow without one lists None.
        listed = {w['workflow_id']: w['monthly_budget_usd'] for w in _call(lambda_context, 'GET', '/workflows')[1]['items']}
        assert (listed[workflow_id], listed['wf_default']) == (49.99, None)


def test_a_budget_off_its_rule_or_on_an_agents_workflow_is_refused(lambda_context: Any) -> None:
    with _api():
        status, body = _call(lambda_context, 'POST', '/workflows',
                             body={'definition': {**bug_fix(), 'budget': {'monthly_usd': 0}}})
        assert (status, body['errors'][0]['message'].startswith('budget is {monthly_usd}')) == (400, True)
        status, body = _call(lambda_context, 'POST', '/workflows',
                             body={'definition': {**workflow_schema.default_template(), 'budget': {'monthly_usd': 5}}})
        assert (status, body['errors']) == (400, [{'message': 'only an engineering flow has a budget'}])


def test_a_stored_budget_that_is_not_one_never_fails_the_library():
    from shared.agents_store import _monthly_budget
    assert (_monthly_budget({'budget': 'lots'}), _monthly_budget({'budget': [50]}), _monthly_budget(None),
            _monthly_budget({'budget': {'monthly_usd': 50}})) == (None, None, None, 50)
