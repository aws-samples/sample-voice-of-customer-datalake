"""Mutation hardening for `agents/conductor/handler.py`.

`test_conductor_run.py` drives whole runs of the default workflow and asserts
that they FINISH with the right status, but a mutation run found what a whole
run cannot see:

* the WORDING of every finish: each refusal, timeout, escalation and loop
  message is the run row's ``error`` and the journal's ``decision`` — read
  back verbatim by the Runs page — and the ``Run started (…)`` / ``node_*`` /
  ``artifact`` / ``verdict`` journal lines;
* the BOUNDS: 120 steps (the 121st refused), 120 polls per node (the 121st
  times out), a run context of exactly 120,000 bytes kept and 120,001 refused,
  a loop that escalates on reaching ``max_rounds`` and not one round later,
  agent instructions clipped to 8,000 characters, an error name to 100;
* the envelope a crewmate is briefed with, line for line, and the revision
  target's fallback chain (param → last review target → ``prfaq``; a
  prototype revision always targets the prototype);
* verification of a claim: an unreadable project, a missing document, a
  document of another type (an untyped one passes), missing personas — and
  the claims the agent reads with;
* the fan-out scheduler: a join held until its forward predecessors ran, end
  nodes last, the oldest entry when nothing is ready, the queue de-duplicated
  and persisted with the dispatch;
* the hand-offs: a finish that lost the race settles a cancel, pins resolved
  only after a passing prototype review, and the result the state machine
  receives passes through ``store.plain``.
"""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, ClassVar
from unittest.mock import MagicMock, call, patch

import pytest

from agents import pins, principal, run_memory, store
from agents.conductor import handler
from agents.graph import Node, WorkflowError, WorkflowGraph
from agents.test.document_node_fixtures import AGENT
from shared.logging import metrics as shared_metrics
from shared.test.emf_fixtures import cold_start_metric_names
from shared.test.instrumentation_fixtures import INSTRUMENTED_HANDLER_LAYERS, handler_layers

AGENT_ID, RUN_ID = AGENT['agent_id'], 'ar_1'
IDS = {'agent_id': AGENT_ID, 'run_id': RUN_ID}
CLAIMS = {'sub': f'agent:{AGENT_ID}'}


def _raw(node_id: str, node_type: str, title: str = '', params: dict | None = None) -> dict:
    return {'id': node_id, 'type': node_type, 'data': {'title': title, 'params': params or {}}}


def _graph(nodes: list[dict], edges: list[tuple[str, str] | tuple[str, str, str]],
           loops: list[dict] | None = None) -> WorkflowGraph:
    return WorkflowGraph({
        'schema': 'voc-workflow/1', 'nodes': nodes,
        'edges': [{'source': e[0], 'target': e[1], 'label': e[2] if len(e) > 2 else None} for e in edges],
        'loops': loops or [],
    })


def _line() -> WorkflowGraph:
    """start → a ("Step A", custom_llm) → b ("Step B", custom_llm) → end."""
    return _graph([_raw('start', 'start'), _raw('a', 'custom_llm', 'Step A'), _raw('b', 'custom_llm', 'Step B'),
                   _raw('end', 'end', 'Done')], [('start', 'a'), ('a', 'b'), ('b', 'end')])


def _fan() -> WorkflowGraph:
    """start → p; p → x, p → y; x → j, y → j; j → end."""
    return _graph([_raw('start', 'start'), _raw('p', 'custom_llm', 'Project'), _raw('x', 'custom_llm', 'X'),
                   _raw('y', 'custom_llm', 'Y'), _raw('j', 'custom_llm', 'Join'), _raw('end', 'end')],
                  [('start', 'p'), ('p', 'x'), ('p', 'y'), ('x', 'j'), ('y', 'j'), ('j', 'end')])


def _review_loop(max_rounds: int = 3) -> WorkflowGraph:
    """start → review ("Panel"); agreed → end; not_agreed → revise → review, looped."""
    return _graph([_raw('start', 'start'), _raw('review', 'persona_review', 'Panel'),
                   _raw('revise', 'revise_document', 'Revise'), _raw('end', 'end')],
                  [('start', 'review'), ('review', 'end', 'agreed'), ('review', 'revise', 'not_agreed'),
                   ('revise', 'review')],
                  [{'node_ids': ['review', 'revise'], 'until': 'persona_agreement', 'max_rounds': max_rounds}])


def _node(node_type: str = 'custom_llm', *, node_id: str = 'a', title: str = 'Step A', instructions: str = '',
          params: dict | None = None, role: str = 'worker') -> Node:
    return Node(id=node_id, type=node_type, title=title, instructions=instructions, role=role, params=params or {})


def _run(**overrides: Any) -> dict:
    return {'run_id': RUN_ID, 'agent_id': AGENT_ID, 'status': 'running', 'current_node_id': 'a', 'steps': 3,
            'context': {}, **overrides}


@dataclass
class Seams:
    get_agent: MagicMock
    get_run: MagicMock
    start_run: MagicMock
    finish_run: MagicMock
    mark_cancelled: MagicMock
    append_event: MagicMock
    append_mate: MagicMock
    update_running: MagicMock
    enqueue: MagicMock
    brief: MagicMock
    get_project: MagicMock
    agent_claims: MagicMock
    resolve_addressed: MagicMock
    load_graph: MagicMock
    resolve_workflow: MagicMock

    def finished(self, status: str, error: str | None) -> None:
        self.finish_run.assert_called_once_with(AGENT_ID, RUN_ID, status, error)


