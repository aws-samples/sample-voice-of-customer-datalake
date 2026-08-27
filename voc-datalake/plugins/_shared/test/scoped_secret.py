"""Test helper: build a secret payload inside the plugin's own namespace.

Since issue #251 both base classes REFUSE a secret that carries no key under
`<SOURCE_PLATFORM>_`, so `{}` — which most of these tests used to pass as "no
secrets configured" — is now a ConfigurationError. Tests that are not about
secret filtering need a payload that satisfies the boundary without restating
it, hence this helper.

The prefix is DERIVED from the live `SOURCE_PLATFORM` the base classes read, not
spelled out: a test that hardcoded `'test_source_'` would keep passing if the
production prefix construction changed under it, which is exactly the silence
this module exists to avoid. Imported by tests of individual plugins too (they
all run with the same SOURCE_PLATFORM from `plugins/conftest.py`), so the
knowledge lives in one place rather than in six test files.
"""

from _shared import base_ingestor
from _shared.secrets import plugin_secret_prefix

__all__ = ["scoped_secret"]


def scoped_secret(**values: str) -> dict:
    """Return *values* re-keyed into the namespace the base classes accept.

    With no arguments, returns a single filler key — enough to pass the
    fail-closed check for tests whose subject is not secret loading at all.
    """
    prefix = plugin_secret_prefix(base_ingestor.SOURCE_PLATFORM)
    if not values:
        values = {"api_key": "unused-by-this-test"}
    return {f"{prefix}{key}": value for key, value in values.items()}
