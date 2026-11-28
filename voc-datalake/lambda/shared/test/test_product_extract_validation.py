"""The product extract's answer is untrusted too (7.104.00, shared/product_extract.py ``validated``): every value is
checked against the sources as sent and the form as it was before it becomes a proposal."""
from __future__ import annotations

from typing import Any

import pytest

from shared.product_extract import (
    MAX_CITATIONS,
    MAX_QUESTIONS,
    NO_VERIFIED_SOURCE,
    Source,
    system_prompt,
    validated,
)
from shared.product_proposals import FIELD_ORDER, ContextState

DECK = Source('S1', 'doc_deck', 'deck.pdf', 'file', 'PDF',
              text='[page 1]\nOrbit plans   team trips\nfor remote companies.\n[page 2]\nPricing: 9 dollars a seat.',
              pages=2)
SHOT = Source('S2', 'doc_shot', 'home.png', 'file', 'Image', image=b'png', image_format='png')


def _state(values: dict[str, str] | None = None, meta: dict[str, dict[str, Any]] | None = None) -> ContextState:
    current = dict.fromkeys(FIELD_ORDER, '') | (values or {})
    return ContextState(values=current, stored={}, meta=meta or {}, exists=bool(values), has_meta=bool(meta),
                        updated_at=None)


def _field(value: str = 'Orbit plans team trips', *, status: str = 'proposed', confidence: str = 'high',
           citations: list[dict[str, Any]] | None = None, note: str = '') -> dict[str, Any]:
    cited = [{'source_id': 'S1', 'quote': 'orbit PLANS team\ntrips', 'page': 1}] if citations is None else citations
    return {'status': status, 'value': value, 'citations': cited, 'confidence': confidence, 'note': note}


def _entries(fields: dict[str, Any]) -> list[Any]:
    """The answer's ``fields`` array (7.109.01) of ``{name: entry}``: each entry naming its field, anything that is
    not an entry as it is."""
    return [{'field': name, **entry} if isinstance(entry, dict) else entry for name, entry in fields.items()]


def _one(name: str, entry: Any, state: ContextState | None = None, sources=(DECK, SHOT)) -> dict[str, Any]:
    fields, _questions = validated({'fields': _entries({name: entry})}, sources, state or _state())
    return fields[name]


class TestCitations:
    def test_a_quote_found_in_its_source_whatever_its_case_and_spacing_is_verified(self):
        assert _one('one_liner', _field())['citations'] == [
            {'source_id': 'S1', 'quote': 'orbit PLANS team\ntrips', 'page': 1, 'verified': True}]

    def test_a_quote_that_is_not_in_its_source_is_marked_unverified_and_the_value_low(self):
        entry = _one('one_liner', _field(citations=[{'source_id': 'S1', 'quote': 'Orbit books flights', 'page': 1}],
                                         note='From the deck'))
        assert entry['citations'] == [{'source_id': 'S1', 'quote': 'Orbit books flights', 'page': 1,
                                       'verified': False}]
        assert (entry['confidence'], entry['note']) == ('low', f'{NO_VERIFIED_SOURCE}. From the deck')

    @pytest.mark.parametrize(('quote', 'verified'), [
        ('Orbit', False), ('team trips', False), ('Pricing: 9 dollars', False), ('9 dollars a seat', True),
        ('Orbit plans   team trips', True),
    ], ids=['one-word', 'two-words', 'three-words', 'four-words', 'four-words-spaced'])
    def test_a_quote_is_verified_only_when_it_is_at_least_four_words_or_twenty_characters(self, quote, verified):
        # Review S4 (7.104.00 round 1): a word or two is found in almost any source, so it verified nothing.
        entry = _one('one_liner', _field(citations=[{'source_id': 'S1', 'quote': quote, 'page': None}]))
        assert entry['citations'][0]['verified'] is verified
        assert entry['confidence'] == ('high' if verified else 'low')

    def test_a_citation_to_a_source_not_sent_is_dropped(self):
        entry = _one('one_liner', _field(citations=[{'source_id': 'S7', 'quote': 'Orbit plans', 'page': None}]))
        assert (entry['citations'], entry['confidence']) == ([], 'low')

    def test_an_images_quote_is_never_verified(self):
        entry = _one('product_name', _field('Orbit', citations=[{'source_id': 'S2', 'quote': 'Orbit', 'page': None}]))
        assert entry['citations'][0]['verified'] is False
        assert entry['confidence'] == 'low'

    @pytest.mark.parametrize('source_id', [['S1'], {'id': 'S1'}, 1, None], ids=['a-list', 'a-map', 'a-number', 'none'])
    def test_a_citation_whose_source_id_is_not_text_is_dropped(self, source_id):
        # The sibling of a question's field (7.109.01): a list or a map raised TypeError (unhashable) in the
        # membership test, which failed the whole extract.
        entry = _one('one_liner', _field(citations=[{'source_id': source_id, 'quote': 'Orbit plans team trips',
                                                     'page': None},
                                                    {'source_id': 'S1', 'quote': 'Orbit plans team trips',
                                                     'page': None}]))
        assert [citation['source_id'] for citation in entry['citations']] == ['S1']

    def test_at_most_three_citations_with_capped_quotes_and_real_pages(self):
        cited = [{'source_id': 'S1', 'quote': 'x' * 400, 'page': page} for page in (0, True, 2, 3, 4)]
        entry = _one('one_liner', _field(citations=cited))
        assert len(entry['citations']) == MAX_CITATIONS
        assert [citation['page'] for citation in entry['citations']] == [None, None, 2]
        assert {len(citation['quote']) for citation in entry['citations']} == {300}


