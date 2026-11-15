"""Shards fit the budget: split at directories, again deeper, a big item in byte windows; ids are stable."""
from __future__ import annotations

import pytest

from engineering.knowledge.shards import (
    ITEM_OVERHEAD,
    Budget,
    Entry,
    ShardItem,
    file_shards,
    history_shards,
    pending,
    pull_request_shards,
)

BUDGET = Budget(max_bytes=1000, history_window=3, pr_page=2)


def refs(shards: list) -> list[list[str]]:
    return [[item.ref for item in shard.items] for shard in shards]


def test_a_package_within_the_budget_is_one_shard() -> None:
    shards = file_shards('packages/web', [Entry('b.ts', 10), Entry('a.ts', 10), Entry('a.ts', 10)], BUDGET)
    assert refs(shards) == [['a.ts', 'b.ts']]
    assert (shards[0].kind, shards[0].package, shards[0].size) == ('files', 'packages/web', 20)
    assert file_shards('empty', [], BUDGET) == []


def test_a_package_over_the_budget_splits_at_its_directories_and_siblings_share_again() -> None:
    files = [Entry('src/a/one.ts', 400), Entry('src/a/two.ts', 300), Entry('src/b/x.ts', 100), Entry('src/c/y.ts', 100),
             Entry('test/t.ts', 200)]
    shards = file_shards('web', files, BUDGET)
    # src/ is over the budget alone: split at its subdirectories, a/ and b/ fit together again, c/ starts the next.
    assert refs(shards) == [['src/a/one.ts', 'src/a/two.ts', 'src/b/x.ts'], ['src/c/y.ts'], ['test/t.ts']]
    assert all(item.end is None for shard in shards for item in shard.items)   # whole files
    assert all(shard.size + ITEM_OVERHEAD * len(shard.items) <= BUDGET.max_bytes for shard in shards)


def test_a_directory_still_over_the_budget_is_split_again_deeper() -> None:
    files = [Entry(f'src/deep/{name}.ts', 400) for name in 'abcd']
    shards = file_shards('web', files, BUDGET)
    assert refs(shards) == [['src/deep/a.ts', 'src/deep/b.ts'], ['src/deep/c.ts', 'src/deep/d.ts']]


def test_a_single_file_over_the_budget_is_read_in_byte_windows() -> None:
    shards = file_shards('web', [Entry('big.json', 2000), Entry('small.ts', 5)], BUDGET)
    step = BUDGET.max_bytes - ITEM_OVERHEAD
    assert [s.items for s in shards] == [
        (ShardItem('big.json', 0, step),), (ShardItem('big.json', step, 2 * step),),
        (ShardItem('big.json', 2 * step, 2000),), (ShardItem('small.ts'),)]
    assert [s.size for s in shards] == [step, step, 2000 - 2 * step, 5]


def test_ids_are_stable_and_tell_shards_apart() -> None:
    files = [Entry('a.ts', 600), Entry('b.ts', 600)]
    first, again = file_shards('web', files, BUDGET), file_shards('web', list(reversed(files)), BUDGET)
    assert [s.id for s in first] == [s.id for s in again]
    assert len({s.id for s in first}) == 2
    assert first[0].id.startswith('files-')
    assert len(first[0].id) == len('files-') + 16
    assert file_shards('api', files, BUDGET)[0].id != first[0].id   # the package is part of the id


def test_history_windows_run_oldest_first_so_new_commits_change_only_the_last() -> None:
    newest_first = [Entry(f'{n:040x}', 10) for n in range(7, 0, -1)]   # commit 7 is the newest
    shards = history_shards('web', newest_first, BUDGET)
    assert [len(s.items) for s in shards] == [3, 3, 1]
    assert shards[0].items[0].ref == f'{1:040x}'
    grown = history_shards('web', [Entry(f'{8:040x}', 10), *newest_first], BUDGET)
    assert [s.id for s in grown[:2]] == [s.id for s in shards[:2]]
    assert grown[2].id != shards[2].id


def test_a_window_over_the_budget_is_halved_and_a_huge_commit_windowed() -> None:
    commits = [Entry('1' * 40, 600), Entry('2' * 40, 600), Entry('3' * 40, 2000)]
    shards = history_shards('web', list(reversed(commits)), BUDGET)
    assert refs(shards) == [['1' * 40], ['2' * 40], ['3' * 40], ['3' * 40], ['3' * 40]]
    assert shards[-1].items[0].end == 2000


def test_pull_requests_come_in_pages_by_number() -> None:
    prs = [Entry(str(n), 50) for n in (12, 3, 40, 7, 12)]
    shards = pull_request_shards('web', prs, BUDGET)
    assert refs(shards) == [['3', '7'], ['12', '40']]
    assert shards[0].id.startswith('pull-requests-')


def test_a_run_resumes_at_the_first_shard_not_mapped() -> None:
    shards = file_shards('web', [Entry('a.ts', 600), Entry('b.ts', 600), Entry('c.ts', 600)], BUDGET)
    assert pending(shards, {shards[0].id}) == shards[1:]
    assert pending(shards, {s.id for s in shards}) == []


@pytest.mark.parametrize('budget', [{'max_bytes': ITEM_OVERHEAD}, {'history_window': 0}, {'pr_page': 0}])
def test_a_budget_holds_at_least_one_item(budget: dict[str, int]) -> None:
    with pytest.raises(ValueError, match='at least one item'):
        Budget(**budget)
