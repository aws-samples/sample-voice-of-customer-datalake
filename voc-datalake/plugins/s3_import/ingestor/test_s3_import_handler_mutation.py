"""Mutation hardening for `plugins/s3_import/ingestor/handler.py`.

`test_s3_import_handler.py` pins that the three parsers yield the right number
of items, that oversized and empty files are refused, and that batches are
counted by what SQS confirmed. A mutation run left 79 survivors it cannot see:

* every alias in `FIELD_ALIASES` except the few the earlier tests happened to
  use, and the `channel` / `url` output keys — a row carrying only
  ``reviewer`` or ``href`` must still populate ``author`` / ``url``;
* the exact shape of a normalized row: the ``csv_import`` / ``json_import``
  channel defaults, the 200-character hash window and the 16-hex-digit id;
* the ACCEPTED side of the size limit (exactly 52,428,800 bytes imports; one
  byte more is refused) and the batch flush at exactly 100 items (101 rows
  must reach SQS as ``[100, 1]``);
* the wording of every log line an operator reads in CloudWatch — the row and
  line numbers in parse warnings start at 2 and 1 respectively, the
  oversize message states the sizes in MB — and the exact return value of
  ``lambda_handler`` (``reason``, ``file``, ``results``);
* that a non-S3 record is skipped and the following record still processed
  (``continue`` vs ``break``);
* that invalid UTF-8 is replaced rather than fatal;
* that `lambda_handler` is wrapped: context keys reach the logger, the
  ``ColdStart`` metric is flushed as EMF, the tracer registers the handler;
* that the module's S3 client is a real boto3 client.

The run also showed two dead pieces, deleted rather than tested: the
``value is None or value == ""`` guard in `_parse_rating` (``float`` raises
``TypeError`` / ``ValueError`` for both, which the ``except`` already turns
into ``None``) and the ``"import"`` default on `_normalize_row`'s
``default_channel`` (every caller passes one). The oversize log now reads
``MAX_FILE_SIZE_MB`` directly instead of re-deriving it from the byte count,
which printed the same ``50`` for a limit off by one KiB.
"""

import hashlib
import importlib
import io
import json
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest
from aws_lambda_powertools.metrics.provider.cold_start import reset_cold_start_flag

from _shared.test.ingestor_fixtures import offline_ingestor_construction
from s3_import.ingestor import handler
from s3_import.ingestor.handler import (
    FIELD_ALIASES,
    MAX_FILE_SIZE_BYTES,
    MAX_FILE_SIZE_MB,
    _generate_deterministic_id,
    _normalize_row,
    _parse_csv,
    _parse_json,
    _parse_jsonl,
    _parse_rating,
    lambda_handler,
    logger,
    metrics,
    tracer,
)

SOURCE = "S3 - surveys"


def _csv(header: str, *rows: str) -> io.BytesIO:
    return io.BytesIO("\n".join([header, *rows]).encode("utf-8"))


def _jsonl(*objects) -> io.BytesIO:
    return io.BytesIO("\n".join(json.dumps(o) for o in objects).encode("utf-8"))


def _json(data) -> io.BytesIO:
    return io.BytesIO(json.dumps(data).encode("utf-8"))


def _s3_event(*records: tuple[str, str, str]) -> dict:
    return {
        "Records": [
            {"eventSource": source, "s3": {"bucket": {"name": bucket}, "object": {"key": key}}}
            for source, bucket, key in records
        ]
    }


def _context(function_name: str = "voc-s3-import-under-test") -> SimpleNamespace:
    # A plain object, not a MagicMock: Powertools reads `context.lambda_context`
    # whenever that attribute exists, and a MagicMock has every attribute.
    return SimpleNamespace(
        function_name=function_name,
        memory_limit_in_mb=512,
        invoked_function_arn=f"arn:aws:lambda:us-east-1:123456789012:function:{function_name}",
        aws_request_id="req-s3-import-mutation-0001",
        get_remaining_time_in_millis=lambda: 30_000,
    )


def _mark_normalized(item: dict, raw_content: str | None = None) -> dict:
    """A typed stand-in for `BaseIngestor.normalize_item` that only marks the item."""
    del raw_content
    return {**item, "_normalized": True}


@pytest.fixture
def ingestor():
    """An S3ImportIngestor whose normalize_item marks items and whose
    send_to_queue returns the count SQS would confirm."""
    with offline_ingestor_construction():
        ing = handler.S3ImportIngestor()
    ing.normalize_item = _mark_normalized
    ing.send_to_queue = MagicMock(side_effect=len)
    return ing