class TestValues:
    def test_a_value_is_capped_at_its_field(self):
        assert len(_one('product_name', _field('O' * 500))['value']) == 200

    def test_a_lifecycle_state_outside_the_list_is_a_gap(self):
        assert _one('current_state', _field('launched'))['status'] == 'gap'

    def test_a_valid_lifecycle_state_is_proposed(self):
        assert _one('current_state', _field('beta'))['value'] == 'beta'

    def test_a_value_equal_to_the_current_one_is_unchanged(self):
        entry = _one('one_liner', _field('orbit plans  team trips'), _state({'one_liner': 'Orbit plans team trips'}))
        assert (entry['status'], entry['value'], entry['citations']) == ('unchanged', 'Orbit plans team trips', [])

    def test_a_proposal_over_a_value_a_person_typed_is_a_conflict(self):
        state = _state({'one_liner': 'Trips for teams'}, {'one_liner': {'by': 'person'}})
        assert _one('one_liner', _field(), state)['status'] == 'conflict'

    def test_a_proposal_over_a_value_with_no_field_meta_entry_is_a_conflict_too(self):
        # Review S1 (7.104.00 round 1): the one rule (shared/product_proposals.py person_typed), a value written before
        # field_meta existed taken for a person's.
        assert _one('one_liner', _field(), _state({'one_liner': 'Trips for teams'}))['status'] == 'conflict'

    def test_a_proposal_over_an_extracts_value_is_proposed(self):
        state = _state({'one_liner': 'Trips for teams'}, {'one_liner': {'by': 'extract'}})
        assert _one('one_liner', _field(), state)['status'] == 'proposed'

    def test_each_field_keeps_the_value_it_was_proposed_against(self):
        entry = _one('one_liner', _field(), _state({'one_liner': 'Trips for teams'}))
        assert (entry['seen'], entry['accepted']) == ('Trips for teams', False)

    @pytest.mark.parametrize('entry', [None, 'Orbit', [], {'status': 'proposed', 'value': ''},
                                       {'status': 'gap', 'value': 'Orbit'}, {'status': 'other', 'value': 'Orbit'}])
    def test_anything_else_is_a_gap(self, entry):
        assert _one('one_liner', entry) == {'status': 'gap', 'value': '', 'citations': [], 'confidence': 'low',
                                            'note': '', 'seen': '', 'accepted': False}

    def test_an_unknown_field_is_dropped_and_every_field_is_answered(self):
        fields, _questions = validated({'fields': _entries({'pricing': _field()})}, (DECK,), _state())
        assert list(fields) == list(FIELD_ORDER)
        assert {entry['status'] for entry in fields.values()} == {'gap'}


