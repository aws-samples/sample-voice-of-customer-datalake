"""The spend ledger pinned where its redundant code came out (spend.py): the flow's month total is a Decimal sum of
the write's models, and a month's read pages only as far as its row cap needs (one bound: the read's own count)."""
from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest

from engineering import spend
from engineering.spend import MICROVM, Usage, Where, ledger_updates, month_spend

AT = datetime(2026, 11, 30, 23, 30, tzinfo=UTC)


class Pages:
    """A table whose query answers ``pages`` one after another (a cursor between them), counting the requests."""

    def __init__(self, pages: list[list[dict[str, Any]]]) -> None:
        self.pages = pages
        self.requests: list[dict[str, Any]] = []

    def query(self, **request: Any) -> dict[str, Any]:
        self.requests.append(request)
        page = len(self.requests) - 1
        answer: dict[str, Any] = {'Items': list(self.pages[page])}
        if page + 1 < len(self.pages):
            answer['LastEvaluatedKey'] = {'pk': 'p', 'sk': f'page-{page}'}
        return answer


def _pages(count: int, size: int) -> list[list[dict[str, Any]]]:
    return [[{'run_id': f'RUN{page}-{row}', 'usd': Decimal(1)} for row in range(size)] for page in range(count)]


@pytest.mark.parametrize(('cap', 'read', 'truncated'), [
    (3, 2, True),    # (row 4, on the second page, says the month is past its cap: the third page is never read)
    (4, 3, True),    # (row 5 is on the third)
    (6, 3, False),   # (every row within the cap: every page)
    (5, 3, True),
])
def test_a_months_read_pages_only_as_far_as_its_row_cap_needs(monkeypatch: pytest.MonkeyPatch, cap: int, read: int,
                                                              truncated: bool) -> None:
    monkeypatch.setattr(spend, 'MAX_ROWS', cap)
    table = Pages(_pages(3, 2))
    spent = month_spend(table, '2026-11', 'run')
    assert (len(table.requests), spent.truncated, spent.total.usd) == (read, truncated, Decimal(min(cap, 6)))
    assert [request.get('ExclusiveStartKey') for request in table.requests][1:] == [
        {'pk': 'p', 'sk': f'page-{page}'} for page in range(read - 1)]


def test_a_months_read_asks_no_page_size_of_its_own() -> None:
    # (the read pages as DynamoDB pages it; the cap is the read's own count, never a request's Limit)
    table = Pages(_pages(1, 1))
    month_spend(table, '2026-11', 'day')
    assert set(table.requests[0]) == {'KeyConditionExpression', 'ExpressionAttributeValues'}


def test_the_flows_total_is_the_decimal_sum_of_the_writes_models() -> None:
    usage = {MICROVM: Usage(usd=Decimal('0.10'), microvm_seconds=6), 'a': Usage(usd=Decimal('0.20'), tokens_in=1),
             'b': Usage(usd=Decimal('0.0000001'), tokens_out=1)}
    total = ledger_updates('t', AT, Where('RUN1', 'fixer-1', 'wf'), usage)[-1]['Update']
    usd = total['ExpressionAttributeValues'][':usd']
    assert (total['Key']['sk'], type(usd), usd) == ('FLOW#wf', Decimal, Decimal('0.3000001'))


def test_one_priced_model_is_its_own_total() -> None:
    total = ledger_updates('t', AT, Where('RUN1', 'fixer-1', 'wf'), {'a': Usage(usd=Decimal('2.5'))})[-1]['Update']
    assert total['ExpressionAttributeValues'][':usd'] == Decimal('2.5')


class Total:
    """A table holding one flow's month total, recording each GetItem."""

    def __init__(self, usd: Decimal | None) -> None:
        self.usd = usd
        self.asked: list[dict[str, Any]] = []

    def get_item(self, **request: Any) -> dict[str, Any]:
        self.asked.append(request)
        return {} if self.usd is None else {'Item': {'usd': self.usd}}


@pytest.mark.parametrize(('usd', 'spent'), [(Decimal('12.5'), Decimal('12.5')), (None, Decimal(0))])
def test_a_flows_month_is_one_strongly_consistent_read_of_its_total(usd: Decimal | None, spent: Decimal) -> None:
    # (read right after the tick's own writes: an eventually consistent read could miss a level they passed)
    table = Total(usd)
    assert spend.flow_month_usd(table, '2026-11', 'wf') == spent
    assert table.asked == [{'Key': {'pk': 'WS#default#SPEND#2026-11', 'sk': 'FLOW#wf'}, 'ConsistentRead': True}]


def test_rows_of_one_group_add_up_in_it() -> None:
    rows = [{'run_id': 'RUN1', 'usd': Decimal(1), 'tokens_in': 2}, {'run_id': 'RUN2', 'usd': Decimal(5)},
            {'run_id': 'RUN1', 'usd': Decimal('0.5'), 'tokens_in': 3}]
    spent = month_spend(Pages([rows]), '2026-11', 'run')
    assert spent.groups == {'RUN1': Usage(usd=Decimal('1.5'), tokens_in=5), 'RUN2': Usage(usd=Decimal(5))}
