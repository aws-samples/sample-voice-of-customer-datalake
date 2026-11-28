"""A pytest node, found statically: the file pytest would collect, the class and the function, and what skips them.

The rules come from voc-datalake/pytest.ini (the gate's own pytest config): the rootdir is voc-datalake/, a file must
be under a ``testpaths`` folder, never under a ``norecursedirs`` folder or an ``--ignore=`` path of ``addopts``, and
match ``python_files``; a class must match ``python_classes`` and have no ``__init__``; a function must match
``python_functions``. Two definitions of one name in one scope are refused (pytest keeps the last, so the first
never runs). Skips: ``@pytest.mark.skip`` / ``skipif`` / ``xfail`` on the function or its class, a ``pytestmark``
(plain or annotated) of the module or the class, a module-level ``pytest.skip(...)``, and a mark bound to a
module-level name first (``later = pytest.mark.skip``; ``@later``). A skip decided at run time inside the body is
not seen: the run per build (report.py) proves it runs.
"""
from __future__ import annotations

import ast
import configparser
import fnmatch
import shlex
from dataclasses import dataclass, field
from pathlib import Path

ROOTDIR = 'voc-datalake'
INI = f'{ROOTDIR}/pytest.ini'
SKIPS = ('skip', 'skipif', 'xfail')
FunctionNode = ast.FunctionDef | ast.AsyncFunctionDef


@dataclass(frozen=True)
class Config:
    testpaths: tuple[str, ...] = ('lambda', 'plugins')
    norecursedirs: tuple[str, ...] = ('cdk.out', '.venv', 'node_modules', 'dist', 'frontend', '.git', 'layers',
                                      '_template')
    ignores: tuple[str, ...] = ('frontend', 'lambda/layers')
    files: tuple[str, ...] = ('test_*.py', '*_test.py')
    classes: tuple[str, ...] = ('Test*',)
    functions: tuple[str, ...] = ('test_*',)


def config(root: Path) -> Config:
    path = root / INI
    if not path.is_file():
        return Config()
    ini = configparser.RawConfigParser()
    ini.read_string(path.read_text(encoding='utf-8'))
    if not ini.has_section('pytest'):
        return Config()
    words = {key: tuple(ini.get('pytest', key).split()) for key in ini.options('pytest')}
    addopts = shlex.split(ini.get('pytest', 'addopts', fallback=''))
    default = Config()
    return Config(
        testpaths=words.get('testpaths', default.testpaths),
        norecursedirs=words.get('norecursedirs', default.norecursedirs),
        ignores=tuple(a.removeprefix('--ignore=') for a in addopts if a.startswith('--ignore=')),
        files=words.get('python_files', default.files),
        classes=words.get('python_classes', default.classes),
        functions=words.get('python_functions', default.functions),
    )


def _matches(name: str, patterns: tuple[str, ...]) -> bool:
    """pytest's rule: a pattern with a glob character is a glob, else a prefix."""
    return any(fnmatch.fnmatchcase(name, p) if any(c in p for c in '*?[') else name.startswith(p) for p in patterns)


def path_problem(cfg: Config, path: str) -> str | None:
    if not path.startswith(ROOTDIR + '/'):
        return f'{path} is outside {ROOTDIR}/, the pytest rootdir'
    rel = path.removeprefix(ROOTDIR + '/')
    parts = rel.split('/')
    if parts[0] not in cfg.testpaths:
        return f'{path} is outside the pytest testpaths ({", ".join(cfg.testpaths)})'
    for folder in parts[:-1]:
        if _matches_glob(folder, cfg.norecursedirs):
            return f'{path} is under {folder}, which pytest does not collect'
    for ignored in cfg.ignores:
        if rel == ignored or rel.startswith(ignored.rstrip('/') + '/'):
            return f'{path} is under --ignore={ignored}'
    if not any(fnmatch.fnmatchcase(parts[-1], p) for p in cfg.files):
        return f'{path} does not match python_files ({" ".join(cfg.files)})'
    return None


def _matches_glob(name: str, patterns: tuple[str, ...]) -> bool:
    return any(fnmatch.fnmatchcase(name, p) for p in patterns)


def _dotted(node: ast.expr) -> str:
    if isinstance(node, ast.Call):
        return _dotted(node.func)
    if isinstance(node, ast.Attribute):
        return f'{_dotted(node.value)}.{node.attr}'
    if isinstance(node, ast.Name):
        return node.id
    return ''


