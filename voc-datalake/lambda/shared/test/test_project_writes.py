"""DynamoDB-level contracts for retained project tombstones."""

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.project_writes import (
    put_project_item,
    put_project_item_and_increment,
)


@pytest.fixture
def projects_table():
    with mock_aws():
        table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='test-project-writes',
            KeySchema=[
                {'AttributeName': 'pk', 'KeyType': 'HASH'},
                {'AttributeName': 'sk', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'pk', 'AttributeType': 'S'},
                {'AttributeName': 'sk', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST',
        )
        table.put_item(Item={
            'pk': 'PROJECT#p1',
            'sk': 'META',
            'status': 'deleted',
            'deletion_started_at': '2026-09-03T12:00:00+00:00',
            'document_count': 0,
        })
        yield table


@pytest.mark.parametrize('writer', ['child_only', 'child_and_count'])
def test_retained_tombstone_rejects_project_child_creation(projects_table, writer):
    item = {
        'pk': 'PROJECT#p1',
        'sk': 'DOC#new',
        'document_id': 'new',
        'created_at': '2026-09-03T12:01:00+00:00',
    }

    with pytest.raises(ClientError):
        if writer == 'child_only':
            put_project_item(projects_table, 'p1', item)
        else:
            put_project_item_and_increment(
                projects_table, 'p1', item, 'document_count',
            )

    assert projects_table.get_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'DOC#new'}, ConsistentRead=True,
    ).get('Item') is None
    tombstone = projects_table.get_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'META'}, ConsistentRead=True,
    )['Item']
    assert tombstone['status'] == 'deleted'
    assert tombstone['document_count'] == 0
