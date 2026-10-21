"""
Tests for S3 Import Ingestor handler.

Covers: field alias resolution, deterministic IDs, CSV/JSON/JSONL parsing,
file size validation, batched SQS sending, and lambda_handler entry point.
"""

import io
import json
import pytest
from unittest.mock import patch, MagicMock

from _shared.test.scoped_secret import scoped_secret


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
    def test_normalizes_folder_name_to_valid_source_platform(self):
        # The folder becomes a source_platform-valid slug, not the old
        # "S3 - surveys" (which carried a space, dash and uppercase and was
        # rejected at message validation — the latent bug this cleans up).
        from s3_import.ingestor.handler import _get_source_from_key
        assert _get_source_from_key("surveys/data.csv") == "surveys"

    def test_normalizes_a_messy_folder_name(self):
        from s3_import.ingestor.handler import _get_source_from_key
        assert _get_source_from_key("Q1 Survey Results/data.csv") == "q1_survey_results"

    def test_returns_default_for_root_file(self):
        from s3_import.ingestor.handler import _get_source_from_key
        assert _get_source_from_key("data.csv") == "s3_import"


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

    def test_sets_source_platform_override_to_file_source_by_default(self):
        # With no source_field, the file-level source passes through unchanged
        # (it is already a valid slug from _get_source_from_key).
        from s3_import.ingestor.handler import _normalize_row
        result = _normalize_row({"text": "Hello"}, "surveys")
        assert result["source_platform_override"] == "surveys"

    def test_per_row_source_field_overrides_file_source(self):
        # Phase 3: a named column drives each row's source, normalized to the
        # source_platform contract — this is what lets one file carry several
        # distinct, filterable sources.
        from s3_import.ingestor.handler import _normalize_row
        result = _normalize_row(
            {"text": "Hello", "platform": "Trustpilot Reviews"}, "surveys",
            source_field="platform",
        )
        assert result["source_platform_override"] == "trustpilot_reviews"

    def test_per_row_source_falls_back_to_file_source_when_cell_blank(self):
        from s3_import.ingestor.handler import _normalize_row
        result = _normalize_row(
            {"text": "Hello", "platform": ""}, "surveys", source_field="platform",
        )
        assert result["source_platform_override"] == "surveys"

    def test_per_row_source_falls_back_when_field_absent_from_row(self):
        from s3_import.ingestor.handler import _normalize_row
        result = _normalize_row(
            {"text": "Hello"}, "surveys", source_field="platform",
        )
        assert result["source_platform_override"] == "surveys"

    def test_carries_metadata_object_through(self):
        # Regression: a bulk JSON record's `metadata` map must survive
        # normalization so the processor can persist it as custom_fields (the
        # admin-pickable import filters). It was dropped here before.
        from s3_import.ingestor.handler import _normalize_row
        result = _normalize_row(
            {"text": "Hello", "metadata": {"tier_status": "Diamond", "nps": "9"}},
            "surveys",
        )
        assert result["metadata"] == {"tier_status": "Diamond", "nps": "9"}

    def test_omits_metadata_key_when_absent(self):
        from s3_import.ingestor.handler import _normalize_row
        result = _normalize_row({"text": "Hello"}, "surveys")
        assert "metadata" not in result

    def test_omits_metadata_key_when_empty_dict(self):
        from s3_import.ingestor.handler import _normalize_row
        result = _normalize_row({"text": "Hello", "metadata": {}}, "surveys")
        assert "metadata" not in result

    def test_ignores_non_dict_metadata(self):
        # A non-object `metadata` (e.g. a stray string) must not be forwarded —
        # MessageMetadata expects a flat object, and a non-dict would be noise.
        from s3_import.ingestor.handler import _normalize_row
        result = _normalize_row({"text": "Hello", "metadata": "oops"}, "surveys")
        assert "metadata" not in result


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

    def test_unwraps_items_envelope(self):
        # The documented upload format: records under an "items" key, alongside
        # arbitrary provenance keys. Must parse the records, not treat the whole
        # wrapper as one textless row (which yielded 0 items for a real export).
        from s3_import.ingestor.handler import _parse_json
        data = _json_bytes({
            "_source_notes": {"dataset": "August survey", "source_rows": 52353},
            "items": [{"text": "First"}, {"text": "Second"}],
        })
        items = list(_parse_json(_stream(data), "S3 - test"))
        assert len(items) == 2
        assert items[0]["text"] == "First"
        assert items[1]["text"] == "Second"

    def test_single_object_with_text_is_not_mistaken_for_envelope(self):
        # A plain record with no "items" key is still one row.
        from s3_import.ingestor.handler import _parse_json
        data = _json_bytes({"text": "Solo", "rating": 5})
        items = list(_parse_json(_stream(data), "S3 - test"))
        assert len(items) == 1
        assert items[0]["text"] == "Solo"

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
        patch("_shared.base_ingestor.get_secret", return_value=scoped_secret()),
    ):
        mock_dynamo.return_value.Table.return_value = MagicMock()
        from s3_import.ingestor.handler import S3ImportIngestor
        ing = S3ImportIngestor()
        ing.normalize_item = lambda item: {**item, "_normalized": True}
        # Mirror the real contract: send_to_queue returns the number of items SQS
        # confirmed, and raises rather than losing any.  A bare MagicMock() would
        # return a MagicMock, so process_file's count would silently stop being a
        # number and every assertion on it would be vacuous.
        ing.send_to_queue = MagicMock(side_effect=lambda batch: len(batch))
        return ing


