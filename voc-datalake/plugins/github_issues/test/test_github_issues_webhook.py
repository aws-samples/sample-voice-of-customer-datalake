"""The github_issues webhook: HMAC verification, size cap, event filtering, mapping, raw archive."""
import hashlib
import hmac
import json
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest
from github_fixtures import REPO, comment, issue

from _shared.test.scoped_secret import scoped_secret
from _shared.test.sqs_response_fixtures import echo_batch_success
from _shared.test.webhook_fixtures import webhook_event

SECRET = "s3cr3t-webhook"


def sign(body: bytes, secret: str = SECRET) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


@contextmanager
def github_webhook(**secrets):
    sqs = MagicMock()
    sqs.send_message_batch.side_effect = echo_batch_success
    values = {"webhook_secret": SECRET, "repos": REPO, **secrets}
    with (
        patch("_shared.base_webhook.get_sqs_client", return_value=sqs),
        patch("_shared.base_webhook.get_secret", return_value=scoped_secret(**values)),
        patch("github_issues.webhook.handler.get_s3_client") as s3,
        patch("github_issues.webhook.handler.emit_audit_event") as audit,
    ):
        from github_issues.webhook.handler import lambda_handler

        yield lambda_handler, sqs, s3.return_value, audit


def delivery(payload: dict, event: str = "issues", *, signature: str | None = None) -> dict:
    raw = json.dumps(payload).encode()
    headers = {"X-GitHub-Event": event, "x-hub-signature-256": sign(raw) if signature is None else signature}
    return webhook_event(body=raw.decode(), headers=headers)


def issues_payload(action: str = "opened", **issue_overrides) -> dict:
    return {"action": action, "issue": issue(7, **issue_overrides), "repository": {"full_name": REPO}}


def enqueued(sqs) -> list[dict]:
    return [json.loads(e["MessageBody"]) for c in sqs.send_message_batch.call_args_list for e in c.kwargs["Entries"]]


def call(handler, event):
    response = handler(event, MagicMock())
    return response["statusCode"], json.loads(response["body"])


class TestSignature:
    def test_a_valid_signature_is_accepted_and_the_issue_enqueued(self):
        with github_webhook() as (handler, sqs, _, _audit):
            status, body = call(handler, delivery(issues_payload()))

        assert (status, body["items_processed"]) == (200, 1)
        item = enqueued(sqs)[0]
        assert item["id"] == "acme/Kiro#7"
        assert item["source_platform"] == "test_source"
        assert item["is_webhook"] is True
        assert item["issue_attributes"]["software_version"] == "0.4.2"

    @pytest.mark.parametrize("signature", [
        "",
        "sha256=" + "0" * 64,
        "sha1=abc",
        sign(b"a different body"),
        sign(json.dumps(issues_payload()).encode(), secret="wrong"),
    ])
    def test_a_missing_or_invalid_signature_is_rejected(self, signature):
        with github_webhook() as (handler, sqs, _, audit):
            status, body = call(handler, delivery(issues_payload(), signature=signature))

        assert status == 401
        assert body == {"error": "Invalid signature"}
        sqs.send_message_batch.assert_not_called()
        assert audit.call_args.args[0] == "webhook.rejected"
        assert audit.call_args.args[3]["reason"] == "bad_signature"

    def test_no_configured_secret_refuses_everything(self):
        with github_webhook(webhook_secret="") as (handler, sqs, _, _audit):
            status, _ = call(handler, delivery(issues_payload()))
        assert status == 503
        sqs.send_message_batch.assert_not_called()

    def test_an_oversized_body_is_refused_before_it_is_verified(self):
        from github_issues.webhook import handler as module

        with patch.object(module, "MAX_BODY_BYTES", 100), \
                patch.object(module, "signature_matches") as verify, \
                github_webhook() as (handler, sqs, _, _audit):
            status, _ = call(handler, delivery(issues_payload()))

        assert status == 413
        verify.assert_not_called()
        sqs.send_message_batch.assert_not_called()

    def test_the_compare_is_constant_time(self):
        from github_issues.webhook.handler import signature_matches

        with patch("hmac.compare_digest", return_value=True) as compare:
            assert signature_matches(SECRET, b"x", "sha256=whatever")
        compare.assert_called_once()

    def test_the_secret_never_appears_in_a_response(self):
        with github_webhook() as (handler, _, _s3, _audit):
            response = handler(delivery(issues_payload(), signature="sha256=bad"), MagicMock())
        assert SECRET not in json.dumps(response)


