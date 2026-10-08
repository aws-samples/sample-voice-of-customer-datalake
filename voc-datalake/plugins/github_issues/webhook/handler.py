"""
GitHub Issues Webhook — real-time ``issues`` and ``issue_comment`` deliveries.

The route is public (GitHub cannot present a Cognito token), so the request is
authenticated here, BEFORE anything is parsed or enqueued:

* the raw body must be at most ``MAX_BODY_BYTES`` (413 otherwise);
* ``X-Hub-Signature-256`` must be present and equal, under a constant-time
  compare, to ``sha256=`` + HMAC-SHA256(body, ``webhook_secret``) (401 otherwise);
* no configured ``webhook_secret`` means every delivery is refused (503) —
  fail closed, never "accept unsigned".

A verified delivery is mapped by the same ``_shared/github_mapping.py`` the
ingestor uses, so a pushed issue and a later poll of it produce one item id and
the processor keeps the first. Deliveries for a repo that is not configured, for
pull requests, bot comments, deletions or other event types are acknowledged
(200) and dropped.
"""

import base64
import hashlib
import hmac
import json
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _shared.audit import emit_audit_event
from _shared.base_webhook import BaseWebhook, logger, metrics, tracer
from _shared.github_config import GitHubSourceConfig
from _shared.github_mapping import (
    RAW_PAYLOAD_KEY,
    comment_item,
    is_bot,
    is_pull_request,
    issue_item,
    issue_labels,
)
from _shared.raw_archive import archive_raw_item
from shared.aws import get_s3_client
from shared.invocation_cost import measure_invocation_cost

RAW_DATA_BUCKET = os.environ.get("RAW_DATA_BUCKET", "")
#: GitHub caps deliveries at 25 MB, but an issue or comment event is a few KB;
#: anything near this is not a delivery this plugin needs to read.
MAX_BODY_BYTES = 1_000_000
SIGNATURE_PREFIX = "sha256="
_IGNORED_ACTIONS = frozenset({"deleted", "transferred", "pinned", "unpinned", "locked", "unlocked"})


def _response(status: int, body: dict) -> dict:
    return {"statusCode": status, "body": json.dumps(body)}


def _raw_body(event: dict) -> bytes:
    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        return base64.b64decode(body)
    return body.encode("utf-8") if isinstance(body, str) else b""


def _header(headers: object, name: str) -> str | None:
    """A request header by lower-case *name* (API Gateway preserves the sender's case)."""
    items = headers.items() if isinstance(headers, dict) else ()
    return next((v for k, v in items if isinstance(k, str) and k.lower() == name), None)


def signature_matches(secret: str, body: bytes, signature: str | None) -> bool:
    """Constant-time check of GitHub's ``X-Hub-Signature-256`` over the exact body bytes."""
    if not secret or not signature or not signature.startswith(SIGNATURE_PREFIX):
        return False
    expected = SIGNATURE_PREFIX + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected.encode("utf-8"), signature.strip().encode("utf-8"))


class GitHubIssuesWebhook(BaseWebhook):
    """Verifies, maps and enqueues one GitHub delivery."""

    def __init__(self):
        super().__init__()
        # Never logged, never echoed in a response.
        self._webhook_secret = str(self.secrets.get("webhook_secret", "")).strip()
        self.config = GitHubSourceConfig.from_secrets(self.secrets)
        self._s3 = get_s3_client()

    def rejection(self, event: dict) -> dict | None:
        """The refusal for an unauthenticated or oversized request, else None."""
        client_ip = self._extract_client_ip(event)
        if not self._webhook_secret:
            reason, response = "not_configured", _response(503, {"error": "Webhook not configured"})
        else:
            try:
                body = _raw_body(event)
            except (ValueError, TypeError):
                body = None
            if body is None:
                reason, response = "bad_encoding", _response(400, {"error": "Invalid body"})
            elif len(body) > MAX_BODY_BYTES:
                reason, response = "too_large", _response(413, {"error": "Payload too large"})
            elif not signature_matches(self._webhook_secret, body, _header(event.get("headers"), "x-hub-signature-256")):
                reason, response = "bad_signature", _response(401, {"error": "Invalid signature"})
            else:
                return None
        emit_audit_event("webhook.rejected", self.source_platform, False, {"reason": reason, "ip_address": client_ip})
        metrics.add_metric(name="WebhookRejected", unit="Count", value=1)
        return response

    def parse_webhook_payload(self, body: dict, headers: dict) -> list[dict]:
        event_name = _header(headers, "x-github-event") or ""
        repo = self.config.canonical_repo((body.get("repository") or {}).get("full_name"))
        issue = body.get("issue")
        if event_name not in ("issues", "issue_comment") or not repo or not isinstance(issue, dict):
            logger.info(f"github_issues webhook: ignoring event={event_name!r} (ping, other event or unconfigured repo)")
            return []
        if body.get("action") in _IGNORED_ACTIONS or is_pull_request(issue):
            return []
        if not self.config.admits_labels(issue_labels(issue)):
            return []
        if event_name == "issues":
            return [issue_item(issue, repo, self.config.product_names)] if self.config.admits(issue) else []
        comment = body.get("comment")
        if not isinstance(comment, dict) or "id" not in comment or is_bot(comment) or not self.config.admits(comment):
            return []
        return [comment_item(comment, repo, issue, self.config.product_names)]

    def normalize_item(self, item: dict) -> dict:
        """Archive the delivery's issue/comment object to S3 like every source; send only the mapped item."""
        payload = item.pop(RAW_PAYLOAD_KEY, None)
        uri = archive_raw_item(
            self._s3, RAW_DATA_BUCKET, self.source_platform, item,
            json.dumps(payload, default=str) if payload is not None else None,
        )
        normalized = super().normalize_item(item)
        if uri:
            normalized["s3_raw_uri"] = uri
            normalized["raw_data"] = None
        return normalized


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@measure_invocation_cost
def lambda_handler(event: dict, context: Any) -> dict:
    """API Gateway proxy entry point for ``POST /webhooks/github_issues``."""
    webhook = GitHubIssuesWebhook()
    refusal = webhook.rejection(event)
    if refusal:
        return refusal
    return webhook.handle(event, context)
