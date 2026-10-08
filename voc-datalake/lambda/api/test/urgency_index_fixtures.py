"""The urgency GSI plus the BatchGetItem read-back `/feedback/urgent` performs.

`get_urgent_feedback` queries `gsi3-by-urgency` for keys, then hydrates them with
`table.meta.client.batch_get_item` (issue #267 item 2). A stub that answers only
the query returns attribute-less rows and every filter passes on an empty window,
so every urgent-route test wires both halves through this one helper.
"""
from typing import Any
from unittest.mock import MagicMock

FEEDBACK_TABLE_NAME = 'test-feedback'


def wire_urgency_index(table: MagicMock, rows: list[dict[str, Any]], *, unprocessed_rounds: int = 0) -> None:
    """Answer the urgency query with `rows`' keys and BatchGetItem with `rows`.

    `unprocessed_rounds` > 0 makes the first N batch calls return every key as
    UnprocessedKeys and nothing in Responses, the way a throttled table does.
    """
    table.name = FEEDBACK_TABLE_NAME
    table.query.return_value = {'Items': [{'pk': r['pk'], 'sk': r['sk']} for r in rows]}
    by_key = {(r['pk'], r['sk']): r for r in rows}
    throttled = iter(range(unprocessed_rounds))

    def batch_get_item(RequestItems: dict[str, Any]) -> dict[str, Any]:
        keys = RequestItems[FEEDBACK_TABLE_NAME]['Keys']
        if next(throttled, None) is not None:
            return {'Responses': {}, 'UnprocessedKeys': RequestItems}
        found = [by_key[(k['pk'], k['sk'])] for k in keys if (k['pk'], k['sk']) in by_key]
        return {'Responses': {FEEDBACK_TABLE_NAME: found}, 'UnprocessedKeys': {}}

    table.meta.client.batch_get_item.side_effect = batch_get_item


def batch_get_key_counts(table: MagicMock) -> list[int]:
    """How many keys each BatchGetItem call asked for, in call order."""
    return [
        len(call.kwargs['RequestItems'][FEEDBACK_TABLE_NAME]['Keys'])
        for call in table.meta.client.batch_get_item.call_args_list
    ]
