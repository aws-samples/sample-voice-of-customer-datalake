"""
Tests for S3 Import Ingestor handler.

Covers: field alias resolution, deterministic IDs, CSV/JSON/JSONL parsing,
file size validation, batched SQS sending, and lambda_handler entry point.
"""

import io
import json
import pytest
from unittest.mock import patch, MagicMock


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _csv_bytes(header: str, *rows: str) -> bytes:
    return "\n".join([header] + list(rows)).encode("utf-8")


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


class TestGenerateDeterministicId:
    def test_produces_consistent_ids(self):
        from s3_import.ingestor.handler import _generate_deterministic_id
        assert _generate_deterministic_id("same") == _generate_deterministic_id("same")

    def test_different_text_produces_different_ids(self):
        from s3_import.ingestor.handler import _generate_deterministic_id
        assert _generate_deterministic_id("A") != _generate_deterministic_id("B")

    def test_starts_with_s3_prefix(self):
        from s3_import.ingestor.handler import _generate_deterministic_id
        assert _generate_deterministic_id("hello").startswith("s3-")

    def test_handles_empty_text(self):
        from s3_import.ingestor.handler import _generate_deterministic_id
        result = _generate_deterministic_id("")
        assert result.startswith("s3-") and len(result) > 3


class TestParseRating:
    def test_parses_int(self):
        from s3_import.ingestor.handler import _parse_rating
        assert _parse_rating(5) == 5.0

    def test_parses_string(self):
        from s3_import.ingestor.handler import _parse_rating
        assert _parse_rating("4") == 4.0

    def test_returns_none_for_none(self):
        from s3_import.ingestor.handler import _parse_rating
        assert _parse_rating(None) is None

    def test_returns_none_for_empty(self):
        from s3_import.ingestor.handler import _parse_rating
        assert _parse_rating("") is None

    def test_returns_none_for_non_numeric(self):
        from s3_import.ingestor.handler import _parse_rating
        assert _parse_rating("excellent") is None


class TestGetSourceFromKey:
    def test_extracts_folder_name(self):
        from s3_import.ingestor.handler import _get_source_from_key
        assert _get_source_from_key("surveys/data.csv") == "S3 - surveys"

    def test_returns_default_for_root_file(self):
        from s3_import.ingestor.handler import _get_source_from_key
        assert _get_source_from_key("data.csv") == "S3 - Import"


class TestNormalizeRow:
    def test_normalizes_canonical_fields(self):
        from s3_import.ingestor.handler import _normalize_row
        result = _normalize_row({"id": "1", "text": "Great", "rating": "5"}, "S3 - test")
        assert result["text"] == "Great"
        assert result["id"] == "1"
        assert result["rating"] == 5.0

    def test_resolves_aliases(self):
        from s3_import.ingestor.handler import _normalize_row
        result = _normalize_row({"review_id": "r1", "comment": "Nice", "score": "4"}, "S3 - test")
        assert result["text"] == "Nice"
        assert result["id"] == "r1"
        assert result["rating"] == 4.0

    def test_returns_none_for_empty_text(self):
        from s3_import.ingestor.handler import _normalize_row
        assert _normalize_row({"text": ""}, "S3 - test") is None
        assert _normalize_row({"id": "1"}, "S3 - test") is None

    def test_generates_id_when_missing(self):
        from s3_import.ingestor.handler import _normalize_row
        result = _normalize_row({"text": "No id here"}, "S3 - test")
        assert result["id"].startswith("s3-")

    def test_sets_source_platform_override(self):
        from s3_import.ingestor.handler import _normalize_row
        result = _normalize_row({"text": "Hello"}, "S3 - surveys")
        assert result["source_platform_override"] == "S3 - surveys"


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

    def test_resolves_alias_columns(self):
        from s3_import.ingestor.handler import _parse_csv
        data = _csv_bytes("review_id,comment,score,date", "r1,Nice,4,2025-06-01")
        items = list(_parse_csv(_stream(data), "S3 - test"))
        assert len(items) == 1
        assert items[0]["text"] == "Nice"
        assert items[0]["created_at"] == "2025-06-01"

    def test_skips_rows_with_empty_text(self):
        from s3_import.ingestor.handler import _parse_csv
        data = _csv_bytes("id,text,rating", "1,,5", "2,Valid,3")
        items = list(_parse_csv(_stream(data), "S3 - test"))
        assert len(items) == 1

    def test_rejects_csv_without_text_column(self):
        from s3_import.ingestor.handler import _parse_csv
        data = _csv_bytes("id,score,date", "1,5,2025-01-01")
        items = list(_parse_csv(_stream(data), "S3 - test"))
        assert len(items) == 0

    def test_rejects_empty_headers(self):
        from s3_import.ingestor.handler import _parse_csv
        items = list(_parse_csv(_stream(b""), "S3 - test"))
        assert len(items) == 0