def _serve(mock_s3: MagicMock, body: bytes, size: int | None = None) -> None:
    mock_s3.head_object.return_value = {"ContentLength": len(body) if size is None else size}
    mock_s3.get_object.return_value = {"Body": io.BytesIO(body)}


# ---------------------------------------------------------------------------
# Field aliases and the normalized row
# ---------------------------------------------------------------------------

class TestEveryAliasIsRecognised:
    def test_the_alias_table_is_exactly_this(self):
        # Pinned as (canonical, position, alias) triples rather than the dict literal, so the table
        # is restated in a different shape than the handler declares it (and lookup order counts).
        triples = sorted(
            (canonical, position, alias)
            for canonical, aliases in FIELD_ALIASES.items()
            for position, alias in enumerate(aliases)
        )
        assert triples == [
            ("author", 0, "author"), ("author", 1, "user"), ("author", 2, "username"), ("author", 3, "name"),
            ("author", 4, "reviewer"),
            ("channel", 0, "channel"), ("channel", 1, "source"), ("channel", 2, "platform"), ("channel", 3, "type"),
            ("created_at", 0, "created_at"), ("created_at", 1, "date"), ("created_at", 2, "timestamp"),
            ("created_at", 3, "time"), ("created_at", 4, "created"),
            ("id", 0, "id"), ("id", 1, "review_id"), ("id", 2, "feedback_id"), ("id", 3, "item_id"),
            ("rating", 0, "rating"), ("rating", 1, "score"), ("rating", 2, "stars"),
            ("text", 0, "text"), ("text", 1, "content"), ("text", 2, "feedback"), ("text", 3, "comment"),
            ("text", 4, "review"), ("text", 5, "message"), ("text", 6, "body"),
            ("url", 0, "url"), ("url", 1, "link"), ("url", 2, "href"),
        ]
        assert list(FIELD_ALIASES) == ["text", "rating", "created_at", "author", "channel", "url", "id"]

    @pytest.mark.parametrize("alias", ["text", "content", "feedback", "comment", "review", "message", "body"])
    def test_a_row_with_only_a_text_alias_is_kept(self, alias):
        row = _normalize_row({alias: "Hello"}, SOURCE, "csv_import")
        assert row is not None
        assert row["text"] == "Hello"

    @pytest.mark.parametrize(("canonical", "alias", "value", "expected"), [
        *((c, a, "4", 4.0) for c in ["rating"] for a in ["rating", "score", "stars"]),
        *((c, a, "2025-06-01", "2025-06-01") for c in ["created_at"]
          for a in ["created_at", "date", "timestamp", "time", "created"]),
        *((c, a, "Bob", "Bob") for c in ["author"] for a in ["author", "user", "username", "name", "reviewer"]),
        *((c, a, "web", "web") for c in ["channel"] for a in ["channel", "source", "platform", "type"]),
        *((c, a, "https://x/1", "https://x/1") for c in ["url"] for a in ["url", "link", "href"]),
        *((c, a, "r-1", "r-1") for c in ["id"] for a in ["id", "review_id", "feedback_id", "item_id"]),
    ])
    def test_each_alias_feeds_its_canonical_field(self, canonical, alias, value, expected):
        row = _normalize_row({"text": "t", alias: value}, SOURCE, "csv_import")
        assert row is not None
        assert row[canonical] == expected


class TestTheNormalizedRowShape:
    def test_a_bare_text_row_gets_the_caller_channel_and_empty_strings(self):
        assert _normalize_row({"text": "Only text"}, SOURCE, "json_import") == {
            "id": "s3-" + hashlib.sha256(b"Only text").hexdigest()[:16],
            "channel": "json_import",
            "url": "",
            "text": "Only text",
            "rating": None,
            "created_at": "",
            "author": "",
            "source_platform_override": SOURCE,
        }

    def test_a_full_row_keeps_every_field(self):
        row = {"id": "r1", "text": "Great", "rating": "5", "created_at": "2025-01-01",
               "author": "Ann", "channel": "web", "url": "https://x/1"}
        assert _normalize_row(row, SOURCE, "csv_import") == {
            "id": "r1", "channel": "web", "url": "https://x/1", "text": "Great", "rating": 5.0,
            "created_at": "2025-01-01", "author": "Ann", "source_platform_override": SOURCE,
        }

    @pytest.mark.parametrize("value", [None, "", "excellent", "4,5"])
    def test_an_unparseable_rating_is_none(self, value):
        assert _parse_rating(value) is None

    def test_the_guard_on_none_and_empty_is_gone(self):
        from pathlib import Path

        source = Path(handler.__file__).read_text(encoding="utf-8")
        assert 'value == ""' not in source
        assert "default_channel: str)" in source


