"""Recall in a form's texts (shared/forms_recall.py; docs/feedback-forms.md "Recall"): the grammar the builder and the
widget share (schemas/form-recall-cases.json), the save's 400s, and the publish guard's list of texts that would show
a placeholder as written.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from shared import forms_recall as recall
from shared import forms_v2 as fv2
from shared.exceptions import ConflictError, ValidationError

CASES = json.loads((Path(__file__).resolve().parents[3] / 'schemas' / 'form-recall-cases.json').read_text('utf-8'))


def _q(qid: str, kind: str, headline: str, **extra: Any) -> dict[str, Any]:
    return {'id': qid, 'type': kind, 'headline': {'en': headline}, 'required': False, **extra}


def _form(*questions: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {'language': 'en', 'languages': ['en', 'pl'], 'welcome': {'enabled': False},
            'questions': list(questions) or [_q('q_a', 'nps', 'How likely?')],
            'hidden_fields': [{'id': 'event'}], 'endings': [{'id': 'end_a', 'title': {'en': 'Thanks'}}], **extra}


PICK = _q('q_pick', 'single_select', 'Pick', options=[{'code': 'a', 'label': {'en': 'A'}}])


@pytest.mark.parametrize('case', CASES['parse'], ids=[case['text'] for case in CASES['parse']])
def test_the_grammar_is_the_builders_and_the_widgets(case):
    found = [{'raw': p.raw, 'id': p.id, 'fallback': p.fallback} for p in recall.placeholders(case['text'])]
    assert found == case['placeholders']


def test_no_text_has_no_placeholder():
    assert (recall.placeholders(None), recall.placeholders({'en': '{{x}}'})) == ([], [])


def test_a_reader_of_results_sees_each_placeholder_as_its_id():
    assert recall.shown_as_ids('How was {{ event | the event }} after {{q_nps}}?') == 'How was [event] after [q_nps]?'


def test_the_recallable_types_are_question_types_of_the_schema():
    assert set(fv2.QUESTION_TYPES) > recall.RECALL_TYPES
    assert fv2.MATRIX not in recall.RECALL_TYPES
    assert fv2.OPEN_TEXT not in recall.RECALL_TYPES


def test_the_module_imports_only_the_exceptions_of_shared():
    source = Path(recall.__file__).read_text(encoding='utf-8')
    assert [line for line in source.splitlines() if line.startswith('from shared')] == [
        'from shared.exceptions import ValidationError']


class TestTheSavesChecks:
    def test_a_hidden_field_and_an_earlier_score_or_single_choice_are_recalled(self):
        definition = _form(_q('q_a', 'nps', 'How likely at {{event}}?'), PICK,
                           _q('q_b', 'open_text', 'Why {{q_a|that score}} and {{ q_pick }}?'),
                           welcome={'enabled': True, 'title': {'en': 'Hi {{event}}'}},
                           endings=[{'id': 'end_a', 'title': {'en': 'Thanks for {{q_a}}'},
                                     'description': {'en': '{{q_pick}}'}}])
        recall.check_recall(definition)
        assert recall.unresolved_placeholders(definition) == []

    @pytest.mark.parametrize(('definition', 'code', 'where'), [
        (_form(_q('q_a', 'nps', 'How was {{nobody}}?')), 'recall_unknown', 'questions[0].headline.en'),
        (_form(_q('q_a', 'nps', 'How was {{constructor}}?')), 'recall_unknown', 'questions[0].headline.en'),
        (_form(_q('q_a', 'nps', 'How was {{}}?')), 'recall_unknown', 'questions[0].headline.en'),
        (_form(_q('q_a', 'nps', 'Again {{q_a}}?')), 'recall_not_before', 'questions[0].headline.en'),
        (_form(_q('q_a', 'nps', 'A', subheader={'en': 'x', 'pl': 'Po {{q_b}}'}), _q('q_b', 'nps', 'B')),
         'recall_not_before', 'questions[0].subheader.pl'),
        (_form(_q('q_a', 'nps', 'A'), welcome={'enabled': True, 'title': {'en': 'Hi {{q_a}}'}}), 'recall_not_before',
         'welcome.title.en'),
        (_form(_q('q_t', 'open_text', 'A'), _q('q_b', 'nps', 'You said {{q_t}}')), 'recall_type',
         'questions[1].headline.en'),
        (_form(_q('q_m', 'multi_select', 'A'), endings=[{'id': 'end_a', 'title': {'en': '{{q_m}}'}}]), 'recall_type',
         'endings[0].title.en'),
    ], ids=['unknown', 'reserved', 'empty', 'itself', 'later', 'welcome', 'open-text', 'multi'])
    def test_a_placeholder_recall_cannot_fill_is_a_400_naming_it(self, definition, code, where):
        with pytest.raises(ValidationError) as refused:
            recall.check_recall(definition)
        assert (refused.value.code, refused.value.details['where']) == (code, where)
        assert str(refused.value.details['placeholder']) in refused.value.message

    def test_a_hidden_field_is_looked_up_before_a_question_of_the_same_id(self):
        definition = _form(_q('q_a', 'nps', 'A {{q_a}}'), hidden_fields=[{'id': 'q_a'}])
        recall.check_recall(definition)
        assert recall.unresolved_placeholders(definition) == []

    def test_every_save_checks_it(self):
        with pytest.raises(ValidationError) as refused:
            fv2.validate_definition(_form(_q('q_a', 'nps', 'How was {{nobody}}?')))
        assert refused.value.code == 'recall_unknown'


class TestThePublishGuard:
    def test_it_lists_a_recall_text_it_cannot_fill_and_any_placeholder_where_recall_never_works(self):
        definition = _form(
            _q('q_a', 'nps', 'Fine {{event}} {{later}}', lower_label={'en': 'Low {{event}}'}),
            {**PICK, 'options': [{'code': 'a', 'label': {'en': 'A {{event}}'}}], 'other': {'enabled': True,
                                                                                         'label': {'en': '{{o}}'}}},
            _q('q_m', 'matrix', 'M', rows=[{'code': 'r', 'label': {'en': 'R {{x}}'}}],
               columns=[{'code': 'c', 'label': {'en': 'C {{y}}'}}]),
            _q('q_s', 'statement', 'S', cta={'label': {'en': 'Go {{event}}'}, 'url': 'https://x.example/{{event}}'}),
            welcome={'enabled': True, 'title': {'en': 'Hi'}, 'button_label': {'en': 'Start {{event}}'}},
            endings=[{'id': 'end_a', 'title': {'en': 'Bye'},
                      'button': {'label': {'en': '{{b}}'}, 'url': 'https://x.example'}}])
        assert [entry['where'] for entry in recall.unresolved_placeholders(definition)] == [
            'questions[0].headline.en', 'welcome.button_label.en', 'questions[0].lower_label.en',
            'questions[1].other.label.en', 'questions[1].options[0].label.en', 'questions[2].rows[0].label.en',
            'questions[2].columns[0].label.en', 'questions[3].cta.label.en', 'questions[3].cta.url',
            'endings[0].button.label.en']
        assert recall.unresolved_placeholders(definition)[0]['placeholder'] == '{{later}}'

    def test_it_names_at_most_twenty_texts(self):
        options = [{'code': f'o{n}', 'label': {'en': f'{{{{x{n}}}}}'}} for n in range(30)]
        assert len(recall.unresolved_placeholders(_form({**PICK, 'options': options}))) == recall.MAX_UNRESOLVED

    def test_a_live_write_is_a_409_and_an_off_one_is_not(self):
        definition = _form({**PICK, 'options': [{'code': 'a', 'label': {'en': 'A {{event}}'}}]})
        fv2.validate_placeholders(definition, live=False)
        with pytest.raises(ConflictError) as refused:
            fv2.validate_placeholders(definition, live=True)
        assert (refused.value.status_code, refused.value.code) == (409, 'unresolved_placeholder')
        assert refused.value.details == {'texts': [{'where': 'questions[0].options[0].label.en',
                                                    'placeholder': '{{event}}'}]}
