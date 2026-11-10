"""Re-execute a `_shared` module as a cold start would, without disturbing the session's copy.

The `_shared` import-time suites (audit, circuit breaker) pin what a module
reads from the environment and that it puts the plugins root at the FRONT of
`sys.path`. Both need the same two moves, written once here: load the file
again under a throwaway dotted name, and prove the path insert lands at index 0.
"""
from __future__ import annotations

import importlib.util
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType


def load_fresh(dotted_name: str, path: Path) -> ModuleType:
    """Execute ``path`` again as ``dotted_name``, a module registered nowhere.

    A dotted name under `_shared` keeps the module's relative imports working
    while the session's own module (and everything patched on it) stays untouched.
    """
    spec = importlib.util.spec_from_file_location(dotted_name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f'cannot build an import spec for {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_loading_puts_root_first(load: Callable[[], object], original_path: list[str], root: str) -> None:
    """`plugins/conftest.py` already has ``root`` at `sys.path[0]`, which would hide an insert at any
    index; start from a path whose front is a sentinel, ``load()``, and require ``root`` then the sentinel.
    The caller restores `sys.path` (``original_path`` is its snapshot)."""
    sentinel = '/not-the-plugins-root'
    sys.path[:] = [sentinel, *(entry for entry in original_path if entry != root)]
    load()
    if sys.path[:2] != [root, sentinel]:
        raise AssertionError(f'sys.path starts {sys.path[:2]!r}, expected {[root, sentinel]!r}')
