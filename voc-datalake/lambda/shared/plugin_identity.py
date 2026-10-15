"""The character class a plugin id / credential key must satisfy, declared ONCE.

A plugin id and a credential key are both used as, or inside, a Secrets Manager
key namespace (`<plugin_id>_<key>`), so the same character class has to hold on
both sides of that namespace:

  * the WRITE path (`lambda/api/integrations_handler.py`) validates the `source`
    path parameter and every submitted credential key before it prefixes and
    stores them;
  * the READ path (`plugins/_shared/plugin_secrets.py`) validates the plugin
    identity it is about to turn into a prefix, because since issue #251 a
    namespace miss is a hard failure rather than a silent widening to the whole
    shared secret.

Those two used to carry their own copies of the pattern. Read-path and
write-path validation drifting apart is the same class of defect issue #251 was
about one level down — a write that stores `Foo_key` under a rule the reader does
not share, or a reader that refuses an identity the writer accepted — so the
pattern lives here instead.

`lambda/shared/` is the only directory both bundles contain: the API Lambdas get
`lambda/api/<handler>.py` + `lambda/shared/`, and a plugin Lambda gets
`plugins/<id>/...` + `plugins/_shared/` + `lambda/shared/` (see
`createApiLambdaCode` in `lib/stacks/api-stack.ts` and `createIngestorLambda` in
`lib/stacks/ingestion-stack.ts`). `lambda/api` is NOT on a plugin Lambda's path,
which is why the plugin side cannot simply import the handler's constant.

Rules, unchanged from the write path's original statement of them:

  * Only lowercase letters, digits, and underscores — no dots, slashes, hyphens
    or other characters that could escape or re-enter a namespace.
  * Length 1-64 characters.
  * May not start or end with an underscore, which would blur the boundary
    between a name and the `_` namespace separator.

Single alternative: the optional inner body of up to 62 chars means the total
length is 1 (just the initial char) or 2-64 (initial + inner + final). Callers
use `re.fullmatch`, so no anchors are needed in the pattern.
"""

import re

__all__ = ["PLUGIN_IDENTIFIER_RE", "PLUGIN_IDENTIFIER_RULES", "is_valid_plugin_identifier"]

PLUGIN_IDENTIFIER_RE = re.compile(r'[a-z0-9](?:[a-z0-9_]{0,62}[a-z0-9])?')

# The rules above in the words both paths' error messages use, so a 400 from the
# write path and a ConfigurationError from the read path describe the same
# constraint identically.
PLUGIN_IDENTIFIER_RULES = (
    "must contain only lowercase letters, digits, and underscores, must start "
    "and end with a letter or digit, and must be 1–64 characters long"
)


def is_valid_plugin_identifier(value: object) -> bool:
    """True if *value* is a string conforming to the rules above.

    The isinstance check is part of the contract rather than the caller's job:
    both paths receive this value from outside (a path parameter, an environment
    variable) and `re.fullmatch` raises on a non-string instead of returning
    False.
    """
    return isinstance(value, str) and PLUGIN_IDENTIFIER_RE.fullmatch(value) is not None
