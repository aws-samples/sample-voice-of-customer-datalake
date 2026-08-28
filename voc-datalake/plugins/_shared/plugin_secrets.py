"""Plugin-scoped reads of the shared API-credentials secret.

Named `plugin_secrets`, not `secrets`: `plugins/_shared` is on `sys.path` in the
deployed bundle (the ingestor handler sits at the bundle root beside `_shared/`),
and a module called `secrets.py` there shadows the stdlib `secrets` for anything
that imports it — six modules in this tree do.

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

What this boundary does NOT guarantee:

  ponytail: the scan is a plain prefix match, so if one plugin id were ever a
  PREFIX of another (`app_reviews` alongside the existing `app_reviews_ios`) the
  shorter one would also receive the longer one's keys, under mangled names
  (`app_reviews_ios_app_id` arriving as `ios_app_id`). No current id pair does
  this, and the write path carries the same caveat for the same reason
  (`integrations_handler.get_credentials`) — the two mirrors are kept in step so
  a reader comparing them finds the same limitation stated in both. It cannot be
  enforced HERE, which sees one id at a time and holds no list of the others by
  design — keeping such a list is precisely the hole rule 1 closed. It is instead
  refused at the two places that DO see more than one id, and both are needed
  because they close different entrances:

    * `plugin-loader.ts` rejects a manifest whose id is a prefix of another's, at
      synth time, where the whole id set is known
      (`test_plugin_secret_isolation.py` pins that the tree agrees).
    * `integrations_handler._validate_source_parameter` restricts the namespace a
      REQUEST may address to the manifest-derived plugin ids, on every route taking
      a `<source>` path parameter. The loader's guard is over manifest ids and
      cannot see a `source` invented in a request: `PUT
      /integrations/app_reviews/credentials` with key `ios_app_id` stored
      `app_reviews_ios_app_id`, which this scan then handed to `app_reviews_ios` as
      its own `app_id` — a stored key needs no colliding manifest to exist.

  Neither guard is retroactive: a key stored before they existed survives, and
  this scan still hands it over. Only deleting it from the secret removes it.
"""

import os
import sys
from collections.abc import Mapping

# Add the `plugins/` directory (this file's grandparent) to sys.path. `shared.*`
# below resolves through it: `lambda/shared/` is copied in beside `_shared/` when
# the bundle is built, and `plugins/`'s parent carries it in a source checkout.
# Mirrors the other `_shared` modules, so this one can be imported directly by a
# test without importing a base class first.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.exceptions import ConfigurationError, SecretUnreadableError
from shared.logging import logger
from shared.plugin_identity import PLUGIN_IDENTIFIER_RULES, is_valid_plugin_identifier

__all__ = ["filter_plugin_secrets", "plugin_secret_prefix"]


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
            *all_secrets* is not a JSON object, or if no key carries this plugin's
            prefix. The first and last used to yield the complete shared secret.
            All three mean a human wrote something wrong.
        SecretUnreadableError: If *all_secrets* is empty. A ConfigurationError
            SUBCLASS, so `except ConfigurationError` still catches it, but
            distinguishable — this is the one branch that may be an AWS-side blip
            rather than a misconfiguration, because `get_secret` swallows a failed
            read into `{}`. `BaseIngestor` uses the distinction to keep a throttle
            from counting against the circuit breaker.

    The empty-payload branch is RETRY-SAFE, but only because the caller makes it
    so: `shared.aws.get_secret` is `lru_cache`d and swallows a failed read into
    `{}`, so both `_load_secrets` callers evict that entry before delegating here
    (see `BaseIngestor._load_secrets`). Without the eviction, one transient
    Secrets Manager blip would wedge every later invocation in the warm container
    against a cached `{}`, with no further API call.

    Log/message discipline: the identity and the expected prefix are the only
    things named. No secret VALUE and no OTHER plugin's key name is emitted —
    an error raised because a prefix was wrong must not become a directory of
    what the correct prefixes are.
    """
    # The identity becomes a key prefix, so it is validated against the same
    # character class the WRITE path enforces on `source`. Both import it from
    # `shared/plugin_identity.py`: the read path refusing an identity the write
    # path accepted (or the reverse) is the same drift, one level up, that having
    # two copies of the prefix scan produced.
    if not is_valid_plugin_identifier(plugin_id):
        # Truncated repr, not the raw value: the identity comes from
        # SOURCE_PLATFORM and is expected to be short, but an error message is
        # not the place to echo an unbounded string back. A non-string is named
        # by its bare type name — `repr` of it would double the quoting.
        preview = repr(plugin_id[:40]) if isinstance(plugin_id, str) else type(plugin_id).__name__
        logger.error(
            "Refusing to load plugin secrets: plugin identity is missing or malformed",
            extra={"plugin_id": preview},
        )
        raise ConfigurationError(
            f"Cannot load plugin secrets: plugin identity {preview} is missing or "
            f"malformed (it {PLUGIN_IDENTIFIER_RULES})."
        )

    prefix = plugin_secret_prefix(plugin_id)

    # Tested BEFORE the empty check, because `not all_secrets` is also true of `[]`
    # and `''`. `get_secret` does `json.loads` on the SecretString, which succeeds
    # for any valid JSON — so a secret whose body is an array, a string or a number
    # arrives here as a non-Mapping. That is nobody's throttle: it is a human having
    # written the wrong thing, it will never self-heal, and it therefore belongs to
    # the COUNTED class alongside a malformed identity and a namespace miss. Folding
    # it into the branch below would both exempt it from the circuit breaker and log
    # "payload is empty" about a populated JSON array.
    if not isinstance(all_secrets, Mapping):
        logger.error(
            "Refusing to load plugin secrets: secret payload is not a JSON object",
            extra={"plugin_id": plugin_id, "expected_prefix": prefix,
                   "payload_type": type(all_secrets).__name__},
        )
        raise ConfigurationError(
            f"Cannot load plugin secrets for '{plugin_id}': the shared secret is not "
            f"a JSON object, so it cannot carry '{prefix}*' keys."
        )

    if not all_secrets:
        # An empty secret is still a refusal — neither a genuinely empty secret
        # nor a failed read is a state in which a plugin should quietly run with
        # no credentials — but it is the ONLY branch here that may not be anyone's
        # mistake: `get_secret` logs and swallows every client error into `{}`, so
        # a throttle and an empty secret are indistinguishable from here.
        #
        # Hence the narrower type. The caller has already evicted the cache entry
        # so the next invocation retries, and `BaseIngestor` reports this without
        # recording a circuit-breaker failure: counting it would let five transient
        # Secrets Manager errors in one window disable a healthy plugin's
        # EventBridge schedule, which nothing in this tree re-enables.
        logger.error(
            "Refusing to load plugin secrets: secret payload is empty",
            extra={"plugin_id": plugin_id, "expected_prefix": prefix},
        )
        raise SecretUnreadableError(
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