@dataclass
class Marks:
    """The module-level names bound to a skip mark (``later = pytest.mark.skip``), and the names ``pytest.mark``
    itself was imported under (``from pytest import mark as m``)."""
    bound: dict[str, str] = field(default_factory=dict)
    mark_names: set[str] = field(default_factory=set)

    def of(self, expr: ast.expr | None) -> str | None:
        """'skip' / 'skipif' / 'xfail' when the expression is (or lists, or names) such a mark."""
        if expr is None:
            return None
        if isinstance(expr, ast.List | ast.Tuple):
            return next((m for e in expr.elts if (m := self.of(e))), None)
        if isinstance(expr, ast.Name) and expr.id in self.bound:
            return self.bound[expr.id]
        name = _dotted(expr)
        head, _, rest = name.partition('.')
        if head in self.mark_names and rest:
            name = f'pytest.mark.{rest}'
        return next((mark for mark in SKIPS if name.endswith(f'mark.{mark}')), None)


def _calls(stmt: ast.stmt, suffix: str) -> bool:
    """The statement is (or assigns) a call whose callee ends with ``suffix`` (``pytest.skip``, ``importorskip``)."""
    value = stmt.value if isinstance(stmt, ast.Expr | ast.Assign | ast.AnnAssign) else None
    return isinstance(value, ast.Call) and _dotted(value.func).endswith(suffix)


def _assigned(stmt: ast.stmt) -> tuple[str, ast.expr | None] | None:
    """(name, value) of a one-name assignment: plain, annotated or augmented (``pytestmark += [...]``)."""
    if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
        return stmt.targets[0].id, stmt.value
    if isinstance(stmt, ast.AnnAssign | ast.AugAssign) and isinstance(stmt.target, ast.Name):
        return stmt.target.id, stmt.value
    return None


def _flat(body: list[ast.stmt]) -> list[ast.stmt]:
    """The statements of a scope, those under its if / try / with / for / while included (never a def's body)."""
    return [s for stmt in body for s in [stmt, *[n for b in _nested(stmt) for n in _flat(b)]]]


def _module_marks(tree: ast.Module) -> Marks:
    marks = Marks()
    for stmt in tree.body:
        if isinstance(stmt, ast.ImportFrom) and stmt.module == 'pytest':
            marks.mark_names |= {a.asname or a.name for a in stmt.names if a.name == 'mark'}
        pair = _assigned(stmt)
        if pair and pair[0] != 'pytestmark' and (mark := marks.of(pair[1])):
            marks.bound[pair[0]] = mark
    return marks


def _pytestmark(body: list[ast.stmt], marks: Marks) -> str | None:
    """A skip in any ``pytestmark`` assignment of the scope, under an ``if`` too (any of them may be the one in force)."""
    for stmt in _flat(body):
        pair = _assigned(stmt)
        if pair and pair[0] == 'pytestmark' and (mark := marks.of(pair[1])):
            return mark
    return None


def _module_skip(tree: ast.Module, marks: Marks) -> str | None:
    for stmt in tree.body:
        if isinstance(stmt, ast.Expr) and _dotted(stmt.value) == 'pytest.skip':
            return 'skip'
    return _pytestmark(tree.body, marks)


def _defs(body: list[ast.stmt], name: str) -> list[ast.stmt]:
    return [s for s in body if isinstance(s, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) and s.name == name]


def _truth(test: ast.expr) -> bool | None:
    """The value of a constant condition (``False``, ``0``, ``None``, ``''``, ``not True``), None when it is not one."""
    if isinstance(test, ast.Constant):
        return bool(test.value)
    if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not) and (inner := _truth(test.operand)) is not None:
        return not inner
    return None


def _found_defs(body: list[ast.stmt], name: str, dead: bool = False) -> list[tuple[ast.stmt, bool]]:
    """The defs of ``name`` in a scope, under if / try / with / for / while too, each with whether it sits only under
    a branch that never runs (``if False:``, or the ``else`` of ``if True:``)."""
    out: list[tuple[ast.stmt, bool]] = [(s, dead) for s in _defs(body, name)]
    for stmt in body:
        if isinstance(stmt, ast.If):
            truth = _truth(stmt.test)
            out += _found_defs(stmt.body, name, dead or truth is False)
            out += _found_defs(stmt.orelse, name, dead or truth is True)
        else:
            out += [d for b in _nested(stmt) for d in _found_defs(b, name, dead)]
    return out


def _target_names(target: ast.expr) -> list[str]:
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, ast.Tuple | ast.List):
        return [n for e in target.elts for n in _target_names(e)]
    if isinstance(target, ast.Starred):
        return _target_names(target.value)
    return []


def _nested(stmt: ast.stmt) -> list[list[ast.stmt]]:
    """The statement lists of a compound statement that bind names in the same scope (never a def's body)."""
    if isinstance(stmt, ast.If | ast.While | ast.For | ast.AsyncFor):
        return [stmt.body, stmt.orelse]
    if isinstance(stmt, ast.With | ast.AsyncWith):
        return [stmt.body]
    if isinstance(stmt, ast.Try | ast.TryStar):
        return [stmt.body, *[h.body for h in stmt.handlers], stmt.orelse, stmt.finalbody]
    return []


