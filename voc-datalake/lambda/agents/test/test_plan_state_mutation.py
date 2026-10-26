"""Mutation hardening for `agents/conductor/plan_state.py`.

`test_plan_conductor.py` drives whole plans through moto, so it sees plan_state only through the
decisions a run makes. A mutation run found what those end-to-end runs cannot see:

* the exact CAP BOUNDARIES and their wording: 59 model calls run, 60 refuse with
  "The plan has spent its 60 model calls."; 5 started jobs run, 6 refuse with "... 6 background jobs.";
  a missing ``model_calls`` counts as zero; every job tool (and only a job tool) meets the jobs cap.
* how a job is COUNTED: one per row whose outputs hold ``job_id`` or ``execution_id``, never twice.
* which OUTPUTS a later step gets: only done steps, think text apart from ids, every row walked
  (a skipped row does not end the walk), values as strings under ``"sN.name"``.
* the small predicates the conductor branches on (``uses_model``, ``needs_admin``, ``admin_reads``,
  ``write_tool``, ``{{free}}`` detection in nested args) on both sides of each condition.
* ``load`` and ``table``: an absent plan is None, the rows keep their stored order, ``now`` defaults to
  the store clock, and an unconfigured table names the variable.
"""
from __future__ import annotations

import dataclasses
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Any, Final
from unittest.mock import MagicMock, patch

import pytest

from agents.conductor import plan_state
from agents.conductor.plan_state import JOB_TOOLS, PlanState
from shared import plans_store as ps
from shared.plan_schema import ADMIN_ONLY_WRITE_TOOLS, PLAN_LIMITS

T0 = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
T1 = datetime(2026, 2, 3, 4, 5, 6, tzinfo=UTC)


def _state(rows: dict[str, dict] | None = None, definitions: dict[str, dict] | None = None,
           meta: dict | None = None) -> PlanState:
    rows = rows or {}
    return PlanState(meta=meta if meta is not None else {'plan_id': 'pl_000000000001'}, rows=rows,
                     definitions=definitions or {}, order=list(rows), now=T0)


def _write(tool: Any = 'create_project', args: Any = None, *, kind: str = 'write', pack: str = 'core') -> dict:
    return {'kind': kind, 'pack': pack, 'write': {'tool': tool, 'args': args if args is not None else {}}}


def _job_rows(count: int) -> dict[str, dict]:
    return {f's{i}': {'status': ps.STEP_DONE, 'outputs': {'job_id': f'j{i}'}} for i in range(count)}


class TestTheTable:
    def test_an_unconfigured_table_names_the_variable(self):
        with patch.object(plan_state.agents_store, 'get_agents_table', return_value=None), \
                pytest.raises(RuntimeError, match=r'^AGENTS_TABLE is not configured$'):
            plan_state.table()

    def test_a_configured_table_is_returned_as_is(self):
        found = object()
        with patch.object(plan_state.agents_store, 'get_agents_table', return_value=found):
            assert plan_state.table() is found


class TestLoad:
    def test_an_absent_plan_is_none_and_reads_no_steps(self):
        steps = MagicMock()
        with patch.object(plan_state, 'table', return_value='T'), \
                patch.object(ps, 'get_meta', return_value=None) as get_meta, \
                patch.object(ps, 'get_steps', steps):
            assert plan_state.load('pl_1') is None
        get_meta.assert_called_once_with('T', 'pl_1')
        steps.assert_not_called()

    def _load(self, now: datetime | None) -> PlanState | None:
        meta = {'plan_id': 'pl_1', 'plan': {'steps': [{'id': 's2', 'kind': 'think'}, {'id': 's1', 'kind': 'write'}]}}
        rows = [{'step_id': 's2', 'status': 'done'}, {'step_id': 's1', 'status': 'pending'}]
        with patch.object(plan_state, 'table', return_value='T'), \
                patch.object(ps, 'get_meta', return_value=meta), \
                patch.object(ps, 'get_steps', return_value=rows) as get_steps, \
                patch.object(ps, 'plan_steps_by_id', return_value={'s1': {'id': 's1'}}) as by_id, \
                patch.object(plan_state.agents_store, 'utc_now', return_value=T1):
            state = plan_state.load('pl_1', now)
        get_steps.assert_called_once_with('T', 'pl_1')
        by_id.assert_called_once_with(meta)
        return state

    def test_a_plan_loads_its_rows_by_id_in_stored_order(self):
        state = self._load(T0)
        assert state == PlanState(
            meta={'plan_id': 'pl_1', 'plan': {'steps': [{'id': 's2', 'kind': 'think'}, {'id': 's1', 'kind': 'write'}]}},
            rows={'s2': {'step_id': 's2', 'status': 'done'}, 's1': {'step_id': 's1', 'status': 'pending'}},
            definitions={'s1': {'id': 's1'}}, order=['s2', 's1'], now=T0)

    def test_now_defaults_to_the_store_clock(self):
        state = self._load(None)
        assert state is not None
        assert state.now == T1


