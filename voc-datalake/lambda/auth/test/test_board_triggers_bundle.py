"""The board trigger bundle is self-contained (lib/stacks/core-board-auth.ts BOARD_TRIGGER_FILES).

The CDK asset ships ONLY ``auth/board_triggers.py``, ``shared/__init__.py``,
``shared/participants_settings.py`` and ``shared/review_share_audience.py``; the runtime adds
boto3. With an import path holding just a copy of those four files (plus the interpreter's stdlib and site-packages, which
stand in for the runtime's boto3) and every ``auth`` / ``shared`` module forgotten, both
handlers must import, and every app module loaded must be one of the copies.
"""
from __future__ import annotations

import importlib
import shutil
import sys
from pathlib import Path

import pytest

LAMBDA_ROOT = Path(__file__).resolve().parents[2]
BUNDLE_FILES = ('auth/board_triggers.py', 'shared/__init__.py', 'shared/participants_settings.py',
                'shared/review_share_audience.py')
APP_PACKAGES = ('auth', 'shared')


def _is_app_module(name: str) -> bool:
    return any(name == package or name.startswith(f'{package}.') for package in APP_PACKAGES)


def _outside_the_repo(entry: str) -> bool:
    resolved = str(Path(entry or '.').resolve())
    return not resolved.startswith(str(LAMBDA_ROOT.parent))


@pytest.fixture
def forget_bundle_modules():
    """Drop the copies' modules afterwards (monkeypatch restores only what existed before)."""
    before = {name for name in sys.modules if _is_app_module(name)}
    yield
    for name in [name for name in sys.modules if _is_app_module(name) and name not in before]:
        del sys.modules[name]


@pytest.mark.usefixtures('forget_bundle_modules')
def test_the_trigger_imports_with_only_the_bundled_files(tmp_path, monkeypatch: pytest.MonkeyPatch):
    for relative in BUNDLE_FILES:
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(LAMBDA_ROOT / relative, target)
    monkeypatch.setattr(sys, 'path', [str(tmp_path), *filter(_outside_the_repo, sys.path)])
    for name in [name for name in sys.modules if _is_app_module(name)]:
        monkeypatch.delitem(sys.modules, name)
    importlib.invalidate_caches()

    triggers = importlib.import_module('auth.board_triggers')

    assert callable(triggers.pre_sign_up_handler)
    assert callable(triggers.custom_message_handler)
    files = [getattr(module, '__file__', None) for name, module in list(sys.modules.items()) if _is_app_module(name)]
    loaded = sorted(str(Path(file).relative_to(tmp_path)) for file in files if isinstance(file, str))
    assert loaded == sorted(BUNDLE_FILES)
