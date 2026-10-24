"""Warm-container memo for read-only GET routes (docs/caching.md).

A bounded LRU (``MAX_ENTRIES`` entries, ``MAX_BYTES`` of serialized body, every
entry at most ``MAX_AGE_SECONDS`` old) of route RESULTS, held in the Lambda
container's memory: nothing to provision, nothing billed while idle. A container
serves one request at a time, so a hit is simply "the same question, asked again,
with nothing changed since".

The key is everything the answer depends on:

* the route and the request path (the path carries ids such as the brand key);
* the query string, normalized (sorted, multi-values kept);
* today's UTC date (windows end today) — the resolved ``days`` follows from the
  query, the watermark (part of the versions read) and today;
* the caller's scope fingerprint: their category/source scope, resolved for THIS
  request before the memo is consulted, plus the admin and delegated flags;
* the data / config (/ Radar) versions of ``shared.data_version``. A write bumps a
  version, so every older entry is simply never asked for again and ages out.

Never stored: a ``Response`` object (a non-default status such as 202, or a hand
built answer), anything that is not a dict, ``success: false``, and any answer that
reports a partial read (``is_partial`` / ``is_partial_window`` true, or a
``partial_reason``) — a partial answer is a time-budget accident, not the data.
A version read that failed means no memo at all for that request (live read).

Hits are deep copies, so the framework's later passes (validation encoding, the
override redaction) can never mutate a stored entry.
"""
from __future__ import annotations

import copy
import functools
import hashlib
import json
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Hashable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from aws_lambda_powertools.shared.json_encoder import Encoder

from shared.category_access import CategoryScope
from shared.data_version import VersionRead, read_versions
from shared.logging import logger
from shared.project_gate import caller_from_event

MAX_ENTRIES: Final = 200
MAX_BYTES: Final = 5 * 1024 * 1024
# One answer may take at most this share of the byte budget, so a single huge page
# cannot flush everything else.
MAX_ENTRY_SHARE: Final = 5
MAX_AGE_SECONDS: Final = 600
PARTIAL_FLAGS: Final = ('is_partial', 'is_partial_window')
PARTIAL_REASON: Final = 'partial_reason'
# How deep the partial-flag check looks into nested objects (lists are not walked:
# list items are records, never a response's own flags).
PARTIAL_SCAN_DEPTH: Final = 3
VERSIONS_CONTEXT_KEY: Final = 'cache_versions'


@dataclass
class _Entry:
    body: Any
    size: int
    stored_at: float


