"""Every name a production module lists in ``__all__`` is used by ANOTHER production module.

vulture (pyproject.toml) counts an ``__all__`` entry as a use, so a function nothing calls
survives the dead-code gate as long as its module exports it. The 5.28 clean-up found nine
such definitions (``fetch_with_retry``, ``resolve_window_days``, ``cached_source_profile``,
...). This gate closes that hole: an exported name must be imported, or read as an attribute
of its module, by some other module under ``lambda/`` or ``plugins/``. Tests do not count:
a name only tests reach is dead in production (keep a deliberate test seam out of
``__all__`` and document it in pyproject.toml's vulture ``ignore_names`` instead).

How a use is found (AST only, nothing is imported):

* ``from <module> import name`` where ``<module>`` resolves to the exporting file;
* ``<alias>.name`` where ``<alias>`` is bound to the exporting module (``import shared.x as
  alias``, ``from shared import x``, ``import shared.x`` then ``shared.x.name``);
* ``from <module> import *`` uses every exported name of that module.

A dotted import path resolves to a file by suffix (``shared.api`` → ``lambda/shared/api.py``,
``_shared.audit`` → ``plugins/_shared/audit.py``, ``projects`` → ``lambda/api/projects.py``),
because each Lambda asset has its own root; relative imports resolve against the package.
"""
from __future__ import annotations

import ast
import os
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]  # voc-datalake/
SOURCE_DIRS = ('lambda', 'plugins')
# Never production: vendored layer dependencies, the TypeScript stream Lambda's node_modules,
# and the plugin template (copied by hand, never deployed).
EXCLUDED_PARTS = frozenset({'layers', 'node_modules', '__pycache__', '_template', 'test', 'tests'})

# Exported names no other production module imports, each with its reason. Keyed by module path
# without ``.py``. Real entry points belong here; an over-export is fixed by dropping it from ``__all__``.
ALLOWED_UNUSED_EXPORTS: dict[str, frozenset[str]] = {}


def is_production(relative: Path) -> bool:
    """``relative`` is a path under the scanned root (``lambda/...`` or ``plugins/...``)."""
    name = relative.name
    if name == 'conftest.py' or name.startswith('test_') or name.endswith('_test.py'):
        return False
    return not EXCLUDED_PARTS & set(relative.parts[:-1])


def production_files(root: Path = ROOT) -> list[Path]:
    """Production ``.py`` files, never descending into an excluded directory (``layers`` alone is huge)."""
    found = []
    for directory in SOURCE_DIRS:
        for current, subdirs, names in os.walk(root / directory):
            subdirs[:] = [d for d in subdirs if d not in EXCLUDED_PARTS]
            found.extend(Path(current, name) for name in names if name.endswith('.py'))
    return sorted(path for path in found if is_production(path.relative_to(root)))


def module_parts(path: Path, root: Path) -> tuple[str, ...]:
    """``lambda/shared/api.py`` → ``('lambda', 'shared', 'api')``; a package's ``__init__`` is the package."""
    parts = path.relative_to(root).with_suffix('').parts
    return parts[:-1] if parts[-1] == '__init__' else parts


def _assigns_all(node: ast.stmt) -> ast.expr | None:
    """The value of ``__all__ = ...`` / ``__all__: T = ...``, else None."""
    if isinstance(node, ast.Assign):
        targets, value = node.targets, node.value
    elif isinstance(node, ast.AnnAssign):
        targets, value = [node.target], node.value
    else:
        return None
    return value if any(isinstance(t, ast.Name) and t.id == '__all__' for t in targets) else None


def declared_exports(tree: ast.Module) -> list[str]:
    """The string entries of a module-level ``__all__`` list or tuple."""
    for node in tree.body:
        value = _assigns_all(node)
        if isinstance(value, ast.List | ast.Tuple):
            return [elt.value for elt in value.elts if isinstance(elt, ast.Constant) and isinstance(elt.value, str)]
    return []


class ModuleIndex:
    """Dotted path → the modules it can name, matched by suffix (each Lambda asset has its own root)."""

    def __init__(self, modules: Iterable[tuple[str, ...]]) -> None:
        self._by_suffix: dict[tuple[str, ...], set[tuple[str, ...]]] = {}
        for module in modules:
            for start in range(len(module)):
                self._by_suffix.setdefault(module[start:], set()).add(module)

    def resolve(self, dotted: str) -> set[tuple[str, ...]]:
        return self._by_suffix.get(tuple(dotted.split('.')), set())


def _absolute(node: ast.ImportFrom, importer: tuple[str, ...], is_package: bool) -> str:
    """The absolute dotted module of a (possibly relative) ``from`` import."""
    if not node.level:
        return node.module or ''
    package = importer if is_package else importer[:-1]
    base = package[:len(package) - node.level + 1]   # level 1 = this package, 2 = its parent, ...
    return '.'.join((*base, *(node.module.split('.') if node.module else ())))


