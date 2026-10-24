"""shared.dynamodb_fast_items: the fast item decode returns exactly what boto3 returns."""
from __future__ import annotations

import base64
from decimal import Decimal

import boto3
import pytest
from boto3.dynamodb.conditions import Attr, Key
from boto3.dynamodb.types import Binary, TypeDeserializer, TypeSerializer
from moto import mock_aws

from shared import dynamodb_fast_items as fast

# Every DynamoDB type, nested, plus numbers at the edge of boto3's decimal context.
RICH_ITEM = {
    'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#a1', 'gsi1pk': 'DATE#2026-10-01',
    'text': 'Example Air lost my bag', 'empty': '',
    'score': Decimal('-0.75'), 'big': Decimal('12345678901234567890123456789012345678'),
    'tiny': Decimal('1E-120'), 'whole': Decimal('42'), 'zero_point': Decimal('0.000'),
    'flag': True, 'off': False, 'nothing': None,
    # Plain bytes in, `Binary` out: boto3's Binary compares and hashes equal to its bytes.
    'blob': b'\x00\xffacme', 'blobs': {b'a', b'\x01'},
    'names': {'acme', 'example'}, 'numbers': {Decimal('1'), Decimal('2.5')},
    'nested': {'list': [Decimal('1'), 'two', {'three': [None, True]}], 'map': {}},
    'empty_list': [],
}


def _wire(item: dict) -> dict:
    """The item as DynamoDB's JSON wire format (binaries base64, as on the wire)."""
    serializer = TypeSerializer()

    def to_json(value):
        if isinstance(value, dict):
            return {k: to_json(v) for k, v in value.items()}
        if isinstance(value, list):
            return [to_json(v) for v in value]
        if isinstance(value, (bytes, bytearray)):
            return base64.b64encode(value).decode()
        return value

    def wire_attr(value):
        (kind, raw), = serializer.serialize(value).items()
        if kind == 'M':
            return {'M': {k: wire_attr(v) for k, v in value.items()}}
        if kind == 'L':
            return {'L': [wire_attr(v) for v in value]}
        if kind in ('SS', 'NS', 'BS') and isinstance(raw, (list, set)):
            return {kind: [to_json(v) for v in raw]}
        return {kind: to_json(raw)}

    return {name: wire_attr(value) for name, value in item.items()}


def _boto3_decoded(item: dict) -> dict:
    """What boto3 returns for the item: botocore's decoding (base64 -> bytes), then TypeDeserializer."""
    deserializer = TypeDeserializer()

    def botocore_like(attr):
        (kind, value), = attr.items()
        if kind == 'B':
            return {'B': base64.b64decode(value)}
        if kind == 'BS':
            return {'BS': [base64.b64decode(v) for v in value]}
        if kind == 'M':
            return {'M': {k: botocore_like(v) for k, v in value.items()}}
        if kind == 'L':
            return {'L': [botocore_like(v) for v in value]}
        return attr

    return {name: deserializer.deserialize(botocore_like(attr)) for name, attr in item.items()}


def test_every_type_decodes_exactly_as_boto3_decodes_it():
    wire = _wire(RICH_ITEM)
    decoded = fast.decode_item(wire)
    assert decoded == _boto3_decoded(wire) == RICH_ITEM
    assert type(decoded['big']) is Decimal
    assert str(decoded['big']) == str(RICH_ITEM['big'])
    assert str(decoded['zero_point']) == '0.000'
    assert isinstance(decoded['blob'], Binary)
    assert isinstance(decoded['names'], set)


def test_an_unknown_or_ambiguous_attribute_value_is_refused():
    with pytest.raises(TypeError):
        fast.deserialize({'X': 'unknown'})
    with pytest.raises(TypeError):
        fast.deserialize({'S': 'a', 'N': '1'})


