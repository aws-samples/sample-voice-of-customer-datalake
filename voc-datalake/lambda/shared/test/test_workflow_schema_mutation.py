"""Mutation hardening for `shared/workflow_schema.py`.

`test_workflow_schema.py` pins that broken definitions are refused, mostly with
`not valid` or a substring of one message, so a mutation run found what it
cannot see:

* the WORDING and the node pin of every refusal. `POST /workflows/validate`
  returns `ValidationResult.to_dict()` and the workflow editor shows each message
  on the node it names, so every error list here is compared whole: a label that
  drifts (``node 1 id`` becoming ``node 2 id``), a joined list of choices, or an
  extra or missing finding fails a test.
* the ACCEPTED side of every bound (`>` vs `>=`): exactly 60 nodes, 240 edges,
  10 loops, 120-character names and titles, 4,000-character instructions, a
  4,096-byte params object, ±1,000,000 coordinates and a 300,000-byte definition
  all validate.
* every member of the vocabularies (node types, roles, labels, loop conditions,
  review targets, end statuses, reviewing nodes) is accepted, and the diff names
  each changed field of a node and an edge.
* the built-in `wf_default` template, which seeds every deployment and the
  agents' default run, is pinned by a digest of its stored form.
"""
import dataclasses
import hashlib
import itertools
import typing

import pytest

from shared import workflow_schema as ws


def _step(node_id: str, node_type: str = 'write_prd', **data: object) -> dict:
    return {'id': node_id, 'type': node_type, 'position': {'x': 0, 'y': 0}, 'data': {'title': node_id, **data}}


def _arrow(source: str, target: str, label: str | None = None) -> dict:
    if label is None:
        return {'id': f'{source[:30]}-{target[:30]}', 'source': source, 'target': target}
    return {'id': f'{source}-{target}-{label}', 'source': source, 'target': target, 'label': label}


def _flow(*middle: dict, arrows: tuple = (), loops: tuple | str = (), **top: object) -> dict:
    """start → each middle step in order → end, plus extra arrows and loops."""
    steps = [_step('s', 'start'), *middle, _step('e', 'end')]
    chain = [_arrow(a['id'], b['id']) for a, b in itertools.pairwise(steps)]
    return {'schema': 'voc-workflow/1', 'name': 'Flow', 'nodes': steps, 'edges': [*chain, *arrows],
            'loops': loops if isinstance(loops, str) else list(loops), **top}


def _errors(raw: object) -> list[dict]:
    return [issue.to_dict() for issue in ws.validate_definition(raw).errors]


def _normalised(raw: object) -> dict:
    definition = ws.validate_definition(raw).definition
    assert definition is not None, _errors(raw)
    return definition


def _msg(message: str, node_id: str | None = None) -> dict:
    return {'message': message, **({'node_id': node_id} if node_id else {})}


def _assign(target: object, name: str, value: object) -> None:
    """A field write pyright allows to type-check, so the frozen refusal is a runtime fact."""
    setattr(target, name, value)


ID_RULE = '1-64 letters, digits, "_" or "-"'


class TestResultObjects:
    def test_an_issue_without_a_node_has_no_node_id_key(self):
        assert ws.Issue('m').to_dict() == {'message': 'm'}
        assert ws.Issue('m').node_id is None
        assert ws.Issue('m', 'n').to_dict() == {'message': 'm', 'node_id': 'n'}

    def test_the_validate_body(self):
        assert ws.validate_definition(None).to_dict() == {
            'valid': False, 'errors': [{'message': 'definition must be a JSON object'}]}
        assert ws.validate_definition(_flow()).to_dict() == {'valid': True, 'errors': []}

    def test_a_refused_definition_carries_none(self):
        assert ws.validate_definition(None).definition is None
        assert ws.ValidationResult(errors=()).definition is None

    def test_results_are_frozen(self):
        with pytest.raises(dataclasses.FrozenInstanceError):
            _assign(ws.Issue('m'), 'message', 'x')
        with pytest.raises(dataclasses.FrozenInstanceError):
            _assign(ws.ValidationResult(errors=()), 'errors', ())

    def test_the_declared_field_types(self):
        assert typing.get_type_hints(ws.Issue) == {'message': str, 'node_id': str | None}
        assert typing.get_type_hints(ws.ValidationResult) == {
            'errors': tuple[ws.Issue, ...], 'definition': dict[str, typing.Any] | None}


