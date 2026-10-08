"""
Tests for S3 Import Ingestor handler.

Covers: field alias resolution, rating parsing, source naming, CSV/JSON/JSONL
parsing, parser dispatch per extension, batched SQS sending, URL-decoded keys
and the lambda_handler entry point. Exact log lines, boundaries, every alias
and the full response shape live in test_s3_import_handler_mutation.py.
"""

import io
import json
from typing import override
from unittest.mock import MagicMock, patch

import pytest

from _shared.test.ingestor_fixtures import offline_ingestor_construction

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _csv_bytes(header: str, *rows: str) -> bytes:
    return "\n".join([header, *rows]).encode("utf-8")


def _json_bytes(data) -> bytes:
    return json.dumps(data).encode("utf-8")


def _jsonl_bytes(*objects) -> bytes:
    return "\n".join(json.dumps(o) for o in objects).encode("utf-8")


def _stream(data: bytes):
    return io.BytesIO(data)


def _make_s3_event(bucket: str, key: str) -> dict:
    return {
        "Records": [{
            "eventSource": "aws:s3",
            "s3": {"bucket": {"name": bucket}, "object": {"key": key}},
        }]
    }


@pytest.fixture
def lambda_context():
    ctx = MagicMock()
    ctx.function_name = "test-s3-import"
    ctx.memory_limit_in_mb = 512
    ctx.invoked_function_arn = "arn:aws:lambda:us-east-1:123456789:function:test"
    ctx.aws_request_id = "test-request-id"
    return ctx


# ---------------------------------------------------------------------------
# Module-level helper tests
# ---------------------------------------------------------------------------

class TestResolveField:
    def test_returns_canonical_field(self):
        from s3_import.ingestor.handler import _resolve_field
        assert _resolve_field({"text": "hello"}, "text") == "hello"

    def test_returns_alias_when_canonical_missing(self):
        from s3_import.ingestor.handler import _resolve_field
        assert _resolve_field({"comment": "hello"}, "text") == "hello"

    def test_returns_default_when_no_match(self):
        from s3_import.ingestor.handler import _resolve_field
        assert _resolve_field({"unrelated": "x"}, "text", "fallback") == "fallback"

    def test_skips_empty_strings(self):
        from s3_import.ingestor.handler import _resolve_field
        assert _resolve_field({"text": "", "content": "real"}, "text") == "real"

    def test_skips_whitespace_only(self):
        from s3_import.ingestor.handler import _resolve_field
        assert _resolve_field({"text": "  ", "feedback": "ok"}, "text") == "ok"

    def test_strips_whitespace(self):
        from s3_import.ingestor.handler import _resolve_field
        assert _resolve_field({"text": "  padded  "}, "text") == "padded"


class TestParseRating:
    def test_parses_int(self):
        from s3_import.ingestor.handler import _parse_rating
        assert _parse_rating(5) == 5.0

    def test_parses_string(self):
        from s3_import.ingestor.handler import _parse_rating
        assert _parse_rating("4") == 4.0


class TestGetSourceFromKey:
    def test_extracts_folder_name(self):
        from s3_import.ingestor.handler import _get_source_from_key
        assert _get_source_from_key("surveys/data.csv") == "S3 - surveys"

    def test_returns_default_for_root_file(self):
        from s3_import.ingestor.handler import _get_source_from_key
        assert _get_source_from_key("data.csv") == "S3 - Import"


class TestNormalizeRow:
    def test_returns_none_for_empty_text(self):
        from s3_import.ingestor.handler import _normalize_row
        assert _normalize_row({"text": ""}, "S3 - test", "csv_import") is None
        assert _normalize_row({"id": "1"}, "S3 - test", "csv_import") is None


# ---------------------------------------------------------------------------
# Parser tests
# ---------------------------------------------------------------------------

class TestParseCsv:
    def test_parses_valid_csv(self):
        from s3_import.ingestor.handler import _parse_csv
        data = _csv_bytes("id,text,rating", "1,Great product,5", "2,Poor service,1")
        items = list(_parse_csv(_stream(data), "S3 - test"))
        assert len(items) == 2
        assert items[0]["text"] == "Great product"
        assert items[1]["rating"] == 1.0


class TestParseJsonl:
    def test_parses_valid_jsonl(self):
        from s3_import.ingestor.handler import _parse_jsonl
        data = _jsonl_bytes({"text": "Review 1"}, {"text": "Review 2"})
        items = list(_parse_jsonl(_stream(data), "S3 - test"))
        assert len(items) == 2

    def test_skips_empty_lines(self):
        from s3_import.ingestor.handler import _parse_jsonl
        raw = b'{"text": "One"}\n\n\n{"text": "Two"}\n'
        items = list(_parse_jsonl(_stream(raw), "S3 - test"))
        assert len(items) == 2

    def test_skips_items_with_empty_text(self):
        from s3_import.ingestor.handler import _parse_jsonl
        data = _jsonl_bytes({"text": ""}, {"text": "Valid"})
        items = list(_parse_jsonl(_stream(data), "S3 - test"))
        assert len(items) == 1


