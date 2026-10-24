"""An issue already stored is refreshed in place by a newer copy (github_issues).

Before this, `process_feedback` skipped any id it had stored and the idempotency
key was `<source>:<id>`, so a label added, an issue closed or its text edited
after the first ingest never reached the stored item. Every test here drives the
real `record_handler` against moto-backed tables, because the guarantees are
conditional writes that only DynamoDB really evaluates (a mock cannot refuse one).
"""
import json
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

import boto3
import pytest
from aws_lambda_powertools.utilities.idempotency import DynamoDBPersistenceLayer, IdempotencyConfig
from moto import mock_aws

from processor import handler
from processor.test.sqs_fixtures import sqs_record
from shared.source_updates import UPDATE_CAPABLE_SOURCE, idempotency_key_for
from shared.test.moto_tables import create_pk_sk_table

INGESTED = "2026-01-02T00:00:00Z"
CHANGED = "2026-02-01T00:00:00Z"
TEXT = "Chat freezes #7\n\nThe chat panel freezes when I resume it."


def issue_message(updated_at: str = INGESTED, text: str = TEXT, **attributes) -> dict:
    """A github_issues queue message as the plugin sends it."""
    return {
        "id": "acme/Kiro#7",
        "source_platform": "github_issues",
        "text": text,
        "title": text.split("\n", 1)[0],
        "created_at": "2026-01-01T00:00:00Z",
        "channel": "issue",
        "issue_attributes": {
            "kind": "issue", "repo": "acme/Kiro", "number": 7, "state": "open",
            "labels": ["bug"], "plus_one": 3, "updated_at": updated_at, **attributes,
        },
    }


def insights(category: str = "product_quality", score: float = -0.4, urgency: str = "medium",
             label: str = "negative") -> dict:
    return {"insights": {
        "category": category, "subcategory": None, "sentiment_label": label, "sentiment_score": score,
        "urgency": urgency, "journey_stage": "usage", "impact_area": "product",
    }, "metadata": {"model_name": "haiku"}}


CATEGORIES = [
    {"id": "product_quality", "name": "product_quality", "subcategories": []},
    {"id": "performance", "name": "performance", "subcategories": []},
]


@contextmanager
def world(llm_answers: list[dict] | None = None, *, idempotent: bool = False):
    """Moto feedback (+ idempotency) tables wired into the handler, enrichment stubbed."""
    with mock_aws():
        feedback = create_pk_sk_table("test-feedback")
        llm = MagicMock(side_effect=llm_answers or [insights()])
        layer, config = None, None
        if idempotent:
            client = boto3.client("dynamodb", region_name="us-east-1")
            client.create_table(
                TableName="idem", BillingMode="PAY_PER_REQUEST",
                KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
                AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
            )
            layer = DynamoDBPersistenceLayer(table_name="idem", boto3_client=client)
            config = IdempotencyConfig(use_local_cache=False)
        with patch.object(handler, "feedback_table", feedback), \
             patch.object(handler, "persistence_layer", layer), \
             patch.object(handler, "idempotency_config", config), \
             patch.object(handler, "get_categories_config", return_value=CATEGORIES), \
             patch.object(handler, "detect_language", return_value="en"), \
             patch.object(handler, "translate_text", side_effect=lambda text, _s, _d: text), \
             patch.object(handler, "get_comprehend_sentiment", return_value={"label": "negative", "score": -0.4}), \
             patch.object(handler, "invoke_bedrock_llm", llm):
            yield feedback, llm


def deliver(message: dict) -> dict:
    return handler.record_handler(MagicMock(body=json.dumps(message)))


def stored(feedback) -> dict:
    (item,) = feedback.scan()["Items"]
    return item


