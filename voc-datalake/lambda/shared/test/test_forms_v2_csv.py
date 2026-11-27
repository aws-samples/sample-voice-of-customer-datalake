"""The responses CSV (shared/forms_v2_csv.py; docs/feedback-forms.md "Results and responses"): the familiar layout
(the default) and 7.04.00's detailed one, the formula guard and the file's name.
"""
from __future__ import annotations

import csv
import io
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pytest

from shared import forms_v2 as fv2
from shared import forms_v2_csv as fcsv
from shared.forms_v2_results import ResultRow

DEFINITION = fv2.validate_definition({
    'language': 'pl', 'languages': ['pl', 'en'], 'welcome': {'enabled': False},
    'questions': [
        {'id': 'q_why', 'type': 'multi_select', 'headline': {'pl': 'Dlaczego {{event|tu}}?'}, 'required': False,
         'options': [{'code': 'price', 'label': {'pl': 'Cena'}}, {'code': 'speed', 'label': {'pl': '=Szybkość'}}],
         'other': {'enabled': True}, 'none': {'enabled': True}},
        {'id': 'q_one', 'type': 'single_select', 'headline': {'pl': 'Jedno'}, 'required': False,
         'options': [{'code': 'a', 'label': {'pl': 'A'}}], 'other': {'enabled': True, 'label': {'pl': 'Coś innego'}}},
        {'id': 'q_info', 'type': 'statement', 'headline': {'pl': 'Info'}},
        {'id': 'q_phases', 'type': 'matrix', 'headline': {'pl': 'Części'}, 'required': False,
         'rows': [{'code': 'intro', 'label': {'pl': 'Wstęp'}}, {'code': 'lab', 'label': {'pl': 'Laboratorium'}}],
         'columns': [{'code': 'ok', 'label': {'pl': 'Dobrze'}}, {'code': 'top', 'label': {'pl': 'Świetnie'}}]},
        {'id': 'q_nps', 'type': 'nps', 'headline': {'pl': 'Polecisz?'}, 'required': False},
        {'id': 'q_ok', 'type': 'consent', 'headline': {'pl': 'Zgoda'}, 'required': False, 'label': {'pl': 'Tak'}},
        {'id': 'q_who', 'type': 'contact_info', 'headline': {'pl': 'Kontakt'}, 'required': False,
         'fields': {'name': {'show': True, 'required': False}, 'email': {'show': True, 'required': False}}},
    ],
    'hidden_fields': [{'id': 'event', 'label': 'Wydarzenie'}, {'id': 'app'}],
    'endings': [{'id': 'end_a', 'title': {'pl': 'Dzięki'}}],
})

ANSWERED = ResultRow({'q_why': {'codes': ['speed', 'price'], 'other': 'Kolor'}, 'q_one': {'other': '+48 123'},
                      'q_phases': {'rows': {'lab': 'top'}}, 'q_nps': 9, 'q_ok': True,
                      'q_who': {'email': 'ana@example.com'}},
                     [], 'end_a', '2026-11-20T10:30:00.123456+01:00', response_id='f1', language='pl',
                     hidden={'event': 'Lizbona'})
TEST = ResultRow({'q_why': {'codes': ['none']}, 'q_one': {'code': 'a'}}, [], 'end_a', '2026-11-19T08:00:00Z',
                 is_test=True, response_id='t1', language='en')


def _table(text: str) -> list[list[str]]:
    return list(csv.reader(io.StringIO(text.removeprefix('\ufeff'))))