class TestSplitFile:
    """The splitter: read once, count rows, fan out one chunk invocation per range."""

    @patch("s3_import.ingestor.handler.lambda_client")
    @patch("s3_import.ingestor.handler.s3_client")
    def test_dispatches_one_chunk_for_a_small_file(self, mock_s3, mock_lambda, ingestor):
        csv_data = _csv_bytes("id,text,rating", "1,Great,5", "2,Bad,1", "3,Ok,3")
        mock_s3.head_object.return_value = {"ContentLength": len(csv_data)}
        mock_s3.get_object.return_value = {"Body": _stream(csv_data)}

        assert ingestor.split_file("bucket", "surveys/data.csv") == 1
        mock_lambda.invoke.assert_called_once()
        _, kwargs = mock_lambda.invoke.call_args
        assert kwargs["InvocationType"] == "Event"
        payload = json.loads(kwargs["Payload"])
        assert payload["chunk"]["start"] == 0
        assert payload["chunk"]["end"] == 3
        assert payload["chunk"]["key"] == "surveys/data.csv"

    @patch("s3_import.ingestor.handler.CHUNK_SIZE", 100)
    @patch("s3_import.ingestor.handler.lambda_client")
    @patch("s3_import.ingestor.handler.s3_client")
    def test_fans_out_one_invocation_per_chunk_range(self, mock_s3, mock_lambda, ingestor):
        rows = [f"{i},Review {i},3" for i in range(250)]
        csv_data = _csv_bytes("id,text,rating", *rows)
        mock_s3.head_object.return_value = {"ContentLength": len(csv_data)}
        # get_object is called once to count; islice is not used by the splitter.
        mock_s3.get_object.return_value = {"Body": _stream(csv_data)}

        assert ingestor.split_file("bucket", "src/big.csv") == 3  # 100 + 100 + 50
        assert mock_lambda.invoke.call_count == 3
        ranges = [
            tuple(json.loads(c.kwargs["Payload"])["chunk"][k] for k in ("start", "end"))
            for c in mock_lambda.invoke.call_args_list
        ]
        assert ranges == [(0, 100), (100, 200), (200, 250)]

    @patch("s3_import.ingestor.handler.lambda_client")
    @patch("s3_import.ingestor.handler.s3_client")
    def test_rejects_oversized_file(self, mock_s3, mock_lambda, ingestor):
        from s3_import.ingestor.handler import MAX_FILE_SIZE_BYTES
        mock_s3.head_object.return_value = {"ContentLength": MAX_FILE_SIZE_BYTES + 1}
        assert ingestor.split_file("bucket", "src/huge.csv") == 0
        mock_s3.get_object.assert_not_called()
        mock_lambda.invoke.assert_not_called()

    @patch("s3_import.ingestor.handler.lambda_client")
    @patch("s3_import.ingestor.handler.s3_client")
    def test_rejects_empty_file(self, mock_s3, mock_lambda, ingestor):
        mock_s3.head_object.return_value = {"ContentLength": 0}
        assert ingestor.split_file("bucket", "src/empty.csv") == 0
        mock_lambda.invoke.assert_not_called()

    @patch("s3_import.ingestor.handler.lambda_client")
    @patch("s3_import.ingestor.handler.s3_client")
    def test_returns_zero_for_unsupported_extension(self, mock_s3, mock_lambda, ingestor):
        assert ingestor.split_file("bucket", "src/data.txt") == 0
        mock_s3.head_object.assert_not_called()
        mock_lambda.invoke.assert_not_called()

    @patch("s3_import.ingestor.handler.lambda_client")
    @patch("s3_import.ingestor.handler.s3_client")
    def test_dispatches_nothing_when_no_rows_parse(self, mock_s3, mock_lambda, ingestor):
        # Rows present but none have text → zero parseable rows → no fan-out.
        csv_data = _csv_bytes("id,rating", "1,5", "2,1")
        mock_s3.head_object.return_value = {"ContentLength": len(csv_data)}
        mock_s3.get_object.return_value = {"Body": _stream(csv_data)}
        assert ingestor.split_file("bucket", "src/notext.csv") == 0
        mock_lambda.invoke.assert_not_called()

    @patch("s3_import.ingestor.handler.MAX_CHUNKS", 2)
    @patch("s3_import.ingestor.handler.CHUNK_SIZE", 100)
    @patch("s3_import.ingestor.handler.lambda_client")
    @patch("s3_import.ingestor.handler.s3_client")
    def test_refuses_to_fan_out_past_the_chunk_cap(self, mock_s3, mock_lambda, ingestor):
        rows = [f"{i},Review {i},3" for i in range(250)]  # 3 chunks > cap of 2
        csv_data = _csv_bytes("id,text,rating", *rows)
        mock_s3.head_object.return_value = {"ContentLength": len(csv_data)}
        mock_s3.get_object.return_value = {"Body": _stream(csv_data)}
        assert ingestor.split_file("bucket", "src/toobig.csv") == 0
        mock_lambda.invoke.assert_not_called()


