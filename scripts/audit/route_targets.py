"""What the API actually serves, and what the product requests from it (a library of py_route_callers, no marker).

``py_route_callers`` asks two questions. "Does anything call this route?" reads literals in the callers' source.
"Is there a route for this call?" (kind ``called-no-route``) needs the opposite side, collected here:

- SERVED. Every Powertools route a Lambda resolves: ``@app.<verb>(path)`` in ``lambda/api/*_handler.py``, plus the
  routers a handler mounts with ``app.include_router(<module>.app)`` (the engagement handler's ``shared/*_routes.py``).
  Plus every EXPLICIT API Gateway method in ``lib/stacks/*.ts`` (``<resource>.addMethod('VERB', ...)`` on a resource
  chain built with ``addResource``): those reach a non-Powertools target (the stream Lambda behind ``/chat/stream``,
  the webhooks, ``/mcp/global``), or a Python route the CDK route tests already pin to its handler. A ``{proxy+}``
  is NOT a route: it forwards anything, and the Lambda behind it answers 404 for a path it has no route for.
- REQUESTED. The probes of ``frontend/mock-coverage.json``, one per SPA ``fetchApi`` call site (``check:mock``
  keeps the file complete, with concrete paths), and the stream Lambda's internal-API calls (an object literal
  with ``method: 'VERB'`` and ``path: <literal>``; production files only).
"""
from __future__ import annotations

import ast
import json
import re
from dataclasses import dataclass
from pathlib import Path

from audit_common import AuditError, is_test_path

VERBS = ('get', 'post', 'put', 'delete', 'patch')
_PARAM = re.compile(r'\$\{[^}]*\}|\{[^}]*\}|<[^>]*>|^:\w+$')
_RES_ASSIGN = re.compile(r'\bconst\s+(\w+)\s*=\s*((?:api\.root|apiRoot|\w+)(?:\.addResource\([^)]*\))+)\s*;')
_RES_STEP = re.compile(r"\.addResource\(\s*(?:'([^']*)'|\"([^\"]*)\"|[^)]*)\)")
_METHOD = re.compile(r"\b((?:api\.root|apiRoot|\w+)(?:\.addResource\([^)]*\))*)\.addMethod\(\s*(?:'(\w+)'|\"(\w+)\"|\w+)")
_CALL_LITERAL = re.compile(r"""^\s*(?:'(/[^']*)'|"(/[^"]*)"|`(/[^`]*)`)\s*$""")
_STREAM_CALL = re.compile(r"""method:\s*'(GET|POST|PUT|DELETE|PATCH)'\s*,\s*path:\s*(?:'(/[^'\n]*)'|`(/[^`\n]*)`)""")


@dataclass(frozen=True)
class Served:
    verb: str | None     # None: any method (a gateway method whose verb is a loop variable)
    segments: tuple[str, ...]
    where: str


@dataclass(frozen=True)
class Request:
    verb: str
    path: str
    segments: tuple[str, ...]
    where: str
    template: str = ''   # the call site's own path literal, when it has one (`/integrations/${source}/test`)

    @property
    def key(self) -> str:
        shape = segments(self.template) if self.template else self.segments
        return f'{self.verb} /{"/".join("{}" if s == "*" else s for s in shape)}'


def segments(path: str) -> tuple[str, ...]:
    """A path as a segment template: any parameter (``<id>``, ``{id}``, ``${id}``, ``:id``) is ``*``."""
    parts = path.split('?')[0].split('#')[0].strip('/').split('/')
    return tuple('*' if _PARAM.search(p) or p == '*' else p for p in parts if p)


def route_decorator(deco: ast.expr) -> tuple[str, str] | None:
    """``@app.<verb>('<literal path>')`` -> (VERB, path)."""
    if not (isinstance(deco, ast.Call) and isinstance(deco.func, ast.Attribute) and deco.args):
        return None
    func, first = deco.func, deco.args[0]
    if func.attr in VERBS and isinstance(func.value, ast.Name) and func.value.id == 'app' \
            and isinstance(first, ast.Constant) and isinstance(first.value, str):
        return func.attr.upper(), first.value
    return None


def _decorated_routes(file: Path, rel: str) -> list[Served]:
    tree = ast.parse(file.read_text(encoding='utf-8'))
    return [Served(verb, segments(path), f'{rel}:{deco.lineno}')
            for node in ast.walk(tree) if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
            for deco in node.decorator_list if (route := route_decorator(deco)) for verb, path in [route]]


def _mounted_routers(handler: Path, lambda_dir: Path) -> list[Path]:
    """Modules a handler mounts with ``app.include_router(<module>.app)``, resolved by its ``from X import`` lines."""
    tree = ast.parse(handler.read_text(encoding='utf-8'))
    packages = {alias.asname or alias.name: node.module for node in ast.walk(tree)
                if isinstance(node, ast.ImportFrom) and node.module for alias in node.names}
    found: list[Path] = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'include_router'
                and node.args and isinstance(arg := node.args[0], ast.Attribute)
                and isinstance(arg.value, ast.Name) and arg.value.id in packages):
            module = lambda_dir.joinpath(*packages[arg.value.id].split('.'), f'{arg.value.id}.py')
            if not module.is_file():
                raise AuditError(f'{handler}: mounted router {arg.value.id} not found at {module}')
            found.append(module)
    return found


