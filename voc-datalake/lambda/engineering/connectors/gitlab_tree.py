"""Git tree ids worked out from GitLab's tree listings (docs/autonomous-engineering.md, "Repository connectors": GitLab).

GitLab's REST API answers a commit's files and each tree entry's object id, but never a commit's own tree id, which
is what the board's GO names and what the broker holds every push and pull request to. So the GitLab client works the
tree id out the way git does: a tree object is its entries, sorted as git sorts them (a tree's name as if it ended in
``/``), each ``<mode> <name>\\0<raw object id>``, hashed with its header ``tree <length>\\0``; a blob's id is the hash
of ``blob <length>\\0<content>``. SHA-1, or SHA-256 for a repository whose ids are 64 characters long.

``rebuilt`` works out the tree a set of changes gives on a commit, reading only the directories those changes are in
(and each of their parents up to the root); everything else is the commit's own, by its listed ids. Pure: the host
client hands it the listings.
"""
from __future__ import annotations

import hashlib
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Final

from engineering.connectors.hosts import FileChange

#: The mode GitLab lists a tree entry with, and the one git writes in a tree object.
TREE_MODES: Final = frozenset({'040000', '40000'})
GIT_TREE_MODE: Final = '40000'


@dataclass(frozen=True)
class TreeEntry:
    """One entry of a tree as GitLab lists it: its name, its git mode and its object id."""

    name: str
    mode: str
    object_id: str

    @property
    def is_tree(self) -> bool:
        return self.mode in TREE_MODES


Listing = Mapping[str, TreeEntry]


def _digest(algorithm: str, kind: str, data: bytes) -> str:
    return hashlib.new(algorithm, f'{kind} {len(data)}\0'.encode() + data).hexdigest()


def algorithm_of(object_id: str) -> str:
    """The hash a repository uses, read off one of its object ids (64 characters: SHA-256)."""
    return 'sha256' if len(object_id) == 64 else 'sha1'


def blob_id(content: bytes, algorithm: str) -> str:
    return _digest(algorithm, 'blob', content)


def tree_id(entries: Iterable[TreeEntry], algorithm: str) -> str:
    """The id of the tree object holding ``entries`` (git's order: a tree's name compared as if it ended in ``/``)."""
    ordered = sorted(entries, key=lambda entry: entry.name.encode() + (b'/' if entry.is_tree else b''))
    body = b''.join(f'{GIT_TREE_MODE if entry.is_tree else entry.mode} {entry.name}'.encode() + b'\0'
                    + bytes.fromhex(entry.object_id) for entry in ordered)
    return _digest(algorithm, 'tree', body)


def parent_of(path: str) -> str:
    """The directory ``path`` is in ('' for the root)."""
    return path.rpartition('/')[0]


def directories(paths: Iterable[str]) -> set[str]:
    """Every directory ``paths`` are in, and each of its parents up to the root ('')."""
    found = {''}
    for path in paths:
        directory = parent_of(path)
        while directory and directory not in found:
            found.add(directory)
            directory = parent_of(directory)
    return found


def rebuilt(listing: Callable[[str], Listing], changes: Mapping[str, FileChange], algorithm: str) -> str:
    """The root tree id that ``changes`` (by path: the last change of each) give on the commit ``listing`` reads (a
    directory's entries by name, empty for a directory it does not have). A directory left empty goes, as in git."""
    touched = directories(changes)
    children: dict[str, list[str]] = {}
    for directory in sorted(touched - {''}):
        children.setdefault(parent_of(directory), []).append(directory)

    def build(directory: str) -> str | None:
        entries = dict(listing(directory))
        for path, change in changes.items():
            if parent_of(path) != directory:
                continue
            name = path.rpartition('/')[2]
            if change.content is None:
                entries.pop(name, None)
            else:
                entries[name] = TreeEntry(name, change.mode, blob_id(change.content, algorithm))
        for child in children.get(directory, []):
            name, built = child.rpartition('/')[2], build(child)
            if built is not None:
                entries[name] = TreeEntry(name, GIT_TREE_MODE, built)
            elif name in entries and entries[name].is_tree:
                del entries[name]
        return tree_id(entries.values(), algorithm) if entries or not directory else None

    return build('') or tree_id((), algorithm)   # (the root is always built, empty or not)
