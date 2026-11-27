"""Test support shared by the s3_import ingestor's suites (plugins/s3_import/ingestor/test_s3_import_*.py): the
staged file a mocked import-bucket client serves, the messages a run queues, and a raw lake to keep originals in."""

import io
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

from shared.test.source_profile_fixtures import seeded_source_profiles

#: The raw lake's bucket name `with_raw_lake` sets.
RAW_LAKE = "raw-lake"


def serve_staged_file(s3: MagicMock, body: bytes) -> None:
    """Make the mocked import-bucket client *s3* answer every head with *body*'s size and every read with a fresh
    stream of *body*."""
    s3.head_object.return_value = {"ContentLength": len(body)}
    s3.get_object.side_effect = lambda **_: {"Body": io.BytesIO(body)}


@contextmanager
def queued_messages() -> Generator[list[dict]]:
    """Every message the block's runs send through the real `send_to_queue` (`_shared/base_ingestor.py`), in order;
    each send reports all of its messages sent."""
    queued: list[dict] = []

    def send(_sqs, _url, messages, **_kwargs) -> int:
        queued.extend(messages)
        return len(messages)

    with patch("_shared.base_ingestor.send_messages_to_queue", side_effect=send):
        yield queued


@contextmanager
def with_raw_lake(monkeypatch: pytest.MonkeyPatch,
                  workspaces: Mapping[str, list[dict]] | None = None) -> Generator[None]:
    """A raw lake (`RAW_LAKE`) and the plugin's version for the block, with the source profiles of *workspaces*
    (workspace id -> its profiles; the deployment has none configured)."""
    monkeypatch.setenv("RAW_DATA_BUCKET", RAW_LAKE)
    monkeypatch.setenv("PLUGIN_VERSION", "1.4.0")
    with seeded_source_profiles(workspaces=workspaces):
        yield
