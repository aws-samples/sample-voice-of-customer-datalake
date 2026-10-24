"""Moto tables shared by the Radar suites (processor routing, release scan)."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

import boto3

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.type_defs import AttributeDefinitionTypeDef, KeySchemaElementTypeDef

_HASH: KeySchemaElementTypeDef = {'AttributeName': 'pk', 'KeyType': 'HASH'}
_RANGE: KeySchemaElementTypeDef = {'AttributeName': 'sk', 'KeyType': 'RANGE'}
_ATTRIBUTES: list[AttributeDefinitionTypeDef] = [
    {'AttributeName': name, 'AttributeType': 'S'} for name in ('pk', 'sk')
]


def radar_pk_sk_table(name: str) -> Any:
    """A (pk, sk) on-demand table, the shape of voc-radar and voc-aggregates. Call inside ``mock_aws()``."""
    return boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName=name, BillingMode='PAY_PER_REQUEST', KeySchema=[_HASH, _RANGE], AttributeDefinitions=_ATTRIBUTES)
