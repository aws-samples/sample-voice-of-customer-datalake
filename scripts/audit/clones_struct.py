# audit-detector: run by scripts/audit/run-all.sh
"""Structural near-duplicates in the Python source: the renamed clones jscpd cannot see.

PATTERN. Two pieces of code with the same shape: the same statements and expressions in the same order, but
with other variable, function, attribute and keyword names and other literal values. The 5.26-5.28 audits
found these by hand: hand-written ``LastEvaluatedKey`` loops, five ``plain()`` Decimal converters, seven
exception handlers that differed in one class name.

HOW. Every module is parsed with ``ast``. A fragment is either a function body (its signature included) or a
window of ``--window`` consecutive statements in any statement list. A fragment is turned into a token stream
of node types in which identifiers and attribute/keyword names are renamed consistently per fragment (first
name seen = ``i0``, next ``i1``...; attributes ``a0``...), and literals become their type (``str``, ``int``;
``None``/``True``/``False`` keep their value). Equal streams = a clone. Fragments smaller than
``--min-nodes`` AST nodes are ignored, adjacent matching windows are merged into one region, and a group whose
every copy sits inside a bigger reported group is dropped. Only groups spanning at least two files are
reported (``--same-file`` adds in-file copies).

WHY THE REFERENCE TOOLS MISS IT. jscpd compares token TEXT (mode ``weak`` only drops comments/whitespace), so
one renamed variable breaks a match; at the gate's 40 tokens / 5 lines it reported nothing for clusters the
audits then consolidated by hand. ruff/pyright/vulture do not look for duplication at all.

KNOWN FALSE POSITIVES. (1) Code that must stay a separate copy: a package that cannot import ``shared``
(``product_doc_extractor``), ``plugins/_shared`` vs ``lambda/shared`` (separate bundles), deliberate lockstep
mirrors. (2) Boilerplate of the same framework callback (decorator-only handlers). (3) Two short routines that
are equal by shape but mean different things (a sort key vs a filter). Raise ``--min-nodes`` for a coarser
view.

SILENCING. ``scripts/audit/allowlists/clones_struct.json``: ``{"entries": [{"files": [globs], "reason": "..."}]}``;
a group is silenced when EVERY copy's file matches one of the entry's globs. An optional ``"name"`` limits the
entry to groups where one copy is a function of that name. Every entry needs a reason.

Exit 0 = no clone groups, 1 = clone groups (or stale allowlist entries) reported, 2 = error (including a vacuous
scan: fewer than ``--min-files`` files parsed on the default scope). ``--json`` prints the JSON report instead of the
text one, ``--json PATH`` also writes it there.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import re
import sys
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from audit_common import (
    EXIT_ERROR,
    REPO,
    AuditError,
    add_json_flag,
    iter_files,
    matches_any,
    print_report,
    read_allowlist,
    say,
    split_allowlisted,
)

TOOL = 'clones_struct.py'
SUMMARY = 'Structural near-duplicates in the Python source: the renamed clones jscpd cannot see.'
DEFAULT_PATHS = ('voc-datalake/lambda', 'voc-datalake/plugins', 'voc-datalake/scripts', 'scripts')
DEFAULT_EXCLUDE = ('voc-datalake/lambda/stream/**',)
DEFAULT_ALLOWLIST = Path(__file__).resolve().parent / 'allowlists' / 'clones_struct.json'
DEFAULT_MIN_NODES = 40
DEFAULT_WINDOW = 3
#: A real-tree scan below this many files means the scope is wrong, not that the code is clean.
DEFAULT_MIN_FILES = 300
#: Near matches: Jaccard similarity of the blinded 4-gram sets, between functions of comparable size.
DEFAULT_SIMILARITY = 0.8
SHINGLE_WIDTH = 4
MAX_SIZE_RATIO = 1.3
_RENAMED = re.compile(r'[ia]\d+\Z')

_SKIP_FIELDS = frozenset({'ctx', 'type_comment', 'lineno', 'col_offset', 'end_lineno', 'end_col_offset'})
_IDENT_FIELDS = frozenset({'id', 'arg', 'name', 'names', 'asname', 'module'})
_ATTR_FIELDS = frozenset({'attr'})
_DEFS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
_IMPORTS = (ast.Import, ast.ImportFrom)


class _Shape:
    """Token stream of a fragment, with consistent per-fragment renaming."""

    def __init__(self) -> None:
        self.tokens: list[str] = []
        self.nodes = 0
        self._names: dict[tuple[str, str], str] = {}
        self._counts: dict[str, int] = defaultdict(int)

    def _rename(self, space: str, value: str) -> str:
        key = (space, value)
        if key not in self._names:
            self._names[key] = f'{space}{self._counts[space]}'
            self._counts[space] += 1
        return self._names[key]

    def _primitive(self, name: str, value: Any) -> None:
        if isinstance(value, str) and name in _IDENT_FIELDS:
            self.tokens.append(self._rename('i', value))
        elif isinstance(value, str) and name in _ATTR_FIELDS:
            self.tokens.append(self._rename('a', value))
        elif value is None or isinstance(value, bool):
            self.tokens.append(repr(value))
        else:
            self.tokens.append(type(value).__name__)

    def visit(self, node: ast.AST) -> None:
        if isinstance(node, ast.expr_context):
            return
        self.nodes += 1
        self.tokens.append(type(node).__name__)
        if isinstance(node, ast.keyword) and node.arg is not None:
            self.tokens.append(self._rename('a', node.arg))
        for name, value in ast.iter_fields(node):
            if name in _SKIP_FIELDS or (isinstance(node, ast.keyword) and name == 'arg'):
                continue
            if isinstance(value, ast.AST):
                self.visit(value)
            elif isinstance(value, list):
                self.tokens.append('[')
                for item in value:
                    if isinstance(item, ast.AST):
                        self.visit(item)
                    else:
                        self._primitive(name, item)
                self.tokens.append(']')
            else:
                self._primitive(name, value)
        self.tokens.append(')')

    def digest(self) -> str:
        return hashlib.sha1('\x1f'.join(self.tokens).encode(), usedforsecurity=False).hexdigest()

    def shingles(self, width: int = SHINGLE_WIDTH) -> frozenset[int]:
        """Hashed ``width``-grams of the stream with every renamed name blinded (for near matches)."""
        blind = ['_' if _RENAMED.match(t) else t for t in self.tokens]
        return frozenset(hash(tuple(blind[i:i + width])) for i in range(len(blind) - width + 1))


def _without_docstring(body: list[ast.stmt]) -> list[ast.stmt]:
    first = body[0] if body else None
    if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
        return body[1:]
    return body


@dataclass(frozen=True)
class Copy:
    path: str
    start: int
    end: int
    name: str = ''

    def contains(self, other: Copy) -> bool:
        return self.path == other.path and self.start <= other.start and other.end <= self.end


@dataclass
class Group:
    kind: str
    nodes: int
    copies: list[Copy] = field(default_factory=list)
    similarity: float = 1.0  # the weakest pair of a near-function cluster

    def as_json(self) -> dict[str, Any]:
        return {'kind': self.kind, 'nodes': self.nodes, 'similarity': self.similarity,
                'copies': [{'path': c.path, 'start': c.start, 'end': c.end, 'name': c.name} for c in self.copies]}


Loc = tuple[str, int, int]  # (path, statement-list id, window position)


@dataclass(frozen=True)
class _Window:
    digest: str
    copy: Copy
    nodes: int
    last_nodes: int  # nodes of the window's last statement: what a merged run adds per extra window


@dataclass(frozen=True)
class _Function:
    copy: Copy
    nodes: int
    digest: str
    shingles: frozenset[int]


@dataclass
class _Index:
    """Fragments by shape: function bodies, and statement windows keyed by location."""

    functions: list[_Function] = field(default_factory=list)
    windows: dict[Loc, _Window] = field(default_factory=dict)
    list_ids: int = 0


def _shape_of(nodes: list[ast.AST]) -> _Shape:
    shape = _Shape()
    for node in nodes:
        shape.visit(node)
    return shape


def _index_function(index: _Index, rel: str, node: ast.FunctionDef | ast.AsyncFunctionDef, min_nodes: int) -> None:
    body = _without_docstring(node.body)
    shape = _shape_of([node.args, *body])
    if body and shape.nodes >= min_nodes:
        copy = Copy(rel, node.lineno, node.end_lineno or node.lineno, node.name)
        index.functions.append(_Function(copy, shape.nodes, shape.digest(), shape.shingles()))


def _index_windows(index: _Index, rel: str, stmts: list[ast.stmt], window: int, min_nodes: int) -> None:
    index.list_ids += 1
    for i in range(len(stmts) - window + 1):
        chunk = stmts[i:i + window]
        if any(isinstance(s, _DEFS + _IMPORTS) for s in chunk):
            continue
        shape = _shape_of(list(chunk))
        if shape.nodes >= min_nodes:
            copy = Copy(rel, chunk[0].lineno, chunk[-1].end_lineno or chunk[-1].lineno)
            index.windows[(rel, index.list_ids, i)] = _Window(shape.digest(), copy, shape.nodes,
                                                              _shape_of([chunk[-1]]).nodes)


def index_module(index: _Index, rel: str, tree: ast.Module, *, window: int, min_nodes: int) -> None:
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            _index_function(index, rel, node, min_nodes)
        for name in ('body', 'orelse', 'finalbody'):
            stmts = getattr(node, name, None)
            if isinstance(stmts, list) and stmts and isinstance(stmts[0], ast.stmt):
                _index_windows(index, rel, _without_docstring(stmts), window, min_nodes)


def _spans_files(copies: list[Copy], same_file: bool) -> bool:
    return len(copies) > 1 and (same_file or len({c.path for c in copies}) > 1)


def _shift(locs: list[Loc], by: int) -> list[Loc]:
    return [(path, list_id, i + by) for path, list_id, i in locs]


class _WindowGroups:
    """Matching windows, adjacent ones merged: a run of windows that match in the same copies is one region."""

    def __init__(self, index: _Index) -> None:
        self.windows = index.windows
        self.by_hash: dict[str, list[Loc]] = defaultdict(list)
        for loc, win in sorted(self.windows.items()):
            self.by_hash[win.digest].append(loc)

    def is_group(self, locs: list[Loc]) -> bool:
        """True when ``locs`` are exactly the members of one shape group."""
        if any(loc not in self.windows for loc in locs):
            return False
        return self.by_hash[self.windows[locs[0]].digest] == locs

    def merged(self, locs: list[Loc]) -> Group:
        ends = [self.windows[loc].copy.end for loc in locs]
        nodes, run = self.windows[locs[0]].nodes, _shift(locs, 1)
        while self.is_group(run):
            ends = [self.windows[loc].copy.end for loc in run]
            nodes += self.windows[run[0]].last_nodes
            run = _shift(run, 1)
        starts = [self.windows[loc].copy for loc in locs]
        return Group('statements', nodes, [Copy(c.path, c.start, end) for c, end in zip(starts, ends, strict=True)])

    def groups(self, same_file: bool) -> list[Group]:
        found = []
        for locs in self.by_hash.values():
            if not _spans_files([self.windows[loc].copy for loc in locs], same_file):
                continue
            if self.is_group(_shift(locs, -1)):
                continue  # the continuation of a run that starts earlier
            found.append(self.merged(locs))
        return found


def _jaccard(a: frozenset[int], b: frozenset[int]) -> float:
    return len(a & b) / len(a | b) if a or b else 1.0


class _Clusters:
    """Union-find over function indexes, remembering each cluster's weakest link."""

    def __init__(self, size: int) -> None:
        self.parent = list(range(size))
        self.weakest: dict[int, float] = {}

    def root(self, i: int) -> int:
        while self.parent[i] != i:
            self.parent[i] = self.parent[self.parent[i]]
            i = self.parent[i]
        return i

    def join(self, i: int, j: int, score: float) -> None:
        ri, rj = self.root(i), self.root(j)
        self.weakest[ri] = min(score, self.weakest.get(ri, 1.0), self.weakest.get(rj, 1.0))
        self.parent[rj] = ri


