"""Fast decoding of the item lists in DynamoDB read responses (a CPU optimisation).

For a DynamoDB resource (``boto3.resource('dynamodb')``) botocore parses every
response against the service model, one ``AttributeValue`` structure at a time,
and boto3 then walks the parsed response a second time to turn ``{'S': 'x'}`` into
``'x'``. On a read of a few thousand reviews that model-driven walk is most of the
request's CPU (measured: about 80 % of ``/feedback`` with a filter).

:func:`install` hooks the resource's client so that, for ``Query``, ``Scan`` and
``BatchGetItem``, the item list is lifted out of the JSON body before botocore
parses it, decoded in one pass (C ``json.loads`` plus :func:`deserialize`), and put
back after boto3's own transform has run. Everything else in the response
(``Count``, ``LastEvaluatedKey``, ``UnprocessedKeys``, ``ConsumedCapacity``, the
metadata) still goes through botocore and boto3 unchanged.

The values are exactly what ``boto3.dynamodb.types.TypeDeserializer`` returns:
numbers are ``Decimal`` in boto3's ``DYNAMODB_CONTEXT``, binaries ``Binary``, sets
``set``. ``test_dynamodb_fast_items.py`` pins that equality for every type.

Only for a client whose responses boto3 deserializes (a resource's
``meta.client``): a plain ``boto3.client('dynamodb')`` returns wire types, and
installing there would change what its callers receive.
"""
from __future__ import annotations

import base64
import json
from collections.abc import Callable, Mapping, MutableMapping
from typing import Any, Final

from boto3.dynamodb.types import DYNAMODB_CONTEXT, Binary

# Where the decoded items wait between the two hooks; never a modeled member, so
# neither botocore's parser nor boto3's transform looks at it.
STASH_KEY: Final = '_voc_fast_items'
UNIQUE_ID: Final = 'voc-dynamodb-fast-items'
_SUCCESS_MAX: Final = 300

_create_decimal = DYNAMODB_CONTEXT.create_decimal


def _decode_binary(value: str) -> Binary:
    return Binary(base64.b64decode(value))


def _decode_map(value: Mapping[str, Any]) -> dict[str, Any]:
    return {name: deserialize(attr) for name, attr in value.items()}


def _decode_list(value: list[Any]) -> list[Any]:
    return [deserialize(attr) for attr in value]


_DECODERS: Final[dict[str, Callable[[Any], Any]]] = {
    'N': _create_decimal,
    'B': _decode_binary,
    'BOOL': lambda value: value,
    'NULL': lambda _value: None,
    'M': _decode_map,
    'L': _decode_list,
    'SS': set,
    'NS': lambda values: {_create_decimal(v) for v in values},
    'BS': lambda values: {_decode_binary(v) for v in values},
}


def deserialize(attr: Mapping[str, Any]) -> Any:
    """One wire ``AttributeValue`` (as JSON-decoded) to its Python value, as boto3 decodes it."""
    if len(attr) != 1:
        raise TypeError('An AttributeValue carries exactly one type')
    (kind, value), = attr.items()
    if kind == 'S':
        return value
    decoder = _DECODERS.get(kind)
    if decoder is None:
        raise TypeError(f'Unknown DynamoDB type {kind!r}')
    return decoder(value)


def decode_item(item: Mapping[str, Any]) -> dict[str, Any]:
    """One wire item (``{name: AttributeValue}``) to a native dict."""
    return {name: deserialize(attr) for name, attr in item.items()}


def _lift(response_dict: MutableMapping[str, Any], pick: Callable[[dict[str, Any]], Any]) -> Any:
    """Remove the item list ``pick`` pops from a success body; the rest stays for botocore."""
    if not 200 <= int(response_dict.get('status_code') or 0) < _SUCCESS_MAX:
        return None
    body = response_dict.get('body')
    if not isinstance(body, (bytes, bytearray)) or not body:
        return None
    try:
        document = json.loads(body)
    except ValueError:
        return None
    if not isinstance(document, dict):
        return None
    lifted = pick(document)
    if lifted is None:
        return None
    response_dict['body'] = json.dumps(document).encode()
    return lifted


def _pop_items(document: dict[str, Any]) -> list[dict[str, Any]] | None:
    items = document.pop('Items', None)
    return [decode_item(item) for item in items] if isinstance(items, list) else None


def _pop_responses(document: dict[str, Any]) -> dict[str, list[dict[str, Any]]] | None:
    responses = document.pop('Responses', None)
    if not isinstance(responses, dict):
        return None
    return {table: [decode_item(item) for item in items] for table, items in responses.items()}


def _lifter(name: str, pop: Callable[[dict[str, Any]], Any]) -> Callable[..., None]:
    """A ``before-parse`` handler that stashes the decoded ``name`` member of a success body."""
    def handler(response_dict: MutableMapping[str, Any], customized_response_dict: MutableMapping[str, Any],
                **_kwargs: Any) -> None:
        lifted = _lift(response_dict, pop)
        if lifted is not None:
            customized_response_dict[STASH_KEY] = (name, lifted)
    return handler


_lift_items: Final = _lifter('Items', _pop_items)
_lift_responses: Final = _lifter('Responses', _pop_responses)


def _restore(parsed: MutableMapping[str, Any] | None = None, **_kwargs: Any) -> None:
    """Put the decoded list back under its own name (runs after boto3's transform)."""
    if not isinstance(parsed, MutableMapping):
        return
    stashed = parsed.pop(STASH_KEY, None)
    if stashed is not None:
        name, value = stashed
        parsed[name] = value


def install(client: Any) -> None:
    """Hook a DynamoDB RESOURCE's client (``resource.meta.client``); idempotent."""
    events = client.meta.events
    for operation in ('Query', 'Scan'):
        events.register(f'before-parse.dynamodb.{operation}', _lift_items, unique_id=f'{UNIQUE_ID}-{operation}')
    events.register('before-parse.dynamodb.BatchGetItem', _lift_responses, unique_id=f'{UNIQUE_ID}-BatchGetItem')
    # LAST on the same event boto3's output transform uses, so the decoded items are
    # put back only after that transform has walked (and skipped) the response.
    events.register_last('after-call.dynamodb', _restore, unique_id=f'{UNIQUE_ID}-restore')