@pytest.fixture
def seams() -> Iterator[Seams]:
    with (
        patch.object(store, 'get_agent', return_value=dict(AGENT)) as get_agent,
        patch.object(store, 'get_run', return_value=_run()) as get_run,
        patch.object(store, 'start_run') as start_run,
        patch.object(store, 'finish_run', return_value=True) as finish_run,
        patch.object(store, 'mark_cancelled_finished') as mark_cancelled,
        patch.object(store, 'append_event') as append_event,
        patch.object(store, 'append_mate', return_value=7) as append_mate,
        patch.object(store, 'update_running') as update_running,
        patch.object(run_memory, 'enqueue_finished_run') as enqueue,
        patch.object(handler.planning, 'revision_brief', return_value='- Fix it') as brief,
        patch.object(principal, 'get_project') as get_project,
        patch.object(principal, 'agent_claims', return_value=CLAIMS) as agent_claims,
        patch.object(pins, 'resolve_addressed', return_value=([], 0)) as resolve_addressed,
        patch.object(handler, 'load_graph', return_value=_line()) as load_graph,
        patch.object(handler, 'resolve_workflow', return_value=(_line(), 4)) as resolve_workflow,
    ):
        yield Seams(get_agent, get_run, start_run, finish_run, mark_cancelled, append_event, append_mate,
                    update_running, enqueue, brief, get_project, agent_claims, resolve_addressed, load_graph,
                    resolve_workflow)


def _advance(seams: Seams, result: Any, *, graph: WorkflowGraph | None = None, **run: Any) -> dict:
    seams.get_run.return_value = _run(**run)
    if graph is not None:
        seams.load_graph.return_value = graph
    return handler.handle({'action': 'advance', **IDS, 'node': result})


def _finish_of(status: str) -> dict:
    return {'kind': 'finish', 'status': status}


class TestConstants:
    def test_the_bounds_are_the_documented_ones(self):
        assert handler.ENVELOPE_PREFIX == '[sent by conductor]'
        assert handler.WAIT_SECONDS == 30
        assert handler.MAX_POLLS_PER_NODE == 120
        assert handler.MAX_STEPS == 120
        assert handler.MAX_CONTEXT_BYTES == 120_000
        assert frozenset({'revise_document', 'revise_prototype'}) == handler.REVISION_TYPES

    def test_a_finish_carries_its_status_and_message(self):
        stop = handler._Finish('failed', 'Why')
        assert (stop.status, stop.message, str(stop)) == ('failed', 'Why', 'Why')


class TestFinishing:
    def test_a_completed_run_records_no_error_and_a_message_event(self, seams):
        assert handler._finish(AGENT_ID, RUN_ID, 'completed', 'All done.') == _finish_of('completed')
        seams.finished('completed', None)
        seams.append_event.assert_called_once_with(AGENT_ID, RUN_ID, 'message', 'All done.')
        seams.enqueue.assert_called_once_with(AGENT_ID, RUN_ID, 'completed')

    @pytest.mark.parametrize('status', ['failed', 'needs_human'])
    def test_any_other_finish_records_the_message_as_error_and_a_decision(self, seams, status):
        assert handler._finish(AGENT_ID, RUN_ID, status, 'Why.') == _finish_of(status)
        seams.finished(status, 'Why.')
        seams.append_event.assert_called_once_with(AGENT_ID, RUN_ID, 'decision', 'Why.')
        seams.enqueue.assert_called_once_with(AGENT_ID, RUN_ID, status)

    def test_a_finish_that_lost_the_race_settles_the_cancel_without_writing(self, seams):
        seams.finish_run.return_value = False
        seams.get_run.return_value = {'status': 'cancelled'}

        assert handler._finish(AGENT_ID, RUN_ID, 'failed', 'Why.') == _finish_of('failed')
        seams.mark_cancelled.assert_called_once_with(AGENT_ID, RUN_ID)
        seams.get_run.assert_called_once_with(AGENT_ID, RUN_ID)
        seams.append_event.assert_not_called()
        seams.enqueue.assert_not_called()


class TestSettlingARunLeftRunning:
    def test_a_cancelled_run_is_marked_finished(self, seams):
        seams.get_run.return_value = {'status': 'cancelled'}
        assert handler._settle_left_running(AGENT_ID, RUN_ID) == _finish_of('cancelled')
        seams.mark_cancelled.assert_called_once_with(AGENT_ID, RUN_ID)

    def test_another_status_is_reported_as_is(self, seams):
        seams.get_run.return_value = {'status': 'completed'}
        assert handler._settle_left_running(AGENT_ID, RUN_ID) == _finish_of('completed')
        seams.mark_cancelled.assert_not_called()

    @pytest.mark.parametrize('row', [None, {}, {'status': ''}])
    def test_a_vanished_run_or_status_reads_as_cancelled(self, seams, row):
        seams.get_run.return_value = row
        assert handler._settle_left_running(AGENT_ID, RUN_ID) == _finish_of('cancelled')
        seams.mark_cancelled.assert_not_called()