class TestTheDeterministicId:
    def test_the_empty_text_id_is_the_sha256_of_nothing(self):
        assert _generate_deterministic_id("") == "s3-e3b0c44298fc1c14"

    def test_hello_hashes_to_sixteen_hex_digits(self):
        assert _generate_deterministic_id("hello") == "s3-2cf24dba5fb0a30e"
        assert len(_generate_deterministic_id("hello")) == 19

    def test_only_the_first_200_characters_count(self):
        base = "a" * 200
        assert _generate_deterministic_id(base + "b") == _generate_deterministic_id(base + "c")
        assert _generate_deterministic_id("a" * 199 + "b") != _generate_deterministic_id("a" * 199 + "c")

    def test_the_hash_is_declared_not_for_security(self):
        with patch.object(handler.hashlib, "sha256", wraps=hashlib.sha256) as sha256:
            _generate_deterministic_id("hello")
        sha256.assert_called_once_with(b"hello", usedforsecurity=False)


# ---------------------------------------------------------------------------
# Parsers: channels, numbering, encoding, and every log line
# ---------------------------------------------------------------------------

class TestParsersNameTheirChannel:
    def test_csv_rows_default_to_csv_import(self):
        [item] = _parse_csv(_csv("id,text", "1,Hi"), SOURCE)
        assert item["channel"] == "csv_import"
        assert item["source_platform_override"] == SOURCE

    def test_jsonl_rows_default_to_json_import(self):
        [item] = _parse_jsonl(_jsonl({"text": "Hi"}), SOURCE)
        assert item["channel"] == "json_import"

    def test_json_rows_default_to_json_import(self):
        [item] = _parse_json(_json([{"text": "Hi"}]), SOURCE)
        assert item["channel"] == "json_import"


class TestInvalidUtf8IsReplacedNotFatal:
    def test_csv(self):
        [item] = _parse_csv(io.BytesIO(b"id,text\n1,caf\xe9\n"), SOURCE)
        assert item["text"] == "caf\ufffd"

    def test_jsonl(self):
        [item] = _parse_jsonl(io.BytesIO(b'{"text": "caf\xe9"}\n'), SOURCE)
        assert item["text"] == "caf\ufffd"


class TestEveryParserLogLine:
    def test_csv_without_headers(self):
        with patch.object(handler, "logger") as log:
            assert list(_parse_csv(io.BytesIO(b""), SOURCE)) == []
        log.error.assert_called_once_with("CSV file has no headers")

    def test_csv_without_a_text_column_lists_what_was_expected_and_found(self):
        with patch.object(handler, "logger") as log:
            assert list(_parse_csv(_csv("id,Score", "1,5"), SOURCE)) == []
        log.error.assert_called_once_with(
            "CSV missing text column. Expected one of: "
            "['body', 'comment', 'content', 'feedback', 'message', 'review', 'text']. "
            "Found: ['id', 'score']"
        )

    def test_csv_rows_are_numbered_from_2_when_text_is_empty(self):
        with patch.object(handler, "logger") as log:
            assert len(list(_parse_csv(_csv("id,text", "1,", "2,ok", "3,"), SOURCE))) == 1
        assert log.debug.call_args_list == [
            call("Row 2: empty text, skipping"),
            call("Row 4: empty text, skipping"),
        ]

    def test_a_csv_row_that_fails_to_normalize_is_reported_by_number(self):
        with (
            patch.object(handler, "logger") as log,
            patch.object(handler, "_normalize_row", side_effect=ValueError("boom")),
        ):
            assert list(_parse_csv(_csv("id,text", "1,a", "2,b"), SOURCE)) == []
        assert log.warning.call_args_list == [
            call("Row 2: parse error: boom"),
            call("Row 3: parse error: boom"),
        ]

    def test_jsonl_lines_are_numbered_from_1(self):
        raw = b'{"text": "Good"}\n{bad json}\n"a string"\n'
        with patch.object(handler, "logger") as log:
            assert len(list(_parse_jsonl(io.BytesIO(raw), SOURCE))) == 1
        assert log.warning.call_args_list == [
            call("JSONL line 2: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"),
            call("JSONL line 3: 'str' object has no attribute 'get'"),
        ]

    def test_an_invalid_json_document(self):
        with patch.object(handler, "logger") as log:
            assert list(_parse_json(io.BytesIO(b"not json"), SOURCE)) == []
        log.exception.assert_called_once_with("Invalid JSON: Expecting value: line 1 column 1 (char 0)")

    def test_json_items_are_numbered_from_0(self):
        with patch.object(handler, "logger") as log:
            assert len(list(_parse_json(_json([{"text": "ok"}, "a string", 7]), SOURCE))) == 1
        assert log.warning.call_args_list == [
            call("JSON item 1: 'str' object has no attribute 'get'"),
            call("JSON item 2: 'int' object has no attribute 'get'"),
        ]


