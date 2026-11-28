"""A source profile cannot be added under the id of a whole-file folder (TENETS.md D5; shared/source_profiles.py).

``csv_upload/`` and ``json_upload/`` under a raw root hold whole-file uploads (shared/retention.py
``whole_upload_key``): a new source with one of those ids would archive its items' own copies beside them. A profile
already stored under one still loads, and a list that keeps it still saves (the PUT replaces the whole list), so no
deployment's settings get stuck.
"""
from unittest.mock import MagicMock

import pytest

from shared.source_profiles import load_source_profiles, validate_source_profiles


def test_a_source_profile_named_csv_upload_is_refused_on_save():
    with pytest.raises(ValueError, match='reserved'):
        validate_source_profiles([{'id': 'csv_upload'}], [])


def test_a_source_profile_named_json_upload_is_refused_on_save():
    with pytest.raises(ValueError, match='reserved'):
        validate_source_profiles([{'id': 'json_upload'}], [])


def test_a_new_reserved_id_is_refused_with_what_to_do():
    with pytest.raises(ValueError, match='choose another id'):
        validate_source_profiles([{'id': 'web'}, {'id': 'csv_upload'}], [], stored_ids={'web'})


def test_a_list_that_already_holds_a_reserved_id_saves():
    saved = validate_source_profiles([{'id': 'csv_upload'}, {'id': 'web'}], [], stored_ids={'csv_upload'})
    assert [profile['id'] for profile in saved] == ['csv_upload', 'web']


def test_a_stored_profile_named_csv_upload_still_loads():
    table = MagicMock()
    table.get_item.return_value = {'Item': {'pk': 'SETTINGS#sources', 'sk': 'config',
                                            'sources': [{'id': 'csv_upload'}]}}
    assert [profile['id'] for profile in load_source_profiles(table)] == ['csv_upload']


def test_the_paste_and_form_sources_stay_saveable():
    saved = validate_source_profiles([{'id': 'manual_import'}, {'id': 'feedback_form'}], [])
    assert [profile['id'] for profile in saved] == ['manual_import', 'feedback_form']
