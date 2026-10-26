"""The client projection of a review's ``category_override`` audit.

The stored audit (``shared.feedback_category.override_record``) keeps the
editor's Cognito ``by_sub`` so the change stays attributable; a client never
sees it. ``redact_category_overrides`` is THE sanitiser for feedback leaving the
API: ``shared.api.create_api_resolver`` applies it to every JSON response body,
so a new route returning raw items cannot leak the subject. Dependency-free on
purpose — ``shared.api`` imports it.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

# The only `category_override` fields a client ever sees (no `by_sub`).
PUBLIC_OVERRIDE_FIELDS = ('previous_category', 'previous_subcategory', 'by_username', 'at')


def public_override(override: object) -> dict | None:
    """``category_override`` as a client may see it: no ``by_sub``, nothing unknown."""
    if not isinstance(override, Mapping):
        return None
    return {key: override.get(key) for key in PUBLIC_OVERRIDE_FIELDS if key in override}


def redact_category_overrides(value: Any) -> Any:
    """``value`` with every nested ``category_override`` projected by :func:`public_override`."""
    if isinstance(value, Mapping):
        return {
            key: (public_override(inner) if key == 'category_override' else redact_category_overrides(inner))
            for key, inner in value.items()
        }
    if isinstance(value, list):
        return [redact_category_overrides(inner) for inner in value]
    return value
