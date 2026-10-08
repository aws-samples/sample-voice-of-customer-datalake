"""The source ids a listing without an explicit `?source=` covers, declared ONCE.

`GET /sources/status` (integrations) and the `/logs/*` listings fan out over
"every source" when the caller names none. Both used to hardcode
`['webscraper', 'manual_import', 's3_import']`, which drifted from the deployed
plugin set (issue #256): `app_reviews_ios`, `app_reviews_android` and
`synthetic_reviews` were enabled yet never listed.

The plugin half now comes from the deployment itself. CDK renders the ids of the
plugins enabled in `pluginStatus` (and present under `plugins/`) into the
`ENABLED_SOURCES` env var at synth time — see `enabledSourcesEnv` in
`lib/stacks/api-enabled-sources.ts`.

`manual_import` is appended because it is a real `source_platform` with no plugin
manifest: `manual_import_handler` writes feedback under it, and the processor
writes `LOGS#<type>#manual_import` rows for its failures.
"""
import json
import os

from shared.logging import logger
from shared.plugin_identity import is_valid_plugin_identifier

__all__ = ["ENABLED_SOURCES_ENV_VAR", "NON_PLUGIN_SOURCES", "default_source_ids"]

ENABLED_SOURCES_ENV_VAR = "ENABLED_SOURCES"

# Sources that write feedback and logs without being a plugin.
NON_PLUGIN_SOURCES = ("manual_import",)


def _enabled_plugin_ids() -> list[str]:
    """Parse ENABLED_SOURCES (a JSON array of plugin ids).

    Fails SOFT to no plugins, with a warning: a malformed or absent variable must
    not turn the Settings or Logs page into a 500. Entries that are not a valid
    plugin identifier are dropped individually so one bad id hides no other.
    """
    raw = os.environ.get(ENABLED_SOURCES_ENV_VAR, "")
    if not raw:
        logger.warning(f"{ENABLED_SOURCES_ENV_VAR} is not set; listing no plugin sources")
        return []
    try:
        parsed = json.loads(raw)
    except ValueError:
        logger.warning(f"{ENABLED_SOURCES_ENV_VAR} is not valid JSON; listing no plugin sources")
        return []
    if not isinstance(parsed, list):
        logger.warning(f"{ENABLED_SOURCES_ENV_VAR} is not a JSON array; listing no plugin sources")
        return []
    # `isinstance` narrows for the type checker; the identifier check is the rule.
    valid = [s for s in parsed if isinstance(s, str) and is_valid_plugin_identifier(s)]
    if len(valid) != len(parsed):
        logger.warning(f"Ignoring {len(parsed) - len(valid)} malformed {ENABLED_SOURCES_ENV_VAR} entries")
    return valid


def default_source_ids() -> list[str]:
    """Enabled plugin ids in deploy order, then the non-plugin sources, de-duplicated."""
    return list(dict.fromkeys([*_enabled_plugin_ids(), *NON_PLUGIN_SOURCES]))