class TestAttributeChanges:
    def test_a_label_added_after_ingest_reaches_the_stored_item(self):
        with world() as (feedback, llm):
            deliver(issue_message())
            deliver(issue_message(CHANGED, labels=["bug", "regression"]))
            item = stored(feedback)

        assert item["issue_attributes"]["labels"] == ["bug", "regression"]
        assert item["issue_attributes"]["updated_at"] == CHANGED
        assert llm.call_count == 1  # attributes only: no model call for a label

    def test_closing_the_issue_reaches_the_stored_item(self):
        with world() as (feedback, _):
            deliver(issue_message())
            deliver(issue_message(CHANGED, state="closed", state_reason="completed", milestone="0.5",
                                  plus_one=9, linked_prs=[12], comment_count=4, component="chat",
                                  software_version="0.4.3"))
            attributes = stored(feedback)["issue_attributes"]

        assert attributes["state"] == "closed"
        assert attributes["state_reason"] == "completed"
        assert (attributes["milestone"], attributes["plus_one"], attributes["linked_prs"]) == ("0.5", 9, [12])
        assert (attributes["comment_count"], attributes["component"], attributes["software_version"]) == \
            (4, "chat", "0.4.3")

    def test_an_attribute_refresh_keeps_the_keys_the_date_and_the_enrichment(self):
        with world() as (feedback, _):
            deliver(issue_message())
            before = stored(feedback)
            deliver(issue_message(CHANGED, labels=["question"]))
            after = stored(feedback)

        unchanged = ("pk", "sk", "gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk", "gsi3pk", "gsi3sk", "date",
                     "category", "sentiment_score", "original_text", "processed_at")
        assert {k: after[k] for k in unchanged} == {k: before[k] for k in unchanged}
        assert after["source_refreshed_at"]

    def test_a_stale_copy_delivered_late_changes_nothing(self):
        with world() as (feedback, _):
            deliver(issue_message())
            deliver(issue_message(CHANGED, labels=["regression"]))
            result = deliver(issue_message("2026-01-15T00:00:00Z", labels=["wontfix"]))
            item = stored(feedback)

        assert result == {"status": "skipped", "reason": "duplicate"}
        assert item["issue_attributes"]["labels"] == ["regression"]
        assert item["issue_attributes"]["updated_at"] == CHANGED

    def test_the_same_stamp_with_different_content_is_applied(self):
        """Two changes inside one second share a stamp; the later copy (and the next poll) converges."""
        with world() as (feedback, _):
            deliver(issue_message())
            deliver(issue_message(INGESTED, labels=["bug", "p1"]))

            assert stored(feedback)["issue_attributes"]["labels"] == ["bug", "p1"]

    def test_an_identical_resend_writes_nothing(self):
        with world() as (feedback, _):
            deliver(issue_message())
            before = stored(feedback)
            deliver(issue_message())

            assert stored(feedback) == before

    def test_a_copy_with_no_stamp_cannot_be_ordered_and_changes_nothing(self):
        message = issue_message(labels=["regression"])
        del message["issue_attributes"]["updated_at"]
        with world() as (feedback, _):
            deliver(issue_message())
            deliver(message)

            assert stored(feedback)["issue_attributes"]["labels"] == ["bug"]

    def test_an_item_stored_before_it_had_a_stamp_takes_a_changed_copy(self):
        with world() as (feedback, _):
            deliver(issue_message())
            feedback.update_item(Key={k: stored(feedback)[k] for k in ("pk", "sk")},
                                 UpdateExpression="REMOVE issue_attributes.updated_at")
            deliver(issue_message(INGESTED, labels=["regression"]))

            assert stored(feedback)["issue_attributes"]["labels"] == ["regression"]


