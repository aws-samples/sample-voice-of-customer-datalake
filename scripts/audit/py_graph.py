"""AST reachability over ONE Lambda bundle: which top-level defs, classes, methods and constants run.

Roots: the handler named by the template, every top-level statement of a loaded module (imports run
module code), and decorator registrations (``@app.get``, ``@app.exception_handler``, pydantic
validators). From there it follows names, ``alias.attr`` chains into modules, function-local imports,
``from x import *`` (via ``__all__``) and re-exports, to a fixed point. Dynamic dispatch is kept alive
CONSERVATIVELY, so a finding is high-confidence:

* a method of a live class stays alive if its name is used as an attribute anywhere live (``obj.name``);
* an identifier-shaped string literal in live code (``getattr`` dispatch, ASL ``action`` names, conductor
  tables, ``'module.attr'`` paths) keeps a same-named top-level def alive;
* ``import_module('a.b')`` / ``import_module(MODULE_CONSTANT)`` load that module, and
  ``import_module(f'agents.nodes.{kind}')`` loads every module under the prefix whose last part is a live
  string (the node-type names); a dynamic module's defs are reached by attribute name;
* every method of a class with a third-party base (``HTMLParser``, ``BasePartialProcessor``) stays alive,
  and dunders always do.

``__all__`` is NOT a use (vulture's blind spot): its strings are only read when a star import needs them.
"""
from __future__ import annotations

import ast
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

REGISTERING_DECORATORS = frozenset({
    'get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'route', 'exception_handler', 'not_found',
    'field_validator', 'model_validator', 'validator', 'root_validator', 'field_serializer', 'include_router',
})
# Bases whose methods the base itself never calls back (so a method there is judged like any other).
NON_CALLING_BASES = frozenset({
    'Exception', 'BaseException', 'ValueError', 'RuntimeError', 'KeyError', 'TypeError', 'LookupError',
    'PermissionError', 'IOError', 'OSError', 'TimeoutError', 'ConnectionError', 'object', 'TypedDict',
    'NamedTuple', 'Protocol', 'Enum', 'IntEnum', 'StrEnum', 'str', 'int', 'dict', 'list', 'Generic', 'ABC',
    'BaseModel',
})
_IDENT_PATH = re.compile(r'[A-Za-z_][A-Za-z0-9_.]*')
Key = tuple[str, str]   # (module name in the bundle, qualified name)


