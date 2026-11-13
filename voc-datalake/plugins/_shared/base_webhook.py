"""
Base Webhook Handler - Common functionality for webhook-based data ingestion.

Two paths (docs/multi-workspace.md, "Public and non-user entry points"; docs/plugin-architecture.md, Webhooks):

* ``POST /webhooks/{plugin}``: deployment-wide, exactly as before (the shared secret, ``raw/<plugin>/…``, messages
  that name no workspace);
* ``POST /webhooks/{plugin}/{ws}``: the ``{ws}`` path value is only the key of a workspace's own ``META`` row
  (``delivery_workspace``, over shared/workspace_routing.py ``route_workspace_id``): it must be a well-formed id of an
  ``active`` workspace that enabled this plugin (its ``PLUGIN#{plugin}`` / ``WS#{ws}`` row, since 7.14.00). The
  webhook secret and the plugin's settings then come from THAT workspace's parameter of
  this plugin, ``{prefix}/{ws}/credentials/{plugin}`` (decision 19, shared/workspace_credentials.py), never the shared
  secret; a verified delivery is archived under ``ws/{ws}/raw/<plugin>/…`` and queued with that ``workspace_id``
  (``workspace_payload``, after every other field). Anything that routes nowhere (a malformed or unknown id, a
  ``deleting`` workspace, a workspace that has not enabled the plugin, a parameter missing, unreadable or without the plugin's webhook secret) gets the plugin's
  own bad-signature answer, so the answer confirms no workspace.
"""

import json
import os
import sys
import time
from abc import ABC, abstractmethod
from collections.abc import Callable
from typing import Any

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from botocore.exceptions import BotoCoreError, ClientError

from shared.aws import clear_secret_cache, get_s3_client, get_secret, get_sqs_client, get_ssm_client
from shared.exceptions import ConflictError
from shared.logging import logger, metrics, tracer
from shared.plugin_identity import is_valid_plugin_identifier
from shared.source_profiles import SourceProfilesUnavailable
from shared.tables import get_workspaces_table
from shared.workspace_credentials import MalformedCredentials, read_credentials
from shared.workspace_plugin_settings import require_plugin_enabled
from shared.workspace_routing import RoutedWorkspace, Unroutable, route_workspace_id, workspace_payload

from .audit import emit_audit_event
from .normalized_item import normalized_item_fields
from .plugin_secrets import load_shared_plugin_secrets
from .raw_archive import WEBHOOK, archive_raw_item
from .raw_source import pop_raw_source
from .source_policy_gate import policy_messages
from .sqs_utils import send_messages_to_queue

__all__ = ["BaseWebhook", "delivery_workspace", "logger", "metrics", "tracer"]

# Configuration from environment
PROCESSING_QUEUE_URL = os.environ.get("PROCESSING_QUEUE_URL", "")
SECRETS_ARN = os.environ.get("SECRETS_ARN", "")
BRAND_NAME = os.environ.get("BRAND_NAME", "")
SOURCE_PLATFORM = os.environ.get("SOURCE_PLATFORM", "")
# The raw archive (``raw/<plugin>/…``, ``_shared/raw_archive.py``): every webhook archives what it receives.
RAW_DATA_BUCKET = os.environ.get("RAW_DATA_BUCKET", "")
# The workspaces' credentials parameters, `{prefix}/{ws}/credentials/{plugin}` (decision 19; lib/stacks/api-stack.ts).
WORKSPACE_PARAMETER_PREFIX = os.environ.get("WORKSPACE_PARAMETER_PREFIX", "")
#: The path parameter of ``/webhooks/{plugin}/{ws}`` (lib/stacks/api-routes.ts).
WORKSPACE_PATH_PARAMETER = "ws"


#: How long a warm container keeps a workspace's parameter before it reads it again (docs/plugin-architecture.md): a
#: webhook secret a workspace rotates, or one that leaked and is replaced, stops opening its endpoint within this.
WORKSPACE_SECRET_TTL_SECONDS = 60.0
#: A container keeps at most this many workspaces' parameters; a full cache starts again empty.
MAX_CACHED_WORKSPACE_SECRETS = 256


