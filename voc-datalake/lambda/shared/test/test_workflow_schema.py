"""Tests for shared/workflow_schema.py: the voc-workflow/1 rules, template and diff."""
import copy

import pytest

from shared import workflow_schema as ws


def _minimal(**overrides):
    definition = {
        'schema': ws.SCHEMA, 'name': 'Tiny', 'description': '',
        'nodes': [
            {'id': 'start', 'type': 'start', 'position': {'x': 0, 'y': 0}, 'data': {'title': 'Start'}},
            {'id': 'prfaq', 'type': 'write_prfaq', 'position': {'x': 0, 'y': 100}, 'data': {'title': 'Write'}},
            {'id': 'end', 'type': 'end', 'position': {'x': 0, 'y': 200}, 'data': {'title': 'End'}},
        ],
        'edges': [
            {'id': 'e1', 'source': 'start', 'target': 'prfaq'},
            {'id': 'e2', 'source': 'prfaq', 'target': 'end'},
        ],
        'loops': [],
    }
    definition.update(overrides)
    return definition


def _messages(result):
    return [issue.message for issue in result.errors]


class TestTemplate:
    def test_the_builtin_template_is_valid(self):
        result = ws.validate_definition(ws.default_template())
        assert result.valid, result.to_dict()

    def test_the_template_follows_the_reviews_to_prototype_flow(self):
        types = [node['type'] for node in ws.default_template()['nodes']]
        for step in ('aggregate_reviews', 'select_or_create_project', 'generate_personas', 'deep_research',
                     'write_prfaq', 'persona_review', 'build_prototype', 'revise_prototype', 'final_review',
                     'handoff'):
            assert step in types
        loops = ws.default_template()['loops']
        assert [loop['max_rounds'] for loop in loops] == [3, 2]
        assert all(loop['until'] == 'persona_agreement' for loop in loops)

    def test_each_call_returns_an_independent_copy(self):
        first = ws.default_template()
        first['nodes'][0]['data']['title'] = 'changed'
        assert ws.default_template()['nodes'][0]['data']['title'] == 'Start'

    def test_validation_round_trips_the_template_unchanged(self):
        template = ws.default_template()
        assert ws.validate_definition(template).definition == template


class TestShape:
    @pytest.mark.parametrize('raw', [None, [], 'x', 3])
    def test_a_non_object_is_refused(self, raw):
        assert not ws.validate_definition(raw).valid

    def test_unknown_node_type_is_pinned_to_the_node(self):
        definition = _minimal()
        definition['nodes'][1]['type'] = 'launch_rockets'
        result = ws.validate_definition(definition)
        assert result.errors[0].to_dict() == {'message': 'unknown node type', 'node_id': 'prfaq'}

    def test_persona_review_needs_a_target(self):
        definition = _minimal()
        definition['nodes'][1] = {'id': 'prfaq', 'type': 'persona_review', 'position': {'x': 0, 'y': 0},
                                  'data': {'title': 'Review', 'params': {}}}
        assert any('params.target' in m for m in _messages(ws.validate_definition(definition)))



    def test_unknown_top_level_keys_are_dropped(self):
        result = ws.validate_definition({**_minimal(), 'exported_from': {'workflow_id': 'wf_x'}})
        assert result.valid
        assert result.definition is not None
        assert 'exported_from' not in result.definition

    def test_params_must_be_plain_json(self):
        definition = _minimal()
        definition['nodes'][1]['data']['params'] = {'x': float('inf')}
        assert any('plain JSON' in m for m in _messages(ws.validate_definition(definition)))


class TestGraph:

    def test_orphan_node(self):
        definition = _minimal()
        definition['nodes'].append({'id': 'lost', 'type': 'write_prd', 'position': {'x': 1, 'y': 1},
                                    'data': {'title': 'Lost'}})
        result = ws.validate_definition(definition)
        assert ws.Issue('this step is not connected to the start', 'lost') in result.errors

    def test_dead_end(self):
        definition = _minimal()
        definition['nodes'].append({'id': 'stuck', 'type': 'write_prd', 'position': {'x': 1, 'y': 1},
                                    'data': {'title': 'Stuck'}})
        definition['edges'].append({'id': 'e3', 'source': 'start', 'target': 'stuck'})
        assert ws.Issue('this step has no path to an end step', 'stuck') in ws.validate_definition(definition).errors

    def test_cycle_outside_a_loop(self):
        definition = _minimal()
        definition['edges'].append({'id': 'back', 'source': 'prfaq', 'target': 'prfaq'})
        assert ws.Issue('this step is in a cycle that is not inside one declared loop', 'prfaq') in \
            ws.validate_definition(definition).errors

    def test_agreed_label_only_from_a_persona_review(self):
        definition = _minimal()
        definition['edges'][1]['label'] = 'agreed'
        assert any("'agreed' arrows" in m for m in _messages(ws.validate_definition(definition)))

    def test_end_cannot_have_outgoing_arrows(self):
        definition = _minimal()
        definition['edges'].append({'id': 'e3', 'source': 'end', 'target': 'prfaq'})
        assert ws.Issue('an end step cannot have outgoing arrows', 'end') in ws.validate_definition(definition).errors


