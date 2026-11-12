"""
Base Ingestor - Common functionality for all VoC data source ingestors.
Uses DynamoDB for watermarks and SQS for processing queue.

Two paths (docs/multi-workspace.md, phase 2 "ingestion"; ``run_in_workspace``):

* A run in a workspace: its event names it in ``workspace_id`` (the scheduled tick's
  per-workspace invoke, a continuation part of one) and the verified scope comes from it
  (``shared/ws_repo.py scope_from_message``). Everything it keeps is the workspace's:
  watermarks (``WS#{ws}#{plugin}#{key}``), the ``WS#{ws}#SOURCE_RUN#`` rows, the circuit
  breaker, the raw objects (``ws/{ws}/raw/...``), the credentials (the workspace's own
  secret), and every queued message carries ``workspace_id``. A ``workspace_id`` that is not
  a workspace id is refused.
* A deployment-wide run: its event names no workspace (the API's Run now, scraper run and
  reprocess, an S3 upload, the scheduled tick's own run). It does exactly what it did before
  workspaces (``{plugin}#{key}`` watermarks, ``SOURCE_RUN#`` rows, the shared secret, ``raw/``).
  This path stays until phase 2's last slice moves the API, the S3 trigger and the
  processor onto workspaces, and is then removed.
"""

import os
import sys
from abc import ABC, abstractmethod
from collections.abc import Callable, Generator, Mapping
from datetime import UTC, datetime
from typing import TypeGuard

from botocore.exceptions import BotoCoreError, ClientError

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.aws import (
    clear_secret_cache,
    get_dynamodb_resource,
    get_s3_client,
    get_secret,
    get_sqs_client,
)
from shared.exceptions import ConfigurationError, SecretUnreadableError
from shared.idempotency import dedupe_claim_item
from shared.ingest_tables import ingest_table
from shared.logging import logger, metrics, tracer
from shared.timestamps import now_iso
from shared.workspace_ids import credentials_secret_name
from shared.workspace_plugins import workspaces_with_plugin
from shared.ws_repo import (
    WATERMARK_PARTITION,
    WORKSPACE_FIELD,
    WorkspaceScope,
    message_scope,
    source_run_pk,
    watermark_key,
)

from .audit import emit_audit_event
from .circuit_breaker import CircuitBreaker
from .normalized_item import normalized_item_fields
from .plugin_secrets import filter_plugin_secrets
from .raw_archive import archive_raw_item
from .raw_source import pop_raw_source
from .self_invoke import invoke_self
from .source_policy_gate import policy_messages
from .sqs_utils import send_messages_to_queue

# The ingestor handlers import the Powertools singletons from here.
__all__ = ["BaseIngestor", "logger", "metrics", "run_in_workspace", "tracer"]

# Configuration from environment
WATERMARKS_TABLE = os.environ.get("WATERMARKS_TABLE", "")
PROCESSING_QUEUE_URL = os.environ.get("PROCESSING_QUEUE_URL", "")
RAW_DATA_BUCKET = os.environ.get("RAW_DATA_BUCKET", "")
# The shared secret, read by a deployment-wide run (an event that names no workspace).
SECRETS_ARN = os.environ.get("SECRETS_ARN", "")
# The workspaces' credentials secrets, `{prefix}/{ws}/credentials` (lib/stacks/ingestion-stack.ts).
WORKSPACE_SECRET_PREFIX = os.environ.get("WORKSPACE_SECRET_PREFIX", "")
# voc-workspaces: the scheduled tick reads the workspaces that enabled this plugin (shared/workspace_plugins.py).
WORKSPACES_TABLE = os.environ.get("WORKSPACES_TABLE", "")
BRAND_NAME = os.environ.get("BRAND_NAME", "")
SOURCE_PLATFORM = os.environ.get("SOURCE_PLATFORM", "")
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")

# voc-idempotency: the scheduled tick's claim, so a retried delivery fans out no second time.
IDEMPOTENCY_TABLE = os.environ.get("IDEMPOTENCY_TABLE", "")

