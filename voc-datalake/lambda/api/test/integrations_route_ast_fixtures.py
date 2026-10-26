"""Parse a handler module's `@app.<method>("<path>")` routes for guard assertions.

Shared by `test_integrations_security.py` and `test_scrapers_security.py`, which
assert about their two handlers the same way: parsed rather than read off the
resolver, because the resolver records a route's PATH and handler but not the
guards inside the handler's body, which is the thing under test.
"""
import ast
import inspect
from types import ModuleType


def app_route_path(decorator: ast.expr) -> str | None:
    """The literal path of an `@app.get("/x")`-style decorator, else None.

    Matches on the `app` receiver and a string first argument, so
    `@tracer.capture_method` (no arguments) and any future non-routing decorator
    are ignored without needing a list of method names to exclude.
    """
    if not isinstance(decorator, ast.Call):
        return None
    func = decorator.func
    if not isinstance(func, ast.Attribute):
        return None
    if not isinstance(func.value, ast.Name) or func.value.id != 'app':
        return None
    if not decorator.args or not isinstance(decorator.args[0], ast.Constant):
        return None
    path = decorator.args[0].value
    return path if isinstance(path, str) else None


def route_paths(node: ast.FunctionDef) -> list[str]:
    """Every literal route path decorating *node*."""
    return [
        path for path in (app_route_path(d) for d in node.decorator_list)
        if path is not None
    ]


def module_functions(module: ModuleType) -> list[ast.FunctionDef]:
    """The module-level function definitions in *module*'s source."""
    tree = ast.parse(inspect.getsource(module))
    return [node for node in tree.body if isinstance(node, ast.FunctionDef)]


def module_function(module: ModuleType, name: str) -> ast.FunctionDef:
    """The module-level function *name*; raises StopIteration if it no longer exists."""
    return next(node for node in module_functions(module) if node.name == name)


def route_functions(module: ModuleType) -> dict[str, ast.FunctionDef]:
    """Every module-level function carrying an `@app.<method>("<path>")` decorator, by name."""
    return {
        node.name: node
        for node in module_functions(module)
        if any(app_route_path(d) for d in node.decorator_list)
    }


def plain_calls_in(node: ast.FunctionDef) -> set[str]:
    """Names of the plain-function calls anywhere in *node*'s body."""
    return {
        call.func.id
        for call in ast.walk(node)
        if isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
    }
