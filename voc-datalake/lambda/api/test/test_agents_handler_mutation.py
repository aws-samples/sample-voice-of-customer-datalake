"""Mutation hardening for `api/agents_handler.py`.

`test_agents_handler.py` drives every route end to end against moto tables and
pins the statuses and the main fields, but a mutation run (352 mutants, 130
survivors) found what it cannot see:

* the WORDING of every refusal: the three 404 texts, the 403, the 400 for an
  unknown ``workflow_id`` or a bad ``expected_revision``, the two 409s of a run,
  the 409 for an agent whose workflow is gone, the 500s for an unconfigured
  table or runtime, and the exact 400 body of an invalid workflow definition.
* the one delegated path to an admin action: a global-MCP write token carrying
  ``voc:mcp_agent_run`` may run an agent, the same token without the claim may
  not, and an ``agent:`` principal never may.
* what an archived agent looks like from each side: an admin reads it, a user or
  a delegated admin gets 404, archiving is idempotent, it is disabled, and it
  can neither run nor be enabled.
* the paging constants the fixtures never reach: runs default to a page of 20
  capped at 50, events to 200 capped at 200, ``after`` is clamped into
  ``[0, 99_999_998]``, and an empty events page echoes ``after``.
* the fallbacks for legacy rows: an agent with no ``workflow_id`` is saved
  against ``wf_default``, a first run with no cursor looks back exactly 7 days,
  a workflow row without ``revision`` reads as revision 1, and an export without
  a stored ``slug`` slugifies the definition's name (``workflow`` when nameless).
* the ordering rules: agents by case-folded name then id, nameless rows first;
  the library by its ``gsi1sk`` after the built-in template.
* every log line a write emits, with its structured ``extra`` payload, and the
  tracer/handler decorators on each route.
"""
from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from agents_handler_fixtures import create as _create
from handler_log import handler_info

import agents_handler
from shared import agents_store as store
from shared import workflow_schema
from shared.test.agents_fixtures import AgentsEnv, agent_body

DELEGATED_ADMIN = {'sub': 'mcp:tok', 'voc:acting_subject': 'admin-sub', 'cognito:groups': 'admins'}
MCP_RUNNER = {**DELEGATED_ADMIN, 'voc:mcp_agent_run': 'true'}
AGENT_PRINCIPAL = {'sub': 'agent:ag_0123456789ab', 'voc:acting_subject': 'admin-sub', 'voc:mcp_agent_run': 'true'}
T0 = datetime(2026, 10, 5, 12, 0, 0, tzinfo=UTC)
T1 = T0 + timedelta(hours=1)
UNKNOWN_WORKFLOW = 'wf_0123456789ab'
RAW_WORKFLOW = 'wf_abcdefabcdef'


def _run(lambda_context: Any, agent_id: str, **kwargs: Any) -> dict:
    status, body = _call(lambda_context, 'POST', f'/agents/{agent_id}/run', **kwargs)
    assert status == 202, body
    return body['run']


def _remove(env: AgentsEnv, agent_id: str, attribute: str) -> None:
    env.agents.update_item(Key=store.agent_key(agent_id), UpdateExpression=f'REMOVE {attribute}')


def _raw_workflow(env: AgentsEnv, definition: dict, **attrs: Any) -> None:
    """A CURRENT row written by hand: only the attributes given, so a fallback can be reached."""
    env.agents.put_item(Item={
        **store.workflow_current_key(RAW_WORKFLOW), 'gsi1pk': store.WORKFLOWS_GSI_PK,
        'gsi1sk': f'raw#{RAW_WORKFLOW}', 'workflow_id': RAW_WORKFLOW, 'name': definition.get('name', ''),
        'definition': workflow_schema.encode_definition(definition), **attrs,
    })


def _save_revision(lambda_context: Any, workflow_id: str, name: str) -> None:
    changed = workflow_schema.default_template()
    changed['name'] = name
    status, _ = _call(lambda_context, 'PUT', f'/workflows/{workflow_id}',
                      body={'definition': changed, 'expected_revision': 1})
    assert status == 200


