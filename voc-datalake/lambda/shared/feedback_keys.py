"""The DynamoDB key of a processed feedback item whose producer sent its own id.

ONE derivation, shared by the processor (which writes the item) and the manual-import
API (whose CSV dataset preview reads it back before anything is queued). The two
drifting apart would make the preview look up keys the processor never writes, so
every changed row would read as new and its update would be skipped as a duplicate.

A PERSISTED CONTRACT: every stored item was keyed with it. Never edit the recipe.
"""
from __future__ import annotations

import hashlib
from typing import Final

__all__ = ['FEEDBACK_ID_LENGTH', 'feedback_item_id', 'feedback_item_key']

#: Hex characters of the stored ``feedback_id``.
FEEDBACK_ID_LENGTH: Final = 32


def feedback_item_id(source_platform: str, source_id: str) -> str:
    """The ``feedback_id`` the processor stores for message ``id`` ``source_id`` from ``source_platform``."""
    content = f"{source_platform}:{source_id}"
    return hashlib.sha256(content.encode()).hexdigest()[:FEEDBACK_ID_LENGTH]


def feedback_item_key(source_platform: str, source_id: str) -> dict[str, str]:
    """``{pk, sk}`` of that item (``source_platform`` is also the ``SOURCE#`` partition when no brand is sent)."""
    return {
        'pk': f"SOURCE#{source_platform}",
        'sk': f"FEEDBACK#{feedback_item_id(source_platform, source_id)}",
    }