class TestParseJson:
    def test_parses_json_array(self):
        from s3_import.ingestor.handler import _parse_json
        data = _json_bytes([{"text": "A"}, {"text": "B"}])
        items = list(_parse_json(_stream(data), "S3 - test"))
        assert len(items) == 2

    def test_parses_single_object(self):
        from s3_import.ingestor.handler import _parse_json
        data = _json_bytes({"text": "Solo"})
        items = list(_parse_json(_stream(data), "S3 - test"))
        assert len(items) == 1


# ---------------------------------------------------------------------------
# Ingestor / process_file tests
# ---------------------------------------------------------------------------

@pytest.fixture
def ingestor():
    """Create an S3ImportIngestor with mocked AWS dependencies."""
    with offline_ingestor_construction():
        from s3_import.ingestor.handler import S3ImportIngestor

        class _MarkingS3ImportIngestor(S3ImportIngestor):
            """Normalizes by marking the item instead of storing it to S3."""

            @override
            def normalize_item(self, item: dict, raw_content: str | None = None) -> dict:
                return {**item, "_normalized": True}

        ing = _MarkingS3ImportIngestor()
        # Mirror the real contract: send_to_queue returns the number of items SQS
        # confirmed, and raises rather than losing any.  A bare MagicMock() would
        # return a MagicMock, so process_file's count would silently stop being a
        # number and every assertion on it would be vacuous.
        ing.send_to_queue = MagicMock(side_effect=len)
        return ing


def _serve_csv_rows(mock_s3: MagicMock, row_count: int) -> None:
    """Have *mock_s3* serve a CSV with *row_count* reviews."""
    rows = [f"{i},Review {i},3" for i in range(row_count)]
    csv_data = _csv_bytes("id,text,rating", *rows)
    mock_s3.head_object.return_value = {"ContentLength": len(csv_data)}
    mock_s3.get_object.return_value = {"Body": _stream(csv_data)}


class TestProcessFile:
    @patch("s3_import.ingestor.handler.s3_client")
    def test_processes_csv(self, mock_s3, ingestor):
        csv_data = _csv_bytes("id,text,rating", "1,Great,5", "2,Bad,1", "3,Ok,3")
        mock_s3.head_object.return_value = {"ContentLength": len(csv_data)}
        mock_s3.get_object.return_value = {"Body": _stream(csv_data)}

        assert ingestor.process_file("bucket", "surveys/data.csv") == 3
        ingestor.send_to_queue.assert_called_once()

    @patch("s3_import.ingestor.handler.s3_client")
    def test_processes_json(self, mock_s3, ingestor):
        json_data = _json_bytes([{"text": "A"}, {"text": "B"}])
        mock_s3.head_object.return_value = {"ContentLength": len(json_data)}
        mock_s3.get_object.return_value = {"Body": _stream(json_data)}

        assert ingestor.process_file("bucket", "src/data.json") == 2

    @patch("s3_import.ingestor.handler.s3_client")
    def test_processes_jsonl(self, mock_s3, ingestor):
        jsonl_data = _jsonl_bytes({"text": "L1"}, {"text": "L2"}, {"text": "L3"})
        mock_s3.head_object.return_value = {"ContentLength": len(jsonl_data)}
        mock_s3.get_object.return_value = {"Body": _stream(jsonl_data)}

        assert ingestor.process_file("bucket", "src/data.jsonl") == 3

    @patch("s3_import.ingestor.handler.metrics")
    @patch("s3_import.ingestor.handler.s3_client")
    def test_reports_what_landed_when_a_later_batch_is_rejected(
        self, mock_s3, mock_metrics, ingestor
    ):
        """When send_to_queue raises part-way through a file, the items already
        enqueued must still be reported, and the error must propagate.

        This plugin is the third caller of the shared helper, so it inherits the
        raising contract: one rejected row now fails the whole file rather than
        silently importing a subset.

        Reverts-to-catch: emitting ItemsImported after the loop skips it entirely
        on the raise, so a run that enqueued 200 of 250 items reports nothing to
        CloudWatch — and counting ``len(batch)`` instead of the returned value
        reports 250 for a file where 50 items never reached the queue.
        """
        _serve_csv_rows(mock_s3, 250)
        ingestor.send_to_queue = MagicMock(
            side_effect=[100, 100, RuntimeError("50 ingestor item(s) rejected")]
        )

        with pytest.raises(RuntimeError):
            ingestor.process_file("bucket", "src/big.csv")

        mock_metrics.add_metric.assert_called_once_with(
            name="ItemsImported", unit="Count", value=200
        )


# ---------------------------------------------------------------------------
# lambda_handler tests
# ---------------------------------------------------------------------------

class TestLambdaHandler:
    @patch("s3_import.ingestor.handler.S3ImportIngestor")
    def test_decodes_url_encoded_keys(self, MockIngestor, lambda_context):
        from s3_import.ingestor.handler import lambda_handler
        mock_inst = MagicMock()
        mock_inst.process_file.return_value = 1
        MockIngestor.return_value = mock_inst

        lambda_handler(_make_s3_event("bucket", "my+folder/my+file.csv"), lambda_context)
        mock_inst.process_file.assert_called_once_with("bucket", "my folder/my file.csv")
