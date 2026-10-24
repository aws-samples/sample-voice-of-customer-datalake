"""The BatchGetItem read-back `GET /feedback` performs for its page.

The list route walks PROJECTED rows (`metrics_handler._metric_row_read()`: the table keys
plus the fields its filters read) and fetches the page's full reviews by key with
`table.meta.client.batch_get_item`. A test double that answers only `query` would
return an empty page, so every list test that stubs the feedback table wires the
read-back here too, answering from the same reviews its query returns.
"""
from typing import Any
from unittest.mock import MagicMock

from urgency_index_fixtures import FEEDBACK_TABLE_NAME


def with_keys(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`items` with the table keys every stored review carries (`pk`, `sk`), where missing."""
    return [{'pk': f"SOURCE#{item.get('source_platform', 'webscraper')}",
             'sk': f"FEEDBACK#{item.get('feedback_id', n)}", **item} for n, item in enumerate(items)]


class StoredReviews:
    """The reviews a test's query double answers, served back by key to BatchGetItem."""

    def __init__(self) -> None:
        self._by_key: dict[tuple[Any, Any], dict[str, Any]] = {}

    def clear(self) -> None:
        self._by_key.clear()

    def remember(self, items: list[dict[str, Any]]) -> None:
        """Store `items` (keyless rows are skipped: the route never fetches them)."""
        self._by_key.update({(item['pk'], item['sk']): item for item in items if 'pk' in item and 'sk' in item})

    def install(self, table: MagicMock) -> None:
        """Answer `table`'s BatchGetItem from the stored reviews, in the order asked."""
        table.name = FEEDBACK_TABLE_NAME
        table.meta.client.batch_get_item.side_effect = self._batch_get_item

    def _batch_get_item(self, RequestItems: dict[str, Any]) -> dict[str, Any]:
        keys = RequestItems[FEEDBACK_TABLE_NAME]['Keys']
        found = [self._by_key[(k['pk'], k['sk'])] for k in keys if (k['pk'], k['sk']) in self._by_key]
        return {'Responses': {FEEDBACK_TABLE_NAME: found}, 'UnprocessedKeys': {}}


def serve_page_by_key(table: MagicMock, items: list[dict[str, Any]]) -> StoredReviews:
    """Answer the table's BatchGetItem with `items`, by key, in the order asked."""
    stored = StoredReviews()
    stored.remember(items)
    stored.install(table)
    return stored