def python_routes(cdk_dir: Path) -> list[Served]:
    """Every Powertools route: the handlers' own decorators and those of the routers they mount."""
    lambda_dir = cdk_dir / 'lambda'
    out: list[Served] = []
    for handler in sorted((lambda_dir / 'api').glob('*_handler.py')):
        for file in [handler, *_mounted_routers(handler, lambda_dir)]:
            out.extend(_decorated_routes(file, file.relative_to(cdk_dir).as_posix()))
    return out


def _chain_segments(chain: str, resources: dict[str, tuple[str, ...]]) -> tuple[str, ...] | None:
    base = chain.split('.addResource(')[0]
    if base in ('api.root', 'apiRoot'):
        prefix: tuple[str, ...] = ()
    elif base in resources:
        prefix = resources[base]
    else:
        return None
    words = (single or double for single, double in _RES_STEP.findall(chain))
    return prefix + tuple(word if word and not _PARAM.search(word) else '*' for word in words)


def _assigned_resources(text: str, known: dict[str, tuple[str, ...]]) -> dict[str, tuple[str, ...]]:
    """``const <name> = <base>.addResource(...)...;`` in one file, resolved in order (``known`` = other files' names)."""
    resources: dict[str, tuple[str, ...]] = {}
    for match in _RES_ASSIGN.finditer(text):
        segs = _chain_segments(match.group(2), {**known, **resources})
        if segs is not None:
            resources[match.group(1)] = segs
    return resources


def gateway_methods(cdk_dir: Path) -> list[Served]:
    """Explicit ``addMethod`` calls on resource chains the stack files build (a ``{proxy+}`` is not one)."""
    out: list[Served] = []
    files = [f for f in sorted((cdk_dir / 'lib' / 'stacks').glob('*.ts')) if not is_test_path(f.relative_to(cdk_dir).as_posix())]
    texts = {f: f.read_text(encoding='utf-8') for f in files}
    # A resource built in one file and handed to a builder in another (`mcpResource` -> global-mcp.ts) keeps its
    # name across the call: names assigned once in the whole stack directory are shared by every file.
    shared: dict[str, tuple[str, ...] | None] = {}
    for text in texts.values():
        for name, segs in _assigned_resources(text, {}).items():
            shared[name] = segs if name not in shared else None
    known = {name: segs for name, segs in shared.items() if segs is not None}
    for file, text in texts.items():
        rel = file.relative_to(cdk_dir).as_posix()
        resources = {**known, **_assigned_resources(text, known)}
        for match in _METHOD.finditer(text):
            segs = _chain_segments(match.group(1), resources)
            # A first segment that is not a literal (`api.root.addResource(pathPart)` in a helper) is no
            # path parameter: the path is unknown, and `*` would serve every one-segment request.
            if segs is not None and segs[:1] != ('*',):
                verb = match.group(2) or match.group(3)
                out.append(Served(verb.upper() if verb else None, segs, f'{rel}:{text.count(chr(10), 0, match.start()) + 1}'))
    return out


def spa_requests(cdk_dir: Path) -> list[Request]:
    """One request per probe of ``frontend/mock-coverage.json`` (the SPA's every ``fetchApi`` call site)."""
    file = cdk_dir / 'frontend' / 'mock-coverage.json'
    try:
        entries = json.loads(file.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise AuditError(f'{file}: unreadable ({error})') from error
    if not isinstance(entries, list):
        raise AuditError(f'{file}: expected a list of call sites')
    out: list[Request] = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get('method'), str):
            raise AuditError(f'{file}: a call site without a method')
        for probe in entry.get('probes') or []:
            if isinstance(probe, dict) and isinstance(probe.get('path'), str):
                call = str(entry.get('call', ''))
                literal = _CALL_LITERAL.match(call)
                template = next((g for g in literal.groups() if g), '') if literal else ''
                where = f'frontend/src/{entry.get("file", "?")} ({call})'
                out.append(Request(entry['method'].upper(), probe['path'], segments(probe['path']), where, template))
    return out


def stream_requests(cdk_dir: Path) -> list[Request]:
    """The stream Lambda's internal-API calls whose method and path are literals in one object."""
    src = cdk_dir / 'lambda' / 'stream' / 'src'
    out: list[Request] = []
    for file in sorted(src.rglob('*.ts')):
        rel = file.relative_to(cdk_dir).as_posix()
        if is_test_path(rel) or 'node_modules' in file.parts:
            continue
        text = file.read_text(encoding='utf-8')
        for match in _STREAM_CALL.finditer(text):
            literal = match.group(2) or match.group(3)
            segs = segments(literal)
            if any(s != '*' for s in segs):
                line = text.count('\n', 0, match.start()) + 1
                out.append(Request(match.group(1), literal, segs, f'{rel}:{line}', literal))
    return out


def serves(target: Served, request: Request) -> bool:
    """A served route answers a request: same verb (or any), each segment equal or a parameter on either side.

    A request's LAST segment, when it is a parameter (`/settings/${route}`), may stand for several segments.
    """
    if target.verb is not None and target.verb != request.verb:
        return False
    route, asked = target.segments, request.segments
    if len(asked) > len(route) or (len(asked) < len(route) and not (asked and asked[-1] == '*')):
        return False
    return all(r == a or '*' in (r, a) for r, a in zip(route, asked, strict=False))
