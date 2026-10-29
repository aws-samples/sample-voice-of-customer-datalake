#!/usr/bin/env python3
# audit-detector: run by scripts/audit/run-all.sh
"""py_doc_refs: Python comments and docstrings that name code, files or routes that do not exist.

PATTERN (hunt-python class 5, fixed in 5.34): a comment points at ``lib/stacks/api-enabled-sources.ts`` after the
code moved to ``api-data-lambdas.ts``, a docstring names ``handle_service_error`` after it became a mapping
table, a "mirrors ``extractKeywords``" note outlives the TypeScript it mirrored. A reader follows the pointer
and finds nothing; worse, a "kept in lockstep with X" promise nobody keeps.

HOW: the comments (``tokenize``) and docstrings of every production module under ``lambda/`` and ``plugins/``
are read. Three kinds of reference are checked:

- ``name``: a back-ticked identifier (`` `x` `` / ``` ``x`` ```, dotted paths too) or a bare ``name()``, whose last
  component has at least 4 characters, must occur as a CODE token somewhere: a Python name, attribute,
  argument, def, import or identifier inside a string (docstrings excluded) anywhere in the repo, a word of
  any TS / JS / JSON / shell / YAML / TOML file, or a token of the installed libraries and the standard
  library (site-packages, botocore's service models included), so ``ReturnConsumedCapacity`` is known. A name
  written as a prefix (`` `test_rebucketing_...` ``, `` `sup_` ``) needs a token that starts with it.
- ``path``: a repo path (``lambda/…``, ``plugins/…``, ``lib/…``, ``bin/…``, ``frontend/…``, ``scripts/…``,
  ``docs/…``, optionally under ``voc-datalake/``) must exist.
- ``route``: ``VERB /path`` must match a route of py_route_callers' table (``@app.<verb>`` in
  ``lambda/api/*_handler.py``), a route a shared router registers, or an API Gateway method of the synthesized
  app (py_assembly: ``/chat/stream``, webhooks, ``{proxy+}`` resources match any deeper path), path parameters
  as wildcards. A fragment (``POST /submit``) matches the tail of a route.

A sentence that says the thing is gone (``used to``, ``once``, ``was``, ``legacy``, ``former``, ``removed``,
``renamed``, ``retired``, ``no longer``) is history, not a pointer, and is skipped.

KEY: ``<path>::<reference>``. WHY THE REFERENCE TOOLS MISS IT: no linter reads prose; pyright resolves only code.

FALSE POSITIVES: a name of a tool outside the repo (a CLI flag, a console label), a placeholder (`` `<id>` ``
never matches). Allowlist ``{"key": ..., "reason": ...}`` in ``scripts/audit/allowlists/py_doc_refs.json``.

Run: ``voc-datalake/.venv/bin/python scripts/audit/py_doc_refs.py [--json]``.
"""
from __future__ import annotations

import argparse
import ast
import gzip
import io
import re
import sysconfig
import tokenize
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

from audit_common import Finding, detector_main, guard, iter_files, run_main, walk_py
from py_assembly import Assembly, load_assembly, refs
from py_graph import strip_docstrings
from py_route_callers import routes_in, segments

TOOL = 'py_doc_refs'
MIN_NAME = 4
MAX_RESOURCE_DEPTH = 30
#: Not code: an allowlist names the very references it excuses.
TOKEN_EXCLUDE = ('scripts/audit/allowlists/**',)
TEXT_SUFFIXES = ('.ts', '.tsx', '.mjs', '.cjs', '.js', '.json', '.sh', '.toml', '.yml', '.yaml', '.html')
LIBRARY_SUFFIXES = ('.py', '.pyi', '.json', '.json.gz')
_WORD = re.compile(r'[A-Za-z_]\w*')
_TICKED = re.compile(r'``?([A-Za-z_][\w.]*)(\(\))?(\.\.\.|…)?``?')
_CALLED = re.compile(r'(?<![\w.`])([A-Za-z_]\w*)\(\)')
_PATH = re.compile(r'(?<![\w/.-])((?:voc-datalake/)?(?:lambda|plugins|lib|bin|frontend|scripts|docs)/[\w./-]*\w'
                   r'\.(?:py|ts|tsx|json|md|mjs|cjs|sh|yml|yaml|html))\b')
_ROUTE = re.compile(r'\b(GET|POST|PUT|DELETE|PATCH) (/[\w{}<>/:.+$-]*[\w}>])')
_HISTORY = re.compile(r'\b(used to|once|was|were|legacy|former(ly)?|removed|renamed|retired|no longer|old|ported)\b',
                      re.IGNORECASE)
_ROUTER_DECORATOR = re.compile(r'^(get|post|put|delete|patch)$')


@dataclass(frozen=True)
class Note:
    file: str
    line: int
    text: str


