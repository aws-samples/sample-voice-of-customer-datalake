"""Mutation hardening for `github_issues/webhook/handler.py`.

`test_github_issues_webhook.py` proves the happy path and that a bad signature
is answered 401, but a mutation run left 39 mutants alive, most of them on the
refusal path of a PUBLIC route:

* every refusal's reason, response body and audit record could be renamed, the
  400 could become a 401, the audit could claim success (``True``), the client
  IP and the ``WebhookRejected`` metric could be dropped or miscounted;
* an undecodable body could fall through to the signature check instead of 400;
* the size cap could become ``>=`` (a body of exactly ``MAX_BODY_BYTES`` is
  accepted) or move by one;
* ``signature_matches`` could accept a delivery signed with an EMPTY secret,
  or raise on a missing header, and a secret key absent from the secret could
  default to a non-empty string — i.e. "accept" instead of fail closed (503);
* an absent or non-string body could be verified as bytes other than ``b""``;
* five of the six ignored actions, the comment-without-id / non-dict comment
  drop, the env-var name and default of ``RAW_DATA_BUCKET``, the ``sys.path``
  insert index and all three Powertools decorators were unpinned.

Each test below pins one of them with literal values.
"""
import base64
import hashlib
import hmac
import importlib
import json
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest
from github_fixtures import REPO, comment, issue

from _shared.test.fresh_import import assert_loading_puts_root_first, load_fresh
from _shared.test.scoped_secret import scoped_secret
from _shared.test.webhook_fixtures import webhook_event
from github_issues.webhook import handler
from shared.test.emf_fixtures import cold_start_metric_names

H = "github_issues.webhook.handler"
KEY = "mutation-webhook-key"
CLIENT_IP = "203.0.113.9"
MODULE_PATH = Path(handler.__file__).resolve()
PLUGIN_ROOT = str(MODULE_PATH.parents[1])


def _sig(body: bytes, key: str = KEY) -> str:
    return "sha256=" + hmac.new(key.encode(), body, hashlib.sha256).hexdigest()


@contextmanager
def isolated(**secrets: str) -> Iterator[MagicMock]:
    """No AWS: the secret is *secrets*, SQS and S3 are mocks; yields the audit emitter."""
    with (
        patch("_shared.base_webhook.get_sqs_client"),
        patch("_shared.base_webhook.get_secret", return_value=scoped_secret(**secrets)),
        patch(f"{H}.get_s3_client"),
        patch(f"{H}.emit_audit_event") as audit,
    ):
        yield audit


@contextmanager
def built(**secrets: str) -> Iterator[tuple[handler.GitHubIssuesWebhook, MagicMock, MagicMock]]:
    """A constructed webhook (secret *secrets*), its audit emitter and its metric recorder."""
    with isolated(**secrets) as audit, patch.object(handler.metrics, "add_metric") as add_metric:
        yield handler.GitHubIssuesWebhook(), audit, add_metric


def signed_event(raw: bytes, *, header: str = "x-hub-signature-256") -> dict:
    return webhook_event(body=raw.decode(), headers={header: _sig(raw)}, source_ip=CLIENT_IP)


def refused(status: int, error: str) -> dict:
    return {"statusCode": status, "body": json.dumps({"error": error})}


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(("secrets", "event", "response", "reason"), [
        pytest.param({"webhook_secret": "", "repos": REPO}, signed_event(b"{}"),
                     refused(503, "Webhook not configured"), "not_configured", id="empty-secret"),
        pytest.param({"repos": REPO}, signed_event(b"{}"),
                     refused(503, "Webhook not configured"), "not_configured", id="no-secret-key"),
        pytest.param({"webhook_secret": KEY}, webhook_event(body="abc", is_base64=True, source_ip=CLIENT_IP),
                     refused(400, "Invalid body"), "bad_encoding", id="bad-base64-padding"),
        pytest.param({"webhook_secret": KEY}, {**webhook_event(source_ip=CLIENT_IP), "body": 123, "isBase64Encoded": True},
                     refused(400, "Invalid body"), "bad_encoding", id="base64-of-a-non-string"),
        pytest.param({"webhook_secret": KEY}, signed_event(b"x" * (handler.MAX_BODY_BYTES + 1)),
                     refused(413, "Payload too large"), "too_large", id="one-byte-over"),
        pytest.param({"webhook_secret": KEY}, webhook_event(body="{}", source_ip=CLIENT_IP),
                     refused(401, "Invalid signature"), "bad_signature", id="no-signature-header"),
    ])
    def test_the_refusal_is_exact_audited_and_counted_once(self, secrets, event, response, reason):
        with built(**secrets) as (webhook, audit, add_metric):
            assert webhook.rejection(event) == response
        audit.assert_called_once_with(
            "webhook.rejected", "test_source", False, {"reason": reason, "ip_address": CLIENT_IP},
        )
        add_metric.assert_called_once_with(name="WebhookRejected", unit="Count", value=1)

    def test_the_size_cap_is_one_million_bytes(self):
        assert handler.MAX_BODY_BYTES == 1_000_000


class TestAnAuthenticDeliveryPasses:
    @pytest.mark.parametrize("event", [
        pytest.param(signed_event(b"x" * 1_000_000), id="exactly-the-cap"),
        pytest.param(signed_event(b"{}", header="X-Hub-Signature-256"), id="sender-cased-header"),
        pytest.param({**webhook_event(headers={"x-hub-signature-256": _sig(b"")}), "body": None},
                     id="absent-body-is-empty-bytes"),
        pytest.param({**webhook_event(headers={"x-hub-signature-256": _sig(b"")}), "body": 123},
                     id="non-string-body-is-empty-bytes"),
    ])
    def test_is_not_refused_and_leaves_no_rejection_trace(self, event):
        with built(webhook_secret=KEY) as (webhook, audit, add_metric):
            assert webhook.rejection(event) is None
        audit.assert_not_called()
        add_metric.assert_not_called()

    def test_a_base64_body_is_decoded_before_it_is_verified(self):
        raw = b'{"a": 1}'
        event = webhook_event(body=base64.b64encode(raw).decode(), headers={"x-hub-signature-256": _sig(raw)},
                              is_base64=True)
        with built(webhook_secret=KEY) as (webhook, _audit, _metric):
            assert webhook.rejection(event) is None


