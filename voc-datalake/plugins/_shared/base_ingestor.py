"""
Base Ingestor - Common functionality for all VoC data source ingestors.
Uses DynamoDB for watermarks and SQS for processing queue.

This is the plugin version that supports per-plugin secrets isolation.
"""

import json
import os
import sys
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Generator
import hashlib

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, tracer, metrics
from shared.exceptions import ConfigurationError
from shared.http_utils import fetch_with_retry
from shared.aws import (
    clear_secret_cache,
    get_dynamodb_resource,
    get_s3_client,
    get_sqs_client,
    get_secret,
)
from .circuit_breaker import CircuitBreaker
from .audit import emit_audit_event
from .plugin_secrets import filter_plugin_secrets
from .sqs_utils import send_messages_to_queue

# Re-export for backwards compatibility with existing handlers
__all__ = ["BaseIngestor", "logger", "tracer", "metrics", "fetch_with_retry"]

# Configuration from environment
WATERMARKS_TABLE = os.environ.get("WATERMARKS_TABLE", "")
PROCESSING_QUEUE_URL = os.environ.get("PROCESSING_QUEUE_URL", "")
RAW_DATA_BUCKET = os.environ.get("RAW_DATA_BUCKET", "")
SECRETS_ARN = os.environ.get("SECRETS_ARN", "")
BRAND_NAME = os.environ.get("BRAND_NAME", "")
BRAND_HANDLES = json.loads(os.environ.get("BRAND_HANDLES", "[]"))
SOURCE_PLATFORM = os.environ.get("SOURCE_PLATFORM", "")
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")


