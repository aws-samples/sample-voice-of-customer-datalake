"""Route tests for api/agents_handler.py against moto tables (Step Functions mocked)."""
import json

import pytest
from agents_handler_fixtures import USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from agents_handler_fixtures import create as _create

from shared import agents_store as store
from shared import workflow_schema
from shared.test.agents_fixtures import STATE_MACHINE_ARN, agent_body


def _restrict(env, sub, categories):
    env.aggregates.put_item(Item={'pk': 'CATEGORY_ACCESS', 'sk': f'USER#{sub}', 'categories': categories})


class TestAgents:
    def test_create_gets_its_own_copy_of_the_template(self, lambda_context):
        with _api() as env:
            agent = _create(lambda_context)
            assert agent['owner_sub'] == 'admin-sub'
            assert agent['enabled'] is False
            workflow = store.get_workflow(env.agents, agent['workflow_id'])
            assert workflow is not None
            assert workflow['derived_from'] == 'wf_default'
            assert workflow['name'] == 'Shipping crew workflow'

    def test_invalid_body_is_400(self, lambda_context):
        with _api():
            status, body = _call(lambda_context, 'POST', '/agents', body={'name': 'x', 'scope': {'all': False}})
            assert status == 400
            assert 'scope' in body['error']

    def test_reads_are_filtered_by_category_scope(self, lambda_context):
        with _api() as env:
            shipping = _create(lambda_context)
            _create(lambda_context, name='Everything', scope={'all': True})
            _restrict(env, 'user-sub', ['shipping'])
            status, body = _call(lambda_context, 'GET', '/agents', claims=USER)
            assert status == 200
            assert [a['agent_id'] for a in body['items']] == [shipping['agent_id']]
            status, _ = _call(lambda_context, 'GET', f"/agents/{body['items'][0]['agent_id']}", claims=USER)
            assert status == 200
            everything = [a for a in _call(lambda_context, 'GET', '/agents')[1]['items'] if a['name'] == 'Everything']
            status, _ = _call(lambda_context, 'GET', f"/agents/{everything[0]['agent_id']}", claims=USER)
            assert status == 404

    def test_an_unrestricted_user_sees_every_agent(self, lambda_context):
        with _api():
            _create(lambda_context, scope={'all': True})
            assert _call(lambda_context, 'GET', '/agents', claims=USER)[1]['count'] == 1

    def test_update_enable_disable_archive(self, lambda_context):
        with _api():
            agent_id = _create(lambda_context)['agent_id']
            status, body = _call(lambda_context, 'PUT', f'/agents/{agent_id}', body={'instructions': 'Be brief'})
            assert status == 200
            assert body['agent']['instructions'] == 'Be brief'
            assert body['agent']['description'] == 'Late parcels'
            assert _call(lambda_context, 'POST', f'/agents/{agent_id}/enable')[1]['agent']['enabled'] is True
            assert _call(lambda_context, 'POST', f'/agents/{agent_id}/disable')[1]['agent']['enabled'] is False
            status, body = _call(lambda_context, 'DELETE', f'/agents/{agent_id}')
            assert status == 200
            assert body['agent']['status'] == 'archived'
            assert _call(lambda_context, 'GET', '/agents')[1]['count'] == 0
            assert _call(lambda_context, 'GET', '/agents', query={'include_archived': 'true'})[1]['count'] == 1
            assert _call(lambda_context, 'PUT', f'/agents/{agent_id}', body={'name': 'x'})[0] == 404