# ---------------------------------------------------------------------------
# process_file: the size boundary, the batch boundary, what reaches SQS
# ---------------------------------------------------------------------------

class TestTheSizeLimit:
    def test_the_limit_is_fifty_mebibytes(self):
        assert MAX_FILE_SIZE_MB == 50
        assert MAX_FILE_SIZE_BYTES == 52_428_800

    @patch("s3_import.ingestor.handler.s3_client")
    def test_a_file_of_exactly_the_limit_is_imported(self, mock_s3, ingestor):
        _serve(mock_s3, b"id,text\n1,Hi\n", size=52_428_800)
        assert ingestor.process_file("bucket", "surveys/data.csv") == 1

    @patch("s3_import.ingestor.handler.s3_client")
    def test_one_byte_over_is_refused_and_the_message_states_both_sizes(self, mock_s3, ingestor):
        _serve(mock_s3, b"", size=52_428_801)
        with patch.object(handler, "logger") as log:
            assert ingestor.process_file("bucket", "surveys/data.csv") == 0
        log.error.assert_called_once_with("surveys/data.csv: 50.0 MB exceeds 50 MB limit")
        mock_s3.get_object.assert_not_called()

    @patch("s3_import.ingestor.handler.s3_client")
    def test_a_hundred_mebibyte_file_reports_its_size_in_mb(self, mock_s3, ingestor):
        _serve(mock_s3, b"", size=100 * 1024 * 1024)
        with patch.object(handler, "logger") as log:
            assert ingestor.process_file("bucket", "surveys/huge.json") == 0
        log.error.assert_called_once_with("surveys/huge.json: 100.0 MB exceeds 50 MB limit")


class TestEveryProcessFileLogLine:
    @patch("s3_import.ingestor.handler.s3_client")
    def test_an_unsupported_extension(self, mock_s3, ingestor):
        with patch.object(handler, "logger") as log:
            assert ingestor.process_file("bucket", "surveys/data.txt") == 0
        log.warning.assert_called_once_with("Unsupported file type: surveys/data.txt")
        mock_s3.head_object.assert_not_called()

    @patch("s3_import.ingestor.handler.s3_client")
    def test_an_empty_file(self, mock_s3, ingestor):
        _serve(mock_s3, b"", size=0)
        with patch.object(handler, "logger") as log:
            assert ingestor.process_file("bucket", "surveys/data.csv") == 0
        log.warning.assert_called_once_with("surveys/data.csv: empty file, skipping")
        mock_s3.get_object.assert_not_called()

    @patch("s3_import.ingestor.handler.s3_client")
    def test_a_processed_file_reports_its_count(self, mock_s3, ingestor):
        _serve(mock_s3, b"id,text\n1,A\n2,B\n")
        with patch.object(handler, "logger") as log, patch.object(handler, "metrics") as met:
            assert ingestor.process_file("bucket", "surveys/data.csv") == 2
        log.info.assert_called_once_with("Processed surveys/data.csv: 2 items")
        met.add_metric.assert_called_once_with(name="ItemsImported", unit="Count", value=2)


class TestWhatReachesTheQueue:
    @patch("s3_import.ingestor.handler.s3_client")
    def test_the_batch_holds_the_normalized_items_with_the_folder_as_source(self, mock_s3, ingestor):
        _serve(mock_s3, b"id,text\n1,A\n2,B\n")
        mock_s3.head_object.return_value = {"ContentLength": 17}

        assert ingestor.process_file("bucket", "surveys/data.csv") == 2

        mock_s3.head_object.assert_called_once_with(Bucket="bucket", Key="surveys/data.csv")
        mock_s3.get_object.assert_called_once_with(Bucket="bucket", Key="surveys/data.csv")
        ingestor.send_to_queue.assert_called_once_with([
            {"id": "1", "channel": "csv_import", "url": "", "text": "A", "rating": None,
             "created_at": "", "author": "", "source_platform_override": "S3 - surveys", "_normalized": True},
            {"id": "2", "channel": "csv_import", "url": "", "text": "B", "rating": None,
             "created_at": "", "author": "", "source_platform_override": "S3 - surveys", "_normalized": True},
        ])

    @pytest.mark.parametrize(("rows", "batches"), [(99, [99]), (100, [100]), (101, [100, 1])])
    @patch("s3_import.ingestor.handler.s3_client")
    def test_a_batch_is_flushed_at_exactly_100_items(self, mock_s3, ingestor, rows, batches):
        body = "\n".join(["id,text", *(f"{i},Review {i}" for i in range(rows))]).encode()
        _serve(mock_s3, body)

        assert ingestor.process_file("bucket", "surveys/data.csv") == rows
        assert [len(c.args[0]) for c in ingestor.send_to_queue.call_args_list] == batches


