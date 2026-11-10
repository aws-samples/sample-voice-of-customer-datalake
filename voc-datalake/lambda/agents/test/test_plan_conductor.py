"""The plan branch of the conductor: decisions, waits, identity re-checks, failure, cancel, expiry, caps."""
from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

import pytest

from agents.conductor import plan_execution
from agents.conductor.plan_state import PlanState
from agents.test.plan_fixtures import (
    APPROVER,
    PlanEnv,
    conduct,
    drive,
    plan_env,
    plan_of,
    run_steps,
    write_step,
)
from shared import agents_store
from shared import plans_store as ps
from shared.plan_canonical import canonical_write_fingerprint
from shared.plan_schema import CARD_ONLY_WRITE_TOOLS
from shared.test.plan_fixture_plans import fixture_plan


@pytest.fixture
def env():
    with plan_env() as environment:
        yield environment


def _later(minutes: int):
    return patch.object(agents_store, 'utc_now', return_value=agents_store.utc_now() + timedelta(minutes=minutes))


def _two_independent_chains() -> dict:
    return plan_of(
        write_step('s1', 'create_project', {'name': 'A'}, produces=['project_id']),
        write_step('s2', 'update_project', {'project_id': '{{s1.project_id}}', 'description': 'x'},
                   pack='project', after=['s1']),
        write_step('s3', 'create_project', {'name': 'B'}, produces=['project_id']),
    )


# -- a plan that runs to the end --------------------------------------------------------------------

def test_a_chain_runs_in_order_and_completes(env: PlanEnv):
    plan_id = env.create(fixture_plan('valid-small-non-admin'))
    finished = drive(env, plan_id)
    assert finished == {'kind': 'finish', 'status': ps.PLAN_COMPLETED}
    assert [event['step']['id'] for event in env.plan_step.events] == ['s1', 's2']
    assert env.statuses(plan_id) == {'s1': ps.STEP_DONE, 's2': ps.STEP_DONE}


def test_a_later_step_gets_the_earlier_outputs_as_resolved_references(env: PlanEnv):
    plan_id = env.create(fixture_plan('valid-small-non-admin'))
    drive(env, plan_id)
    assert env.plan_step.event_for('s2')['resolved'] == {'s1.project_id': 's1-project_id'}


def test_a_step_runs_as_the_approver_with_the_plan_principal_and_no_admin_group(env: PlanEnv):
    plan_id = env.create(fixture_plan('valid-small-non-admin'))
    drive(env, plan_id)
    assert env.plan_step.event_for('s1')['claims'] == {
        'sub': APPROVER.sub, 'cognito:username': APPROVER.username, 'cognito:groups': 'users',
        'voc:acting_subject': APPROVER.sub, 'voc:principal': f'plan:{plan_id}'}


def _literal_then_free() -> dict:
    """s1 fully literal, s2 (after s1) with one {{free}} field."""
    return plan_of(write_step('s1', 'create_project', {'name': 'Checkout'}, produces=['project_id']),
                   write_step('s2', 'update_project', {'project_id': '{{s1.project_id}}', 'description': '{{free}}'},
                              after=['s1']))


def test_the_plan_records_a_summary_and_the_model_calls_of_free_field_writes(env: PlanEnv):
    plan_id = env.create(_literal_then_free())
    drive(env, plan_id)
    meta = env.meta(plan_id)
    assert meta['summary'] == '2 of 2 steps done.'
    assert meta['model_calls'] == 1  # s2 has a {{free}} field; s1 is fully literal


def test_at_most_three_ready_steps_run_at_once(env: PlanEnv):
    plan_id = env.create(plan_of(*(write_step(f's{i}', 'create_project', {'name': str(i)}) for i in range(1, 5))))
    directive = conduct({'action': 'plan_decide', 'plan_id': plan_id})
    assert directive == {'kind': 'execute', 'steps': ['s1', 's2', 's3']}
    assert env.meta(plan_id)['status'] == ps.PLAN_RUNNING


# -- the Example Air plan: admin tools, waits, think steps ---------------------------------------------------

def _complete_import(env: PlanEnv, plan_id: str) -> None:
    execution = env.steps(plan_id)['s2']['outputs']['execution_id']
    env.aggregates.put_item(Item={'pk': 'SOURCE_RUN#app_reviews_ios', 'sk': execution, 'status': 'completed',
                                  'items_found': 42})


