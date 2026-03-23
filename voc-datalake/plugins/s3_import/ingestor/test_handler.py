"""
Tests for S3 Import Ingestor handler.

Covers: file size validation, streaming parsing, batched SQS sending,
row-level error handling, deterministic IDs, field alias resolution,
CSV header validation, distributed locking, error folder handling,
multi-record S3 event processing, and scheduled scan.
"""

import io
import json
import pytest
from unittest.mock import patch, MagicMock, call
from botocore.exceptions import ClientError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_s3_event(bucket: str, key: str) -> dict:
    """Build a minimal S3 event notification payload."""
    return {
        "Records": [
            {
                "eventSource": "aws:s3",
                "s3": {
                    "bucket": {"name": bucket},
                    "object": {"key": key},
                },
            }
        ]
    }


def _make_multi_record_s3_event(bucket: str, keys: list[str]) -> dict:
    """Build an S3 event with multiple records."""
    return {
        "Records": [
            {
                "eventSource": "aws:s3",
                "s3": {
                    "bucket": {"name": bucket},
                    "object": {"key": k},
                },
            }
            for k in keys
        ]
    }


def _csv_bytes(header: str, *rows: str) -> bytes:
    """Build CSV content as bytes from header + rows."""
    lines = [header] + list(rows)
    return "\n".join(lines).encode("utf-8")


def _json_bytes(data) -> bytes:
    return json.dumps(data).encode("utf-8")


def _jsonl_bytes(*objects) -> bytes:
    return "\n".join(json.dumps(o) for o in objects).encode("utf-8")


def _stream(data: bytes):
    """Return a BytesIO stream that behaves like S3 Body."""
    return io.BytesIO(data)


@pytest.fixture
def lambda_context():
    """Create a mock Lambda context."""
    context = MagicMock()
    context.function_name = "test-s3-import"
    context.memory_limit_in_mb = 512
    context.invoked_function_arn = "arn:aws:lambda:us-east-1:123456789:function:test"
    context.aws_request_id = "test-request-id"
    return context


# ---------------------------------------------------------------------------
# Module-level helper tests
# ---------------------------------------------------------------------------

class TestResolveField:
    """Tests for _resolve_field helper."""

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
    """Tests for _generate_deterministic_id helper."""

    def test_produces_consistent_ids(self):
        from s3_import.ingestor.handler import _generate_deterministic_id
        id1 = _generate_deterministic_id("same text")
        id2 = _generate_deterministic_id("same text")
        assert id1 == id2

    def test_different_text_produces_different_ids(self):
        from s3_import.ingestor.handler import _generate_deterministic_id
        id1 = _generate_deterministic_id("text A")
        id2 = _generate_deterministic_id("text B")
        assert id1 != id2

    def test_starts_with_s3_prefix(self):
        from s3_import.ingestor.handler import _generate_deterministic_id
        assert _generate_deterministic_id("hello").startswith("s3-")

    def test_handles_empty_text(self):
        from s3_import.ingestor.handler import _generate_deterministic_id
        result = _generate_deterministic_id("")
        assert result.startswith("s3-")
        assert len(result) > 3


# ---------------------------------------------------------------------------
# Ingestor class tests — each class patches BaseIngestor.__init__ so we
# don't need real AWS resources.
# ---------------------------------------------------------------------------

@pytest.fixture
def ingestor():
    """Create an S3ImportIngestor with mocked AWS dependencies."""
    with (
        patch("_shared.base_ingestor.get_dynamodb_resource") as mock_dynamo,
        patch("_shared.base_ingestor.get_s3_client"),
        patch("_shared.base_ingestor.get_sqs_client"),
        patch("_shared.base_ingestor.get_secret", return_value={"processed_prefix": "processed/"}),
    ):
        mock_dynamo.return_value.Table.return_value = MagicMock()

        from s3_import.ingestor.handler import S3ImportIngestor
        ing = S3ImportIngestor(bucket="test-bucket", key="source/data.csv")
        # Override normalize_item to pass through without real S3 writes
        ing.normalize_item = lambda item: {**item, "_normalized": True}
        ing.send_to_queue = MagicMock()
        return ing