@pytest.fixture
def logger() -> Iterator[MagicMock]:
    with handler_info(agents_handler.logger) as info:
        yield info


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('method', 'path', 'claims', 'body', 'status', 'message'), [
        ('GET', '/agents/ag_000000000000', ADMIN, None, 404, 'Agent not found'),
        ('GET', '/agents/not-an-id', USER, None, 404, 'Agent not found'),
        ('GET', f'/workflows/{UNKNOWN_WORKFLOW}', USER, None, 404, 'Workflow not found'),
        ('GET', '/workflows/bad', ADMIN, None, 404, 'Workflow not found'),
        ('POST', '/agents', USER, agent_body(), 403, 'Admin access required'),
        ('POST', '/agents', DELEGATED_ADMIN, agent_body(), 403, 'Admin access required'),
        ('POST', '/agents', ADMIN, agent_body(workflow_id=UNKNOWN_WORKFLOW), 400,
         'workflow_id does not name a workflow'),
        ('GET', '/agents', USER, None, 200, None),
    ])
    def test_the_status_and_the_message(self, lambda_context, method, path, claims, body, status, message):
        with _api():
            got_status, got_body = _call(lambda_context, method, path, claims=claims, body=body)
            assert got_status == status
            if message is not None:
                assert got_body == {'success': False, 'error': message}

    def test_an_unknown_run_of_a_visible_agent(self, lambda_context):
        with _api():
            agent_id = _create(lambda_context)['agent_id']
            for run_id in ('ar_000000000000', 'nope'):
                status, body = _call(lambda_context, 'GET', f'/agents/{agent_id}/runs/{run_id}')
                assert (status, body) == (404, {'success': False, 'error': 'Run not found'})

    def test_run_now_without_the_runtime(self, lambda_context):
        with _api(with_state_machine=False):
            agent_id = _create(lambda_context)['agent_id']
            status, body = _call(lambda_context, 'POST', f'/agents/{agent_id}/run')
            assert (status, body) == (500, {'success': False, 'error': 'Agent runtime not configured'})

    def test_a_second_run_while_one_is_in_flight(self, lambda_context):
        with _api():
            agent_id = _create(lambda_context)['agent_id']
            _run(lambda_context, agent_id)
            status, body = _call(lambda_context, 'POST', f'/agents/{agent_id}/run')
            assert (status, body) == (409, {'success': False, 'error': 'This agent already has a run in progress'})

    def test_cancelling_a_finished_run(self, lambda_context):
        with _api():
            agent_id = _create(lambda_context)['agent_id']
            run_id = _run(lambda_context, agent_id)['run_id']
            assert _call(lambda_context, 'POST', f'/agents/{agent_id}/runs/{run_id}/cancel')[0] == 200
            status, body = _call(lambda_context, 'POST', f'/agents/{agent_id}/runs/{run_id}/cancel')
            assert (status, body) == (409, {'success': False, 'error': 'This run has already finished'})

    def test_running_an_agent_whose_workflow_is_gone(self, lambda_context):
        with _api() as env:
            agent = _create(lambda_context)
            env.agents.delete_item(Key=store.workflow_current_key(agent['workflow_id']))
            status, body = _call(lambda_context, 'POST', f"/agents/{agent['agent_id']}/run")
            assert (status, body) == (
                409, {'success': False, 'error': "The agent's workflow no longer exists; choose another workflow"})

    def test_an_unconfigured_agents_table(self, lambda_context):
        with _api(), patch.object(store, 'get_agents_table', return_value=None):
            status, body = _call(lambda_context, 'GET', '/agents')
            assert (status, body) == (500, {'success': False, 'error': 'Agents table not configured'})

    def test_an_unconfigured_aggregates_table(self, lambda_context):
        with _api(), patch.object(agents_handler, 'get_aggregates_table', return_value=None):
            status, body = _call(lambda_context, 'GET', '/agents', claims=USER)
            assert (status, body) == (500, {'success': False, 'error': 'Aggregates table not configured'})

    def test_an_invalid_workflow_definition_lists_its_errors(self, lambda_context):
        with _api():
            bad = workflow_schema.default_template()
            bad['loops'][0]['max_rounds'] = 9
            status, body = _call(lambda_context, 'POST', '/workflows', body={'definition': bad})
            assert status == 400
            assert body == {
                'success': False, 'error': 'The workflow is not valid', 'valid': False,
                'errors': [{'message': 'loop 1 max_rounds must be a whole number from 1 to 5'}],
            }

    @pytest.mark.parametrize('expected', [True, False, 0, -1, '1', 1.0, None])
    def test_expected_revision_must_be_a_whole_number_from_one(self, lambda_context, expected):
        with _api():
            status, body = _call(lambda_context, 'PUT', '/workflows/wf_default',
                                 body={'definition': workflow_schema.default_template(), 'expected_revision': expected})
            assert status == 400
            assert body == {'success': False,
                            'error': 'expected_revision must be the revision you edited (a whole number ≥ 1)'}

    def test_the_revision_check_comes_before_the_workflow_lookup(self, lambda_context):
        with _api():
            status, _ = _call(lambda_context, 'PUT', f'/workflows/{UNKNOWN_WORKFLOW}',
                              body={'definition': {}, 'expected_revision': 1})
            assert status == 404