class TestEvents:
    def test_a_comment_is_its_own_item_linked_to_the_issue(self):
        payload = {"action": "created", "issue": issue(7), "comment": comment(9, 7), "repository": {"full_name": REPO}}
        with github_webhook() as (handler, sqs, _, _audit):
            status, _ = call(handler, delivery(payload, "issue_comment"))

        assert status == 200
        item = enqueued(sqs)[0]
        assert item["id"] == "acme/Kiro#7/comment-9"
        assert item["issue_attributes"]["parent_id"] == "acme/Kiro#7"
        assert item["issue_attributes"]["software_version"] == "0.4.3"

    @pytest.mark.parametrize(("event", "payload"), [
        ("ping", {"zen": "Keep it logically awesome.", "repository": {"full_name": REPO}}),
        ("push", {"repository": {"full_name": REPO}}),
        ("issues", {**issues_payload(), "repository": {"full_name": "someone/else"}}),
        ("issues", issues_payload(action="deleted")),
        ("issues", issues_payload(pull_request={"url": "x"})),
        ("issue_comment", {"action": "created", "issue": issue(7),
                           "comment": comment(9, 7, user={"login": "ci", "type": "Bot"}),
                           "repository": {"full_name": REPO}}),
    ])
    def test_is_acknowledged_and_dropped(self, event, payload):
        with github_webhook() as (handler, sqs, _, _audit):
            status, body = call(handler, delivery(payload, event))

        assert (status, body["items_processed"]) == (200, 0)
        sqs.send_message_batch.assert_not_called()

    def test_the_label_filter_applies(self):
        with github_webhook(labels="feedback") as (handler, sqs, _, _audit):
            call(handler, delivery(issues_payload()))
        sqs.send_message_batch.assert_not_called()

    def test_the_repo_name_is_matched_case_insensitively(self):
        payload = {**issues_payload(), "repository": {"full_name": "ACME/kiro"}}
        with github_webhook() as (handler, sqs, _, _audit):
            call(handler, delivery(payload))
        assert enqueued(sqs)[0]["issue_attributes"]["repo"] == REPO


def test_the_payload_is_archived_to_s3_and_not_sent_inline():
    with patch("github_issues.webhook.handler.RAW_DATA_BUCKET", "raw-bucket"), \
            github_webhook() as (handler, sqs, s3, _audit):
        call(handler, delivery(issues_payload()))

    put = s3.put_object.call_args.kwargs
    assert put["Bucket"] == "raw-bucket"
    # "acme/Kiro#7" is not filename-safe, so its archive stem is its sha256 (shared/archive_keys.py).
    stem = "h." + hashlib.sha256(b"acme/Kiro#7").hexdigest()
    assert put["Key"] == f"raw/test_source/2026/01/01/{stem}.json"
    assert json.loads(json.loads(put["Body"])["raw_content"])["number"] == 7
    item = enqueued(sqs)[0]
    assert item["s3_raw_uri"].startswith("s3://raw-bucket/")
    assert "raw_data" not in item or item["raw_data"] is None


class TestVolumeFilters:
    """A delivery is filtered exactly like a poll of the same item."""

    def test_an_issue_by_an_excluded_role_is_acknowledged_and_dropped(self):
        with github_webhook(exclude_associations="MEMBER") as (handler, sqs, _, _audit):
            status, _body = call(handler, delivery(issues_payload(author_association="MEMBER")))

        assert status == 200
        assert enqueued(sqs) == []

    def test_an_issue_created_before_the_start_date_is_dropped(self):
        with github_webhook(created_after="2026-03-01") as (handler, sqs, _, _audit):
            call(handler, delivery(issues_payload(created_at="2026-02-01T00:00:00Z")))

        assert enqueued(sqs) == []

    def test_a_customer_reply_on_an_excluded_issue_is_still_enqueued(self):
        payload = {
            "action": "created",
            "issue": issue(7, author_association="MEMBER", created_at="2025-01-01T00:00:00Z"),
            "comment": comment(70, 7, created_at="2026-04-01T00:00:00Z", author_association="NONE"),
            "repository": {"full_name": REPO},
        }
        with github_webhook(exclude_associations="MEMBER", created_after="2026-03-01") as (handler, sqs, _, _audit):
            call(handler, delivery(payload, "issue_comment"))

        assert [i["id"] for i in enqueued(sqs)] == ["acme/Kiro#7/comment-70"]

    def test_a_reply_by_an_excluded_role_is_dropped(self):
        payload = {
            "action": "created",
            "issue": issue(7),
            "comment": comment(70, 7, author_association="OWNER"),
            "repository": {"full_name": REPO},
        }
        with github_webhook(exclude_associations="OWNER") as (handler, sqs, _, _audit):
            call(handler, delivery(payload, "issue_comment"))

        assert enqueued(sqs) == []
