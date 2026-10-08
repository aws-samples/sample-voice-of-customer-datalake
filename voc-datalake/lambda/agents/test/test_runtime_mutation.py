"""Mutation hardening for `agents/runtime.py`.

`test_conductor_run.py` drives whole runs through the conductor, node and persona
Lambdas, so a runtime that cannot build a context at all is caught there. A
mutation run found what the end-to-end drive cannot see:

* which workflow revision is asked for: the built-in ``wf_default`` (no id, an empty
  id, or the id itself) is never loaded and answers ``BUILTIN_REVISION``; a stored
  workflow is loaded at a positive int revision, and ``0``, a negative, a string or
  ``None`` all ask for CURRENT. The run's pin must be a non-negative int (``0`` is
  accepted), and both refusals are pinned word for word.
* every guard in ``build_context``: a missing agent OR a missing run, a run that is
  not ``running``, the ``''`` fallbacks of the three event ids, and the envelope —
  read only for an int ``mate_seq``, only from a mate written for THIS node, with an
  empty text kept empty.
* the exact node result each expected failure maps to (the run records it), the
  ``''`` node id fallback, the unavailable-service log line, and that an unexpected
  error is not swallowed.
* the Powertools stack of the step entry point (each decorator, in order, with the
  cold-start metric on), the ``{}`` stand-in for a non-dict event and the finished
  log line.
"""
from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from agents import principal, runtime, store
from agents.graph import SCHEMA, WorkflowError, WorkflowGraph
from agents.nodes.base import NodeContext, NodeFailure
from shared.agents_store import BUILTIN_REVISION
from shared.mcp_delegate import DelegationUnavailable
from shared.workflow_schema import DEFAULT_WORKFLOW_ID, default_template

CUSTOM = {
    'schema': SCHEMA,
    'nodes': [{'id': 's', 'type': 'start'},
              {'id': 'w', 'type': 'custom_llm', 'data': {'role': 'reviewer'}},
              {'id': 'e', 'type': 'end'}],
    'edges': [{'source': 's', 'target': 'w'}, {'source': 'w', 'target': 'e'}],
}
CUSTOM_AGENT = {'agent_id': 'ag_1', 'workflow_id': 'wf_custom'}
CLAIMS = {'sub': 'agent:ag_1'}
RUNNING = {'run_id': 'r1', 'status': 'running', 'workflow_revision': 4}


@pytest.fixture
def load_workflow() -> Iterator[MagicMock]:
    with patch('agents.store.load_workflow', return_value=(CUSTOM, 7)) as mock:
        yield mock


def _default_node_ids() -> list[str]:
    return [n['id'] for n in default_template()['nodes']]


class TestResolveWorkflow:
    def test_the_built_in_id_is_still_wf_default_at_revision_1(self):
        assert (DEFAULT_WORKFLOW_ID, BUILTIN_REVISION) == ('wf_default', 1)

    @pytest.mark.parametrize('agent', [{}, {'workflow_id': ''}, {'workflow_id': None}, {'workflow_id': 'wf_default'}])
    def test_the_built_in_workflow_is_the_template_and_never_loaded(self, agent, load_workflow):
        graph, revision = runtime.resolve_workflow(agent, 5)

        assert list(graph.nodes) == _default_node_ids()
        assert revision == 1
        load_workflow.assert_not_called()

    @pytest.mark.parametrize(('revision', 'asked'), [(1, 1), (3, 3), (0, None), (-1, None), (None, None), ('3', None)])
    def test_a_stored_workflow_is_loaded_at_a_positive_int_revision_else_current(self, revision, asked, load_workflow):
        graph, resolved = runtime.resolve_workflow(CUSTOM_AGENT, revision)

        load_workflow.assert_called_once_with('wf_custom', asked)
        assert list(graph.nodes) == ['s', 'w', 'e']
        assert resolved == 7

    def test_an_unloadable_workflow_is_refused(self, load_workflow):
        load_workflow.return_value = None
        with pytest.raises(WorkflowError) as exc:
            runtime.resolve_workflow(CUSTOM_AGENT, 2)
        assert str(exc.value) == 'the agent workflow could not be loaded'


