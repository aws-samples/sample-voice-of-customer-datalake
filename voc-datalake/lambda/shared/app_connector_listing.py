"""Every app-review connector and review page, in one read-only list (docs/radar.md → "With the AI assistant").

``GET /scrapers/connectors`` (scrapers_handler) answers ``{connectors: [...]}`` from the shared
API-credentials secret, which the scrapers Lambda already reads for ``webscraper_configs``: the iOS
and Android app connectors and the web_reviews pages, each with the Radar brand it feeds. The AI
assistant's ``list_scrapers`` reads it beside ``GET /scrapers`` (the stream may invoke the scrapers
API, not the integrations API).

The same configs ``GET /integrations/<source>/apps`` returns to every signed-in user, but only the
fields in ``CONNECTOR_FIELDS``: a field added to a connector config later never leaves here unless it
is listed. A config that is not an object, or a source whose stored value is not a JSON list, is
skipped (the read never fails on one bad entry).
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Final

__all__ = ['connectors_in_secret']

#: The multi-instance plugins (integrations_handler.APP_CONFIG_PLUGINS), in the order the list shows them.
CONNECTOR_SOURCES: Final = ('app_reviews_ios', 'app_reviews_android', 'web_reviews')
#: What each connector shows: no credential exists on these configs today, and none would pass.
CONNECTOR_FIELDS: Final = (
    'id', 'app_name', 'app_id', 'package_name', 'url', 'enabled', 'frequency_minutes', 'source_id', 'radar_brand',
)


def _configs(secrets: Mapping[str, Any], source: str) -> list[Any]:
    try:
        configs = json.loads(secrets.get(f'{source}_configs') or '[]')
    except (TypeError, ValueError):
        return []
    return configs if isinstance(configs, list) else []


def _view(source: str, config: Mapping[str, Any]) -> dict[str, Any]:
    picked = {field: config[field] for field in CONNECTOR_FIELDS if config.get(field) not in (None, '')}
    return {'source': source, **picked}


def connectors_in_secret(secrets: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Every connector of ``CONNECTOR_SOURCES`` in the secret's ``<source>_configs``, ``{source, …CONNECTOR_FIELDS}``."""
    return [_view(source, config) for source in CONNECTOR_SOURCES for config in _configs(secrets, source)
            if isinstance(config, Mapping)]
