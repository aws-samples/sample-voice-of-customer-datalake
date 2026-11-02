"""`shared/ingest_archive.py`: upload source resolution, policy and per-item archive."""
import hashlib
from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from shared.ingest_archive import archive_per_item, prepare_messages, stamp_file_archive, upload_profile
from shared.source_profiles import SourceProfilesUnavailable, profile_for

NOW = datetime(2026, 1, 15, tzinfo=UTC)
_PROFILES = [{'id': 'support_tickets', 'pii': 'redact', 'retention_days': 365},
             {'id': 'sales_csv', 'retention_days': 90}]


def _table(sources):
    table = MagicMock()
    table.get_item.return_value = {'Item': {'sources': sources}}
    return table


@pytest.mark.parametrize('raw', [None, '', 'manual_import'])
def test_the_default_upload_source_is_manual_import(raw):
    assert upload_profile(_table([]), raw)['id'] == 'manual_import'


def test_a_configured_source_returns_its_profile():
    profile = upload_profile(_table(_PROFILES), 'support_tickets')
    assert (profile['id'], profile['pii'], profile['retention_days']) == ('support_tickets', 'redact', 365)


@pytest.mark.parametrize('failure', [ClientError({'Error': {'Code': 'X'}}, 'GetItem'), None])
def test_unreadable_profiles_fail_closed(failure):
    table = _table([{'id': 'BAD ID'}]) if failure is None else MagicMock()
    if failure is not None:
        table.get_item.side_effect = failure
    with pytest.raises(SourceProfilesUnavailable) as exc:
        upload_profile(table, 'manual_import')
    assert exc.value.status_code == 503


def _messages():
    return [{'id': 'a/1', 'source_platform': 's', 'text': 'mail a@b.io', 's3_raw_uri': 'old'},
            {'id': 'b', 'source_platform': 's', 'text': 'fine', 's3_raw_uri': 'old'}]


def test_item_mode_archives_each_message_under_its_source():
    s3 = MagicMock()
    out, mode = prepare_messages(s3, 'bkt', _messages(), profile_for(_PROFILES, 'sales_csv'), NOW)
    assert mode == 'item'
    # 'a/1' is not filename-safe, so it is archived under its sha256 stem (shared/archive_keys.py).
    a_stem = 'h.' + hashlib.sha256(b'a/1').hexdigest()
    folders = [m['s3_raw_uri'].rpartition('/')[0] for m in out]
    assert folders == [f's3://bkt/raw/sales_csv/2026/01/15/{a_stem}', 's3://bkt/raw/sales_csv/2026/01/15/b']
    assert sorted(m['s3_raw_uri'] for m in out) == [f"s3://bkt/{key}" for key in _keys(s3)]
    assert s3.put_object.call_count == 2


def test_none_mode_redacts_and_clears_every_uri_without_writing():
    s3 = MagicMock()
    out, mode = prepare_messages(s3, 'bkt', _messages(), profile_for(_PROFILES, 'support_tickets'), NOW)
    assert mode == 'none'
    assert [(m['text'], m['s3_raw_uri']) for m in out] == [('mail [EMAIL]', None), ('fine', None)]
    s3.put_object.assert_not_called()


def test_file_mode_leaves_archiving_to_the_caller():
    s3 = MagicMock()
    out, mode = prepare_messages(s3, 'bkt', _messages(), profile_for([], 'manual_import'), NOW)
    assert (mode, out[0]['s3_raw_uri']) == ('file', 'old')
    assert stamp_file_archive(out, mode, lambda: 's3://bkt/whole') == 's3://bkt/whole'
    assert {m['s3_raw_uri'] for m in out} == {'s3://bkt/whole'}
    s3.put_object.assert_not_called()


def test_stamp_file_archive_writes_nothing_outside_file_mode():
    write = MagicMock()
    assert stamp_file_archive([], 'item', write) is None
    write.assert_not_called()


def test_a_failed_item_write_leaves_that_uri_empty():
    s3 = MagicMock()
    s3.put_object.side_effect = [ClientError({'Error': {'Code': 'X'}}, 'PutObject'), None]
    messages = _messages()
    archive_per_item(s3, 'bkt', 'src', messages, NOW)
    assert messages[0]['s3_raw_uri'] is None
    assert messages[1]['s3_raw_uri'].startswith('s3://bkt/raw/src/2026/01/15/b/')


def test_without_a_bucket_nothing_is_archived():
    messages = _messages()
    archive_per_item(MagicMock(), '', 'src', messages, NOW)
    assert {m['s3_raw_uri'] for m in messages} == {'old'}


def _keys(s3) -> list[str]:
    return sorted(c.kwargs['Key'] for c in s3.put_object.call_args_list)


def _key_of(s3, folder: str) -> str:
    matches = [key for key in _keys(s3) if key.startswith(folder)]
    assert len(matches) == 1, _keys(s3)
    return matches[0]


@pytest.mark.parametrize('stored', [
    's3://bkt/raw/sales_csv/2025/12/01/b.json',                     # a legacy archive: its folder is .../b/
    's3://bkt/raw/sales_csv/2025/12/01/b/0123456789abcdef.json',    # a versioned one: its own folder
])
def test_an_update_is_a_new_version_in_the_stored_items_folder(stored):
    """A confirmed CSV correction (issue #411) never overwrites: a new object next to the stored one."""
    s3 = MagicMock()
    out, _ = prepare_messages(s3, 'bkt', _messages(), profile_for(_PROFILES, 'sales_csv'), NOW, {'b': stored})
    key = _key_of(s3, 'raw/sales_csv/2025/12/01/b/')
    assert f's3://bkt/{key}' != stored
    assert not [k for k in _keys(s3) if k.startswith('raw/sales_csv/2026/01/15/b')]
    assert out[1]['s3_raw_uri'] == f's3://bkt/{key}'
    assert out[0]['s3_raw_uri'].startswith('s3://bkt/raw/sales_csv/2026/01/15/')
    assert all(c.kwargs['IfNoneMatch'] == '*' for c in s3.put_object.call_args_list)


@pytest.mark.parametrize('stored', [
    's3://other-bucket/raw/sales_csv/2025/12/01/b.json',   # another bucket
    's3://bkt/raw/support_tickets/2025/12/01/b.json',      # another source's archive
    's3://bkt/raw/csv_upload/2025/12/01/upload.csv',       # a whole-file archive
    's3://bkt/raw/sales_csv/2025/12/01/b/not-a-digest.json',  # not a version file
    'not-a-uri',
])
def test_an_archive_that_is_not_the_items_own_is_never_a_correction_target(stored):
    s3 = MagicMock()
    prepare_messages(s3, 'bkt', _messages(), profile_for(_PROFILES, 'sales_csv'), NOW, {'b': stored})
    _key_of(s3, 'raw/sales_csv/2026/01/15/b/')