class TestTheEnvelope:
    def test_every_section_in_order(self):
        agent = {**AGENT, 'instructions': '  Focus.  '}
        run = _run(context={'project_id': 'p1', 'documents': {'prfaq': 'd1', 'prd': 'd2'}})
        node = _node(instructions='Do A.')

        assert handler._envelope(run, agent, node, 4, '- Fix') == (
            '[sent by conductor]\n'
            'Run ar_1 · step 4: Step A (custom_llm)\n\n'
            'Agent instructions:\nFocus.\n\n'
            'Step instructions:\nDo A.\n\n'
            'Run so far: project p1, prd=d2, prfaq=d1\n\n'
            'Revision brief (from the persona panel, via the conductor):\n- Fix'
        )

    @pytest.mark.parametrize('instructions', ['   ', 5, None])
    def test_blank_or_non_text_agent_instructions_and_empty_sections_are_left_out(self, instructions):
        agent = {**AGENT, 'instructions': instructions}
        assert handler._envelope(_run(context=None), agent, _node(), 1, '') == (
            '[sent by conductor]\nRun ar_1 · step 1: Step A (custom_llm)')

    def test_an_agent_without_instructions_is_briefed_without_them(self):
        assert handler._envelope(_run(), AGENT, _node(), 2, '') == (
            '[sent by conductor]\nRun ar_1 · step 2: Step A (custom_llm)')

    def test_agent_instructions_are_clipped_to_8000_characters(self):
        envelope = handler._envelope(_run(), {**AGENT, 'instructions': 'i' * 8000 + 'X'}, _node(), 1, '')
        assert envelope.endswith('Agent instructions:\n' + 'i' * 8000)

    def test_documents_alone_are_the_run_so_far(self):
        run = _run(context={'documents': {'research': 'r1'}})
        assert handler._envelope(run, AGENT, _node(), 1, '').endswith('\n\nRun so far: research=r1')


class TestDispatch:
    def test_a_step_is_briefed_persisted_journalled_and_executed(self, seams):
        fan_out = {'pending_nodes': ['y'], 'done_nodes': ['start']}
        directive = handler._dispatch(AGENT, _run(), _node(), {'0': 1}, fan_out)

        assert directive == {'kind': 'execute', 'node_id': 'a', 'node_type': 'custom_llm', 'mate_seq': 7}
        seams.append_mate.assert_called_once_with(
            AGENT_ID, RUN_ID, 'worker', 'a', 'to_mate', '[sent by conductor]\nRun ar_1 · step 4: Step A (custom_llm)')
        seams.update_running.assert_called_once_with(AGENT_ID, RUN_ID, {
            'current_node_id': 'a', 'poll_attempts': 0, 'steps': 4, 'loop_rounds': {'0': 1},
            'pending_nodes': ['y'], 'done_nodes': ['start']})
        seams.append_event.assert_called_once_with(AGENT_ID, RUN_ID, 'node_started', 'Step A', node_id='a',
                                                   role='worker')
        seams.brief.assert_not_called()

    def test_a_run_without_steps_starts_at_step_one(self, seams):
        handler._dispatch(AGENT, _run(steps=None), _node(), {}, {})
        assert seams.update_running.call_args.args[2]['steps'] == 1

    def test_step_120_runs_and_step_121_is_refused(self, seams):
        handler._dispatch(AGENT, _run(steps=119), _node(), {}, {})
        assert seams.update_running.call_args.args[2]['steps'] == 120

        with pytest.raises(handler._Finish) as stop:
            handler._dispatch(AGENT, _run(steps=120), _node(), {}, {})
        assert (stop.value.status, stop.value.message) == ('failed', 'Stopped after 120 steps.')

    def test_the_end_node_completes_the_run(self, seams):
        assert handler._dispatch(AGENT, _run(), _node('end', title='Done'), {}, {}) == _finish_of('completed')
        seams.finished('completed', None)
        seams.append_event.assert_called_once_with(AGENT_ID, RUN_ID, 'message', 'Workflow completed.')

    def test_a_needs_human_end_asks_for_a_human(self, seams):
        end = _node('end', title='Escalate', params={'status': 'needs_human'})
        assert handler._dispatch(AGENT, _run(), end, {}, {}) == _finish_of('needs_human')
        seams.finished('needs_human', 'Escalate: the workflow asks for a human.')

    def test_looping_back_to_start_fails(self, seams):
        with pytest.raises(handler._Finish) as stop:
            handler._dispatch(AGENT, _run(), _node('start'), {}, {})
        assert (stop.value.status, stop.value.message) == ('failed', 'The workflow loops back to its start node.')
        seams.append_mate.assert_not_called()


class TestTheRevisionBrief:
    @pytest.mark.parametrize(('node_type', 'params', 'context', 'target'), [
        ('revise_document', {'target': 'prd'}, {'last_review_target': 'prototype'}, 'prd'),
        ('revise_document', {}, {'last_review_target': 'prototype'}, 'prototype'),
        ('revise_document', {}, {}, 'prfaq'),
        ('revise_prototype', {'target': 'prd'}, {'last_review_target': 'prfaq'}, 'prototype'),
    ])
    def test_the_target_falls_back_from_param_to_last_review_to_prfaq(self, seams, node_type, params, context,
                                                                       target):
        verdicts = [{'name': 'Ana', 'score': 2}]
        node = _node(node_type, params=params)
        handler._dispatch(AGENT, _run(context={**context, 'last_verdicts': verdicts}), node, {}, {})

        seams.brief.assert_called_once_with(AGENT, RUN_ID, target, verdicts)
        assert seams.append_mate.call_args.args[5].endswith(
            '\n\nRevision brief (from the persona panel, via the conductor):\n- Fix it')

    def test_verdicts_that_are_not_a_list_are_none(self, seams):
        handler._dispatch(AGENT, _run(context={'last_verdicts': 'x'}), _node('revise_document'), {}, {})
        seams.brief.assert_called_once_with(AGENT, RUN_ID, 'prfaq', [])


