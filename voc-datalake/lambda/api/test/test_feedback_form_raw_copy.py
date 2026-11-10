"""POST /feedback-forms/{id}/submit keeps the validated fields as the widget sent them (shared/feedback_form_raw.py).

Only when the ``feedback_form`` profile permits a raw copy; a redact profile keeps none, and a
failed write never refuses the submission.
"""
import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import call_route

from shared.test.raw_lake_fixtures import RAW_BUCKET, raw_keys, raw_lake
from shared.test.source_profile_fixtures import seeded_source_profiles

BUCKET = RAW_BUCKET
QUEUE = 'https://sqs.example.com/queue'
_ENABLED_FORM = {'Item': {'form_id': 'deadbeef', 'enabled': True, 'collect_email': True}}
BODY = {'text': 'The checkout is slow', 'rating': 2, 'email': 'Ann@Example.com', 'page_url': 'https://shop/x'}
#: Form copies are opt-in: an admin-saved feedback_form profile that permits one.
_ALLOW = [{'id': 'feedback_form', 'label': 'Forms', 'pii': 'allow'}]


@pytest.fixture
def raw_s3() -> Iterator[Any]:
    with raw_lake() as client:
        yield client


def _submit(handler: Any, api_gateway_event: Any, lambda_context: Any, sqs: MagicMock,
            profiles: list[dict] | None = None, *, body: dict | None = None, form: dict | None = None) -> dict:
    with (
        seeded_source_profiles(_ALLOW if profiles is None else profiles),
        patch.object(handler, 'PROCESSING_QUEUE_URL', QUEUE),
        patch.object(handler, 'sqs', sqs),
        patch.object(handler, 'aggregates_table') as table,
    ):
        table.get_item.return_value = form or _ENABLED_FORM
        response, payload = call_route(
            handler.lambda_handler, api_gateway_event, lambda_context, method='POST',
            path='/feedback-forms/deadbeef/submit', path_params={'form_id': 'deadbeef'}, body=body or BODY,
        )
    assert response['statusCode'] == 200, payload
    return json.loads(sqs.send_message.call_args.kwargs['MessageBody'])


def _objects(s3: Any) -> list[str]:
    return raw_keys(s3)


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


def test_the_copy_keeps_only_validated_fields_never_extras_or_the_participant_token(
    raw_s3, feedback_form_handler, api_gateway_event, lambda_context,
):
    # The route is public: an extra field of any size and the participant link token are not kept.
    body = {**BODY, 'padding': 'x' * 100_000, 'participant_token': 'secret-token'}
    _submit(feedback_form_handler, api_gateway_event, lambda_context, MagicMock(), body=body)

    [key] = _objects(raw_s3)
    assert json.loads(raw_s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())['submission'] == BODY


def test_text_and_dimensions_are_kept_as_validated_not_as_sent(
    raw_s3, feedback_form_handler, api_gateway_event, lambda_context,
):
    # Padding around the text and a dimension value the cleaner drops must not reach the lake.
    body = {**BODY, 'text': f"{' ' * 50_000}{BODY['text']}{' ' * 50_000}",
            'dimensions': {'plan': 'pro', 'junk': {'nested': 'x' * 50_000}}}
    _submit(feedback_form_handler, api_gateway_event, lambda_context, MagicMock(), body=body)

    [key] = _objects(raw_s3)
    obj = raw_s3.get_object(Bucket=BUCKET, Key=key)
    submission = json.loads(obj['Body'].read())['submission']
    assert submission['text'] == BODY['text']
    assert submission['dimensions'] == {'plan': 'pro'}
    assert obj['ContentLength'] < 2_000


def test_email_and_name_are_kept_only_when_the_form_collects_them(
    raw_s3, feedback_form_handler, api_gateway_event, lambda_context,
):
    form = {'Item': {'form_id': 'deadbeef', 'enabled': True}}  # collects neither
    _submit(feedback_form_handler, api_gateway_event, lambda_context, MagicMock(),
            body={**BODY, 'name': 'Ann'}, form=form)

    [key] = _objects(raw_s3)
    submission = json.loads(raw_s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())['submission']
    assert 'email' not in submission
    assert 'name' not in submission
    assert submission['text'] == BODY['text']


def test_a_redact_profile_keeps_no_raw_copy(raw_s3, feedback_form_handler, api_gateway_event, lambda_context):
    record = _submit(feedback_form_handler, api_gateway_event, lambda_context, MagicMock(),
                     [{'id': 'feedback_form', 'label': 'Forms', 'pii': 'redact'}])

    assert _objects(raw_s3) == []
    assert record.get('s3_raw_uri') is None


def test_no_copy_is_written_until_an_admin_saves_a_feedback_form_profile(
    raw_s3, feedback_form_handler, api_gateway_event, lambda_context,
):
    # The route is public: an upgraded deployment never starts persisting submissions silently.
    record = _submit(feedback_form_handler, api_gateway_event, lambda_context, MagicMock(), [])

    assert _objects(raw_s3) == []
    assert record.get('s3_raw_uri') is None


def test_a_failed_raw_write_still_queues_the_submission(
    monkeypatch, feedback_form_handler, api_gateway_event, lambda_context,
):
    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)
    s3 = MagicMock()
    s3.put_object.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'PutObject')
    with patch('shared.raw_copy.get_s3_client', return_value=s3):
        record = _submit(feedback_form_handler, api_gateway_event, lambda_context, MagicMock())

    assert record['text'] == 'The checkout is slow'
    assert record.get('s3_raw_uri') is None