class TestGetSourceFromKey:
    """Tests for _get_source_from_key."""

    def test_extracts_folder_name(self, ingestor):
        assert ingestor._get_source_from_key("surveys/data.csv") == "S3 - surveys"

    def test_returns_default_for_root_file(self, ingestor):
        assert ingestor._get_source_from_key("data.csv") == "S3 - Import"

    def test_ignores_processed_prefix(self, ingestor):
        assert ingestor._get_source_from_key("processed/old.csv") == "S3 - Import"


class TestValidateCsvHeaders:
    """Tests for _validate_csv_headers."""

    def test_accepts_canonical_text_column(self, ingestor):
        valid, _ = ingestor._validate_csv_headers(["id", "text", "rating"])
        assert valid is True

    def test_accepts_alias_column(self, ingestor):
        valid, _ = ingestor._validate_csv_headers(["id", "comment", "score"])
        assert valid is True

    def test_rejects_missing_text_column(self, ingestor):
        valid, msg = ingestor._validate_csv_headers(["id", "score", "date"])
        assert valid is False
        assert "missing" in msg.lower()

    def test_rejects_none_fieldnames(self, ingestor):
        valid, msg = ingestor._validate_csv_headers(None)
        assert valid is False

    def test_rejects_empty_fieldnames(self, ingestor):
        valid, msg = ingestor._validate_csv_headers([])
        assert valid is False

    def test_case_insensitive_matching(self, ingestor):
        valid, _ = ingestor._validate_csv_headers(["ID", "TEXT", "Rating"])
        assert valid is True


class TestParseCsvStream:
    """Tests for _parse_csv_stream with streaming."""

    def test_parses_valid_csv(self, ingestor):
        data = _csv_bytes(
            "id,text,rating",
            "1,Great product,5",
            "2,Poor service,1",
        )
        items = list(ingestor._parse_csv_stream(_stream(data), "S3 - test"))
        assert len(items) == 2
        assert items[0]["text"] == "Great product"
        assert items[1]["rating"] == 1.0

    def test_resolves_alias_columns(self, ingestor):
        data = _csv_bytes(
            "review_id,comment,score,date",
            "r1,Nice product,4,2025-06-01",
        )
        items = list(ingestor._parse_csv_stream(_stream(data), "S3 - test"))
        assert len(items) == 1
        assert items[0]["text"] == "Nice product"
        assert items[0]["id"] == "r1"
        assert items[0]["rating"] == 4.0
        assert items[0]["created_at"] == "2025-06-01"

    def test_skips_rows_with_empty_text(self, ingestor):
        data = _csv_bytes(
            "id,text,rating",
            "1,,5",
            "2,Valid review,3",
        )
        items = list(ingestor._parse_csv_stream(_stream(data), "S3 - test"))
        assert len(items) == 1
        assert items[0]["id"] == "2"

    def test_rejects_csv_without_text_column(self, ingestor):
        data = _csv_bytes(
            "id,score,date",
            "1,5,2025-01-01",
        )
        items = list(ingestor._parse_csv_stream(_stream(data), "S3 - test"))
        assert len(items) == 0

    def test_generates_deterministic_id_when_missing(self, ingestor):
        data = _csv_bytes(
            "text,rating",
            "No id here,3",
        )
        items = list(ingestor._parse_csv_stream(_stream(data), "S3 - test"))
        assert len(items) == 1
        assert items[0]["id"].startswith("s3-")

    def test_survives_malformed_row(self, ingestor):
        """A row that causes an exception should be skipped, not crash the file."""
        data = _csv_bytes(
            "text,rating",
            "Good review,5",
            "Bad review,not_a_number",
            "Another good one,3",
        )
        items = list(ingestor._parse_csv_stream(_stream(data), "S3 - test"))
        # All 3 should parse — rating parse failure returns None, doesn't raise
        assert len(items) == 3


