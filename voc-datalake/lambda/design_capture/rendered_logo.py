"""A logo the browser drew as a PNG (shared by ``page_logo`` and ``raster_logo``)."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RenderedLogo:
    """A logo the browser drew: where it came from, the PNG, the sanitised SVG copy (when there is one), and the
    ``#rrggbb`` backdrop a light logo was drawn on (``logo_isolate``)."""
    source_url: str
    png: bytes
    svg: str | None = None
    backdrop: str | None = None
