"""What the gate asks git: the base branch's files, and whether a recorded sha is a commit HEAD descends from.

A git runner takes git's arguments and answers its stdout, or None when git exits non-zero (tests pass a fake one).
The base ref is checked before git sees it, so it can never be read as an option. "The ref does not exist" (not
fetched here) and "the file is absent at the ref" (the base branch has no registry yet) are told apart: the first is
loud, and fails under CI or ``--strict-base``; the second simply means there is nothing to compare against yet.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from . import items, ratchet, registry

Git = Callable[[list[str]], 'str | None']
REF_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._/-]*')
DEFAULT_BASE = 'origin/voc-multiplayer'
ZERO = '0' * 40   # GitHub's `before` on the first push of a new branch: no base commit


def run_git(root: Path) -> Git:
    def git(args: list[str]) -> str | None:
        done = subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True, check=False)  # noqa: S603, S607 — git from PATH; argv is git's own words, a checked ref and a sha
        return done.stdout if done.returncode == 0 else None
    return git


def check_ref(ref: str) -> str:
    if not REF_RE.fullmatch(ref) or '..' in ref or ref.endswith(('/', '.lock')):
        raise ValueError(f'{ref!r} is not a branch or ref name (letters, digits, ".", "_", "/", "-"; no leading "-")')
    return ref


def commit_of(git: Git, ref: str, *, ours: bool = False) -> str | None:
    """The commit a ref (or sha) names, None when it names none here (``ours``: a name of the program's own, such
    as ``HEAD^1``, not checked as a ref)."""
    name = ref if ours else check_ref(ref)
    out = git(['rev-parse', '--verify', '--quiet', '--end-of-options', f'{name}^{{commit}}'])
    return out.strip() if out else None


def show(git: Git, commit: str, path: str) -> str | None:
    return git(['show', f'{check_ref(commit)}:{path}'])


HISTORY_LIMIT = 5000   # commits that touched package.json, newest first: far more than this line will ever have
COMMIT_RE = re.compile(r'[0-9a-f]{40}')
NO_COLOUR = ['-c', 'color.ui=never', '-c', 'log.showSignature=false']
# Every walk of the line, whatever the settings: no colour or signature lines, no rename following, and a merge on the
# first-parent line diffed against its first parent (so a gate or a bump that arrives by a merge is seen).
WALK = [*NO_COLOUR, '-c', 'log.follow=false', 'log', '--format=%H', '--first-parent', '--diff-merges=first-parent',
        '--no-renames']


def _commits(git: Git, args: list[str]) -> list[str]:
    """The commit ids a walk of the line prints (any other line a setting adds is ignored)."""
    return [line for line in (git([*WALK, *args]) or '').split() if COMMIT_RE.fullmatch(line)]


def bootstrap_commit(git: Git, tip: str = 'HEAD') -> str | None:
    """The commit on ``tip``'s first-parent line that brought the gate (it first added the allowed list; a list added
    again later keeps the oldest bound), None before it."""
    added = _commits(git, ['--diff-filter=A', tip, '--', ratchet.ALLOWED])
    return added[-1] if added else None


def _order_problems(walk: list[tuple[str, str]]) -> list[str]:
    """Every bump on the line, oldest first, is above the one before it, and the first is not before the gate (the
    bootstrap's own 7.105.00): a pushed release is never renumbered, so a lower number is no release of its own."""
    out: list[str] = []
    before: str | None = None
    for sha, version in walk:
        if version == before:
            continue   # package.json changed, its version did not: no bump
        if before is None and registry.parse_version(version) < GATE_VERSION:
            out.append(f"{sha[:12]}: package.json's version {version} is before the gate's ({registry.GATE})")
        elif before is not None and registry.parse_version(version) <= registry.parse_version(before):
            out.append(f"{sha[:12]}: package.json's version {version} is not above the bump before it ({before}): a "
                       'pushed bump is never renumbered')
        before = version
    return out


def package_history_report(git: Git, limit: int = HISTORY_LIMIT, tip: str = 'HEAD') -> tuple[list[str], list[str]]:
    """(every version the root package.json held on ``tip``'s first-parent line since the gate came, newest first, in
    the CHANGELOG's two-digit form; the commits whose version is not a plain MAJOR.MINOR.PATCH, as problems). The walk
    is bounded to the commits after the bootstrap commit's parents (``<tip> --not <boot>^@``), so the bootstrap commit
    is in it whether or not it bumped; the branches merged into the line keep their own bumps. Each version is read as
    JSON from ``git show <commit>:package.json`` (any formatting, any diff setting). Before the gate's bootstrap commit
    the history is not the gate's to judge. In a PR into another line, ``tip`` is the PR's own head."""
    boot = bootstrap_commit(git, tip)
    if boot is None:
        return [], []
    out: list[str] = []
    problems: list[str] = []
    walk: list[tuple[str, str]] = []
    for sha in _commits(git, [f'--max-count={limit}', tip, '--not', f'{boot}^@', '--', 'package.json']):
        try:
            version = json.loads(show(git, sha, 'package.json') or '{}').get('version')
        except (ValueError, AttributeError):
            version = None
        two = items.two_digit(str(version)) if version is not None else None
        if two is None:
            problems.append(f"{sha[:12]}: package.json's version {version!r} is not MAJOR.MINOR.PATCH")
            continue
        walk.append((sha, two))
        if two not in out:
            out.append(two)
    return out, problems + _order_problems(walk[::-1])


def package_history(git: Git, limit: int = HISTORY_LIMIT, tip: str = 'HEAD') -> list[str]:
    """The versions of ``package_history_report`` alone."""
    return package_history_report(git, limit, tip)[0]


def exists_at(git: Git, sha: str, path: str) -> bool:
    """The file is in that commit's tree (``<sha>:<path>`` can never be read as an option: it starts with the sha)."""
    return registry.is_sha(sha) and git(['cat-file', '-e', f'{sha}:{path}']) is not None


def descends(git: Git, older: str, newer: str) -> bool:
    """``newer`` is ``older`` or a descendant of it."""
    return git(['merge-base', '--is-ancestor', older, newer]) is not None


def sha_problems(git: Git, sha: str) -> list[str]:
    """Why a recorded sha does not hold: not a commit here, or not HEAD or one of its ancestors."""
    if not registry.is_sha(sha):
        return [f'the sha {sha!r} is not a commit sha']
    if git(['cat-file', '-e', f'{sha}^{{commit}}']) is None:
        return [f'the sha {sha} is not a commit of this repository']
    if git(['merge-base', '--is-ancestor', sha, 'HEAD']) is None:
        return [f'the sha {sha} is not HEAD or an ancestor of it']
    return []


@dataclass
class Base:
    ref: str
    exists: bool
    commit: str | None = None                  # the commit compared against
    fork: str | None = None                    # where HEAD's history left it (a record must descend from this)
    registry: registry.Registry | None = None
    allowed: ratchet.Gaps | None = None
    problems: list[str] = field(default_factory=list)
    note: str | None = None
    no_parent: bool = False   # the base ref is HEAD, and HEAD's parent is not here


GATE_VERSION = registry.parse_version(registry.GATE)   # (7, 105, 0): a base before it may have no registry


def _pre_gate_problems(git: Git, commit: str, ref: str) -> list[str]:
    """A base with no registry is the bootstrap only when it holds no docs/feature-tests/ at all and its package.json
    version is before the gate's; anything else is a registry that went missing."""
    listed = (git(['ls-tree', '--name-only', '-r', commit, f'{registry.REGISTRY_DIR}/']) or '').split()
    if listed:
        return [f'the base {ref} has no registry, but it has {registry.REGISTRY_DIR}/ ({listed[0]})']
    try:
        version = str(json.loads(show(git, commit, 'package.json') or '{}').get('version', ''))
    except (ValueError, AttributeError):
        version = ''
    parts = tuple(int(p) for p in version.split('.')) if re.fullmatch(r'\d+\.\d+\.\d+', version) else None
    if parts is None:
        return [f'the base {ref} has no registry and no package.json version to show it is from before the gate']
    if parts >= GATE_VERSION:
        gate = '.'.join(map(str, GATE_VERSION))
        return [f'the base {ref} has no registry, but its package.json version {version} is not before the gate ({gate})']
    return []


def read_base(git: Git, ref: str, pull_request: bool | None = None) -> Base:
    """The base branch's registry and allowed gaps (each None where the file is absent there). A base ref that is
    HEAD itself (the branch's own check after a merge) is compared through HEAD's first parent: comparing a tree with
    itself would let every change through."""
    commit = commit_of(git, ref)
    if commit is None:
        return Base(ref, exists=False)
    base = Base(ref, exists=True, commit=commit)
    if commit == commit_of(git, 'HEAD'):
        parent = commit_of(git, 'HEAD^1', ours=True)
        if parent is None:
            base.commit = None
            base.no_parent = True
            return base
        commit = base.commit = parent
        base.note = f"the base ref {ref} is HEAD: comparing against HEAD's first parent {parent}"
    # A record descends from where the branch's own history left the base (their merge-base), not from the base's
    # newest commit: a PR's commits never descend from its target's later ones. In a pull_request run, HEAD is the PR's
    # merge ref and its second parent the PR's own head, so the fork is taken against that; anywhere else (a local
    # merge commit too) against HEAD.
    if pull_request is None:
        pull_request = os.environ.get('GITHUB_EVENT_NAME') == 'pull_request'
    side = (commit_of(git, 'HEAD^2', ours=True) if pull_request else None) or 'HEAD'
    fork = git(['merge-base', commit, side])
    base.fork = fork.strip() if fork else commit
    texts = {sl.file: show(git, commit, sl.file) for sl in registry.SLICES}
    parent = commit_of(git, 'HEAD^1', ours=True)
    if all(t is None for t in texts.values()) and parent and parent != commit:
        # The base has no registry yet, but HEAD's parent does (the registry landed earlier on this branch): compare
        # with that, or a second commit could undo the first's registry with nothing to compare it against.
        earlier = {sl.file: show(git, parent, sl.file) for sl in registry.SLICES}
        if any(t is not None for t in earlier.values()):
            texts, commit = earlier, parent
            base.note = (f"the base {ref} has no registry yet; comparing against HEAD's first parent {parent}, "
                         'which has one')
    if any(t is not None for t in texts.values()):
        base.registry = registry.from_texts(texts)
        base.problems += [f'{ref}: {p}' for p in base.registry.problems]
    elif (boot := bootstrap_commit(git, side)) is not None and descends(git, boot, commit):
        # A base on or after the line's bootstrap commit had the gate: without a registry it lost it, and is never
        # taken for a base from before the gate (whatever its package.json says).
        base.problems.append(f"the base {ref} has no registry, but it descends from the line's bootstrap commit {boot}: "
                             'a base after the gate is never the bootstrap')
    else:
        base.problems += _pre_gate_problems(git, commit, ref)
    allowed = show(git, commit, ratchet.ALLOWED)
    if allowed is None and base.registry is not None:
        base.problems.append(f'the base {ref} has a registry but no {ratchet.ALLOWED}')
    elif allowed is not None:
        try:
            base.allowed = ratchet.read_allowed(allowed)
        except ValueError as err:
            base.problems.append(f'{ref}: {err}')
    return base