class TestRunNowPermission:
    def test_a_global_mcp_write_token_cleared_by_the_mcp_lambda_may_run(self, lambda_context):
        with _api():
            agent_id = _create(lambda_context)['agent_id']
            status, body = _call(lambda_context, 'POST', f'/agents/{agent_id}/run', claims=MCP_RUNNER)
            assert status == 202
            assert body['run']['trigger'] == 'manual'

    @pytest.mark.parametrize('claims', [DELEGATED_ADMIN, AGENT_PRINCIPAL, USER])
    def test_everyone_else_is_refused(self, lambda_context, claims):
        with _api():
            agent_id = _create(lambda_context)['agent_id']
            status, body = _call(lambda_context, 'POST', f'/agents/{agent_id}/run', claims=claims)
            assert (status, body) == (403, {'success': False, 'error': 'Admin access required'})


class TestArchivedAgents:
    def _archived(self, lambda_context) -> str:
        agent_id = _create(lambda_context)['agent_id']
        assert _call(lambda_context, 'POST', f'/agents/{agent_id}/enable')[1]['agent']['enabled'] is True
        status, body = _call(lambda_context, 'DELETE', f'/agents/{agent_id}')
        assert status == 200
        assert body['agent']['status'] == 'archived'
        assert body['agent']['enabled'] is False
        return agent_id

    def test_an_admin_still_reads_it(self, lambda_context):
        with _api():
            agent_id = self._archived(lambda_context)
            status, body = _call(lambda_context, 'GET', f'/agents/{agent_id}')
            assert status == 200
            assert list(body) == ['agent']
            assert body['agent']['status'] == 'archived'
            assert body['agent']['enabled'] is False

    @pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN])
    def test_a_user_or_a_delegated_admin_gets_404(self, lambda_context, claims):
        with _api():
            agent_id = self._archived(lambda_context)
            status, body = _call(lambda_context, 'GET', f'/agents/{agent_id}', claims=claims)
            assert (status, body) == (404, {'success': False, 'error': 'Agent not found'})

    def test_archiving_twice_is_idempotent(self, lambda_context):
        with _api():
            agent_id = self._archived(lambda_context)
            status, body = _call(lambda_context, 'DELETE', f'/agents/{agent_id}')
            assert status == 200
            assert body['agent']['status'] == 'archived'

    @pytest.mark.parametrize('action', ['run', 'enable', 'disable'])
    def test_it_cannot_run_or_be_toggled(self, lambda_context, action):
        with _api():
            agent_id = self._archived(lambda_context)
            status, body = _call(lambda_context, 'POST', f'/agents/{agent_id}/{action}')
            assert (status, body) == (404, {'success': False, 'error': 'Agent not found'})

    def test_only_an_admin_may_ask_for_archived_agents_in_the_list(self, lambda_context):
        with _api():
            agent_id = self._archived(lambda_context)
            status, body = _call(lambda_context, 'GET', '/agents', claims=USER, query={'include_archived': 'true'})
            assert (status, body) == (403, {'success': False, 'error': 'Admin access required'})
            assert _call(lambda_context, 'GET', '/agents', query={'include_archived': 'True'})[1]['count'] == 0
            listed = _call(lambda_context, 'GET', '/agents', query={'include_archived': 'true'})[1]
            assert [a['agent_id'] for a in listed['items']] == [agent_id]


