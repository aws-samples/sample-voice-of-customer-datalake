# audit-detector: run by scripts/audit/run-all.sh
"""Known anti-patterns that already have a shared helper: a small rule engine over the source tree.

PATTERN. Code that re-implements something the platform already has ONE home for: a hand-written
``LastEvaluatedKey`` loop instead of ``shared/dynamo_paging.py``, a local Decimal converter instead of
``shared/dynamo_values.py``, a client built per request instead of at init, ``toFixed`` instead of the
locale-aware number helpers, a local date formatter instead of ``utils/dateUtils.ts``, and so on. Each one was
found and consolidated by hand in the 5.26-5.28 audits; a rule here keeps the next copy from landing unnoticed.

HOW. ``scripts/audit/pattern-rules.json`` lists the rules. A rule has an ``id``, a ``language`` (``python``,
``ts`` or ``json``), ``include`` globs, ``exclude`` globs that each carry a ``reason`` (normally the helper's own
home), a ``message``, the helper to ``use`` instead, and EITHER a ``regex`` matched per line (comment lines and,
in Python, docstrings are skipped; ``"code_only": true`` also blanks Python string literals, so a call named in a
label is not a call) OR a ``predicate``: the name of an AST check in ``PREDICATES`` below (for what a
regex cannot say, such as "inside a function body but not a cached getter").

WHY THE REFERENCE TOOLS MISS IT. These are legal, typed, tested code. ruff/eslint have no notion of "this repo
already has a helper for that"; jscpd needs 40 identical tokens; a five-line local ``plain()`` is none of those.

KNOWN FALSE POSITIVES. A regex sees text, not meaning: a variable named like the API, a test double, a string
that mentions the call. The predicates are narrower but still heuristic (a getter cached in a non-standard way).
Some copies are deliberate (a package that cannot import ``shared``, a fixed-locale PDF).

SILENCING. A whole path that legitimately does the thing: a rule ``exclude`` entry with a reason. One finding:
``scripts/audit/allowlists/patterns.json`` ``{"entries": [{"rule", "path", "scope"?, "contains"?, "reason"}]}``:
``path`` is a glob, ``scope`` (Python) the enclosing function as reported (``Class.method``), ``contains`` a
substring of the reported line. Python findings are reported once per rule and function, so an entry survives
line shifts. Stale entries are listed after the report.

Exit 0 = clean, 1 = findings (stale allowlist entries included), 2 = error (bad rules file, a rule whose include
matches no file, or a vacuous scan: fewer than ``--min-files`` files). ``--json`` prints the JSON report instead of
the text one, ``--json PATH`` also writes it there; ``--rule ID`` runs one rule.
"""
from __future__ import annotations

import argparse
import ast
import io
import json
import re
import sys
import tokenize
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from functools import cached_property
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

TOOL = 'patterns.py'
SUMMARY = 'Known anti-patterns that already have a shared helper: a small rule engine over the source tree.'
HERE = Path(__file__).resolve().parent
DEFAULT_RULES = HERE / 'pattern-rules.json'
DEFAULT_ALLOWLIST = HERE / 'allowlists' / 'patterns.json'
SCAN_ROOTS = ('voc-datalake', 'scripts', 'eslint-rules')
SUFFIXES = {'python': ('.py',), 'ts': ('.ts', '.tsx', '.mts', '.mjs', '.js'), 'json': ('.json',)}
DEFAULT_MIN_FILES = 1000
_COMMENT = {'python': re.compile(r'\s*#'), 'ts': re.compile(r'\s*(//|/\*|\*)'), 'json': re.compile(r'(?!)')}


@dataclass(frozen=True)
class Finding:
    rule: str
    path: str
    line: int
    text: str
    scope: str = ''  # Python: the enclosing function (``Class.method``), '' at module level / in TS and JSON

    def as_json(self) -> dict[str, Any]:
        return {'rule': self.rule, 'path': self.path, 'line': self.line, 'text': self.text, 'scope': self.scope}


@dataclass
class Rule:
    id: str
    language: str
    include: list[str]
    message: str
    use: str
    exclude: list[dict[str, str]] = field(default_factory=list)
    regex: re.Pattern[str] | None = None
    predicate: str | None = None
    code_only: bool = False  # Python regex rules: match code with string literals blanked (a call, not a label)

    def in_scope(self, rel: str) -> bool:
        return (rel.endswith(SUFFIXES[self.language]) and matches_any(rel, self.include)
                and not matches_any(rel, [e['glob'] for e in self.exclude]))


# ---- AST predicates (Python) -------------------------------------------------------------------------------

def _is_boto3_factory(node: ast.AST) -> bool:
    """``boto3.client(...)`` / ``boto3.resource(...)``."""
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr in {'client', 'resource'}
            and isinstance(node.func.value, ast.Name) and node.func.value.id == 'boto3')


