"""The third-party import names one Lambda's LIVE code executes, for py_layers (a library: no detector marker).

Input is a ``py_reachability`` :class:`FunctionReach`: the bundle's modules, which of them load, and which
top-level defs and methods are alive. An import counts when it runs: at module level (inside ``if`` / ``try`` /
``with`` too, but not under ``if TYPE_CHECKING``), in a class body, or inside a live function or method (nested
defs follow their enclosing def). ``importlib.import_module('name')`` / ``__import__('name')`` with a literal
count like an import. Relative imports, bundle modules and the standard library are not third-party.
An import inside a ``try`` that catches ``ImportError`` / ``ModuleNotFoundError`` is OPTIONAL: it still reaches
the distribution, but its absence is not a ``missing-distribution``.
"""
from __future__ import annotations

import ast
import sys
from collections.abc import Iterator
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from py_reachability import FunctionReach

#: Standard-library modules newer than the interpreter that may run the audit (3.12) knows.
NEWER_STDLIB = frozenset({'annotationlib', 'compression', '_interpreters', '_interpqueues', '_interpchannels'})
_IMPORT_ERRORS = frozenset({'ImportError', 'ModuleNotFoundError'})
_DYNAMIC_IMPORTERS = frozenset({'import_module', '__import__'})


@dataclass(frozen=True)
class ImportSite:
    module: str        # the dotted module named (relative imports: as written, resolved by :func:`targets`)
    owner: str | None  # top-level def / ``Class.method`` it runs in; None = runs when the module loads
    optional: bool
    level: int = 0
    symbols: tuple[str, ...] = ()   # ``from module import a, b``: each may be a submodule

    @property
    def name(self) -> str:
        """The top-level module name of an absolute import ('' for a relative one)."""
        return '' if self.level else self.module.split('.')[0]

    def targets(self, importer: str, is_package: bool) -> list[str]:
        """The dotted modules this import may load, for an importer module named ``importer``."""
        base = self.module
        if self.level:
            package = importer.split('.') if is_package else importer.split('.')[:-1]
            head = package[:len(package) - self.level + 1]
            base = '.'.join([*head, *([self.module] if self.module else [])])
        return [base, *(f'{base}.{symbol}' for symbol in self.symbols if symbol != '*')]


@dataclass
class _Walker:
    sites: list[ImportSite] = field(default_factory=list)

    def body(self, stmts: list[ast.stmt], owner: str | None, *, in_def: bool, optional: bool) -> None:
        for st in stmts:
            self.statement(st, owner, in_def=in_def, optional=optional)

    def statement(self, st: ast.stmt, owner: str | None, *, in_def: bool, optional: bool) -> None:
        if isinstance(st, ast.FunctionDef | ast.AsyncFunctionDef):
            self.body(st.body, owner if in_def else _qual(owner, st.name), in_def=True, optional=optional)
        elif isinstance(st, ast.ClassDef):
            # The class body runs with its module (or enclosing def); its methods are judged by name.
            for sub in st.body:
                if isinstance(sub, ast.FunctionDef | ast.AsyncFunctionDef) and not in_def:
                    self.body(sub.body, _qual(_qual(owner, st.name), sub.name), in_def=True, optional=optional)
                else:
                    self.statement(sub, owner, in_def=in_def, optional=optional)
        elif isinstance(st, ast.Import):
            self.sites += [ImportSite(a.name, owner, optional) for a in st.names]
        elif isinstance(st, ast.ImportFrom):
            self.sites.append(ImportSite(st.module or '', owner, optional, st.level, tuple(a.name for a in st.names)))
        elif isinstance(st, ast.If) and _is_type_checking(st.test):
            self.body(st.orelse, owner, in_def=in_def, optional=optional)
        elif isinstance(st, ast.Try | ast.TryStar):
            guarded = optional or any(_catches_import_error(h) for h in st.handlers)
            self.body(st.body, owner, in_def=in_def, optional=guarded)
            for handler in st.handlers:
                self.body(handler.body, owner, in_def=in_def, optional=optional)
            self.body(st.orelse + st.finalbody, owner, in_def=in_def, optional=optional)
        elif isinstance(st, ast.If | ast.For | ast.AsyncFor | ast.While | ast.With | ast.AsyncWith):
            self.body(st.body + getattr(st, 'orelse', []), owner, in_def=in_def, optional=optional)
        else:
            self.dynamic(st, owner, optional=optional)

    def dynamic(self, st: ast.stmt, owner: str | None, *, optional: bool) -> None:
        for node in ast.walk(st):
            if (isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str) and _callee(node.func) in _DYNAMIC_IMPORTERS):
                self.sites.append(ImportSite(node.args[0].value, owner, optional))


