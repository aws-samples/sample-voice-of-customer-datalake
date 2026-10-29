"""Small helpers shared by the engagement domain (participants + feature requests).

Ids, tokens, timestamps, bounded text fields and the 201 answer. The two stores
and their routes live in ``shared/`` (not ``lambda/api``) because an API bundle
ships ``api/<handler>.py`` plus ``shared/`` only (``createApiLambdaCode``), so a
sibling module beside the handler would be missing at cold start
(``lambda/api/test/test_api_bundle_imports.py``).

Tokens (``new_token``) are unguessable and only their sha256 is ever stored: a
token grants nothing but "unsubscribe this person" or "attribute this form answer
to this recipient". They are never sign-in credentials (docs/participants.md).
"""
from __future__ import annotations

import json
import re
import secrets
from collections.abc import Callable, Mapping
from typing import Any, Final

from aws_lambda_powertools.event_handler import Response, content_types
from botocore.exceptions import ClientError

from shared import ops_alerts
from shared.aws import is_conditional_check_failure
from shared.batch_get import batch_get_all
from shared.dimension_config import bounded_text
from shared.dynamo_values import plain
from shared.exceptions import NotFoundError, ServiceError, ValidationError
from shared.timestamps import now_iso

TOKEN_BYTES: Final = 24
ID_HEX_BYTES: Final = 8
_ID: Final = re.compile(rf'^[a-z]{{2,4}}_[0-9a-f]{{{ID_HEX_BYTES * 2}}}\Z')
_MAX_ID_CHARS: Final = 32


def new_id(prefix: str) -> str:
    """``{prefix}_{16 hex}`` (``per_``, ``lst_``, ``ask_``, ``fr_``, ``sup_``)."""
    return f'{prefix}_{secrets.token_hex(ID_HEX_BYTES)}'


def is_id(value: object, prefix: str) -> bool:
    return isinstance(value, str) and value.startswith(f'{prefix}_') and bool(_ID.match(value))


def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def normalize_email(raw: object) -> tuple[str, str]:
    """``(email as given but trimmed, lower-cased)``; ValueError('invalid_email') otherwise.

    The address rule is ``shared.ops_alerts.normalize_email``'s (alert recipients), one rule app-wide.
    """
    email = raw.strip() if isinstance(raw, str) else ''
    try:
        email_lc = ops_alerts.normalize_email(email)
    except ValidationError as exc:
        raise ValueError('invalid_email') from exc
    return email, email_lc


def optional_text(body: Mapping[str, Any], field: str, limit: int) -> str:
    """The trimmed string at ``field`` ('' when absent or null); 400 when not a string or too long."""
    try:
        return bounded_text(body, field, limit, field)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def required_text(body: Mapping[str, Any], field: str, limit: int) -> str:
    value = optional_text(body, field, limit)
    if not value:
        raise ValidationError(f'{field} is required')
    return value


def string_list(value: object, field: str, *, max_items: int, max_chars: int) -> list[str]:
    """A de-duplicated list of short trimmed strings (order kept); 400 for anything else."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > max_items:
        raise ValidationError(f'{field} must be a list of at most {max_items} strings')
    out: list[str] = []
    for entry in value:
        if not isinstance(entry, str) or len(entry.strip()) > max_chars:
            raise ValidationError(f'{field} entries must be strings of at most {max_chars} characters')
        text = entry.strip()
        if text and text not in out:
            out.append(text)
    return out


def id_list(value: object, field: str, prefix: str, max_items: int) -> list[str]:
    """A de-duplicated list of ids with ``prefix``; 400 for anything else."""
    ids = string_list(value, field, max_items=max_items, max_chars=_MAX_ID_CHARS)
    if any(not is_id(entry, prefix) for entry in ids):
        raise ValidationError(f'{field} must hold {prefix}_ ids')
    return ids


def conditional_write(write: Callable[..., Any], **request: Any) -> bool:
    """``write(**request)`` (a conditional update/put); False when DynamoDB refused the condition."""
    try:
        write(**request)
    except ClientError as error:
        if is_conditional_check_failure(error):
            return False
        raise
    return True


def rows_by_id(table: Any, keys: list[dict[str, str]], id_field: str, noun: str) -> dict[str, dict[str, Any]]:
    """``{row[id_field]: row}`` for the ``keys`` that exist (a strongly consistent BatchGetItem)."""
    rows = batch_get_all(table, keys, failure=ServiceError(f'Could not read the {noun}. Please retry.'))
    return {row[id_field]: row for row in rows if isinstance(row.get(id_field), str)}


def update_existing(table: Any, key: Mapping[str, str], fields: Mapping[str, Any], missing: str, *,
                    bump_version: bool = False) -> dict[str, Any]:
    """SET ``fields`` (+ ``updated_at``) on an existing row; NotFoundError(``missing``) when it is gone.

    ``bump_version`` also adds 1 to the row's ``version`` (rows written with a version condition).
    """
    names = {f'#f{i}': field for i, field in enumerate(fields)}
    values: dict[str, Any] = {f':v{i}': value for i, value in enumerate(fields.values())}
    sets = [f'#f{i} = :v{i}' for i in range(len(fields))]
    expression = 'SET ' + ', '.join([*sets, '#updated = :now'])
    if bump_version:
        expression += ' ADD version :one'
        values[':one'] = 1
    try:
        response = table.update_item(
            Key=dict(key),
            UpdateExpression=expression,
            ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeNames={**names, '#updated': 'updated_at'},
            ExpressionAttributeValues={**values, ':now': now_iso()},
            ReturnValues='ALL_NEW',
        )
    except ClientError as error:
        if is_conditional_check_failure(error):
            raise NotFoundError(missing) from error
        raise
    return response['Attributes']


def created(body: Mapping[str, Any], status_code: int = 201) -> Response:
    """A JSON answer with ``status_code`` (201 Created, or 202 Accepted)."""
    return Response(status_code=status_code, content_type=content_types.APPLICATION_JSON,
                    body=json.dumps(plain(dict(body))))


def public_fields(item: Mapping[str, Any], hidden: frozenset[str]) -> dict[str, Any]:
    """``item`` JSON-safe, without its keys and the ``hidden`` attributes."""
    return {key: plain(value) for key, value in item.items()
            if key not in hidden and key not in ('pk', 'sk', 'gsi1pk', 'gsi1sk')}