def _bound_here(stmt: ast.stmt) -> list[str]:
    if isinstance(stmt, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
        return [stmt.name]
    if isinstance(stmt, ast.Assign):
        return [n for t in stmt.targets for n in _target_names(t)]
    if isinstance(stmt, ast.AnnAssign | ast.AugAssign | ast.For | ast.AsyncFor):
        return _target_names(stmt.target)
    if isinstance(stmt, ast.Import | ast.ImportFrom):
        return [a.asname or a.name.split('.', 1)[0] for a in stmt.names]
    if isinstance(stmt, ast.With | ast.AsyncWith):
        return [n for item in stmt.items if item.optional_vars for n in _target_names(item.optional_vars)]
    if isinstance(stmt, ast.Try | ast.TryStar):
        return [h.name for h in stmt.handlers if h.name]
    return []


def bindings(body: list[ast.stmt], name: str) -> int:
    """How many times the scope binds ``name``: defs, assignments, imports, loop and with targets, at any depth of
    if / try / with / for / while, never inside a def or a class."""
    return sum(_bound_here(s).count(name) + sum(bindings(b, name) for b in _nested(s)) for s in body)


def _sets_test_false(body: list[ast.stmt]) -> bool:
    return any((pair := _assigned(s)) and pair[0] == '__test__' and isinstance(pair[1], ast.Constant)
               and pair[1].value is False for s in body)


def _decorator_skip(node: ast.stmt, marks: Marks) -> str | None:
    if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
        return next((m for d in node.decorator_list if (m := marks.of(d))), None)
    return None


def _class_problems(cls: ast.ClassDef, cfg: Config, marks: Marks) -> list[str]:
    out = []
    if not _matches(cls.name, cfg.classes):
        out.append(f'class {cls.name} is not collected (python_classes {" ".join(cfg.classes)})')
    if _defs(cls.body, '__init__'):
        out.append(f'class {cls.name} has an __init__: pytest does not collect it')
    if _sets_test_false(cls.body):
        out.append(f'{cls.name} sets __test__ = False: pytest does not collect it')
    if mark := _pytestmark(cls.body, marks):
        out.append(f'{cls.name} is marked {mark}: the gate does not run it')
    return out


def _walk(tree: ast.Module, parts: list[str], path: str, cfg: Config, marks: Marks,
          problems: list[str]) -> FunctionNode | None:
    body: list[ast.stmt] = tree.body
    found: ast.stmt | None = None
    for k, part in enumerate(parts):
        defs = _found_defs(body, part)
        if not defs:
            problems.append(f'no test {"::".join(parts[:k + 1])} in {path}')
            return None
        if bindings(body, part) > 1:
            problems.append(f'{part} is defined twice in the same scope (pytest keeps the last)')
            return None
        live = [d for d, dead in defs if not dead]
        if not live:
            problems.append(f'{part} is bound only under an `if` that is always false: pytest never collects it')
            return None
        found = live[0]
        if mark := _decorator_skip(found, marks):
            problems.append(f'{part} is marked {mark}: the gate does not run it')
        if isinstance(found, ast.ClassDef):
            problems += _class_problems(found, cfg, marks)
            body = found.body
    if not isinstance(found, ast.FunctionDef | ast.AsyncFunctionDef):
        problems.append(f'{"::".join(parts)} is not a test function')
        return None
    if not _matches(found.name, cfg.functions):
        problems.append(f'{found.name} is not a test function (python_functions {" ".join(cfg.functions)})')
        return None
    if any(_calls(s, 'pytest.skip') for s in found.body):
        problems.append(f'{found.name} calls pytest.skip() in its body unconditionally: the gate does not run it')
    return found


def find(source: str, path: str, rest: str, cfg: Config, problems: list[str]) -> str:
    """The test function's source lines ('' when it is not found); every reason it would not run is in problems."""
    try:
        tree = ast.parse(source, filename=path)
    except (SyntaxError, ValueError, RecursionError, MemoryError) as err:
        problems.append(f'{path} cannot be parsed ({type(err).__name__})')
        return ''
    marks = _module_marks(tree)
    if _sets_test_false(tree.body):
        problems.append(f'{path} sets __test__ = False: pytest does not collect it')
    if any(_calls(s, 'importorskip') for s in _flat(tree.body)):
        problems.append(f'{path} calls pytest.importorskip at module level: it may skip every test')
    if mark := _module_skip(tree, marks):
        problems.append(f'{path} is marked {mark} at module level: the gate does not run it')
    parts = rest.split('::')
    parts[-1] = parts[-1].split('[', 1)[0]
    fn = _walk(tree, parts, path, cfg, marks, problems)
    if fn is None:
        return ''
    first = min([d.lineno for d in fn.decorator_list] + [fn.lineno])
    return '\n'.join(source.splitlines()[first - 1:fn.end_lineno])
