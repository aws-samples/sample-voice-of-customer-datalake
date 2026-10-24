"""Processor side of Radar routing: the brand a stamped queue message belongs to (docs/radar.md).

A scraper / web-review target / app connector / CSV upload naming a Radar brand
stamps each message with ``radar_brand_key``. The processor turns that key into
the brand's label through the EFFECTIVE brands (the brand list in ``voc-radar``,
then the legacy source-profile brands, ``shared.radar_brands.effective_brands``).

FAILS CLOSED: an unknown key, or a brand list that cannot be read, raises. The
message is retried by SQS and lands in the DLQ; it is never stored in
``voc-feedback``, where another brand's review would pollute our own numbers.
A key missing from a cached list is looked up once more against a fresh read
before it is refused, so a brand added a moment ago is not dead-lettered.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable, Mapping
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.radar_brands import effective_brands, load_brand_list

__all__ = ['BrandLabels']

CACHE_SECONDS: Final = 60.0


class UnknownRadarBrandError(Exception):
    """A message names a Radar brand key that no effective brand has; SQS retries it, then the DLQ."""


class RadarBrandListUnavailableError(Exception):
    """The brand list could not be read (or is malformed); SQS retries the message."""


class BrandLabels:
    """``key -> label`` of the effective brands, the brand list read at most every ``CACHE_SECONDS``."""

    def __init__(self, ttl: float = CACHE_SECONDS, clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl
        self._clock = clock
        self._listed: list[dict[str, Any]] | None = None
        self._read_at = 0.0

    def _brand_list(self, table: Any, *, fresh: bool) -> list[dict[str, Any]]:
        now = self._clock()
        if fresh or self._listed is None or now - self._read_at >= self._ttl:
            try:
                self._listed = load_brand_list(table)
            except (ClientError, BotoCoreError, ValueError) as exc:
                self._listed = None
                raise RadarBrandListUnavailableError('The Radar brand list could not be read') from exc
            self._read_at = now
        return self._listed

    def _labels(self, table: Any, profiles: Iterable[Mapping[str, Any]], *, fresh: bool) -> dict[str, str]:
        return {brand.key: brand.label for brand in effective_brands(self._brand_list(table, fresh=fresh), profiles)}

    def label(self, table: Any, profiles: list[Mapping[str, Any]], key: str) -> str:
        """The label of brand ``key``; ``UnknownRadarBrandError`` / ``RadarBrandListUnavailableError`` otherwise."""
        labels = self._labels(table, profiles, fresh=False)
        if key not in labels:
            labels = self._labels(table, profiles, fresh=True)
        if key not in labels:
            raise UnknownRadarBrandError(f'No Radar brand has the key {key!r}')
        return labels[key]