class TestVerify:
    def test_a_result_without_a_project_claims_nothing(self, seams):
        assert handler.verify({'artifacts': {'document_id': 'd1'}}, CLAIMS) is None
        seams.get_project.assert_not_called()

    def test_the_project_is_read_with_the_agent_claims(self, seams):
        seams.get_project.return_value = {}
        assert handler.verify({'artifacts': {'project_id': 'p1'}}, CLAIMS) is None
        seams.get_project.assert_called_once_with('p1', CLAIMS)

    def test_an_unreadable_project_names_the_status(self, seams):
        seams.get_project.side_effect = principal.RouteError(403, 'nope')
        assert handler.verify({'artifacts': {'project_id': 'p1'}}, CLAIMS) == (
            'project p1 is not readable by the agent (HTTP 403)')

    @pytest.mark.parametrize(('artifacts', 'problem'), [
        ({'document_id': 'd9'}, 'document d9 is not in project p1'),
        ({'document_id': 'd1', 'document_type': 'prd'}, 'document d1 is not a prd'),
        ({'document_id': 'd1', 'document_type': 'prfaq'}, None),
        ({'document_id': 'd2', 'document_type': 'prd'}, None),
        ({'persona_ids': ['per_1', 'per_8', 'per_9']}, '2 claimed persona(s) are not in project p1'),
        ({'persona_ids': ['per_1']}, None),
        ({'persona_ids': 'per_9'}, None),
    ])
    def test_every_claimed_artifact_must_exist(self, seams, artifacts, problem):
        seams.get_project.return_value = {
            'documents': ['junk', {'document_id': 'd1', 'document_type': 'prfaq'}, {'document_id': 'd2'}],
            'personas': ['junk', {'persona_id': 'per_1'}],
        }
        assert handler.verify({'artifacts': {'project_id': 'p1', **artifacts}}, CLAIMS) == problem

    def test_a_project_without_lists_has_no_documents_or_personas(self, seams):
        seams.get_project.return_value = {'documents': None, 'personas': None}
        assert handler.verify({'artifacts': {'project_id': 'p1', 'persona_ids': ['per_1']}}, CLAIMS) == (
            '1 claimed persona(s) are not in project p1')
        assert handler.verify({'artifacts': {'project_id': 'p1', 'document_id': 'd1'}}, CLAIMS) == (
            'document d1 is not in project p1')


class TestTheRunContext:
    def test_updates_are_merged_over_a_copy(self):
        run = _run(context={'a': 1, 'b': 1})
        assert handler._merged_context(run, {'b': 2, 'c': Decimal('3')}) == {'a': 1, 'b': 2, 'c': Decimal('3')}
        assert run['context'] == {'a': 1, 'b': 1}

    @pytest.mark.parametrize('updates', [None, ['b'], 'b'])
    def test_updates_that_are_not_a_mapping_are_ignored(self, updates):
        assert handler._merged_context(_run(context=None), updates) == {}

    def test_exactly_120000_bytes_are_kept_and_one_more_is_refused(self):
        # json.dumps({'k': v}) is 9 bytes around v.
        assert len(handler._merged_context(_run(context={}), {'k': 'x' * 119_991})['k']) == 119_991

        with pytest.raises(handler._Finish) as stop:
            handler._merged_context(_run(context={}), {'k': 'x' * 119_992})
        assert (stop.value.status, stop.value.message) == ('failed', 'The run context grew beyond its size limit.')


class TestRecordingAResult:
    def test_a_document_result_is_transcribed_journalled_and_announced(self, seams):
        result = {'summary': 'Wrote it', 'artifacts': {'project_id': 'p1', 'document_id': 'd1',
                                                       'document_type': 'prfaq'}}
        handler._record_result(AGENT_ID, RUN_ID, _node(), result)

        ref = {'project_id': 'p1', 'document_id': 'd1'}
        seams.append_mate.assert_called_once_with(AGENT_ID, RUN_ID, 'worker', 'a', 'from_mate', 'Wrote it')
        assert seams.append_event.call_args_list == [
            call(AGENT_ID, RUN_ID, 'node_finished', 'Wrote it', node_id='a', role='worker', ref=ref),
            call(AGENT_ID, RUN_ID, 'artifact', 'PRFAQ ready', node_id='a', ref=ref),
        ]

    def test_an_untyped_document_is_a_document_and_non_text_refs_are_dropped(self, seams):
        handler._record_result(AGENT_ID, RUN_ID, _node(), {'artifacts': {'project_id': 5, 'document_id': 'd1'}})

        seams.append_mate.assert_called_once_with(AGENT_ID, RUN_ID, 'worker', 'a', 'from_mate', 'Step A')
        assert seams.append_event.call_args_list == [
            call(AGENT_ID, RUN_ID, 'node_finished', 'Step A', node_id='a', role='worker', ref={'document_id': 'd1'}),
            call(AGENT_ID, RUN_ID, 'artifact', 'DOCUMENT ready', node_id='a', ref={'document_id': 'd1'}),
        ]

    def test_a_persona_review_journals_one_verdict_per_persona(self, seams):
        verdicts = [{'name': 'Ana', 'score': 2, 'blocking': True, 'would_use': False, 'persona_id': 'p1'},
                    {'name': 'Bo', 'score': 5, 'blocking': False, 'would_use': True, 'persona_id': 'p2'},
                    {'name': 'Cy', 'score': 3, 'blocking': True, 'would_use': True, 'persona_id': 'p3'}]
        node = _node('persona_review', node_id='review', title='Panel', role='persona')
        handler._record_result(AGENT_ID, RUN_ID, node, {'summary': 'S', 'updates': {'last_verdicts': verdicts}})

        assert seams.append_event.call_args_list[1:] == [
            call(AGENT_ID, RUN_ID, 'verdict', 'Ana: 2/5, blocking', node_id='review', role='persona',
                 ref={'persona_id': 'p1'}),
            call(AGENT_ID, RUN_ID, 'verdict', 'Bo: 5/5, would use', node_id='review', role='persona',
                 ref={'persona_id': 'p2'}),
            call(AGENT_ID, RUN_ID, 'verdict', 'Cy: 3/5, blocking, would use', node_id='review', role='persona',
                 ref={'persona_id': 'p3'}),
        ]

    @pytest.mark.parametrize(('node_type', 'updates'), [
        ('custom_llm', {'last_verdicts': [{'name': 'Ana'}]}),
        ('persona_review', {'last_verdicts': None}),
    ])
    def test_no_verdicts_outside_a_review_or_without_any(self, seams, node_type, updates):
        handler._record_result(AGENT_ID, RUN_ID, _node(node_type), {'summary': 'S', 'updates': updates})
        assert [c.args[2] for c in seams.append_event.call_args_list] == ['node_finished']


