"""
Structured audit logging for plugin operations.
"""

import os
import sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Literal

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger

AuditAction = Literal[
    "plugin.invoked",
    "plugin.completed",
    "plugin.failed",
    "plugin.enabled",
    "plugin.disabled",
    "webhook.received",
    "webhook.verified",
    "webhook.rejected",
    "message.ingested",
    "message.validated",
    "message.rejected",
    "secret.accessed",
    "config.updated",
]


@dataclass
class AuditEvent:
    """Structured audit event."""
    timestamp: str
    action: AuditAction
    plugin_id: str
    success: bool
    details: dict
    request_id: str = ""
    user_id: str = ""
    ip_address: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def emit_audit_event(
    action: AuditAction,
    plugin_id: str,
    success: bool,
    details: dict | None = None,
    request_id: str = "",
    user_id: str = "",
    ip_address: str = "",
) -> None:
    """
    Emit a structured audit event as one CloudWatch log line under ``AUDIT``.
    """
    event = AuditEvent(
        timestamp=datetime.now(UTC).isoformat(),
        action=action,
        plugin_id=plugin_id,
        success=success,
        details=details or {},
        request_id=request_id,
        user_id=user_id,
        ip_address=ip_address,
    )

    logger.info("AUDIT", extra={"audit_event": event.to_dict()})