def strip_docstrings(tree: ast.AST) -> None:
    """Docstrings are prose: a name in one must not keep a def alive."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
                    and isinstance(body[0].value.value, str):
                node.body = body[1:] or [ast.Pass()]


def decorator_name(node: ast.expr) -> str | None:
    if isinstance(node, ast.Call):
        node = node.func
    if isinstance(node, ast.Attribute):
        return node.attr
    return node.id if isinstance(node, ast.Name) else None


def base_name(node: ast.expr) -> str | None:
    if isinstance(node, ast.Subscript):
        node = node.value
    return decorator_name(node)


@dataclass
class Binding:
    module: str
    symbol: str | None = None   # None: the name is bound to the module itself


@dataclass
class ModuleInfo:
    """One parsed module, under the name it has inside a bundle (relative imports depend on it)."""

    name: str
    path: Path
    is_package: bool
    tree: ast.Module = field(init=False)
    defs: dict[str, ast.AST] = field(default_factory=dict)
    imports: dict[str, Binding] = field(default_factory=dict)
    dotted: set[str] = field(default_factory=set)        # plain `import a.b.c`
    roots: list[ast.AST] = field(default_factory=list)   # executed at import
    exports: list[str] = field(default_factory=list)     # __all__

    def __post_init__(self) -> None:
        self.tree = ast.parse(self.path.read_text(encoding='utf-8'), str(self.path))
        strip_docstrings(self.tree)
        for statement in self.tree.body:
            self._top(statement)

    def _top(self, st: ast.stmt) -> None:
        if isinstance(st, ast.FunctionDef | ast.AsyncFunctionDef):
            self.defs[st.name] = st
            self.roots += [*st.decorator_list, *st.args.defaults, *(d for d in st.args.kw_defaults if d)]
        elif isinstance(st, ast.ClassDef):
            self._class(st)
        elif isinstance(st, ast.Import | ast.ImportFrom):
            self.bind_import(st)
        elif isinstance(st, ast.Assign | ast.AnnAssign):
            self._assign(st)
        elif isinstance(st, ast.If | ast.Try | ast.TryStar):
            self._compound(st)
        else:
            self.roots.append(st)

    def _class(self, st: ast.ClassDef) -> None:
        self.defs[st.name] = st
        self.roots += st.decorator_list
        for item in st.body:
            if isinstance(item, ast.FunctionDef | ast.AsyncFunctionDef):
                self.defs[f'{st.name}.{item.name}'] = item
                self.roots += item.decorator_list

    def _assign(self, st: ast.Assign | ast.AnnAssign) -> None:
        targets = st.targets if isinstance(st, ast.Assign) else [st.target]
        names = [t.id for t in targets if isinstance(t, ast.Name)]
        if '__all__' in names and isinstance(st.value, ast.List | ast.Tuple):
            self.exports = [e.value for e in st.value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
            return
        if names and len(names) == len(targets):
            for name in names:
                self.defs[name] = st
        else:
            self.roots.append(st)

    def _compound(self, st: ast.If | ast.Try | ast.TryStar) -> None:
        """`if TYPE_CHECKING:` / `try: import x except ImportError:` still bind module names."""
        blocks = [st.body, st.orelse, *([h.body for h in st.handlers] if not isinstance(st, ast.If) else [])]
        if isinstance(st, ast.If):
            self.roots.append(st.test)
        else:
            self.roots += [h.type for h in st.handlers if h.type]
            blocks.append(st.finalbody)
        for block in blocks:
            for sub in block:
                if isinstance(sub, ast.Assign | ast.AnnAssign):
                    self._assign(sub)
                    self.roots.append(sub)   # a conditional assignment always runs one branch
                else:
                    self._top(sub)

    def absolute(self, node: ast.ImportFrom) -> str:
        if not node.level:
            return node.module or ''
        package = self.name.split('.') if self.is_package else self.name.split('.')[:-1]
        base = package[:len(package) - node.level + 1]
        return '.'.join([*base, *([node.module] if node.module else [])])

    def bind_import(self, node: ast.Import | ast.ImportFrom) -> list[Binding]:
        bound: list[Binding] = []
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    binding = Binding(alias.name)
                    self.imports[alias.asname] = binding
                else:
                    head = alias.name.split('.')[0]
                    binding = Binding(alias.name)
                    self.imports.setdefault(head, Binding(head))
                    self.dotted.add(alias.name)
                bound.append(binding)
            return bound
        source = self.absolute(node)
        for alias in node.names:
            binding = Binding(source, alias.name)
            if alias.name != '*':
                self.imports[alias.asname or alias.name] = binding
            bound.append(binding)
        return bound


class ParseCache:
    def __init__(self) -> None:
        self._mods: dict[tuple[Path, str], ModuleInfo | None] = {}

    def get(self, path: Path, name: str) -> ModuleInfo | None:
        key = (path, name)
        if key not in self._mods:
            try:
                self._mods[key] = ModuleInfo(name, path, path.name == '__init__.py')
            except (SyntaxError, UnicodeDecodeError):
                self._mods[key] = None
        return self._mods[key]


@dataclass
class Reach:
    alive: set[Key] = field(default_factory=set)
    loaded: set[str] = field(default_factory=set)
    strings: set[str] = field(default_factory=set)       # every live string literal (full text)
    bindings: set[Key] = field(default_factory=set)      # import bindings some live code read
    attrs: set[str] = field(default_factory=set)         # every attribute name live code uses
    why: dict[Key, Key] = field(default_factory=dict)    # first (module, qualname) that reached a def or module

    def chain(self, key: Key) -> list[Key]:
        """How ``key`` was reached, entry first (modules appear as ``(name, '<module>')``)."""
        path = [key]
        while path[-1] in self.why and len(path) < 60:
            path.append(self.why[path[-1]])
        return path[::-1]


class Graph:
    """Fixed-point reachability over one bundle (``modules``: importable name -> source file)."""

    def __init__(self, modules: dict[str, Path], cache: ParseCache | None = None) -> None:
        self.files = modules
        self.cache = cache or ParseCache()
        self.reach = Reach()
        self.attrs: set[str] = self.reach.attrs
        self.idents: set[str] = set()
        self.prefixes: set[str] = set()
        self.dynamic: set[str] = set()
        self.dynamic_names: set[str] = set()   # literal module names passed to import_module
        self.current: Key = ('<entry>', '')
        self.work: list[tuple[ModuleInfo, ast.AST]] = []

    def mod(self, name: str) -> ModuleInfo | None:
        path = self.files.get(name)
        return self.cache.get(path, name) if path else None

    # --- loading and marking -------------------------------------------------------------
    def load(self, name: str) -> ModuleInfo | None:
        info = self.mod(name)
        if info is None or name in self.reach.loaded:
            return info
        self.reach.loaded.add(name)
        self.reach.why.setdefault((name, '<module>'), self.current)
        parts = name.split('.')
        for i in range(1, len(parts)):
            self.load('.'.join(parts[:i]))
        self.work += [(info, root) for root in info.roots]
        for binding in list(info.imports.values()):
            self.follow_import(binding, mark_symbol=False)
        for dotted in info.dotted:
            self.load(dotted)
        return info

    def follow_import(self, binding: Binding, *, mark_symbol: bool) -> None:
        if binding.symbol is None:
            self.load(binding.module)
            return
        if binding.symbol == '*':
            target = self.load(binding.module)
            for name in (target.exports if target else []):
                self.mark(target, name)
            return
        if self.mod(f'{binding.module}.{binding.symbol}') is not None:
            self.load(f'{binding.module}.{binding.symbol}')
            return
        target = self.load(binding.module)
        if target is not None and mark_symbol:
            self.mark(target, binding.symbol)

    def mark(self, info: ModuleInfo | None, qualname: str, depth: int = 0) -> None:
        if info is None or depth > 25:
            return
        if qualname in info.defs:
            key = (info.name, qualname)
            if key not in self.reach.alive:
                self.reach.alive.add(key)
                self.reach.why.setdefault(key, self.current)
                self.work.append((info, info.defs[qualname]))
                if '.' in qualname:
                    self.mark(info, qualname.split('.', maxsplit=1)[0], depth + 1)
            return
        binding = info.imports.get(qualname)
        if binding is not None:
            self.reach.bindings.add((info.name, qualname))
        if binding is not None and binding.symbol is not None:
            if self.mod(f'{binding.module}.{binding.symbol}') is not None:
                self.load(f'{binding.module}.{binding.symbol}')
            else:
                self.mark(self.load(binding.module), binding.symbol, depth + 1)

    # --- visiting --------------------------------------------------------------------------
    def module_of(self, info: ModuleInfo, node: ast.Attribute) -> tuple[str, str] | None:
        """``a.b.c.name`` where ``a.b.c`` names a module of the bundle -> (module, 'name')."""
        chain: list[str] = []
        cursor: ast.expr = node
        while isinstance(cursor, ast.Attribute):
            chain.append(cursor.attr)
            cursor = cursor.value
        if not isinstance(cursor, ast.Name):
            return None
        chain.reverse()
        binding = info.imports.get(cursor.id)
        if binding is None:
            return None
        module = binding.module if binding.symbol is None else f'{binding.module}.{binding.symbol}'
        if binding.symbol is None:
            for dotted in sorted(info.dotted, key=len, reverse=True):
                parts = dotted.split('.')
                if parts[0] == cursor.id and chain[:len(parts) - 1] == parts[1:]:
                    module, chain = dotted, chain[len(parts) - 1:]
                    break
        return (module, chain[0]) if chain and self.mod(module) is not None else None

    def dynamic_import(self, info: ModuleInfo, arg: ast.expr) -> None:
        """``import_module('a.b')``, ``import_module(NAME_CONSTANT)``, ``import_module(f'agents.nodes.{t}')``."""
        bound = info.defs.get(arg.id) if isinstance(arg, ast.Name) else None
        if isinstance(bound, ast.Assign | ast.AnnAssign) and bound.value is not None:
            arg = bound.value
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            self.dynamic_names.add(arg.value)
        elif isinstance(arg, ast.JoinedStr) and arg.values and isinstance(arg.values[0], ast.Constant):
            self.prefixes.add(str(arg.values[0].value))

    def visit_string(self, value: str) -> None:
        self.reach.strings.add(value)
        if _IDENT_PATH.fullmatch(value):
            for token in value.split('.'):
                self.idents.add(token)
                self.attrs.add(token)

    def visit_node(self, info: ModuleInfo, sub: ast.AST) -> None:
        if isinstance(sub, ast.Name):
            self.mark(info, sub.id)
        elif isinstance(sub, ast.Attribute):
            self.attrs.add(sub.attr)
            target = self.module_of(info, sub)
            if target:
                self.mark(self.load(target[0]), target[1])
        elif isinstance(sub, ast.Call) and decorator_name(sub.func) in ('import_module', '__import__') and sub.args:
            self.dynamic_import(info, sub.args[0])
        elif isinstance(sub, ast.Constant) and isinstance(sub.value, str):
            self.visit_string(sub.value)
        elif isinstance(sub, ast.Import | ast.ImportFrom):
            for binding in info.bind_import(sub):
                self.follow_import(binding, mark_symbol=True)

    def visit(self, info: ModuleInfo, node: ast.AST) -> None:
        nodes: Iterable[ast.AST] = [node]
        if isinstance(node, ast.ClassDef):
            nodes = [*(b for b in node.body if not isinstance(b, ast.FunctionDef | ast.AsyncFunctionDef)),
                     *node.bases, *node.keywords, *node.decorator_list]
            self.class_alive(info, node)
        for root in nodes:
            for sub in ast.walk(root):
                self.visit_node(info, sub)

    def is_local_base(self, info: ModuleInfo, base: ast.expr) -> bool:
        name = base_name(base)
        if name is None or name in info.defs:
            return True
        binding = info.imports.get(name)
        return binding is not None and (binding.module in self.files or f'{binding.module}.{name}' in self.files)

    def class_alive(self, info: ModuleInfo, node: ast.ClassDef) -> None:
        external = any(not self.is_local_base(info, b) and base_name(b) not in NON_CALLING_BASES for b in node.bases)
        for item in node.body:
            if isinstance(item, ast.FunctionDef | ast.AsyncFunctionDef):
                dunder = item.name.startswith('__') and item.name.endswith('__')
                if dunder or external:
                    self.mark(info, f'{node.name}.{item.name}')

    # --- fixed point -----------------------------------------------------------------------
    def dynamic_modules(self) -> Iterator[str]:
        for name in self.files:
            if name in self.reach.loaded:
                continue
            last = name.rsplit('.', 1)[-1]
            if name in self.dynamic_names or any(
                    p.endswith('.') and name.startswith(p) and name.count('.') == p.count('.') and last in self.idents
                    for p in self.prefixes):
                yield name

    def registered(self, node: ast.AST) -> bool:
        return isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and any(
            decorator_name(d) in REGISTERING_DECORATORS for d in node.decorator_list)

    def judge(self, name: str, qualname: str, node: ast.AST) -> bool:
        """The conservative rules for one not-yet-live def of a loaded module."""
        if '.' in qualname:
            cls, method = qualname.split('.', 1)
            return (name, cls) in self.reach.alive and (method in self.attrs or self.registered(node))
        if qualname in self.idents or self.registered(node):
            return True
        # `import_module(f'agents.nodes.{kind}').finish(...)`: a dynamic module's defs are reached by attribute.
        return name in self.dynamic and qualname in self.attrs

    def sweep(self) -> bool:
        """One pass of the conservative rules; True when it marked or loaded anything."""
        before = (len(self.reach.alive), len(self.reach.loaded))
        for name in list(self.dynamic_modules()):
            self.dynamic.add(name)
            self.load(name)
        for name in list(self.reach.loaded):
            info = self.mod(name)
            for qualname, node in (info.defs.items() if info else ()):
                if (name, qualname) not in self.reach.alive and self.judge(name, qualname, node):
                    self.mark(info, qualname)
        return (len(self.reach.alive), len(self.reach.loaded)) != before or bool(self.work)

    def run(self, entries: Iterable[Key]) -> Reach:
        for module, function in entries:
            info = self.load(module)
            if info is None:
                raise LookupError(f'entry module {module!r} is not in the bundle')
            self.mark(info, function)
        while True:
            while self.work:
                info, node = self.work.pop()
                self.current = (info.name, getattr(node, 'name', None) or '<module>')
                self.visit(info, node)
            self.current = ('<sweep>', '')
            if not self.sweep():
                return self.reach


def reexports(tree: ast.Module, is_package: bool) -> Iterator[tuple[str, ast.stmt]]:
    """Top-level import bindings a module offers to others: every one in a package ``__init__``,
    and any other module's imports it lists in ``__all__`` (ruff's F401 accepts both as "used")."""
    exported: set[str] = set()
    for st in tree.body:
        if isinstance(st, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '__all__' for t in st.targets) \
                and isinstance(st.value, ast.List | ast.Tuple):
            exported = {e.value for e in st.value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)}
    for st in tree.body:
        if isinstance(st, ast.ImportFrom) and st.module == '__future__':
            continue
        if isinstance(st, ast.Import | ast.ImportFrom):
            for alias in st.names:
                name = alias.asname or alias.name.split('.')[0]
                if alias.name != '*' and (is_package or name in exported):
                    yield name, st


def top_level_defs(tree: ast.Module) -> Iterator[tuple[str, ast.stmt, str]]:
    """``(qualname, node, kind)`` for every def, class, method and module constant of a source file."""
    for st in tree.body:
        if isinstance(st, ast.FunctionDef | ast.AsyncFunctionDef):
            yield st.name, st, 'function'
        elif isinstance(st, ast.ClassDef):
            yield st.name, st, 'class'
            for item in st.body:
                if isinstance(item, ast.FunctionDef | ast.AsyncFunctionDef):
                    yield f'{st.name}.{item.name}', item, 'method'
        elif isinstance(st, ast.Assign | ast.AnnAssign):
            targets = st.targets if isinstance(st, ast.Assign) else [st.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    yield target.id, st, 'constant'
