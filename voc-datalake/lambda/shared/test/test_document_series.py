"""A PR/FAQ / PRD as a series, and the plain text anchors match in (shared/document_series.py).

The base-title normalisation itself is pinned in test_document_series_identity.py; here the
series id, the commentable-type gate, the document lookup and ``plain_text``.
"""
import re

import pytest
from moto import mock_aws

from shared import document_series as series
from shared.exceptions import NotFoundError, ValidationError
from shared.test.moto_tables import create_pk_sk_table


def _doc(document_id, *, document_type='prfaq', base='Launch', version=1, content='Body'):
    """A stored managed version row: title ``{base} (v{version})``."""
    return {'pk': 'PROJECT#p1', 'sk': f'{document_type.upper()}#{document_id}', 'document_id': document_id,
            'document_type': document_type, 'title': f'{base} (v{version})', 'base_title': base,
            'version': version, 'content': content, 'created_at': f'2026-10-{version:02d}T00:00:00+00:00'}


@pytest.fixture
def table():
    with mock_aws():
        yield create_pk_sk_table('projects')


# ── series_id / series_of ───────────────────────────────────────────────────

def test_a_series_id_is_ser_plus_24_hex_and_never_carries_the_title():
    value = series.series_id('p1', 'prfaq', 'Secret launch')
    assert re.fullmatch(r'ser_[0-9a-f]{24}', value)
    assert 'Secret' not in value


@pytest.mark.parametrize('title', ['Launch', 'Launch (v2)', '  LAUNCH  ', 'launch (v17)'])
def test_every_version_and_casing_of_one_title_is_one_series(title):
    assert series.series_id('p1', 'prfaq', title) == series.series_id('p1', 'prfaq', 'Launch')


@pytest.mark.parametrize(('project_id', 'document_type', 'title'), [
    ('p2', 'prfaq', 'Launch'), ('p1', 'prd', 'Launch'), ('p1', 'prfaq', 'Launch two'),
])
def test_another_project_type_or_title_is_another_series(project_id, document_type, title):
    assert series.series_id(project_id, document_type, title) != series.series_id('p1', 'prfaq', 'Launch')


def test_series_of_names_the_type_and_base_title_of_a_version():
    assert series.series_of('p1', _doc('d3', version=3)) == {
        'series_id': series.series_id('p1', 'prfaq', 'Launch'), 'document_type': 'prfaq', 'base_title': 'Launch'}


def test_two_versions_of_a_document_share_a_series():
    assert (series.series_of('p1', _doc('d1'))['series_id']
            == series.series_of('p1', _doc('d2', version=2))['series_id'])


def test_a_legacy_row_without_a_type_is_typed_by_its_sort_key():
    legacy = {'sk': 'PRD#old', 'document_id': 'old', 'title': 'Spec'}
    assert series.commentable_type(legacy) == 'prd'


@pytest.mark.parametrize('document', [
    {'document_type': 'prototype', 'sk': 'PROTOTYPE#x'},
    {'document_type': 'custom', 'sk': 'DOC#x'},
    {'sk': 'PERSONA#x'},
    {},
])
def test_only_a_prfaq_or_prd_is_commentable(document):
    with pytest.raises(ValidationError, match='PR/FAQ and PRD'):
        series.commentable_type(document)
    with pytest.raises(ValidationError):
        series.series_of('p1', document)


# ── find_document / latest_version ──────────────────────────────────────────

def test_find_document_returns_the_full_row_with_content(table):
    table.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1'})
    table.put_item(Item=_doc('d1', content='The full body'))
    found = series.find_document(table, 'p1', 'd1')
    assert found['content'] == 'The full body'


def test_find_document_is_404_for_an_unknown_id_or_another_projects_document(table):
    table.put_item(Item={**_doc('d1'), 'pk': 'PROJECT#p2'})
    with pytest.raises(NotFoundError, match=series.DOCUMENT_NOT_FOUND):
        series.find_document(table, 'p1', 'd1')
    with pytest.raises(NotFoundError):
        series.find_document(table, 'p2', 'missing')


def test_latest_version_is_the_newest_of_the_series_only(table):
    other_title, other_type = _doc('x9', base='Other', version=9), _doc('r9', document_type='prd', version=9)
    for item in (_doc('d1'), _doc('d3', version=3), _doc('d2', version=2), other_title, other_type):
        table.put_item(Item=item)
    latest = series.latest_version(table, 'p1', 'prfaq', 'Launch')
    assert latest is not None
    assert latest['document_id'] == 'd3'


def test_latest_version_is_none_once_every_version_is_gone(table):
    assert series.latest_version(table, 'p1', 'prfaq', 'Launch') is None


# ── plain_text / collapse ───────────────────────────────────────────────────

def test_collapse_turns_every_whitespace_run_into_one_space():
    assert series.collapse('  a\n\n b\t\tc  ') == 'a b c'


@pytest.mark.parametrize(('markdown', 'expected'), [
    ('# Heading\n\nBody text.', 'Heading Body text.'),
    ('Some **bold** and __strong__ and ~~gone~~ and `code`.', 'Some bold and strong and gone and code.'),
    ('An *emphasis* word.', 'An emphasis word.'),
    ('A [link text](https://x.example) here.', 'A link text here.'),
    ('An ![alt words](img.png) image.', 'An alt words image.'),
    ('- one\n- two\n1. three\n- [x] done', 'one two three done'),
    ('> quoted line', 'quoted line'),
    ('above\n\n---\n\nbelow', 'above below'),
    ('| a | b |\n|---|---|\n| c | d |', 'a b c d'),
    ('```python\nprint(1)\n```', 'print(1)'),
    ('Hi <b>there</b>', 'Hi there'),
    ('2 * 3 * 4', '2 * 3 * 4'),
])
def test_plain_text_keeps_the_words_a_reader_sees(markdown, expected):
    assert series.plain_text(markdown) == expected


@pytest.mark.parametrize('value', [None, 7, ['# x']])
def test_plain_text_of_a_non_string_is_empty(value):
    assert series.plain_text(value) == ''
