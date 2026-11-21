"""The in-app micro-feedback's tag (``voc_app``, 7.66.00) is reserved: it keeps an item out of every customer read
(shared/item_filters.py), so only a response to a form made from the In-app micro-feedback template carries it.

A source profile and a producer's saved labels (a form's, a scraper's) refuse it, a form only unless made from the
template; every producer but a form has it dropped from its messages (a review is never refused for a tag). The
manual tag edit is in lambda/api/test/test_feedback_edit_dimensions.py, the form saves in test_feedback_form_v2.py.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from shared.app_feedback_tag import names_app_feedback, refuses_tag_edit
from shared.exceptions import ValidationError
from shared.ingest_schemas import validate_message
from shared.producer_labels import normalise_label_fields
from shared.source_profiles import validate_source_profiles

MESSAGE = {'id': 'r1', 'text': 'Late again', 'created_at': '2026-11-20T09:00:00Z'}


@pytest.mark.parametrize(('source', 'stored', 'edited', 'refused'), [
    ('web', [], ['voc_app'], True),                         # (giving it: refused everywhere)
    ('feedback_form', [], [' VOC_APP '], True),
    ('feedback_form', ['voc_app'], ['beta'], True),         # (taking it from a form's response: refused)
    ('web', ['voc_app', 'beta'], ['beta'], False),          # (round 3: a review of another source tagged before 7.66)
    ('feedback_form', ['voc_app'], ['VOC_APP', 'beta'], False),
    ('web', ['beta'], [], False),
])
def test_a_manual_tag_edit_never_gives_the_tag_and_takes_it_only_from_a_non_form_review(source, stored, edited,
                                                                                         refused):
    assert refuses_tag_edit({'source_platform': source, 'tags': stored}, edited) is refused


@pytest.mark.parametrize('source', ['s3_import', 'manual_import', 'webscraper', 'email_inbox'])
def test_no_producer_but_a_form_brings_the_tag(source):
    assert validate_message({**MESSAGE, 'source_platform': source, 'tags': ['VOC_APP', 'beta']}).tags == ['beta']
    assert validate_message({**MESSAGE, 'source_platform': source, 'tags': ['voc_app']}).tags is None


def test_a_form_s_response_keeps_it():
    assert validate_message({**MESSAGE, 'source_platform': 'feedback_form', 'tags': ['voc_app']}).tags == ['voc_app']


def test_a_producer_s_saved_labels_refuse_it_unless_it_is_the_app_feedback_form():
    with pytest.raises(ValidationError, match='reserved'):
        normalise_label_fields(MagicMock(), {'tags': ['beta', 'voc_app']})
    table = MagicMock()
    table.get_item.return_value = {}
    entry = {'tags': ['voc_app']}
    normalise_label_fields(table, entry, app_feedback=True)
    assert entry['tags'] == ['voc_app']


def test_a_source_profile_refuses_it():
    with pytest.raises(ValueError, match='reserved'):
        validate_source_profiles([{'id': 'web', 'tags': ['Voc_App']}], [])


@pytest.mark.parametrize(('tags', 'named'), [(['voc_app'], True), ([' VOC_APP '], True), (['voc'], False), ('voc_app', False),
                                            (None, False)])
def test_what_names_it(tags, named):
    assert names_app_feedback(tags) is named
