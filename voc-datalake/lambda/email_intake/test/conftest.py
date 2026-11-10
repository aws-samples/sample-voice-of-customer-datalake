"""Fixtures for the email intake worker: moto watermarks + aggregates tables, the inbound
bucket and the processing queue, and the two model calls replaced by fakes (no Bedrock)."""
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws

from email_intake import intake, model_calls
from email_intake.intake import IntakeContext
from email_intake.state import IntakeState
from shared import source_profiles
from shared.test.moto_tables import create_pk_sk_table

FIXTURES = Path(__file__).parent / 'fixtures'
BUCKET = 'test-inbound-bucket'
DOMAIN = 'voc.example.com'
DAY = '2026-03-02'
#: shared.source_profiles reads AGGREGATES_TABLE, which the root conftest defaults to this.
AGGREGATES = 'test-aggregates'


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


@pytest.fixture
def aws():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        watermarks = resource.create_table(
            TableName='test-watermarks', BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'source', 'KeyType': 'HASH'}],
            AttributeDefinitions=[{'AttributeName': 'source', 'AttributeType': 'S'}],
        )
        aggregates = create_pk_sk_table(AGGREGATES, resource)
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        sqs = boto3.client('sqs', region_name='us-east-1')
        queue_url = sqs.create_queue(QueueName='test-processing')['QueueUrl']
        source_profiles.clear_source_profiles_cache()
        with patch.object(source_profiles, 'get_dynamodb_resource', return_value=resource):
            yield {'watermarks': watermarks, 'aggregates': aggregates, 's3': s3, 'sqs': sqs,
                   'queue_url': queue_url, 'resource': resource}
        source_profiles.clear_source_profiles_cache()


@pytest.fixture
def ctx(aws):
    return IntakeContext(
        s3=aws['s3'], sqs=aws['sqs'], bedrock=MagicMock(name='bedrock'),
        state=IntakeState(aws['watermarks'], aws['aggregates'], day=DAY),
        bucket=BUCKET, queue_url=aws['queue_url'], inbox_domain=DOMAIN,
    )


@pytest.fixture(autouse=True)
def models():
    """The model calls, faked (never Bedrock): every reply is new feedback, every attachment summarised."""
    fakes = MagicMock()
    fakes.relevance_label.return_value = model_calls.LABEL_NEW
    fakes.summarise_attachments.side_effect = lambda _client, _subject, readable: {
        index: model_calls.AttachmentSummary(relevant=True, summary=f'summary of {item.filename}')
        for index, item in enumerate(readable, start=1)
    }
    with patch.object(model_calls, 'relevance_label', fakes.relevance_label), \
            patch.object(model_calls, 'summarise_attachments', fakes.summarise_attachments):
        yield fakes


@pytest.fixture
def lambda_context():
    context = MagicMock()
    context.function_name = 'voc-email-intake'
    context.memory_limit_in_mb = 512
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:voc-email-intake'
    context.aws_request_id = 'req-1'
    return context


def put_email(aws, name: str, key: str | None = None, raw: bytes | None = None) -> str:
    object_key = key or f'inbound/{name}'
    aws['s3'].put_object(Bucket=BUCKET, Key=object_key, Body=raw if raw is not None else fixture_bytes(name))
    return object_key


def run(aws, ctx, name: str, raw: bytes | None = None):
    key = put_email(aws, name, raw=raw)
    data = aws['s3'].get_object(Bucket=BUCKET, Key=key)['Body'].read()
    return intake.process_email(data, key, ctx)


def queued(aws) -> list[dict]:
    messages = aws['sqs'].receive_message(QueueUrl=aws['queue_url'], MaxNumberOfMessages=10).get('Messages', [])
    return [json.loads(message['Body']) for message in messages]
