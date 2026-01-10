"""
Structured audit logging for plugin operations.
"""

import json
import os
from datetime import datetime, timezone
from typing import Literal, Optional
from dataclasses import dataclass, asdict

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger

# Try to import EventBridge client, but don't fail if not available
try:
    from shared.aws import get_eventbridge_client
    HAS_EVENTBRIDGE = True
except ImportError:
    HAS_EVENTBRIDGE = False

AUDIT_EVENT_BUS = os.environ.get("AUDIT_EVENT_BUS", "")

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
    details: Optional[dict] = None,
    request_id: str = "",
    user_id: str = "",
    ip_address: str = "",
) -> None:
    """
    Emit a structured audit event.
    
    Events are:
    1. Logged to CloudWatch (always)
    2. Sent to EventBridge (if configured)
    """
    event = AuditEvent(
        timestamp=datetime.now(timezone.utc).isoformat(),
        action=action,
        plugin_id=plugin_id,
        success=success,
        details=details or {},
        request_id=request_id,
        user_id=user_id,
        ip_address=ip_address,
    )

    # Always log to CloudWatch
    logger.info("AUDIT", extra={"audit_event": event.to_dict()})

    # Optionally send to EventBridge for downstream processing
    if AUDIT_EVENT_BUS and HAS_EVENTBRIDGE:
        try:
            events = get_eventbridge_client()
            events.put_events(Entries=[{
                "Source": "voc.plugins",
                "DetailType": f"Plugin Audit: {action}",
                "Detail": json.dumps(event.to_dict()),
                "EventBusName": AUDIT_EVENT_BUS,
            }])
        except Exception as e:
            logger.warning(f"Failed to send audit event to EventBridge: {e}")
