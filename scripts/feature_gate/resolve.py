"""A registered test, resolved statically: it exists, the gate collects it, its digest, and the pinned command for it.

No test module is imported or run: every check here is static. A pytest node is found with ``ast`` under the rules of
voc-datalake/pytest.ini (pytest_static.py); a vitest ``describe > it`` or a Playwright ``describe > test`` title is
found from string literals by jsscan.py's token pass. A test is refused when it, a class or describe around it, or its
module is skipped (``skip``, ``skipif``, ``xfail``; ``.skip``, ``.skipIf``, ``.runIf``, ``.todo``, ``.fixme``,
``.fail``), when its file holds a ``.only`` anywhere, when its body skips itself unconditionally (``test.skip()``,
``test.skip(true)``), or, for Playwright, when its spec is not one the mock run takes (``MOCK_SPEC_NAMES``). A
conditional ``test.skip(cond, reason)`` inside a Playwright test is a note, shown in the evaluator's brief. The
runtime proof that a test runs and passes comes with the run per build (report.py).

THE DIGEST is sha256 over the test's whole file, its conftest.py chain (pytest: every one from its folder up to the
repository root), its suite's configs (pytest.ini; the vitest config and its setup files; playwright.config.ts) and
the repository files it imports that are not product code (its helpers and fixtures); the product files it imports are
left out. A change to the test or its own side no longer matches the digest its verdict was given for, and its
acceptance stops counting until it is evaluated again; a product edit never voids it.

Test ids (the CLI's ``<test>``): a pytest node ``<path>::[Class::]test_x``; a vitest ``<file>::<describe> > <it>``; a
Playwright ``<spec>::<describe> > <test>``, paths from the repository root, never absolute, never through ``..``.
"""
from __future__ import annotations

import ast
import hashlib
import os
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from . import jsscan, pytest_static, registry, verdict

SEP = ' > '
VITEST_SUITES = (
    ('voc-datalake/frontend/', 'frontend', 'voc-datalake/frontend'),
    ('voc-datalake/lambda/stream/', 'stream', 'voc-datalake/lambda/stream'),
    ('voc-datalake/lib/', 'cdk', 'voc-datalake'),
)
E2E_DIR = 'voc-datalake/frontend/e2e/'
MOCK_ENV = 'voc-datalake/frontend/e2e/lib/env.ts'
UNIT_RUNNERS = ('pytest', 'vitest')
E2E_RUNNERS = ('playwright',)
RUNNERS = UNIT_RUNNERS + E2E_RUNNERS


@dataclass
class Resolved:
    file: str
    segment: str = ''
    files: list[str] = field(default_factory=list)   # what the digest covers
    digest: str = ''
    problems: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _vitest_suite(path: str) -> tuple[str, str] | None:
    for prefix, suite, package in VITEST_SUITES:
        if path.startswith(prefix):
            return suite, package
    return None


def entry_from_id(test_id: str) -> dict[str, str]:
    """The runner fields of a test entry, from its id (ValueError when no runner owns it)."""
    path, sep, name = test_id.partition('::')
    if not sep or not name:
        raise ValueError(f'{test_id!r}: no runner owns it (a test id is <path>::<name>)')
    base = path.rsplit('/', 1)[-1]
    if base.endswith('.py') and (base.startswith('test_') or base.endswith('_test.py')):
        return {'runner': 'pytest', 'node': test_id}
    if path.startswith(E2E_DIR) and base.endswith('.spec.ts'):
        return {'runner': 'playwright', 'spec': path, 'title': name}
    suite = _vitest_suite(path)
    if suite and re.search(r'\.test\.tsx?\Z', base):
        return {'runner': 'vitest', 'suite': suite[0], 'file': path, 'name': name}
    raise ValueError(f'{test_id!r}: no runner owns it (pytest test_*.py, vitest *.test.ts(x) in frontend/src, '
                     f'lambda/stream or lib, Playwright {E2E_DIR}**/*.spec.ts)')


def test_id(entry: dict[str, Any]) -> str:
    runner = entry.get('runner')
    if runner == 'pytest':
        return str(entry['node'])
    if runner == 'vitest':
        return f'{entry["file"]}::{entry["name"]}'
    if runner == 'playwright':
        return f'{entry["spec"]}::{entry["title"]}'
    raise ValueError(f'unknown runner {runner!r}')


