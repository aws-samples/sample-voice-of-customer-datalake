"""Tests for `scripts/retention/remove_ttl.py`, the keep-everything migration.

Lives under `lambda/` so the default `testpaths` (lambda, plugins) runs it; the
script itself is loaded by path because `scripts/` is not a package.
"""
import sys
from typing import Any
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from shared.test.repo_paths import load_module_from_path, repo_root

_SCRIPT = repo_root() / 'scripts' / 'retention' / 'remove_ttl.py'


@pytest.fixture(scope='module')
def remove_ttl():
    module = load_module_from_path('remove_ttl', _SCRIPT)
    try:
        yield module
    finally:
        sys.modules.pop(module.__name__, None)


def _table(*pages: list[dict]) -> MagicMock:
    """A mock table whose Scan returns `pages` in order, with cursors between them."""
    table = MagicMock()
    responses = []
    for index, items in enumerate(pages):
        response: dict[str, Any] = {'Items': items}
        if index < len(pages) - 1:
            response['LastEvaluatedKey'] = {'pk': f'page-{index}'}
        responses.append(response)
    table.scan.side_effect = responses
    return table


def _conditional_failure() -> ClientError:
    return ClientError({'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'x'}}, 'UpdateItem')


FEEDBACK_PAGES = (
    [
        {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#1', 'ttl': 1, 'date': '2025-06-01'},
        {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#2', 'date': '2025-03-15'},
    ],
    [{'pk': 'SOURCE#web', 'sk': 'FEEDBACK#3', 'ttl': 2, 'date': '2025-09-30'}],
)
METRIC_ROWS = ([{'pk': 'METRIC#daily_total', 'sk': '2025-06-01'}],)


def test_the_dry_run_writes_nothing(remove_ttl):
    feedback, aggregates = _table(*FEEDBACK_PAGES), _table(*METRIC_ROWS)

    report = remove_ttl.run(feedback, aggregates, apply=False)

    assert (report.feedback_scanned, report.feedback_with_ttl, report.aggregate_rows_with_ttl) == (3, 2, 1)
    assert report.earliest_date == '2025-03-15'
    feedback.update_item.assert_not_called()
    aggregates.update_item.assert_not_called()


def test_apply_removes_ttl_conditionally_and_lowers_the_watermark(remove_ttl):
    feedback, aggregates = _table(*FEEDBACK_PAGES), _table(*METRIC_ROWS)

    report = remove_ttl.run(feedback, aggregates, apply=True)

    assert report.feedback_updated == 2
    assert [c.kwargs['Key']['sk'] for c in feedback.update_item.call_args_list] == ['FEEDBACK#1', 'FEEDBACK#3']
    for call in feedback.update_item.call_args_list + aggregates.update_item.call_args_list[:1]:
        assert call.kwargs['UpdateExpression'] == 'REMOVE #ttl'
        assert call.kwargs['ConditionExpression'] == 'attribute_exists(pk)'
    watermark = aggregates.update_item.call_args_list[-1].kwargs
    assert watermark['Key'] == {'pk': 'METRIC#meta', 'sk': 'earliest_date'}
    assert watermark['ExpressionAttributeValues'][':date'] == '2025-03-15'
    assert report.watermark_written is True


def test_only_metric_rows_are_selected_and_the_watermark_is_excluded(remove_ttl):
    aggregates = _table([])
    remove_ttl.migrate_aggregates(aggregates, remove_ttl.Report(), apply=False)

    kwargs = aggregates.scan.call_args.kwargs
    assert 'begins_with(pk, :metric)' in kwargs['FilterExpression']
    assert kwargs['ExpressionAttributeValues'] == {':metric': 'METRIC#', ':meta': 'METRIC#meta'}


def test_nothing_is_ever_deleted(remove_ttl):
    feedback, aggregates = _table(*FEEDBACK_PAGES), _table(*METRIC_ROWS)
    remove_ttl.run(feedback, aggregates, apply=True)

    for table in (feedback, aggregates):
        table.delete_item.assert_not_called()
        table.put_item.assert_not_called()
    assert 'delete_item' not in _SCRIPT.read_text(encoding='utf-8')


def test_a_row_that_vanished_meanwhile_is_skipped(remove_ttl):
    feedback, aggregates = _table(*FEEDBACK_PAGES), _table([])
    feedback.update_item.side_effect = [_conditional_failure(), {}]

    report = remove_ttl.run(feedback, aggregates, apply=True)

    assert report.feedback_updated == 1


def test_an_older_stored_watermark_is_left_alone(remove_ttl):
    feedback, aggregates = _table(*FEEDBACK_PAGES), _table([])
    aggregates.update_item.side_effect = _conditional_failure()

    report = remove_ttl.run(feedback, aggregates, apply=True)

    assert report.watermark_written is False


def test_any_other_failure_stops_the_run(remove_ttl):
    feedback = _table(*FEEDBACK_PAGES)
    feedback.update_item.side_effect = ClientError(
        {'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'UpdateItem')

    with pytest.raises(ClientError):
        remove_ttl.run(feedback, _table([]), apply=True)