class TestParseJsonlStream:
    """Tests for _parse_jsonl_stream."""

    def test_parses_valid_jsonl(self, ingestor):
        data = _jsonl_bytes(
            {"text": "Review 1", "rating": 5},
            {"text": "Review 2", "rating": 3},
        )
        items = list(ingestor._parse_jsonl_stream(_stream(data), "S3 - test"))
        assert len(items) == 2

    def test_skips_invalid_json_lines(self, ingestor):
        raw = b'{"text": "Good"}\n{bad json}\n{"text": "Also good"}\n'
        items = list(ingestor._parse_jsonl_stream(_stream(raw), "S3 - test"))
        assert len(items) == 2

    def test_skips_empty_lines(self, ingestor):
        raw = b'{"text": "One"}\n\n\n{"text": "Two"}\n'
        items = list(ingestor._parse_jsonl_stream(_stream(raw), "S3 - test"))
        assert len(items) == 2

    def test_skips_items_with_empty_text(self, ingestor):
        data = _jsonl_bytes(
            {"text": ""},
            {"text": "Valid"},
        )
        items = list(ingestor._parse_jsonl_stream(_stream(data), "S3 - test"))
        assert len(items) == 1


class TestParseJsonContent:
    """Tests for _parse_json_content (array and single object)."""

    def test_parses_json_array(self, ingestor):
        data = _json_bytes([
            {"text": "Review A"},
            {"text": "Review B"},
        ])
        items = list(ingestor._parse_json_content(_stream(data), "S3 - test"))
        assert len(items) == 2

    def test_parses_single_json_object(self, ingestor):
        data = _json_bytes({"text": "Solo review"})
        items = list(ingestor._parse_json_content(_stream(data), "S3 - test"))
        assert len(items) == 1

    def test_handles_invalid_json(self, ingestor):
        items = list(ingestor._parse_json_content(_stream(b"not json"), "S3 - test"))
        assert len(items) == 0

    def test_resolves_field_aliases(self, ingestor):
        data = _json_bytes([{"review": "Alias text", "score": 4, "reviewer": "Bob"}])
        items = list(ingestor._parse_json_content(_stream(data), "S3 - test"))
        assert items[0]["text"] == "Alias text"
        assert items[0]["rating"] == 4.0
        assert items[0]["author"] == "Bob"


class TestParseRating:
    """Tests for _parse_rating."""

    def test_parses_int(self, ingestor):
        assert ingestor._parse_rating(5) == 5.0

    def test_parses_float(self, ingestor):
        assert ingestor._parse_rating(3.5) == 3.5

    def test_parses_string_number(self, ingestor):
        assert ingestor._parse_rating("4") == 4.0

    def test_returns_none_for_none(self, ingestor):
        assert ingestor._parse_rating(None) is None

    def test_returns_none_for_empty_string(self, ingestor):
        assert ingestor._parse_rating("") is None

    def test_returns_none_for_non_numeric(self, ingestor):
        assert ingestor._parse_rating("excellent") is None


# ---------------------------------------------------------------------------
# _process_file tests
# ---------------------------------------------------------------------------

