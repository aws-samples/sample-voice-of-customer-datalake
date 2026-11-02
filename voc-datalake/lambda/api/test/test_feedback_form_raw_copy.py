"""POST /feedback-forms/{id}/submit keeps the body as the widget sent it (shared/feedback_form_raw.py).

Only when the ``feedback_form`` profile permits a raw copy; a redact profile keeps none, and a
failed write never refuses the submission.
"""
import json
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import call_route
from moto import mock_aws

from shared.test.source_profile_fixtures import seeded_source_profiles

BUCKET = 'raw-bucket'
QUEUE = 'https://sqs.example.com/queue'
_ENABLED_FORM = {'Item': {'form_id': 'deadbeef', 'enabled': True, 'collect_email': True}}
BODY = {'text': 'The checkout is slow', 'rating': 2, 'email': 'Ann@Example.com', 'page_url': 'https://shop/x'}


@pytest.fixture
def raw_s3(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)
    monkeypatch.setenv('APP_VERSION', '9.1.0')
    with mock_aws():
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket=BUCKET)
        with patch('shared.feedback_form_raw.get_s3_client', return_value=client):
            yield client


def _submit(handler: Any, api_gateway_event: Any, lambda_context: Any, sqs: MagicMock,
            profiles: list[dict] | None = None) -> dict:
    with (
        seeded_source_profiles(profiles),
        patch.object(handler, 'PROCESSING_QUEUE_URL', QUEUE),
        patch.object(handler, 'sqs', sqs),
        patch.object(handler, 'aggregates_table') as table,
    ):
        table.get_item.return_value = _ENABLED_FORM
        response, payload = call_route(
            handler.lambda_handler, api_gateway_event, lambda_context, method='POST',
            path='/feedback-forms/deadbeef/submit', path_params={'form_id': 'deadbeef'}, body=BODY,
        )
    assert response['statusCode'] == 200, payload
    return json.loads(sqs.send_message.call_args.kwargs['MessageBody'])


def _objects(s3: Any) -> list[str]:
    return [o['Key'] for o in s3.list_objects_v2(Bucket=BUCKET).get('Contents', [])]


def test_the_submission_is_archived_as_sent_and_the_message_points_at_it(
    raw_s3, feedback_form_handler, api_gateway_event, lambda_context,
):
    record = _submit(feedback_form_handler, api_gateway_event, lambda_context, MagicMock())

    [key] = _objects(raw_s3)
    assert key.startswith('raw/feedback_form/')
    assert key.split('/')[5] == record['id']  # one folder per submission, named after its feedback id
    assert record['s3_raw_uri'] == f's3://{BUCKET}/{key}'
    obj = raw_s3.get_object(Bucket=BUCKET, Key=key)
    # Before the policy: the email exactly as typed (the queued copy is lower-cased).
    assert json.loads(obj['Body'].read()) == {'form_id': 'deadbeef', 'submission': BODY}
    assert obj['Metadata'] == {'connector': 'feedback_form', 'connector-version': '9.1.0'}


def test_a_redact_profile_keeps_no_raw_copy(raw_s3, feedback_form_handler, api_gateway_event, lambda_context):
    record = _submit(feedback_form_handler, api_gateway_event, lambda_context, MagicMock(),
                     [{'id': 'feedback_form', 'label': 'Forms', 'pii': 'redact'}])

    assert _objects(raw_s3) == []
    assert record.get('s3_raw_uri') is None


def test_a_failed_raw_write_still_queues_the_submission(
    monkeypatch, feedback_form_handler, api_gateway_event, lambda_context,
):
    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)
    s3 = MagicMock()
    s3.put_object.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'PutObject')
    with patch('shared.feedback_form_raw.get_s3_client', return_value=s3):
        record = _submit(feedback_form_handler, api_gateway_event, lambda_context, MagicMock())

    assert record['text'] == 'The checkout is slow'
    assert record.get('s3_raw_uri') is None