def _decorator_names(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    names = set()
    for dec in fn.decorator_list:
        target = dec.func if isinstance(dec, ast.Call) else dec
        names.add(target.attr if isinstance(target, ast.Attribute) else getattr(target, 'id', ''))
    return names


_CACHE_METHODS = frozenset({'append', 'setdefault', 'update', 'add'})


def _boto3_calls_in(node: ast.AST) -> set[int]:
    return {id(n) for n in ast.walk(node) if _is_boto3_factory(n)}


def _names_in(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def _cache_targets(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> set[int]:
    """ids of boto3 calls whose client is kept for reuse.

    Kept = (part of) a value stored in a ``global`` name, an attribute or a subscript, or passed to a container's
    ``append`` / ``setdefault`` / ``update`` / ``add``; directly, or through a local that is then stored so.
    """
    globals_ = {name for n in ast.walk(fn) if isinstance(n, ast.Global) for name in n.names}
    kept_values: list[ast.AST] = []
    locals_from_boto3: dict[str, set[int]] = {}
    for node in ast.walk(fn):
        if isinstance(node, ast.Assign | ast.AnnAssign) and node.value is not None:
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(isinstance(t, ast.Attribute | ast.Subscript) or (isinstance(t, ast.Name) and t.id in globals_)
                   for t in targets):
                kept_values.append(node.value)
            for target in targets:
                if isinstance(target, ast.Name) and (calls := _boto3_calls_in(node.value)):
                    locals_from_boto3.setdefault(target.id, set()).update(calls)
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
              and node.func.attr in _CACHE_METHODS):
            kept_values.extend([*node.args, *(k.value for k in node.keywords)])
    cached: set[int] = set()
    for value in kept_values:
        cached |= _boto3_calls_in(value)
        for name in _names_in(value) & set(locals_from_boto3):
            cached |= locals_from_boto3[name]
    return cached


def _functions(tree: ast.Module) -> Iterator[ast.FunctionDef | ast.AsyncFunctionDef]:
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            yield node


def boto3_in_function(tree: ast.Module) -> Iterator[int]:
    """A boto3 client/resource built inside a function on every call (not module level, not a cached getter)."""
    for fn in _functions(tree):
        if _decorator_names(fn) & {'cache', 'lru_cache', 'cached_property'}:
            continue
        cached = _cache_targets(fn)
        nested = {id(n) for inner in ast.walk(fn) if inner is not fn and isinstance(inner, ast.FunctionDef | ast.AsyncFunctionDef)
                  for n in ast.walk(inner)}
        for node in ast.walk(fn):
            if isinstance(node, ast.Call) and _is_boto3_factory(node) and id(node) not in cached | nested:
                yield node.lineno


def _is_lazy_getter(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    """A ``global``-cached factory: ``global _x; if _x is None: _x = boto3.…(…) / ….Table(…) / get_…(…)``."""
    if not any(isinstance(n, ast.Global) for n in fn.body):
        return False
    for node in ast.walk(fn):
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
            func = node.value.func
            name = func.attr if isinstance(func, ast.Attribute) else getattr(func, 'id', '')
            if _is_boto3_factory(node.value) or name == 'Table' or name.startswith('get_'):
                return True
    return False


def lazy_getter_without_warm(tree: ast.Module) -> Iterator[int]:
    """A handler module with a lazy client getter that never runs it at init (``shared.warm_init.warm_at_init``)."""
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} | {
        n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)} | {
        a.name for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) for a in n.names}
    if names & {'warm_at_init', 'register_snapshot_hooks'}:
        return
    for node in tree.body:
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and _is_lazy_getter(node):
            yield node.lineno


_SILENT_BODY = (ast.Pass, ast.Continue)


def _is_silent(stmt: ast.stmt) -> bool:
    if isinstance(stmt, _SILENT_BODY):
        return True
    if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant):
        return True  # `...`
    return isinstance(stmt, ast.Return) and (stmt.value is None or isinstance(stmt.value, ast.Constant))