class TestProcessFile:
    """Tests for _process_file — the core orchestration method."""

    @patch("s3_import.ingestor.handler.s3_client")
    def test_skips_already_processed_files(self, mock_s3, ingestor):
        assert ingestor._process_file("bucket", "processed/old.csv") == 0
        mock_s3.head_object.assert_not_called()

    @patch("s3_import.ingestor.handler.s3_client")
    def test_skips_error_folder_files(self, mock_s3, ingestor):
        assert ingestor._process_file("bucket", "error/bad.csv") == 0

    @patch("s3_import.ingestor.handler.s3_client")
    def test_rejects_file_exceeding_size_limit(self, mock_s3, ingestor):
        mock_s3.head_object.return_value = {"ContentLength": 100 * 1024 * 1024}
        mock_s3.copy_object.return_value = {}
        mock_s3.delete_object.return_value = {}

        result = ingestor._process_file("bucket", "source/huge.csv")

        assert result == 0
        # File should be moved to error/
        mock_s3.copy_object.assert_called_once()
        copy_args = mock_s3.copy_object.call_args
        assert copy_args.kwargs["Key"].startswith("error/")

    @patch("s3_import.ingestor.handler.s3_client")
    def test_rejects_empty_file(self, mock_s3, ingestor):
        mock_s3.head_object.return_value = {"ContentLength": 0}
        mock_s3.copy_object.return_value = {}
        mock_s3.delete_object.return_value = {}

        result = ingestor._process_file("bucket", "source/empty.csv")

        assert result == 0
        copy_args = mock_s3.copy_object.call_args
        assert copy_args.kwargs["Key"].startswith("error/")

    @patch("s3_import.ingestor.handler.s3_client")
    def test_processes_csv_end_to_end(self, mock_s3, ingestor):
        csv_data = _csv_bytes(
            "id,text,rating",
            "1,Great product,5",
            "2,Bad service,1",
            "3,Average,3",
        )
        mock_s3.head_object.return_value = {"ContentLength": len(csv_data)}
        mock_s3.get_object.return_value = {"Body": _stream(csv_data)}
        mock_s3.copy_object.return_value = {}
        mock_s3.delete_object.return_value = {}

        result = ingestor._process_file("bucket", "surveys/data.csv")

        assert result == 3
        ingestor.send_to_queue.assert_called_once()
        # File moved to processed/
        copy_args = mock_s3.copy_object.call_args
        assert copy_args.kwargs["Key"].startswith("processed/")

    @patch("s3_import.ingestor.handler.s3_client")
    def test_processes_json_end_to_end(self, mock_s3, ingestor):
        json_data = _json_bytes([
            {"text": "JSON review 1"},
            {"text": "JSON review 2"},
        ])
        mock_s3.head_object.return_value = {"ContentLength": len(json_data)}
        mock_s3.get_object.return_value = {"Body": _stream(json_data)}
        mock_s3.copy_object.return_value = {}
        mock_s3.delete_object.return_value = {}

        result = ingestor._process_file("bucket", "source/data.json")

        assert result == 2

    @patch("s3_import.ingestor.handler.s3_client")
    def test_processes_jsonl_end_to_end(self, mock_s3, ingestor):
        jsonl_data = _jsonl_bytes(
            {"text": "Line 1"},
            {"text": "Line 2"},
            {"text": "Line 3"},
        )
        mock_s3.head_object.return_value = {"ContentLength": len(jsonl_data)}
        mock_s3.get_object.return_value = {"Body": _stream(jsonl_data)}
        mock_s3.copy_object.return_value = {}
        mock_s3.delete_object.return_value = {}

        result = ingestor._process_file("bucket", "source/data.jsonl")

        assert result == 3

    @patch("s3_import.ingestor.handler.s3_client")
    def test_batches_large_files(self, mock_s3, ingestor):
        """Items should be sent in batches of BATCH_SIZE, not all at once."""
        rows = [f"{i},Review number {i},3" for i in range(250)]
        csv_data = _csv_bytes("id,text,rating", *rows)

        mock_s3.head_object.return_value = {"ContentLength": len(csv_data)}
        mock_s3.get_object.return_value = {"Body": _stream(csv_data)}
        mock_s3.copy_object.return_value = {}
        mock_s3.delete_object.return_value = {}

        result = ingestor._process_file("bucket", "source/big.csv")

        assert result == 250
        # 250 items / 100 batch size = 3 calls (100 + 100 + 50)
        assert ingestor.send_to_queue.call_count == 3

    @patch("s3_import.ingestor.handler.s3_client")
    def test_does_not_move_file_on_processing_error(self, mock_s3, ingestor):
        """If get_object fails, file should NOT be moved to processed/."""
        mock_s3.head_object.return_value = {"ContentLength": 100}
        mock_s3.get_object.side_effect = Exception("S3 read error")

        result = ingestor._process_file("bucket", "source/fail.csv")

        assert result == 0
        mock_s3.copy_object.assert_not_called()

    @patch("s3_import.ingestor.handler.s3_client")
    def test_returns_zero_for_unsupported_extension(self, mock_s3, ingestor):
        mock_s3.head_object.return_value = {"ContentLength": 100}
        mock_s3.get_object.return_value = {"Body": _stream(b"data")}

        result = ingestor._process_file("bucket", "source/data.txt")

        assert result == 0