class TestLoops:

    def test_a_loop_without_a_back_edge(self):
        definition = _minimal(loops=[{'node_ids': ['prfaq'], 'until': 'review_pass', 'max_rounds': 2}])
        definition['nodes'][1]['type'] = 'final_review'
        assert 'loop 1 has no arrow back to an earlier step in the loop' in _messages(ws.validate_definition(definition))

    def test_persona_agreement_loop_needs_a_persona_review(self):
        definition = ws.default_template()
        definition['loops'][0]['until'] = 'persona_agreement'
        definition['nodes'] = [n if n['id'] != 'prfaq_review' else {**n, 'type': 'final_review',
                                                                    'data': {'title': 'r', 'params': {}}}
                               for n in definition['nodes']]
        assert not ws.validate_definition(definition).valid

    def test_a_cycle_spanning_two_loops_is_refused(self):
        definition = ws.default_template()
        definition['loops'][0]['node_ids'] = ['prfaq_review']
        result = ws.validate_definition(definition)
        assert any(issue.node_id == 'prfaq_revise' for issue in result.errors)

    def test_a_step_in_two_loops(self):
        definition = ws.default_template()
        definition['loops'][1]['node_ids'].append('prfaq_revise')
        assert any('only one loop' in m for m in _messages(ws.validate_definition(definition)))


class TestDiff:
    def test_identical_definitions_are_unchanged(self):
        assert ws.diff_definitions(ws.default_template(), ws.default_template())['unchanged'] is True

    def test_a_new_workflow_adds_everything(self):
        diff = ws.diff_definitions(None, _minimal())
        assert diff['nodes']['added'] == ['end', 'prfaq', 'start']
        assert diff['edges']['added'] == ['e1', 'e2']
        assert diff['meta_changed'] == ['name', 'description']

    def test_added_removed_and_changed(self):
        before = _minimal()
        after = copy.deepcopy(before)
        after['nodes'][1]['data']['title'] = 'Write the PR/FAQ'
        after['nodes'][1]['position'] = {'x': 5, 'y': 100}
        after['nodes'].append({'id': 'prd', 'type': 'write_prd', 'position': {'x': 0, 'y': 0},
                               'data': {'title': 'PRD'}})
        after['edges'] = [after['edges'][0], {'id': 'e2', 'source': 'prfaq', 'target': 'prd'},
                          {'id': 'e3', 'source': 'prd', 'target': 'end'}]
        diff = ws.diff_definitions(before, after)
        assert diff['nodes'] == {'added': ['prd'], 'removed': [],
                                 'changed': [{'id': 'prfaq', 'fields': ['position', 'title']}]}
        assert diff['edges'] == {'added': ['e3'], 'removed': [], 'changed': [{'id': 'e2', 'fields': ['target']}]}
        assert diff['loops_changed'] is False
        assert diff['unchanged'] is False

    def test_loop_changes_are_reported(self):
        after = ws.default_template()
        after['loops'][0]['max_rounds'] = 4
        assert ws.diff_definitions(ws.default_template(), after)['loops_changed'] is True


class TestLibraryHelpers:
    def test_export_then_import_keeps_lineage(self):
        exported = ws.export_document(_minimal(), workflow_id='wf_0123456789ab', revision=3, slug='tiny')
        assert ws.imported_lineage(exported) == 'wf_0123456789ab'
        assert ws.validate_definition(exported).valid

    @pytest.mark.parametrize('raw', [None, {}, {'exported_from': {'workflow_id': 'bad id!'}}])
    def test_no_lineage(self, raw):
        assert ws.imported_lineage(raw) is None

    def test_encode_decode(self):
        assert ws.decode_definition(ws.encode_definition(_minimal())) == _minimal()
        assert ws.decode_definition('not json') is None
        assert ws.decode_definition(None) is None


def _with_custom_step(edges):
    """start → custom → end (+ a second end), with the custom step's arrows as given."""
    definition = _minimal()
    definition['nodes'][1] = {'id': 'prfaq', 'type': 'custom_llm', 'position': {'x': 0, 'y': 100},
                              'data': {'title': 'Think', 'instructions': 'Summarise.'}}
    definition['nodes'].append({'id': 'human', 'type': 'end', 'position': {'x': 100, 'y': 200},
                                'data': {'title': 'Human', 'params': {'status': 'needs_human'}}})
    definition['edges'] = [{'id': 'e1', 'source': 'start', 'target': 'prfaq'}, *edges]
    return definition


def _with_two_plain_custom_arrows():
    """The custom step with a plain arrow to each end."""
    return _with_custom_step([
        {'id': 'e2', 'source': 'prfaq', 'target': 'end'},
        {'id': 'e3', 'source': 'prfaq', 'target': 'human'},
    ])