def entry_file(entry: dict[str, Any]) -> str:
    return test_id(entry).partition('::')[0]


def layer_of(entry: dict[str, Any]) -> str:
    return 'e2e' if entry.get('runner') in E2E_RUNNERS else 'unit'


def red_name(entry: dict[str, Any]) -> str:
    """What a failing run must print to show it is this test: a pytest node id, a vitest or Playwright title."""
    if entry.get('runner') == 'pytest':
        return str(entry['node'])
    return test_id(entry).partition('::')[2].split(SEP)[-1]


def test_key(entry: dict[str, Any]) -> tuple[str, str]:
    """(file, test) whatever spelling names it: a pytest node's parameters do not make another test."""
    path, _, name = test_id(entry).partition('::')
    if entry.get('runner') == 'pytest':
        parts = name.split('::')
        parts[-1] = parts[-1].split('[', 1)[0]
        name = '::'.join(parts)
    return path, name


def _canonical(path: str) -> bool:
    """Relative and in canonical form (no ``./``, ``//``, ``..``, as ``os.path.normpath`` writes it)."""
    pure = PurePosixPath(path)
    return bool(path) and not pure.is_absolute() and '..' not in pure.parts and os.path.normpath(path) == path \
        and '//' not in path


def _unsafe(root: Path, path: str) -> str | None:
    """Why a file the resolver would read is refused: a link on its path, or a real path outside the root."""
    if registry.link_on_path(root / path, root) is not None:
        return f'{path} is a link: the gate never reads a test, a config or an import through one'
    if not (root / path).resolve().is_relative_to(root.resolve()):
        return f'{path} resolves outside the repository'
    return None


def _safe(root: Path, path: str) -> bool:
    """Canonical, no link on its path, and inside the root once resolved."""
    return _canonical(path) and _unsafe(root, path) is None


def _conftests(root: Path, path: str) -> list[str]:
    out = []
    folder = PurePosixPath(path).parent
    while True:
        rel = (folder / 'conftest.py').as_posix().removeprefix('./')
        if (root / rel).is_file():
            out.append(rel)
        if folder == PurePosixPath('.'):
            return out
        folder = folder.parent