# ---------------------------------------------------------------------------
# Distributed locking tests
# ---------------------------------------------------------------------------

class TestFileLocking:
    """Tests for _acquire_file_lock / _release_file_lock."""

    def test_acquire_lock_succeeds(self, ingestor):
        ingestor.watermarks_table.put_item.return_value = {}
        assert ingestor._acquire_file_lock("bucket", "key.csv") is True

    def test_acquire_lock_fails_when_already_held(self, ingestor):
        error_response = {"Error": {"Code": "ConditionalCheckFailedException"}}
        ingestor.watermarks_table.put_item.side_effect = ClientError(
            error_response, "PutItem"
        )
        assert ingestor._acquire_file_lock("bucket", "key.csv") is False

    def test_acquire_lock_allows_on_other_errors(self, ingestor):
        """Non-conditional-check errors should not block processing."""
        ingestor.watermarks_table.put_item.side_effect = Exception("Network error")
        assert ingestor._acquire_file_lock("bucket", "key.csv") is True

    def test_release_lock_deletes_item(self, ingestor):
        ingestor._release_file_lock("bucket", "key.csv")
        ingestor.watermarks_table.delete_item.assert_called_once_with(
            Key={"source": "s3_import_lock#bucket#key.csv"}
        )

    @patch("s3_import.ingestor.handler.s3_client")
    def test_skips_file_when_lock_held(self, mock_s3, ingestor):
        """_process_file should return 0 if lock cannot be acquired."""
        error_response = {"Error": {"Code": "ConditionalCheckFailedException"}}
        ingestor.watermarks_table.put_item.side_effect = ClientError(
            error_response, "PutItem"
        )

        result = ingestor._process_file("bucket", "source/data.csv")

        assert result == 0
        mock_s3.head_object.assert_not_called()

    @patch("s3_import.ingestor.handler.s3_client")
    def test_lock_released_after_success(self, mock_s3, ingestor):
        csv_data = _csv_bytes("text", "Review")
        mock_s3.head_object.return_value = {"ContentLength": len(csv_data)}
        mock_s3.get_object.return_value = {"Body": _stream(csv_data)}
        mock_s3.copy_object.return_value = {}
        mock_s3.delete_object.return_value = {}

        ingestor._process_file("bucket", "source/data.csv")

        ingestor.watermarks_table.delete_item.assert_called_once()

    @patch("s3_import.ingestor.handler.s3_client")
    def test_lock_released_after_failure(self, mock_s3, ingestor):
        mock_s3.head_object.side_effect = Exception("boom")

        ingestor._process_file("bucket", "source/data.csv")

        ingestor.watermarks_table.delete_item.assert_called_once()


# ---------------------------------------------------------------------------
# lambda_handler tests
# ---------------------------------------------------------------------------

