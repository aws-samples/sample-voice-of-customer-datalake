"""agents/notices.py: run and plan status notices on the ``runs`` channel, and where the conductor sends them."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError

from agents import notices
from agents.conductor import handler, plan_state


@pytest.fixture
def publish():
    with patch.object(notices.realtime, 'configured', return_value=True), \
            patch.object(notices.realtime, 'publish', return_value=True) as fake:
        yield fake


class TestRunChanged:
    def test_tells_the_owner_and_the_person_who_started_it_once_each(self, publish):
        notices.run_changed('ag_1', 'run_1', 'completed', agent={'owner_sub': 'owner'}, run={'requested_by': 'starter'})
        event = {'type': 'run', 'agent_id': 'ag_1', 'run_id': 'run_1', 'status': 'completed'}
        assert [c.args for c in publish.call_args_list] == [('runs', 'owner', event), ('runs', 'starter', event)]

    def test_a_scheduled_run_tells_only_the_owner(self, publish):
        notices.run_changed('ag_1', 'run_1', 'running', agent={'owner_sub': 'owner'}, run={'requested_by': 'heartbeat'})
        assert [c.args[1] for c in publish.call_args_list] == ['owner']

    def test_the_owner_who_started_it_is_told_once(self, publish):
        notices.run_changed('ag_1', 'run_1', 'failed', agent={'owner_sub': 'same'}, run={'requested_by': 'same'})
        assert publish.call_count == 1

    def test_reads_the_rows_it_was_not_given(self, publish):
        with patch.object(notices.store, 'get_agent', return_value={'owner_sub': 'owner'}) as agent, \
                patch.object(notices.store, 'get_run', return_value={}) as run:
            notices.run_changed('ag_1', 'run_1', 'cancelled')
        agent.assert_called_once_with('ag_1')
        run.assert_called_once_with('ag_1', 'run_1')
        assert publish.call_args.args[1] == 'owner'

    def test_a_failed_read_sends_nothing_and_never_raises(self, publish):
        error = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'GetItem')
        with patch.object(notices.store, 'get_agent', side_effect=error):
            notices.run_changed('ag_1', 'run_1', 'completed')
        publish.assert_not_called()

    def test_without_an_event_api_nothing_is_read_or_sent(self):
        with patch.object(notices.realtime, 'configured', return_value=False), \
                patch.object(notices.store, 'get_agent') as agent, \
                patch.object(notices.realtime, 'publish') as fake:
            notices.run_changed('ag_1', 'run_1', 'completed')
        agent.assert_not_called()
        fake.assert_not_called()


class TestPlanChanged:
    def test_tells_the_approver_with_the_change_and_step(self, publish):
        notices.plan_changed('pl_1', 'step_started', meta={'approver_sub': 'approver'}, step_id='s1')
        publish.assert_called_once_with('runs', 'approver', {
            'type': 'plan', 'plan_id': 'pl_1', 'change': 'step_started', 'step_id': 's1'})

    def test_reads_the_plan_when_not_given(self, publish):
        with patch.object(notices.ps, 'get_meta', return_value={'approver_sub': 'approver'}), \
                patch.object(notices, 'get_agents_table', return_value=object()):
            notices.plan_changed('pl_1', 'plan_failed')
        assert publish.call_args.args[1:] == ('approver', {'type': 'plan', 'plan_id': 'pl_1', 'change': 'plan_failed'})


class TestWhereTheConductorSends:
    def test_a_finished_run_is_told(self):
        with patch.object(handler.store, 'finish_run', return_value=True), \
                patch.object(handler.store, 'append_event'), \
                patch.object(handler.run_memory, 'enqueue_finished_run'), \
                patch.object(handler.notices, 'run_changed') as changed:
            handler._finish('ag_1', 'run_1', handler.store.RUN_COMPLETED, 'done')
        changed.assert_called_once_with('ag_1', 'run_1', handler.store.RUN_COMPLETED)

    def test_a_run_that_had_already_left_running_is_not_told_as_finished(self):
        with patch.object(handler.store, 'finish_run', return_value=False), \
                patch.object(handler.store, 'get_run', return_value={'status': 'completed'}), \
                patch.object(handler.notices, 'run_changed') as changed:
            handler._finish('ag_1', 'run_1', handler.store.RUN_FAILED, 'x')
        changed.assert_not_called()

    def test_every_plan_journal_row_is_a_notice(self):
        with patch.object(plan_state.ps, 'append_event') as append, \
                patch.object(plan_state, 'table', return_value='t'), \
                patch.object(plan_state.notices, 'plan_changed') as changed:
            plan_state.journal('pl_1', 'step_finished', 'Title', now=plan_state.agents_store.utc_now(), step_id='s2',
                               meta={'approver_sub': 'a'})
        assert append.call_args.args[:4] == ('t', 'pl_1', 'step_finished', 'Title')
        changed.assert_called_once_with('pl_1', 'step_finished', meta={'approver_sub': 'a'}, step_id='s2')
