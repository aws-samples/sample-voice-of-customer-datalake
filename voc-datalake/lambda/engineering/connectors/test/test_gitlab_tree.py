"""The tree ids the GitLab client works out (gitlab_tree.py) are git's own: checked against real git."""
from __future__ import annotations

import os
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

from engineering.connectors.gitlab_tree import (
    TreeEntry,
    algorithm_of,
    blob_id,
    directories,
    parent_of,
    rebuilt,
    tree_id,
)
from engineering.connectors.hosts import FileChange
from engineering.connectors.test.test_cache_git import GIT, _git

needs_git = pytest.mark.skipif(not os.path.exists(GIT), reason='git is not installed')
EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'


def _repository(root: Path) -> Path:
    """A repository whose names sort differently as trees and as files (``a`` and ``a.txt``), with an executable,
    a nested directory and a symbolic link."""
    repo = root / 'repo'
    files = {'a/x.py': 'x\n', 'a.txt': 'a\n', 'a-b/y.md': 'y\n', 'src/deep/z.py': 'z\n', 'run.sh': '#!/bin/sh\n'}
    for path, text in files.items():
        (repo / path).parent.mkdir(parents=True, exist_ok=True)
        (repo / path).write_text(text)
    (repo / 'run.sh').chmod(0o755)
    (repo / 'link').symlink_to('a.txt')
    _git('init', '--quiet', str(repo), cwd=root)
    _git('add', '.', cwd=repo)
    _git('commit', '--quiet', '-m', 'first', cwd=repo)
    return repo


def _listing(repo: Path, ref: str) -> Callable[[str], dict[str, TreeEntry]]:
    """What GitLab's tree API lists of a directory at ``ref``, read from git itself."""
    def listing(directory: str) -> dict[str, TreeEntry]:
        spec = f'{ref}:{directory}' if directory else f'{ref}^{{tree}}'
        try:
            out = _git('ls-tree', spec, cwd=repo)
        except subprocess.CalledProcessError:
            return {}
        entries = {}
        for line in out.splitlines():
            meta, name = line.split('\t')
            mode, _kind, object_id = meta.split()
            entries[name] = TreeEntry(name, '040000' if mode == '040000' else mode, object_id)
        return entries
    return listing


@needs_git
def test_a_commits_tree_id_is_gits_from_its_root_listing(tmp_path: Path) -> None:
    repo = _repository(tmp_path)
    root = _listing(repo, 'HEAD')('')
    assert tree_id(root.values(), 'sha1') == _git('rev-parse', 'HEAD^{tree}', cwd=repo)


@needs_git
def test_changes_rebuilt_on_a_commit_give_the_tree_git_commits_for_them(tmp_path: Path) -> None:
    repo = _repository(tmp_path)
    listing = _listing(repo, 'HEAD')
    changes = {
        'a/x.py': FileChange('a/x.py', '100644', b'x2\n'),                    # an update
        'src/deep/z.py': FileChange('src/deep/z.py', '100644', None),         # a deletion that empties two dirs
        'new/dir/n.py': FileChange('new/dir/n.py', '100755', b'n\n'),         # a new executable in new dirs
        'a.txt': FileChange('a.txt', '100644', b'\x00binary'),                # binary content
    }
    expected = rebuilt(listing, changes, 'sha1')
    (repo / 'a/x.py').write_text('x2\n')
    (repo / 'src/deep/z.py').unlink()
    (repo / 'new/dir').mkdir(parents=True)
    (repo / 'new/dir/n.py').write_text('n\n')
    (repo / 'new/dir/n.py').chmod(0o755)
    (repo / 'a.txt').write_bytes(b'\x00binary')
    _git('add', '-A', '.', cwd=repo)
    _git('commit', '--quiet', '-m', 'second', cwd=repo)
    assert expected == _git('rev-parse', 'HEAD^{tree}', cwd=repo)
    assert _git('ls-tree', 'HEAD', 'src', cwd=repo) == ''   # (the emptied directories went, as in git)


def test_the_empty_tree_and_a_blob_are_gits_well_known_ids() -> None:
    assert tree_id((), 'sha1') == EMPTY_TREE
    assert blob_id(b'', 'sha1') == 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
    assert rebuilt(lambda _directory: {}, {'x': FileChange('x', '100644', None)}, 'sha1') == EMPTY_TREE


def test_a_sha256_repository_hashes_with_sha256() -> None:
    assert (algorithm_of('a' * 64), algorithm_of('a' * 40)) == ('sha256', 'sha1')
    assert len(tree_id((), 'sha256')) == 64


def test_the_directories_a_change_reads_are_its_own_and_each_parent() -> None:
    assert directories(['a/b/c.py', 'a/d.py', 'top.md']) == {'', 'a', 'a/b'}
    assert (parent_of('a/b/c.py'), parent_of('top.md')) == ('a/b', '')
