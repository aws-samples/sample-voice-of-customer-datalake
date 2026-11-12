"""
Circuit breaker pattern for plugins: one breaker per plugin, and per workspace for a run in one.

State lives in the AGGREGATES table (``pk``/``sk``, TTL attribute ``ttl``):

* ``FAILURES#<plugin>`` / ``<iso timestamp>`` — one row per counted failure, 24 h TTL;
* ``CIRCUIT#<plugin>`` / ``TRIPPED`` — present while the breaker is open.

Those are the deployment-wide rows, of a run whose event names no workspace (the API's
Run now and reprocess, an S3 upload, the scheduled tick's own run). A trip there also
disables the plugin's EventBridge schedule, as it always did; that one rule is also what
fans out to every workspace (base_ingestor.py ``fan_out_once``), so a deployment-wide trip
(like ``PUT /sources/{source}/disable``) stops every workspace's scheduled runs too, until
the source is enabled again. The integrations API
reads and clears the ``TRIPPED`` row (``lambda/shared/plugin_circuit.py`` — same key,
pinned in lockstep by its tests): enabling a source or ``POST /sources/{source}/reset``
closes the breaker again. That path stays until phase 2's last slice moves the API, the
S3 trigger and the processor onto workspaces (docs/multi-workspace.md).

A run in a workspace keeps its own rows, ``WS#{ws}#FAILURES#<plugin>`` and
``WS#{ws}#CIRCUIT#<plugin>`` / ``TRIPPED`` (``plugin_circuit.workspace_tripped_key``). Its
trip stops that workspace's runs (``is_open``) and disables no schedule: the plugin's one
rule serves every workspace (the tick fans out), so one workspace's failing credentials
must not stop the others. The API's status and reset do not reach those rows yet; an
operator resets one by deleting its ``TRIPPED`` row.

It once addressed the WATERMARKS table with the same ``pk``/``sk`` keys, but that table's
only key is ``source``: every query, get and delete was a ValidationException (caught and
logged), so a deployed breaker never counted a failure and never tripped.
"""

import os
import sys
from datetime import UTC, datetime, timedelta

from botocore.exceptions import BotoCoreError, ClientError

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.aws import get_dynamodb_resource, get_eventbridge_client
from shared.ingest_tables import ingest_table
from shared.logging import logger, metrics
from shared.plugin_circuit import tripped_key, workspace_tripped_key
from shared.timestamps import now_iso
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope

# Failures inside the window that trip the breaker. Constants, not env: no stack ever set one.
FAILURE_THRESHOLD = 5
WINDOW_MINUTES = 15
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")
MAX_ERROR_CHARS = 500


def failures_pk(scope: WorkspaceScope | None, plugin_id: str) -> str:
    """Partition of a plugin's counted failures: ``FAILURES#<plugin>``, or ``WS#{ws}#FAILURES#<plugin>`` in a
    workspace."""
    return f"FAILURES#{plugin_id}" if scope is None else scope.key("FAILURES", plugin_id)


class CircuitBreaker:
    """Circuit breaker for plugin failure handling, deployment-wide (``scope`` None) or in one workspace."""

    def __init__(self, plugin_id: str, scope: WorkspaceScope | None = None):
        self.plugin_id = plugin_id
        self.scope = scope
        self._table = None

    @property
    def table(self):
        """Lazy load the aggregates table (through the workspace layer for a run in a workspace)."""
        if self._table is None and AGGREGATES_TABLE:
            self._table = ingest_table(self.scope, get_dynamodb_resource(), AGGREGATES_TABLE)
        return self._table

    @property
    def _tripped_key(self) -> dict:
        if self.scope is None:
            return tripped_key(self.plugin_id)
        return workspace_tripped_key(self.scope, self.plugin_id)

    def record_failure(self, error: str) -> None:
        """Record a failure. May trigger circuit breaker."""
        if not self.table:
            logger.warning("AGGREGATES_TABLE not configured, circuit breaker disabled")
            return

        now = datetime.now(UTC)
        window_start = now - timedelta(minutes=WINDOW_MINUTES)

        partition = failures_pk(self.scope, self.plugin_id)
        try:
            # Get recent failures
            response = self.table.query(
                "pk", partition,
                sort_condition="sk BETWEEN :start AND :end",
                ExpressionAttributeValues={
                    ":start": window_start.isoformat(),
                    ":end": now.isoformat(),
                },
            )

            recent_failures = len(response.get("Items", []))

            # Record this failure
            self.table.put_item({
                "pk": partition,
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
        """Record the trip, disable the plugin schedule (deployment-wide only), emit the audit event.

        INDEPENDENT steps, the row first: the row is what stops every later run
        (``is_open``) and what Settings shows and resets, so it must not depend on
        EventBridge. A failure of one step is logged and metered and never skips
        the others (it used to: a failing ``disable_rule`` aborted the trip before
        the row was written).

        INGEST_SCHEDULE_RULE_NAME is the plugin's own schedule rule, set by CDK
        (lib/stacks/ingestion-stack.ts) from the same string that names the rule
        and scopes this role's events:DisableRule grant. It is absent for an
        unscheduled plugin (no rule exists), which still records the trip so
        later runs stop at `is_open`. A run in a workspace never disables it: the
        rule serves every workspace, which is also why a deployment-wide trip's
        disable stops every workspace's ticks (module doc).
        """
        self._record_trip(failure_count, last_error)
        if self.scope is None:
            self._disable_schedule()
        self._emit_trip_audit(failure_count, last_error)
        if self.scope is None:
            logger.warning(f"CIRCUIT BREAKER: Disabled {self.plugin_id} after {failure_count} failures")
        else:
            logger.warning(
                f"CIRCUIT BREAKER: {self.plugin_id} stopped in workspace {self.scope.ws} after {failure_count} failures"
            )

    def _record_trip(self, failure_count: int, last_error: str) -> None:
        # Blind catch: this runs inside record_failure's own `try`, and an
        # unexpected error here must not cost the steps that follow.
        try:
            if self.table:
                self.table.put_item({
                    **self._tripped_key,
                    "tripped_at": now_iso(),
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
            details = {"reason": "circuit_breaker", "failure_count": failure_count, "last_error": last_error}
            if self.scope is not None:
                details[WORKSPACE_FIELD] = self.scope.ws
            emit_audit_event("plugin.disabled", self.plugin_id, True, details)
        except Exception as e:
            logger.exception(f"Failed to emit circuit breaker audit event: {e}")

    def record_success(self) -> None:
        """Record a success. Closes the breaker (deletes the TRIPPED row)."""
        if not self.table:
            return

        try:
            self.table.delete_item(self._tripped_key)
        except (BotoCoreError, ClientError) as e:
            logger.debug(f"Failed to clear circuit breaker state: {e}", exc_info=True)

    def is_open(self) -> bool:
        """Check if circuit breaker is open (plugin disabled; in a workspace: stopped there)."""
        if not self.table:
            return False

        try:
            response = self.table.get_item(self._tripped_key)
        except (BotoCoreError, ClientError) as e:
            logger.debug(f"Failed to check circuit breaker state: {e}", exc_info=True)
            return False
        else:
            return "Item" in response