class TestThePlanStateReads:
    def test_the_state_is_frozen(self):
        with pytest.raises(dataclasses.FrozenInstanceError):
            _state().__setattr__('now', T1)

    def test_plan_id_is_the_meta_id_as_text(self):
        assert _state(meta={'plan_id': 7}).plan_id == '7'

    @pytest.mark.parametrize(('rows', 'expected'), [
        ({}, ''), ({'s1': {}}, ''), ({'s1': {'status': None}}, ''), ({'s1': {'status': 'done'}}, 'done'),
    ])
    def test_status(self, rows: dict, expected: str):
        assert _state(rows).status('s1') == expected

    @pytest.mark.parametrize(('definitions', 'expected'), [
        ({}, []), ({'s2': {}}, []), ({'s2': {'after': None}}, []), ({'s2': {'after': ('s0', 's1')}}, ['s0', 's1']),
    ])
    def test_after(self, definitions: dict, expected: list):
        assert _state(definitions=definitions).after('s2') == expected

    @pytest.mark.parametrize(('statuses', 'done'), [
        ({}, False), ({'s0': 'done'}, False), ({'s0': 'running', 's1': 'done'}, False),
        ({'s0': 'done', 's1': 'done'}, True),
    ])
    def test_dependencies_done_needs_every_dependency_done(self, statuses: dict, done: bool):
        state = _state({sid: {'status': status} for sid, status in statuses.items()},
                       {'s2': {'after': ['s0', 's1']}})
        assert state.dependencies_done('s2') is done

    def test_no_dependencies_are_done(self):
        assert _state(definitions={'s2': {}}).dependencies_done('s2') is True


OUTPUT_ROWS: Final = MappingProxyType({
    's1': {'status': ps.STEP_RUNNING, 'outputs': {'project_id': 'p0'}},
    's2': {'status': ps.STEP_DONE, 'outputs': {'summary': 'text'}},
    's3': {'status': ps.STEP_DONE, 'outputs': None},
    's4': {'status': ps.STEP_DONE, 'outputs': ['not', 'a', 'dict']},
    's5': {'status': ps.STEP_DONE, 'outputs': {'project_id': 'p1', 'count': 3}},
})
OUTPUT_DEFINITIONS: Final = MappingProxyType({'s2': {'kind': 'think'}, 's5': {'kind': 'write'}})


class TestOutputs:
    def test_ids_are_every_done_non_think_output_as_text(self):
        assert _state(dict(OUTPUT_ROWS), dict(OUTPUT_DEFINITIONS)).outputs(think=False) == {
            's5.project_id': 'p1', 's5.count': '3'}

    def test_think_text_is_only_the_done_think_steps(self):
        assert _state(dict(OUTPUT_ROWS), dict(OUTPUT_DEFINITIONS)).outputs(think=True) == {'s2.summary': 'text'}


class TestJobsStarted:
    @pytest.mark.parametrize('name', ['job_id', 'execution_id'])
    def test_each_job_output_counts_once(self, name: str):
        rows = {'s1': {'outputs': {name: 'x'}}, 's2': {'outputs': {name: 'y', 'other': 'z'}}}
        assert _state(rows).jobs_started() == 2

    def test_a_row_with_both_outputs_is_one_job(self):
        assert _state({'s1': {'outputs': {'job_id': 'j', 'execution_id': 'e'}}}).jobs_started() == 1

    def test_rows_without_job_outputs_are_not_counted(self):
        rows = {'s1': {}, 's2': {'outputs': None}, 's3': {'outputs': ['job_id']}, 's4': {'outputs': {'id': 'x'}}}
        assert _state(rows).jobs_started() == 0