class TestRuns:
    def test_run_now_starts_the_state_machine(self, lambda_context):
        with _api() as env:
            agent_id = _create(lambda_context)['agent_id']
            status, body = _call(lambda_context, 'POST', f'/agents/{agent_id}/run')
            assert status == 202
            run = body['run']
            assert run['status'] == 'queued'
            assert run['trigger'] == 'manual'
            assert run['agent_id'] == agent_id
            kwargs = env.sfn.start_execution.call_args.kwargs
            assert kwargs['stateMachineArn'] == STATE_MACHINE_ARN
            assert kwargs['name'] == run['run_id']
            assert json.loads(kwargs['input']) == {'run_id': run['run_id'], 'agent_id': agent_id}
            assert _call(lambda_context, 'POST', f'/agents/{agent_id}/run')[0] == 409

    def test_a_failed_start_fails_the_run_and_frees_the_lock(self, lambda_context):
        from botocore.exceptions import ClientError
        with _api() as env:
            agent_id = _create(lambda_context)['agent_id']
            env.sfn.start_execution.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'StartExecution')
            assert _call(lambda_context, 'POST', f'/agents/{agent_id}/run')[0] == 500
            runs = _call(lambda_context, 'GET', f'/agents/{agent_id}/runs')[1]['items']
            assert runs[0]['status'] == 'failed'
            stored = store.get_agent(env.agents, agent_id)
            assert stored is not None
            assert 'active_run_id' not in stored

    def test_runs_events_and_cancel(self, lambda_context):
        with _api() as env:
            agent_id = _create(lambda_context)['agent_id']
            run_id = _call(lambda_context, 'POST', f'/agents/{agent_id}/run')[1]['run']['run_id']
            status, body = _call(lambda_context, 'GET', f'/agents/{agent_id}/runs')
            assert status == 200
            assert [r['run_id'] for r in body['items']] == [run_id]
            assert _call(lambda_context, 'GET', f'/agents/{agent_id}/runs/{run_id}')[1]['run']['run_id'] == run_id
            status, body = _call(lambda_context, 'GET', f'/agents/{agent_id}/runs/{run_id}/events',
                                 query={'after': '0'})
            assert status == 200
            assert body['items'][0]['kind'] == 'decision'
            assert body['next_after'] == 1
            status, body = _call(lambda_context, 'POST', f'/agents/{agent_id}/runs/{run_id}/cancel')
            assert status == 200
            assert body['run']['status'] == 'cancelled'
            env.sfn.stop_execution.assert_called_once()
            assert _call(lambda_context, 'POST', f'/agents/{agent_id}/runs/{run_id}/cancel')[0] == 409
            assert _call(lambda_context, 'POST', f'/agents/{agent_id}/run')[0] == 202

    def test_cancel_stops_a_run_whose_execution_arn_was_never_recorded(self, lambda_context):
        # E2E s2 F3: the start succeeded but recording execution_arn failed; cancel skipped
        # stop_execution and the "cancelled" run kept executing nodes (SUCCEEDED, not ABORTED).
        with _api() as env:
            agent_id = _create(lambda_context)['agent_id']
            run_id = _call(lambda_context, 'POST', f'/agents/{agent_id}/run')[1]['run']['run_id']
            env.agents.update_item(Key=store.run_key(agent_id, run_id), UpdateExpression='REMOVE execution_arn')
            status, body = _call(lambda_context, 'POST', f'/agents/{agent_id}/runs/{run_id}/cancel')
            assert status == 200
            assert body['run']['status'] == 'cancelled'
            env.sfn.stop_execution.assert_called_once_with(
                executionArn=f"{STATE_MACHINE_ARN.replace(':stateMachine:', ':execution:')}:{run_id}",
                cause='Cancelled by an admin')

    def test_runs_of_a_hidden_agent_are_404(self, lambda_context):
        with _api() as env:
            agent_id = _create(lambda_context)['agent_id']
            run_id = _call(lambda_context, 'POST', f'/agents/{agent_id}/run')[1]['run']['run_id']
            _restrict(env, 'user-sub', ['billing'])
            assert _call(lambda_context, 'GET', f'/agents/{agent_id}/runs/{run_id}', claims=USER)[0] == 404


