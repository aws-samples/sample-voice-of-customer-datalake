"""In-app micro-feedback's settings and tag (shared/app_feedback.py, shared/app_feedback_tag.py, 7.66.00): the PUT's
checks, the merge, a form's fitness and the view a member reads."""
from __future__ import annotations

import re
from decimal import Decimal
from pathlib import Path

import pytest

from shared import app_feedback as af
from shared.app_feedback_tag import APP_FEEDBACK_TAG, asks_for_app_feedback, is_app_feedback
from shared.exceptions import ValidationError

FIT = {'form_id': 'ff_1', 'name': 'App feedback', 'schema_version': Decimal(2), 'enabled': True, 'language': 'en',
       'languages': ['en', 'de'], 'tags': ['voc_app'],
       'questions': [{'id': 'q_verdict', 'type': 'single_select', 'options': [{'code': 'up'}, {'code': 'down'}]},
                     {'id': 'q_missing', 'type': 'open_text'}],
       'hidden_fields': [{'id': name} for name in ('action', 'page', 'app_version', 'workspace_role')]}


class TestTag:
    @pytest.mark.parametrize('tags', [['voc_app'], ['VOC_APP'], [' voc_app ', 'other'], ['x', 'Voc_App']])
    def test_an_item_tagged_voc_app_is_app_feedback(self, tags):
        assert is_app_feedback({'tags': tags}) is True

    @pytest.mark.parametrize('item', [{}, {'tags': None}, {'tags': 'voc_app'}, {'tags': ['voc', 'app']},
                                      {'tags': [7, None]}, {'tags': ['voc_apps']}])
    def test_anything_else_is_not(self, item):
        assert is_app_feedback(item) is False

    @pytest.mark.parametrize(('value', 'asks'), [('voc_app', True), (' VOC_APP ', True), ('voc', False),
                                                 (None, False), (7, False)])
    def test_only_a_filter_on_the_tag_asks_for_it(self, value, asks):
        assert asks_for_app_feedback(value) is asks

    def test_the_tag(self):
        assert APP_FEEDBACK_TAG == 'voc_app'


class TestChanges:
    def test_each_field_and_the_actions_in_their_order(self):
        assert af.validate_changes({'enabled': True, 'form_id': 'ff_1', 'actions': ['prd', 'personas']}) == {
            'enabled': True, 'form_id': 'ff_1', 'actions': ['personas', 'prd']}
        assert af.validate_changes({'form_id': None}) == {'form_id': None}

    @pytest.mark.parametrize(('body', 'message'), [
        ({}, 'Give at least one of: enabled, form_id, actions'),
        ({'enabled': 'yes'}, 'enabled must be true or false'),
        ({'form_id': '../x'}, 'form_id must be a feedback form id, or null'),
        ({'form_id': 'x' * 65}, 'form_id must be a feedback form id, or null'),
        ({'form_id': 3}, 'form_id must be a feedback form id, or null'),
        ({'actions': []}, 'actions must list at least one of'),
        ({'actions': ['personas', 'personas']}, 'actions must list at least one of'),
        ({'actions': ['telemetry']}, 'actions must list at least one of'),
        ({'actions': 'prd'}, 'actions must list at least one of'),
        ({'enabled': True, 'owner': 'x'}, 'Unknown field(s): owner'),
    ])
    def test_refusals(self, body, message):
        with pytest.raises(ValidationError, match=message.replace('(', r'\(').replace(')', r'\)')):
            af.validate_changes(body)

    def test_the_merge_keeps_what_the_put_does_not_name(self):
        stored = {'enabled': True, 'form_id': 'ff_1', 'actions': ['prd']}
        assert af.merged_config(stored, {'actions': ['import']}) == {
            'enabled': True, 'form_id': 'ff_1', 'actions': ['import']}
        assert af.merged_config({}, {'form_id': 'ff_2'}) == {
            'enabled': False, 'form_id': 'ff_2', 'actions': list(af.ACTIONS)}

    def test_on_needs_a_form(self):
        with pytest.raises(ValidationError) as caught:
            af.merged_config({}, {'enabled': True})
        assert caught.value.code == 'app_feedback_form_required'
        with pytest.raises(ValidationError):
            af.merged_config({'enabled': True, 'form_id': 'ff_1'}, {'form_id': None})
        assert af.merged_config({'enabled': True, 'form_id': 'ff_1'}, {'enabled': False, 'form_id': None})['enabled'] is False