def notes(cdk_dir: Path, rel: Path) -> Iterator[Note]:
    """Every comment and docstring of one module, one sentence at a time (so history wording stays local)."""
    source = (cdk_dir / rel).read_text(encoding='utf-8')
    texts = [(tok.start[0], tok.string) for tok in tokenize.generate_tokens(io.StringIO(source).readline)
             if tok.type == tokenize.COMMENT]
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Module | ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            doc = ast.get_docstring(node, clean=False)
            if doc and node.body:
                texts.append((node.body[0].lineno, doc))
    for line, text in texts:
        for sentence in re.split(r'(?<=[.;!?])\s+|\n\s*\n', text):
            yield Note(rel.as_posix(), line, sentence)


# ---- what exists -----------------------------------------------------------------------------------------------

def python_tokens(file: Path) -> set[str]:
    """Code tokens of one Python file: names, attributes, args, defs, imports and words in non-doc strings."""
    try:
        tree = ast.parse(file.read_text(encoding='utf-8'))
    except (SyntaxError, UnicodeDecodeError, ValueError):
        return set()
    strip_docstrings(tree)
    out: set[str] = set()
    for node in ast.walk(tree):
        for attr in ('id', 'attr', 'name', 'arg', 'asname', 'module'):
            value = getattr(node, attr, None)
            if isinstance(value, str):
                out.update(value.split('.'))
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            out.update(_WORD.findall(node.value))
    return out


def repo_tokens(repo: Path) -> set[str]:
    out: set[str] = set()
    for _, file in iter_files(repo, ('.',), ('.py',), include_tests=True, exclude=TOKEN_EXCLUDE):
        out |= python_tokens(file)
        out.add(file.stem)                     # a module named in prose: `test_feature_env_lockstep`
    for _, file in iter_files(repo, ('.',), TEXT_SUFFIXES, include_tests=True, exclude=TOKEN_EXCLUDE):
        out.add(file.name.split('.', 1)[0])
        try:
            out.update(_WORD.findall(file.read_text(encoding='utf-8', errors='ignore')))
        except OSError:
            continue
    return out


def library_known(candidates: set[str], site_packages: Path) -> set[str]:
    """The candidates that occur in the installed libraries (read only while some are still unseen)."""
    left, found = set(candidates), set()
    if not left or not site_packages.is_dir():
        return found
    for file in sorted(site_packages.rglob('*')):
        if not file.name.endswith(LIBRARY_SUFFIXES) or not file.is_file():
            continue
        try:
            raw = file.read_bytes()
            text = (gzip.decompress(raw) if file.name.endswith('.gz') else raw).decode('utf-8', errors='ignore')
        except (OSError, EOFError, gzip.BadGzipFile):
            continue
        hits = {name for name in left if name in text}
        found |= hits
        left -= hits
        if not left:
            break
    return found


def _resource_path(resources: dict, stack: str, rid: str, depth: int = 0) -> tuple[str, ...] | None:
    """Segments of an API Gateway resource (the REST API root = ``()``); ``{proxy+}`` = ``**``."""
    resource = resources.get(rid, {})
    props = resource.get('Properties', {})
    part = props.get('PathPart')
    if resource.get('Type') != 'AWS::ApiGateway::Resource' or not isinstance(part, str):
        return ()                            # the RestApi itself (its RootResourceId)
    parents = list(refs(props.get('ParentId'), stack, {}))
    if depth > MAX_RESOURCE_DEPTH:
        return None
    parent = _resource_path(resources, stack, parents[0].split('/', 1)[1], depth + 1) if parents else ()
    if parent is None:
        return None
    return (*parent, '**' if part.endswith('+}') else segments('/' + part)[0])


def gateway_routes(assembly: Assembly) -> Iterator[tuple[str, tuple[str, ...]]]:
    """(VERB, segments) of every API Gateway method of the synthesized app."""
    for stack, template in assembly.templates.items():
        resources = template.get('Resources', {})
        for method in resources.values():
            props = method.get('Properties', {})
            if method.get('Type') != 'AWS::ApiGateway::Method' or props.get('HttpMethod') == 'OPTIONS':
                continue
            targets = list(refs(props.get('ResourceId'), stack, {}))
            path = _resource_path(resources, stack, targets[0].split('/', 1)[1]) if targets else ()
            if path is not None:
                yield str(props.get('HttpMethod')), path


def route_table(cdk_dir: Path, assembly: Assembly) -> list[tuple[str, tuple[str, ...]]]:
    """(VERB, segments) of every handler route, every shared-router route and every API Gateway method."""
    table = [(r.verb, segments(r.path)) for r in routes_in(cdk_dir)] + list(gateway_routes(assembly))
    for rel in walk_py(cdk_dir):
        tree = ast.parse((cdk_dir / rel).read_text(encoding='utf-8'))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                    and _ROUTER_DECORATOR.match(node.func.attr) and node.args \
                    and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str) \
                    and node.args[0].value.startswith('/'):
                table.append((node.func.attr.upper(), segments(node.args[0].value)))
    return table


