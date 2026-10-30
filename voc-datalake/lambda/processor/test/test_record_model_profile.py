"""The processor runs a record's model calls under the profile its importer stamped (shared/model_profile.py),
and drops the field before anything reads the record."""
from unittest.mock import patch

import pytest
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord
from pydantic import ValidationError

from processor.test.sqs_fixtures import sqs_record
from shared.ingest_schemas import IngestMessage
from shared.model_profile import PAYLOAD_KEY, active_profile

MESSAGE = {'id': 'm1', 'source_platform': 'manual_import', 'text': 'Great flight', 'created_at': '2026-10-01T10:00:00+00:00'}


def _seen(message: dict) -> tuple[str | None, dict]:
    from processor import handler
    seen: dict = {}

    def capture(raw_record: dict) -> dict:
        seen['profile'], seen['record'] = active_profile(), dict(raw_record)
        return {'status': 'success'}

    with patch.object(handler, '_process_record', side_effect=capture):
        handler.record_handler(SQSRecord(sqs_record('msg-1', message)))
    return seen['profile'], seen['record']


def test_a_stamped_record_is_processed_in_the_e2e_profile_without_the_field():
    profile, record = _seen({**MESSAGE, PAYLOAD_KEY: 'e2e'})
    assert profile == 'e2e'
    assert PAYLOAD_KEY not in record
    assert active_profile() is None


def test_an_ordinary_record_runs_without_a_profile():
    assert _seen(MESSAGE) == (None, MESSAGE)


def test_the_queue_contract_admits_only_the_known_profile():
    IngestMessage.model_validate({**MESSAGE, PAYLOAD_KEY: 'e2e'})
    with pytest.raises(ValidationError, match=PAYLOAD_KEY):
        IngestMessage.model_validate({**MESSAGE, PAYLOAD_KEY: 'opus-for-free'})