IMPORT_EXTS = ('', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx')
PLAYWRIGHT_CONFIG = 'voc-datalake/frontend/e2e/playwright.config.ts'


def _relative_imports(root: Path, path: str, source: str) -> list[str]:
    """The repository files the module imports by a relative path (``from './x'``, ``import '../y'``), one level."""
    tokens = jsscan.tokenize(source)
    out: list[str] = []
    for k, tok in enumerate(tokens):
        prev = tokens[k - 1] if k else None
        if tok.kind != 'str' or not (tok.value or '').startswith('.') or prev is None or prev.kind != 'id' or \
                prev.value not in ('from', 'import'):
            continue
        base = (PurePosixPath(path).parent / str(tok.value)).as_posix()
        for ext in IMPORT_EXTS:
            rel = os.path.normpath(base + ext)
            if _canonical(rel) and ((root / rel).is_file() or (root / rel).is_symlink()):
                if rel not in out:
                    out.append(rel)
                break
    return out


def _python_imports(root: Path, path: str, source: str, problems: list[str]) -> list[str]:
    """The repository modules a pytest file imports (one level): ``import a.b`` / ``from a.b import c`` found from the
    test's folder or any folder above it up to the pytest rootdir (as the suite's conftest puts them on sys.path), a
    relative ``from .x import y`` from the test's own package (one above the repository is a problem line)."""
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return []
    here = PurePosixPath(path).parent
    roots = [here, *[p for p in here.parents if p.as_posix().startswith(pytest_static.ROOTDIR)]]
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            wanted = [(roots, a.name) for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level:
            if node.level - 2 >= len(here.parents):
                problems.append(f'{path} line {node.lineno}: a relative import above the repository '
                                f'(from {"." * node.level}{node.module or ""} import)')
                continue
            base = here.parents[node.level - 2] if node.level > 1 else here
            wanted = [([base], node.module or a.name) for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            wanted = [(roots, node.module)]
        else:
            continue
        for folders, module in wanted:
            found = _module_file(root, folders, module)
            if found and found != path and found not in out:
                out.append(found)
    return out


def _module_file(root: Path, folders: list[PurePosixPath], module: str) -> str | None:
    rel = module.replace('.', '/')
    for folder in folders:
        for candidate in (f'{folder.as_posix()}/{rel}.py', f'{folder.as_posix()}/{rel}/__init__.py'):
            if (root / candidate).is_file():
                return candidate
    return None


def _setup_files(root: Path, config: str) -> list[str]:
    """The files a vitest config names as ``setupFiles`` or ``globalSetup`` (string literals, relative to the
    config's package)."""
    tokens = jsscan.tokenize((root / config).read_text(encoding='utf-8'))
    package = PurePosixPath(config).parent
    out: list[str] = []
    for k, tok in enumerate(tokens):
        if tok.kind != 'id' or tok.value not in ('setupFiles', 'globalSetup'):
            continue
        for value in jsscan.literal_values(tokens, k + 1):
            rel = os.path.normpath((package / value).as_posix())
            if _canonical(rel) and ((root / rel).is_file() or (root / rel).is_symlink()) and rel not in out:
                out.append(rel)
    return out


def _configs(root: Path, runner: str, path: str) -> list[str]:
    if runner == 'pytest':
        candidates = [pytest_static.INI]
    elif runner == 'playwright':
        candidates = [PLAYWRIGHT_CONFIG]
    else:
        package = (_vitest_suite(path) or ('', 'voc-datalake'))[1]
        candidates = [f'{package}/vitest.config.ts', f'{package}/vitest.config.mts']
    found = [c for c in candidates if (root / c).is_file()]
    if runner == 'vitest':
        found += [f for c in list(found) for f in _setup_files(root, c)]
    return found


def _digest(root: Path, files: list[str]) -> str:
    h = hashlib.sha256()
    for rel in files:
        h.update(rel.encode('utf-8') + b'\0' + (root / rel).read_bytes() + b'\0')
    return h.hexdigest()


# ---- vitest / Playwright ----

def mock_spec_names(root: Path) -> list[str] | None:
    """The spec names the mock run takes: the string literals of ``MOCK_SPEC_NAMES = [...]`` in the e2e env module."""
    path = root / MOCK_ENV
    if not path.is_file():
        return None
    tokens = jsscan.tokenize(path.read_text(encoding='utf-8'))
    start = next((k for k, t in enumerate(tokens) if t.kind == 'id' and t.value == 'MOCK_SPEC_NAMES'), None)
    if start is None:
        return None
    # The list after `=` (a type annotation such as `readonly string[]` has brackets of its own).
    equals = next((k for k in range(start, len(tokens)) if tokens[k].kind == 'punct' and tokens[k].value == '='),
                  len(tokens))
    if not (equals + 1 < len(tokens) and tokens[equals + 1].kind == 'punct' and tokens[equals + 1].value == '['):
        return None
    names: list[str] = []
    for tok in tokens[equals + 2:]:
        if tok.kind == 'punct' and tok.value == ']':
            return names
        if tok.kind == 'str' and tok.value is not None:
            names.append(tok.value)
    return None


def _mock_problem(root: Path, spec: str) -> str | None:
    names = mock_spec_names(root)
    if names is None:
        return f'{spec}: no MOCK_SPEC_NAMES list in {MOCK_ENV}'
    name = PurePosixPath(spec).name.removesuffix('.spec.ts')
    if name not in names:
        return f'{spec}: {name} is not in MOCK_SPEC_NAMES ({MOCK_ENV}), so the mock run skips it'
    return None


def _resolve_js(source: str, name: str, runner: str, out: Resolved) -> None:
    path = out.file
    scan = jsscan.scan(source)
    if scan.has_only:
        out.problems.append(f'{path} holds a .only: the gate would run only that test')
    if scan.file_skip == 'always':
        out.problems.append(f'{path} skips every test at file level: the gate does not run it')
    elif scan.file_skip == 'conditional':
        out.notes.append(f'{path} has a file-level conditional skip')
    matches = [b for b in scan.blocks if b.kind == 'test' and b.path == name]
    if not matches:
        out.problems.append(f'no test {name!r} in {path} (titles are matched from string literals, joined by "{SEP}")')
        return
    if len(matches) > 1:
        out.problems.append(f'{name!r} is named twice in {path}')
        return
    block = matches[0]
    out.segment = source[block.start:block.end]
    for mod in block.skipped_by:
        out.problems.append(f'{name!r} is {mod}: the gate does not run it')
    if block.self_skip:
        out.problems.append(f'{name!r} calls skip() unconditionally: the gate does not run it')
    if block.conditional_skip and runner == 'playwright':
        out.notes.append(f'{name!r} has a conditional skip (it may skip itself on the mock or a deployment)')


def resolve(root: Path, entry: dict[str, Any]) -> Resolved:
    runner = entry.get('runner')
    if runner not in RUNNERS:
        return Resolved('', problems=[f'unknown runner {runner!r}'])
    path, _, rest = test_id(entry).partition('::')
    out = Resolved(path)
    if not _safe(root, path):
        out.problems.append(f'{path}: a test path is relative to the repository root, in canonical form (no ./, //, '
                            '..), and inside it')
        return out
    if not (root / path).is_file():
        out.problems.append(f'no file {path}')
        return out
    source = (root / path).read_text(encoding='utf-8')
    if runner == 'pytest':
        cfg = pytest_static.config(root)
        problem = pytest_static.path_problem(cfg, path)
        out.problems += [problem] if problem else []
        out.segment = pytest_static.find(source, path, rest, cfg, out.problems)
        out.files = [path, *_conftests(root, path), *_configs(root, 'pytest', path),
                     *_python_imports(root, path, source, out.problems)]
    else:
        if runner == 'playwright' and (problem := _mock_problem(root, path)):
            out.problems.append(problem)
        _resolve_js(source, rest, str(runner), out)
        out.files = [path, *_configs(root, str(runner), path), *_relative_imports(root, path, source)]
    # Every file the digest reads is the repository's own: never through a link, never resolving outside the root.
    refused = {f: why for f in out.files if (why := _unsafe(root, f))}
    out.problems += list(refused.values())
    # Product code the test imports is what the test proves, not the test: an edit there must not void its acceptance.
    # The test's own side (its file, helpers, fixtures, conftest, configs) stays in the digest.
    out.files = [f for k, f in enumerate(out.files) if f not in refused and (k == 0 or not verdict.is_product_path(f))]
    out.digest = _digest(root, out.files)
    return out


JS_SPECIAL_RE = re.compile(r'[.*+?^${}()|[\]\\/]')


def _js_regex(text: str) -> str:
    """A JavaScript regex source that matches ``text`` literally (vitest's -t, Playwright's -g)."""
    return JS_SPECIAL_RE.sub(lambda m: '\\' + m.group(0), text)


def command(entry: dict[str, Any]) -> str:
    """The exact command an evaluator runs, from the repository root (scripts/pinned.sh: pinned and capped).

    vitest's -t and Playwright's -g match the describe titles and the test's joined by spaces, both anchored at the
    end (Playwright's full title starts with the project and the file). An ``it.each`` title with ``%s``
    placeholders matches no expanded name: run its file and read that test's lines.
    """
    runner = entry['runner']
    if runner == 'pytest':
        return ('bash scripts/pinned.sh python -m pytest -c voc-datalake/pytest.ini --rootdir voc-datalake '
                f'-p no:cacheprovider --no-cov -q {shlex.quote(str(entry["node"]))}')
    if runner == 'vitest':
        suite = _vitest_suite(str(entry['file']))
        package = suite[1] if suite else 'voc-datalake'
        rel = str(entry['file']).removeprefix(package + '/')
        full = ' '.join(str(entry['name']).split(SEP))
        return (f'bash scripts/pinned.sh npx --prefix {package} vitest run --root {package} {shlex.quote(rel)} '
                f'-t {shlex.quote("^" + _js_regex(full) + "$")}')
    full = ' '.join(str(entry['title']).split(SEP))
    return ('bash scripts/pinned.sh env E2E_MOCK=1 npx --prefix voc-datalake/frontend/e2e playwright test '
            f'-c voc-datalake/frontend/e2e/playwright.config.ts {shlex.quote(str(entry["spec"]))} '
            f'-g {shlex.quote("(^| )" + _js_regex(full) + "$")}')
