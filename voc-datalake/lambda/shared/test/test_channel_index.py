"""`walk_channel` (shared/channel_index.py): paging, the cap, the walk budget, a missing index.

Also pins `CHANNEL_INDEX_FIELDS` to the `nonKeyAttributes` of `gsi5-by-channel` in
lib/stacks/core-stack.ts: the routes read those fields off the rows, so a field added on
one side only would quietly read as absent.
"""
import re
from unittest.mock import MagicMock

import pytest
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

from shared.channel_index import CHANNEL_INDEX_FIELDS, ChannelIndexUnavailable, walk_channel
from shared.test.repo_paths import repo_root
from shared.time_budget import WalkBudget


def _rows(*stamps: str) -> list[dict]:
    return [{'pk': 'p', 'sk': stamp, 'gsi1sk': f'{stamp}T08:00:00+00:00#x'} for stamp in stamps]


def _table(*pages: dict) -> MagicMock:
    table = MagicMock()
    table.query.side_effect = list(pages)
    return table


def _budget(exhausted: bool = False) -> WalkBudget:
    return WalkBudget(seconds=-1 if exhausted else 60)


def _error(code: str, message: str) -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': message}}, 'Query')


def test_the_projection_matches_the_stack():
    source = (repo_root() / 'lib' / 'stacks' / 'core-stack.ts').read_text()
    block = re.search(r"indexName: 'gsi5-by-channel',.*?nonKeyAttributes: \[(.*?)\]", source, re.DOTALL)
    assert block is not None
    assert tuple(re.findall(r"'([a-z_]+)'", block.group(1))) == CHANNEL_INDEX_FIELDS


def test_reads_every_page_newest_first_from_the_cutoff():
    table = _table({'Items': _rows('2026-10-22'), 'LastEvaluatedKey': {'k': 1}}, {'Items': _rows('2026-10-21')})
    rows, partial = walk_channel(table, 'google_play', '2026-10-20', _budget(), row_filter=Attr('source_platform').eq('x'))
    assert ([r['sk'] for r in rows], partial) == (['2026-10-22', '2026-10-21'], False)
    first, second = (call.kwargs for call in table.query.call_args_list)
    key = first['KeyConditionExpression'].get_expression()
    assert [part.get_expression()['values'][1] for part in key['values']] == ['google_play', '2026-10-20']
    assert (first['IndexName'], first['ScanIndexForward'], 'FilterExpression' in first) == ('gsi5-by-channel', False, True)
    assert second['ExclusiveStartKey'] == {'k': 1}


def test_no_filter_sends_no_filter_expression():
    table = _table({'Items': []})
    walk_channel(table, 'soz', '2026-10-20', _budget())
    assert 'FilterExpression' not in table.query.call_args.kwargs


def test_stops_at_the_cap_and_claims_only_the_days_after_the_last_row():
    budget = _budget()
    table = _table({'Items': _rows('2026-10-22', '2026-10-21', '2026-10-21'), 'LastEvaluatedKey': {'k': 1}})
    rows, partial = walk_channel(table, 'soz', '2026-10-01', budget, cap=2)
    assert (len(rows), partial, budget.scanned_through) == (2, True, '2026-10-22')
    assert budget.partial_reason == 'row_cap'
    assert table.query.call_count == 1


def test_a_last_page_at_the_cap_is_complete():
    rows, partial = walk_channel(_table({'Items': _rows('2026-10-22', '2026-10-21')}), 'soz', '2026-10-01', _budget(), cap=2)
    assert (len(rows), partial) == (2, False)


def test_stops_when_the_walk_budget_runs_out():
    budget = _budget(exhausted=True)
    table = _table({'Items': _rows('2026-10-22'), 'LastEvaluatedKey': {'k': 1}})
    rows, partial = walk_channel(table, 'soz', '2026-10-01', budget)
    assert (len(rows), partial, budget.scanned_through) == (1, True, '2026-10-23')
    assert budget.partial_reason == 'time_budget'


def test_an_empty_stopped_page_claims_nothing_newer_than_the_cutoff():
    budget = _budget(exhausted=True)
    walk_channel(_table({'Items': [], 'LastEvaluatedKey': {'k': 1}}), 'soz', '2026-10-01', budget)
    assert budget.scanned_through == '2026-10-01'


@pytest.mark.parametrize('error', [
    _error('ValidationException', 'The table does not have the specified index: gsi5-by-channel'),
    _error('ResourceNotFoundException', 'Invalid index: gsi5-by-channel for table: t'),
])
def test_a_missing_index_is_reported_for_the_fallback(error):
    table = MagicMock()
    table.query.side_effect = error
    with pytest.raises(ChannelIndexUnavailable):
        walk_channel(table, 'soz', '2026-10-01', _budget())


@pytest.mark.parametrize('error', [
    _error('ValidationException', 'Invalid FilterExpression: syntax error'),
    _error('ResourceNotFoundException', 'Requested resource not found: Table: t not found'),
    _error('ProvisionedThroughputExceededException', 'slow down'),
])
def test_any_other_error_surfaces(error):
    table = MagicMock()
    table.query.side_effect = error
    with pytest.raises(ClientError):
        walk_channel(table, 'soz', '2026-10-01', _budget())