class TestTheFamiliarLayout:
    def test_it_starts_with_a_bom_and_one_header_row_a_person_recognises(self):
        text = fcsv.familiar_csv(DEFINITION, [ANSWERED], tags=['pilot'])
        assert text.startswith('\ufeff')
        assert _table(text)[0] == [
            'Submission ID', 'Submitted On', 'Locale', 'Tags', 'Wydarzenie', 'app', 'Dlaczego [event]?', 'Jedno',
            'Części - Wstęp', 'Części - Laboratorium', 'Polecisz?', 'Zgoda', 'Kontakt - Name', 'Kontakt - Email']
        assert len(_table(text)) == 2

    def test_a_response_reads_as_words_with_choices_joined_by_semicolons(self):
        assert _table(fcsv.familiar_csv(DEFINITION, [ANSWERED], tags=['pilot']))[1] == [
            'f1', '2026-11-20T09:30:00Z', 'pl', 'pilot', 'Lizbona', '', "'=Szybkość;Cena;Inne: Kolor",
            'Coś innego: +48 123', '', 'Świetnie', '9', 'Yes', '', 'ana@example.com']

    def test_a_test_response_is_tagged_and_none_reads_as_its_localized_words(self):
        row = _table(fcsv.familiar_csv(DEFINITION, [TEST], tags=['pilot']))[1]
        assert (row[3], row[6], row[7]) == ('pilot;test', 'Żadne z powyższych', 'A')

    def test_ids_adds_a_second_header_row(self):
        assert _table(fcsv.familiar_csv(DEFINITION, [], ids=True))[1] == [
            'submission_id', 'submitted_on', 'locale', 'tags', 'hidden.event', 'hidden.app', 'q_why', 'q_one',
            'q_phases.intro', 'q_phases.lab', 'q_nps', 'q_ok', 'q_who.name', 'q_who.email']

    def test_no_header_is_ever_a_formula(self):
        definition = {**DEFINITION, 'hidden_fields': [{'id': 'event', 'label': '@cmd'}]}
        assert _table(fcsv.familiar_csv(definition, []))[0][4] == "'@cmd"


class TestTheDetailedLayout:
    def test_it_is_the_old_file_with_a_matrix_as_row_column_pairs(self):
        table = list(csv.reader(io.StringIO(fcsv.detailed_csv(DEFINITION, [ANSWERED]))))
        assert table[1][:6] == ['created_at', 'response_id', 'is_test', 'revision', 'language', 'ending_id']
        assert table[1][8] == 'q_phases'
        assert table[2][8] == 'Laboratorium: Świetnie'
        assert table[2][6] == "'=Szybkość; Cena; other: Kolor"


@pytest.mark.parametrize(('value', 'expected'), [
    ('2026-11-20T10:30:00+01:00', '2026-11-20T09:30:00Z'), ('2026-11-20T10:30:00', '2026-11-20T10:30:00Z'),
    ('2026-11-20T10:30:00Z', '2026-11-20T10:30:00Z'), ('', ''), ('yesterday', 'yesterday'),
], ids=['offset', 'naive', 'zulu', 'empty', 'not-a-time'])
def test_times_are_iso_8601_in_utc(value, expected):
    assert fcsv.utc_time(value) == expected


@pytest.mark.parametrize(('name', 'layout', 'expected'), [
    ('Warsztat: Łódź 2026!', 'familiar', 'warsztat-lodz-2026-responses-2026-11-20.csv'),
    ('  Øre Æble — Straße ', 'familiar', 'ore-aeble-strasse-responses-2026-11-20.csv'),
    ('***', 'familiar', 'ff_1-responses-2026-11-20.csv'), (None, 'familiar', 'ff_1-responses-2026-11-20.csv'),
    ('Workshop', 'detailed', 'ff_1-responses.csv'),
], ids=['slug', 'special-letters', 'no-slug', 'no-name', 'detailed'])
def test_the_file_is_named_after_the_form_and_the_day_in_utc(name: Any, layout, expected):
    late = datetime(2026, 11, 21, 0, 30, tzinfo=timezone(timedelta(hours=1)))
    assert fcsv.csv_filename(name, 'ff_1', late, layout) == expected


def test_a_long_name_is_cut_without_a_trailing_hyphen():
    name = fcsv.csv_filename('a' * 59 + ' b', 'ff_1', datetime(2026, 1, 2, tzinfo=UTC), 'familiar')
    assert name == 'a' * 59 + '-responses-2026-01-02.csv'