class TestPickingTheNextNode:
    @staticmethod
    def _pick(queue: list[str], done: set[str]) -> str | None:
        chosen = handler._pick_next(_fan(), queue, done)
        return chosen.id if chosen else None

    def test_a_join_waits_for_every_forward_predecessor(self):
        assert self._pick(['j', 'y'], {'start', 'p', 'x'}) == 'y'

    def test_a_join_runs_once_its_predecessors_are_exactly_done(self):
        assert self._pick(['x', 'j'], {'start', 'p', 'y'}) == 'x'
        # j's predecessors are {x, y}: equal to `done`, not a proper subset; y (needs p) is not ready.
        assert self._pick(['y', 'j'], {'x', 'y'}) == 'j'

    def test_end_nodes_go_last(self):
        assert self._pick(['end', 'y'], {'start', 'p', 'j'}) == 'y'
        assert self._pick(['end'], {'j'}) == 'end'

    def test_with_nothing_ready_the_oldest_non_end_entry_runs(self):
        assert self._pick(['end', 'j', 'y'], set()) == 'j'
        assert self._pick(['end'], set()) == 'end'

    def test_an_empty_queue_has_no_next_node(self):
        assert self._pick([], {'start'}) is None


class TestAdvancingAStep:
    def test_a_verified_result_is_committed_and_the_next_step_dispatched(self, seams):
        result = {'node_id': 'a', 'status': 'done', 'summary': 'Did A', 'updates': {'project_id': 'p1'}}
        directive = _advance(seams, result, done_nodes=['start', 9], pending_nodes=None)

        assert directive == {'kind': 'execute', 'node_id': 'b', 'node_type': 'custom_llm', 'mate_seq': 7}
        assert seams.update_running.call_args_list == [
            call(AGENT_ID, RUN_ID, {'context': {'project_id': 'p1'}, 'project_id': 'p1'}),
            call(AGENT_ID, RUN_ID, {'current_node_id': 'b', 'poll_attempts': 0, 'steps': 4, 'loop_rounds': {},
                                    'pending_nodes': [], 'done_nodes': ['a', 'start']}),
        ]
        # The next crewmate is briefed from the COMMITTED context.
        assert seams.append_mate.call_args_list[1].args[5].endswith('\n\nRun so far: project p1')
        seams.load_graph.assert_called_once_with(AGENT, _run(done_nodes=['start', 9], pending_nodes=None))

    def test_a_project_id_that_is_not_text_is_not_promoted(self, seams):
        _advance(seams, {'node_id': 'a', 'status': 'done', 'updates': {'project_id': 5}})
        assert seams.update_running.call_args_list[0] == call(AGENT_ID, RUN_ID, {'context': {'project_id': 5}})

    def test_the_last_step_completes_the_workflow(self, seams):
        assert _advance(seams, {'node_id': 'b', 'status': 'done'}, current_node_id='b') == _finish_of('completed')
        seams.finished('completed', None)
        assert seams.append_event.call_args_list[-1] == call(AGENT_ID, RUN_ID, 'message', 'Workflow completed.')

    @pytest.mark.parametrize(('summary', 'message'), [('Nothing new', 'Nothing new'), (None, 'Nothing to do.')])
    def test_a_halting_result_completes_the_run_with_its_summary(self, seams, summary, message):
        directive = _advance(seams, {'node_id': 'a', 'status': 'done', 'halt': True, 'summary': summary})

        assert directive == _finish_of('completed')
        assert seams.append_event.call_args_list[-1] == call(AGENT_ID, RUN_ID, 'message', message)
        assert seams.append_mate.call_count == 1

    def test_a_result_for_another_node_is_refused(self, seams):
        assert _advance(seams, {'node_id': 'a', 'status': 'done'}, current_node_id='b') == _finish_of('failed')
        seams.finished('failed', 'A step reported for a node that is not running.')

    @pytest.mark.parametrize('result', [{'status': 'done'}, {'node_id': None}, 'not a result'])
    def test_a_result_naming_no_node_is_a_workflow_error(self, seams, result):
        assert _advance(seams, result) == _finish_of('failed')
        seams.finished('failed', 'Workflow error: unknown node ')

    def test_a_pending_step_waits_and_counts_the_poll(self, seams):
        directive = _advance(seams, {'node_id': 'a', 'status': 'pending', 'pending': {'job_id': 'j'}},
                             poll_attempts=119)

        assert directive == {'kind': 'wait', 'node_id': 'a', 'node_type': 'custom_llm',
                             'pending': {'job_id': 'j'}, 'wait_seconds': 30}
        seams.update_running.assert_called_once_with(AGENT_ID, RUN_ID, {'poll_attempts': 120})

    def test_the_first_poll_is_poll_one(self, seams):
        _advance(seams, {'node_id': 'a', 'status': 'pending'})
        seams.update_running.assert_called_once_with(AGENT_ID, RUN_ID, {'poll_attempts': 1})

    def test_the_121st_poll_times_out(self, seams):
        assert _advance(seams, {'node_id': 'a', 'status': 'pending'}, poll_attempts=120) == _finish_of('failed')
        seams.finished('failed', 'Step A timed out.')
        seams.update_running.assert_not_called()

    @pytest.mark.parametrize(('summary', 'journalled'), [('Boom', 'Boom'), (None, 'The step failed.')])
    def test_a_failed_step_fails_the_run(self, seams, summary, journalled):
        assert _advance(seams, {'node_id': 'a', 'status': 'failed', 'summary': summary}) == _finish_of('failed')
        assert seams.append_event.call_args_list[0] == call(AGENT_ID, RUN_ID, 'node_failed', journalled,
                                                            node_id='a', role='worker')
        seams.finished('failed', 'Step A failed.')

    def test_a_step_out_of_budget_needs_a_human(self, seams):
        result = {'node_id': 'a', 'status': 'failed', 'error': 'budget_exhausted'}
        assert _advance(seams, result) == _finish_of('needs_human')
        seams.finished('needs_human', 'The run spent its model-call budget.')

    def test_an_unverifiable_claim_needs_a_human(self, seams):
        seams.get_project.return_value = {'documents': []}
        result = {'node_id': 'a', 'status': 'done', 'artifacts': {'project_id': 'p1', 'document_id': 'd9'}}

        assert _advance(seams, result) == _finish_of('needs_human')
        seams.agent_claims.assert_called_with(AGENT)
        seams.get_project.assert_called_once_with('p1', CLAIMS)
        assert seams.append_event.call_args_list[0] == call(
            AGENT_ID, RUN_ID, 'node_failed', 'Verification failed: document d9 is not in project p1',
            node_id='a', role='worker')
        seams.finished('needs_human', 'Step A: the claimed result could not be verified.')
        seams.update_running.assert_not_called()


