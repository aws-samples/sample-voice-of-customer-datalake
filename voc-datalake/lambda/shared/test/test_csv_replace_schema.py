"""``csv_replace`` is accepted only on a CSV dataset upload's row (issue #411 security review).

The processor lets a ``csv_replace`` record overwrite the stored item it names, so the queue
schema refuses the marker from any other producer, and on a CSV row that does not name its
dataset and digest.
"""
import pytest

from shared.ingest_schemas import MessageValidationError, validate_message

HASH = 'a' * 32


def _message(**extra) -> dict:
    return {
        'id': 'row-1', 'source_platform': 'manual_import', 'text': 'the app crashes',
        'created_at': '2026-01-15T00:00:00Z', 'ingestion_method': 'csv_upload',
        'csv_dataset': 'example air q3', 'csv_content_hash': HASH, 'csv_replace': True, **extra,
    }


def test_a_csv_upload_row_naming_its_dataset_and_digest_may_carry_csv_replace():
    assert validate_message(_message()).csv_replace is True


@pytest.mark.parametrize('change', [
    {'ingestion_method': 'json_upload'}, {'ingestion_method': 'manual'}, {'ingestion_method': None},
    {'csv_dataset': None}, {'csv_content_hash': None},
])
def test_csv_replace_from_any_other_producer_or_without_its_dataset_and_digest_is_refused(change):
    with pytest.raises(MessageValidationError, match='csv_replace'):
        validate_message(_message(**change))


@pytest.mark.parametrize('change', [
    {'csv_dataset': 'Example Air Q3'}, {'csv_dataset': ''}, {'csv_content_hash': 'A' * 32},
    {'csv_content_hash': 'a' * 31},
])
def test_a_malformed_dataset_or_digest_is_refused(change):
    with pytest.raises(MessageValidationError):
        validate_message(_message(**change))


@pytest.mark.parametrize('replace', [None, False])
def test_a_message_without_the_marker_is_judged_as_before(replace):
    message = _message(csv_replace=replace, ingestion_method='json_upload', csv_dataset=None)
    assert validate_message(message).csv_replace is replace