def _similar_pairs(fns: list[_Function], similarity: float, same_file: bool) -> Iterator[tuple[int, int, float]]:
    """(i, j, score) for functions of comparable size (``fns`` sorted by size) that match exactly or nearly."""
    for i, a in enumerate(fns):
        for j in range(i + 1, len(fns)):
            b = fns[j]
            if b.nodes > a.nodes * MAX_SIZE_RATIO:
                break
            if a.copy.path == b.copy.path and not same_file:
                continue
            if a.digest == b.digest:
                yield i, j, 1.0
            elif (score := _jaccard(a.shingles, b.shingles)) >= similarity:
                yield i, j, score


def _function_groups(index: _Index, similarity: float, same_file: bool) -> list[Group]:
    """Functions whose blinded shapes overlap >= ``similarity``, as connected clusters.

    A cluster whose members all have the same exact shape is a ``function`` group, otherwise ``near-function``.
    """
    fns = sorted(index.functions, key=lambda f: f.nodes)
    clusters = _Clusters(len(fns))
    for i, j, score in _similar_pairs(fns, similarity, same_file):
        clusters.join(i, j, score)
    members_of: dict[int, list[_Function]] = defaultdict(list)
    for i, fn in enumerate(fns):
        members_of[clusters.root(i)].append(fn)
    groups = []
    for key, members in members_of.items():
        copies = sorted((m.copy for m in members), key=lambda c: (c.path, c.start))
        if _spans_files(copies, same_file):
            kind = 'function' if len({m.digest for m in members}) == 1 else 'near-function'
            groups.append(Group(kind, max(m.nodes for m in members), copies, round(clusters.weakest.get(key, 1.0), 2)))
    return groups


