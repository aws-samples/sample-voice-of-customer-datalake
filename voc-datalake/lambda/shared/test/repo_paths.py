"""Where the lockstep tests find the other half of each pin they guard, and how
tests load the standalone scripts that live outside any importable package.

Conventions every lockstep (mirror) test follows
================================================

Positive controls
-----------------
Each mirror comparison is paired with a control test that asserts the other
language's source exists and that the mirrored constant parses out of it. The
control carries NO skip marker on purpose: it is exactly the check that has to
run. Skipping it would leave the equality test able to pass while comparing
against nothing — a green result meaning "did not check".

A full checkout is required
---------------------------
A mirror test whose other half lives in a tree a partial checkout might omit
does not degrade gracefully with a `skipif`. That tolerance cannot take effect:

1. The positive control carries no marker, so the module fails on precisely the
   checkout a `skipif` would exist to accommodate; the marker only changes which
   test reports the problem, not whether one does.
2. `scripts/mcp_gate.py` floors the MCP-scoped modules on tests that RAN, so any
   skip drops such a module below its floor and fails the audit regardless.
3. The supported consumers — local full-backend testing and the manually-
   dispatched MCP workflow — both use a full checkout.

Failing loudly on a partial checkout is the better behaviour anyway: a guard
that quietly measures nothing is worse than one that says it cannot run.
"""
import importlib.util
import sys
from pathlib import Path
from types import ModuleType


def repo_root() -> Path:
    """The `voc-datalake/` directory (this file lives in lambda/shared/test/)."""
    return Path(__file__).resolve().parents[3]


def cdk_model_allowlist_source() -> str:
    """The CDK model allowlist, the TypeScript side of several Python pins."""
    return (repo_root() / 'lib' / 'utils' / 'model-allowlist.ts').read_text(encoding='utf-8')


def load_module_from_path(module_name: str, path: Path) -> ModuleType:
    """Execute the Python file at *path* as a module named *module_name*.

    `scripts/` has no `__init__.py`, so its entry points are loaded by location.
    The module is registered in `sys.modules` BEFORE execution: `@dataclass` (and
    anything else that resolves its defining module by name) looks it up there,
    which a path-loaded module is not in by default. On a failed execution the
    half-initialised entry is removed again. The caller owns removing it after a
    successful load if it wants the registration scoped.
    """
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f'not a loadable Python file: {path}')
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(module_name, None)
        raise
    return module


def fresh_module_copy(module: ModuleType) -> ModuleType:
    """Execute *module*'s source file as a NEW module, so every module-level cache
    sits at its cold-start value, and leave `sys.modules` as it was.

    Not a reload: every importer holds the original's functions and classes by
    reference, and a reload would split an `lru_cache` or a dataclass the whole
    session shares. The copy is registered only while it executes (`@dataclass`
    resolves string annotations through `sys.modules[cls.__module__]`), under a
    name no import statement produces, and unregistered again before it is handed
    back.
    """
    source = module.__file__
    if source is None:
        raise ImportError(f'{module.__name__} has no source file to execute again')
    name = f'_{module.__name__.replace(".", "_")}_cold'
    try:
        return load_module_from_path(name, Path(source))
    finally:
        sys.modules.pop(name, None)
