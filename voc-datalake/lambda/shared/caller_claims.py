"""Display labels read from the caller's Cognito authorizer claims.

Each route chooses which claims may name the caller to its readers (a username only, a name
first, an email for admins) and its own fallback; this module only finds the first usable one.
"""

from __future__ import annotations

from collections.abc import Iterable


def first_claim(event: dict, names: Iterable[str]) -> str | None:
    """The first of ``names`` whose claim is non-blank text, stripped; None when there is none."""
    claims = (event.get('requestContext') or {}).get('authorizer', {}).get('claims', {})
    if not isinstance(claims, dict):
        return None
    for name in names:
        value = claims.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None
