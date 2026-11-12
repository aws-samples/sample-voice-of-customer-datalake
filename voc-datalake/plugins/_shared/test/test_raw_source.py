"""_shared/raw_source.py and BaseIngestor.normalize_item: the provider payload goes to the archive, never the queue."""
import json
from unittest.mock import patch

from _shared.raw_source import MAX_RAW_SOURCE_CHARS, RAW_SOURCE_KEY, TRUNCATION_MARKER, pop_raw_source
from _shared.test.ingestor_fixtures import offline_ingestor_construction
from _shared.test.workspace_fixtures import SCOPE


class TestPopRawSource:
    def test_a_record_is_popped_as_json(self):
        item = {"id": "1", RAW_SOURCE_KEY: {"b": 1, "a": "é"}}
        assert pop_raw_source(item) == json.dumps({"b": 1, "a": "é"}, ensure_ascii=False)
        assert RAW_SOURCE_KEY not in item

    def test_a_string_is_kept_as_is(self):
        assert pop_raw_source({RAW_SOURCE_KEY: "<div>x</div>"}) == "<div>x</div>"

    def test_nothing_there_is_none(self):
        item = {"id": "1"}
        assert pop_raw_source(item) is None
        assert pop_raw_source({RAW_SOURCE_KEY: None}) is None
        assert item == {"id": "1"}

    def test_an_oversized_payload_is_cut_with_a_marker(self):
        text = pop_raw_source({RAW_SOURCE_KEY: "x" * (MAX_RAW_SOURCE_CHARS + 10)})
        assert text == "x" * MAX_RAW_SOURCE_CHARS + TRUNCATION_MARKER

    def test_a_payload_at_the_limit_is_whole(self):
        assert pop_raw_source({RAW_SOURCE_KEY: "x" * MAX_RAW_SOURCE_CHARS}) == "x" * MAX_RAW_SOURCE_CHARS


def _ingestor():
    from _shared.base_ingestor import BaseIngestor

    class _Plugin(BaseIngestor):
        def fetch_new_items(self):
            yield from ()

    with offline_ingestor_construction():
        return _Plugin(SCOPE)


class TestNormalizeItem:
    def test_the_payload_is_archived_and_not_in_the_message(self):
        ingestor = _ingestor()
        with patch("_shared.base_ingestor.archive_raw_item", return_value="s3://b/k") as archive:
            message = ingestor.normalize_item({"id": "1", "text": "hi", RAW_SOURCE_KEY: {"rss": 1}})

        assert archive.call_args.args[4] == '{"rss": 1}'
        assert RAW_SOURCE_KEY not in archive.call_args.args[3]
        assert RAW_SOURCE_KEY not in message
        # Archived under the run's workspace (ws/{ws}/raw/...), never the deployment-wide raw/.
        assert archive.call_args.kwargs == {"scope": SCOPE}

    def test_an_explicit_raw_content_wins_and_the_key_still_goes(self):
        ingestor = _ingestor()
        with patch("_shared.base_ingestor.archive_raw_item", return_value=None) as archive:
            message = ingestor.normalize_item({"id": "1", "text": "hi", RAW_SOURCE_KEY: {"rss": 1}}, "explicit")

        assert archive.call_args.args[4] == "explicit"
        assert RAW_SOURCE_KEY not in message
        assert RAW_SOURCE_KEY not in (message.get("raw_data") or {})