class ResponseCache:
    """A thread-safe LRU bounded by entry count, total size and age."""

    def __init__(self, max_entries: int = MAX_ENTRIES, max_bytes: int = MAX_BYTES,
                 max_age_seconds: float = MAX_AGE_SECONDS, clock: Callable[[], float] = time.monotonic) -> None:
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self.max_entry_bytes = max(1, max_bytes // MAX_ENTRY_SHARE)
        self.max_age_seconds = max_age_seconds
        self._clock = clock
        self._entries: OrderedDict[Hashable, _Entry] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    def __len__(self) -> int:
        return len(self._entries)

    def clear(self) -> None:
        """Empty the cache. A test seam (pyproject.toml vulture ignore_names): nothing clears it live."""
        with self._lock:
            self._entries.clear()
            self._bytes = 0

    def get(self, key: Hashable) -> Any | None:
        """A deep copy of the stored body, or None (absent or older than the max age)."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            if self._clock() - entry.stored_at > self.max_age_seconds:
                self._drop(key)
                return None
            self._entries.move_to_end(key)
            body = entry.body
        return copy.deepcopy(body)

    def put(self, key: Hashable, body: Any, size: int) -> bool:
        """Store a deep copy of ``body``; False when it is too large to keep."""
        if size > self.max_entry_bytes:
            return False
        stored = copy.deepcopy(body)
        with self._lock:
            if key in self._entries:
                self._drop(key)
            self._entries[key] = _Entry(stored, size, self._clock())
            self._bytes += size
            while len(self._entries) > self.max_entries or self._bytes > self.max_bytes:
                self._drop(next(iter(self._entries)))
        return True

    def _drop(self, key: Hashable) -> None:
        entry = self._entries.pop(key)
        self._bytes -= entry.size


# The container's one memo, shared by every opted-in route of the Lambda.
DEFAULT_CACHE: Final = ResponseCache()


def is_cacheable(body: object) -> bool:
    """A complete, successful JSON object: no partial-read flag, no ``success: false``."""
    return isinstance(body, dict) and body.get('success') is not False and not _reports_partial(body, 0)


def _reports_partial(value: Mapping[str, Any], depth: int) -> bool:
    if any(value.get(flag) for flag in PARTIAL_FLAGS) or value.get(PARTIAL_REASON):
        return True
    if depth >= PARTIAL_SCAN_DEPTH:
        return False
    return any(_reports_partial(child, depth + 1) for child in value.values() if isinstance(child, Mapping))


def serialized_size(body: object) -> int:
    """Bytes the body takes as JSON (the same encoder Powertools answers with)."""
    return len(json.dumps(body, separators=(',', ':'), cls=Encoder, default=str).encode())


def normalized_query(event: Mapping[str, Any]) -> tuple[tuple[str, tuple[str, ...]], ...]:
    """The query string as sorted ``(name, values)`` pairs; multi-values kept in order."""
    multi = event.get('multiValueQueryStringParameters')
    single = event.get('queryStringParameters')
    pairs: dict[str, tuple[str, ...]] = {}
    if isinstance(single, Mapping):
        pairs.update({str(k): (str(v),) for k, v in single.items()})
    if isinstance(multi, Mapping):
        pairs.update({str(k): tuple(str(v) for v in values) for k, values in multi.items()
                      if isinstance(values, list)})
    return tuple(sorted(pairs.items()))


def scope_fingerprint(scope: CategoryScope, event: Mapping[str, Any]) -> str:
    """SHA-256 of everything about the caller a cached answer may depend on.

    The scope's full rule set (categories, granted / denied sources) plus the admin
    and delegated flags. Two callers share an entry only when all of it is equal.
    """
    caller = caller_from_event(event)
    material = {'scope': scope.to_dict(), 'admin': caller.is_admin, 'delegated': caller.delegated}
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()


def request_versions(app: Any, aggregates_table: Any, radar_table: Any = None) -> VersionRead:
    """This request's versions read, made at most once per request (the resolver's context)."""
    cached = app.context.get(VERSIONS_CONTEXT_KEY)
    if isinstance(cached, VersionRead):
        return cached
    read = read_versions(aggregates_table, radar_table)
    app.append_context(**{VERSIONS_CONTEXT_KEY: read})
    return read


def _today_utc() -> str:
    return datetime.now(UTC).date().isoformat()


def memoized_route(
    app: Any, *, scope: Callable[[], CategoryScope], versions: Callable[[], VersionRead],
    cache: ResponseCache | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Opt a read-only GET route into the memo (the decorator sits under ``@app.get``).

    ``scope`` resolves the caller's scope for THIS request (never memoized across
    requests) and runs first; ``versions`` is the request's ``request_versions`` read.
    """
    def decorate(route: Callable[..., Any]) -> Callable[..., Any]:
        route_id = f'{route.__module__}.{route.__qualname__}'

        @functools.wraps(route)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            store = cache if cache is not None else DEFAULT_CACHE
            event = app.current_event.raw_event
            fingerprint = scope_fingerprint(scope(), event)
            read = versions()
            if read.versions is None:
                return route(*args, **kwargs)
            key = (route_id, str(event.get('path') or ''), normalized_query(event), _today_utc(),
                   fingerprint, read.versions.key(), read.earliest_date)
            hit = store.get(key)
            if hit is not None:
                logger.debug('Response cache hit', extra={'route': route_id})
                return hit
            result = route(*args, **kwargs)
            if is_cacheable(result):
                store.put(key, result, serialized_size(result))
            return result

        return wrapper

    return decorate