class BaseIngestor(ABC):
    """Base class for all data source ingestors."""

    def __init__(self, execution_id: str | None = None):
        """
        Args:
            execution_id: Present on manual ("Run now") invocations. Passing it
                here — rather than assigning the attribute post-construction —
                matters: manual runs clear the shared secret cache BEFORE the
                secret is read below, so a warm container picks up credentials
                saved moments ago (Save-then-Run-now, issues #141/#215).
                Scheduled runs keep the warm cache.
        """
        self.execution_id: str | None = execution_id
        if execution_id:
            clear_secret_cache()
        self.source_platform = SOURCE_PLATFORM
        self.brand_name = BRAND_NAME
        self.brand_handles = BRAND_HANDLES
        # Everything the failure path needs is wired BEFORE the secret is read.
        # Since issue #251 a namespace miss raises here rather than silently
        # widening to the whole shared secret, so construction failing is a
        # routine outcome — and a raise out of __init__ never reaches run()'s
        # except block, which is what tells the operator anything (see
        # _report_construction_failure). Ordering this after the read is what left
        # a manual run's status record stranded at 'running' with a permanent
        # spinner in the UI.
        self.watermarks_table = get_dynamodb_resource().Table(WATERMARKS_TABLE)
        self.aggregates_table = get_dynamodb_resource().Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None
        self.circuit_breaker = CircuitBreaker(self.source_platform)
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
            way does not auto-disable its schedule;
          * no ``plugin.failed`` audit event is emitted.

        Reported HERE rather than in each plugin's ``lambda_handler`` for the same
        reason the manual-run cache clear is centralized (#141/#215): a per-handler
        wrapper is one a new plugin can forget, and forgetting it is silent.

        Never raises. It runs while a ConfigurationError is propagating, and
        replacing that error with a DynamoDB one would hide the thing worth
        reporting; each step already swallows its own failures, and the belt-and-
        braces catch covers a client that is missing altogether.
        """
        try:
            self._update_source_run_status({
                'status': 'error',
                'items_found': 0,
                'completed_at': datetime.now(timezone.utc).isoformat(),
                'errors': [str(error)],
            })
            self.circuit_breaker.record_failure(str(error))
            emit_audit_event("plugin.failed", self.source_platform, False, {
                "error": str(error),
                "error_type": type(error).__name__,
                "phase": "construction",
            })
        # Deliberately blind: narrowing it means enumerating what three AWS clients
        # can raise, and anything missed REPLACES the ConfigurationError being
        # propagated with an unrelated one — hiding the only message that names the
        # prefix the plugin expected. Pinned by
        # test_the_report_does_not_replace_the_error_the_operator_needs.
        except Exception as reporting_error:  # noqa: BLE001
            logger.warning(f"Failed to report construction failure: {reporting_error}")

    def _load_secrets(self) -> dict:
        """
        Load this plugin's API credentials from the shared Secrets Manager secret.

        Keys are stored namespaced as ``<plugin_id>_<key>``; ``filter_plugin_secrets``
        returns only this plugin's namespace with the prefix stripped, and RAISES
        rather than widening when the namespace matches nothing (issue #251 — the
        old ``filtered if filtered else all_secrets`` turned a typo'd plugin id
        into cross-plugin credential access). See ``_shared/plugin_secrets.py`` for
        why the "keys with no known prefix are shared/legacy" branch, and the
        plugin-id list it needed, are gone.

        An absent SECRETS_ARN stays a warning rather than a raise: that is the
        env-var-not-wired case, not a namespace mismatch, and no secret is read at
        all — so there is nothing to over-share. It is also what a plugin invoked
        outside the CDK-built environment (a local smoke run) hits.
        """
        if not SECRETS_ARN:
            logger.warning("SECRETS_ARN not configured")
            return {}

        all_secrets = get_secret(SECRETS_ARN)
        if not all_secrets:
            # `get_secret` is lru_cached and swallows EVERY exception into `{}`,
            # so a throttle or timeout memoizes an empty payload under the ARN.
            # filter_plugin_secrets refuses to run on it (correctly), but without
            # this eviction the refusal is permanent: every later invocation in
            # the warm container re-reads the cached `{}` and raises again with no
            # further API call. Only a manual "Run now" clears the cache, so a
            # SCHEDULED plugin would stay wedged for the container's lifetime
            # after a single transient blip. Evicting here costs one extra read on
            # the next invocation and makes the failure retry-safe.
            clear_secret_cache()

        return filter_plugin_secrets(self.source_platform, all_secrets)

    def get_watermark(self, key: str, default: str = None) -> str:
        """Get watermark for a specific source/key from DynamoDB."""
        try:
            response = self.watermarks_table.get_item(
                Key={"source": f"{self.source_platform}#{key}"}
            )
            return response.get("Item", {}).get("value", default)
        except Exception as e:
            logger.warning(f"Failed to get watermark: {e}")
            return default

    def set_watermark(self, key: str, value: str):
        """Set watermark for a specific source/key in DynamoDB."""
        try:
            self.watermarks_table.put_item(
                Item={
                    "source": f"{self.source_platform}#{key}",
                    "value": value,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            )
        except Exception as e:
            logger.error(f"Failed to save watermark: {e}")

    @abstractmethod
    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new items from the data source. Must be implemented by subclasses."""
        pass

    def _generate_deterministic_id(self, item: dict) -> str:
        """
        Generate a deterministic ID for S3 filename to prevent duplicates.
        
        Uses the same logic as processor deduplication:
        1. source_id if available (most reliable)
        2. hash of created_at + text + url (fallback for scraped content)
        """
        source_id = item.get("id", "")
        if source_id:
            # Sanitize source_id for use as filename (remove special chars)
            safe_id = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(source_id))
            return safe_id[:64]  # Limit length
        
        # Fallback: generate from content signature
        text = item.get("text", "")
        created_at = item.get("created_at", "")
        url = item.get("url", "")
        
        # MD5 used only for content fingerprinting (not security), marked explicitly
        text_hash = hashlib.sha256(text[:500].encode(), usedforsecurity=False).hexdigest()[:16] if text else ""
        content = f"{created_at}:{text_hash}:{url}"
        return hashlib.sha256(content.encode()).hexdigest()[:32]

    def store_raw_to_s3(self, item: dict, raw_content: str = None) -> str | None:
        """Store raw data to S3 with partitioned structure."""
        if not RAW_DATA_BUCKET:
            logger.warning("RAW_DATA_BUCKET not configured, skipping S3 storage")
            return None

        try:
            now = datetime.now(timezone.utc)
            source_platform = (
                item.get("source_platform_override") or self.source_platform
            )
            
            item_id = self._generate_deterministic_id(item)

            # Use review's created_at date for partitioning
            created_at = item.get("created_at")
            if created_at:
                try:
                    if isinstance(created_at, str):
                        date_str = created_at.replace('Z', '+00:00').replace(' ', 'T')
                        if 'T' in date_str and '+' not in date_str and '-' not in date_str.split('T')[1]:
                            date_str += '+00:00'
                        partition_date = datetime.fromisoformat(date_str)
                    else:
                        partition_date = now
                except (ValueError, TypeError) as e:
                    logger.debug(f"Could not parse created_at '{created_at}': {e}")
                    partition_date = now
            else:
                partition_date = now

            # Build S3 key - scoped to plugin prefix for isolation
            s3_key = f"raw/{source_platform}/{partition_date.year}/{partition_date.month:02d}/{partition_date.day:02d}/{item_id}.json"

            raw_payload = {
                "item_id": item_id,
                "source_platform": source_platform,
                "ingested_at": now.isoformat(),
                "partition_date": partition_date.strftime('%Y-%m-%d'),
                "raw_content": raw_content,
                "raw_item": item,
            }

            self._s3.put_object(
                Bucket=RAW_DATA_BUCKET,
                Key=s3_key,
                Body=json.dumps(raw_payload, default=str),
                ContentType="application/json",
            )

            logger.info(f"Stored raw data to s3://{RAW_DATA_BUCKET}/{s3_key}")
            return f"s3://{RAW_DATA_BUCKET}/{s3_key}"
        except Exception as e:
            logger.error(f"Failed to store raw data to S3: {e}")
            return None

    def normalize_item(self, item: dict, raw_content: str = None) -> dict:
        """Normalize item to common raw schema and store raw data to S3."""
        source_platform = (
            item.get("source_platform_override") or self.source_platform
        )

        s3_raw_uri = self.store_raw_to_s3(item, raw_content)

        return {
            "id": item.get("id", ""),
            "source_platform": source_platform,
            "source_channel": item.get("channel", "unknown"),
            "url": item.get("url", ""),
            "text": item.get("text", ""),
            "rating": item.get("rating"),
            "created_at": item.get(
                "created_at", datetime.now(timezone.utc).isoformat()
            ),
            "ingested_at": datetime.now(timezone.utc).isoformat(),
            "brand_name": self.brand_name,
            "brand_handles_matched": item.get("brand_handles_matched", []),
            "s3_raw_uri": s3_raw_uri,
            "raw_data": item if not s3_raw_uri else None,
        }

    def send_to_queue(self, items: list[dict]) -> int:
        """Send items to SQS processing queue.

        Delegates to the shared helper which checks the ``Failed`` list in every
        batch response, retries transient errors, and raises ``RuntimeError`` if
        any items cannot be enqueued — ensuring callers cannot silently lose
        feedback.  The ``ItemsIngested`` metric reflects the actual enqueued
        count, not the attempted count.

        Returns:
            The number of items that SQS confirmed as enqueued.
        """
        return send_messages_to_queue(
            self._sqs,
            PROCESSING_QUEUE_URL,
            items,
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
                Key={'pk': f'SOURCE_RUN#{self.source_platform}', 'sk': self.execution_id},
                UpdateExpression='SET ' + ', '.join(expr_parts),
                ExpressionAttributeNames=expr_names,
                ExpressionAttributeValues=expr_values,
            )
        except Exception as e:
            logger.warning(f"Failed to update run status: {e}")

    def run(self) -> dict:
        """Main execution method with circuit breaker support."""
        # Check circuit breaker before running
        if self.circuit_breaker.is_open():
            logger.warning(f"Circuit breaker open for {self.source_platform}, skipping")
            return {"status": "skipped", "reason": "circuit_breaker_open"}

        emit_audit_event("plugin.invoked", self.source_platform, True)
        
        # Initialize run status tracking
        if self.aggregates_table and self.execution_id:
            self._update_source_run_status({
                'status': 'running',
                'items_found': 0,
                'started_at': datetime.now(timezone.utc).isoformat(),
            })

        items = []
        last_id = None
        total_processed = 0

        try:
            for item in self.fetch_new_items():
                normalized = self.normalize_item(item)
                items.append(normalized)
                last_id = item.get("id")

                emit_audit_event("message.ingested", self.source_platform, True, {
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
                'completed_at': datetime.now(timezone.utc).isoformat(),
            })

            emit_audit_event("plugin.completed", self.source_platform, True, {
                "items_processed": total_processed,
            })

            return {"status": "success", "items_processed": total_processed}

        except Exception as e:
            logger.exception(f"Ingestion failed: {e}")
            metrics.add_metric(name="IngestionErrors", unit="Count", value=1)
            
            self._update_source_run_status({
                'status': 'error',
                'items_found': total_processed,
                'completed_at': datetime.now(timezone.utc).isoformat(),
                'errors': [str(e)],
            })

            # Record failure for circuit breaker
            self.circuit_breaker.record_failure(str(e))
            
            emit_audit_event("plugin.failed", self.source_platform, False, {
                "error": str(e),
                "error_type": type(e).__name__,
            })
            raise