class TestTextEdits:
    def test_an_edited_text_is_re_enriched_and_the_indexes_follow(self):
        edited = "Chat freezes #7\n\nIt also takes 30 seconds to load."
        answers = [insights(), insights("performance", -0.9, "high")]
        with world(answers) as (feedback, llm):
            deliver(issue_message())
            before = stored(feedback)
            deliver(issue_message(CHANGED, text=edited))
            after = stored(feedback)

        assert llm.call_count == 2
        assert after["original_text"] == edited
        assert (after["category"], after["sentiment_score"], after["urgency"]) == ("performance", Decimal("-0.9"), "high")
        assert after["gsi2pk"] == "CATEGORY#performance"
        assert after["gsi3pk"] == "URGENCY#high"
        # The sentiment half of gsi2sk moves; its timestamp half and the date index are the first ingest.
        assert after["gsi2sk"] == f"-0.9#{before['gsi2sk'].split('#', 1)[1]}"
        assert (after["gsi1pk"], after["gsi1sk"], after["date"]) == (before["gsi1pk"], before["gsi1sk"], before["date"])

    @staticmethod
    def _text_edit_after_a_person_changed(expression: str, values: dict) -> dict:
        """Ingest, apply a person's edit (``expression``), then deliver an edited copy; the stored item."""
        answers = [insights(), insights("performance", -0.9, "high")]
        with world(answers) as (feedback, _):
            deliver(issue_message())
            key = {k: stored(feedback)[k] for k in ("pk", "sk")}
            feedback.update_item(Key=key, UpdateExpression=expression, ExpressionAttributeValues=values)
            deliver(issue_message(CHANGED, text="Chat freezes #7\n\nNow with a different body."))
            return stored(feedback)

    def test_a_manual_category_correction_survives_a_text_edit(self):
        item = self._text_edit_after_a_person_changed(
            "SET category = :c, gsi2pk = :g, category_source = :m",
            {":c": "billing", ":g": "CATEGORY#billing", ":m": "manual"})

        assert (item["category"], item["gsi2pk"], item["category_source"]) == ("billing", "CATEGORY#billing", "manual")
        assert item["urgency"] == "high"  # the rest of the enrichment did refresh

    def test_manual_dimensions_and_tags_survive_a_text_edit(self):
        item = self._text_edit_after_a_person_changed(
            "SET dimensions = :d, dimension_sources = :s, tags = :t",
            {":d": {"product": "IDE"}, ":s": {"product": "manual"}, ":t": ["vip"]})

        assert item["dimensions"] == {"product": "IDE"}
        assert item["dimension_sources"] == {"product": "manual"}
        assert item["tags"] == ["vip"]

    def test_a_failed_model_call_refreshes_the_attributes_but_keeps_the_enrichment(self):
        failed = {"insights": {}, "metadata": {"error": "unparseable"}}
        with world([insights(), failed]) as (feedback, _):
            deliver(issue_message())
            deliver(issue_message(CHANGED, text="Chat freezes #7\n\nEdited.", labels=["regression"]))
            item = stored(feedback)

        assert item["issue_attributes"]["labels"] == ["regression"]
        assert item["original_text"] == TEXT  # left as stored, so the next copy re-tries the enrichment
        assert item["category"] == "product_quality"


class TestIdempotency:
    def test_a_newer_copy_is_processed_but_an_identical_resend_is_answered_by_the_store(self):
        with world(idempotent=True) as (feedback, llm), \
             patch.object(handler, "process_feedback", wraps=handler.process_feedback) as process:
            deliver(issue_message())
            deliver(issue_message())
            deliver(issue_message(CHANGED, labels=["regression"]))
            item = stored(feedback)

        assert process.call_count == 2  # the identical resend never reached it
        assert llm.call_count == 1
        assert item["issue_attributes"]["labels"] == ["regression"]

    def test_a_replayed_first_copy_does_not_overwrite_a_later_refresh(self):
        """The store answers a replay with the item it built then; the put is conditional, so it is not re-written."""
        with world(idempotent=True) as (feedback, _):
            deliver(issue_message())
            deliver(issue_message(CHANGED, labels=["regression"]))
            deliver(issue_message())
            item = stored(feedback)

        assert item["issue_attributes"]["labels"] == ["regression"]


