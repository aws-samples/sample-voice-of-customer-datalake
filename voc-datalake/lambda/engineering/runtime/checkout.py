"""An agent's checkout: a sparse, blob-less clone of the repository at one commit, from the cache.

The connector's broker (trusted code, the only holder of the host credential) keeps a partial clone of
each repository in the cache, ``engineering/cache/<repo>/repo.git`` in the run bucket. Each MicroVM's
entry point mounts ``engineering/cache/<repo>/`` read-only at ``/mnt/voc-cache`` (Mountpoint for Amazon
S3: no appends or random writes, so nothing is ever written through it), and the agent's first commands
clone from there: ``--filter=blob:none`` and a sparse checkout of only the task's paths, so a monorepo
costs what the task touches (the broker sets git's uploadpack.allowFilter on the cache's repository; without it
git ignores the filter and clones whole). The agent user runs every git command, with hooks, the file-system
monitor, pagers, external diff tools, credential helpers, terminal prompts and the system config off, so
nothing the repository planted runs as the agent; then the checkout's ``.git`` is made read-only to the
``work`` group, so repository code (the ``code`` user) can change the working tree but not the git directory.
"""
from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Final

from engineering.runtime.interface import Command, RuntimeRefused
from engineering.runtime.unit_runner import MOUNT_POINT

CACHE_SOURCE: Final = f'file://{MOUNT_POINT}/repo.git'
#: Relative to the agent's working directory (``/work`` in the images).
CHECKOUT_DIR: Final = 'repo'
CLONE_TIMEOUT_SECONDS: Final = 30 * 60
MAX_SPARSE_PATHS: Final = 200
_COMMIT_RE: Final = re.compile(r'^[0-9a-f]{40}([0-9a-f]{24})?\Z')
#: A plain path: never starting with "-" (an option to git) or "/", no glob, no backslash.
_PATH_RE: Final = re.compile(r'^[A-Za-z0-9_.@+][A-Za-z0-9_./@+-]{0,511}\Z')
#: Every git command: no system config, no terminal prompt, no hooks, no file-system monitor, no pager, no
#: external diff, no credential helper, no protocol but file.
#: Absolute paths: the agent's PATH may hold a directory the `code` user can write (a toolchain's bin directory).
_GIT: Final = ('/usr/bin/env', 'GIT_CONFIG_NOSYSTEM=1', 'GIT_TERMINAL_PROMPT=0', '/usr/bin/git',
               '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat',
               '-c', 'diff.external=', '-c', 'credential.helper=',
               '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
               # Whatever git writes in .git later (the index, refs, objects) is 0644/0755 whatever the umask, so
               # repository code (group `work`) never gets write access back to the git directory. Every agent
               # git command in the checkout uses this same prefix.
               '-c', 'core.sharedRepository=0644')


def check_sparse_path(path: str) -> str:
    """A repository-relative directory or file: no leading ``/`` or ``-``, no ``..``, no glob."""
    if not _PATH_RE.match(path) or '..' in path.split('/') or '//' in path:
        raise RuntimeRefused(f'{path!r} is not a plain repository path')
    return path.rstrip('/')


def checkout_commands(commit: str, paths: Sequence[str], source: str = CACHE_SOURCE) -> list[Command]:
    """The commands that check out ``commit`` with only ``paths`` (the whole tree when ``paths`` is empty).

    ``source`` is the cache's partial clone (a ``file://`` URL; tests point it at a local repository).
    """
    if not source.startswith('file:///'):
        raise RuntimeRefused('a checkout comes from the cache only (a file:// source)')
    if not _COMMIT_RE.match(commit):
        raise RuntimeRefused('a commit is a full hexadecimal object id')
    if len(paths) > MAX_SPARSE_PATHS:
        raise RuntimeRefused(f'at most {MAX_SPARSE_PATHS} sparse paths')
    sparse = [check_sparse_path(path) for path in paths]
    in_repo = (*_GIT, '-C', CHECKOUT_DIR)
    steps: list[tuple[tuple[str, ...], int]] = [
        ((*_GIT, 'clone', '--no-checkout', '--filter=blob:none', '--quiet', source, CHECKOUT_DIR),
         CLONE_TIMEOUT_SECONDS),
    ]
    if sparse:
        steps.append(((*in_repo, 'sparse-checkout', 'set', '--', *sparse), 300))
    steps.append(((*in_repo, 'checkout', '--quiet', '--detach', commit), CLONE_TIMEOUT_SECONDS))
    # The agent's commands run under umask 0022: the working tree (never .git) is opened to the group, for
    # builds and tests, and the git directory is closed to it. Links are skipped: chmod follows a link it is
    # named, and the repository's links may point anywhere (or nowhere).
    steps.append((('/usr/bin/find', CHECKOUT_DIR, '-path', f'{CHECKOUT_DIR}/.git', '-prune', '-o',
                   '!', '-type', 'l', '-exec', '/usr/bin/chmod', 'g+w', '{}', '+'), 300))
    steps.append((('/usr/bin/chmod', '-R', 'g-w', f'{CHECKOUT_DIR}/.git'), 300))
    # The agent's own commands (as `unit`): never repository code, and the cache is a local mount.
    return [Command(argv=argv, timeout_seconds=timeout, repository_code=False) for argv, timeout in steps]