def swallowed_exception(tree: ast.Module) -> Iterator[int]:
    """``except:`` / ``except Exception:`` / ``except BaseException:`` whose whole body discards the error."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.ExceptHandler):
            continue
        broad = node.type is None or (isinstance(node.type, ast.Name) and node.type.id in {'Exception', 'BaseException'})
        if broad and all(_is_silent(s) for s in node.body):
            yield node.lineno


PREDICATES: dict[str, Callable[[ast.Module], Iterator[int]]] = {
    'boto3_in_function': boto3_in_function,
    'lazy_getter_without_warm': lazy_getter_without_warm,
    'swallowed_exception': swallowed_exception,
}


# ---- Engine -------------------------------------------------------------------------------------------------

def load_rules(file: Path) -> list[Rule]:
    try:
        data = json.loads(file.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise AuditError(f'{file}: unreadable rules ({error})') from error
    rules, seen = [], set()
    for raw in data.get('rules', []) if isinstance(data, dict) else []:
        rid = raw.get('id', '?')
        missing = [k for k in ('id', 'language', 'include', 'message', 'use') if not raw.get(k)]
        if missing or rid in seen:
            raise AuditError(f'{file}: rule {rid}: {"duplicate id" if rid in seen else "lacks " + ", ".join(missing)}')
        if raw['language'] not in SUFFIXES or bool(raw.get('regex')) == bool(raw.get('predicate')):
            raise AuditError(f'{file}: rule {rid}: needs a known language and exactly one of regex / predicate')
        if raw.get('predicate') and (raw['predicate'] not in PREDICATES or raw['language'] != 'python'):
            raise AuditError(f'{file}: rule {rid}: unknown predicate {raw["predicate"]} (Python only)')
        if any(not str(e.get('reason', '')).strip() or not e.get('glob') for e in raw.get('exclude', [])):
            raise AuditError(f'{file}: rule {rid}: every exclude needs a glob and a reason')
        seen.add(rid)
        rules.append(Rule(id=rid, language=raw['language'], include=raw['include'], message=raw['message'],
                          use=raw['use'], exclude=raw.get('exclude', []),
                          regex=re.compile(raw['regex']) if raw.get('regex') else None,
                          predicate=raw.get('predicate'), code_only=bool(raw.get('code_only'))))
    if not rules:
        raise AuditError(f'{file}: no rules')
    return rules


def _docstring_lines(tree: ast.Module) -> set[int]:
    lines: set[int] = set()
    for node in ast.walk(tree):
        body = getattr(node, 'body', None)
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef) and body:
            first = body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                lines.update(range(first.lineno, (first.end_lineno or first.lineno) + 1))
    return lines


@dataclass
class _Source:
    rel: str
    text: str
    _tree: ast.Module | None = None
    _parsed: bool = False

    @cached_property
    def lines(self) -> list[str]:
        return self.text.splitlines()

    @cached_property
    def code_lines(self) -> list[str]:
        """Python source lines with every string literal's text blanked (same line numbers)."""
        out = self.lines.copy()
        try:
            tokens = list(tokenize.generate_tokens(io.StringIO(self.text).readline))
        except (tokenize.TokenError, SyntaxError):
            return out
        for tok in reversed(tokens):
            if tok.type != tokenize.STRING or tok.start[0] != tok.end[0]:
                continue  # a multi-line string spans lines; its text never holds a call we look for
            row, (start, end) = tok.start[0] - 1, (tok.start[1], tok.end[1])
            out[row] = out[row][:start] + "''" + out[row][end:]
        return out

    def tree(self) -> ast.Module | None:
        if not self._parsed:
            self._parsed = True
            try:
                self._tree = ast.parse(self.text, filename=self.rel)
            except (SyntaxError, ValueError):
                self._tree = None
        return self._tree


def _scopes(tree: ast.Module) -> list[tuple[int, int, str]]:
    """(first line, last line, qualified name) of every function, outermost first."""
    out: list[tuple[int, int, str]] = []

    def walk(node: ast.AST, prefix: str) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
                name = f'{prefix}{child.name}'
                if not isinstance(child, ast.ClassDef):
                    out.append((child.lineno, child.end_lineno or child.lineno, name))
                walk(child, f'{name}.')
            else:
                walk(child, prefix)

    walk(tree, '')
    return out


def _scope_of(scopes: list[tuple[int, int, str]], line: int) -> str:
    inner = ''
    for first, last, name in scopes:
        if first <= line <= last:
            inner = name  # later = nested deeper
    return inner


def _check(rule: Rule, src: _Source) -> Iterator[Finding]:
    """Findings of one rule in one file; Python findings are reported once per (rule, function)."""
    lines, tree = src.lines, src.tree() if rule.language == 'python' else None
    scopes = _scopes(tree) if tree else []
    if rule.predicate:
        numbers = list(PREDICATES[rule.predicate](tree)) if tree else []
    else:
        regex, comment = rule.regex, _COMMENT[rule.language]
        skip = _docstring_lines(tree) if tree else set()
        if rule.code_only and tree:
            lines = src.code_lines
        numbers = [n for n, line in enumerate(lines, 1)
                   if regex is not None and n not in skip and not comment.match(line) and regex.search(line)]
    seen: set[str] = set()
    for number in sorted(numbers):
        scope = _scope_of(scopes, number)
        if tree and scope:
            if scope in seen:
                continue
            seen.add(scope)
        yield Finding(rule.id, src.rel, number, src.lines[number - 1].strip(), scope)


