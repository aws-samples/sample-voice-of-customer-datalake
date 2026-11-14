"""The checkout cache's layout and its pure rules (docs/autonomous-engineering.md, "The checkout cache").

One immutable entry per (connection, commit, generation), in the raw bucket::

    engineering/cache/<connection>/<commit>/g<N>/repo.git/...   a bare repository holding exactly that commit at depth 1
    engineering/cache/<connection>/<commit>/g<N>/READY          its manifest, written last and create-only

The generation ``N`` is ``floor(epoch seconds / GENERATION_SECONDS)`` (14 days), from the caller's clock: a fill writes
the current one, and a reader takes READY of generation ``N``, or of ``N - 1`` when its manifest was written under
``PREVIOUS_USABLE_DAYS`` (28) ago. The cache's lifecycle rule expires every object 30 days after it was written, so an
entry in use is always at least two days from its expiry, and none is ever rewritten: when neither is usable, a new
generation is filled beside the old one.

The repository has one ref, ``refs/heads/voc-base`` (HEAD points to it), ``uploadpack.allowFilter`` on, and its
objects in one pack; the ref stays a loose file (S3 has no empty directory, and git opens a repository only with its
``refs/``). An entry is complete only once ``READY`` exists: nobody reads one without it, so a fill redone after a
failed one may overwrite the files of the same names under ``repo.git/`` (the bucket is versioned: the old ones
become noncurrent versions, which the cache's rule expires a day later) and leave a pack of another name the
manifest does not list (the same commit's objects: harmless), never ``READY`` (``If-None-Match: *``). Each session mounts its connection's
prefix read-only and clones ``/mnt/voc-cache/<commit>/g<N>/repo.git`` (``runtime/checkout.py``).

The filler (``cache.py``) and the runtime's check of an entry (``runtime/checkout_cache.py``) share these rules: the
inputs' shapes, the generations, the keys, the claim's row, the size caps and the manifest. Nothing here does IO.
"""
from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final

from engineering.connectors.connections import CONNECTION_ID
from engineering.connectors.identity import WORKSPACE
from engineering.runtime.checkout import COMMIT_RE, GIT_DIR, check_generation

CACHE_PREFIX: Final = 'engineering/cache/'
#: The entry's bare repository, under its generation (``runtime/checkout.py`` clones ``<commit>/g<N>/repo.git``): the
#: same name as an agent's own git directory.
REPOSITORY_DIR: Final = GIT_DIR
READY: Final = 'READY'
#: One generation of the cache: an entry of the current generation is at most this old.
GENERATION_SECONDS: Final = 14 * 86_400
#: The previous generation's entry is used only while its manifest is younger than this (the lifecycle rule expires it
#: at 30 days: two days to spare).
PREVIOUS_USABLE_DAYS: Final = 28
#: The entry's one ref; HEAD points to it.
BASE_REF: Final = 'refs/heads/voc-base'
MANIFEST_FORMAT: Final = 2
WRITTEN_AT_FORMAT: Final = '%Y-%m-%dT%H:%M:%SZ'
#: The most an entry may hold, all its files together: a commit whose checkout is larger is refused, saying so
#: (the filler's time and its ephemeral storage are sized for it: lib/stacks/engineering-cache.ts).
MAX_ENTRY_BYTES: Final = 1024 * 1024 * 1024
#: The most files an entry may hold (a packed bare repository has a handful).
MAX_ENTRY_FILES: Final = 1000
#: The claim rows' partition per connection, beside the runs' (``WS#<ws>#RUN#<run>``) and their writes'.
CLAIM_PARTITION: Final = 'WS#{ws}#CACHE#{connection}'
CLAIM_KEY: Final = 'COMMIT#{commit}#G#{generation}'
#: The writer's refusals of the run's commit itself (cache.py ``fetch_refusal``): a Resume keeps the commit, so the
#: runtime's words after them say what else helps (runtime/handler.py ``_refusal_ending``).
NO_COMMIT: Final = ('the run\'s commit is not on the repository host (git: no such commit): push it to the '
                    'connection\'s repository, or start the run on a commit that is there')
FSCK_REJECTED: Final = ('the commit\'s objects failed git\'s integrity check (fsck) as they were fetched: someone checks '
                        'the repository (git fsck) and starts the run on a commit without the malformed object')
_MB: Final = 1024 * 1024
_DAY: Final = 86_400


class EntryRefused(ValueError):
    """A fill the cache will not make: a connection, commit or generation off its shape, an entry over a cap, a
    connection with no usable credential. The reason is a plain sentence, never a credential or a host's answer."""


