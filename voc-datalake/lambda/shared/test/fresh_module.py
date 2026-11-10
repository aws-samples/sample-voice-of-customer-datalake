"""Execute a module file as a NEW module, so its caches are at their cold-start values."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType


def fresh_module_copy(name: str, path: Path) -> ModuleType:
    """A fresh copy of the module at ``path``, registered as ``name`` only while it executes.

    Not a reload: importers hold the module's functions and classes by reference,
    and a reload would split them (and any ``lru_cache`` the session shares). The
    temporary ``sys.modules`` entry lets ``dataclass`` resolve string annotations.
    """
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f'cannot load {path}')
    fresh = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = fresh
    try:
        spec.loader.exec_module(fresh)
    finally:
        del sys.modules[spec.name]
    return fresh
