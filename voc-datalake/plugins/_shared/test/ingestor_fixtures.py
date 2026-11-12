"""Test builders for BaseIngestor subclasses."""
from collections.abc import Generator
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

from _shared.test.scoped_secret import scoped_secret
from _shared.test.workspace_fixtures import SCOPE
from shared.ws_repo import WorkspaceScope

# Three timestamped reviews: the run() tests feed these through fetch_new_items.
THREE_REVIEWS = (
    {'id': '1', 'text': 'Review 1', 'created_at': '2025-01-01T00:00:00Z'},
    {'id': '2', 'text': 'Review 2', 'created_at': '2025-01-01T01:00:00Z'},
    {'id': '3', 'text': 'Review 3', 'created_at': '2025-01-01T02:00:00Z'},
)


def ingestor_yielding(items=(), scope: WorkspaceScope | None = SCOPE, **init_kwargs):
    """Construct a minimal BaseIngestor whose fetch_new_items yields *items*, running in *scope* (``WS``; None: a
    deployment-wide run).

    Construction reads the secret and builds the AWS clients, so call it with
    the ``ingestor_aws`` fixture (or equivalent patches) active.
    """
    from _shared.base_ingestor import BaseIngestor

    class TestIngestor(BaseIngestor):
        def fetch_new_items(self):
            # Fresh copies, so a run that mutates its items cannot leak into
            # another test through the shared THREE_REVIEWS constant.
            yield from (dict(item) for item in items)

    return TestIngestor(scope, **init_kwargs)


class FakeWatermarks:
    """voc-watermarks as one dict (`get_item` / `put_item` with boto3's keywords, as the workspace layer calls the
    table): one table for every workspace, as the real one is."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def get_item(self, *, Key) -> dict:
        value = self.values.get(Key["source"])
        return {"Item": {"value": value}} if value is not None else {}

    def put_item(self, *, Item) -> None:
        self.values[Item["source"]] = Item["value"]


def with_mock_circuit_breaker(ingestor, is_open: bool = False):
    """Replace *ingestor*'s circuit breaker with a mock reporting *is_open*."""
    ingestor.circuit_breaker = MagicMock()
    ingestor.circuit_breaker.is_open.return_value = is_open
    return ingestor


def breaker_mock(ingestor) -> MagicMock:
    """The mock circuit breaker installed by ``with_mock_circuit_breaker``."""
    breaker = ingestor.circuit_breaker
    if not isinstance(breaker, MagicMock):
        raise TypeError('call with_mock_circuit_breaker first')
    return breaker


@contextmanager
def offline_ingestor_construction() -> Generator[None, None, None]:
    """Patch every AWS dependency ``BaseIngestor.__init__`` touches (DynamoDB,
    S3, SQS, and a secret inside the plugin's namespace), so a plugin's
    ingestor can be constructed inside the block without AWS."""
    with (
        patch("_shared.base_ingestor.get_dynamodb_resource") as mock_dynamo,
        patch("_shared.base_ingestor.get_s3_client"),
        patch("_shared.base_ingestor.get_sqs_client"),
        patch("_shared.base_ingestor.get_secret", return_value=scoped_secret()),
    ):
        mock_dynamo.return_value.Table.return_value = MagicMock()
        yield