def _complete_jobs(env: PlanEnv, plan_id: str) -> None:
    for row in env.steps(plan_id).values():
        job = (row.get('outputs') or {}).get('job_id')
        if job:
            env.jobs.put_item(Item={'pk': 'PROJECT#s5-project_id', 'sk': f'JOB#{job}', 'status': 'completed'})


def _example(env: PlanEnv) -> str:
    env.cognito.groups = ['admins', 'users']
    plan_id = env.create(fixture_plan('valid-example'))

    def on_wait(_count: int) -> None:
        _complete_import(env, plan_id)
        _complete_jobs(env, plan_id)

    assert drive(env, plan_id, on_wait=on_wait)['status'] == ps.PLAN_COMPLETED
    return plan_id


def test_the_example_plan_waits_for_each_job_and_completes(env: PlanEnv):
    plan_id = _example(env)
    steps = env.steps(plan_id)
    assert set(env.statuses(plan_id).values()) == {ps.STEP_DONE}
    assert steps['s3']['outputs'] == {'status': 'completed', 'items_found': '42'}


def test_admins_is_forwarded_only_for_the_admin_only_tools(env: PlanEnv):
    _example(env)
    groups = {event['step']['id']: event['claims']['cognito:groups'] for event in env.plan_step.events}
    assert groups['s1'] == groups['s2'] == 'admins,users'
    assert groups['s5'] == groups['s6'] == 'users'


def _scrapers_think() -> dict:
    return plan_of({'id': 's1', 'pack': 'scrapers', 'kind': 'think', 'title': 'Read the import',
                    'think': {'brief': 'How did the last import go?'}, 'produces': ['summary']})


@pytest.mark.parametrize(('groups', 'forwarded'), [(['admins', 'users'], 'admins,users'), (['users'], 'users')])
def test_a_scrapers_think_step_reads_as_admin_only_while_the_approver_is_one(env: PlanEnv, groups: list[str],
                                                                               forwarded: str):
    env.cognito.groups = groups
    plan_id = env.create(_scrapers_think())
    assert drive(env, plan_id)['status'] == ps.PLAN_COMPLETED
    assert env.plan_step.event_for('s1')['claims']['cognito:groups'] == forwarded


def test_a_think_output_reaches_later_steps_only_as_think_outputs(env: PlanEnv):
    _example(env)
    event = env.plan_step.event_for('s8')
    assert event['think_outputs'] == {'s4.summary': 's4-summary'}
    assert 's4.summary' not in event['resolved']


def test_a_wait_keeps_waiting_while_the_job_runs(env: PlanEnv):
    plan_id = env.create(fixture_plan('valid-small-non-admin') | {'steps': [
        write_step('s1', 'create_project', {'name': 'A'}, produces=['project_id']),
        {'id': 's2', 'pack': 'project', 'kind': 'wait', 'after': ['s1'], 'title': 'Wait',
         'wait': {'for': 'project_job', 'project_id': '{{s1.project_id}}', 'job_id': 'job_9'}},
    ]})
    env.jobs.put_item(Item={'pk': 'PROJECT#s1-project_id', 'sk': 'JOB#job_9', 'status': 'running'})
    directive = drive(env, plan_id)
    assert directive == {'kind': 'wait', 'wait_seconds': 30}
    assert env.statuses(plan_id)['s2'] == ps.STEP_WAITING


def test_a_wait_past_its_timeout_fails(env: PlanEnv):
    plan_id = env.create(plan_of({'id': 's1', 'pack': 'scrapers', 'kind': 'wait', 'title': 'Wait',
                                  'wait': {'for': 'scraper_run', 'scraper_id': 'sc_1', 'execution_id': 'run_1',
                                           'timeout_minutes': 5}}))
    drive(env, plan_id)
    with _later(6):
        finished = drive(env, plan_id)
    assert finished['status'] == ps.PLAN_COMPLETED_WITH_ERRORS
    assert env.steps(plan_id)['s1']['error'] == 'The wait timed out.'


