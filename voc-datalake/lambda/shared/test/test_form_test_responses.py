"""shared/form_test_responses.py: a test response row's key, and where it keeps a person's contact values."""
import pytest

# The module, not its names: pytest would collect an imported ``test_response_key`` as a test.
from shared import form_test_responses as rows


@pytest.mark.parametrize(('row', 'field', 'expected'), [
    ({'submitter_email': 'jane@example.com', 'answers': {'q_contact': {'email': 'Jane@Example.com'}}},
     rows.CONTACT_EMAIL, ['jane@example.com', 'Jane@Example.com']),
    ({'answers': {'q_contact': {'name': 'Jane'}, 'q_other': {'name': 'Jo'}}}, rows.CONTACT_NAME, ['Jane', 'Jo']),
    ({'submitter_name': 'Jane'}, rows.CONTACT_NAME, ['Jane']),
    # Not a contact answer, not a text, empty: never a value.
    ({'answers': {'q_pick': {'code': 'a'}, 'q_text': 'jane@example.com', 'q_c': {'email': ''}, 'q_n': {'email': 3}}},
     rows.CONTACT_EMAIL, []),
    ({'submitter_email': '', 'answers': 'not a map'}, rows.CONTACT_EMAIL, []),
])
def test_person_values_reads_the_top_level_copy_and_every_contact_answer(row, field, expected):
    assert rows.person_values(row, field) == expected


@pytest.mark.parametrize(('row', 'expected'), [
    ({'response_id': 'abc', 'sk': 'f1#t#zzz'}, 'abc'),
    ({'sk': 'f1#2026-11-18T10:00:00+00:00#def'}, 'def'),
    ({'response_id': '', 'sk': 'f1#t#ghi'}, 'ghi'),
    ({}, ''),
])
def test_response_id_of_falls_back_to_the_sort_key(row, expected):
    assert rows.response_id_of(row) == expected


def test_a_test_response_lives_in_its_own_partition_under_its_forms_prefix():
    key = rows.test_response_key('f1', '2026-11-18T10:00:00+00:00', 'abc')
    assert key == {'pk': 'FEEDBACK_FORM_TEST', 'sk': 'f1#2026-11-18T10:00:00+00:00#abc'}
    assert key['pk'] == rows.TEST_RESPONSES_PK
    assert key['sk'].startswith(rows.form_sk_prefix('f1'))
    # A form id never holds '#': one form's prefix never names another form's rows.
    assert not rows.test_response_key('f10', 'x', 'y')['sk'].startswith(rows.form_sk_prefix('f1'))
    assert rows.response_id_of(key) == 'abc'