def _drop_nested(groups: list[Group]) -> list[Group]:
    """Biggest first; a group whose every copy lies inside a kept group's copy adds nothing."""
    kept: list[Group] = []
    for group in sorted(groups, key=lambda g: (-g.nodes, g.copies[0].path, g.copies[0].start)):
        if not all(any(k.contains(c) for g in kept for k in g.copies) for c in group.copies):
            kept.append(group)
    return kept


def _allows(entry: dict[str, Any], group: Group) -> bool:
    if entry.get('name') and entry['name'] not in {c.name for c in group.copies}:
        return False
    return all(matches_any(c.path, entry['files']) for c in group.copies)


@dataclass(frozen=True)
class Options:
    include_tests: bool = False
    min_nodes: int = DEFAULT_MIN_NODES
    window: int = DEFAULT_WINDOW
    similarity: float = DEFAULT_SIMILARITY
    same_file: bool = False
    exclude: tuple[str, ...] = DEFAULT_EXCLUDE


def scan(root: Path, scan_paths: tuple[str, ...], opts: Options) -> tuple[list[Group], int, list[str]]:
    """(clone groups, files parsed, files that failed to parse)."""
    index = _Index()
    parsed, broken = 0, []
    for rel, file in iter_files(root, scan_paths, ('.py',), include_tests=opts.include_tests, exclude=opts.exclude):
        try:
            tree = ast.parse(file.read_text(encoding='utf-8'), filename=rel)
        except (SyntaxError, UnicodeDecodeError):
            broken.append(rel)
            continue
        parsed += 1
        index_module(index, rel, tree, window=opts.window, min_nodes=opts.min_nodes)
    found = _function_groups(index, opts.similarity, opts.same_file) + _WindowGroups(index).groups(opts.same_file)
    groups = _drop_nested(found)
    return groups, parsed, broken