class TestLoopsAndFanOut:
    @staticmethod
    def _review(seams: Seams, rounds: dict, outcome: str = 'not_agreed') -> dict:
        return _advance(seams, {'node_id': 'review', 'status': 'done', 'outcome': outcome},
                        graph=_review_loop(), current_node_id='review', loop_rounds=rounds)

    def test_a_failed_round_is_counted_journalled_and_revised(self, seams):
        assert self._review(seams, {})['node_id'] == 'revise'
        assert seams.append_event.call_args_list[1] == call(
            AGENT_ID, RUN_ID, 'decision', 'Panel: round 1 of 3 failed; revising.', node_id='review')
        assert seams.update_running.call_args.args[2]['loop_rounds'] == {'0': 1}

    def test_the_second_failed_round_is_round_two(self, seams):
        self._review(seams, {'0': 1})
        assert seams.append_event.call_args_list[1].args[3] == 'Panel: round 2 of 3 failed; revising.'

    def test_reaching_max_rounds_needs_a_human(self, seams):
        assert self._review(seams, {'0': 2}) == _finish_of('needs_human')
        seams.finished('needs_human', 'Panel: no agreement after 3 round(s).')

    def test_a_passing_review_does_not_count_a_round(self, seams):
        assert self._review(seams, {'0': 2}, outcome='agreed') == _finish_of('completed')
        assert [c.args[2] for c in seams.append_event.call_args_list] == ['node_finished', 'message']

    def test_a_failure_without_a_fail_path_needs_a_human(self, seams):
        graph = _graph([_raw('start', 'start'), _raw('a', 'final_review', 'Final'), _raw('end', 'end')],
                       [('start', 'a'), ('a', 'end', 'pass')])
        result = {'node_id': 'a', 'status': 'done', 'outcome': 'fail'}

        assert _advance(seams, result, graph=graph) == _finish_of('needs_human')
        seams.finished('needs_human', 'Final did not pass and the workflow has no fail path.')
        assert [c.args[2] for c in seams.append_event.call_args_list] == ['node_finished', 'decision']

    def test_a_step_with_no_way_out_fails(self, seams):
        graph = _graph([_raw('start', 'start'), _raw('a', 'custom_llm', 'Step A'), _raw('end', 'end')],
                       [('start', 'a')])
        assert _advance(seams, {'node_id': 'a', 'status': 'done'}, graph=graph) == _finish_of('failed')
        seams.finished('failed', 'Step A has no next step.')

    @pytest.mark.parametrize(('node', 'pending', 'done', 'chosen', 'persisted'), [
        ('p', [], ['start'], 'x', {'pending_nodes': ['y'], 'done_nodes': ['p', 'start']}),
        ('x', ['y'], ['p', 'start'], 'y', {'pending_nodes': ['j'], 'done_nodes': ['p', 'start', 'x']}),
        ('y', ['j'], ['p', 'start', 'x'], 'j', {'pending_nodes': [], 'done_nodes': ['p', 'start', 'x', 'y']}),
        ('y', ['y', 'j'], ['p', 'start', 'x'], 'j', {'pending_nodes': [], 'done_nodes': ['p', 'start', 'x', 'y']}),
    ])
    def test_branches_run_one_after_another_and_the_queue_is_persisted(self, seams, node, pending, done, chosen,
                                                                       persisted):
        directive = _advance(seams, {'node_id': node, 'status': 'done'}, graph=_fan(), current_node_id=node,
                             pending_nodes=pending, done_nodes=done)

        assert directive['node_id'] == chosen
        sets = seams.update_running.call_args.args[2]
        assert {k: sets[k] for k in persisted} == persisted


