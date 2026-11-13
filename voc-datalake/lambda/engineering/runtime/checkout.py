"""An agent's checkout: a sparse, blob-less clone of the repository at one commit, from the cache.

The connector's broker (trusted code, the only holder of the host credential) keeps a partial clone of
each repository in the cache, ``engineering/cache/<repo>/repo.git`` in the run bucket. Each session's
entry point mounts ``engineering/cache/<repo>/`` read-only at ``/mnt/voc-cache`` (Mountpoint for Amazon
S3: no appends or random writes, so nothing is ever written through it), and the agent's first commands
clone from there: ``--filter=blob:none`` and a sparse checkout of only the task's paths, so a monorepo
costs what the task touches (the broker sets git's uploadpack.allowFilter on the cache's repository; without it
git ignores the filter and clones whole). The agent user runs every git command, with hooks, the file-system
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

CACHE_SOURCE: Final = f'file://{MOUNT_POINT}/repo.git'
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


def checkout_commands(commit: str, paths: Sequence[str], source: str = CACHE_SOURCE) -> list[Command]:
    """The commands that check out ``commit`` with only ``paths`` (the whole tree when ``paths`` is empty).

    ``source`` is the cache's partial clone (a ``file://`` URL; tests point it at a local repository).
    """
    if not source.startswith('file:///'):
        raise RuntimeRefused('a checkout comes from the cache only (a file:// source)')
    if not COMMIT_RE.match(commit):
        raise RuntimeRefused('a commit is a full hexadecimal object id')
    if len(paths) > MAX_SPARSE_PATHS:
        raise RuntimeRefused(f'at most {MAX_SPARSE_PATHS} sparse paths')
    sparse = [check_sparse_path(path) for path in paths]
    steps: list[tuple[tuple[str, ...], int]] = [
        ((*GIT, 'clone', '--no-checkout', '--filter=blob:none', f'--separate-git-dir={GIT_DIR}', '--quiet', source,
          CHECKOUT_DIR), CLONE_TIMEOUT_SECONDS),
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
