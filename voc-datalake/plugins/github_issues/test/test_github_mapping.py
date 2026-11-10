"""Issue/comment payload → feedback item, and that the item passes the queue's schema."""
from github_fixtures import REPO, comment, issue

from _shared.github_config import GitHubSourceConfig
from _shared.github_mapping import RAW_PAYLOAD_KEY, comment_item, issue_item
from _shared.normalized_item import normalized_item_fields
from shared.ingest_schemas import safe_validate_message


def _validated(item: dict) -> dict:
    raw = {k: v for k, v in item.items() if k != RAW_PAYLOAD_KEY}
    message = normalized_item_fields(raw, source_platform="github_issues", default_channel="unknown", brand_name="B")
    validated, errors = safe_validate_message(message)
    assert errors == []
    assert validated is not None
    return validated.model_dump(mode="json", exclude_none=True)


class TestIssueItem:
    def test_maps_every_field(self):
        item = issue_item(issue(7, comments=2, body=issue(7)["body"] + "\nFixed in PR #31"), REPO, ["Kiro"])

        assert item["id"] == "acme/Kiro#7"
        assert item["channel"] == "issue"
        assert item["url"] == "https://github.com/acme/Kiro/issues/7"
        assert item["text"].startswith("Chat freezes #7\n\n")
        assert "###" not in item["text"]
        assert item["issue_attributes"] == {
            "kind": "issue",
            "repo": REPO,
            "number": 7,
            "state": "open",
            "labels": ["bug", "area: chat"],
            "plus_one": 3,
            "reactions_total": 4,
            "author_association": "NONE",
            "milestone": "0.5",
            "linked_prs": [31],
            "comment_count": 2,
            "updated_at": "2026-01-02T00:00:00Z",
            "software_version": "0.4.2",
            "version_source": "form",
            "component": "chat",
            "error_signature": "typeerror: cannot read properties of undefined (reading <str>)",
            "has_repro": True,
        }
        assert item[RAW_PAYLOAD_KEY]["number"] == 7

    def test_passes_the_queue_schema_and_keeps_its_attributes(self):
        message = _validated(issue_item(issue(7), REPO))
        assert message["issue_attributes"]["software_version"] == "0.4.2"
        assert message["issue_attributes"]["labels"] == ["bug", "area: chat"]

    def test_an_empty_body_still_has_text(self):
        item = issue_item(issue(8, body=None, labels=[]), REPO)
        assert item["text"] == "Chat freezes #8"
        assert "software_version" not in item["issue_attributes"]
        _validated(item)

    def test_a_label_version_is_used_when_the_body_has_none(self):
        item = issue_item(issue(9, body="It broke", labels=[{"name": "v1.2.3"}]), REPO)
        assert item["issue_attributes"]["software_version"] == "1.2.3"
        assert item["issue_attributes"]["version_source"] == "label"


class TestCommentItem:
    def test_is_its_own_item_linked_to_the_issue(self):
        parent = issue(7)
        item = comment_item(comment(555, 7), REPO, parent, ["Kiro"])

        assert item["id"] == "acme/Kiro#7/comment-555"
        assert item["channel"] == "comment"
        assert item["text"] == "Re: Chat freezes #7\n\nSame here on Kiro 0.4.3"
        attributes = item["issue_attributes"]
        assert attributes["kind"] == "comment"
        assert attributes["parent_id"] == "acme/Kiro#7"
        # Its own version mention wins over the issue's.
        assert attributes["software_version"] == "0.4.3"
        # Labels and component are the issue's.
        assert attributes["labels"] == ["bug", "area: chat"]
        assert attributes["component"] == "chat"
        assert attributes["plus_one"] == 1
        _validated(item)

    def test_inherits_the_issue_version_when_it_cites_none(self):
        item = comment_item(comment(1, 7, body="+1, any workaround?"), REPO, issue(7))
        assert item["issue_attributes"]["software_version"] == "0.4.2"
        assert item["issue_attributes"]["version_source"] == "form"


class TestConfig:
    def test_parses_repos_labels_and_product_names(self):
        config = GitHubSourceConfig.from_secrets({
            "repos": "acme/Kiro\nhttps://github.com/acme/other.git, not a repo,acme/kiro",
            "labels": "Bug, feedback",
            "product_names": "Kiro IDE",
        })
        assert config.repos == ("acme/Kiro", "acme/other")
        assert config.labels == frozenset({"bug", "feedback"})
        assert config.product_names == ("Kiro IDE", "Kiro", "other")

    def test_label_filter_is_any_of_and_case_insensitive(self):
        config = GitHubSourceConfig.from_secrets({"labels": "bug"})
        assert config.admits_labels(["BUG", "x"])
        assert not config.admits_labels(["question"])
        assert GitHubSourceConfig.from_secrets({}).admits_labels([])

    def test_canonical_repo_is_case_insensitive_and_only_for_configured_repos(self):
        config = GitHubSourceConfig.from_secrets({"repos": "acme/Kiro"})
        assert config.canonical_repo("ACME/kiro") == "acme/Kiro"
        assert config.canonical_repo("evil/repo") is None
        assert config.canonical_repo(None) is None
