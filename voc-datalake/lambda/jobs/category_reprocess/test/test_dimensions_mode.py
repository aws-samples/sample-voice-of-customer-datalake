"""Reprocess ``mode: 'dimensions'``: re-infer AI dimensions, never a locked value."""
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from jobs.category_reprocess import handler
from jobs.category_reprocess.handler import build_dimensions_update, reprocess_item
from shared import reprocess_jobs as jobs

DIMENSIONS = [
    {'key': 'product', 'infer': True, 'values': [{'name': 'App'}, {'name': 'Web'}]},
    {'key': 'user_type', 'infer': True, 'values': [{'name': 'customer'}, {'name': 'partner'}]},
]
JOB = {'mode': jobs.MODE_DIMENSIONS}


def _item(**extra) -> dict:
    return {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#1', 'original_text': 'the app crashes', 'category': 'other', **extra}


def _counters() -> dict:
    return dict.fromkeys(jobs.COUNTERS, 0)


def _run(item: dict, answer: dict, table: MagicMock | None = None,
         categories: list | None = None) -> tuple[dict, MagicMock]:
    table = table or MagicMock()
    counters = _counters()
    with patch.object(handler, 'classify_dimensions', return_value=answer):
        reprocess_item(table, item, JOB, categories or [], counters, DIMENSIONS)
    return counters, table


def test_an_ai_value_is_replaced_and_a_locked_one_kept():
    item = _item(dimensions={'product': 'Web', 'user_type': 'partner'},
                 dimension_sources={'product': 'ai', 'user_type': 'manual'})
    counters, table = _run(item, {'product': 'App', 'user_type': 'customer'})
    assert counters['updated'] == 1
    values = table.update_item.call_args.kwargs['ExpressionAttributeValues']
    assert values[':v1'] == {'product': 'App', 'user_type': 'partner'}
    assert values[':v2'] == {'product': 'reprocess', 'user_type': 'manual'}
    assert values[':dims_before'] == item['dimensions']


def test_an_unchanged_answer_writes_nothing():
    item = _item(dimensions={'product': 'App'}, dimension_sources={'product': 'reprocess'})
    counters, table = _run(item, {'product': 'app'})
    assert counters['unchanged'] == 1
    table.update_item.assert_not_called()


def test_a_manual_category_does_not_skip_the_dimensions():
    counters, _ = _run(_item(category_source='manual'), {'product': 'App'})
    assert counters['updated'] == 1


def test_a_review_without_text_fails():
    counters, _ = _run(_item(original_text=''), {'product': 'App'})
    assert counters['failed'] == 1


def test_a_concurrent_edit_wins():
    table = MagicMock()
    table.update_item.side_effect = ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'UpdateItem')
    counters, _ = _run(_item(), {'product': 'App'}, table)
    assert counters['skipped_manual'] == 1


@pytest.mark.parametrize(('item', 'condition'), [
    (_item(), 'attribute_exists(#pk) AND attribute_not_exists(#dims)'),
    (_item(dimensions={'product': 'App'}), 'attribute_exists(#pk) AND #dims = :dims_before'),
])
def test_the_update_is_conditional_on_what_was_read(item, condition):
    kwargs = build_dimensions_update(item, {}, {}, 'now')
    assert kwargs['ConditionExpression'] == condition
    assert kwargs['UpdateExpression'] == 'SET #a0 = :v0 REMOVE #a1, #a2'


def test_the_category_product_feeds_the_product_dimension():
    _, table = _run(_item(category='billing'), {}, categories=[{'name': 'billing', 'product': 'Web'}])
    values = table.update_item.call_args.kwargs['ExpressionAttributeValues']
    assert values[':v1'] == {'product': 'Web'}
    assert values[':v2'] == {'product': 'category'}