class TestTheArray:
    """7.109.01: the answer's ``fields`` is an array of entries, each naming its field (``proposal_schema``)."""

    def test_each_entry_is_read_as_its_fields_and_a_field_with_none_is_a_gap(self):
        raw = {'fields': [{'field': 'one_liner', **_field()}, {'field': 'product_name', **_field('Orbit')}]}
        fields, _questions = validated(raw, (DECK,), _state())
        assert list(fields) == list(FIELD_ORDER)
        assert (fields['one_liner']['value'], fields['product_name']['value']) == ('Orbit plans team trips', 'Orbit')
        assert {fields[name]['status'] for name in FIELD_ORDER if name not in ('one_liner', 'product_name')} == {'gap'}

    def test_a_fields_first_entry_is_kept_and_a_later_one_dropped(self):
        raw = {'fields': [{'field': 'product_name', **_field('Orbit')}, {'field': 'product_name', **_field('Atlas')}]}
        fields, _questions = validated(raw, (DECK,), _state())
        assert fields['product_name']['value'] == 'Orbit'

    @pytest.mark.parametrize('entry', [
        {'field': 'pricing', **_field()}, {'field': ['one_liner'], **_field()}, {'field': None, **_field()},
        {**_field()}, 'one_liner', None,
    ], ids=['unknown-field', 'field-a-list', 'field-null', 'no-field', 'a-string', 'null'])
    def test_an_entry_for_no_field_of_the_form_is_dropped(self, entry):
        fields, _questions = validated({'fields': [entry, {'field': 'one_liner', **_field()}]}, (DECK,), _state())
        assert fields['one_liner']['status'] == 'proposed'
        assert {fields[name]['status'] for name in FIELD_ORDER if name != 'one_liner'} == {'gap'}

    @pytest.mark.parametrize('answered', [{'one_liner': _field()}, 'Orbit', None],
                             ids=['an-object', 'a-string', 'null'])
    def test_fields_that_are_no_array_are_all_gaps(self, answered):
        fields, _questions = validated({'fields': answered}, (DECK,), _state())
        assert {entry['status'] for entry in fields.values()} == {'gap'}


class TestQuestions:
    def test_only_a_gap_or_a_low_field_keeps_its_question(self):
        raw = {'fields': _entries({'one_liner': _field(), 'target_users': _field(confidence='low')}),
               'questions': [{'field': 'one_liner', 'question': 'Who is it for?'},
                             {'field': 'target_users', 'question': 'Which  teams?'},
                             {'field': 'non_goals', 'question': 'What is out of scope?'},
                             {'field': 'pricing', 'question': 'How much?'}]}
        _fields, questions = validated(raw, (DECK,), _state())
        assert questions == [{'field': 'target_users', 'question': 'Which teams?'},
                             {'field': 'non_goals', 'question': 'What is out of scope?'}]

    def test_a_second_question_for_the_same_field_is_dropped(self):
        # Review Q1 / S2 (7.104.00 round 2): two questions for one field bound two of the gaps panel's answers to one
        # field, and the voice start refused the proposal's questions ("One question per field").
        asked = [('differentiators', 'Who does it compete with?'), ('success_metrics', 'Which numbers show it works?'),
                 ('differentiators', 'What makes it different?'), ('success_metrics', 'What is a good month?')]
        raw = {'fields': _entries({'differentiators': _field(confidence='low')}),
               'questions': [{'field': field, 'question': question} for field, question in asked]}
        _fields, questions = validated(raw, (DECK,), _state())
        assert [(one['field'], one['question']) for one in questions] == asked[:2]

    @pytest.mark.parametrize('field', [['target_users'], {'name': 'target_users'}, 7, None],
                             ids=['a-list', 'a-map', 'a-number', 'none'])
    def test_a_question_whose_field_is_not_text_is_dropped(self, field):
        # Review S3 / Q2 (7.72.00 gate, round 3): a list or a map as the field raised TypeError (unhashable) in the
        # membership test, which failed the whole extract.
        raw = {'fields': [], 'questions': [{'field': field, 'question': 'Who is it for?'},
                                           {'field': 'non_goals', 'question': 'What is out of scope?'}]}
        _fields, questions = validated(raw, (DECK,), _state())
        assert questions == [{'field': 'non_goals', 'question': 'What is out of scope?'}]

    def test_the_prompt_asks_for_one_question_per_field(self):
        assert '- questions: at most 8, at most one per field,' in system_prompt(None)

    def test_at_most_eight_capped_questions(self):
        raw = {'fields': [], 'questions': [{'field': name, 'question': f'{name}? ' + 'q' * 300}
                                           for name in FIELD_ORDER]}
        _fields, questions = validated(raw, (DECK,), _state())
        assert len(questions) == MAX_QUESTIONS
        assert {len(question['question']) for question in questions} == {200}