@pytest.fixture
def tables():
    """Two resources on one moto backend: one plain, one with the fast decode installed."""
    with mock_aws():
        plain = boto3.resource('dynamodb', region_name='us-east-1')
        hooked = boto3.resource('dynamodb', region_name='us-east-1')
        fast.install(hooked.meta.client)
        fast.install(hooked.meta.client)  # idempotent
        plain.create_table(
            TableName='voc-feedback-test', BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': n, 'AttributeType': 'S'} for n in ('pk', 'sk', 'gsi1pk')],
            GlobalSecondaryIndexes=[{'IndexName': 'gsi1-by-date', 'Projection': {'ProjectionType': 'ALL'},
                                     'KeySchema': [{'AttributeName': 'gsi1pk', 'KeyType': 'HASH'},
                                                   {'AttributeName': 'sk', 'KeyType': 'RANGE'}]}],
        )
        with plain.Table('voc-feedback-test').batch_writer() as batch:
            for n in range(30):
                batch.put_item(Item={**RICH_ITEM, 'sk': f'FEEDBACK#{n:03d}', 'n': Decimal(n)})
        yield plain.Table('voc-feedback-test'), hooked.Table('voc-feedback-test')


def _without_metadata(response: dict) -> dict:
    return {k: v for k, v in response.items() if k != 'ResponseMetadata'}


def test_query_pages_are_identical_with_the_fast_decode(tables, monkeypatch):
    plain, hooked = tables
    decoded = []
    real_decode = fast.decode_item
    monkeypatch.setattr(fast, 'decode_item', lambda item: decoded.append(1) or real_decode(item))
    kwargs = {'IndexName': 'gsi1-by-date', 'KeyConditionExpression': Key('gsi1pk').eq('DATE#2026-10-01'),
              'Limit': 7, 'ScanIndexForward': False, 'FilterExpression': Attr('n').gte(3)}
    pages = 0
    while True:
        expected, actual = plain.query(**kwargs), hooked.query(**kwargs)
        assert _without_metadata(actual) == _without_metadata(expected)
        # Same attribute ORDER too, so a serialized body is byte-identical.
        assert [list(item) for item in actual['Items']] == [list(item) for item in expected['Items']]
        assert fast.STASH_KEY not in actual
        pages += 1
        if 'LastEvaluatedKey' not in expected:
            break
        kwargs['ExclusiveStartKey'] = expected['LastEvaluatedKey']
    assert pages > 1
    assert len(decoded) == 27  # the hooked resource really took the fast path (n >= 3)


def test_projected_queries_counts_and_scans_are_identical_with_the_fast_decode(tables):
    plain, hooked = tables
    projected = {'KeyConditionExpression': Key('pk').eq('SOURCE#webscraper'), 'ProjectionExpression': 'sk, #b, nested',
                 'ExpressionAttributeNames': {'#b': 'blob'}}
    assert _without_metadata(hooked.query(**projected)) == _without_metadata(plain.query(**projected))
    counted = {'KeyConditionExpression': Key('pk').eq('SOURCE#webscraper'), 'Select': 'COUNT'}
    assert _without_metadata(hooked.query(**counted)) == _without_metadata(plain.query(**counted))
    assert _without_metadata(hooked.scan(Limit=5)) == _without_metadata(plain.scan(Limit=5))


def test_batch_get_and_get_item_are_identical_with_the_fast_decode(tables):
    plain, hooked = tables
    keys = [{'pk': 'SOURCE#webscraper', 'sk': f'FEEDBACK#{n:03d}'} for n in (4, 1, 29)]
    request = {plain.name: {'Keys': keys}}
    expected = plain.meta.client.batch_get_item(RequestItems=request)
    actual = hooked.meta.client.batch_get_item(RequestItems=request)
    assert _without_metadata(actual) == _without_metadata(expected)
    assert len(actual['Responses'][plain.name]) == 3
    assert hooked.get_item(Key=keys[0])['Item'] == plain.get_item(Key=keys[0])['Item']


def test_an_error_response_is_left_to_botocore(tables):
    _plain, hooked = tables
    with pytest.raises(hooked.meta.client.exceptions.ResourceNotFoundException):
        hooked.meta.client.query(TableName='voc-missing', KeyConditionExpression='pk = :p',
                                 ExpressionAttributeValues={':p': 'x'})