class TestFitness:
    def test_a_form_from_the_template_is_fit(self):
        assert af.form_problems(FIT) == []

    @pytest.mark.parametrize(('change', 'problem'), [
        ({'tags': []}, 'not_tagged'),
        ({'tags': None}, 'not_tagged'),
        ({'questions': [FIT['questions'][1]]}, 'no_verdict'),
        ({'questions': [{**FIT['questions'][0], 'type': 'multi_select'}, FIT['questions'][1]]}, 'no_verdict'),
        ({'questions': [{**FIT['questions'][0], 'options': [{'code': 'up'}]}, FIT['questions'][1]]}, 'no_verdict'),
        ({'questions': [FIT['questions'][0]]}, 'no_missing'),
        ({'questions': [FIT['questions'][0], {'id': 'q_missing', 'type': 'rating'}]}, 'no_missing'),
        ({'hidden_fields': [{'id': 'action'}, {'id': 'page'}, {'id': 'app_version'}]}, 'hidden_fields'),
        ({'enabled': False}, 'form_off'),
    ])
    def test_each_problem(self, change, problem):
        assert af.form_problems({**FIT, **change}) == [problem]

    def test_a_version_1_form_has_every_problem_but_the_tag(self):
        assert af.form_problems({'name': 'Old', 'enabled': True, 'tags': ['voc_app']}) == [
            'no_verdict', 'no_missing', 'hidden_fields']

    def test_only_off_does_not_refuse_a_save(self):
        assert 'form_off' not in af.BLOCKING
        assert {'not_tagged', 'no_verdict', 'no_missing', 'hidden_fields'} == af.BLOCKING


class TestView:
    def test_no_row_is_off(self):
        assert af.config_view({}, None) == {
            'enabled': False, 'form_id': None, 'actions': list(af.ACTIONS), 'updated_at': None, 'tag': 'voc_app',
            'form': None, 'active': False}

    def test_on_with_a_fit_form_is_active_and_never_names_who_saved(self):
        row = {'enabled': True, 'form_id': 'ff_1', 'actions': ['prd', 'nope'], 'updated_at': 'then',
               'updated_by': {'sub': 'admin-sub', 'kind': 'admin'}}
        view = af.config_view(row, FIT)
        assert view == {'enabled': True, 'form_id': 'ff_1', 'actions': ['prd'], 'updated_at': 'then',
                        'tag': 'voc_app', 'active': True,
                        'form': {'form_id': 'ff_1', 'found': True, 'name': 'App feedback', 'enabled': True,
                                 'languages': ['en', 'de'], 'problems': []}}
        assert 'admin-sub' not in str(view)

    @pytest.mark.parametrize(('row', 'form'), [
        ({'enabled': False, 'form_id': 'ff_1'}, FIT),
        ({'enabled': True, 'form_id': 'ff_1'}, {**FIT, 'enabled': False}),
        ({'enabled': True, 'form_id': 'ff_1'}, {**FIT, 'tags': []}),
    ])
    def test_off_or_an_unfit_form_is_not_active(self, row, form):
        assert af.config_view(row, form)['active'] is False

    def test_a_deleted_form_is_named_not_found(self):
        view = af.config_view({'enabled': True, 'form_id': 'ff_1'}, None)
        assert view['form'] == {'form_id': 'ff_1', 'found': False, 'name': None, 'enabled': False, 'languages': [],
                                'problems': []}
        assert view['active'] is False

    @pytest.mark.parametrize('stored', [None, [], ['telemetry'], 'prd'])
    def test_unreadable_actions_read_as_all(self, stored):
        assert af.config_view({'actions': stored}, None)['actions'] == list(af.ACTIONS)

    def test_a_drifted_form_id_reads_as_none(self):
        assert af.config_view({'form_id': '../x', 'enabled': True}, None)['form'] is None


class TestTheSpaSendsWhatTheServerChecks:
    """The template the SPA makes and the control's actions are the server's (no shared file: pinned by reading them)."""

    FRONTEND = Path(__file__).resolve().parents[3] / 'frontend' / 'src'

    def test_the_template_holds_every_id_a_fit_form_needs(self):
        source = (self.FRONTEND / 'pages/FeedbackForms/templates/appTemplates.ts').read_text(encoding='utf-8')
        assert f"single('{af.VERDICT_QUESTION}', {list(af.VERDICT_CODES)!r}" in source
        assert f"openText('{af.MISSING_QUESTION}'" in source
        for field in af.HIDDEN_FIELDS:
            assert f"{{ id: '{field}'" in source
        assert f"tags: ['{APP_FEEDBACK_TAG}']" in source

    def test_the_control_names_the_same_actions(self):
        source = (self.FRONTEND / 'api/appFeedbackApi.ts').read_text(encoding='utf-8')
        listed = re.search(r'APP_FEEDBACK_ACTIONS = \[(.*?)\] as const', source, re.DOTALL)
        assert listed is not None
        assert tuple(re.findall(r"'([a-z_]+)'", listed.group(1))) == af.ACTIONS