class TestPublishedConstants:
    def test_the_default_workflow_names(self):
        assert (ws.DEFAULT_WORKFLOW_ID, ws.DEFAULT_WORKFLOW_SLUG) == ('wf_default', 'reviews-to-prototype')


class TestTopLevelRefusals:
    @pytest.mark.parametrize(('top', 'errors'), [
        ({'schema': 'v2'}, ["schema must be 'voc-workflow/1'"]),
        ({'name': None}, ['name is required']),
        ({'name': '   '}, ['name is required']),
        ({'name': 3}, ['name must be a string']),
        ({'name': 'n' * 121}, ['name must be at most 120 characters']),
        ({'description': 'd' * 2001}, ['description must be at most 2000 characters']),
        ({'description': 5}, ['description must be a string']),
        ({'nodes': None}, ['nodes must be a list']),
        ({'edges': 'x'}, ['edges must be a list']),
        ({'loops': 'x'}, ['loops must be a list']),
    ])
    def test_each_message(self, top, errors):
        assert _errors(_flow(**top)) == [_msg(m) for m in errors]

    def test_a_missing_edges_key_is_refused_but_missing_loops_is_empty(self):
        definition = _flow()
        del definition['edges']
        assert _errors(definition) == [_msg('edges must be a list')]
        definition = _flow()
        del definition['loops']
        assert _normalised(definition)['loops'] == []

    def test_the_normalised_top_level(self):
        definition = _flow(name='  Flow  ', extra='dropped')
        assert _normalised(definition) == {
            'schema': 'voc-workflow/1', 'name': 'Flow', 'description': '',
            'nodes': [
                {'id': 's', 'type': 'start', 'position': {'x': 0.0, 'y': 0.0}, 'data': {'title': 's', 'params': {}}},
                {'id': 'e', 'type': 'end', 'position': {'x': 0.0, 'y': 0.0}, 'data': {'title': 'e', 'params': {}}},
            ],
            'edges': [{'id': 's-e', 'source': 's', 'target': 'e'}],
            'loops': [],
        }

    def test_the_longest_texts_are_kept(self):
        definition = _normalised(_flow(name='n' * 120, description='d' * 2000))
        assert (len(definition['name']), len(definition['description'])) == (120, 2000)


def _many_nodes(count: int) -> list[dict]:
    return [_step(f'n{i}') for i in range(count)]


def _dag_edges(middle: int, total: int) -> list[dict]:
    """The start→…→end chain over `middle` steps, plus forward skips until `total` arrows."""
    names = ['s', *(f'n{i}' for i in range(middle)), 'e']
    pairs = list(itertools.pairwise(names))
    skips = ((names[i], names[j]) for i in range(1, len(names) - 1) for j in range(i + 2, len(names) - 1))
    while len(pairs) < total:
        pairs.append(next(skips))
    return [_arrow(source, target) for source, target in pairs]


def _self_loops(count: int) -> tuple[list[dict], list[dict], list[dict]]:
    # final_review, not custom_llm: since 3.00.00 a custom step is not a reviewer.
    steps = [_step(f'c{i}', 'final_review') for i in range(count)]
    arrows = [_arrow(f'c{i}', f'c{i}') for i in range(count)]
    loops = [{'node_ids': [f'c{i}'], 'until': 'review_pass', 'max_rounds': 1} for i in range(count)]
    return steps, arrows, loops


class TestCountLimits:
    def test_sixty_nodes_and_240_edges_validate(self):
        definition = _flow(*_many_nodes(58))
        definition['edges'] = _dag_edges(58, 240)
        assert ws.validate_definition(definition).valid, _errors(definition)

    def test_sixty_one_nodes_are_refused(self):
        assert _errors(_flow(*_many_nodes(59))) == [_msg('at most 60 nodes are allowed')]

    def test_241_edges_are_refused(self):
        definition = _flow(*_many_nodes(58))
        definition['edges'] = _dag_edges(58, 241)
        assert _errors(definition) == [_msg('at most 240 edges are allowed')]

    def test_ten_loops_validate_and_eleven_are_refused(self):
        steps, arrows, loops = _self_loops(10)
        assert ws.validate_definition(_flow(*steps, arrows=tuple(arrows), loops=tuple(loops))).valid
        steps, arrows, loops = _self_loops(11)
        assert _errors(_flow(*steps, arrows=tuple(arrows), loops=tuple(loops))) == [
            _msg('at most 10 loops are allowed')]


