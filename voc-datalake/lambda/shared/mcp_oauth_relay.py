"""Single-use relay rows of the MCP OAuth loopback relay (docs/mcp.md → "OAuth sign-in").

Cognito matches callback URLs exactly, while a desktop MCP client listens on a random loopback port
(RFC 8252 §7.3). So Cognito only ever sees ONE callback, ``<api>/oauth/callback``, and two short-lived
rows in the jobs table (it has a ``ttl`` attribute; the projects table has none) carry the rest:

* ``MCPOAUTH#RELAY#<relay id>`` — written by the consent API: the client, its loopback redirect URI and
  its own ``state``. The relay id (256 bits) is the ``state`` Cognito echoes to ``/oauth/callback``.
* ``MCPOAUTH#CODE#<sha256(code)>`` — written by ``/oauth/callback``: which client and loopback URI the
  code was delivered to, so ``/oauth/token`` can check both and put the relay URL back as
  ``redirect_uri`` (the one Cognito issued the code for). The code itself is never stored.

Both are CONSUMED by a DeleteItem returning the old row (one atomic step: a second use finds nothing),
and both expire after ``RELAY_TTL_MINUTES`` — checked here too, because DynamoDB's TTL deletion lags.
The tokens role may Put/Delete these partitions only (``MCPOAUTH#*``, pinned in api-stack-mcp-global.test.ts).
"""

from __future__ import annotations

import hashlib
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Final

PARTITION_PREFIX: Final = 'MCPOAUTH#'
RELAY_TTL_MINUTES: Final = 10
_SK: Final = 'RELAY'
_RELAY_ID: Final = re.compile(r'^[A-Za-z0-9_-]{43}\Z')
MAX_CODE_LENGTH: Final = 2048


@dataclass(frozen=True)
class Delivery:
    client_id: str
    redirect_uri: str
    state: str | None


def new_relay_id() -> str:
    return secrets.token_urlsafe(32)


def is_relay_id(value: object) -> bool:
    return isinstance(value, str) and bool(_RELAY_ID.fullmatch(value))


def _code_pk(code: str) -> str:
    return f'{PARTITION_PREFIX}CODE#{hashlib.sha256(code.encode()).hexdigest()}'


def _relay_pk(relay_id: str) -> str:
    return f'{PARTITION_PREFIX}RELAY#{relay_id}'


def _expiring(pk: str, delivery: Delivery, now: datetime) -> dict[str, Any]:
    item: dict[str, Any] = {
        'pk': pk, 'sk': _SK, 'client_id': delivery.client_id, 'redirect_uri': delivery.redirect_uri,
        'ttl': int((now + timedelta(minutes=RELAY_TTL_MINUTES)).timestamp()),
    }
    if delivery.state is not None:
        item['state'] = delivery.state
    return item


def _consume(table: Any, pk: str, now: datetime) -> Delivery | None:
    old = table.delete_item(Key={'pk': pk, 'sk': _SK}, ReturnValues='ALL_OLD').get('Attributes')
    if not isinstance(old, dict):
        return None
    ttl, client_id, redirect_uri = old.get('ttl'), old.get('client_id'), old.get('redirect_uri')
    if not isinstance(client_id, str) or not isinstance(redirect_uri, str) or int(ttl or 0) <= now.timestamp():
        return None
    state = old.get('state')
    return Delivery(client_id=client_id, redirect_uri=redirect_uri, state=state if isinstance(state, str) else None)


def store_relay(table: Any, relay_id: str, delivery: Delivery, now: datetime) -> None:
    table.put_item(Item=_expiring(_relay_pk(relay_id), delivery, now), ConditionExpression='attribute_not_exists(pk)')


def consume_relay(table: Any, relay_id: str, now: datetime) -> Delivery | None:
    return _consume(table, _relay_pk(relay_id), now) if is_relay_id(relay_id) else None


def store_code_binding(table: Any, code: str, delivery: Delivery, now: datetime) -> None:
    table.put_item(Item=_expiring(_code_pk(code), Delivery(delivery.client_id, delivery.redirect_uri, None), now))


def consume_code_binding(table: Any, code: str, now: datetime) -> Delivery | None:
    if not code or len(code) > MAX_CODE_LENGTH:
        return None
    return _consume(table, _code_pk(code), now)