class TestCustomStepArrows:
    """3.00.00: a custom step reports no verdict, so it has no pass/fail arrows."""

    @pytest.mark.parametrize('label', ['pass', 'fail'])
    def test_a_labelled_arrow_out_of_a_custom_step_is_refused_on_save(self, label):
        result = ws.validate_definition(_with_custom_step([
            {'id': 'e2', 'source': 'prfaq', 'target': 'end', 'label': label},
            {'id': 'e3', 'source': 'prfaq', 'target': 'human'},
        ]))
        assert not result.valid
        assert result.errors[0].to_dict() == {
            'message': f"a custom step reports no pass/fail verdict, so its arrows cannot be '{label}'"
                       ' — use a plain arrow',
            'node_id': 'prfaq',
        }

    def test_a_plain_arrow_out_of_a_custom_step_is_fine(self):
        assert ws.validate_definition(_with_two_plain_custom_arrows()).valid

    def test_a_review_pass_loop_needs_a_real_reviewer_not_a_custom_step(self):
        definition = _with_two_plain_custom_arrows()
        definition['nodes'].append({'id': 'again', 'type': 'revise_document', 'position': {'x': 0, 'y': 50},
                                    'data': {'title': 'Again'}})
        definition['edges'] += [{'id': 'e4', 'source': 'prfaq', 'target': 'again'},
                                {'id': 'e5', 'source': 'again', 'target': 'prfaq'}]
        definition['loops'] = [{'node_ids': ['prfaq', 'again'], 'until': 'review_pass', 'max_rounds': 2}]
        assert ('loop 1 repeats until a review passes but contains no reviewing step'
                in _messages(ws.validate_definition(definition)))

    def test_a_final_review_still_takes_pass_and_fail(self):
        definition = _with_two_plain_custom_arrows()
        definition['nodes'][1]['type'] = 'final_review'
        definition['edges'][1]['label'] = 'pass'
        definition['edges'][2]['label'] = 'fail'
        assert ws.validate_definition(definition).valid


class TestCustomStepArrowsNormaliseOnRead:
    """Stored pre-3.00.00 definitions are read as the runtime ran them, and then save cleanly."""

    def _read(self, edges):
        stored = ws.encode_definition(_with_custom_step(edges))
        decoded = ws.decode_definition(stored)
        assert decoded is not None
        return decoded

    def _custom_arrows(self, definition):
        return [edge for edge in definition['edges'] if edge['source'] == 'prfaq']

    def test_pass_becomes_plain_and_fail_is_dropped(self):
        decoded = self._read([
            {'id': 'e2', 'source': 'prfaq', 'target': 'end', 'label': 'pass'},
            {'id': 'e3', 'source': 'prfaq', 'target': 'human', 'label': 'fail'},
        ])
        assert self._custom_arrows(decoded) == [{'id': 'e2', 'source': 'prfaq', 'target': 'end'}]

    def test_pass_beside_an_unlabelled_arrow_is_dropped(self):
        decoded = self._read([
            {'id': 'e2', 'source': 'prfaq', 'target': 'human'},
            {'id': 'e3', 'source': 'prfaq', 'target': 'end', 'label': 'pass'},
            {'id': 'e4', 'source': 'prfaq', 'target': 'end'},
        ])
        assert [e['id'] for e in self._custom_arrows(decoded)] == ['e2', 'e4']

    def test_a_relabel_never_creates_a_duplicate_arrow(self):
        decoded = self._read([
            {'id': 'e2', 'source': 'prfaq', 'target': 'end', 'label': 'pass'},
            {'id': 'e3', 'source': 'prfaq', 'target': 'end', 'label': 'pass'},
            {'id': 'e4', 'source': 'prfaq', 'target': 'human', 'label': 'pass'},
        ])
        assert [e['id'] for e in self._custom_arrows(decoded)] == ['e2', 'e4']
        assert all('label' not in e for e in self._custom_arrows(decoded))

    def test_the_normalised_definition_saves(self):
        decoded = self._read([
            {'id': 'e2', 'source': 'prfaq', 'target': 'end', 'label': 'pass'},
            {'id': 'e3', 'source': 'prfaq', 'target': 'human', 'label': 'pass'},
        ])
        assert ws.validate_definition(decoded).valid

    def test_other_steps_and_clean_definitions_are_untouched(self):
        template = ws.default_template()
        assert ws.decode_definition(ws.encode_definition(template)) == template
        plain = _with_custom_step([{'id': 'e2', 'source': 'prfaq', 'target': 'end'}])
        assert ws.normalise_custom_step_arrows(plain) is plain

    def test_the_input_is_never_mutated(self):
        definition = _with_custom_step([{'id': 'e2', 'source': 'prfaq', 'target': 'end', 'label': 'pass'}])
        before = copy.deepcopy(definition)
        ws.normalise_custom_step_arrows(definition)
        assert definition == before

    @pytest.mark.parametrize('edges', [None, 'x', [None, 3]])
    def test_malformed_edges_are_left_for_the_validator(self, edges):
        definition = {**_with_custom_step([]), 'edges': edges}
        assert ws.normalise_custom_step_arrows(definition)['edges'] == edges
