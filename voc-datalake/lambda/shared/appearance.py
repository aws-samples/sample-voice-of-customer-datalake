"""The workspace's colour theme: the start theme every person sees until they pick their own.

Stored in voc-aggregates as ``SETTINGS#appearance`` / ``config`` with ``default_theme``.
No row (or a stored id this build no longer ships) answers :data:`DEFAULT_THEME`.

:data:`THEME_IDS` mirrors ``COLOR_THEME_IDS`` in ``frontend/src/theme/themeCatalog.ts``
(pinned by ``shared/test/test_appearance.py``).
"""
from __future__ import annotations

from typing import Any, Final

APPEARANCE_PK: Final = 'SETTINGS#appearance'
APPEARANCE_SK: Final = 'config'

THEME_IDS: Final = ('kiro', 'nord', 'dracula', 'highcontrast', 'quick')
DEFAULT_THEME: Final = 'kiro'


def is_theme_id(value: object) -> bool:
    """True when ``value`` is one of the shipped theme ids."""
    return isinstance(value, str) and value in THEME_IDS


def appearance_view(item: dict[str, Any] | None) -> dict[str, str]:
    """The ``{default_theme}`` answer for a stored row (or none)."""
    stored = (item or {}).get('default_theme')
    return {'default_theme': stored if isinstance(stored, str) and stored in THEME_IDS else DEFAULT_THEME}


def parse_default_theme(body: dict[str, Any]) -> str:
    """The ``default_theme`` of a PUT body, or a ``ValueError`` naming the accepted ids."""
    value = body.get('default_theme')
    if not isinstance(value, str) or value not in THEME_IDS:
        raise ValueError(f"default_theme must be one of: {', '.join(THEME_IDS)}")
    return value