def _row(agent_id: str, name: str | None) -> dict:
    row = {'agent_id': agent_id, 'scope': {'all': True}, 'status': 'active'}
    if name is not None:
        row['name'] = name
    return row


class TestAgentsAreListedByFoldedNameThenId:
    def test_case_folded_name_then_agent_id_breaks_ties(self, lambda_context):
        rows = [_row('ag_ffffffffffff', 'beta'), _row('ag_eeeeeeeeeeee', 'Alpha'),
                _row('ag_dddddddddddd', 'alpha'), _row('ag_cccccccccccc', 'Alpha')]
        with _api(), patch.object(store, 'list_agents', return_value=rows):
            items = _call(lambda_context, 'GET', '/agents')[1]['items']
            assert [(a['name'], a['agent_id']) for a in items] == [
                ('Alpha', 'ag_cccccccccccc'), ('alpha', 'ag_dddddddddddd'),
                ('Alpha', 'ag_eeeeeeeeeeee'), ('beta', 'ag_ffffffffffff'),
            ]

    def test_a_nameless_row_sorts_first(self, lambda_context):
        rows = [_row('ag_ffffffffffff', 'Zeta'), _row('ag_eeeeeeeeeeee', None), _row('ag_dddddddddddd', 'Alpha')]
        with _api(), patch.object(store, 'list_agents', return_value=rows):
            items = _call(lambda_context, 'GET', '/agents')[1]['items']
            assert [a['agent_id'] for a in items] == ['ag_eeeeeeeeeeee', 'ag_dddddddddddd', 'ag_ffffffffffff']

    def test_one_clock_read_is_shared_by_every_view(self, lambda_context):
        rows = [_row('ag_ffffffffffff', 'b'), _row('ag_eeeeeeeeeeee', 'a')]
        with _api(), patch.object(store, 'list_agents', return_value=rows), \
                patch.object(store, 'utc_now', return_value=T0), \
                patch.object(store, 'agent_view', wraps=store.agent_view) as view:
            assert _call(lambda_context, 'GET', '/agents')[0] == 200
            assert view.call_args_list == [call(rows[0], T0), call(rows[1], T0)]