def test_a_failed_job_fails_its_wait(env: PlanEnv):
    plan_id = env.create(plan_of({'id': 's1', 'pack': 'scrapers', 'kind': 'wait', 'title': 'Wait',
                                  'wait': {'for': 'source_run', 'source': 'app_reviews_ios', 'execution_id': 'r1'}}))
    env.aggregates.put_item(Item={'pk': 'SOURCE_RUN#app_reviews_ios', 'sk': 'r1', 'status': 'error'})
    assert drive(env, plan_id)['status'] == ps.PLAN_COMPLETED_WITH_ERRORS
    assert env.steps(plan_id)['s1']['error'] == 'The import failed.'


# -- failure, skipping ----------------------------------------------------------------------------------

def test_a_failed_step_skips_its_dependents_and_independent_steps_continue(env: PlanEnv):
    env.plan_step.results['s1'] = {'status': 'failed', 'error': 'Project name taken'}
    plan_id = env.create(_two_independent_chains())
    finished = drive(env, plan_id)
    assert finished['status'] == ps.PLAN_COMPLETED_WITH_ERRORS
    assert env.statuses(plan_id) == {'s1': ps.STEP_FAILED, 's2': ps.STEP_SKIPPED, 's3': ps.STEP_DONE}
    assert 's1 (Run create_project) failed: Project name taken' in env.meta(plan_id)['summary']


def test_a_step_whose_result_was_lost_fails_at_the_next_decide(env: PlanEnv):
    plan_id = env.create(plan_of(write_step('s1', 'create_project', {'name': 'A'})))
    conduct({'action': 'plan_decide', 'plan_id': plan_id})
    conduct({'action': 'plan_prepare', 'plan_id': plan_id, 'step_id': 's1'})
    assert drive(env, plan_id)['status'] == ps.PLAN_COMPLETED_WITH_ERRORS
    assert env.steps(plan_id)['s1']['error'] == 'The step stopped before it reported a result.'


def test_a_state_machine_error_is_recorded_by_name_only(env: PlanEnv):
    plan_id = env.create(plan_of(write_step('s1', 'create_project', {'name': 'A'})))
    conduct({'action': 'plan_decide', 'plan_id': plan_id})
    conduct({'action': 'plan_record', 'plan_id': plan_id, 'step_id': 's1',
             'error': {'Error': 'Lambda.Unknown', 'Cause': 'secret review text'}})
    error = env.steps(plan_id)['s1']['error']
    assert error == 'The step stopped on an internal error (Lambda.Unknown).'


def test_an_unexpected_result_fails_the_step(env: PlanEnv):
    env.plan_step.results['s1'] = {'status': 'maybe'}
    plan_id = env.create(plan_of(write_step('s1', 'create_project', {'name': 'A'})))
    drive(env, plan_id)
    assert env.steps(plan_id)['s1']['error'] == 'The step returned an unexpected result.'


def test_the_conductor_internal_error_fails_the_plan_and_skips_open_steps(env: PlanEnv):
    plan_id = env.create(_two_independent_chains())
    conduct({'action': 'plan_decide', 'plan_id': plan_id})
    finished = conduct({'action': 'plan_fail', 'plan_id': plan_id, 'error': {'Error': 'States.Timeout'}})
    assert finished == {'kind': 'finish', 'status': ps.PLAN_FAILED}
    assert set(env.statuses(plan_id).values()) == {ps.STEP_SKIPPED}
    assert env.meta(plan_id)['summary'] == 'The plan stopped on an internal error (States.Timeout).'


@pytest.mark.usefixtures('env')
def test_an_unknown_plan_finishes_failed():
    assert conduct({'action': 'plan_decide', 'plan_id': 'pl_000000000000'})['status'] == ps.PLAN_FAILED


# -- paused writes -----------------------------------------------------------------------------------

def _paused_result(args: dict, fingerprint: str | None = None) -> dict:
    return {'status': 'needs_approval', 'pending': {
        'tool': 'create_project', 'args': args, 'reason': 'The name differs from the plan.',
        'fingerprint': fingerprint or canonical_write_fingerprint('create_project', args)}}


def test_a_paused_write_waits_for_the_approver_and_then_runs_with_those_arguments(env: PlanEnv):
    env.plan_step.results['s1'] = _paused_result({'name': 'Renamed'})
    plan_id = env.create(plan_of(write_step('s1', 'create_project', {'name': 'A'})))
    assert drive(env, plan_id) == {'kind': 'wait', 'wait_seconds': 30}
    ps.approve_step(env.agents, plan_id, 's1', fingerprint=canonical_write_fingerprint('create_project', {'name': 'Renamed'}),
                    now=agents_store.utc_now())
    env.plan_step.results.pop('s1')
    assert drive(env, plan_id)['status'] == ps.PLAN_COMPLETED
    assert env.plan_step.event_for('s1')['approved_pending']['args'] == {'name': 'Renamed'}


