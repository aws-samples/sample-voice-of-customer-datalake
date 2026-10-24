"""Loop gate rules (shared.workflow_loop_rules) through validate_definition.

Each case is one of the four loops the deployed app accepted and then ran wrong,
or one rule on its own. The messages are mirrored by the frontend
(graphRules.ts), so they are pinned verbatim.
"""
from __future__ import annotations

import pytest

from shared import workflow_loop_rules as rules
from shared import workflow_schema as ws


def _node(node_id: str, node_type: str, **params: object) -> dict:
    return {'id': node_id, 'type': node_type, 'position': {'x': 0, 'y': 0},
            'data': {'title': node_id, 'params': dict(params)}}


def _edge(source: str, target: str, label: str | None = None) -> dict:
    return {'id': f'{source}-{target}-{label or "plain"}', 'source': source, 'target': target,
            **({'label': label} if label else {})}


def _persona_loop(*review_arrows: tuple[str, str | None], extra: tuple[dict, ...] = ()) -> dict:
    """s → doc → r, w → r; loop {r, w} until persona agreement; the review's own arrows as given."""
    return {
        'schema': ws.SCHEMA, 'name': 'Loop',
        'nodes': [_node('s', 'start'), _node('doc', 'write_prfaq'),
                  _node('r', 'persona_review', target='prfaq'), _node('w', 'revise_document'), _node('e', 'end')],
        'edges': [_edge('s', 'doc'), _edge('doc', 'r'), _edge('w', 'r'),
                  *(_edge('r', target, label) for target, label in review_arrows), *extra],
        'loops': [{'node_ids': ['r', 'w'], 'until': 'persona_agreement', 'max_rounds': 3}],
    }


def _errors(definition: dict) -> list[dict]:
    return [issue.to_dict() for issue in ws.validate_definition(definition).errors]


def _at(message: str, node_id: str) -> dict:
    return {'message': message, 'node_id': node_id}


NEEDS_AGREED_EXIT = "this review needs an 'agreed' arrow that leaves the loop"
NEEDS_NOT_AGREED_BACK = "this review needs a 'not_agreed' arrow that stays inside the loop"
AGREED_MUST_LEAVE = "an 'agreed' arrow must leave the loop"
NOT_AGREED_MUST_STAY = "a 'not_agreed' arrow must stay inside the loop"
LABEL_EACH = "label each arrow of this review 'agreed' or 'not_agreed'"


class TestTheWellFormedLoop:
    def test_agreed_out_and_not_agreed_back_is_valid(self):
        definition = _persona_loop(('e', 'agreed'), ('w', 'not_agreed'))
        assert ws.validate_definition(definition).valid, _errors(definition)

    def test_the_builtin_template_still_validates(self):
        result = ws.validate_definition(ws.default_template())
        assert result.valid, result.to_dict()


class TestLiveFindings:
    def test_1_unlabelled_arrows_back_and_out(self):
        assert _errors(_persona_loop(('e', None), ('w', None))) == [
            _at(NEEDS_AGREED_EXIT, 'r'), _at(NEEDS_NOT_AGREED_BACK, 'r'), _at(LABEL_EACH, 'r')]

    def test_2_inverted_labels(self):
        assert _errors(_persona_loop(('e', 'not_agreed'), ('w', 'agreed'))) == [
            _at(NEEDS_AGREED_EXIT, 'r'), _at(NEEDS_NOT_AGREED_BACK, 'r'),
            _at(AGREED_MUST_LEAVE, 'r'), _at(NOT_AGREED_MUST_STAY, 'r')]

    def test_3_an_exit_from_a_member_that_is_not_the_review(self):
        definition = _persona_loop(('e', 'agreed'), ('w', 'not_agreed'), extra=(_edge('w', 'e'),))
        assert _errors(definition) == [_at(rules.ONLY_THE_REVIEW_LEAVES, 'w')]

    def test_4_a_review_pass_loop_whose_only_reviewer_is_a_persona_review(self):
        definition = _persona_loop(('e', 'agreed'), ('w', 'not_agreed'))
        definition['loops'][0]['until'] = 'review_pass'
        assert _errors(definition) == [
            {'message': 'loop 1 repeats until a review passes but contains no final review'}]