class TestUpdateAgentKeepsWhatTheBodyOmits:
    def test_a_legacy_agent_without_a_workflow_is_saved_against_the_template(self, lambda_context):
        with _api() as env:
            agent_id = _create(lambda_context)['agent_id']
            _remove(env, agent_id, 'workflow_id')
            status, body = _call(lambda_context, 'PUT', f'/agents/{agent_id}', body={'instructions': 'x'})
            assert status == 200
            assert body['agent']['workflow_id'] == 'wf_default'

    def test_an_explicit_null_workflow_keeps_the_stored_one(self, lambda_context):
        with _api():
            agent = _create(lambda_context)
            status, body = _call(lambda_context, 'PUT', f"/agents/{agent['agent_id']}", body={'workflow_id': None})
            assert status == 200
            assert body['agent']['workflow_id'] == agent['workflow_id']
            assert body['agent']['workflow_id'] != 'wf_default'

    def test_a_changed_workflow_must_exist(self, lambda_context):
        with _api():
            agent_id = _create(lambda_context)['agent_id']
            status, body = _call(lambda_context, 'PUT', f'/agents/{agent_id}', body={'workflow_id': UNKNOWN_WORKFLOW})
            assert (status, body) == (400, {'success': False, 'error': 'workflow_id does not name a workflow'})

    def test_an_unchanged_workflow_is_not_looked_up(self, lambda_context):
        with _api() as env:
            agent = _create(lambda_context)
            env.agents.delete_item(Key=store.workflow_current_key(agent['workflow_id']))
            status, body = _call(lambda_context, 'PUT', f"/agents/{agent['agent_id']}", body={'instructions': 'x'})
            assert status == 200
            assert body['agent']['workflow_id'] == agent['workflow_id']

    @pytest.mark.parametrize(('owner_sub', 'expected'), [(None, 'admin-sub'), ('carol-sub', 'carol-sub')])
    def test_owner_sub(self, lambda_context, owner_sub, expected):
        with _api():
            agent_id = _create(lambda_context)['agent_id']
            status, body = _call(lambda_context, 'PUT', f'/agents/{agent_id}', body={'owner_sub': owner_sub})
            assert status == 200
            assert body['agent']['owner_sub'] == expected


class TestRunNowWindowAndRevision:
    """The agent is created at T0 and run at T1 (one hour later)."""

    @staticmethod
    def _created_at_t0_run_at_t1(lambda_context, *, remove: str | None = None) -> dict:
        clock = MagicMock(return_value=T0)
        with _api() as env, patch.object(store, 'utc_now', clock):
            agent_id = _create(lambda_context)['agent_id']
            if remove:
                _remove(env, agent_id, remove)
            clock.return_value = T1
            return _run(lambda_context, agent_id)

    def test_the_window_starts_at_the_agents_cursor(self, lambda_context):
        run = self._created_at_t0_run_at_t1(lambda_context)
        assert run['review_window'] == {'since': '2026-10-05T12:00:00+00:00', 'until': '2026-10-05T13:00:00+00:00'}

    def test_a_first_run_without_a_cursor_looks_back_seven_days(self, lambda_context):
        run = self._created_at_t0_run_at_t1(lambda_context, remove='last_run_cursor')
        assert run['review_window'] == {'since': '2026-09-28T13:00:00+00:00', 'until': '2026-10-05T13:00:00+00:00'}

    def test_the_run_pins_the_workflows_current_revision(self, lambda_context):
        with _api():
            agent = _create(lambda_context)
            _save_revision(lambda_context, agent['workflow_id'], 'Second')
            run = _run(lambda_context, agent['agent_id'])
            assert run['workflow_revision'] == 2
            assert run['workflow_id'] == agent['workflow_id']

    def test_a_legacy_agent_without_a_workflow_runs_the_template(self, lambda_context):
        with _api() as env:
            agent_id = _create(lambda_context)['agent_id']
            _remove(env, agent_id, 'workflow_id')
            run = _run(lambda_context, agent_id)
            assert run['workflow_id'] == 'wf_default'
            assert run['workflow_revision'] == 1

    def test_a_workflow_row_without_a_revision_reads_as_one(self, lambda_context):
        with _api() as env:
            _raw_workflow(env, workflow_schema.default_template())
            agent_id = _create(lambda_context, workflow_id=RAW_WORKFLOW)['agent_id']
            run = _run(lambda_context, agent_id)
            assert run['workflow_revision'] == 1

    def test_the_log_line(self, lambda_context, logger):
        with _api():
            agent_id = _create(lambda_context)['agent_id']
            logger.reset_mock()
            run_id = _run(lambda_context, agent_id)['run_id']
            logger.assert_called_once_with('Agent run started',
                                           extra={'agent_id': agent_id, 'run_id': run_id, 'trigger': 'manual'})