# An EventBridge scheduled event (the plugin's schedule rule): the tick.
SCHEDULED_EVENT_SOURCE = "aws.events"
SCHEDULED_EVENT_DETAIL_TYPE = "Scheduled Event"
# The tick's claim key: `ingestor#fanout#{plugin}#{EventBridge event id}`.
FAN_OUT_CLAIM_PREFIX = "ingestor#fanout#"


def is_scheduled_tick(event: object) -> TypeGuard[Mapping]:
    """Whether *event* is the plugin's schedule firing (an EventBridge ``Scheduled Event`` naming no workspace).

    Anyone allowed to invoke the function could send this shape too; all it does is the deployment-wide run and
    the fan-out below, which runs each workspace that enabled the plugin as its own tick would.
    """
    return (isinstance(event, Mapping) and WORKSPACE_FIELD not in event
            and event.get("source") == SCHEDULED_EVENT_SOURCE
            and event.get("detail-type") == SCHEDULED_EVENT_DETAIL_TYPE)


def fan_out_tick(plugin_id: str) -> dict:
    """The scheduled tick's per-workspace runs: invoke this function asynchronously once per workspace that enabled
    *plugin_id*, with ``{"workspace_id": ws}`` and nothing else (each a scheduled run of that workspace).

    The list is ``workspaces_with_plugin`` (one paged Query of ``PLUGIN#{plugin_id}`` in voc-workspaces); a read
    that fails raises (``fan_out_once`` logs and meters it: no workspace runs on that tick). A workspace whose invoke fails is logged and counted (``IngestFanOutFailures``) and the rest
    still run; its next tick catches up from its watermarks. A tripped breaker is not checked here: the
    workspace's own run skips at once (``BaseIngestor.run``).
    """
    if not WORKSPACES_TABLE:
        raise ConfigurationError("The scheduled tick needs WORKSPACES_TABLE")
    # voc-workspaces, the control plane (not a data-path table): read only for the PLUGIN# partition.
    # (invoke_self refuses to run without AWS_LAMBDA_FUNCTION_NAME: each workspace's invoke then counts as failed.)
    workspaces = workspaces_with_plugin(ingest_table(None, get_dynamodb_resource(), WORKSPACES_TABLE).table, plugin_id)
    failed = 0
    for ws in workspaces:
        try:
            invoke_self({WORKSPACE_FIELD: ws})
        except (BotoCoreError, ClientError, RuntimeError) as error:
            failed += 1
            logger.exception(f"Scheduled run not started: {type(error).__name__}", extra={"workspace_id": ws})
    if failed:
        metrics.add_metric(name="IngestFanOutFailures", unit="Count", value=failed)
    logger.info("Scheduled tick fanned out", extra={"workspaces": len(workspaces), "failed": failed})
    return {"status": "fanned_out", "workspaces": len(workspaces) - failed, "failed": failed}


def _claim_the_tick(plugin_id: str, event: Mapping) -> bool:
    """Whether this delivery of the tick is the first: a conditional put (a one-item transaction) of
    ``ingestor#fanout#{plugin}#{EventBridge event id}`` in the idempotency table (``shared/idempotency.py``
    ``dedupe_claim_item``, its normal TTL). Lambda's asynchronous retries of a tick whose deployment-wide run raised
    carry the same event id, so they find the claim and fan out no second time. Raises when the claim cannot be
    attempted (no table, no event id, any other DynamoDB error)."""
    event_id = event.get("id")
    if not IDEMPOTENCY_TABLE or not isinstance(event_id, str) or not event_id:
        raise ConfigurationError("The scheduled tick's fan-out needs IDEMPOTENCY_TABLE and the event's id")
    # The aggregator's claim, alone in its transaction: what it guards is the invokes after it, not writes beside it.
    claim = dedupe_claim_item(
        IDEMPOTENCY_TABLE, f"{FAN_OUT_CLAIM_PREFIX}{plugin_id}#{event_id}", int(datetime.now(UTC).timestamp()))
    try:
        get_dynamodb_resource().meta.client.transact_write_items(TransactItems=[claim])
    except ClientError as error:
        # The claim's own reason (the only item: index 0) is ConditionalCheckFailed when, and only when, an earlier
        # delivery holds the key; any other cancellation or error raises (logged and metered by fan_out_once).
        reasons = error.response.get("CancellationReasons") or []
        if [reason.get("Code") for reason in reasons] == ["ConditionalCheckFailed"]:
            return False
        raise
    return True


