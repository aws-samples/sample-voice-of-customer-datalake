"""Publishing on the engineering bus: the one helper every producer uses (the board API is the first).

Each message is checked against voc-msg/1 before it leaves (``parse`` of its own dict), then put on the bus with the
producer's fixed ``source``. A failed entry raises: the caller's record (the board row) is already written, and its
caller retries the operation, which is idempotent. A message about a recorded change takes its id from the change
(``change_event_id``), so the retry's message is the same one again and its receivers dedupe it by id.
"""
from __future__ import annotations

import hashlib
import os
import time
from datetime import datetime
from typing import Any

from engineering.bus.schema import Message, parse

_CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'


class PublishError(RuntimeError):
    """The bus refused an entry."""


def _ulid(ms: int, entropy: bytes) -> str:
    """48 bits of milliseconds then 80 bits of ``entropy``, Crockford base32 (sorts by time)."""
    value = (ms << 80) | int.from_bytes(entropy[:10], 'big')
    return ''.join(_CROCKFORD[(value >> shift) & 31] for shift in range(125, -1, -5))


def new_event_id() -> str:
    """A ULID with 80 random bits."""
    return _ulid(time.time_ns() // 1_000_000, os.urandom(10))


def change_event_id(at: datetime, *change: str) -> str:
    """The id of one recorded change (a ULID at its time): publishing it again is a redelivery, not a new message."""
    return _ulid(int(at.timestamp() * 1000), hashlib.sha256('\x00'.join(change).encode()).digest())


class EventBridgePublisher:
    def __init__(self, client: Any, bus_name: str, source: str) -> None:
        """``client`` is boto3's EventBridge client (or a test's); ``source`` the producer's pinned source."""
        self.client = client
        self.bus_name = bus_name
        self.source = source

    def publish(self, message: Message) -> None:
        checked = parse(message.to_dict())
        result = self.client.put_events(Entries=[{
            'EventBusName': self.bus_name, 'Source': self.source, 'DetailType': checked.type,
            'Detail': checked.to_json()}])
        if result.get('FailedEntryCount', 0):
            code = (result.get('Entries') or [{}])[0].get('ErrorCode', 'unknown')
            raise PublishError(f'the bus refused {checked.type} {checked.event_id}: {code}')