class TestRunPaging:
    @pytest.mark.parametrize(('query', 'limit', 'cursor'), [
        (None, 20, None),
        ({'limit': '0'}, 1, None),
        ({'limit': '1'}, 1, None),
        ({'limit': '5', 'cursor': 'abc'}, 5, 'abc'),
        ({'limit': '50'}, 50, None),
        ({'limit': '51'}, 50, None),
    ])
    def test_list_runs_limit_and_cursor(self, lambda_context, query, limit, cursor):
        with _api() as env:
            agent_id = _create(lambda_context)['agent_id']
            with patch.object(store, 'list_runs', return_value=([], None)) as list_runs:
                status, body = _call(lambda_context, 'GET', f'/agents/{agent_id}/runs', query=query)
            assert status == 200
            assert body == {'items': [], 'next_cursor': None}
            table = store.get_agents_table()
            assert table is not None
            assert table.name == env.agents.name
            list_runs.assert_called_once_with(table, agent_id, limit=limit, cursor=cursor)

    @pytest.mark.parametrize(('query', 'after', 'limit'), [
        (None, 0, 200),
        ({'after': '-3', 'limit': '0'}, 0, 1),
        ({'after': '7', 'limit': '5'}, 7, 5),
        ({'after': '99999998', 'limit': '200'}, 99_999_998, 200),
        ({'after': '99999999', 'limit': '201'}, 99_999_998, 200),
    ])
    def test_list_events_after_and_limit(self, lambda_context, query, after, limit):
        with _api():
            agent_id = _create(lambda_context)['agent_id']
            run_id = _run(lambda_context, agent_id)['run_id']
            with patch.object(store, 'list_events', return_value=[]) as list_events:
                status, body = _call(lambda_context, 'GET', f'/agents/{agent_id}/runs/{run_id}/events', query=query)
            assert status == 200
            assert body == {'items': [], 'next_after': after}
            table = store.get_agents_table()
            list_events.assert_called_once_with(table, run_id, after=after, limit=limit)

    def test_a_cancelled_run_journals_the_decision(self, lambda_context, logger):
        with _api(), patch.object(store, 'utc_now', return_value=T0):
            agent_id = _create(lambda_context)['agent_id']
            run_id = _run(lambda_context, agent_id)['run_id']
            logger.reset_mock()
            status, body = _call(lambda_context, 'POST', f'/agents/{agent_id}/runs/{run_id}/cancel')
            assert status == 200
            assert list(body) == ['run']
            logger.assert_called_once_with('Agent run cancelled', extra={'agent_id': agent_id, 'run_id': run_id})
            events = _call(lambda_context, 'GET', f'/agents/{agent_id}/runs/{run_id}/events')[1]
            assert events['items'] == [
                {'seq': 1, 'at': '2026-10-05T12:00:00+00:00', 'kind': 'decision', 'role': 'system',
                 'summary': 'Run queued (manual)'},
                {'seq': 2, 'at': '2026-10-05T12:00:00+00:00', 'kind': 'decision', 'role': 'system',
                 'summary': 'Run cancelled by an admin'},
            ]
            assert events['next_after'] == 2

    def test_a_run_with_no_recorded_and_no_derivable_execution_is_cancelled_without_a_stop(self, lambda_context):
        # The recorded-ARN-missing case is stopped through the derived ARN (E2E s2 F3, pinned in
        # test_agents_handler.py); with no state machine configured there is nothing to derive.
        with _api() as env:
            agent_id = _create(lambda_context)['agent_id']
            run_id = _run(lambda_context, agent_id)['run_id']
            env.agents.update_item(Key=store.run_key(agent_id, run_id), UpdateExpression='REMOVE execution_arn')
            with patch.dict(os.environ, {store.STATE_MACHINE_ENV: ''}):
                status, body = _call(lambda_context, 'POST', f'/agents/{agent_id}/runs/{run_id}/cancel')
            assert (status, body['run']['status']) == (200, 'cancelled')
            env.sfn.stop_execution.assert_not_called()

    def test_a_cancelled_run_stops_its_execution(self, lambda_context):
        with _api() as env:
            agent_id = _create(lambda_context)['agent_id']
            run_id = _run(lambda_context, agent_id)['run_id']
            assert _call(lambda_context, 'POST', f'/agents/{agent_id}/runs/{run_id}/cancel')[0] == 200
            env.sfn.stop_execution.assert_called_once_with(
                executionArn=f'arn:aws:states:us-east-1:123456789012:stateMachine:voc-agent-run:{run_id}',
                cause='Cancelled by an admin',
            )