def fan_out_once(plugin_id: str, event: Mapping) -> None:
    """The tick's fan-out, at most once per tick (``_claim_the_tick``) and never raising: it runs BEFORE the tick's
    deployment-wide run, whose own outcome (its result, or its exception and Lambda's asynchronous retries) must
    stay exactly as it was, and which may time out. A failed claim or fan-out is logged and metered
    (``IngestFanOutFailures``): no workspace runs on this tick, and the next tick tries again."""
    try:
        if not _claim_the_tick(plugin_id, event):
            logger.info("Scheduled tick already fanned out (a retried delivery)", extra={"event_id": event.get("id")})
            return
        fan_out_tick(plugin_id)
    except Exception as error:  # the deployment-wide run must run whatever happens here: logged and metered
        logger.exception(f"Scheduled tick not fanned out: {type(error).__name__}")
        metrics.add_metric(name="IngestFanOutFailures", unit="Count", value=1)


def run_in_workspace(event: object, run: Callable[[WorkspaceScope | None], dict]) -> dict:
    """The one entry of every ingestor's ``lambda_handler`` (docs/multi-workspace.md).

    * An event that names a workspace in ``workspace_id`` (the fan-out's runs, a continuation part of one) runs
      ``run(scope)`` in it. One that names something that is not a workspace id is refused (logged and metered,
      ``{"status": "refused"}``; never raised, so Lambda does not retry it), and never runs deployment-wide instead.
    * An event that names none (the API's Run now, scraper run and reprocess, an S3 upload's trigger) runs
      ``run(None)``: the deployment-wide path, exactly as before workspaces. That path stays until phase 2's last
      slice moves the API, the S3 trigger and the processor onto workspaces, and is then removed.
    * The scheduled tick first fans out to the workspaces that enabled the plugin (``fan_out_tick``, each its own
      invoke), at most once per tick (``fan_out_once``), then runs the deployment-wide run as before.
    """
    # The scope the event names (shared/ws_repo.py message_scope, as the feedback processor reads its messages):
    # None when it names none, refused when its workspace_id is not a workspace id (never run deployment-wide).
    refused, scope = message_scope(event)
    if refused:
        logger.error("Ingestor event refused: its workspace_id is not a workspace id", extra={"plugin_id": SOURCE_PLATFORM})
        metrics.add_metric(name="IngestorEventRefused", unit="Count", value=1)
        return {"status": "refused", "reason": "invalid_workspace"}
    if is_scheduled_tick(event):
        fan_out_once(SOURCE_PLATFORM, event)
    return run(scope)


