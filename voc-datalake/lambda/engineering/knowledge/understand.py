"""One package through the Understand flow: map its shards, then reduce their notes into a draft version.

This is what the mapper agent runs in its MicroVM (the agent and the flow that starts it land in phase 4; nothing
invokes this yet). One call maps at most ``max_shards`` shards, the run's budget: each shard's notes are written to
the run's workspace once, as ``voc-note/1`` lines under the agent's own key for the shard
(``ws/<ws>/runs/<run>/<agent>/commits/<sha>/<package>/attempt-<n>/<shard>.jsonl``), and the shards already mapped
(``mapped``: shard id -> its key, from the board's result keys) are skipped, so a later call resumes at the first
shard not mapped yet. When none is left, every shard's notes are read back (a key that is not this refresh's own,
or an object that is not there, stops the publish and is named in ``Refreshed.unreadable``, to be mapped again) and
parsed again (what an agent wrote is data: its citations are checked a second time), reduced on top of the latest approved version (its people's edits
kept, contradictions flagged) and published as a draft that names that version as its base.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace

from engineering.knowledge.mapper import map_shard, prepare
from engineering.knowledge.notes import CitationRules, Note, parse_notes
from engineering.knowledge.reduce import reduce_package
from engineering.knowledge.shards import Budget, Entry, file_shards, history_shards, pending, pull_request_shards
from engineering.knowledge.store import Actor, PackStore, PackVersion
from engineering.knowledge.workspaces import Package
from engineering.quality_gate.models import ModelClient
from engineering.workspace.layout import agent_shard_key, parse_agent_key
from engineering.workspace.store import WorkspaceStore


@dataclass(frozen=True)
class Sources:
    """What the broker's reads listed for the package, and how to read one item's text (None: gone)."""

    files: Sequence[Entry]
    commits_newest_first: Sequence[Entry]
    pull_requests: Sequence[Entry]
    read: Callable[[str], str | None]


@dataclass(frozen=True)
class RunPlace:
    """Where the mapper writes: the run, the agent, the commit it read and the attempt (its lease's epoch)."""

    ws: str
    run_id: str
    agent: str
    sha: str
    attempt: int


@dataclass(frozen=True)
class Refreshed:
    #: The draft published, None while shards are left to map.
    version: PackVersion | None
    #: The shards this call mapped, by id -> the key of their notes (for the board's result keys).
    mapped: Mapping[str, str]
    remaining: int
    dropped: Mapping[str, int] = field(default_factory=dict)
    citations_removed: int = 0
    #: Mapped shards whose notes object is not there, or whose key is not this refresh's own (``own_key``): nothing
    #: is published
    #: while any is, since a pack missing a shard's notes would drop its claims silently; map these again (leave
    #: them out of ``mapped``). An empty object is a shard with no notes, not one of these.
    unreadable: tuple[str, ...] = ()


def _count(into: dict[str, int], dropped: Mapping[str, int]) -> None:
    for reason, n in dropped.items():
        into[reason] = into.get(reason, 0) + n


def own_key(key: str, place: RunPlace, package: str, shard_id: str) -> bool:
    """``key`` is this refresh's own notes object for the shard: the workspace's, the run's, the mapper agent's, the
    commit's and the package's, named for the shard (any attempt: a retried lease writes a new one). A result key
    from anywhere else (another workspace, run, agent, commit or package) is never read into this pack."""
    parsed = parse_agent_key(key)
    return parsed is not None and (parsed.ws, parsed.run_id, parsed.agent, parsed.sha, parsed.package, parsed.name) \
        == (place.ws, place.run_id, place.agent, place.sha, package, f'{shard_id}.jsonl')


def understand_package(*, place: RunPlace, connection: str, package: Package, packages: Sequence[Package],
                       sources: Sources, budget: Budget, model: ModelClient, rules: CitationRules,
                       workspace: WorkspaceStore, store: PackStore, mapped: Mapping[str, str], max_shards: int,
                       author: Actor) -> Refreshed:
    """``rules``: the connection's host and repository address; the paths, commits and comments a citation may name
    come from ``sources`` (the package) and, at the map step, from what each shard read."""
    # A note names the shard's own package: one about another package is dropped (counted as ``package``).
    own = {package.path}
    package_rules = replace(rules, paths=frozenset(e.ref for e in sources.files),
                            shas=frozenset(e.ref for e in sources.commits_newest_first), urls=None, lines=None)
    shards = [*file_shards(package.path, sources.files, budget),
              *history_shards(package.path, sources.commits_newest_first, budget),
              *pull_request_shards(package.path, sources.pull_requests, budget)]
    todo = pending(shards, mapped)
    written: dict[str, str] = {}
    dropped: dict[str, int] = {}
    removed = 0
    for shard in todo[:max(0, max_shards)]:
        batch = map_shard(model, shard, prepare(shard, sources.read, package_rules), own)
        key = agent_shard_key(place.ws, place.run_id, place.agent, place.sha, package.path, place.attempt,
                              f'{shard.id}.jsonl')
        # A retried attempt finds its own object already there: it stands, and is what the reduce reads.
        workspace.put_once(key, ''.join(f'{note.to_line()}\n' for note in batch.notes), 'application/x-ndjson')
        written[shard.id] = key
        _count(dropped, batch.dropped)
        removed += batch.citations_removed
    remaining = len(todo) - len(written)
    if remaining:
        return Refreshed(None, written, remaining, dropped, removed)
    notes: list[Note] = []
    unreadable: list[str] = []
    keys = {**mapped, **written}
    for shard in shards:
        key = keys[shard.id]
        text = workspace.read_text(key) if own_key(key, place, package.path, shard.id) else None
        if text is None:
            unreadable.append(shard.id)
            continue
        # Read back, the notes are checked against the package (its files and commits, a comment URL on the
        # repository): the object is the agent's own, under its prefix, and its citations were narrowed to the
        # shard's own reads when it was written.
        batch = parse_notes(text, package.path, package_rules, own)
        notes.extend(batch.notes)
        _count(dropped, batch.dropped)
    if unreadable:
        return Refreshed(None, written, len(unreadable), dropped, removed, tuple(unreadable))
    previous = store.latest_approved(place.ws, connection, package.path)
    pack = reduce_package(package.path, notes, previous.pack if previous else None, packages)
    version = store.publish(place.ws, connection, pack, author=author, reason='refresh', built_from=place.sha,
                            base_version=previous.version.version if previous else 0)
    return Refreshed(version, written, 0, dropped, removed)