class WorkspaceSecrets:
    """The workspaces' credentials parameters one warm container read, each kept ``ttl`` seconds by
    ``(workspace, plugin)``.

    Not ``shared.aws.get_secret``'s cache, which keeps a value for the container's life: a rotated webhook secret
    takes effect within the TTL everywhere, and a bad signature or a missing key costs no extra read (a flood of
    forged deliveries reads each workspace's parameter at most once per TTL), a workspace with nothing saved
    (``ParameterNotFound``, kept as ``{}``) included. A read that FAILS is not kept (``_read_credentials`` tells the
    two apart).
    """

    def __init__(self, ttl: float = WORKSPACE_SECRET_TTL_SECONDS, clock: Callable[[], float] = time.monotonic):
        self._ttl = ttl
        self._clock = clock
        self._entries: dict[tuple[str, str], tuple[float, dict]] = {}

    def get(self, ws: str, plugin: str) -> dict:
        now = self._clock()
        entry = self._entries.get((ws, plugin))
        if entry is not None and now < entry[0]:
            return entry[1]
        value = _read_credentials(ws, plugin)
        if value is None:
            self._entries.pop((ws, plugin), None)
            return {}
        if len(self._entries) >= MAX_CACHED_WORKSPACE_SECRETS:
            self._entries.clear()
        self._entries[(ws, plugin)] = (now + self._ttl, value)
        return value

    def clear(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)


def _read_credentials(ws: str, plugin: str) -> dict | None:
    """One uncached read of ``plugin``'s credentials parameter in ``ws`` (shared/workspace_credentials.py
    ``read_credentials``): ``{}`` when it does not exist (nothing saved) or is not a JSON object; None when the read
    failed (logged by type, never its text: it names the parameter, the account and the role)."""
    try:
        return read_credentials(get_ssm_client(), WORKSPACE_PARAMETER_PREFIX, ws, plugin)
    except MalformedCredentials as error:
        # A hand-edited value: refused like a bad signature, kept as `{}` for the TTL, and counted for the operator.
        logger.warning("A workspace's credentials parameter is not a JSON object",
                       extra={"plugin_id": plugin, "error_type": type(error).__name__})
        metrics.add_metric(name="WorkspaceCredentialsMalformed", unit="Count", value=1)
        return {}
    except (ClientError, BotoCoreError) as error:
        logger.warning("A workspace's parameter could not be read", extra={"error_type": type(error).__name__})
        return None


#: This container's workspace parameters (tests reset it with ``clear``).
WORKSPACE_SECRETS = WorkspaceSecrets()


def _on_workspace_route(event: dict) -> bool:
    """Whether the delivery came on ``/webhooks/{plugin}/{ws}`` (API Gateway's ``{ws}`` path parameter is there)."""
    parameters = event.get("pathParameters")
    return isinstance(parameters, dict) and WORKSPACE_PATH_PARAMETER in parameters


def delivery_workspace(event: dict) -> tuple[bool, RoutedWorkspace | None]:
    """``(refused, routed)`` of one delivery. ``/webhooks/{plugin}`` (no ``{ws}`` path parameter): ``(False, None)``,
    deployment-wide. ``/webhooks/{plugin}/{ws}``: ``(False, routed)`` for an active workspace,
    read from its stored ``META`` (the path value is only the row's key), that enabled this plugin (its
    ``PLUGIN#{plugin}`` / ``WS#{ws}`` row, shared/workspace_plugin_settings.py: a disable stops its deliveries at
    once), else ``(True, None)``: refused with the bad signature's 401 before any secret is read or the body parsed,
    never served deployment-wide, so the answer says nothing of which. A read fault raises, for the plugin's 500: a provider such as GitHub does not redeliver a failed
    delivery by itself, so the scheduled poll picks the item up and the 500 tells the operator."""
    if not _on_workspace_route(event):
        return False, None
    parameters = event["pathParameters"]
    table = get_workspaces_table()
    if table is None:
        logger.warning("WORKSPACES_TABLE not configured: a workspace webhook is refused")
        return True, None
    try:
        routed = route_workspace_id(table, parameters.get(WORKSPACE_PATH_PARAMETER))
        require_plugin_enabled(table, routed.ws, SOURCE_PLATFORM)
    except (Unroutable, ConflictError, ValueError):  # ValueError: no plugin id configured (SOURCE_PLATFORM)
        return True, None
    return False, routed


