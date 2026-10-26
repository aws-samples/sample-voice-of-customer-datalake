"""Teach moto DynamoDB rules it does not enforce.

1. Real DynamoDB rejects a Query whose ``FilterExpression`` names a key attribute of
the table (or of the index being queried) with ``ValidationException: Filter
Expression can only contain non-primary key attributes``. moto 5 accepts the same
request and filters in memory, so a handler can pass every moto test and still
answer 502 in production — which is exactly how ``GET /memory?scope=personal`` and
``GET /memory/review`` shipped broken (an ``Attr('sk').begins_with(...)`` filter).

``install`` wraps moto's ``DynamoHandler.query`` so the server side of every
moto-backed Query applies the rule and answers the same ``ValidationException`` a
real table would. It inspects the WIRE request (after boto3 rendered any ``Attr``
condition into ``#n0``-style placeholders), so it judges what DynamoDB judges.
The root ``lambda/conftest.py`` installs it for the whole backend suite.

2. Real DynamoDB rejects an EMPTY ``ExpressionAttributeNames`` / ``Values`` map on any
request; moto accepts it. That is how agent "Run now" shipped answering 500 (E2E s2 F3).
"""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from moto.dynamodb.exceptions import MockValidationException
from moto.dynamodb.responses import DynamoHandler

_VALUE_PLACEHOLDER_RE = re.compile(r':[A-Za-z0-9_]+')
_TOKEN_RE = re.compile(r'#?[A-Za-z_][A-Za-z0-9_]*')
_KEYWORDS = frozenset({'and', 'or', 'not', 'between', 'in'})


def _is_top_level_name(text: str, match: re.Match[str]) -> bool:
    """A path's first segment: not after ``.`` (``a.b`` filters on ``a``), not a ``fn(``."""
    if match.start() > 0 and text[match.start() - 1] == '.':
        return False
    if text[match.end():].lstrip().startswith('('):
        return False
    return match.group().lower() not in _KEYWORDS


def filter_attribute_names(expression: str, names: Mapping[str, str]) -> set[str]:
    """Top-level attribute names a filter/condition expression references."""
    text = _VALUE_PLACEHOLDER_RE.sub(' ', expression)
    found: set[str] = set()
    for match in _TOKEN_RE.finditer(text):
        if _is_top_level_name(text, match):
            token = match.group()
            found.add(names.get(token, token) if token.startswith('#') else token)
    return found


def key_attributes(schema: Sequence[Mapping[str, Any]]) -> set[str]:
    return {str(element['AttributeName']) for element in schema}


def check_query(body: Mapping[str, Any], schema: Sequence[Mapping[str, Any]]) -> None:
    """Raise the ValidationException DynamoDB raises for a key attribute in a Query filter."""
    expression = body.get('FilterExpression')
    if not isinstance(expression, str) or not expression:
        return
    raw_names = body.get('ExpressionAttributeNames') or {}
    names = {str(k): str(v) for k, v in raw_names.items()} if isinstance(raw_names, Mapping) else {}
    offending = sorted(filter_attribute_names(expression, names) & key_attributes(schema))
    if offending:
        raise MockValidationException(
            'Filter Expression can only contain non-primary key attributes: '
            f'Primary key attribute: {offending[0]}'
        )


def _empty_map_error(body: Mapping[str, Any]) -> str | None:
    for key in ('ExpressionAttributeNames', 'ExpressionAttributeValues'):
        if key in body and isinstance(body[key], Mapping) and not body[key]:
            return f'{key} must not be empty'
    return None


def check_expression_maps(body: Mapping[str, Any]) -> None:
    """Raise what DynamoDB raises for an EMPTY ``ExpressionAttributeNames``/``Values`` map.

    moto accepts ``ExpressionAttributeNames={}``; DynamoDB answers ``ValidationException:
    ExpressionAttributeNames must not be empty`` — which made every agent Run now answer
    500 in production (``agents_store._run_update``). Checked on the request itself and on
    each item of a ``TransactWriteItems``.
    """
    bodies: list[Mapping[str, Any]] = [body]
    for item in body.get('TransactItems') or []:
        if isinstance(item, Mapping):
            bodies += [op for op in item.values() if isinstance(op, Mapping)]
    for each in bodies:
        message = _empty_map_error(each)
        if message is not None:
            raise MockValidationException(message)


_EXPRESSION_ACTIONS = ('put_item', 'delete_item', 'update_item', 'scan', 'transact_write_items')


def _with_map_check(original):
    """Wrap one moto DynamoHandler action so its wire request is checked first."""
    def strict(self: DynamoHandler):
        check_expression_maps(self.body if isinstance(self.body, Mapping) else {})
        return original(self)
    return strict


def install(monkeypatch) -> None:
    """Make every moto request enforce the rules above for one test."""
    original = DynamoHandler.query

    def strict_query(self: DynamoHandler):
        body = self.body if isinstance(self.body, Mapping) else {}
        check_expression_maps(body)
        table_name = body.get('TableName')
        if isinstance(table_name, str):
            schema = self.dynamodb_backend.get_schema(table_name=table_name, index_name=body.get('IndexName'))
            check_query(body, schema)
        return original(self)

    monkeypatch.setattr(DynamoHandler, 'query', strict_query)
    for action in _EXPRESSION_ACTIONS:
        monkeypatch.setattr(DynamoHandler, action, _with_map_check(getattr(DynamoHandler, action)))