class TestResolvingReviewedPins:
    GROUPS: ClassVar[list[dict]] = [{'document_id': 'd1', 'pin_ids': ['pin_1']}]

    def _resolve(self, node: Node, outcome: Any, context: dict) -> dict:
        return handler._resolve_reviewed_pins(AGENT, RUN_ID, node, outcome, context)

    def test_a_passing_final_review_resolves_the_addressed_pins(self, seams):
        seams.resolve_addressed.return_value = ([], 2)
        context = {'project_id': 'p1', 'addressed_pins': self.GROUPS}

        assert self._resolve(_node('final_review', title='Final'), 'pass', context) == {
            'project_id': 'p1', 'addressed_pins': []}
        seams.agent_claims.assert_called_once_with(AGENT)
        seams.resolve_addressed.assert_called_once_with(CLAIMS, context)
        seams.append_event.assert_called_once_with(AGENT_ID, RUN_ID, 'decision',
                                                   'Final passed: 2 tester pin(s) resolved.', node_id='a')

    def test_nothing_resolved_journals_nothing_but_keeps_what_remains(self, seams):
        seams.resolve_addressed.return_value = (self.GROUPS, 0)
        context = {'addressed_pins': self.GROUPS}
        assert self._resolve(_node('final_review'), 'pass', context) == {'addressed_pins': self.GROUPS}
        seams.append_event.assert_not_called()

    @pytest.mark.parametrize(('outcome', 'context'), [
        ('pass', {'addressed_pins': []}),
        ('fail', {'addressed_pins': GROUPS}),
    ])
    def test_no_groups_or_no_pass_leaves_the_context_alone(self, seams, outcome, context):
        assert self._resolve(_node('final_review'), outcome, context) is context
        seams.resolve_addressed.assert_not_called()

    def test_advance_commits_the_resolved_context(self, seams):
        seams.resolve_addressed.return_value = ([], 1)
        graph = _graph([_raw('start', 'start'), _raw('a', 'final_review', 'Final'), _raw('end', 'end')],
                       [('start', 'a'), ('a', 'end', 'pass')])
        _advance(seams, {'node_id': 'a', 'status': 'done', 'outcome': 'pass'}, graph=graph,
                 context={'project_id': 'p1', 'addressed_pins': self.GROUPS})

        assert seams.update_running.call_args_list[0] == call(
            AGENT_ID, RUN_ID, {'context': {'project_id': 'p1', 'addressed_pins': []}, 'project_id': 'p1'})


class TestInit:
    def _init(self, seams: Seams, *, run: dict | None = None, started: dict | None = None,
              graph: WorkflowGraph | None = None) -> dict:
        seams.get_run.return_value = run or _run(status='queued', workflow_revision=None)
        seams.start_run.return_value = started or _run(steps=0, trigger='schedule')
        seams.resolve_workflow.return_value = (graph or _line(), 4)
        return handler.handle({'action': 'init', **IDS})

    @pytest.mark.parametrize('status', ['queued', 'running'])
    def test_a_run_starts_journals_and_dispatches_the_first_step(self, seams, status):
        directive = self._init(seams, run=_run(status=status, workflow_revision=3))

        assert directive == {'kind': 'execute', 'node_id': 'a', 'node_type': 'custom_llm', 'mate_seq': 7}
        seams.get_agent.assert_called_once_with(AGENT_ID)
        seams.resolve_workflow.assert_called_once_with(AGENT, 3)
        seams.start_run.assert_called_once_with(AGENT_ID, RUN_ID, 4)
        assert seams.append_event.call_args_list[0] == call(
            AGENT_ID, RUN_ID, 'message', 'Run started (schedule), workflow revision 4.')
        seams.update_running.assert_called_once_with(AGENT_ID, RUN_ID, {
            'current_node_id': 'a', 'poll_attempts': 0, 'steps': 1, 'loop_rounds': {},
            'pending_nodes': [], 'done_nodes': ['start']})

    def test_a_revision_that_is_not_a_number_is_not_pinned_and_the_trigger_defaults(self, seams):
        self._init(seams, run=_run(status='queued', workflow_revision='3'), started=_run(steps=None))
        seams.resolve_workflow.assert_called_once_with(AGENT, None)
        assert seams.append_event.call_args_list[0].args[3] == 'Run started (manual), workflow revision 4.'

    def test_the_started_row_is_the_run_walked(self, seams):
        self._init(seams, started=_run(steps=5))
        assert seams.update_running.call_args.args[2]['steps'] == 6

    def test_a_finished_run_is_settled_not_started(self, seams):
        assert self._init(seams, run=_run(status='completed')) == _finish_of('completed')
        seams.start_run.assert_not_called()
        seams.append_event.assert_not_called()

    def test_a_run_that_left_queued_meanwhile_is_settled(self, seams):
        seams.start_run.side_effect = store.RunNotRunning('run is not queued')
        seams.get_run.side_effect = [_run(status='queued'), {'status': 'cancelled'}]
        seams.resolve_workflow.return_value = (_line(), 4)

        assert handler.handle({'action': 'init', **IDS}) == _finish_of('cancelled')
        seams.mark_cancelled.assert_called_once_with(AGENT_ID, RUN_ID)
        seams.append_event.assert_not_called()

    def test_a_workflow_with_nothing_after_start_fails(self, seams):
        graph = _graph([_raw('start', 'start'), _raw('end', 'end')], [])
        assert self._init(seams, graph=graph) == _finish_of('failed')
        seams.finished('failed', 'The workflow has no step after start.')

    @pytest.mark.parametrize(('agent', 'run'), [(None, _run()), (AGENT, None)])
    def test_a_missing_agent_or_run_is_not_found(self, seams, agent, run):
        seams.get_agent.return_value, seams.get_run.return_value = agent, run
        with pytest.raises(LookupError, match=r'^agent or run not found$'):
            handler.handle({'action': 'init', **IDS})

    def test_the_ids_are_read_from_the_event(self, seams):
        seams.get_agent.return_value = None
        with pytest.raises(LookupError):
            handler.handle({'action': 'init'})
        seams.get_agent.assert_called_once_with('')
        seams.get_run.assert_called_once_with('', '')