@dataclass(frozen=True)
class EntryFile:
    """One file of an entry's repository: its path under ``repo.git/``, its size and its sha256."""

    path: str
    size: int
    sha256: str


def generation_at(now: float) -> int:
    """The cache's generation at ``now`` (epoch seconds)."""
    return int(now // GENERATION_SECONDS)


def check_entry(connection: str, commit: str, generation: int) -> None:
    """Refuse a connection id that is not a stored connection's shape, a commit that is not a full object id, or a
    generation that is not a small non-negative integer."""
    if not CONNECTION_ID.fullmatch(connection):
        raise EntryRefused('the connection is not a connection id (lower-case letters, digits and "-")')
    if not COMMIT_RE.match(commit):
        raise EntryRefused('the commit is not a full commit id (40 or 64 lower-case hexadecimal characters)')
    try:
        check_generation(generation)
    except ValueError as refused:
        raise EntryRefused(str(refused)) from None


def entry_prefix(connection: str, commit: str, generation: int) -> str:
    """``engineering/cache/<connection>/<commit>/g<N>/``, after ``check_entry``."""
    check_entry(connection, commit, generation)
    return f'{CACHE_PREFIX}{connection}/{commit}/g{generation}/'


def ready_key(connection: str, commit: str, generation: int) -> str:
    return f'{entry_prefix(connection, commit, generation)}{READY}'


def file_key(connection: str, commit: str, generation: int, path: str) -> str:
    """The key of ``path`` (relative to ``repo.git/``): never one that leaves the entry's repository."""
    parts = path.split('/')
    if not path or any(part in {'', '.', '..'} for part in parts) or any(ord(c) < 32 or c == '\\' for c in path):
        raise EntryRefused('a cached file is a plain path inside the repository')
    return f'{entry_prefix(connection, commit, generation)}{REPOSITORY_DIR}/{path}'


def claim_key(connection: str, commit: str, generation: int) -> dict[str, dict[str, str]]:
    """The claim row's key in voc-engineering (low-level form): one row per (connection, commit, generation)."""
    check_entry(connection, commit, generation)
    return {'pk': {'S': CLAIM_PARTITION.format(ws=WORKSPACE, connection=connection)},
            'sk': {'S': CLAIM_KEY.format(commit=commit, generation=generation)}}


def previous_usable(written_at: str, now: float) -> bool:
    """Whether the previous generation's entry, its manifest written at ``written_at``, may still be used at ``now``:
    under ``PREVIOUS_USABLE_DAYS`` old. A manifest whose time does not read is not used."""
    try:
        written = datetime.strptime(written_at, WRITTEN_AT_FORMAT).replace(tzinfo=UTC).timestamp()
    except ValueError:
        return False
    return now - written < PREVIOUS_USABLE_DAYS * _DAY


def check_size(files: Sequence[EntryFile], max_bytes: int = MAX_ENTRY_BYTES) -> int:
    """The entry's total size, or ``EntryRefused`` when it holds more than ``max_bytes`` or ``MAX_ENTRY_FILES``."""
    if len(files) > MAX_ENTRY_FILES:
        raise EntryRefused(f'the commit\'s repository has more than {MAX_ENTRY_FILES} files once packed')
    total = sum(entry.size for entry in files)
    if total > max_bytes:
        raise EntryRefused(f'the commit\'s repository is {-(-total // _MB)} MB, over the checkout cache\'s cap of '
                           f'{max_bytes // _MB} MB: work on a smaller repository, or raise the cap')
    return total


def manifest(connection: str, repository: str, commit: str, generation: int, files: Sequence[EntryFile],
             written_at: float) -> bytes:
    """``READY``'s body: the format, the repository (``owner/name``: the runtime launches no run of another on it), the
    commit, its generation and its ref, every file with its size and sha256, the total and when it was written (UTC).
    Sorted, so one entry always has one manifest. The files were held to the caps (``check_size``) before any was
    uploaded."""
    listed = sorted(files, key=lambda entry: entry.path)
    return json.dumps({
        'format': MANIFEST_FORMAT, 'connection': connection, 'repository': repository, 'commit': commit,
        'generation': generation, 'ref': BASE_REF,
        'files': [{'path': f'{REPOSITORY_DIR}/{entry.path}', 'size': entry.size, 'sha256': entry.sha256}
                  for entry in listed],
        'bytes': sum(entry.size for entry in listed),
        'written_at': datetime.fromtimestamp(written_at, UTC).strftime(WRITTEN_AT_FORMAT),
    }, sort_keys=True, separators=(',', ':')).encode()