class TestRaces:
    def test_an_item_that_appears_between_the_check_and_the_put_is_refreshed_instead(self):
        with world([insights(), insights()]) as (feedback, _):
            deliver(issue_message())
            with patch.object(handler, "load_stored_item", side_effect=[None, stored(feedback)]):
                result = deliver(issue_message(CHANGED, labels=["regression"]))
            item = stored(feedback)

        assert result["status"] == "source_update_apply"
        assert item["issue_attributes"]["labels"] == ["regression"]

    def test_a_concurrent_refresh_fails_the_record_for_a_retry(self):
        with world() as (feedback, _):
            deliver(issue_message())
            read = stored(feedback)
            feedback.update_item(Key={k: read[k] for k in ("pk", "sk")},
                                 UpdateExpression="SET issue_attributes.plus_one = :n",
                                 ExpressionAttributeValues={":n": 5})
            with patch.object(handler, "load_stored_item", return_value=read), \
                 pytest.raises(handler.ConcurrentSourceUpdateError):
                deliver(issue_message(CHANGED, labels=["regression"]))

            assert stored(feedback)["issue_attributes"]["labels"] == ["bug"]

    def test_other_sources_still_skip_an_id_they_already_stored(self, sample_sqs_record):
        with world([insights(), insights()]) as (feedback, llm):
            deliver(sample_sqs_record)
            result = deliver({**sample_sqs_record, "text": "Different words, same review id."})
            item = stored(feedback)

        assert result == {"status": "skipped", "reason": "duplicate"}
        assert llm.call_count == 1
        assert item["original_text"] == sample_sqs_record["text"]


def test_sqs_batches_go_through_the_same_path(lambda_context):
    """The batch entry point (the deployed handler) refreshes too."""
    with world() as (feedback, _):
        handler.lambda_handler({"Records": [sqs_record("m1", issue_message())]}, lambda_context)
        handler.lambda_handler({"Records": [sqs_record("m2", issue_message(CHANGED, state="closed"))]}, lambda_context)

        assert stored(feedback)["issue_attributes"]["state"] == "closed"


def non_github_issue_copy(updated_at: str = INGESTED, text: str = TEXT) -> dict:
    """Another producer's record that happens to carry `issue_attributes`."""
    return {**issue_message(updated_at, text), "source_platform": "webscraper", "id": "scraped-7"}


class TestOnlyGithubIssuesAreUpdateCapable:
    """`issue_attributes` alone never makes a record an in-place update."""

    def test_a_non_github_record_with_issue_attributes_is_stored_as_a_new_item(self):
        with world() as (feedback, llm):
            result = deliver(non_github_issue_copy())
            item = stored(feedback)

        assert result["status"] == "success", result
        assert (item["source_platform"], item["original_text"]) == ("webscraper", TEXT)
        assert llm.call_count == 1

    def test_its_newer_copy_is_a_duplicate_skip_never_an_overwrite(self):
        with world([insights(), insights()]) as (feedback, llm):
            deliver(non_github_issue_copy())
            with patch.object(handler, "refresh_stored_item") as refresh:
                result = deliver(non_github_issue_copy(CHANGED, text="Rewritten by someone else"))
            item = stored(feedback)

        assert result == {"status": "skipped", "reason": "duplicate"}
        refresh.assert_not_called()
        assert (item["original_text"], item["issue_attributes"]["updated_at"]) == (TEXT, INGESTED)
        assert llm.call_count == 1

    def test_its_idempotency_key_carries_no_fingerprint(self):
        assert idempotency_key_for(non_github_issue_copy()) == "webscraper:scraped-7"
        assert idempotency_key_for(non_github_issue_copy(CHANGED)) == "webscraper:scraped-7"

    def test_the_update_capable_source_is_the_github_plugins_manifest_id(self):
        manifest = Path(__file__).parents[3] / "plugins" / "github_issues" / "manifest.json"
        assert json.loads(manifest.read_text(encoding="utf-8"))["id"] == UPDATE_CAPABLE_SOURCE