class TestAdvanceAndFailActions:
    def test_advance_on_a_run_that_is_not_running_settles_it(self, seams):
        assert _advance(seams, {'node_id': 'a', 'status': 'done'}, status='cancelled') == _finish_of('cancelled')
        seams.load_graph.assert_not_called()
        seams.mark_cancelled.assert_called_once_with(AGENT_ID, RUN_ID)

    def test_fail_records_the_error_name_clipped_to_100(self, seams):
        event = {'action': 'fail', **IDS, 'error': {'Error': 'E' * 100 + 'X', 'Cause': 'secret'}}
        assert handler.handle(event) == _finish_of('failed')
        seams.finished('failed', f'The run stopped on an internal error ({"E" * 100}).')

    @pytest.mark.parametrize('error', [None, {}, {'Error': ''}])
    def test_an_unnamed_error_is_error(self, seams, error):
        handler.handle({'action': 'fail', 'error': error})
        seams.finish_run.assert_called_once_with('', '', 'failed', 'The run stopped on an internal error (Error).')


class TestHandle:
    @pytest.mark.parametrize('event', [{}, {'action': 'retry'}, {'action': None}])
    def test_an_unknown_action_is_refused(self, seams, event):
        with pytest.raises(ValueError, match=r'^unknown conductor action$'):
            handler.handle(event)
        seams.finish_run.assert_not_called()

    def test_a_run_that_stopped_running_mid_step_is_settled(self, seams):
        seams.update_running.side_effect = store.RunNotRunning('gone')
        seams.get_run.side_effect = [_run(), {'status': 'cancelled'}]

        assert handler.handle({'action': 'advance', **IDS, 'node': {'node_id': 'a', 'status': 'pending'}}) == (
            _finish_of('cancelled'))
        seams.finish_run.assert_not_called()

    def test_an_exhausted_budget_needs_a_human(self, seams):
        seams.brief.side_effect = store.BudgetExhausted()
        graph = _review_loop()
        result = {'node_id': 'review', 'status': 'done', 'outcome': 'not_agreed'}

        assert _advance(seams, result, graph=graph, current_node_id='review') == _finish_of('needs_human')
        seams.finished('needs_human', 'The run spent its model-call budget.')

    def test_a_workflow_error_names_itself(self, seams):
        seams.load_graph.side_effect = WorkflowError('the run has no pinned workflow revision')
        assert handler.handle({'action': 'advance', **IDS}) == _finish_of('failed')
        seams.finished('failed', 'Workflow error: the run has no pinned workflow revision')

    def test_the_directive_is_plain_json(self, seams):
        seams.append_mate.return_value = Decimal('7')
        directive = _advance(seams, {'node_id': 'a', 'status': 'done'})
        assert directive['mate_seq'] == 7
        assert type(directive['mate_seq']) is int


class TestLambdaHandler:
    @staticmethod
    def _context() -> SimpleNamespace:
        return SimpleNamespace(
            function_name='voc-agent-conductor', memory_limit_in_mb=256,
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-agent-conductor',
            aws_request_id='req-1', get_remaining_time_in_millis=lambda: 600_000,
        )

    def test_the_directive_is_returned_and_logged(self, seams):
        with patch.object(handler, 'logger') as log:
            assert handler.lambda_handler({'action': 'fail', **IDS}, self._context()) == _finish_of('failed')
        log.info.assert_called_once_with('Conductor directive', extra={'kind': 'finish', 'status': 'failed'})
        seams.finished('failed', 'The run stopped on an internal error (Error).')

    def test_an_event_that_is_not_an_object_is_no_action(self, seams):
        with pytest.raises(ValueError, match=r'^unknown conductor action$'):
            handler.lambda_handler(['init'], self._context())
        seams.finish_run.assert_not_called()

    @pytest.mark.usefixtures('seams')
    def test_the_lambda_context_reaches_the_logger(self):
        handler.logger.remove_keys(['function_name', 'cold_start'])
        handler.lambda_handler({'action': 'fail', **IDS}, self._context())
        assert handler.logger.get_current_keys()['function_name'] == 'voc-agent-conductor'

    @pytest.mark.usefixtures('seams')
    def test_the_cold_start_metric_is_flushed_as_emf(self, capsys):
        names = cold_start_metric_names(
            shared_metrics, lambda: handler.lambda_handler({'action': 'fail', **IDS}, self._context()), capsys)
        assert names == {'ColdStart'}

    def test_the_handler_wears_the_shared_instrumentation_stack_in_order(self):
        """`@instrumented_handler`: logger, tracer, metrics, invocation cost, then the function itself."""
        assert handler_layers(handler.lambda_handler) == INSTRUMENTED_HANDLER_LAYERS


class TestTheEventIdsReachEveryFinish:
    def test_the_run_is_loaded_by_the_event_ids(self, seams):
        _advance(seams, {'node_id': 'a', 'status': 'pending'})
        seams.get_agent.assert_called_once_with(AGENT_ID)
        seams.get_run.assert_called_once_with(AGENT_ID, RUN_ID)

    def test_a_refusal_for_an_event_without_ids_finishes_run_blank(self, seams):
        seams.get_run.return_value = _run(current_node_id='b')
        assert handler.handle({'action': 'advance', 'node': {'node_id': 'a', 'status': 'done'}}) == (
            _finish_of('failed'))
        seams.finish_run.assert_called_once_with('', '', 'failed', 'A step reported for a node that is not running.')