def _dotted(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        head = _dotted(node.value)
        return f'{head}.{node.attr}' if head else None
    return None


def _bindings(tree: ast.Module, importer: tuple[str, ...], is_package: bool,
              index: ModuleIndex) -> tuple[dict[str, set[tuple[str, ...]]], set[str], list[tuple[str, str]]]:
    """``(aliases, dotted_heads, from_imports)`` of one module.

    ``aliases``: a local name bound to a module (``import a.b as m``, ``from a import b``);
    ``dotted_heads``: the first part of each plain ``import a.b`` (reached as ``a.b.name``);
    ``from_imports``: ``(absolute source module, imported name)`` pairs, ``*`` included.
    """
    aliases: dict[str, set[tuple[str, ...]]] = {}
    dotted_heads: set[str] = set()
    from_imports: list[tuple[str, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname or '.' not in alias.name:
                    aliases.setdefault(alias.asname or alias.name, set()).update(index.resolve(alias.name))
                else:
                    dotted_heads.add(alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            source = _absolute(node, importer, is_package)
            for alias in node.names:
                from_imports.append((source, alias.name))
                # `from pkg import module` binds the submodule.
                aliases.setdefault(alias.asname or alias.name, set()).update(index.resolve(f'{source}.{alias.name}'))
    return aliases, dotted_heads, from_imports


def uses_in(tree: ast.Module, importer: tuple[str, ...], is_package: bool,
            index: ModuleIndex) -> Iterator[tuple[tuple[str, ...], str]]:
    """``(module, name)`` for every use this module makes of a name of another module (``*`` for a star import)."""
    aliases, dotted_heads, from_imports = _bindings(tree, importer, is_package, index)
    for source, name in from_imports:
        for module in index.resolve(source):
            yield module, name
    for node in ast.walk(tree):
        if not isinstance(node, ast.Attribute):
            continue
        base = _dotted(node.value)
        if base is None:
            continue
        if '.' not in base:
            modules = aliases.get(base, set())
        else:
            modules = index.resolve(base) if base.split('.')[0] in dotted_heads else set()
        for module in modules:
            yield module, node.attr


@dataclass(frozen=True)
class Export:
    module: tuple[str, ...]
    name: str

    @property
    def path(self) -> str:
        """The module's path without ``.py`` (the ``ALLOWED_UNUSED_EXPORTS`` key)."""
        return '/'.join(self.module)

    def __str__(self) -> str:
        return f'{self.path}.py: {self.name}'


def unused_exports(root: Path = ROOT, allowed: dict[str, frozenset[str]] | None = None) -> list[str]:
    """Every exported name no other production module under ``root`` uses."""
    allowed = ALLOWED_UNUSED_EXPORTS if allowed is None else allowed
    files = production_files(root)
    trees = {path: ast.parse(path.read_text(encoding='utf-8'), filename=str(path)) for path in files}
    index = ModuleIndex({module_parts(path, root) for path in files})
    exports = {Export(module_parts(path, root), name) for path, tree in trees.items()
               for name in declared_exports(tree)}
    used: set[tuple[tuple[str, ...], str]] = set()
    for path, tree in trees.items():
        importer = module_parts(path, root)
        for module, name in uses_in(tree, importer, path.name == '__init__.py', index):
            if module != importer:
                used.add((module, name))
    star = {module for module, name in used if name == '*'}
    return sorted(str(e) for e in exports
                  if (e.module, e.name) not in used and e.module not in star
                  and e.name not in allowed.get(e.path, frozenset()))


def _write(root: Path, files: Iterable[tuple[str, str]]) -> Path:
    for relative, text in files:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
    return root


def test_every_exported_name_has_a_production_importer():
    assert unused_exports() == []


def test_the_scan_sees_the_exports_it_judges():
    """Vacuity guard: an empty file list or a broken ``__all__`` parser would pass the gate above."""
    files = production_files()
    exporting = [path for path in files if declared_exports(ast.parse(path.read_text(encoding='utf-8')))]
    assert len(exporting) > 30
    assert ROOT / 'lambda' / 'shared' / 'api.py' in exporting
    assert not [path for path in files if 'test' in path.relative_to(ROOT).parts]


class TestAPlantedExport:
    """The gate fails on an unused export and passes once something imports it."""

    LIB = ('lambda/shared/lib.py', "__all__ = ['used', 'planted']\n\ndef used(): ...\n\ndef planted(): ...\n")

    def test_an_export_no_module_imports_is_reported(self, tmp_path):
        root = _write(tmp_path, [self.LIB, ('lambda/api/handler.py', 'from shared.lib import used\n')])
        assert unused_exports(root, allowed={}) == ['lambda/shared/lib.py: planted']

    def test_a_test_importing_it_does_not_count(self, tmp_path):
        root = _write(tmp_path, [self.LIB, ('lambda/api/handler.py', 'from shared.lib import used\n'),
                                 ('lambda/shared/test/test_lib.py', 'from shared.lib import planted\n')])
        assert unused_exports(root, allowed={}) == ['lambda/shared/lib.py: planted']

    def test_the_module_using_its_own_export_does_not_count(self, tmp_path):
        root = _write(tmp_path, [('lambda/shared/lib.py', "__all__ = ['planted']\n\ndef planted(): ...\n\nplanted()\n")])
        assert unused_exports(root, allowed={}) == ['lambda/shared/lib.py: planted']

    @pytest.mark.parametrize('importer', [
        'from shared.lib import used, planted\n',
        'from shared import lib\nlib.used()\nlib.planted()\n',
        'import shared.lib as lib\nlib.used()\nlib.planted()\n',
        'from shared.lib import *\n',
    ])
    def test_an_import_or_a_module_attribute_read_counts(self, tmp_path, importer):
        root = _write(tmp_path, [self.LIB, ('plugins/x/handler.py', importer)])
        assert unused_exports(root, allowed={}) == []

    def test_a_relative_import_inside_a_package_counts(self, tmp_path):
        root = _write(tmp_path, [('plugins/_shared/__init__.py', ''),
                                 ('plugins/_shared/audit.py', "__all__ = ['emit']\n\ndef emit(): ...\n"),
                                 ('plugins/_shared/base.py', 'from .audit import emit\n')])
        assert unused_exports(root, allowed={}) == []

    def test_an_allowlisted_entry_point_is_not_reported(self, tmp_path):
        root = _write(tmp_path, [self.LIB, ('lambda/api/handler.py', 'from shared.lib import used\n')])
        assert unused_exports(root, allowed={'lambda/shared/lib': frozenset({'planted'})}) == []
