"""The urgency GSI plus the BatchGetItem read-back `/feedback/urgent` performs.

`get_urgent_feedback` queries `gsi3-by-urgency` for keys, then hydrates them with
`table.meta.client.batch_get_item` (issue #267 item 2). A stub that answers only
the query returns attribute-less rows and every filter passes on an empty window,
so every urgent-route test wires both halves through this one helper.
"""
from typing import Any
from unittest.mock import DEFAULT, MagicMock

FEEDBACK_TABLE_NAME = 'test-feedback'

# The index's projected key attributes (the table key plus the urgency index key).
_INDEX_KEY_FIELDS = ('pk', 'sk', 'gsi3pk', 'gsi3sk')


def _index_row(row: dict[str, Any]) -> dict[str, Any]:
    return {name: row[name] for name in _INDEX_KEY_FIELDS if name in row}


def _paged_query(rows: list[dict[str, Any]], kwargs: dict[str, Any]) -> dict[str, Any]:
    """A Query over `rows` the way DynamoDB pages one: `Limit`, `ExclusiveStartKey`, `Select=COUNT`.

    The key condition and FilterExpression are NOT evaluated (the route's in-memory
    filters are what these tests pin); every row is in the partition.
    """
    if kwargs.get('Select') == 'COUNT':
        return {'Count': len(rows), 'ScannedCount': len(rows)}
    start = kwargs.get('ExclusiveStartKey')
    offset = 0
    if start:
        keys = [(r.get('pk'), r.get('sk')) for r in rows]
        offset = keys.index((start['pk'], start['sk'])) + 1
    limit = kwargs.get('Limit', len(rows))
    page = [_index_row(r) for r in rows[offset:offset + limit]]
    response: dict[str, Any] = {'Items': page, 'ScannedCount': len(page)}
    if page and offset + limit < len(rows):
        response['LastEvaluatedKey'] = dict(page[-1])
    return response


def wire_urgency_index(table: MagicMock, rows: list[dict[str, Any]], *, unprocessed_rounds: int = 0) -> None:
    """Answer the urgency query with `rows`' keys (paged as DynamoDB pages) and BatchGetItem with `rows`.

    A test that later assigns `table.query.return_value` gets that answer instead
    (the paged double steps aside); one that assigns `side_effect` replaces it.

    `unprocessed_rounds` > 0 makes the first N batch calls return every key as
    UnprocessedKeys and nothing in Responses, the way a throttled table does.
    """
    table.name = FEEDBACK_TABLE_NAME
    own_return_value = table.query.return_value

    def query(**kwargs: Any) -> Any:
        if table.query.return_value is not own_return_value:
            return DEFAULT
        return _paged_query(rows, kwargs)

    table.query.side_effect = query
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