# ---------------------------------------------------------------------------
# lambda_handler: the exact response, record skipping, and its decorators
# ---------------------------------------------------------------------------

class TestLambdaHandlerResponses:
    @pytest.mark.parametrize("event", [{}, {"Records": []}])
    def test_no_records_is_skipped_with_a_reason(self, event):
        with patch.object(handler, "logger") as log:
            assert lambda_handler(event, _context()) == {"status": "skipped", "reason": "no records"}
        log.info.assert_called_once_with("No S3 records in event, nothing to do")

    @patch("s3_import.ingestor.handler.S3ImportIngestor")
    def test_the_response_lists_every_file_with_its_count(self, MockIngestor):
        MockIngestor.return_value.process_file.side_effect = [3, 7]
        event = _s3_event(("aws:s3", "b", "a/x.csv"), ("aws:s3", "b", "a/y.json"))

        with patch.object(handler, "logger") as log:
            result = lambda_handler(event, _context())

        assert result == {
            "status": "success",
            "files_processed": 2,
            "items_processed": 10,
            "results": [{"file": "a/x.csv", "items_processed": 3}, {"file": "a/y.json", "items_processed": 7}],
        }
        assert log.info.call_args_list == [call("Processing s3://b/a/x.csv"), call("Processing s3://b/a/y.json")]

    @patch("s3_import.ingestor.handler.S3ImportIngestor")
    def test_a_non_s3_record_is_skipped_and_the_next_one_still_processed(self, MockIngestor):
        MockIngestor.return_value.process_file.return_value = 4
        event = _s3_event(("aws:sns", "b", "ignored.csv"), ("aws:s3", "b", "kept.csv"))

        result = lambda_handler(event, _context())

        MockIngestor.return_value.process_file.assert_called_once_with("b", "kept.csv")
        assert result["files_processed"] == 1
        assert result["results"] == [{"file": "kept.csv", "items_processed": 4}]


class TestLambdaHandlerIsWrapped:
    def test_the_module_holds_a_real_s3_client(self):
        assert handler.s3_client.meta.service_model.service_name == "s3"

    def test_the_lambda_context_reaches_the_logger(self):
        logger.remove_keys(["function_name", "cold_start"])
        lambda_handler({}, _context("voc-s3-import-under-test"))
        keys = logger.get_current_keys()
        assert keys["function_name"] == "voc-s3-import-under-test"
        assert keys["function_request_id"] == "req-s3-import-mutation-0001"

    @patch("s3_import.ingestor.handler.s3_client")
    def test_the_cold_start_and_items_imported_metrics_are_flushed_as_emf(self, mock_s3, capsys):
        _serve(mock_s3, b"id,text\n1,A\n2,B\n")
        metrics.clear_metrics()
        reset_cold_start_flag()
        try:
            with offline_ingestor_construction(), patch.object(
                handler.S3ImportIngestor, "send_to_queue", side_effect=len
            ), patch.object(handler.S3ImportIngestor, "normalize_item", side_effect=lambda item: item):
                lambda_handler(_s3_event(("aws:s3", "b", "surveys/data.csv")), _context())
        finally:
            out = capsys.readouterr().out
            metrics.clear_metrics()

        blobs = [json.loads(line) for line in out.splitlines() if line.startswith("{")]
        names = {m["Name"] for b in blobs for fam in b["_aws"]["CloudWatchMetrics"] for m in fam["Metrics"]}
        assert names == {"ColdStart", "ItemsImported"}
        assert [b["ItemsImported"] for b in blobs if "ItemsImported" in b] == [[2.0]]

    def test_the_handler_is_registered_with_the_tracer(self):
        try:
            with patch.object(tracer, "capture_lambda_handler", side_effect=lambda f: f) as capture:
                importlib.reload(handler)
            (wrapped,), _ = capture.call_args
            assert capture.call_count == 1
            assert wrapped.__name__ == "lambda_handler"
            # The tracer sits between the logger (outermost) and the metrics flush.
            assert vars(handler.lambda_handler)["__wrapped__"] is wrapped
        finally:
            importlib.reload(handler)
