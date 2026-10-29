"""The S3 import ingestor writes one import-history record per file (#237, docs/import-history.md)."""
import io
import json
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest

from _shared.test.ingestor_fixtures import offline_ingestor_construction

HANDLER = "s3_import.ingestor.handler"


@pytest.fixture
def ingestor():
    with offline_ingestor_construction():
        from s3_import.ingestor.handler import S3ImportIngestor

        ing = S3ImportIngestor()
        ing.normalize_item = MagicMock(side_effect=lambda item, *_args, **_kwargs: item)
        ing.send_to_queue = MagicMock(side_effect=len)
        ing.aggregates_table = MagicMock()
        return ing


@pytest.fixture
def recorded() -> Iterator[list]:
    """Every ImportRun the ingestor hands to the shared writer."""
    runs: list = []
    with patch(f"{HANDLER}.record_import_run", side_effect=lambda _table, run: runs.append(run)):
        yield runs


def _serve(mock_s3: MagicMock, data: bytes) -> None:
    mock_s3.head_object.return_value = {"ContentLength": len(data)}
    mock_s3.get_object.return_value = {"Body": io.BytesIO(data)}


@patch(f"{HANDLER}.s3_client")
def test_a_file_records_its_counts_and_the_skipped_rows(mock_s3, ingestor, recorded):
    _serve(mock_s3, b"id,text\n1,Great\n2,\n3,Slow\n")
    assert ingestor.process_file("bucket", "surveys/q3.csv") == 2
    [run] = recorded
    assert (run.method, run.source, run.actor) == ("s3", "S3 - surveys", "s3-upload")
    assert (run.counts.received, run.counts.imported, run.counts.skipped, run.counts.failed) == (3, 2, 1, 0)
    assert run.warnings == ["row 3: empty text — skipped"]
    assert run.raw_s3_key == "s3://bucket/surveys/q3.csv"


@patch(f"{HANDLER}.s3_client")
def test_a_bad_jsonl_line_is_a_skipped_row_with_its_reason(mock_s3, ingestor, recorded):
    _serve(mock_s3, b'{"text": "ok"}\nnot json\n')
    ingestor.process_file("bucket", "web/a.jsonl")
    [run] = recorded
    assert (run.counts.received, run.counts.imported, run.counts.skipped) == (2, 1, 1)
    assert run.warnings[0].startswith("line 2: not valid JSON — skipped")


@patch(f"{HANDLER}.s3_client")
def test_an_unreadable_json_file_is_a_failed_run_with_the_error(mock_s3, ingestor, recorded):
    _serve(mock_s3, b"{not json")
    assert ingestor.process_file("bucket", "web/a.json") == 0
    [run] = recorded
    assert run.counts.imported == 0
    assert run.errors[0].startswith("Invalid JSON")


@patch(f"{HANDLER}.s3_client")
def test_a_csv_without_a_text_column_is_a_failed_run(mock_s3, ingestor, recorded):
    _serve(mock_s3, b"id,score\n1,5\n")
    ingestor.process_file("bucket", "web/a.csv")
    [run] = recorded
    assert run.errors[0].startswith("CSV missing text column")


@patch(f"{HANDLER}.s3_client")
def test_an_oversized_file_is_recorded_as_failed_without_being_read(mock_s3, ingestor, recorded):
    mock_s3.head_object.return_value = {"ContentLength": 60 * 1024 * 1024}
    assert ingestor.process_file("bucket", "web/big.csv") == 0
    mock_s3.get_object.assert_not_called()
    [run] = recorded
    assert run.counts.received == 0
    assert "exceeds the 50 MB limit" in run.errors[0]


@patch(f"{HANDLER}.s3_client")
def test_an_empty_file_is_recorded_as_failed(mock_s3, ingestor, recorded):
    mock_s3.head_object.return_value = {"ContentLength": 0}
    ingestor.process_file("bucket", "web/empty.csv")
    assert recorded[0].errors == ["empty file"]


@patch(f"{HANDLER}.s3_client")
def test_an_unsupported_file_type_writes_no_record(mock_s3, ingestor, recorded):
    ingestor.process_file("bucket", "web/notes.txt")
    assert recorded == []
    mock_s3.head_object.assert_not_called()


@patch(f"{HANDLER}.s3_client")
def test_a_queue_failure_is_recorded_before_the_error_propagates(mock_s3, ingestor, recorded):
    rows = "".join(f"{i},Review {i}\n" for i in range(150))
    _serve(mock_s3, f"id,text\n{rows}".encode())
    ingestor.send_to_queue = MagicMock(side_effect=[100, RuntimeError("SQS rejected")])
    with pytest.raises(RuntimeError, match="SQS rejected"):
        ingestor.process_file("bucket", "web/a.csv")
    [run] = recorded
    assert (run.counts.received, run.counts.imported, run.counts.failed) == (150, 100, 50)
    assert run.errors == ["stopped after 100 items: SQS rejected"]


@patch(f"{HANDLER}.s3_client")
def test_the_record_reaches_the_aggregates_table(mock_s3, ingestor):
    """Without the capture: the shared writer puts the detail and the summary row."""
    _serve(mock_s3, json.dumps([{"text": "A"}]).encode())
    ingestor.process_file("bucket", "web/a.json")
    pks = [c.kwargs["Item"]["pk"] for c in ingestor.aggregates_table.put_item.call_args_list]
    assert pks[1] == "IMPORT_RUN"
    assert pks[0].startswith("IMPORT_RUN#")