class TestLoadGraph:
    @pytest.mark.parametrize('run', [{}, {'workflow_revision': None}, {'workflow_revision': '2'},
                                     {'workflow_revision': -1}])
    def test_a_run_without_a_non_negative_int_pin_is_refused(self, run, load_workflow):
        with pytest.raises(WorkflowError) as exc:
            runtime.load_graph(CUSTOM_AGENT, run)
        assert str(exc.value) == 'the run has no pinned workflow revision'
        load_workflow.assert_not_called()

    @pytest.mark.parametrize(('pin', 'asked'), [(0, None), (2, 2)])
    def test_the_pinned_revision_is_loaded_and_the_graph_returned(self, pin, asked, load_workflow):
        graph = runtime.load_graph(CUSTOM_AGENT, {'workflow_revision': pin})

        assert isinstance(graph, WorkflowGraph)
        assert list(graph.nodes) == ['s', 'w', 'e']
        load_workflow.assert_called_once_with('wf_custom', asked)


class _Store:
    """The four store reads `build_context` makes, as one patch set."""

    def __init__(self, agent: dict | None, run: dict | None, mate: dict | None = None):
        self.get_agent = MagicMock(return_value=agent)
        self.get_run = MagicMock(return_value=run)
        self.get_mate = MagicMock(return_value=mate)
        self.agent_claims = MagicMock(return_value=dict(CLAIMS))

    def build(self, event: dict) -> NodeContext:
        with (patch('agents.store.get_agent', self.get_agent), patch('agents.store.get_run', self.get_run),
              patch('agents.store.get_mate', self.get_mate), patch('agents.store.load_workflow',
                                                                   return_value=(CUSTOM, 4)),
              patch('agents.principal.agent_claims', self.agent_claims)):
            return runtime.build_context(event)


EVENT = {'agent_id': 'ag_1', 'run_id': 'r1', 'node_id': 'w'}


class TestBuildContextGuards:
    @pytest.mark.parametrize(('agent', 'run'), [(None, RUNNING), (CUSTOM_AGENT, None), (None, None)])
    def test_a_missing_agent_or_run_is_refused(self, agent, run):
        with pytest.raises(NodeFailure) as exc:
            _Store(agent, run).build(EVENT)
        assert str(exc.value) == 'agent or run not found'

    def test_missing_ids_read_the_empty_keys(self):
        fake = _Store(None, None)
        with pytest.raises(NodeFailure):
            fake.build({})
        fake.get_agent.assert_called_once_with('')
        fake.get_run.assert_called_once_with('', '')

    def test_the_event_ids_are_read(self):
        fake = _Store(CUSTOM_AGENT, RUNNING)
        fake.build(EVENT)
        fake.get_agent.assert_called_once_with('ag_1')
        fake.get_run.assert_called_once_with('ag_1', 'r1')

    @pytest.mark.parametrize('status', ['queued', 'completed', None])
    def test_a_run_that_is_not_running_is_refused(self, status):
        with pytest.raises(NodeFailure) as exc:
            _Store(CUSTOM_AGENT, {**RUNNING, 'status': status}).build(EVENT)
        assert str(exc.value) == 'run is not running'

    def test_a_missing_node_id_looks_up_the_empty_id(self):
        with pytest.raises(WorkflowError) as exc:
            _Store(CUSTOM_AGENT, RUNNING).build({'agent_id': 'ag_1', 'run_id': 'r1'})
        assert str(exc.value) == 'unknown node '


class TestBuildContextResult:
    def test_the_context_carries_agent_run_node_and_the_agent_claims(self):
        fake = _Store(CUSTOM_AGENT, RUNNING)
        ctx = fake.build(EVENT)

        assert ctx.agent == CUSTOM_AGENT
        assert ctx.run == RUNNING
        assert (ctx.node.id, ctx.node.type, ctx.node.role) == ('w', 'custom_llm', 'reviewer')
        assert ctx.envelope == ''
        assert ctx.claims == CLAIMS
        fake.agent_claims.assert_called_once_with(CUSTOM_AGENT)
        fake.get_mate.assert_not_called()

    @pytest.mark.parametrize('seq', [None, '2', 2.0])
    def test_no_int_mate_seq_reads_no_mate(self, seq):
        fake = _Store(CUSTOM_AGENT, RUNNING, {'node_id': 'w', 'text': 'brief'})
        assert fake.build({**EVENT, 'mate_seq': seq}).envelope == ''
        fake.get_mate.assert_not_called()

    @pytest.mark.parametrize('seq', [0, 2])
    def test_the_mate_for_this_node_is_the_envelope(self, seq):
        fake = _Store(CUSTOM_AGENT, RUNNING, {'node_id': 'w', 'text': 'brief'})
        assert fake.build({**EVENT, 'mate_seq': seq}).envelope == 'brief'
        fake.get_mate.assert_called_once_with('r1', 'reviewer', seq)

    @pytest.mark.parametrize(('mate', 'envelope'), [
        (None, ''),
        ({}, ''),
        ({'node_id': 'other', 'text': 'brief'}, ''),
        ({'node_id': 'w'}, ''),
        ({'node_id': 'w', 'text': None}, ''),
        ({'node_id': 'w', 'text': 5}, '5'),
    ])
    def test_the_envelope_of_any_other_mate(self, mate, envelope):
        assert _Store(CUSTOM_AGENT, RUNNING, mate).build({**EVENT, 'mate_seq': 1}).envelope == envelope