class TestNodeShape:
    @pytest.mark.parametrize('node_type', [
        'aggregate_reviews', 'select_or_create_project', 'select_personas', 'generate_personas', 'deep_research',
        'write_prfaq', 'write_prd', 'revise_document', 'build_prototype', 'collect_prototype_feedback',
        'revise_prototype', 'final_review', 'duplicate_document', 'handoff',
    ])
    def test_every_plain_step_type_is_accepted(self, node_type):
        assert _normalised(_flow(_step('a', node_type)))['nodes'][1]['type'] == node_type

    @pytest.mark.parametrize('role', ['orchestrator', 'worker', 'reviewer', 'persona'])
    def test_every_role_is_kept(self, role):
        assert _normalised(_flow(_step('a', role=role)))['nodes'][1]['data'] == {
            'title': 'a', 'role': role, 'params': {}}

    def test_the_normalised_node_drops_unknown_keys(self):
        node = {**_step('a', instructions='  think  ', params={'k': 1}, colour='red'),
                'position': {'x': 3, 'y': -4.5}, 'selected': True}
        assert _normalised(_flow(node))['nodes'][1] == {
            'id': 'a', 'type': 'write_prd', 'position': {'x': 3.0, 'y': -4.5},
            'data': {'title': 'a', 'instructions': 'think', 'params': {'k': 1}}}

    @pytest.mark.parametrize(('node', 'errors'), [
        ('x', [_msg('node 2 must be an object')]),
        ({'id': 'a b', 'type': 'nope'}, [_msg(f'node 2 id must be {ID_RULE}')]),
        ({'id': 5}, [_msg(f'node 2 id must be {ID_RULE}')]),
        ({'id': 'x' * 65}, [_msg(f'node 2 id must be {ID_RULE}')]),
        ({'id': 'a', 'type': 'nope', 'data': 'x'}, [_msg('unknown node type', 'a')]),
        ({**_step('a'), 'data': 'x'}, [_msg('data must be an object', 'a')]),
        ({**_step('a'), 'position': 'p'}, [_msg('position must be an object {x, y}', 'a')]),
        (_step('a', title=None), [_msg('title is required', 'a')]),
        (_step('a', title=7), [_msg('title must be a string', 'a')]),
        (_step('a', title='t' * 121), [_msg('title must be at most 120 characters', 'a')]),
        (_step('a', 'custom_llm'), [_msg('instructions is required', 'a')]),
        (_step('a', 'custom_llm', instructions='i' * 4001), [_msg('instructions must be at most 4000 characters', 'a')]),
        (_step('a', role='boss'), [_msg('role must be one of orchestrator, worker, reviewer, persona', 'a')]),
        (_step('a', params=[1]), [_msg('params must be an object', 'a')]),
        (_step('a', params={'x': float('nan')}), [_msg('params must be plain JSON (no NaN or Infinity)', 'a')]),
        (_step('a', params={'x': object()}), [_msg('params must be plain JSON (no NaN or Infinity)', 'a')]),
        (_step('a', params={'k': 'v' * 4088}), [_msg('params must be at most 4096 bytes of JSON', 'a')]),
        (_step('a', 'persona_review'), [_msg('persona_review needs params.target: one of prfaq, prd, prototype', 'a')]),
    ])
    def test_each_refusal(self, node, errors):
        definition = _flow()
        definition['nodes'].insert(1, node)  # shape errors stop validation before the graph rules
        assert _errors(definition) == errors

    def test_the_index_is_one_based(self):
        assert _errors({**_flow(), 'nodes': ['x']}) == [_msg('node 1 must be an object')]
        assert _errors({**_flow(), 'nodes': [{'id': ''}]}) == [_msg(f'node 1 id must be {ID_RULE}')]

    def test_the_longest_texts_and_params_are_accepted(self):
        node = _step('a', 'custom_llm', title='t' * 120, instructions='i' * 4000, params={'k': 'v' * 4087})
        data = _normalised(_flow(node))['nodes'][1]['data']
        assert (len(data['title']), len(data['instructions']), len(data['params']['k'])) == (120, 4000, 4087)

    def test_a_64_character_id_is_accepted(self):
        assert _normalised(_flow(_step('x' * 64)))['nodes'][1]['id'] == 'x' * 64

    def test_missing_instructions_and_params_normalise_to_nothing(self):
        node = {'id': 'a', 'type': 'write_prd', 'position': {'x': 0, 'y': 0}, 'data': {'title': 'a'}}
        assert _normalised(_flow(node))['nodes'][1]['data'] == {'title': 'a', 'params': {}}

    @pytest.mark.parametrize('target', ['prfaq', 'prd', 'prototype'])
    def test_every_review_target_is_accepted(self, target):
        node = _step('a', 'persona_review', params={'target': target})
        assert _normalised(_flow(node))['nodes'][1]['data']['params'] == {'target': target}

    @pytest.mark.parametrize(('params', 'valid'), [
        ({}, True), ({'status': 'completed'}, True), ({'status': 'needs_human'}, True), ({'status': 'won'}, False),
    ])
    def test_the_end_status(self, params, valid):
        definition = _flow()
        definition['nodes'][1]['data']['params'] = params
        expected = [] if valid else [_msg('end params.status must be one of completed, needs_human', 'e')]
        assert _errors(definition) == expected

    def test_a_status_on_another_step_is_not_checked(self):
        assert ws.validate_definition(_flow(_step('a', params={'status': 'won'}))).valid

    def test_duplicate_node_ids_name_the_node(self):
        assert _errors(_flow(_step('a'), _step('a'))) == [_msg('node id is used more than once', 'a')]


