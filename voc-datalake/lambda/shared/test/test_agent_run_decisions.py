"""shared.agent_run_decisions: the needs_human payload, the allowed decisions, the request body."""
from __future__ import annotations

import pytest

from shared import agent_run_decisions as d
from shared.exceptions import ValidationError


class TestConstants:
    def test_the_vocabulary(self):
        assert d.DECISIONS == ('accept', 'another_round', 'stop')
        assert d.NEEDS_HUMAN_REASONS == ('loop_exhausted', 'no_fail_path', 'end_node', 'budget', 'verification')
        assert frozenset({'loop_exhausted', 'no_fail_path'}) == d.GATE_REASONS

    def test_the_bounds(self):
        assert (d.MAX_STEPS_PER_RUN, d.DEFAULT_MAX_MODEL_CALLS_PER_RUN, d.MAX_MODEL_CALLS_CEILING) == (120, 150, 1000)
        assert (d.MAX_NOTE_CHARS, d.MAX_VERDICTS, d.MAX_OBJECTIONS, d.MAX_OBJECTION_CHARS) == (6000, 12, 5, 400)


class TestPayload:
    def test_a_loop_stop_carries_its_loop_and_compact_verdicts(self):
        verdicts = [{'name': 'Example Air flyer', 'score': 2.5, 'blocking': True, 'persona_id': 'p1',
                     'objections': ['  a  ', '', 'b' * 500, 'c', 'd', 7, 'e', 'f'], 'would_use': False}]
        assert d.needs_human_payload('loop_exhausted', 'r', 'Panel', loop_index=1, max_rounds=3,
                                     verdicts=verdicts) == {
            'reason': 'loop_exhausted', 'node_id': 'r', 'node_title': 'Panel', 'loop_index': 1, 'max_rounds': 3,
            'verdicts': [{'name': 'Example Air flyer', 'score': 2.5, 'blocking': True,
                          'objections': ['a', 'b' * 400, 'c', 'd', 'e']}]}

    def test_other_reasons_carry_no_verdicts_and_no_half_loop(self):
        assert d.needs_human_payload('budget', 'n', 't' * 300, loop_index=1, verdicts=[{'name': 'x'}]) == {
            'reason': 'budget', 'node_id': 'n', 'node_title': 't' * 200}

    def test_an_unknown_reason_is_a_programming_error(self):
        with pytest.raises(ValueError, match=r'^unknown needs_human reason: nope$'):
            d.needs_human_payload('nope', 'n', 't')

    @pytest.mark.parametrize(('raw', 'expected'), [
        (None, []), ('x', []), (['x', 3], []),
        ([{}], [{'name': 'Persona', 'score': None, 'blocking': False, 'objections': []}]),
        ([{'score': True, 'blocking': 'yes', 'objections': 'no'}],
         [{'name': 'Persona', 'score': None, 'blocking': False, 'objections': []}]),
    ])
    def test_verdicts_are_normalised(self, raw, expected):
        assert d.compact_verdicts(raw) == expected

    def test_at_most_twelve_verdicts(self):
        assert len(d.compact_verdicts([{'name': str(i)} for i in range(20)])) == 12


class TestActions:
    @pytest.mark.parametrize(('run', 'expected'), [
        ({'status': 'needs_human', 'needs_human': {'reason': 'loop_exhausted', 'loop_index': 0}},
         ['accept', 'another_round', 'stop']),
        ({'status': 'needs_human', 'needs_human': {'reason': 'no_fail_path'}}, ['accept', 'stop']),
        ({'status': 'needs_human', 'needs_human': {'reason': 'loop_exhausted', 'loop_index': True}},
         ['accept', 'stop']),
        ({'status': 'needs_human', 'needs_human': {'reason': 'end_node'}}, ['stop']),
        ({'status': 'needs_human', 'needs_human': {'reason': 'budget'}}, ['stop']),
        ({'status': 'needs_human', 'needs_human': {'reason': 'verification'}}, ['stop']),
        ({'status': 'needs_human'}, ['stop']),
        ({'status': 'needs_human', 'needs_human': {'reason': 'loop_exhausted', 'loop_index': 0},
          'decision': {'decision': 'stop'}}, []),
        ({'status': 'completed', 'needs_human': {'reason': 'loop_exhausted', 'loop_index': 0}}, []),
        ({'status': 'running'}, []), ({}, []),
    ])
    def test_allowed_actions(self, run, expected):
        assert d.allowed_actions(run) == expected

    def test_the_views(self):
        run = {'status': 'needs_human', 'needs_human': {'reason': 'budget'},
               'decision': {'decision': 'stop', 'note': None, 'by_username': 'alice', 'by_sub': 's', 'at': 'now'}}
        assert d.needs_human_view(run) == {'reason': 'budget'}
        assert d.decision_view(run) == {'decision': 'stop', 'note': None, 'by_username': 'alice', 'at': 'now'}
        assert d.needs_human_view({**run, 'status': 'completed'}) is None
        assert d.needs_human_view({'status': 'needs_human', 'needs_human': 'x'}) is None
        assert d.decision_view({}) is None


class TestParseDecision:
    @pytest.mark.parametrize(('body', 'expected'), [
        ({'decision': 'stop'}, ('stop', None)),
        ({'decision': 'accept', 'note': '  go  '}, ('accept', 'go')),
        ({'decision': 'another_round', 'note': '   '}, ('another_round', None)),
        ({'decision': 'stop', 'note': 'x' * 6000}, ('stop', 'x' * 6000)),
        ({'decision': 'stop', 'note': ' ' + 'x' * 6000 + ' '}, ('stop', 'x' * 6000)),
    ])
    def test_accepted(self, body, expected):
        assert d.parse_decision(body) == expected

    @pytest.mark.parametrize(('body', 'message'), [
        ({}, 'decision must be one of accept, another_round, stop'),
        ({'decision': 'STOP'}, 'decision must be one of accept, another_round, stop'),
        ({'decision': ['stop']}, 'decision must be one of accept, another_round, stop'),
        ({'decision': 'stop', 'note': 1}, 'note must be a string'),
        ({'decision': 'stop', 'note': 'x' * 6001}, 'note must be at most 6000 characters'),
    ])
    def test_refused(self, body, message):
        with pytest.raises(ValidationError, match=f'^{message}$'):
            d.parse_decision(body)


class TestMaxCalls:
    @pytest.mark.parametrize(('agent', 'expected'), [
        ({}, 150), ({'budget': {'max_model_calls_per_run': 40}}, 40), ({'budget': {'max_model_calls_per_run': True}}, 150),
        ({'budget': {'max_model_calls_per_run': 1000}}, 1000), ({'budget': {'max_model_calls_per_run': 1001}}, 150),
    ])
    def test_the_budget(self, agent, expected):
        assert d.max_calls_per_run(agent) == expected
