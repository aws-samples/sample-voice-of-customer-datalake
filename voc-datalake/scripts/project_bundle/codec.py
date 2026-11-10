"""DynamoDB item values <-> JSON, losslessly.

DynamoDB numbers are `Decimal`, and JSON has only binary floats, which DynamoDB rejects on
write. An integral number is written as a JSON int; any other number as
`{"__decimal__": "<exact text>"}` (the sentinel from PR #429's exporter), so no value goes
through a float. String / number / binary sets and binary values get their own sentinels.
"""
from __future__ import annotations

import base64
import json
from decimal import Decimal
from typing import Any, SupportsBytes

from boto3.dynamodb.types import Binary

_DECIMAL = '__decimal__'
_BINARY = '__binary__'
_SET = '__set__'


def encode(value: Any) -> Any:
    """A JSON-safe copy of one DynamoDB (boto3 resource) value."""
    if isinstance(value, bool) or value is None or isinstance(value, str | int):
        return value
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else {_DECIMAL: str(value)}
    if isinstance(value, Binary) and isinstance(value, SupportsBytes):
        # Binary's `__bytes__` hands back its wrapped value (as in shared/memory_store.py).
        return encode(value.__bytes__())
    if isinstance(value, bytes | bytearray):
        return {_BINARY: base64.b64encode(bytes(value)).decode('ascii')}
    if isinstance(value, set | frozenset):
        return {_SET: sorted((encode(member) for member in value), key=json.dumps)}
    if isinstance(value, dict):
        return {str(key): encode(member) for key, member in value.items()}
    if isinstance(value, list | tuple):
        return [encode(member) for member in value]
    if isinstance(value, float):
        return encode(Decimal(str(value)))
    raise TypeError(f'cannot export a {type(value).__name__} value')


def _decode_sentinel(value: dict[str, Any]) -> Any:
    if _DECIMAL in value:
        return Decimal(value[_DECIMAL])
    if _BINARY in value:
        return Binary(base64.b64decode(value[_BINARY]))
    return {decode(member) for member in value[_SET]}


def decode(value: Any) -> Any:
    """The DynamoDB-ready value `encode` produced (a stray float becomes an exact Decimal)."""
    if isinstance(value, dict):
        if len(value) == 1 and next(iter(value)) in (_DECIMAL, _BINARY, _SET):
            return _decode_sentinel(value)
        return {key: decode(member) for key, member in value.items()}
    if isinstance(value, list):
        return [decode(member) for member in value]
    if isinstance(value, float):
        return Decimal(str(value))
    return value
