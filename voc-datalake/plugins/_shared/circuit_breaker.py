"""
Circuit breaker pattern for plugins.
Auto-disables plugins after repeated failures.
"""

import os
from datetime import datetime, timezone, timedelta

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger
from shared.aws import get_dynamodb_resource

# Try to import EventBridge client
try:
    from shared.aws import get_eventbridge_client
    HAS_EVENTBRIDGE = True
except ImportError:
    HAS_EVENTBRIDGE = False

FAILURE_THRESHOLD = int(os.environ.get("CIRCUIT_BREAKER_THRESHOLD", "5"))
WINDOW_MINUTES = int(os.environ.get("CIRCUIT_BREAKER_WINDOW", "15"))
WATERMARKS_TABLE = os.environ.get("WATERMARKS_TABLE", "")


class CircuitBreaker:
    """Circuit breaker for plugin failure handling."""

    def __init__(self, plugin_id: str):
        self.plugin_id = plugin_id
        self._table = None

    @property
    def table(self):
        """Lazy load DynamoDB table."""
        if self._table is None and WATERMARKS_TABLE:
            self._table = get_dynamodb_resource().Table(WATERMARKS_TABLE)
        return self._table

    def record_failure(self, error: str) -> None:
        """Record a failure. May trigger circuit breaker."""
        if not self.table:
            logger.warning("WATERMARKS_TABLE not configured, circuit breaker disabled")
            return

        now = datetime.now(timezone.utc)
        window_start = now - timedelta(minutes=WINDOW_MINUTES)

        try:
            # Get recent failures
            response = self.table.query(
                KeyConditionExpression="pk = :pk AND sk BETWEEN :start AND :end",
                ExpressionAttributeValues={
                    ":pk": f"FAILURES#{self.plugin_id}",
                    ":start": window_start.isoformat(),
                    ":end": now.isoformat(),
                },
            )

            recent_failures = len(response.get("Items", []))

            # Record this failure
            self.table.put_item(Item={
                "pk": f"FAILURES#{self.plugin_id}",
                "sk": now.isoformat(),
                "source": f"FAILURES#{self.plugin_id}#{now.isoformat()}",  # For GSI compatibility
                "error": error[:500],  # Truncate
                "ttl": int((now + timedelta(hours=24)).timestamp()),  # Auto-cleanup
            })

            # Check if threshold exceeded
            if recent_failures + 1 >= FAILURE_THRESHOLD:
                self._trip_breaker(recent_failures + 1, error)

        except Exception as e:
            logger.warning(f"Failed to record failure in circuit breaker: {e}")

    def _trip_breaker(self, failure_count: int, last_error: str) -> None:
        """Disable the plugin schedule."""
        rule_name = f"voc-ingest-{self.plugin_id}-schedule"

        try:
            if HAS_EVENTBRIDGE:
                events = get_eventbridge_client()
                events.disable_rule(Name=rule_name)

            # Record the trip
            if self.table:
                self.table.put_item(Item={
                    "pk": f"CIRCUIT#{self.plugin_id}",
                    "sk": "TRIPPED",
                    "source": f"CIRCUIT#{self.plugin_id}#TRIPPED",
                    "tripped_at": datetime.now(timezone.utc).isoformat(),
                    "failure_count": failure_count,
                    "last_error": last_error[:500],
                })

            # Emit audit event
            from .audit import emit_audit_event
            emit_audit_event("plugin.disabled", self.plugin_id, True, {
                "reason": "circuit_breaker",
                "failure_count": failure_count,
                "last_error": last_error,
            })

            logger.warning(
                f"CIRCUIT BREAKER: Disabled {self.plugin_id} after {failure_count} failures"
            )

        except Exception as e:
            logger.error(f"Failed to trip circuit breaker: {e}")

    def record_success(self) -> None:
        """Record a success. Resets failure count."""
        if not self.table:
            return

        try:
            # Clear the circuit breaker state on success
            self.table.delete_item(
                Key={"pk": f"CIRCUIT#{self.plugin_id}", "sk": "TRIPPED"}
            )
        except Exception as e:
            logger.debug(f"Failed to clear circuit breaker state: {e}")

    def is_open(self) -> bool:
        """Check if circuit breaker is open (plugin disabled)."""
        if not self.table:
            return False

        try:
            response = self.table.get_item(
                Key={"pk": f"CIRCUIT#{self.plugin_id}", "sk": "TRIPPED"}
            )
            return "Item" in response
        except Exception as e:
            logger.debug(f"Failed to check circuit breaker state: {e}")
            return False