class TestPositions:
    @pytest.mark.parametrize(('x', 'y'), [(1_000_000, -1_000_000), (0, 0), (2.5, 7)])
    def test_accepted_coordinates_become_floats(self, x, y):
        node = {**_step('a'), 'position': {'x': x, 'y': y}}
        assert _normalised(_flow(node))['nodes'][1]['position'] == {'x': float(x), 'y': float(y)}

    @pytest.mark.parametrize('position', [
        {'x': 1_000_001, 'y': 0}, {'x': 0, 'y': -1_000_001}, {'x': True, 'y': 0}, {'x': 0, 'y': 'p'},
        {'x': float('inf'), 'y': 0}, {'x': float('nan'), 'y': 0}, {'x': 0},
    ])
    def test_refused_coordinates(self, position):
        node = {**_step('a'), 'position': position}
        assert _errors(_flow(node)) == [_msg('position x and y must be finite numbers within ±1000000', 'a')]


class TestEdgeShape:
    @pytest.mark.parametrize(('edge', 'errors'), [
        ('x', ['edge 2 must be an object']),
        ({'source': 's', 'target': 'e'}, [f'edge 2 id must be {ID_RULE}']),
        ({'id': 'z', 'target': 'e'}, [f'edge 2 source must be {ID_RULE}']),
        ({'id': 'z', 'source': 's'}, [f'edge 2 target must be {ID_RULE}']),
        ({'id': 'z', 'source': 's', 'target': 'e', 'label': 'maybe'},
         ['edge 2 label must be one of pass, fail, agreed, not_agreed']),
        ({'id': 'z', 'source': 's', 'target': 'e', 'label': ''},
         ['edge 2 label must be one of pass, fail, agreed, not_agreed']),
    ])
    def test_each_refusal(self, edge, errors):
        definition = _flow()
        definition['edges'].append(edge)
        assert _errors(definition) == [_msg(m) for m in errors]

    def test_the_index_is_one_based(self):
        assert _errors({**_flow(), 'edges': ['x']}) == [_msg('edge 1 must be an object')]
        assert _errors({**_flow(), 'edges': [{}]}) == [
            _msg(f'edge 1 {part} must be {ID_RULE}') for part in ('id', 'source', 'target')]
        assert _errors({**_flow(), 'edges': [{'id': 'z', 'source': 's', 'target': 'e', 'label': 'x'}]}) == [
            _msg('edge 1 label must be one of pass, fail, agreed, not_agreed')]

    def test_edges_with_a_bad_id_are_dropped_not_kept(self):
        definition = _flow()
        definition['edges'] += [{'source': 's', 'target': 'e'}, {'source': 's', 'target': 'e'}]
        assert _errors(definition) == [_msg(f'edge {n} id must be {ID_RULE}') for n in (2, 3)]

    def test_duplicate_edge_ids_name_no_node(self):
        definition = _flow(_step('a'))
        definition['edges'][1]['id'] = definition['edges'][0]['id']
        assert _errors(definition) == [_msg('edge id is used more than once')]

    @pytest.mark.parametrize('label', ['pass', 'fail'])
    def test_verdict_labels_leave_any_step(self, label):
        edge = _normalised(_flow(_step('a'), arrows=(_arrow('a', 'e', label),)))['edges'][-1]
        assert edge == {'id': f'a-e-{label}', 'source': 'a', 'target': 'e', 'label': label}

    @pytest.mark.parametrize('label', ['agreed', 'not_agreed'])
    def test_persona_labels(self, label):
        review = _step('r', 'persona_review', params={'target': 'prfaq'})
        assert ws.validate_definition(_flow(review, arrows=(_arrow('r', 'e', label),))).valid
        assert _errors(_flow(_step('a'), arrows=(_arrow('a', 'e', label),))) == [
            _msg(f"'{label}' arrows can only leave a persona review", 'a')]