class TestWorkflows:
    def test_library_crud(self, lambda_context):
        with _api():
            status, body = _call(lambda_context, 'POST', '/workflows',
                                 body={'definition': workflow_schema.default_template()})
            assert status == 201
            workflow_id = body['workflow']['workflow_id']
            items = _call(lambda_context, 'GET', '/workflows', claims=USER)[1]['items']
            assert [w['workflow_id'] for w in items] == ['wf_default', workflow_id]
            assert 'definition' not in items[0]
            changed = workflow_schema.default_template()
            changed['name'] = 'Renamed'
            status, body = _call(lambda_context, 'PUT', f'/workflows/{workflow_id}',
                                 body={'definition': changed, 'expected_revision': 1})
            assert status == 200
            assert body['workflow']['revision'] == 2
            assert _call(lambda_context, 'PUT', f'/workflows/{workflow_id}',
                         body={'definition': changed, 'expected_revision': 1})[0] == 409
            status, body = _call(lambda_context, 'GET', f'/workflows/{workflow_id}', claims=USER)
            assert status == 200
            assert [r['revision'] for r in body['revisions']] == [2, 1]
            assert body['workflow']['definition']['name'] == 'Renamed'

    def test_builtin_cannot_be_saved_but_can_be_duplicated(self, lambda_context):
        with _api():
            assert _call(lambda_context, 'PUT', '/workflows/wf_default',
                         body={'definition': workflow_schema.default_template(), 'expected_revision': 1})[0] == 409
            status, body = _call(lambda_context, 'POST', '/workflows/wf_default/duplicate', body={})
            assert status == 201
            assert body['workflow']['derived_from'] == 'wf_default'
            assert body['workflow']['name'] == 'Reviews → Prototype (copy)'

    def test_export_then_import(self, lambda_context):
        with _api():
            status, exported = _call(lambda_context, 'GET', '/workflows/wf_default/export', claims=USER)
            assert status == 200
            assert exported['exported_from']['workflow_id'] == 'wf_default'
            status, body = _call(lambda_context, 'POST', '/workflows/import', body={'definition': exported})
            assert status == 201
            assert body['workflow']['derived_from'] == 'wf_default'

    def test_validate_with_diff(self, lambda_context):
        with _api():
            changed = workflow_schema.default_template()
            changed['nodes'][1]['data']['title'] = 'Aggregate'
            status, body = _call(lambda_context, 'POST', '/workflows/validate', claims=USER,
                                 body={'definition': changed, 'workflow_id': 'wf_default'})
            assert status == 200
            assert body['valid'] is True
            assert body['diff']['nodes']['changed'] == [{'id': 'aggregate', 'fields': ['title']}]

    def test_workflow_writes_are_admin_only(self, lambda_context):
        with _api():
            assert _call(lambda_context, 'POST', '/workflows', claims=USER,
                         body={'definition': workflow_schema.default_template()})[0] == 403
            assert _call(lambda_context, 'POST', '/workflows/wf_default/duplicate', claims=USER, body={})[0] == 403


def _custom_step_workflow(label: str | None) -> dict:
    """start → custom step → end, the custom step's arrow labelled ``label``."""
    definition = workflow_schema.default_template()
    definition['name'] = 'Custom'
    definition['nodes'] = [
        {'id': 'start', 'type': 'start', 'position': {'x': 0, 'y': 0}, 'data': {'title': 'Start'}},
        {'id': 'custom', 'type': 'custom_llm', 'position': {'x': 0, 'y': 100},
         'data': {'title': 'Think', 'instructions': 'Summarise.'}},
        {'id': 'end', 'type': 'end', 'position': {'x': 0, 'y': 200}, 'data': {'title': 'End'}},
    ]
    definition['edges'] = [{'id': 'e1', 'source': 'start', 'target': 'custom'},
                           {'id': 'e2', 'source': 'custom', 'target': 'end', **({'label': label} if label else {})}]
    definition['loops'] = []
    return definition


class TestCustomStepArrows:
    """3.00.00: a custom step reports no verdict, so pass/fail arrows out of it are refused on
    save and a stored one (pre-3.00.00) is served as the plain arrow it always behaved as."""

    @pytest.mark.parametrize('label', ['pass', 'fail'])
    def test_saving_a_labelled_custom_arrow_is_a_400_naming_the_step(self, lambda_context, label):
        with _api():
            status, body = _call(lambda_context, 'POST', '/workflows', body={'definition': _custom_step_workflow(label)})
            assert status == 400
            assert {'message': f"a custom step reports no pass/fail verdict, so its arrows cannot be '{label}'"
                               ' — use a plain arrow', 'node_id': 'custom'} in body['errors']
            status, body = _call(lambda_context, 'POST', '/workflows/validate', claims=USER,
                                 body={'definition': _custom_step_workflow(label)})
            assert status == 200
            assert body['valid'] is False

    def test_a_stored_pass_arrow_is_read_as_plain_and_resaves(self, lambda_context):
        with _api() as env:
            legacy = store.create_workflow(env.agents, _custom_step_workflow('pass'), created_by='admin-sub',
                                           username='alice', now=store.utc_now())
            workflow_id = legacy['workflow_id']
            status, body = _call(lambda_context, 'GET', f'/workflows/{workflow_id}', claims=USER)
            assert status == 200
            definition = body['workflow']['definition']
            assert [e for e in definition['edges'] if e['source'] == 'custom'] == [
                {'id': 'e2', 'source': 'custom', 'target': 'end'}]
            status, exported = _call(lambda_context, 'GET', f'/workflows/{workflow_id}/export', claims=USER)
            assert status == 200
            assert all('label' not in e for e in exported['edges'])
            status, _ = _call(lambda_context, 'PUT', f'/workflows/{workflow_id}',
                              body={'definition': definition, 'expected_revision': 1})
            assert status == 200


