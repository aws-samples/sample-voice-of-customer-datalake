"""
Circuit breaker pattern for plugins.
Auto-disables plugins after repeated failures.
"""

import os
import sys
from datetime import UTC, datetime, timedelta

from botocore.exceptions import BotoCoreError, ClientError

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.aws import get_dynamodb_resource, get_eventbridge_client
from shared.logging import logger

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

        now = datetime.now(UTC)
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

        except (BotoCoreError, ClientError) as e:
            logger.warning(f"Failed to record failure in circuit breaker: {e}", exc_info=True)

    def _trip_breaker(self, failure_count: int, last_error: str) -> None:
        """Disable the plugin schedule and record the trip.

        INGEST_SCHEDULE_RULE_NAME is the plugin's own schedule rule, set by CDK
        (lib/stacks/ingestion-stack.ts) from the same string that names the rule
        and scopes this role's events:DisableRule grant. It is absent for an
        unscheduled plugin (no rule exists), which still records the trip so
        later runs stop at `is_open`.
        """
        rule_name = os.environ.get("INGEST_SCHEDULE_RULE_NAME", "")

        try:
            if rule_name:
                get_eventbridge_client().disable_rule(Name=rule_name)

            # Record the trip
            if self.table:
                self.table.put_item(Item={
                    "pk": f"CIRCUIT#{self.plugin_id}",
                    "sk": "TRIPPED",
                    "source": f"CIRCUIT#{self.plugin_id}#TRIPPED",
                    "tripped_at": datetime.now(UTC).isoformat(),
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
            logger.exception(f"Failed to trip circuit breaker: {e}")

    def record_success(self) -> None:
        """Record a success. Resets failure count."""
        if not self.table:
            return

        try:
            # Clear the circuit breaker state on success
            self.table.delete_item(
                Key={"pk": f"CIRCUIT#{self.plugin_id}", "sk": "TRIPPED"}
            )
        except (BotoCoreError, ClientError) as e:
            logger.debug(f"Failed to clear circuit breaker state: {e}", exc_info=True)

    def is_open(self) -> bool:
        """Check if circuit breaker is open (plugin disabled)."""
        if not self.table:
            return False

        try:
            response = self.table.get_item(
                Key={"pk": f"CIRCUIT#{self.plugin_id}", "sk": "TRIPPED"}
            )
        except (BotoCoreError, ClientError) as e:
            logger.debug(f"Failed to check circuit breaker state: {e}", exc_info=True)
            return False
        else:
            return "Item" in response