def _report_lines(groups: list[Group]) -> list[str]:
    lines = []
    for number, group in enumerate(groups, 1):
        similar = f', similarity >= {group.similarity}' if group.kind == 'near-function' else ''
        lines.append(f'[{number}] {group.kind}, ~{group.nodes} nodes, {len(group.copies)} copies{similar}')
        lines.extend(f'    {c.path}:{c.start}-{c.end}{"  " + c.name if c.name else ""}' for c in group.copies)
    return lines


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=TOOL, description=SUMMARY)
    parser.add_argument('paths', nargs='*', help=f'repo-relative paths to scan (default: {" ".join(DEFAULT_PATHS)})')
    parser.add_argument('--root', default=str(REPO), help='repository root (fixtures use a temp dir)')
    parser.add_argument('--include-tests', action='store_true', help='also scan test modules and test support')
    parser.add_argument('--min-nodes', type=int, default=DEFAULT_MIN_NODES, help='smallest fragment, in AST nodes')
    parser.add_argument('--window', type=int, default=DEFAULT_WINDOW, help='statements per window')
    parser.add_argument('--similarity', type=float, default=DEFAULT_SIMILARITY,
                        help='near-function threshold, 0-1 (above 1 turns near matches off)')
    parser.add_argument('--same-file', action='store_true', help='also report copies within one file')
    parser.add_argument('--allowlist', default=str(DEFAULT_ALLOWLIST))
    parser.add_argument('--min-files', type=int, default=None, help='vacuity guard (default: on the default scope only)')
    add_json_flag(parser)
    return parser