@pytest.mark.parametrize('reported', [None, '1' * 64])
def test_an_approved_write_reported_done_with_another_fingerprint_fails_and_is_never_done(env: PlanEnv,
                                                                                         reported: str | None):
    args = {'name': 'Renamed'}
    env.plan_step.results['s1'] = _paused_result(args)
    plan_id = env.create(plan_of(write_step('s1', 'create_project', {'name': 'A'})))
    drive(env, plan_id)
    ps.approve_step(env.agents, plan_id, 's1', fingerprint=canonical_write_fingerprint('create_project', args),
                    now=agents_store.utc_now())
    env.plan_step.results['s1'] = {'status': 'done', 'outputs': {}, **({'fingerprint': reported} if reported else {})}
    drive(env, plan_id)
    assert (env.statuses(plan_id)['s1'], env.steps(plan_id)['s1']['error']) == (
        ps.STEP_FAILED, 'The write that ran is not the one you approved.')


def test_a_paused_write_with_a_wrong_fingerprint_fails(env: PlanEnv):
    env.plan_step.results['s1'] = _paused_result({'name': 'Renamed'}, fingerprint='0' * 64)
    plan_id = env.create(plan_of(write_step('s1', 'create_project', {'name': 'A'})))
    drive(env, plan_id)
    assert env.steps(plan_id)['s1']['error'] == 'The paused write could not be verified.'


def test_a_paused_write_nobody_approves_fails_after_30_minutes(env: PlanEnv):
    env.plan_step.results['s1'] = _paused_result({'name': 'Renamed'})
    plan_id = env.create(_two_independent_chains())
    drive(env, plan_id)
    with _later(31):
        finished = drive(env, plan_id)
    assert finished['status'] == ps.PLAN_COMPLETED_WITH_ERRORS
    assert env.statuses(plan_id) == {'s1': ps.STEP_FAILED, 's2': ps.STEP_SKIPPED, 's3': ps.STEP_DONE}


def test_a_declined_write_fails_and_skips_its_dependents(env: PlanEnv):
    env.plan_step.results['s1'] = _paused_result({'name': 'Renamed'})
    plan_id = env.create(_two_independent_chains())
    drive(env, plan_id)
    ps.decline_step(env.agents, plan_id, 's1', now=agents_store.utc_now())
    assert drive(env, plan_id)['status'] == ps.PLAN_COMPLETED_WITH_ERRORS
    assert env.steps(plan_id)['s2']['error'] == 'Skipped: step s1 did not complete.'


def test_a_never_preapprovable_write_reported_done_without_approval_fails(env: PlanEnv):
    plan_id = env.create(plan_of(write_step('s1', 'delete_document', {'project_id': 'p1', 'document_id': 'd1'},
                                            pack='project')))
    drive(env, plan_id)
    assert env.steps(plan_id)['s1']['error'] == 'The write ran without its required approval.'



@pytest.mark.parametrize('tool', sorted(CARD_ONLY_WRITE_TOOLS))
def test_a_card_only_write_reported_done_by_a_plan_step_trips_the_wire(tool: str):
    state = PlanState(meta={'plan_id': 'pl_000000000001'}, rows={'s1': {'approved_pending_json': '{}'}},
                      definitions={'s1': {'id': 's1', 'kind': 'write', 'write': {'tool': tool, 'args': {}}}},
                      order=['s1'], now=agents_store.utc_now())
    assert plan_execution._ran_unapproved(state, 's1') is True

# -- identity re-check ----------------------------------------------------------------------------------

@pytest.mark.parametrize(('change', 'reason'), [
    ({'enabled': False}, "The approver's account is disabled."),
    ({'exists': False}, "The approver's account no longer exists."),
    ({'sub': 'someone-else'}, "The approver's account no longer matches the plan."),
])
def test_an_approver_who_is_no_longer_current_stops_the_plan(env: PlanEnv, change: dict, reason: str):
    plan_id = env.create(_two_independent_chains())
    for name, value in change.items():
        setattr(env.cognito, name, value)
    assert drive(env, plan_id)['status'] == ps.PLAN_FAILED
    assert env.plan_step.events == []
    assert env.steps(plan_id)['s1']['error'] == reason


