#!/usr/bin/env python3
# audit-detector: run by scripts/audit/run-all.sh
"""py_route_callers: API routes the Python handlers register that no product code calls.

PATTERN (the 5.28 clean-up removed 8 such routes): ``@app.<verb>(path)`` in
``lambda/api/*_handler.py`` is registered and wired in API Gateway (both CDK route tests pass), but
nothing in the product calls it: not the SPA (``fetchApi`` and its path builders), not the assistant
stream (server tools, plan writes, ``READ_POSTS``), not the global MCP tools, the agent runtime, the
plan-step delegates, the static feedback widget or any other Python delegate.

KINDS. ``no-caller``: no product string names the path at all (high confidence). ``weak-caller-only``:
only a caller with a wildcard where the route has a fixed word could produce it (``/memory/${id}`` for
``/memory/stats``; medium, read the caller). ``method-uncalled``: the path is named, but every caller
whose method could be read uses another verb (medium: the method is inferred from the text near it).
``called-no-route`` (the inverse question, high confidence): a request the product makes that no route serves.
The requests are the probes of ``frontend/mock-coverage.json`` (one per SPA ``fetchApi`` call site) and the stream
Lambda's internal-API calls; a route is a Powertools decorator (handlers and the routers they mount) or an explicit
API Gateway method in ``lib/stacks`` (``route_targets.py``). A ``{proxy+}`` passes any path to its Lambda, which
answers 404, so the call always fails (the Settings -> Sources "Test" button did, from #115 until 5.34).

HOW. Route paths are normalised to segment templates (``<id>``, ``{id}``, ``${id}``, ``:id`` -> ``*``).
Every string / template literal starting with ``/`` in the caller sources is a candidate (route
decorators themselves excluded). A literal that starts with an interpolated base (``${BASE}/runs``) or
that is a bare fragment (``'/members'`` appended to a path builder) matches a route by suffix, provided it
has a literal segment. The method is read near the literal: ``method: 'PUT'`` or a ``post(...)`` helper
after it, or a verb string just before it (``RouteRequest(DOMAIN, 'GET', '/feedback')``); a literal that is
``fetchApi``'s first argument with no options is a GET; anything else = any method.

WHY THE REFERENCE TOOLS MISS IT: knip / vulture see the handler function as used (the decorator
registers it); ``api-route-liveness.test.ts`` and the "wires every route" test check gateway <-> handler,
never handler <-> caller.

FALSE POSITIVES: routes for operators (curl, runbooks), webhooks called by third parties, routes kept for
an announced client. Silence with ``{"key": "<VERB> <path>", "reason": ...}`` in
``scripts/audit/allowlists/py_route_callers.json``.

Run: ``voc-datalake/.venv/bin/python scripts/audit/py_route_callers.py [--json]`` (no synth needed).
"""
from __future__ import annotations

import argparse
import ast
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

from audit_common import Finding, detector_main, guard, run_main
from route_targets import (
    Request,
    Served,
    gateway_methods,
    python_routes,
    route_decorator,
    segments,
    serves,
    spa_requests,
    stream_requests,
)

TOOL = 'py_route_callers'
CALLER_GLOBS = (
    'frontend/src/**/*.ts', 'frontend/src/**/*.tsx', 'frontend/public/**/*.js', 'frontend/public/**/*.html',
    'lambda/stream/src/**/*.ts', 'lambda/api/static/**/*', 'lambda/**/*.py', 'plugins/**/*.py',
    'lambda/**/*.json',
)
NON_PRODUCT = re.compile(r'(\.test\.|\.spec\.|/test/|/tests/|/__tests__/|/test_|conftest|/e2e/|/mocks?/|mock-|'
                         r'\.stories\.|/layers/|node_modules|__pycache__|\.d\.ts$|/locales/)')
_LITERAL = re.compile(r"""(?<![A-Za-z0-9_])(?:f?'(/[^'\n]*)'|f?"(/[^"\n]*)"|`(/[^`]*)`|`(\$\{[^}]*\}/[^`]*)`"""
                      r"""|f'(\{[^}']*\}/[^'\n]*)'|f"(\{[^}"]*\}/[^"\n]*)")""")
_METHOD_AFTER = re.compile(r"""method:\s*['"](GET|POST|PUT|DELETE|PATCH)['"]|\b(post|put|patch|del|remove)\(""", re.IGNORECASE)
_FETCH_DIRECT = re.compile(r'\bfetchApi(?:<[^()]*>)?\(\s*$')
_METHOD_BEFORE = re.compile(r"""['"](GET|POST|PUT|DELETE|PATCH)['"]\s*,\s*f?$""")


@dataclass(frozen=True)
class Route:
    verb: str
    path: str
    file: str
    line: int
    function: str

    @property
    def key(self) -> str:
        return f'{self.verb} {self.path}'


@dataclass(frozen=True)
class Caller:
    file: str
    line: int
    segments: tuple[str, ...]
    method: str | None      # None: could not be read, matches any verb
    anchored: bool          # starts at the API root (not an interpolated base or a fragment)


def routes_in(cdk_dir: Path) -> list[Route]:
    found: list[Route] = []
    for path in sorted((cdk_dir / 'lambda' / 'api').glob('*_handler.py')):
        tree = ast.parse(path.read_text(encoding='utf-8'))
        rel = path.relative_to(cdk_dir).as_posix()
        found.extend(Route(*route, rel, deco.lineno, node.name)
                     for node in ast.walk(tree) if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
                     for deco in node.decorator_list if (route := route_decorator(deco)))
    return found


