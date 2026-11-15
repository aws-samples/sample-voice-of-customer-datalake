"""An agent's checkout: a sparse, blob-less clone of the repository at one commit, from the cache.

The cache's writer (voc-engineering-cache, ``engineering/connectors/cache.py``: trusted code that holds the
host's token only for its fetch) keeps one entry per commit and 14-day generation,
``engineering/cache/<connection>/<commit>/g<N>/repo.git`` in the raw bucket, a bare repository of that commit at depth
1, complete once its ``READY`` exists (the runtime launches no agent before, and records the generation it found on
the agent's session). Each session's entry point mounts ``engineering/cache/<connection>/`` read-only at
``/mnt/voc-cache`` (Mountpoint for Amazon S3: no appends or random writes, so nothing is ever written through it),
and the agent's first commands clone ``/mnt/voc-cache/<commit>/g<N>/repo.git``: ``--filter=blob:none`` and a sparse
checkout of only the task's paths, so a monorepo costs what the task touches (the writer sets git's
uploadpack.allowFilter on the entry's repository; without it git ignores the filter and clones whole). The agent user runs every git command, with hooks, the file-system
monitor, pagers, external diff tools, credential helpers, terminal prompts and the system config off, so
nothing the repository planted runs as the agent. The git directory lives beside the working tree
(``/work/repo.git``, the agent's: ``/work`` is not group-writable), is made read-only to the ``work`` group,
and every agent git command names it (``repo_git``), so repository code (the ``code`` user) can change the
working tree but neither the git directory nor which one the agent's git reads.
"""
from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Final

from engineering.runtime.interface import Command, RuntimeRefused
from engineering.runtime.unit_runner import MOUNT_POINT

#: The cache's entries as the session sees them: ``<commit>/g<N>/repo.git`` under the mounted connection prefix
#: (``engineering/connectors/cache_layout.py``).
CACHE_ROOT: Final = f'file://{MOUNT_POINT}'
#: The largest cache generation (14 days each: far past any clock this code will run under).
MAX_GENERATION: Final = 99_999
#: Relative to the agent's working directory (``/work`` in the images).
CHECKOUT_DIR: Final = 'repo'
CLONE_TIMEOUT_SECONDS: Final = 30 * 60
MAX_SPARSE_PATHS: Final = 200
COMMIT_RE: Final = re.compile(r'^[0-9a-f]{40}([0-9a-f]{24})?\Z')
#: A plain path: never starting with "-" (an option to git) or "/", no glob, no backslash.
_PATH_RE: Final = re.compile(r'^[A-Za-z0-9_.@+][A-Za-z0-9_./@+-]{0,511}\Z')
#: Every git command: no system config, no terminal prompt, no hooks, no file-system monitor, no pager, no
#: external diff, no credential helper, no protocol but file.
#: Absolute paths: the agent's PATH may hold a directory the `code` user can write (a toolchain's bin directory).
GIT: Final = ('/usr/bin/env', 'GIT_CONFIG_NOSYSTEM=1', 'GIT_TERMINAL_PROMPT=0', '/usr/bin/git',
              '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat',
              '-c', 'diff.external=', '-c', 'credential.helper=',
              '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
              # Whatever git writes in its directory later (the index, refs, objects) is 0644/0755 whatever the
              # umask, so repository code (group `work`) never gets write access to it.
              '-c', 'core.sharedRepository=0644',
              # A bare repository is used only when named: never one repository code planted where git looks.
              '-c', 'safe.bareRepository=explicit')
#: The checkout's git directory: beside the working tree in /work (the agent's, not writable by the group), never
#: inside it, where repository code could rename it and plant a repository (and its config) of its own.
GIT_DIR: Final = 'repo.git'


def repo_git(*args: str) -> tuple[str, ...]:
    """An agent git command on the checkout, run from the working tree's root and naming its git directory and
    work tree: nothing is discovered, so a ``.git`` or a bare repository that repository code planted in the
    working tree is never read, and every path git writes (``apply`` included) is inside the working tree."""
    env, *rest = GIT
    return (env, '-C', CHECKOUT_DIR, *rest, f'--git-dir=../{GIT_DIR}', '--work-tree=.', *args)


