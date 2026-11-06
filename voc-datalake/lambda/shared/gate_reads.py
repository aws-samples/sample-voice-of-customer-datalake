"""The one keyed read an access gate makes, failing closed.

A gate (category access, source restrictions, project membership) must neither answer
"missing" nor "allowed" when DynamoDB fails: the failure is logged and becomes a JSON 500
(``ServiceError``) with the gate's own retry wording.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from shared.exceptions import ServiceError
from shared.logging import logger


def read_gate_item(table: Any, *, log_message: str, error_message: str, **get_item: Any) -> dict | None:
    """``table.get_item(**get_item)``'s item, or None when absent; a failed read logs
    ``log_message`` and raises ``ServiceError(error_message)``."""
    try:
        response = table.get_item(**get_item)
    except (ClientError, BotoCoreError) as exc:
        logger.exception(log_message)
        raise ServiceError(error_message) from exc
    item = response.get('Item') if isinstance(response, Mapping) else None
    return item if isinstance(item, dict) else None
