"""The client projection of a review's ``category_override`` audit.

The stored audit (``shared.feedback_category.override_record``) keeps the
editor's Cognito ``by_sub`` so the change stays attributable; a client never
sees it. ``redact_category_overrides`` is THE sanitiser for feedback leaving the
API: ``shared.api.create_api_resolver`` applies it to every JSON response body,
so a new route returning raw items cannot leak the subject. The same holds for an
item's ``updated_by`` change stamp (``shared.silver_provenance``): a client sees its
``kind`` only, never the ``sub``. Dependency-free on purpose — ``shared.api`` imports it.
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


# The only `updated_by` field a client ever sees (no `sub`).
PUBLIC_UPDATED_BY_FIELDS = ('kind',)


def public_updated_by(stamp: object) -> dict | None:
    """``updated_by`` as a client may see it: the actor's kind, never its ``sub``."""
    if not isinstance(stamp, Mapping):
        return None
    return {key: stamp.get(key) for key in PUBLIC_UPDATED_BY_FIELDS if key in stamp}


_PROJECTIONS = {'category_override': public_override, 'updated_by': public_updated_by}


def redact_category_overrides(value: Any) -> Any:
    """``value`` with every nested ``category_override`` / ``updated_by`` projected for a client."""
    if isinstance(value, Mapping):
        return {
            key: (_PROJECTIONS[key](inner) if key in _PROJECTIONS else redact_category_overrides(inner))
            for key, inner in value.items()
        }
    if isinstance(value, list):
        return [redact_category_overrides(inner) for inner in value]
    return value