class TestEachRule:
    def test_a_missing_failing_arrow_alone(self):
        definition = _persona_loop(('e', 'agreed'), extra=(_edge('doc', 'w'),))
        assert _at(NEEDS_NOT_AGREED_BACK, 'r') in _errors(definition)
        assert _at(NEEDS_AGREED_EXIT, 'r') not in _errors(definition)

    def test_a_missing_passing_exit_alone(self):
        definition = _persona_loop(('w', 'not_agreed'))
        definition['edges'].append(_edge('w', 'e'))
        assert _errors(definition) == [_at(NEEDS_AGREED_EXIT, 'r'), _at(rules.ONLY_THE_REVIEW_LEAVES, 'w')]

    def test_a_second_agreed_arrow_inside_the_loop(self):
        assert _errors(_persona_loop(('e', 'agreed'), ('w', 'not_agreed'), ('w', 'agreed'))) == [
            _at(AGREED_MUST_LEAVE, 'r')]

    def test_a_second_not_agreed_arrow_outside_the_loop(self):
        assert _errors(_persona_loop(('e', 'agreed'), ('w', 'not_agreed'), ('e', 'not_agreed'))) == [
            _at(NOT_AGREED_MUST_STAY, 'r')]

    def test_one_extra_unlabelled_arrow(self):
        assert _errors(_persona_loop(('e', 'agreed'), ('w', 'not_agreed'), ('w', None))) == [_at(LABEL_EACH, 'r')]

    def test_a_review_pass_gate_speaks_pass_and_fail(self):
        definition = _persona_loop()
        definition['nodes'][2] = _node('r', 'final_review')
        definition['edges'] += [_edge('r', 'e'), _edge('r', 'w', 'pass')]
        definition['loops'][0]['until'] = 'review_pass'
        assert _errors(definition) == [
            _at("this review needs a 'pass' arrow that leaves the loop", 'r'),
            _at("this review needs a 'fail' arrow that stays inside the loop", 'r'),
            _at("a 'pass' arrow must leave the loop", 'r'),
            _at("label each arrow of this review 'pass' or 'fail'", 'r')]

    def test_a_final_review_with_fail_out_is_refused(self):
        definition = _persona_loop()
        definition['nodes'][2] = _node('r', 'final_review')
        definition['edges'] += [_edge('r', 'e', 'pass'), _edge('r', 'w', 'fail'), _edge('r', 'e', 'fail')]
        definition['loops'][0]['until'] = 'review_pass'
        assert _errors(definition) == [_at("a 'fail' arrow must stay inside the loop", 'r')]

    def test_every_gate_of_a_loop_is_checked(self):
        definition = _persona_loop(('e', 'agreed'), ('w', 'not_agreed'))
        definition['nodes'][3] = _node('w', 'persona_review', target='prfaq')
        assert _errors(definition) == [
            _at(NEEDS_AGREED_EXIT, 'w'), _at(NEEDS_NOT_AGREED_BACK, 'w'), _at(LABEL_EACH, 'w')]


class TestHelpers:
    @pytest.mark.parametrize(('label', 'expected'), [
        ('agreed', 'an'), ('not_agreed', 'a'), ('pass', 'a'), ('fail', 'a'), ('', 'a')])
    def test_the_article(self, label, expected):
        assert rules.article(label) == expected

    def test_the_gate_table(self):
        assert rules.LOOP_GATES == {'persona_agreement': ('persona_review', 'agreed', 'not_agreed'),
                                    'review_pass': ('final_review', 'pass', 'fail')}

    def test_an_unknown_until_and_missing_steps_are_left_to_the_shape_checks(self):
        types = {'r': 'persona_review'}
        assert rules.loop_gate_issues(types, [_edge('r', 'ghost')],
                                      [{'node_ids': ['r'], 'until': 'never'}]) == []
        assert rules.loop_gate_issues(types, [], [{'node_ids': ['ghost'], 'until': 'persona_agreement'}]) == [
            ('loop 1 repeats until persona agreement but contains no persona review', None)]

    def test_start_and_end_members_are_not_part_of_the_loop_for_the_gate(self):
        types = {'r': 'persona_review', 'w': 'revise_document', 'e': 'end'}
        edges = [_edge('r', 'w', 'not_agreed'), _edge('w', 'r'), _edge('r', 'e', 'agreed')]
        assert rules.loop_gate_issues(types, edges, [{'node_ids': ['r', 'w', 'e'], 'until': 'persona_agreement'}]) == []


class TestTheEditorsOrder:
    """The editor (graphRules.ts) lists the same issues in the same order: loops in
    order, members in ``node_ids`` order, each gate's checks where the gate sits."""

    def test_members_are_walked_in_node_ids_order_not_gates_first(self):
        definition = _persona_loop(('w', 'not_agreed'), extra=(_edge('w', 'e'),))
        definition['loops'][0]['node_ids'] = ['w', 'r']
        assert _errors(definition) == [_at(rules.ONLY_THE_REVIEW_LEAVES, 'w'), _at(NEEDS_AGREED_EXIT, 'r')]

    def test_a_loop_without_its_review_reports_only_that(self):
        definition = _persona_loop(('e', 'agreed'), ('w', 'not_agreed'), extra=(_edge('w', 'e'),))
        definition['loops'][0]['until'] = 'review_pass'
        assert _errors(definition) == [
            {'message': 'loop 1 repeats until a review passes but contains no final review'}]
