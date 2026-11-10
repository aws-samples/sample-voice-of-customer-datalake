"""Mutation hardening for `agents/nodes/collect_prototype_feedback.py`.

`test_prototype_pins_flow.py` drives the node through the whole loop and pins
that the collected pins reach the revision, and that an unreadable pins route
still ends the step `done` with the feedback cleared. A mutation run found the
node's own words and shape unobserved:

* the two refusals — `no project has been chosen for this run yet` before any
  pin is read, and `there is no prototype to collect feedback for yet` when the
  run has no prototype document;
* the pins are read for the run's project and CURRENT prototype as the agent
  (`open_pins(project_id, document_id, claims)`);
* an unavailable pins route (`RouteError` or `DelegationUnavailable`) logs
  exactly `Prototype pins unavailable` with `error_type` naming the exception
  class, and the result carries the literal summary, `artifacts={'project_id'}`
  and `prototype_feedback: None`;
* the summary is `N open tester pin(s) on the prototype`, extended with
  `; N flagged pin(s) left for a human` only when a pin was flagged (0 stays
  silent, 1 speaks), and the feedback written to the run context is exactly
  `{'document_id', 'pins', 'flagged'}` with the usable pins in order.

Every expectation is the literal string, dict or call the module emits.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from agents import pins, principal
from agents.graph import Node
from agents.nodes import collect_prototype_feedback
from agents.nodes.base import NodeContext, NodeFailure
from shared.mcp_delegate import DelegationUnavailable

PROJECT = 'proj_1'
PROTOTYPE = 'proto_1'
CLAIMS = {'sub': 'agent:ag_1', 'cognito:groups': ''}
PIN_A = {'pin_id': 'pin_a', 'comment': 'The Pay button does nothing'}
PIN_B = {'pin_id': 'pin_b', 'comment': 'The total is wrong'}


def _ctx(context: dict) -> NodeContext:
    node = Node(id='n_collect', type='collect_prototype_feedback', title='Collect', instructions='',
                role='worker')
    return NodeContext(agent={'agent_id': 'ag_1'}, run={'run_id': 'ar_1', 'context': context},
                       node=node, envelope='', claims=CLAIMS)


def _context(*, project: str | None = PROJECT, documents: dict | None = None) -> dict:
    context: dict = {'documents': {'prototype': PROTOTYPE} if documents is None else documents}
    if project is not None:
        context['project_id'] = project
    return context


def _start_logging(*, return_value: object = None,
                   side_effect: BaseException | None = None) -> tuple[dict, MagicMock]:
    """Start the node with `pins.open_pins` answering ``return_value`` (or raising ``side_effect``);
    the result and the `logger.warning` spy."""
    with patch.object(pins, 'open_pins', return_value=return_value, side_effect=side_effect), \
            patch.object(collect_prototype_feedback.logger, 'warning') as warning:
        result = collect_prototype_feedback.start(_ctx(_context()))
    return result, warning


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize('context', [_context(project=None), _context(project='')])
    def test_without_a_project_nothing_is_read(self, context):
        with patch.object(pins, 'open_pins') as open_pins, pytest.raises(NodeFailure) as exc:
            collect_prototype_feedback.start(_ctx(context))
        assert str(exc.value) == 'no project has been chosen for this run yet'
        open_pins.assert_not_called()

    @pytest.mark.parametrize('documents', [{}, {'prototype': ''}, {'prototype': 7}, {'prfaq': 'prfaq_1'}])
    def test_without_a_prototype_nothing_is_read(self, documents):
        with patch.object(pins, 'open_pins') as open_pins, pytest.raises(NodeFailure) as exc:
            collect_prototype_feedback.start(_ctx(_context(documents=documents)))
        assert str(exc.value) == 'there is no prototype to collect feedback for yet'
        open_pins.assert_not_called()


class TestThePinsAreReadForTheCurrentPrototypeAsTheAgent:
    def test_open_pins_gets_the_project_the_prototype_and_the_claims(self):
        open_pins: MagicMock
        with patch.object(pins, 'open_pins', return_value=([], 0)) as open_pins:
            collect_prototype_feedback.start(_ctx(_context()))
        open_pins.assert_called_once_with(PROJECT, PROTOTYPE, CLAIMS)


class TestUnavailablePinsAreAnInputNotAGate:
    @pytest.mark.parametrize(('error', 'error_type'), [
        (principal.RouteError(500, 'boom'), 'RouteError'),
        (DelegationUnavailable('down'), 'DelegationUnavailable'),
    ])
    def test_the_step_is_done_with_the_feedback_cleared(self, error, error_type):
        result, warning = _start_logging(side_effect=error)
        assert result == {
            'node_id': 'n_collect', 'status': 'done',
            'summary': 'Tester pins were unavailable; revising from the review alone',
            'artifacts': {'project_id': PROJECT},
            'updates': {'prototype_feedback': None},
        }
        warning.assert_called_once_with('Prototype pins unavailable', extra={'error_type': error_type})

    def test_any_other_error_is_not_swallowed(self):
        with patch.object(pins, 'open_pins', side_effect=KeyError('pins')), pytest.raises(KeyError):
            collect_prototype_feedback.start(_ctx(_context()))


class TestTheSummaryAndTheContextCarryTheExactCounts:
    @pytest.mark.parametrize(('usable', 'flagged', 'summary'), [
        ([], 0, '0 open tester pin(s) on the prototype'),
        ([PIN_A], 0, '1 open tester pin(s) on the prototype'),
        ([PIN_A, PIN_B], 0, '2 open tester pin(s) on the prototype'),
        ([], 1, '0 open tester pin(s) on the prototype; 1 flagged pin(s) left for a human'),
        ([PIN_A, PIN_B], 3, '2 open tester pin(s) on the prototype; 3 flagged pin(s) left for a human'),
    ])
    def test_the_result_is_the_literal_summary_and_feedback(self, usable, flagged, summary):
        result, warning = _start_logging(return_value=(usable, flagged))
        assert result == {
            'node_id': 'n_collect', 'status': 'done', 'summary': summary,
            'artifacts': {'project_id': PROJECT},
            'updates': {'prototype_feedback': {'document_id': PROTOTYPE, 'pins': usable, 'flagged': flagged}},
        }
        warning.assert_not_called()

    def test_the_context_key_is_the_one_revise_prototype_reads(self):
        with patch.object(pins, 'open_pins', return_value=([PIN_A], 0)):
            result = collect_prototype_feedback.start(_ctx(_context()))
        assert pins.feedback_for({**_context(), **result['updates']}, PROTOTYPE) == {
            'document_id': PROTOTYPE, 'pins': [PIN_A], 'flagged': 0}