class BaseIngestor(ABC):
    """Base class for all data source ingestors: one run of one plugin, deployment-wide or in one workspace."""

    def __init__(self, scope: WorkspaceScope | None, execution_id: str | None = None):
        """
        Args:
            scope: The workspace of this run, from its event (``run_in_workspace``): every key, object and the
                secret read below are this workspace's. None for a deployment-wide run (an event that names no
                workspace), which keeps the deployment-wide keys, objects and shared secret it always had.
            execution_id: Present on manual ("Run now") invocations. Passing it
                here — rather than assigning the attribute post-construction —
                matters: manual runs clear the shared secret cache BEFORE the
                secret is read below, so a warm container picks up credentials
                saved moments ago (Save-then-Run-now, issues #141/#215).
                Scheduled runs keep the warm cache.
        """
        self.scope = scope
        self.execution_id = execution_id
        if execution_id:
            clear_secret_cache()
        self.source_platform = SOURCE_PLATFORM
        self.brand_name = BRAND_NAME
        # Everything the failure path needs is wired BEFORE the secret is read.
        # Since issue #251 a namespace miss raises here rather than silently
        # widening to the whole shared secret, so construction failing is a
        # routine outcome — and a raise out of __init__ never reaches run()'s
        # except block, which is what tells the operator anything (see
        # _report_construction_failure). Ordering this after the read is what left
        # a manual run's status record stranded at 'running' with a permanent
        # spinner in the UI.
        # In a workspace both tables are seen through it (shared/ws_repo.py: a key outside it is refused before any
        # call); deployment-wide, the tables themselves (shared/ingest_tables.py), as before.
        self.watermarks_table = ingest_table(scope, get_dynamodb_resource(), WATERMARKS_TABLE, key=WATERMARK_PARTITION)
        self.aggregates_table = (
            ingest_table(scope, get_dynamodb_resource(), AGGREGATES_TABLE) if AGGREGATES_TABLE else None
        )
        self.circuit_breaker = CircuitBreaker(self.source_platform, scope)
        self._s3 = get_s3_client()
        self._sqs = get_sqs_client()
        try:
            self.secrets = self._load_secrets()
        except ConfigurationError as error:
            self._report_construction_failure(error)
            raise

    def _report_construction_failure(self, error: Exception) -> None:
        """Give a construction-time failure the same reporting run() gives its own.

        ``_load_secrets`` runs in ``__init__``, and every ``lambda_handler``
        constructs the ingestor before calling ``run()`` — so a raise from here
        bypasses run()'s ``except`` entirely. Three things that block go on to do
        are what the operator actually sees, and all three were missing:

          * the ``SOURCE_RUN#`` record stays at 'running', which
            ``integrations_handler.run_source`` wrote before invoking us and which
            the Scrapers UI polls with no timeout — so a manual "Run now" spins
            forever and the diagnosis exists only in CloudWatch;
          * the circuit breaker never counts the failure, so a plugin broken this
            way does not auto-disable its schedule (a deployment-wide run) or
            stop in its workspace (a run in one);
          * no ``plugin.failed`` audit event is emitted.

        The breaker is the exception, and deliberately so: a
        ``SecretUnreadableError`` is NOT counted. ``get_secret`` swallows every
        client error into ``{}``, so an unreadable secret may be an AWS-side
        throttle the plugin did nothing to cause — and at the default threshold
        (5 failures in 15 minutes) counting it lets a handful of blips call
        ``_trip_breaker``, which disables the plugin's EventBridge schedule on a
        deployment-wide run (nothing in this tree re-enables a disabled rule) and
        stops the plugin in its workspace on a run in one; either way ingestion
        would stop until an operator noticed. Only the trip is withheld; the audit
        event still fires, and the run record does too on a MANUAL run — on a
        scheduled one there is no ``SOURCE_RUN#`` record to move, which is why the
        audit event is the only remaining signal and why losing it mattered. See
        ``docs/plugin-architecture.md`` on the alarm this exemption relies on. A
        misconfiguration — a malformed identity or a namespace that
        matches nothing — is a plain ``ConfigurationError`` and still counts, since
        retrying it forever is exactly what the breaker exists to stop.

        Reported HERE rather than in each plugin's ``lambda_handler`` for the same
        reason the manual-run cache clear is centralized (#141/#215): a per-handler
        wrapper is one a new plugin can forget, and forgetting it is silent.

        Each step is INDEPENDENTLY guarded, and one step is not merely tidier than
        one shared ``try`` — it is the difference between reporting and not.
        ``CircuitBreaker.record_failure`` looks exception-safe but is not on its
        first line: ``self.table`` is a property that calls
        ``get_dynamodb_resource()`` OUTSIDE record_failure's own ``try``, so a
        failure constructing that resource escapes it. Under one shared ``try``
        that landed in the catch below and the audit event two lines later never
        ran — losing the ONLY signal a scheduled run leaves behind, since
        ``_update_source_run_status`` is a no-op without an ``execution_id``. That
        is also the correlated case: the same DynamoDB trouble affects both.

        Ordered audit-event first as well, but the per-step guards are what carry
        the guarantee — the order alone is defence in depth and should not be
        mistaken for the fix (with the guards in place, reordering these three
        changes nothing, which is the point). ``emit_audit_event`` swallows its own
        EventBridge errors and always logs, so it is the cheapest and most reliable
        of the three; running it first means it survives even a future edit that
        reintroduces a shared ``try``.

        Never raises. It runs while a ConfigurationError is propagating, and
        replacing that error with a DynamoDB one would hide the thing worth
        reporting.
        """
        unreadable = isinstance(error, SecretUnreadableError)

        # Deliberately blind catches: narrowing them means enumerating what three
        # AWS clients can raise, and anything missed REPLACES the
        # ConfigurationError being propagated with an unrelated one — hiding the
        # only message that names the prefix the plugin expected. Pinned by
        # test_the_report_does_not_replace_the_error_the_operator_needs.
        try:
            emit_audit_event("plugin.failed", self.source_platform, False, {
                "error": str(error),
                "error_type": type(error).__name__,
                "phase": "construction",
                # Names WHY the breaker did not count this one, so an operator
                # reading the audit trail after a burst of these does not conclude
                # the breaker is broken.
                "counted_against_circuit_breaker": not unreadable,
                **self._workspace_fields(),
            })
        except Exception as reporting_error:  # noqa: BLE001 — reporting must never mask the original failure; logged
            logger.warning(f"Failed to emit construction failure audit event: {reporting_error}")

        # The exception TYPE only, the same rule as run()'s path (#263): the
        # run-status row is returned to every signed-in user, and a construction
        # error's text names the secret prefix and keys the plugin expected. The
        # full text is in the audit event above.
        try:
            self._update_source_run_status({
                'status': 'error',
                'items_found': 0,
                'completed_at': now_iso(),
                'errors': [type(error).__name__],
            })
        except Exception as reporting_error:  # noqa: BLE001 — reporting must never mask the original failure; logged
            logger.warning(f"Failed to record construction failure run status: {reporting_error}")

        if not unreadable:
            try:
                self.circuit_breaker.record_failure(str(error))
            except Exception as reporting_error:  # noqa: BLE001 — reporting must never mask the original failure; logged
                logger.warning(f"Failed to record construction failure with the circuit breaker: {reporting_error}")

    def _workspace_fields(self) -> dict:
        """``{"workspace_id": ws}`` for a run in a workspace; nothing for a deployment-wide run."""
        return {} if self.scope is None else {WORKSPACE_FIELD: self.scope.ws}

    def _audit(self, action, success: bool, details: dict | None = None) -> None:
        """One audit event of this run; a run in a workspace names it (``workspace_id``) beside *details*."""
        emit_audit_event(action, self.source_platform, success, {**(details or {}), **self._workspace_fields()})

    def _watermark_source(self, key: str) -> str:
        """The watermark's key: ``{plugin}#{key}`` deployment-wide, ``WS#{ws}#{plugin}#{key}`` in a workspace."""
        if self.scope is None:
            return f"{self.source_platform}#{key}"
        return watermark_key(self.scope, self.source_platform, key)

    def _source_run_pk(self) -> str:
        """The run row's partition: ``SOURCE_RUN#{plugin}`` deployment-wide (what the API polls), else
        ``WS#{ws}#SOURCE_RUN#{plugin}``."""
        if self.scope is None:
            return f"SOURCE_RUN#{self.source_platform}"
        return source_run_pk(self.scope, self.source_platform)

    def _load_secrets(self) -> dict:
        """
        Load this plugin's API credentials: for a run in a workspace from the
        WORKSPACE's own Secrets Manager secret, ``{prefix}/{ws}/credentials``
        (decision 8, docs/multi-workspace.md), the name built from the run's verified
        scope only (``workspace_ids.credentials_secret_name``), never from anything else in the
        event; for a deployment-wide run from the shared secret (``SECRETS_ARN``), as
        before (lib/stacks/ingestion-roles.ts grants both and no other secret).

        Keys are stored namespaced as ``<plugin_id>_<key>``; ``filter_plugin_secrets``
        returns only this plugin's namespace with the prefix stripped, and RAISES
        rather than widening when the namespace matches nothing (issue #251 — the
        old ``filtered if filtered else all_secrets`` turned a typo'd plugin id
        into cross-plugin credential access). See ``_shared/plugin_secrets.py`` for
        why the "keys with no known prefix are shared/legacy" branch, and the
        plugin-id list it needed, are gone.

        An absent SECRETS_ARN / WORKSPACE_SECRET_PREFIX stays a warning rather than
        a raise: that is the env-var-not-wired case, not a namespace mismatch, and no
        secret is read at all — so there is nothing to over-share. It is also what a
        plugin invoked outside the CDK-built environment (a local smoke run) hits.

        A new workspace's secret holds ``{}`` until its credentials are saved, which
        reads as ``SecretUnreadableError`` (not counted by the breaker).
        """
        if self.scope is None:
            if not SECRETS_ARN:
                logger.warning("SECRETS_ARN not configured")
                return {}
            secret_name = SECRETS_ARN
        else:
            if not WORKSPACE_SECRET_PREFIX:
                logger.warning("WORKSPACE_SECRET_PREFIX not configured")
                return {}
            secret_name = credentials_secret_name(WORKSPACE_SECRET_PREFIX, self.scope.ws)

        all_secrets = get_secret(secret_name)
        if not all_secrets:
            # `get_secret` is lru_cached and swallows EVERY exception into `{}`,
            # so a throttle or timeout memoizes an empty payload under the name.
            # filter_plugin_secrets refuses to run on it (correctly), but without
            # this eviction the refusal is permanent: every later invocation in
            # the warm container re-reads the cached `{}` and raises again with no
            # further API call. Only a manual "Run now" clears the cache, so a
            # SCHEDULED plugin would stay wedged for the container's lifetime
            # after a single transient blip. Evicting here costs one extra read on
            # the next invocation and makes the failure retry-safe.
            clear_secret_cache()

        return filter_plugin_secrets(self.source_platform, all_secrets)

    def get_watermark(self, key: str, default: str | None = None) -> str | None:
        """Get watermark for a specific source/key from DynamoDB.

        Watermarks are only ever written as strings (``set_watermark``), so a
        stored value that is not a string is treated like a missing one.
        """
        try:
            response = self.watermarks_table.get_item({"source": self._watermark_source(key)})
        except (BotoCoreError, ClientError) as e:
            logger.warning(f"Failed to get watermark: {e}", exc_info=True)
            return default
        value = response.get("Item", {}).get("value", default)
        return value if isinstance(value, str) else default

    def set_watermark(self, key: str, value: str):
        """Set watermark for a specific source/key in DynamoDB (``_watermark_source``)."""
        try:
            self.watermarks_table.put_item(
                {
                    "source": self._watermark_source(key),
                    "value": value,
                    "updated_at": now_iso(),
                }
            )
        except (BotoCoreError, ClientError) as e:
            logger.exception(f"Failed to save watermark: {e}")

    @abstractmethod
    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new items from the data source. Must be implemented by subclasses."""

    def store_raw_to_s3(self, item: dict, raw_content: str | None = None) -> str | None:
        """Store raw data to S3: ``raw/``, or the workspace's ``ws/{ws}/raw/`` (see ``_shared/raw_archive.py``)."""
        source_platform = item.get("source_platform_override") or self.source_platform
        return archive_raw_item(self._s3, RAW_DATA_BUCKET, source_platform, item, raw_content, scope=self.scope)

    def normalize_item(self, item: dict, raw_content: str | None = None) -> dict:
        """Normalize item to common raw schema and store raw data to S3.

        The provider payload a plugin left on the item (``_shared/raw_source.py``) is popped here,
        so it never travels, and archived as ``raw_content`` unless one was passed.
        """
        source_payload = pop_raw_source(item)
        if raw_content is None:
            raw_content = source_payload
        source_platform = (
            item.get("source_platform_override") or self.source_platform
        )

        s3_raw_uri = self.store_raw_to_s3(item, raw_content)

        return {
            **normalized_item_fields(
                item,
                source_platform=source_platform,
                default_channel="unknown",
                brand_name=self.brand_name,
            ),
            "s3_raw_uri": s3_raw_uri,
            "raw_data": item if not s3_raw_uri else None,
        }

    def send_to_queue(self, items: list[dict]) -> int:
        """Send items to SQS processing queue.

        Delegates to ``send_messages_to_queue`` (see its docstring for the
        ``Failed``-list checking, retries and the ``RuntimeError`` on loss), so
        callers cannot silently lose feedback.  The ``ItemsIngested`` metric
        reflects the actual enqueued count, not the attempted count.

        A run in a workspace puts its ``workspace_id`` on every message, set from the
        scope LAST, after every field the item and the source policy put there, so
        no source payload can choose the workspace its feedback lands in. A
        deployment-wide run's messages are exactly what they always were.

        Returns:
            The number of items that SQS confirmed as enqueued.
        """
        messages = policy_messages(items)
        if self.scope is not None:
            messages = [{**message, WORKSPACE_FIELD: self.scope.ws} for message in messages]
        return send_messages_to_queue(
            self._sqs,
            PROCESSING_QUEUE_URL,
            messages,
            metric_name="ItemsIngested",
            log_label="ingestor",
        )

    @tracer.capture_method
    def _update_source_run_status(self, updates: dict):
        """Update run status in DynamoDB for progress tracking."""
        if not self.aggregates_table or not self.execution_id:
            return
        try:
            expr_parts = []
            expr_names = {}
            expr_values = {}
            for key, value in updates.items():
                safe_key = f"#{key}"
                expr_parts.append(f"{safe_key} = :{key}")
                expr_names[safe_key] = key
                expr_values[f":{key}"] = value
            self.aggregates_table.update_item(
                {'pk': self._source_run_pk(), 'sk': self.execution_id},
                UpdateExpression='SET ' + ', '.join(expr_parts),
                ExpressionAttributeNames=expr_names,
                ExpressionAttributeValues=expr_values,
            )
        except (BotoCoreError, ClientError, TypeError) as e:
            # TypeError: boto3's DynamoDB serializer rejecting a value type.
            logger.warning(f"Failed to update run status: {e}", exc_info=True)

    def run(self) -> dict:
        """Main execution method with circuit breaker support."""
        # Check circuit breaker before running
        if self.circuit_breaker.is_open():
            logger.warning(f"Circuit breaker open for {self.source_platform}, skipping")
            return {"status": "skipped", "reason": "circuit_breaker_open"}

        self._audit("plugin.invoked", True)

        # Initialize run status tracking (a no-op without a table and an execution id)
        self._update_source_run_status({
            'status': 'running',
            'items_found': 0,
            'started_at': now_iso(),
        })

        items = []
        last_id = None  # pragma: no mutate  read only by the falsy `if last_id` below; '' is as falsy as None
        total_processed = 0

        try:
            for item in self.fetch_new_items():
                normalized = self.normalize_item(item)
                items.append(normalized)
                last_id = item.get("id")

                self._audit("message.ingested", True, {
                    "message_id": item.get("id"),
                })

                # Batch send every 100 items
                if len(items) >= 100:
                    total_processed += self.send_to_queue(items)
                    items = []
                    self._update_source_run_status({'items_found': total_processed})

            # Send remaining items
            if items:
                total_processed += self.send_to_queue(items)

            # Update watermark
            if last_id:
                self.set_watermark("last_id", str(last_id))

            # Record success
            self.circuit_breaker.record_success()

            self._update_source_run_status({
                'status': 'completed',
                'items_found': total_processed,
                'completed_at': now_iso(),
            })

            self._audit("plugin.completed", True, {
                "items_processed": total_processed,
            })

        except Exception as e:
            logger.exception(f"Ingestion failed: {e}")
            metrics.add_metric(name="IngestionErrors", unit="Count", value=1)

            # The exception TYPE only: this SOURCE_RUN# row is returned to every
            # signed-in user (integrations_handler's source status), and the
            # exception text can carry an upstream URL, response body or
            # credential-bearing detail. The full text is in the log line above
            # and the audit event below (#263).
            self._update_source_run_status({
                'status': 'error',
                'items_found': total_processed,
                'completed_at': now_iso(),
                'errors': [type(e).__name__],
            })

            # Record failure for circuit breaker
            self.circuit_breaker.record_failure(str(e))

            self._audit("plugin.failed", False, {
                "error": str(e),
                "error_type": type(e).__name__,
            })
            raise
        else:
            return {"status": "success", "items_processed": total_processed}