def _rest_of_call(text: str, end: int, limit: int = 400) -> str:
    """The text after a literal up to the end of its call / statement (the call's options live there)."""
    depth = 0
    for i, char in enumerate(text[end:end + limit]):
        if char in '([{':
            depth += 1
        elif char in ')]}':
            depth -= 1
            if depth < 0:
                return text[end:end + i]
        elif depth == 0 and (char == ';' or (char == '\n' and not text[end:end + i].rstrip().endswith(','))):
            return text[end:end + i]   # the statement ended (a trailing comma means the call goes on)
    return text[end:end + limit]


def _method_near(text: str, start: int, end: int) -> str | None:
    before = text[max(0, start - 40):start]
    match = _METHOD_BEFORE.search(before)
    if match:
        return match.group(1).upper()
    match = _METHOD_AFTER.search(_rest_of_call(text, end))
    if not match:
        # `fetchApi(path)` / `fetchApi<T>(path)` with no options is a GET; anything else is unknown
        return 'GET' if _FETCH_DIRECT.search(text[max(0, start - 60):start]) else None
    verb = (match.group(1) or match.group(2)).upper()
    return {'DEL': 'DELETE', 'REMOVE': 'DELETE'}.get(verb, verb)


def callers_in(cdk_dir: Path) -> tuple[list[Caller], int]:
    files = sorted({p for pattern in CALLER_GLOBS for p in cdk_dir.glob(pattern) if p.is_file()})
    out: list[Caller] = []
    scanned = 0
    for path in files:
        rel = path.relative_to(cdk_dir).as_posix()
        if NON_PRODUCT.search('/' + rel):
            continue
        scanned += 1
        text = path.read_text(encoding='utf-8', errors='ignore')
        if rel.endswith('_handler.py'):
            text = re.sub(r'@app\.\w+\([^)]*\)', lambda m: ' ' * len(m.group(0)), text)
        for match in _LITERAL.finditer(text):
            literal = next(g for g in match.groups() if g is not None)
            segs = segments(literal)
            if not segs:
                continue
            out.append(Caller(rel, text.count('\n', 0, match.start()) + 1, segs,
                              _method_near(text, match.start(), match.end()), not literal.startswith(('$', '{'))))
    return out, scanned


def _align(route: tuple[str, ...], caller: tuple[str, ...], *, literal_on_param: bool) -> str | None:
    """'strong' / 'weak' / None for two equal-length templates.

    A caller wildcard on a route LITERAL (``/memory/${id}`` vs ``/memory/stats``) is only 'weak': the
    caller may never produce that word. ``literal_on_param``: may a caller literal fill a route
    parameter (a fixed id in a full path)? Not for a suffix fragment, whose words must be the route's.
    """
    strength = 'strong'
    for r, c in zip(route, caller, strict=True):
        if r == c:
            continue
        if c == '*':
            strength = 'weak'
        elif r != '*' or not literal_on_param:
            return None
    return strength


def match(route: tuple[str, ...], caller: Caller) -> str | None:
    segs = caller.segments
    if caller.anchored and len(segs) == len(route):
        return _align(route, segs, literal_on_param=True)
    tail = segs[1:] if segs[0] == '*' else segs
    if not tail or all(s == '*' for s in tail) or len(tail) >= len(route) + (0 if caller.anchored else 1):
        return None
    return _align(route[len(route) - len(tail):], tail, literal_on_param=False)


def findings(routes: list[Route], callers: list[Caller]) -> Iterator[Finding]:
    for route in routes:
        segs = segments(route.path)
        hits = [(c, m) for c in callers if (m := match(segs, c))]
        strong = [c for c, m in hits if m == 'strong']
        where = f'{route.file}:{route.line} {route.function}'
        if not hits:
            yield Finding('no-caller', route.key, f'{where}: no product code names this path')
        elif not strong:
            first = hits[0][0]
            yield Finding('weak-caller-only', route.key, f'{where}: only a wildcard caller could produce it '
                          f'(e.g. {first.file}:{first.line} /{"/".join(first.segments)})')
        elif all(c.method is not None and c.method != route.verb for c in strong):
            methods = sorted({c.method or '?' for c in strong})
            yield Finding('method-uncalled', route.key,
                          f'{where}: path named only with {"/".join(methods)} (e.g. {strong[0].file}:{strong[0].line})')


def unrouted(requests: list[Request], served: list[Served]) -> Iterator[Finding]:
    """``called-no-route``: a request no Powertools route and no explicit gateway method answers (one per key)."""
    seen: set[str] = set()
    for request in requests:
        if request.key in seen or any(serves(target, request) for target in served):
            continue
        seen.add(request.key)
        yield Finding('called-no-route', request.key,
                      f'{request.where}: requests {request.path}, which no route serves (a {{proxy+}} answers 404)')


def scan(args: argparse.Namespace) -> tuple[Iterable[Finding], str]:
    routes = routes_in(args.cdk_dir)
    callers, scanned = callers_in(args.cdk_dir)
    guard(len(routes) >= 150, f'only {len(routes)} routes found')
    guard(scanned >= 500 and len(callers) >= 500, f'only {scanned} caller files / {len(callers)} path literals')
    served = python_routes(args.cdk_dir) + gateway_methods(args.cdk_dir)
    requests = spa_requests(args.cdk_dir) + stream_requests(args.cdk_dir)
    guard(len(served) >= 200 and len(requests) >= 200, f'only {len(served)} served routes / {len(requests)} requests')
    found = [*findings(routes, callers), *unrouted(requests, served)]
    return found, (f'{len(routes)} routes, {len(callers)} path literals in {scanned} files; '
                   f'{len(requests)} requests against {len(served)} served routes')


main = detector_main(TOOL, __doc__, scan)


if __name__ == '__main__':
    run_main(main)