class TestGraphRefusals:
    def test_an_arrow_from_a_missing_step_names_no_node(self):
        assert _errors(_flow(arrows=(_arrow('ghost', 'e'),))) == [_msg('edge connects a node that does not exist')]

    def test_an_arrow_to_a_missing_step_names_its_source_only(self):
        assert _errors(_flow(arrows=(_arrow('e', 'ghost'),))) == [
            _msg('edge connects a node that does not exist', 'e')]

    def test_arrows_after_a_missing_step_are_still_checked(self):
        assert _errors(_flow(_step('a'), arrows=(_arrow('a', 'ghost'), _arrow('e', 'a')))) == [
            _msg('edge connects a node that does not exist', 'a'),
            _msg('an end step cannot have outgoing arrows', 'e'),
            _msg('this step is in a cycle that is not inside one declared loop', 'a'),
            _msg('this step is in a cycle that is not inside one declared loop', 'e')]

    def test_an_arrow_into_the_start(self):
        assert _errors(_flow(_step('a'), arrows=(_arrow('a', 's'),))) == [
            _msg('the start step cannot have incoming arrows', 's'),
            _msg('this step is in a cycle that is not inside one declared loop', 's'),
            _msg('this step is in a cycle that is not inside one declared loop', 'a')]

    def test_an_arrow_out_of_an_end(self):
        assert _errors(_flow(_step('a'), arrows=(_arrow('e', 'a'),))) == [
            _msg('an end step cannot have outgoing arrows', 'e'),
            _msg('this step is in a cycle that is not inside one declared loop', 'a'),
            _msg('this step is in a cycle that is not inside one declared loop', 'e')]

    def test_two_arrows_with_the_same_label(self):
        twin = {**_arrow('s', 'e'), 'id': 'twin'}
        assert _errors(_flow(arrows=(twin,))) == [_msg('two arrows connect the same steps with the same label', 's')]

    def test_the_same_steps_with_different_labels_are_allowed(self):
        assert ws.validate_definition(_flow(_step('a'), arrows=(_arrow('a', 'e', 'fail'),))).valid

    def test_no_start(self):
        definition = _flow()
        definition['nodes'][0]['type'] = 'write_prd'
        assert _errors(definition) == [_msg('a workflow needs exactly one start step')]

    def test_two_starts(self):
        definition = _flow(_step('a', 'start'))
        assert _errors(definition) == [
            _msg('the start step cannot have incoming arrows', 'a'), _msg('a workflow needs exactly one start step')]

    def test_no_end_stops_before_reachability(self):
        definition = _flow()
        definition['nodes'][1]['type'] = 'write_prd'
        assert _errors(definition) == [_msg('a workflow needs at least one end step')]

    def test_an_orphan_and_a_dead_end(self):
        definition = _flow(_step('a'), arrows=(_arrow('s', 'b'),))
        definition['nodes'] += [_step('lost'), _step('b')]
        assert _errors(definition) == [
            _msg('this step is not connected to the start', 'lost'), _msg('this step has no path to an end step', 'b')]

    def test_a_second_end_is_a_valid_exit(self):
        definition = _flow(_step('a'), arrows=(_arrow('a', 'e2', 'fail'),))
        definition['nodes'].append(_step('e2', 'end'))
        assert ws.validate_definition(definition).valid

    def test_a_cycle_after_an_acyclic_step_is_still_found(self):
        definition = _flow(_step('a'), _step('b'), arrows=(_arrow('b', 'a'),))
        assert _errors(definition) == [
            _msg('this step is in a cycle that is not inside one declared loop', 'a'),
            _msg('this step is in a cycle that is not inside one declared loop', 'b')]


def _review(node_id: str = 'r') -> dict:
    return _step(node_id, 'persona_review', params={'target': 'prfaq'})


def _review_loop(**loop: object) -> dict:
    """s → r ⇄ w → e, with one declared loop over r and w."""
    return _flow(_review(), _step('w', 'revise_document'), arrows=(_arrow('w', 'r'),),
                 loops=({'node_ids': ['r', 'w'], 'until': 'persona_agreement', 'max_rounds': 3, **loop},))