def _new_workflow(lambda_context):
    status, body = _call(lambda_context, 'POST', '/workflows', body={'definition': workflow_schema.default_template()})
    assert status == 201, body
    return body['workflow']['workflow_id']


class TestWorkflowArchive:
    """QA s2: a workflow could not be removed. DELETE archives it, like an agent."""

    def test_archive_hides_it_from_the_library_and_keeps_it_for_admins(self, lambda_context):
        with _api() as env:
            workflow_id = _new_workflow(lambda_context)

            status, body = _call(lambda_context, 'DELETE', f'/workflows/{workflow_id}')

            assert status == 200, body
            assert body['workflow']['status'] == 'archived'
            listed = [w['workflow_id'] for w in _call(lambda_context, 'GET', '/workflows')[1]['items']]
            assert listed == ['wf_default']
            everything = _call(lambda_context, 'GET', '/workflows', query={'include_archived': 'true'})[1]['items']
            assert [w['workflow_id'] for w in everything] == ['wf_default', workflow_id]
            assert _call(lambda_context, 'GET', f'/workflows/{workflow_id}')[0] == 200
            assert _call(lambda_context, 'GET', f'/workflows/{workflow_id}', claims=USER)[0] == 404
            # Soft: the rows are still there.
            stored = store.get_workflow(env.agents, workflow_id)
            assert stored is not None
            assert stored['status'] == 'archived'

    def test_an_archived_workflow_is_read_only_and_cannot_back_a_new_agent(self, lambda_context):
        with _api():
            workflow_id = _new_workflow(lambda_context)
            _call(lambda_context, 'DELETE', f'/workflows/{workflow_id}')

            assert _call(lambda_context, 'PUT', f'/workflows/{workflow_id}',
                         body={'definition': workflow_schema.default_template(), 'expected_revision': 1})[0] == 404
            assert _call(lambda_context, 'POST', f'/workflows/{workflow_id}/duplicate', body={})[0] == 404
            assert _call(lambda_context, 'POST', '/agents', body=agent_body(workflow_id=workflow_id))[0] == 400

    def test_archiving_is_admin_only_idempotent_and_refuses_the_builtin(self, lambda_context):
        with _api():
            workflow_id = _new_workflow(lambda_context)

            assert _call(lambda_context, 'DELETE', f'/workflows/{workflow_id}', claims=USER)[0] == 403
            assert _call(lambda_context, 'DELETE', f'/workflows/{workflow_id}')[0] == 200
            assert _call(lambda_context, 'DELETE', f'/workflows/{workflow_id}')[0] == 200
            assert _call(lambda_context, 'DELETE', '/workflows/wf_default')[0] == 409
            assert _call(lambda_context, 'DELETE', '/workflows/wf_missing0000000000')[0] == 404
            assert _call(lambda_context, 'GET', '/workflows', claims=USER,
                         query={'include_archived': 'true'})[0] == 403

    def test_a_workflow_an_active_agent_runs_is_refused_until_the_agent_is_archived(self, lambda_context):
        with _api():
            agent = _create(lambda_context)

            status, body = _call(lambda_context, 'DELETE', f"/workflows/{agent['workflow_id']}")
            assert status == 409
            assert agent['name'] in body['error']

            assert _call(lambda_context, 'DELETE', f"/agents/{agent['agent_id']}")[0] == 200
            assert _call(lambda_context, 'DELETE', f"/workflows/{agent['workflow_id']}")[0] == 200
