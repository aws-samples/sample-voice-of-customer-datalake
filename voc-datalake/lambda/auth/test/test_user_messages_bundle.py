"""The user-messages trigger bundle is self-contained (lib/stacks/core-auth.ts USER_MESSAGES_FILES).

The CDK asset ships ONLY ``auth/user_messages.py``; the runtime adds boto3. With an import path holding
just a copy of that file (plus the interpreter's stdlib and site-packages, which stand in for the
runtime's boto3), the handler must import without loading any other app module.
"""
from __future__ import annotations

import importlib
import shutil
import sys
from pathlib import Path

LAMBDA_ROOT = Path(__file__).resolve().parents[2]
BUNDLE_FILES = ('auth/user_messages.py',)


def _outside_the_repo(entry: str) -> bool:
    return not str(Path(entry or '.').resolve()).startswith(str(LAMBDA_ROOT.parent))


def test_imports_with_only_the_bundled_file(tmp_path, monkeypatch):
    for relative in BUNDLE_FILES:
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(LAMBDA_ROOT / relative, target)
    monkeypatch.setattr(sys, 'path', [str(tmp_path), *[e for e in sys.path if _outside_the_repo(e)]])
    for name in [n for n in sys.modules if n == 'auth' or n.startswith(('auth.', 'shared'))]:
        monkeypatch.delitem(sys.modules, name)
    module = importlib.import_module('auth.user_messages')
    assert module.__file__ is not None
    assert Path(module.__file__).resolve().is_relative_to(tmp_path.resolve())
    app_modules = [n for n in sys.modules if n.startswith('shared')]
    assert app_modules == []
