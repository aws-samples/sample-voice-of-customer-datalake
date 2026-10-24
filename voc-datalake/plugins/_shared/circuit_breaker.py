"""
Circuit breaker pattern for plugins.
Auto-disables plugins after repeated failures.

State lives in the AGGREGATES table (``pk``/``sk``, TTL attribute ``ttl``):

* ``FAILURES#<plugin>`` / ``<iso timestamp>`` — one row per counted failure, 24 h TTL;
* ``CIRCUIT#<plugin>`` / ``TRIPPED`` — present while the breaker is open.

It used to address the WATERMARKS table with the same ``pk``/``sk`` keys, but that
table's only key is ``source``: every query, get and delete was a
ValidationException (caught and logged), so a deployed breaker never counted a
failure and never tripped. Every ingestor already holds read/write on the
aggregates table and gets ``AGGREGATES_TABLE`` (run status), and the integrations
API reads and clears the ``TRIPPED`` row there (``lambda/shared/plugin_circuit.py``
— same key, pinned in lockstep by its tests): enabling a source or
``POST /sources/{source}/reset`` closes the breaker again.
"""

import os
import sys
from datetime import UTC, datetime, timedelta

from botocore.exceptions import BotoCoreError, ClientError

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.aws import get_dynamodb_resource, get_eventbridge_client
from shared.logging import logger, metrics

# Failures inside the window that trip the breaker. Constants, not env: no stack ever set one.
FAILURE_THRESHOLD = 5
WINDOW_MINUTES = 15
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")
MAX_ERROR_CHARS = 500
TRIPPED_SK = "TRIPPED"


def circuit_pk(plugin_id: str) -> str:
    """Partition of a plugin's TRIPPED row (mirrored by ``shared.plugin_circuit``)."""
    return f"CIRCUIT#{plugin_id}"


class CircuitBreaker:
    """Circuit breaker for plugin failure handling."""

    def __init__(self, plugin_id: str):
        self.plugin_id = plugin_id
        self._table = None

    @property
    def table(self):
        """Lazy load DynamoDB table."""
        if self._table is None and AGGREGATES_TABLE:
            self._table = get_dynamodb_resource().Table(AGGREGATES_TABLE)
        return self._table

    @property
    def _tripped_key(self) -> dict:
        return {"pk": circuit_pk(self.plugin_id), "sk": TRIPPED_SK}

    def record_failure(self, error: str) -> None:
        """Record a failure. May trigger circuit breaker."""
        if not self.table:
            logger.warning("AGGREGATES_TABLE not configured, circuit breaker disabled")
            return

        now = datetime.now(UTC)
        window_start = now - timedelta(minutes=WINDOW_MINUTES)

        failures_pk = f"FAILURES#{self.plugin_id}"
        try:
            # Get recent failures
            response = self.table.query(
                KeyConditionExpression="pk = :pk AND sk BETWEEN :start AND :end",
                ExpressionAttributeValues={
                    ":pk": failures_pk,
                    ":start": window_start.isoformat(),
                    ":end": now.isoformat(),
                },
            )

            recent_failures = len(response.get("Items", []))

            # Record this failure
            self.table.put_item(Item={
                "pk": failures_pk,
                "sk": now.isoformat(),
                "error": error[:MAX_ERROR_CHARS],
                "ttl": int((now + timedelta(hours=24)).timestamp()),  # Auto-cleanup
            })

            # Check if threshold exceeded
            if recent_failures + 1 >= FAILURE_THRESHOLD:
                self._trip_breaker(recent_failures + 1, error)

        except (BotoCoreError, ClientError) as e:
            logger.warning(f"Failed to record failure in circuit breaker: {e}", exc_info=True)

    def _trip_breaker(self, failure_count: int, last_error: str) -> None:
        """Record the trip, disable the plugin schedule, emit the audit event.

        Three INDEPENDENT steps, the row first: the row is what stops every later
        run (``is_open``) and what Settings shows and resets, so it must not
        depend on EventBridge. A failure of one step is logged and metered and
        never skips the others (it used to: a failing ``disable_rule`` aborted
        the trip before the row was written).

        INGEST_SCHEDULE_RULE_NAME is the plugin's own schedule rule, set by CDK
        (lib/stacks/ingestion-stack.ts) from the same string that names the rule
        and scopes this role's events:DisableRule grant. It is absent for an
        unscheduled plugin (no rule exists), which still records the trip so
        later runs stop at `is_open`.
        """
        self._record_trip(failure_count, last_error)
        self._disable_schedule()
        self._emit_trip_audit(failure_count, last_error)
        logger.warning(
            f"CIRCUIT BREAKER: Disabled {self.plugin_id} after {failure_count} failures"
        )

    def _record_trip(self, failure_count: int, last_error: str) -> None:
        # Blind catch: this runs inside record_failure's own `try`, and an
        # unexpected error here must not cost the schedule disable that follows.
        try:
            if self.table:
                self.table.put_item(Item={
                    **self._tripped_key,
                    "tripped_at": datetime.now(UTC).isoformat(),
                    "failure_count": failure_count,
                    "last_error": last_error[:MAX_ERROR_CHARS],
                })
        except Exception as e:
            logger.exception(f"Failed to record circuit breaker trip: {e}")
            metrics.add_metric(name="CircuitBreakerTripRecordFailed", unit="Count", value=1)

    def _disable_schedule(self) -> None:
        rule_name = os.environ.get("INGEST_SCHEDULE_RULE_NAME", "")
        if not rule_name:
            return
        try:
            get_eventbridge_client().disable_rule(Name=rule_name)
        except Exception as e:
            logger.exception(f"Failed to disable the schedule for a tripped circuit breaker: {e}")
            metrics.add_metric(name="CircuitBreakerScheduleDisableFailed", unit="Count", value=1)

    def _emit_trip_audit(self, failure_count: int, last_error: str) -> None:
        try:
            from .audit import emit_audit_event
            emit_audit_event("plugin.disabled", self.plugin_id, True, {
                "reason": "circuit_breaker",
                "failure_count": failure_count,
                "last_error": last_error,
            })
        except Exception as e:
            logger.exception(f"Failed to emit circuit breaker audit event: {e}")

    def record_success(self) -> None:
        """Record a success. Closes the breaker (deletes the TRIPPED row)."""
        if not self.table:
            return

        try:
            self.table.delete_item(Key=self._tripped_key)
        except (BotoCoreError, ClientError) as e:
            logger.debug(f"Failed to clear circuit breaker state: {e}", exc_info=True)

    def is_open(self) -> bool:
        """Check if circuit breaker is open (plugin disabled)."""
        if not self.table:
            return False

        try:
            response = self.table.get_item(Key=self._tripped_key)
        except (BotoCoreError, ClientError) as e:
            logger.debug(f"Failed to check circuit breaker state: {e}", exc_info=True)
            return False
        else:
            return "Item" in response