def share_working_tree() -> tuple[str, ...]:
    """The agent's command that opens the working tree (never its links) to the group, for repository code; run
    after the checkout and after a continuation puts its working tree back."""
    return ('/usr/bin/find', CHECKOUT_DIR, '!', '-type', 'l', '-exec', '/usr/bin/chmod', 'g+w', '{}', '+')


def check_sparse_path(path: str) -> str:
    """A repository-relative directory or file: no leading ``/`` or ``-``, no ``..``, no glob."""
    if not _PATH_RE.match(path) or '..' in path.split('/') or '//' in path:
        raise RuntimeRefused(f'{path!r} is not a plain repository path')
    return path.rstrip('/')


def check_generation(generation: object) -> int:
    """``generation`` when it is a cache generation: an integer (never a bool) from 0 to ``MAX_GENERATION``."""
    if not isinstance(generation, int) or isinstance(generation, bool) or not 0 <= generation <= MAX_GENERATION:
        raise RuntimeRefused(f'a cache generation is a whole number from 0 to {MAX_GENERATION}')
    return generation


def cache_source(commit: str, generation: int) -> str:
    """The cache's entry of ``commit`` in the mount: ``file:///mnt/voc-cache/<commit>/g<N>/repo.git``, ``N`` the
    generation the launch found (``runtime/checkout_cache.py``)."""
    if not COMMIT_RE.match(commit):
        raise RuntimeRefused('a commit is a full hexadecimal object id')
    return f'{CACHE_ROOT}/{commit}/g{check_generation(generation)}/{GIT_DIR}'


def checkout_commands(commit: str, paths: Sequence[str], generation: int, source: str | None = None) -> list[Command]:
    """The commands that check out ``commit`` with only ``paths`` (the whole tree when ``paths`` is empty).

    ``source`` is the cache's entry (a ``file://`` URL): the commit's own of ``generation`` in the mount
    (``cache_source``) unless given (tests point it at a local repository).
    """
    check_generation(generation)
    source = cache_source(commit, generation) if source is None else source
    if not source.startswith('file:///'):
        raise RuntimeRefused('a checkout comes from the cache only (a file:// source)')
    if not COMMIT_RE.match(commit):
        raise RuntimeRefused('a commit is a full hexadecimal object id')
    if len(paths) > MAX_SPARSE_PATHS:
        raise RuntimeRefused(f'at most {MAX_SPARSE_PATHS} sparse paths')
    sparse = [check_sparse_path(path) for path in paths]
    steps: list[tuple[tuple[str, ...], int]] = [
        # --depth=1 as well: the cache's entry is that one commit at depth 1, and git hangs on a blob-less clone of a
        # shallow repository without it (history is read through the broker, never cloned).
        ((*GIT, 'clone', '--no-checkout', '--depth=1', '--filter=blob:none', f'--separate-git-dir={GIT_DIR}',
          '--quiet', source, CHECKOUT_DIR), CLONE_TIMEOUT_SECONDS),
    ]
    if sparse:
        steps.append((repo_git('sparse-checkout', 'set', '--', *sparse), 300))
    steps.append((repo_git('checkout', '--quiet', '--detach', commit), CLONE_TIMEOUT_SECONDS))
    # The agent's commands run under umask 0022: the working tree is opened to the group, for builds and tests;
    # the git directory, beside it, is closed to it. Links are skipped: chmod follows a link it is named, and the
    # repository's links may point anywhere (or nowhere).
    steps.append((share_working_tree(), 300))
    steps.append((('/usr/bin/chmod', '-R', 'g-w', GIT_DIR), 300))
    # The agent's own commands (as `unit`): never repository code, and the cache is a local mount.
    return [Command(argv=argv, timeout_seconds=timeout, repository_code=False) for argv, timeout in steps]
