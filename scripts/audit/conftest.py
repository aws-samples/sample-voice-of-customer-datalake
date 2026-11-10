"""Shared fixtures for the scripts/audit detector tests (planted trees in a temp dir, never the real tree)."""
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest
from py_assembly import Assembly, Function

TreeMaker = Callable[[dict[str, str]], Path]


@pytest.fixture
def make_tree(tmp_path: Path) -> TreeMaker:
    """``make_tree({'lambda/api/x.py': '...'})`` writes the files under a temp voc-datalake root."""
    def make(files: dict[str, str]) -> Path:
        for rel, text in files.items():
            (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
            (tmp_path / rel).write_text(text, encoding='utf-8')
        return tmp_path
    return make


def lambda_function(fid: str, handler: str, copy: str, *, env: dict[str, object] | None = None,
                    role: str | None = None) -> Function:
    """A Python Lambda bundled from ``lambda/`` by ``copy`` (the bundling command's cp steps)."""
    fn = Function(fid, 'python3.14', handler, dict(env or {}), role, asset_source='lambda',
                  asset_command=['bash', '-c', copy])
    fn.default_env = set(fn.env)
    return fn


def assembly_of(*functions: Function, templates: dict[str, dict] | None = None) -> Assembly:
    return Assembly(templates or {}, {fn.fid: fn for fn in functions})