def test_a_demoted_admin_stops_the_plan_at_the_admin_only_write(env: PlanEnv):
    env.cognito.groups = ['users']
    plan_id = env.create(fixture_plan('valid-example'))
    assert drive(env, plan_id)['status'] == ps.PLAN_FAILED
    assert env.steps(plan_id)['s1']['error'] == 'The approver is no longer an administrator.'
    assert env.statuses(plan_id)['s10'] == ps.STEP_SKIPPED


def test_a_directory_fault_fails_the_step_closed_without_running_it(env: PlanEnv):
    env.cognito.broken = True
    plan_id = env.create(plan_of(write_step('s1', 'create_project', {'name': 'A'})))
    assert drive(env, plan_id)['status'] == ps.PLAN_COMPLETED_WITH_ERRORS
    assert env.plan_step.events == []
    assert env.steps(plan_id)['s1']['error'] == 'The user directory could not confirm the approver.'


# -- cancel, expiry, caps ------------------------------------------------------------------------------

def test_a_cancelled_plan_finishes_and_starts_nothing_new(env: PlanEnv):
    plan_id = env.create(fixture_plan('valid-small-non-admin'))
    directive = conduct({'action': 'plan_decide', 'plan_id': plan_id})
    run_steps(env, plan_id, directive['steps'])
    ps.cancel_plan(env.agents, plan_id, now=agents_store.utc_now())
    assert drive(env, plan_id) == {'kind': 'finish', 'status': ps.PLAN_CANCELLED}
    assert env.statuses(plan_id) == {'s1': ps.STEP_DONE, 's2': ps.STEP_CANCELLED}


def test_a_step_prepared_after_cancel_does_not_run(env: PlanEnv):
    plan_id = env.create(plan_of(write_step('s1', 'create_project', {'name': 'A'})))
    conduct({'action': 'plan_decide', 'plan_id': plan_id})
    ps.cancel_plan(env.agents, plan_id, now=agents_store.utc_now())
    assert conduct({'action': 'plan_prepare', 'plan_id': plan_id, 'step_id': 's1'}) == {'run': False}


def test_an_approved_plan_that_starts_after_24_hours_expires(env: PlanEnv):
    plan_id = env.create(fixture_plan('valid-small-non-admin'),
                         now=agents_store.utc_now() - timedelta(hours=25))
    assert drive(env, plan_id) == {'kind': 'finish', 'status': ps.PLAN_EXPIRED}
    assert env.plan_step.events == []


def test_a_plan_out_of_model_calls_fails_its_model_steps(env: PlanEnv):
    plan_id = env.create(_literal_then_free())
    ps.update_meta(env.agents, plan_id, ps.Change({'model_calls': 60}, (ps.PLAN_APPROVED,)), now=agents_store.utc_now())
    drive(env, plan_id)
    assert env.statuses(plan_id) == {'s1': ps.STEP_DONE, 's2': ps.STEP_FAILED}
    assert env.steps(plan_id)['s2']['error'] == 'The plan has spent its 60 model calls.'


def test_a_plan_out_of_background_jobs_fails_the_seventh_job(env: PlanEnv):
    steps = [write_step(f's{i}', 'generate_personas', {'project_id': 'p1', 'persona_count': 3},
                        pack='project', produces=['job_id']) for i in range(1, 8)]
    for index, step in enumerate(steps[1:], start=1):
        step['after'] = [f's{index}']
    plan_id = env.create(plan_of(*steps))
    drive(env, plan_id)
    assert env.statuses(plan_id)['s7'] == ps.STEP_FAILED
    assert env.steps(plan_id)['s7']['error'] == 'The plan has started its 6 background jobs.'


def test_after_an_hour_a_waiting_plan_polls_every_two_minutes(env: PlanEnv):
    plan_id = env.create(plan_of({'id': 's1', 'pack': 'scrapers', 'kind': 'wait', 'title': 'Wait',
                                  'wait': {'for': 'scraper_run', 'scraper_id': 'sc_1', 'execution_id': 'r1',
                                           'timeout_minutes': 600}}))
    drive(env, plan_id)
    with _later(61):
        assert drive(env, plan_id) == {'kind': 'wait', 'wait_seconds': 120}
