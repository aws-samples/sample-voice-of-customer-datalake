"""Shared builders for the aggregator tests."""
from decimal import Decimal
from typing import TYPE_CHECKING, Any, cast

from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord
from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from botocore.exceptions import _ClientErrorResponseTypeDef


def conditional_check_failure(item: dict | None = None, operation: str = 'UpdateItem') -> ClientError:
    """A ``ConditionalCheckFailedException`` as DynamoDB raises it.

    ``item`` is the ALL_OLD image DynamoDB returns beside the error when the
    request asked for ``ReturnValuesOnConditionCheckFailure`` — in the wire shape,
    because the resource layer does not deserialise it on a ClientError. Omit it for
    a refusal that carries no item (there was no row).

    The cast is for the stubs, not the value: botocore-stubs'
    ``_ClientErrorResponseTypeDef`` does not model the top-level ``Item`` key that
    DynamoDB really sends, so a faithful response cannot satisfy it.
    """
    response: dict[str, Any] = {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'no'}}
    if item is not None:
        response['Item'] = item
    error_response: _ClientErrorResponseTypeDef = cast('_ClientErrorResponseTypeDef', response)
    return ClientError(error_response, operation)


def to_stream_image(item: dict) -> dict:
    """Serialize a plain dict the way a stream image arrives."""
    out = {}
    for key, value in item.items():
        if isinstance(value, bool):
            out[key] = {'BOOL': value}
        elif isinstance(value, (int, float, Decimal)):
            out[key] = {'N': str(value)}
        else:
            out[key] = {'S': str(value)}
    return out


def stream_record(event_name: str, *, new=None, old=None, user_identity=None,
                  event_id=None) -> DynamoDBRecord:
    """A real Powertools stream record, not a MagicMock.

    A MagicMock answers any attribute, so `record.user_identity` on one would be
    a truthy mock and the TTL branch could never be exercised honestly.

    `event_id` is the stream's own `eventID`, which the aggregator claims to make an
    arrival idempotent (issue #264). OMITTED BY DEFAULT, and that default is a
    statement about what most tests are for: they ask which counters a given event
    moves, and a dedupe claim would make the SECOND record built by a test — a
    redelivery as far as the handler is concerned — write nothing, so every such test
    would be measuring the claim instead of the dimensions. A record with no id routes
    to the non-transactional path, exactly as it does in production when
    `IDEMPOTENCY_TABLE` is unset. The idempotency behaviour has its own class in
    test_handler.py, where the id is passed explicitly.
    """
    body: dict = {'eventName': event_name, 'eventSource': 'aws:dynamodb', 'dynamodb': {}}
    if new is not None:
        body['dynamodb']['NewImage'] = to_stream_image(new)
    if old is not None:
        body['dynamodb']['OldImage'] = to_stream_image(old)
    if user_identity is not None:
        body['userIdentity'] = user_identity
    if event_id is not None:
        body['eventID'] = event_id
    return DynamoDBRecord(body)