class TestParseJsonl:
    def test_parses_valid_jsonl(self):
        from s3_import.ingestor.handler import _parse_jsonl
        data = _jsonl_bytes({"text": "Review 1"}, {"text": "Review 2"})
        items = list(_parse_jsonl(_stream(data), "S3 - test"))
        assert len(items) == 2

    def test_skips_invalid_json_lines(self):
        from s3_import.ingestor.handler import _parse_jsonl
        raw = b'{"text": "Good"}\n{bad json}\n{"text": "Also good"}\n'
        items = list(_parse_jsonl(_stream(raw), "S3 - test"))
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

    def test_handles_invalid_json(self):
        from s3_import.ingestor.handler import _parse_json
        items = list(_parse_json(_stream(b"not json"), "S3 - test"))
        assert len(items) == 0

    def test_resolves_field_aliases(self):
        from s3_import.ingestor.handler import _parse_json
        data = _json_bytes([{"review": "Alias text", "score": 4, "reviewer": "Bob"}])
        items = list(_parse_json(_stream(data), "S3 - test"))
        assert items[0]["text"] == "Alias text"
        assert items[0]["rating"] == 4.0
        assert items[0]["author"] == "Bob"


# ---------------------------------------------------------------------------
# Ingestor / process_file tests
# ---------------------------------------------------------------------------

@pytest.fixture
def ingestor():
    """Create an S3ImportIngestor with mocked AWS dependencies."""
    with (
        patch("_shared.base_ingestor.get_dynamodb_resource") as mock_dynamo,
        patch("_shared.base_ingestor.get_s3_client"),
        patch("_shared.base_ingestor.get_sqs_client"),
        patch("_shared.base_ingestor.get_secret", return_value={}),
    ):
        mock_dynamo.return_value.Table.return_value = MagicMock()
        from s3_import.ingestor.handler import S3ImportIngestor
        ing = S3ImportIngestor()
        ing.normalize_item = lambda item: {**item, "_normalized": True}
        ing.send_to_queue = MagicMock()
        return ing


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

    @patch("s3_import.ingestor.handler.s3_client")
    def test_rejects_oversized_file(self, mock_s3, ingestor):
        mock_s3.head_object.return_value = {"ContentLength": 100 * 1024 * 1024}
        assert ingestor.process_file("bucket", "src/huge.csv") == 0
        mock_s3.get_object.assert_not_called()

    @patch("s3_import.ingestor.handler.s3_client")
    def test_rejects_empty_file(self, mock_s3, ingestor):
        mock_s3.head_object.return_value = {"ContentLength": 0}
        assert ingestor.process_file("bucket", "src/empty.csv") == 0

    @patch("s3_import.ingestor.handler.s3_client")
    def test_returns_zero_for_unsupported_extension(self, mock_s3, ingestor):
        assert ingestor.process_file("bucket", "src/data.txt") == 0
        mock_s3.head_object.assert_not_called()

    @patch("s3_import.ingestor.handler.s3_client")
    def test_batches_large_files(self, mock_s3, ingestor):
        rows = [f"{i},Review {i},3" for i in range(250)]
        csv_data = _csv_bytes("id,text,rating", *rows)
        mock_s3.head_object.return_value = {"ContentLength": len(csv_data)}
        mock_s3.get_object.return_value = {"Body": _stream(csv_data)}

        assert ingestor.process_file("bucket", "src/big.csv") == 250
        assert ingestor.send_to_queue.call_count == 3  # 100 + 100 + 50


# ---------------------------------------------------------------------------
# lambda_handler tests
# ---------------------------------------------------------------------------

class TestLambdaHandler:
    @patch("s3_import.ingestor.handler.S3ImportIngestor")
    def test_handles_s3_event(self, MockIngestor, lambda_context):
        from s3_import.ingestor.handler import lambda_handler
        mock_inst = MagicMock()
        mock_inst.process_file.return_value = 5
        MockIngestor.return_value = mock_inst

        result = lambda_handler(_make_s3_event("bucket", "src/data.csv"), lambda_context)

        assert result["status"] == "success"
        assert result["files_processed"] == 1
        assert result["items_processed"] == 5
        mock_inst.process_file.assert_called_once_with("bucket", "src/data.csv")

    @patch("s3_import.ingestor.handler.S3ImportIngestor")
    def test_handles_multiple_records(self, MockIngestor, lambda_context):
        from s3_import.ingestor.handler import lambda_handler
        mock_inst = MagicMock()
        mock_inst.process_file.side_effect = [3, 7]
        MockIngestor.return_value = mock_inst

        event = {"Records": [
            {"eventSource": "aws:s3", "s3": {"bucket": {"name": "b"}, "object": {"key": "a.csv"}}},
            {"eventSource": "aws:s3", "s3": {"bucket": {"name": "b"}, "object": {"key": "b.json"}}},
        ]}
        result = lambda_handler(event, lambda_context)

        assert result["files_processed"] == 2
        assert result["items_processed"] == 10

    @patch("s3_import.ingestor.handler.S3ImportIngestor")
    def test_decodes_url_encoded_keys(self, MockIngestor, lambda_context):
        from s3_import.ingestor.handler import lambda_handler
        mock_inst = MagicMock()
        mock_inst.process_file.return_value = 1
        MockIngestor.return_value = mock_inst

        lambda_handler(_make_s3_event("bucket", "my+folder/my+file.csv"), lambda_context)
        mock_inst.process_file.assert_called_once_with("bucket", "my folder/my file.csv")

    def test_skips_when_no_records(self, lambda_context):
        from s3_import.ingestor.handler import lambda_handler
        result = lambda_handler({}, lambda_context)
        assert result["status"] == "skipped"