def _run(event: dict, error: BaseException | None = None, result: Any = None) -> tuple[dict, MagicMock]:
    ctx = MagicMock(spec=NodeContext)
    step = MagicMock(side_effect=error, return_value=result)
    with patch('agents.runtime.build_context', return_value=ctx) as build:
        out = runtime.run_step(event, step)
    build.assert_called_once_with(event)
    step.assert_called_once_with(ctx)
    return out, step


def _failed(node_id: str, error: str) -> dict:
    return {'node_id': node_id, 'status': 'failed', 'summary': error, 'error': error}


class TestRunStep:
    def test_the_step_result_is_returned_json_safe(self):
        out, _ = _run({'node_id': 'n1'}, result={'node_id': 'n1', 'status': 'done', 'n': Decimal('3')})
        assert out == {'node_id': 'n1', 'status': 'done', 'n': 3}
        assert type(out['n']) is int

    def test_an_exhausted_budget_names_its_code(self):
        out, _ = _run({'node_id': 'n1'}, store.BudgetExhausted())
        assert out == {**_failed('n1', 'The run has spent its model-call budget.'), 'error': 'budget_exhausted'}

    @pytest.mark.parametrize('error', [NodeFailure('no document'), WorkflowError('no document')])
    def test_a_node_or_workflow_failure_records_its_message(self, error):
        assert _run({'node_id': 'n1'}, error)[0] == _failed('n1', 'no document')

    def test_a_refusing_route_records_status_and_message(self):
        out, _ = _run({'node_id': 'n1'}, principal.RouteError(403, 'Forbidden'))
        assert out == _failed('n1', 'A project route refused the step (HTTP 403): Forbidden')

    def test_an_unavailable_service_is_logged_and_recorded(self):
        with patch('agents.runtime.logger') as logger:
            out, _ = _run({'node_id': 'n1'}, DelegationUnavailable('down'))
        assert out == _failed('n1', 'A project service was unavailable.')
        logger.exception.assert_called_once_with('Domain call unavailable')

    def test_a_missing_node_id_is_recorded_empty(self):
        assert _run({}, NodeFailure('x'))[0] == _failed('', 'x')

    def test_an_unexpected_error_propagates(self):
        with pytest.raises(KeyError):
            _run({'node_id': 'n1'}, KeyError('boom'))


class TestStepLambdaHandler:
    @staticmethod
    def _build(execute: MagicMock) -> tuple[Any, MagicMock, MagicMock, MagicMock]:
        with (patch('agents.runtime.logger') as logger, patch('agents.runtime.tracer') as tracer,
              patch('agents.runtime.metrics') as metrics):
            entry = runtime.step_lambda_handler(execute, 'Panel step finished')
        return entry, logger, tracer, metrics

    def test_the_powertools_stack_in_order_with_the_cold_start_metric(self):
        entry, logger, tracer, metrics = self._build(MagicMock())

        metrics.log_metrics.assert_called_once_with(capture_cold_start_metric=True)
        inner = metrics.log_metrics.return_value.call_args.args[0]
        assert inner.__name__ == 'handler'
        tracer.capture_lambda_handler.assert_called_once_with(metrics.log_metrics.return_value.return_value)
        logger.inject_lambda_context.assert_called_once_with(tracer.capture_lambda_handler.return_value)
        assert entry is logger.inject_lambda_context.return_value

    @pytest.mark.parametrize(('event', 'passed'), [
        ({'node_id': 'n1'}, {'node_id': 'n1'}), (None, {}), (['x'], {}), ('event', {}),
    ])
    def test_the_handler_runs_the_step_and_logs_the_finished_line(self, event, passed):
        execute = MagicMock(return_value={'node_id': 'n1', 'status': 'done'})
        _, logger, _, metrics = self._build(execute)
        inner = metrics.log_metrics.return_value.call_args.args[0]
        logger.reset_mock()

        with patch('agents.runtime.logger', logger):
            assert inner(event, None) == {'node_id': 'n1', 'status': 'done'}

        execute.assert_called_once_with(passed)
        logger.info.assert_called_once_with('Panel step finished', extra={'node_status': 'done'})