def _checked_scan(args: argparse.Namespace) -> tuple[list[dict[str, Any]], list[Group], int, list[str]]:
    """Allowlist and scan; AuditError for a bad allowlist or a vacuous scan."""
    min_files = args.min_files if args.min_files is not None else (DEFAULT_MIN_FILES if not args.paths else 1)
    entries = read_allowlist(Path(args.allowlist), ('files',))
    opts = Options(include_tests=args.include_tests, min_nodes=args.min_nodes, window=args.window,
                   similarity=args.similarity, same_file=args.same_file)
    groups, parsed, broken = scan(Path(args.root), tuple(args.paths) or DEFAULT_PATHS, opts)
    if parsed < min_files:
        raise AuditError(f'only {parsed} Python file(s) parsed (expected >= {min_files}); wrong scope?')
    return entries, groups, parsed, broken


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        entries, groups, parsed, broken = _checked_scan(args)
    except AuditError as error:
        say(f'{TOOL}: {error}', err=True)
        return EXIT_ERROR
    reported, allowlisted, stale = split_allowlisted(groups, entries, _allows)
    stale = [] if args.paths else stale  # a partial scan cannot judge the allowlist
    findings = [g.as_json() for g in reported] + [{'kind': 'stale-allowlist', 'entry': e} for e in stale]
    lines = [*_report_lines(reported), *(f'stale-allowlist  {e["reason"][:80]}' for e in stale)]
    if broken:
        lines.append(f'  not parsed (syntax): {", ".join(broken)}')
    summary = (f'clone groups in {parsed} Python files (>= {args.min_nodes} nodes, window {args.window}, '
               f'{len(allowlisted)} allowlisted{", tests included" if args.include_tests else ""})')
    return print_report(TOOL, findings, lines, as_json=args.json, summary=summary,
                        extra={'files': parsed, 'unparsed': broken, 'allowlisted': len(allowlisted)})


if __name__ == '__main__':
    sys.exit(main())