class TestPredicates:
    @pytest.mark.parametrize(('definition', 'tool'), [
        ({}, None), ({'write': 'create_project'}, None), ({'write': {}}, None), ({'write': {'tool': 3}}, None),
        ({'write': {'tool': 'create_project'}}, 'create_project'),
    ])
    def test_write_tool(self, definition: dict, tool: str | None):
        assert plan_state.write_tool(definition) == tool

    @pytest.mark.parametrize(('definition', 'uses'), [
        ({'kind': 'think'}, True),
        (_write(args={'description': '{{free}}'}), True),
        (_write(args={'items': ['a', '{{free}}']}), True),
        (_write(args={'outer': {'inner': '{{free}}'}}), True),
        (_write(args={'description': 'not {{free}}', 'n': 1, 'items': ['a'], 'outer': {'k': 'v'}}), False),
        (_write(args='{{free}}'), True),
        (_write(args={'description': '{{free}}'}, kind='wait'), False),
        ({'kind': 'write', 'write': '{{free}}'}, False),
        ({'kind': 'write'}, False),
    ])
    def test_uses_model(self, definition: dict, uses: bool):
        assert plan_state.uses_model(definition) is uses

    @pytest.mark.parametrize(('definition', 'admin'), [
        (_write(pack='settings'), True),
        (_write('run_scraper', pack='scrapers'), True),
        (_write(pack='scrapers'), False),
        ({'kind': 'think', 'pack': 'core'}, False),
    ])
    def test_needs_admin(self, definition: dict, admin: bool):
        assert plan_state.needs_admin(definition) is admin

    @pytest.mark.parametrize('tool', sorted(ADMIN_ONLY_WRITE_TOOLS))
    def test_every_admin_only_write_tool_needs_admin(self, tool: str):
        assert plan_state.needs_admin(_write(tool)) is True

    @pytest.mark.parametrize(('definition', 'reads'), [
        ({'kind': 'think', 'pack': 'scrapers'}, True),
        ({'kind': 'think', 'pack': 'settings'}, True),
        ({'kind': 'think', 'pack': 'core'}, False),
        (_write(pack='scrapers'), False),
    ])
    def test_admin_reads(self, definition: dict, reads: bool):
        assert plan_state.admin_reads(definition) is reads


class TestCaps:
    MODEL = 'The plan has spent its 60 model calls.'
    JOBS = 'The plan has started its 6 background jobs.'

    def test_the_limits_are_the_contract_values(self):
        assert (PLAN_LIMITS['modelCalls'], PLAN_LIMITS['jobs']) == (60, 6)

    @pytest.mark.parametrize(('calls', 'problem'), [(59, None), (60, MODEL), (61, MODEL), (None, None)])
    def test_the_model_calls_cap(self, calls: int | None, problem: str | None):
        state = _state(meta={'plan_id': 'pl_1', 'model_calls': calls})
        assert plan_state.cap_problem(state, {'kind': 'think'}) == problem

    def test_a_missing_model_calls_counts_as_zero(self):
        with patch.dict(PLAN_LIMITS, {'modelCalls': 1}):
            assert plan_state.cap_problem(_state(meta={'plan_id': 'pl_1'}), {'kind': 'think'}) is None
            assert plan_state.cap_problem(_state(meta={'plan_id': 'pl_1', 'model_calls': 1}), {'kind': 'think'}) == \
                'The plan has spent its 1 model calls.'

    def test_a_step_without_a_model_ignores_the_model_cap(self):
        state = _state(meta={'plan_id': 'pl_1', 'model_calls': 60})
        assert plan_state.cap_problem(state, _write('create_project')) is None

    @pytest.mark.parametrize('tool', sorted(JOB_TOOLS))
    @pytest.mark.parametrize(('started', 'problem'), [(5, None), (6, JOBS), (7, JOBS)])
    def test_the_jobs_cap(self, tool: str, started: int, problem: str | None):
        assert plan_state.cap_problem(_state(_job_rows(started)), _write(tool)) == problem

    def test_the_job_tools(self):
        assert sorted(JOB_TOOLS) == ['build_prototype', 'generate_document', 'generate_personas', 'run_agent',
                                     'run_scraper', 'run_source', 'start_research']

    def test_a_non_job_write_ignores_the_jobs_cap(self):
        assert plan_state.cap_problem(_state(_job_rows(6)), _write('create_project')) is None
