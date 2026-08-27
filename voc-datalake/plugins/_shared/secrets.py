"""Plugin-scoped reads of the shared API-credentials secret.

Every plugin Lambda reads ONE Secrets Manager secret whose keys are namespaced
`<plugin_id>_<key>` (CDK seeds them that way in `aggregateSecrets()`, and the
only writers — `integrations_handler` and `scrapers_handler` — always prefix).
The namespace prefix is therefore the entire isolation boundary: all ingestion
Lambdas share one IAM role, so IAM cannot provide a second layer (issue #251).

Two rules follow from that, and this module is the single choke point for both,
so neither base class can drift from the other:

  1. **Only the plugin's own namespace is returned.** Previously a key carrying
     no *known* plugin prefix was passed through as a "legacy/shared" value,
     which required `BaseIngestor` to keep a hand-maintained list of plugin ids:
     forget to add one and its `<plugin>_*` keys read as unprefixed and leaked
     into every other plugin. Nothing in production writes an unprefixed key
     (the only one that exists is Secrets Manager's own generated
     `placeholder`, which no plugin consumes), so the list bought nothing and
     cost an isolation hole. See
     `test_plugin_secret_isolation.py::TestOnlyThisPluginsNamespaceIsLoaded`.

  2. **A prefix that matches nothing FAILS, it does not widen.** The previous
     `return filtered if filtered else all_secrets` was a migration convenience
     for plugins predating prefixing; the effect was that a typo in a plugin id
     — the one input most likely to be wrong — produced the maximally permissive
     outcome, handing that plugin every other plugin's credentials. A raise is
     loud, names what to fix, and cannot be mistaken for success.
"""

import os
import re
import sys
from collections.abc import Mapping

# Add lambda/shared to path (mirrors the other _shared modules, so this one can
# be imported directly by a test without importing a base class first).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.exceptions import ConfigurationError
from shared.logging import logger

__all__ = ["filter_plugin_secrets", "plugin_secret_prefix"]

# Same character class the write path enforces on `source`
# (`integrations_handler._validate_source`): a plugin id becomes a key prefix,
# so anything outside `[a-z0-9_]` could escape or re-enter another namespace.
# Duplicated rather than imported because `lambda/api` is not on a plugin
# Lambda's path — only `lambda/shared` and `plugins/` are bundled.
_PLUGIN_ID_RE = re.compile(r'[a-z0-9](?:[a-z0-9_]{0,62}[a-z0-9])?')


def plugin_secret_prefix(plugin_id: str) -> str:
    """The namespace every one of *plugin_id*'s keys carries in the secret."""
    return f"{plugin_id}_"


def filter_plugin_secrets(plugin_id: str, all_secrets: Mapping) -> dict:
    """Return *plugin_id*'s namespaced keys from *all_secrets*, prefix stripped.

    The returned shape is what plugin handlers already consume — bare field
    names (`api_key`, `configs`, `app_id`), not the stored prefixed ones — so
    callers are unchanged.

    Raises:
        ConfigurationError: If *plugin_id* is missing or malformed, if
            *all_secrets* is empty, or if no key carries this plugin's prefix.
            Every one of those states used to yield the complete shared secret.

    Log/message discipline: the identity and the expected prefix are the only
    things named. No secret VALUE and no OTHER plugin's key name is emitted —
    an error raised because a prefix was wrong must not become a directory of
    what the correct prefixes are.
    """
    if not isinstance(plugin_id, str) or not _PLUGIN_ID_RE.fullmatch(plugin_id):
        # Truncated repr, not the raw value: the identity comes from
        # SOURCE_PLATFORM and is expected to be short, but an error message is
        # not the place to echo an unbounded string back.
        preview = repr(plugin_id[:40]) if isinstance(plugin_id, str) else repr(type(plugin_id).__name__)
        logger.error(
            "Refusing to load plugin secrets: plugin identity is missing or malformed",
            extra={"plugin_id": preview},
        )
        raise ConfigurationError(
            f"Cannot load plugin secrets: plugin identity {preview} is missing or "
            "malformed (expected lowercase letters, digits and underscores, "
            "starting and ending with a letter or digit)."
        )

    prefix = plugin_secret_prefix(plugin_id)

    if not isinstance(all_secrets, Mapping) or not all_secrets:
        # An empty secret is a configuration failure, not an empty namespace:
        # `get_secret` returns {} both for a genuinely empty secret and for a
        # read that FAILED (it logs and swallows), and neither is a state in
        # which a plugin should quietly run with no credentials.
        logger.error(
            "Refusing to load plugin secrets: secret payload is empty",
            extra={"plugin_id": plugin_id, "expected_prefix": prefix},
        )
        raise ConfigurationError(
            f"Cannot load plugin secrets for '{plugin_id}': the shared secret is "
            f"empty or unreadable, so no '{prefix}*' keys could be read."
        )

    # `len(key) > len(prefix)` drops a key that IS the bare prefix, which would
    # otherwise be handed to the plugin under the empty name ''.
    scoped = {
        key[len(prefix):]: value
        for key, value in all_secrets.items()
        if isinstance(key, str) and key.startswith(prefix) and len(key) > len(prefix)
    }

    if not scoped:
        logger.error(
            "Refusing to load plugin secrets: no key carries this plugin's prefix",
            extra={"plugin_id": plugin_id, "expected_prefix": prefix},
        )
        raise ConfigurationError(
            f"Cannot load plugin secrets for '{plugin_id}': the shared secret "
            f"contains no '{prefix}*' keys. Check the plugin id and that its "
            "credentials were saved under that prefix."
        )

    return scoped
