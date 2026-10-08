"""The github_issues ingestor under scripted GitHub responses, for its two test suites.

A watermarks table backed by a dict, the ingestor built with every AWS client
mocked, and a reader for what it enqueued — shared by
`test_github_issues_ingestor.py` and `test_github_issues_handler_mutation.py`.
"""
import json
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

from github_fixtures import ISSUES_PATH, REPO, FakeGitHub

from _shared.test.ingestor_fixtures import breaker_mock, with_mock_circuit_breaker
from _shared.test.scoped_secret import scoped_secret
from _shared.test.sqs_response_fixtures import echo_batch_success

WATERMARK_KEY = f"test_source#repo#{REPO}"
#: Pass as a secret's value to leave that key out of the secret altogether.
ABSENT = None


class WatermarkTable:
    """The watermarks table as a dict, so commits and reads can be asserted on."""

    def __init__(self, initial: dict | None = None):
        self.values = dict(initial or {})

    def get_item(self, Key):
        value = self.values.get(Key["source"])
        return {"Item": {"value": value}} if value is not None else {}

    def put_item(self, Item):
        self.values[Item["source"]] = Item["value"]

    def state(self) -> dict:
        return json.loads(self.values[WATERMARK_KEY])


@dataclass
class ObservedIngestor:
    """The ingestor under test plus the mocked clients it was built with."""

    ingestor: Any
    sqs: MagicMock
    s3: MagicMock

    def run(self) -> dict:
        return self.ingestor.run()

    @property
    def circuit_breaker(self) -> MagicMock:
        return breaker_mock(self.ingestor)


@contextmanager
def ingestor_with(
    github: FakeGitHub, watermarks: WatermarkTable, *, deadline=None, **secrets: str | None,
) -> Iterator[ObservedIngestor]:
    """The ingestor over *github* and *watermarks*; a secret given as ``ABSENT`` is left out."""
    sqs = MagicMock()
    sqs.send_message_batch.side_effect = echo_batch_success
    merged: dict[str, str | None] = {"token": "ghp_secret_token", "repos": REPO, **secrets}
    values = {key: value for key, value in merged.items() if value is not None}
    with (
        patch("_shared.base_ingestor.get_dynamodb_resource") as dynamo,
        patch("_shared.base_ingestor.get_s3_client") as s3,
        patch("_shared.base_ingestor.get_sqs_client", return_value=sqs),
        patch("_shared.base_ingestor.get_secret", return_value=scoped_secret(**values)),
        patch("_shared.github_api._http_get", github),
    ):
        dynamo.return_value.Table.return_value = watermarks
        from github_issues.ingestor.handler import GitHubIssuesIngestor

        yield ObservedIngestor(
            ingestor=with_mock_circuit_breaker(GitHubIssuesIngestor(deadline=deadline)),
            sqs=sqs,
            s3=s3.return_value,
        )


def run_listing(page, state: dict | None = None):
    """One run over a single scripted issues page, from watermark *state*."""
    github = FakeGitHub({ISSUES_PATH: [page]})
    watermarks = WatermarkTable({WATERMARK_KEY: json.dumps(state)} if state else None)
    with ingestor_with(github, watermarks) as ingestor:
        result = ingestor.run()
    return ingestor, github, watermarks, result


def sent_items(ingestor: ObservedIngestor) -> list[dict]:
    return [
        json.loads(entry["MessageBody"])
        for call in ingestor.sqs.send_message_batch.call_args_list
        for entry in call.kwargs["Entries"]
    ]
