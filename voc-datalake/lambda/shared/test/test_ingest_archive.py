"""`shared/ingest_archive.py`: upload source resolution, policy and per-item archive."""
import hashlib
import threading
import time
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from shared import pii_redaction
from shared.ingest_archive import archive_per_item, policy_applied, prepare_messages, stamp_file_archive, upload_profile
from shared.source_policy import apply_source_policy
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


class _SlowFactory:
    """``boto3.client`` standing in for Comprehend: counts the clients built, and each call's text decides its answer
    (a text with ``throttled`` fails as a throttle that outlasted the retries)."""

    def __init__(self) -> None:
        self.built = 0
        self._lock = threading.Lock()

    def __call__(self, *_args: object, **_kwargs: object) -> MagicMock:
        with self._lock:
            self.built += 1
        time.sleep(0.01)  # a slow build: workers building their own would overlap here
        client = MagicMock()

        def detect(**request: str) -> dict:
            if 'throttled' in request['Text']:
                raise ClientError({'Error': {'Code': 'ThrottlingException'}}, 'DetectPiiEntities')
            return {'Entities': []}

        client.detect_pii_entities.side_effect = detect
        return client


def test_a_strict_redaction_shares_one_client_and_leaves_out_what_comprehend_could_not_read(monkeypatch):
    """S7 (7.71.01): the Comprehend client is built once, before the workers; a message one of whose texts Comprehend
    could not read is left out and named, never kept with the patterns' redaction alone. F1 (7.71.02): every upload's
    redaction is strict, so without ``unreadable`` it is left out too; one live record keeps the pattern result."""
    monkeypatch.setenv('PII_COMPREHEND', '1')
    messages = [{'id': f'm{n}', 'source_platform': 's', 'language': 'en',
                 'text': 'throttled, call 555-123-4567' if n == 3 else f'fine {n}'} for n in range(12)]
    factory = _SlowFactory()
    pii_redaction._comprehend_client.clear()
    try:
        with patch.object(pii_redaction.boto3, 'client', factory):
            unreadable: list[str] = []
            out, _mode = prepare_messages(MagicMock(), 'bkt', messages, profile_for(_PROFILES, 'support_tickets'), NOW,
                                          unreadable=unreadable)
            unnamed = policy_applied(messages, profile_for(_PROFILES, 'support_tickets'))
            live = apply_source_policy(messages[3], profile_for(_PROFILES, 'support_tickets'))
    finally:
        pii_redaction._comprehend_client.clear()
    assert factory.built == 1
    assert (unreadable, [m['id'] for m in out]) == (['m3'], [f'm{n}' for n in range(12) if n != 3])
    assert [m['id'] for m in unnamed] == [m['id'] for m in out]
    assert (live or {}).get('text') == 'throttled, call [PHONE]'