class TestSignatureMatches:
    def test_an_empty_secret_never_matches_even_a_signature_made_with_it(self):
        assert handler.signature_matches("", b"body", _sig(b"body", key="")) is False

    def test_a_missing_signature_is_false_not_an_error(self):
        assert handler.signature_matches(KEY, b"body", None) is False

    def test_a_correct_signature_matches(self):
        assert handler.signature_matches(KEY, b"body", _sig(b"body")) is True


def _payload(action: str, **extra: object) -> dict:
    return {"action": action, "issue": issue(7), "repository": {"full_name": REPO}, **extra}


class TestParsing:
    @pytest.mark.parametrize("action", ["deleted", "transferred", "pinned", "unpinned", "locked", "unlocked"])
    def test_an_ignored_action_yields_nothing(self, action):
        with built(webhook_secret=KEY, repos=REPO) as (webhook, _audit, _metric):
            assert webhook.parse_webhook_payload(_payload(action), {"X-GitHub-Event": "issues"}) == []

    def test_an_edited_issue_is_not_ignored(self):
        with built(webhook_secret=KEY, repos=REPO) as (webhook, _audit, _metric):
            items = webhook.parse_webhook_payload(_payload("edited"), {"X-GitHub-Event": "issues"})
        assert [item["id"] for item in items] == ["acme/Kiro#7"]

    @pytest.mark.parametrize("bad_comment", [
        pytest.param(None, id="not-a-dict"),
        pytest.param({k: v for k, v in comment(9, 7).items() if k != "id"}, id="no-id"),
    ])
    def test_a_comment_event_without_a_usable_comment_yields_nothing(self, bad_comment):
        with built(webhook_secret=KEY, repos=REPO) as (webhook, _audit, _metric):
            payload = _payload("created", comment=bad_comment)
            assert webhook.parse_webhook_payload(payload, {"X-GitHub-Event": "issue_comment"}) == []

    def test_a_delivery_without_an_event_header_is_logged_with_an_empty_name(self):
        with built(webhook_secret=KEY, repos=REPO) as (webhook, _audit, _metric), \
                patch.object(handler.logger, "info") as info:
            assert webhook.parse_webhook_payload(_payload("opened"), {}) == []
        info.assert_called_once_with(
            "github_issues webhook: ignoring event='' (ping, other event or unconfigured repo)",
        )


def _load_fresh_handler() -> ModuleType:
    return load_fresh("github_issues.webhook._handler_under_test", MODULE_PATH)


@pytest.fixture
def restored_sys_path() -> Iterator[list[str]]:
    before = list(sys.path)
    yield before
    sys.path[:] = before


class TestImportTimeConfiguration:
    def test_the_bucket_is_read_from_raw_data_bucket(self, monkeypatch):
        monkeypatch.setenv("RAW_DATA_BUCKET", "lake-bucket")
        assert _load_fresh_handler().RAW_DATA_BUCKET == "lake-bucket"

    def test_the_bucket_defaults_to_the_empty_string(self, monkeypatch):
        monkeypatch.delenv("RAW_DATA_BUCKET", raising=False)
        assert _load_fresh_handler().RAW_DATA_BUCKET == ""

    def test_the_plugin_root_is_put_at_the_front_of_sys_path(self, restored_sys_path):
        assert_loading_puts_root_first(_load_fresh_handler, restored_sys_path, PLUGIN_ROOT)


def _context() -> SimpleNamespace:
    return SimpleNamespace(
        function_name="voc-github-issues-webhook", memory_limit_in_mb=256,
        invoked_function_arn="arn:aws:lambda:us-east-1:123456789012:function:voc-github-issues-webhook",
        aws_request_id="req-1",
    )


def unconfigured():
    """Patches under which `lambda_handler` answers 503 (no webhook secret) without touching AWS."""
    return isolated(repos=REPO)


class TestInstrumentation:
    def test_a_refusal_returns_before_handling(self):
        with unconfigured():
            assert handler.lambda_handler(webhook_event(), _context()) == refused(503, "Webhook not configured")

    def test_the_cold_start_and_rejection_metrics_are_flushed_as_emf(self, capsys):
        with unconfigured():
            names = cold_start_metric_names(
                handler.metrics, lambda: handler.lambda_handler(webhook_event(), _context()), capsys,
            )
        assert names == {"ColdStart", "WebhookRejected"}

    def test_the_lambda_context_reaches_the_logger(self):
        handler.logger.remove_keys(["function_name", "cold_start"])
        with unconfigured():
            handler.lambda_handler(webhook_event(), _context())
        assert handler.logger.get_current_keys()["function_name"] == "voc-github-issues-webhook"

    def test_the_handler_is_registered_with_the_tracer(self):
        try:
            with patch.object(handler.tracer, "capture_lambda_handler", side_effect=lambda f: f) as capture:
                importlib.reload(handler)
            wrapped = vars(handler.lambda_handler)["__wrapped__"]
            assert capture.call_args_list == [call(wrapped)]
            assert wrapped.__name__ == "lambda_handler"
        finally:
            importlib.reload(handler)