def _iter_sources(root: Path, scan_roots: tuple[str, ...], include_tests: bool) -> Iterator[_Source]:
    suffixes = tuple(s for group in SUFFIXES.values() for s in group)
    for rel, file in iter_files(root, scan_roots, suffixes, include_tests=include_tests):
        yield _Source(rel, file.read_text(encoding='utf-8', errors='replace'))


def _allows(entry: dict[str, Any], finding: Finding) -> bool:
    return (entry['rule'] == finding.rule and matches_any(finding.path, [entry['path']])
            and str(entry.get('contains', '')) in finding.text
            and entry.get('scope', finding.scope) == finding.scope)


@dataclass
class Report:
    findings: list[Finding]
    allowlisted: list[Finding]
    files: int
    empty_rules: list[str]
    stale: list[dict[str, Any]]


def run(root: Path, rules: list[Rule], entries: list[dict[str, Any]], *, include_tests: bool = False,
        scan_roots: tuple[str, ...] = SCAN_ROOTS) -> Report:
    found: list[Finding] = []
    scoped = dict.fromkeys((r.id for r in rules), 0)
    files = 0
    for src in _iter_sources(root, scan_roots, include_tests):
        files += 1
        for rule in rules:
            if rule.in_scope(src.rel):
                scoped[rule.id] += 1
                found.extend(_check(rule, src))
    reported, allowlisted, stale = split_allowlisted(found, entries, _allows)
    return Report(reported, allowlisted, files, [rid for rid, n in scoped.items() if n == 0], stale)


def _report_lines(findings: list[Finding], rules: dict[str, Rule], stale: list[dict[str, Any]]) -> list[str]:
    lines = []
    for rule_id in sorted({f.rule for f in findings}):
        rule = rules[rule_id]
        hits = [f for f in findings if f.rule == rule_id]
        lines.append(f'[{rule_id}] {len(hits)}: {rule.message} -> use {rule.use}')
        lines.extend(f'    {f.path}:{f.line}{"  [" + f.scope + "]" if f.scope else ""}  {f.text[:120]}' for f in hits)
    lines.extend(f'stale-allowlist  {e["rule"]} {e["path"]} ({e["reason"][:60]})' for e in stale)
    return lines


def _selected(rules: list[Rule], wanted: list[str] | None) -> list[Rule]:
    """The rules named by ``--rule`` (all when none is named); AuditError for an unknown id."""
    if not wanted:
        return rules
    unknown = set(wanted) - {r.id for r in rules}
    if unknown:
        raise AuditError(f'unknown rule {", ".join(sorted(unknown))}')
    return [r for r in rules if r.id in wanted]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='patterns.py', description=SUMMARY)
    parser.add_argument('--root', default=str(REPO), help='repository root (fixtures use a temp dir)')
    parser.add_argument('--rules', default=str(DEFAULT_RULES))
    parser.add_argument('--allowlist', default=str(DEFAULT_ALLOWLIST))
    parser.add_argument('--rule', action='append', help='only this rule id (repeatable; stale entries not judged)')
    parser.add_argument('--include-tests', action='store_true', help='also scan tests and test support')
    parser.add_argument('--min-files', type=int, default=DEFAULT_MIN_FILES, help='vacuity guard')
    add_json_flag(parser)
    return parser


def _checked_run(args: argparse.Namespace) -> tuple[list[Rule], Report]:
    """Rules, allowlist and scan; AuditError for a bad file or a vacuous scan."""
    rules = _selected(load_rules(Path(args.rules)), args.rule)
    entries = read_allowlist(Path(args.allowlist), ('rule', 'path'))
    report = run(Path(args.root), rules, entries, include_tests=args.include_tests)
    if report.files < args.min_files or report.empty_rules:
        raise AuditError(f'vacuous scan: {report.files} file(s) (expected >= {args.min_files}); '
                         f'rules matching no file: {", ".join(report.empty_rules) or "none"}')
    return rules, report


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        rules, report = _checked_run(args)
    except AuditError as error:
        say(f'{TOOL}: {error}', err=True)
        return EXIT_ERROR
    stale = [] if args.rule else report.stale
    findings = [f.as_json() for f in report.findings] + [{'kind': 'stale-allowlist', 'entry': e} for e in stale]
    summary = (f'{len(rules)} rule(s), {report.files} files, {len(report.allowlisted)} allowlisted'
               f'{", tests included" if args.include_tests else ""}')
    return print_report(TOOL, findings, _report_lines(report.findings, {r.id: r for r in rules}, stale),
                        as_json=args.json, summary=summary, extra={'files': report.files, 'rules': [r.id for r in rules],
                                                                   'allowlisted': len(report.allowlisted)})


if __name__ == '__main__':
    sys.exit(main())
