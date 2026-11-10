"""Both transports re-send an issue that changed after its first ingest.

The processor refreshes a stored item in place when a newer copy arrives
(``shared/source_updates.py``), so the plugin's half of the fix is simply that a
change — a label, a close, an edit — always produces a copy carrying the
current state and a newer ``updated_at``, for the issue AND for the comments
already stored under it (they carry the issue's labels / state / milestone).
"""
import json

import pytest
from github_fixtures import ISSUES_PATH, REPO, FakeGitHub, comment, issue, ok
from github_ingestor_fixtures import WATERMARK_KEY, WatermarkTable, ingestor_with, sent_items
from test_github_issues_webhook import call, delivery, enqueued, github_webhook, issues_payload

from _shared.github_mapping import comment_item, issue_item

COMMENTS_PATH = f"/repos/{REPO}/issues/7/comments"
INGESTED = "2026-01-02T00:00:00Z"
CHANGED = "2026-02-01T00:00:00Z"


class TestTheMappingStampsAComment:
    def test_a_comment_is_as_new_as_the_later_of_itself_and_its_issue(self):
        parent = issue(7, CHANGED)
        item = comment_item(comment(10, 7, updated_at=INGESTED), REPO, parent)

        assert item["issue_attributes"]["updated_at"] == CHANGED

    def test_an_edited_comment_on_an_unchanged_issue_keeps_its_own_stamp(self):
        item = comment_item(comment(10, 7, updated_at=CHANGED), REPO, issue(7, INGESTED))

        assert item["issue_attributes"]["updated_at"] == CHANGED

    def test_a_comment_without_stamps_has_none(self):
        item = comment_item(comment(10, 7, updated_at=None), REPO, issue(7, updated_at=INGESTED) | {"updated_at": None})

        assert "updated_at" not in item["issue_attributes"]

    def test_an_issue_keeps_githubs_own_stamp(self):
        assert issue_item(issue(7, CHANGED), REPO)["issue_attributes"]["updated_at"] == CHANGED


class TestTheWebhookResendsAChangedIssue:
    @pytest.mark.parametrize(("action", "changes", "expected"), [
        ("labeled", {"labels": [{"name": "bug"}, {"name": "regression"}]}, {"labels": ["bug", "regression"]}),
        ("unlabeled", {"labels": []}, {"labels": []}),
        ("closed", {"state": "closed", "state_reason": "completed"}, {"state": "closed", "state_reason": "completed"}),
        ("reopened", {"state": "open"}, {"state": "open"}),
        ("milestoned", {"milestone": {"title": "0.6"}}, {"milestone": "0.6"}),
        ("edited", {"title": "Chat freezes on resume"}, {}),
    ])
    def test_each_change_event_enqueues_the_current_state(self, action, changes, expected):
        with github_webhook() as (handler, sqs, _, _audit):
            status, _ = call(handler, delivery(issues_payload(action, updated_at=CHANGED, **changes)))

        assert status == 200
        (item,) = enqueued(sqs)
        assert item["id"] == "acme/Kiro#7"
        attributes = item["issue_attributes"]
        assert attributes["updated_at"] == CHANGED
        assert {key: attributes.get(key) for key in expected} == expected

    def test_an_edited_issue_carries_its_new_text(self):
        with github_webhook() as (handler, sqs, _, _audit):
            call(handler, delivery(issues_payload("edited", updated_at=CHANGED, title="Chat freezes on resume")))

        assert enqueued(sqs)[0]["text"].startswith("Chat freezes on resume")

    def test_an_edited_comment_is_enqueued_with_its_issues_current_labels(self):
        payload = {
            "action": "edited",
            "issue": issue(7, CHANGED, labels=[{"name": "regression"}]),
            "comment": comment(10, 7, updated_at=INGESTED),
            "repository": {"full_name": REPO},
        }
        with github_webhook() as (handler, sqs, _, _audit):
            call(handler, delivery(payload, event="issue_comment"))

        (item,) = enqueued(sqs)
        assert item["issue_attributes"]["labels"] == ["regression"]
        assert item["issue_attributes"]["updated_at"] == CHANGED


class TestThePollerResendsAChangedIssue:
    def _run(self, listed_issue: dict, comments: list[dict]) -> tuple[list[dict], FakeGitHub]:
        github = FakeGitHub({ISSUES_PATH: [ok([listed_issue])], COMMENTS_PATH: [ok(comments)]})
        # The issue was ingested at INGESTED: the watermark sits there, so only a change re-lists it.
        watermarks = WatermarkTable({WATERMARK_KEY: json.dumps({"since": INGESTED, "boundary": [7]})})
        with ingestor_with(github, watermarks) as ingestor:
            ingestor.run()
        return sent_items(ingestor), github

    def test_a_label_change_re_sends_the_issue_and_its_stored_comment_with_the_new_labels(self):
        changed = issue(7, CHANGED, comments=1, labels=[{"name": "bug"}, {"name": "regression"}])
        sent, github = self._run(changed, [comment(10, 7, updated_at=INGESTED)])

        assert [i["id"] for i in sent] == ["acme/Kiro#7", "acme/Kiro#7/comment-10"]
        assert all(i["issue_attributes"]["labels"] == ["bug", "regression"] for i in sent)
        assert all(i["issue_attributes"]["updated_at"] == CHANGED for i in sent)
        # Every comment, not only those edited since the watermark.
        assert github.calls[1].params == {"per_page": 100}

    def test_a_close_re_sends_the_issue_closed(self):
        sent, _ = self._run(issue(7, CHANGED, comments=1, state="closed", state_reason="not_planned"),
                            [comment(10, 7, updated_at=INGESTED)])

        assert [i["issue_attributes"]["state"] for i in sent] == ["closed", "closed"]
        assert sent[0]["issue_attributes"]["state_reason"] == "not_planned"
