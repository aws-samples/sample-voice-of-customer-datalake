"""The one HTTPS transport of the repository hosts' clients (docs/autonomous-engineering.md, "Repository connectors").

Each client reaches exactly one host: a ``Transport`` takes a path, never a URL, and ``HttpsTransport`` is bound to
its host when it is made (``api.github.com`` for the GitHub client, ``gitlab.com`` for the GitLab client and the
Agents API's check of a GitLab token). No redirect is followed, the default certificate checks hold, an answer is
read to ``MAX_RESPONSE_BYTES`` at most, and nothing a request or a response carries is logged. Tests inject a fake.

A write whose answer was lost may have happened, so only a read (or a request the caller names as safe to repeat,
``repeatable``) is answered as retryable (``HostBusy``); a lost write is a ``HostError`` the broker reads as an unknown
outcome. Nothing here imports ``cryptography``: the Agents API ships without the signing layer. The readers of an
answer (``json_of``, ``text_of``, ``int_of``, ``dig``, ``items_of``) are both clients': a field missing where one is
needed is a ``HostError`` naming the field, never the answer.
"""
from __future__ import annotations

import http.client
import json
import math
import re
import ssl
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Final, Protocol

from engineering.connectors.hosts import HostBusy, HostError

#: The most of one response a client reads (a Lambda function URL answers at most 6 MB).
MAX_RESPONSE_BYTES: Final = 5 * 1024 * 1024
#: A rate limit with no header to say how long (a bare 429), or a host that could not be reached: a minute.
DEFAULT_RETRY_SECONDS: Final = 60
#: Requests that change nothing on the host, so a lost answer can be retried.
SAFE_METHODS: Final = frozenset({'GET', 'HEAD'})


@dataclass(frozen=True)
class Response:
    status: int
    #: Header names in lower case.
    headers: Mapping[str, str]
    body: bytes


class Transport(Protocol):
    def request(self, method: str, path: str, headers: Mapping[str, str], body: bytes | None) -> Response: ...


class _Answer(Protocol):
    status: int

    def read(self, limit: int, /) -> bytes: ...

    def getheaders(self) -> list[tuple[str, str]]: ...


class _Connection(Protocol):
    def request(self, method: str, url: str, body: bytes | None, headers: Mapping[str, str]) -> None: ...

    def getresponse(self) -> _Answer: ...

    def close(self) -> None: ...


class HttpsTransport:
    """``host`` over HTTPS with the default certificate checks; a path, never a URL, so no other host. ``repeatable``:
    the paths of writes that are harmless to repeat (GitHub's token mint), answered as retryable when lost."""

    def __init__(self, timeout: float = 10.0, connect: Callable[..., _Connection] = http.client.HTTPSConnection, *,
                 host: str = 'api.github.com', repeatable: re.Pattern[str] | None = None) -> None:
        self._timeout = timeout
        self._connect = connect
        self._host = host
        self._repeatable = repeatable

    def request(self, method: str, path: str, headers: Mapping[str, str], body: bytes | None) -> Response:
        connection = self._connect(self._host, timeout=self._timeout, context=ssl.create_default_context())
        sent = False
        try:
            connection.request(method, path, body=body, headers=dict(headers))
            sent = True
            answer = connection.getresponse()
            data = answer.read(MAX_RESPONSE_BYTES + 1)
            status, received = answer.status, {name.lower(): value for name, value in answer.getheaders()}
        except (OSError, http.client.HTTPException):
            # A write whose answer was lost may have happened: "retry later" could make it twice (a second comment,
            # a second pull request), so only a read, or a request that never left, is answered as retryable.
            if sent and method not in SAFE_METHODS and not (self._repeatable and self._repeatable.match(path)):
                raise HostError('The repository host\'s answer to a write was lost: the write may have happened, '
                                'so check before trying it again.') from None
            raise HostBusy('The repository host could not be reached.', retry_after=DEFAULT_RETRY_SECONDS) from None
        finally:
            connection.close()
        if len(data) > MAX_RESPONSE_BYTES:
            raise HostError('The repository host answered with more than the broker reads.')
        return Response(status=status, headers=received, body=data)


# --- reading an answer --------------------------------------------------------------------------------------------


def asked_wait(response: Response, reset_header: str, now: float, *, reset_needs_empty: str = '') -> int | None:
    """The seconds a rate-limited answer asks the client to wait (at least one): its ``Retry-After``, else the epoch
    second in ``reset_header`` (only while ``reset_needs_empty``, when named, says no request is left); ``None``
    when it says neither."""
    retry_after = response.headers.get('retry-after', '')
    if retry_after.isdigit():
        return max(1, int(retry_after))
    reset = response.headers.get(reset_header, '')
    if reset.isdigit() and (not reset_needs_empty or response.headers.get(reset_needs_empty) == '0'):
        return max(1, math.ceil(float(reset) - now))
    return None


def json_of(response: Response) -> Any:
    try:
        return json.loads(response.body)
    except ValueError:
        raise HostError(f'The repository host answered {response.status} with a body that is not JSON.') from None


def text_of(value: object, key: str) -> str:
    found = value.get(key) if isinstance(value, dict) else None
    if not isinstance(found, str):
        raise HostError(f'The repository host answered without "{key}".')
    return found


def int_of(value: object, key: str) -> int:
    found = value.get(key) if isinstance(value, dict) else None
    if not isinstance(found, int) or isinstance(found, bool):
        raise HostError(f'The repository host answered without "{key}".')
    return found


def dig(value: object, *keys: str) -> object:
    for key in keys:
        value = value.get(key) if isinstance(value, dict) else None
    return value


def text_or_empty(value: object, *keys: str) -> str:
    """The text at ``keys`` of an answer, '' when it has none (what the record keeps only when it is there)."""
    found = dig(value, *keys)
    return found if isinstance(found, str) else ''


def text_unless_missing(response: Response, *keys: str) -> str | None:
    """``None`` for a 404 (the host has no such thing), else the text at ``keys`` of the answer (``HostError``
    without it)."""
    return None if response.status == 404 else text_of(dig(json_of(response), *keys[:-1]), keys[-1])


def items_of(data: object, fields: Mapping[str, tuple[str, ...]]) -> list[dict[str, object]]:
    """Each item of a list answer, as ``fields`` (name -> the keys to it) pick it."""
    return [{name: dig(item, *keys) for name, keys in fields.items()}
            for item in (data if isinstance(data, list) else [])]