class BaseWebhook(ABC):
    """Base class for webhook handlers: one delivery, deployment-wide (``routed`` None) or in the workspace a stored
    row routed it to (``routed``); ``refused`` for one that routes nowhere (no secret is read)."""

    def __init__(self, routed: RoutedWorkspace | None = None, *, refused: bool = False):
        self.source_platform = SOURCE_PLATFORM
        self.brand_name = BRAND_NAME
        self.routed = routed
        self.refused = refused
        #: Whether the delivery came on a workspace's route (``/webhooks/{plugin}/{ws}``), routed or refused.
        self.on_workspace_route = refused or routed is not None
        self.secrets = {} if refused else self._load_secrets()
        self._sqs = get_sqs_client()
        self._s3 = get_s3_client()

    def _load_workspace_secrets(self, routed: RoutedWorkspace) -> dict:
        """The plugin's keys from the WORKSPACE's own parameter of this plugin (the name built from the routed
        workspace and this plugin's identity only; the webhook role may read no other plugin's), or ``{}`` when it
        is missing, unreadable or malformed: the delivery is then refused like a bad signature."""
        if not WORKSPACE_PARAMETER_PREFIX:
            logger.warning("WORKSPACE_PARAMETER_PREFIX not configured")
            return {}
        if not is_valid_plugin_identifier(self.source_platform):
            return {}
        return dict(WORKSPACE_SECRETS.get(routed.ws, self.source_platform))

    def _load_secrets(self) -> dict:
        """Load this plugin's secrets from the shared secret, prefix stripped.

        Same choke point as ``BaseIngestor._load_secrets`` — one implementation in
        ``_shared/plugin_secrets.py`` — so the webhook path cannot keep failing
        open after the ingestor path was fixed (issue #251). A webhook is the more
        exposed of the two: its Lambda is reachable from the internet with no
        Cognito authorizer in front of it.

        The identity comes from ``SOURCE_PLATFORM``, which ``createWebhookLambda``
        sets (it once set only a ``PLUGIN_ID`` nothing read, so this read saw ``''``
        and every delivery would have died on a message about a malformed identity
        rather than the missing variable). Pinned by
        'SOURCE_PLATFORM' in ``lib/stacks/api-stack-webhook-env.test.ts``.

        A delivery on a workspace's route reads that workspace's parameter instead
        (``_load_workspace_secrets``), never the shared secret.
        """
        routed = self.routed
        # Deployment-wide: the one shared-secret read both base classes make (_shared/plugin_secrets.py), with this
        # module's own get_secret, cache eviction and logger.
        return (self._load_workspace_secrets(routed) if routed is not None else load_shared_plugin_secrets(
            self.source_platform, SECRETS_ARN, read=get_secret, evict=clear_secret_cache, log=logger))

    @abstractmethod
    def parse_webhook_payload(self, body: dict, headers: dict) -> list[dict]:
        """
        Parse the webhook payload and return a list of items to process.

        Must be implemented by subclasses.

        Args:
            body: The parsed JSON body of the webhook request
            headers: The request headers

        Returns:
            List of normalized items ready for the processing queue
        """

    def normalize_item(self, item: dict, raw_content: str | None = None) -> dict:
        """Archive the delivered item (and the provider's own payload, *raw_content*) and normalize it.

        Same archive as every ingestor (``archive_raw_item``, connector ``webhook_<plugin>``):
        write-once, skipped for a redact / summary-only source. The item travels inline
        (``raw_data``) only when the archive write failed or was not allowed, and the
        source policy drops that copy for a non-allow source (``shared/source_policy.py``). The
        provider payload a plugin left on the item (``_shared/raw_source.py``) is popped here and
        archived as ``raw_content`` unless one was passed.
        """
        source_payload = pop_raw_source(item)
        if raw_content is None:
            raw_content = source_payload
        # A routed delivery's copy under its workspace's ws/{ws}/raw/ (the deployment's call is unchanged).
        workspace = {"scope": self.routed.scope} if self.routed is not None else {}
        uri = archive_raw_item(
            self._s3, RAW_DATA_BUCKET, self.source_platform, item, raw_content, transport=WEBHOOK, **workspace,
        )
        normalized = {
            **normalized_item_fields(
                item,
                source_platform=self.source_platform,
                default_channel="webhook",
                brand_name=self.brand_name,
            ),
            "is_webhook": True,
            "raw_data": None if uri else item,
        }
        if uri:
            normalized["s3_raw_uri"] = uri
        return normalized

    def send_to_queue(self, items: list[dict]) -> int:
        """Send items to SQS processing queue.

        Delegates to the shared helper which checks the ``Failed`` list in every
        batch response, retries transient errors, and raises ``RuntimeError`` if
        any items cannot be enqueued — ensuring callers cannot silently lose
        feedback.  It also reconciles ``Successful`` + ``Failed`` against the
        submitted entries so an unaccounted entry is reported rather than
        dropped.  The ``WebhookItemsIngested`` metric reflects the actual
        enqueued count, not the attempted count.

        Returns:
            The number of items that SQS confirmed as enqueued.

        Note — partial-failure duplicate-delivery trade-off:
            If the helper raises ``RuntimeError`` after a partial success (some
            items were already enqueued before the failure occurred), ``handle()``
            catches it and returns HTTP 500.  Most webhook providers treat 500 as
            transient and re-deliver the *entire* original payload, so items that
            were already successfully enqueued will be sent a second time.  This
            PR chooses "duplicate over loss" as the safer trade-off; the
            downstream processor deduplicates on ``id`` via
            ``check_duplicate`` / ``@idempotent_function`` when
            ``IDEMPOTENCY_TABLE`` is configured.  Ensure ``IDEMPOTENCY_TABLE`` is
            set in all production deployments to prevent double-processing.

        A delivery routed to a workspace names it on every message
        (``workspace_payload``: the stored row's workspace, set after every field
        the item and the source policy put there), under that workspace's source
        policy; a deployment-wide one names none, under the deployment's, as before.
        """
        scope = self.routed.scope if self.routed is not None else None
        return send_messages_to_queue(
            self._sqs,
            PROCESSING_QUEUE_URL,
            [workspace_payload(message, self.routed) for message in policy_messages(items, scope)],
            metric_name="WebhookItemsIngested",
            log_label="webhook",
        )

    def _extract_client_ip(self, event: dict) -> str:
        """Extract client IP from API Gateway event."""
        request_context = event.get("requestContext", {})
        identity = request_context.get("identity", {})
        return identity.get("sourceIp", "unknown")

    @tracer.capture_method
    def handle(self, event: dict, context: Any) -> dict:
        """
        Main webhook handler method.

        Performs NO authentication itself: the plugin's Lambda handler must verify
        the request (e.g. github_issues checks `X-Hub-Signature-256` with
        `hmac.compare_digest`) and call this only for a request that passed.
        A delivery that routes to no workspace (``refused``) is never handled,
        whatever the plugin did: the plugins' bad-signature answer. Nor is one on
        a workspace's route (``/webhooks/{plugin}/{ws}``) that the plugin built
        without routing it (``delivery_workspace``): it fails closed the same way,
        never handled deployment-wide.
        """
        client_ip = self._extract_client_ip(event)
        if self.refused or (_on_workspace_route(event) and self.routed is None):
            return {"statusCode": 401, "body": json.dumps({"error": "Invalid signature"})}

        emit_audit_event("webhook.received", self.source_platform, True, {
            "ip_address": client_ip,
        })

        try:
            # Parse body
            body = event.get("body", "{}")
            if event.get("isBase64Encoded"):
                import base64
                body = base64.b64decode(body).decode("utf-8")

            if isinstance(body, str):
                body = json.loads(body)

            headers = event.get("headers", {})

            # Parse webhook payload
            items = self.parse_webhook_payload(body, headers)

            if not items:
                logger.info("No items to process from webhook")
                return {
                    "statusCode": 200,
                    "body": json.dumps({"status": "ok", "items_processed": 0}),
                }

            # Normalize and send to queue
            normalized_items = [self.normalize_item(item) for item in items]
            # Use the confirmed-enqueued count, not the attempted count, so the
            # audit event and HTTP response never report items SQS did not
            # acknowledge (mirrors BaseIngestor.run()).
            enqueued = self.send_to_queue(normalized_items)

            emit_audit_event("webhook.received", self.source_platform, True, {
                "items_processed": enqueued,
                "ip_address": client_ip,
            })

            return {
                "statusCode": 200,
                "body": json.dumps({
                    "status": "ok",
                    "items_processed": enqueued,
                }),
            }

        except json.JSONDecodeError as e:
            logger.exception(f"Invalid JSON in webhook body: {e}")
            emit_audit_event("webhook.rejected", self.source_platform, False, {
                "reason": "invalid_json",
                "ip_address": client_ip,
            })
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "Invalid JSON"}),
            }
        except SourceProfilesUnavailable as e:
            # Fail closed: nothing was queued under the allow default; the
            # provider re-delivers on a 5xx.
            logger.warning("Webhook deferred: source policy unreadable")
            metrics.add_metric(name="WebhookErrors", unit="Count", value=1)
            emit_audit_event("webhook.rejected", self.source_platform, False, {
                "reason": "source_policy_unavailable",
                "ip_address": client_ip,
            })
            return {
                "statusCode": 503,
                "body": json.dumps({"error": e.message}),
            }
        except Exception as e:
            logger.exception(f"Webhook processing failed: {e}")
            metrics.add_metric(name="WebhookErrors", unit="Count", value=1)
            emit_audit_event("webhook.rejected", self.source_platform, False, {
                "reason": str(e),
                "ip_address": client_ip,
            })
            return {
                "statusCode": 500,
                "body": json.dumps({"error": "Internal server error"}),
            }
