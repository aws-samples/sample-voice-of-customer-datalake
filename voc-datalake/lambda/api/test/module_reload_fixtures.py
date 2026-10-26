"""Re-import a handler module as a fresh execution environment would.

Cold-start suites pin what a module reads from the environment at import; this
builds the ``reload(**env)`` callable their fixtures yield, and
``reload_cycle`` wraps it with the teardown (``monkeypatch.undo()`` then one
more reload, and ``sys.path`` put back) so every module is restored for the
tests after it.
"""
from __future__ import annotations

import importlib
import sys
from collections.abc import Callable, Iterator
from types import ModuleType

import pytest


def env_reloader(monkeypatch: pytest.MonkeyPatch, module: ModuleType) -> Callable[..., ModuleType]:
    """``reload(NAME=value | None, ...)``: set (or, for None, unset) each variable, then re-import ``module``."""
    def _reload(**env: str | None) -> ModuleType:
        for name, value in env.items():
            if value is None:
                monkeypatch.delenv(name, raising=False)
            else:
                monkeypatch.setenv(name, value)
        return importlib.reload(module)

    return _reload


def reload_cycle(monkeypatch: pytest.MonkeyPatch, module: ModuleType, *,
                 restore_sys_path: bool = True) -> Iterator[Callable[..., ModuleType]]:
    """A cold-start fixture body (``yield from``): yields ``env_reloader(monkeypatch, module)``, then
    undoes the environment, re-imports ``module`` once more and, by default, restores ``sys.path``."""
    saved_path = list(sys.path)
    yield env_reloader(monkeypatch, module)
    monkeypatch.undo()
    importlib.reload(module)
    if restore_sys_path:
        sys.path[:] = saved_path
