"""Cutting a package into shards that each fit one small model call (the map step of the knowledge pack).

Three kinds of shard, each from what the host's read paths return:

- ``files``: the package's files, in path order, so a directory stays together. A package over the budget is split
  at its subdirectories (siblings small enough share a shard again), and a part still over it is split again,
  deeper; a single file over the budget is read in byte windows (``ShardItem.start`` / ``end``).
- ``history``: the commits that touched the package in windows of ``history_window``, oldest first, so a refresh
  that adds commits changes only the last window and every earlier window keeps its id (it was mapped already).
- ``pull_requests``: the package's pull requests by number in pages of ``pr_page``.

A window or page over the byte budget is halved again, and one commit or pull request over it is read in byte
windows like a file. Each item costs its size plus ``ITEM_OVERHEAD`` (its header in the prompt), so a shard of
empty files is bounded too. A shard's id is a hash of its package, kind and items: the same cut of the same input
always has the same ids, and a run resumes at the first shard whose id it has not mapped yet (``pending``).
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass
from typing import Literal

ShardKind = Literal['files', 'history', 'pull_requests']
ITEM_OVERHEAD = 64


@dataclass(frozen=True)
class Budget:
    #: What one shard may hold, in bytes of repository text: about 12k tokens for one small model call.
    max_bytes: int = 48_000
    history_window: int = 50
    pr_page: int = 20

    def __post_init__(self) -> None:
        if self.max_bytes <= ITEM_OVERHEAD or self.history_window < 1 or self.pr_page < 1:
            raise ValueError('a budget holds at least one item')


@dataclass(frozen=True)
class Entry:
    """Something to map: a file path, a commit sha or a pull request number, with its size in bytes."""

    ref: str
    size: int


@dataclass(frozen=True)
class ShardItem:
    ref: str
    #: The byte window to read, ``end`` excluded; ``end`` None reads the whole item.
    start: int = 0
    end: int | None = None


@dataclass(frozen=True)
class Shard:
    id: str
    package: str
    kind: ShardKind
    items: tuple[ShardItem, ...]
    size: int


def _cost(entry: Entry) -> int:
    return max(0, entry.size) + ITEM_OVERHEAD


def _windows(entry: Entry, budget: int) -> list[list[ShardItem]]:
    step = budget - ITEM_OVERHEAD
    return [[ShardItem(entry.ref, start, min(start + step, entry.size))] for start in range(0, entry.size, step)]


def _depth(entries: Sequence[Entry]) -> int:
    """How many leading path segments every entry shares (its directory, for files)."""
    split = [entry.ref.split('/') for entry in entries]
    depth = 0
    while all(len(parts) > depth + 1 and parts[depth] == split[0][depth] for parts in split):
        depth += 1
    return depth


def _by_directory(entries: Sequence[Entry], budget: int) -> list[list[Entry]]:
    """The entries by what is right below their shared directory (a subdirectory's files together, each file on
    its own), adjacent groups merged again while they fit: always two parts or more for entries over the budget."""
    depth = _depth(entries)
    groups: list[list[Entry]] = []
    keys: list[str | None] = []
    for entry in entries:
        parts = entry.ref.split('/')
        key = parts[depth] if len(parts) > depth + 1 else None
        if key is not None and keys and keys[-1] == key:
            groups[-1].append(entry)
        else:
            groups.append([entry])
            keys.append(key)
    merged: list[list[Entry]] = []
    for group in groups:
        if merged and sum(map(_cost, merged[-1])) + sum(map(_cost, group)) <= budget:
            merged[-1].extend(group)
        else:
            merged.append(list(group))
    return merged


def _halves(entries: Sequence[Entry]) -> list[list[Entry]]:
    middle = len(entries) // 2
    return [list(entries[:middle]), list(entries[middle:])]


def _cut(entries: Sequence[Entry], budget: int, *, by_directory: bool) -> list[list[ShardItem]]:
    if sum(map(_cost, entries)) <= budget:
        return [[ShardItem(entry.ref) for entry in entries]] if entries else []
    if len(entries) == 1:
        return _windows(entries[0], budget)
    parts = _by_directory(entries, budget) if by_directory else _halves(entries)
    return [items for part in parts for items in _cut(part, budget, by_directory=by_directory)]


def shard_id(package: str, kind: ShardKind, items: Sequence[ShardItem]) -> str:
    canonical = json.dumps([package, kind, [[i.ref, i.start, i.end] for i in items]], separators=(',', ':'))
    return f'{kind.replace("_", "-")}-{hashlib.sha256(canonical.encode()).hexdigest()[:16]}'


def _shards(package: str, kind: ShardKind, cuts: Iterable[list[ShardItem]], sizes: dict[str, int]) -> list[Shard]:
    def size(item: ShardItem) -> int:
        whole = max(0, sizes[item.ref])
        return (whole if item.end is None else item.end) - item.start

    return [Shard(shard_id(package, kind, items), package, kind, tuple(items), sum(map(size, items)))
            for items in cuts]


def file_shards(package: str, files: Iterable[Entry], budget: Budget) -> list[Shard]:
    ordered = sorted({entry.ref: entry for entry in files}.values(), key=lambda entry: entry.ref)
    sizes = {entry.ref: entry.size for entry in ordered}
    return _shards(package, 'files', _cut(ordered, budget.max_bytes, by_directory=True), sizes)


def _paged(package: str, kind: ShardKind, entries: Sequence[Entry], page: int, budget: Budget) -> list[Shard]:
    sizes = {entry.ref: entry.size for entry in entries}
    cuts = [items for start in range(0, len(entries), page)
            for items in _cut(entries[start:start + page], budget.max_bytes, by_directory=False)]
    return _shards(package, kind, cuts, sizes)


def history_shards(package: str, commits_newest_first: Sequence[Entry], budget: Budget) -> list[Shard]:
    """``commits_newest_first``: as the host's history read pages them (each commit's size: its message and diff
    stat, as read)."""
    return _paged(package, 'history', list(reversed(commits_newest_first)), budget.history_window, budget)


def pull_request_shards(package: str, pull_requests: Iterable[Entry], budget: Budget) -> list[Shard]:
    """``pull_requests``: each by its number (as text) and the size of its conversation and review threads."""
    ordered = sorted({entry.ref: entry for entry in pull_requests}.values(), key=lambda entry: int(entry.ref))
    return _paged(package, 'pull_requests', ordered, budget.pr_page, budget)


def pending(shards: Sequence[Shard], mapped: Collection[str]) -> list[Shard]:
    """The shards not mapped yet, in order: where a run that stopped at its budget resumes."""
    return [shard for shard in shards if shard.id not in mapped]