def _qual(owner: str | None, name: str) -> str:
    return f'{owner}.{name}' if owner else name


def _callee(func: ast.expr) -> str | None:
    return func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else None


def _is_type_checking(test: ast.expr) -> bool:
    return _callee(test) == 'TYPE_CHECKING'


def _catches_import_error(handler: ast.ExceptHandler) -> bool:
    kinds = handler.type.elts if isinstance(handler.type, ast.Tuple) else [handler.type] if handler.type else []
    return any(_callee(kind) in _IMPORT_ERRORS for kind in kinds)


@lru_cache(maxsize=4096)
def import_sites(path: Path) -> tuple[ImportSite, ...]:
    """Every absolute import of one source file, with the def it runs in."""
    walker = _Walker()
    walker.body(ast.parse(path.read_text(encoding='utf-8')).body, None, in_def=False, optional=False)
    return tuple(walker.sites)


def library_closure(roots: set[str], modules: dict[str, Path]) -> set[str]:
    """The installed-library modules that load when ``roots`` are imported (``modules``: dotted name -> file).

    Every UNGUARDED import of a loaded library module counts, wherever it sits (a library's dead functions are
    not judged: conservative), and a module loads its parent packages. A guarded import (``try: from . import
    _lxml`` / ``except ImportError``) does not, so bs4 alone never loads lxml and urllib3 never loads its
    pyOpenSSL contrib (and with it cryptography).
    """
    loaded: set[str] = set()
    todo = [r for r in roots if r in modules]
    while todo:
        name = todo.pop()
        if name in loaded:
            continue
        loaded.add(name)
        parts = name.split('.')
        todo += [p for i in range(1, len(parts)) if (p := '.'.join(parts[:i])) in modules]
        path = modules[name]
        try:
            sites = import_sites(path)
        except (SyntaxError, UnicodeDecodeError, OSError):
            continue   # a template or py2 file shipped as data
        for site in sites:
            if not site.optional:
                todo += [t for t in site.targets(name, path.name == '__init__.py') if t in modules]
    return loaded


def is_stdlib(name: str) -> bool:
    return name in sys.stdlib_module_names or name in NEWER_STDLIB


def _live_sites(fr: FunctionReach, root: Path) -> Iterator[ImportSite]:
    for module in sorted(fr.reach.loaded):
        rel = fr.modules.get(module)
        if rel is None:
            continue
        for site in import_sites(root / rel):
            if site.owner is None or (module, site.owner) in fr.reach.alive:
                yield site


@dataclass
class LiveImports:
    """What one function's live code imports from outside its bundle and the standard library."""

    names: set[str] = field(default_factory=set)      # top-level names
    optional: set[str] = field(default_factory=set)   # names only ever imported under an ImportError guard
    modules: set[str] = field(default_factory=set)    # the dotted modules (roots of the library closure)


def live_imports(fr: FunctionReach, root: Path) -> LiveImports:
    local = {name.split('.')[0] for name in fr.modules}
    found = LiveImports()
    required: set[str] = set()
    for site in _live_sites(fr, root):
        if not site.name or site.name in local or is_stdlib(site.name):
            continue
        found.names.add(site.name)
        if not site.optional:
            required.add(site.name)
        found.modules.update(site.targets('', is_package=False))
    found.optional = found.names - required
    return found
