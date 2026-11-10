"""`get_dynamodb_resource` hands every Lambda a resource whose reads use the one-pass item decode (5.27.00).

The decode used to be installed by the metrics Lambda alone; it now lives in the shared getter, so a
regression that drops it (or installs it twice per call) would silently bring back the per-attribute
parse for every Lambda. The values themselves are pinned by test_dynamodb_fast_items.py.
"""
from __future__ import annotations

from decimal import Decimal
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

from shared import aws, concurrency, dynamodb_fast_items


@pytest.fixture
def fresh_resource(monkeypatch):
    """No cached resource and a moto backend; monkeypatch restores the module's cache afterwards."""
    monkeypatch.setattr(aws, '_dynamodb_resource', None)
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    with mock_aws():
        yield


@pytest.mark.usefixtures('fresh_resource')
def test_query_items_are_decoded_by_the_fast_path_with_native_values():
    resource = aws.get_dynamodb_resource()
    table = resource.create_table(
        TableName='t', BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'}, {'AttributeName': 'sk', 'AttributeType': 'S'}],
    )
    table.put_item(Item={'pk': 'P', 'sk': '1', 'n': Decimal('1.5'), 'tags': {'a', 'b'}, 'm': {'x': [True, None]}})

    with patch.object(dynamodb_fast_items, 'decode_item', wraps=dynamodb_fast_items.decode_item) as decode:
        items = table.query(KeyConditionExpression='pk = :p', ExpressionAttributeValues={':p': 'P'})['Items']

    assert decode.call_count == 1
    assert items == [{'pk': 'P', 'sk': '1', 'n': Decimal('1.5'), 'tags': {'a', 'b'}, 'm': {'x': [True, None]}}]


@pytest.mark.usefixtures('fresh_resource')
def test_the_resource_is_built_and_hooked_once_per_environment():
    with patch.object(dynamodb_fast_items, 'install', wraps=dynamodb_fast_items.install) as install, \
            patch.object(boto3, 'resource', wraps=boto3.resource) as build:
        first = aws.get_dynamodb_resource()
        second = aws.get_dynamodb_resource()

    assert first is second
    assert (build.call_count, install.call_count) == (1, 1)


@pytest.mark.usefixtures('fresh_resource')
def test_the_connection_pool_holds_every_read_a_request_fans_out_at_once():
    """5.35.02 e2e: botocore's default pool (10) was below the metrics fan-out, which logged
    "Connection pool is full, discarding connection" and re-handshook on the next request."""
    pool = getattr(aws.get_dynamodb_resource().meta.client.meta.config, 'max_pool_connections', None)

    nested_fan_out = concurrency.MAX_CONCURRENT_CALLS * concurrency.DEFAULT_MAX_WORKERS
    assert pool == aws.DYNAMODB_MAX_POOL_CONNECTIONS == nested_fan_out
    assert isinstance(pool, int)
    assert pool > 10
