"""Shared fakes for the Radar news scan tests: a moto world with one tracked brand, and a Lambda context."""
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from typing import Any
from unittest.mock import MagicMock, patch

from moto import mock_aws

from jobs.radar_scan import extract, handler, scan, windows
from shared.radar_brands import BRAND_LIST_KEY, RadarBrand
from shared.test.radar_fixtures import radar_pk_sk_table


@contextmanager
def acme_world(brand: dict[str, Any]) -> Iterator[Any]:
    """The radar + aggregates tables (moto) with ``brand`` as the only listed brand; yields the radar table."""
    with mock_aws():
        radar = radar_pk_sk_table('radar')
        radar_pk_sk_table('aggregates')
        radar.put_item(Item={**BRAND_LIST_KEY, 'brands': [brand]})
        with patch.object(handler, 'RADAR_TABLE', 'radar'), patch.object(handler, 'AGGREGATES_TABLE', 'aggregates'):
            yield radar


def lambda_context(remaining_ms: int = 900_000) -> MagicMock:
    context = MagicMock()
    context.get_remaining_time_in_millis.return_value = remaining_ms
    return context


def run_scan(brand: RadarBrand, window: windows.BrandWindow, budget: int, today: date,
             **sources: Any) -> tuple[scan.BrandScanStats, dict[str, Any]]:
    """Scan ``brand`` (domains ``acme.pl``) with fake sources (web search answers nothing unless given)."""
    sources.setdefault('search', MagicMock(return_value=[]))
    ctx = extract.ExtractContext('acme', 'Acme', ('acme.pl',), today, extract.Budget(0), MagicMock())
    stats = scan.scan_brand(brand, window=window, budget=extract.Budget(budget), ctx=ctx, table=MagicMock(),
                            now_iso='now', sources=scan.ScanSources(**sources))
    return stats, sources
