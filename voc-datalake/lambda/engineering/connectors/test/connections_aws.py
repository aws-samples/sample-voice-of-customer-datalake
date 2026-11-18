"""Test support for the connections' specs (test_connections.py, test_github_apps.py): under moto, the connections'
table, SSM and a KMS key for their parameters."""
from __future__ import annotations

from typing import Any

import boto3


def connections_aws(table_name: str) -> tuple[Any, Any, str]:
    """Under moto: the connections' table (``table_name``), SSM, and a KMS key's ARN for its parameters."""
    table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName=table_name, BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                              {'AttributeName': 'sk', 'AttributeType': 'S'}])
    key_id = boto3.client('kms', region_name='us-east-1').create_key()['KeyMetadata']['Arn']
    return table, boto3.client('ssm', region_name='us-east-1'), key_id
