"""Which `metrics_handler` routes publish `is_partial`, derived from its source.

Two suites need this set and they need the SAME set:
`test_metrics_partial_window` parametrizes its cases over it, and
`test_mcp_delegation` asks which of those routes MCP can reach. A list in either
file would be a copy, and the failure a stale copy produces is silence — a new
endpoint publishing the flag simply never gets tested, which is how the flag came
to be a hardcoded `False` on six of them.

A plain helper module rather than an import between test modules: it is importable
because `conftest.py` puts this directory on `sys.path` (the same reason
`plugin_manifests.py` works), which does not depend on pytest's import mode or on
which module pytest happened to load first.

Nothing here asserts. `test_metrics_partial_window` owns the positive control that
the derivation is not empty, because a derivation that silently returns nothing
makes every suite standing on it vacuous.
"""
import ast
from pathlib import Path

HANDLER_SOURCE = Path(__file__).resolve().parents[1] / 'metrics_handler.py'

# `@app.route(...)` included: it takes the path first as well, so a route
# declared that way is still a route this derivation must see.
_ROUTE_VERBS = frozenset({'get', 'post', 'put', 'patch', 'delete', 'route'})


def handler_tree() -> ast.Module:
    return ast.parse(HANDLER_SOURCE.read_text(encoding='utf-8'))


def _route_path(decorator: ast.expr) -> str | None:
    """`'/metrics/categories'` from `@app.get("/metrics/categories")`, else None."""
    if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
        return None
    target = decorator.func.value
    if not isinstance(target, ast.Name) or target.id != 'app':
        return None
    if decorator.func.attr not in _ROUTE_VERBS or not decorator.args:
        return None
    first = decorator.args[0]
    return first.value if isinstance(first, ast.Constant) else None


def _publishes_is_partial(func: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    """True when this function's own body builds a dict carrying `is_partial`.

    Walked over the function body ONLY, so a sibling route's response cannot
    answer for this one — the mistake that would make a parametrization look
    complete while covering nothing.
    """
    for node in ast.walk(func):
        if isinstance(node, ast.Dict) and any(
            isinstance(key, ast.Constant) and key.value == 'is_partial'
            for key in node.keys
        ):
            return True
    return False


def routes_publishing_is_partial() -> dict[str, str]:
    """`{route path: handler name}` for every route that publishes the flag."""
    found: dict[str, str] = {}
    for node in ast.walk(handler_tree()):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        paths = [p for p in (_route_path(d) for d in node.decorator_list) if p]
        if paths and _publishes_is_partial(node):
            found[paths[0]] = node.name
    return found
