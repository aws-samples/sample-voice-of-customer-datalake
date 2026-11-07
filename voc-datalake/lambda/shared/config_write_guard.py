"""Create-never-overwrites and stale-update refusals for configs kept in the shared secret (tenet 4).

``POST /scrapers`` and ``POST /integrations/{source}/apps`` used to be plain upserts:
the "a create never overwrites" and "a stale update is refused" rules held only in
the browser (the assistant's approval executors). Both routes now take, optionally:

* ``mode: 'create' | 'update'``: ``create`` answers 409 when the record already
  exists; ``update`` answers 404 when it does not;
* ``base_etag``: the record's ``etag`` as the client read it; an update whose stored
  record now has another ``etag`` answers 409 (somebody changed it).

Both absent = the upsert every older client relies on. The ``etag`` is computed,
never stored: a hash of the stored record that the list routes add to every record
they answer (``with_etag``), so nothing about the stored configs changes and a record
sent back with its ``etag`` is stored without it (``without_etag``). See
docs/scrapers.md → Write rules.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from typing import Any, Final, TypeGuard

from shared.exceptions import ConflictError, NotFoundError, ValidationError
from shared.request_body import optional_field

MODE_CREATE: Final = 'create'
MODE_UPDATE: Final = 'update'
MODES: Final = (MODE_CREATE, MODE_UPDATE)
MAX_ETAG_CHARS: Final = 64
ETAG: Final = 'etag'


def etag(record: Mapping[str, Any]) -> str:
    """The record's version: the first 16 hex of a SHA-256 of its canonical JSON (``etag`` excluded)."""
    canonical = json.dumps({k: v for k, v in record.items() if k != ETAG},
                           sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:16]


def with_etag(record: Any) -> Any:
    """A copy of a listed record with its ``etag`` (anything but an object is returned as is)."""
    return {**record, ETAG: etag(record)} if isinstance(record, Mapping) else record


def without_etag(record: dict[str, Any]) -> dict[str, Any]:
    """The record as it is stored: a client that sends back what it read sends the ``etag`` too."""
    return {k: v for k, v in record.items() if k != ETAG}


def write_mode(body: Mapping[str, Any]) -> str | None:
    """The request's ``mode`` (None = upsert), or a 400."""
    mode = body.get('mode')
    if mode is None:
        return None
    if mode not in MODES:
        raise ValidationError("mode must be 'create' or 'update'")
    return str(mode)


def base_etag(body: Mapping[str, Any]) -> str | None:
    """The request's ``base_etag`` (None = no stale check), or a 400."""
    return optional_field(body, 'base_etag', _is_etag, lambda: ValidationError(
        f'base_etag must be a string of at most {MAX_ETAG_CHARS} characters'))


def _is_etag(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and len(value) <= MAX_ETAG_CHARS


def check_write(stored: Mapping[str, Any] | None, *, mode: str | None, base: str | None, what: str) -> None:
    """Refuse the write when it would overwrite on create, or update a missing or changed record.

    ``stored`` is the record the write would replace (None = a create). ``what`` names
    it in the message ("A scraper with id \"x\"").
    """
    if mode == MODE_CREATE and stored is not None:
        raise ConflictError(f'{what} already exists; nothing was saved. A create never overwrites.')
    if mode == MODE_UPDATE and stored is None:
        raise NotFoundError(f'{what} does not exist; nothing was saved.')
    if stored is not None and base is not None and etag(stored) != base:
        raise ConflictError(f'{what} changed since it was read; nothing was saved. Read it again.')


def find_existing(configs: list, matches: Callable[[Mapping[str, Any]], bool]) -> Mapping[str, Any] | None:
    """The first stored config ``matches`` accepts."""
    return next((c for c in configs if isinstance(c, Mapping) and matches(c)), None)