class TestLoopShape:
    def test_the_normalised_loop(self):
        assert _normalised(_review_loop(extra=1))['loops'] == [
            {'node_ids': ['r', 'w'], 'until': 'persona_agreement', 'max_rounds': 3}]

    @pytest.mark.parametrize('rounds', [1, 5])
    def test_the_round_bounds_are_accepted(self, rounds):
        assert _normalised(_review_loop(max_rounds=rounds))['loops'][0]['max_rounds'] == rounds

    @pytest.mark.parametrize('rounds', [0, 6, True, 2.5, None])
    def test_other_rounds_are_refused(self, rounds):
        assert _errors(_review_loop(max_rounds=rounds)) == [
            _msg('loop 1 max_rounds must be a whole number from 1 to 5')]

    @pytest.mark.parametrize(('loop', 'errors'), [
        ('x', ['loop 1 must be an object']),
        ({'node_ids': []}, ['loop 1 needs a non-empty node_ids list']),
        ({'node_ids': 'r'}, ['loop 1 needs a non-empty node_ids list']),
        ({'node_ids': ['r', 'w b'], 'until': 'never'}, [f'loop 1 node id must be {ID_RULE}']),
        ({'node_ids': ['r', 'w', 'r'], 'until': 'persona_agreement', 'max_rounds': 3}, ['loop 1 lists a node twice']),
        ({'node_ids': ['r', 'w'], 'until': 'never', 'max_rounds': 3},
         ['loop 1 until must be one of persona_agreement, review_pass']),
    ])
    def test_each_refusal(self, loop, errors):
        assert _errors({**_review_loop(), 'loops': [loop]}) == [_msg(m) for m in errors]

    def test_loops_are_numbered_from_one(self):
        definition = _review_loop()
        definition['loops'].append('x')
        assert _errors(definition) == [_msg('loop 2 must be an object')]


class TestLoopRules:
    def test_a_step_that_does_not_exist(self):
        assert _errors(_review_loop(node_ids=['r', 'w', 'ghost'])) == [
            _msg('loop 1 lists a step that does not exist')]

    def test_members_after_a_missing_step_are_still_checked(self):
        assert _errors(_review_loop(node_ids=['r', 'ghost', 'w', 'e'])) == [
            _msg('loop 1 lists a step that does not exist'),
            _msg('start and end steps cannot be inside a loop', 'e')]

    @pytest.mark.parametrize('node_id', ['s', 'e'])
    def test_start_and_end_cannot_be_in_a_loop(self, node_id):
        assert _errors(_review_loop(node_ids=['r', 'w', node_id])) == [
            _msg('start and end steps cannot be inside a loop', node_id)]

    def test_a_step_in_two_loops(self):
        definition = _review_loop()
        definition['loops'].append({'node_ids': ['w'], 'until': 'review_pass', 'max_rounds': 1})
        assert _errors(definition) == [
            _msg('a step can belong to only one loop', 'w'),
            _msg('loop 2 repeats until a review passes but contains no reviewing step'),
            _msg('loop 2 has no arrow back to an earlier step in the loop')]

    def test_persona_agreement_needs_a_persona_review(self):
        definition = _flow(_step('a'), _step('w'), arrows=(_arrow('w', 'a'),),
                           loops=({'node_ids': ['a', 'w'], 'until': 'persona_agreement', 'max_rounds': 2},))
        assert _errors(definition) == [
            _msg('loop 1 repeats until persona agreement but contains no persona review')]

    # Not custom_llm: since 3.00.00 it reports no verdict (test_workflow_schema.py pins the refusal).
    @pytest.mark.parametrize('node', [_review('v'), _step('v', 'final_review')])
    def test_review_pass_accepts_every_reviewing_step(self, node):
        definition = _flow(node, _step('w'), arrows=(_arrow('w', 'v'),),
                           loops=({'node_ids': ['v', 'w'], 'until': 'review_pass', 'max_rounds': 2},))
        assert ws.validate_definition(definition).valid, _errors(definition)

    def test_review_pass_needs_a_reviewing_step(self):
        definition = _flow(_step('a'), _step('w'), arrows=(_arrow('w', 'a'),),
                           loops=({'node_ids': ['a', 'w'], 'until': 'review_pass', 'max_rounds': 2},))
        assert _errors(definition) == [_msg('loop 1 repeats until a review passes but contains no reviewing step')]

    def test_a_loop_without_a_cycle(self):
        definition = _flow(_review(), loops=({'node_ids': ['r'], 'until': 'persona_agreement', 'max_rounds': 2},))
        assert _errors(definition) == [_msg('loop 1 has no arrow back to an earlier step in the loop')]

    def test_a_cycle_that_leaves_its_loop(self):
        assert _errors(_review_loop(node_ids=['r'])) == [
            _msg('this step is in a cycle that is not inside one declared loop', 'r'),
            _msg('this step is in a cycle that is not inside one declared loop', 'w'),
            _msg('loop 1 has no arrow back to an earlier step in the loop')]