class TestLambdaHandler:
    """Tests for the lambda_handler entry point."""

    @patch("s3_import.ingestor.handler.S3ImportIngestor")
    def test_handles_single_s3_event(self, MockIngestor, lambda_context):
        from s3_import.ingestor.handler import lambda_handler

        mock_instance = MagicMock()
        mock_instance.run_for_event.return_value = {
            "status": "success",
            "items_processed": 5,
            "file": "source/data.csv",
        }
        MockIngestor.return_value = mock_instance

        event = _make_s3_event("my-bucket", "source/data.csv")
        result = lambda_handler(event, lambda_context)

        assert result["status"] == "success"
        assert result["files_processed"] == 1
        assert result["items_processed"] == 5
        mock_instance.run_for_event.assert_called_once_with("my-bucket", "source/data.csv")

    @patch("s3_import.ingestor.handler.S3ImportIngestor")
    def test_handles_multiple_s3_records(self, MockIngestor, lambda_context):
        from s3_import.ingestor.handler import lambda_handler

        mock_instance = MagicMock()
        mock_instance.run_for_event.side_effect = [
            {"status": "success", "items_processed": 3, "file": "a.csv"},
            {"status": "success", "items_processed": 7, "file": "b.json"},
        ]
        MockIngestor.return_value = mock_instance

        event = _make_multi_record_s3_event("bucket", ["a.csv", "b.json"])
        result = lambda_handler(event, lambda_context)

        assert result["files_processed"] == 2
        assert result["items_processed"] == 10
        assert mock_instance.run_for_event.call_count == 2

    @patch("s3_import.ingestor.handler.S3ImportIngestor")
    def test_handles_url_encoded_keys(self, MockIngestor, lambda_context):
        from s3_import.ingestor.handler import lambda_handler

        mock_instance = MagicMock()
        mock_instance.run_for_event.return_value = {
            "status": "success",
            "items_processed": 1,
            "file": "my folder/my file.csv",
        }
        MockIngestor.return_value = mock_instance

        event = _make_s3_event("bucket", "my+folder/my+file.csv")
        lambda_handler(event, lambda_context)

        mock_instance.run_for_event.assert_called_once_with(
            "bucket", "my folder/my file.csv"
        )

    @patch("s3_import.ingestor.handler.S3ImportIngestor")
    def test_falls_back_to_scheduled_scan(self, MockIngestor, lambda_context):
        from s3_import.ingestor.handler import lambda_handler

        mock_instance = MagicMock()
        mock_instance.run_scheduled.return_value = {
            "status": "success",
            "files_processed": 2,
            "items_processed": 15,
        }
        MockIngestor.return_value = mock_instance

        result = lambda_handler({}, lambda_context)

        assert result["status"] == "success"
        mock_instance.run_scheduled.assert_called_once()


# ---------------------------------------------------------------------------
# Scheduled scan tests
# ---------------------------------------------------------------------------

class TestRunScheduled:
    """Tests for run_scheduled."""

    @patch("s3_import.ingestor.handler.s3_client")
    def test_skips_when_no_bucket(self, mock_s3, ingestor):
        ingestor.import_bucket = ""
        result = ingestor.run_scheduled()
        assert result["status"] == "skipped"

    @patch("s3_import.ingestor.handler.s3_client")
    def test_scans_and_processes_pending_files(self, mock_s3, ingestor):
        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                "Contents": [
                    {"Key": "source/a.csv"},
                    {"Key": "processed/old.csv"},
                    {"Key": "error/bad.csv"},
                    {"Key": "source/b.json"},
                    {"Key": "source/readme.txt"},
                ]
            }
        ]
        mock_s3.get_paginator.return_value = paginator

        # Mock _process_file to return counts without real S3 calls
        ingestor._process_file = MagicMock(side_effect=[3, 2])

        result = ingestor.run_scheduled()

        assert result["files_processed"] == 2
        assert result["items_processed"] == 5
        # Should only process a.csv and b.json
        assert ingestor._process_file.call_count == 2


# ---------------------------------------------------------------------------
# Move-to-error tests
# ---------------------------------------------------------------------------

class TestMoveToError:
    """Tests for _move_to_error."""

    @patch("s3_import.ingestor.handler.s3_client")
    def test_moves_file_to_error_prefix(self, mock_s3, ingestor):
        mock_s3.copy_object.return_value = {}
        mock_s3.delete_object.return_value = {}

        ingestor._move_to_error("bucket", "source/bad.csv", "Too large")

        copy_args = mock_s3.copy_object.call_args
        assert copy_args.kwargs["Key"].startswith("error/source/")
        assert "bad.csv" in copy_args.kwargs["Key"]
        mock_s3.delete_object.assert_called_once()

    @patch("s3_import.ingestor.handler.s3_client")
    def test_handles_move_error_gracefully(self, mock_s3, ingestor):
        mock_s3.copy_object.side_effect = Exception("S3 error")
        # Should not raise
        ingestor._move_to_error("bucket", "source/bad.csv", "reason")