def _aligns(known: tuple[str, ...], wanted: tuple[str, ...]) -> bool:
    if known and known[-1] == '**':                       # {proxy+}: any deeper path under the prefix
        head = known[:-1]
        return len(wanted) > len(head) and _aligns(head, wanted[:len(head)])
    return len(known) == len(wanted) and all(a == b or '*' in (a, b) for a, b in zip(known, wanted, strict=True))


def route_known(verb: str, path: str, table: Iterable[tuple[str, tuple[str, ...]]]) -> bool:
    """A route of the table, or a fragment of one (``POST /submit`` = the tail of ``/feedback-forms/{id}/submit``)."""
    wanted = segments(path)
    for known_verb, known in table:
        if known_verb not in (verb, 'ANY'):
            continue
        if _aligns(known, wanted):
            return True
        literal = [s for s in known if s != '**']
        if 0 < len(wanted) < len(literal) and _aligns(tuple(literal[len(literal) - len(wanted):]), wanted):
            return True
    return False


# ---- judging ---------------------------------------------------------------------------------------------------

def references(note: Note) -> Iterator[tuple[str, str]]:
    """(kind, reference) pairs one sentence makes."""
    for match in _TICKED.finditer(note.text):
        name = match.group(1).rstrip('.')
        # `test_a_long_name_...` and `sup_` name a family by its prefix
        yield ('prefix' if match.group(3) or name.endswith('_') else 'name'), name + (match.group(2) or '')
    for match in _CALLED.finditer(note.text):
        yield 'name', f'{match.group(1)}()'
    for match in _PATH.finditer(note.text):
        yield 'path', match.group(1)
    for match in _ROUTE.finditer(note.text):
        yield 'route', f'{match.group(1)} {match.group(2)}'


def _last_name(reference: str) -> str:
    parts = [p for p in reference.removesuffix('()').split('.') if p]
    return parts[-1] if parts else ''


def _path_exists(repo: Path, cdk_dir: Path, reference: str) -> bool:
    return (repo / reference).exists() or (cdk_dir / reference.removeprefix('voc-datalake/')).exists()


@dataclass
class Candidate:
    note: Note
    kind: str
    reference: str


@dataclass
class Known:
    """What exists: code tokens, the route table, and the repo on disk."""

    cdk_dir: Path
    repo: Path
    tokens: set[str]
    routes: list[tuple[str, tuple[str, ...]]]

    def resolves(self, kind: str, reference: str) -> bool:
        name = _last_name(reference)
        if kind == 'name':
            return len(name) < MIN_NAME or name in self.tokens
        if kind == 'prefix':
            return len(name) < MIN_NAME or any(token.startswith(name) for token in self.tokens)
        if kind == 'path':
            return _path_exists(self.repo, self.cdk_dir, reference)
        verb, path = reference.split(' ', 1)
        return route_known(verb, path, self.routes)


def candidates(known: Known) -> tuple[list[Candidate], int]:
    """Every reference the repo itself does not resolve, and how many sentences were read."""
    out: list[Candidate] = []
    count = 0
    for rel in walk_py(known.cdk_dir):
        for note in notes(known.cdk_dir, rel):
            count += 1
            if _HISTORY.search(note.text):
                continue
            out.extend(Candidate(note, kind, ref) for kind, ref in references(note) if not known.resolves(kind, ref))
    return out, count


def findings(known: Known, libraries: Iterable[Path]) -> tuple[list[Finding], int]:
    found, count = candidates(known)
    names = {_last_name(c.reference) for c in found if c.kind == 'name'}
    library: set[str] = set()
    for directory in libraries:
        library |= library_known(names - library, directory)
    out: dict[str, Finding] = {}
    for c in found:
        if c.kind == 'name' and _last_name(c.reference) in library:
            continue
        key = f'{c.note.file}::{c.reference}'
        out.setdefault(key, Finding(f'missing-{"name" if c.kind == "prefix" else c.kind}', key, f'line {c.note.line}: {c.note.text.strip()[:110]}'))
    return sorted(out.values(), key=lambda f: (f.kind, f.key)), count


def scan(args: argparse.Namespace) -> tuple[list[Finding], str]:
    assembly = load_assembly(args.cdk_dir, refresh=args.refresh)
    known = Known(args.cdk_dir, args.cdk_dir.parent, repo_tokens(args.cdk_dir.parent), route_table(args.cdk_dir, assembly))
    paths = sysconfig.get_paths()
    found, count = findings(known, [Path(paths['purelib']), Path(paths['stdlib'])])
    guard(count >= 3000, f'only {count} comment / docstring sentences read')
    return found, f'{count} comment and docstring sentences read'


main = detector_main(TOOL, __doc__, scan)


if __name__ == '__main__':
    run_main(main)