class TestProcessChunk:
    """The chunk worker: process only rows [start, end), parallel raw writes."""

    @patch("s3_import.ingestor.handler.s3_client")
    def test_processes_only_the_requested_range(self, mock_s3, ingestor):
        rows = [f"{i},Review {i},3" for i in range(10)]
        csv_data = _csv_bytes("id,text,rating", *rows)
        mock_s3.get_object.return_value = {"Body": _stream(csv_data)}

        # Rows 2..5 (3 items) of the parsed sequence.
        assert ingestor.process_chunk("bucket", "src/data.csv", None, 2, 5) == 3
        # One batch (3 < 100) → one send_to_queue of exactly those 3 items.
        ingestor.send_to_queue.assert_called_once()
        sent = ingestor.send_to_queue.call_args.args[0]
        assert [item["id"] for item in sent] == ["2", "3", "4"]

    @patch("s3_import.ingestor.handler.s3_client")
    def test_batches_within_a_chunk(self, mock_s3, ingestor):
        rows = [f"{i},Review {i},3" for i in range(250)]
        csv_data = _csv_bytes("id,text,rating", *rows)
        mock_s3.get_object.return_value = {"Body": _stream(csv_data)}

        # A 250-row range queues in batches of 100.
        assert ingestor.process_chunk("bucket", "src/data.csv", None, 0, 250) == 250
        assert ingestor.send_to_queue.call_count == 3  # 100 + 100 + 50

    @patch("s3_import.ingestor.handler.metrics")
    @patch("s3_import.ingestor.handler.s3_client")
    def test_reports_what_landed_when_a_later_batch_is_rejected(
        self, mock_s3, mock_metrics, ingestor
    ):
        # Inherits the raising contract: a rejected batch fails the chunk but the
        # items already enqueued are still reported to CloudWatch.
        rows = [f"{i},Review {i},3" for i in range(250)]
        csv_data = _csv_bytes("id,text,rating", *rows)
        mock_s3.get_object.return_value = {"Body": _stream(csv_data)}
        ingestor.send_to_queue = MagicMock(
            side_effect=[100, 100, RuntimeError("50 ingestor item(s) rejected")]
        )

        with pytest.raises(RuntimeError):
            ingestor.process_chunk("bucket", "src/data.csv", None, 0, 250)

        mock_metrics.add_metric.assert_called_once_with(
            name="ItemsImported", unit="Count", value=200
        )


# ---------------------------------------------------------------------------
# lambda_handler tests
# ---------------------------------------------------------------------------

class TestLambdaHandler:
    @patch("s3_import.ingestor.handler.S3ImportIngestor")
    def test_s3_event_runs_the_splitter(self, MockIngestor, lambda_context):
        from s3_import.ingestor.handler import lambda_handler
        mock_inst = MagicMock()
        mock_inst.split_file.return_value = 4
        MockIngestor.return_value = mock_inst

        result = lambda_handler(_make_s3_event("bucket", "src/data.csv"), lambda_context)

        assert result["status"] == "success"
        assert result["mode"] == "split"
        assert result["files_processed"] == 1
        mock_inst.split_file.assert_called_once_with("bucket", "src/data.csv")
        mock_inst.process_chunk.assert_not_called()

    @patch("s3_import.ingestor.handler.S3ImportIngestor")
    def test_chunk_event_runs_the_worker(self, MockIngestor, lambda_context):
        from s3_import.ingestor.handler import lambda_handler
        mock_inst = MagicMock()
        mock_inst.process_chunk.return_value = 2000
        MockIngestor.return_value = mock_inst

        event = {"chunk": {
            "bucket": "b", "key": "src/data.json", "source_field": "platform",
            "start": 0, "end": 2000,
        }}
        result = lambda_handler(event, lambda_context)

        assert result["mode"] == "chunk"
        assert result["items_processed"] == 2000
        mock_inst.process_chunk.assert_called_once_with("b", "src/data.json", "platform", 0, 2000)
        mock_inst.split_file.assert_not_called()

    @patch("s3_import.ingestor.handler.S3ImportIngestor")
    def test_decodes_url_encoded_keys(self, MockIngestor, lambda_context):
        from s3_import.ingestor.handler import lambda_handler
        mock_inst = MagicMock()
        mock_inst.split_file.return_value = 1
        MockIngestor.return_value = mock_inst

        lambda_handler(_make_s3_event("bucket", "my+folder/my+file.csv"), lambda_context)
        mock_inst.split_file.assert_called_once_with("bucket", "my folder/my file.csv")

    def test_skips_when_no_records(self, lambda_context):
        from s3_import.ingestor.handler import lambda_handler
        result = lambda_handler({}, lambda_context)
        assert result["status"] == "skipped"