def _sized(extra: int) -> dict:
    """A valid definition whose stored JSON is (base + extra) bytes; each step's params can grow by 1,000."""
    steps = [_step(f'n{i}', 'custom_llm', instructions='i' * 4000, params={'p': 'v' * 3000}) for i in range(40)]
    for step in steps:
        grow = min(extra, 1000)
        step['data']['params']['p'] += 'v' * grow
        extra -= grow
    return _flow(*steps)


def _stored_bytes(raw: dict) -> int:
    return len(ws.encode_definition(_normalised(raw)).encode('utf-8'))


class TestStoredSizeLimit:
    def test_exactly_the_limit_validates_and_one_byte_more_is_refused(self):
        fill = 300_000 - _stored_bytes(_sized(0))
        assert 0 < fill < 40_000
        assert _stored_bytes(_sized(fill)) == 300_000
        assert _errors(_sized(fill + 1)) == [_msg('the workflow is too large to save (at most 300000 bytes of JSON)')]


class TestStoredForm:
    def test_encode_is_compact_and_key_sorted(self):
        assert ws.encode_definition({'b': 1.5, 'a': [1, {'d': 2, 'c': 3}]}) == '{"a":[1,{"c":3,"d":2}],"b":1.5}'

    def test_encode_refuses_nan(self):
        with pytest.raises(ValueError, match='Out of range float values are not JSON compliant'):
            ws.encode_definition({'x': float('nan')})

    @pytest.mark.parametrize(('stored', 'decoded'), [('{"a":1}', {'a': 1}), ('[1]', None), ('{', None), (5, None)])
    def test_decode(self, stored, decoded):
        assert ws.decode_definition(stored) == decoded


class TestLibraryHelpers:
    def test_the_export_envelope(self):
        assert ws.export_document({'name': 'n'}, workflow_id='wf_1', revision=2, slug='n') == {
            'name': 'n', 'exported_from': {'workflow_id': 'wf_1', 'revision': 2, 'slug': 'n'}}

    @pytest.mark.parametrize('raw', [
        {'exported_from': 'wf_1'}, {'exported_from': {'workflow_id': 5}}, {'exported_from': {'workflow_id': 'w' * 65}},
        'wf_1',
    ])
    def test_malformed_lineage_is_none(self, raw):
        assert ws.imported_lineage(raw) is None

    def test_a_64_character_lineage_is_kept(self):
        assert ws.imported_lineage({'exported_from': {'workflow_id': 'w' * 64}}) == 'w' * 64

    @pytest.mark.parametrize(('name', 'slug'), [
        ('  Hello,  World!  ', 'hello-world'), ('a' * 61, 'a' * 60), ('a' * 59 + ' b', 'a' * 59), ('ÉÉ', 'workflow'),
        ('--Ab--9--', 'ab-9'), ('a' * 58 + ' b-c', 'a' * 58 + '-b'),
    ])
    def test_slugify(self, name, slug):
        assert ws.slugify(name) == slug


def _node_diff(before: dict, after: dict) -> list:
    return ws.diff_definitions({'nodes': [before]}, {'nodes': [after]})['nodes']['changed']


