"""The retention walk's tests' store: a retained source on the moto tables, a scripted clock and scan, and the
hand-over chain (test_retention_walk_testable.py, test_retention_walk_bounds.py)."""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

from boto3.dynamodb.conditions import Key

from jobs.retention import handler, runs
from jobs.retention.copies import TOMBSTONE_PK_PREFIX
from jobs.retention.test.conftest import days_ago

SOURCE = 'tickets'
PLENTY = 900_000
LOW = 0
# The longest hand-over chain any test here needs; a chain past it fails the test instead of running on.
CHAIN_LIMIT = 12


def key(name: str) -> dict[str, str]:
    return {'pk': f'SOURCE#{SOURCE}', 'sk': f'FEEDBACK#{name}'}


def put(aws: dict[str, Any], name: str, age_days: int) -> None:
    aws['feedback'].put_item(Item={**key(name), 'feedback_id': name, 'source_id': name, 'source_platform': SOURCE,
                                   'date': days_ago(age_days)})


def expired(aws: dict[str, Any], count: int) -> list[str]:
    """``tickets`` keeps its feedback 30 days, and holds ``count`` items 60 days old (``a0``, ``a1``, ...)."""
    aws['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config',
                                     'sources': [{'id': SOURCE, 'retention_days': 30}]})
    names = [f'a{n}' for n in range(count)]
    for name in names:
        put(aws, name, 60)
    return names


def left(aws: dict[str, Any]) -> list[str]:
    """The feedback ids still stored, in key order."""
    items = aws['feedback'].query(KeyConditionExpression=Key('pk').eq(f'SOURCE#{SOURCE}'))['Items']
    return [str(item['feedback_id']) for item in items]


def tombstoned(aws: dict[str, Any]) -> list[str]:
    rows = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(f'{TOMBSTONE_PK_PREFIX}{SOURCE}'))['Items']
    return sorted(str(row['sk']) for row in rows)


def audits(aws: dict[str, Any]) -> list[dict[str, Any]]:
    return aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(runs.AUDIT_PK))['Items']


def clock(context: MagicMock, *budgets: int) -> None:
    """The Lambda's remaining time, one value per check, then plenty."""
    remaining = iter(budgets)
    context.get_remaining_time_in_millis.side_effect = lambda: next(remaining, PLENTY)


def scanned(context: MagicMock) -> tuple[dict[str, Any], list[Any]]:
    """One daily run's result, and the cursor each of its scans started from."""
    with patch.object(handler, '_scan_page', wraps=handler._scan_page) as scans:
        result = handler.handle_event({}, context)
    return result, [call.args[2] for call in scans.call_args_list]


def handed_over(context: MagicMock, invoke: MagicMock, event: dict[str, Any] | None = None) -> dict[str, Any]:
    """The payload of the hand-over one invocation ended with."""
    status = handler.handle_event(event or {}, context)['status']
    if status != 'continued':
        raise AssertionError(f'the invocation ended {status!r}, not with a hand-over')
    return invoke.call_args.args[1]


def chain(event: dict[str, Any], context: MagicMock, invoke: MagicMock) -> list[dict[str, Any]]:
    """Run the invocation and every hand-over it starts, in turn; each invocation's result."""
    results = []
    for _ in range(CHAIN_LIMIT):
        result = handler.handle_event(event, context)
        results.append(result)
        if result['status'] != 'continued':
            return results
        event = invoke.call_args.args[1]
    raise AssertionError(f'no end after {CHAIN_LIMIT} invocations')


def pages(*pages: dict[str, Any], steps: list[tuple[str, Any]] | None = None) -> Any:
    """A scan that serves ``pages`` in turn (noting each cursor in ``steps``), and fails past the last one, so a
    walk that never stops fails the test instead of running on."""
    served = iter(pages)

    def scan(cursor: dict | None) -> dict[str, Any]:
        if steps is not None:
            steps.append(('scan', cursor))
        page = next(served, None)
        if page is None:
            raise AssertionError('scanned past the last page')
        return page

    return scan
