"""Timestamp formats, decided once: the ``now`` writer (an aware UTC ISO-8601 string,
``2026-10-25T09:30:00.123456+00:00``), its reader (:func:`parse_iso`) and the stored ``YYYY-MM-DD`` day shape.

Every ``created_at`` / ``updated_at`` / ``started_at`` the platform stores is written through :func:`now_iso`, so
the format is decided once. ``lambda/shared`` ships in every Python bundle (plugins included), so every module
can import it. A test that freezes the time patches the caller's imported name (``patch.object(module,
'now_iso', return_value=...)``) or this module's ``datetime``.
"""
from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Final

#: A calendar day as every stored ``YYYY-MM-DD`` field spells it (the shape only, not a valid date).
ISO_DAY_RE: Final = re.compile(r'^\d{4}-\d{2}-\d{2}\Z')


def parse_iso(value: object) -> datetime | None:
    """An ISO-8601 timestamp as an aware datetime (a naive one is taken as UTC); None for anything else."""
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def now_iso(now: datetime | None = None) -> str:
    """``now`` (default: the current time) as an ISO-8601 string; a naive or local ``now`` is taken as written."""
    return (now or datetime.now(UTC)).isoformat()