class TestDiff:
    @pytest.mark.parametrize(('field', 'change'), [
        ('type', {'type': 'write_prfaq'}),
        ('position', {'position': {'x': 1, 'y': 0}}),
        ('title', {'data': {'title': 'other'}}),
        ('instructions', {'data': {'title': 'a', 'instructions': 'x'}}),
        ('role', {'data': {'title': 'a', 'role': 'worker'}}),
        ('params', {'data': {'title': 'a', 'params': {'k': 1}}}),
    ])
    def test_each_node_field_is_named(self, field, change):
        before = _step('a')
        assert _node_diff(before, {**before, **change}) == [{'id': 'a', 'fields': [field]}]

    def test_a_node_without_data_and_an_empty_params_are_the_same(self):
        assert _node_diff({'id': 'a', 'data': None}, {'id': 'a', 'data': {'params': {}}}) == []

    @pytest.mark.parametrize('field', ['source', 'target', 'label'])
    def test_each_edge_field_is_named(self, field):
        before = {'id': 'x', 'source': 'a', 'target': 'b', 'label': 'pass'}
        diff = ws.diff_definitions({'edges': [before]}, {'edges': [{**before, field: 'z'}]})
        assert diff['edges'] == {'added': [], 'removed': [], 'changed': [{'id': 'x', 'fields': [field]}]}

    def test_removed_items_are_sorted_and_malformed_ones_ignored(self):
        before = {'nodes': [{'id': 'b'}, {'id': 'a'}, 'x', {'id': 3}], 'edges': 'x'}
        diff = ws.diff_definitions(before, {'nodes': [], 'edges': [{'id': 'e'}]})
        assert diff['nodes'] == {'added': [], 'removed': ['a', 'b'], 'changed': []}
        assert diff['edges'] == {'added': ['e'], 'removed': [], 'changed': []}

    def test_loop_order_and_member_order_do_not_matter(self):
        before = {'loops': [{'node_ids': ['b', 'a', 3], 'until': 'u', 'max_rounds': 2}, {'node_ids': 'x'}]}
        after = {'loops': [{'node_ids': [], 'until': None, 'max_rounds': None},
                           {'node_ids': ['a', 'b'], 'until': 'u', 'max_rounds': 2}]}
        assert ws.diff_definitions(before, after)['loops_changed'] is False

    def test_a_malformed_loop_differs_from_an_empty_one(self):
        assert ws.diff_definitions({'loops': ['x']}, {'loops': [{}]})['loops_changed'] is True

    @pytest.mark.parametrize('field', ['until', 'max_rounds'])
    def test_each_loop_setting_counts(self, field):
        before = {'node_ids': ['a'], 'until': 'review_pass', 'max_rounds': 2}
        assert ws.diff_definitions({'loops': [before]}, {'loops': [{**before, field: 'z'}]})['loops_changed'] is True

    @pytest.mark.parametrize('after', [
        {'description': 'new'}, {'loops': [{}]}, {'nodes': [{'id': 'a'}]}, {'edges': [{'id': 'e'}]},
    ])
    def test_any_one_change_is_not_unchanged(self, after):
        assert ws.diff_definitions({}, after)['unchanged'] is False

    def test_the_whole_diff_of_a_meta_change(self):
        assert ws.diff_definitions({'name': 'a'}, {'name': 'a', 'description': 'd'}) == {
            'nodes': {'added': [], 'removed': [], 'changed': []},
            'edges': {'added': [], 'removed': [], 'changed': []},
            'loops_changed': False, 'meta_changed': ['description'], 'unchanged': False}

    def test_none_before_against_nothing_is_unchanged(self):
        assert ws.diff_definitions(None, {})['unchanged'] is True


# sha256 of encode_definition(default_template()). The template seeds `wf_default` in every deployment and is
# what an agent runs without a workflow of its own: change it deliberately, then update this digest.
TEMPLATE_DIGEST = '9852213006ce5901a66f8496ade60de6a3319495922650374d6c7302c0068115'


class TestTemplate:
    def test_the_stored_form_is_pinned(self):
        encoded = ws.encode_definition(ws.default_template()).encode('utf-8')
        assert hashlib.sha256(encoded).hexdigest() == TEMPLATE_DIGEST

    def test_positions_are_a_280_by_140_grid(self):
        nodes = {node['id']: node['position'] for node in ws.default_template()['nodes']}
        assert nodes['start'] == {'x': 280.0, 'y': 0.0}
        assert nodes['research'] == {'x': 560.0, 'y': 420.0}
        assert nodes['personas_fixed'] == {'x': 0.0, 'y': 420.0}

    def test_role_and_instructions_appear_only_when_set(self):
        nodes = {node['id']: node['data'] for node in ws.default_template()['nodes']}
        assert nodes['start'] == {'title': 'Start', 'params': {}}
        assert nodes['end'] == {'title': 'Done', 'params': {'status': 'completed'}}
        assert nodes['research'] == {'title': 'Deep research (with web)', 'params': {'use_web_search': True},
                                     'role': 'worker'}

    def test_edge_ids_and_labels(self):
        edges = ws.default_template()['edges']
        assert edges[0] == {'id': 'e_start__aggregate', 'source': 'start', 'target': 'aggregate'}
        assert edges[9] == {'id': 'e_prfaq_review__prfaq_revise', 'source': 'prfaq_review',
                            'target': 'prfaq_revise', 'label': 'not_agreed'}
