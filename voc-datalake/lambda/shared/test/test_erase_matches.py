"""``shared/retention.py`` ``erase_matches`` is ``erase_filter`` evaluated in Python on one row (7.96.00).

A workspace's erasure finds candidates by index (lambda/jobs/retention/item_walk.py), reads each row again from the
table and acts only on a row that still matches. That second test must be the Scan's own rule: rows are generated, put
in a moto voc-feedback, Scanned with ``erase_filter`` (DynamoDB's semantics, as moto evaluates them), and the rows the
Scan returns must be exactly those ``erase_matches`` accepts, for every field, value spelling, source and scope.
"""
from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from typing import Any, Final

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from shared import retention
from shared.test.ws_properties import PROPERTY, EmptiedAfter, moto_pk_sk_table
from shared.ws_repo import WorkspaceScope

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_TWO = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
JANE, JANE_EMAIL = 'Jane Doe', 'jane@example.com'
EMAILS = [JANE_EMAIL, 'Jane@Example.com', 'JANE@EXAMPLE.COM', 'john@example.com', ' jane@example.com ']
VALUES = st.sampled_from([JANE, 'John Roe', '12345', 'row-7', *EMAILS])
PARTITIONS = st.sampled_from(['SOURCE#web', 'SOURCE#tickets', f'WS#{WS}#SOURCE#web', f'WS#{WS}#SOURCE#tickets',
                              f'WS#{WS_TWO}#SOURCE#web', f'WS#{WS_TWO}#SOURCE#tickets', 'WSX#SOURCE#web'])
#: Mostly feedback rows (the other two each fail the ``FEEDBACK#`` rule), so most rows test the rest of it.
SORT_KEYS = st.sampled_from(['FEEDBACK#'] * 4 + ['OTHER#', 'feedback#'])
#: An attribute as a row may hold it: absent (None), a string, or another type.
FIELD_VALUES = st.one_of(st.none(), VALUES, st.just(Decimal(12345)), st.just(['Jane Doe']))
METADATA = st.one_of(
    st.none(), st.just('jane@example.com'),
    st.fixed_dictionaries({}, optional={'email': FIELD_VALUES, 'submitter_email': FIELD_VALUES, 'name': VALUES}))


def _near(value: str) -> st.SearchStrategy[Any]:
    """An attribute drawn around the job's ``value``: the value itself (most often), another spelling of it, any other
    value, absent (None) or another type, so most rows are close to matching and each rule is put to the test."""
    return st.sampled_from([value] * 4 + [value.upper(), value.lower(), value.strip(), None]) | FIELD_VALUES


#: Every job a row is judged against: each field, in the deployment and (but the whole source) in each workspace.
JOBS: Final = [(field, ws) for field in (*retention.WORKSPACE_ERASE_FIELDS, retention.SOURCE_FIELD)
               for ws in ((None,) if field == retention.SOURCE_FIELD else (None, WS, WS_TWO))]


@st.composite
def cases(draw: st.DrawFn) -> tuple[list[dict[str, Any]], str, str | None]:
    """A job's value and source, and 1 to 8 rows around them, each its own key (``JOBS`` judges every row)."""
    value, source = draw(VALUES), draw(st.sampled_from([None, 'web', 'tickets']))
    found = []
    for n in range(draw(st.integers(min_value=1, max_value=8))):
        row: dict[str, Any] = {'pk': draw(PARTITIONS), 'sk': f'{draw(SORT_KEYS)}{n}'}
        for name in ('author', 'source_id', 'csv_row_id'):
            drawn = draw(_near(value))
            if drawn is not None:
                row[name] = drawn
        platform = draw(st.sampled_from([source or 'web'] * 3 + [None, 'web', 'tickets']) | _near(value))
        if platform is not None:
            row['source_platform'] = platform
        metadata = draw(st.one_of(METADATA, st.fixed_dictionaries(
            {}, optional={'email': _near(value), 'submitter_email': _near(value)})))
        if metadata is not None:
            row['metadata'] = {k: v for k, v in metadata.items() if v is not None} if isinstance(metadata, dict) \
                else metadata
        found.append(row)
    return found, value, source


@pytest.fixture(scope='module')
def table() -> Iterator[Any]:
    yield from moto_pk_sk_table('test-erase-matches')


def _scanned(table: Any, condition: Any) -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    kwargs: dict[str, Any] = {'FilterExpression': condition}
    for _page in range(100):
        page = table.scan(**kwargs)
        found |= {(item['pk'], item['sk']) for item in page['Items']}
        if 'LastEvaluatedKey' not in page:
            return found
        kwargs['ExclusiveStartKey'] = page['LastEvaluatedKey']
    raise AssertionError('scanned past 100 pages')


@settings(PROPERTY, max_examples=150)
@given(cases())
def test_the_python_rule_is_the_scans_filter(table, case):
    generated, value, source = case
    with EmptiedAfter(table):
        for row in generated:
            table.put_item(Item=row)
        for field, ws in JOBS:
            scope = WorkspaceScope(ws) if ws else None
            expected = _scanned(table, retention.erase_filter(field, value, source, retention.STORE_FEEDBACK, scope))
            matched = {(row['pk'], row['sk']) for row in generated
                       if retention.erase_matches(row, field, value, source, scope)}
            assert matched == expected, (field, ws)


class TestTheRule:
    def test_a_workspace_job_matches_its_own_partition_only(self):
        row = {'pk': f'WS#{WS}#SOURCE#web', 'sk': 'FEEDBACK#a', 'author': JANE, 'source_platform': 'web'}
        assert retention.erase_matches(row, 'author', JANE, None, WorkspaceScope(WS))
        assert not retention.erase_matches(row, 'author', JANE, None, WorkspaceScope(WS_TWO))
        assert not retention.erase_matches({**row, 'pk': 'SOURCE#web'}, 'author', JANE, None, WorkspaceScope(WS))

    def test_the_email_is_the_value_as_typed_or_lower_cased_on_either_field(self):
        scope = WorkspaceScope(WS)
        base = {'pk': f'WS#{WS}#SOURCE#web', 'sk': 'FEEDBACK#a'}
        assert retention.erase_matches({**base, 'metadata': {'email': JANE_EMAIL}}, 'email', 'Jane@Example.com',
                                       None, scope)
        assert retention.erase_matches({**base, 'metadata': {'submitter_email': 'Jane@Example.com'}}, 'email',
                                       'Jane@Example.com', None, scope)
        assert not retention.erase_matches({**base, 'metadata': {'email': 'JANE@EXAMPLE.COM'}}, 'email',
                                           'Jane@Example.com', None, scope)
        assert not retention.erase_matches({**base, 'metadata': JANE_EMAIL}, 'email', JANE_EMAIL, None, scope)

    def test_a_source_narrows_it(self):
        row = {'pk': f'WS#{WS}#SOURCE#web', 'sk': 'FEEDBACK#a', 'csv_row_id': 'row-7', 'source_platform': 'web'}
        assert retention.erase_matches(row, 'csv_row_id', 'row-7', 'web', WorkspaceScope(WS))
        assert not retention.erase_matches(row, 'csv_row_id', 'row-7', 'tickets', WorkspaceScope(WS))

    def test_it_refuses_what_the_filter_refuses(self):
        row = {'pk': f'WS#{WS}#SOURCE#web', 'sk': 'FEEDBACK#a'}
        with pytest.raises(ValueError, match='Unknown erasure field'):
            retention.erase_matches(row, 'title', 'x', None)
        with pytest.raises(ValueError, match='cannot erase by "source"'):
            retention.erase_matches(row, 'source', 'web', 'web', WorkspaceScope(WS))
