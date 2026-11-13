"""
GitHub Issues Webhook — real-time ``issues`` and ``issue_comment`` deliveries.

The route is public (GitHub cannot present a Cognito token), so the request is
authenticated here, BEFORE anything is parsed or enqueued:

* the raw body must be at most ``MAX_BODY_BYTES`` (413 otherwise);
* ``X-Hub-Signature-256`` must be present and equal, under a constant-time
  compare, to ``sha256=`` + HMAC-SHA256(body, ``webhook_secret``) (401 otherwise);
* no configured ``webhook_secret`` means every delivery is refused (503) —
  fail closed, never "accept unsigned".

``POST /webhooks/github_issues/{ws}`` is a workspace's own endpoint
(``_shared/base_webhook.py``): the secret, the repos and the labels come from
that workspace's secret, and a workspace that routes nowhere or has no
``webhook_secret`` gets the bad signature's 401, after the body checks.

A verified delivery is mapped by the same ``_shared/github_mapping.py`` the
ingestor uses, so a pushed issue and a later poll of it produce one item id and
the processor keeps one item, refreshed in place by whichever copy is newer
(``labeled`` / ``closed`` / ``edited`` … deliveries are how a change arrives in
real time; see ``shared/source_updates.py``). Deliveries for a repo that is not configured, for
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

from botocore.exceptions import BotoCoreError, ClientError

from _shared.audit import emit_audit_event
from _shared.base_webhook import BaseWebhook, delivery_workspace, logger, metrics, tracer
from _shared.github_config import GitHubSourceConfig
from _shared.github_mapping import (
    comment_item,
    is_bot,
    is_pull_request,
    issue_item,
    issue_labels,
)
from shared.invocation_cost import measure_invocation_cost
from shared.workspace_routing import RoutedWorkspace

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

    def __init__(self, routed: RoutedWorkspace | None = None, *, refused: bool = False):
        super().__init__(routed, refused=refused)
        # Never logged, never echoed in a response.
        self._webhook_secret = str(self.secrets.get("webhook_secret", "")).strip()
        self.config = GitHubSourceConfig.from_secrets(self.secrets)

    def rejection(self, event: dict) -> dict | None:
        """The refusal for an unauthenticated or oversized request, else None.

        Deployment-wide (``/webhooks/github_issues``) as before: no secret 503 first. On a workspace's route
        (``/webhooks/github_issues/{ws}``) the body is checked first, so its 400 and 413 depend on the body alone,
        then a workspace that routes nowhere, one with no webhook secret and a bad signature all get the same 401:
        no answer says whether the workspace exists or has the plugin.
        """
        client_ip = self._extract_client_ip(event)
        if not self._webhook_secret and not self.on_workspace_route:
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
                # A refused delivery holds no secret, so it fails here too.
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


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@measure_invocation_cost
def lambda_handler(event: dict, context: Any) -> dict:
    """API Gateway proxy entry point for ``POST /webhooks/github_issues`` and ``/webhooks/github_issues/{ws}``."""
    try:
        refused, routed = delivery_workspace(event)
    except (ClientError, BotoCoreError):
        # The workspace's row could not be read: nothing was read or queued. GitHub does not redeliver a failed
        # delivery by itself; the scheduled poll picks the item up, and the 500 (and WebhookErrors) tells the operator.
        logger.exception("github_issues webhook: the workspace could not be read")
        metrics.add_metric(name="WebhookErrors", unit="Count", value=1)
        return _response(500, {"error": "Internal server error"})
    webhook = GitHubIssuesWebhook(routed, refused=refused)
    refusal = webhook.rejection(event)
    if refusal:
        return refusal
    return webhook.handle(event, context)