class TestWriteLogLines:
    def test_agent_created(self, lambda_context, logger):
        with _api():
            agent_id = _create(lambda_context)['agent_id']
            logger.assert_called_once_with('Agent created', extra={'agent_id': agent_id})

    def test_agent_archived(self, lambda_context, logger):
        with _api():
            agent_id = _create(lambda_context)['agent_id']
            logger.reset_mock()
            assert _call(lambda_context, 'DELETE', f'/agents/{agent_id}')[0] == 200
            logger.assert_called_once_with('Agent archived', extra={'agent_id': agent_id})

    def test_workflow_created(self, lambda_context, logger):
        with _api():
            status, body = _call(lambda_context, 'POST', '/workflows',
                                 body={'definition': workflow_schema.default_template()})
            assert status == 201
            logger.assert_called_once_with('Workflow created', extra={'workflow_id': body['workflow']['workflow_id']})


class TestWorkflowLibrary:
    def test_the_template_first_then_by_gsi1sk_with_a_missing_key_sorting_first(self, lambda_context):
        rows = [store.builtin_workflow(), {'workflow_id': 'wf_000000000003', 'gsi1sk': 'zeta#wf_000000000003'},
                {'workflow_id': 'wf_000000000002'}, {'workflow_id': 'wf_000000000001', 'gsi1sk': '1st#wf_000000000001'}]
        with _api(), patch.object(store, 'list_workflows', return_value=rows):
            status, body = _call(lambda_context, 'GET', '/workflows', claims=USER)
            assert status == 200
            assert list(body) == ['items', 'count']
            assert body['count'] == 4
            assert [w['workflow_id'] for w in body['items']] == [
                'wf_default', 'wf_000000000002', 'wf_000000000001', 'wf_000000000003']
            assert all('definition' not in w for w in body['items'])

    def test_validate_without_a_workflow_id_has_no_diff(self, lambda_context):
        with _api():
            status, body = _call(lambda_context, 'POST', '/workflows/validate', claims=USER,
                                 body={'definition': workflow_schema.default_template()})
            assert (status, body) == (200, {'valid': True, 'errors': []})

    def test_validate_diffs_even_an_invalid_definition(self, lambda_context):
        with _api():
            bad = workflow_schema.default_template()
            bad['name'] = ''
            status, body = _call(lambda_context, 'POST', '/workflows/validate', claims=USER,
                                 body={'definition': bad, 'workflow_id': 'wf_default'})
            assert status == 200
            assert body['valid'] is False
            assert body['diff']['meta_changed'] == ['name']

    def test_validate_against_an_unknown_workflow(self, lambda_context):
        with _api():
            status, body = _call(lambda_context, 'POST', '/workflows/validate', claims=USER,
                                 body={'definition': workflow_schema.default_template(), 'workflow_id': UNKNOWN_WORKFLOW})
            assert (status, body) == (404, {'success': False, 'error': 'Workflow not found'})

    def test_validate_with_a_non_object_definition_skips_the_diff(self, lambda_context):
        with _api():
            status, body = _call(lambda_context, 'POST', '/workflows/validate', claims=USER,
                                 body={'definition': 'x', 'workflow_id': UNKNOWN_WORKFLOW})
            assert status == 200
            assert 'diff' not in body
            assert body['valid'] is False

    def test_duplicate_takes_the_given_name(self, lambda_context):
        with _api():
            status, body = _call(lambda_context, 'POST', '/workflows/wf_default/duplicate', body={'name': 'Mine'})
            assert status == 201
            assert body['workflow']['name'] == 'Mine'
            assert body['workflow']['derived_from'] == 'wf_default'

    def test_duplicate_truncates_the_copy_suffix_to_the_name_limit(self, lambda_context):
        with _api():
            long_name = 'N' * 120
            status, body = _call(lambda_context, 'POST', '/workflows/wf_default/duplicate', body={'name': long_name})
            assert status == 201
            status, body = _call(lambda_context, 'POST', f"/workflows/{body['workflow']['workflow_id']}/duplicate",
                                 body={})
            assert status == 201
            assert body['workflow']['name'] == long_name

    def test_duplicate_of_a_nameless_definition_is_workflow_copy(self, lambda_context):
        with _api() as env:
            definition = workflow_schema.default_template()
            del definition['name']
            _raw_workflow(env, definition, revision=1)
            status, body = _call(lambda_context, 'POST', f'/workflows/{RAW_WORKFLOW}/duplicate', body={})
            assert status == 201
            assert body['workflow']['name'] == 'Workflow (copy)'

    def test_export_carries_the_current_revision_and_stored_slug(self, lambda_context):
        with _api():
            created = _call(lambda_context, 'POST', '/workflows',
                            body={'definition': workflow_schema.default_template()})[1]['workflow']
            _save_revision(lambda_context, created['workflow_id'], 'Second Name')
            status, body = _call(lambda_context, 'GET', f"/workflows/{created['workflow_id']}/export", claims=USER)
            assert status == 200
            assert body['exported_from'] == {'workflow_id': created['workflow_id'], 'revision': 2, 'slug': 'second-name'}

    @pytest.mark.parametrize(('attrs', 'name', 'slug'), [
        ({'slug': 'kept-slug'}, 'Other Name', 'kept-slug'),
        ({}, 'Hello World', 'hello-world'),
        ({}, None, 'workflow'),
    ])
    def test_export_of_a_raw_row_falls_back_to_revision_one_and_a_slug(self, lambda_context, attrs, name, slug):
        with _api() as env:
            definition = workflow_schema.default_template()
            if name is None:
                del definition['name']
            else:
                definition['name'] = name
            _raw_workflow(env, definition, **attrs)
            status, body = _call(lambda_context, 'GET', f'/workflows/{RAW_WORKFLOW}/export', claims=USER)
            assert status == 200
            assert body['exported_from'] == {'workflow_id': RAW_WORKFLOW, 'revision': 1, 'slug': slug}


ROUTES = [
    'list_agents', 'create_agent', 'get_agent', 'update_agent', 'archive_agent', 'enable_agent', 'disable_agent',
    'run_agent', 'list_runs', 'get_run', 'list_run_events', 'cancel_run', 'list_workflows', 'create_workflow',
    'import_workflow', 'validate_workflow', 'get_workflow', 'save_workflow', 'duplicate_workflow',
    'export_workflow',
]


class TestTheRoutesAreInstrumented:
    @pytest.mark.parametrize('route', ROUTES)
    def test_every_route_is_the_tracer_wrapper_around_the_named_function(self, route):
        func = getattr(agents_handler, route)
        assert func.__code__.co_filename.endswith(os.path.join('tracing', 'tracer.py'))
        assert func.__wrapped__.__qualname__ == route

    def test_the_handler_is_wrapped_by_api_handler(self):
        handler = agents_handler.lambda_handler
        assert handler.__code__.co_filename.endswith(os.path.join('logging', 'logger.py'))
        assert vars(handler)['__wrapped__'].__qualname__ == 'lambda_handler'
